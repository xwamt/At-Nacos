import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { NacosInstanceConfig } from '../../src/config/schema';
import { NacosDraftFileSystemProvider } from '../../src/document/NacosDraftFileSystemProvider';
import type { NacosConfigDetail } from '../../src/nacos/driver/normalize';
import { publishConfig } from '../../src/write/publishConfig';

const instance: NacosInstanceConfig = {
  id: 'inst-1',
  label: 'Production',
  serverUrl: 'http://127.0.0.1:8848/nacos',
  authMode: 'none',
  readOnly: false,
  allowBackgroundAccess: false,
  createdAt: 0,
  updatedAt: 0
};

const detail: NacosConfigDetail = {
  namespaceId: 'prod',
  group: 'DEFAULT_GROUP',
  dataId: 'app.yaml',
  content: 'port: 8080',
  type: 'yaml'
};

describe('publishConfig', () => {
  it('throws immediately when instance is read-only', async () => {
    const draftProvider = new NacosDraftFileSystemProvider();
    await expect(
      publishConfig({
        instance: { ...instance, readOnly: true },
        ref: detail,
        draftProvider,
        connect: vi.fn()
      })
    ).rejects.toThrow(/read-only/);
  });

  it('warns when no draft exists', async () => {
    const draftProvider = new NacosDraftFileSystemProvider();
    const warnSpy = vi.spyOn(vscode.window, 'showWarningMessage');

    const published = await publishConfig({
      instance,
      ref: detail,
      draftProvider,
      connect: vi.fn()
    });

    expect(published).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('publishes modified draft upon user confirmation and notifies on success', async () => {
    const draftProvider = new NacosDraftFileSystemProvider();
    const uri = draftProvider.initDraft(instance.id, detail, detail);
    draftProvider.writeFile(uri, Buffer.from('port: 9090', 'utf8'), { create: false, overwrite: true });

    const publishMock = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn().mockResolvedValue({
      getConfig: vi.fn().mockResolvedValue(detail),
      publishConfig: publishMock
    });

    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Publish' as unknown as undefined);
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');
    const refreshDoc = vi.fn();
    const onPublished = vi.fn();

    const published = await publishConfig({
      instance,
      ref: detail,
      draftProvider,
      connect,
      refreshDocument: refreshDoc,
      onPublished
    });

    expect(published).toBe(true);
    expect(publishMock).toHaveBeenCalledWith({
      namespaceId: 'prod',
      group: 'DEFAULT_GROUP',
      dataId: 'app.yaml',
      content: 'port: 9090',
      type: 'yaml',
      appName: undefined,
      description: undefined
    });
    expect(draftProvider.isDirty(uri)).toBe(false);
    expect(refreshDoc).toHaveBeenCalledWith(instance.id, detail);
    expect(onPublished).toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalled();
  });

  it('detects server conflict and attaches warning in confirmation detail', async () => {
    const draftProvider = new NacosDraftFileSystemProvider();
    const uri = draftProvider.initDraft(instance.id, detail, detail);
    draftProvider.writeFile(uri, Buffer.from('port: 9090', 'utf8'), { create: false, overwrite: true });

    const serverModifiedDetail = { ...detail, content: 'port: 8888' };
    const connect = vi.fn().mockResolvedValue({
      getConfig: vi.fn().mockResolvedValue(serverModifiedDetail),
      publishConfig: vi.fn().mockResolvedValue(undefined)
    });

    const warnModalSpy = vi
      .spyOn(vscode.window, 'showWarningMessage')
      .mockResolvedValue('Publish' as unknown as undefined);

    const published = await publishConfig({
      instance,
      ref: detail,
      draftProvider,
      connect
    });

    expect(published).toBe(true);
    expect(warnModalSpy).toHaveBeenCalledWith(
      expect.stringContaining('app.yaml'),
      expect.objectContaining({
        modal: true,
        detail: expect.stringContaining('modified by someone else')
      }),
      'Publish'
    );
  });
});
