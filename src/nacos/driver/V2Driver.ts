import type { NacosHttpClient } from '../NacosHttpClient';
import {
  fetchConfigDetail,
  fetchConfigPage,
  fetchNamespaces,
  type NacosApiFlavor,
  type NacosConfigHistoryListQuery,
  type NacosConfigHistoryQuery,
  type NacosConfigListQuery,
  type NacosConfigPublish,
  type NacosDriver,
  type NacosInstanceHealthUpdate,
  type NacosInstanceQuery,
  type NacosListenerQuery,
  type NacosServiceListQuery,
  type NacosSubscriberQuery
} from './NacosDriver';
import { fetchConfigHistoryDetail, fetchConfigHistoryPage, fetchConfigListeners } from './history';
import {
  fetchCatalogInstances,
  fetchCatalogServices,
  fetchClusterNodes,
  fetchInstances,
  fetchServerMetrics,
  fetchServiceDetail,
  fetchServiceNames,
  fetchSubscribers,
  listInstancesPreferringCatalog,
  listServicesPreferringCounts
} from './naming';
import { deleteConfigAt, publishConfigAt, updateInstanceHealthAt } from './writes';
import type {
  NacosClusterNode,
  NacosConfigDetail,
  NacosConfigHistoryEntry,
  NacosConfigListener,
  NacosConfigRef,
  NacosConfigSummary,
  NacosInstance,
  NacosNamespace,
  NacosServerMetrics,
  NacosServiceDetail,
  NacosServiceRef,
  NacosServiceSummary,
  NacosSubscriber,
  Paged
} from './normalize';

/** The v2 endpoint 2.x added: entries have v1's shape, and the success code becomes 0. It needs no auth either. */
const NAMESPACE_LIST_PATH = '/v2/console/namespace/list';

/**
 * Both configuration capabilities fall back to the v1 path, and that is a
 * decision rather than an omission.
 *
 * Nacos v2 **never shipped a configuration list endpoint at all** -- there is
 * no `/v2/cs/config/list` to call. And `GET /v2/cs/config`, which does exist,
 * answers with `data` as a bare content string: no `type`, no group, no
 * timestamps. `type` is what picks the editor's language mode (§6.8), so
 * using it would cost every config its syntax highlighting for nothing gained.
 *
 * A 2.x server serves the v1 paths natively, so this is not a fallback in any
 * degraded sense; it is where the capability lives on this version.
 */
const CONFIG_PATH = '/v1/cs/configs';

/**
 * And therefore the v1 *dialect* as well. `namespaceParamName` keys on the
 * endpoint family, not on the driver, precisely for this case: `/v1/cs/configs`
 * reads `tenant` and `group`, and sending it `namespaceId` is silent -- Spring
 * drops the unknown parameter and the server answers for the default
 * namespace, which reaches the user as an empty namespace rather than as an
 * error.
 */
const CONFIG_ENDPOINT_FLAVOR: NacosApiFlavor = 'v1';

/** Without it the same path answers in plain text, with no `type` in it. */
const SHOW_ALL = { query: { show: 'all' } };

/**
 * The history stays on the v1 paths too, and this one is a measurement
 * rather than an inheritance.
 *
 * `/v2/cs/history/list` and `/v2/cs/history` **do** exist on a real 2.3.2 --
 * and both demand **`group`**, the v1 spelling, while taking `namespaceId`,
 * the v2 one. (`{"code":10000,"message":"parameter missing","data":"Required
 * request parameter 'group' ... is not present"}` for a request that says
 * `groupName`.) That is a third dialect, half in each, and the two parameter
 * names in this codebase are chosen together on purpose: a request that mixes
 * them has one half dropped in silence rather than refused. The v1 endpoints
 * answer the same rows in a dialect that is already covered, so they are what
 * this driver asks.
 */
const CONFIG_HISTORY_PATH = '/v1/cs/history';
const SEARCH_ACCURATE = { query: { search: 'accurate' } };

/** Measured on a real 2.3.2: `/v2/cs/config/listener` does not exist -- HTTP 404, Spring's own error page. */
const CONFIG_LISTENER_PATH = '/v1/cs/configs/listener';

/** v2 does have its own service detail, and it is the shape §6.7 describes: `clusterMap` and `serviceName`. */
const SERVICE_DETAIL_PATH = '/v2/ns/service';

/**
 * And measured the same way: `/v2/ns/service/subscribers` does not exist
 * either. This is the one naming capability where v2 has to reach back to a
 * v1 path -- so it also has to ask in the v1 naming dialect, where the group
 * travels inside the service name.
 */
const SUBSCRIBERS_PATH = '/v1/ns/service/subscribers';
const SUBSCRIBERS_ENDPOINT_FLAVOR: NacosApiFlavor = 'v1';

/**
 * v2 never got a catalog of its own, so the counts come from v1's -- the same
 * server serves both, and `/v2/ns/service/list` reports nothing but names
 * (`{"code":0,"data":{"count":N,"services":[...]}}`, measured). The fallback
 * stays on the v2 path: it is this driver's own version, and the only thing
 * the v1 one would add is a second dialect to get wrong.
 */
const CATALOG_SERVICES_PATH = '/v1/ns/catalog/services';
const CATALOG_INSTANCES_PATH = '/v1/ns/catalog/instances';
const SERVICE_LIST_PATH = '/v2/ns/service/list';

const INSTANCE_LIST_PATH = '/v2/ns/instance/list';

/**
 * The instance write does have a v2 endpoint of its own, unlike the
 * configuration ones -- `InstanceControllerV2` binds an `InstanceForm`, so
 * this is the one place in this driver where the v2 naming dialect
 * (`groupName` beside a bare `serviceName`) is what goes out.
 */
const INSTANCE_PATH = '/v2/ns/instance';
const CLUSTER_NODES_PATH = '/v2/core/cluster/node/list';

/** v2 does have its own metrics endpoint -- confirmed answering on a real 2.3.2. */
const METRICS_PATH = '/v2/ns/operator/metrics';

export class V2Driver implements NacosDriver {
  readonly flavor: NacosApiFlavor = 'v2';

  constructor(private readonly http: Pick<NacosHttpClient, 'requestJson' | 'requestRaw'>) {}

  listNamespaces(): Promise<NacosNamespace[]> {
    return fetchNamespaces(this.http, NAMESPACE_LIST_PATH);
  }

  listConfigs(query: NacosConfigListQuery): Promise<Paged<NacosConfigSummary>> {
    return fetchConfigPage(this.http, CONFIG_ENDPOINT_FLAVOR, CONFIG_PATH, query);
  }

  getConfig(ref: NacosConfigRef): Promise<NacosConfigDetail> {
    return fetchConfigDetail(this.http, CONFIG_ENDPOINT_FLAVOR, CONFIG_PATH, ref, SHOW_ALL);
  }

  listConfigHistory(query: NacosConfigHistoryListQuery): Promise<Paged<NacosConfigHistoryEntry>> {
    return fetchConfigHistoryPage(this.http, CONFIG_ENDPOINT_FLAVOR, CONFIG_HISTORY_PATH, query, SEARCH_ACCURATE);
  }

  getConfigHistory(query: NacosConfigHistoryQuery): Promise<NacosConfigDetail> {
    return fetchConfigHistoryDetail(this.http, CONFIG_ENDPOINT_FLAVOR, CONFIG_HISTORY_PATH, query);
  }

  listConfigListeners(query: NacosListenerQuery): Promise<NacosConfigListener[]> {
    return fetchConfigListeners(this.http, CONFIG_ENDPOINT_FLAVOR, CONFIG_LISTENER_PATH, query);
  }

  listServices(query: NacosServiceListQuery): Promise<Paged<NacosServiceSummary>> {
    return listServicesPreferringCounts(
      () => fetchCatalogServices(this.http, CATALOG_SERVICES_PATH, query),
      () => fetchServiceNames(this.http, SERVICE_LIST_PATH, query)
    );
  }

  getService(ref: NacosServiceRef): Promise<NacosServiceDetail> {
    return fetchServiceDetail(this.http, this.flavor, SERVICE_DETAIL_PATH, ref);
  }

  listInstances(query: NacosInstanceQuery): Promise<NacosInstance[]> {
    return listInstancesPreferringCatalog(
      () => fetchCatalogInstances(this.http, CATALOG_INSTANCES_PATH, query),
      () => fetchInstances(this.http, this.flavor, INSTANCE_LIST_PATH, query)
    );
  }

  listSubscribers(query: NacosSubscriberQuery): Promise<NacosSubscriber[]> {
    return fetchSubscribers(this.http, SUBSCRIBERS_ENDPOINT_FLAVOR, SUBSCRIBERS_PATH, query);
  }

  listClusterNodes(): Promise<NacosClusterNode[]> {
    return fetchClusterNodes(this.http, CLUSTER_NODES_PATH);
  }

  getServerMetrics(): Promise<NacosServerMetrics> {
    return fetchServerMetrics(this.http, METRICS_PATH);
  }

  publishConfig(request: NacosConfigPublish): Promise<void> {
    return publishConfigAt(this.http, CONFIG_ENDPOINT_FLAVOR, CONFIG_PATH, request);
  }

  deleteConfig(ref: NacosConfigRef): Promise<void> {
    return deleteConfigAt(this.http, CONFIG_ENDPOINT_FLAVOR, CONFIG_PATH, ref);
  }

  updateInstanceHealth(request: NacosInstanceHealthUpdate): Promise<void> {
    return updateInstanceHealthAt(this.http, this.flavor, INSTANCE_PATH, request);
  }
}
