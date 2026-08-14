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
  type NacosServiceListQuery
} from './NacosDriver';
import { fetchConfigHistoryDetail, fetchConfigHistoryPage, fetchConfigListeners } from './history';
import {
  fetchClusterNodes,
  fetchInstances,
  fetchServerMetrics,
  fetchServiceDetail,
  fetchServicePage,
  fetchSubscribers
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

/**
 * 3.x's admin API, which uses the server's own base URL (8848 plus the
 * `/nacos` context path) and therefore passes no baseUrlOverride. It requires
 * **administrator identity**, and an ordinary account gets a 403 -- which
 * falls through to V3ConsoleDriver.
 */
const NAMESPACE_LIST_PATH = '/v3/admin/core/namespace/list';

/**
 * 3.x split the one v1 path in two, which is why there is no `show=all` here:
 * the detail endpoint has no plain-text form to opt out of, and passing a
 * parameter it does not declare would only make the request harder to read.
 */
const CONFIG_LIST_PATH = '/v3/admin/cs/config/list';
const CONFIG_DETAIL_PATH = '/v3/admin/cs/config';

/**
 * 3.x split the history in two as well, so there is no `search=accurate`
 * here either: the listing has a path of its own rather than being a query
 * form on the detail's.
 */
const CONFIG_HISTORY_LIST_PATH = '/v3/admin/cs/history/list';
const CONFIG_HISTORY_DETAIL_PATH = '/v3/admin/cs/history';

/**
 * The only reader in this driver that **needs WRITE permission**: 3.x
 * classifies the admin listener endpoint as a write, and only the console's
 * version of it settles for READ (§9). So an ordinary account gets a 403
 * here even where the rest of this driver works -- which falls through to
 * `V3ConsoleDriver`, and that is the whole reason the fallback matters for
 * this one capability.
 */
const CONFIG_LISTENER_PATH = '/v3/admin/cs/config/listener';

const SERVICE_DETAIL_PATH = '/v3/admin/ns/service';
const SUBSCRIBERS_PATH = '/v3/admin/ns/service/subscribers';

/**
 * The 3.x subscriber listings page where v1's does not, so they are the only
 * ones that have to ask for a page. 100 is this project's own ceiling (§10);
 * a service watched by more clients than that would be truncated here, which
 * is the price of an interface where subscribers are a list.
 */
const FIRST_SUBSCRIBER_PAGE = { query: { pageNo: '1', pageSize: '100' } };

/**
 * 3.x folded the catalog into the standard listing -- `ServiceControllerV3`
 * answers `/list` out of `CatalogServiceV2Impl` -- so there is one endpoint
 * here where 1.x/2.x have two, and no fallback to arrange.
 */
const SERVICE_LIST_PATH = '/v3/admin/ns/service/list';
const INSTANCE_LIST_PATH = '/v3/admin/ns/instance/list';

/** The listing's path without `/list`: one controller, PUT for the update. */
const INSTANCE_PATH = '/v3/admin/ns/instance';

/** The server nodes live under `core`, not under the naming module's `ns`. */
const CLUSTER_NODES_PATH = '/v3/admin/core/cluster/node/list';

/** 3.x renamed the naming module's `operator` segment to `ops`. */
const METRICS_PATH = '/v3/admin/ns/ops/metrics';

export class V3AdminDriver implements NacosDriver {
  readonly flavor: NacosApiFlavor = 'v3-admin';

  constructor(private readonly http: Pick<NacosHttpClient, 'requestJson' | 'requestRaw'>) {}

  listNamespaces(): Promise<NacosNamespace[]> {
    return fetchNamespaces(this.http, NAMESPACE_LIST_PATH);
  }

  listConfigs(query: NacosConfigListQuery): Promise<Paged<NacosConfigSummary>> {
    return fetchConfigPage(this.http, this.flavor, CONFIG_LIST_PATH, query);
  }

  getConfig(ref: NacosConfigRef): Promise<NacosConfigDetail> {
    return fetchConfigDetail(this.http, this.flavor, CONFIG_DETAIL_PATH, ref);
  }

  listConfigHistory(query: NacosConfigHistoryListQuery): Promise<Paged<NacosConfigHistoryEntry>> {
    return fetchConfigHistoryPage(this.http, this.flavor, CONFIG_HISTORY_LIST_PATH, query);
  }

  getConfigHistory(query: NacosConfigHistoryQuery): Promise<NacosConfigDetail> {
    return fetchConfigHistoryDetail(this.http, this.flavor, CONFIG_HISTORY_DETAIL_PATH, query);
  }

  listConfigListeners(ref: NacosConfigRef): Promise<NacosConfigListener[]> {
    return fetchConfigListeners(this.http, this.flavor, CONFIG_LISTENER_PATH, ref);
  }

  listServices(query: NacosServiceListQuery): Promise<Paged<NacosServiceSummary>> {
    return fetchServicePage(this.http, SERVICE_LIST_PATH, query);
  }

  getService(ref: NacosServiceRef): Promise<NacosServiceDetail> {
    return fetchServiceDetail(this.http, this.flavor, SERVICE_DETAIL_PATH, ref);
  }

  listInstances(query: NacosInstanceQuery): Promise<NacosInstance[]> {
    return fetchInstances(this.http, this.flavor, INSTANCE_LIST_PATH, query);
  }

  listSubscribers(ref: NacosServiceRef): Promise<NacosSubscriber[]> {
    return fetchSubscribers(this.http, this.flavor, SUBSCRIBERS_PATH, ref, FIRST_SUBSCRIBER_PAGE);
  }

  listClusterNodes(): Promise<NacosClusterNode[]> {
    return fetchClusterNodes(this.http, CLUSTER_NODES_PATH);
  }

  getServerMetrics(): Promise<NacosServerMetrics> {
    return fetchServerMetrics(this.http, METRICS_PATH);
  }

  /**
   * 3.x split the reader's two config paths but not the writer's: the publish
   * and the delete share the detail endpoint's address and differ by method.
   */
  publishConfig(request: NacosConfigPublish): Promise<void> {
    return publishConfigAt(this.http, this.flavor, CONFIG_DETAIL_PATH, request);
  }

  deleteConfig(ref: NacosConfigRef): Promise<void> {
    return deleteConfigAt(this.http, this.flavor, CONFIG_DETAIL_PATH, ref);
  }

  updateInstanceHealth(request: NacosInstanceHealthUpdate): Promise<void> {
    return updateInstanceHealthAt(this.http, this.flavor, INSTANCE_PATH, request);
  }
}
