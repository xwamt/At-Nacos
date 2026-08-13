import { describe, expect, it } from 'vitest';
import { NacosApiError } from '../../../src/nacos/NacosApiError';
import type { NacosRawResponse, NacosRequestOptions } from '../../../src/nacos/NacosHttpClient';
import type { NacosAuthStrategy } from '../../../src/nacos/auth/NacosAuthStrategy';
import { UserPasswordStrategy } from '../../../src/nacos/auth/UserPasswordStrategy';
import { withAuth } from '../../../src/nacos/auth/withAuth';

interface RecordedCall {
  method: string;
  path: string;
  options: NacosRequestOptions;
}

/**
 * Answers with the queued outcomes in order and replays the last one once they
 * run out, so a test that cares about one attempt does not have to describe
 * every later one. An `Error` in the queue is thrown; anything else is
 * returned.
 */
function createHttp(outcomes: unknown[]) {
  const calls: RecordedCall[] = [];
  let index = 0;
  const answer = (): unknown => {
    const outcome = outcomes[Math.min(index, outcomes.length - 1)];
    index += 1;
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome;
  };
  return {
    calls,
    async requestJson<T>(method: string, path: string, options: NacosRequestOptions = {}): Promise<T> {
      calls.push({ method, path, options });
      return answer() as T;
    },
    async requestRaw(method: string, path: string, options: NacosRequestOptions = {}): Promise<NacosRawResponse> {
      calls.push({ method, path, options });
      return answer() as NacosRawResponse;
    }
  };
}

interface FakeAuth extends NacosAuthStrategy {
  readonly state: { refreshes: number; generation: number };
}

/**
 * Hands out a new token on every successful refresh, so "did the retry use the
 * renewed credential?" is visible in the recorded headers.
 */
function createAuth(options: { canRefresh?: boolean; headers?: Record<string, string> } = {}): FakeAuth {
  const { canRefresh = true } = options;
  const state = { refreshes: 0, generation: 1 };
  return {
    state,
    async authHeaders(): Promise<Record<string, string>> {
      return options.headers ?? { authorization: `Bearer tok${state.generation}` };
    },
    async refresh(): Promise<boolean> {
      state.refreshes += 1;
      if (!canRefresh) {
        return false;
      }
      state.generation += 1;
      return true;
    }
  };
}

function raw(status: number, text = ''): NacosRawResponse {
  return { status, ok: status >= 200 && status < 300, text, contentType: 'application/json' };
}

function forbidden(): NacosApiError {
  return new NacosApiError('forbidden', 'Nacos denied the request to /v3/x (HTTP 403)', 403);
}

/** Drains the microtask queue so every concurrent request has reached the client. */
function flush(): Promise<void> {
  return new Promise((done) => setImmediate(done));
}

describe('withAuth header merging', () => {
  it('attaches the strategy headers to a request that supplied none', async () => {
    const http = createHttp([{ ok: true }]);
    await withAuth(http, createAuth()).requestJson('GET', '/v3/x');
    expect(http.calls[0]?.options.headers).toEqual({ authorization: 'Bearer tok1' });
  });

  it('keeps a caller header alongside the auth headers', async () => {
    const http = createHttp([{ ok: true }]);
    await withAuth(http, createAuth()).requestJson('GET', '/v3/x', { headers: { accept: 'text/plain' } });
    expect(http.calls[0]?.options.headers).toEqual({ authorization: 'Bearer tok1', accept: 'text/plain' });
  });

  it('leaves everything else on the options untouched', async () => {
    const http = createHttp([{ ok: true }]);
    await withAuth(http, createAuth()).requestJson('POST', '/v3/x', {
      query: { namespaceId: 'public' },
      form: { a: 'b' },
      baseUrlOverride: 'http://console:8080'
    });
    expect(http.calls[0]?.options).toMatchObject({
      query: { namespaceId: 'public' },
      form: { a: 'b' },
      baseUrlOverride: 'http://console:8080'
    });
  });

  it('lets a caller header win over an auth header of the same name', async () => {
    const http = createHttp([{ ok: true }]);
    await withAuth(http, createAuth()).requestJson('GET', '/v3/x', {
      headers: { authorization: 'Bearer caller' }
    });
    expect(http.calls[0]?.options.headers).toEqual({ authorization: 'Bearer caller' });
  });

  it('lets a caller header win over an auth header spelled with different case', async () => {
    // Two spellings of one header would otherwise both go on the wire, and
    // which of them Nacos reads is not something this wrapper gets to decide.
    const http = createHttp([{ ok: true }]);
    await withAuth(http, createAuth({ headers: { Authorization: 'Bearer stored' } })).requestJson('GET', '/v3/x', {
      headers: { authorization: 'Bearer caller' }
    });
    expect(http.calls[0]?.options.headers).toEqual({ authorization: 'Bearer caller' });
  });

  it('does not mutate the options object the caller handed in', async () => {
    const http = createHttp([{ ok: true }]);
    const options: NacosRequestOptions = { headers: { accept: 'text/plain' } };
    await withAuth(http, createAuth()).requestJson('GET', '/v3/x', options);
    expect(options).toEqual({ headers: { accept: 'text/plain' } });
  });

  it('resolves the headers again for every request, so a renewed token is picked up', async () => {
    const http = createHttp([{ ok: true }]);
    const auth = createAuth();
    const client = withAuth(http, auth);
    await client.requestJson('GET', '/v3/x');
    await auth.refresh();
    await client.requestJson('GET', '/v3/x');
    expect(http.calls.map((call) => call.options.headers?.authorization)).toEqual(['Bearer tok1', 'Bearer tok2']);
  });
});

describe('withAuth 403 recovery on requestJson', () => {
  it('refreshes and retries once, returning what the retry answered', async () => {
    const http = createHttp([forbidden(), { namespaces: [] }]);
    const auth = createAuth();

    const result = await withAuth(http, auth).requestJson('GET', '/v3/x');

    expect(result).toEqual({ namespaces: [] });
    expect(auth.state.refreshes).toBe(1);
    expect(http.calls.map((call) => call.options.headers?.authorization)).toEqual(['Bearer tok1', 'Bearer tok2']);
  });

  it('throws the second failure when the retry is refused too, and stops there', async () => {
    const http = createHttp([forbidden(), forbidden()]);
    const auth = createAuth();

    await expect(withAuth(http, auth).requestJson('GET', '/v3/x')).rejects.toMatchObject({ kind: 'forbidden' });

    expect(http.calls).toHaveLength(2);
    expect(auth.state.refreshes).toBe(1);
  });

  it('propagates the original 403 without retrying when the strategy cannot refresh', async () => {
    // What `NoAuthStrategy` and `CustomHeaderStrategy` answer: nothing to renew,
    // so a retry would only repeat the failure.
    const http = createHttp([forbidden()]);
    const auth = createAuth({ canRefresh: false });

    await expect(withAuth(http, auth).requestJson('GET', '/v3/x')).rejects.toMatchObject({ kind: 'forbidden' });

    expect(http.calls).toHaveLength(1);
    expect(auth.state.refreshes).toBe(1);
  });

  it.each([
    ['not-found', new NacosApiError('not-found', 'no such endpoint', 404)],
    ['api-deprecated', new NacosApiError('api-deprecated', 'compatibility switch off', 410)],
    ['gateway-auth', new NacosApiError('gateway-auth', 'the proxy said no', 401)],
    ['network', new NacosApiError('network', 'ECONNREFUSED')],
    ['validation', new NacosApiError('validation', 'this instance is misconfigured')],
    ['an unclassified error', new TypeError('driver bug')]
  ])('does not refresh or retry after %s', async (_name, error) => {
    const http = createHttp([error]);
    const auth = createAuth();

    await expect(withAuth(http, auth).requestJson('GET', '/v3/x')).rejects.toBe(error);

    expect(http.calls).toHaveLength(1);
    expect(auth.state.refreshes).toBe(0);
  });

  it('never refreshes on a request that succeeded', async () => {
    const http = createHttp([{ ok: true }]);
    const auth = createAuth();
    await withAuth(http, auth).requestJson('GET', '/v3/x');
    expect(auth.state.refreshes).toBe(0);
  });

  it('propagates a rejection from authHeaders without sending anything', async () => {
    // The shape `UserPasswordStrategy` produces for an OIDC deployment, and the
    // shape `createAuthStrategy` throws for akSk: neither is a 403 to recover
    // from, and both name the setting the user has to change.
    const failure = new NacosApiError('validation', 'This Nacos server uses an external identity provider');
    const http = createHttp([{ ok: true }]);
    const auth: NacosAuthStrategy = {
      authHeaders: () => Promise.reject(failure),
      refresh: async () => true
    };

    await expect(withAuth(http, auth).requestJson('GET', '/v3/x')).rejects.toBe(failure);

    expect(http.calls).toHaveLength(0);
  });

  it('propagates a rejection from the authHeaders call that follows a refresh', async () => {
    const failure = new NacosApiError('network', 'the login connection was reset');
    let attempt = 0;
    const http = createHttp([forbidden()]);
    const auth: NacosAuthStrategy = {
      authHeaders: async () => {
        attempt += 1;
        if (attempt > 1) {
          throw failure;
        }
        return { authorization: 'Bearer tok1' };
      },
      refresh: async () => true
    };

    await expect(withAuth(http, auth).requestJson('GET', '/v3/x')).rejects.toBe(failure);

    expect(http.calls).toHaveLength(1);
  });
});

describe('withAuth 403 recovery on requestRaw', () => {
  it('refreshes and retries a 403 that arrives as a returned status rather than a throw', async () => {
    // `requestRaw` resolves for any status, so a `catch`-based retry would
    // never see this one.
    const http = createHttp([raw(403, 'unauthorized'), raw(200, 'content')]);
    const auth = createAuth();

    const response = await withAuth(http, auth).requestRaw('GET', '/v1/cs/configs');

    expect(response).toMatchObject({ status: 200, text: 'content' });
    expect(auth.state.refreshes).toBe(1);
    expect(http.calls.map((call) => call.options.headers?.authorization)).toEqual(['Bearer tok1', 'Bearer tok2']);
  });

  it('returns the second 403 rather than throwing when the retry is refused too', async () => {
    const http = createHttp([raw(403, 'first'), raw(403, 'second')]);
    const auth = createAuth();

    const response = await withAuth(http, auth).requestRaw('GET', '/v1/cs/configs');

    expect(response).toMatchObject({ status: 403, text: 'second' });
    expect(http.calls).toHaveLength(2);
    expect(auth.state.refreshes).toBe(1);
  });

  it('returns the original 403 when the strategy cannot refresh', async () => {
    const http = createHttp([raw(403, 'first')]);
    const auth = createAuth({ canRefresh: false });

    const response = await withAuth(http, auth).requestRaw('GET', '/v1/cs/configs');

    expect(response).toMatchObject({ status: 403, text: 'first' });
    expect(http.calls).toHaveLength(1);
  });

  it.each([
    ['404', 404],
    ['410', 410],
    ['401', 401],
    ['500', 500]
  ])('leaves a non-2xx %s alone: it is the answer the caller came for', async (_name, status) => {
    // The context-path probe reads a 404 as "try the next candidate" and the
    // 3.x detector reads the body of a 410. Refreshing a credential neither of
    // them doubted would spend a login on nothing.
    const http = createHttp([raw(status)]);
    const auth = createAuth();

    const response = await withAuth(http, auth).requestRaw('GET', '/v1/cs/configs');

    expect(response.status).toBe(status);
    expect(http.calls).toHaveLength(1);
    expect(auth.state.refreshes).toBe(0);
  });

  it('recovers from a thrown 403 as well, so both surfaces behave alike', async () => {
    const http = createHttp([forbidden(), raw(200, 'content')]);
    const auth = createAuth();

    const response = await withAuth(http, auth).requestRaw('GET', '/v1/cs/configs');

    expect(response).toMatchObject({ status: 200 });
    expect(auth.state.refreshes).toBe(1);
  });
});

describe('withAuth against the real UserPasswordStrategy', () => {
  /**
   * Login answers a token; everything else is refused. One fake stands in for
   * both because production passes the strategy the same client the wrapper
   * wraps.
   */
  function createLoginAndDenyClient() {
    const logins: unknown[] = [];
    const requests: NacosRequestOptions[] = [];
    let issued = 0;
    return {
      logins,
      requests,
      async requestJson<T>(_method: string, path: string, options: NacosRequestOptions = {}): Promise<T> {
        if (path.endsWith('/login')) {
          logins.push(options);
          issued += 1;
          return { accessToken: `tok${issued}`, tokenTtl: 18000 } as T;
        }
        requests.push(options);
        throw forbidden();
      },
      async requestRaw(): Promise<NacosRawResponse> {
        throw new Error('this test drives requestJson only');
      }
    };
  }

  it('spends one login on the first wave and one on the refresh, not one per request', async () => {
    const http = createLoginAndDenyClient();
    const strategy = new UserPasswordStrategy(http, async () => ({ username: 'nacos', password: 'hunter2' }));
    const client = withAuth(http, strategy);

    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, () => client.requestJson('GET', '/v3/admin/core/namespace/list'))
    );
    await flush();

    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true);
    // Ten requests, each retried once, sharing exactly two logins.
    expect(http.requests).toHaveLength(20);
    expect(http.logins).toHaveLength(2);
    expect(http.requests.slice(0, 10).every((options) => options.headers?.authorization === 'Bearer tok1')).toBe(true);
    expect(http.requests.slice(10).every((options) => options.headers?.authorization === 'Bearer tok2')).toBe(true);
  });
});
