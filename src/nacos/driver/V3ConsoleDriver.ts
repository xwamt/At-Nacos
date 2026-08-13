import type { NacosHttpClient } from '../NacosHttpClient';
import { fetchNamespaces, type NacosApiFlavor, type NacosDriver } from './NacosDriver';
import type { NacosNamespace } from './normalize';

/**
 * 3.x's console API lives on **a different origin**: port 8080 by default,
 * with an **empty** context path. So baseUrlOverride has to replace the
 * server's base URL here, or `/v3/console/...` goes to `/nacos` on 8848
 * instead. It asks only for a valid identity, which makes it the fallback for
 * an admin 403.
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
