import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { NacosDraftFileSystemProvider } from '../../src/document/NacosDraftFileSystemProvider';
import { openDraftDocument } from '../../src/document/openDraftDocument';
import { NacosApiError } from '../../src/nacos/NacosApiError';
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

  it('starts an empty draft without asking the server when createNew is set', async () => {
    const draftProvider = new NacosDraftFileSystemProvider();
    const connect = vi.fn();
    const setLangSpy = vi.spyOn(vscode.languages, 'setTextDocumentLanguage');

    const ref = { namespaceId: 'dev', group: 'DEFAULT_GROUP', dataId: 'brand-new.yaml' };
    await openDraftDocument({ instance, ref, draftProvider, connect, createNew: true });

    // No fetch at all: the dataId came from an input box, so the only thing
    // the server could answer is the resource-not-found this flag assumes.
    expect(connect).not.toHaveBeenCalled();

    const draft = draftProvider.getDraft({ instanceId: instance.id, ref });
    expect(draft?.content).toBe('');
    expect(draft?.baseContent).toBe('');
    // The type is inferred from the dataId suffix, and it drives the language
    // mode the same way a server-carried type would.
    expect(draft?.type).toBe('yaml');
    expect(setLangSpy).toHaveBeenCalledWith(expect.anything(), 'yaml');
  });

  it('falls back to an empty draft when the server says the config does not exist', async () => {
    const draftProvider = new NacosDraftFileSystemProvider();
    const connect = vi.fn().mockResolvedValue({
      getConfig: vi.fn().mockRejectedValue(new NacosApiError('resource-not-found', 'no such config', 404))
    });

    const ref = { namespaceId: 'dev', group: 'DEFAULT_GROUP', dataId: 'just-deleted.json' };
    await openDraftDocument({ instance, ref, draftProvider, connect });

    // The fetch was attempted -- this is the default path, not createNew.
    expect(connect).toHaveBeenCalled();

    const draft = draftProvider.getDraft({ instanceId: instance.id, ref });
    expect(draft?.content).toBe('');
    expect(draft?.baseContent).toBe('');
    expect(draft?.type).toBe('json');
  });

  it('still throws every other fetch failure rather than opening a blank draft over a real config', async () => {
    const draftProvider = new NacosDraftFileSystemProvider();
    const connect = vi.fn().mockResolvedValue({
      getConfig: vi.fn().mockRejectedValue(new NacosApiError('network', 'connection refused'))
    });

    await expect(
      openDraftDocument({ instance, ref: detail, draftProvider, connect })
    ).rejects.toThrow(/connection refused/);

    expect(draftProvider.getDraft({ instanceId: instance.id, ref: detail })).toBeUndefined();
  });

  it('throws for a read-only instance even when creating new, without opening anything', async () => {
    const draftProvider = new NacosDraftFileSystemProvider();
    const connect = vi.fn();

    await expect(
      openDraftDocument({
        instance: { ...instance, readOnly: true },
        ref: detail,
        draftProvider,
        connect,
        createNew: true
      })
    ).rejects.toThrow(/read-only/);

    expect(connect).not.toHaveBeenCalled();
    expect(draftProvider.getDraft({ instanceId: instance.id, ref: detail })).toBeUndefined();
  });
});
