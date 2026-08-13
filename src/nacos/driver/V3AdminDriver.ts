import type { NacosHttpClient } from '../NacosHttpClient';
import { fetchNamespaces, type NacosApiFlavor, type NacosDriver } from './NacosDriver';
import type { NacosNamespace } from './normalize';

/**
 * 3.x's admin API, which uses the server's own base URL (8848 plus the
 * `/nacos` context path) and therefore passes no baseUrlOverride. It requires
 * **administrator identity**, and an ordinary account gets a 403 -- which
 * falls through to V3ConsoleDriver.
 */
const NAMESPACE_LIST_PATH = '/v3/admin/core/namespace/list';

export class V3AdminDriver implements NacosDriver {
  readonly flavor: NacosApiFlavor = 'v3-admin';

  constructor(private readonly http: Pick<NacosHttpClient, 'requestJson'>) {}

  listNamespaces(): Promise<NacosNamespace[]> {
    return fetchNamespaces(this.http, NAMESPACE_LIST_PATH);
  }
}
