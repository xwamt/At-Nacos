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
      selector: { type: 'none' }
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
    listInstances: vi.fn().mockResolvedValue([
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
    ]),
    listConfigHistory: vi.fn().mockResolvedValue({
      totalCount: 1,
      pageNumber: 1,
      pagesAvailable: 1,
      items: [{ id: '203', group: 'DEFAULT_GROUP', dataId: 'db.yaml', namespaceId: 'dev', opType: 'U' }]
    }),
    getConfigHistory: vi.fn().mockResolvedValue({
      namespaceId: 'dev',
      group: 'DEFAULT_GROUP',
      dataId: 'db.yaml',
      type: 'yaml',
      content: 'password: super-secret-password'
    }),
    listConfigListeners: vi.fn().mockResolvedValue([{ ip: '10.0.0.1', md5: 'abc' }]),
    listListenedConfigs: vi.fn().mockResolvedValue([]),
    listSubscribers: vi.fn().mockResolvedValue([
      { ip: '10.0.0.1', port: 0, group: 'DEFAULT_GROUP', serviceName: 'order-service', namespaceId: 'dev' }
    ]),
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

  it('nacos_list_configs forwards filters to the client and omits content', async () => {
    const { service, client } = createMockDeps();
    const res = await service.invoke('nacos_list_configs', {
      instanceId: 'inst-allowed',
      namespaceId: 'dev',
      group: 'DEFAULT_GROUP',
      dataId: 'db.yaml',
      search: 'accurate',
      type: 'yaml',
      appName: 'order',
      configTags: 'prod'
    });
    expect(res.ok).toBe(true);
    expect(client.listConfigs).toHaveBeenCalledWith({
      namespaceId: 'dev',
      group: 'DEFAULT_GROUP',
      dataId: 'db.yaml',
      searchMode: 'accurate',
      type: 'yaml',
      appName: 'order',
      configTags: 'prod',
      pageNo: 1,
      pageSize: 100
    });
    if (res.ok) {
      const data = res.result as { items: Array<Record<string, unknown>> };
      expect(data.items[0]).not.toHaveProperty('content');
      expect(JSON.stringify(data)).not.toContain('super-secret-password');
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

  it('nacos_list_services defaults ignoreEmptyService to true and forwards serviceName', async () => {
    const { service, client } = createMockDeps();
    await service.invoke('nacos_list_services', {
      instanceId: 'inst-allowed',
      serviceName: 'order'
    });
    expect(client.listServices).toHaveBeenCalledWith({
      namespaceId: '',
      group: undefined,
      serviceName: 'order',
      ignoreEmptyService: true,
      pageNo: 1,
      pageSize: 100
    });
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

  it('nacos_get_service fills DEFAULT_GROUP and does not call listInstances', async () => {
    const { service, client } = createMockDeps();
    const res = await service.invoke('nacos_get_service', {
      instanceId: 'inst-allowed',
      serviceName: 'order-service'
    });
    expect(res.ok).toBe(true);
    expect(client.getService).toHaveBeenCalledWith({
      namespaceId: '',
      group: 'DEFAULT_GROUP',
      serviceName: 'order-service'
    });
    expect(client.listInstances).not.toHaveBeenCalled();
    if (res.ok) {
      expect(res.result).not.toHaveProperty('hosts');
      expect(res.result).not.toHaveProperty('instances');
    }
  });

  it('nacos_list_service_instances lists instances for one service', async () => {
    const { service, client } = createMockDeps();
    const res = await service.invoke('nacos_list_service_instances', {
      instanceId: 'inst-allowed',
      serviceName: 'order-service',
      cluster: 'DEFAULT'
    });
    expect(res.ok).toBe(true);
    expect(client.listInstances).toHaveBeenCalledWith({
      namespaceId: '',
      group: 'DEFAULT_GROUP',
      serviceName: 'order-service',
      cluster: 'DEFAULT'
    });
    if (res.ok) {
      expect(res.result).toEqual({
        instances: [
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
      });
    }
  });

  it('nacos_list_config_history pages history without content', async () => {
    const { service, client } = createMockDeps();
    const res = await service.invoke('nacos_list_config_history', {
      instanceId: 'inst-allowed',
      group: 'DEFAULT_GROUP',
      dataId: 'db.yaml'
    });
    expect(res.ok).toBe(true);
    expect(client.listConfigHistory).toHaveBeenCalledWith({
      namespaceId: '',
      group: 'DEFAULT_GROUP',
      dataId: 'db.yaml',
      pageNo: 1,
      pageSize: 100
    });
    if (res.ok) {
      const page = res.result as { items: Array<Record<string, unknown>> };
      expect(page.items[0]).not.toHaveProperty('content');
    }
  });

  it('nacos_get_config_history redacts unless raw is true', async () => {
    const { service } = createMockDeps();
    const redacted = await service.invoke('nacos_get_config_history', {
      instanceId: 'inst-allowed',
      group: 'DEFAULT_GROUP',
      dataId: 'db.yaml',
      nid: '203'
    });
    expect(redacted.ok).toBe(true);
    if (redacted.ok) {
      const data = redacted.result as { content: string; isRedacted: boolean };
      expect(data.isRedacted).toBe(true);
      expect(data.content).not.toContain('super-secret-password');
    }

    const raw = await service.invoke('nacos_get_config_history', {
      instanceId: 'inst-allowed',
      group: 'DEFAULT_GROUP',
      dataId: 'db.yaml',
      nid: '203',
      raw: true
    });
    expect(raw.ok).toBe(true);
    if (raw.ok) {
      const data = raw.result as { content: string; isRedacted: boolean };
      expect(data.isRedacted).toBe(false);
      expect(data.content).toContain('super-secret-password');
    }
  });

  it('nacos_get_config_history requires nid', async () => {
    const { service } = createMockDeps();
    const res = await service.invoke('nacos_get_config_history', {
      instanceId: 'inst-allowed',
      group: 'DEFAULT_GROUP',
      dataId: 'db.yaml'
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('VALIDATION_ERROR');
    }
  });

  it('nacos_list_config_listeners forwards aggregation', async () => {
    const { service, client } = createMockDeps();
    await service.invoke('nacos_list_config_listeners', {
      instanceId: 'inst-allowed',
      group: 'DEFAULT_GROUP',
      dataId: 'db.yaml',
      aggregation: false
    });
    expect(client.listConfigListeners).toHaveBeenCalledWith({
      namespaceId: '',
      group: 'DEFAULT_GROUP',
      dataId: 'db.yaml',
      aggregation: false
    });
  });

  it('nacos_list_config_listeners defaults aggregation to true', async () => {
    const { service, client } = createMockDeps();
    await service.invoke('nacos_list_config_listeners', {
      instanceId: 'inst-allowed',
      group: 'DEFAULT_GROUP',
      dataId: 'db.yaml'
    });
    expect(client.listConfigListeners).toHaveBeenCalledWith({
      namespaceId: '',
      group: 'DEFAULT_GROUP',
      dataId: 'db.yaml',
      aggregation: true
    });
  });

  it('nacos_list_listened_configs requires ip', async () => {
    const { service } = createMockDeps();
    const res = await service.invoke('nacos_list_listened_configs', { instanceId: 'inst-allowed' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('VALIDATION_ERROR');
    }
  });

  it('nacos_list_listened_configs forwards ip and aggregation', async () => {
    const { service, client } = createMockDeps();
    await service.invoke('nacos_list_listened_configs', {
      instanceId: 'inst-allowed',
      ip: '10.0.0.8'
    });
    expect(client.listListenedConfigs).toHaveBeenCalledWith({
      namespaceId: '',
      ip: '10.0.0.8',
      aggregation: true
    });
  });

  it('nacos_list_service_subscribers defaults group and aggregation', async () => {
    const { service, client } = createMockDeps();
    await service.invoke('nacos_list_service_subscribers', {
      instanceId: 'inst-allowed',
      serviceName: 'order-service'
    });
    expect(client.listSubscribers).toHaveBeenCalledWith({
      namespaceId: '',
      group: 'DEFAULT_GROUP',
      serviceName: 'order-service',
      aggregation: true
    });
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
