import type { NacosHttpClient } from '../NacosHttpClient';
import { fetchNamespaces, type NacosApiFlavor, type NacosDriver } from './NacosDriver';
import type { NacosNamespace } from './normalize';

/**
 * 1.x 的 `RestResult` 接口，成功码是 **200 而不是 0**（`NacosHttpClient`
 * 两个都认）。这条属于 CONSOLE_API 且没有 @Secured，1.x/2.x 上免鉴权；
 * 3.0/3.1 关掉兼容开关时返回 410、3.2+ 返回 404，两者都会触发降级。
 */
const NAMESPACE_LIST_PATH = '/v1/console/namespaces';

export class V1Driver implements NacosDriver {
  readonly flavor: NacosApiFlavor = 'v1';

  constructor(private readonly http: Pick<NacosHttpClient, 'requestJson'>) {}

  listNamespaces(): Promise<NacosNamespace[]> {
    return fetchNamespaces(this.http, NAMESPACE_LIST_PATH);
  }
}
