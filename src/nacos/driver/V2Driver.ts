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
}
