import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { NacosInstanceConfig } from '../../src/config/schema';
import { NACOS_CONFIG_SCHEME, parseConfigUri } from '../../src/document/configUri';
import { NacosConfigDocumentProvider } from '../../src/document/NacosConfigDocumentProvider';
import type { NacosConfigSummary } from '../../src/nacos/driver/normalize';
import { ConfigTreeProvider } from '../../src/tree/ConfigTreeProvider';
import { NamespaceTreeItem } from '../../src/tree/NacosTreeItems';
import { activate, deactivate } from '../../src/extension';
import {
  commands as fixtureCommands,
  window as fixtureWindow,
  workspace as fixtureWorkspace
} from '../../test-fixtures/vscode';
import { extensionContext } from './extensionContext';

function run(command: string, ...args: unknown[]): Promise<unknown> {
  const handler = fixtureCommands.__getRegisteredCommands().get(command);
  expect(handler, command).toBeDefined();
  return Promise.resolve(handler?.(...(args as never[])));
}

function summary(overrides: Partial<NacosConfigSummary> = {}): NacosConfigSummary {
  return { namespaceId: 'uat', group: 'cl-intimfy', dataId: 'application-uat.yml', type: 'yaml', ...overrides };
}

function configTree(): ConfigTreeProvider {
  return fixtureWindow.__getTreeViews()[0]?.treeDataProvider as ConfigTreeProvider;
}

/** A namespace node, which is the whole of what the Load more command is handed. */
function namespaceNode(): NamespaceTreeItem {
  const instance: NacosInstanceConfig = {
    id: 'instance-1',
    label: 'prod',
    serverUrl: 'http://nacos.example.com:8848/nacos',
    authMode: 'none',
    readOnly: false,
    allowBackgroundAccess: false,
    createdAt: 0,
    updatedAt: 0
  };
  return new NamespaceTreeItem('config', instance, { namespaceId: 'uat', displayName: 'uat', type: 2 }, 2);
}

describe('atNacos configuration document wiring', () => {
  beforeEach(async () => {
    await deactivate();
    fixtureCommands.__clearRegisteredCommands();
    fixtureWindow.__clearTreeViews();
    fixtureWindow.__clearLogChannels();
    fixtureWorkspace.__clearContentProviders();
  });

  afterEach(async () => {
    await deactivate();
    vi.restoreAllMocks();
  });

  /**
   * Without this registration, every `nacos:` URI the tree hands to
   * `openTextDocument` fails with "cannot open ... no provider" -- so clicking
   * a configuration is broken, and nothing else in the suite notices, because
   * the provider is unit-tested directly.
   */
  it('serves the nacos scheme with a document content provider', () => {
    activate(extensionContext());

    const registered = fixtureWorkspace.__getContentProviders();
    expect(registered.map((entry) => entry.scheme)).toEqual([NACOS_CONFIG_SCHEME]);
    expect(registered[0]?.provider).toBeInstanceOf(NacosConfigDocumentProvider);
  });

  it('disposes that registration with the rest of its subscriptions', () => {
    const context = extensionContext();
    activate(context);

    for (const subscription of context.subscriptions) {
      subscription.dispose();
    }

    expect(fixtureWorkspace.__getContentProviders().map((entry) => entry.disposed)).toEqual([true]);
  });

  it('opens the configuration a tree node names, at the address that addresses it', async () => {
    const opened = vi.spyOn(vscode.workspace, 'openTextDocument');
    const withProgress = vi.spyOn(vscode.window, 'withProgress');
    activate(extensionContext());

    await run('atNacos.openConfig', 'instance-1', summary());

    expect(withProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        location: vscode.ProgressLocation.Notification,
        title: 'Loading configuration application-uat.yml...'
      }),
      expect.any(Function)
    );
    expect(parseConfigUri(opened.mock.calls[0]?.[0] as vscode.Uri)).toEqual({
      instanceId: 'instance-1',
      ref: { namespaceId: 'uat', group: 'cl-intimfy', dataId: 'application-uat.yml' }
    });
  });

  it('opens it in the language mode the summary implies', async () => {
    const setLanguage = vi.spyOn(vscode.languages, 'setTextDocumentLanguage');
    activate(extensionContext());

    await run('atNacos.openConfig', 'instance-1', summary({ type: undefined }));

    expect(setLanguage.mock.calls[0]?.[1]).toBe('yaml');
  });

  /**
   * A click that appears to do nothing is the worst outcome here: VS Code
   * neither retries nor explains a command that rejected out of a tree node.
   */
  it('reports a configuration it could not open instead of failing silently', async () => {
    const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage');
    vi.spyOn(vscode.window, 'showTextDocument').mockRejectedValue(new Error('no editor group available'));
    activate(extensionContext());

    await expect(run('atNacos.openConfig', 'instance-1', summary())).resolves.toBeUndefined();

    expect(showErrorMessage).toHaveBeenCalledWith(
      'Could not open the configuration application-uat.yml: no editor group available'
    );
  });

  it('pages the namespace the Load more node names', async () => {
    activate(extensionContext());
    const loadMore = vi.spyOn(configTree(), 'loadMore').mockResolvedValue();
    const namespace = namespaceNode();

    await run('atNacos.loadMoreConfigs', namespace);

    expect(loadMore).toHaveBeenCalledWith(namespace);
  });

  /**
   * `loadMore` rejects rather than rendering an error node -- deliberately,
   * because an error node in the namespace would throw away the pages the user
   * was already reading. The report has to happen here or nowhere.
   */
  it('reports a page that failed to load, since the tree deliberately does not', async () => {
    const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage');
    activate(extensionContext());
    vi.spyOn(configTree(), 'loadMore').mockRejectedValue(new Error('connect ETIMEDOUT 10.0.0.9:8848'));

    await expect(run('atNacos.loadMoreConfigs', namespaceNode())).resolves.toBeUndefined();

    expect(showErrorMessage).toHaveBeenCalledWith(
      'Could not load more configurations: connect ETIMEDOUT 10.0.0.9:8848'
    );
  });

  /**
   * The listing carries every configuration's full body, so an error that
   * quotes what it could not parse is quoting a document that holds passwords.
   * Both surfaces have to be redacted, and the failure is on the channel as
   * well as in the notification -- the notification is gone in five seconds.
   */
  it('redacts the configuration body a failed page may have quoted, on the notification and on the log', async () => {
    const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage');
    activate(extensionContext());
    vi.spyOn(configTree(), 'loadMore').mockRejectedValue(
      new Error('unreadable listing: {"dataId":"redis.yml","content":"spring:\\n  redis:\\n    password: hunter2"}')
    );

    await run('atNacos.loadMoreConfigs', namespaceNode());

    expect(vi.mocked(showErrorMessage).mock.calls[0]?.[0]).toContain('password: [REDACTED]');
    expect(vi.mocked(showErrorMessage).mock.calls[0]?.[0]).not.toContain('hunter2');
    const logged = fixtureWindow.__getLogChannels()[0]?.lines.map((line) => line.message).join('\n');
    expect(logged).toContain('loadMoreConfigs');
    expect(logged).not.toContain('hunter2');
  });
});
