import type { NacosHttpClient } from '../NacosHttpClient';
import { fetchNamespaces, type NacosApiFlavor, type NacosDriver } from './NacosDriver';
import type { NacosNamespace } from './normalize';

/**
 * 1.x's `RestResult` interface, whose success code is **200 rather than 0**
 * (`NacosHttpClient` accepts both). This one is a CONSOLE_API and carries no
 * @Secured, so it needs no authentication on 1.x/2.x; 3.0/3.1 answer 410 with
 * the compatibility switch off and 3.2+ answer 404, and both fall through.
 */
const NAMESPACE_LIST_PATH = '/v1/console/namespaces';

export class V1Driver implements NacosDriver {
  readonly flavor: NacosApiFlavor = 'v1';

  constructor(private readonly http: Pick<NacosHttpClient, 'requestJson'>) {}

  listNamespaces(): Promise<NacosNamespace[]> {
    return fetchNamespaces(this.http, NAMESPACE_LIST_PATH);
  }
}
