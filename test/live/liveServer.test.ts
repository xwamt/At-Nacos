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
    const configManager = {
      getPassword: async () => password,
      getCustomHeaders: async () => undefined
    };
    const certTrustStore = { check: async () => 'trusted' as const };

    const client = await createNacosClient(
      configManager as never,
      liveInstance(),
      certTrustStore as never,
      noopLog
    );
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
