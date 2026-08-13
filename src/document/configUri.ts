import * as vscode from 'vscode';
import type { NacosConfigRef } from '../nacos/driver/normalize';

/**
 * One `TextDocumentContentProvider` registration serves every instance: which
 * server a document came from is a path segment, not a scheme of its own.
 */
export const NACOS_CONFIG_SCHEME = 'nacos';

/**
 * What stands in for the public namespace, whose id is the empty string on
 * Nacos 1.x and 2.x.
 *
 * A sentinel is needed at all because an empty path segment does not survive:
 * it collapses under any path normalization, and a path that begins with two
 * slashes is re-read as an authority on the way back -- `vscode.Uri` refuses
 * to construct one for exactly that reason.
 *
 * It cannot collide with a real namespace id, and the guarantee is a property
 * of the encoder rather than of Nacos's validation rules: every real id
 * reaches the path through `encodeURIComponent`, which escapes `$` to `%24`.
 * No output of that function contains a literal `$`, so this segment is not
 * the encoding of *any* string -- a server that somehow serves a namespace
 * called `$public` still gets a URI of its own.
 *
 * Nacos's own rule would have been the weaker argument. It validates a
 * namespace id against `[\w-]+`, which admits underscores -- so the obvious
 * `_public_` really is a legal id, and picking it would have been a collision
 * waiting for the one user who names a namespace that.
 */
const PUBLIC_NAMESPACE_SEGMENT = '$public';

/** Instance, namespace, group, dataId. */
const SEGMENT_COUNT = 4;

/**
 * The query parameter naming a history record, and Nacos's own name for it.
 *
 * The version goes in the query rather than in a fifth path segment because
 * VS Code titles an editor after the last segment: a history tab would be
 * called `1044`, and the whole point of ending the path with the dataId is
 * that the tab says which configuration it is showing.
 */
const HISTORY_QUERY_KEY = 'nid';

/** Everything needed to fetch a config again: which server, where on it, and which version. */
export interface NacosConfigDocumentTarget {
  instanceId: string;
  ref: NacosConfigRef;
  /**
   * The history record to read instead of the current content, when the
   * address names one. Absent is the current version, which is what every
   * address M2 wrote means.
   */
  nid?: string;
}

/**
 * The virtual document address of one configuration.
 *
 * `nacos:/<instance>/<namespace>/<group>/<dataId>`, every segment
 * percent-encoded. A dataId may legally contain slashes, dots, spaces, `?`,
 * `#` and non-ASCII -- all of which occur in practice and all of which would
 * otherwise split the path, start a query or start a fragment.
 *
 * The instance id is the first path segment rather than the URI's authority,
 * which is the shape it would be natural to reach for. An authority is
 * case-folded by `Uri.toString()`, and VS Code keys open documents by that
 * string -- so two instances whose ids differ only in case would share one
 * buffer. An authority also carries its own `user:pass@host:port` syntax,
 * while `NacosInstanceConfig.id` is only `z.string().min(1)`: an id holding a
 * colon and an at-sign would be *displayed* as a credential in the tab title
 * and in Ctrl+P. As a path segment it is encoded like every other, and the
 * four components are handled by one rule instead of two.
 *
 * The instance id, not its address: nothing a user typed into a server URL --
 * a password among it -- can reach a string VS Code prints in the editor tab,
 * in Ctrl+P and in the recently-opened list.
 */
export function buildConfigUri(instanceId: string, ref: NacosConfigRef): vscode.Uri {
  return vscode.Uri.from({ scheme: NACOS_CONFIG_SCHEME, path: configPath(instanceId, ref) });
}

/**
 * The virtual document address of one *past* version of one configuration.
 *
 * The same path as the current version, plus the history record's id in the
 * query. Being different is the requirement, not a detail: `vscode.diff` is
 * handed two URIs, VS Code keys open documents by `Uri.toString()`, and two
 * equal addresses are one buffer -- a diff of which renders as a file with no
 * changes, indistinguishable from a version that really did not change.
 *
 * Being the same *path* is the other half. Both sides of a diff have to name
 * one configuration, and the tab keeps the dataId it would have had.
 *
 * The id is percent-encoded like every path segment, for the same reason: a
 * literal `&` or `#` in it would end the query and hand back the current
 * version's address. Nacos issues a database bigint here, so that is defence
 * rather than a case anyone has met -- but it is one rule for four components
 * and a fifth instead of one rule with an exception.
 */
export function buildConfigHistoryUri(instanceId: string, ref: NacosConfigRef, nid: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: NACOS_CONFIG_SCHEME,
    path: configPath(instanceId, ref),
    query: `${HISTORY_QUERY_KEY}=${encodeURIComponent(nid)}`
  });
}

function configPath(instanceId: string, ref: NacosConfigRef): string {
  const path = [
    encodeURIComponent(instanceId),
    ref.namespaceId === '' ? PUBLIC_NAMESPACE_SEGMENT : encodeURIComponent(ref.namespaceId),
    encodeURIComponent(ref.group),
    encodeURIComponent(ref.dataId)
  ].join('/');
  return `/${path}`;
}

/**
 * The inverse, for any URI at all -- the content provider is handed whatever
 * carries this scheme, including a hand-typed one from Ctrl+P and one
 * restored from a window that reloaded.
 *
 * Undefined rather than a throw, because the only caller is a
 * `TextDocumentContentProvider`: VS Code renders a rejected
 * `provideTextDocumentContent` as an empty editor with no explanation, so a
 * failure here has to become text the provider can show.
 *
 * A segment that decodes to the empty string is refused rather than accepted
 * as blank. `encodeURIComponent('')` is `''`, so an empty segment is what an
 * address this module never wrote looks like -- and for the namespace in
 * particular, the sentinel is the only spelling of public.
 */
export function parseConfigUri(uri: vscode.Uri): NacosConfigDocumentTarget | undefined {
  if (uri.scheme !== NACOS_CONFIG_SCHEME) {
    return undefined;
  }
  // Every path this module writes is absolute, so splitting one always yields
  // an empty element in front of the four segments.
  const [leading, ...segments] = uri.path.split('/');
  if (leading !== '' || segments.length !== SEGMENT_COUNT || segments.some((segment) => segment === '')) {
    return undefined;
  }
  const [instanceId, namespaceId, group, dataId] = segments;
  try {
    const nid = historyIdIn(uri.query);
    // A query this module did not write is refused rather than dropped. The
    // query is the only thing that tells the two versions of one
    // configuration apart, so ignoring one would answer with the current
    // content -- which is what the other side of the diff already holds.
    if (uri.query !== '' && nid === undefined) {
      return undefined;
    }
    return {
      instanceId: decodeURIComponent(instanceId),
      ref: {
        namespaceId: namespaceId === PUBLIC_NAMESPACE_SEGMENT ? '' : decodeURIComponent(namespaceId),
        group: decodeURIComponent(group),
        dataId: decodeURIComponent(dataId)
      },
      nid
    };
  } catch {
    // decodeURIComponent throws URIError on a malformed escape such as `%zz`.
    return undefined;
  }
}

/**
 * The history record id a query names, or undefined for a query this module
 * never wrote -- including the empty one, which is the current version.
 *
 * Exactly one parameter, spelled exactly as `buildConfigHistoryUri` spells
 * it. Anything looser would read `?nid=1044&nid=1045` as a single version and
 * pick one of the two at random.
 */
function historyIdIn(query: string): string | undefined {
  if (query === '') {
    return undefined;
  }
  const [key, ...rest] = query.split('=');
  const value = rest.join('=');
  if (key !== HISTORY_QUERY_KEY || value === '' || value.includes('&')) {
    return undefined;
  }
  return decodeURIComponent(value);
}
