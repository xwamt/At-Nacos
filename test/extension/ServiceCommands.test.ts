import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { NacosInstanceConfig } from '../../src/config/schema';
import { activate, deactivate } from '../../src/extension';
import { LoadMoreTreeItem, NamespaceTreeItem } from '../../src/tree/NacosTreeItems';
import { ServiceTreeProvider } from '../../src/tree/ServiceTreeProvider';
import { commands as fixtureCommands, window as fixtureWindow } from '../../test-fixtures/vscode';
import { extensionContext } from './extensionContext';

function run(command: string, ...args: unknown[]): Promise<unknown> {
  const handler = fixtureCommands.__getRegisteredCommands().get(command);
  expect(handler, command).toBeDefined();
  return Promise.resolve(handler?.(...(args as never[])));
}

function serviceTree(): ServiceTreeProvider {
  return fixtureWindow.__getTreeViews()[1]?.treeDataProvider as ServiceTreeProvider;
}

/** A namespace node of the services view, which is the whole of what Load more is handed. */
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
  return new NamespaceTreeItem('service', instance, { namespaceId: 'uat', displayName: 'uat', type: 2 }, 2);
}

describe('atNacos service tree wiring', () => {
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

  /**
   * The regression this closes: the service tree has carried a Load more node
   * naming this command since M3 Task 2, with nobody registered to answer it,
   * so a namespace of more than a hundred services rendered an affordance that
   * did nothing at all when clicked.
   */
  it('registers the command the service tree Load more node points at', () => {
    activate(extensionContext());

    const node = new LoadMoreTreeItem('service', namespaceNode(), 100, 213);

    expect([...fixtureCommands.__getRegisteredCommands().keys()]).toContain(
      (node.command as { command: string }).command
    );
  });

  it('pages the namespace the Load more node names', async () => {
    activate(extensionContext());
    const loadMore = vi.spyOn(serviceTree(), 'loadMore').mockResolvedValue();
    const namespace = namespaceNode();

    await run('atNacos.loadMoreServices', namespace);

    expect(loadMore).toHaveBeenCalledWith(namespace);
  });

  /** The services view pages its own tree, not the configurations view's. */
  it('leaves the configuration tree alone', async () => {
    activate(extensionContext());
    const configTree = fixtureWindow.__getTreeViews()[0]?.treeDataProvider as { loadMore: () => Promise<void> };
    const configLoadMore = vi.spyOn(configTree, 'loadMore').mockResolvedValue();
    vi.spyOn(serviceTree(), 'loadMore').mockResolvedValue();

    await run('atNacos.loadMoreServices', namespaceNode());

    expect(configLoadMore).not.toHaveBeenCalled();
  });

  /**
   * `loadMore` rejects rather than rendering an error node -- deliberately,
   * because an error node in the namespace would throw away the services the
   * user was already reading. The report has to happen here or nowhere.
   */
  it('reports a page that failed to load, since the tree deliberately does not', async () => {
    const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage');
    activate(extensionContext());
    vi.spyOn(serviceTree(), 'loadMore').mockRejectedValue(new Error('connect ETIMEDOUT 10.0.0.9:8848'));

    await expect(run('atNacos.loadMoreServices', namespaceNode())).resolves.toBeUndefined();

    expect(showErrorMessage).toHaveBeenCalledWith('Could not load more services: connect ETIMEDOUT 10.0.0.9:8848');
    const logged = fixtureWindow.__getLogChannels()[0]?.lines.map((line) => line.message).join('\n');
    expect(logged).toContain('loadMoreServices');
  });
});
