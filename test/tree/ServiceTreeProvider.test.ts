import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import type { NacosInstanceConfig } from '../../src/config/schema';
import type { NacosNamespace } from '../../src/nacos/driver/normalize';
import { ConfigTreeProvider, type NacosConfigTreeClient } from '../../src/tree/ConfigTreeProvider';
import { ErrorTreeItem, InstanceTreeItem, NamespaceTreeItem } from '../../src/tree/NacosTreeItems';
import { ServiceTreeProvider } from '../../src/tree/ServiceTreeProvider';

function instance(overrides: Partial<NacosInstanceConfig> = {}): NacosInstanceConfig {
  return {
    id: 'instance-1',
    label: 'Production',
    serverUrl: 'http://nacos.example.com:8848/nacos',
    authMode: 'none',
    readOnly: false,
    allowBackgroundAccess: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

/**
 * Wide enough for both trees, because the assertions below run the same stub
 * through each of them. The service tree never calls `listConfigs`; the
 * configuration tree needs it from M2 on.
 */
function stubClient(namespaces: NacosNamespace[], majorVersion = 1): NacosConfigTreeClient {
  return {
    state: {
      version: `${majorVersion}.0.0`,
      majorVersion,
      startupMode: 'standalone',
      authEnabled: false,
      raw: {}
    },
    listNamespaces: async () => namespaces,
    listConfigs: async () => ({ items: [], totalCount: 0, pageNumber: 1, pagesAvailable: 1 })
  };
}

const NAMESPACES: NacosNamespace[] = [
  { namespaceId: '', displayName: '', type: 0 },
  { namespaceId: 'ns-staging', displayName: 'Staging', type: 2 }
];

/**
 * Both trees over the same stubs. The assertions below compare one against
 * the other rather than against a literal, so a change made to the shared
 * levels for one tree and not the other fails here rather than shipping as a
 * pair of views that disagree.
 */
function bothTrees(inst = instance()) {
  const listInstances = async () => [inst];
  const createClient = async () => stubClient(NAMESPACES);
  return {
    config: new ConfigTreeProvider({ listInstances }, createClient),
    service: new ServiceTreeProvider({ listInstances }, createClient)
  };
}

async function expandInstance(provider: ConfigTreeProvider | ServiceTreeProvider) {
  const [root] = await provider.getChildren();
  return { root, children: await provider.getChildren(root) };
}

describe('ServiceTreeProvider', () => {
  it('returns no root children when no instance is configured, so its own viewsWelcome can render', async () => {
    const provider = new ServiceTreeProvider({ listInstances: async () => [] }, async () => {
      throw new Error('createClient must not be called when there is no instance');
    });

    expect(await provider.getChildren()).toEqual([]);
  });

  it('renders the instance and namespace levels exactly as the configuration tree does', async () => {
    const trees = bothTrees();

    const fromConfig = await expandInstance(trees.config);
    const fromService = await expandInstance(trees.service);

    expect(fromService.root).toBeInstanceOf(InstanceTreeItem);
    expect(fromService.root.label).toBe(fromConfig.root.label);
    expect(fromService.root.tooltip).toBe(fromConfig.root.tooltip);
    expect(fromService.children.every((item) => item instanceof NamespaceTreeItem)).toBe(true);
    expect(fromService.children.map((item) => item.label)).toEqual(fromConfig.children.map((item) => item.label));
    expect(fromService.children.map((item) => item.collapsibleState)).toEqual([
      vscode.TreeItemCollapsibleState.Collapsed,
      vscode.TreeItemCollapsibleState.Collapsed
    ]);
  });

  /** One `when` clause per node kind has to cover both views, so the context values cannot diverge. */
  it('gives its nodes the same context values as the configuration tree, including the read-only suffix', async () => {
    const trees = bothTrees(instance({ readOnly: true }));

    const fromConfig = await expandInstance(trees.config);
    const fromService = await expandInstance(trees.service);

    expect(fromService.root.contextValue).toBe('atNacos.instance.readonly');
    expect(fromService.root.contextValue).toBe(fromConfig.root.contextValue);
    expect(fromService.children.map((item) => item.contextValue)).toEqual(
      fromConfig.children.map((item) => item.contextValue)
    );
  });

  /**
   * Both views sit in the `atNacos` container and show the same instances and
   * namespaces. An id identifies at most one item, so the two trees have to
   * spell theirs differently even when everything else about the node matches.
   */
  it('keeps its item ids distinct from the configuration tree for the same instance and namespace', async () => {
    const trees = bothTrees();

    const fromConfig = await expandInstance(trees.config);
    const fromService = await expandInstance(trees.service);

    expect(fromService.root.id).not.toBe(fromConfig.root.id);
    expect(fromService.children.map((item) => item.id)).not.toEqual(fromConfig.children.map((item) => item.id));
    expect(new Set(fromService.children.map((item) => item.id)).size).toBe(fromService.children.length);
  });

  it('stops at the namespace level in M1: expanding a namespace yields no children', async () => {
    const provider = new ServiceTreeProvider({ listInstances: async () => [instance()] }, async () =>
      stubClient(NAMESPACES)
    );

    const { children } = await expandInstance(provider);

    expect(await provider.getChildren(children[0])).toEqual([]);
  });

  it('renders a load failure as an error node under the instance, as the configuration tree does', async () => {
    const failing = async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.9:8848');
    };
    const provider = new ServiceTreeProvider({ listInstances: async () => [instance()] }, failing);

    const { children } = await expandInstance(provider);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorTreeItem);
    expect(children[0].description).toContain('connect ECONNREFUSED 10.0.0.9:8848');
  });

  it('re-fetches after refresh(), as the configuration tree does', async () => {
    let created = 0;
    const provider = new ServiceTreeProvider({ listInstances: async () => [instance()] }, async () => {
      created += 1;
      return stubClient(NAMESPACES);
    });

    const { root } = await expandInstance(provider);
    await provider.getChildren(root);
    expect(created).toBe(1);

    provider.refresh();
    await provider.getChildren(root);

    expect(created).toBe(2);
  });
});
