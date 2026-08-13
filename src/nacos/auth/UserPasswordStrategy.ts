import { NacosApiError } from '../NacosApiError';
import type { NacosHttpClient, NacosRequestOptions } from '../NacosHttpClient';
import type { NacosAuthStrategy } from './NacosAuthStrategy';

const LOGIN_V3_PATH = '/v3/auth/user/login';
/** Nacos 1.x/2.x, which 3.0 through 3.2 still keep alive for older clients. */
const LOGIN_V1_PATH = '/v1/auth/login';
/** Re-login once the token has spent this fraction of its TTL. */
const REFRESH_RATIO = 0.8;
/** Applied when the server reports no usable tokenTtl; 18000s is the Nacos default. */
const DEFAULT_TTL_SECONDS = 18_000;

/**
 * The only two statuses that mean "this server has no v3 login": 404 from a
 * Nacos older than 3.x, and 501 from a proxy that refuses the route. This
 * mirrors the official Java client's HttpLoginProcessor. Nothing else falls
 * back, and a 403 least of all -- bad credentials fail identically on v1, so
 * retrying there would only double the failed-login count that an account
 * lockout policy is counting.
 */
const MISSING_ENDPOINT_STATUSES: ReadonlySet<number> = new Set([404, 501]);

export interface NacosCredentials {
  username: string;
  password: string;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

/** Straight off JSON.parse, so every field has to be checked at runtime rather than declared. */
interface LoginResponse {
  accessToken?: unknown;
  tokenTtl?: unknown;
}

export class UserPasswordStrategy implements NacosAuthStrategy {
  private cached: CachedToken | undefined;
  private inFlight: Promise<CachedToken> | undefined;

  constructor(
    private readonly http: Pick<NacosHttpClient, 'requestJson'>,
    private readonly loadCredentials: () => Promise<NacosCredentials>
  ) {}

  async authHeaders(): Promise<Record<string, string>> {
    const token = await this.token();
    return { authorization: `Bearer ${token.accessToken}` };
  }

  /**
   * Discarding the cached token is the whole job; the next `authHeaders()`
   * performs the login. That is what keeps a wave of 403s cheap -- a tree
   * expansion has many requests in flight with the same expired token, and
   * `token()`'s dedupe collapses all of their retries into one login.
   */
  async refresh(): Promise<boolean> {
    this.cached = undefined;
    return true;
  }

  private async token(): Promise<CachedToken> {
    const cached = this.cached;
    if (cached && Date.now() < cached.expiresAtMs) {
      return cached;
    }
    // Expanding a tree asks many nodes for headers at the same moment; without
    // this each would open a login round trip of its own.
    if (!this.inFlight) {
      // The slot is cleared on rejection as well as fulfilment. A promise left
      // behind by a failed login would be replayed as an already-settled
      // rejection for the rest of the session, turning one network blip into a
      // permanently broken instance.
      this.inFlight = this.login().finally(() => {
        this.inFlight = undefined;
      });
    }
    const token = await this.inFlight;
    this.cached = token;
    return token;
  }

  private async login(): Promise<CachedToken> {
    const credentials = await this.loadCredentials();
    // Username in the query, password in the form body. Both are Spring
    // @RequestParam so Nacos accepts the split, and it is what the official
    // Java client sends -- Tomcat's access log is enabled by default and
    // records the query string, which is no place for a password.
    const options: NacosRequestOptions = {
      query: { username: credentials.username },
      form: { password: credentials.password }
    };

    let response: LoginResponse;
    try {
      response = await this.http.requestJson<LoginResponse>('POST', LOGIN_V3_PATH, options);
    } catch (error) {
      if (!isMissingEndpoint(error)) {
        throw toFriendlyLoginError(error);
      }
      response = await this.http
        .requestJson<LoginResponse>('POST', LOGIN_V1_PATH, options)
        .catch((v1Error: unknown) => {
          throw toFriendlyLoginError(v1Error);
        });
    }

    // requestJson yields undefined for an empty body, so the response object
    // itself may be missing.
    const accessToken = response?.accessToken;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new NacosApiError('invalid-response', 'Nacos login did not return an accessToken.');
    }
    return {
      accessToken,
      expiresAtMs: Date.now() + toTtlSeconds(response.tokenTtl) * REFRESH_RATIO * 1000
    };
  }
}

/**
 * `tokenTtl` is advisory. A server that reports 0 -- or a negative, or
 * something that is not a number at all -- has told us nothing usable, and
 * read literally it says the token expired the instant it arrived, so every
 * single request would open a fresh login: a storm of BCrypt password checks
 * for the server, and a pattern any lockout policy reads as credential
 * stuffing. The authoritative expiry signal is the 403, which the caller
 * already recovers from by refreshing and retrying once. Assuming the Nacos
 * default therefore costs at most one wasted round trip, where the literal
 * reading costs a login on every request forever.
 */
function toTtlSeconds(tokenTtl: unknown): number {
  return typeof tokenTtl === 'number' && Number.isFinite(tokenTtl) && tokenTtl > 0 ? tokenTtl : DEFAULT_TTL_SECONDS;
}

function isMissingEndpoint(error: unknown): boolean {
  return error instanceof NacosApiError && error.status !== undefined && MISSING_ENDPOINT_STATUSES.has(error.status);
}

/**
 * A Nacos wired to an external identity provider rejects the login endpoint
 * itself, wording it the same way on v1 and v3, which is why both paths run
 * through here. The test reads the message rather than the status because the
 * rejection arrives either as HTTP 200 carrying a business code or as a 403 --
 * and the 403 form is the one that needs rescuing, since `forbidden` sends the
 * driver chain off to try other API versions that all fail identically,
 * instead of surfacing the one thing that fixes it. `validation` does not fall
 * through.
 *
 * The apostrophe is ASCII in the Java source; the typographic one is allowed
 * in case something between us and Nacos rewrites the body.
 */
function toFriendlyLoginError(error: unknown): unknown {
  if (error instanceof NacosApiError && /don['’]t support login API/i.test(error.message)) {
    return new NacosApiError(
      'validation',
      'This Nacos server uses an external identity provider (OIDC/LDAP plugin) and does not accept username/password login. Switch the instance to "Custom headers" and paste a bearer token issued by your IdP.'
    );
  }
  return error;
}
