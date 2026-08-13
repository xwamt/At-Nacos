import { NacosApiError } from '../NacosApiError';
import type { NacosHttpClient } from '../NacosHttpClient';
import { isRecord, toStringRecord } from '../jsonGuards';

export interface NacosServerState {
  version: string;
  majorVersion: number;
  startupMode: 'standalone' | 'cluster' | 'unknown';
  /** Reflects `nacos.core.auth.enabled` alone. False on 3.x still does not mean admin/console need no auth. */
  authEnabled: boolean;
  raw: Record<string, string>;
}

const V3_STATE_PATH = '/v3/admin/core/state';
const V1_STATE_PATH = '/v1/console/server/state';

/**
 * The shape of the 3.x response is disputed: the source says
 * `Result<Map<String,String>>` (wrapped), while the official documentation's
 * example is a bare map. Both are accepted.
 */
export function parseServerState(payload: unknown): NacosServerState {
  const raw = unwrap(payload);
  const version = raw.version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new NacosApiError('invalid-response', 'Nacos server state did not report a version.');
  }
  const majorVersion = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (!Number.isFinite(majorVersion)) {
    throw new NacosApiError('invalid-response', `Unrecognized Nacos version string: ${version}`);
  }
  // 2.5 renamed standalone_mode to startup_mode. Picking the key by version
  // number gets it wrong on whichever release sits on that boundary, so both
  // are read.
  const mode = raw.startup_mode ?? raw.standalone_mode;
  return {
    version,
    majorVersion,
    startupMode: mode === 'standalone' || mode === 'cluster' ? mode : 'unknown',
    authEnabled: raw.auth_enabled === 'true',
    raw
  };
}

/**
 * A `data` carrying a version wins over a version at the top level: the state
 * map itself is the raw we want, and the top level is only an envelope.
 * Taking the top level instead would reduce the raw of
 * `{code,message,data:{...}}` to `{message:'success'}` -- losing fields such
 * as startup_mode, and mistaking a version a gateway added of its own accord
 * for the server's. When `data` carries no version the top level is used
 * after all, which is what keeps the documentation's bare map readable.
 */
function unwrap(payload: unknown): Record<string, string> {
  if (isRecord(payload)) {
    const wrapped = toStringRecord(payload.data);
    if (wrapped && typeof wrapped.version === 'string') {
      return wrapped;
    }
  }
  return toStringRecord(payload) ?? {};
}

export async function probeServerState(
  http: Pick<NacosHttpClient, 'requestJson'>
): Promise<NacosServerState> {
  let v3Failure: unknown;
  try {
    return parseServerState(await http.requestJson('GET', V3_STATE_PATH));
  } catch (v3Error) {
    if (!shouldTryOlderState(v3Error)) {
      throw v3Error;
    }
    v3Failure = v3Error;
  }

  try {
    return parseServerState(await http.requestJson('GET', V1_STATE_PATH));
  } catch (v1Error) {
    // 410 means this is 3.0/3.1 with the console compatibility switch turned
    // off, which is itself proof that v3 exists -- the first v3 failure had
    // some other cause (a proxy hiccup, a truncated body). This one retry and
    // no more; if it fails the error goes out. This is not a general retry
    // policy.
    if (v1Error instanceof NacosApiError && v1Error.kind === 'api-deprecated') {
      return parseServerState(await http.requestJson('GET', V3_STATE_PATH));
    }
    throw combineMissingEndpoints(v3Failure, v1Error) ?? v1Error;
  }
}

/**
 * When both paths answer 404, reporting only the v1 one is the least
 * informative thing available: the real cause is almost always a wrong guess
 * at the context path, or an address that is not Nacos at all. The kind stays
 * not-found, so Task 10's candidate walk still goes on to the next base URL.
 */
function combineMissingEndpoints(v3Error: unknown, v1Error: unknown): NacosApiError | undefined {
  if (!isNotFound(v3Error) || !isNotFound(v1Error)) {
    return undefined;
  }
  return new NacosApiError(
    'not-found',
    `Nacos answered HTTP 404 for both ${V3_STATE_PATH} and ${V1_STATE_PATH}. The context path is probably wrong, or this address is not a Nacos server.`,
    404
  );
}

function isNotFound(error: unknown): boolean {
  return error instanceof NacosApiError && error.kind === 'not-found';
}

/**
 * `invalid-response` counts too: an Ingress that rewrites unknown paths to
 * the console SPA makes v3 answer with HTML (which `requestJson` reads as
 * invalid-response) while the v1 underneath it is fine. The cost is one extra
 * request against a reverse proxy that answers every path with the same JSON
 * error page, which still ends in an error rather than a false success.
 */
function shouldTryOlderState(error: unknown): boolean {
  return error instanceof NacosApiError && (error.shouldFallThrough() || error.kind === 'invalid-response');
}
