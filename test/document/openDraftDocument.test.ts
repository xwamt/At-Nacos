import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { NacosDraftFileSystemProvider } from '../../src/document/NacosDraftFileSystemProvider';
import { openDraftDocument } from '../../src/document/openDraftDocument';
import type { NacosInstanceConfig } from '../../src/config/schema';
import type { NacosConfigDetail } from '../../src/nacos/driver/normalize';

const instance: NacosInstanceConfig = {
  id: 'inst-1',
  label: 'Dev Server',
  serverUrl: 'http://127.0.0.1:8848/nacos',
  authMode: 'none',
  readOnly: false,
  allowBackgroundAccess: false,
  createdAt: 0,
  updatedAt: 0
};

const detail: NacosConfigDetail = {
  namespaceId: 'dev',
  group: 'DEFAULT_GROUP',
  dataId: 'app.yaml',
  content: 'port: 8080',
  type: 'yaml'
};

describe('openDraftDocument', () => {
  it('throws for read-only instance without fetching or opening', async () => {
    const draftProvider = new NacosDraftFileSystemProvider();
    const connect = vi.fn();

    await expect(
      openDraftDocument({
        instance: { ...instance, readOnly: true },
        ref: detail,
        draftProvider,
        connect
      })
    ).rejects.toThrow(/read-only/);

    expect(connect).not.toHaveBeenCalled();
  });

  it('fetches server config and opens draft document with correct language', async () => {
    const draftProvider = new NacosDraftFileSystemProvider();
    const connect = vi.fn().mockResolvedValue({
      getConfig: vi.fn().mockResolvedValue(detail)
    });

    const openDocSpy = vi.spyOn(vscode.workspace, 'openTextDocument');
    const setLangSpy = vi.spyOn(vscode.languages, 'setTextDocumentLanguage');
    const showDocSpy = vi.spyOn(vscode.window, 'showTextDocument');

    const doc = await openDraftDocument({
      instance,
      ref: detail,
      draftProvider,
      connect
    });

    expect(connect).toHaveBeenCalled();
    expect(openDocSpy).toHaveBeenCalled();
    expect(setLangSpy).toHaveBeenCalledWith(expect.anything(), 'yaml');
    expect(showDocSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ preview: false }));
    expect(doc).toBeDefined();

    // Opening a second time uses existing draft without re-fetching
    connect.mockClear();
    await openDraftDocument({
      instance,
      ref: detail,
      draftProvider,
      connect
    });
    expect(connect).not.toHaveBeenCalled();
  });
});
