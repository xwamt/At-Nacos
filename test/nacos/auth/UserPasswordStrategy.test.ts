import { afterEach, describe, expect, it, vi } from 'vitest';
import { NacosApiError } from '../../../src/nacos/NacosApiError';
import { NacosHttpClient } from '../../../src/nacos/NacosHttpClient';
import { UserPasswordStrategy } from '../../../src/nacos/auth/UserPasswordStrategy';
import { startTestHttpServer, type TestHttpServer } from '../testHttpServer';

/** The exact wording Nacos 3.x answers with when an OIDC auth plugin is configured. */
const OIDC_REJECTION =
  "Current Nacos auth plugin type is not 'nacos' or 'nacos-ldap', don't support login API.";

let server: TestHttpServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

function createLoginClient(responses: unknown[]) {
  const calls: { method: string; path: string; options: unknown }[] = [];
  let index = 0;
  return {
    calls,
    async requestJson(method: string, path: string, options: unknown) {
      calls.push({ method, path, options });
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (next instanceof Error) {
        throw next;
      }
      return next;
    }
  };
}

/** A client whose logins stay pending until the test releases them. */
function createDeferredLoginClient() {
  const calls: { method: string; path: string; options: unknown }[] = [];
  const pending: { resolve: (value: unknown) => void; reject: (reason: unknown) => void }[] = [];
  return {
    calls,
    pending,
    async requestJson(method: string, path: string, options: unknown) {
      calls.push({ method, path, options });
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    }
  };
}

function strategyFor(client: { requestJson: unknown }, password = 'hunter2'): UserPasswordStrategy {
  return new UserPasswordStrategy(client as never, () => Promise.resolve({ username: 'nacos', password }));
}

/** Drains the microtask queue so a login in progress has reached the client. */
function flush(): Promise<void> {
  return new Promise((done) => setImmediate(done));
}

describe('UserPasswordStrategy', () => {
  it('logs in against the v3 endpoint first', async () => {
    const client = createLoginClient([{ accessToken: 'tok', tokenTtl: 18000 }]);
    const strategy = new UserPasswordStrategy(client as never, () =>
      Promise.resolve({ username: 'nacos', password: 'hunter2' })
    );
    await strategy.authHeaders();
    expect(client.calls[0]?.path).toBe('/v3/auth/user/login');
  });

  it('falls back to the v1 login endpoint on 404', async () => {
    const client = createLoginClient([
      new NacosApiError('not-found', 'no v3 login', 404),
      { accessToken: 'tok', tokenTtl: 18000 }
    ]);
    const strategy = new UserPasswordStrategy(client as never, () =>
      Promise.resolve({ username: 'nacos', password: 'hunter2' })
    );
    const headers = await strategy.authHeaders();
    expect(client.calls[1]?.path).toBe('/v1/auth/login');
    expect(headers.authorization).toBe('Bearer tok');
  });

  it('sends the username as a query param and the password as a form field', async () => {
    const client = createLoginClient([{ accessToken: 'tok', tokenTtl: 18000 }]);
    const strategy = new UserPasswordStrategy(client as never, () =>
      Promise.resolve({ username: 'nacos', password: 'hunter2' })
    );
    await strategy.authHeaders();
    expect(client.calls[0]?.options).toMatchObject({
      query: { username: 'nacos' },
      form: { password: 'hunter2' }
    });
  });

  it('reuses a cached token instead of logging in on every request', async () => {
    const client = createLoginClient([{ accessToken: 'tok', tokenTtl: 18000 }]);
    const strategy = new UserPasswordStrategy(client as never, () =>
      Promise.resolve({ username: 'nacos', password: 'hunter2' })
    );
    await strategy.authHeaders();
    await strategy.authHeaders();
    expect(client.calls).toHaveLength(1);
  });

  it('re-logs in once the token passes 80% of its advertised ttl', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(0);
    const client = createLoginClient([{ accessToken: 'tok', tokenTtl: 100 }]);
    const strategy = new UserPasswordStrategy(client as never, () =>
      Promise.resolve({ username: 'nacos', password: 'hunter2' })
    );
    await strategy.authHeaders();
    now.mockReturnValue(81_000);
    await strategy.authHeaders();
    expect(client.calls).toHaveLength(2);
    now.mockRestore();
  });

  it('discards the cached token on refresh so the next call re-authenticates', async () => {
    const client = createLoginClient([
      { accessToken: 'tok1', tokenTtl: 18000 },
      { accessToken: 'tok2', tokenTtl: 18000 }
    ]);
    const strategy = new UserPasswordStrategy(client as never, () =>
      Promise.resolve({ username: 'nacos', password: 'hunter2' })
    );
    await strategy.authHeaders();
    expect(await strategy.refresh()).toBe(true);
    expect((await strategy.authHeaders()).authorization).toBe('Bearer tok2');
  });

  it('surfaces an actionable message when the server runs an OIDC auth plugin', async () => {
    const client = createLoginClient([
      new NacosApiError(
        'api-error',
        "Nacos returned code 23000: Current Nacos auth plugin type is not 'nacos' or 'nacos-ldap', don't support login API.",
        200
      )
    ]);
    const strategy = new UserPasswordStrategy(client as never, () =>
      Promise.resolve({ username: 'nacos', password: 'hunter2' })
    );
    await expect(strategy.authHeaders()).rejects.toThrow(/OIDC|external identity provider/i);
  });

  it('falls back to the v1 login endpoint on 501, which is what some reverse proxies answer', async () => {
    const client = createLoginClient([
      new NacosApiError('api-error', 'not implemented', 501),
      { accessToken: 'tok', tokenTtl: 18000 }
    ]);
    const headers = await strategyFor(client).authHeaders();
    expect(client.calls.map((call) => call.path)).toEqual(['/v3/auth/user/login', '/v1/auth/login']);
    expect(headers.authorization).toBe('Bearer tok');
  });

  it('does not retry the v1 endpoint after a 403, which would double the failed-login count', async () => {
    const client = createLoginClient([new NacosApiError('forbidden', 'unknown user!', 403)]);
    await expect(strategyFor(client).authHeaders()).rejects.toMatchObject({ kind: 'forbidden' });
    expect(client.calls).toHaveLength(1);
  });

  it('recognises the OIDC rejection on the v1 fallback path too', async () => {
    const client = createLoginClient([
      new NacosApiError('not-found', 'no v3 login', 404),
      new NacosApiError('api-error', `Nacos returned code 23000 for /v1/auth/login: ${OIDC_REJECTION}`, 200)
    ]);
    await expect(strategyFor(client).authHeaders()).rejects.toThrow(/external identity provider/i);
  });

  it('spends a single login on concurrent first requests', async () => {
    const client = createDeferredLoginClient();
    const strategy = strategyFor(client);
    const headers = Promise.all([strategy.authHeaders(), strategy.authHeaders(), strategy.authHeaders()]);
    await flush();
    expect(client.pending).toHaveLength(1);
    client.pending[0]?.resolve({ accessToken: 'tok', tokenTtl: 18000 });
    expect(await headers).toEqual([
      { authorization: 'Bearer tok' },
      { authorization: 'Bearer tok' },
      { authorization: 'Bearer tok' }
    ]);
    expect(client.calls).toHaveLength(1);
  });

  it('rejects every waiter when a shared login fails', async () => {
    const client = createDeferredLoginClient();
    const strategy = strategyFor(client);
    const attempts = Promise.allSettled([strategy.authHeaders(), strategy.authHeaders(), strategy.authHeaders()]);
    await flush();
    expect(client.pending).toHaveLength(1);
    client.pending[0]?.reject(new NacosApiError('network', 'connection reset'));
    const results = await attempts;
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(client.calls).toHaveLength(1);
  });

  it('retries the login after a failure rather than replaying the rejected attempt', async () => {
    const client = createLoginClient([
      new NacosApiError('network', 'connection reset'),
      { accessToken: 'tok', tokenTtl: 18000 }
    ]);
    const strategy = strategyFor(client);
    await expect(strategy.authHeaders()).rejects.toThrow('connection reset');
    expect((await strategy.authHeaders()).authorization).toBe('Bearer tok');
    expect(client.calls).toHaveLength(2);
  });

  it('spends a single re-login on a wave of concurrent 403 refreshes', async () => {
    const client = createLoginClient([
      { accessToken: 'tok1', tokenTtl: 18000 },
      { accessToken: 'tok2', tokenTtl: 18000 }
    ]);
    const strategy = strategyFor(client);
    await strategy.authHeaders();
    const retried = await Promise.all(
      Array.from({ length: 10 }, async () => {
        await strategy.refresh();
        return strategy.authHeaders();
      })
    );
    expect(client.calls).toHaveLength(2);
    expect(new Set(retried.map((headers) => headers.authorization))).toEqual(new Set(['Bearer tok2']));
  });

  it('reports that a retry is worthwhile even when nothing has been cached yet', async () => {
    const client = createLoginClient([{ accessToken: 'tok', tokenTtl: 18000 }]);
    const strategy = strategyFor(client);
    expect(await strategy.refresh()).toBe(true);
    expect(client.calls).toHaveLength(0);
    expect((await strategy.authHeaders()).authorization).toBe('Bearer tok');
  });

  it('falls back to the Nacos default ttl when the server omits tokenTtl', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    const client = createLoginClient([{ accessToken: 'tok' }]);
    const strategy = strategyFor(client);
    await strategy.authHeaders();
    now.mockReturnValue(14_399_999);
    await strategy.authHeaders();
    expect(client.calls).toHaveLength(1);
    now.mockReturnValue(14_400_000);
    await strategy.authHeaders();
    expect(client.calls).toHaveLength(2);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['not a number', '18000'],
    ['infinite', Number.POSITIVE_INFINITY]
  ])('treats a %s tokenTtl as absent rather than re-logging in on every request', async (_name, tokenTtl) => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    const client = createLoginClient([{ accessToken: 'tok', tokenTtl }]);
    const strategy = strategyFor(client);
    await strategy.authHeaders();
    await strategy.authHeaders();
    await strategy.authHeaders();
    expect(client.calls).toHaveLength(1);
    now.mockReturnValue(14_400_000);
    await strategy.authHeaders();
    expect(client.calls).toHaveLength(2);
  });

  it.each([
    ['an empty accessToken', { accessToken: '', tokenTtl: 18000 }],
    ['a non-string accessToken', { accessToken: 12345, tokenTtl: 18000 }],
    ['no accessToken at all', { tokenTtl: 18000 }],
    ['an empty body', undefined]
  ])('rejects a login response with %s', async (_name, response) => {
    const client = createLoginClient([response]);
    await expect(strategyFor(client).authHeaders()).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('keeps the password out of the request line when talking to a real server', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"accessToken":"eyJhbGciOi","tokenTtl":18000,"globalAdmin":true,"username":"nacos"}');
    });
    const http = new NacosHttpClient({ baseUrl: `${server.origin}/nacos` });
    const strategy = new UserPasswordStrategy(http, () =>
      Promise.resolve({ username: 'nacos', password: 'hunter2&admin=true' })
    );
    expect(await strategy.authHeaders()).toEqual({ authorization: 'Bearer eyJhbGciOi' });
    const request = server.requests[0];
    expect(request?.url).toBe('/nacos/v3/auth/user/login?username=nacos');
    expect(request?.body).toBe('password=hunter2%26admin%3Dtrue');
  });

  it('detects the OIDC rejection through the wrapping the http client applies', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ code: 23000, message: OIDC_REJECTION, data: null }));
    });
    const http = new NacosHttpClient({ baseUrl: server.origin });
    const strategy = new UserPasswordStrategy(http, () => Promise.resolve({ username: 'nacos', password: 'x' }));
    await expect(strategy.authHeaders()).rejects.toMatchObject({
      kind: 'validation',
      message: expect.stringMatching(/external identity provider/i)
    });
    // A business-code failure is not a missing endpoint, so v1 must stay untried.
    expect(server.requests).toHaveLength(1);
  });

  it('detects the OIDC rejection when the server reports it as an HTTP 403', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.statusCode = 403;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ code: 403, message: OIDC_REJECTION }));
    });
    const http = new NacosHttpClient({ baseUrl: server.origin });
    const strategy = new UserPasswordStrategy(http, () => Promise.resolve({ username: 'nacos', password: 'x' }));
    await expect(strategy.authHeaders()).rejects.toMatchObject({ kind: 'validation' });
  });
});
