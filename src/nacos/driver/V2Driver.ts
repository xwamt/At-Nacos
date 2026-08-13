import type { NacosHttpClient } from '../NacosHttpClient';
import { fetchNamespaces, type NacosApiFlavor, type NacosDriver } from './NacosDriver';
import type { NacosNamespace } from './normalize';

/** 2.x 新增的 v2 端点：条目形状与 v1 相同，成功码换成了 0。同样免鉴权。 */
const NAMESPACE_LIST_PATH = '/v2/console/namespace/list';

export class V2Driver implements NacosDriver {
  readonly flavor: NacosApiFlavor = 'v2';

  constructor(private readonly http: Pick<NacosHttpClient, 'requestJson'>) {}

  listNamespaces(): Promise<NacosNamespace[]> {
    return fetchNamespaces(this.http, NAMESPACE_LIST_PATH);
  }
}
