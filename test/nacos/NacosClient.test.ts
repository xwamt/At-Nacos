import { describe, expect, it, vi } from 'vitest';
import { NacosApiError } from '../../src/nacos/NacosApiError';
import { NacosCapabilityResolver } from '../../src/nacos/NacosCapabilityResolver';
import { buildChainAdvice, buildDriverChain, NacosClient } from '../../src/nacos/NacosClient';
import type { NacosHttpClient, NacosRequestOptions } from '../../src/nacos/NacosHttpClient';
import type { NacosApiFlavor, NacosDriver } from '../../src/nacos/driver/NacosDriver';
import type { NacosServerState } from '../../src/nacos/probe/probeServerState';

const CONSOLE_BASE_URL = 'http://h:8080';

interface StubCall {
  path: string;
  options: NacosRequestOptions | undefined;
}

interface StubHttp {
  calls: StubCall[];
  client: Pick<NacosHttpClient, 'requestJson' | 'requestRaw'>;
}

/** `requestJson` is generic, so the cast happens here once instead of in every test. */
function recordingHttp(respond: (path: string) => unknown = () => ({ code: 0, data: [] })): StubHttp {
  const calls: StubCall[] = [];
  return {
    calls,
    client: {
      async requestJson<T>(_method: string, path: string, options?: NacosRequestOptions): Promise<T> {
        calls.push({ path, options });
        return respond(path) as T;
      },
      async requestRaw(_method: string, path: string, options?: NacosRequestOptions) {
        calls.push({ path, options });
        return {
          status: 200,
          ok: true,
          text: JSON.stringify(respond(path)),
          contentType: 'application/json'
        };
      }
    }
  };
}

function flavorsOf(chain: readonly NacosDriver[]): NacosApiFlavor[] {
  return chain.map((driver) => driver.flavor);
}

function serverState(majorVersion: number): NacosServerState {
  return {
    version: `${majorVersion}.0.0`,
    majorVersion,
    startupMode: 'standalone',
    authEnabled: false,
    raw: {}
  };
}

describe('buildDriverChain', () => {
  it('puts admin first on 3.x and keeps console behind it as the 403 fallback', () => {
    const http = recordingHttp();
    expect(flavorsOf(buildDriverChain(3, http.client, CONSOLE_BASE_URL))).toEqual([
      'v3-admin',
      'v3-console',
      'v2',
      'v1'
    ]);
  });

  /**
   * `nacos.console.ui.enabled=false`, or a console deployed on a host we were
   * never told about. Admin still answers, so the chain is built without the
   * fallback rather than not built at all.
   */
  it('omits the console driver on 3.x when no console origin is known', () => {
    const http = recordingHttp();
    expect(flavorsOf(buildDriverChain(3, http.client, undefined))).toEqual(['v3-admin', 'v2', 'v1']);
  });

  /** An empty string is not an origin, and a driver built on one would request `/v3/console/...` of nowhere. */
  it('treats an empty console origin as no console at all', () => {
    const http = recordingHttp();
    expect(flavorsOf(buildDriverChain(3, http.client, ''))).toEqual(['v3-admin', 'v2', 'v1']);
  });

  it('keeps the 3.x shape on later 3.x majors', () => {
    const http = recordingHttp();
    expect(flavorsOf(buildDriverChain(4, http.client, CONSOLE_BASE_URL))).toEqual([
      'v3-admin',
      'v3-console',
      'v2',
      'v1'
    ]);
  });

  /** v3 does not exist on 2.x, so a v3 tail would only buy a guaranteed 404 per capability. */
  it('asks v2 first and keeps v1 behind it on 2.x, with no v3 tail', () => {
    const http = recordingHttp();
    expect(flavorsOf(buildDriverChain(2, http.client, CONSOLE_BASE_URL))).toEqual(['v2', 'v1']);
  });

  it('offers v1 alone on 1.x', () => {
    const http = recordingHttp();
    expect(flavorsOf(buildDriverChain(1, http.client, CONSOLE_BASE_URL))).toEqual(['v1']);
  });

  /**
   * `probeServerState` rejects a version it cannot parse, so reaching here
   * means a caller skipped the probe. Trying everything costs a few 404s that
   * the resolver caches away; guessing the oldest version would leave a 3.x
   * server permanently unusable.
   */
  it.each([[Number.NaN], [0], [-1]])(
    'tries every flavor when the major version is %s rather than guessing the oldest',
    (majorVersion) => {
      const http = recordingHttp();
      expect(flavorsOf(buildDriverChain(majorVersion, http.client, CONSOLE_BASE_URL))).toEqual([
        'v3-admin',
        'v3-console',
        'v2',
        'v1'
      ]);
    }
  );

  it('gives every driver the same http client and only the console driver the console origin', async () => {
    const http = recordingHttp();
    for (const driver of buildDriverChain(3, http.client, CONSOLE_BASE_URL)) {
      await driver.listNamespaces();
    }
    expect(http.calls).toEqual([
      { path: '/v3/admin/core/namespace/list', options: undefined },
      { path: '/v3/console/core/namespace/list', options: { baseUrlOverride: CONSOLE_BASE_URL } },
      { path: '/v2/console/namespace/list', options: undefined },
      { path: '/v1/console/namespaces', options: undefined }
    ]);
  });
});

/**
 * `buildDriverChain` is the only place that knows a console driver was left
 * out and why, so it is also the only place that can say what would put one
 * back. The resolver asks; this answers.
 */
describe('buildChainAdvice', () => {
  it('names the console address when v3-admin refused and the chain had no console driver', () => {
    const advice = buildChainAdvice(3, undefined)([{ flavor: 'v3-admin', kind: 'forbidden', status: 403 }]);

    expect(advice).toMatch(/console/i);
    expect(advice).toMatch(/administrator/i);
  });

  it('says nothing when the chain already had a console driver to fall through to', () => {
    expect(buildChainAdvice(3, CONSOLE_BASE_URL)([{ flavor: 'v3-admin', kind: 'forbidden', status: 403 }])).toBeUndefined();
  });

  /** A 404 from the admin API is a missing endpoint, not a permission the console API would satisfy. */
  it('says nothing when v3-admin failed for a reason a console account would not fix', () => {
    expect(buildChainAdvice(3, undefined)([{ flavor: 'v3-admin', kind: 'not-found', status: 404 }])).toBeUndefined();
  });

  it('says nothing on 1.x and 2.x, which have no console API to point at', () => {
    const attempts = [{ flavor: 'v1', kind: 'forbidden', status: 403 } as const];
    expect(buildChainAdvice(1, undefined)(attempts)).toBeUndefined();
    expect(buildChainAdvice(2, undefined)(attempts)).toBeUndefined();
  });
});

describe('NacosClient', () => {
  it('exposes the probed server state the chain was built from', () => {
    const client = new NacosClient(new NacosCapabilityResolver([]), serverState(3));
    expect(client.state).toMatchObject({ version: '3.0.0', majorVersion: 3, startupMode: 'standalone' });
  });

  it('lists namespaces through the resolver, under the namespaces capability', async () => {
    const http = recordingHttp((path) =>
      path.startsWith('/v3/admin')
        ? { code: 0, data: [{ namespace: 'public', namespaceShowName: 'public', type: 0 }] }
        : { code: 0, data: [] }
    );
    const resolver = new NacosCapabilityResolver(buildDriverChain(3, http.client, CONSOLE_BASE_URL));

    await expect(new NacosClient(resolver, serverState(3)).listNamespaces()).resolves.toEqual([
      {
        namespaceId: 'public',
        displayName: 'public',
        description: undefined,
        quota: undefined,
        configCount: undefined,
        type: 0
      }
    ]);
    expect(resolver.snapshot()).toEqual({ namespaces: 'v3-admin' });
  });

  /** The whole point of the facade: a non-admin account on 3.x still sees its namespaces. */
  it('degrades from admin to console when the account is not an administrator', async () => {
    const http = recordingHttp((path) => {
      if (path.startsWith('/v3/admin')) {
        throw new NacosApiError('forbidden', 'denied', 403);
      }
      return { code: 0, data: [{ namespace: 'public', namespaceShowName: 'public', type: 0 }] };
    });
    const resolver = new NacosCapabilityResolver(buildDriverChain(3, http.client, CONSOLE_BASE_URL));

    const namespaces = await new NacosClient(resolver, serverState(3)).listNamespaces();
    expect(namespaces.map((namespace) => namespace.namespaceId)).toEqual(['public']);
    expect(resolver.snapshot()).toEqual({ namespaces: 'v3-console' });
  });

  /**
   * The facade holds no cache of its own -- the tree providers own that, and a
   * second layer of it here would make a refresh command lie.
   */
  it('asks again on every call rather than memoizing the list', async () => {
    const listNamespaces = vi.fn(() => Promise.resolve([]));
    const driver: NacosDriver = { ...stubDriver('v1'), listNamespaces };
    const client = new NacosClient(new NacosCapabilityResolver([driver]), serverState(1));

    await client.listNamespaces();
    await client.listNamespaces();
    expect(listNamespaces).toHaveBeenCalledTimes(2);
  });

  it('lists configs through the resolver, under its own capability', async () => {
    const http = recordingHttp(() => ({ totalCount: 0, pageNumber: 1, pagesAvailable: 0, pageItems: [] }));
    const resolver = new NacosCapabilityResolver(buildDriverChain(2, http.client, undefined));

    await expect(
      new NacosClient(resolver, serverState(2)).listConfigs({ namespaceId: 'uat', pageNo: 1, pageSize: 100 })
    ).resolves.toEqual({ items: [], totalCount: 0, pageNumber: 1, pagesAvailable: 0 });
    expect(resolver.snapshot()).toEqual({ configs: 'v2' });
  });

  it('fetches one config through the resolver, under a capability of its own', async () => {
    const http = recordingHttp(() => ({ dataId: 'a.yml', group: 'g', tenant: 'uat', content: 'a: 1', type: 'yaml' }));
    const resolver = new NacosCapabilityResolver(buildDriverChain(2, http.client, undefined));

    await expect(
      new NacosClient(resolver, serverState(2)).getConfig({ namespaceId: 'uat', group: 'g', dataId: 'a.yml' })
    ).resolves.toMatchObject({ content: 'a: 1', type: 'yaml' });
    expect(resolver.snapshot()).toEqual({ 'config-detail': 'v2' });
  });

  it('lists services through the resolver, under its own capability', async () => {
    const http = recordingHttp(() => ({ count: 1, serviceList: [{ name: 'order-service', groupName: 'g' }] }));
    const resolver = new NacosCapabilityResolver(buildDriverChain(2, http.client, undefined));

    const page = await new NacosClient(resolver, serverState(2)).listServices({
      namespaceId: 'uat',
      pageNo: 1,
      pageSize: 100
    });
    expect(page.items.map((item) => item.serviceName)).toEqual(['order-service']);
    expect(resolver.snapshot()).toEqual({ services: 'v2' });
  });

  it('lists instances through the resolver, under its own capability', async () => {
    const http = recordingHttp(() => ({ code: 0, data: { name: 'g@@s', hosts: [{ ip: '10.0.0.7', port: 8080 }] } }));
    const resolver = new NacosCapabilityResolver(buildDriverChain(2, http.client, undefined));

    const instances = await new NacosClient(resolver, serverState(2)).listInstances({
      namespaceId: 'uat',
      group: 'g',
      serviceName: 's'
    });
    expect(instances.map((instance) => instance.ip)).toEqual(['10.0.0.7']);
    expect(resolver.snapshot()).toEqual({ instances: 'v2' });
  });

  it('lists cluster nodes through the resolver, under its own capability', async () => {
    const http = recordingHttp(() => ({ code: 0, data: [{ ip: '172.25.0.2', port: 8848, state: 'UP' }] }));
    const resolver = new NacosCapabilityResolver(buildDriverChain(2, http.client, undefined));

    const nodes = await new NacosClient(resolver, serverState(2)).listClusterNodes();
    expect(nodes.map((node) => node.address)).toEqual(['172.25.0.2:8848']);
    expect(resolver.snapshot()).toEqual({ 'cluster-nodes': 'v2' });
  });

  it('reads the server metrics through the resolver, under its own capability', async () => {
    const http = recordingHttp(() => ({ code: 0, data: { status: 'UP', serviceCount: 13 } }));
    const resolver = new NacosCapabilityResolver(buildDriverChain(2, http.client, undefined));

    const metrics = await new NacosClient(resolver, serverState(2)).getServerMetrics();
    expect(metrics).toMatchObject({ status: 'UP', serviceCount: 13 });
    expect(resolver.snapshot()).toEqual({ 'server-metrics': 'v2' });
  });

  it('lists a config history through the resolver, under its own capability', async () => {
    const http = recordingHttp(() => ({
      totalCount: 1,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [{ id: 203, dataId: 'a.yml', group: 'g', tenant: 'uat', opType: 'U ' }]
    }));
    const resolver = new NacosCapabilityResolver(buildDriverChain(2, http.client, undefined));

    const page = await new NacosClient(resolver, serverState(2)).listConfigHistory({
      namespaceId: 'uat',
      group: 'g',
      dataId: 'a.yml',
      pageNo: 1,
      pageSize: 100
    });
    expect(page.items.map((item) => item.id)).toEqual(['203']);
    expect(resolver.snapshot()).toEqual({ 'config-history': 'v2' });
  });

  /**
   * A separate cache entry from the listing, for the reason `config-detail`
   * is separate from `configs`: a server can serve one and not the other, and
   * sharing an entry would let a fall-through on either evict the winner the
   * other had already found.
   */
  it('fetches one history version through the resolver, under a capability of its own', async () => {
    const http = recordingHttp(() => ({ dataId: 'a.yml', group: 'g', tenant: 'uat', content: 'a: 1' }));
    const resolver = new NacosCapabilityResolver(buildDriverChain(2, http.client, undefined));

    await expect(
      new NacosClient(resolver, serverState(2)).getConfigHistory({
        namespaceId: 'uat',
        group: 'g',
        dataId: 'a.yml',
        nid: '203'
      })
    ).resolves.toMatchObject({ content: 'a: 1' });
    expect(resolver.snapshot()).toEqual({ 'config-history-detail': 'v2' });
  });

  it('reads the config listeners through the resolver, under its own capability', async () => {
    const http = recordingHttp(() => ({ collectStatus: 200, lisentersGroupkeyStatus: { '10.0.0.7': 'md5' } }));
    const resolver = new NacosCapabilityResolver(buildDriverChain(2, http.client, undefined));

    const listeners = await new NacosClient(resolver, serverState(2)).listConfigListeners({
      namespaceId: 'uat',
      group: 'g',
      dataId: 'a.yml'
    });
    expect(listeners).toEqual([{ ip: '10.0.0.7', md5: 'md5' }]);
    expect(resolver.snapshot()).toEqual({ 'config-listeners': 'v2' });
  });

  it('reads a service detail through the resolver, under its own capability', async () => {
    const http = recordingHttp(() => ({ code: 0, data: { namespace: 'uat', serviceName: 's', groupName: 'g' } }));
    const resolver = new NacosCapabilityResolver(buildDriverChain(2, http.client, undefined));

    const detail = await new NacosClient(resolver, serverState(2)).getService({
      namespaceId: 'uat',
      group: 'g',
      serviceName: 's'
    });
    expect(detail).toMatchObject({ namespaceId: 'uat', group: 'g', serviceName: 's' });
    expect(resolver.snapshot()).toEqual({ 'service-detail': 'v2' });
  });

  it('lists subscribers through the resolver, under its own capability', async () => {
    const http = recordingHttp(() => ({ subscribers: [{ ip: '10.0.0.7', port: 0 }], count: 1 }));
    const resolver = new NacosCapabilityResolver(buildDriverChain(2, http.client, undefined));

    const subscribers = await new NacosClient(resolver, serverState(2)).listSubscribers({
      namespaceId: 'uat',
      group: 'g',
      serviceName: 's'
    });
    expect(subscribers.map((subscriber) => subscriber.ip)).toEqual(['10.0.0.7']);
    expect(resolver.snapshot()).toEqual({ subscribers: 'v2' });
  });

  /**
   * Three of v2's five new endpoints do not exist on a real 2.3.2 --
   * `/v2/ns/service/subscribers` and `/v2/cs/config/listener` answer 404, and
   * `/v2/cs/history/list` demands the v1 spelling of `group`. So the v2
   * driver reaches the v1 paths itself, and the v1 driver is never tried:
   * the capability cache must not be taught a flavor decision that has
   * nothing to do with the server's version.
   */
  it('serves the v1-only capabilities from the v2 driver without walking the chain', async () => {
    const http = recordingHttp(() => ({ subscribers: [], count: 0 }));
    const resolver = new NacosCapabilityResolver(buildDriverChain(2, http.client, undefined));

    await new NacosClient(resolver, serverState(2)).listSubscribers({
      namespaceId: 'uat',
      group: 'g',
      serviceName: 's'
    });

    expect(resolver.snapshot()).toEqual({ subscribers: 'v2' });
    expect(http.calls.map((call) => call.path)).toEqual(['/v1/ns/service/subscribers']);
  });

  /**
   * The catalog fallback is the driver's own business, and this is what that
   * buys: a 2.x server whose catalog is missing still has `services` served
   * by v2, so the v1 driver is never tried and the resolver's cache is not
   * taught a flavor decision that had nothing to do with the version.
   */
  it('keeps the catalog fallback inside one driver, out of the capability cache', async () => {
    const http = recordingHttp((path) => {
      if (path === '/v1/ns/catalog/services') {
        // What `/v1/ns/**` really answers for a path it has no controller
        // for: 501 no-such-api, which is not even a fall-through kind.
        throw new NacosApiError('api-error', 'no such api', 501);
      }
      return { code: 0, data: { count: 1, services: ['order-service'] } };
    });
    const resolver = new NacosCapabilityResolver(buildDriverChain(2, http.client, undefined));

    const page = await new NacosClient(resolver, serverState(2)).listServices({
      namespaceId: 'uat',
      pageNo: 1,
      pageSize: 100
    });

    expect(page.items.map((item) => item.serviceName)).toEqual(['order-service']);
    expect(resolver.snapshot()).toEqual({ services: 'v2' });
    expect(http.calls.map((call) => call.path)).toEqual(['/v1/ns/catalog/services', '/v2/ns/service/list']);
  });

  /**
   * The console API has no metrics endpoint, so the 3.x chain has to walk
   * past it -- and it does so without spending a request on finding out.
   */
  it('walks past the console driver for metrics, which the console API does not serve', async () => {
    const http = recordingHttp((path) => {
      if (path.startsWith('/v3/admin')) {
        throw new NacosApiError('forbidden', 'not an administrator', 403);
      }
      return { code: 0, data: { status: 'UP', serviceCount: 13 } };
    });
    const resolver = new NacosCapabilityResolver(buildDriverChain(3, http.client, CONSOLE_BASE_URL));

    await expect(new NacosClient(resolver, serverState(3)).getServerMetrics()).resolves.toMatchObject({ status: 'UP' });
    expect(resolver.snapshot()).toEqual({ 'server-metrics': 'v2' });
    expect(http.calls.map((call) => call.path)).toEqual(['/v3/admin/ns/ops/metrics', '/v2/ns/operator/metrics']);
  });

  /**
   * The reason `resource-not-found` exists. Asking for a dataId nobody
   * published used to walk every driver in the chain and end in "No Nacos API
   * flavor could serve ...", which names the wrong problem entirely.
   */
  it('reports a missing config without walking the rest of the chain', async () => {
    const tried: string[] = [];
    const chain = buildDriverChain(3, missingConfigHttp(tried), CONSOLE_BASE_URL);
    const client = new NacosClient(new NacosCapabilityResolver(chain), serverState(3));

    const error = await client
      .getConfig({ namespaceId: 'uat', group: 'g', dataId: 'nope.yml' })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(NacosApiError);
    expect((error as NacosApiError).kind).toBe('resource-not-found');
    expect(tried).toHaveLength(1);
  });
});

/** Answers every config fetch the way a real Nacos answers a dataId nobody published. */
function missingConfigHttp(tried: string[]): Pick<NacosHttpClient, 'requestJson' | 'requestRaw'> {
  return {
    requestJson: <T,>(): Promise<T> => Promise.reject(new NacosApiError('not-found', 'no endpoint', 404)),
    requestRaw: (_method: string, path: string) => {
      tried.push(path);
      return Promise.resolve({
        status: 404,
        ok: false,
        text: 'config data not exist',
        contentType: 'application/json;charset=UTF-8'
      });
    }
  };
}

/** A driver whose unexercised capabilities reject rather than resolve to a shape nobody supplied. */
function stubDriver(flavor: NacosApiFlavor): NacosDriver {
  const unused = (): never => {
    throw new Error(`${flavor}: this capability was not part of the test`);
  };
  return {
    flavor,
    listNamespaces: unused,
    listConfigs: unused,
    getConfig: unused,
    listServices: unused,
    listInstances: unused,
    listClusterNodes: unused,
    getServerMetrics: unused,
    listConfigHistory: unused,
    getConfigHistory: unused,
    listConfigListeners: unused,
    getService: unused,
    listSubscribers: unused
  };
}
