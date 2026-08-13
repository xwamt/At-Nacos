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
import {
  fetchCatalogServices,
  fetchClusterNodes,
  fetchInstances,
  fetchServerMetrics,
  fetchServiceNames,
  listServicesPreferringCounts
} from './naming';
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
 * v2 never got a catalog of its own, so the counts come from v1's -- the same
 * server serves both, and `/v2/ns/service/list` reports nothing but names
 * (`{"code":0,"data":{"count":N,"services":[...]}}`, measured). The fallback
 * stays on the v2 path: it is this driver's own version, and the only thing
 * the v1 one would add is a second dialect to get wrong.
 */
const CATALOG_SERVICES_PATH = '/v1/ns/catalog/services';
const SERVICE_LIST_PATH = '/v2/ns/service/list';

const INSTANCE_LIST_PATH = '/v2/ns/instance/list';
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

  listServices(query: NacosServiceListQuery): Promise<Paged<NacosServiceSummary>> {
    return listServicesPreferringCounts(
      () => fetchCatalogServices(this.http, CATALOG_SERVICES_PATH, query),
      () => fetchServiceNames(this.http, SERVICE_LIST_PATH, query)
    );
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
