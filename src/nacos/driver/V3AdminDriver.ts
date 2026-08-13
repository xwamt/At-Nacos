import type { NacosHttpClient } from '../NacosHttpClient';
import { fetchNamespaces, type NacosApiFlavor, type NacosDriver } from './NacosDriver';
import type { NacosNamespace } from './normalize';

/**
 * 3.x 的 admin API，走服务端 base URL（8848 + context-path `/nacos`），因此
 * 不传 baseUrlOverride。它要求**管理员身份**，普通账号会拿到 403——那时
 * 降级到 V3ConsoleDriver。
 */
const NAMESPACE_LIST_PATH = '/v3/admin/core/namespace/list';

export class V3AdminDriver implements NacosDriver {
  readonly flavor: NacosApiFlavor = 'v3-admin';

  constructor(private readonly http: Pick<NacosHttpClient, 'requestJson'>) {}

  listNamespaces(): Promise<NacosNamespace[]> {
    return fetchNamespaces(this.http, NAMESPACE_LIST_PATH);
  }
}
