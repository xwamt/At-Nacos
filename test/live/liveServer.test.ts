/**
 * Smoke tests against a real Nacos server, skipped unless one is offered.
 *
 * Everything else in this suite runs against `startTestHttpServer` fixtures
 * built from researched response shapes. That catches our own logic but not a
 * wrong assumption about what Nacos actually sends, which is the failure mode
 * this project is most exposed to: three major versions that disagree about
 * parameter names, response envelopes and which endpoints exist at all.
 *
 * Run with:
 *   AT_NACOS_LIVE_URL=http://host:8848/nacos npx vitest run test/live
 *
 * Optional: AT_NACOS_LIVE_USERNAME / AT_NACOS_LIVE_PASSWORD for a secured
 * server. Without them the instance is treated as `authMode: 'none'`, which is
 * the default Nacos 1.x/2.x deployment.
 */
import { describe, expect, it } from 'vitest';
import { createNacosClient } from '../../src/extension';
import type { NacosInstanceConfig } from '../../src/config/schema';
import { NacosConfigDocumentProvider } from '../../src/document/NacosConfigDocumentProvider';
import { openConfigDocument } from '../../src/document/openConfigDocument';
import type { NacosApiError } from '../../src/nacos/NacosApiError';
import type { NacosClient } from '../../src/nacos/NacosClient';
import { configLanguageId } from '../../src/nacos/driver/configLanguage';
import type { NacosConfigSummary } from '../../src/nacos/driver/normalize';
import { testNacosConnection } from '../../src/nacos/testNacosConnection';
import { ConfigTreeProvider } from '../../src/tree/ConfigTreeProvider';
import {
  ConfigTreeItem,
  GroupTreeItem,
  LoadMoreTreeItem,
  NamespaceTreeItem,
  type NacosTreeItem
} from '../../src/tree/NacosTreeItems';
import { noopLog } from '../../src/utils/logger';

const liveUrl = process.env.AT_NACOS_LIVE_URL;
const username = process.env.AT_NACOS_LIVE_USERNAME;
const password = process.env.AT_NACOS_LIVE_PASSWORD;

const describeLive = liveUrl ? describe : describe.skip;

function liveInstance(): NacosInstanceConfig {
  return {
    id: 'live',
    label: 'live',
    serverUrl: liveUrl ?? '',
    authMode: username ? 'userPassword' : 'none',
    username,
    readOnly: true,
    allowBackgroundAccess: false,
    createdAt: 0,
    updatedAt: 0
  };
}

function connectLive(): Promise<NacosClient> {
  const configManager = {
    getPassword: async () => password,
    getCustomHeaders: async () => undefined
  };
  const certTrustStore = { check: async () => 'trusted' as const };
  return createNacosClient(configManager as never, liveInstance(), certTrustStore as never, noopLog);
}

describeLive('a real Nacos server', () => {
  it('reports its version and startup mode through the connection test', async () => {
    const result = await testNacosConnection({
      serverUrl: liveUrl ?? '',
      authMode: username ? 'userPassword' : 'none',
      username,
      password,
      log: noopLog
    });

    if (!result.ok) {
      throw new Error(`connection test failed (${result.reason}): ${result.message}`);
    }
    expect(result.version).toMatch(/^\d+\./);
    expect(['standalone', 'cluster', 'unknown']).toContain(result.startupMode);
    console.log(
      `  version=${result.version} major=${result.majorVersion} mode=${result.startupMode} ` +
        `authEnabled=${result.authEnabled} baseUrl=${result.baseUrl} console=${result.consoleUrl ?? '(none)'}`
    );
  });

  it('finds the same server when the context path is left off the address', async () => {
    const origin = new URL(liveUrl ?? '').origin;

    const result = await testNacosConnection({
      serverUrl: origin,
      authMode: username ? 'userPassword' : 'none',
      username,
      password,
      log: noopLog
    });

    if (!result.ok) {
      throw new Error(`context-path discovery failed (${result.reason}): ${result.message}`);
    }
    console.log(`  discovered baseUrl=${result.baseUrl} from bare origin ${origin}`);
  });

  it('lists namespaces end to end, through whichever driver the chain settles on', async () => {
    const client = await connectLive();
    const namespaces = await client.listNamespaces();

    expect(namespaces.length).toBeGreaterThan(0);
    // Every deployment has the default namespace, whose id is '' before 3.x
    // and the literal 'public' from 3.x on. Finding neither would mean the
    // entry shape changed under us.
    const defaultNamespace = namespaces.find((entry) => entry.namespaceId === '' || entry.namespaceId === 'public');
    expect(defaultNamespace, 'no default namespace in the listing').toBeDefined();

    console.log(`  ${namespaces.length} namespaces via a ${client.state.majorVersion}.x chain:`);
    for (const entry of namespaces) {
      console.log(
        `    id=${JSON.stringify(entry.namespaceId).padEnd(20)} name=${entry.displayName.padEnd(20)} ` +
          `type=${entry.type} configs=${entry.configCount ?? '?'}`
      );
    }
  });
});

/**
 * The configuration capabilities, which is where the version differences bite
 * hardest: the namespace parameter is spelled `tenant` on the v1 config paths
 * and `namespaceId` everywhere else, and getting it wrong is **silent** --
 * Spring drops the unknown parameter and the server answers for the default
 * namespace. A fixture server cannot catch that, because a fixture answers
 * whatever it was told to. Only a real server can.
 */
describeLive('a real Nacos server, browsing configurations', () => {
  /**
   * The first namespace that holds a config in a language we can assert on.
   *
   * Resolved once and shared: each connection costs a probe, and the three
   * tests below are three views of the same lookup. Not hard-coded to a
   * namespace name so that the suite still means something on someone else's
   * server.
   */
  let discovery: Promise<{ client: NacosClient; namespaceId: string; page: NacosConfigSummary[] }> | undefined;

  function findYamlConfig(): Promise<{ client: NacosClient; namespaceId: string; page: NacosConfigSummary[] }> {
    discovery ??= (async () => {
      const client = await connectLive();
      const namespaces = await client.listNamespaces();
      let fallback: { client: NacosClient; namespaceId: string; page: NacosConfigSummary[] } | undefined;
      for (const namespace of namespaces) {
        const page = await client.listConfigs({ namespaceId: namespace.namespaceId, pageNo: 1, pageSize: 100 });
        if (page.items.length === 0) {
          continue;
        }
        fallback ??= { client, namespaceId: namespace.namespaceId, page: page.items };
        if (page.items.some((item) => configLanguageId(item) === 'yaml')) {
          return { client, namespaceId: namespace.namespaceId, page: page.items };
        }
      }
      if (!fallback) {
        throw new Error('no namespace on this server holds a configuration; nothing to browse');
      }
      return fallback;
    })();
    return discovery;
  }

  it('lists the configurations of a namespace, under whichever parameter name that version reads', async () => {
    const { namespaceId, page } = await findYamlConfig();

    expect(page.length).toBeGreaterThan(0);
    // The parameter-name trap: a request that says `namespaceId` where the
    // server reads `tenant` comes back with the *default* namespace's
    // configs, not an error. Every item belonging to the namespace asked for
    // is what proves the right spelling went out.
    for (const item of page) {
      expect(item.namespaceId).toBe(namespaceId);
    }
    // §14.2: the server sends every config's full body in the list response.
    // It is dropped at the driver boundary, and a summary that still carried
    // it would mean every tree node holds a password.
    expect(JSON.stringify(page)).not.toContain('password');

    console.log(`  ${page.length} configs in namespace ${JSON.stringify(namespaceId)}:`);
    for (const item of page.slice(0, 3)) {
      console.log(
        `    dataId=${item.dataId.padEnd(34)} group=${item.group.padEnd(16)} ` +
          `type=${item.type ?? '(null)'} language=${configLanguageId(item)}`
      );
    }
  });

  it('fetches one configuration whole, with the type that picks its language mode', async () => {
    const { client, page } = await findYamlConfig();
    const target = page.find((item) => configLanguageId(item) === 'yaml');
    expect(target, 'no YAML configuration on this server to open').toBeDefined();

    const detail = await client.getConfig({
      namespaceId: target?.namespaceId ?? '',
      group: target?.group ?? '',
      dataId: target?.dataId ?? ''
    });

    expect(detail.content.length).toBeGreaterThan(0);
    expect(configLanguageId(detail)).toBe('yaml');
    console.log(
      `  ${detail.dataId} (group=${detail.group}, type=${detail.type ?? '(null)'}) ` +
        `-> ${configLanguageId(detail)}, ${detail.content.length} bytes, ` +
        `first line: ${JSON.stringify(detail.content.split('\n')[0])}`
    );
  });

  /**
   * The whole reason `resource-not-found` exists. Before it, a dataId nobody
   * published looked exactly like a missing endpoint, so the resolver walked
   * every driver and reported "No Nacos API flavor could serve ..." for what
   * is really just a typo.
   */
  it('says a missing configuration is missing, rather than blaming the API version', async () => {
    const { client, namespaceId, page } = await findYamlConfig();

    const error = (await client
      .getConfig({
        namespaceId,
        group: page[0]?.group ?? 'DEFAULT_GROUP',
        dataId: 'at-nacos-no-such-config-please-do-not-create.yml'
      })
      .catch((thrown: unknown) => thrown)) as NacosApiError;

    expect(error.kind).toBe('resource-not-found');
    expect(error.shouldFallThrough()).toBe(false);
    console.log(`  missing dataId -> kind=${error.kind} status=${error.status ?? '(none)'}: ${error.message}`);
  });
});

/**
 * The same server, reached the way a user reaches it: through the tree
 * provider the view is backed by and the document layer a click goes through,
 * rather than through the client those two are built on.
 *
 * What only this level can catch is the wiring between them -- that the
 * summary the tree holds is the one the document layer is handed, that the
 * address built from it survives a round trip, and that the language mode
 * survives a filter. The driver tests above prove the server answers; these
 * prove the answer reaches the editor.
 *
 * A generous timeout, because a page is a fresh client: `createNacosClient`
 * probes the version on every call, deliberately, and expanding eleven
 * namespaces to find one with configurations pays for eleven of them.
 */
const LIVE_BROWSE_TIMEOUT_MS = 60_000;

/** One namespace of the live server, expanded down to its configurations. */
interface BrowsedNamespace {
  provider: ConfigTreeProvider;
  namespaceItem: NamespaceTreeItem;
  children: NacosTreeItem[];
  groups: GroupTreeItem[];
  configs: ConfigTreeItem[];
}

function liveConfigTree(): ConfigTreeProvider {
  return new ConfigTreeProvider({ listInstances: async () => [liveInstance()] }, () => connectLive());
}

/**
 * The instance is answered for whatever id is asked, because the tree built
 * the address from `liveInstance().id` a moment earlier -- there is exactly
 * one server in this suite.
 */
function liveDocumentProvider(): NacosConfigDocumentProvider {
  return new NacosConfigDocumentProvider({ getInstance: async () => liveInstance() }, () => connectLive());
}

function groupsIn(children: NacosTreeItem[]): GroupTreeItem[] {
  return children.filter((item): item is GroupTreeItem => item instanceof GroupTreeItem);
}

function configsIn(children: NacosTreeItem[]): ConfigTreeItem[] {
  return children.filter((item): item is ConfigTreeItem => item instanceof ConfigTreeItem);
}

/**
 * Walks instance -> namespace -> group -> configuration and stops at the first
 * namespace that has anything under it. Not hard-coded to a namespace name, so
 * the suite still means something on a server that is not this one.
 */
async function browseFirstPopulatedNamespace(provider: ConfigTreeProvider): Promise<BrowsedNamespace> {
  const instances = await provider.getChildren();
  expect(instances.length, 'the tree offered no instance to expand').toBe(1);
  const namespaces = await provider.getChildren(instances[0]);

  for (const candidate of namespaces) {
    if (!(candidate instanceof NamespaceTreeItem)) {
      continue;
    }
    const children = await provider.getChildren(candidate);
    const groups = groupsIn(children);
    if (groups.length === 0) {
      continue;
    }
    const configs = (await Promise.all(groups.map((group) => provider.getChildren(group)))).flatMap(configsIn);
    return { provider, namespaceItem: candidate, children, groups, configs };
  }
  throw new Error('no namespace on this server holds a configuration; nothing to browse');
}

function printTree(browsed: BrowsedNamespace, heading: string): void {
  console.log(`  ${heading}`);
  console.log(`    ${browsed.namespaceItem.label} [${browsed.namespaceItem.description ?? ''}]`);
  for (const group of browsed.groups) {
    console.log(`      ${group.label} (${group.description})`);
    for (const item of browsed.configs.filter((entry) => entry.config.group === group.group)) {
      console.log(
        `        ${String(item.label).padEnd(34)} type=${(item.config.type ?? '(null)').padEnd(8)} ` +
          `language=${configLanguageId(item.config)}`
      );
    }
  }
  for (const item of browsed.children.filter((entry) => entry instanceof LoadMoreTreeItem)) {
    console.log(`      [Load more] ${item.description}`);
  }
}

/** A configuration the tree found that we can assert a language mode on. */
function firstYaml(configs: ConfigTreeItem[]): ConfigTreeItem {
  const found = configs.find((item) => configLanguageId(item.config) === 'yaml');
  expect(found, 'no YAML configuration on this server to open').toBeDefined();
  return found as ConfigTreeItem;
}

describeLive('a real Nacos server, through the configuration tree and the editor', () => {
  let browsing: Promise<BrowsedNamespace> | undefined;

  /** Shared: the walk costs a probe per namespace, and all three tests want the same one. */
  function browse(): Promise<BrowsedNamespace> {
    browsing ??= browseFirstPopulatedNamespace(liveConfigTree());
    return browsing;
  }

  it(
    'expands an instance down to its groups and data IDs',
    async () => {
      const browsed = await browse();

      expect(browsed.groups.length).toBeGreaterThan(0);
      expect(browsed.configs.length).toBeGreaterThan(0);
      // Nacos has no endpoint that lists groups, so every group node here was
      // derived from the page of configurations that was loaded. A group with
      // nothing under it would mean that derivation is wrong.
      for (const group of browsed.groups) {
        expect(
          browsed.configs.filter((item) => item.config.group === group.group).length,
          `group ${group.group} rendered with no configuration under it`
        ).toBeGreaterThan(0);
      }
      printTree(browsed, `tree shape for namespace ${JSON.stringify(browsed.namespaceItem.namespace.namespaceId)}:`);
    },
    LIVE_BROWSE_TIMEOUT_MS
  );

  it(
    'opens a configuration the tree found, through the address the document layer builds',
    async () => {
      const { namespaceItem, configs } = await browse();
      const target = firstYaml(configs);

      const document = await openConfigDocument(namespaceItem.instance.id, target.config);
      const content = await liveDocumentProvider().provideTextDocumentContent(document.uri);

      expect(document.languageId).toBe('yaml');
      expect(content.length).toBeGreaterThan(0);
      // The provider answers every failure with readable prose instead of
      // rejecting, so a length check on its own would pass for "AT Nacos could
      // not read this configuration".
      expect(content).not.toMatch(/AT Nacos|no longer exists|no longer configured/);
      console.log(
        `  ${String(target.label)} -> ${document.uri.toString()}\n` +
          `    language=${document.languageId} bytes=${content.length} ` +
          `first line: ${JSON.stringify(content.split('\n')[0])}`
      );
    },
    LIVE_BROWSE_TIMEOUT_MS
  );

  /**
   * The filter searches with `search=blur`, and §14.2 records that Nacos
   * fills `type` only under `search=accurate`. So the moment a user filters,
   * the dataId suffix stops being a fallback and becomes the only thing
   * deciding the syntax highlighting. This is the test that says so.
   */
  it(
    'narrows the tree to a filter, and still highlights what is opened while filtered',
    async () => {
      const unfiltered = await browse();
      const target = firstYaml(unfiltered.configs);
      // A substring of a dataId the unfiltered pass really found, so the
      // filter is guaranteed to match at least that one.
      const needle = target.config.dataId.slice(0, Math.max(3, target.config.dataId.indexOf('.')));

      const provider = liveConfigTree();
      provider.setFilter(needle);
      const filtered = await browseFirstPopulatedNamespace(provider);

      expect(filtered.configs.length).toBeGreaterThan(0);
      expect(filtered.configs.length).toBeLessThan(unfiltered.configs.length);
      for (const item of filtered.configs) {
        expect(item.config.dataId, 'a filtered listing returned a dataId that does not match').toContain(needle);
      }

      const openWhileFiltered = firstYaml(filtered.configs);
      expect(
        openWhileFiltered.config.type ?? null,
        'a blur search filled in `type`; §14.2 says it does not, and the suffix fallback is built on that'
      ).toBeNull();
      const document = await openConfigDocument(filtered.namespaceItem.instance.id, openWhileFiltered.config);

      expect(document.languageId).toBe('yaml');
      printTree(filtered, `tree shape under filter ${JSON.stringify(needle)}:`);
      console.log(
        `    opened while filtered: ${String(openWhileFiltered.label)} ` +
          `type=${openWhileFiltered.config.type ?? '(null)'} -> language=${document.languageId}`
      );
    },
    LIVE_BROWSE_TIMEOUT_MS
  );
});
