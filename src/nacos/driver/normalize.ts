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
 * Which spelling of the config-tags filter an endpoint family expects.
 *
 * v1's list endpoint reads `config_tags`; v2 renamed it to `configTags` and
 * v3 kept that. Getting this wrong is silent: the unknown parameter is
 * dropped and the listing is unfiltered. Read the argument as the endpoint
 * family, the same way `groupParamName` is: `V2Driver` reaches the v1 config
 * endpoints, so its config requests have to ask as v1.
 */
export function configTagsParamName(flavor: NacosApiFlavor): 'config_tags' | 'configTags' {
  return flavor === 'v1' ? 'config_tags' : 'configTags';
}

/**
 * Which spelling of the cluster filter an endpoint family expects.
 *
 * v1 takes **`clusters`**, plural and comma-separated, and splits it into a
 * set; v2 renamed it to the singular `clusterName` and v3 kept that. Both
 * were seen answering on a real 2.3.2, which echoes the parsed value back in
 * the ServiceInfo's `clusters` field. Getting it wrong is silent in the worst
 * way here -- an unrecognized parameter is dropped, so the request asks for
 * *every* cluster and the answer looks like a filter that matched everything.
 */
export function clusterParamName(flavor: NacosApiFlavor): 'clusters' | 'clusterName' {
  return flavor === 'v1' ? 'clusters' : 'clusterName';
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
 * One past version of a configuration.
 *
 * `getConfigHistory` answers with a `NacosConfigDetail` rather than with a
 * fuller version of this, deliberately: the document layer renders both sides
 * of a diff, and a type of its own for the history side would make it branch
 * on which side it was rendering.
 */
export interface NacosConfigHistoryEntry extends NacosConfigRef {
  /** The history record's id. Goes back as the `nid` parameter to fetch this version. */
  id: string;
  /** `I` inserted / `U` updated / `D` deleted. Already trimmed -- see `normalizeConfigHistoryEntry`. */
  opType: string;
  /** Milliseconds, whichever of Nacos's two spellings and two types the server used. */
  modifiedAt?: number;
  srcIp?: string;
  srcUser?: string;
  appName?: string;
}

/** One client currently holding a copy of a configuration. */
export interface NacosConfigListener {
  ip: string;
  /** What that client last received. A value other than the config's current md5 means it is behind. */
  md5: string;
}

/** One configuration a given client IP is currently listening to. */
export interface NacosListenedConfig {
  group: string;
  dataId: string;
  md5: string;
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
    // The history spellings are read here too, because a history version is
    // handed back as one of these: without them a past version would render
    // with no date on it while the current one has both.
    createTime: optionalEpochMillis(record.createTime, record.createdTime),
    modifyTime: optionalEpochMillis(record.modifyTime, record.lastModifiedTime),
    createIp: optionalString(record.createIp),
    description: optionalString(record.desc)
  };
}

/**
 * One row of a configuration's history, in either version's spelling.
 *
 * The row's own field names are **not verified against a real server**: the
 * 2.3.2 this project tests against holds no history at all, so only the empty
 * page around them has been measured (§14.8). They come from
 * `ConfigHistoryInfo` (1.x/2.x) and `ConfigHistoryBasicInfo` (3.x), and both
 * name pairs are read on every version rather than keyed to a flavor --
 * guessing wrong about which server sends which would cost a whole column,
 * and accepting both costs nothing.
 *
 * `ref` is the config the history was asked for, and it stands in for a
 * namespace or group the row does not spell. Unlike a config *listing*, whose
 * rows span a whole namespace, every row here belongs to one dataId in one
 * group -- so the fallback cannot name the wrong config, and it matters
 * because an entry that arrived without its group would address the wrong
 * document when something later builds a URI from it.
 */
export function normalizeConfigHistoryEntry(entry: unknown, ref: NacosConfigRef): NacosConfigHistoryEntry {
  const record = asConfigRecord(entry);
  const id = historyRecordId(record.id);
  if (id === undefined) {
    // Fetching the version is the one action a history row exists to offer,
    // and the id is the only thing that can address it. A row that renders
    // and then does nothing when clicked is worse than a named failure.
    throw new NacosApiError('invalid-response', `Nacos returned a history entry for ${record.dataId} with no id.`);
  }
  return {
    // The dataId is not defaulted, because `asConfigRecord` is the shape
    // check as well as the identity one and every config normalizer owes it.
    namespaceId: firstString(record.namespaceId, record.tenant) ?? ref.namespaceId,
    group: firstString(record.groupName, record.group) ?? ref.group,
    dataId: record.dataId,
    id,
    // The value is stored in a database `char` column, which pads it: every
    // version sends `"I "`, `"U "`, `"D "`. Anything downstream comparing
    // against `'D'` would be wrong on every row without this.
    opType: typeof record.opType === 'string' ? record.opType.trim() : '',
    modifiedAt: optionalEpochMillis(record.modifyTime, record.lastModifiedTime),
    srcIp: optionalString(record.srcIp),
    srcUser: optionalString(record.srcUser),
    appName: optionalString(record.appName)
  };
}

/** The id is a database `bigint`, so it arrives as a number and goes back out as a query parameter. */
function historyRecordId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The clients currently holding a copy of one configuration, keyed by address.
 *
 * **`lisentersGroupkeyStatus` is misspelled in Nacos itself** -- confirmed
 * verbatim on a real 2.3.2 -- so reading the correct spelling alone would
 * find nothing on every server in existence. The corrected spelling is read
 * as well, because a typo in a field name is the kind of thing that
 * eventually gets fixed. 3.x `ConfigListenerInfo` renamed the map to
 * `listenersStatus`, which is the Maintainer SDK / Admin API shape.
 *
 * An empty map is the ordinary answer, not a failure: it is what a config
 * nobody is watching returns, and also -- measured -- what a dataId nobody
 * ever published returns. Only a response with none of these maps at all is
 * a shape this cannot read.
 */
export function normalizeConfigListeners(payload: unknown, endpoint: string): NacosConfigListener[] {
  const data = unwrapData<unknown>(payload);
  const status = listenerStatusIn(data);
  if (status === undefined) {
    throw new NacosApiError(
      'invalid-response',
      `Nacos returned no listener status for ${endpoint}: the response carried ${describePayload(data)}.`
    );
  }
  return Object.entries(stringMap(status)).map(([ip, md5]) => ({ ip, md5 }));
}

/**
 * Nacos GroupKey is `dataId+group` or `dataId+group+tenant`. The first two
 * segments are identity; anything after the second plus is tenant and is
 * dropped. `requestJson` already decoded the JSON string, so this does not
 * URL-decode again.
 */
export function parseGroupKey(groupKey: string): { dataId: string; group: string } {
  const parts = groupKey.split('+');
  if (parts.length < 2) {
    return { dataId: groupKey, group: '' };
  }
  return { dataId: parts[0] ?? groupKey, group: parts[1] ?? '' };
}

/**
 * The configurations one client IP currently holds. 1.x/2.x key them in
 * `lisentersGroupkeyStatus`; 3.x `ConfigListenerInfo` uses `listenersStatus`.
 */
export function normalizeListenedConfigs(payload: unknown, endpoint: string): NacosListenedConfig[] {
  const data = unwrapData<unknown>(payload);
  const status = listenerStatusIn(data);
  if (status === undefined) {
    throw new NacosApiError(
      'invalid-response',
      `Nacos returned no listener status for ${endpoint}: the response carried ${describePayload(data)}.`
    );
  }
  return Object.entries(stringMap(status)).map(([groupKey, md5]) => {
    const { dataId, group } = parseGroupKey(groupKey);
    return { dataId, group, md5 };
  });
}

function listenerStatusIn(data: unknown): Record<string, unknown> | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  const status =
    data.lisentersGroupkeyStatus ?? data.listenersGroupkeyStatus ?? data.listenersStatus;
  return isRecord(status) ? status : undefined;
}

/**
 * Nacos's two spellings of a timestamp, read as one number of milliseconds.
 *
 * 1.x/2.x are documented to serialize the history timestamps as ISO strings
 * (`createdTime` / `lastModifiedTime`); 3.x renamed the fields
 * (`createTime` / `modifyTime`) and sends milliseconds. Both types are
 * accepted under both names because the pairing is research rather than a
 * measurement, and a caller should never have to know which it got.
 *
 * **An unparseable value yields undefined, never NaN.** `NaN` is a number, so
 * it passes every `typeof` check between here and the view and then surfaces
 * as "Invalid Date" -- a value that looks like a timestamp, is not one, and
 * says nothing about where it came from.
 */
function optionalEpochMillis(...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === 'string' && candidate.length > 0) {
      const parsed = Date.parse(candidate);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
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

/** Nacos's separator between a group and a service name, everywhere both are carried in one string. */
const GROUP_SEPARATOR = '@@';

/** Where a service lives. All three are needed to list its instances. */
export interface NacosServiceRef {
  namespaceId: string;
  group: string;
  serviceName: string;
}

/**
 * The namespace and group a listing was asked for.
 *
 * 1.x answers a service listing with names and nothing else, so the only
 * thing that can place those names is the question that produced them.
 */
export interface NacosServiceScope {
  namespaceId: string;
  group: string;
}

export interface NacosServiceSummary extends NacosServiceRef {
  /** Absent on the 1.x/2.x name-only listings; only the catalog and 3.x carry counts. */
  instanceCount?: number;
  healthyInstanceCount?: number;
  clusterCount?: number;
  /** Whether the service's protect threshold is currently tripped. */
  triggerFlag?: boolean;
}

export interface NacosInstance {
  ip: string;
  port: number;
  healthy: boolean;
  enabled: boolean;
  weight: number;
  clusterName: string;
  ephemeral: boolean;
  instanceId?: string;
  metadata: Record<string, string>;
}

/** One cluster a service is divided into, with the health check configured for it. */
export interface NacosServiceCluster {
  name: string;
  /** `TCP` | `HTTP` | `MYSQL` | `NONE`, and absent when the service named none. */
  healthCheckerType?: string;
  metadata: Record<string, string>;
}

/**
 * One service's own configuration, as opposed to a row of a listing.
 *
 * Carries no instance counts: those belong to the listing, which is the
 * endpoint that computes them.
 */
export interface NacosServiceDetail extends NacosServiceRef {
  /** The fraction of healthy instances below which Nacos starts returning unhealthy ones too. */
  protectThreshold: number;
  metadata: Record<string, string>;
  /** Absent on 1.x, which does not report it. */
  ephemeral?: boolean;
  clusters: NacosServiceCluster[];
}

/**
 * One client watching a service for changes.
 *
 * Extends the service ref because the server names the service in every row,
 * and it names it with the group folded in -- so something has to take that
 * apart, and the place that does may as well keep the result.
 */
export interface NacosSubscriber extends NacosServiceRef {
  ip: string;
  /** **0 for a gRPC subscriber**, which has no callback port. Not a missing value. */
  port: number;
  /** The client's own identification, e.g. `Nacos-Java-Client:v2.3.2`. */
  agent?: string;
  app?: string;
  cluster?: string;
}

/** One JRaft group a server node takes part in, flattened out of `extendInfo.raftMetaData`. */
export interface NacosRaftGroup {
  group: string;
  leader: string;
  members: string[];
  term: number;
}

export interface NacosClusterNode {
  address: string;
  ip: string;
  port: number;
  /** `STARTING` | `UP` | `SUSPICIOUS` | `DOWN` | `ISOLATION`, and `UNKNOWN` when the node named none. */
  state: string;
  version?: string;
  raftPort?: string;
  failAccessCnt?: number;
  raftGroups?: NacosRaftGroup[];
}

export interface NacosServerMetrics {
  status: string;
  /** All absent when the request forgot `onlyStatus=false`; see `fetchServerMetrics`. */
  serviceCount?: number;
  instanceCount?: number;
  subscribeCount?: number;
  clientCount?: number;
  cpu?: number;
  load?: number;
  mem?: number;
}

/**
 * Splits Nacos's `GROUP@@service` into its two halves.
 *
 * The split is at the **first** separator and the rest is the name. Nacos's
 * own `NamingUtils.getServiceName` splits on every occurrence and keeps only
 * the second field, which would turn `g@@b@@c` into `b` -- a client that
 * renames a service is worse than one that shows an unusual name. (2.3.2's
 * parameter checker rejects such a name on the way in, so this only decides
 * what happens to one that got in some other way.)
 *
 * A leading separator leaves no group, so the scope's group answers instead.
 */
export function splitGroupedServiceName(
  grouped: string,
  fallbackGroup: string
): { group: string; serviceName: string } {
  const separator = grouped.indexOf(GROUP_SEPARATOR);
  if (separator <= 0) {
    return { group: fallbackGroup, serviceName: grouped.slice(separator < 0 ? 0 : GROUP_SEPARATOR.length) };
  }
  return { group: grouped.slice(0, separator), serviceName: grouped.slice(separator + GROUP_SEPARATOR.length) };
}

/**
 * Joins a group and a service back into the one string Nacos parses them out
 * of, which is how v1's instance endpoint -- which has no group parameter at
 * all -- is told which group to look in.
 *
 * An empty group would produce a leading separator and put the service in a
 * group named `''`, so the bare name goes instead and the server applies its
 * own default.
 */
export function groupedServiceName(ref: NacosServiceRef): string {
  return ref.group.length === 0 ? ref.serviceName : `${ref.group}${GROUP_SEPARATOR}${ref.serviceName}`;
}

/**
 * One entry of a service listing, in any of the three shapes §6.5 lists.
 *
 * **A bare string is a valid entry.** 1.x answers `{"count":N,"doms":[...]}`
 * with nothing but names in it, so the scope supplies what the entry cannot.
 * The counts stay undefined rather than becoming zeroes: a tree that colors
 * services by health has to be able to tell "no healthy instances" from "the
 * endpoint does not report health", and a zero would paint the whole listing
 * red.
 */
export function normalizeServiceSummary(entry: unknown, scope: NacosServiceScope): NacosServiceSummary {
  if (typeof entry === 'string' && entry.length > 0) {
    return { namespaceId: scope.namespaceId, ...splitGroupedServiceName(entry, scope.group) };
  }
  if (!isRecord(entry)) {
    throw new NacosApiError('invalid-response', 'Nacos returned a service entry that is neither a name nor an object.');
  }
  const named = firstString(entry.name, entry.serviceName);
  if (named === undefined || named.length === 0) {
    throw new NacosApiError('invalid-response', 'Nacos returned a service entry with no service name.');
  }
  const grouped = splitGroupedServiceName(named, firstString(entry.groupName, entry.group) ?? scope.group);
  return {
    namespaceId: firstString(entry.namespaceId, entry.namespace) ?? scope.namespaceId,
    group: grouped.group,
    serviceName: grouped.serviceName,
    instanceCount: optionalNumber(entry.ipCount ?? entry.instanceCount),
    healthyInstanceCount: optionalNumber(entry.healthyInstanceCount),
    clusterCount: optionalNumber(entry.clusterCount),
    triggerFlag: optionalBoolean(entry.triggerFlag)
  };
}

/**
 * One instance, from `hosts[]`, `data[]` or `pageItems[]` -- the same POJO
 * however it is wrapped.
 *
 * The heartbeat plumbing (`instanceHeartBeatInterval` and friends) is dropped
 * on the way through: it is a client's business, not a viewer's.
 *
 * The fields Nacos's `Instance` POJO initializes are defaulted to what that
 * initializer says rather than to a zero value, so an entry that omits one
 * reads the way the server would have meant it. `clusterName` has no such
 * initializer and so has no default to borrow.
 */
export function normalizeInstance(entry: unknown): NacosInstance {
  if (!isRecord(entry) || typeof entry.ip !== 'string' || entry.ip.length === 0) {
    throw new NacosApiError('invalid-response', 'Nacos returned an instance with no ip:port address.');
  }
  const port =
    typeof entry.port === 'number'
      ? entry.port
      : typeof entry.port === 'string'
        ? parseInt(entry.port, 10)
        : Number.NaN;
  if (Number.isNaN(port)) {
    throw new NacosApiError('invalid-response', 'Nacos returned an instance with no ip:port address.');
  }
  return {
    ip: entry.ip,
    port,
    healthy: entry.healthy !== false,
    enabled: entry.enabled !== false,
    weight: optionalNumber(entry.weight) ?? 1,
    clusterName: typeof entry.clusterName === 'string' ? entry.clusterName : '',
    ephemeral: entry.ephemeral !== false,
    instanceId: optionalString(entry.instanceId),
    metadata: stringMap(entry.metadata)
  };
}

/**
 * The three shapes an instance listing arrives in (§6.4), read as one list.
 *
 * v1/v2 wrap the hosts in a ServiceInfo, v3's admin API answers with the
 * array itself, and v3's console API pages it. Which one a driver gets is not
 * something the driver should have to restate, so all three land here.
 *
 * A shape that is none of the three raises `invalid-response` naming the
 * endpoint, for the reason `unwrapDataArray` does: a raw TypeError out of
 * `.map()` carries no kind, so the resolver cannot judge whether to fall
 * through and the chain stops there instead.
 */
export function normalizeInstanceList(payload: unknown, endpoint: string): NacosInstance[] {
  const data = unwrapData<unknown>(payload);
  const hosts = Array.isArray(data) ? data : instanceArrayIn(data);
  if (hosts === undefined) {
    throw new NacosApiError(
      'invalid-response',
      `Nacos returned no instances for ${endpoint}: the response carried ${describePayload(data)}.`
    );
  }
  return hosts.map(normalizeInstance);
}

function instanceArrayIn(data: unknown): unknown[] | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  if (Array.isArray(data.hosts)) {
    return data.hosts;
  }
  if (Array.isArray(data.list)) {
    return data.list;
  }
  if (Array.isArray(data.pageItems)) {
    return data.pageItems;
  }
  if (Array.isArray(data.instances)) {
    return data.instances;
  }
  if (Array.isArray(data.items)) {
    return data.items;
  }
  if (isRecord(data.serviceInfo) && Array.isArray(data.serviceInfo.hosts)) {
    return data.serviceInfo.hosts;
  }
  return undefined;
}

/**
 * One service's configuration, in either of the two shapes §6.7 lists --
 * both of them measured on a real 2.3.2, which serves each from its own
 * endpoint.
 *
 * 1.x answers with a `clusters` **array** and calls the service `name`;
 * 2.x/3.x answer with a `clusterMap` **object** and call it `serviceName`,
 * and 2.x alone spells the namespace `namespace`. Whichever the server sent
 * is read, so a driver does not restate its own version here.
 *
 * `ref` supplies what a response leaves out. It cannot redirect the answer at
 * a different service: every field it stands in for is one the server did not
 * send.
 */
export function normalizeServiceDetail(payload: unknown, ref: NacosServiceRef): NacosServiceDetail {
  const data = unwrapData<unknown>(payload);
  if (!isRecord(data)) {
    throw new NacosApiError(
      'invalid-response',
      `Nacos returned no service detail for ${ref.serviceName}: the response carried ${describePayload(data)}.`
    );
  }
  const named = firstString(data.name, data.serviceName);
  const grouped =
    named === undefined || named.length === 0
      ? { group: ref.group, serviceName: ref.serviceName }
      : splitGroupedServiceName(named, firstString(data.groupName, data.group) ?? ref.group);
  return {
    namespaceId: firstString(data.namespaceId, data.namespace) ?? ref.namespaceId,
    group: grouped.group,
    serviceName: grouped.serviceName,
    protectThreshold: optionalNumber(data.protectThreshold) ?? 0,
    metadata: stringMap(data.metadata),
    ephemeral: typeof data.ephemeral === 'boolean' ? data.ephemeral : undefined,
    clusters: normalizeServiceClusters(data.clusters ?? data.clusterMap)
  };
}

/**
 * A service with no cluster of its own is a real state and reads as an empty
 * list, not as a broken response -- which is also what a response carrying
 * neither field gives, since neither shape can express "this server does not
 * report clusters".
 */
function normalizeServiceClusters(value: unknown): NacosServiceCluster[] {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeServiceCluster(entry, undefined));
  }
  if (isRecord(value)) {
    return Object.entries(value).map(([name, entry]) => normalizeServiceCluster(entry, name));
  }
  return [];
}

/** In the map form the cluster's name is the key rather than a field, so the key wins. */
function normalizeServiceCluster(entry: unknown, keyedName: string | undefined): NacosServiceCluster {
  const record = isRecord(entry) ? entry : {};
  const healthChecker = isRecord(record.healthChecker) ? record.healthChecker : undefined;
  return {
    name: keyedName ?? firstString(record.clusterName, record.name) ?? '',
    healthCheckerType: optionalString(healthChecker?.type),
    metadata: stringMap(record.metadata)
  };
}

/**
 * The clients watching one service, in either of the two top-level shapes.
 *
 * v1/v2 answer `{"subscribers":[...],"count":N}` -- measured on a real 2.3.2,
 * where it is emphatically **not** the `pageItems` the 3.x research
 * describes. Both are read here, because which one arrives is a fact about
 * the endpoint and not something a caller should have to know.
 *
 * An empty list is the ordinary answer: it is what a service nobody watches
 * returns, and -- measured -- also what a service that does not exist
 * returns. That is the opposite of how a missing *configuration* is reported
 * (§14.2 ⓪) and the same rule the instance listing already follows
 * (§14.5 ⑤).
 */
export function normalizeSubscriberList(payload: unknown, endpoint: string, ref: NacosServiceRef): NacosSubscriber[] {
  const data = unwrapData<unknown>(payload);
  const entries = subscriberArrayIn(data);
  if (entries === undefined) {
    throw new NacosApiError(
      'invalid-response',
      `Nacos returned no subscribers for ${endpoint}: the response carried ${describePayload(data)}.`
    );
  }
  return entries.map((entry) => normalizeSubscriber(entry, ref));
}

function subscriberArrayIn(data: unknown): unknown[] | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  if (Array.isArray(data.subscribers)) {
    return data.subscribers;
  }
  return Array.isArray(data.pageItems) ? data.pageItems : undefined;
}

/**
 * One subscriber, whose `serviceName` carries the `GROUP@@` prefix exactly as
 * an instance's does -- so it is split the same way, at the **first**
 * separator, and never with Nacos's own `split()[1]`.
 *
 * The address is the identity, and only the ip half of it: `port` is 0 for
 * every gRPC subscriber on a real 2.3.2, so a check that required a port
 * would reject the ordinary case.
 */
function normalizeSubscriber(entry: unknown, ref: NacosServiceRef): NacosSubscriber {
  if (!isRecord(entry) || typeof entry.ip !== 'string' || entry.ip.length === 0) {
    throw new NacosApiError('invalid-response', 'Nacos returned a subscriber with no address.');
  }
  const named = firstString(entry.serviceName);
  const grouped =
    named === undefined || named.length === 0
      ? { group: ref.group, serviceName: ref.serviceName }
      : splitGroupedServiceName(named, ref.group);
  return {
    namespaceId: firstString(entry.namespaceId, entry.namespace) ?? ref.namespaceId,
    group: grouped.group,
    serviceName: grouped.serviceName,
    ip: entry.ip,
    port: optionalNumber(entry.port) ?? 0,
    agent: optionalString(entry.agent),
    app: optionalString(entry.app),
    cluster: optionalString(entry.cluster)
  };
}

/**
 * One server of the cluster, with its raft metadata flattened.
 *
 * `extendInfo.raftMetaData.metaDataMap` is a map keyed by raft group name,
 * three levels down; handing that to a view would make the view learn the
 * shape of a Nacos internal. It becomes a list here, and the group name --
 * which is the map's key, not a field -- becomes a field.
 *
 * The state is carried verbatim. Nacos has five (`STARTING`, `UP`,
 * `SUSPICIOUS`, `DOWN`, `ISOLATION`, of which the 3.x documentation lists
 * three), and a sixth from a version this plugin has not seen is still the
 * server's answer: mapping it onto one of the five would report a health
 * nobody claimed.
 */
export function normalizeClusterNode(entry: unknown): NacosClusterNode {
  const record = isRecord(entry) ? entry : {};
  const ip = typeof record.ip === 'string' ? record.ip : '';
  const port = optionalNumber(record.port) ?? 0;
  const address = optionalString(record.address) ?? (ip.length > 0 && port > 0 ? `${ip}:${port}` : undefined);
  if (address === undefined) {
    throw new NacosApiError('invalid-response', 'Nacos returned a cluster node with no address.');
  }
  const extendInfo = isRecord(record.extendInfo) ? record.extendInfo : undefined;
  return {
    address,
    ip,
    port,
    // 'UNKNOWN' rather than '': the panel renders this as a badge, and a
    // badge with nothing in it says the panel is broken.
    state: optionalString(record.state) ?? 'UNKNOWN',
    version: optionalString(extendInfo?.version),
    // A string on the wire, oddly, while `port` beside it is a number.
    raftPort: optionalString(extendInfo?.raftPort),
    failAccessCnt: optionalNumber(record.failAccessCnt),
    raftGroups: normalizeRaftGroups(extendInfo?.raftMetaData)
  };
}

function normalizeRaftGroups(raftMetaData: unknown): NacosRaftGroup[] | undefined {
  if (!isRecord(raftMetaData) || !isRecord(raftMetaData.metaDataMap)) {
    return undefined;
  }
  return Object.entries(raftMetaData.metaDataMap).map(([group, meta]) => ({
    group,
    leader: (isRecord(meta) ? optionalString(meta.leader) : undefined) ?? '',
    members: isRecord(meta) ? stringArray(meta.raftGroupMember) : [],
    term: (isRecord(meta) ? optionalNumber(meta.term) : undefined) ?? 0
  }));
}

/**
 * The naming module's server metrics.
 *
 * Every field but `status` is optional because the server really does answer
 * `{"status":"UP"}` and nothing else -- that is the `onlyStatus` default, not
 * a version difference (§14). A missing count is left missing rather than
 * defaulted to zero, so a panel can say "not reported" instead of claiming an
 * empty registry.
 */
export function normalizeServerMetrics(payload: unknown): NacosServerMetrics {
  const data = unwrapData<unknown>(payload);
  if (!isRecord(data) || typeof data.status !== 'string') {
    throw new NacosApiError(
      'invalid-response',
      `Nacos returned no server metrics: the response carried ${describePayload(data)}.`
    );
  }
  return {
    status: data.status,
    serviceCount: optionalNumber(data.serviceCount),
    instanceCount: optionalNumber(data.instanceCount),
    subscribeCount: optionalNumber(data.subscribeCount),
    clientCount: optionalNumber(data.clientCount),
    cpu: optionalNumber(data.cpu),
    load: optionalNumber(data.load),
    mem: optionalNumber(data.mem)
  };
}

/**
 * 2.3.2's `ServiceView.triggerFlag` is the string `"true"` or `"false"`;
 * 3.x models the same field as a boolean. Anything else is not an answer,
 * and undefined says so.
 */
function optionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'true' || value === 'false') {
    return value === 'true';
  }
  return undefined;
}

/** Nacos's instance metadata is a Map<String,String>; anything else in it cannot be rendered as one. */
function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return Object.fromEntries(entries);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
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
