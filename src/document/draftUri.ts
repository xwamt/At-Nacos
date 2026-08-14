import * as vscode from 'vscode';
import type { NacosConfigRef } from '../nacos/driver/normalize';

export const NACOS_DRAFT_SCHEME = 'nacos-draft';

const PUBLIC_NAMESPACE_SEGMENT = '$public';
const SEGMENT_COUNT = 4;

export interface NacosDraftDocumentTarget {
  instanceId: string;
  ref: NacosConfigRef;
}

/**
 * Builds the draft URI for a configuration.
 *
 * `nacos-draft:/<instanceId>/<namespaceId>/<group>/<dataId>`
 */
export function buildDraftUri(instanceId: string, ref: NacosConfigRef): vscode.Uri {
  const path = [
    encodeURIComponent(instanceId),
    ref.namespaceId === '' ? PUBLIC_NAMESPACE_SEGMENT : encodeURIComponent(ref.namespaceId),
    encodeURIComponent(ref.group),
    encodeURIComponent(ref.dataId)
  ].join('/');
  return vscode.Uri.from({ scheme: NACOS_DRAFT_SCHEME, path: `/${path}` });
}

/**
 * Parses a draft URI back into its target components.
 */
export function parseDraftUri(uri: vscode.Uri): NacosDraftDocumentTarget | undefined {
  if (uri.scheme !== NACOS_DRAFT_SCHEME) {
    return undefined;
  }
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
    return undefined;
  }
}
