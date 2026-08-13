import type { NacosHttpClient, NacosRequestOptions } from '../NacosHttpClient';
import { normalizeNamespace, unwrapDataArray, type NacosNamespace } from './normalize';

export type NacosApiFlavor = 'v1' | 'v2' | 'v3-admin' | 'v3-console';

/**
 * M1 defines the namespace capability and nothing more. Later milestones
 * widen this interface as they need to, and every widening has to bring all
 * four implementations along with it -- TypeScript enforces that, which is
 * exactly why the interface is kept narrow.
 */
export interface NacosDriver {
  readonly flavor: NacosApiFlavor;
  listNamespaces(): Promise<NacosNamespace[]>;
}

/**
 * The four drivers' listNamespaces differ by one path (v3-console by one more
 * base URL). Everything either side of that difference -- the unwrapping, the
 * validation, the normalization -- has to be word-for-word identical, or an
 * empty `data` throws a TypeError on one version and a NacosApiError on
 * another, and the fall-through chain's behaviour becomes a function of the
 * server's version. So the shared part sits beside the interface while the
 * paths stay in their own driver files: to see which URL a version asks for,
 * that one file is enough.
 */
export async function fetchNamespaces(
  http: Pick<NacosHttpClient, 'requestJson'>,
  path: string,
  options?: NacosRequestOptions
): Promise<NacosNamespace[]> {
  const payload = await http.requestJson<unknown>('GET', path, options);
  return unwrapDataArray(payload, path).map(normalizeNamespace);
}
