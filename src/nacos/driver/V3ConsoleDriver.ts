import type { NacosHttpClient } from '../NacosHttpClient';
import { fetchNamespaces, type NacosApiFlavor, type NacosDriver } from './NacosDriver';
import type { NacosNamespace } from './normalize';

/**
 * 3.x 的 console API 在**另一个源**上：默认 8080，context-path 为**空**。
 * 所以这里必须用 baseUrlOverride 覆盖服务端 base URL，否则会把
 * `/v3/console/...` 打到 8848 的 `/nacos` 下面去。它只要求一个有效身份，
 * 于是成为 admin 返回 403 时的兜底。
 */
const NAMESPACE_LIST_PATH = '/v3/console/core/namespace/list';

export class V3ConsoleDriver implements NacosDriver {
  readonly flavor: NacosApiFlavor = 'v3-console';

  constructor(
    private readonly http: Pick<NacosHttpClient, 'requestJson'>,
    private readonly consoleBaseUrl: string
  ) {}

  listNamespaces(): Promise<NacosNamespace[]> {
    return fetchNamespaces(this.http, NAMESPACE_LIST_PATH, { baseUrlOverride: this.consoleBaseUrl });
  }
}
