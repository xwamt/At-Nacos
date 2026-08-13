import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

export interface TestHttpServer {
  origin: string;
  requests: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }[];
  close(): Promise<void>;
}

export type TestRequestHandler = (request: IncomingMessage, response: ServerResponse, body: string) => void;

export async function startTestHttpServer(handler: TestRequestHandler): Promise<TestHttpServer> {
  const requests: TestHttpServer['requests'] = [];
  const server: Server = createServer(recordThen(requests, handler));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => closeServer(server)
  };
}

export interface TestHttpsServer extends TestHttpServer {
  /**
   * Accepted TCP connections, so a test can tell "never connected" from
   * "connected but sent nothing". Deliberately not `secureConnection`: a
   * client that walks away right after its own handshake completes leaves the
   * server still waiting on the TLS 1.3 client Finished, so the server only
   * ever reports a `tlsClientError` for exactly the case worth asserting on.
   */
  connections: number;
  /** The SHA-256 fingerprint the server presents, in Node's colon-separated uppercase-hex form. */
  fingerprint256: string;
}

/**
 * Serves the throwaway self-signed certificate in `fixtures/`, which is the
 * only way to exercise the Trust-On-First-Use path end to end: with a
 * publicly-trusted certificate, Node's own chain validation would succeed and
 * the tests could not tell whether the fingerprint check ran at all.
 */
export async function startTestHttpsServer(handler: TestRequestHandler): Promise<TestHttpsServer> {
  const requests: TestHttpServer['requests'] = [];
  const cert = readFixture('selfsigned-test.cert.pem');
  const server: HttpsServer = createHttpsServer(
    { key: readFixture('selfsigned-test.key.pem'), cert },
    recordThen(requests, handler)
  );
  const state = { connections: 0 };
  server.on('connection', () => {
    state.connections += 1;
  });
  // A client that refuses the certificate aborts the handshake; without this
  // the server emits an unhandled 'tlsClientError' and fails the run.
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `https://127.0.0.1:${port}`,
    requests,
    get connections() {
      return state.connections;
    },
    fingerprint256: new X509Certificate(cert).fingerprint256,
    close: () => closeServer(server)
  };
}

function recordThen(
  requests: TestHttpServer['requests'],
  handler: TestRequestHandler
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        headers: request.headers,
        body
      });
      handler(request, response, body);
    });
  };
}

/**
 * Node's global agent keeps connections alive, so a bare `close()` would wait
 * on sockets no test is still using.
 */
function closeServer(server: Server | HttpsServer): Promise<void> {
  server.closeAllConnections();
  return new Promise<void>((done) => server.close(() => done()));
}

function readFixture(name: string): string {
  // Anchored on `process.cwd()` the way test/i18n/nls.test.ts is: these
  // sources compile as CommonJS, where `import.meta.url` is not allowed.
  return readFileSync(resolve(process.cwd(), 'test/nacos/fixtures', name), 'utf8');
}
