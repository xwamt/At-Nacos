import { describe, expect, it } from 'vitest';
import { NacosApiError } from '../../../src/nacos/NacosApiError';
import type { NacosHttpClient } from '../../../src/nacos/NacosHttpClient';
import { parseServerState, probeServerState } from '../../../src/nacos/probe/probeServerState';

interface FakeHttp {
  calls: { method: string; path: string }[];
  paths: string[];
  client: Pick<NacosHttpClient, 'requestJson'>;
}

/**
 * `requestJson` is generic, so a responder returning a concrete shape is not
 * assignable to it without a cast. Doing the cast once here keeps every test
 * below typed against the real `Pick<NacosHttpClient, 'requestJson'>`.
 */
function fakeHttp(respond: (path: string) => unknown): FakeHttp {
  const calls: { method: string; path: string }[] = [];
  return {
    calls,
    get paths() {
      return calls.map((call) => call.path);
    },
    client: {
      async requestJson<T>(method: string, path: string): Promise<T> {
        calls.push({ method, path });
        return (await respond(path)) as T;
      }
    }
  };
}

/** The 2.5.2 response verbatim, including the null that 2.x still emits. */
const REAL_2_5_2_STATE = {
  auth_system_type: 'nacos',
  auth_enabled: 'false',
  version: '2.5.2',
  startup_mode: 'cluster',
  server_port: '8848',
  datasource_platform: 'mysql',
  console_ui_enabled: 'true',
  config_retention_days: '30',
  defaultMaxSize: '102400',
  function_mode: null,
  login_page_enabled: 'false',
  auth_admin_request: 'false',
  election_timeout_ms: '5000',
  data_sync_delayMs: '1000'
};

describe('parseServerState', () => {
  it('reads a Nacos 2.x bare map', () => {
    const state = parseServerState({
      version: '2.2.3',
      auth_enabled: 'true',
      standalone_mode: 'standalone'
    });
    expect(state).toMatchObject({ version: '2.2.3', majorVersion: 2, authEnabled: true, startupMode: 'standalone' });
  });

  it('reads startup_mode as well as standalone_mode because 2.5 renamed the key', () => {
    expect(parseServerState({ version: '2.5.2', startup_mode: 'cluster' }).startupMode).toBe('cluster');
  });

  it('unwraps a Result-wrapped 3.x response', () => {
    const state = parseServerState({ code: 0, message: 'success', data: { version: '3.2.3' } });
    expect(state.version).toBe('3.2.3');
    expect(state.majorVersion).toBe(3);
  });

  it('reads a bare 3.x response because the docs and source disagree on wrapping', () => {
    expect(parseServerState({ version: '3.2.3', startup_mode: 'standalone' }).majorVersion).toBe(3);
  });

  it('treats auth_enabled as a string, not a boolean', () => {
    expect(parseServerState({ version: '2.2.3', auth_enabled: 'false' }).authEnabled).toBe(false);
    expect(parseServerState({ version: '2.2.3' }).authEnabled).toBe(false);
  });

  it('rejects a payload with no version anywhere', () => {
    expect(() => parseServerState({ hello: 'world' })).toThrow();
  });

  it('classifies a versionless payload as invalid-response so the caller can fall through', () => {
    const error = catchError(() => parseServerState({ hello: 'world' }));
    expect(error).toBeInstanceOf(NacosApiError);
    expect((error as NacosApiError).kind).toBe('invalid-response');
  });

  it('rejects a payload that is not an object at all', () => {
    expect(() => parseServerState('Nacos is starting up')).toThrow(NacosApiError);
    expect(() => parseServerState(null)).toThrow(NacosApiError);
    expect(() => parseServerState([{ version: '2.2.3' }])).toThrow(NacosApiError);
  });

  it('rejects an empty version string', () => {
    expect(() => parseServerState({ version: '' })).toThrow(NacosApiError);
  });

  it('accepts a version with no dots', () => {
    expect(parseServerState({ version: '3' }).majorVersion).toBe(3);
  });

  it('rejects a version string with no leading number', () => {
    const error = catchError(() => parseServerState({ version: 'not-a-version' }));
    expect((error as NacosApiError).kind).toBe('invalid-response');
    expect((error as NacosApiError).message).toContain('not-a-version');
  });

  /**
   * The digit prefix is the best signal available, and a wrong guess is
   * survivable: the driver chain falls through on 404/410, so it costs a round
   * trip. Refusing the server outright would not be survivable.
   */
  it('keeps the leading digits of a version string carrying a suffix', () => {
    expect(parseServerState({ version: '3abc' }).majorVersion).toBe(3);
    expect(parseServerState({ version: '2.2.3-SNAPSHOT' }).majorVersion).toBe(2);
  });

  it('falls back to the top level when data carries no version', () => {
    const state = parseServerState({ code: 0, version: '2.2.3', data: { unrelated: 'x' } });
    expect(state.version).toBe('2.2.3');
  });

  it('rejects a wrapper whose data is an empty object and whose top level has no version', () => {
    expect(() => parseServerState({ code: 0, message: 'success', data: {} })).toThrow(NacosApiError);
  });

  /**
   * `data` wins: the wrapped shape is what the 3.x source produces, so a
   * top-level `version` sitting next to a state-carrying `data` is an
   * envelope's own field (a gateway's), not the server's.
   */
  it('prefers data.version over a top-level version when both exist', () => {
    const state = parseServerState({ version: '1.0', data: { version: '3.2.3', startup_mode: 'cluster' } });
    expect(state.version).toBe('3.2.3');
    expect(state.startupMode).toBe('cluster');
    expect(state.raw.version).toBe('3.2.3');
  });

  /** The rename went standalone_mode -> startup_mode, so the newer key is the maintained one. */
  it('prefers startup_mode when both keys are present and disagree', () => {
    expect(parseServerState({ version: '2.5.2', startup_mode: 'cluster', standalone_mode: 'standalone' }).startupMode)
      .toBe('cluster');
  });

  it('reports an unrecognized startup mode as unknown rather than throwing', () => {
    expect(parseServerState({ version: '2.2.3', startup_mode: 'brand-new-mode' }).startupMode).toBe('unknown');
    expect(parseServerState({ version: '2.2.3' }).startupMode).toBe('unknown');
  });

  it('carries the whole state map through as raw, dropping the non-string values', () => {
    const state = parseServerState(REAL_2_5_2_STATE);
    expect(state).toMatchObject({ version: '2.5.2', majorVersion: 2, startupMode: 'cluster', authEnabled: false });
    expect(state.raw.server_port).toBe('8848');
    expect(state.raw.console_ui_enabled).toBe('true');
    expect(state.raw.datasource_platform).toBe('mysql');
    expect(state.raw).not.toHaveProperty('function_mode');
  });

  it('carries the unwrapped map through as raw for a 3.x wrapper, not the envelope', () => {
    const state = parseServerState({ code: 0, message: 'success', data: { version: '3.2.3', server_port: '8848' } });
    expect(state.raw).toEqual({ version: '3.2.3', server_port: '8848' });
  });
});

describe('probeServerState', () => {
  it('prefers the v3 admin state endpoint', async () => {
    const http = fakeHttp(() => ({ code: 0, data: { version: '3.2.3' } }));
    const state = await probeServerState(http.client);
    expect(http.paths[0]).toBe('/v3/admin/core/state');
    expect(http.calls[0]?.method).toBe('GET');
    expect(state.majorVersion).toBe(3);
  });

  it('falls back to the v1 console state endpoint when v3 is missing', async () => {
    const http = fakeHttp((path) => {
      if (path === '/v3/admin/core/state') {
        throw new NacosApiError('not-found', 'no v3', 404);
      }
      return { version: '2.2.3' };
    });
    const state = await probeServerState(http.client);
    expect(http.paths).toEqual(['/v3/admin/core/state', '/v1/console/server/state']);
    expect(state.majorVersion).toBe(2);
  });

  /**
   * The first v3 failure has to be one that falls through, or v1 is never
   * reached and the 410 branch cannot fire. `invalid-response` is the one
   * fall-through kind that is also plausibly transient (a garbled body from a
   * flaky proxy), which is what makes a second v3 attempt worth its round trip.
   */
  it('retries v3 when the v1 endpoint answers 410 (3.0/3.1 with console compat off)', async () => {
    let v3Attempts = 0;
    const http = fakeHttp((path) => {
      if (path === '/v3/admin/core/state') {
        v3Attempts += 1;
        if (v3Attempts === 1) {
          throw new NacosApiError('invalid-response', 'truncated body');
        }
        return { code: 0, data: { version: '3.1.2' } };
      }
      throw new NacosApiError('api-deprecated', 'gone', 410);
    });
    const state = await probeServerState(http.client);
    expect(state.version).toBe('3.1.2');
    expect(http.paths).toEqual(['/v3/admin/core/state', '/v1/console/server/state', '/v3/admin/core/state']);
  });

  /**
   * An unreachable or untrusted host answers no path, so walking to v1 would
   * only spend another timeout to be told the same thing.
   */
  it('does not try v1 when v3 fails for a transport reason', async () => {
    for (const kind of ['network', 'tls'] as const) {
      const http = fakeHttp(() => {
        throw new NacosApiError(kind, 'unreachable');
      });
      await expect(probeServerState(http.client)).rejects.toMatchObject({ kind });
      expect(http.paths).toEqual(['/v3/admin/core/state']);
    }
  });

  it('does not try v1 when v3 fails with a server-side error', async () => {
    const http = fakeHttp(() => {
      throw new NacosApiError('api-error', 'boom', 500);
    });
    await expect(probeServerState(http.client)).rejects.toMatchObject({ kind: 'api-error' });
    expect(http.paths).toEqual(['/v3/admin/core/state']);
  });

  /**
   * The reverse-proxy-answers-every-path case: an ingress that rewrites
   * unknown paths to the console SPA makes v3 look like a non-JSON success,
   * and the v1 endpoint underneath it still works.
   */
  it('tries v1 when v3 answers with something that is not a server state', async () => {
    const http = fakeHttp((path) => {
      if (path === '/v3/admin/core/state') {
        throw new NacosApiError('invalid-response', 'Nacos returned a non-JSON response for /v3/admin/core/state.');
      }
      return { version: '2.2.3' };
    });
    const state = await probeServerState(http.client);
    expect(http.paths).toEqual(['/v3/admin/core/state', '/v1/console/server/state']);
    expect(state.version).toBe('2.2.3');
  });

  it('tries v1 when v3 is forbidden, because 1.x/2.x state needs no credential', async () => {
    const http = fakeHttp((path) => {
      if (path === '/v3/admin/core/state') {
        throw new NacosApiError('forbidden', 'denied', 403);
      }
      return { version: '2.2.3' };
    });
    const state = await probeServerState(http.client);
    expect(http.paths).toEqual(['/v3/admin/core/state', '/v1/console/server/state']);
    expect(state.majorVersion).toBe(2);
  });

  /**
   * Reporting only the v1 404 would point at the endpoint least likely to be
   * the problem. Both missing almost always means the context path is wrong.
   */
  it('names both endpoints when neither exists', async () => {
    const http = fakeHttp(() => {
      throw new NacosApiError('not-found', 'no such endpoint', 404);
    });
    const error = await probeServerState(http.client).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NacosApiError);
    expect((error as NacosApiError).kind).toBe('not-found');
    expect((error as NacosApiError).message).toContain('/v3/admin/core/state');
    expect((error as NacosApiError).message).toContain('/v1/console/server/state');
    expect((error as NacosApiError).message).toMatch(/context path/i);
  });

  it('surfaces the v1 failure when only v1 fails in a way of its own', async () => {
    const http = fakeHttp((path) => {
      if (path === '/v3/admin/core/state') {
        throw new NacosApiError('not-found', 'no v3', 404);
      }
      throw new NacosApiError('gateway-auth', 'proxy wants a login', 401);
    });
    await expect(probeServerState(http.client)).rejects.toMatchObject({ kind: 'gateway-auth' });
  });

  it('surfaces the second v3 failure after a 410 rather than looping', async () => {
    const http = fakeHttp((path) => {
      if (path === '/v3/admin/core/state') {
        throw new NacosApiError('forbidden', 'admin API needs a login', 403);
      }
      throw new NacosApiError('api-deprecated', 'gone', 410);
    });
    await expect(probeServerState(http.client)).rejects.toMatchObject({ kind: 'forbidden' });
    expect(http.paths).toEqual(['/v3/admin/core/state', '/v1/console/server/state', '/v3/admin/core/state']);
  });

  it('surfaces an unparseable v1 body instead of probing again', async () => {
    const http = fakeHttp((path) => {
      if (path === '/v3/admin/core/state') {
        throw new NacosApiError('not-found', 'no v3', 404);
      }
      return { hello: 'world' };
    });
    await expect(probeServerState(http.client)).rejects.toMatchObject({ kind: 'invalid-response' });
    expect(http.paths).toEqual(['/v3/admin/core/state', '/v1/console/server/state']);
  });

  it('lets a non-NacosApiError from the transport through untouched', async () => {
    const http = fakeHttp(() => {
      throw new TypeError('programming error');
    });
    await expect(probeServerState(http.client)).rejects.toThrow(TypeError);
    expect(http.paths).toEqual(['/v3/admin/core/state']);
  });
});

function catchError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}
