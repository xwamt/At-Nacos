import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createNacosClient } from '../../src/extension';
import type { NacosInstanceConfig } from '../../src/config/schema';
import { NacosCertTrustStore, type CertTrustMemento } from '../../src/nacos/NacosCertTrustStore';
import { noopLog } from '../../src/utils/logger';
import { startTestHttpServer, type TestHttpServer } from '../nacos/testHttpServer';

class MemoryMemento implements CertTrustMemento {
  private readonly data = new Map<string, unknown>();

  get<T>(key: string, defaultValue: T): T {
    return (this.data.has(key) ? this.data.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

let server: TestHttpServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function instance(overrides: Partial<NacosInstanceConfig> = {}): NacosInstanceConfig {
  return {
    id: 'instance-1',
    label: 'prod',
    serverUrl: server?.origin ?? 'http://127.0.0.1:1',
    authMode: 'none',
    readOnly: false,
    allowBackgroundAccess: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  };
}

const secrets = {
  getPassword: async () => 'hunter2',
  getCustomHeaders: async () => ({ Authorization: 'Bearer pasted-token' })
};

function build(config: NacosInstanceConfig) {
  return createNacosClient(secrets, config, new NacosCertTrustStore(new MemoryMemento()), noopLog);
}

function json(response: ServerResponse, body: unknown): void {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}

/** A Nacos 3.x that answers the v3 state and namespace endpoints, and nothing else. */
function serveV3(request: IncomingMessage, response: ServerResponse): void {
  const path = (request.url ?? '').split('?')[0];
  if (path === '/v3/auth/user/login') {
    json(response, { accessToken: 'issued-token', tokenTtl: 18000 });
    return;
  }
  if (path === '/v3/admin/core/state') {
    json(response, { code: 0, data: { version: '3.0.1', startup_mode: 'standalone', auth_enabled: 'true' } });
    return;
  }
  if (path === '/v3/admin/core/namespace/list') {
    json(response, { code: 0, data: [{ namespace: 'public', namespaceShowName: 'public', type: 0 }] });
    return;
  }
  response.statusCode = 404;
  response.end('not found');
}

describe('createNacosClient', () => {
  it('probes the server and serves namespaces through the matching driver', async () => {
    server = await startTestHttpServer(serveV3);

    const client = await build(instance());

    expect(client.state).toMatchObject({ version: '3.0.1', majorVersion: 3, startupMode: 'standalone' });
    expect(await client.listNamespaces()).toEqual([
      { namespaceId: 'public', displayName: 'public', description: undefined, quota: undefined, configCount: undefined, type: 0 }
    ]);
  });

  it('logs in once and carries the token on the probe and on the data request', async () => {
    server = await startTestHttpServer(serveV3);

    const client = await build(instance({ authMode: 'userPassword', username: 'nacos' }));
    await client.listNamespaces();

    const paths = server.requests.map((request) => (request.url ?? '').split('?')[0]);
    expect(paths).toEqual(['/v3/auth/user/login', '/v3/admin/core/state', '/v3/admin/core/namespace/list']);
    // The probe is inside the authenticated wrapper: a secured Nacos refuses
    // `/state` too, and an unauthenticated probe would report the server as
    // unreachable before any driver was chosen.
    expect(server.requests.slice(1).map((request) => request.headers.authorization)).toEqual([
      'Bearer issued-token',
      'Bearer issued-token'
    ]);
  });

  it('sends the stored custom headers', async () => {
    server = await startTestHttpServer(serveV3);

    await build(instance({ authMode: 'customHeader' }));

    expect(server.requests[0]?.headers.authorization).toBe('Bearer pasted-token');
  });

  it('falls back to the 1.x state endpoint and builds a v1-only chain', async () => {
    server = await startTestHttpServer((request, response) => {
      const path = (request.url ?? '').split('?')[0];
      if (path === '/nacos/v1/console/server/state') {
        json(response, { version: '1.4.2', standalone_mode: 'cluster' });
        return;
      }
      if (path === '/nacos/v1/console/namespaces') {
        json(response, { code: 200, data: [{ namespace: '', namespaceShowName: 'public', type: 0 }] });
        return;
      }
      response.statusCode = 404;
      response.end('not found');
    });

    const client = await build(instance({ serverUrl: `${server.origin}/nacos` }));

    expect(client.state).toMatchObject({ version: '1.4.2', majorVersion: 1, startupMode: 'cluster' });
    expect((await client.listNamespaces())[0]).toMatchObject({ namespaceId: '', displayName: 'public' });
    // No v3 endpoint is attempted for the namespace list: `buildDriverChain`
    // leaves out what a 1.x server cannot have.
    expect(server.requests.map((request) => (request.url ?? '').split('?')[0])).toEqual([
      '/nacos/v3/admin/core/state',
      '/nacos/v1/console/server/state',
      '/nacos/v1/console/namespaces'
    ]);
  });

  it('refuses an akSk instance before it opens a connection', async () => {
    server = await startTestHttpServer(serveV3);

    await expect(build(instance({ authMode: 'akSk' }))).rejects.toThrow(/AK\/SK authentication is not implemented/);

    expect(server.requests).toHaveLength(0);
  });

  it('surfaces an unreachable server as a network failure', async () => {
    // No server: the port is closed for the duration of this test.
    await expect(build(instance({ serverUrl: 'http://127.0.0.1:1/nacos' }))).rejects.toMatchObject({
      kind: 'network'
    });
  });
});
