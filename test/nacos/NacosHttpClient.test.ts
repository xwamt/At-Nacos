import { afterEach, describe, expect, it } from 'vitest';
import { NacosApiError } from '../../src/nacos/NacosApiError';
import type { NacosCertVerifier } from '../../src/nacos/NacosCertTrustStore';
import { NacosHttpClient, verifyCertFingerprint } from '../../src/nacos/NacosHttpClient';
import type { AtNacosLog } from '../../src/utils/logger';
import {
  startTestHttpServer,
  startTestHttpsServer,
  type TestHttpServer,
  type TestHttpsServer
} from './testHttpServer';

let server: TestHttpServer | undefined;
let secondServer: TestHttpServer | undefined;
let tlsServer: TestHttpsServer | undefined;

afterEach(async () => {
  await server?.close();
  await secondServer?.close();
  await tlsServer?.close();
  server = undefined;
  secondServer = undefined;
  tlsServer = undefined;
});

/** What the query string of a recorded request decoded back to. */
function queryOf(request: { url: string } | undefined): URLSearchParams {
  return new URL(request?.url ?? '/', 'http://127.0.0.1').searchParams;
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function recordingLog(): { lines: string[]; log: AtNacosLog } {
  const lines: string[] = [];
  const push = (message: string) => lines.push(message);
  return { lines, log: { error: push, warn: push, info: push, debug: push, trace: push } };
}

describe('NacosHttpClient', () => {
  it('joins a path onto a base URL that already carries a context path', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true}');
    });
    const client = new NacosHttpClient({ baseUrl: `${server.origin}/nacos` });
    await client.requestJson('GET', '/v1/console/server/state');
    expect(server.requests[0]?.url).toBe('/nacos/v1/console/server/state');
  });

  it('attaches auth headers supplied by the caller', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const client = new NacosHttpClient({ baseUrl: server.origin });
    await client.requestJson('GET', '/x', { headers: { authorization: 'Bearer abc' } });
    expect(server.requests[0]?.headers.authorization).toBe('Bearer abc');
  });

  it('classifies HTTP 410 as api-deprecated', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.statusCode = 410;
      response.end('{"status":410,"error":"Gone"}');
    });
    const client = new NacosHttpClient({ baseUrl: server.origin });
    await expect(client.requestJson('GET', '/v1/cs/configs')).rejects.toMatchObject({
      kind: 'api-deprecated',
      status: 410
    });
  });

  it('classifies HTTP 404 as not-found', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.statusCode = 404;
      response.end('not found');
    });
    const client = new NacosHttpClient({ baseUrl: server.origin });
    await expect(client.requestJson('GET', '/v1/cs/configs')).rejects.toMatchObject({
      kind: 'not-found'
    });
  });

  it('treats HTTP 200 with a non-success body code as an api-error, not a fallback trigger', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"code":20004,"message":"resource not found","data":null}');
    });
    const client = new NacosHttpClient({ baseUrl: server.origin });
    const error = await client.requestJson('GET', '/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NacosApiError);
    expect((error as NacosApiError).kind).toBe('api-error');
    expect((error as NacosApiError).shouldFallThrough()).toBe(false);
  });

  it('accepts code 200 as success because Nacos 1.x RestResult uses HTTP-style codes', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"code":200,"message":null,"data":[{"namespace":""}]}');
    });
    const client = new NacosHttpClient({ baseUrl: server.origin });
    await expect(client.requestJson('GET', '/v1/console/namespaces')).resolves.toMatchObject({
      code: 200
    });
  });

  it('returns raw text for endpoints that answer with plain config content', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.setHeader('content-type', 'text/plain');
      response.end('server.port=8080');
    });
    const client = new NacosHttpClient({ baseUrl: server.origin });
    const result = await client.requestRaw('GET', '/v1/cs/configs');
    expect(result.text).toBe('server.port=8080');
    expect(result.status).toBe(200);
  });

  it('sends a urlencoded form body with the password out of the query string', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const client = new NacosHttpClient({ baseUrl: server.origin });
    await client.requestJson('POST', '/v1/auth/login', {
      query: { username: 'nacos' },
      form: { password: 'hunter2' }
    });
    const request = server.requests[0];
    expect(request?.url).toBe('/v1/auth/login?username=nacos');
    expect(request?.url).not.toContain('hunter2');
    expect(request?.body).toBe('password=hunter2');
    expect(request?.headers['content-type']).toBe('application/x-www-form-urlencoded');
  });

  it('sends a JSON body with a matching content type', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const client = new NacosHttpClient({ baseUrl: server.origin });
    await client.requestJson('POST', '/v3/admin/cs/config', { body: { dataId: 'a', content: 'b' } });
    expect(server.requests[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(server.requests[0]?.body ?? '')).toEqual({ dataId: 'a', content: 'b' });
  });
});

describe('NacosHttpClient URL building', () => {
  it('retargets the request at baseUrlOverride, keeping that origin own context path', async () => {
    secondServer = await startTestHttpServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"code":0,"data":[]}');
    });
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const client = new NacosHttpClient({ baseUrl: `${server.origin}/nacos` });

    await client.requestJson('GET', '/v3/console/core/namespace/list', {
      baseUrlOverride: `${secondServer.origin}/console`
    });

    expect(secondServer.requests[0]?.url).toBe('/console/v3/console/core/namespace/list');
    expect(server.requests).toHaveLength(0);
  });

  it('preserves the context path when the caller omits the leading slash', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const client = new NacosHttpClient({ baseUrl: `${server.origin}/nacos` });
    await client.requestJson('GET', 'v1/console/server/state');
    expect(server.requests[0]?.url).toBe('/nacos/v1/console/server/state');
  });

  it('preserves the context path when the caller doubles up leading slashes', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const client = new NacosHttpClient({ baseUrl: `${server.origin}/nacos` });
    await client.requestJson('GET', '///v1/console/server/state');
    expect(server.requests[0]?.url).toBe('/nacos/v1/console/server/state');
  });

  it('tolerates trailing slashes on the base URL', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const client = new NacosHttpClient({ baseUrl: `${server.origin}/nacos///` });
    await client.requestJson('GET', '/v1/console/server/state');
    expect(server.requests[0]?.url).toBe('/nacos/v1/console/server/state');
  });

  /**
   * A base URL is only ever a base: relative resolution against
   * `http://host/nacos?x=1/` drops the context path entirely and sends the
   * request to `/v1/...`. Nothing downstream can recover from that, so the
   * query and the fragment are removed where every caller passes through --
   * including the ones that hand a stored `serverUrl` straight to the client.
   */
  it('drops a query string on the base URL, which would otherwise erase the context path', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const client = new NacosHttpClient({ baseUrl: `${server.origin}/nacos?x=1` });
    await client.requestJson('GET', '/v1/console/server/state');
    expect(server.requests[0]?.url).toBe('/nacos/v1/console/server/state');
  });

  /** What a user gets by copying the console URL out of a browser address bar. */
  it('drops a fragment on the base URL', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const client = new NacosHttpClient({ baseUrl: `${server.origin}/nacos/#/login` });
    await client.requestJson('GET', '/v1/console/server/state');
    expect(server.requests[0]?.url).toBe('/nacos/v1/console/server/state');
  });

  /**
   * Node turns userinfo into a real `Authorization: Basic` header, which a
   * strategy-supplied `authorization` then silently suppresses -- so it
   * half-works, undesigned, and which half depends on the authentication mode.
   * Removing it here removes both the header and the credential from every
   * message built out of a base URL.
   */
  it('sends no Basic credential for a base URL that carries userinfo', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const origin = new URL(server.origin);
    const client = new NacosHttpClient({
      baseUrl: `${origin.protocol}//admin:hunter2@${origin.host}/nacos`
    });

    await client.requestJson('GET', '/v1/console/server/state');

    expect(server.requests[0]?.url).toBe('/nacos/v1/console/server/state');
    expect(server.requests[0]?.headers.authorization).toBeUndefined();
  });

  it('sends no Basic credential for a baseUrlOverride that carries userinfo either', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    secondServer = await startTestHttpServer((_request, response) => response.end('{}'));
    const override = new URL(secondServer.origin);
    const client = new NacosHttpClient({ baseUrl: server.origin });

    await client.requestJson('GET', '/v3/console/core/namespace/list', {
      baseUrlOverride: `${override.protocol}//admin:hunter2@${override.host}`
    });

    expect(secondServer.requests[0]?.headers.authorization).toBeUndefined();
  });

  it('drops a query string on baseUrlOverride too', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    secondServer = await startTestHttpServer((_request, response) => response.end('{}'));
    const client = new NacosHttpClient({ baseUrl: server.origin });
    await client.requestJson('GET', '/v3/console/x', { baseUrlOverride: `${secondServer.origin}/console?y=2` });
    expect(secondServer.requests[0]?.url).toBe('/console/v3/console/x');
  });

  /** Per-request query parameters are unaffected; only the base URL is normalized. */
  it('still sends the query parameters the caller asked for', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const client = new NacosHttpClient({ baseUrl: `${server.origin}/nacos?x=1` });
    await client.requestJson('GET', '/v1/cs/configs', { query: { dataId: 'app.properties' } });
    expect(server.requests[0]?.url).toBe('/nacos/v1/cs/configs?dataId=app.properties');
  });

  it('omits a query parameter whose value is undefined rather than sending the string "undefined"', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const client = new NacosHttpClient({ baseUrl: server.origin });
    await client.requestJson('GET', '/v1/cs/configs', {
      query: { dataId: 'app.properties', tenant: undefined }
    });
    expect(server.requests[0]?.url).toBe('/v1/cs/configs?dataId=app.properties');
    expect(queryOf(server.requests[0]).has('tenant')).toBe(false);
  });

  it('percent-encodes query values so a dataId survives spaces, plus, ampersand and non-ASCII', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const client = new NacosHttpClient({ baseUrl: server.origin });
    const dataId = 'my app+v2&stage=配置.properties';

    await client.requestJson('GET', '/v1/cs/configs', { query: { dataId, group: 'DEFAULT_GROUP' } });

    expect(queryOf(server.requests[0]).get('dataId')).toBe(dataId);
    expect(queryOf(server.requests[0]).get('group')).toBe('DEFAULT_GROUP');
  });

  it('rejects an unparseable base URL as a validation failure before any request goes out', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const client = new NacosHttpClient({ baseUrl: server.origin });

    const error = await client.requestJson('GET', '/x', { baseUrlOverride: 'not a url' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NacosApiError);
    expect((error as NacosApiError).kind).toBe('validation');
    expect(server.requests).toHaveLength(0);
  });
});

describe('NacosHttpClient request bodies', () => {
  it('percent-encodes form values so a password containing separators survives intact', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const client = new NacosHttpClient({ baseUrl: server.origin });
    const password = 'a&b=c+d e';

    await client.requestJson('POST', '/v1/auth/login', { query: { username: 'nacos' }, form: { password } });

    const body = server.requests[0]?.body ?? '';
    expect(body).not.toContain('a&b');
    expect(new URLSearchParams(body).get('password')).toBe(password);
  });

  it('refuses a request that carries both a JSON body and a form, instead of silently picking one', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const client = new NacosHttpClient({ baseUrl: server.origin });

    const error = await client
      .requestJson('POST', '/x', { body: { a: 1 }, form: { b: '2' } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NacosApiError);
    expect((error as NacosApiError).kind).toBe('validation');
    expect((error as NacosApiError).shouldFallThrough()).toBe(false);
    expect(server.requests).toHaveLength(0);
  });

  it('asks for JSON by default but lets the caller override the accept header', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const client = new NacosHttpClient({ baseUrl: server.origin });

    await client.requestJson('GET', '/a');
    await client.requestJson('GET', '/b', { headers: { accept: 'text/plain' } });

    expect(server.requests[0]?.headers.accept).toBe('application/json');
    expect(server.requests[1]?.headers.accept).toBe('text/plain');
  });
});

describe('NacosHttpClient response parsing', () => {
  it('resolves an empty 204 rather than failing to parse it', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.statusCode = 204;
      response.end();
    });
    const client = new NacosHttpClient({ baseUrl: server.origin });
    await expect(client.requestJson('DELETE', '/v3/admin/cs/config')).resolves.toBeUndefined();
  });

  it('passes a bare JSON array through without applying the body-code check', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('[{"code":40004,"name":"a config named like an error"}]');
    });
    const client = new NacosHttpClient({ baseUrl: server.origin });
    await expect(client.requestJson('GET', '/v1/cs/configs')).resolves.toEqual([
      { code: 40004, name: 'a config named like an error' }
    ]);
  });

  it('passes a literal JSON null through instead of crashing the body-code check', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('null');
    });
    const client = new NacosHttpClient({ baseUrl: server.origin });
    await expect(client.requestJson('GET', '/x')).resolves.toBeNull();
  });

  it('accepts code 0, the v2/v3 success value', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"code":0,"message":"success","data":{"version":"3.2.3"}}');
    });
    const client = new NacosHttpClient({ baseUrl: server.origin });
    await expect(client.requestJson('GET', '/v3/admin/core/state')).resolves.toMatchObject({ code: 0 });
  });

  it('classifies a 2xx body that is not JSON as invalid-response', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.setHeader('content-type', 'text/plain');
      response.end('Nacos Console default port is 8080, and the path is /.');
    });
    const client = new NacosHttpClient({ baseUrl: server.origin });
    await expect(client.requestJson('GET', '/')).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('carries the upstream message into a non-2xx error so the user sees why', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json');
      response.end('{"code":50000,"message":"do metadata operation failed"}');
    });
    const client = new NacosHttpClient({ baseUrl: server.origin });
    const error = await client.requestJson('GET', '/x').catch((e: unknown) => e);
    expect((error as NacosApiError).kind).toBe('api-error');
    expect((error as NacosApiError).message).toContain('do metadata operation failed');
  });

  it('says a proxy is in front when something answers 401, which Nacos itself never does', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.statusCode = 401;
      response.end('<html>gateway</html>');
    });
    const client = new NacosHttpClient({ baseUrl: server.origin });
    const error = await client.requestJson('GET', '/x').catch((e: unknown) => e);
    expect((error as NacosApiError).kind).toBe('gateway-auth');
    expect((error as NacosApiError).message).toMatch(/proxy|gateway/i);
  });
});

describe('NacosHttpClient.requestRaw', () => {
  it('reports the content type alongside the body', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.setHeader('content-type', 'text/plain;charset=UTF-8');
      response.end('Nacos Console default port is 8080, and the path is /.');
    });
    const client = new NacosHttpClient({ baseUrl: server.origin });
    const result = await client.requestRaw('GET', '/');
    expect(result.contentType).toBe('text/plain;charset=UTF-8');
    expect(result.ok).toBe(true);
  });

  it('returns a non-2xx instead of throwing, so a caller can read the status and the body', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.statusCode = 410;
      response.setHeader('content-type', 'application/json');
      response.end('{"timestamp":1,"status":410,"error":"Gone","path":"/nacos/v1/cs/configs"}');
    });
    const client = new NacosHttpClient({ baseUrl: server.origin });

    const result = await client.requestRaw('GET', '/v1/cs/configs');

    expect(result.status).toBe(410);
    expect(result.ok).toBe(false);
    expect(result.contentType).toBe('application/json');
    expect(result.text).toContain('Gone');
  });

  it('reports a 404 the same way, so a context-path probe can just try the next candidate', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.statusCode = 404;
      response.end('not found');
    });
    const client = new NacosHttpClient({ baseUrl: server.origin });
    await expect(client.requestRaw('GET', '/nacos/')).resolves.toMatchObject({ status: 404, ok: false });
  });

  it('still throws when no response arrives at all, because there is nothing to hand back', async () => {
    const client = new NacosHttpClient({ baseUrl: 'http://127.0.0.1:1' });
    await expect(client.requestRaw('GET', '/')).rejects.toMatchObject({ kind: 'network' });
  });

  it('applies the same body and form exclusivity check', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const client = new NacosHttpClient({ baseUrl: server.origin });
    await expect(client.requestRaw('POST', '/x', { body: {}, form: {} })).rejects.toMatchObject({
      kind: 'validation'
    });
    expect(server.requests).toHaveLength(0);
  });
});

describe('NacosHttpClient transport failures', () => {
  it('classifies a connection to a closed port as network', async () => {
    const client = new NacosHttpClient({ baseUrl: 'http://127.0.0.1:1' });
    const error = await client.requestJson('GET', '/v1/console/server/state').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NacosApiError);
    expect((error as NacosApiError).kind).toBe('network');
  });

  it('classifies a timeout as network', async () => {
    server = await startTestHttpServer(() => {
      // Never responds: the client's own timeout has to end this.
    });
    const client = new NacosHttpClient({ baseUrl: server.origin, timeoutMs: 40 });
    const error = await client.requestJson('GET', '/v1/cs/configs').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NacosApiError);
    expect((error as NacosApiError).kind).toBe('network');
    expect((error as NacosApiError).message).toMatch(/timed out/i);
  });

  it('aborts and rejects with response-too-large once the body passes maxResponseBytes', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ big: 'x'.repeat(200_000) }));
    });
    const client = new NacosHttpClient({ baseUrl: server.origin });

    const error = await client.requestJson('GET', '/v1/cs/configs', { maxResponseBytes: 64 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NacosApiError);
    expect((error as NacosApiError).kind).toBe('response-too-large');
  });

  it('settles once when the cap is hit on a response the server then tears down', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('x'.repeat(100_000));
      // Destroying mid-stream is what makes a later 'error' race the abort
      // above; the one-shot settle guard is what keeps the first result.
      setTimeout(() => response.destroy(), 5);
    });
    const client = new NacosHttpClient({ baseUrl: server.origin });

    const error = await client.requestJson('GET', '/v1/cs/configs', { maxResponseBytes: 64 }).catch((e: unknown) => e);

    expect((error as NacosApiError).kind).toBe('response-too-large');
  });

  it('does not abort a response that fits inside maxResponseBytes', async () => {
    const body = '{"code":0,"data":[]}';
    server = await startTestHttpServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(body);
    });
    const client = new NacosHttpClient({ baseUrl: server.origin });
    await expect(
      client.requestJson('GET', '/x', { maxResponseBytes: Buffer.byteLength(body) })
    ).resolves.toEqual({ code: 0, data: [] });
  });

  it('logs the classification without echoing the credential that was posted', async () => {
    const { lines, log } = recordingLog();
    server = await startTestHttpServer((_request, response) => {
      response.statusCode = 403;
      response.end('{"code":403,"message":"user not found!"}');
    });
    const client = new NacosHttpClient({ baseUrl: server.origin, log });

    const error = await client
      .requestJson('POST', '/v3/auth/user/login', {
        query: { username: 'nacos' },
        form: { password: 'hunter2' }
      })
      .catch((e: unknown) => e);

    expect((error as NacosApiError).kind).toBe('forbidden');
    expect(lines.join('\n')).toContain('/v3/auth/user/login');
    expect(lines.join('\n')).not.toContain('hunter2');
    expect((error as NacosApiError).message).not.toContain('hunter2');
  });
});

describe('NacosHttpClient TLS trust-on-first-use', () => {
  it('accepts a self-signed certificate the verifier approves, which Node alone would reject', async () => {
    tlsServer = await startTestHttpsServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"code":0,"data":{"version":"3.2.3"}}');
    });
    const client = new NacosHttpClient({
      baseUrl: tlsServer.origin,
      certVerifier: { verify: async () => true }
    });

    await expect(client.requestJson('GET', '/v3/admin/core/state')).resolves.toMatchObject({ code: 0 });
  });

  it('hands the verifier the host, port and the certificate SHA-256 fingerprint', async () => {
    tlsServer = await startTestHttpsServer((_request, response) => response.end('{}'));
    const seen: { host: string; port: number; fingerprint256: string }[] = [];
    const client = new NacosHttpClient({
      baseUrl: tlsServer.origin,
      certVerifier: {
        verify: async (host, port, fingerprint256) => {
          seen.push({ host, port, fingerprint256 });
          return true;
        }
      }
    });

    await client.requestJson('GET', '/x');

    expect(seen[0]?.host).toBe('127.0.0.1');
    expect(seen[0]?.port).toBe(Number(new URL(tlsServer.origin).port));
    expect(seen[0]?.fingerprint256).toBe(tlsServer.fingerprint256);
  });

  it('sends no request bytes when the verifier rejects the certificate', async () => {
    tlsServer = await startTestHttpsServer((_request, response) => response.end('{}'));
    let consulted = false;
    const client = new NacosHttpClient({
      baseUrl: tlsServer.origin,
      certVerifier: {
        verify: async () => {
          consulted = true;
          return false;
        }
      }
    });

    const error = await client
      .requestJson('POST', '/v3/auth/user/login', { form: { password: 'hunter2' } })
      .catch((e: unknown) => e);

    expect((error as NacosApiError).kind).toBe('tls');
    // Connected and got far enough to read the certificate, then wrote nothing:
    // the password never left the process.
    expect(tlsServer.connections).toBeGreaterThan(0);
    expect(consulted).toBe(true);
    expect(tlsServer.requests).toHaveLength(0);
  });

  it('writes nothing onto the wire until the verifier has settled', async () => {
    tlsServer = await startTestHttpsServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"code":0}');
    });
    let approve: () => void = () => undefined;
    const verdict = new Promise<void>((settle) => {
      approve = settle;
    });
    const client = new NacosHttpClient({
      baseUrl: tlsServer.origin,
      certVerifier: {
        verify: async () => {
          await verdict;
          return true;
        }
      }
    });

    const pending = client.requestJson('GET', '/v3/admin/core/state');
    await delay(60);
    // The handshake is long done by now; only the deferred write keeps the
    // request itself from having reached the server.
    expect(tlsServer.requests).toHaveLength(0);

    approve();
    await expect(pending).resolves.toMatchObject({ code: 0 });
    expect(tlsServer.requests).toHaveLength(1);
  });

  it('completes a second request that reuses the pooled connection', async () => {
    // Node's global agent keeps HTTPS sockets alive (its default since Node
    // 19), so the second request is handed a socket whose handshake finished
    // during the first. `secureConnect` never fires again for it, and a
    // verification hook that waits for it would hold the request until the
    // timeout -- which is every request after the first: the version probe is
    // followed immediately by a namespace listing on the same origin.
    tlsServer = await startTestHttpsServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"code":0}');
    });
    const client = new NacosHttpClient({
      baseUrl: tlsServer.origin,
      timeoutMs: 2000,
      certVerifier: { verify: async () => true }
    });

    await expect(client.requestJson('GET', '/first')).resolves.toMatchObject({ code: 0 });
    await expect(client.requestJson('GET', '/second')).resolves.toMatchObject({ code: 0 });

    expect(tlsServer.requests.map((request) => request.url)).toEqual(['/first', '/second']);
  });

  it('checks the fingerprint again on a reused connection', async () => {
    tlsServer = await startTestHttpsServer((_request, response) => response.end('{}'));
    let checks = 0;
    const client = new NacosHttpClient({
      baseUrl: tlsServer.origin,
      timeoutMs: 2000,
      certVerifier: {
        verify: async () => {
          checks += 1;
          return true;
        }
      }
    });

    await client.requestJson('GET', '/first');
    await client.requestJson('GET', '/second');

    // Skipping the check for a socket already in the pool would make "no
    // request is written without a verdict" true only for the first one.
    expect(checks).toBe(2);
  });

  it('sends nothing on a reused connection whose certificate is no longer trusted', async () => {
    tlsServer = await startTestHttpsServer((_request, response) => response.end('{}'));
    let trusted = true;
    const client = new NacosHttpClient({
      baseUrl: tlsServer.origin,
      timeoutMs: 2000,
      certVerifier: { verify: async () => trusted }
    });

    await client.requestJson('GET', '/first');
    trusted = false;
    const error = await client.requestJson('GET', '/second').catch((e: unknown) => e);

    expect((error as NacosApiError).kind).toBe('tls');
    expect(tlsServer.requests.map((request) => request.url)).toEqual(['/first']);
  });

  it('falls back to Node chain validation when no verifier is configured', async () => {
    tlsServer = await startTestHttpsServer((_request, response) => response.end('{}'));
    const client = new NacosHttpClient({ baseUrl: tlsServer.origin });

    const error = await client.requestJson('GET', '/x').catch((e: unknown) => e);

    expect((error as NacosApiError).kind).toBe('tls');
    expect(tlsServer.requests).toHaveLength(0);
  });

  it('reports a verifier that blows up as a tls failure rather than an unhandled rejection', async () => {
    tlsServer = await startTestHttpsServer((_request, response) => response.end('{}'));
    const client = new NacosHttpClient({
      baseUrl: tlsServer.origin,
      certVerifier: {
        verify: async () => {
          throw new Error('trust store unavailable');
        }
      }
    });

    const error = await client.requestJson('GET', '/x').catch((e: unknown) => e);

    expect((error as NacosApiError).kind).toBe('tls');
    expect((error as NacosApiError).message).toContain('trust store unavailable');
  });
});

/**
 * The verifier is a modal asking a human to compare a SHA-256 fingerprint --
 * and for a certificate that has *changed*, to go and confirm the new one with
 * whoever administers the server. The socket is idle for all of it, and the
 * request's inactivity timeout is already armed.
 */
describe('NacosHttpClient timeout across the certificate prompt', () => {
  it('does not time out while the verifier is still deciding', async () => {
    tlsServer = await startTestHttpsServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"code":0}');
    });
    const client = new NacosHttpClient({
      baseUrl: tlsServer.origin,
      // Far shorter than the verifier takes, and far shorter than anyone
      // reading a fingerprint prompt.
      timeoutMs: 80,
      certVerifier: {
        verify: async () => {
          await delay(400);
          return true;
        }
      }
    });

    await expect(client.requestJson('GET', '/v3/admin/core/state')).resolves.toMatchObject({ code: 0 });
    expect(tlsServer.requests).toHaveLength(1);
  });

  it('does not time out while the verifier is deciding against the certificate either', async () => {
    tlsServer = await startTestHttpsServer((_request, response) => response.end('{}'));
    const client = new NacosHttpClient({
      baseUrl: tlsServer.origin,
      timeoutMs: 80,
      certVerifier: {
        verify: async () => {
          await delay(400);
          return false;
        }
      }
    });

    const error = await client.requestJson('GET', '/x').catch((e: unknown) => e);

    // A rejected certificate, not "the request to Nacos timed out": the user
    // said no, and that is what they have to be told.
    expect((error as NacosApiError).kind).toBe('tls');
    expect((error as NacosApiError).message).toMatch(/rejected by the certificate verifier/);
  });

  /** Stopping the clock for the human must not stop it for the server. */
  it('still times out a server that takes the request and then goes silent', async () => {
    tlsServer = await startTestHttpsServer(() => {
      // Never responds.
    });
    const client = new NacosHttpClient({
      baseUrl: tlsServer.origin,
      timeoutMs: 120,
      certVerifier: {
        verify: async () => {
          await delay(200);
          return true;
        }
      }
    });

    const error = await client.requestJson('GET', '/x').catch((e: unknown) => e);

    expect((error as NacosApiError).kind).toBe('network');
    expect((error as NacosApiError).message).toMatch(/timed out/i);
    // The prompt window bought the request its full deadline back, so the
    // failure is the server's silence and not the wait for the verdict.
    expect(tlsServer.requests).toHaveLength(1);
  });

  /** Nothing is left to re-arm, and arming a timer on a dead handle would be worse than not. */
  it('reports a socket torn down while the prompt was open as a connection failure', async () => {
    tlsServer = await startTestHttpsServer((_request, response) => response.end('{}'));
    const client = new NacosHttpClient({
      baseUrl: tlsServer.origin,
      timeoutMs: 5000,
      certVerifier: {
        verify: async () => {
          await delay(200);
          return true;
        }
      }
    });

    const pending = client.requestJson('GET', '/x');
    // Long enough for the handshake to finish and the verifier to be waiting.
    await delay(60);
    await tlsServer.close();
    tlsServer = undefined;

    const error = await pending.catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NacosApiError);
    expect((error as NacosApiError).kind).toBe('network');
    // Long after the verdict, so the restore ran against the dead socket too.
    await delay(200);
  });

  /** The check runs per request, so the second one on a kept-alive socket can prompt too. */
  it('does not time out while the verifier decides on a socket taken from the pool', async () => {
    tlsServer = await startTestHttpsServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"code":0}');
    });
    let slow = false;
    const client = new NacosHttpClient({
      baseUrl: tlsServer.origin,
      timeoutMs: 80,
      certVerifier: {
        verify: async () => {
          if (slow) {
            await delay(400);
          }
          return true;
        }
      }
    });

    await expect(client.requestJson('GET', '/first')).resolves.toMatchObject({ code: 0 });
    slow = true;

    await expect(client.requestJson('GET', '/second')).resolves.toMatchObject({ code: 0 });
  });

  it('leaves the timeout armed for the request that follows on a pooled socket', async () => {
    let slow = false;
    tlsServer = await startTestHttpsServer((request, response) => {
      if (slow) {
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end('{"code":0}');
    });
    const client = new NacosHttpClient({
      baseUrl: tlsServer.origin,
      timeoutMs: 120,
      certVerifier: { verify: async () => true }
    });

    await expect(client.requestJson('GET', '/first')).resolves.toMatchObject({ code: 0 });
    slow = true;
    const error = await client.requestJson('GET', '/second').catch((e: unknown) => e);

    expect((error as NacosApiError).kind).toBe('network');
    expect((error as NacosApiError).message).toMatch(/timed out/i);
  });
});

describe('verifyCertFingerprint', () => {
  it('resolves undefined (trusted) when the verifier approves the fingerprint', async () => {
    const verifier: NacosCertVerifier = { verify: async () => true };
    await expect(verifyCertFingerprint(verifier, 'nacos.example.com', 8848, 'SHA256:abc')).resolves.toBeUndefined();
  });

  it('resolves a tls NacosApiError when the verifier rejects the fingerprint', async () => {
    const verifier: NacosCertVerifier = { verify: async () => false };
    const result = await verifyCertFingerprint(verifier, 'nacos.example.com', 8848, 'SHA256:abc');
    expect(result).toBeInstanceOf(NacosApiError);
    expect(result?.kind).toBe('tls');
  });

  it('resolves a tls NacosApiError when no fingerprint was presented', async () => {
    const verifier: NacosCertVerifier = { verify: async () => true };
    const result = await verifyCertFingerprint(verifier, 'nacos.example.com', 8848, undefined);
    expect(result).toBeInstanceOf(NacosApiError);
    expect(result?.kind).toBe('tls');
  });

  it('propagates a rejecting verifier as a promise rejection', async () => {
    const verifier: NacosCertVerifier = {
      verify: async () => {
        throw new Error('store unavailable');
      }
    };
    await expect(verifyCertFingerprint(verifier, 'nacos.example.com', 8848, 'SHA256:abc')).rejects.toThrow(
      'store unavailable'
    );
  });
});
