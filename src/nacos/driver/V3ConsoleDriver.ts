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
  fetchClusterNodes,
  fetchInstances,
  fetchServiceDetail,
  fetchServicePage,
  fetchSubscribers,
  missingCapability
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

const CONFIG_HISTORY_LIST_PATH = '/v3/console/cs/history/list';
const CONFIG_HISTORY_DETAIL_PATH = '/v3/console/cs/history';

/** The one that only asks for READ where the admin API's asks for WRITE (§9). */
const CONFIG_LISTENER_PATH = '/v3/console/cs/config/listener';

const SERVICE_LIST_PATH = '/v3/console/ns/service/list';
const SERVICE_DETAIL_PATH = '/v3/console/ns/service';
const INSTANCE_LIST_PATH = '/v3/console/ns/instance/list';

/**
 * The console module's instance controller has exactly two mappings: the
 * listing and this PUT. It cannot register or deregister -- which is fine,
 * since taking an instance out of rotation is the only instance write this
 * project has.
 */
const INSTANCE_PATH = '/v3/console/ns/instance';
const SUBSCRIBERS_PATH = '/v3/console/ns/service/subscribers';

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

/**
 * The subscriber listing pages on 3.x too -- v1's does not -- so the same
 * page is asked for, for the same reason and at the same ceiling.
 */
const FIRST_SUBSCRIBER_PAGE = { pageNo: '1', pageSize: '100' };

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

  listConfigHistory(query: NacosConfigHistoryListQuery): Promise<Paged<NacosConfigHistoryEntry>> {
    return fetchConfigHistoryPage(this.http, this.flavor, CONFIG_HISTORY_LIST_PATH, query, this.onConsoleOrigin());
  }

  getConfigHistory(query: NacosConfigHistoryQuery): Promise<NacosConfigDetail> {
    return fetchConfigHistoryDetail(this.http, this.flavor, CONFIG_HISTORY_DETAIL_PATH, query, this.onConsoleOrigin());
  }

  listConfigListeners(query: NacosListenerQuery): Promise<NacosConfigListener[]> {
    return fetchConfigListeners(this.http, this.flavor, CONFIG_LISTENER_PATH, query, this.onConsoleOrigin());
  }

  listServices(query: NacosServiceListQuery): Promise<Paged<NacosServiceSummary>> {
    return fetchServicePage(this.http, SERVICE_LIST_PATH, query, this.onConsoleOrigin());
  }

  getService(ref: NacosServiceRef): Promise<NacosServiceDetail> {
    return fetchServiceDetail(this.http, this.flavor, SERVICE_DETAIL_PATH, ref, this.onConsoleOrigin());
  }

  listInstances(query: NacosInstanceQuery): Promise<NacosInstance[]> {
    return fetchInstances(this.http, this.flavor, INSTANCE_LIST_PATH, query, {
      ...this.onConsoleOrigin(),
      query: FIRST_INSTANCE_PAGE
    });
  }

  listSubscribers(query: NacosSubscriberQuery): Promise<NacosSubscriber[]> {
    return fetchSubscribers(this.http, this.flavor, SUBSCRIBERS_PATH, query, {
      ...this.onConsoleOrigin(),
      query: FIRST_SUBSCRIBER_PAGE
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

  publishConfig(request: NacosConfigPublish): Promise<void> {
    return publishConfigAt(this.http, this.flavor, CONFIG_DETAIL_PATH, request, this.onConsoleOrigin());
  }

  deleteConfig(ref: NacosConfigRef): Promise<void> {
    return deleteConfigAt(this.http, this.flavor, CONFIG_DETAIL_PATH, ref, this.onConsoleOrigin());
  }

  updateInstanceHealth(request: NacosInstanceHealthUpdate): Promise<void> {
    return updateInstanceHealthAt(this.http, this.flavor, INSTANCE_PATH, request, this.onConsoleOrigin());
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
