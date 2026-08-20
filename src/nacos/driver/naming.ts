import { NacosApiError } from '../NacosApiError';
import type { NacosHttpClient, NacosRequestOptions } from '../NacosHttpClient';
import { isRecord } from '../jsonGuards';
import type { NacosApiFlavor, NacosInstanceQuery, NacosServiceListQuery, NacosSubscriberQuery } from './NacosDriver';
import {
  clusterParamName,
  groupedServiceName,
  normalizeClusterNode,
  normalizeInstanceList,
  normalizePaged,
  normalizeServerMetrics,
  normalizeServiceDetail,
  normalizeServiceSummary,
  normalizeSubscriberList,
  unwrapData,
  unwrapDataArray,
  type NacosClusterNode,
  type NacosInstance,
  type NacosServerMetrics,
  type NacosServiceDetail,
  type NacosServiceRef,
  type NacosServiceScope,
  type NacosServiceSummary,
  type NacosSubscriber,
  type Paged
} from './normalize';

/**
 * What Nacos assumes when a naming request names no group.
 *
 * Spelled out rather than left to the server, because it is only ever used
 * where the server would have assumed it anyway -- and a request that says
 * what it means can be read off the wire.
 */
const DEFAULT_GROUP = 'DEFAULT_GROUP';

/**
 * What both counting listings ask for -- the 1.x/2.x catalog and the 3.x
 * listing that absorbed it, which differ only in the envelope they answer in
 * and in what they call one flag.
 *
 * The group filter is `groupNameParam`, not `groupName`. The `Param` suffix
 * belongs to the *catalog* controller and 3.x inherited it, so it is **not**
 * a 3.x-only spelling as §6.5 has it -- 2.3.2's CatalogController declares
 * `@RequestParam(name = "groupNameParam")`, and a request that says
 * `groupName` there is dropped in silence and answered for every group.
 * Blank means every group, which is what the tree asks for.
 *
 * `withInstances=false` keeps the answer to one row per service; the `true`
 * form expands every instance of every service in the page, which is a
 * different endpoint's job. The empty-service flag -- `hasIpCount` on the
 * catalog, `ignoreEmptyService` on 3.x -- is sent as false unless the caller
 * asked otherwise, because a service with no instances is still a service
 * and a form-bound boolean's default is the one thing a client cannot see.
 */
function countedServiceParams(
  query: NacosServiceListQuery,
  emptyServiceParam: 'hasIpCount' | 'ignoreEmptyService'
): Record<string, string> {
  return {
    namespaceId: query.namespaceId,
    groupNameParam: query.group ?? '',
    serviceNameParam: query.serviceName ?? '',
    pageNo: String(query.pageNo),
    pageSize: String(query.pageSize),
    withInstances: 'false',
    [emptyServiceParam]: query.ignoreEmptyService === true ? 'true' : 'false'
  };
}

/**
 * The 1.x/2.x catalog: the only listing before 3.x that reports instance and
 * healthy counts, and the only one that can answer for every group at once.
 */
export async function fetchCatalogServices(
  http: Pick<NacosHttpClient, 'requestJson'>,
  path: string,
  query: NacosServiceListQuery,
  options?: NacosRequestOptions
): Promise<Paged<NacosServiceSummary>> {
  const payload = await http.requestJson<unknown>('GET', path, {
    ...options,
    query: { ...options?.query, ...countedServiceParams(query, 'hasIpCount') }
  });
  return servicePage(payload, path, query);
}

/**
 * The 1.x/2.x listings that answer with names and nothing else.
 *
 * They cannot serve the tree's counts, which is why they are the fallback
 * rather than the route -- and they cannot serve every group either. The
 * group filter is an exact match with no wildcard (`Objects.equals` in
 * ServiceOperatorV2Impl) and blank collapses to `DEFAULT_GROUP`, so a caller
 * asking for every group gets the default one and the request says as much.
 */
export async function fetchServiceNames(
  http: Pick<NacosHttpClient, 'requestJson'>,
  path: string,
  query: NacosServiceListQuery,
  options?: NacosRequestOptions
): Promise<Paged<NacosServiceSummary>> {
  const payload = await http.requestJson<unknown>('GET', path, {
    ...options,
    query: {
      ...options?.query,
      namespaceId: query.namespaceId,
      groupName: query.group ?? DEFAULT_GROUP,
      pageNo: String(query.pageNo),
      pageSize: String(query.pageSize)
    }
  });
  return servicePage(payload, path, query);
}

/**
 * 3.x's listing, which is the catalog's own content in a real `Page` -- so
 * the same parameters, and the page read off the response instead of counted
 * out of it.
 */
export async function fetchServicePage(
  http: Pick<NacosHttpClient, 'requestJson'>,
  path: string,
  query: NacosServiceListQuery,
  options?: NacosRequestOptions
): Promise<Paged<NacosServiceSummary>> {
  const payload = await http.requestJson<unknown>('GET', path, {
    ...options,
    query: { ...options?.query, ...countedServiceParams(query, 'ignoreEmptyService') }
  });
  return normalizePaged(payload, (entry) => normalizeServiceSummary(entry, scopeOf(query)), path);
}

/**
 * Prefers the endpoint that reports instance and healthy counts, and settles
 * for names when it is not there.
 *
 * **This degradation is deliberately not the resolver's.** Both endpoints
 * belong to the same server and the same API family, so a fall-through here
 * would cache a *flavor* decision taken for a reason that has nothing to do
 * with the server's version -- and evict the driver every other capability
 * had already settled on. The resolver arbitrates between versions; this
 * arbitrates between two endpoints of one.
 *
 * Any classified failure is enough to move on, because the alternative is
 * strictly more available: the catalog is a console-side endpoint that older
 * 1.x releases served at a different path (answering **501 no-such-api**, not
 * 404, since it lives under `/v1/ns/**`), that 3.0/3.1 turn off with the
 * compatibility switch, and that a non-administrator can be refused. The
 * fallback's own failure is the one that surfaces, so that what the resolver
 * sees is the standard listing's verdict rather than the preferred route's.
 */
export async function listServicesPreferringCounts(
  counted: () => Promise<Paged<NacosServiceSummary>>,
  names: () => Promise<Paged<NacosServiceSummary>>
): Promise<Paged<NacosServiceSummary>> {
  try {
    return await counted();
  } catch (error) {
    if (!(error instanceof NacosApiError)) {
      throw error;
    }
    return await names();
  }
}

/**
 * The instances of one service.
 *
 * v1 has no group parameter here at all: the group travels inside
 * `serviceName` as `GROUP@@name`, which is what every version's
 * `NamingUtils.getGroupName` reads back out. v2 onward takes the two apart --
 * and sending a grouped name *there* makes the server compose the group in
 * twice, so the two dialects are not interchangeable in either direction.
 *
 * The cluster filter is `clusters` on v1 and `clusterName` from v2 on, and it
 * is omitted entirely when the caller named no cluster rather than sent
 * empty: both spellings treat blank as "every cluster", and an omitted
 * parameter cannot be misspelled.
 */
export async function fetchInstances(
  http: Pick<NacosHttpClient, 'requestJson'>,
  endpointFlavor: NacosApiFlavor,
  path: string,
  query: NacosInstanceQuery,
  options?: NacosRequestOptions
): Promise<NacosInstance[]> {
  const payload = await http.requestJson<unknown>('GET', path, {
    ...options,
    query: { ...options?.query, ...instanceParams(endpointFlavor, query) }
  });
  return normalizeInstanceList(payload, path);
}

/**
 * 1.x/2.x catalog instance listing: console-dedicated endpoint that returns all instances
 * regardless of enabled/disabled/healthy status.
 */
export async function fetchCatalogInstances(
  http: Pick<NacosHttpClient, 'requestJson'>,
  path: string,
  query: NacosInstanceQuery,
  options?: NacosRequestOptions
): Promise<NacosInstance[]> {
  const clusterName = query.cluster || 'DEFAULT';
  const payload = await http.requestJson<unknown>('GET', path, {
    ...options,
    query: {
      ...options?.query,
      namespaceId: query.namespaceId,
      groupName: query.group,
      serviceName: query.group ? `${query.group}@@${query.serviceName}` : query.serviceName,
      clusterName,
      pageNo: '1',
      pageSize: '500'
    }
  });
  return normalizeInstanceList(payload, path);
}

/**
 * Attempts catalog instance query first (returns all offline/online instances).
 * Falls back to client open-api endpoint if catalog is unavailable (e.g. 404/410).
 */
export async function listInstancesPreferringCatalog(
  fetchCatalog: () => Promise<NacosInstance[]>,
  fetchFallback: () => Promise<NacosInstance[]>
): Promise<NacosInstance[]> {
  try {
    return await fetchCatalog();
  } catch (error) {
    if (!(error instanceof NacosApiError)) {
      throw error;
    }
    return await fetchFallback();
  }
}

function instanceParams(flavor: NacosApiFlavor, query: NacosInstanceQuery): Record<string, string> {
  const cluster = query.cluster === undefined ? {} : { [clusterParamName(flavor)]: query.cluster };
  return { ...serviceIdentityParams(flavor, query), healthyOnly: 'false', ...cluster };
}

/**
 * Which service the request is about, in the dialect the endpoint family
 * reads.
 *
 * v1 has no group parameter on its instance endpoint at all -- the group
 * travels inside `serviceName` as `GROUP@@name` -- and its service detail and
 * subscriber endpoints read that same spelling. Measured on a real 2.3.2: a
 * grouped name **wins over** a contradicting `groupName` sent beside it on
 * both of them, so the grouped form cannot be defeated by a stray parameter,
 * while a bare name resolves to `DEFAULT_GROUP@@name` and finds nothing.
 *
 * v2 onward takes the two apart, and sending a grouped name *there* makes the
 * server compose the group in twice.
 *
 * Exported for the instance *write*, which addresses an instance exactly as
 * the listing does and must not grow a second opinion about how: the update
 * endpoint is the same controller as the listing on every version, so a write
 * that named its service differently from the read that found it would be
 * addressing something else.
 */
export function serviceIdentityParams(flavor: NacosApiFlavor, ref: NacosServiceRef): Record<string, string> {
  if (flavor === 'v1') {
    return { namespaceId: ref.namespaceId, serviceName: groupedServiceName(ref) };
  }
  return { namespaceId: ref.namespaceId, groupName: ref.group, serviceName: ref.serviceName };
}

/** One service's own configuration: its clusters, its metadata and its protect threshold. */
export async function fetchServiceDetail(
  http: Pick<NacosHttpClient, 'requestJson'>,
  endpointFlavor: NacosApiFlavor,
  path: string,
  ref: NacosServiceRef,
  options?: NacosRequestOptions
): Promise<NacosServiceDetail> {
  const payload = await http.requestJson<unknown>('GET', path, {
    ...options,
    query: { ...options?.query, ...serviceIdentityParams(endpointFlavor, ref) }
  });
  return normalizeServiceDetail(payload, ref);
}

/**
 * The clients watching one service.
 *
 * No paging is sent here. Only the 3.x listings page -- the v1 endpoint's own
 * `pageSize` defaults to 1000, so sending this project's ceiling of 100 would
 * *lower* what a real server already answers with -- and the drivers that do
 * page pass their page through `options.query`.
 */
export async function fetchSubscribers(
  http: Pick<NacosHttpClient, 'requestJson'>,
  endpointFlavor: NacosApiFlavor,
  path: string,
  query: NacosSubscriberQuery,
  options?: NacosRequestOptions
): Promise<NacosSubscriber[]> {
  const payload = await http.requestJson<unknown>('GET', path, {
    ...options,
    query: {
      ...options?.query,
      ...serviceIdentityParams(endpointFlavor, query),
      ...(endpointFlavor === 'v3-admin' || endpointFlavor === 'v3-console'
        ? { aggregation: query.aggregation === false ? 'false' : 'true' }
        : {})
    }
  });
  return normalizeSubscriberList(payload, path, query);
}

/** The servers of the cluster. No parameters on any version: a node list is a node list. */
export async function fetchClusterNodes(
  http: Pick<NacosHttpClient, 'requestJson'>,
  path: string,
  options?: NacosRequestOptions
): Promise<NacosClusterNode[]> {
  const payload = await http.requestJson<unknown>('GET', path, options);
  return unwrapDataArray(payload, path).map(normalizeClusterNode);
}

/**
 * The naming module's server metrics, and the one parameter that makes them
 * metrics.
 *
 * `onlyStatus` defaults to **true** on every version --
 * `WebUtils.optional(request, "onlyStatus", "true")` on v1/v2,
 * `@RequestParam(defaultValue = "true")` on v3 -- so a request without it
 * gets `{"status":"UP"}` and nothing else. Verified on a real 2.3.2: this is
 * a parameter default, not the version-dependent degradation the research
 * recorded.
 */
export async function fetchServerMetrics(
  http: Pick<NacosHttpClient, 'requestJson'>,
  path: string,
  options?: NacosRequestOptions
): Promise<NacosServerMetrics> {
  const payload = await http.requestJson<unknown>('GET', path, {
    ...options,
    query: { ...options?.query, onlyStatus: 'false' }
  });
  return normalizeServerMetrics(payload);
}

/**
 * A capability this API family simply does not have, refused without a round
 * trip.
 *
 * `not-found` is the accurate kind and the useful one: it is what the server
 * would have answered had there been a path to ask, and it lets the resolver
 * move straight on to a family that does have one.
 */
export function missingCapability(reason: string): NacosApiError {
  return new NacosApiError('not-found', reason);
}

/**
 * Turns the `{count, <names>}` shape the older listings share into a page.
 *
 * The three of them differ only in what the array is called -- `serviceList`
 * on the catalog, `doms` on 1.x, `services` on v2 -- and none of them says
 * which page it just answered with. `count` is the total *before* paging in
 * all three (each controller counts the filtered set and then slices it), so
 * the page number is the one that was asked for and the page count is that
 * arithmetic rather than a guess.
 */
function servicePage(payload: unknown, endpoint: string, query: NacosServiceListQuery): Paged<NacosServiceSummary> {
  const data = unwrapData<unknown>(payload);
  const entries = serviceEntriesIn(data);
  if (entries === undefined) {
    throw new NacosApiError(
      'invalid-response',
      `Nacos returned no service list for ${endpoint}: no serviceList, doms or services array in the response.`
    );
  }
  const scope = scopeOf(query);
  const items = entries.map((entry) => normalizeServiceSummary(entry, scope));
  const totalCount = isRecord(data) && typeof data.count === 'number' ? data.count : items.length;
  return {
    items,
    totalCount,
    pageNumber: query.pageNo,
    pagesAvailable: Math.max(1, Math.ceil(totalCount / Math.max(query.pageSize, 1)))
  };
}

function serviceEntriesIn(data: unknown): unknown[] | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  const entries = [data.serviceList, data.doms, data.services].find((candidate) => Array.isArray(candidate));
  return Array.isArray(entries) ? entries : undefined;
}

/**
 * Where the listing was asked for, for entries that cannot say. The default
 * group stands in when the caller named none, because that is the group the
 * server filtered by whenever an entry arrives without one of its own.
 */
function scopeOf(query: NacosServiceListQuery): NacosServiceScope {
  return { namespaceId: query.namespaceId, group: query.group ?? DEFAULT_GROUP };
}
