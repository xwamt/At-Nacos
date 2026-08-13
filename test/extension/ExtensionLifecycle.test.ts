import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from '../../src/extension';
import { ConfigTreeProvider } from '../../src/tree/ConfigTreeProvider';
import { ServiceTreeProvider } from '../../src/tree/ServiceTreeProvider';
import { commands as fixtureCommands, window as fixtureWindow } from '../../test-fixtures/vscode';
import { extensionContext } from './extensionContext';

describe('atNacos extension lifecycle', () => {
  beforeEach(async () => {
    await deactivate();
    fixtureCommands.__clearRegisteredCommands();
    fixtureWindow.__clearTreeViews();
    fixtureWindow.__clearLogChannels();
  });

  afterEach(async () => {
    await deactivate();
    vi.restoreAllMocks();
  });

  it('registers the four instance and refresh commands', () => {
    // That this is exactly what the manifest contributes is asserted in
    // Manifest.test.ts, against package.json rather than against a copy of it.
    activate(extensionContext());

    expect([...fixtureCommands.__getRegisteredCommands().keys()].sort()).toEqual([
      'atNacos.addInstance',
      'atNacos.manageInstances',
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
    // The channel, the four commands and the two views. Anything left out
    // survives a window reload and leaks a listener into the next activation.
    const context = extensionContext();

    activate(context);

    expect(context.subscriptions).toHaveLength(7);
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
