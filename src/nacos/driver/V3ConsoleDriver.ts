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
