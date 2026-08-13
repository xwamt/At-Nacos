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
}
