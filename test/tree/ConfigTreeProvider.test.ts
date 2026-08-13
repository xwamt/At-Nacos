import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { parseNacosInstanceConfig, type NacosInstanceConfig } from '../../src/config/schema';
import type { NacosNamespace } from '../../src/nacos/driver/normalize';
import { ConfigTreeProvider } from '../../src/tree/ConfigTreeProvider';
import type { NacosTreeClient } from '../../src/tree/NacosTreeBase';
import { ErrorTreeItem, InstanceTreeItem, NamespaceTreeItem } from '../../src/tree/NacosTreeItems';

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

function stubClient(namespaces: NacosNamespace[], majorVersion = 3): NacosTreeClient {
  return {
    state: {
      version: `${majorVersion}.0.0`,
      majorVersion,
      startupMode: 'standalone',
      authEnabled: false,
      raw: {}
    },
    listNamespaces: async () => namespaces
  };
}

/** The one instance / one client shape most tests want. */
function providerFor(client: NacosTreeClient, inst = instance()): ConfigTreeProvider {
  return new ConfigTreeProvider({ listInstances: async () => [inst] }, async () => client);
}

async function expandInstance(provider: ConfigTreeProvider, index = 0) {
  const roots = await provider.getChildren();
  return provider.getChildren(roots[index]);
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

  it('stops at the namespace level in M1: expanding a namespace yields no children', async () => {
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
      state: stubClient([]).state,
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
      return { state: stubClient([]).state, listNamespaces: () => pending };
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
});
