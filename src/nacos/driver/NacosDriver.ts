import type { NacosHttpClient, NacosRequestOptions } from '../NacosHttpClient';
import { normalizeNamespace, unwrapDataArray, type NacosNamespace } from './normalize';

export type NacosApiFlavor = 'v1' | 'v2' | 'v3-admin' | 'v3-console';

/**
 * M1 只定义命名空间能力。后续里程碑按需扩展本接口，每次扩展都必须让
 * 四个实现同时跟进——TypeScript 会强制这一点，这正是把接口做窄的理由。
 */
export interface NacosDriver {
  readonly flavor: NacosApiFlavor;
  listNamespaces(): Promise<NacosNamespace[]>;
}

/**
 * 四个 driver 的 listNamespaces 只差一个路径（v3-console 再多一个 base
 * URL），差异之外的取值、校验、归一化必须逐字相同——否则某个版本的空
 * `data` 会抛 TypeError 而别的版本抛 NacosApiError，降级链的行为就跟服务端
 * 版本挂上钩了。所以共用体放在接口旁边，路径仍写在各自的 driver 文件里：
 * 想知道某个版本打的是哪个 URL，看那一个文件就够。
 */
export async function fetchNamespaces(
  http: Pick<NacosHttpClient, 'requestJson'>,
  path: string,
  options?: NacosRequestOptions
): Promise<NacosNamespace[]> {
  const payload = await http.requestJson<unknown>('GET', path, options);
  return unwrapDataArray(payload, path).map(normalizeNamespace);
}
