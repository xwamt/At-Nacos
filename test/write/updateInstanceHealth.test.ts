import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { NacosInstanceConfig } from '../../src/config/schema';
import type { NacosInstance, NacosServiceRef } from '../../src/nacos/driver/normalize';
import { toggleServiceInstanceEnabled } from '../../src/write/updateInstanceHealth';

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

const serviceRef: NacosServiceRef = {
  namespaceId: 'prod',
  group: 'DEFAULT_GROUP',
  serviceName: 'order-service'
};

const serviceInstance: NacosInstance = {
  instanceId: 'inst-order-1',
  ip: '192.168.1.100',
  port: 8080,
  healthy: true,
  enabled: true,
  weight: 1,
  ephemeral: true,
  clusterName: 'DEFAULT',
  metadata: {}
};

describe('updateInstanceHealth', () => {
  it('throws when instance is read-only', async () => {
    await expect(
      toggleServiceInstanceEnabled({
        instance: { ...instance, readOnly: true },
        serviceRef,
        serviceInstance,
        enabled: false,
        connect: vi.fn()
      })
    ).rejects.toThrow(/read-only/);
  });

  it('updates instance enabled state upon user confirmation', async () => {
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Disable' as unknown as undefined);
    const updateMock = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn().mockResolvedValue({
      updateInstanceHealth: updateMock
    });

    const onUpdated = vi.fn();
    const updated = await toggleServiceInstanceEnabled({
      instance,
      serviceRef,
      serviceInstance,
      enabled: false,
      connect,
      onUpdated
    });

    expect(updated).toBe(true);
    expect(updateMock).toHaveBeenCalledWith({
      service: serviceRef,
      instance: serviceInstance,
      enabled: false
    });
    expect(onUpdated).toHaveBeenCalled();
  });
});
