import type { NacosHttpClient } from '../NacosHttpClient';
import {
  fetchConfigDetail,
  fetchConfigPage,
  fetchNamespaces,
  type NacosApiFlavor,
  type NacosConfigListQuery,
  type NacosDriver
} from './NacosDriver';
import type { NacosConfigDetail, NacosConfigRef, NacosConfigSummary, NacosNamespace, Paged } from './normalize';

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
}
