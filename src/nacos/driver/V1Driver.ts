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
  type NacosListenedConfigQuery,
  type NacosListenerQuery,
  type NacosServiceListQuery,
  type NacosSubscriberQuery
} from './NacosDriver';
import { fetchConfigHistoryDetail, fetchConfigHistoryPage, fetchConfigListeners, fetchListenedConfigs } from './history';
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
  NacosListenedConfig,
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

/**
 * 1.x's `RestResult` interface, whose success code is **200 rather than 0**
 * (`NacosHttpClient` accepts both). This one is a CONSOLE_API and carries no
 * @Secured, so it needs no authentication on 1.x/2.x; 3.0/3.1 answer 410 with
 * the compatibility switch off and 3.2+ answer 404, and both fall through.
 */
const NAMESPACE_LIST_PATH = '/v1/console/namespaces';

/**
 * One path serves both configuration capabilities, told apart only by the
 * query: `search=accurate|blur` lists, `show=all` fetches one. That is also
 * why they are separate capabilities to the resolver -- 3.0/3.1 classify the
 * two query forms differently (both CONSOLE_API, but the bare content form is
 * OPEN_API), so one can be available while the other is not.
 */
const CONFIG_PATH = '/v1/cs/configs';

/**
 * Without `show=all` this same path answers in plain text and carries no
 * `type`, and `type` is what picks the editor's language mode. §6.8.
 */
const SHOW_ALL = { query: { show: 'all' } };

/**
 * And a third capability on one more shared path: the history listing and one
 * history version are told apart by `search=accurate` against `nid`, exactly
 * as the config listing and the config detail are.
 */
const CONFIG_HISTORY_PATH = '/v1/cs/history';
const SEARCH_ACCURATE = { query: { search: 'accurate' } };

/**
 * `configs/listener`, plural -- not `/v1/cs/listener`, which is the same
 * question asked the other way round (the configs one client holds, rather
 * than the clients holding one config).
 */
const CONFIG_LISTENER_PATH = '/v1/cs/configs/listener';
const LISTENED_CONFIGS_PATH = '/v1/cs/listener';

const SERVICE_DETAIL_PATH = '/v1/ns/service';
const SUBSCRIBERS_PATH = '/v1/ns/service/subscribers';

/**
 * The two service listings 1.x has, in the order they are worth asking in.
 *
 * The catalog is the only one that reports instance and healthy counts, which
 * is what the tree colors its service nodes by; `service/list` gives names
 * alone. The catalog is also the more fragile of the two -- it is a
 * console-side endpoint, older 1.x releases served it at
 * `/v1/ns/catalog/serviceList`, and 3.0/3.1 answer 410 for it with the
 * compatibility switch off.
 */
const CATALOG_SERVICES_PATH = '/v1/ns/catalog/services';
const CATALOG_INSTANCES_PATH = '/v1/ns/catalog/instances';
const SERVICE_LIST_PATH = '/v1/ns/service/list';

const INSTANCE_LIST_PATH = '/v1/ns/instance/list';

/**
 * And the same path without `/list` is where an instance is written -- one
 * controller, told apart by the method: PUT updates, POST registers, DELETE
 * deregisters. Only the update is reachable from here.
 */
const INSTANCE_PATH = '/v1/ns/instance';

/**
 * `/v1/core/cluster/nodes`, not `/v1/ns/operator/servers` -- the latter is in
 * the research as an equivalent and a real 2.3.2 answers it with **HTTP 501
 * no-such-api**, which is not even a fall-through kind.
 */
const CLUSTER_NODES_PATH = '/v1/core/cluster/nodes';

/** No @Secured on this one, so it answers without authentication on 1.x/2.x. */
const METRICS_PATH = '/v1/ns/operator/metrics';

export class V1Driver implements NacosDriver {
  readonly flavor: NacosApiFlavor = 'v1';

  constructor(private readonly http: Pick<NacosHttpClient, 'requestJson' | 'requestRaw'>) {}

  listNamespaces(): Promise<NacosNamespace[]> {
    return fetchNamespaces(this.http, NAMESPACE_LIST_PATH);
  }

  listConfigs(query: NacosConfigListQuery): Promise<Paged<NacosConfigSummary>> {
    return fetchConfigPage(this.http, this.flavor, CONFIG_PATH, query);
  }

  getConfig(ref: NacosConfigRef): Promise<NacosConfigDetail> {
    return fetchConfigDetail(this.http, this.flavor, CONFIG_PATH, ref, SHOW_ALL);
  }

  listConfigHistory(query: NacosConfigHistoryListQuery): Promise<Paged<NacosConfigHistoryEntry>> {
    return fetchConfigHistoryPage(this.http, this.flavor, CONFIG_HISTORY_PATH, query, SEARCH_ACCURATE);
  }

  getConfigHistory(query: NacosConfigHistoryQuery): Promise<NacosConfigDetail> {
    return fetchConfigHistoryDetail(this.http, this.flavor, CONFIG_HISTORY_PATH, query);
  }

  listConfigListeners(query: NacosListenerQuery): Promise<NacosConfigListener[]> {
    return fetchConfigListeners(this.http, this.flavor, CONFIG_LISTENER_PATH, query);
  }

  listListenedConfigs(query: NacosListenedConfigQuery): Promise<NacosListenedConfig[]> {
    return fetchListenedConfigs(this.http, this.flavor, LISTENED_CONFIGS_PATH, query);
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
    return fetchSubscribers(this.http, this.flavor, SUBSCRIBERS_PATH, query);
  }

  listClusterNodes(): Promise<NacosClusterNode[]> {
    return fetchClusterNodes(this.http, CLUSTER_NODES_PATH);
  }

  getServerMetrics(): Promise<NacosServerMetrics> {
    return fetchServerMetrics(this.http, METRICS_PATH);
  }

  publishConfig(request: NacosConfigPublish): Promise<void> {
    return publishConfigAt(this.http, this.flavor, CONFIG_PATH, request);
  }

  deleteConfig(ref: NacosConfigRef): Promise<void> {
    return deleteConfigAt(this.http, this.flavor, CONFIG_PATH, ref);
  }

  updateInstanceHealth(request: NacosInstanceHealthUpdate): Promise<void> {
    return updateInstanceHealthAt(this.http, this.flavor, INSTANCE_PATH, request);
  }
}
