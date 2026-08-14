import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { NacosDraftFileSystemProvider } from '../../src/document/NacosDraftFileSystemProvider';
import { buildDraftUri, NACOS_DRAFT_SCHEME } from '../../src/document/draftUri';
import type { NacosConfigDetail } from '../../src/nacos/driver/normalize';

function mockDetail(overrides: Partial<NacosConfigDetail> = {}): NacosConfigDetail {
  return {
    namespaceId: 'dev',
    group: 'DEFAULT_GROUP',
    dataId: 'app.yaml',
    content: 'server:\n  port: 8080',
    type: 'yaml',
    md5: 'md5-123',
    ...overrides
  };
}

describe('NacosDraftFileSystemProvider', () => {
  it('initializes draft and reads contents correctly', () => {
    const provider = new NacosDraftFileSystemProvider();
    const detail = mockDetail();
    const uri = provider.initDraft('inst-1', detail, detail);

    expect(uri.scheme).toBe(NACOS_DRAFT_SCHEME);

    const read = provider.readFile(uri);
    expect(Buffer.from(read).toString('utf8')).toBe('server:\n  port: 8080');

    const stat = provider.stat(uri);
    expect(stat.size).toBe(Buffer.byteLength('server:\n  port: 8080', 'utf8'));
    expect(provider.isDirty(uri)).toBe(false);
  });

  it('updates draft on writeFile and tracks dirty state', () => {
    const provider = new NacosDraftFileSystemProvider();
    const detail = mockDetail();
    const uri = provider.initDraft('inst-1', detail, detail);

    provider.writeFile(uri, Buffer.from('server:\n  port: 9090', 'utf8'), {
      create: false,
      overwrite: true
    });

    expect(provider.isDirty(uri)).toBe(true);
    expect(Buffer.from(provider.readFile(uri)).toString('utf8')).toBe('server:\n  port: 9090');

    provider.markClean(uri, 'server:\n  port: 9090', 'md5-9090');
    expect(provider.isDirty(uri)).toBe(false);
    expect(provider.getDraft(uri)?.baseMd5).toBe('md5-9090');
  });

  it('throws FileNotFound when reading non-existent draft', () => {
    const provider = new NacosDraftFileSystemProvider();
    const nonExistent = buildDraftUri('inst-1', {
      namespaceId: 'dev',
      group: 'DEFAULT_GROUP',
      dataId: 'unknown.yaml'
    });

    expect(() => provider.readFile(nonExistent)).toThrow();
    expect(() => provider.stat(nonExistent)).toThrow();
  });

  it('deletes draft and clears cache', () => {
    const provider = new NacosDraftFileSystemProvider();
    const detail = mockDetail();
    const uri = provider.initDraft('inst-1', detail, detail);

    expect(provider.getDraft(uri)).toBeDefined();

    provider.deleteDraft(uri);
    expect(provider.getDraft(uri)).toBeUndefined();
    expect(() => provider.readFile(uri)).toThrow();
  });
});
