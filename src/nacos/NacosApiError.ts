export type NacosApiErrorKind =
  | 'network'
  | 'tls'
  /** HTTP 403 — Nacos's own auth failure or insufficient permission. Nacos never returns 401. */
  | 'forbidden'
  /** HTTP 401 — Nacos does not produce this; it means a reverse proxy or gateway is in front. */
  | 'gateway-auth'
  /** HTTP 404 — this version has no such endpoint (e.g. v1/v2 removed in 3.2+). */
  | 'not-found'
  /** HTTP 410 — Nacos 3.0/3.1 with the API compatibility switch turned off. */
  | 'api-deprecated'
  /** Any other non-2xx, or HTTP 200 whose body code reports a business failure. */
  | 'api-error'
  | 'invalid-response'
  /** Client-side validation that failed before any request was sent. */
  | 'validation'
  | 'response-too-large';

/** Error kinds that should make the resolver try the next driver. See the architecture doc §5.4. */
const FALL_THROUGH_KINDS: ReadonlySet<NacosApiErrorKind> = new Set([
  'not-found',
  'api-deprecated',
  'forbidden'
]);

export class NacosApiError extends Error {
  constructor(
    public readonly kind: NacosApiErrorKind,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'NacosApiError';
  }

  shouldFallThrough(): boolean {
    return FALL_THROUGH_KINDS.has(this.kind);
  }
}

/**
 * The `error.code` values Node raises when the peer's certificate chain fails
 * validation, as opposed to the connection itself failing. Kept verbatim from
 * at-grafana-series's `isTlsConnectionError`: the distinction is what lets the
 * UI say "trust this certificate?" instead of "the server is unreachable".
 */
const TLS_ERROR_CODES: ReadonlySet<string> = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
]);

function isTlsConnectionError(error: NodeJS.ErrnoException): boolean {
  return typeof error.code === 'string' && TLS_ERROR_CODES.has(error.code);
}

/**
 * Classifies a transport-level failure, i.e. one where no HTTP response ever
 * arrived. Neither kind falls through to the next driver: a driver chain
 * exists to find the endpoint this server version speaks, and an unreachable
 * or untrusted server answers no path at all.
 */
export function toNetworkOrTlsError(error: NodeJS.ErrnoException): NacosApiError {
  if (isTlsConnectionError(error)) {
    return new NacosApiError('tls', `Nacos TLS certificate is not trusted: ${error.message}`);
  }
  return new NacosApiError('network', error.message);
}

export function classifyHttpStatus(status: number): NacosApiErrorKind | undefined {
  if (status >= 200 && status < 300) {
    return undefined;
  }
  switch (status) {
    case 401:
      return 'gateway-auth';
    case 403:
      return 'forbidden';
    case 404:
      return 'not-found';
    case 410:
      return 'api-deprecated';
    default:
      return 'api-error';
  }
}
