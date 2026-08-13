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
 * Reads v2/v3's `{code,message,data}` and 1.x's bare responses the same way.
 *
 * The test is that *either* `code` or `data` is present, not that both are:
 * `{code:0, message:'success'}`, which 1.x/2.x use for operations that return
 * nothing, has no `data`, and a both-must-be-present test would hand the
 * envelope itself back to the caller as the content -- an object that looks
 * like data is much harder to track down than an undefined. In the other
 * direction, 1.x's config and history listings are bare `Page` objects with
 * neither key, and pass through as they are.
 *
 * One layer only: the outer envelope is Nacos's, and a field of the same name
 * inside it is the data itself. The business code in the body is checked by
 * `NacosHttpClient`, and is not checked again here.
 */
export function unwrapData<T>(payload: unknown): T {
  if (isRecord(payload) && ('data' in payload || 'code' in payload)) {
    return payload.data as T;
  }
  return payload as T;
}

/**
 * For list endpoints: takes `data` out and confirms it really is an array.
 *
 * Without this check, a `data` that is null, an object or missing travels as
 * far as `.map()` and throws a `TypeError`. That error carries no kind, so
 * `NacosCapabilityResolver` has no way to judge whether to fall through and
 * the whole driver chain stops there. A NacosApiError with a kind goes out
 * instead, with the endpoint written into the message -- the four versions
 * each have their own path, and only a path in the message says which of them
 * answered.
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
