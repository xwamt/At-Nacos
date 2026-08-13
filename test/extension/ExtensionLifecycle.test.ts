import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from '../../src/extension';
import { ConfigTreeProvider } from '../../src/tree/ConfigTreeProvider';
import { ServiceTreeProvider } from '../../src/tree/ServiceTreeProvider';
import {
  commands as fixtureCommands,
  window as fixtureWindow,
  workspace as fixtureWorkspace
} from '../../test-fixtures/vscode';
import { extensionContext } from './extensionContext';

describe('atNacos extension lifecycle', () => {
  beforeEach(async () => {
    await deactivate();
    fixtureCommands.__clearRegisteredCommands();
    fixtureWindow.__clearTreeViews();
    fixtureWindow.__clearLogChannels();
    fixtureWorkspace.__clearContentProviders();
    // An input box answer queued by one test and left unconsumed would be
    // handed to the next one that opens a box.
    fixtureWindow.__resetDialogs();
  });

  afterEach(async () => {
    await deactivate();
    vi.restoreAllMocks();
  });

  it('registers the instance, refresh, filter and configuration commands', () => {
    // That this is exactly what the manifest contributes is asserted in
    // Manifest.test.ts, against package.json rather than against a copy of it.
    activate(extensionContext());

    expect([...fixtureCommands.__getRegisteredCommands().keys()].sort()).toEqual([
      'atNacos.addInstance',
      'atNacos.clearConfigFilter',
      'atNacos.filterConfigs',
      'atNacos.loadMoreConfigs',
      'atNacos.manageInstances',
      'atNacos.openConfig',
      'atNacos.refreshConfigs',
      'atNacos.refreshServices'
    ]);
  });

  it('creates both views and backs each with its own provider', () => {
    activate(extensionContext());

    const views = fixtureWindow.__getTreeViews();
    expect(views.map((view) => view.viewId)).toEqual(['atNacos.configs', 'atNacos.services']);
    expect(views[0]?.treeDataProvider).toBeInstanceOf(ConfigTreeProvider);
    expect(views[1]?.treeDataProvider).toBeInstanceOf(ServiceTreeProvider);
  });

  it('opens one log output channel named for the extension', () => {
    activate(extensionContext());

    expect(fixtureWindow.__getLogChannels().map((channel) => channel.name)).toEqual(['AT Nacos']);
  });

  it('hands every disposable it created to context.subscriptions', () => {
    // The channel, the eight commands, the two views, the document provider
    // and its registration. Anything left out survives a window reload and
    // leaks a listener into the next activation.
    const context = extensionContext();

    activate(context);

    expect(context.subscriptions).toHaveLength(13);
    for (const subscription of context.subscriptions) {
      expect(typeof subscription.dispose).toBe('function');
    }
  });

  it('disposes the views when its subscriptions are disposed', () => {
    const context = extensionContext();
    activate(context);

    for (const subscription of context.subscriptions) {
      subscription.dispose();
    }

    expect(fixtureWindow.__getTreeViews().map((view) => view.disposed)).toEqual([true, true]);
  });

  it.each([
    ['atNacos.refreshConfigs', 0],
    ['atNacos.refreshServices', 1]
  ])('wires %s to the tree it names', async (command, viewIndex) => {
    activate(extensionContext());
    const providers = fixtureWindow
      .__getTreeViews()
      .map((view) => view.treeDataProvider as vscode.TreeDataProvider<unknown>);
    const changed = providers.map(() => vi.fn());
    providers.forEach((provider, index) => provider.onDidChangeTreeData?.(changed[index] as () => void));

    await fixtureCommands.__getRegisteredCommands().get(command)?.();

    expect(changed.map((listener) => listener.mock.calls.length)).toEqual(
      providers.map((_provider, index) => (index === viewIndex ? 1 : 0))
    );
  });

  it('filters the configuration tree with what the input box returns', async () => {
    activate(extensionContext());
    const provider = fixtureWindow.__getTreeViews()[0]?.treeDataProvider as ConfigTreeProvider;
    fixtureWindow.__setInputBoxResults(['application-uat']);

    await fixtureCommands.__getRegisteredCommands().get('atNacos.filterConfigs')?.();

    expect(provider.getFilter()).toBe('application-uat');
  });

  /** Escape out of the input box and the filter that was there has to survive it. */
  it('leaves the filter alone when the input box is dismissed', async () => {
    activate(extensionContext());
    const provider = fixtureWindow.__getTreeViews()[0]?.treeDataProvider as ConfigTreeProvider;
    provider.setFilter('application-uat');
    fixtureWindow.__setInputBoxResults([undefined]);

    await fixtureCommands.__getRegisteredCommands().get('atNacos.filterConfigs')?.();

    expect(provider.getFilter()).toBe('application-uat');
  });

  it('offers the current filter as the text to edit rather than an empty box', async () => {
    activate(extensionContext());
    const provider = fixtureWindow.__getTreeViews()[0]?.treeDataProvider as ConfigTreeProvider;
    provider.setFilter('application-uat');
    const inputBox = vi.spyOn(fixtureWindow, 'showInputBox');

    await fixtureCommands.__getRegisteredCommands().get('atNacos.filterConfigs')?.();

    expect(inputBox.mock.calls[0]?.[0]?.value).toBe('application-uat');
  });

  it('clears the configuration filter with the command contributed for it', async () => {
    activate(extensionContext());
    const provider = fixtureWindow.__getTreeViews()[0]?.treeDataProvider as ConfigTreeProvider;
    provider.setFilter('application-uat');

    await fixtureCommands.__getRegisteredCommands().get('atNacos.clearConfigFilter')?.();

    expect(provider.getFilter()).toBeUndefined();
  });

  /** The message belongs to the view, so the provider only reaches it if `activate` hands it over. */
  it('shows the active filter on the configurations view, and only on that view', async () => {
    activate(extensionContext());
    const provider = fixtureWindow.__getTreeViews()[0]?.treeDataProvider as ConfigTreeProvider;

    provider.setFilter('application-uat');

    expect(fixtureWindow.__getTreeViews()[0]?.message).toContain('application-uat');
    expect(fixtureWindow.__getTreeViews()[1]?.message).toBeUndefined();
  });

  it('runs its shutdown once even when deactivate is called twice', async () => {
    activate(extensionContext());
    const channel = fixtureWindow.__getLogChannels()[0];

    await deactivate();
    await deactivate();

    expect(channel?.lines.filter((line) => line.message.startsWith('deactivate:'))).toHaveLength(1);
  });

  it('resolves when deactivate is called without an activation', async () => {
    await expect(deactivate()).resolves.toBeUndefined();
  });

  it('starts a fresh shutdown for a second activation', async () => {
    // A window reload activates again against the same module instance. The
    // guard must be per activation, not per process, or the second session
    // would deactivate silently.
    activate(extensionContext());
    await deactivate();
    activate(extensionContext());
    const channel = fixtureWindow.__getLogChannels()[1];

    await deactivate();

    expect(channel?.lines.filter((line) => line.message.startsWith('deactivate:'))).toHaveLength(1);
  });
});
