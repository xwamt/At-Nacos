import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { NacosInstanceConfig } from '../../src/config/schema';
import { NacosDraftFileSystemProvider } from '../../src/document/NacosDraftFileSystemProvider';
import { deleteConfig } from '../../src/write/deleteConfig';

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

const ref = {
  namespaceId: 'prod',
  group: 'DEFAULT_GROUP',
  dataId: 'app.yaml'
};

describe('deleteConfig', () => {
  it('throws for read-only instance', async () => {
    await expect(
      deleteConfig({
        instance: { ...instance, readOnly: true },
        ref,
        connect: vi.fn()
      })
    ).rejects.toThrow(/read-only/);
  });

  it('does not delete if confirmation is rejected', async () => {
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    const deleteMock = vi.fn();
    const connect = vi.fn().mockResolvedValue({ deleteConfig: deleteMock });

    const deleted = await deleteConfig({
      instance,
      ref,
      connect
    });

    expect(deleted).toBe(false);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('deletes config, cleans draft, and refreshes on confirmation', async () => {
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as unknown as undefined);
    const deleteMock = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn().mockResolvedValue({ deleteConfig: deleteMock });
    const draftProvider = new NacosDraftFileSystemProvider();
    draftProvider.initDraft(instance.id, ref, { ...ref, content: 'test', type: 'yaml' });

    const refreshDoc = vi.fn();
    const onDeleted = vi.fn();

    const deleted = await deleteConfig({
      instance,
      ref,
      connect,
      draftProvider,
      refreshDocument: refreshDoc,
      onDeleted
    });

    expect(deleted).toBe(true);
    expect(deleteMock).toHaveBeenCalledWith(ref);
    expect(draftProvider.getDraft({ instanceId: instance.id, ref })).toBeUndefined();
    expect(refreshDoc).toHaveBeenCalledWith(instance.id, ref);
    expect(onDeleted).toHaveBeenCalled();
  });
});
