import { classifyHttpStatus, describeFailure, NacosApiError } from '../NacosApiError';
import {
  SUCCESS_CODES,
  type NacosHttpClient,
  type NacosRawResponse,
  type NacosRequestOptions
} from '../NacosHttpClient';
import { isRecord } from '../jsonGuards';
import type { NacosApiFlavor, NacosConfigPublish, NacosInstanceHealthUpdate } from './NacosDriver';
import { serviceIdentityParams } from './naming';
import { groupParamName, namespaceParamName, unwrapData, type NacosConfigRef } from './normalize';

/**
 * One configuration published, as a form.
 *
 * **`form`, never `body`.** Every Nacos write endpoint binds its arguments
 * from request *parameters* -- `@RequestParam` on 1.x/2.x, a command object
 * on 3.x -- which Spring reads from the query string and from an
 * `application/x-www-form-urlencoded` body and from nowhere else. A JSON body
 * is not refused; it is ignored, and the server then answers `parameter
 * missing` naming a field the request demonstrably sent.
 *
 * `endpointFlavor` is the family of the *path*, not always the driver's own:
 * v2 publishes to the v1 endpoint, so it has to ask in the v1 dialect.
 */
export async function publishConfigAt(
  http: Pick<NacosHttpClient, 'requestRaw'>,
  endpointFlavor: NacosApiFlavor,
  path: string,
  request: NacosConfigPublish,
  options?: NacosRequestOptions
): Promise<void> {
  const response = await http.requestRaw('POST', path, {
    ...options,
    form: {
      ...configRefFields(endpointFlavor, request),
      content: request.content,
      type: requiredType(request, path),
      // Present-but-empty rather than omitted, because an omitted one is not
      // "leave it alone": both versions write the whole row back, so a
      // republish that drops these clears the stored value. The caller
      // carries the existing value through; '' is how it says there was none.
      appName: request.appName ?? '',
      desc: request.description ?? ''
    }
  });
  assertWriteAccepted(response, path);
}

/**
 * One configuration deleted.
 *
 * The parameters go in the **query string**, not in a form. A servlet
 * container parses a `x-www-form-urlencoded` body for POST alone, so a
 * DELETE's form body reaches no `@RequestParam` at all -- and on 1.x that
 * failure is HTTP 400 `parameter missing` for a `dataId` the request sent.
 *
 * There is no missing-config case to report here: 2.3.2's
 * `ConfigOperationService.deleteConfig` returns `true` whether or not a row
 * was there, so deleting a dataId nobody published is a plain success.
 */
export async function deleteConfigAt(
  http: Pick<NacosHttpClient, 'requestRaw'>,
  endpointFlavor: NacosApiFlavor,
  path: string,
  ref: NacosConfigRef,
  options?: NacosRequestOptions
): Promise<void> {
  const response = await http.requestRaw('DELETE', path, {
    ...options,
    query: { ...options?.query, ...configRefFields(endpointFlavor, ref) }
  });
  assertWriteAccepted(response, path);
}

/**
 * One instance taken out of, or put back into, rotation.
 *
 * **The whole instance goes back, not just `enabled`.** Nacos has no endpoint
 * that flips one field of an instance: the update rebuilds the instance from
 * the request, and everything the request leaves out takes a default --
 * `weight` 1, `healthy` true, an empty metadata map, cluster `DEFAULT`
 * (2.3.2's `HttpRequestInstanceBuilder`, and 3.x's `InstanceForm`, which
 * fills the same defaults in `validate()`). So a request carrying only the
 * address and the flag would take an instance offline *and* silently reset
 * its weight and drop its metadata, which is the same class of data loss a
 * publish without a `type` causes.
 *
 * `enabled` overrides the instance's own value rather than being read off it,
 * because the whole point of the call is that the two differ.
 *
 * The `instanceId` is not sent. Nacos derives it from the address, the
 * cluster and the service, no version declares a parameter for it, and a
 * parameter no controller reads is one more thing that can look meaningful
 * while doing nothing.
 */
export async function updateInstanceHealthAt(
  http: Pick<NacosHttpClient, 'requestRaw'>,
  endpointFlavor: NacosApiFlavor,
  path: string,
  request: NacosInstanceHealthUpdate,
  options?: NacosRequestOptions
): Promise<void> {
  const { instance } = request;
  const response = await http.requestRaw('PUT', path, {
    ...options,
    form: {
      ...serviceIdentityParams(endpointFlavor, request.service),
      ip: instance.ip,
      port: String(instance.port),
      clusterName: instance.clusterName,
      // A form carries text and nothing else, and both sides read it that
      // way: 2.3.2 parses these with `ConvertUtils.toBoolean`, 3.x binds them
      // through Spring's Boolean converter. `Record<string, string>` is what
      // stops a JS boolean being handed over in the first place.
      enabled: String(request.enabled),
      healthy: String(instance.healthy),
      ephemeral: String(instance.ephemeral),
      weight: String(instance.weight),
      // JSON, which is what `UtilsAndCommons.parseMetadata` tries first. Sent
      // even when empty, so that what the server will store can be read off
      // the request rather than inferred from what it does not say.
      metadata: JSON.stringify(instance.metadata)
    }
  });
  assertWriteAccepted(response, path);
}

/**
 * Which config a write is about, in the dialect the endpoint family reads.
 *
 * The same pairing rule the readers follow (`history.ts`): a request that
 * says `tenant` and `groupName` is half in each dialect, and the half the
 * server does not recognize is dropped in silence rather than refused. On a
 * *write* that silence is worse than on a read -- a publish addressed to the
 * default namespace because `namespaceId` went to a v1 endpoint does not
 * return an empty list, it creates a configuration somewhere nobody looked.
 */
function configRefFields(flavor: NacosApiFlavor, ref: NacosConfigRef): Record<string, string> {
  return {
    dataId: ref.dataId,
    [groupParamName(flavor, 'config')]: ref.group,
    [namespaceParamName(flavor, 'config')]: ref.namespaceId
  };
}

/**
 * The type, refused rather than defaulted when it is blank.
 *
 * 2.3.2's `ConfigController.publishConfig` ends with
 * `if (!ConfigType.isValidType(type)) configForm.setType(getDefaultType())`,
 * and the default is `text` -- so a blank type does not mean "leave the
 * stored one alone", it means "store `text`", and the next reader of a YAML
 * configuration opens it without syntax highlighting. The interface makes
 * `type` required, which stops the field being forgotten; this stops it being
 * forgotten as an empty string.
 *
 * `validation` because the request as written cannot succeed and no other API
 * version would judge it differently, so the resolver must not walk the chain
 * repeating it.
 */
function requiredType(request: NacosConfigPublish, path: string): string {
  if (request.type.trim().length === 0) {
    throw new NacosApiError(
      'validation',
      `A publish to ${path} carried no configuration type. Nacos stores a blank type as "text", which would reset the configuration's format, so the type has to come from the caller.`
    );
  }
  return request.type;
}

/**
 * Whether the server actually performed the write, across the four answers it
 * has for saying so.
 *
 * The config writes answer a `Boolean` -- a bare `true` on the v1 endpoints,
 * `{"code":0,"data":true}` once v2 wrapped it. The instance update answers a
 * `String`: the bare text `ok` on v1, `{"code":0,"data":"ok"}` from v2 on.
 * Only one of the four is JSON on every version, which is why every write
 * reads its response raw and decides here instead of through `requestJson`.
 *
 * **`false` under HTTP 200 is a refusal, not a result.** It is how Nacos
 * reports a write it declined -- a permission check that failed, a rejection
 * from the persistence layer -- and reading it as success would tell a user
 * their configuration was published while the server discarded it. It is
 * raised as `api-error`, which deliberately does **not** fall through: a
 * refused write must not be retried against another API family.
 */
export function assertWriteAccepted(response: NacosRawResponse, path: string): void {
  if (!response.ok) {
    const kind = classifyHttpStatus(response.status) ?? 'api-error';
    throw new NacosApiError(kind, describeFailure(kind, response.status, response.text, path), response.status);
  }
  const payload = parseWriteBody(response.text);
  // §6.3: a handful of endpoints report a business failure under HTTP 200
  // with the real error only in `code`. `requestJson` checks that for every
  // caller that can use it; these cannot, so the check has to be restored.
  if (isRecord(payload) && typeof payload.code === 'number' && !SUCCESS_CODES.has(payload.code)) {
    const message = typeof payload.message === 'string' ? payload.message : 'unknown error';
    throw new NacosApiError('api-error', `Nacos returned code ${payload.code} for ${path}: ${message}`, response.status);
  }
  const verdict = unwrapData<unknown>(payload);
  if (verdict === true || verdict === 'true' || verdict === 'ok') {
    return;
  }
  if (verdict === false || verdict === 'false') {
    throw new NacosApiError(
      'api-error',
      `Nacos refused the write at ${path}: it answered HTTP ${response.status} with "false", which is how it reports a write it declined rather than one it performed. The account may lack write permission for this namespace, or the server may have rejected the values.`,
      response.status
    );
  }
  throw new NacosApiError(
    'invalid-response',
    `Nacos answered the write at ${path} with something that is neither a confirmation nor a refusal: ${describeWriteBody(response.text)}. Whether the write happened cannot be told from it.`,
    response.status
  );
}

/**
 * The response as a value, whichever of the two encodings it arrived in.
 *
 * A body that is not JSON is the value: that is v1's `ok`, which no parser
 * accepts and which is nonetheless the ordinary success of an instance
 * update. An empty body falls here too and becomes `''`, which is neither a
 * confirmation nor a refusal -- silence is not consent for a write.
 */
function parseWriteBody(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

/**
 * Truncated the way `describeFailure` truncates an unparsed error body, and
 * for the same reason: what came back is the only clue to why it was not
 * understood, and a write response is a handful of bytes rather than a config
 * body -- none of these endpoints echoes the content it was sent.
 */
function describeWriteBody(text: string): string {
  return text.length === 0 ? 'an empty body' : JSON.stringify(text.slice(0, 200));
}
