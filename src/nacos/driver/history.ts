import type { NacosHttpClient, NacosRequestOptions } from '../NacosHttpClient';
import {
  fetchConfigDetail,
  type NacosApiFlavor,
  type NacosConfigHistoryListQuery,
  type NacosConfigHistoryQuery,
  type NacosListenedConfigQuery,
  type NacosListenerQuery
} from './NacosDriver';
import {
  groupParamName,
  namespaceParamName,
  normalizeConfigHistoryEntry,
  normalizeConfigListeners,
  normalizeListenedConfigs,
  normalizePaged,
  type NacosConfigDetail,
  type NacosConfigHistoryEntry,
  type NacosConfigListener,
  type NacosConfigRef,
  type NacosListenedConfig,
  type Paged
} from './normalize';

/**
 * The one paged Nacos endpoint with a **server-side hard cap**: its own
 * source clamps with `Math.min(500, pageSize)` (§10). Nothing else this
 * project pages does -- a real 2.3.2 accepted `pageSize=9999` on the config
 * listing and answered every row.
 *
 * Clamping here as well changes nothing about what comes back, and that is
 * the point: it gives "why did I only get 500 rows" an origin in this
 * codebase, instead of leaving it looking like a response that was truncated
 * in transit.
 */
const MAX_HISTORY_PAGE_SIZE = 500;

/**
 * How many rounds the server spends polling its cluster for the clients
 * holding a config. Its default is 1 and it is sent anyway, for the reason
 * `withInstances=false` is: a form-bound default is the one thing a client
 * cannot see from the request it made.
 */
const LISTENER_SAMPLE_ROUNDS = 1;

/**
 * One page of a configuration's history.
 *
 * `endpointFlavor` is the family of the *path*, which is not always the
 * driver's own: v2 serves its history from the v1 endpoints, so it has to ask
 * in the v1 dialect. A driver's own `options.query` is merged underneath and
 * never over -- that is where the v1 family's `search=accurate` comes from,
 * and a driver that could overwrite the config identity would be answering
 * about a different config than the one it was given.
 */
export async function fetchConfigHistoryPage(
  http: Pick<NacosHttpClient, 'requestJson'>,
  endpointFlavor: NacosApiFlavor,
  path: string,
  query: NacosConfigHistoryListQuery,
  options?: NacosRequestOptions
): Promise<Paged<NacosConfigHistoryEntry>> {
  const payload = await http.requestJson<unknown>('GET', path, {
    ...options,
    query: {
      ...options?.query,
      ...configRefParams(endpointFlavor, query),
      pageNo: String(query.pageNo),
      pageSize: String(Math.min(query.pageSize, MAX_HISTORY_PAGE_SIZE))
    }
  });
  return normalizePaged(payload, (entry) => normalizeConfigHistoryEntry(entry, query), path);
}

/**
 * One past version of a configuration, as a `NacosConfigDetail` -- the same
 * type `getConfig` answers with, so that the document layer renders both
 * sides of a diff through one path instead of branching on which side it is
 * rendering.
 *
 * It goes through `fetchConfigDetail` for more than the shape. That reader
 * is the one that knows Nacos's two opposite 404s apart, and it is also the
 * one that reads "HTTP 200 with an empty body" as an absence -- which is
 * exactly how a real 2.3.2 reports a `nid` that is not there on v1, with v2
 * answering the same absence as `data: null`. Both were measured.
 */
export function fetchConfigHistoryDetail(
  http: Pick<NacosHttpClient, 'requestRaw'>,
  endpointFlavor: NacosApiFlavor,
  path: string,
  query: NacosConfigHistoryQuery,
  options?: NacosRequestOptions
): Promise<NacosConfigDetail> {
  return fetchConfigDetail(http, endpointFlavor, path, query, {
    ...options,
    query: { ...options?.query, nid: query.nid }
  });
}

/** The clients currently holding a copy of one configuration. */
export async function fetchConfigListeners(
  http: Pick<NacosHttpClient, 'requestJson'>,
  endpointFlavor: NacosApiFlavor,
  path: string,
  query: NacosListenerQuery,
  options?: NacosRequestOptions
): Promise<NacosConfigListener[]> {
  const payload = await http.requestJson<unknown>('GET', path, {
    ...options,
    query: {
      ...options?.query,
      ...configRefParams(endpointFlavor, query),
      sampleTime: String(LISTENER_SAMPLE_ROUNDS),
      ...(endpointFlavor === 'v3-admin' || endpointFlavor === 'v3-console'
        ? { aggregation: query.aggregation === false ? 'false' : 'true' }
        : {})
    }
  });
  return normalizeConfigListeners(payload, path);
}

/** The configurations one client IP currently holds. */
export async function fetchListenedConfigs(
  http: Pick<NacosHttpClient, 'requestJson'>,
  endpointFlavor: NacosApiFlavor,
  path: string,
  query: NacosListenedConfigQuery,
  options?: NacosRequestOptions
): Promise<NacosListenedConfig[]> {
  const payload = await http.requestJson<unknown>('GET', path, {
    ...options,
    query: {
      ...options?.query,
      ip: query.ip,
      [namespaceParamName(endpointFlavor, 'config')]: query.namespaceId,
      ...(endpointFlavor === 'v3-admin' || endpointFlavor === 'v3-console'
        ? { aggregation: query.aggregation === false ? 'false' : 'true' }
        : {})
    }
  });
  return normalizeListenedConfigs(payload, path);
}

/**
 * Which config the request is about, in the dialect the endpoint family
 * reads. The two parameter names are always chosen together: a request that
 * says `tenant` and `groupName` is half in each dialect, and the half the
 * server does not recognize is dropped in silence rather than refused.
 */
function configRefParams(flavor: NacosApiFlavor, ref: NacosConfigRef): Record<string, string> {
  return {
    dataId: ref.dataId,
    [groupParamName(flavor, 'config')]: ref.group,
    [namespaceParamName(flavor, 'config')]: ref.namespaceId
  };
}
