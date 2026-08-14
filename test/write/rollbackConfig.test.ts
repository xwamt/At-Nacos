import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { NacosInstanceConfig } from '../../src/config/schema';
import type { NacosConfigDetail, NacosConfigHistoryEntry } from '../../src/nacos/driver/normalize';
import { rollbackConfig } from '../../src/write/rollbackConfig';

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

const historyEntry: NacosConfigHistoryEntry = {
  ...ref,
  id: '1044',
  opType: 'U',
  modifiedAt: 1723600000000
};

const historyDetail: NacosConfigDetail = {
  ...ref,
  content: 'port: 7070',
  type: 'yaml'
};

const currentDetail: NacosConfigDetail = {
  ...ref,
  content: 'port: 8080',
  type: 'yaml'
};

describe('rollbackConfig', () => {
  it('throws for read-only instance', async () => {
    await expect(
      rollbackConfig({
        instance: { ...instance, readOnly: true },
        ref,
        entry: historyEntry,
        connect: vi.fn()
      })
    ).rejects.toThrow(/read-only/);
  });

  it('rolls back to past version upon confirmation with diff and publishes new version', async () => {
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Roll Back' as unknown as undefined);
    const publishMock = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn().mockResolvedValue({
      getConfigHistory: vi.fn().mockResolvedValue(historyDetail),
      getConfig: vi.fn().mockResolvedValue(currentDetail),
      publishConfig: publishMock
    });

    const refreshDoc = vi.fn();
    const onRollback = vi.fn();

    const rolledBack = await rollbackConfig({
      instance,
      ref,
      entry: historyEntry,
      connect,
      refreshDocument: refreshDoc,
      onRollback
    });

    expect(rolledBack).toBe(true);
    expect(publishMock).toHaveBeenCalledWith({
      namespaceId: 'prod',
      group: 'DEFAULT_GROUP',
      dataId: 'app.yaml',
      content: 'port: 7070',
      type: 'yaml',
      appName: undefined,
      description: undefined
    });
    expect(refreshDoc).toHaveBeenCalledWith(instance.id, ref);
    expect(onRollback).toHaveBeenCalled();
  });
});
