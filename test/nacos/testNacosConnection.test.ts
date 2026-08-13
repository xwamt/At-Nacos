import { afterEach, describe, expect, it, vi } from 'vitest';
import { NacosApiError } from '../../src/nacos/NacosApiError';
import type { NacosServerState } from '../../src/nacos/probe/probeServerState';
import {
  testNacosConnection,
  type NacosConnectionTestFailure,
  type NacosConnectionTestResult,
  type NacosConnectionTestSuccess
} from '../../src/nacos/testNacosConnection';
import { startTestHttpServer, type TestHttpServer, type TestRequestHandler } from './testHttpServer';

let server: TestHttpServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('testNacosConnection', () => {
  it('reports the detected version and startup mode on success', async () => {
    const result = await testNacosConnection({
      serverUrl: 'http://h:8848/nacos',
      authMode: 'none',
      probe: async () => ({
        version: '2.2.3',
        majorVersion: 2,
        startupMode: 'standalone' as const,
        authEnabled: false,
        raw: {}
      })
    });
    expect(result).toMatchObject({ ok: true, version: '2.2.3', startupMode: 'standalone' });
  });

  it('classifies a 403 as an auth failure with an actionable message', async () => {
    const result = await testNacosConnection({
      serverUrl: 'http://h:8848/nacos',
      authMode: 'userPassword',
      probe: async () => {
        throw new NacosApiError('forbidden', 'denied', 403);
      }
    });
    expect(result).toMatchObject({ ok: false, reason: 'auth' });
    expect(result.message).toMatch(/credential|permission/i);
  });
});

describe('testNacosConnection success', () => {
  it('reports the base URL that answered, not the one that was typed', async () => {
    const probe = recordingProbe((baseUrl) => {
      if (baseUrl.endsWith('/nacos')) {
        throw new NacosApiError('not-found', 'no such endpoint', 404);
      }
      return state({ version: '1.4.6', majorVersion: 1 });
    });
    const result = expectSuccess(
      await testNacosConnection({ serverUrl: 'http://h:8848', authMode: 'none', probe: probe.probe })
    );
    expect(result.baseUrl).toBe('http://h:8848');
    expect(result).toMatchObject({ version: '1.4.6', majorVersion: 1, authEnabled: false });
  });

  it('stops at the first candidate that answers', async () => {
    const probe = recordingProbe(() => state());
    await testNacosConnection({ serverUrl: 'http://h:8848', authMode: 'none', probe: probe.probe });
    expect(probe.baseUrls).toEqual(['http://h:8848/nacos']);
  });

  it('names the version and the startup mode in the message', async () => {
    const result = expectSuccess(
      await testNacosConnection({
        serverUrl: 'http://h:8848/nacos',
        authMode: 'none',
        probe: async () => state({ startupMode: 'cluster' })
      })
    );
    expect(result.message).toMatch(/2\.2\.3/);
    expect(result.message).toMatch(/cluster/i);
  });

  /** `startupMode: 'unknown'` is what a version we cannot read the key of reports. */
  it('says the startup mode was not reported rather than inventing one', async () => {
    const result = expectSuccess(
      await testNacosConnection({
        serverUrl: 'http://h:8848/nacos',
        authMode: 'none',
        probe: async () => state({ startupMode: 'unknown' })
      })
    );
    expect(result.startupMode).toBe('unknown');
    expect(result.message).not.toMatch(/standalone|cluster/i);
    expect(result.message).toMatch(/not report/i);
  });

  it('reports that the server has authentication enabled', async () => {
    const result = expectSuccess(
      await testNacosConnection({
        serverUrl: 'http://h:8848/nacos',
        authMode: 'none',
        probe: async () => state({ authEnabled: true })
      })
    );
    expect(result.authEnabled).toBe(true);
  });
});

describe('testNacosConnection failure classification', () => {
  it('blames the username and password for a 403 in userPassword mode', async () => {
    const result = expectFailure(await failWith(new NacosApiError('forbidden', 'denied', 403), 'userPassword'));
    expect(result).toMatchObject({ reason: 'auth', kind: 'forbidden', status: 403 });
    expect(result.message).toMatch(/username and password/i);
  });

  /** A 403 while sending nothing means the server wants credentials the form has not been given. */
  it('tells an unauthenticated connection to configure authentication when it is refused', async () => {
    const result = expectFailure(await failWith(new NacosApiError('forbidden', 'denied', 403), 'none'));
    expect(result.reason).toBe('auth');
    expect(result.message).toMatch(/authentication/i);
    expect(result.message).not.toMatch(/username and password are wrong/i);
  });

  it('blames the custom headers for a 403 in customHeader mode', async () => {
    const result = expectFailure(await failWith(new NacosApiError('forbidden', 'denied', 403), 'customHeader'));
    expect(result.reason).toBe('auth');
    expect(result.message).toMatch(/custom header/i);
  });

  /**
   * Nacos never answers 401, so the fix is at the proxy and never in the Nacos
   * username and password. Sharing the `auth` reason would point the form at
   * the wrong fields.
   */
  it('separates a gateway 401 from a Nacos credential failure', async () => {
    const result = expectFailure(await failWith(new NacosApiError('gateway-auth', 'unauthorized', 401), 'userPassword'));
    expect(result).toMatchObject({ reason: 'gateway', kind: 'gateway-auth', status: 401 });
    expect(result.message).toMatch(/proxy|gateway/i);
    expect(result.message).toMatch(/custom header/i);
  });

  it('names the certificate for a TLS failure', async () => {
    const result = expectFailure(
      await failWith(new NacosApiError('tls', 'certificate has expired'), 'none', 'https://nacos.example.com/nacos')
    );
    expect(result).toMatchObject({ reason: 'tls', kind: 'tls' });
    expect(result.message).toMatch(/certificate/i);
    expect(result.message).toContain('nacos.example.com');
  });

  it('names the host and port for a network failure', async () => {
    const result = expectFailure(await failWith(new NacosApiError('network', 'connect ECONNREFUSED'), 'none'));
    expect(result).toMatchObject({ reason: 'network', kind: 'network' });
    expect(result.message).toContain('h:8848');
    expect(result.message).toMatch(/reach/i);
  });

  it('blames the context path when every candidate answers 404', async () => {
    const result = expectFailure(
      await failWith(new NacosApiError('not-found', 'no endpoint', 404), 'none', 'http://h:8848')
    );
    expect(result).toMatchObject({ reason: 'address', kind: 'not-found' });
    expect(result.message).toMatch(/context path/i);
    expect(result.message).toContain('http://h:8848/nacos');
    expect(result.message).toContain('http://h:8848');
    expect(result.triedBaseUrls).toEqual(['http://h:8848/nacos', 'http://h:8848']);
  });

  /** Task 6 reclassifies an OIDC deployment's refusal here; its wording is already the fix. */
  it('passes a validation refusal through as an instance-settings problem', async () => {
    const message =
      'This Nacos server uses an external identity provider (OIDC/LDAP plugin) and does not accept username/password login. Switch the instance to "Custom headers" and paste a bearer token issued by your IdP.';
    const result = expectFailure(await failWith(new NacosApiError('validation', message), 'userPassword'));
    expect(result).toMatchObject({ reason: 'config', kind: 'validation' });
    expect(result.message).toBe(message);
  });

  it('blames the address when something answers that is not a Nacos API', async () => {
    const result = expectFailure(
      await failWith(new NacosApiError('invalid-response', 'Nacos returned a non-JSON response for /nacos'), 'none')
    );
    expect(result).toMatchObject({ reason: 'address', kind: 'invalid-response' });
    expect(result.message).toMatch(/not.*Nacos API response/i);
    expect(result.message).toMatch(/proxy|single-page|web server/i);
  });

  it('points a 500 at the Nacos server log rather than at the form', async () => {
    const upstream = 'Nacos returned HTTP 500 for /nacos/v3/admin/core/state: connection pool exhausted';
    const result = expectFailure(await failWith(new NacosApiError('api-error', upstream, 500), 'none'));
    expect(result).toMatchObject({ reason: 'error', kind: 'api-error', status: 500 });
    expect(result.message).toMatch(/server log/i);
    expect(result.message).toContain('connection pool exhausted');
    expect(result.message).toContain('500');
  });

  it('names the compatibility switch for a 410', async () => {
    const result = expectFailure(await failWith(new NacosApiError('api-deprecated', 'gone', 410), 'none'));
    expect(result).toMatchObject({ reason: 'error', kind: 'api-deprecated', status: 410 });
    expect(result.message).toMatch(/compatibility/i);
  });

  /**
   * The state probe asks for an endpoint, never for a resource, so this kind
   * should not reach the connection test at all. It is in the kind union now
   * that config lookups can raise it, and a kind with no branch here returns
   * undefined and takes the whole result down -- so the branch exists and is
   * pinned rather than left to the next widening of the union.
   */
  it('reports a resource-not-found from the probe as a server-side failure instead of crashing', async () => {
    const upstream = 'Nacos has no such resource at /nacos/v1/cs/configs (HTTP 404): config data not exist';
    const result = expectFailure(await failWith(new NacosApiError('resource-not-found', upstream, 404), 'none'));
    expect(result).toMatchObject({ reason: 'error', kind: 'resource-not-found', status: 404 });
    expect(result.message).toContain('config data not exist');
  });

  it('resolves rather than throwing when the probe fails with an unclassified error', async () => {
    const result = expectFailure(await failWith(new Error('AK/SK authentication is not implemented yet.'), 'akSk'));
    expect(result.reason).toBe('error');
    expect(result.kind).toBeUndefined();
    expect(result.message).toContain('AK/SK authentication is not implemented yet.');
  });

  it('rejects an unparseable server URL without opening a connection', async () => {
    const probe = recordingProbe(() => state());
    const result = expectFailure(
      await testNacosConnection({ serverUrl: 'not a url', authMode: 'none', probe: probe.probe })
    );
    expect(result).toMatchObject({ reason: 'address', kind: 'validation', triedBaseUrls: [] });
    expect(result.message).toMatch(/not a valid url/i);
    expect(probe.baseUrls).toEqual([]);
  });

  /** The address may carry userinfo, and this message reaches the output channel. */
  it('does not echo a rejected address that may carry a password', async () => {
    const result = expectFailure(
      await testNacosConnection({
        serverUrl: 'http://admin:hunter2@ho st:8848',
        authMode: 'none',
        probe: async () => state()
      })
    );
    expect(result.message).not.toContain('hunter2');
  });
});

describe('testNacosConnection candidate walk', () => {
  it('tries the bare origin after /nacos answers 404', async () => {
    const probe = recordingProbe(() => {
      throw new NacosApiError('not-found', 'no endpoint', 404);
    });
    await testNacosConnection({ serverUrl: 'http://h:8848', authMode: 'none', probe: probe.probe });
    expect(probe.baseUrls).toEqual(['http://h:8848/nacos', 'http://h:8848']);
  });

  /**
   * Both candidates share a host and port, so an unreachable host fails
   * identically on the second -- at the cost of a second full timeout.
   */
  it('does not spend a second timeout on the bare origin after a network failure', async () => {
    const probe = recordingProbe(() => {
      throw new NacosApiError('network', 'connect ETIMEDOUT');
    });
    await testNacosConnection({ serverUrl: 'http://h:8848', authMode: 'none', probe: probe.probe });
    expect(probe.baseUrls).toEqual(['http://h:8848/nacos']);
  });

  it('does not retry the bare origin after an untrusted certificate', async () => {
    const probe = recordingProbe(() => {
      throw new NacosApiError('tls', 'self signed certificate');
    });
    await testNacosConnection({ serverUrl: 'https://h:8848', authMode: 'none', probe: probe.probe });
    expect(probe.baseUrls).toEqual(['https://h:8848/nacos']);
  });

  /**
   * A second candidate costs a second failed login, which is what an account
   * lockout policy counts. The 403 already proves a Nacos answered.
   */
  it('stops after a 403 rather than spending a second failed login', async () => {
    const probe = recordingProbe(() => {
      throw new NacosApiError('forbidden', 'denied', 403);
    });
    const result = expectFailure(
      await testNacosConnection({ serverUrl: 'http://h:8848', authMode: 'userPassword', probe: probe.probe })
    );
    expect(probe.baseUrls).toEqual(['http://h:8848/nacos']);
    expect(result.reason).toBe('auth');
  });

  /** "Something answered that is not Nacos" outranks "nothing is there". */
  it('reports the more specific failure when the candidates fail differently', async () => {
    const probe = recordingProbe((baseUrl) => {
      if (baseUrl.endsWith('/nacos')) {
        throw new NacosApiError('invalid-response', 'non-JSON response');
      }
      throw new NacosApiError('not-found', 'no endpoint', 404);
    });
    const result = expectFailure(
      await testNacosConnection({ serverUrl: 'http://h:8848', authMode: 'none', probe: probe.probe })
    );
    expect(probe.baseUrls).toEqual(['http://h:8848/nacos', 'http://h:8848']);
    expect(result.kind).toBe('invalid-response');
    expect(result.triedBaseUrls).toEqual(['http://h:8848/nacos', 'http://h:8848']);
  });
});

describe('testNacosConnection console discovery', () => {
  it('composes the console URL from the host that answered', async () => {
    const result = expectSuccess(
      await testNacosConnection({
        serverUrl: 'http://h:8848/nacos',
        authMode: 'none',
        probe: async () => state({ version: '3.0.1', majorVersion: 3 }),
        consoleHint: async () => ({ port: 8080, path: '/' })
      })
    );
    expect(result.consoleUrl).toBe('http://h:8080');
  });

  it('keeps a console path other than the root', async () => {
    const result = expectSuccess(
      await testNacosConnection({
        serverUrl: 'https://nacos.example.com/nacos',
        authMode: 'none',
        probe: async () => state({ version: '3.1.0', majorVersion: 3 }),
        consoleHint: async () => ({ port: 8080, path: '/console' })
      })
    );
    expect(result.consoleUrl).toBe('https://nacos.example.com:8080/console');
  });

  it('still succeeds when a 3.x server does not answer with a hint', async () => {
    const result = expectSuccess(
      await testNacosConnection({
        serverUrl: 'http://h:8848/nacos',
        authMode: 'none',
        probe: async () => state({ version: '3.0.1', majorVersion: 3 }),
        consoleHint: async () => undefined
      })
    );
    expect(result.ok).toBe(true);
    expect(result.consoleUrl).toBeUndefined();
  });

  it('never asks a 2.x server where its console is', async () => {
    const consoleHint = vi.fn(async () => ({ port: 8080, path: '/' }));
    const result = expectSuccess(
      await testNacosConnection({
        serverUrl: 'http://h:8848/nacos',
        authMode: 'none',
        probe: async () => state(),
        consoleHint
      })
    );
    expect(consoleHint).not.toHaveBeenCalled();
    expect(result.consoleUrl).toBeUndefined();
  });

  it('passes a console URL the user supplied through without asking', async () => {
    const consoleHint = vi.fn(async () => ({ port: 8080, path: '/' }));
    const result = expectSuccess(
      await testNacosConnection({
        serverUrl: 'http://h:8848/nacos',
        consoleUrl: 'http://console.example.com:9090',
        authMode: 'none',
        probe: async () => state({ version: '3.0.1', majorVersion: 3 }),
        consoleHint
      })
    );
    expect(consoleHint).not.toHaveBeenCalled();
    expect(result.consoleUrl).toBe('http://console.example.com:9090');
  });
});

/**
 * The failure sentence is rendered into the Webview, so an address the user
 * typed with a password in it would be shown back to them -- and it is the
 * candidate list, not the raw input, that these sentences are built from.
 */
describe('testNacosConnection credentials in the address', () => {
  it('names no credential in the failure message or the candidates it reports', async () => {
    const result = await testNacosConnection({
      serverUrl: 'http://admin:hunter2@h:8848/nacos',
      authMode: 'none',
      probe: async () => {
        throw new NacosApiError('forbidden', 'denied', 403);
      }
    });

    expect(result.ok).toBe(false);
    expect(result.message).not.toContain('hunter2');
    expect(result.message).toContain('http://h:8848/nacos');
    expect((result as NacosConnectionTestFailure).triedBaseUrls).toEqual(['http://h:8848/nacos']);
  });

  it('reports the same stripped address for a username-only userinfo', async () => {
    const result = await testNacosConnection({
      serverUrl: 'http://admin@h:8848/nacos',
      authMode: 'none',
      probe: async () => {
        throw new NacosApiError('not-found', 'missing', 404);
      }
    });

    expect(result.message).not.toContain('admin');
    expect((result as NacosConnectionTestFailure).triedBaseUrls).toEqual(['http://h:8848/nacos']);
  });

  it('reports a stripped base URL on success, since that is what the form saves', async () => {
    const result = await testNacosConnection({
      serverUrl: 'http://admin:hunter2@h:8848/nacos',
      authMode: 'none',
      probe: async () => ({
        version: '2.2.3',
        majorVersion: 2,
        startupMode: 'standalone' as const,
        authEnabled: false,
        raw: {}
      })
    });

    expect(result).toMatchObject({ ok: true, baseUrl: 'http://h:8848/nacos' });
  });
});

describe('testNacosConnection against a real server', () => {
  it('reads the version from a real /v1/console/server/state body', async () => {
    server = await startTestHttpServer(nacos2(STATE_2_2_3));
    const result = expectSuccess(
      await testNacosConnection({ serverUrl: `${server.origin}/nacos`, authMode: 'none' })
    );
    expect(result).toMatchObject({ version: '2.2.3', majorVersion: 2, startupMode: 'standalone' });
    expect(urls()).toContain('/nacos/v1/console/server/state');
  });

  /**
   * A base URL carrying a query string resolves relative paths against the
   * origin instead of the context path, so the request would silently land on
   * `/v1/...` and 404.
   */
  it('keeps the context path when the address carries a query string', async () => {
    server = await startTestHttpServer(nacos2(STATE_2_2_3));
    const result = expectSuccess(
      await testNacosConnection({ serverUrl: `${server.origin}/nacos?x=1`, authMode: 'none' })
    );
    expect(result.version).toBe('2.2.3');
    expect(result.baseUrl).toBe(`${server.origin}/nacos`);
    expect(urls()).toContain('/nacos/v1/console/server/state');
  });

  /** Copying the console URL out of a browser address bar produces exactly this. */
  it('keeps the context path when the address carries a fragment', async () => {
    server = await startTestHttpServer(nacos2(STATE_2_2_3));
    const result = expectSuccess(
      await testNacosConnection({ serverUrl: `${server.origin}/nacos/#/login`, authMode: 'none' })
    );
    expect(result.version).toBe('2.2.3');
    expect(result.baseUrl).toBe(`${server.origin}/nacos`);
    expect(urls()).toContain('/nacos/v1/console/server/state');
  });

  it('logs in and sends the token it was given', async () => {
    server = await startTestHttpServer(authenticatedNacos2('nacos', 'correct-horse'));
    const result = expectSuccess(
      await testNacosConnection({
        serverUrl: `${server.origin}/nacos`,
        authMode: 'userPassword',
        username: 'nacos',
        password: 'correct-horse'
      })
    );
    expect(result.version).toBe('2.2.3');
    const stateRequest = server.requests.find((request) => request.url === '/nacos/v1/console/server/state');
    expect(stateRequest?.headers.authorization).toBe('Bearer test-token');
    // The v3 state path 404s before the v1 one answers, and both carry the
    // token: two requests must not mean two logins.
    expect(urls().filter((url) => url.includes('/auth/'))).toHaveLength(1);
  });

  it('reports a rejected login as an auth failure after exactly one login attempt', async () => {
    server = await startTestHttpServer(authenticatedNacos2('nacos', 'correct-horse'));
    const result = expectFailure(
      await testNacosConnection({
        serverUrl: server.origin,
        authMode: 'userPassword',
        username: 'nacos',
        password: 'wrong'
      })
    );
    expect(result.reason).toBe('auth');
    expect(urls().filter((url) => url.includes('/auth/'))).toEqual(['/nacos/v3/auth/user/login']);
  });

  it('sends the custom headers it was given', async () => {
    server = await startTestHttpServer(nacos2(STATE_2_2_3));
    expectSuccess(
      await testNacosConnection({
        serverUrl: `${server.origin}/nacos`,
        authMode: 'customHeader',
        customHeaders: { 'x-gateway-token': 'let-me-in' }
      })
    );
    const stateRequest = server.requests.find((request) => request.url === '/nacos/v1/console/server/state');
    expect(stateRequest?.headers['x-gateway-token']).toBe('let-me-in');
  });

  it('reports a closed port as a network failure', async () => {
    const result = expectFailure(await testNacosConnection({ serverUrl: 'http://127.0.0.1:1/nacos', authMode: 'none' }));
    expect(result.reason).toBe('network');
    expect(result.message).toContain('127.0.0.1:1');
  });

  it('discovers where a real 3.x server keeps its console', async () => {
    server = await startTestHttpServer((request, response) => {
      if (request.url === '/nacos/v3/admin/core/state') {
        respondJson(response, { code: 0, message: 'success', data: { version: '3.0.1', startup_mode: 'cluster' } });
        return;
      }
      if (request.url === '/nacos/') {
        response.setHeader('content-type', 'text/plain');
        response.end('Nacos Console default port is 8080, and the path is /.');
        return;
      }
      respondJson(response, { status: 404 }, 404);
    });
    const result = expectSuccess(
      await testNacosConnection({ serverUrl: `${server.origin}/nacos`, authMode: 'none' })
    );
    expect(result).toMatchObject({ version: '3.0.1', majorVersion: 3, startupMode: 'cluster' });
    expect(result.consoleUrl).toBe(`${server.origin.replace(/:\d+$/, '')}:8080`);
  });

  it('never asks a real 2.x server where its console is', async () => {
    server = await startTestHttpServer(nacos2(STATE_2_2_3));
    expectSuccess(await testNacosConnection({ serverUrl: `${server.origin}/nacos`, authMode: 'none' }));
    expect(urls()).not.toContain('/nacos/');
  });
});

/** The 2.2.3 response verbatim, including the null that 2.x still emits. */
const STATE_2_2_3 = { standalone_mode: 'standalone', function_mode: null, version: '2.2.3' };

function state(overrides: Partial<NacosServerState> = {}): NacosServerState {
  return { version: '2.2.3', majorVersion: 2, startupMode: 'standalone', authEnabled: false, raw: {}, ...overrides };
}

interface ProbeRecorder {
  baseUrls: string[];
  probe: (context: { baseUrl: string }) => Promise<NacosServerState>;
}

function recordingProbe(respond: (baseUrl: string) => NacosServerState): ProbeRecorder {
  const baseUrls: string[] = [];
  return {
    baseUrls,
    probe: async ({ baseUrl }) => {
      baseUrls.push(baseUrl);
      return respond(baseUrl);
    }
  };
}

function failWith(
  error: unknown,
  authMode: 'none' | 'userPassword' | 'customHeader' | 'akSk',
  serverUrl = 'http://h:8848/nacos'
): Promise<NacosConnectionTestResult> {
  return testNacosConnection({
    serverUrl,
    authMode,
    probe: async () => {
      throw error;
    }
  });
}

function expectSuccess(result: NacosConnectionTestResult): NacosConnectionTestSuccess {
  if (!result.ok) {
    throw new Error(`Expected a successful connection test, got ${result.reason}: ${result.message}`);
  }
  return result;
}

function expectFailure(result: NacosConnectionTestResult): NacosConnectionTestFailure {
  if (result.ok) {
    throw new Error(`Expected a failed connection test, got: ${result.message}`);
  }
  return result;
}

/** Request paths with the query string dropped, which is where the username rides on login. */
function urls(): string[] {
  return (server?.requests ?? []).map((request) => request.url.split('?')[0]);
}

/** Answers the v1 state path only, the way a 2.x server without the v3 admin API does. */
function nacos2(body: Record<string, unknown>): TestRequestHandler {
  return (request, response) => {
    if (request.url === '/nacos/v1/console/server/state') {
      respondJson(response, body);
      return;
    }
    respondJson(response, { status: 404, message: 'Not Found' }, 404);
  };
}

function authenticatedNacos2(username: string, password: string): TestRequestHandler {
  return (request, response, body) => {
    const url = request.url ?? '';
    if (url.startsWith('/nacos/v3/auth/user/login')) {
      const sent = new URLSearchParams(body).get('password');
      if (url.includes(`username=${username}`) && sent === password) {
        respondJson(response, { accessToken: 'test-token', tokenTtl: 18_000 });
        return;
      }
      respondJson(response, { status: 403, message: 'user not found!' }, 403);
      return;
    }
    if (url === '/nacos/v1/console/server/state' && request.headers.authorization === 'Bearer test-token') {
      respondJson(response, STATE_2_2_3);
      return;
    }
    respondJson(response, { status: 404, message: 'Not Found' }, 404);
  };
}

function respondJson(response: Parameters<TestRequestHandler>[1], body: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}
