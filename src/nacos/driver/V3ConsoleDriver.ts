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
import { fetchClusterNodes, fetchInstances, fetchServicePage, missingCapability } from './naming';
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
 * 3.x's console API lives on **a different origin**: port 8080 by default,
 * with an **empty** context path. So baseUrlOverride has to replace the
 * server's base URL here, or `/v3/console/...` goes to `/nacos` on 8848
 * instead. It asks only for a valid identity, which makes it the fallback for
 * an admin 403.
 */
const NAMESPACE_LIST_PATH = '/v3/console/core/namespace/list';

/** The admin API's two paths under the console prefix; §9 lists them side by side. */
const CONFIG_LIST_PATH = '/v3/console/cs/config/list';
const CONFIG_DETAIL_PATH = '/v3/console/cs/config';

const SERVICE_LIST_PATH = '/v3/console/ns/service/list';
const INSTANCE_LIST_PATH = '/v3/console/ns/instance/list';

/** `nodes`, where the admin API says `node/list`. The console module spells its own paths. */
const CLUSTER_NODES_PATH = '/v3/console/core/cluster/nodes';

/**
 * The console's instance listing is the only one of the four that pages, so
 * it is the only one that has to ask for a page -- its `PageForm` binds a
 * null page number otherwise. 100 is this project's own ceiling (§10) and far
 * past what one service holds in practice; a service with more instances than
 * that would be truncated here, which is the price of an interface where
 * instances are a list.
 */
const FIRST_INSTANCE_PAGE = { pageNo: '1', pageSize: '100' };

export class V3ConsoleDriver implements NacosDriver {
  readonly flavor: NacosApiFlavor = 'v3-console';

  constructor(
    private readonly http: Pick<NacosHttpClient, 'requestJson' | 'requestRaw'>,
    private readonly consoleBaseUrl: string
  ) {}

  listNamespaces(): Promise<NacosNamespace[]> {
    return fetchNamespaces(this.http, NAMESPACE_LIST_PATH, this.onConsoleOrigin());
  }

  listConfigs(query: NacosConfigListQuery): Promise<Paged<NacosConfigSummary>> {
    return fetchConfigPage(this.http, this.flavor, CONFIG_LIST_PATH, query, this.onConsoleOrigin());
  }

  getConfig(ref: NacosConfigRef): Promise<NacosConfigDetail> {
    return fetchConfigDetail(this.http, this.flavor, CONFIG_DETAIL_PATH, ref, this.onConsoleOrigin());
  }

  listServices(query: NacosServiceListQuery): Promise<Paged<NacosServiceSummary>> {
    return fetchServicePage(this.http, SERVICE_LIST_PATH, query, this.onConsoleOrigin());
  }

  listInstances(query: NacosInstanceQuery): Promise<NacosInstance[]> {
    return fetchInstances(this.http, this.flavor, INSTANCE_LIST_PATH, query, {
      ...this.onConsoleOrigin(),
      query: FIRST_INSTANCE_PAGE
    });
  }

  listClusterNodes(): Promise<NacosClusterNode[]> {
    return fetchClusterNodes(this.http, CLUSTER_NODES_PATH, this.onConsoleOrigin());
  }

  /**
   * The console module has controllers for services, instances and cluster
   * nodes, and none for the naming module's metrics -- so this capability has
   * no address on the console API, and no request could discover that.
   * Refusing the way a missing endpoint refuses is what sends the resolver on
   * to a driver that has one.
   */
  getServerMetrics(): Promise<NacosServerMetrics> {
    return Promise.reject(
      missingCapability(
        "Nacos 3.x's console API has no naming metrics endpoint; only the admin API reports them, so there is nothing to ask on the console origin."
      )
    );
  }

  /**
   * Spelled once so that a capability added later cannot be the one that
   * forgets it -- a request without the override reaches the server origin,
   * where `/v3/console/...` does not exist, and the 404 reads as "this
   * version has no console API" rather than as a missing override.
   */
  private onConsoleOrigin(): { baseUrlOverride: string } {
    return { baseUrlOverride: this.consoleBaseUrl };
  }
}
