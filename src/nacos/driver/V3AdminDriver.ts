import type { NacosHttpClient } from '../NacosHttpClient';
import {
  fetchConfigDetail,
  fetchConfigPage,
  fetchNamespaces,
  type NacosApiFlavor,
  type NacosConfigListQuery,
  type NacosDriver,
  type NacosInstanceQuery,
  type NacosServiceListQuery
} from './NacosDriver';
import { fetchClusterNodes, fetchInstances, fetchServerMetrics, fetchServicePage } from './naming';
import type {
  NacosClusterNode,
  NacosConfigDetail,
  NacosConfigRef,
  NacosConfigSummary,
  NacosInstance,
  NacosNamespace,
  NacosServerMetrics,
  NacosServiceSummary,
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
 * 3.x folded the catalog into the standard listing -- `ServiceControllerV3`
 * answers `/list` out of `CatalogServiceV2Impl` -- so there is one endpoint
 * here where 1.x/2.x have two, and no fallback to arrange.
 */
const SERVICE_LIST_PATH = '/v3/admin/ns/service/list';
const INSTANCE_LIST_PATH = '/v3/admin/ns/instance/list';

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

  listServices(query: NacosServiceListQuery): Promise<Paged<NacosServiceSummary>> {
    return fetchServicePage(this.http, SERVICE_LIST_PATH, query);
  }

  listInstances(query: NacosInstanceQuery): Promise<NacosInstance[]> {
    return fetchInstances(this.http, this.flavor, INSTANCE_LIST_PATH, query);
  }

  listClusterNodes(): Promise<NacosClusterNode[]> {
    return fetchClusterNodes(this.http, CLUSTER_NODES_PATH);
  }

  getServerMetrics(): Promise<NacosServerMetrics> {
    return fetchServerMetrics(this.http, METRICS_PATH);
  }
}
