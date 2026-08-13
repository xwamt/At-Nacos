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
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { createNacosClient } from '../../src/extension';
import type { NacosInstanceConfig } from '../../src/config/schema';
import { buildConfigHistoryUri, buildConfigUri } from '../../src/document/configUri';
import { compareConfigAcrossEnvironments, diffWithPreviousVersion } from '../../src/document/diffConfig';
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
import { loadClusterStatus, renderClusterStatus } from '../../src/webview/ClusterStatusPanel';
import { loadConfigHistory, renderConfigHistory } from '../../src/webview/ConfigHistoryPanel';
import { loadConfigListeners, renderConfigListeners } from '../../src/webview/ConfigListenersPanel';
import { loadServiceSubscribers, renderServiceSubscribers } from '../../src/webview/ServiceSubscribersPanel';

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

/**
 * The cluster panel, built from what this server actually answers.
 *
 * The suites above prove the client can read the cluster; this one is the
 * only thing that proves the panel can show it. Everything a node reports is
 * optional except its address and its state, and a fixture cannot say which
 * of those a real 2.3.2 fills in -- a body full of "not reported" would pass
 * every render test in `test/webview` and tell a user nothing.
 */
describeLive('a real Nacos server, through the cluster status panel', () => {
  it('renders the panel body from the live cluster nodes and metrics', async () => {
    const client = await connectLive();
    const snapshot = await loadClusterStatus(async () => client);
    const view = renderClusterStatus({ instanceLabel: 'live', snapshot });

    expect(snapshot.nodesError, 'the node listing failed').toBeUndefined();
    expect(snapshot.metricsError, 'the metrics request failed').toBeUndefined();
    expect(snapshot.nodes.length).toBeGreaterThan(0);
    const address = snapshot.nodes[0]?.address ?? '';
    expect(view.body).toContain(address);
    // The count only exists because the request carried `onlyStatus=false`;
    // without it the panel would render seven "not reported" cells.
    expect(snapshot.metrics?.serviceCount, 'no serviceCount to render').toBeDefined();
    expect(view.body).toContain(`>${snapshot.metrics?.serviceCount}<`);
    // A field the server did report must not arrive as the word `undefined`,
    // which is what a template writes when a value is interpolated unchecked.
    expect(view.body).not.toContain('undefined');
    // The badge class is chosen from the five states we know. Falling back to
    // `state-unknown` here would mean this server names its states some other
    // way than `NodeState` does.
    expect(view.body).not.toContain('state-unknown');

    console.log(`  panel body for ${snapshot.nodes.length} node(s), ${view.body.length} bytes:`);
    for (const row of view.body.match(/<tr class="node-summary">[\s\S]*?<\/tr>/g) ?? []) {
      console.log(`    ${row.replace(/\s+/g, ' ')}`);
    }
    for (const metric of view.body.match(/<div class="metric">[\s\S]*?<\/div>/g) ?? []) {
      console.log(`    ${metric.replace(/\s+/g, ' ')}`);
    }
  });

  /**
   * The raft detail is the one part of the table the extension side has to
   * flatten out of `extendInfo.raftMetaData` before it can be rendered, so a
   * row that opens onto nothing means the normalization lost it between the
   * driver and the page.
   */
  it('renders the raft groups of a live node behind an expander', async () => {
    const client = await connectLive();
    const snapshot = await loadClusterStatus(async () => client);
    const groups = snapshot.nodes.flatMap((node) => node.raftGroups ?? []);
    expect(groups.length, 'this server reported no raft group to render').toBeGreaterThan(0);

    const body = renderClusterStatus({ instanceLabel: 'live', snapshot }).body;

    expect(body).toContain('class="node-toggle"');
    for (const group of groups) {
      expect(body).toContain(group.group);
      expect(body).toContain(group.leader);
    }
    console.log(`  ${groups.length} raft group(s) rendered:`);
    for (const group of groups) {
      console.log(`    ${group.group.padEnd(30)} leader=${group.leader} term=${group.term}`);
    }
  });
});

/**
 * M4's five capabilities on the same server, and the sharpest split this
 * suite has between what a real server can settle and what it cannot.
 *
 * The subscribers and the service detail are **verified**: this server has
 * thirteen services, each with a client watching it, and both endpoints
 * answer with real rows. The history and the listeners are **not**: nothing
 * here has ever been republished and nothing is long-polling, so both come
 * back empty on every configuration in every namespace. An empty answer still
 * proves the request reached the right endpoint under the right parameter
 * names -- a wrong namespace parameter answers empty too, but a wrong *path*
 * or a wrong envelope does not -- so what stays unverified is exactly the
 * field names of a populated row (§14.8).
 */
describeLive('a real Nacos server, its history and who is using it', () => {
  it(
    'answers a configuration with no history with an empty page rather than a failure',
    async () => {
      const { client, namespaceId, config } = await findLiveConfig();

      const page = await client.listConfigHistory({
        namespaceId,
        group: config.group,
        dataId: config.dataId,
        pageNo: 1,
        pageSize: 100
      });

      // The assertion that matters is that this did not throw. Empty is the
      // ordinary state of a configuration nobody has republished, and a
      // client that reported it as an error would be wrong about most
      // configurations on most servers.
      expect(Array.isArray(page.items)).toBe(true);
      expect(page.items.length).toBe(page.totalCount);
      console.log(
        `  ${namespaceId}/${config.group}/${config.dataId}: ${page.totalCount} history entries ` +
          `(page ${page.pageNumber} of ${page.pagesAvailable})`
      );
      if (page.items.length === 0) {
        console.log('    empty -- this server has never republished a config, so no row shape is verified here');
      }
      for (const entry of page.items) {
        console.log(
          `    id=${entry.id} opType=${JSON.stringify(entry.opType)} ` +
            `modifiedAt=${entry.modifiedAt ?? '(none)'} srcIp=${entry.srcIp ?? '?'} srcUser=${entry.srcUser ?? '?'}`
        );
      }
    },
    LIVE_BROWSE_TIMEOUT_MS
  );

  /**
   * The one history behaviour this server *can* settle: a `nid` nobody wrote
   * answers **HTTP 200 with an empty body** on the v1 path, which is the same
   * absence `?show=all` reports for a missing config (§14.2 ⓪) and not the
   * 404 the research predicted. It has to read as "no such version" rather
   * than walk the driver chain looking for an API family that could conjure
   * one up.
   */
  it('says a history version that was never written is missing, rather than blaming the API version', async () => {
    const { client, namespaceId, config } = await findLiveConfig();

    const error = (await client
      .getConfigHistory({ namespaceId, group: config.group, dataId: config.dataId, nid: '99999999' })
      .catch((thrown: unknown) => thrown)) as NacosApiError;

    expect(error.kind).toBe('resource-not-found');
    expect(error.shouldFallThrough()).toBe(false);
    console.log(`  missing nid -> kind=${error.kind} status=${error.status ?? '(none)'}: ${error.message}`);
  });

  it(
    'answers a configuration nobody is watching with no listeners rather than a failure',
    async () => {
      const { client, namespaceId, config } = await findLiveConfig();

      const listeners = await client.listConfigListeners({
        namespaceId,
        group: config.group,
        dataId: config.dataId
      });

      // Reaching here at all is the assertion: the misspelled
      // `lisentersGroupkeyStatus` was found and read as a map. A response
      // whose key had been renamed would have raised `invalid-response`
      // instead of answering an empty list.
      expect(Array.isArray(listeners)).toBe(true);
      console.log(`  ${namespaceId}/${config.group}/${config.dataId}: ${listeners.length} listener(s)`);
      if (listeners.length === 0) {
        console.log('    empty -- nothing is long-polling this server, so no listener row is verified here');
      }
      for (const listener of listeners) {
        console.log(`    ${listener.ip} md5=${listener.md5}`);
      }
    },
    LIVE_BROWSE_TIMEOUT_MS
  );

  it(
    'reads a service detail, whose clusters are shaped differently on every version',
    async () => {
      const { client, populated } = await browseServices();
      const service = populated.page.items[0];
      expect(service, 'no service to read a detail for').toBeDefined();

      const detail = await client.getService({
        namespaceId: service?.namespaceId ?? '',
        group: service?.group ?? '',
        serviceName: service?.serviceName ?? ''
      });

      // The identity must come back intact. v1 resolves a *bare* service name
      // to `DEFAULT_GROUP@@name` and answers HTTP 500 "service not found", so
      // a detail that arrived at all is proof the grouped spelling went out.
      expect(detail.serviceName).toBe(service?.serviceName);
      expect(detail.group).toBe(service?.group);
      expect(detail.serviceName).not.toContain('@@');
      expect(detail.clusters.length, 'a registered service reported no cluster at all').toBeGreaterThan(0);

      console.log(
        `  ${detail.namespaceId}/${detail.group}/${detail.serviceName}: ` +
          `protectThreshold=${detail.protectThreshold} ephemeral=${detail.ephemeral ?? '(not reported)'} ` +
          `metadata=${JSON.stringify(detail.metadata)}`
      );
      for (const cluster of detail.clusters) {
        console.log(
          `    cluster ${cluster.name.padEnd(12)} healthChecker=${cluster.healthCheckerType ?? '(none)'} ` +
            `metadata=${JSON.stringify(cluster.metadata)}`
        );
      }
    },
    LIVE_BROWSE_TIMEOUT_MS
  );

  /**
   * The one M4 capability with real data behind it, and the one whose
   * top-level shape the research had wrong: this server answers
   * `{"subscribers":[...],"count":N}`, not the `pageItems` page 3.x is
   * documented to send.
   */
  it(
    'lists the subscribers of a service, with the group prefix taken off each one',
    async () => {
      const { client, populated } = await browseServices();

      const found = await Promise.all(
        populated.page.items.map(async (service) => ({
          service,
          subscribers: await client.listSubscribers({
            namespaceId: service.namespaceId,
            group: service.group,
            serviceName: service.serviceName
          })
        }))
      );

      const watched = found.filter((entry) => entry.subscribers.length > 0);
      expect(watched.length, 'no service on this server has a subscriber; nothing to verify').toBeGreaterThan(0);
      for (const { service, subscribers } of watched) {
        for (const subscriber of subscribers) {
          expect(subscriber.ip.length).toBeGreaterThan(0);
          // The server sends `cl-intimfy@@cl-auth-offline` here, exactly as
          // it does on an instance. A separator surviving to this point would
          // mean a panel renders a Nacos protocol detail as a service name.
          expect(subscriber.serviceName).not.toContain('@@');
          expect(subscriber.serviceName).toBe(service.serviceName);
          expect(subscriber.group).toBe(service.group);
        }
      }

      console.log(`  ${watched.length} of ${found.length} services in ${populated.namespaceId} have subscribers:`);
      for (const { service, subscribers } of watched) {
        for (const subscriber of subscribers) {
          console.log(
            `    ${service.group}/${service.serviceName.padEnd(32)} <- ${subscriber.ip}:${subscriber.port} ` +
              `agent=${subscriber.agent ?? '?'} app=${subscriber.app ?? '?'} ` +
              `cluster=${subscriber.cluster ?? '(none)'}`
          );
        }
      }
    },
    LIVE_BROWSE_TIMEOUT_MS
  );

  /**
   * A gRPC subscriber has no callback port and reports 0. Anything treating
   * that as "the port is missing" would hide the ordinary case, since every
   * subscriber on a 2.x server connects over gRPC.
   */
  it(
    'keeps a subscriber port of zero, which is what every gRPC client reports',
    async () => {
      const { client, populated } = await browseServices();
      const service = populated.page.items[0];

      const subscribers = await client.listSubscribers({
        namespaceId: service?.namespaceId ?? '',
        group: service?.group ?? '',
        serviceName: service?.serviceName ?? ''
      });

      expect(subscribers.length, 'the first service has no subscriber to inspect').toBeGreaterThan(0);
      for (const subscriber of subscribers) {
        expect(typeof subscriber.port).toBe('number');
      }
      console.log(
        `  ${service?.serviceName}: ` +
          subscribers.map((subscriber) => `${subscriber.ip}:${subscriber.port}`).join(', ')
      );
    },
    LIVE_BROWSE_TIMEOUT_MS
  );

  /**
   * A service nobody registered, asked the same question. It answers
   * `{"subscribers":[],"count":0}` under HTTP 200 -- indistinguishable from a
   * service that exists and is unwatched, and not a failure either way.
   */
  it('answers the subscribers of a service nobody registered with an empty list', async () => {
    const client = await connectLive();

    const subscribers = await client.listSubscribers({
      namespaceId: '',
      group: 'DEFAULT_GROUP',
      serviceName: 'at-nacos-no-such-service-please-do-not-register'
    });

    expect(subscribers).toEqual([]);
    console.log('  a service nobody registered -> 0 subscribers, no error');
  });
});

/**
 * M4's panels and its three diff entry points, against the same server.
 *
 * The split here is the same one §14.8 recorded and is worth restating,
 * because it decides what these tests can mean. **Cross-environment
 * comparison and service subscribers are verified**: two namespaces of this
 * server hold the same configuration under the same group with different
 * content, and every service in `cl-parent-offline` has at least one
 * subscriber. **The history and listener row rendering is not**: both
 * endpoints answer empty on every configuration here, so what these tests
 * prove about them is that empty is not a failure and that the empty state is
 * the one that renders.
 */
describeLive('a real Nacos server, through the M4 panels and diffs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    'renders the history panel of a live configuration, whose history is empty',
    async () => {
      const { namespaceId, config } = await findLiveConfig();
      const ref = { namespaceId, group: config.group, dataId: config.dataId };

      const snapshot = await loadConfigHistory(connectLive, ref);
      const body = renderConfigHistory({ instanceLabel: 'live', ref, snapshot }).body;

      expect(snapshot.error, 'reading the history failed').toBeUndefined();
      expect(body).toContain(config.dataId);
      // Empty is the ordinary state here, so the note is what has to render --
      // a table header with no rows would say nothing about why.
      if (snapshot.entries.length === 0) {
        expect(body).toContain('no history');
      } else {
        expect(body).toContain('class="version-row"');
      }
      console.log(
        `  ${namespaceId}/${config.group}/${config.dataId}: ${snapshot.totalCount} version(s), ` +
          `${body.length} bytes of panel body`
      );
      for (const entry of snapshot.entries) {
        console.log(`    id=${entry.id} opType=${JSON.stringify(entry.opType)} modifiedAt=${entry.modifiedAt ?? '?'}`);
      }
    },
    LIVE_BROWSE_TIMEOUT_MS
  );

  /**
   * The one history path this server *can* settle end to end: a `nid` nobody
   * wrote comes back as HTTP 200 with an empty body, which the driver reads as
   * `resource-not-found`, and the document provider turns into a sentence
   * about the *version* rather than about the configuration.
   */
  it(
    'answers a history address for a version that was never written with readable prose',
    async () => {
      const { namespaceId, config } = await findLiveConfig();
      const uri = buildConfigHistoryUri(
        'live',
        { namespaceId, group: config.group, dataId: config.dataId },
        '99999999'
      );

      const content = await liveDocumentProvider().provideTextDocumentContent(uri);

      expect(content).toContain('99999999');
      expect(content).not.toContain('no longer exists in group');
      console.log(`  ${uri.toString()}\n    -> ${content}`);
    },
    LIVE_BROWSE_TIMEOUT_MS
  );

  it(
    'says a configuration with no history has no previous version, instead of opening an empty diff',
    async () => {
      const { namespaceId, config } = await findLiveConfig();
      const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
      const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage');

      await diffWithPreviousVersion({
        instanceId: 'live',
        ref: { namespaceId, group: config.group, dataId: config.dataId },
        connect: connectLive
      });

      const diffs = executeCommand.mock.calls.filter((call) => call[0] === 'vscode.diff');
      expect(diffs, 'this server grew a history row; the empty-history branch is no longer what ran').toHaveLength(0);
      const said = String(vi.mocked(showInformationMessage).mock.calls[0]?.[0]);
      expect(said).toContain(config.dataId);
      console.log(`  ${config.dataId} -> ${said}`);
    },
    LIVE_BROWSE_TIMEOUT_MS
  );

  it(
    'renders the listener panel of a live configuration, with the current md5 read from the server',
    async () => {
      const { namespaceId, config } = await findLiveConfig();
      const ref = { namespaceId, group: config.group, dataId: config.dataId };

      const snapshot = await loadConfigListeners(connectLive, ref);
      const body = renderConfigListeners({ instanceLabel: 'live', ref, snapshot }).body;

      expect(snapshot.listenersError, 'reading the listeners failed').toBeUndefined();
      expect(snapshot.configError, 'reading the configuration failed').toBeUndefined();
      // The md5 is the left-hand side of every staleness comparison this panel
      // makes. Without it the table can only say "cannot be compared", so a
      // server that reports one is what makes the feature possible at all.
      expect(snapshot.currentMd5, 'this server reports no md5, so no listener could ever be judged').toBeDefined();
      // The configuration body is fetched for that one field and must not
      // reach the snapshot: it holds this deployment's redis password.
      expect(JSON.stringify(snapshot)).not.toContain('password');
      console.log(
        `  ${namespaceId}/${config.group}/${config.dataId}: ${snapshot.listeners.length} listener(s), ` +
          `current md5=${snapshot.currentMd5}`
      );
      for (const listener of snapshot.listeners) {
        console.log(`    ${listener.ip} md5=${listener.md5}`);
      }
      if (snapshot.listeners.length === 0) {
        expect(body).toContain('no client');
        console.log('    empty -- nothing is long-polling this server, so no listener row is rendered here');
      }
    },
    LIVE_BROWSE_TIMEOUT_MS
  );

  it(
    'renders the subscriber panel of a live service, one row per real subscriber',
    async () => {
      const { client, populated } = await browseServices();
      const found = await Promise.all(
        populated.page.items.map(async (service) => ({
          service,
          snapshot: await loadServiceSubscribers(async () => client, {
            namespaceId: service.namespaceId,
            group: service.group,
            serviceName: service.serviceName
          })
        }))
      );
      const watched = found.filter((entry) => entry.snapshot.subscribers.length > 0);
      expect(watched.length, 'no service on this server has a subscriber to render').toBeGreaterThan(0);

      for (const { service, snapshot } of watched) {
        const ref = { namespaceId: service.namespaceId, group: service.group, serviceName: service.serviceName };
        const body = renderServiceSubscribers({ instanceLabel: 'live', ref, snapshot }).body;
        expect(snapshot.error).toBeUndefined();
        expect(body.match(/class="subscriber-row"/g) ?? []).toHaveLength(snapshot.subscribers.length);
        for (const subscriber of snapshot.subscribers) {
          expect(body).toContain(subscriber.ip);
        }
        // Every subscriber here is a gRPC client and reports port 0, which is
        // an answer rather than a gap -- `ip:0` in the address column would
        // read as a port nobody can connect to.
        expect(body).not.toContain('undefined');
      }

      // The multi-row branch, which the research had no evidence for: at least
      // one service on this server is watched by more than one client.
      const manyRows = watched.find((entry) => entry.snapshot.subscribers.length > 1);
      expect(manyRows, 'no service has two subscribers, so the multi-row branch is fixture-only after all').toBeDefined();

      console.log(`  ${watched.length} of ${found.length} services in ${populated.namespaceId} have subscribers:`);
      for (const { service, snapshot } of watched) {
        console.log(
          `    ${service.serviceName.padEnd(32)} ${snapshot.subscribers.length} row(s): ` +
            snapshot.subscribers.map((entry) => `${entry.ip} port=${entry.port} agent=${entry.agent ?? '?'}`).join(' | ')
        );
      }
    },
    LIVE_BROWSE_TIMEOUT_MS
  );

  /**
   * The whole cross-environment path, end to end: the namespace pick, the
   * probe that decides whether the target holds this configuration, and the
   * two addresses handed to `vscode.diff` -- then both of those addresses
   * resolved through the content provider, which is the only thing that
   * proves the editor would show two real, different files.
   */
  it(
    'diffs one configuration across two namespaces of this server',
    async () => {
      const { source, targetNamespaceId, differs } = await findComparableConfig();
      const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
      // Answered by namespace id rather than by position, so this test means
      // the same thing whatever order the server lists namespaces in.
      vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (
        items: readonly { description?: string }[] | Thenable<readonly { description?: string }[]>
      ) => (await items).find((choice) => choice.description === targetNamespaceId)) as never);

      await compareConfigAcrossEnvironments({
        source: { instance: { id: 'live', label: 'live' }, ref: source.ref },
        listInstances: async () => [liveInstance()],
        connect: () => connectLive()
      });

      const diff = executeCommand.mock.calls.find((call) => call[0] === 'vscode.diff');
      expect(diff, 'no diff was opened').toBeDefined();
      const [, left, right, title] = diff as [string, vscode.Uri, vscode.Uri, string];
      expect(left.toString()).toBe(buildConfigUri('live', source.ref).toString());
      expect(left.toString()).not.toBe(right.toString());

      const provider = liveDocumentProvider();
      const [leftContent, rightContent] = await Promise.all([
        provider.provideTextDocumentContent(left),
        provider.provideTextDocumentContent(right)
      ]);
      expect(leftContent.length).toBeGreaterThan(0);
      expect(rightContent.length).toBeGreaterThan(0);
      // The provider answers every failure with prose instead of rejecting, so
      // a length check alone would pass for two error messages.
      for (const content of [leftContent, rightContent]) {
        expect(content).not.toMatch(/AT Nacos|no longer exists|no longer configured/);
      }
      // The claim worth making, and the one a pair of identical copies could
      // not support: two environments measured to hold different content
      // arrive at the editor as two different texts. It is the whole address
      // round trip -- build, parse, refetch -- that this closes over, so a
      // URI that lost its namespace on the way back would fail here.
      expect(
        differs && leftContent === rightContent,
        'the two namespaces hold different content, but the same text came back for both addresses'
      ).toBe(false);
      expect(
        differs,
        'no pair of namespaces on this server holds different content, so the diff shows nothing either way'
      ).toBe(true);

      console.log(
        `  ${title}\n` +
          `    left  ${left.toString()} (${leftContent.length} bytes)\n` +
          `    right ${right.toString()} (${rightContent.length} bytes)\n` +
          `    the two sides ${leftContent === rightContent ? 'are identical' : 'differ'}`
      );
    },
    LIVE_BROWSE_TIMEOUT_MS
  );

  /**
   * The other half of the same command, and the reason `resource-not-found`
   * exists as a kind of its own: a dataId nobody published in the target
   * namespace has to read as "not there" rather than as a server that could
   * not be reached, and it must not open a diff with a blank right-hand pane.
   */
  it(
    'says the target namespace has no such configuration, rather than opening a blank side',
    async () => {
      const { source, targetNamespaceId } = await findComparableConfig();
      const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
      const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage');
      vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (
        items: readonly { description?: string }[] | Thenable<readonly { description?: string }[]>
      ) => (await items).find((choice) => choice.description === targetNamespaceId)) as never);

      await compareConfigAcrossEnvironments({
        source: {
          instance: { id: 'live', label: 'live' },
          ref: { ...source.ref, dataId: 'at-nacos-no-such-config-please-do-not-create.yml' }
        },
        listInstances: async () => [liveInstance()],
        connect: () => connectLive()
      });

      expect(executeCommand.mock.calls.filter((call) => call[0] === 'vscode.diff')).toHaveLength(0);
      const said = String(vi.mocked(showInformationMessage).mock.calls[0]?.[0]);
      expect(said).toContain('at-nacos-no-such-config-please-do-not-create.yml');
      expect(said).toContain(targetNamespaceId);
      console.log(`  ${said}`);
    },
    LIVE_BROWSE_TIMEOUT_MS
  );
});

/** One configuration this server holds in two namespaces, which is what makes a cross-environment diff possible. */
interface ComparableConfig {
  source: { namespaceId: string; ref: NacosConfigSummary };
  targetNamespaceId: string;
  /** Whether the two copies were measured to hold different content. */
  differs: boolean;
}

/**
 * How many duplicate pairs are worth two requests each to tell apart. The
 * first differing pair ends the search, and on this server that is the first
 * pair looked at.
 */
const MAX_CONTENT_COMPARISONS = 12;

let comparableConfig: Promise<ComparableConfig> | undefined;

/**
 * Two namespaces holding the same group and dataId, found rather than named.
 * This server has eleven namespaces holding `application-dev.yml` under
 * `cl-intimfy`, but a suite hard-coded to a pair of namespace names would
 * mean nothing on anyone else's server.
 *
 * **A pair whose content differs is preferred, and that preference is the
 * point.** The first duplicate offered here in listing order can be
 * `sentinel-cl-gateway`, which is byte-identical in every namespace --
 * diffing that proves two buffers were opened and nothing about whether a
 * difference would show.
 *
 * Choosing on content costs two requests per candidate, which it should not
 * have to: the listing has an `md5` field. **On this server that field is
 * `null` on every row, under `search=accurate` as well** -- only the detail
 * endpoint fills it in (§14.9). So `NacosConfigSummary.md5` cannot be used to
 * tell two copies apart, here or anywhere the same build is deployed.
 */
function findComparableConfig(): Promise<ComparableConfig> {
  comparableConfig ??= (async () => {
    const client = await connectLive();
    const namespaces = await client.listNamespaces();
    const seen = new Map<string, { namespaceId: string; ref: NacosConfigSummary }>();
    let identical: ComparableConfig | undefined;
    let compared = 0;
    for (const namespace of namespaces) {
      const page = await client.listConfigs({ namespaceId: namespace.namespaceId, pageNo: 1, pageSize: 100 });
      for (const config of page.items) {
        const key = `${config.group}\u0000${config.dataId}`;
        const first = seen.get(key);
        if (!first) {
          seen.set(key, { namespaceId: namespace.namespaceId, ref: config });
          continue;
        }
        identical ??= { source: first, targetNamespaceId: namespace.namespaceId, differs: false };
        if (compared >= MAX_CONTENT_COMPARISONS) {
          continue;
        }
        compared += 1;
        const [before, after] = await Promise.all([client.getConfig(first.ref), client.getConfig(config)]);
        if (before.content !== after.content) {
          return { source: first, targetNamespaceId: namespace.namespaceId, differs: true };
        }
      }
    }
    if (identical) {
      return identical;
    }
    throw new Error('no configuration on this server exists in two namespaces; nothing to compare across environments');
  })();
  return comparableConfig;
}

/** One configuration of the live server, whichever namespace has one. Shared: each probe costs a round trip. */
interface BrowsedConfig {
  client: NacosClient;
  namespaceId: string;
  config: NacosConfigSummary;
}

let browsedConfig: Promise<BrowsedConfig> | undefined;

function findLiveConfig(): Promise<BrowsedConfig> {
  browsedConfig ??= (async () => {
    const client = await connectLive();
    const namespaces = await client.listNamespaces();
    for (const namespace of namespaces) {
      const page = await client.listConfigs({ namespaceId: namespace.namespaceId, pageNo: 1, pageSize: 100 });
      const config = page.items[0];
      if (config) {
        return { client, namespaceId: namespace.namespaceId, config };
      }
    }
    throw new Error('no namespace on this server holds a configuration; nothing to ask about');
  })();
  return browsedConfig;
}

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
