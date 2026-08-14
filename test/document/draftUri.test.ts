import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { buildDraftUri, NACOS_DRAFT_SCHEME, parseDraftUri } from '../../src/document/draftUri';

describe('draftUri', () => {
  it('builds a URI with nacos-draft scheme and percent-encoded segments', () => {
    const uri = buildDraftUri('inst-1', {
      namespaceId: 'dev-ns',
      group: 'DEFAULT_GROUP',
      dataId: 'app.yaml'
    });

    expect(uri.scheme).toBe(NACOS_DRAFT_SCHEME);
    expect(uri.path).toBe('/inst-1/dev-ns/DEFAULT_GROUP/app.yaml');
  });

  it('uses $public sentinel for empty namespace', () => {
    const uri = buildDraftUri('inst-1', {
      namespaceId: '',
      group: 'DEFAULT_GROUP',
      dataId: 'app.yaml'
    });

    expect(uri.path).toBe('/inst-1/$public/DEFAULT_GROUP/app.yaml');
  });

  it('round-trips standard and special character config references', () => {
    const original = {
      instanceId: 'server:8848',
      ref: {
        namespaceId: 'dev/ns',
        group: 'GROUP:1',
        dataId: 'app?v=1#sec'
      }
    };

    const uri = buildDraftUri(original.instanceId, original.ref);
    const parsed = parseDraftUri(uri);

    expect(parsed).toEqual(original);
  });

  it('returns undefined for non nacos-draft scheme', () => {
    const uri = vscode.Uri.from({ scheme: 'nacos', path: '/inst/ns/grp/id' });
    expect(parseDraftUri(uri)).toBeUndefined();
  });

  it('returns undefined for invalid segment counts', () => {
    const uri = vscode.Uri.from({ scheme: NACOS_DRAFT_SCHEME, path: '/inst/ns/grp' });
    expect(parseDraftUri(uri)).toBeUndefined();
  });
});
