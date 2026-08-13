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

/** Everything needed to fetch a config again: which server, and where on it. */
export interface NacosConfigDocumentTarget {
  instanceId: string;
  ref: NacosConfigRef;
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
  const path = [
    encodeURIComponent(instanceId),
    ref.namespaceId === '' ? PUBLIC_NAMESPACE_SEGMENT : encodeURIComponent(ref.namespaceId),
    encodeURIComponent(ref.group),
    encodeURIComponent(ref.dataId)
  ].join('/');
  return vscode.Uri.from({ scheme: NACOS_CONFIG_SCHEME, path: `/${path}` });
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
    return {
      instanceId: decodeURIComponent(instanceId),
      ref: {
        namespaceId: namespaceId === PUBLIC_NAMESPACE_SEGMENT ? '' : decodeURIComponent(namespaceId),
        group: decodeURIComponent(group),
        dataId: decodeURIComponent(dataId)
      }
    };
  } catch {
    // decodeURIComponent throws URIError on a malformed escape such as `%zz`.
    return undefined;
  }
}
