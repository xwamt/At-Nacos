import type { NacosHttpClient } from '../NacosHttpClient';
import { fetchNamespaces, type NacosApiFlavor, type NacosDriver } from './NacosDriver';
import type { NacosNamespace } from './normalize';

/** The v2 endpoint 2.x added: entries have v1's shape, and the success code becomes 0. It needs no auth either. */
const NAMESPACE_LIST_PATH = '/v2/console/namespace/list';

export class V2Driver implements NacosDriver {
  readonly flavor: NacosApiFlavor = 'v2';

  constructor(private readonly http: Pick<NacosHttpClient, 'requestJson'>) {}

  listNamespaces(): Promise<NacosNamespace[]> {
    return fetchNamespaces(this.http, NAMESPACE_LIST_PATH);
  }
}
