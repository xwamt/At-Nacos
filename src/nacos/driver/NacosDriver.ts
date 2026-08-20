import { classifyHttpStatus, describeFailure, NacosApiError } from '../NacosApiError';
import {
  SUCCESS_CODES,
  type NacosHttpClient,
  type NacosRawResponse,
  type NacosRequestOptions
} from '../NacosHttpClient';
import { isRecord } from '../jsonGuards';
import { isSpringErrorPage } from './springErrorPage';
import {
  configTagsParamName,
  groupParamName,
  namespaceParamName,
  normalizeConfigDetail,
  normalizeConfigSummary,
  normalizeNamespace,
  normalizePaged,
  unwrapData,
  unwrapDataArray,
  type NacosClusterNode,
  type NacosConfigDetail,
  type NacosConfigHistoryEntry,
  type NacosConfigListener,
  type NacosConfigRef,
  type NacosListenedConfig,
  type NacosConfigSummary,
  type NacosInstance,
  type NacosNamespace,
  type NacosServerMetrics,
  type NacosServiceDetail,
  type NacosServiceRef,
  type NacosServiceSummary,
  type NacosSubscriber,
  type Paged
} from './normalize';

export type NacosApiFlavor = 'v1' | 'v2' | 'v3-admin' | 'v3-console';

/**
 * One page of one namespace's configs.
 *
 * `search` is the dataId substring a user typed into the tree filter, absent
 * when they have not. The tree still only passes that plus paging: a page
 * needs a namespace to be a page of, and paging that the caller does not
 * control would put the 10MB responses this milestone exists to avoid back
 * on the table.
 *
 * MCP callers set `searchMode` (and `group` / `dataId` / `type` / tags /
 * `appName`) explicitly so the server filters. The tree does not: when
 * `dataId` is unset, a non-empty `search` wraps itself in `*` and switches
 * to blur; otherwise the request is accurate with empty dataId and group --
 * Nacos's two incompatible spellings of "list these".
 */
export interface NacosConfigListQuery {
  namespaceId: string;
  /** One-based, as Nacos counts. */
  pageNo: number;
  pageSize: number;
  /**
   * 树过滤器：有值则 blur，并把该字符串包成 `*term*` 作为 dataId。
   * 仅当 `dataId` 未设时生效，避免和 MCP 的精确/通配 dataId 抢同一参数。
   */
  search?: string;
  group?: string;
  dataId?: string;
  /** 未设时：有树 `search` 则 blur，否则 accurate（与今天无过滤列举相同）。 */
  searchMode?: 'accurate' | 'blur';
  type?: string;
  configTags?: string;
  appName?: string;
}

/**
 * One page of one namespace's services.
 *
 * `group` is optional and **absent means every group**, which is the shape
 * the tree needs: Nacos has no endpoint that lists groups, so the group nodes
 * are derived from the services that came back, and a listing scoped to one
 * group could never produce them.
 *
 * Every group is not a thing every endpoint can express. The catalog and 3.x
 * read a blank group filter as no filter at all; the older name-only
 * listings match one group exactly and silently substitute `DEFAULT_GROUP`
 * for a blank one. So a driver reduced to the fallback answers for the
 * default group alone -- see `listServicesPreferringCounts`. Making the field
 * required instead would not fix that and would cost the tree its groups on
 * every version.
 */
export interface NacosServiceListQuery {
  namespaceId: string;
  /** Absent = every group. */
  group?: string;
  /**
   * Forwarded as `serviceNameParam` on catalog and 3.x listings (prefix/suffix
   * match). Absent or blank means no name filter. The name-only fallback has
   * no such parameter.
   */
  serviceName?: string;
  /**
   * When true, listings that report counts hide services with no instances.
   * Unset must stay false on the wire so the tree still shows empty services.
   */
  ignoreEmptyService?: boolean;
  /** One-based, as Nacos counts. */
  pageNo: number;
  pageSize: number;
}

export interface NacosInstanceQuery extends NacosServiceRef {
  /** One cluster of the service; absent means every cluster. */
  cluster?: string;
}

/**
 * One page of one configuration's history.
 *
 * `pageSize` is the only paging in this interface with a ceiling above it:
 * the history endpoint clamps to 500 server-side, and the driver clamps to
 * the same number on the way out (§10).
 */
export interface NacosConfigHistoryListQuery extends NacosConfigRef {
  /** One-based, as Nacos counts. */
  pageNo: number;
  pageSize: number;
}

export interface NacosConfigHistoryQuery extends NacosConfigRef {
  /** The history record's id, as the listing reported it. Nacos calls the parameter `nid`. */
  nid: string;
}

export interface NacosListenerQuery extends NacosConfigRef {
  /** 3.x：是否汇总整个集群。缺省 true。v1/v2 不发这个参数。 */
  aggregation?: boolean;
}

export interface NacosListenedConfigQuery {
  namespaceId: string;
  ip: string;
  aggregation?: boolean;
}

export interface NacosSubscriberQuery extends NacosServiceRef {
  aggregation?: boolean;
}

/**
 * One configuration, as it is to be stored.
 *
 * A publish is an upsert of the **whole row**, not a patch: every version
 * writes back all of the columns the request bound, so a field this omits is
 * a field the server overwrites with nothing. That is why so little here is
 * optional.
 *
 * `type` is required for that reason and is the sharpest case of it.
 * 2.3.2 ends its publish handler with `if (!ConfigType.isValidType(type))
 * configForm.setType(getDefaultType())`, and the default is `text` -- so a
 * publish without one turns a YAML configuration into a plain-text
 * configuration, and the next reader opens it with no syntax highlighting.
 * The caller supplies it; nothing down here invents one, because a guess made
 * from the dataId would be indistinguishable from what the publisher chose.
 *
 * `appName` and `description` are optional because a configuration really can
 * have neither, and they are sent as empty strings when absent -- which is
 * the same thing the server would store. A republish that means to keep them
 * has to carry them through.
 */
export interface NacosConfigPublish extends NacosConfigRef {
  /** May be empty. Nacos itself rejects a blank body, but that verdict is the server's to give. */
  content: string;
  /** `yaml` | `properties` | `json` | `xml` | `html` | `text`, as `getConfig` reported it. */
  type: string;
  appName?: string;
  description?: string;
}

/**
 * One instance taken out of, or put back into, its service's rotation.
 *
 * The whole instance travels rather than the address and a flag, and that is
 * the same trap `type` is. Nacos has no endpoint that flips one field: the
 * update **rebuilds the instance from the request** and every attribute the
 * request leaves out takes the builder's default -- `weight` becomes 1,
 * `healthy` becomes true, and the metadata map is emptied (verified in
 * 2.3.2's `HttpRequestInstanceBuilder` and in 3.x's `InstanceForm`). So a
 * request carrying only `enabled` would take an instance offline and silently
 * reset its weight and drop its metadata on the way.
 *
 * `instance` is therefore meant to be exactly what `listInstances` last
 * reported, with nothing edited out of it.
 */
export interface NacosInstanceHealthUpdate {
  service: NacosServiceRef;
  /** As `listInstances` reported it. Everything in it is sent back verbatim. */
  instance: NacosInstance;
  /** false takes the instance out of rotation; Nacos stops handing it to clients. */
  enabled: boolean;
}

/**
 * M1 defined the namespace capability, M2 the two configuration ones, M3 the
 * naming and cluster ones, M4 a config's history and the two answers to "who
 * is using this", and M5 the three that change something. Later milestones
 * widen this interface as they need to, and every widening has to bring all
 * four implementations along with it -- TypeScript enforces that, which is
 * exactly why the interface is kept narrow.
 *
 * **Nothing here knows what a read-only instance is.** That switch is a
 * property of how this workspace has configured a server, not of the server,
 * and it is enforced above -- once in the tree, which hides the commands, and
 * once in `confirmWrite`, which refuses them. A driver that checked it as
 * well would put one safety rule in two layers, which is how a rule ends up
 * with a path where neither copy runs.
 */
export interface NacosDriver {
  readonly flavor: NacosApiFlavor;
  listNamespaces(): Promise<NacosNamespace[]>;
  listConfigs(query: NacosConfigListQuery): Promise<Paged<NacosConfigSummary>>;
  getConfig(ref: NacosConfigRef): Promise<NacosConfigDetail>;
  listConfigHistory(query: NacosConfigHistoryListQuery): Promise<Paged<NacosConfigHistoryEntry>>;
  /**
   * One past version, as a `NacosConfigDetail` -- the same type `getConfig`
   * answers with. That is deliberate: the document layer renders both sides
   * of a diff, and a separate history type would force it to branch on which
   * side it was rendering.
   */
  getConfigHistory(query: NacosConfigHistoryQuery): Promise<NacosConfigDetail>;
  listConfigListeners(query: NacosListenerQuery): Promise<NacosConfigListener[]>;
  listListenedConfigs(query: NacosListenedConfigQuery): Promise<NacosListenedConfig[]>;
  listServices(query: NacosServiceListQuery): Promise<Paged<NacosServiceSummary>>;
  getService(ref: NacosServiceRef): Promise<NacosServiceDetail>;
  /**
   * Every instance of one service, unpaged. Only 3.x's console API pages
   * this, and it is the driver's business to ask for a page large enough that
   * the difference does not reach here.
   */
  listInstances(query: NacosInstanceQuery): Promise<NacosInstance[]>;
  /** Every client watching one service, unpaged, for the same reason instances are. */
  listSubscribers(query: NacosSubscriberQuery): Promise<NacosSubscriber[]>;
  listClusterNodes(): Promise<NacosClusterNode[]>;
  getServerMetrics(): Promise<NacosServerMetrics>;
  /**
   * Creates the configuration or overwrites it, which is one endpoint on
   * every version -- Nacos has no separate create.
   *
   * Answers nothing. A write's only result is that it happened, and the
   * server has three ways of saying it did not (a non-2xx, a business `code`,
   * and HTTP 200 carrying `false`); folding those into a returned boolean
   * would let a caller ignore the refusal by ignoring the value.
   */
  publishConfig(request: NacosConfigPublish): Promise<void>;
  deleteConfig(ref: NacosConfigRef): Promise<void>;
  /**
   * Takes one instance out of its service's rotation, or puts it back.
   *
   * **There is no rollback capability beside these**, deliberately. Nacos has
   * no endpoint that restores a past version: rolling back is reading the old
   * content and publishing it under the current dataId, which produces a
   * *new* history row rather than erasing the ones after it. Composing that
   * from `getConfigHistory` and `publishConfig` is the layer above's job,
   * because the confirmation dialog is the only place that semantics can be
   * explained to the person authorizing it.
   */
  updateInstanceHealth(request: NacosInstanceHealthUpdate): Promise<void>;
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

/**
 * Nacos's own ceiling for one configuration is 100KB; 128KB is that with room
 * for the JSON escaping of it.
 */
const MAX_CONFIG_BYTES = 128 * 1024;

/**
 * And an absolute ceiling on top, so that a caller's generous pageSize cannot
 * multiply the cap back into uselessness.
 */
const MAX_LIST_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * How many bytes of a config listing are worth reading before giving up.
 *
 * The list endpoint returns the **full content of every config in the page**,
 * in both search modes, and v1 has no parameter to leave it out -- verified on
 * a real 2.3.2, where 12 configs came to 38KB. At the server's own 100KB per
 * config, a hundred-item page is a 10MB string materializing inside the
 * extension host. `NacosHttpClient` aborts the stream as soon as the cap is
 * passed rather than buffering and then measuring, so this costs nothing at
 * all on a page that stays under it.
 *
 * The floor of one page item is for a nonsensical pageSize: a cap of zero
 * would abort every response including the error bodies, which turns a
 * caller's bad argument into an unreadable failure somewhere else.
 *
 * Sized for the v1 shape, which is the expensive one. 3.x's list is
 * documented to answer with `ConfigBasicInfo`, which leaves `content` out
 * entirely -- so the cap should never come near being hit there. Unverified:
 * no 3.x server has been available to this project.
 */
function listResponseCap(pageSize: number): number {
  return Math.min(Math.max(pageSize, 1) * MAX_CONFIG_BYTES, MAX_LIST_RESPONSE_BYTES);
}

/**
 * The shared half of `listConfigs`, for the same reason `fetchNamespaces`
 * exists: only the path and the parameter dialect may differ between
 * versions, and everything else -- the search mode, the size cap, the
 * normalization -- has to be identical or the tree behaves differently
 * depending on which server answered.
 *
 * `endpointFlavor` is the family of the *path* being called, which is not
 * always the driver's own flavor: v2 serves its config requests from the v1
 * endpoints, so it has to ask in the v1 dialect.
 *
 * A driver's own `options.query` is merged underneath, never over: the
 * namespace and the paging are what the caller asked for, and a driver that
 * could overwrite them would be answering a different question than the one
 * it was given.
 */
export async function fetchConfigPage(
  http: Pick<NacosHttpClient, 'requestJson'>,
  endpointFlavor: NacosApiFlavor,
  path: string,
  query: NacosConfigListQuery,
  options?: NacosRequestOptions
): Promise<Paged<NacosConfigSummary>> {
  const payload = await http.requestJson<unknown>('GET', path, {
    ...options,
    query: { ...options?.query, ...configListParams(endpointFlavor, query) },
    maxResponseBytes: listResponseCap(query.pageSize)
  });
  return normalizePaged(payload, normalizeConfigSummary, path);
}

/**
 * Both search modes of the v1 list endpoint, and the v3 one that copied it.
 *
 * `dataId` and `group` are required `@RequestParam`s even when the caller
 * wants everything back, so they are sent empty rather than omitted -- a
 * missing one is a 400, not a wildcard. A caller-supplied group or dataId is
 * sent as-is; an explicit dataId is never wrapped in `*`.
 *
 * A tree search term (no `dataId`, no `searchMode`) switches the mode to
 * `blur` and wraps itself in `*`, which is the only way Nacos accepts a
 * substring match. MCP can set `searchMode` itself. Nacos answers a blur
 * search with `type: null` on every item; that is expected and
 * `configLanguageId` covers it from the dataId suffix, so nothing here tries
 * to compensate.
 *
 * `type`, `appName` and the dialect's tags parameter are omitted unless the
 * caller set them: an empty filter is not a filter.
 */
function configListParams(flavor: NacosApiFlavor, query: NacosConfigListQuery): Record<string, string> {
  const term = query.search?.trim();
  const searchMode = query.searchMode ?? (term ? 'blur' : 'accurate');
  const dataId = query.dataId !== undefined ? query.dataId : term ? `*${term}*` : '';
  const params: Record<string, string> = {
    search: searchMode,
    dataId,
    [groupParamName(flavor, 'config')]: query.group ?? '',
    [namespaceParamName(flavor, 'config')]: query.namespaceId,
    pageNo: String(query.pageNo),
    pageSize: String(query.pageSize)
  };
  if (query.type) {
    params.type = query.type;
  }
  if (query.appName) {
    params.appName = query.appName;
  }
  if (query.configTags) {
    params[configTagsParamName(flavor)] = query.configTags;
  }
  return params;
}

/**
 * The shared half of `getConfig`, and the reason it reads the response raw.
 *
 * Three separate things make `requestJson` unusable here. v1's config path is
 * the same one that answers in plain text without `show=all`. A 404 has two
 * opposite meanings and only its *body* tells them apart, so the body has to
 * survive the failure. And Nacos lies about the content type -- it answers
 * `config data not exist` with `Content-Type: application/json` -- so nothing
 * about the response's own metadata can be trusted to route it.
 *
 * A driver's own `options.query` is merged underneath -- that is where the v1
 * family's `show=all` comes from, and v3, which has no plain-text form to opt
 * out of, sends none. Underneath rather than over, so that a driver cannot
 * redirect the request at a config other than the one it was asked for.
 */
export async function fetchConfigDetail(
  http: Pick<NacosHttpClient, 'requestRaw'>,
  endpointFlavor: NacosApiFlavor,
  path: string,
  ref: NacosConfigRef,
  options?: NacosRequestOptions
): Promise<NacosConfigDetail> {
  const response = await http.requestRaw('GET', path, {
    ...options,
    query: {
      ...options?.query,
      dataId: ref.dataId,
      [groupParamName(endpointFlavor, 'config')]: ref.group,
      [namespaceParamName(endpointFlavor, 'config')]: ref.namespaceId
    }
  });
  if (!response.ok) {
    throw describeConfigFailure(response, path);
  }
  const payload = unwrapCheckedData(response.text, path);
  if (payload === null || payload === undefined) {
    throw missingConfig(path, response.status);
  }
  return normalizeConfigDetail(payload);
}

/**
 * The way a real Nacos 2.3.2 reports a dataId nobody published -- which is
 * not the 404 the research predicted.
 *
 * `?show=all` is a different controller method from the plain-text form on
 * the same path. It answers with a `ConfigAllInfo`, and Spring serializes a
 * null one as **HTTP 200 with `Content-Length: 0`**, under a
 * `Content-Type: application/json` that describes nothing. Only the
 * plain-text form answers `404 config data not exist`, and that form carries
 * no `type` -- which is the whole reason this milestone cannot use it. 3.x
 * wraps the same absence as `data: null`, so both spellings land here.
 *
 * An empty configuration is a different thing and is not caught by this: it
 * arrives as an object whose `content` is `""`.
 *
 * The dataId stays out of the message on purpose, as it does in
 * `describeFailure`: these sentences reach the output channel, and what a
 * user searched for is theirs.
 */
function missingConfig(path: string, status: number): NacosApiError {
  return new NacosApiError(
    'resource-not-found',
    `Nacos answered ${path} with HTTP ${status} and no configuration in the body, which is how it reports one that does not exist.`,
    status
  );
}

/**
 * Which of Nacos's two 404s this is.
 *
 * A Spring Boot error page means the server has no controller at this path,
 * i.e. this API version does not have the endpoint, and the resolver has to
 * try the next driver. Anything else at 404 is Nacos itself answering that
 * the config does not exist, and falling through on that would walk the whole
 * chain and end in "No Nacos API flavor could serve this" -- which names the
 * wrong problem, since no older API family can produce a dataId nobody
 * published.
 *
 * The `api-error` default is unreachable: `ok` is defined as "the status
 * classifies to nothing", so a response that got here classifies to
 * something. It is there because the types cannot say that.
 */
function describeConfigFailure(response: NacosRawResponse, path: string): NacosApiError {
  const kind =
    response.status === 404 && !isSpringErrorPage(response.text)
      ? 'resource-not-found'
      : (classifyHttpStatus(response.status) ?? 'api-error');
  return new NacosApiError(kind, describeFailure(kind, response.status, response.text, path), response.status);
}

/**
 * Parses a raw 2xx body the way `requestJson` would have, envelope and
 * business code included.
 *
 * §6.3: a handful of 1.x endpoints report a business failure with HTTP 200
 * and the real error only in `code`. `requestJson` checks that for every
 * caller which can use it; this one cannot, so the guarantee it gave up has
 * to be restored here. Without it the failure surfaces from
 * `normalizeConfigDetail` as "a config entry with no dataId", which points at
 * the response shape when the server already said what was wrong.
 */
function unwrapCheckedData(text: string, path: string): unknown {
  // Before the parse, because `JSON.parse('')` throws and the caller reads a
  // missing payload as a missing configuration rather than as a broken one.
  if (text.length === 0) {
    return undefined;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new NacosApiError('invalid-response', `Nacos returned a non-JSON response for ${path}.`);
  }
  if (isRecord(payload) && typeof payload.code === 'number' && !SUCCESS_CODES.has(payload.code)) {
    const message = typeof payload.message === 'string' ? payload.message : 'unknown error';
    throw new NacosApiError('api-error', `Nacos returned code ${payload.code} for ${path}: ${message}`);
  }
  return unwrapData<unknown>(payload);
}
