import { NacosApiError } from '../NacosApiError';
import { isRecord } from '../jsonGuards';

export type NacosModule = 'config' | 'naming' | 'console';

export interface NacosNamespace {
  /** 1.x/2.x 的 public 是空字符串，3.x 是字面量 'public'。原样保留，不做归一。 */
  namespaceId: string;
  /** 服务端给的展示名。缺 `namespaceShowName` 时退回 id，可能是空串，见 `normalizeNamespace`。 */
  displayName: string;
  description?: string;
  quota?: number;
  configCount?: number;
  /** 0 = 全局/默认，1 = 默认私有，2 = 自定义。 */
  type: number;
}

/**
 * 1.x/2.x 里 public 的 id 是空字符串；传 `tenant=public` 会被当成一个
 * 名叫 "public" 的自定义命名空间，查出来是空的。3.x 统一成了字面量。
 */
export function publicNamespaceId(majorVersion: number): string {
  return majorVersion >= 3 ? 'public' : '';
}

/**
 * 1.x 的 config 模块用 `tenant`，同一版本的 naming 模块却用 `namespaceId`。
 * 这是最经常写错的地方，所以集中在这里映射，不允许在 driver 里硬编码。
 *
 * 注意 2.x：它同时保留了 v1 与 v2 两套端点，v1 config 仍是 `tenant`，v2
 * config 已经是 `namespaceId`——只看大版本号分不出这两者。当前按 v1 的拼法
 * 回答（2.x 上我们走的就是 v1 端点）。等哪个里程碑真的调用 v2 的 config
 * 端点时，这里要改成按 driver flavor 而不是大版本号来判断。
 */
export function namespaceParamName(majorVersion: number, module: NacosModule): 'tenant' | 'namespaceId' {
  if (majorVersion >= 3) {
    return 'namespaceId';
  }
  return module === 'config' ? 'tenant' : 'namespaceId';
}

/**
 * `displayName` 在缺 `namespaceShowName` 时退回 id，而 1.x 的 public 其 id
 * 就是空串——于是展示名也是空的。这里不补默认文案：领域层不该造展示文本，
 * 而且树层本来就要为 public 做本地化（l10n 里已有 `public` 这条），补了反
 * 而多一处版本相关的特判。调用方用 `publicNamespaceId(majorVersion)` 就能
 * 认出这一条。
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
