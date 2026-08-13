import { describe, expect, it, vi } from 'vitest';
import { NacosApiError } from '../../src/nacos/NacosApiError';
import { NacosCapabilityResolver } from '../../src/nacos/NacosCapabilityResolver';
import { buildDriverChain, NacosClient } from '../../src/nacos/NacosClient';
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
  client: Pick<NacosHttpClient, 'requestJson'>;
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
    const driver: NacosDriver = { flavor: 'v1', listNamespaces };
    const client = new NacosClient(new NacosCapabilityResolver([driver]), serverState(1));

    await client.listNamespaces();
    await client.listNamespaces();
    expect(listNamespaces).toHaveBeenCalledTimes(2);
  });
});
