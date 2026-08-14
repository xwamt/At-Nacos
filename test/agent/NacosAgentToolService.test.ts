import { describe, expect, it, vi } from 'vitest';
import { NacosAgentToolService, type NacosApiClientLike } from '../../src/agent/NacosAgentToolService';
import type { NacosInstanceConfig } from '../../src/config/schema';

const allowedInstance: NacosInstanceConfig = {
  id: 'inst-allowed',
  label: 'Dev Nacos',
  serverUrl: 'http://127.0.0.1:8848/nacos',
  authMode: 'none',
  readOnly: false,
  allowBackgroundAccess: true,
  createdAt: 0,
  updatedAt: 0
};

const blockedInstance: NacosInstanceConfig = {
  id: 'inst-blocked',
  label: 'Prod Nacos',
  serverUrl: 'http://127.0.0.1:8848/nacos',
  authMode: 'none',
  readOnly: true,
  allowBackgroundAccess: false,
  createdAt: 0,
  updatedAt: 0
};

function createMockDeps(clientOverrides: Partial<NacosApiClientLike> = {}) {
  const instances = [allowedInstance, blockedInstance];
  const configManager = {
    listInstances: vi.fn().mockResolvedValue(instances),
    getInstance: vi.fn().mockImplementation(async (id: string) => instances.find((i) => i.id === id)),
    getToken: vi.fn().mockResolvedValue(undefined)
  };

  const certTrustStore = {
    isTrusted: vi.fn().mockReturnValue(true)
  };

  const client: NacosApiClientLike = {
    listNamespaces: vi.fn().mockResolvedValue([
      { namespaceId: 'dev', namespaceName: 'Development', description: 'dev env', configCount: 5 }
    ]),
    listConfigs: vi.fn().mockResolvedValue({
      totalCount: 1,
      pageNo: 1,
      pageSize: 100,
      items: [
        {
          namespaceId: 'dev',
          group: 'DEFAULT_GROUP',
          dataId: 'db.yaml',
          type: 'yaml',
          content: 'spring:\n  datasource:\n    password: super-secret-password\n    username: root'
        }
      ]
    }),
    getConfig: vi.fn().mockResolvedValue({
      namespaceId: 'dev',
      group: 'DEFAULT_GROUP',
      dataId: 'db.yaml',
      type: 'yaml',
      md5: 'abc123md5',
      content: 'spring:\n  datasource:\n    password: super-secret-password\n    username: root'
    }),
    listServices: vi.fn().mockResolvedValue({
      totalCount: 1,
      items: [
        {
          serviceName: 'order-service',
          group: 'DEFAULT_GROUP',
          healthyInstanceCount: 2,
          totalInstanceCount: 2,
          triggerFlag: 'false'
        }
      ]
    }),
    getService: vi.fn().mockResolvedValue({
      serviceName: 'order-service',
      group: 'DEFAULT_GROUP',
      namespaceId: 'dev',
      protectThreshold: 0,
      metadata: {},
      selector: { type: 'none' },
      hosts: [
        {
          ip: '192.168.1.10',
          port: 8080,
          healthy: true,
          enabled: true,
          weight: 1,
          clusterName: 'DEFAULT',
          ephemeral: true,
          metadata: {}
        }
      ]
    }),
    listClusterNodes: vi.fn().mockResolvedValue([
      {
        address: '127.0.0.1:8848',
        ip: '127.0.0.1',
        port: 8848,
        state: 'UP',
        version: '2.3.2',
        raftPort: 7848,
        failAccessCnt: 0
      }
    ]),
    getServerMetrics: vi.fn().mockResolvedValue({
      status: 'UP',
      serviceCount: 10,
      instanceCount: 20
    }),
    ...clientOverrides
  };

  const createClient = vi.fn().mockResolvedValue(client);

  const service = new NacosAgentToolService({
    configManager: configManager as never,
    certTrustStore: certTrustStore as never,
    createClient
  });

  return { service, client, configManager };
}

describe('NacosAgentToolService', () => {
  it('nacos_list_instances filters out instances without background access', async () => {
    const { service } = createMockDeps();
    const res = await service.invoke('nacos_list_instances', {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.result as { instances: { id: string; label: string; serverUrl: string }[] };
      expect(data.instances).toEqual([
        {
          id: 'inst-allowed',
          label: 'Dev Nacos',
          serverUrl: 'http://127.0.0.1:8848/nacos'
        }
      ]);
    }
  });

  it('rejects access to instances without background access', async () => {
    const { service } = createMockDeps();
    const res = await service.invoke('nacos_list_namespaces', { instanceId: 'inst-blocked' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('UNAVAILABLE');
    }
  });

  it('returns NOT_FOUND for non-existent instanceId', async () => {
    const { service } = createMockDeps();
    const res = await service.invoke('nacos_list_namespaces', { instanceId: 'non-existent' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('NOT_FOUND');
    }
  });

  it('nacos_list_configs redacts sensitive passwords by default', async () => {
    const { service } = createMockDeps();
    const res = await service.invoke('nacos_list_configs', { instanceId: 'inst-allowed' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.result as { items: { content: string }[] };
      expect(data.items[0].content).not.toContain('super-secret-password');
      expect(data.items[0].content).toContain('[REDACTED]');
    }
  });

  it('nacos_get_config redacts content by default and provides raw when raw: true', async () => {
    const { service } = createMockDeps();

    // Default redacted
    const redactedRes = await service.invoke('nacos_get_config', {
      instanceId: 'inst-allowed',
      group: 'DEFAULT_GROUP',
      dataId: 'db.yaml'
    });
    expect(redactedRes.ok).toBe(true);
    if (redactedRes.ok) {
      const data = redactedRes.result as { content: string; isRedacted: boolean };
      expect(data.isRedacted).toBe(true);
      expect(data.content).toContain('[REDACTED]');
      expect(data.content).not.toContain('super-secret-password');
    }

    // Raw unredacted
    const rawRes = await service.invoke('nacos_get_config', {
      instanceId: 'inst-allowed',
      group: 'DEFAULT_GROUP',
      dataId: 'db.yaml',
      raw: true
    });
    expect(rawRes.ok).toBe(true);
    if (rawRes.ok) {
      const data = rawRes.result as { content: string; isRedacted: boolean };
      expect(data.isRedacted).toBe(false);
      expect(data.content).toContain('super-secret-password');
    }
  });

  it('nacos_list_namespaces, nacos_list_services, nacos_get_service, nacos_get_cluster_nodes work correctly', async () => {
    const { service } = createMockDeps();

    const nsRes = await service.invoke('nacos_list_namespaces', { instanceId: 'inst-allowed' });
    expect(nsRes.ok).toBe(true);

    const svcListRes = await service.invoke('nacos_list_services', { instanceId: 'inst-allowed' });
    expect(svcListRes.ok).toBe(true);

    const svcDetailRes = await service.invoke('nacos_get_service', {
      instanceId: 'inst-allowed',
      group: 'DEFAULT_GROUP',
      serviceName: 'order-service'
    });
    expect(svcDetailRes.ok).toBe(true);

    const clusterRes = await service.invoke('nacos_get_cluster_nodes', { instanceId: 'inst-allowed' });
    expect(clusterRes.ok).toBe(true);
  });

  it('returns VALIDATION_ERROR when input schema fails', async () => {
    const { service } = createMockDeps();
    const res = await service.invoke('nacos_get_config', { instanceId: 'inst-allowed' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('VALIDATION_ERROR');
    }
  });

  it('returns NOT_FOUND for unknown tool', async () => {
    const { service } = createMockDeps();
    const res = await service.invoke('nacos_unknown_tool', {});
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('NOT_FOUND');
    }
  });
});
