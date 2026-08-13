import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { parseNacosInstanceConfig, type NacosInstanceConfig } from '../../src/config/schema';
import { openConfigDocument } from '../../src/document/openConfigDocument';
import type { NacosConfigListQuery } from '../../src/nacos/driver/NacosDriver';
import type { NacosConfigSummary, NacosNamespace, Paged } from '../../src/nacos/driver/normalize';
import { ConfigTreeProvider, type NacosConfigTreeClient } from '../../src/tree/ConfigTreeProvider';
import {
  ConfigTreeItem,
  ErrorTreeItem,
  GroupTreeItem,
  InstanceTreeItem,
  LoadMoreTreeItem,
  NamespaceTreeItem,
  type NacosTreeItem
} from '../../src/tree/NacosTreeItems';

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

function emptyPage(): Paged<NacosConfigSummary> {
  return { items: [], totalCount: 0, pageNumber: 1, pagesAvailable: 1 };
}

function stubClient(namespaces: NacosNamespace[], majorVersion = 3): NacosConfigTreeClient {
  return {
    state: {
      version: `${majorVersion}.0.0`,
      majorVersion,
      startupMode: 'standalone',
      authEnabled: false,
      raw: {}
    },
    listNamespaces: async () => namespaces,
    listConfigs: async () => emptyPage()
  };
}

function config(group: string, dataId: string, overrides: Partial<NacosConfigSummary> = {}): NacosConfigSummary {
  return { namespaceId: 'ns-staging', group, dataId, type: 'yaml', ...overrides };
}

/**
 * A listing served from fixed pages, answering whichever page number it was
 * asked for. `pagesAvailable` is what the tree reads to decide whether to
 * offer Load more, so it follows the fixture rather than being stated twice.
 */
function pagesOf(...pages: NacosConfigSummary[][]) {
  return (query: NacosConfigListQuery): Paged<NacosConfigSummary> => ({
    items: pages[query.pageNo - 1] ?? [],
    totalCount: pages.reduce((sum, page) => sum + page.length, 0),
    pageNumber: query.pageNo,
    pagesAvailable: pages.length
  });
}

/**
 * A client that records every config query it was handed. The page number and
 * the search term are the whole subject of the paging and filtering tests, and
 * they are visible nowhere else -- the tree items only show the result.
 */
function recordingClient(
  respond: (query: NacosConfigListQuery) => Paged<NacosConfigSummary>,
  namespaces: NacosNamespace[] = [namespace()]
) {
  const queries: NacosConfigListQuery[] = [];
  return {
    queries,
    client: {
      ...stubClient(namespaces),
      listConfigs: async (query: NacosConfigListQuery) => {
        queries.push(query);
        return respond(query);
      }
    } satisfies NacosConfigTreeClient
  };
}

/** The one instance / one client shape most tests want. */
function providerFor(client: NacosConfigTreeClient, inst = instance()): ConfigTreeProvider {
  return new ConfigTreeProvider({ listInstances: async () => [inst] }, async () => client);
}

async function expandInstance(provider: ConfigTreeProvider, index = 0) {
  const roots = await provider.getChildren();
  return provider.getChildren(roots[index]);
}

async function expandNamespace(provider: ConfigTreeProvider, index = 0) {
  const namespaces = await expandInstance(provider);
  const namespaceItem = namespaces[index] as NamespaceTreeItem;
  return { namespaceItem, children: await provider.getChildren(namespaceItem) };
}

function groupsIn(children: NacosTreeItem[]): GroupTreeItem[] {
  return children.filter((item): item is GroupTreeItem => item instanceof GroupTreeItem);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ConfigTreeProvider root level', () => {
  it('returns no root children when no instance is configured, so the viewsWelcome "Add Instance" button renders', async () => {
    const provider = new ConfigTreeProvider({ listInstances: async () => [] }, async () => {
      throw new Error('createClient must not be called when there is no instance');
    });

    expect(await provider.getChildren()).toEqual([]);
  });

  it('lists one collapsed InstanceTreeItem per configured instance', async () => {
    const instances = [instance({ id: 'a', label: 'A' }), instance({ id: 'b', label: 'B' })];
    const provider = new ConfigTreeProvider({ listInstances: async () => instances }, async () => stubClient([]));

    const roots = await provider.getChildren();

    expect(roots).toHaveLength(2);
    expect(roots.every((root) => root instanceof InstanceTreeItem)).toBe(true);
    expect(roots.map((root) => root.label)).toEqual(['A', 'B']);
    expect(roots.map((root) => root.collapsibleState)).toEqual([
      vscode.TreeItemCollapsibleState.Collapsed,
      vscode.TreeItemCollapsibleState.Collapsed
    ]);
  });

  it('shows the server URL as the instance tooltip', async () => {
    const provider = providerFor(stubClient([]), instance({ serverUrl: 'http://10.0.0.9:8848/nacos' }));

    const [root] = await provider.getChildren();

    expect(root.tooltip).toBe('http://10.0.0.9:8848/nacos');
  });

  /**
   * The tooltip is the stored address verbatim, so it is only ever as clean as
   * the store. `parseNacosInstanceConfig` is what every instance reaching the
   * tree has been through, which is why the fixture goes through it here.
   */
  it('shows no credential in the tooltip of an instance whose address was typed with one', async () => {
    const stored = parseNacosInstanceConfig({
      ...instance(),
      serverUrl: 'http://admin:hunter2@nacos.example.com:8848/nacos'
    });
    const provider = providerFor(stubClient([]), stored);

    const [root] = await provider.getChildren();

    expect(root.tooltip).toBe('http://nacos.example.com:8848/nacos');
  });

  it('marks a read-only instance in its contextValue so M5 menus can hide write commands', async () => {
    const provider = providerFor(stubClient([]), instance({ readOnly: true }));

    const [root] = await provider.getChildren();

    expect(root.contextValue).toBe('atNacos.instance.readonly');
  });

  it('labels a read-only instance in the UI, not only in its contextValue', async () => {
    const readOnly = providerFor(stubClient([]), instance({ readOnly: true }));
    const writable = providerFor(stubClient([]), instance({ readOnly: false }));

    const [readOnlyRoot] = await readOnly.getChildren();
    const [writableRoot] = await writable.getChildren();

    expect(readOnlyRoot.description).toBe('read-only');
    expect(writableRoot.description).toBeUndefined();
  });

  it('leaves a writable instance without the readonly contextValue suffix', async () => {
    const provider = providerFor(stubClient([]));

    const [root] = await provider.getChildren();

    expect(root.contextValue).toBe('atNacos.instance');
  });

  /**
   * `listInstances` throws when a stored record no longer parses. Returning an
   * empty array here would show "No Nacos instance configured" -- an answer
   * that is not merely unhelpful but wrong, and whose Add Instance button
   * writes over the record the user might still want repaired.
   */
  it('reports a corrupt instance list as an error node rather than as an empty tree', async () => {
    const provider = new ConfigTreeProvider(
      {
        listInstances: async () => {
          throw new Error('atNacos.instances is not a valid instance list');
        }
      },
      async () => stubClient([])
    );

    const roots = await provider.getChildren();

    expect(roots).toHaveLength(1);
    expect(roots[0]).toBeInstanceOf(ErrorTreeItem);
    expect(roots[0].description).toContain('atNacos.instances is not a valid instance list');
  });

  it('returns tree items from getTreeItem unchanged', async () => {
    const provider = providerFor(stubClient([]));

    const [root] = await provider.getChildren();

    expect(provider.getTreeItem(root)).toBe(root);
  });
});

describe('ConfigTreeProvider namespace level', () => {
  it('expands an instance into one collapsed NamespaceTreeItem per namespace', async () => {
    const provider = providerFor(
      stubClient([namespace({ namespaceId: 'ns-a', displayName: 'A' }), namespace({ namespaceId: 'ns-b', displayName: 'B' })])
    );

    const namespaces = await expandInstance(provider);

    expect(namespaces).toHaveLength(2);
    expect(namespaces.every((item) => item instanceof NamespaceTreeItem)).toBe(true);
    expect(namespaces.map((item) => item.label)).toEqual(['A', 'B']);
    expect(namespaces.map((item) => item.collapsibleState)).toEqual([
      vscode.TreeItemCollapsibleState.Collapsed,
      vscode.TreeItemCollapsibleState.Collapsed
    ]);
    expect(namespaces.map((item) => item.contextValue)).toEqual(['atNacos.namespace', 'atNacos.namespace']);
  });

  /**
   * M5 publishes configurations from a namespace node, not only from the
   * instance node, so the suffix the write menus key on has to reach here
   * too. Adding it once those menus exist means auditing every one of them.
   */
  it('carries the read-only suffix down to the namespace nodes of a read-only instance', async () => {
    const provider = providerFor(stubClient([namespace()]), instance({ readOnly: true }));

    const [namespaceItem] = await expandInstance(provider);

    expect(namespaceItem.contextValue).toBe('atNacos.namespace.readonly');
  });

  it('renders nothing under a namespace that holds no configuration at all', async () => {
    const provider = providerFor(stubClient([namespace()]));

    const [namespaceItem] = await expandInstance(provider);

    expect(await provider.getChildren(namespaceItem)).toEqual([]);
  });

  /** 1.x reports the default namespace with an empty id *and* an empty name; an unlabelled node is unusable. */
  it('labels the 1.x public namespace, which arrives with an empty id and an empty name', async () => {
    const provider = providerFor(stubClient([namespace({ namespaceId: '', displayName: '', type: 0 })], 1));

    const [publicItem] = await expandInstance(provider);

    expect(publicItem.label).toBe('public');
  });

  it('labels the 3.x public namespace, whose id is the literal "public"', async () => {
    const provider = providerFor(stubClient([namespace({ namespaceId: 'public', displayName: 'public', type: 0 })], 3));

    const [publicItem] = await expandInstance(provider);

    expect(publicItem.label).toBe('public');
  });

  /**
   * A 3.x server whose v3 endpoints are switched off answers through the v1/v2
   * fallback drivers, which spell the default namespace the old way. Keying
   * only on the major version would leave that node blank.
   */
  it('labels an empty namespace id as public even when the server reports a 3.x version', async () => {
    const provider = providerFor(stubClient([namespace({ namespaceId: '', displayName: '', type: 0 })], 3));

    const [publicItem] = await expandInstance(provider);

    expect(publicItem.label).toBe('public');
  });

  /**
   * A custom namespace saved with a blank display name looks like the 1.x
   * public namespace and is not one: it has an id, and calling it "public"
   * would send the user's config edits to the wrong namespace.
   */
  it('falls back to the id for a custom namespace whose display name is blank, never to the public label', async () => {
    const provider = providerFor(stubClient([namespace({ namespaceId: '4b1f-blank', displayName: '', type: 2 })], 1));

    const [blankItem] = await expandInstance(provider);

    expect(blankItem.label).toBe('4b1f-blank');
    expect(blankItem.description).toBeUndefined();
  });

  it('shows the raw namespace id beside a named namespace, because that is what an application config has to quote', async () => {
    const provider = providerFor(stubClient([namespace({ namespaceId: 'ns-staging', displayName: 'Staging' })]));

    const [namespaceItem] = await expandInstance(provider);

    expect(namespaceItem.description).toBe('ns-staging');
  });

  it('carries the namespace description into the tooltip when the server supplies one', async () => {
    const provider = providerFor(stubClient([namespace({ description: 'Pre-production namespace' })]));

    const [namespaceItem] = await expandInstance(provider);

    expect(namespaceItem.tooltip).toBe('Pre-production namespace');
  });

  it('keeps the normalized namespace on the item so M2 can list configurations under it', async () => {
    const target = namespace({ namespaceId: 'ns-staging', configCount: 12 });
    const provider = providerFor(stubClient([target]));

    const [namespaceItem] = await expandInstance(provider);

    expect((namespaceItem as NamespaceTreeItem).namespace).toEqual(target);
    expect((namespaceItem as NamespaceTreeItem).instance.id).toBe('instance-1');
  });
});

describe('ConfigTreeProvider failures', () => {
  it('renders a failing client factory as an error node under the instance instead of throwing', async () => {
    const provider = new ConfigTreeProvider({ listInstances: async () => [instance()] }, async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.9:8848');
    });

    const children = await expandInstance(provider);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorTreeItem);
    expect(children[0].description).toContain('connect ECONNREFUSED 10.0.0.9:8848');
  });

  it('renders a failing namespace listing as an error node under the instance', async () => {
    const provider = providerFor({
      ...stubClient([]),
      listNamespaces: async () => {
        throw new Error('Nacos answered 403 for /v3/admin/core/namespace/list');
      }
    });

    const children = await expandInstance(provider);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorTreeItem);
  });

  /** Credentials reach error messages through URLs and request bodies; the tree renders them verbatim otherwise. */
  it('redacts credentials out of the error node it renders', async () => {
    const provider = new ConfigTreeProvider({ listInstances: async () => [instance()] }, async () => {
      throw new Error('login failed: POST /v1/auth/login?username=nacos&password=hunter2');
    });

    const [errorItem] = await expandInstance(provider);

    expect(errorItem.label).not.toContain('hunter2');
    expect(errorItem.description).not.toContain('hunter2');
    expect(errorItem.tooltip).not.toContain('hunter2');
    expect(errorItem.description).toContain('[REDACTED]');
  });

  it('keeps the other instances loading when one of them fails, and attaches the error to the one that failed', async () => {
    const good = instance({ id: 'good', label: 'Good' });
    const bad = instance({ id: 'bad', label: 'Bad' });
    const provider = new ConfigTreeProvider({ listInstances: async () => [good, bad] }, async (target) => {
      if (target.id === 'bad') {
        throw new Error('host unreachable');
      }
      return stubClient([namespace({ namespaceId: 'ns-good', displayName: 'Good NS' })]);
    });

    const roots = await provider.getChildren();
    const goodChildren = await provider.getChildren(roots[0]);
    const badChildren = await provider.getChildren(roots[1]);

    expect(goodChildren.map((item) => item.label)).toEqual(['Good NS']);
    expect(badChildren).toHaveLength(1);
    expect(badChildren[0]).toBeInstanceOf(ErrorTreeItem);
  });
});

describe('ConfigTreeProvider caching and refresh', () => {
  it('collapses concurrent expansions of one instance into a single fetch by caching the in-flight promise', async () => {
    let releaseNamespaces: (value: NacosNamespace[]) => void = () => undefined;
    const pending = new Promise<NacosNamespace[]>((resolvePending) => {
      releaseNamespaces = resolvePending;
    });
    let created = 0;
    const provider = new ConfigTreeProvider({ listInstances: async () => [instance()] }, async () => {
      created += 1;
      return { ...stubClient([]), listNamespaces: () => pending };
    });

    const [root] = await provider.getChildren();
    const first = provider.getChildren(root);
    const second = provider.getChildren(root);
    releaseNamespaces([namespace()]);
    const [firstChildren, secondChildren] = await Promise.all([first, second]);

    expect(created).toBe(1);
    expect(firstChildren).toHaveLength(1);
    expect(secondChildren).toHaveLength(1);
  });

  it('gives each instance its own cache entry when two are expanded concurrently', async () => {
    const first = instance({ id: 'first', label: 'First' });
    const second = instance({ id: 'second', label: 'Second' });
    const asked: string[] = [];
    const provider = new ConfigTreeProvider({ listInstances: async () => [first, second] }, async (target) => {
      asked.push(target.id);
      return stubClient([namespace({ namespaceId: `ns-${target.id}`, displayName: `NS ${target.id}` })]);
    });

    const roots = await provider.getChildren();
    const [firstChildren, secondChildren] = await Promise.all([
      provider.getChildren(roots[0]),
      provider.getChildren(roots[1])
    ]);

    expect(asked.sort()).toEqual(['first', 'second']);
    expect(firstChildren.map((item) => item.label)).toEqual(['NS first']);
    expect(secondChildren.map((item) => item.label)).toEqual(['NS second']);
  });

  it('re-fetches after refresh() rather than serving the cached namespaces', async () => {
    let created = 0;
    const provider = new ConfigTreeProvider({ listInstances: async () => [instance()] }, async () => {
      created += 1;
      return stubClient([namespace()]);
    });

    const [root] = await provider.getChildren();
    await provider.getChildren(root);
    await provider.getChildren(root);
    expect(created).toBe(1);

    provider.refresh();
    await provider.getChildren(root);

    expect(created).toBe(2);
  });

  /**
   * Collapsing a failed instance and expanding it again is the retry gesture
   * everyone reaches for. A rejected promise is truthy, so a cache that keeps
   * it replays one settled rejection for the rest of the session and only the
   * view-title Refresh clears it -- exactly the trap `UserPasswordStrategy`
   * documents for its own in-flight login.
   */
  it('retries a failed expansion instead of replaying the same rejection', async () => {
    let attempts = 0;
    const provider = new ConfigTreeProvider({ listInstances: async () => [instance()] }, async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('connect ETIMEDOUT 10.0.0.9:8848');
      }
      return stubClient([namespace({ namespaceId: 'ns-a', displayName: 'A' })]);
    });

    const [root] = await provider.getChildren();
    const first = await provider.getChildren(root);
    const second = await provider.getChildren(root);

    expect(first[0]).toBeInstanceOf(ErrorTreeItem);
    expect(attempts).toBe(2);
    expect(second.map((item) => item.label)).toEqual(['A']);
  });

  /** Evicting the failures must not turn into evicting everything. */
  it('still caches a successful expansion', async () => {
    let attempts = 0;
    const provider = new ConfigTreeProvider({ listInstances: async () => [instance()] }, async () => {
      attempts += 1;
      return stubClient([namespace()]);
    });

    const [root] = await provider.getChildren();
    await provider.getChildren(root);
    await provider.getChildren(root);

    expect(attempts).toBe(1);
  });

  it('evicts only the instance that failed, leaving another instance cached', async () => {
    const attempts: string[] = [];
    const good = instance({ id: 'good', label: 'Good' });
    const bad = instance({ id: 'bad', label: 'Bad' });
    const provider = new ConfigTreeProvider({ listInstances: async () => [good, bad] }, async (target) => {
      attempts.push(target.id);
      if (target.id === 'bad') {
        throw new Error('host unreachable');
      }
      return stubClient([namespace({ namespaceId: 'ns-good', displayName: 'Good NS' })]);
    });

    const roots = await provider.getChildren();
    await Promise.all([provider.getChildren(roots[0]), provider.getChildren(roots[1])]);
    await Promise.all([provider.getChildren(roots[0]), provider.getChildren(roots[1])]);

    expect(attempts).toEqual(['good', 'bad', 'bad']);
  });

  /**
   * Mirrors `NacosCapabilityResolver`'s identity check. Without it the
   * rejection of the abandoned load deletes whatever is under its key by then
   * -- which, after a Refresh during a slow expansion, is a healthy in-flight
   * fetch, and the next expansion opens a third one.
   */
  it('does not evict the fetch a refresh started while the failing one was still in flight', async () => {
    let attempts = 0;
    let failFirst: (error: Error) => void = () => undefined;
    const provider = new ConfigTreeProvider({ listInstances: async () => [instance()] }, async () => {
      attempts += 1;
      if (attempts === 1) {
        await new Promise<never>((_resolve, rejectFirst) => {
          failFirst = rejectFirst;
        });
      }
      return stubClient([namespace()]);
    });

    const [root] = await provider.getChildren();
    const abandoned = provider.getChildren(root);
    provider.refresh();
    const replacement = provider.getChildren(root);

    failFirst(new Error('connect ETIMEDOUT 10.0.0.9:8848'));
    expect((await abandoned)[0]).toBeInstanceOf(ErrorTreeItem);
    await replacement;
    await provider.getChildren(root);

    expect(attempts).toBe(2);
  });

  it('fires onDidChangeTreeData on refresh() so the view redraws', async () => {
    const provider = providerFor(stubClient([]));
    let fired = 0;
    provider.onDidChangeTreeData(() => {
      fired += 1;
    });

    provider.refresh();

    expect(fired).toBe(1);
  });
});

describe('ConfigTreeProvider item identity', () => {
  it('keeps namespace ids distinct across two instances that share a namespace id', async () => {
    const first = instance({ id: 'first' });
    const second = instance({ id: 'second' });
    const provider = new ConfigTreeProvider({ listInstances: async () => [first, second] }, async () =>
      stubClient([namespace({ namespaceId: 'public', displayName: 'public', type: 0 })])
    );

    const roots = await provider.getChildren();
    const [firstNamespace] = await provider.getChildren(roots[0]);
    const [secondNamespace] = await provider.getChildren(roots[1]);

    expect(roots[0].id).not.toBe(roots[1].id);
    expect(firstNamespace.id).not.toBe(secondNamespace.id);
  });

  /** An error node per instance, both labelled "Failed to load"; VS Code derives an id from the label without one. */
  it('gives the error node of each failing instance an id of its own', async () => {
    const provider = new ConfigTreeProvider(
      { listInstances: async () => [instance({ id: 'first' }), instance({ id: 'second' })] },
      async () => {
        throw new Error('host unreachable');
      }
    );

    const roots = await provider.getChildren();
    const [firstError] = await provider.getChildren(roots[0]);
    const [secondError] = await provider.getChildren(roots[1]);

    expect(firstError.id).toBeDefined();
    expect(firstError.id).not.toBe(secondError.id);
  });
});

describe('ConfigTreeProvider localization', () => {
  it('routes every label it authors through a key the zh-cn bundle actually translates', async () => {
    // A source string that reaches `t()` but is missing from the bundle falls
    // back to English silently, so nothing but a check like this notices that
    // the tree shipped half-translated.
    const bundle = JSON.parse(readFileSync(resolve(process.cwd(), 'l10n/bundle.l10n.zh-cn.json'), 'utf8')) as Record<
      string,
      string
    >;
    const sources: string[] = [];
    // `l10n.t` is overloaded, so the stub has to accept the widest first
    // parameter of the set rather than just the string form the code uses.
    vi.spyOn(vscode.l10n, 't').mockImplementation((messageOrOptions: string | { message: string }) => {
      const message = typeof messageOrOptions === 'string' ? messageOrOptions : messageOrOptions.message;
      sources.push(message);
      return message;
    });
    const healthy = instance({ id: 'healthy', readOnly: true });
    const broken = instance({ id: 'broken' });
    const provider = new ConfigTreeProvider({ listInstances: async () => [healthy, broken] }, async (target) => {
      if (target.id === 'broken') {
        throw new Error('host unreachable');
      }
      return stubClient([namespace({ namespaceId: '', displayName: '', type: 0 })], 1);
    });

    const roots = await provider.getChildren();
    await provider.getChildren(roots[0]);
    await provider.getChildren(roots[1]);

    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(Object.keys(bundle), source).toContain(source);
    }
  });

  it('routes the labels of the three levels below a namespace through the bundle too', async () => {
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
    const { client } = recordingClient(
      pagesOf([config('cl-intimfy', 'application-uat.yml')], [config('cl-gateway', 'gateway.yml')])
    );
    const provider = providerFor(client);
    provider.attachTreeView({ message: undefined });
    provider.setFilter('uat');

    const { children } = await expandNamespace(provider);
    await provider.getChildren(children[0]);

    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(Object.keys(bundle), source).toContain(source);
    }
  });
});

describe('ConfigTreeProvider group level', () => {
  it('expands a namespace into one node per group of the configurations it loaded', async () => {
    const { client } = recordingClient(
      pagesOf([
        config('cl-intimfy', 'application-uat.yml'),
        config('cl-gateway', 'gateway.yml'),
        config('cl-intimfy', 'redis.yml')
      ])
    );
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

  it('asks for the first page of the namespace it was expanded under, a hundred configurations at a time', async () => {
    const { client, queries } = recordingClient(pagesOf([config('cl-intimfy', 'application-uat.yml')]), [
      namespace({ namespaceId: 'uat' })
    ]);
    const provider = providerFor(client);

    await expandNamespace(provider);

    expect(queries).toEqual([{ namespaceId: 'uat', pageNo: 1, pageSize: 100 }]);
  });

  it('counts the configurations loaded into each group', async () => {
    const { client } = recordingClient(
      pagesOf([
        config('cl-intimfy', 'application-uat.yml'),
        config('cl-intimfy', 'redis.yml'),
        config('cl-gateway', 'gateway.yml')
      ])
    );
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);

    expect(children.map((item) => item.description)).toEqual(['1', '2']);
  });

  /**
   * Nacos has no endpoint that lists groups, so the tree can only derive them
   * from the configurations it has loaded -- and that set grows with every
   * page. A user who reads the group list as complete would conclude a group
   * does not exist when it merely has not been paged in yet.
   */
  it('says in the group tooltip that the list only covers the pages loaded so far', async () => {
    const { client } = recordingClient(pagesOf([config('cl-intimfy', 'application-uat.yml')]));
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);

    expect(children[0].tooltip).toContain('cl-intimfy');
    expect(children[0].tooltip).toContain('more groups may appear');
  });

  it('sorts the groups by name so that a later page does not reshuffle the ones on screen', async () => {
    const { client } = recordingClient(
      pagesOf([config('cl-zeta', 'a.yml'), config('cl-alpha', 'b.yml')], [config('cl-mu', 'c.yml')])
    );
    const provider = providerFor(client);

    const { namespaceItem } = await expandNamespace(provider);
    await provider.loadMore(namespaceItem);
    const grown = await provider.getChildren(namespaceItem);

    expect(groupsIn(grown).map((item) => item.label)).toEqual(['cl-alpha', 'cl-mu', 'cl-zeta']);
  });

  it('carries the read-only suffix down to the group nodes of a read-only instance', async () => {
    const { client } = recordingClient(pagesOf([config('cl-intimfy', 'application-uat.yml')]));
    const provider = providerFor(client, instance({ readOnly: true }));

    const { children } = await expandNamespace(provider);

    expect(children[0].contextValue).toBe('atNacos.group.readonly');
  });
});

describe('ConfigTreeProvider configuration level', () => {
  it('expands a group into one leaf node per dataId in that group', async () => {
    const { client } = recordingClient(
      pagesOf([
        config('cl-intimfy', 'application-uat.yml'),
        config('cl-gateway', 'gateway.yml'),
        config('cl-intimfy', 'redis.yml')
      ])
    );
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);
    const configs = await provider.getChildren(children[1]);

    expect(configs.every((item) => item instanceof ConfigTreeItem)).toBe(true);
    expect(configs.map((item) => item.label)).toEqual(['application-uat.yml', 'redis.yml']);
    expect(configs.map((item) => item.collapsibleState)).toEqual([
      vscode.TreeItemCollapsibleState.None,
      vscode.TreeItemCollapsibleState.None
    ]);
    expect(configs.map((item) => item.contextValue)).toEqual(['atNacos.config', 'atNacos.config']);
  });

  it('gives a configuration node a command that opens exactly the configuration it stands for', async () => {
    const target = config('cl-intimfy', 'application-uat.yml', { namespaceId: 'uat' });
    const { client } = recordingClient(pagesOf([target]), [namespace({ namespaceId: 'uat' })]);
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);
    const [configItem] = await provider.getChildren(children[0]);

    expect(configItem.command?.command).toBe('atNacos.openConfig');
    expect(configItem.command?.arguments).toEqual(['instance-1', target]);
  });

  /**
   * The list endpoint sends the whole body of every configuration in the page
   * and `normalizeConfigSummary` drops it at the boundary; this is the guard
   * one layer up. A body reaching a hover would put a database password in it.
   */
  it('shows the group and the dataId in a configuration tooltip, and never the body', async () => {
    const withBody = {
      ...config('cl-intimfy', 'application-uat.yml'),
      content: 'spring:\n  password: hunter2'
    } as NacosConfigSummary;
    const { client } = recordingClient(pagesOf([withBody]));
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);
    const [configItem] = await provider.getChildren(children[0]);

    expect(configItem.tooltip).toContain('cl-intimfy');
    expect(configItem.tooltip).toContain('application-uat.yml');
    expect(configItem.tooltip).not.toContain('hunter2');
    expect(String(configItem.label)).not.toContain('hunter2');
    expect(configItem.description ?? '').not.toContain('hunter2');
  });

  it('carries the read-only suffix down to the configuration nodes of a read-only instance', async () => {
    const { client } = recordingClient(pagesOf([config('cl-intimfy', 'application-uat.yml')]));
    const provider = providerFor(client, instance({ readOnly: true }));

    const { children } = await expandNamespace(provider);
    const [configItem] = await provider.getChildren(children[0]);

    expect(configItem.contextValue).toBe('atNacos.config.readonly');
  });

  it('answers nothing below a configuration node, which is a leaf', async () => {
    const { client } = recordingClient(pagesOf([config('cl-intimfy', 'application-uat.yml')]));
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);
    const [configItem] = await provider.getChildren(children[0]);

    expect(await provider.getChildren(configItem)).toEqual([]);
  });
});

describe('ConfigTreeProvider paging', () => {
  it('offers a Load more node under the namespace once the listing runs past one page', async () => {
    const { client } = recordingClient(pagesOf([config('cl-intimfy', 'a.yml')], [config('cl-gateway', 'b.yml')]));
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);

    expect(children[children.length - 1]).toBeInstanceOf(LoadMoreTreeItem);
    expect(children[children.length - 1].collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
  });

  it('offers no Load more node when the namespace fits in a single page', async () => {
    const { client } = recordingClient(pagesOf([config('cl-intimfy', 'a.yml')]));
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);

    expect(children.some((item) => item instanceof LoadMoreTreeItem)).toBe(false);
  });

  /** The next page can introduce a group that does not exist yet, so the node cannot belong to one. */
  it('hangs Load more under the namespace rather than under a group', async () => {
    const { client } = recordingClient(pagesOf([config('cl-intimfy', 'a.yml')], [config('cl-gateway', 'b.yml')]));
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);
    const underGroup = await provider.getChildren(groupsIn(children)[0]);

    expect(underGroup.some((item) => item instanceof LoadMoreTreeItem)).toBe(false);
  });

  it('points the Load more command at the namespace it pages', async () => {
    const { client } = recordingClient(pagesOf([config('cl-intimfy', 'a.yml')], [config('cl-gateway', 'b.yml')]));
    const provider = providerFor(client);

    const { namespaceItem, children } = await expandNamespace(provider);
    const loadMoreItem = children[children.length - 1];

    expect(loadMoreItem.command?.command).toBe('atNacos.loadMoreConfigs');
    expect(loadMoreItem.command?.arguments).toEqual([namespaceItem]);
  });

  it('asks for the next page only, once per Load more', async () => {
    const { client, queries } = recordingClient(
      pagesOf([config('cl-intimfy', 'a.yml')], [config('cl-gateway', 'b.yml')], [config('cl-mu', 'c.yml')])
    );
    const provider = providerFor(client);

    const { namespaceItem } = await expandNamespace(provider);
    await provider.loadMore(namespaceItem);

    expect(queries.map((query) => query.pageNo)).toEqual([1, 2]);
  });

  /**
   * The point of the whole exercise: Load more has to *add* to what is on
   * screen. Rebuilding the namespace's children from the second page alone
   * would drop the first, and the groups the user is reading would vanish.
   */
  it('grows the group set on Load more without discarding the pages already loaded', async () => {
    const { client } = recordingClient(
      pagesOf(
        [config('cl-intimfy', 'application-uat.yml'), config('cl-gateway', 'gateway.yml')],
        [config('cl-intimfy', 'redis.yml'), config('cl-mu', 'mu.yml')]
      )
    );
    const provider = providerFor(client);

    const { namespaceItem, children } = await expandNamespace(provider);
    await provider.loadMore(namespaceItem);
    const grown = await provider.getChildren(namespaceItem);
    const intimfy = groupsIn(grown).find((item) => item.label === 'cl-intimfy');

    expect(groupsIn(children).map((item) => item.label)).toEqual(['cl-gateway', 'cl-intimfy']);
    expect(groupsIn(grown).map((item) => item.label)).toEqual(['cl-gateway', 'cl-intimfy', 'cl-mu']);
    expect((await provider.getChildren(intimfy)).map((item) => item.label)).toEqual([
      'application-uat.yml',
      'redis.yml'
    ]);
    expect(grown.some((item) => item instanceof LoadMoreTreeItem)).toBe(false);
  });

  /**
   * VS Code keys a node's expanded state on its id. A group that is rebuilt
   * with a different id after Load more is a different node to the view, so it
   * redraws collapsed and the user loses the place they were reading.
   */
  it('keeps the id of a group stable when a later page adds configurations to it', async () => {
    const { client } = recordingClient(
      pagesOf([config('cl-intimfy', 'application-uat.yml')], [config('cl-intimfy', 'redis.yml')])
    );
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
    const { client } = recordingClient(pagesOf([config('cl-intimfy', 'a.yml')], [config('cl-gateway', 'b.yml')]));
    const provider = providerFor(client);
    const { namespaceItem } = await expandNamespace(provider);
    const changed: Array<NacosTreeItem | undefined | void> = [];
    provider.onDidChangeTreeData((element) => changed.push(element));

    await provider.loadMore(namespaceItem);

    expect(changed).toEqual([namespaceItem]);
  });

  it('renders a configuration only once when a later page repeats it', async () => {
    const repeated = config('cl-intimfy', 'application-uat.yml');
    const { client } = recordingClient(pagesOf([repeated], [repeated, config('cl-intimfy', 'redis.yml')]));
    const provider = providerFor(client);

    const { namespaceItem } = await expandNamespace(provider);
    await provider.loadMore(namespaceItem);
    const grown = await provider.getChildren(namespaceItem);
    const configs = await provider.getChildren(groupsIn(grown)[0]);

    expect(configs.map((item) => item.label)).toEqual(['application-uat.yml', 'redis.yml']);
  });

  it('keeps the pages already loaded when the next page fails', async () => {
    const { client, queries } = recordingClient((query) => {
      if (query.pageNo === 2) {
        throw new Error('connect ETIMEDOUT 10.0.0.9:8848');
      }
      return { items: [config('cl-intimfy', 'a.yml')], totalCount: 2, pageNumber: 1, pagesAvailable: 2 };
    });
    const provider = providerFor(client);

    const { namespaceItem } = await expandNamespace(provider);
    await expect(provider.loadMore(namespaceItem)).rejects.toThrow('ETIMEDOUT');
    const afterFailure = await provider.getChildren(namespaceItem);

    expect(groupsIn(afterFailure).map((item) => item.label)).toEqual(['cl-intimfy']);
    expect(afterFailure.some((item) => item instanceof LoadMoreTreeItem)).toBe(true);
    expect(queries.map((query) => query.pageNo)).toEqual([1, 2]);
  });

  it('serves a second expansion of the same namespace from the page it already loaded', async () => {
    const { client, queries } = recordingClient(pagesOf([config('cl-intimfy', 'a.yml')]));
    const provider = providerFor(client);

    const { namespaceItem } = await expandNamespace(provider);
    await provider.getChildren(namespaceItem);

    expect(queries).toHaveLength(1);
  });

  it('collapses concurrent expansions of one namespace into a single request', async () => {
    const { client, queries } = recordingClient(pagesOf([config('cl-intimfy', 'a.yml')]));
    const provider = providerFor(client);

    const [namespaceItem] = await expandInstance(provider);
    await Promise.all([provider.getChildren(namespaceItem), provider.getChildren(namespaceItem)]);

    expect(queries).toHaveLength(1);
  });

  it('drops the loaded pages on refresh() so the next expansion starts at page one again', async () => {
    const { client, queries } = recordingClient(pagesOf([config('cl-intimfy', 'a.yml')], [config('cl-mu', 'b.yml')]));
    const provider = providerFor(client);

    const { namespaceItem } = await expandNamespace(provider);
    await provider.loadMore(namespaceItem);
    provider.refresh();
    const afterRefresh = await provider.getChildren(namespaceItem);

    expect(queries.map((query) => query.pageNo)).toEqual([1, 2, 1]);
    expect(groupsIn(afterRefresh).map((item) => item.label)).toEqual(['cl-intimfy']);
  });

  it('ignores a Load more for a namespace whose pages were dropped, rather than paging past page one', async () => {
    const { client, queries } = recordingClient(pagesOf([config('cl-intimfy', 'a.yml')], [config('cl-mu', 'b.yml')]));
    const provider = providerFor(client);

    const { namespaceItem } = await expandNamespace(provider);
    provider.refresh();
    await provider.loadMore(namespaceItem);

    expect(queries.map((query) => query.pageNo)).toEqual([1]);
  });
});

describe('ConfigTreeProvider configuration failures', () => {
  it('renders a failing configuration listing as an error node under the namespace', async () => {
    const { client } = recordingClient(() => {
      throw new Error('Nacos answered 403 for /v1/cs/configs');
    });
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorTreeItem);
    expect(children[0].description).toContain('Nacos answered 403 for /v1/cs/configs');
  });

  it('keeps one namespace loading when another namespace fails, and attaches the error to the one that failed', async () => {
    const { client } = recordingClient(
      (query) => {
        if (query.namespaceId === 'broken') {
          throw new Error('host unreachable');
        }
        return pagesOf([config('cl-intimfy', 'a.yml')])(query);
      },
      [namespace({ namespaceId: 'healthy' }), namespace({ namespaceId: 'broken' })]
    );
    const provider = providerFor(client);

    const healthy = await expandNamespace(provider, 0);
    const broken = await expandNamespace(provider, 1);

    expect(groupsIn(healthy.children).map((item) => item.label)).toEqual(['cl-intimfy']);
    expect(broken.children).toHaveLength(1);
    expect(broken.children[0]).toBeInstanceOf(ErrorTreeItem);
    expect(healthy.children[0].id).not.toBe(broken.children[0].id);
  });

  it('retries a failed configuration listing instead of replaying the same rejection', async () => {
    let attempts = 0;
    const { client } = recordingClient((query) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('connect ETIMEDOUT 10.0.0.9:8848');
      }
      return pagesOf([config('cl-intimfy', 'a.yml')])(query);
    });
    const provider = providerFor(client);

    const { namespaceItem, children } = await expandNamespace(provider);
    const second = await provider.getChildren(namespaceItem);

    expect(children[0]).toBeInstanceOf(ErrorTreeItem);
    expect(groupsIn(second).map((item) => item.label)).toEqual(['cl-intimfy']);
  });

  /**
   * A namespace and a group of it can be showing an error in the same draw --
   * a refresh that starts failing reaches both. VS Code identifies at most one
   * item per id, so the two error nodes cannot share one.
   */
  it('gives a failing group an error node of its own rather than the one its namespace uses', async () => {
    let failing = false;
    const { client } = recordingClient((query) => {
      if (failing) {
        throw new Error('host unreachable');
      }
      return pagesOf([config('cl-intimfy', 'a.yml')])(query);
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

  it('redacts credentials out of the error node it renders under a namespace', async () => {
    const { client } = recordingClient(() => {
      throw new Error('GET /v1/cs/configs?username=nacos&password=hunter2 failed');
    });
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);

    expect(children[0].description).not.toContain('hunter2');
    expect(children[0].description).toContain('[REDACTED]');
  });
});

describe('ConfigTreeProvider configuration item identity', () => {
  it('keeps group and configuration ids distinct across two namespaces that share a group name', async () => {
    const { client } = recordingClient(pagesOf([config('shared', 'application.yml')]), [
      namespace({ namespaceId: 'uat' }),
      namespace({ namespaceId: 'prod' })
    ]);
    const provider = providerFor(client);

    const uat = await expandNamespace(provider, 0);
    const prod = await expandNamespace(provider, 1);
    const [uatConfig] = await provider.getChildren(uat.children[0]);
    const [prodConfig] = await provider.getChildren(prod.children[0]);

    expect(uat.children[0].id).not.toBe(prod.children[0].id);
    expect(uatConfig.id).not.toBe(prodConfig.id);
  });

  /**
   * A dataId may legally contain a colon, and so may a group name. Joining the
   * parts raw would give group `a:b` + dataId `c` and group `a` + dataId `b:c`
   * one id between them, and VS Code renders at most one item per id -- so one
   * of two real configurations would silently disappear.
   */
  it('keeps configuration ids distinct when a colon in a name could be read as the separator', async () => {
    const { client } = recordingClient(pagesOf([config('a:b', 'c'), config('a', 'b:c')]));
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);
    const [first] = await provider.getChildren(children[0]);
    const [second] = await provider.getChildren(children[1]);

    expect(children[0].id).not.toBe(children[1].id);
    expect(first.id).not.toBe(second.id);
  });

  it('scopes every node it adds to the configuration view, so the service tree cannot collide with it', async () => {
    const { client } = recordingClient(pagesOf([config('cl-intimfy', 'a.yml')], [config('cl-mu', 'b.yml')]));
    const provider = providerFor(client);

    const { children } = await expandNamespace(provider);
    const configs = await provider.getChildren(children[0]);

    for (const item of [...children, ...configs]) {
      expect(String(item.id), String(item.label)).toMatch(/^atNacos\.config\./);
    }
  });
});

describe('ConfigTreeProvider filtering', () => {
  it('sends no search term while nothing is filtered', async () => {
    const { client, queries } = recordingClient(pagesOf([config('cl-intimfy', 'a.yml')]));
    const provider = providerFor(client);

    await expandNamespace(provider);

    expect(queries[0].search).toBeUndefined();
    expect(provider.getFilter()).toBeUndefined();
  });

  /**
   * The driver derives `search=blur` and the `*term*` wildcards from the
   * presence of this field. Spelling either of them up here would put a Nacos
   * protocol detail in the tree, and put it there four times over -- the two
   * spellings differ by API version.
   */
  it('hands the driver the text the user typed, with no search mode and no wildcards', async () => {
    const { client, queries } = recordingClient(pagesOf([config('cl-intimfy', 'application-uat.yml')]), [
      namespace({ namespaceId: 'uat' })
    ]);
    const provider = providerFor(client);

    provider.setFilter('application');
    await expandNamespace(provider);

    expect(queries).toEqual([{ namespaceId: 'uat', pageNo: 1, pageSize: 100, search: 'application' }]);
  });

  it('trims the filter text before it searches with it', async () => {
    const { client, queries } = recordingClient(pagesOf([config('cl-intimfy', 'a.yml')]));
    const provider = providerFor(client);

    provider.setFilter('  uat  ');
    await expandNamespace(provider);

    expect(provider.getFilter()).toBe('uat');
    expect(queries[0].search).toBe('uat');
  });

  it('reads blank filter text as no filter at all', async () => {
    const { client, queries } = recordingClient(pagesOf([config('cl-intimfy', 'a.yml')]));
    const provider = providerFor(client);

    provider.setFilter('   ');
    await expandNamespace(provider);

    expect(provider.getFilter()).toBeUndefined();
    expect(queries[0].search).toBeUndefined();
  });

  it('stops searching once the filter is cleared', async () => {
    const { client, queries } = recordingClient(pagesOf([config('cl-intimfy', 'a.yml')]));
    const provider = providerFor(client);

    provider.setFilter('uat');
    await expandNamespace(provider);
    provider.clearFilter();
    const { children } = await expandNamespace(provider);

    expect(queries.map((query) => query.search)).toEqual(['uat', undefined]);
    expect(groupsIn(children).map((item) => item.label)).toEqual(['cl-intimfy']);
  });

  /**
   * A filter is a different result set, so page four of the unfiltered one
   * means nothing in it -- and continuing from there would skip the first
   * three pages of matches, which are the ones the user is looking for.
   */
  it('starts the filtered listing at page one rather than continuing the unfiltered paging', async () => {
    const { client, queries } = recordingClient(pagesOf([config('cl-intimfy', 'a.yml')], [config('cl-mu', 'b.yml')]));
    const provider = providerFor(client);

    const { namespaceItem } = await expandNamespace(provider);
    await provider.loadMore(namespaceItem);
    provider.setFilter('uat');
    await provider.getChildren(namespaceItem);

    expect(queries.map((query) => [query.pageNo, query.search])).toEqual([
      [1, undefined],
      [2, undefined],
      [1, 'uat']
    ]);
  });

  it('starts at page one again when the filter is cleared', async () => {
    const { client, queries } = recordingClient(pagesOf([config('cl-intimfy', 'a.yml')], [config('cl-mu', 'b.yml')]));
    const provider = providerFor(client);

    provider.setFilter('uat');
    const { namespaceItem } = await expandNamespace(provider);
    await provider.loadMore(namespaceItem);
    provider.clearFilter();
    await provider.getChildren(namespaceItem);

    expect(queries.map((query) => [query.pageNo, query.search])).toEqual([
      [1, 'uat'],
      [2, 'uat'],
      [1, undefined]
    ]);
  });

  /** Every namespace's result set changes at once, so this is the one case where the whole tree is right. */
  it('redraws the whole tree when the filter changes', async () => {
    const provider = providerFor(stubClient([namespace()]));
    const changed: Array<NacosTreeItem | undefined | void> = [];
    provider.onDidChangeTreeData((element) => changed.push(element));

    provider.setFilter('uat');
    provider.clearFilter();

    expect(changed).toEqual([undefined, undefined]);
  });

  it('keeps the pages already loaded when the same filter text is entered again', async () => {
    const { client, queries } = recordingClient(pagesOf([config('cl-intimfy', 'a.yml')], [config('cl-mu', 'b.yml')]));
    const provider = providerFor(client);
    provider.setFilter('uat');
    const { namespaceItem } = await expandNamespace(provider);
    await provider.loadMore(namespaceItem);

    provider.setFilter('uat');
    const children = await provider.getChildren(namespaceItem);

    expect(queries.map((query) => query.pageNo)).toEqual([1, 2]);
    expect(groupsIn(children).map((item) => item.label)).toEqual(['cl-intimfy', 'cl-mu']);
  });

  it('does nothing when the filter is cleared and there was none', async () => {
    const provider = providerFor(stubClient([namespace()]));
    const changed: Array<NacosTreeItem | undefined | void> = [];
    provider.onDidChangeTreeData((element) => changed.push(element));

    provider.clearFilter();

    expect(changed).toEqual([]);
  });

  it('reports the filter on the view message, and takes it off again', () => {
    const view: { message: string | undefined } = { message: undefined };
    const provider = providerFor(stubClient([namespace()]));
    provider.attachTreeView(view);

    provider.setFilter('uat');
    const whileFiltered = view.message;
    provider.clearFilter();

    expect(whileFiltered).toContain('uat');
    expect(view.message).toBeUndefined();
  });

  /** The view is created after the provider, so a filter can already be set by the time one arrives. */
  it('reports a filter that was set before the view was attached', () => {
    const view: { message: string | undefined } = { message: undefined };
    const provider = providerFor(stubClient([namespace()]));

    provider.setFilter('uat');
    provider.attachTreeView(view);

    expect(view.message).toContain('uat');
  });

  /**
   * The reason `configLanguageId` has a dataId fallback at all. Verified on a
   * real 2.3.2: a filter makes the driver search with `search=blur`, and blur
   * nulls out `type` on every item it returns -- so the field that decides the
   * highlighting is gone exactly when the user is searching for something to
   * open.
   */
  it('opens a configuration found under a filter in the right language mode, though blur left its type out', async () => {
    const setLanguage = vi.spyOn(vscode.languages, 'setTextDocumentLanguage');
    const { client } = recordingClient(pagesOf([config('cl-intimfy', 'application-uat.yml', { type: undefined })]));
    const provider = providerFor(client);
    provider.setFilter('application');

    const { children } = await expandNamespace(provider);
    const [configItem] = await provider.getChildren(children[0]);
    const [instanceId, summary] = (configItem.command?.arguments ?? []) as [string, NacosConfigSummary];
    await openConfigDocument(instanceId, summary);

    expect(summary.type).toBeUndefined();
    expect(setLanguage.mock.calls[0][1]).toBe('yaml');
  });
});
