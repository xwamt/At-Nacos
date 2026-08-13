import type { NacosAuthMode, NacosInstanceConfig } from '../config/schema';
import { formatError } from '../utils/errors';
import { asRedactedLog, type AtNacosLog } from '../utils/logger';
import { NacosApiError, type NacosApiErrorKind } from './NacosApiError';
import type { NacosCertVerifier } from './NacosCertTrustStore';
import {
  NacosHttpClient,
  normalizeBaseUrl,
  type NacosRawResponse,
  type NacosRequestOptions
} from './NacosHttpClient';
import type { NacosAuthStrategy } from './auth/NacosAuthStrategy';
import { createAuthStrategy } from './auth/createAuthStrategy';
import { probeServerState, type NacosServerState } from './probe/probeServerState';
import { candidateBaseUrls, fetchConsoleHint, type NacosConsoleHint } from './probe/resolveBaseUrl';

/**
 * The part of the instance form that changes what goes on the wire. The label
 * and the read-only and background-access flags are deliberately absent: they
 * decide how the instance is displayed and what the user may do with it, none
 * of which a server can accept or refuse.
 *
 * The password arrives here as a value rather than as an id to look up. What
 * the user is testing is usually a password they have just typed and not yet
 * saved, so SecretStorage either has nothing under this instance's id or, on
 * an edit, still has the old one -- and testing the old password while the
 * form shows a new one is worse than not testing at all.
 */
export interface NacosConnectionTestInput {
  serverUrl: string;
  /** Supplied by the user. Left unset, a Nacos 3.x server is asked where its console is. */
  consoleUrl?: string;
  authMode: NacosAuthMode;
  username?: string;
  password?: string;
  customHeaders?: Record<string, string>;
}

/**
 * Wiring, all of it optional. `probe` and `consoleHint` are seams: the
 * defaults below are the production path, and every test that does not supply
 * them exercises that path against a real server.
 */
export interface NacosConnectionTestDependencies {
  certVerifier?: NacosCertVerifier;
  timeoutMs?: number;
  log?: AtNacosLog;
  probe?: (context: NacosProbeContext) => Promise<NacosServerState>;
  consoleHint?: (context: NacosProbeContext) => Promise<NacosConsoleHint | undefined>;
}

export interface NacosProbeContext {
  baseUrl: string;
}

export type NacosConnectionTestOptions = NacosConnectionTestInput & NacosConnectionTestDependencies;

/**
 * What the user has to go and fix. Coarser than `NacosApiErrorKind` on
 * purpose: this names a field of the form (or the world outside it), so that
 * the form can point at one without reading prose.
 */
export type NacosConnectionFailureReason =
  /** The credentials the form carries. */
  | 'auth'
  /** Something in front of Nacos, which the Nacos credentials cannot satisfy. */
  | 'gateway'
  /** The host and port, or whatever sits between here and them. */
  | 'network'
  /** The server's certificate. */
  | 'tls'
  /** The server URL, most often its context path. */
  | 'address'
  /** An instance setting other than the address, such as the authentication mode. */
  | 'config'
  /** Nothing in the form: Nacos or its proxy answered with a failure of its own. */
  | 'error';

export interface NacosConnectionTestSuccess {
  ok: true;
  message: string;
  /** The candidate that answered, which is not always what the user typed. */
  baseUrl: string;
  version: string;
  majorVersion: number;
  startupMode: NacosServerState['startupMode'];
  /** `nacos.core.auth.enabled`, so the form can warn about an anonymous connection to a secured server. */
  authEnabled: boolean;
  consoleUrl?: string;
}

export interface NacosConnectionTestFailure {
  ok: false;
  message: string;
  reason: NacosConnectionFailureReason;
  /** The underlying classification, for the output channel rather than the user. */
  kind?: NacosApiErrorKind;
  status?: number;
  triedBaseUrls: string[];
}

/**
 * Discriminated on `ok`, but with `message` on both sides: the form renders
 * one sentence either way, and a success that cannot say what it found is not
 * worth reporting.
 */
export type NacosConnectionTestResult = NacosConnectionTestSuccess | NacosConnectionTestFailure;

/** Nacos 3.x is the first version to serve its console from a port of its own. */
const CONSOLE_MAJOR_VERSION = 3;

/**
 * Probes a Nacos server with the settings a form is holding, without saving
 * anything, and always resolves: a connection test that throws has failed to
 * do the one thing it exists for.
 *
 * Messages come back in English and unformatted. Localizing them is the
 * caller's job, which is also why the structured fields duplicate everything
 * the prose says.
 */
export async function testNacosConnection(options: NacosConnectionTestOptions): Promise<NacosConnectionTestResult> {
  const result = await runConnectionTest(options);
  // The host, never the base URL: an address the user typed can carry
  // userinfo, and this line goes to the output channel.
  const outcome = result.ok
    ? `connected to Nacos ${result.version} at ${hostOf(result.baseUrl)}`
    : `failed (reason=${result.reason}, kind=${result.kind ?? 'none'})`;
  asRedactedLog(options.log).debug(`nacos-connection-test: ${outcome}`);
  return result;
}

async function runConnectionTest(options: NacosConnectionTestOptions): Promise<NacosConnectionTestResult> {
  let candidates: string[];
  try {
    candidates = candidateBaseUrls(options.serverUrl);
  } catch (error) {
    // Nothing was sent, so there is no candidate to name in the failure.
    return toFailure({ baseUrl: undefined, error }, [], options);
  }

  const probes = resolveProbes(options);
  const attempted: string[] = [];
  let reported: CandidateFailure | undefined;

  for (const baseUrl of candidates) {
    attempted.push(baseUrl);
    try {
      const state = await probes.probe({ baseUrl });
      return await toSuccess(baseUrl, state, probes, options);
    } catch (error) {
      // Strictly greater, so a tie leaves the earlier candidate in place --
      // `/nacos` is the conventional deployment and the likelier thing the
      // user meant.
      if (reported === undefined || informativeness(error) > informativeness(reported.error)) {
        reported = { baseUrl, error };
      }
      if (!canAnotherCandidateHelp(error)) {
        break;
      }
    }
  }

  return toFailure(reported, attempted, options);
}

interface CandidateFailure {
  /** Unset only for a failure raised before any candidate existed. */
  baseUrl: string | undefined;
  error: unknown;
}

/**
 * Whether trying the next base URL could produce a different answer.
 *
 * Every candidate shares a host and a port, so they are all the same server:
 * only a failure that says "the Nacos API did not process this request" can be
 * cured by a different path. A 404 is that signal -- `probeServerState`
 * deliberately preserves the kind for this walk -- and so is a body that is
 * not an API response, which is what an ingress that rewrites unknown paths to
 * the console SPA produces.
 *
 * Everything else stops here, and the two reasons are worth separating. A
 * network or TLS failure repeats identically and costs a full timeout to
 * confirm, which the user spends staring at a button; the default is 15
 * seconds, so continuing would double the wait for one answer. A 403 repeats
 * identically too, but the cost is worse than time: for the userPassword mode
 * each candidate is a login, and a second rejected login is a second entry in
 * whatever lockout policy is counting them.
 */
const RETRYABLE_ON_ANOTHER_PATH: ReadonlySet<NacosApiErrorKind> = new Set([
  'not-found',
  'invalid-response',
  'response-too-large'
]);

function canAnotherCandidateHelp(error: unknown): boolean {
  return error instanceof NacosApiError && RETRYABLE_ON_ANOTHER_PATH.has(error.kind);
}

/**
 * How much a failure tells the user about what to fix, used to pick which one
 * to report when several candidates failed.
 *
 * Taking the last failure is wrong in the case this ranking exists for: with
 * `/nacos` answering 404 and the bare origin answering with a non-Nacos body,
 * the last word would be "no Nacos API answered", sending the user to correct
 * a context path that was never the problem. "Nothing is here" is the weakest
 * thing a candidate can say, so it loses to everything.
 *
 * The kinds that stop the walk outright rank highest, which costs nothing --
 * they are always the last failure recorded -- but keeps the ordering honest
 * if the walk rule ever changes.
 */
function informativeness(error: unknown): number {
  if (!(error instanceof NacosApiError)) {
    return 2;
  }
  switch (error.kind) {
    case 'not-found':
      return 0;
    case 'invalid-response':
    case 'response-too-large':
      return 1;
    default:
      return 2;
  }
}

async function toSuccess(
  baseUrl: string,
  state: NacosServerState,
  probes: ConnectionProbes,
  options: NacosConnectionTestOptions
): Promise<NacosConnectionTestSuccess> {
  const consoleUrl = await resolveConsoleUrl(baseUrl, state, probes, options);
  const mode = state.startupMode === 'unknown' ? 'startup mode not reported' : `${state.startupMode} mode`;
  const connected = `Connected to Nacos ${state.version} at ${baseUrl} (${mode}).`;
  return {
    ok: true,
    message: consoleUrl ? `${connected} Its console is at ${consoleUrl}.` : connected,
    baseUrl,
    version: state.version,
    majorVersion: state.majorVersion,
    startupMode: state.startupMode,
    authEnabled: state.authEnabled,
    consoleUrl
  };
}

/**
 * Asking costs a request, so it only happens where an answer is possible and
 * wanted: 1.x and 2.x serve their console from the same port and have nothing
 * to say, and a user who filled the field in has already answered.
 *
 * Not finding the console is not a failed connection. The instance works
 * without it; the form simply leaves the field empty.
 */
async function resolveConsoleUrl(
  baseUrl: string,
  state: NacosServerState,
  probes: ConnectionProbes,
  options: NacosConnectionTestOptions
): Promise<string | undefined> {
  if (options.consoleUrl) {
    return normalizeBaseUrl(options.consoleUrl);
  }
  if (state.majorVersion < CONSOLE_MAJOR_VERSION) {
    return undefined;
  }
  try {
    const hint = await probes.consoleHint({ baseUrl });
    return hint && composeConsoleUrl(baseUrl, hint);
  } catch {
    return undefined;
  }
}

/**
 * The hint carries a port and a path but no host, because Nacos is describing
 * itself -- so the host has to come from the candidate that answered rather
 * than from what the user typed, which may have been a bare origin.
 *
 * Rebuilt through `URL` rather than by concatenation so that an IPv6 literal
 * keeps its brackets, and stripped of any userinfo, which would otherwise be
 * copied into a field the form saves.
 */
function composeConsoleUrl(baseUrl: string, hint: NacosConsoleHint): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  url.username = '';
  url.password = '';
  url.pathname = hint.path;
  url.port = String(hint.port);
  return normalizeBaseUrl(url.href);
}

function toFailure(
  failure: CandidateFailure | undefined,
  triedBaseUrls: string[],
  options: NacosConnectionTestOptions
): NacosConnectionTestFailure {
  const error = failure?.error;
  const { reason, message } = describeConnectionFailure(failure?.baseUrl, error, triedBaseUrls, options.authMode);
  return {
    ok: false,
    message,
    reason,
    kind: error instanceof NacosApiError ? error.kind : undefined,
    status: error instanceof NacosApiError ? error.status : undefined,
    triedBaseUrls
  };
}

interface FailureDescription {
  reason: NacosConnectionFailureReason;
  message: string;
}

/**
 * One sentence naming the thing to change. "The connection failed" is not an
 * answer to a button whose whole purpose is to find out which of the address,
 * the certificate, the credentials or the network is wrong.
 */
function describeConnectionFailure(
  baseUrl: string | undefined,
  error: unknown,
  tried: string[],
  authMode: NacosAuthMode
): FailureDescription {
  if (!(error instanceof NacosApiError)) {
    return { reason: 'error', message: `The connection test could not be completed: ${formatError(error)}` };
  }
  if (baseUrl === undefined) {
    // Only the address parsing fails this early, and it already words itself
    // as the fix. It withholds the address on purpose, since an address too
    // malformed to parse is also too malformed to strip a password out of.
    return { reason: 'address', message: error.message };
  }
  const host = hostOf(baseUrl);
  switch (error.kind) {
    case 'forbidden':
      return { reason: 'auth', message: describeForbidden(baseUrl, authMode) };
    case 'gateway-auth':
      return {
        reason: 'gateway',
        message: `Something in front of Nacos answered HTTP 401 at ${baseUrl}. Nacos itself never returns 401, so the Nacos username and password are not what is being rejected: send the proxy or gateway credential using the "Custom headers" authentication mode, or fix the proxy configuration.`
      };
    case 'tls':
      return {
        reason: 'tls',
        message: `${sentence(error.message)} Accept the certificate for ${host} when the extension asks, install the CA that issued it, or use http:// if this server does not serve TLS.`
      };
    case 'network':
      return {
        reason: 'network',
        message: `Could not reach ${host} (${error.message}). Check the host and port in the server URL, whether Nacos is running, and any firewall, proxy or VPN in between.`
      };
    case 'not-found':
      return {
        reason: 'address',
        message: `No Nacos API answered at ${joinAlternatives(tried)}. Check the context path in the server URL: Nacos usually serves its API under /nacos, though Kubernetes ingresses and some container images serve it at the root instead.`
      };
    case 'invalid-response':
    case 'response-too-large':
      return {
        reason: 'address',
        message: `Something answered at ${baseUrl}, but not with a Nacos API response (${error.message}). Check that the server URL points at Nacos itself rather than at a web server, a single-page app, or a proxy that rewrites unknown paths.`
      };
    case 'validation':
      // Task 6 reclassifies a server refusal that no retry can fix -- an OIDC
      // deployment turning down username/password login -- into this kind, and
      // words it as the setting to change. Rewriting that would lose the only
      // part of it the user can act on.
      return { reason: 'config', message: error.message };
    case 'api-deprecated':
      return {
        reason: 'error',
        message: `Nacos rejected the server-state API as deprecated (HTTP 410) at ${baseUrl}. This is Nacos 3.0 or 3.1 with the v1/v2 API compatibility switch turned off, and its v3 admin API did not answer either: ask a Nacos administrator to re-enable the compatibility switch, or to grant this account access to the v3 admin API.`
      };
    case 'api-error':
      // Led by the upstream sentence, which already names the status and the
      // path it was refused on, and carries whatever the server said about
      // why. The status is on the result as a field either way.
      return {
        reason: 'error',
        message: `${sentence(error.message)} The address ${baseUrl} did reach a server, so this is a failure inside Nacos or the proxy in front of it rather than a setting in this form: check the Nacos server log.`
      };
  }
}

/** Lets an upstream message be joined to guidance without doubling or dropping a full stop. */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * A 403 means different things per authentication mode, and each sends the
 * user to a different field. Saying "check your credentials" to a connection
 * that sent none is the least useful of the four.
 */
function describeForbidden(baseUrl: string, authMode: NacosAuthMode): string {
  const refused = `Nacos answered at ${baseUrl} but refused the request with HTTP 403`;
  switch (authMode) {
    case 'none':
      return `${refused}. This server requires authentication and no credentials were sent: choose an authentication mode and fill in what it needs.`;
    case 'userPassword':
      return `${refused}. Check the username and password, or whether this account has permission to read the server state.`;
    case 'customHeader':
      return `${refused}. Check the custom header credentials: the token may be wrong or expired, or the account behind it may lack permission to read the server state.`;
    case 'akSk':
      return `${refused}. Check the access key and secret, or whether they carry permission to read the server state.`;
  }
}

function joinAlternatives(values: string[]): string {
  return values.length > 1 ? `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}` : (values[0] ?? '');
}

/**
 * Used by the failures that never reached a path -- an unresolved host and an
 * untrusted certificate are properties of the endpoint, and naming a context
 * path in front of them would suggest a path had been tried. `URL.host` also
 * drops any userinfo, which is what makes it safe to log.
 */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

interface ConnectionProbes {
  probe(context: NacosProbeContext): Promise<NacosServerState>;
  consoleHint(context: NacosProbeContext): Promise<NacosConsoleHint | undefined>;
}

function resolveProbes(options: NacosConnectionTestOptions): ConnectionProbes {
  const live = createLiveProbes(options);
  return { probe: options.probe ?? live.probe, consoleHint: options.consoleHint ?? live.consoleHint };
}

type AuthedRequests = Pick<NacosHttpClient, 'requestJson' | 'requestRaw'>;

/**
 * The production path: a client and an authentication strategy per candidate,
 * built lazily and kept.
 *
 * Keeping them matters for the userPassword mode. The console lookup follows a
 * successful probe against the same base URL, and a second strategy would hold
 * no token and log in again -- one extra round trip on every 3.x connection
 * test, for a credential that was verified a moment earlier. The map holds the
 * promise rather than its result so that concurrent callers share one login.
 */
function createLiveProbes(options: NacosConnectionTestOptions): ConnectionProbes {
  const connections = new Map<string, Promise<AuthedRequests>>();
  const connect = (baseUrl: string): Promise<AuthedRequests> => {
    const existing = connections.get(baseUrl);
    if (existing) {
      return existing;
    }
    const opened = openConnection(baseUrl, options);
    connections.set(baseUrl, opened);
    return opened;
  };
  return {
    probe: async ({ baseUrl }) => probeServerState(await connect(baseUrl)),
    consoleHint: async ({ baseUrl }) => fetchConsoleHint(await connect(baseUrl))
  };
}

async function openConnection(baseUrl: string, options: NacosConnectionTestOptions): Promise<AuthedRequests> {
  const http = new NacosHttpClient({
    baseUrl,
    certVerifier: options.certVerifier,
    timeoutMs: options.timeoutMs,
    log: options.log
  });
  const auth = await createAuthStrategy(toDraftInstance(baseUrl, options), {
    http,
    // Both loaders ignore the instance id: the values under test are the ones
    // in the form, which for a new instance are in no store yet and for an
    // edited one differ from what is stored. Going through the factory anyway
    // keeps one definition of what each authentication mode means, including
    // its refusal of the mode this milestone does not implement.
    getPassword: async () => options.password,
    getCustomHeaders: async () => options.customHeaders
  });
  return withAuthHeaders(http, auth);
}

/**
 * Attaches the strategy's headers to every request, and nothing else.
 *
 * Task 13's `withAuth` additionally refreshes and retries once on a 403. That
 * behavior is wrong here: a rejected credential is the answer this function
 * was called to obtain, and retrying it turns one failed login into two.
 *
 * The headers are resolved exactly once, rejection included, which is what
 * holds a rejected password to a single login attempt. `probeServerState`
 * treats a 403 as a reason to try the older state endpoint -- correct when the
 * 403 came from the endpoint, but here it came from the login in front of it,
 * so the second request would log in again and fail the same way. The strategy
 * cannot prevent that on its own: it drops a failed login from its cache on
 * purpose, so that a long-lived instance recovers from a blip. A connection
 * test is not long-lived, and the account lockout policy on the other side is
 * counting.
 */
function withAuthHeaders(http: NacosHttpClient, auth: NacosAuthStrategy): AuthedRequests {
  let headers: Promise<Record<string, string>> | undefined;
  const merge = async (options: NacosRequestOptions): Promise<NacosRequestOptions> => ({
    ...options,
    headers: { ...(await (headers ??= auth.authHeaders())), ...options.headers }
  });
  return {
    async requestJson<T>(method: string, path: string, options: NacosRequestOptions = {}): Promise<T> {
      return http.requestJson<T>(method, path, await merge(options));
    },
    async requestRaw(method: string, path: string, options: NacosRequestOptions = {}): Promise<NacosRawResponse> {
      return http.requestRaw(method, path, await merge(options));
    }
  };
}

/**
 * The unsaved instance the form is describing. The identity and audit fields
 * are placeholders because nothing here is stored and nothing reads them: the
 * credential loaders above are handed the values directly. `readOnly` is true
 * for the same reason it is the safer default anywhere else -- this object
 * grants no write path to anything.
 */
function toDraftInstance(baseUrl: string, options: NacosConnectionTestOptions): NacosInstanceConfig {
  return {
    id: 'connection-test-draft',
    label: 'Connection test',
    serverUrl: baseUrl,
    consoleUrl: options.consoleUrl,
    authMode: options.authMode,
    username: options.username,
    readOnly: true,
    allowBackgroundAccess: false,
    createdAt: 0,
    updatedAt: 0
  };
}
