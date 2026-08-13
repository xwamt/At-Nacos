import { isRecord } from './jsonGuards';

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
  /**
   * The request as configured cannot succeed, so retrying it or trying another
   * API version would only repeat the failure. Usually a client-side check
   * that ran before anything was sent, but also the shape of a server refusal
   * that is really a misconfiguration -- an OIDC deployment rejecting
   * username/password login answers 403, and reclassifying it here is what
   * stops the driver chain from walking every API version to be told the same
   * thing. Reads to the user as "fix your instance settings".
   */
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

/**
 * Turns the classification into one sentence that points at the next action.
 *
 * The three Nacos-specific statuses each need their own wording because they
 * lead somewhere different: 410 is a server-side switch an administrator can
 * flip, 404 is a version that never had the endpoint, and 401 is not Nacos
 * answering at all.
 */
export function describeFailure(
  kind: NacosApiErrorKind,
  status: number,
  text: string,
  target: URL
): string {
  const detail = extractErrorMessage(text);
  switch (kind) {
    case 'api-deprecated':
      return `Nacos rejected ${target.pathname} as a deprecated API (HTTP 410). This server is Nacos 3.0/3.1 with the v1/v2 compatibility switch turned off.`;
    case 'not-found':
      return `Nacos has no endpoint at ${target.pathname} (HTTP 404).`;
    case 'forbidden':
      return `Nacos denied the request to ${target.pathname} (HTTP 403)${detail ? `: ${detail}` : '. The credential may be expired, or the account may lack permission for this API.'}`;
    case 'gateway-auth':
      return `Something in front of Nacos returned HTTP 401 for ${target.pathname}. Nacos itself never answers 401, so check the reverse proxy or gateway.`;
    default:
      return `Nacos returned HTTP ${status} for ${target.pathname}${detail ? `: ${detail}` : '.'}`;
  }
}

/** v2/v3 error bodies are `{code,message,data}`; 1.x often sends bare text. */
function extractErrorMessage(text: string): string | undefined {
  if (text.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.message === 'string' && parsed.message.length > 0) {
      return parsed.message;
    }
  } catch {
    // A non-JSON body: 1.x's plain-text errors, or Spring's 410 error page.
    // Truncating and passing it through beats dropping it.
    return text.slice(0, 200);
  }
  return undefined;
}
