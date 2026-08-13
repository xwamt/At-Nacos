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
import type { NacosConfigSummary, NacosServiceSummary, Paged } from '../../src/nacos/driver/normalize';
import { testNacosConnection } from '../../src/nacos/testNacosConnection';
import { ConfigTreeProvider } from '../../src/tree/ConfigTreeProvider';
import {
  ConfigTreeItem,
  GroupTreeItem,
  LoadMoreTreeItem,
  NamespaceTreeItem,
  ServiceInstanceTreeItem,
  ServiceTreeItem,
  type NacosTreeItem
} from '../../src/tree/NacosTreeItems';
import { ServiceTreeProvider } from '../../src/tree/ServiceTreeProvider';
import { noopLog } from '../../src/utils/logger';

const liveUrl = process.env.AT_NACOS_LIVE_URL;
const username = process.env.AT_NACOS_LIVE_USERNAME;
const password = process.env.AT_NACOS_LIVE_PASSWORD;

const describeLive = liveUrl ? describe : describe.skip;

/**
 * A generous timeout for anything that walks the whole server: a fresh client
 * probes the version every time, deliberately, and expanding eleven
 * namespaces pays for eleven listings on top of it.
 */
const LIVE_BROWSE_TIMEOUT_MS = 60_000;

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
 * The naming and cluster capabilities.
 *
 * This suite was written expecting an empty registry -- the reconnaissance
 * for this milestone concluded the server had no services at all, because
 * `/v1/ns/service/list` answered zero for every namespace it was asked about.
 * It answered zero because its `groupName` defaults to `DEFAULT_GROUP` and
 * every service on this server is registered under `cl-intimfy`. The
 * registry has thirteen services in it, and the endpoint that was used to
 * look for them is the one this milestone treats as the fallback precisely
 * because it cannot see across groups.
 *
 * So the group default did not merely risk hiding a registry; it hid this
 * one, from the people planning for it.
 */
describeLive('a real Nacos server, its cluster and its registry', () => {
  it('lists the cluster nodes, with the raft metadata flattened out of extendInfo', async () => {
    const client = await connectLive();
    const nodes = await client.listClusterNodes();

    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(node.address).toContain(':');
      expect(['STARTING', 'UP', 'SUSPICIOUS', 'DOWN', 'ISOLATION']).toContain(node.state);
    }

    console.log(`  ${nodes.length} cluster node(s) via a ${client.state.majorVersion}.x chain:`);
    for (const node of nodes) {
      console.log(
        `    ${node.address.padEnd(20)} state=${node.state.padEnd(10)} version=${node.version ?? '?'} ` +
          `raftPort=${node.raftPort ?? '?'} failAccessCnt=${node.failAccessCnt ?? '?'}`
      );
      for (const group of node.raftGroups ?? []) {
        console.log(
          `      raft ${group.group.padEnd(30)} leader=${group.leader} term=${group.term} ` +
            `members=[${group.members.join(', ')}]`
        );
      }
    }
  });

  /**
   * The one assertion this milestone turns on. Without `onlyStatus=false` the
   * server answers `{"status":"UP"}` and nothing else -- a parameter default,
   * not the version-dependent degradation the research recorded -- so a
   * `serviceCount` that arrived at all is proof the parameter did.
   */
  it('reports the full server metrics, which is only possible with onlyStatus=false', async () => {
    const client = await connectLive();
    const metrics = await client.getServerMetrics();

    expect(metrics.status.length).toBeGreaterThan(0);
    expect(metrics.serviceCount, 'only `status` came back, so onlyStatus=false did not reach the server').toBeDefined();

    console.log(
      `  status=${metrics.status} services=${metrics.serviceCount} instances=${metrics.instanceCount} ` +
        `subscribers=${metrics.subscribeCount} clients=${metrics.clientCount}\n` +
        `    cpu=${metrics.cpu} load=${metrics.load} mem=${metrics.mem}`
    );
  });

  /**
   * Every namespace, unfiltered, which is what the tree will ask for.
   *
   * Two things have to hold at once and they pull in opposite directions: a
   * namespace with nothing in it must answer an empty page rather than fail
   * (nine of the eleven here do), and a namespace whose services live outside
   * `DEFAULT_GROUP` must still show them (the other two). The second is what
   * a listing scoped to the default group cannot do.
   */
  it('finds services in every group, and answers an empty namespace with an empty page', async () => {
    const { client, pages } = await browseServices();

    for (const { namespaceId, page } of pages) {
      expect(Array.isArray(page.items), `namespace ${namespaceId} answered no item list`).toBe(true);
      expect(page.items.length).toBeLessThanOrEqual(page.totalCount);
    }
    const found = pages.flatMap((entry) => entry.page.items);
    expect(found.length, 'no services at all: the group filter may have collapsed to DEFAULT_GROUP').toBeGreaterThan(0);
    expect(
      found.some((service) => service.group !== 'DEFAULT_GROUP'),
      'every service found was in DEFAULT_GROUP, so this run proves nothing about the group filter'
    ).toBe(true);
    // Counts come from the catalog and are left undefined by the name-only
    // fallback, so their presence is what says which endpoint answered.
    expect(found[0]?.instanceCount, 'the counts are missing, so the catalog did not serve this').toBeDefined();

    const total = pages.reduce((sum, entry) => sum + entry.page.totalCount, 0);
    console.log(
      `  ${total} services across ${pages.length} namespaces via a ${client.state.majorVersion}.x chain: ` +
        pages.map((entry) => `${JSON.stringify(entry.namespaceId)}=${entry.page.totalCount}`).join(' ')
    );
    for (const { namespaceId, page } of pages.filter((entry) => entry.page.items.length > 0)) {
      for (const service of page.items) {
        console.log(
          `    ${namespaceId}/${service.group}/${service.serviceName.padEnd(32)} ` +
            `healthy=${service.healthyInstanceCount ?? '?'}/${service.instanceCount ?? '?'} ` +
            `clusters=${service.clusterCount ?? '?'} triggerFlag=${String(service.triggerFlag)}`
        );
      }
    }
  }, LIVE_BROWSE_TIMEOUT_MS);

  /**
   * The trap, demonstrated rather than described: the same namespace answers
   * twelve services unfiltered and none under `DEFAULT_GROUP`. That second
   * number is what a caller gets from any endpoint whose group parameter
   * defaults -- which is what `/v1/ns/service/list` does, and why the group
   * here means *every* group when absent.
   */
  it('answers nothing for DEFAULT_GROUP in the namespace where twelve services live', async () => {
    const { client, populated } = await browseServices();

    const defaultGroupOnly = await client.listServices({
      namespaceId: populated.namespaceId,
      group: 'DEFAULT_GROUP',
      pageNo: 1,
      pageSize: 100
    });

    expect(populated.page.items.length).toBeGreaterThan(0);
    expect(defaultGroupOnly.totalCount).toBe(0);
    console.log(
      `  namespace ${JSON.stringify(populated.namespaceId)}: ` +
        `${populated.page.totalCount} services across all groups, ` +
        `${defaultGroupOnly.totalCount} under DEFAULT_GROUP`
    );
  }, LIVE_BROWSE_TIMEOUT_MS);

  it('lists the instances of a service the listing found', async () => {
    const { client, populated } = await browseServices();
    const service = populated.page.items[0];
    expect(service, 'no service to list instances for').toBeDefined();

    const instances = await client.listInstances({
      namespaceId: service?.namespaceId ?? '',
      group: service?.group ?? '',
      serviceName: service?.serviceName ?? ''
    });

    expect(instances.length).toBeGreaterThan(0);
    for (const instance of instances) {
      expect(instance.ip.length).toBeGreaterThan(0);
      expect(instance.port).toBeGreaterThan(0);
    }
    console.log(`  ${populated.namespaceId}/${service?.group}/${service?.serviceName}:`);
    for (const instance of instances) {
      console.log(
        `    ${instance.ip}:${instance.port} healthy=${instance.healthy} enabled=${instance.enabled} ` +
          `weight=${instance.weight} cluster=${instance.clusterName} ephemeral=${instance.ephemeral}\n` +
          `      instanceId=${instance.instanceId ?? '(none)'}\n` +
          `      metadata=${JSON.stringify(instance.metadata)}`
      );
    }
  }, LIVE_BROWSE_TIMEOUT_MS);

  /**
   * A service nobody registered is an empty `hosts` array under HTTP 200, not
   * a 404 -- unlike a configuration nobody published, which is the opposite
   * (§14.2 ⓪). Anything that read this as a failure would put an error in
   * front of a user whose server is fine.
   */
  it('answers the instances of a service nobody registered with an empty list', async () => {
    const client = await connectLive();

    const instances = await client.listInstances({
      namespaceId: '',
      group: 'DEFAULT_GROUP',
      serviceName: 'at-nacos-no-such-service-please-do-not-register'
    });

    expect(instances).toEqual([]);
    console.log('  a service nobody registered -> 0 instances, no error');
  });
});

/** One namespace of the live server and the services in it, whichever namespace has any. */
interface BrowsedServices {
  client: NacosClient;
  pages: { namespaceId: string; page: Paged<NacosServiceSummary> }[];
  populated: { namespaceId: string; page: Paged<NacosServiceSummary> };
}

let browsedServices: Promise<BrowsedServices> | undefined;

/** Shared across the naming tests: one probe and eleven listings is enough to pay for once. */
function browseServices(): Promise<BrowsedServices> {
  browsedServices ??= (async () => {
    const client = await connectLive();
    const namespaces = await client.listNamespaces();
    const pages = await Promise.all(
      namespaces.map(async (namespace) => ({
        namespaceId: namespace.namespaceId,
        page: await client.listServices({ namespaceId: namespace.namespaceId, pageNo: 1, pageSize: 100 })
      }))
    );
    const populated = pages.find((entry) => entry.page.items.length > 0);
    if (!populated) {
      throw new Error('no namespace on this server has a registered service; nothing to browse');
    }
    return { client, pages, populated };
  })();
  return browsedServices;
}

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
 */

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

/** One namespace of the live server, expanded from the namespace down to the instances. */
interface BrowsedServiceNamespace {
  namespaceItem: NamespaceTreeItem;
  children: NacosTreeItem[];
  groups: GroupTreeItem[];
  services: ServiceTreeItem[];
  /** Keyed by the service node's id, because two groups may hold a service of the same name. */
  instances: Map<string, NacosTreeItem[]>;
}

function liveServiceTree(): ServiceTreeProvider {
  return new ServiceTreeProvider({ listInstances: async () => [liveInstance()] }, () => connectLive());
}

function servicesIn(children: NacosTreeItem[]): ServiceTreeItem[] {
  return children.filter((item): item is ServiceTreeItem => item instanceof ServiceTreeItem);
}

function instancesIn(children: NacosTreeItem[]): ServiceInstanceTreeItem[] {
  return children.filter((item): item is ServiceInstanceTreeItem => item instanceof ServiceInstanceTreeItem);
}

/** The codicon and the theme colour a node was decorated with, which is what the view renders. */
function decorationOf(item: NacosTreeItem): { icon: string; color: string | undefined } {
  const icon = item.iconPath as { id: string; color?: { id: string } };
  return { icon: icon.id, color: icon.color?.id };
}

/**
 * Walks namespace -> group -> service -> instance and stops at the first
 * namespace that has a service under it. Not hard-coded to a namespace or a
 * group name, so the suite still means something on a server that is not
 * this one.
 */
async function browseFirstPopulatedServiceNamespace(
  provider: ServiceTreeProvider
): Promise<BrowsedServiceNamespace> {
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
    const services = (await Promise.all(groups.map((group) => provider.getChildren(group)))).flatMap(servicesIn);
    const instancesByService = new Map<string, NacosTreeItem[]>();
    for (const service of services) {
      instancesByService.set(String(service.id), await provider.getChildren(service));
    }
    return { namespaceItem: candidate, children, groups, services, instances: instancesByService };
  }
  throw new Error('no namespace on this server has a registered service; nothing to browse');
}

function printServiceTree(browsed: BrowsedServiceNamespace, heading: string): void {
  console.log(`  ${heading}`);
  console.log(`    ${browsed.namespaceItem.label} [${browsed.namespaceItem.description ?? ''}]`);
  for (const group of browsed.groups) {
    console.log(`      ${group.label} (${group.description})`);
    for (const service of browsed.services.filter((entry) => entry.service.group === group.group)) {
      const decoration = decorationOf(service);
      console.log(
        `        ${String(service.label).padEnd(32)} ${String(service.description).padEnd(24)} ` +
          `$(${decoration.icon}) ${decoration.color ?? '(no colour)'}`
      );
      for (const item of browsed.instances.get(String(service.id)) ?? []) {
        const instanceDecoration = decorationOf(item);
        console.log(
          `          ${String(item.label).padEnd(28)} ${String(item.description).padEnd(28)} ` +
            `$(${instanceDecoration.icon}) ${instanceDecoration.color ?? '(no colour)'}`
        );
        console.log(`            tooltip: ${String(item.tooltip).replace(/\n/g, ' | ')}`);
      }
    }
  }
  for (const item of browsed.children.filter((entry) => entry instanceof LoadMoreTreeItem)) {
    console.log(`      [Load more] ${item.description}`);
  }
}

/**
 * The same registry, reached the way a user reaches it: through the tree
 * provider the view is backed by rather than through the client it is built
 * on. What only this level can catch is that the four levels agree -- that
 * the group derived from a listing is the group the services are asked for
 * under, and that the ref a service node carries is the one whose instances
 * come back.
 */
describeLive('a real Nacos server, through the service tree', () => {
  let browsing: Promise<BrowsedServiceNamespace> | undefined;

  /** Shared: the walk costs a probe per level, and both tests want the same one. */
  function browse(): Promise<BrowsedServiceNamespace> {
    browsing ??= browseFirstPopulatedServiceNamespace(liveServiceTree());
    return browsing;
  }

  it(
    'expands an instance down to the instances of its services',
    async () => {
      const browsed = await browse();

      expect(browsed.groups.length).toBeGreaterThan(0);
      expect(browsed.services.length).toBeGreaterThan(0);
      // Nacos has no endpoint that lists groups, so every group node here was
      // derived from the page of services that was loaded. A group with
      // nothing under it would mean that derivation is wrong.
      for (const group of browsed.groups) {
        expect(
          browsed.services.filter((item) => item.service.group === group.group).length,
          `group ${group.group} rendered with no service under it`
        ).toBeGreaterThan(0);
      }
      // The whole reason the query leaves `group` absent. A tree that could
      // only see `DEFAULT_GROUP` would render nothing at all on this server,
      // which is exactly what this milestone's reconnaissance concluded from
      // the endpoint that has that default.
      expect(
        browsed.groups.some((group) => group.group !== 'DEFAULT_GROUP'),
        'every group found was DEFAULT_GROUP, so this run proves nothing about the group derivation'
      ).toBe(true);
      const withInstances = browsed.services.filter(
        (service) => instancesIn(browsed.instances.get(String(service.id)) ?? []).length > 0
      );
      expect(withInstances.length, 'no service expanded into an instance node').toBeGreaterThan(0);

      printServiceTree(
        browsed,
        `tree shape for namespace ${JSON.stringify(browsed.namespaceItem.namespace.namespaceId)}:`
      );
    },
    LIVE_BROWSE_TIMEOUT_MS
  );

  /**
   * The decoration is the whole point of the service level, and it is the one
   * thing a fixture cannot prove: the counts it is computed from come from the
   * catalog endpoint, and whether that endpoint answered at all is a fact
   * about the server.
   */
  it(
    'decorates a healthy instance and the service above it as healthy',
    async () => {
      const browsed = await browse();
      const healthy = browsed.services
        .flatMap((service) => instancesIn(browsed.instances.get(String(service.id)) ?? []))
        .find((item) => item.serviceInstance.healthy && item.serviceInstance.enabled);
      expect(healthy, 'no healthy instance on this server to assert a decoration on').toBeDefined();
      const instanceItem = healthy as ServiceInstanceTreeItem;

      expect(decorationOf(instanceItem)).toEqual({ icon: 'pass', color: 'charts.green' });
      expect(String(instanceItem.label)).toMatch(/^\d+\.\d+\.\d+\.\d+:\d+$/);
      expect(instanceItem.command, 'M3 has no detail panel, so an instance node must not be clickable').toBeUndefined();

      // The service above it: its counts came from the catalog, so a
      // description of anything but `healthy/total` means the driver fell back
      // to the name-only listing and the tree is showing less than it could.
      const parent = browsed.services.find(
        (service) => instancesIn(browsed.instances.get(String(service.id)) ?? []).includes(instanceItem)
      );
      expect(parent, 'the healthy instance has no service node above it').toBeDefined();
      const serviceItem = parent as ServiceTreeItem;
      expect(serviceItem.service.instanceCount, 'the catalog counts did not reach the tree').toBeDefined();
      expect(String(serviceItem.description)).toMatch(/^\d+\/\d+$/);

      console.log(
        `  ${String(serviceItem.label)} ${String(serviceItem.description)} ` +
          `$(${decorationOf(serviceItem).icon}) ${decorationOf(serviceItem).color ?? '(no colour)'}\n` +
          `    ${String(instanceItem.label)} ${String(instanceItem.description)} ` +
          `$(${decorationOf(instanceItem).icon}) ${decorationOf(instanceItem).color ?? '(no colour)'}\n` +
          `    tooltip: ${String(instanceItem.tooltip).replace(/\n/g, ' | ')}\n` +
          `    id: ${String(instanceItem.id)}`
      );
    },
    LIVE_BROWSE_TIMEOUT_MS
  );
});
