import * as http from 'node:http';
import * as https from 'node:https';
import type { TLSSocket } from 'node:tls';
import { asRedactedLog, type AtNacosLog } from '../utils/logger';
import { classifyHttpStatus, describeFailure, NacosApiError, toNetworkOrTlsError } from './NacosApiError';
import type { NacosCertVerifier } from './NacosCertTrustStore';
import { isRecord } from './jsonGuards';

export type { NacosCertVerifier } from './NacosCertTrustStore';

export interface NacosHttpClientOptions {
  baseUrl: string;
  certVerifier?: NacosCertVerifier;
  timeoutMs?: number;
  /**
   * Diagnostics only. The classified kind and status are what separate "this
   * version has no such endpoint" from "your token expired" from "Nacos is
   * down", so they go to the channel at `debug`.
   */
  log?: AtNacosLog;
}

export interface NacosRequestOptions {
  query?: Record<string, string | undefined>;
  /** JSON request body. Mutually exclusive with `form`. */
  body?: unknown;
  /** application/x-www-form-urlencoded request body. Mutually exclusive with `body`. */
  form?: Record<string, string>;
  /**
   * Per-request headers, which is where authorization belongs: the Nacos JWT
   * is re-issued during a session, so freezing it into the client instance
   * would pin every later request to a token that has already expired.
   */
  headers?: Record<string, string>;
  /** Abort and throw `response-too-large` once the body passes this many bytes. */
  maxResponseBytes?: number;
  /** Overrides `baseUrl`, for the separate console origin a Nacos 3.x deployment exposes. */
  baseUrlOverride?: string;
}

/**
 * What the wire actually said. `requestRaw` deliberately does not throw on a
 * non-2xx: its callers are the ones that need the status *and* the body of a
 * failure — the context-path probe reads a 404 as "try the next candidate",
 * and the 3.x detector has to read the body of a 410. Throwing would destroy
 * exactly the information they came for. `ok` exists so that a caller cannot
 * mistake an error page for content without ignoring a field in plain sight.
 */
export interface NacosRawResponse {
  status: number;
  ok: boolean;
  text: string;
  contentType: string | undefined;
}

interface RequestPayload {
  text: string;
  contentType: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Nacos's two success codes: v2/v3 use 0, and 1.x's RestResult uses an HTTP-style 200. */
const SUCCESS_CODES: ReadonlySet<number> = new Set([0, 200]);

/**
 * Reduces an address to the part that can serve as a base for relative paths.
 *
 * A base URL exists to be extended, and `new URL('v3/x', 'http://h/nacos?q=1/')`
 * resolves to `http://h/v3/x` -- the context path is gone and the request
 * silently lands somewhere the API is not. A fragment does the same. Neither
 * can be carried onto a sub-path anyway, so removing them loses nothing that
 * could have worked.
 *
 * This lives here, at the one place every request funnels through, rather than
 * in the address parsing further up: an instance's stored `serverUrl` is
 * handed to this constructor directly, without passing `candidateBaseUrls`
 * first, so a URL saved with a fragment would break every request the tree
 * makes while the connection test that vetted it reported success.
 *
 * The cut is textual rather than a `URL` round trip so that an address is
 * otherwise returned exactly as it was written.
 */
export function normalizeBaseUrl(input: string): string {
  return input.trim().replace(/[?#][\s\S]*$/, '').replace(/\/+$/, '');
}

/**
 * Thin wrapper around node:http/node:https carrying the trickiest, most
 * security-sensitive logic in this client. When no certVerifier is supplied
 * this behaves exactly like a normal https client (Node's default chain
 * validation applies). When a certVerifier IS supplied, Node's own chain
 * validation is disabled (`rejectUnauthorized: false`) and trust is delegated
 * entirely to the verifier's fingerprint check — this mirrors the
 * SSH-host-key-style TOFU model (a known-fingerprint check, not "is this a
 * publicly trusted CA") used elsewhere in this codebase
 * (NacosCertTrustStore), rather than layering both checks, which would make
 * the self-signed and private-CA certificates typical of an internal Nacos
 * impossible to trust at all.
 *
 * Carries no credential of its own: auth headers arrive per request.
 */
export class NacosHttpClient {
  private readonly baseUrl: string;
  private readonly log: AtNacosLog;

  constructor(private readonly options: NacosHttpClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.log = asRedactedLog(options.log);
  }

  async requestJson<T>(method: string, path: string, requestOptions: NacosRequestOptions = {}): Promise<T> {
    let target: URL | undefined;
    try {
      const prepared = this.prepare(path, requestOptions);
      target = prepared.target;
      const { status, text } = await this.performRequest(
        target,
        method,
        prepared.payload,
        requestOptions,
        'application/json'
      );
      return parseJsonResponse<T>(status, text, target);
    } catch (error) {
      this.logClassifiedFailure(method, target?.pathname ?? path, error);
      throw error;
    }
  }

  /**
   * The unparsed response. Nacos 1.x answers `GET /v1/cs/configs` with the
   * configuration content as plain text and no JSON envelope, so `requestJson`
   * would reject perfectly good content as `invalid-response`.
   */
  async requestRaw(method: string, path: string, requestOptions: NacosRequestOptions = {}): Promise<NacosRawResponse> {
    let target: URL | undefined;
    try {
      const prepared = this.prepare(path, requestOptions);
      target = prepared.target;
      return await this.performRequest(target, method, prepared.payload, requestOptions, '*/*');
    } catch (error) {
      this.logClassifiedFailure(method, target?.pathname ?? path, error);
      throw error;
    }
  }

  /** Everything that can fail before a socket is opened. */
  private prepare(path: string, options: NacosRequestOptions): { target: URL; payload: RequestPayload | undefined } {
    if (options.body !== undefined && options.form !== undefined) {
      throw new NacosApiError(
        'validation',
        `A Nacos request to ${path} supplied both a JSON body and a form body; exactly one encoding can win, so neither is assumed.`
      );
    }
    let target: URL;
    try {
      target = this.buildUrl(path, options);
    } catch {
      throw new NacosApiError('validation', `Invalid Nacos request URL for path ${path}.`);
    }
    return { target, payload: toPayload(options) };
  }

  private buildUrl(path: string, options: NacosRequestOptions): URL {
    const base = normalizeBaseUrl(options.baseUrlOverride ?? this.baseUrl);
    // The leading slash has to go: as an absolute path it would replace the
    // context path (`/nacos`) that the base URL carries rather than extend it.
    const target = new URL(path.replace(/^\/+/, ''), `${base}/`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) {
          target.searchParams.set(key, value);
        }
      }
    }
    return target;
  }

  /**
   * Only the classification and the path reach the channel — never the query
   * string or the body, either of which can carry a credential on the login
   * path.
   */
  private logClassifiedFailure(method: string, path: string, error: unknown): void {
    if (error instanceof NacosApiError) {
      const detail = error.status === undefined ? `kind=${error.kind}` : `kind=${error.kind}, status=${error.status}`;
      this.log.debug(`nacos-api: ${method} ${path} failed (${detail})`);
      return;
    }
    this.log.debug(`nacos-api: ${method} ${path} failed with an unclassified error: ${String(error)}`);
  }

  private performRequest(
    target: URL,
    method: string,
    payload: RequestPayload | undefined,
    options: NacosRequestOptions,
    defaultAccept: string
  ): Promise<NacosRawResponse> {
    const maxResponseBytes = options.maxResponseBytes;
    return new Promise((resolve, reject) => {
      // Guards against the size-cap abort path below racing a subsequent
      // 'error'/'end' event on the same response/request (destroying a
      // stream doesn't guarantee no further events fire) -- settle exactly
      // once no matter which path gets there first.
      let settled = false;
      const settleResolve = (value: NacosRawResponse) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      const settleReject = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };

      const isHttps = target.protocol === 'https:';
      const client: typeof http | typeof https = isHttps ? https : http;
      const headers: Record<string, string> = { accept: defaultAccept, ...options.headers };
      if (payload) {
        headers['content-type'] = payload.contentType;
        headers['content-length'] = Buffer.byteLength(payload.text).toString();
      }

      const certVerifier = this.options.certVerifier;
      const usesCertVerifier = isHttps && Boolean(certVerifier);

      const request = client.request(
        target,
        {
          method,
          headers,
          timeout: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          rejectUnauthorized: usesCertVerifier ? false : undefined
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer | string) => {
            if (settled) {
              return;
            }
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buf.length;
            if (maxResponseBytes !== undefined && size > maxResponseBytes) {
              // Stop reading now rather than buffering the rest of a response
              // we already know is over the cap. `response.destroy()` with no
              // argument tears down the stream without emitting its own
              // 'error' event, so this is the only place that settles the
              // promise for this path.
              settleReject(
                new NacosApiError(
                  'response-too-large',
                  `The Nacos response for ${target.pathname} exceeded the configured maximum of ${maxResponseBytes} bytes; aborted before buffering the full body.`
                )
              );
              response.destroy();
              return;
            }
            chunks.push(buf);
          });
          response.on('end', () => {
            const status = response.statusCode ?? 0;
            settleResolve({
              status,
              ok: classifyHttpStatus(status) === undefined,
              text: Buffer.concat(chunks).toString('utf8'),
              contentType: response.headers['content-type']
            });
          });
          response.on('error', (error: NodeJS.ErrnoException) => settleReject(toNetworkOrTlsError(error)));
        }
      );

      request.on('timeout', () => {
        request.destroy(new NacosApiError('network', `The request to Nacos timed out: ${target.pathname}`));
      });

      request.on('error', (error) => {
        settleReject(error instanceof NacosApiError ? error : toNetworkOrTlsError(error as NodeJS.ErrnoException));
      });

      if (usesCertVerifier && certVerifier) {
        // Deferred write: nothing leaves the process until verify() settles.
        attachCertVerification(request, target.hostname, portOf(target), certVerifier, {
          onVerified: () => writeAndEnd(request, payload),
          onRejected: (error) => request.destroy(error)
        });
        return;
      }

      writeAndEnd(request, payload);
    });
  }
}

export interface CertVerificationHooks {
  onVerified(): void;
  onRejected(error: NacosApiError): void;
}

/**
 * Defers `onVerified` until the certVerifier's TOFU fingerprint check settles
 * (mirroring the SSH-host-key confirmation flow). Exported standalone so this
 * security-sensitive wiring exists in exactly one place.
 *
 * The check runs per *request*, not per connection, which is why the socket
 * has to be inspected rather than simply hooked. Node's agents keep HTTPS
 * sockets alive (the default since Node 19), so every request after the first
 * to a given origin is handed a socket whose handshake finished during an
 * earlier one: `secureConnect` has already fired and never fires again.
 * Waiting for it there would leave the request written to nobody until the
 * timeout -- and on this client the second request is not an edge case, it is
 * the namespace listing that follows the version probe.
 */
export function attachCertVerification(
  request: http.ClientRequest,
  host: string,
  port: number,
  certVerifier: NacosCertVerifier,
  hooks: CertVerificationHooks
): void {
  request.on('socket', (socket) => {
    const tlsSocket = socket as TLSSocket;
    const verify = (): void => {
      const fingerprint256 = tlsSocket.getPeerCertificate()?.fingerprint256;
      verifyCertFingerprint(certVerifier, host, port, fingerprint256)
        .then((verifyError) => {
          if (verifyError) {
            hooks.onRejected(verifyError);
            return;
          }
          hooks.onVerified();
        })
        .catch((error: unknown) => {
          hooks.onRejected(
            new NacosApiError(
              'tls',
              `Nacos TLS certificate verification failed: ${error instanceof Error ? error.message : String(error)}`
            )
          );
        });
    };

    if (hasCompletedHandshake(tlsSocket)) {
      verify();
      return;
    }
    tlsSocket.once('secureConnect', verify);
  });
}

/**
 * Whether this socket has already presented its certificate, i.e. it came out
 * of the agent's pool rather than being dialled for this request.
 *
 * Read from the certificate itself rather than from a connection flag: a
 * socket still handshaking answers with an empty object, and one with no
 * handle answers null, so the same expression that decides "is the handshake
 * done" is the one that would supply the fingerprint. Nothing can be
 * mistakenly treated as verified -- a false positive here would still have to
 * produce a fingerprint the verifier accepts.
 */
function hasCompletedHandshake(socket: TLSSocket): boolean {
  return typeof socket.getPeerCertificate === 'function' && Boolean(socket.getPeerCertificate()?.fingerprint256);
}

/**
 * Exported standalone so the fingerprint-classification logic is unit-testable
 * without a real TLS handshake.
 */
export async function verifyCertFingerprint(
  verifier: NacosCertVerifier,
  host: string,
  port: number,
  fingerprint256: string | undefined
): Promise<NacosApiError | undefined> {
  if (!fingerprint256) {
    return new NacosApiError('tls', `The Nacos TLS certificate for ${host}:${port} did not present a fingerprint.`);
  }
  const trusted = await verifier.verify(host, port, fingerprint256);
  return trusted
    ? undefined
    : new NacosApiError('tls', `The Nacos TLS certificate for ${host}:${port} was rejected by the certificate verifier.`);
}

function toPayload(options: NacosRequestOptions): RequestPayload | undefined {
  if (options.form !== undefined) {
    // URLSearchParams percent-encodes each value, so a password containing
    // `&`, `=` or `+` cannot break out of its field.
    return { text: new URLSearchParams(options.form).toString(), contentType: 'application/x-www-form-urlencoded' };
  }
  if (options.body !== undefined) {
    return { text: JSON.stringify(options.body), contentType: 'application/json' };
  }
  return undefined;
}

function writeAndEnd(request: http.ClientRequest, payload: RequestPayload | undefined): void {
  if (payload) {
    request.write(payload.text);
  }
  request.end();
}

function portOf(target: URL): number {
  if (target.port) {
    return Number(target.port);
  }
  return target.protocol === 'https:' ? 443 : 80;
}

function parseJsonResponse<T>(status: number, text: string, target: URL): T {
  const kind = classifyHttpStatus(status);
  if (kind !== undefined) {
    throw new NacosApiError(kind, describeFailure(kind, status, text, target), status);
  }
  if (text.length === 0) {
    return undefined as T;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new NacosApiError('invalid-response', `Nacos returned a non-JSON response for ${target.pathname}.`);
  }
  // Some 1.x endpoints still answer HTTP 200 on a business failure, with the
  // error hidden in body.code. This deliberately does not trigger driver
  // fall-through -- another version's path would fail the same way, so
  // retrying it only costs a round trip.
  if (isRecord(parsed) && typeof parsed.code === 'number' && !SUCCESS_CODES.has(parsed.code)) {
    const message = typeof parsed.message === 'string' ? parsed.message : 'unknown error';
    throw new NacosApiError(
      'api-error',
      `Nacos returned code ${parsed.code} for ${target.pathname}: ${message}`,
      status
    );
  }
  return parsed as T;
}

