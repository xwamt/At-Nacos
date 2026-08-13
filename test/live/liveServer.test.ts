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
import type { NacosApiError } from '../../src/nacos/NacosApiError';
import type { NacosClient } from '../../src/nacos/NacosClient';
import { configLanguageId } from '../../src/nacos/driver/configLanguage';
import type { NacosConfigSummary } from '../../src/nacos/driver/normalize';
import { testNacosConnection } from '../../src/nacos/testNacosConnection';
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
