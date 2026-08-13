import { NacosApiError } from '../NacosApiError';
import type { NacosHttpClient } from '../NacosHttpClient';
import { isRecord, toStringRecord } from '../jsonGuards';

export interface NacosServerState {
  version: string;
  majorVersion: number;
  startupMode: 'standalone' | 'cluster' | 'unknown';
  /** 只反映 `nacos.core.auth.enabled`。3.x 上为 false 也不代表 admin/console 免鉴权。 */
  authEnabled: boolean;
  raw: Record<string, string>;
}

const V3_STATE_PATH = '/v3/admin/core/state';
const V1_STATE_PATH = '/v1/console/server/state';

/**
 * 3.x 的响应形状存在争议：源码是 `Result<Map<String,String>>`（带包装），
 * 官方文档示例是裸 map。两种都接受。
 */
export function parseServerState(payload: unknown): NacosServerState {
  const raw = unwrap(payload);
  const version = raw.version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new NacosApiError('invalid-response', 'Nacos server state did not report a version.');
  }
  const majorVersion = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (!Number.isFinite(majorVersion)) {
    throw new NacosApiError('invalid-response', `Unrecognized Nacos version string: ${version}`);
  }
  // 2.5 把 standalone_mode 改名成了 startup_mode。用版本号选 key 会在
  // 改名的分界版本上出错，所以两个都读。
  const mode = raw.startup_mode ?? raw.standalone_mode;
  return {
    version,
    majorVersion,
    startupMode: mode === 'standalone' || mode === 'cluster' ? mode : 'unknown',
    authEnabled: raw.auth_enabled === 'true',
    raw
  };
}

/**
 * 带 version 的 `data` 优先于顶层的 version：状态图本身才是我们要的 raw，
 * 顶层只是信封。若反过来取顶层，`{code,message,data:{...}}` 的 raw 会变成
 * `{message:'success'}` —— 既丢了 startup_mode 之类的字段，又会把网关自己
 * 加的 version 当成服务端版本。`data` 里没有 version 时退回顶层，这样文档
 * 里那种裸 map 照样能读。
 */
function unwrap(payload: unknown): Record<string, string> {
  if (isRecord(payload)) {
    const wrapped = toStringRecord(payload.data);
    if (wrapped && typeof wrapped.version === 'string') {
      return wrapped;
    }
  }
  return toStringRecord(payload) ?? {};
}

export async function probeServerState(
  http: Pick<NacosHttpClient, 'requestJson'>
): Promise<NacosServerState> {
  let v3Failure: unknown;
  try {
    return parseServerState(await http.requestJson('GET', V3_STATE_PATH));
  } catch (v3Error) {
    if (!shouldTryOlderState(v3Error)) {
      throw v3Error;
    }
    v3Failure = v3Error;
  }

  try {
    return parseServerState(await http.requestJson('GET', V1_STATE_PATH));
  } catch (v1Error) {
    // 410 意味着这是 3.0/3.1 且 console 兼容开关关闭，也就等于证明了 v3
    // 存在——第一次 v3 失败是别的原因（代理抖了一下、body 截断）。只再试
    // 这一次，失败就抛出去：这不是通用重试策略。
    if (v1Error instanceof NacosApiError && v1Error.kind === 'api-deprecated') {
      return parseServerState(await http.requestJson('GET', V3_STATE_PATH));
    }
    throw combineMissingEndpoints(v3Failure, v1Error) ?? v1Error;
  }
}

/**
 * 两条路径都 404 时，只报 v1 的那条最没有信息量：真正的原因几乎总是
 * context-path 猜错，或者这个地址根本不是 Nacos。kind 保持 not-found，
 * Task 10 的候选遍历照样会接着试下一个 base URL。
 */
function combineMissingEndpoints(v3Error: unknown, v1Error: unknown): NacosApiError | undefined {
  if (!isNotFound(v3Error) || !isNotFound(v1Error)) {
    return undefined;
  }
  return new NacosApiError(
    'not-found',
    `Nacos answered HTTP 404 for both ${V3_STATE_PATH} and ${V1_STATE_PATH}. The context path is probably wrong, or this address is not a Nacos server.`,
    404
  );
}

function isNotFound(error: unknown): boolean {
  return error instanceof NacosApiError && error.kind === 'not-found';
}

/**
 * `invalid-response` 也算：一个把未知路径重写到控制台 SPA 的 Ingress 会让
 * v3 返回 HTML（`requestJson` 判为 invalid-response），而它下面的 v1 是好
 * 的。代价是「每条路径都回同一个 JSON 错误页」的反代会多花一次请求，最终
 * 仍然报错，不会误判成功。
 */
function shouldTryOlderState(error: unknown): boolean {
  return error instanceof NacosApiError && (error.shouldFallThrough() || error.kind === 'invalid-response');
}
