import { NacosApiError } from '../NacosApiError';
import type { NacosHttpClient, NacosRawResponse, NacosRequestOptions } from '../NacosHttpClient';
import type { NacosAuthStrategy } from './NacosAuthStrategy';

/**
 * The two request surfaces everything above the HTTP client is written
 * against. Named here rather than inlined so the drivers, the probe and the
 * resolver can all be handed an authenticated client without knowing whether
 * it is the real `NacosHttpClient` or this wrapper around one.
 */
export type NacosAuthedRequests = Pick<NacosHttpClient, 'requestJson' | 'requestRaw'>;

/** Nacos's own auth failure. It never answers 401 -- see `NacosApiErrorKind`. */
const FORBIDDEN_STATUS = 403;

/** Either half of what one attempt can produce, so both can be inspected the same way. */
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Attaches the strategy's headers to every request and recovers from a single
 * HTTP 403 by refreshing the credential and retrying once.
 *
 * ## Why the retry belongs here and not in the strategy
 *
 * Only the caller of a request knows that it came back 403; only the strategy
 * knows whether that is recoverable. This wrapper is the one place both facts
 * meet, which is also why it is a free function over the two request methods
 * rather than a method on either collaborator.
 *
 * ## At most one retry
 *
 * A second 403 is returned or thrown as it stands. The credential was renewed
 * a moment ago, so the refusal is a permission problem rather than an expiry,
 * and every further attempt is one more entry in whatever lockout policy is
 * counting failed logins. This also keeps the worst case bounded at two
 * requests per call, which matters because `NacosCapabilityResolver` treats
 * `forbidden` as a reason to try the next driver: without the cap, one tree
 * expansion against a 3.x server could walk the chain retrying forever.
 *
 * ## `requestRaw` needs its own detection
 *
 * `requestJson` throws a classified `NacosApiError` on a non-2xx, but
 * `requestRaw` deliberately resolves with `{status, ok, ...}` for any status
 * -- its callers came for the status and the body. So a 403 there is a
 * returned value, and a `catch`-based retry would silently never fire. Both
 * shapes are checked. Every other non-2xx is left alone on both surfaces: a
 * 404 is the context-path probe's "try the next candidate" and a 410 is the
 * 3.x detector's evidence, and refreshing a credential neither of them
 * doubted would spend a login on nothing.
 *
 * ## Not the same as `testNacosConnection`'s `withAuthHeaders`
 *
 * That one attaches headers and never retries, on purpose: a rejected
 * credential is the answer the connection test was called to obtain. This one
 * serves a long-lived instance, where a 403 is usually a token that expired
 * mid-session.
 */
export function withAuth(http: NacosAuthedRequests, auth: NacosAuthStrategy): NacosAuthedRequests {
  /**
   * `authHeaders()` is resolved per attempt rather than once per wrapper: the
   * strategy caches its token internally, so this is free in the steady state
   * and is what lets the retry below pick up the renewed credential.
   *
   * A rejection from `authHeaders()` propagates untouched and un-retried,
   * which is what carries the `validation` message a server behind an external
   * identity provider produces -- and, above this layer, the plain `Error`
   * `createAuthStrategy` throws for `akSk`. Neither is a 403 to recover from;
   * both name the setting the user has to change.
   */
  const send = async <T>(
    attempt: (headers: Record<string, string>) => Promise<T>,
    isForbidden: (value: T) => boolean
  ): Promise<T> => {
    const headers = await auth.authHeaders();
    const first = await settle(() => attempt(headers));
    if (!wasForbidden(first, isForbidden)) {
      return unwrap(first);
    }
    // `false` means the strategy has nothing to renew -- `NoAuthStrategy` and
    // `CustomHeaderStrategy` both answer that way -- so a retry would repeat
    // the failure with the same credential.
    if (!(await auth.refresh())) {
      return unwrap(first);
    }
    return attempt(await auth.authHeaders());
  };

  return {
    async requestJson<T>(method: string, path: string, options: NacosRequestOptions = {}): Promise<T> {
      return send<T>(
        (headers) => http.requestJson<T>(method, path, withHeaders(options, headers)),
        // A resolved `requestJson` is a success by construction.
        () => false
      );
    },
    async requestRaw(method: string, path: string, options: NacosRequestOptions = {}): Promise<NacosRawResponse> {
      return send(
        (headers) => http.requestRaw(method, path, withHeaders(options, headers)),
        (response) => response.status === FORBIDDEN_STATUS
      );
    }
  };
}

function withHeaders(options: NacosRequestOptions, authHeaders: Record<string, string>): NacosRequestOptions {
  return { ...options, headers: mergeHeaders(authHeaders, options.headers) };
}

/**
 * The caller's headers win, matching both `NacosHttpClient` (which lets
 * `options.headers` override its own `accept`) and the connection test's
 * `withAuthHeaders`. The authentication headers are the ambient default: a
 * request that sets a header explicitly is the more specific instruction, and
 * a driver that has to send a credential of its own -- a console request
 * carrying a different token, say -- would otherwise have no way to.
 *
 * The comparison is case-insensitive because HTTP header names are. Merging by
 * exact key would put `Authorization` and `authorization` on the wire as two
 * headers and leave the server to pick one, which is not a decision this
 * wrapper gets to delegate. The caller's spelling is the one that survives.
 */
function mergeHeaders(
  authHeaders: Record<string, string>,
  callerHeaders: Record<string, string> | undefined
): Record<string, string> {
  if (callerHeaders === undefined) {
    return { ...authHeaders };
  }
  const claimed = new Set(Object.keys(callerHeaders).map((name) => name.toLowerCase()));
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(authHeaders)) {
    if (!claimed.has(name.toLowerCase())) {
      merged[name] = value;
    }
  }
  return { ...merged, ...callerHeaders };
}

/** Takes a thunk rather than a promise so a synchronous throw is captured too. */
async function settle<T>(work: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error };
  }
}

function wasForbidden<T>(outcome: Outcome<T>, isForbidden: (value: T) => boolean): boolean {
  return outcome.ok ? isForbidden(outcome.value) : isForbiddenError(outcome.error);
}

function isForbiddenError(error: unknown): boolean {
  return error instanceof NacosApiError && error.kind === 'forbidden';
}

function unwrap<T>(outcome: Outcome<T>): T {
  if (outcome.ok) {
    return outcome.value;
  }
  throw outcome.error;
}
