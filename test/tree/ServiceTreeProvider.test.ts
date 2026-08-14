import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { NacosInstanceConfig } from '../../src/config/schema';
import type { NacosInstanceQuery, NacosServiceListQuery } from '../../src/nacos/driver/NacosDriver';
import type {
  NacosInstance,
  NacosNamespace,
  NacosServiceSummary,
  Paged
} from '../../src/nacos/driver/normalize';
import { ConfigTreeProvider, type NacosConfigTreeClient } from '../../src/tree/ConfigTreeProvider';
import {
  ErrorTreeItem,
  GroupTreeItem,
  InstanceTreeItem,
  LoadMoreTreeItem,
  NamespaceTreeItem,
  ServiceInstanceTreeItem,
  ServiceTreeItem,
  type NacosTreeItem
} from '../../src/tree/NacosTreeItems';
import { ServiceTreeProvider, type NacosServiceTreeClient } from '../../src/tree/ServiceTreeProvider';

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

function namespace(overrides: Partial<NacosNamespace> = {}): NacosNamespace {
  return { namespaceId: 'ns-staging', displayName: 'Staging', type: 2, ...overrides };
}

/**
 * Wide enough for both trees, because the assertions below run the same stub
 * through each of them. The service tree never calls `listConfigs`; the
 * configuration tree never calls `listServices`.
 */
function stubClient(namespaces: NacosNamespace[], majorVersion = 1): NacosConfigTreeClient & NacosServiceTreeClient {
  return {
    state: {
      version: `${majorVersion}.0.0`,
      majorVersion,
      startupMode: 'standalone',
      authEnabled: false,
      raw: {}
    },
    listNamespaces: async () => namespaces,
    listConfigs: async () => ({ items: [], totalCount: 0, pageNumber: 1, pagesAvailable: 1 }),
    listServices: async () => ({ items: [], totalCount: 0, pageNumber: 1, pagesAvailable: 1 }),
    listInstances: async () => []
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

/**
 * Counts by default, because that is what a server whose catalog answered
 * sends. The two tests about a listing that reports no counts pass them as
 * undefined explicitly -- which is the whole point of those tests.
 */
function service(group: string, serviceName: string, overrides: Partial<NacosServiceSummary> = {}): NacosServiceSummary {
  return {
    namespaceId: 'ns-staging',
    group,
    serviceName,
    instanceCount: 1,
    healthyInstanceCount: 1,
    clusterCount: 1,
    ...overrides
  };
}

function host(ip: string, port: number, overrides: Partial<NacosInstance> = {}): NacosInstance {
  return {
    ip,
    port,
    healthy: true,
    enabled: true,
    weight: 1,
    clusterName: 'DEFAULT',
    ephemeral: true,
    metadata: {},
    ...overrides
  };
}

/** A listing served from fixed pages, answering whichever page number it was asked for. */
function pagesOf(...pages: NacosServiceSummary[][]) {
  return (query: NacosServiceListQuery): Paged<NacosServiceSummary> => ({
    items: pages[query.pageNo - 1] ?? [],
    totalCount: pages.reduce((sum, page) => sum + page.length, 0),
    pageNumber: query.pageNo,
    pagesAvailable: pages.length
  });
}

/**
 * A client that records every query it was handed. The page number and the
 * group filter are the whole subject of the paging tests and are visible
 * nowhere else -- the tree items only show the result.
 */
function recordingClient(options: {
  services?: (query: NacosServiceListQuery) => Paged<NacosServiceSummary>;
  instances?: (query: NacosInstanceQuery) => NacosInstance[];
  namespaces?: NacosNamespace[];
}) {
  const serviceQueries: NacosServiceListQuery[] = [];
  const instanceQueries: NacosInstanceQuery[] = [];
  const respondServices = options.services ?? pagesOf([]);
  const respondInstances = options.instances ?? (() => []);
  return {
    serviceQueries,
    instanceQueries,
    client: {
      ...stubClient(options.namespaces ?? [namespace()]),
      listServices: async (query: NacosServiceListQuery) => {
        serviceQueries.push(query);
        return respondServices(query);
      },
      listInstances: async (query: NacosInstanceQuery) => {
        instanceQueries.push(query);
        return respondInstances(query);
      }
    } satisfies NacosServiceTreeClient
  };
}

function providerFor(client: NacosServiceTreeClient, inst = instance()): ServiceTreeProvider {
  return new ServiceTreeProvider({ listInstances: async () => [inst] }, async () => client);
}

async function expandInstance(provider: ConfigTreeProvider | ServiceTreeProvider) {
  const [root] = await provider.getChildren();
  return { root, children: await provider.getChildren(root) };
}

async function expandNamespace(provider: ServiceTreeProvider, index = 0) {
  const { children: namespaces } = await expandInstance(provider);
  const namespaceItem = namespaces[index] as NamespaceTreeItem;
  return { namespaceItem, children: await provider.getChildren(namespaceItem) };
}

function groupsIn(children: NacosTreeItem[]): GroupTreeItem[] {
  return children.filter((item): item is GroupTreeItem => item instanceof GroupTreeItem);
}

function servicesIn(children: NacosTreeItem[]): ServiceTreeItem[] {
  return children.filter((item): item is ServiceTreeItem => item instanceof ServiceTreeItem);
}

/** The icon's codicon id and the theme colour on it, which is all a test can assert about a `ThemeIcon`. */
function iconOf(item: NacosTreeItem): { id: string; color: string | undefined } {
  const icon = item.iconPath as { id: string; color?: { id: string } };
  return { id: icon.id, color: icon.color?.id };
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it('renders nothing under a namespace that holds no service at all', async () => {
    const provider = providerFor(stubClient([namespace()]));

    const { children } = await expandNamespace(provider);

    expect(children).toEqual([]);
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

describe('ServiceTreeProvider group level', () => {
  it('expands a namespace into one node per group of the services it loaded', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'merchant-admin'), service('cl-gateway', 'gateway'), service('cl-intimfy', 'order')])
    });
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);

    expect(children.every((item) => item instanceof GroupTreeItem)).toBe(true);
    expect(children.map((item) => item.label)).toEqual(['cl-gateway', 'cl-intimfy']);
    expect(children.map((item) => item.collapsibleState)).toEqual([
      vscode.TreeItemCollapsibleState.Collapsed,
      vscode.TreeItemCollapsibleState.Collapsed
    ]);
    expect(children.map((item) => item.contextValue)).toEqual(['atNacos.group', 'atNacos.group']);
  });

  /**
   * The trap this milestone was planned around, and the one that hid this
   * server's whole registry from the reconnaissance: a service listing whose
   * group filter defaults answers for `DEFAULT_GROUP` alone. Absent is the
   * only way to ask for every group, and the tree derives its groups from
   * what comes back -- so a group sent here would collapse the level below.
   */
  it('asks for every group, a hundred services at a time', async () => {
    const { client, serviceQueries } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'merchant-admin')]),
      namespaces: [namespace({ namespaceId: 'uat' })]
    });
    const provider = providerFor(client);

    await expandNamespace(provider);

    expect(serviceQueries).toEqual([{ namespaceId: 'uat', pageNo: 1, pageSize: 100 }]);
    expect(serviceQueries[0].group).toBeUndefined();
  });

  it('counts the services loaded into each group', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'merchant-admin'), service('cl-intimfy', 'order'), service('cl-gateway', 'gateway')])
    });
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);

    expect(children.map((item) => item.description)).toEqual(['1', '2']);
  });

  it('carries the read-only suffix down to the group nodes of a read-only instance', async () => {
    const { client } = recordingClient({ services: pagesOf([service('cl-intimfy', 'merchant-admin')]) });
    const provider = providerFor(client, instance({ readOnly: true }));

    const { children } = await expandNamespace(provider);

    expect(children[0].contextValue).toBe('atNacos.group.readonly');
  });
});

describe('ServiceTreeProvider service level', () => {
  it('expands a group into one collapsible node per service in that group', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'order'), service('cl-gateway', 'gateway'), service('cl-intimfy', 'merchant-admin')])
    });
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);
    const services = await provider.getChildren(groupsIn(children)[1]);

    expect(services.every((item) => item instanceof ServiceTreeItem)).toBe(true);
    expect(services.map((item) => item.label)).toEqual(['merchant-admin', 'order']);
    expect(services.map((item) => item.collapsibleState)).toEqual([
      vscode.TreeItemCollapsibleState.Collapsed,
      vscode.TreeItemCollapsibleState.Collapsed
    ]);
    expect(services.map((item) => item.contextValue)).toEqual(['atNacos.service', 'atNacos.service']);
  });

  it('carries the read-only suffix down to the service nodes of a read-only instance', async () => {
    const { client } = recordingClient({ services: pagesOf([service('cl-intimfy', 'merchant-admin')]) });
    const provider = providerFor(client, instance({ readOnly: true }));

    const { children } = await expandNamespace(provider);
    const [serviceItem] = await provider.getChildren(children[0]);

    expect(serviceItem.contextValue).toBe('atNacos.service.readonly');
  });

  it('shows the healthy count over the total when the listing reported both', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'order', { instanceCount: 3, healthyInstanceCount: 2 })])
    });
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);
    const [serviceItem] = await provider.getChildren(children[0]);

    expect(serviceItem.description).toBe('2/3');
  });

  /**
   * The distinction the whole health rendering turns on. `instanceCount` is
   * absent whenever the driver fell back to the name-only listing, and a
   * service whose count nobody reported must not read as a service that has
   * nothing registered -- "0/0" says the service is down, which is a claim
   * this listing did not make.
   */
  it('says the count is missing rather than showing a zero when the listing reported no counts', async () => {
    const { client } = recordingClient({
      services: pagesOf([
        service('cl-intimfy', 'counted', { instanceCount: 0, healthyInstanceCount: 0 }),
        service('cl-intimfy', 'uncounted', { instanceCount: undefined, healthyInstanceCount: undefined })
      ])
    });
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);
    const [counted, uncounted] = await provider.getChildren(children[0]);

    expect(counted.description).toBe('0/0');
    expect(uncounted.description).not.toBe('0/0');
    expect(uncounted.description).not.toContain('0');
    expect(iconOf(uncounted).id).not.toBe(iconOf(counted).id);
  });

  it('leaves the icon of a service with no reported counts uncoloured, since it makes no claim about health', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'uncounted', { instanceCount: undefined, healthyInstanceCount: undefined })])
    });
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);
    const [serviceItem] = await provider.getChildren(children[0]);

    expect(iconOf(serviceItem)).toEqual({ id: 'circle-outline', color: undefined });
  });

  it('tells the user in the tooltip why a service shows no counts', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'uncounted', { instanceCount: undefined, healthyInstanceCount: undefined })])
    });
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);
    const [serviceItem] = await provider.getChildren(children[0]);

    expect(serviceItem.tooltip).toContain('uncounted');
    expect(serviceItem.tooltip).toContain('no instance counts');
  });

  it('marks a service whose instances are all healthy with a green pass icon', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'order', { instanceCount: 2, healthyInstanceCount: 2 })])
    });
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);
    const [serviceItem] = await provider.getChildren(children[0]);

    expect(iconOf(serviceItem)).toEqual({ id: 'pass', color: 'charts.green' });
  });

  it('marks a partly healthy service with the theme warning colour', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'order', { instanceCount: 3, healthyInstanceCount: 1 })])
    });
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);
    const [serviceItem] = await provider.getChildren(children[0]);

    expect(iconOf(serviceItem)).toEqual({ id: 'warning', color: 'problemsWarningIcon.foreground' });
  });

  it('marks a service whose instances are all unhealthy with the theme error colour', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'order', { instanceCount: 3, healthyInstanceCount: 0 })])
    });
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);
    const [serviceItem] = await provider.getChildren(children[0]);

    expect(iconOf(serviceItem)).toEqual({ id: 'error', color: 'problemsErrorIcon.foreground' });
  });

  /**
   * A registered service with nothing behind it cannot be called, so it is as
   * red as one whose instances are all failing -- but it is a different
   * situation and gets a different glyph. Reading `healthy === total` first
   * would paint it green, which is the worst of the three answers.
   */
  it('marks a service with no instances at all as unreachable rather than as fully healthy', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'order', { instanceCount: 0, healthyInstanceCount: 0 })])
    });
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);
    const [serviceItem] = await provider.getChildren(children[0]);

    expect(iconOf(serviceItem)).toEqual({ id: 'circle-slash', color: 'problemsErrorIcon.foreground' });
  });

  /**
   * Only the total came back, which the catalog does not do but a future
   * shape might. Half a count cannot be rendered as a ratio, and inventing
   * the other half is the mistake this whole level exists to avoid.
   */
  it('treats a listing that reported a total but no healthy count as unknown', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'order', { instanceCount: 3, healthyInstanceCount: undefined })])
    });
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);
    const [serviceItem] = await provider.getChildren(children[0]);

    expect(iconOf(serviceItem)).toEqual({ id: 'circle-outline', color: undefined });
  });

  it('keeps the summary on the service node so the level below can list its instances', async () => {
    const target = service('cl-intimfy', 'merchant-admin', { namespaceId: 'uat' });
    const { client } = recordingClient({ services: pagesOf([target]), namespaces: [namespace({ namespaceId: 'uat' })] });
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);
    const [serviceItem] = servicesIn(await provider.getChildren(children[0]));

    expect(serviceItem.service).toEqual(target);
    expect(serviceItem.instance.id).toBe('instance-1');
  });
});

/** Walks instance -> namespace -> group -> service -> instance in one call. */
async function expandFirstService(provider: ServiceTreeProvider) {
  const { children } = await expandNamespace(provider);
  const [serviceItem] = servicesIn(await provider.getChildren(children[0]));
  return { serviceItem, instances: await provider.getChildren(serviceItem) };
}

describe('ServiceTreeProvider instance level', () => {
  it('expands a service into one leaf node per registered instance, labelled ip:port', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'merchant-admin')]),
      instances: () => [host('192.168.99.92', 8088), host('192.168.99.93', 8088)]
    });
    const provider = providerFor(client);

    const { instances } = await expandFirstService(provider);

    expect(instances.every((item) => item instanceof ServiceInstanceTreeItem)).toBe(true);
    expect(instances.map((item) => item.label)).toEqual(['192.168.99.92:8088', '192.168.99.93:8088']);
    expect(instances.map((item) => item.collapsibleState)).toEqual([
      vscode.TreeItemCollapsibleState.None,
      vscode.TreeItemCollapsibleState.None
    ]);
    expect(instances.map((item) => item.contextValue)).toEqual([
      'atNacos.serviceInstance.enabled',
      'atNacos.serviceInstance.enabled'
    ]);
  });

  it('marks disabled instances with atNacos.serviceInstance.disabled contextValue', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'merchant-admin')]),
      instances: () => [host('192.168.99.92', 8088, { enabled: false })]
    });
    const provider = providerFor(client);

    const { instances } = await expandFirstService(provider);

    expect(instances[0].contextValue).toBe('atNacos.serviceInstance.disabled');
  });

  it('asks for the instances of exactly the service the node stands for', async () => {
    const { client, instanceQueries } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'merchant-admin', { namespaceId: 'uat' })]),
      instances: () => [host('192.168.99.92', 8088)],
      namespaces: [namespace({ namespaceId: 'uat' })]
    });
    const provider = providerFor(client);

    await expandFirstService(provider);

    expect(instanceQueries).toEqual([{ namespaceId: 'uat', group: 'cl-intimfy', serviceName: 'merchant-admin' }]);
  });

  /**
   * M3 is read-only and has no instance detail panel, so a click has nowhere
   * to go. M5 hangs enable/disable off the context value instead, which is
   * why that is set now and the command is not.
   */
  it('gives an instance node no command, since M3 has nothing to open', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'merchant-admin')]),
      instances: () => [host('192.168.99.92', 8088)]
    });
    const provider = providerFor(client);

    const { instances } = await expandFirstService(provider);

    expect(instances[0].command).toBeUndefined();
  });

  it('carries the read-only suffix down to the instance nodes of a read-only instance', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'merchant-admin')]),
      instances: () => [host('192.168.99.92', 8088)]
    });
    const provider = providerFor(client, instance({ readOnly: true }));

    const { instances } = await expandFirstService(provider);

    expect(instances[0].contextValue).toBe('atNacos.serviceInstance.enabled.readonly');
  });

  it('shows the cluster and the weight beside an instance, which is what routing turns on', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'merchant-admin')]),
      instances: () => [host('192.168.99.92', 8088, { clusterName: 'BEIJING', weight: 0.5 })]
    });
    const provider = providerFor(client);

    const { instances } = await expandFirstService(provider);

    expect(instances[0].description).toContain('BEIJING');
    expect(instances[0].description).toContain('0.5');
  });

  /** `normalizeInstance` leaves the cluster name empty when the entry omits it; "cluster , weight 1" reads as a bug. */
  it('leaves the cluster out of the description when the instance reported none', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'merchant-admin')]),
      instances: () => [host('192.168.99.92', 8088, { clusterName: '' })]
    });
    const provider = providerFor(client);

    const { instances } = await expandFirstService(provider);

    expect(instances[0].description).toBe('weight 1');
  });

  it('shows the instance metadata in the tooltip', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'merchant-admin')]),
      instances: () => [
        host('192.168.99.92', 8088, { metadata: { 'preserved.register.source': 'SPRING_CLOUD', version: '1.2' } })
      ]
    });
    const provider = providerFor(client);

    const { instances } = await expandFirstService(provider);

    expect(instances[0].tooltip).toContain('preserved.register.source=SPRING_CLOUD');
    expect(instances[0].tooltip).toContain('version=1.2');
  });

  /**
   * An instance registered by a plain `curl` carries no metadata at all. A
   * tooltip that trails off after "Metadata:" reads as a failed lookup rather
   * than as an empty map.
   */
  it('says an instance has no metadata rather than showing an empty list', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'merchant-admin')]),
      instances: () => [host('192.168.99.92', 8088, { metadata: {} })]
    });
    const provider = providerFor(client);

    const { instances } = await expandFirstService(provider);

    expect(instances[0].tooltip).toContain('No metadata');
    expect(instances[0].tooltip).not.toContain('Metadata:');
  });

  it('marks a healthy instance with a green pass icon and says so in the tooltip', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'merchant-admin')]),
      instances: () => [host('192.168.99.92', 8088, { healthy: true })]
    });
    const provider = providerFor(client);

    const { instances } = await expandFirstService(provider);

    expect(iconOf(instances[0])).toEqual({ id: 'pass', color: 'charts.green' });
    expect(instances[0].tooltip).toContain('is healthy');
  });

  it('marks an unhealthy instance with the theme error colour', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'merchant-admin')]),
      instances: () => [host('192.168.99.92', 8088, { healthy: false })]
    });
    const provider = providerFor(client);

    const { instances } = await expandFirstService(provider);

    expect(iconOf(instances[0])).toEqual({ id: 'error', color: 'problemsErrorIcon.foreground' });
    expect(instances[0].tooltip).toContain('is unhealthy');
  });

  /**
   * A disabled instance is one an operator took out of rotation, so Nacos
   * hands it to nobody however healthy it is. Rendering it as healthy would
   * be a true statement about the wrong question; the tooltip still reports
   * the health underneath.
   */
  it('marks a disabled instance as out of rotation even while it is healthy', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'merchant-admin')]),
      instances: () => [host('192.168.99.92', 8088, { healthy: true, enabled: false })]
    });
    const provider = providerFor(client);

    const { instances } = await expandFirstService(provider);

    expect(iconOf(instances[0])).toEqual({ id: 'circle-slash', color: 'problemsWarningIcon.foreground' });
    expect(instances[0].tooltip).toContain('disabled');
    expect(instances[0].tooltip).toContain('is healthy');
  });

  it('answers nothing below an instance node, which is a leaf', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'merchant-admin')]),
      instances: () => [host('192.168.99.92', 8088)]
    });
    const provider = providerFor(client);

    const { instances } = await expandFirstService(provider);

    expect(await provider.getChildren(instances[0])).toEqual([]);
  });

  it('serves a second expansion of one service from the instances it already loaded', async () => {
    const { client, instanceQueries } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'merchant-admin')]),
      instances: () => [host('192.168.99.92', 8088)]
    });
    const provider = providerFor(client);

    const { serviceItem } = await expandFirstService(provider);
    await provider.getChildren(serviceItem);

    expect(instanceQueries).toHaveLength(1);
  });

  it('re-reads the instances of a service after refresh()', async () => {
    const { client, instanceQueries } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'merchant-admin')]),
      instances: () => [host('192.168.99.92', 8088)]
    });
    const provider = providerFor(client);

    const { serviceItem } = await expandFirstService(provider);
    provider.refresh();
    await provider.getChildren(serviceItem);

    expect(instanceQueries).toHaveLength(2);
  });

  it('keeps the ref and the instance on the node so M5 can take it in and out of rotation', async () => {
    const registered = host('192.168.99.92', 8088, { instanceId: '192.168.99.92#8088#DEFAULT#cl-intimfy@@x' });
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'merchant-admin', { namespaceId: 'uat' })]),
      instances: () => [registered],
      namespaces: [namespace({ namespaceId: 'uat' })]
    });
    const provider = providerFor(client);

    const { instances } = await expandFirstService(provider);
    const [instanceItem] = instances as ServiceInstanceTreeItem[];

    expect(instanceItem.serviceInstance).toEqual(registered);
    expect(instanceItem.service).toEqual({ namespaceId: 'uat', group: 'cl-intimfy', serviceName: 'merchant-admin' });
  });
});

describe('ServiceTreeProvider paging', () => {
  it('offers a Load more node under the namespace once the listing runs past one page', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'a')], [service('cl-gateway', 'b')])
    });
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);

    expect(children[children.length - 1]).toBeInstanceOf(LoadMoreTreeItem);
    expect(children[children.length - 1].collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
  });

  it('offers no Load more node when the namespace fits in a single page', async () => {
    const { client } = recordingClient({ services: pagesOf([service('cl-intimfy', 'a')]) });
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);

    expect(children.some((item) => item instanceof LoadMoreTreeItem)).toBe(false);
  });

  /** The next page can introduce a group that does not exist yet, so the node cannot belong to one. */
  it('hangs Load more under the namespace rather than under a group', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'a')], [service('cl-gateway', 'b')])
    });
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);
    const underGroup = await provider.getChildren(groupsIn(children)[0]);

    expect(underGroup.some((item) => item instanceof LoadMoreTreeItem)).toBe(false);
  });

  /**
   * A command of its own, not the configuration tree's: the two trees page
   * different listings out of different caches, and one id between them would
   * send every click to whichever provider was registered last.
   */
  it('points the Load more command at the namespace it pages, through the service tree command', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'a')], [service('cl-gateway', 'b')])
    });
    const provider = providerFor(client);

    const { namespaceItem, children } = await expandNamespace(provider);
    const loadMoreItem = children[children.length - 1];

    expect(loadMoreItem.command?.command).toBe('atNacos.loadMoreServices');
    expect(loadMoreItem.command?.arguments).toEqual([namespaceItem]);
    expect(loadMoreItem.tooltip).toContain('services');
  });

  it('asks for the next page only, once per Load more', async () => {
    const { client, serviceQueries } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'a')], [service('cl-gateway', 'b')], [service('cl-mu', 'c')])
    });
    const provider = providerFor(client);

    const { namespaceItem } = await expandNamespace(provider);
    await provider.loadMore(namespaceItem);

    expect(serviceQueries.map((query) => query.pageNo)).toEqual([1, 2]);
  });

  /**
   * The point of the whole exercise: Load more has to *add* to what is on
   * screen. Rebuilding the namespace's children from the second page alone
   * would drop the first, and the groups the user is reading would vanish.
   */
  it('grows the group set on Load more without discarding the pages already loaded', async () => {
    const { client } = recordingClient({
      services: pagesOf(
        [service('cl-intimfy', 'merchant-admin'), service('cl-gateway', 'gateway')],
        [service('cl-intimfy', 'order'), service('cl-mu', 'mu')]
      )
    });
    const provider = providerFor(client);

    const { namespaceItem, children } = await expandNamespace(provider);
    await provider.loadMore(namespaceItem);
    const grown = await provider.getChildren(namespaceItem);
    const intimfy = groupsIn(grown).find((item) => item.label === 'cl-intimfy');

    expect(groupsIn(children).map((item) => item.label)).toEqual(['cl-gateway', 'cl-intimfy']);
    expect(groupsIn(grown).map((item) => item.label)).toEqual(['cl-gateway', 'cl-intimfy', 'cl-mu']);
    expect((await provider.getChildren(intimfy)).map((item) => item.label)).toEqual(['merchant-admin', 'order']);
    expect(grown.some((item) => item instanceof LoadMoreTreeItem)).toBe(false);
  });

  /** The group a second page introduces has to be expandable, not merely visible. */
  it('lists the services of a group that only the second page introduced', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'merchant-admin')], [service('cl-taskcenter', 'taskcenter')])
    });
    const provider = providerFor(client);

    const { namespaceItem } = await expandNamespace(provider);
    await provider.loadMore(namespaceItem);
    const grown = await provider.getChildren(namespaceItem);
    const introduced = groupsIn(grown).find((item) => item.label === 'cl-taskcenter');

    expect(introduced).toBeDefined();
    expect((await provider.getChildren(introduced)).map((item) => item.label)).toEqual(['taskcenter']);
  });

  /**
   * VS Code keys a node's expanded state on its id. A group that is rebuilt
   * with a different id after Load more is a different node to the view, so it
   * redraws collapsed and the user loses the place they were reading.
   */
  it('keeps the id of a group stable when a later page adds services to it', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'merchant-admin')], [service('cl-intimfy', 'order')])
    });
    const provider = providerFor(client);

    const { namespaceItem, children } = await expandNamespace(provider);
    await provider.loadMore(namespaceItem);
    const grown = await provider.getChildren(namespaceItem);

    expect(groupsIn(grown)[0].id).toBe(groupsIn(children)[0].id);
  });

  /**
   * Firing undefined redraws the tree from the root, which collapses every
   * node the user has open -- including the group they clicked Load more to
   * add to. The base class makes the emitter protected for exactly this.
   */
  it('redraws only the namespace it paged, so the rest of the tree stays expanded', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'a')], [service('cl-gateway', 'b')])
    });
    const provider = providerFor(client);
    const { namespaceItem } = await expandNamespace(provider);
    const changed: Array<NacosTreeItem | undefined | void> = [];
    provider.onDidChangeTreeData((element) => changed.push(element));

    await provider.loadMore(namespaceItem);

    expect(changed).toEqual([namespaceItem]);
  });

  it('renders a service only once when a later page repeats it', async () => {
    const repeated = service('cl-intimfy', 'merchant-admin');
    const { client } = recordingClient({
      services: pagesOf([repeated], [repeated, service('cl-intimfy', 'order')])
    });
    const provider = providerFor(client);

    const { namespaceItem } = await expandNamespace(provider);
    await provider.loadMore(namespaceItem);
    const grown = await provider.getChildren(namespaceItem);
    const services = await provider.getChildren(groupsIn(grown)[0]);

    expect(services.map((item) => item.label)).toEqual(['merchant-admin', 'order']);
  });

  it('keeps the pages already loaded when the next page fails', async () => {
    const { client, serviceQueries } = recordingClient({
      services: (query) => {
        if (query.pageNo === 2) {
          throw new Error('connect ETIMEDOUT 10.0.0.9:8848');
        }
        return { items: [service('cl-intimfy', 'a')], totalCount: 2, pageNumber: 1, pagesAvailable: 2 };
      }
    });
    const provider = providerFor(client);

    const { namespaceItem } = await expandNamespace(provider);
    await expect(provider.loadMore(namespaceItem)).rejects.toThrow('ETIMEDOUT');
    const afterFailure = await provider.getChildren(namespaceItem);

    expect(groupsIn(afterFailure).map((item) => item.label)).toEqual(['cl-intimfy']);
    expect(afterFailure.some((item) => item instanceof LoadMoreTreeItem)).toBe(true);
    expect(serviceQueries.map((query) => query.pageNo)).toEqual([1, 2]);
  });

  it('collapses concurrent expansions of one namespace into a single request', async () => {
    const { client, serviceQueries } = recordingClient({ services: pagesOf([service('cl-intimfy', 'a')]) });
    const provider = providerFor(client);

    const { children } = await expandInstance(provider);
    await Promise.all([provider.getChildren(children[0]), provider.getChildren(children[0])]);

    expect(serviceQueries).toHaveLength(1);
  });

  it('collapses concurrent expansions of one service into a single instance request', async () => {
    const { client, instanceQueries } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'merchant-admin')]),
      instances: () => [host('192.168.99.92', 8088)]
    });
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);
    const [serviceItem] = await provider.getChildren(children[0]);
    await Promise.all([provider.getChildren(serviceItem), provider.getChildren(serviceItem)]);

    expect(instanceQueries).toHaveLength(1);
  });

  it('drops the loaded pages on refresh() so the next expansion starts at page one again', async () => {
    const { client, serviceQueries } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'a')], [service('cl-mu', 'b')])
    });
    const provider = providerFor(client);

    const { namespaceItem } = await expandNamespace(provider);
    await provider.loadMore(namespaceItem);
    provider.refresh();
    const afterRefresh = await provider.getChildren(namespaceItem);

    expect(serviceQueries.map((query) => query.pageNo)).toEqual([1, 2, 1]);
    expect(groupsIn(afterRefresh).map((item) => item.label)).toEqual(['cl-intimfy']);
  });

  it('ignores a Load more for a namespace whose pages were dropped, rather than paging past page one', async () => {
    const { client, serviceQueries } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'a')], [service('cl-mu', 'b')])
    });
    const provider = providerFor(client);

    const { namespaceItem } = await expandNamespace(provider);
    provider.refresh();
    await provider.loadMore(namespaceItem);

    expect(serviceQueries.map((query) => query.pageNo)).toEqual([1]);
  });
});

describe('ServiceTreeProvider failures', () => {
  it('renders a failing service listing as an error node under the namespace', async () => {
    const { client } = recordingClient({
      services: () => {
        throw new Error('Nacos answered 403 for /v1/ns/catalog/services');
      }
    });
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorTreeItem);
    expect(children[0].description).toContain('Nacos answered 403 for /v1/ns/catalog/services');
  });

  /**
   * The service listing is per namespace, so a namespace that cannot be
   * listed takes its own group level down with it -- and must take nobody
   * else's.
   */
  it('keeps one namespace loading when the service listing of another fails', async () => {
    const { client } = recordingClient({
      services: (query) => {
        if (query.namespaceId === 'broken') {
          throw new Error('host unreachable');
        }
        return pagesOf([service('cl-intimfy', 'merchant-admin')])(query);
      },
      namespaces: [namespace({ namespaceId: 'healthy' }), namespace({ namespaceId: 'broken' })]
    });
    const provider = providerFor(client);

    const healthy = await expandNamespace(provider, 0);
    const broken = await expandNamespace(provider, 1);

    expect(groupsIn(healthy.children).map((item) => item.label)).toEqual(['cl-intimfy']);
    expect(broken.children).toHaveLength(1);
    expect(broken.children[0]).toBeInstanceOf(ErrorTreeItem);
    expect(healthy.children[0].id).not.toBe(broken.children[0].id);
  });

  /**
   * A namespace and a group of it can be showing an error in the same draw --
   * a refresh that starts failing reaches both. VS Code identifies at most one
   * item per id, so the two error nodes cannot share one.
   */
  it('gives a failing group an error node of its own rather than the one its namespace uses', async () => {
    let failing = false;
    const { client } = recordingClient({
      services: (query) => {
        if (failing) {
          throw new Error('host unreachable');
        }
        return pagesOf([service('cl-intimfy', 'merchant-admin')])(query);
      }
    });
    const provider = providerFor(client);

    const { namespaceItem, children } = await expandNamespace(provider);
    provider.refresh();
    failing = true;
    const underNamespace = await provider.getChildren(namespaceItem);
    const underGroup = await provider.getChildren(children[0]);

    expect(underNamespace[0]).toBeInstanceOf(ErrorTreeItem);
    expect(underGroup[0]).toBeInstanceOf(ErrorTreeItem);
    expect(underNamespace[0].id).not.toBe(underGroup[0].id);
  });

  /**
   * Each service's instances are a request of their own, so one service that
   * cannot be read must leave its siblings exactly as they were -- an error
   * that swallowed the group would hide every healthy service in it.
   */
  it('reports a failing instance listing under that service alone, leaving its siblings intact', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'broken'), service('cl-intimfy', 'healthy')]),
      instances: (query) => {
        if (query.serviceName === 'broken') {
          throw new Error('Nacos answered 500 for /v1/ns/instance/list');
        }
        return [host('192.168.99.92', 8088)];
      }
    });
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);
    const [brokenService, healthyService] = await provider.getChildren(children[0]);
    const underBroken = await provider.getChildren(brokenService);
    const underHealthy = await provider.getChildren(healthyService);

    expect(underBroken).toHaveLength(1);
    expect(underBroken[0]).toBeInstanceOf(ErrorTreeItem);
    expect(underBroken[0].description).toContain('/v1/ns/instance/list');
    expect(underHealthy.map((item) => item.label)).toEqual(['192.168.99.92:8088']);
    expect(underBroken[0].id).not.toBe(children[0].id);
  });

  it('gives the error node of each failing service an id of its own', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'first'), service('cl-intimfy', 'second')]),
      instances: () => {
        throw new Error('host unreachable');
      }
    });
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);
    const services = await provider.getChildren(children[0]);
    const [firstError] = await provider.getChildren(services[0]);
    const [secondError] = await provider.getChildren(services[1]);

    expect(firstError.id).toBeDefined();
    expect(firstError.id).not.toBe(secondError.id);
  });

  it('retries a failed service listing instead of replaying the same rejection', async () => {
    let attempts = 0;
    const { client } = recordingClient({
      services: (query) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('connect ETIMEDOUT 10.0.0.9:8848');
        }
        return pagesOf([service('cl-intimfy', 'merchant-admin')])(query);
      }
    });
    const provider = providerFor(client);

    const { namespaceItem, children } = await expandNamespace(provider);
    const second = await provider.getChildren(namespaceItem);

    expect(children[0]).toBeInstanceOf(ErrorTreeItem);
    expect(groupsIn(second).map((item) => item.label)).toEqual(['cl-intimfy']);
  });

  it('retries a failed instance listing instead of replaying the same rejection', async () => {
    let attempts = 0;
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'merchant-admin')]),
      instances: () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('connect ETIMEDOUT 10.0.0.9:8848');
        }
        return [host('192.168.99.92', 8088)];
      }
    });
    const provider = providerFor(client);

    const { serviceItem, instances } = await expandFirstService(provider);
    const second = await provider.getChildren(serviceItem);

    expect(instances[0]).toBeInstanceOf(ErrorTreeItem);
    expect(second.map((item) => item.label)).toEqual(['192.168.99.92:8088']);
  });

  it('redacts credentials out of the error node it renders under a namespace', async () => {
    const { client } = recordingClient({
      services: () => {
        throw new Error('GET /v1/ns/service/list?username=nacos&password=hunter2 failed');
      }
    });
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);

    expect(children[0].description).not.toContain('hunter2');
    expect(children[0].description).toContain('[REDACTED]');
  });
});

describe('ServiceTreeProvider item identity', () => {
  it('keeps group, service and instance ids distinct across two namespaces holding the same names', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('shared', 'merchant-admin')]),
      instances: () => [host('192.168.99.92', 8088)],
      namespaces: [namespace({ namespaceId: 'uat' }), namespace({ namespaceId: 'prod' })]
    });
    const provider = providerFor(client);

    const uat = await expandNamespace(provider, 0);
    const prod = await expandNamespace(provider, 1);
    const [uatService] = await provider.getChildren(uat.children[0]);
    const [prodService] = await provider.getChildren(prod.children[0]);
    const [uatInstance] = await provider.getChildren(uatService);
    const [prodInstance] = await provider.getChildren(prodService);

    expect(uat.children[0].id).not.toBe(prod.children[0].id);
    expect(uatService.id).not.toBe(prodService.id);
    expect(uatInstance.id).not.toBe(prodInstance.id);
  });

  /**
   * `@@` is Nacos's own separator between a group and a service name, and it
   * can survive into a service name -- `splitGroupedServiceName` splits at the
   * first one and keeps the rest. Two services whose group and name differ
   * only in where that separator falls must still be two nodes.
   */
  it('keeps service ids distinct when the Nacos group separator appears inside a service name', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy@@x', 'order'), service('cl-intimfy', 'x@@order')])
    });
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);
    const [first] = await provider.getChildren(children[0]);
    const [second] = await provider.getChildren(children[1]);

    expect(children[0].id).not.toBe(children[1].id);
    expect(first.id).not.toBe(second.id);
    expect(String(first.id)).not.toContain('@@');
  });

  it('scopes every node it adds to the service view, so the configuration tree cannot collide with it', async () => {
    const { client } = recordingClient({
      services: pagesOf([service('cl-intimfy', 'merchant-admin')], [service('cl-mu', 'mu')]),
      instances: () => [host('192.168.99.92', 8088)]
    });
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);
    const services = await provider.getChildren(groupsIn(children)[0]);
    const instances = await provider.getChildren(services[0]);

    for (const item of [...children, ...services, ...instances]) {
      expect(String(item.id), String(item.label)).toMatch(/^atNacos\.service\./);
    }
  });
});

describe('ServiceTreeProvider localization', () => {
  it('routes every label it authors through a key the zh-cn bundle actually translates', async () => {
    // A source string that reaches `t()` but is missing from the bundle falls
    // back to English silently, so nothing but a check like this notices that
    // the tree shipped half-translated.
    const bundle = JSON.parse(readFileSync(resolve(process.cwd(), 'l10n/bundle.l10n.zh-cn.json'), 'utf8')) as Record<
      string,
      string
    >;
    const sources: string[] = [];
    vi.spyOn(vscode.l10n, 't').mockImplementation((messageOrOptions: string | { message: string }) => {
      const message = typeof messageOrOptions === 'string' ? messageOrOptions : messageOrOptions.message;
      sources.push(message);
      return message;
    });
    const { client } = recordingClient({
      services: pagesOf(
        [
          service('cl-intimfy', 'counted'),
          service('cl-intimfy', 'uncounted', { instanceCount: undefined, healthyInstanceCount: undefined })
        ],
        [service('cl-taskcenter', 'taskcenter')]
      ),
      instances: () => [
        host('192.168.99.92', 8088, { metadata: { 'preserved.register.source': 'SPRING_CLOUD' } }),
        host('192.168.99.93', 8088, { healthy: false, enabled: false, clusterName: '' })
      ]
    });
    const provider = providerFor(client, instance({ readOnly: true }));

    const { children } = await expandNamespace(provider);
    const services = await provider.getChildren(groupsIn(children)[0]);
    await provider.getChildren(services[0]);
    await provider.getChildren(services[1]);

    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(Object.keys(bundle), source).toContain(source);
    }
  });
});
