import { NacosApiError } from '../NacosApiError';
import { isRecord } from '../jsonGuards';
// Type-only, so it is erased before any module graph exists at runtime. The
// alternative -- rehoming NacosApiFlavor here -- would put the driver
// vocabulary in a file named for what it does to responses.
import type { NacosApiFlavor } from './NacosDriver';

export type NacosModule = 'config' | 'naming' | 'console';

export interface NacosNamespace {
  /** Empty string on 1.x/2.x, the literal 'public' on 3.x. Carried through verbatim, never normalized. */
  namespaceId: string;
  /** The server's display name. Falls back to the id, which can be empty -- see `normalizeNamespace`. */
  displayName: string;
  description?: string;
  quota?: number;
  configCount?: number;
  /** 0 = global/default, 1 = default private, 2 = custom. */
  type: number;
}

/**
 * Which spelling of the public namespace's id a server stores.
 *
 * On 1.x/2.x it is the empty string, and sending `public` instead addresses a
 * *custom* namespace by that name -- which almost never exists, so the server
 * answers with an empty result and no error at all. 3.x settled on the
 * literal.
 *
 * Keyed on the server's major version rather than on the driver flavor,
 * because this is a question about what the server has stored, not about
 * which endpoint family is being asked.
 */
export function publicNamespaceId(majorVersion: number): string {
  return majorVersion >= 3 ? 'public' : '';
}

/**
 * Which spelling of the namespace parameter an endpoint family expects.
 *
 * Only the v1 config module says `tenant`; the v1 *naming* module already
 * said `namespaceId`, and everything from v2 onward agrees on `namespaceId`.
 * Getting this wrong is silent: the server ignores the unknown parameter and
 * answers for the default namespace.
 *
 * Keyed on flavor rather than on major version, because the spelling follows
 * the endpoint being called, not the server answering it. A 2.x server serves
 * both the v1 paths and the v2 paths, and a major-version argument cannot
 * tell those apart.
 */
export function namespaceParamName(flavor: NacosApiFlavor, module: NacosModule): 'tenant' | 'namespaceId' {
  return flavor === 'v1' && module === 'config' ? 'tenant' : 'namespaceId';
}

/**
 * `displayName` falls back to the id when `namespaceShowName` is absent, and
 * on 1.x the public namespace's id is the empty string -- so the display name
 * can be empty too. No default is invented here: the domain layer should not
 * author display text, and the tree has to special-case public regardless in
 * order to localize it (`l10n` already carries a `public` key). Callers
 * recognize the entry with `publicNamespaceId(majorVersion)`.
 */
export function normalizeNamespace(entry: unknown): NacosNamespace {
  if (!isRecord(entry) || typeof entry.namespace !== 'string') {
    throw new NacosApiError('invalid-response', 'Nacos returned a malformed namespace entry.');
  }
  return {
    namespaceId: entry.namespace,
    displayName: typeof entry.namespaceShowName === 'string' ? entry.namespaceShowName : entry.namespace,
    description: typeof entry.namespaceDesc === 'string' ? entry.namespaceDesc : undefined,
    quota: typeof entry.quota === 'number' ? entry.quota : undefined,
    configCount: typeof entry.configCount === 'number' ? entry.configCount : undefined,
    type: typeof entry.type === 'number' ? entry.type : 0
  };
}

/**
 * v2/v3 的 `{code,message,data}` 与 1.x 的裸响应统一取值。
 *
 * 判据是「`code` 与 `data` 有其一」而不是「两者都有」：`{code:0,
 * message:'success'}`（1.x/2.x 用于无返回值的操作）少了 `data`，若按两者
 * 都有来判就会把信封本身当成内容还给调用方——一个长得像数据的对象，比
 * undefined 难查得多。反过来，1.x 的配置/历史列表是裸 `Page` 对象，两个
 * 键都没有，照原样透传。
 *
 * 只剥一层：外层信封是 Nacos 加的，里面再有同名字段就是数据本身了。
 * body 里的业务 code 由 `NacosHttpClient` 校验，这里不重复判。
 */
export function unwrapData<T>(payload: unknown): T {
  if (isRecord(payload) && ('data' in payload || 'code' in payload)) {
    return payload.data as T;
  }
  return payload as T;
}

/**
 * 列表端点专用：取出 `data` 并确认它真是数组。
 *
 * 少了这道检查，`data` 是 null/对象/缺失时会一路走到 `.map()` 抛
 * `TypeError`。那种错误不带 kind，`NacosCapabilityResolver` 无从判断该不该
 * 降级，会直接中断整条 driver 链。所以在这里换成带 kind 的 NacosApiError，
 * 并把端点写进消息里——四个版本的路径不同，消息里有路径才知道是谁答的。
 */
export function unwrapDataArray(payload: unknown, endpoint: string): unknown[] {
  const data = unwrapData<unknown>(payload);
  if (!Array.isArray(data)) {
    throw new NacosApiError(
      'invalid-response',
      `Nacos returned no list for ${endpoint}: the response carried ${describePayload(data)}.`
    );
  }
  return data;
}

function describePayload(value: unknown): string {
  if (value === undefined) {
    return 'no data';
  }
  if (value === null) {
    return 'null';
  }
  if (isRecord(value)) {
    return 'an object';
  }
  return `a ${typeof value}`;
}
