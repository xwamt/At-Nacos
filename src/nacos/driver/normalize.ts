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
 * tell those apart. Read the argument as the endpoint family, therefore, not
 * as the driver asking: `V2Driver` reaches the v1 config endpoints, so its
 * config requests have to ask as v1.
 */
export function namespaceParamName(flavor: NacosApiFlavor, module: NacosModule): 'tenant' | 'namespaceId' {
  return flavor === 'v1' && module === 'config' ? 'tenant' : 'namespaceId';
}

/**
 * Which spelling of the group parameter an endpoint family expects.
 *
 * Splits exactly where `namespaceParamName` splits, and the two must always
 * be used together: a request that says `tenant` and `groupName` is half in
 * each dialect, and the half the server does not recognize is dropped in
 * silence rather than refused. Only v1's config module says `group`; v1
 * naming already said `groupName`, and v3 settled on it everywhere.
 */
export function groupParamName(flavor: NacosApiFlavor, module: NacosModule): 'group' | 'groupName' {
  return flavor === 'v1' && module === 'config' ? 'group' : 'groupName';
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

/** Where a config lives. All three are needed to fetch it, and `namespaceId` is '' for 1.x/2.x public. */
export interface NacosConfigRef {
  namespaceId: string;
  group: string;
  dataId: string;
}

export interface NacosConfigSummary extends NacosConfigRef {
  /** null on a blur search; callers fall back to the dataId suffix. */
  type?: string;
  appName?: string;
  md5?: string;
}

export interface NacosConfigDetail extends NacosConfigSummary {
  content: string;
  createTime?: number;
  modifyTime?: number;
  createIp?: string;
  description?: string;
}

/**
 * One entry of a config listing, with the content taken out.
 *
 * **`content` is dropped on purpose.** The server sends the whole config body
 * in every list item whether we want it or not -- 12 configs measured 38KB on
 * a real 2.3.2, and v1 has no parameter to exclude it. Keeping it would mean
 * every node of the tree holds a full config body, and those bodies contain
 * database passwords. Dropping it here, at the boundary, is what lets every
 * layer above be unable to leak it.
 *
 * Field names differ by version: 1.x/2.x say `group` and `tenant`, 3.x says
 * `groupName` and `namespaceId`. Whichever is present is taken, and the 3.x
 * spelling wins if a compatibility layer sends both -- in that arrangement it
 * is the legacy alias that goes stale.
 */
export function normalizeConfigSummary(entry: unknown): NacosConfigSummary {
  const record = asConfigRecord(entry);
  return {
    // '' rather than a thrown error: the 1.x public namespace really is the
    // empty string, so there is no value here that means "missing".
    namespaceId: firstString(record.namespaceId, record.tenant) ?? '',
    group: firstString(record.groupName, record.group) ?? '',
    dataId: record.dataId,
    type: optionalString(record.type),
    appName: optionalString(record.appName),
    md5: optionalString(record.md5)
  };
}

/** A single config with its body, from `?show=all` on v1/v2 or the config detail endpoint on v3. */
export function normalizeConfigDetail(entry: unknown): NacosConfigDetail {
  const summary = normalizeConfigSummary(entry);
  const record = asConfigRecord(entry);
  const content = record.content;
  if (typeof content !== 'string') {
    // Defaulting to '' would open an empty editor for a config that is not
    // empty, indistinguishable from the real thing -- and M5's publish path
    // could then write that emptiness back to the server.
    throw new NacosApiError(
      'invalid-response',
      `Nacos returned no content for the config ${summary.dataId}: the response carried ${describePayload(content)}.`
    );
  }
  return {
    ...summary,
    content,
    createTime: optionalNumber(record.createTime),
    modifyTime: optionalNumber(record.modifyTime),
    createIp: optionalString(record.createIp),
    description: optionalString(record.desc)
  };
}

/**
 * The dataId is the entry's identity: without one there is nothing to render
 * in the tree and nothing to fetch. A rename of that field in a future
 * version breaks every item alike, so failing on the first says what happened
 * more clearly than a page of blanks would.
 */
function asConfigRecord(entry: unknown): Record<string, unknown> & { dataId: string } {
  if (!isRecord(entry) || typeof entry.dataId !== 'string' || entry.dataId.length === 0) {
    throw new NacosApiError('invalid-response', 'Nacos returned a config entry with no dataId.');
  }
  return entry as Record<string, unknown> & { dataId: string };
}

/** Takes the first spelling a server actually sent, and '' counts as sent. */
function firstString(...candidates: unknown[]): string | undefined {
  return candidates.find((candidate): candidate is string => typeof candidate === 'string');
}

/**
 * Nacos spells "not set" three different ways in one config entry: `''` for
 * `appName` and `desc`, null for `type` under a blur search, and null for
 * `md5` under an accurate one. Folding all of them into undefined is what
 * lets callers write one check instead of three.
 */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
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

export interface Paged<T> {
  items: T[];
  totalCount: number;
  pageNumber: number;
  pagesAvailable: number;
}

/**
 * For paged endpoints: reads both the bare `Page` that 1.x/2.x answer the
 * config list with and the `{code,message,data:{...}}` that 3.x wraps the
 * same object in.
 *
 * A payload that is neither raises `invalid-response` naming the endpoint,
 * for the same reason `unwrapDataArray` does: a raw TypeError out of `.map()`
 * carries no kind, so `NacosCapabilityResolver` cannot judge whether to try
 * the next driver and the chain stops there instead of falling through.
 *
 * Missing counters degrade rather than throw. The items are the payload and
 * the counters are only navigation, so a response that carries rows is worth
 * showing even if it forgot to say how many pages there are.
 */
export function normalizePaged<T>(payload: unknown, mapItem: (entry: unknown) => T, endpoint: string): Paged<T> {
  const page = unwrapData<unknown>(payload);
  if (!isRecord(page) || !Array.isArray(page.pageItems)) {
    throw new NacosApiError(
      'invalid-response',
      `Nacos returned no page for ${endpoint}: the response carried ${describePage(page)}.`
    );
  }
  const items = page.pageItems.map((entry: unknown) => mapItem(entry));
  return {
    items,
    totalCount: typeof page.totalCount === 'number' ? page.totalCount : items.length,
    pageNumber: typeof page.pageNumber === 'number' ? page.pageNumber : 1,
    pagesAvailable: typeof page.pagesAvailable === 'number' ? page.pagesAvailable : 1
  };
}

/** Points at the `pageItems` slot when there is one, since that is the field that failed. */
function describePage(page: unknown): string {
  if (!isRecord(page)) {
    return describePayload(page);
  }
  return `an object whose pageItems field carried ${describePayload(page.pageItems)}`;
}

function describePayload(value: unknown): string {
  if (value === undefined) {
    return 'no data';
  }
  if (value === null) {
    return 'null';
  }
  // Before the isRecord check, which excludes arrays and would otherwise let
  // one fall through to the ungrammatical, undiagnostic "a object".
  if (Array.isArray(value)) {
    return 'an array';
  }
  if (isRecord(value)) {
    return 'an object';
  }
  return `a ${typeof value}`;
}
