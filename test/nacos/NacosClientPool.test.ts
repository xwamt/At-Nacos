import { describe, expect, it, vi } from 'vitest';
import type { NacosInstanceConfig } from '../../src/config/schema';
import { NacosClientPool } from '../../src/nacos/NacosClientPool';
import type { NacosClient } from '../../src/nacos/NacosClient';

function instance(overrides: Partial<NacosInstanceConfig> = {}): NacosInstanceConfig {
  return {
    id: 'instance-1',
    label: 'prod',
    serverUrl: 'http://nacos.example.com:8848/nacos',
    authMode: 'none',
    readOnly: false,
    allowBackgroundAccess: false,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides
  };
}

describe('NacosClientPool', () => {
  it('reuses the client when called repeatedly for the same instance', async () => {
    const pool = new NacosClientPool();
    const fakeClient = { id: 'fake-1' } as unknown as NacosClient;
    const factory = vi.fn().mockResolvedValue(fakeClient);

    const inst = instance();
    const client1 = await pool.getClient(inst, factory);
    const client2 = await pool.getClient(inst, factory);

    expect(client1).toBe(fakeClient);
    expect(client2).toBe(fakeClient);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('evicts and recreates client when instance configuration changes', async () => {
    const pool = new NacosClientPool();
    const fakeClient1 = { id: 'client-1' } as unknown as NacosClient;
    const fakeClient2 = { id: 'client-2' } as unknown as NacosClient;
    const factory = vi
      .fn()
      .mockResolvedValueOnce(fakeClient1)
      .mockResolvedValueOnce(fakeClient2);

    const inst1 = instance({ updatedAt: 1000 });
    const inst2 = instance({ updatedAt: 2000 });

    const client1 = await pool.getClient(inst1, factory);
    const client2 = await pool.getClient(inst2, factory);

    expect(client1).toBe(fakeClient1);
    expect(client2).toBe(fakeClient2);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('evicts cached client when evict() is called', async () => {
    const pool = new NacosClientPool();
    const fakeClient1 = { id: 'client-1' } as unknown as NacosClient;
    const fakeClient2 = { id: 'client-2' } as unknown as NacosClient;
    const factory = vi
      .fn()
      .mockResolvedValueOnce(fakeClient1)
      .mockResolvedValueOnce(fakeClient2);

    const inst = instance();
    const client1 = await pool.getClient(inst, factory);
    pool.evict(inst.id);
    const client2 = await pool.getClient(inst, factory);

    expect(client1).toBe(fakeClient1);
    expect(client2).toBe(fakeClient2);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('clears all cached clients when clear() is called', async () => {
    const pool = new NacosClientPool();
    const fakeClient1 = { id: 'client-1' } as unknown as NacosClient;
    const fakeClient2 = { id: 'client-2' } as unknown as NacosClient;
    const factory = vi
      .fn()
      .mockResolvedValueOnce(fakeClient1)
      .mockResolvedValueOnce(fakeClient2);

    const inst = instance();
    await pool.getClient(inst, factory);
    pool.clear();
    await pool.getClient(inst, factory);

    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('evicts failed promise so subsequent call retries', async () => {
    const pool = new NacosClientPool();
    const fakeClient = { id: 'client-ok' } as unknown as NacosClient;
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(fakeClient);

    const inst = instance();
    await expect(pool.getClient(inst, factory)).rejects.toThrow('connection refused');

    const client = await pool.getClient(inst, factory);
    expect(client).toBe(fakeClient);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
