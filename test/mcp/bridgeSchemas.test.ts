import { describe, expect, it } from 'vitest';
import {
  BRIDGE_SCHEMAS_BY_TOOL_NAME,
  describeZodError,
  NACOS_GET_CONFIG_INPUT_SCHEMA,
  NACOS_LIST_CONFIGS_INPUT_SCHEMA,
  NACOS_LIST_SERVICE_INSTANCES_INPUT_SCHEMA,
  NACOS_LIST_SERVICES_INPUT_SCHEMA,
  nacosGetClusterNodesSchema,
  nacosGetConfigHistorySchema,
  nacosGetConfigSchema,
  nacosGetServiceSchema,
  nacosListConfigHistorySchema,
  nacosListConfigListenersSchema,
  nacosListConfigsSchema,
  nacosListInstancesSchema,
  nacosListNamespacesSchema,
  nacosListServiceInstancesSchema,
  nacosListServiceSubscribersSchema,
  nacosListServicesSchema,
  nacosListListenedConfigsSchema
} from '../../src/mcp/bridgeSchemas';

describe('bridgeSchemas', () => {
  it('nacosListInstancesSchema accepts empty object and rejects extraneous keys', () => {
    expect(nacosListInstancesSchema.safeParse({}).success).toBe(true);
    expect(nacosListInstancesSchema.safeParse({ extra: 'field' }).success).toBe(false);
  });

  it('nacosListNamespacesSchema requires instanceId', () => {
    expect(nacosListNamespacesSchema.safeParse({ instanceId: 'inst-1' }).success).toBe(true);
    expect(nacosListNamespacesSchema.safeParse({}).success).toBe(false);
    expect(nacosListNamespacesSchema.safeParse({ instanceId: '' }).success).toBe(false);
  });

  it('nacosListConfigsSchema accepts official list filters and rejects a bad search mode', () => {
    expect(
      nacosListConfigsSchema.safeParse({
        instanceId: 'inst-1',
        namespaceId: 'dev',
        group: 'DEFAULT_GROUP',
        dataId: 'app.yaml',
        type: 'yaml',
        configTags: 'prod',
        appName: 'order',
        search: 'accurate',
        pageNo: 1,
        pageSize: 50
      }).success
    ).toBe(true);
    expect(nacosListConfigsSchema.safeParse({ instanceId: 'inst-1', search: 'fuzzy' }).success).toBe(false);
    expect(nacosListConfigsSchema.safeParse({ instanceId: 'inst-1', pageSize: 501 }).success).toBe(false);
  });

  it('nacosGetConfigSchema requires instanceId, group and dataId', () => {
    expect(
      nacosGetConfigSchema.safeParse({
        instanceId: 'inst-1',
        namespaceId: 'dev',
        group: 'DEFAULT_GROUP',
        dataId: 'app.yaml',
        raw: true
      }).success
    ).toBe(true);

    expect(nacosGetConfigSchema.safeParse({ instanceId: 'inst-1', dataId: 'app.yaml' }).success).toBe(false);
  });

  it('nacosListServicesSchema validates optional pagination and filters', () => {
    expect(
      nacosListServicesSchema.safeParse({
        instanceId: 'inst-1',
        namespaceId: 'dev',
        group: 'DEFAULT_GROUP',
        pageNo: 1,
        pageSize: 100
      }).success
    ).toBe(true);
  });

  it('nacosListServicesSchema accepts serviceName and ignoreEmptyService', () => {
    expect(
      nacosListServicesSchema.safeParse({
        instanceId: 'inst-1',
        serviceName: 'order',
        ignoreEmptyService: false
      }).success
    ).toBe(true);
  });

  it('nacosGetServiceSchema requires instanceId and serviceName', () => {
    expect(
      nacosGetServiceSchema.safeParse({
        instanceId: 'inst-1',
        group: 'DEFAULT_GROUP',
        serviceName: 'order-service'
      }).success
    ).toBe(true);

    expect(nacosGetServiceSchema.safeParse({ instanceId: 'inst-1' }).success).toBe(false);
  });

  it('nacosGetServiceSchema defaults group to optional', () => {
    expect(
      nacosGetServiceSchema.safeParse({
        instanceId: 'inst-1',
        serviceName: 'order-service'
      }).success
    ).toBe(true);
  });

  it('nacosListServiceInstancesSchema requires serviceName', () => {
    expect(
      nacosListServiceInstancesSchema.safeParse({
        instanceId: 'inst-1',
        serviceName: 'order-service',
        cluster: 'DEFAULT'
      }).success
    ).toBe(true);
    expect(nacosListServiceInstancesSchema.safeParse({ instanceId: 'inst-1' }).success).toBe(false);
  });

  it('nacosGetClusterNodesSchema requires instanceId', () => {
    expect(nacosGetClusterNodesSchema.safeParse({ instanceId: 'inst-1' }).success).toBe(true);
    expect(nacosGetClusterNodesSchema.safeParse({}).success).toBe(false);
  });

  it('nacosGetConfigHistorySchema requires nid', () => {
    expect(
      nacosGetConfigHistorySchema.safeParse({
        instanceId: 'inst-1',
        group: 'DEFAULT_GROUP',
        dataId: 'db.yaml',
        nid: '203'
      }).success
    ).toBe(true);
    expect(
      nacosGetConfigHistorySchema.safeParse({
        instanceId: 'inst-1',
        group: 'DEFAULT_GROUP',
        dataId: 'db.yaml'
      }).success
    ).toBe(false);
  });

  it('nacosListConfigHistorySchema rejects pageSize above 500', () => {
    expect(
      nacosListConfigHistorySchema.safeParse({
        instanceId: 'inst-1',
        group: 'DEFAULT_GROUP',
        dataId: 'db.yaml',
        pageSize: 500
      }).success
    ).toBe(true);
    expect(
      nacosListConfigHistorySchema.safeParse({
        instanceId: 'inst-1',
        group: 'DEFAULT_GROUP',
        dataId: 'db.yaml',
        pageSize: 501
      }).success
    ).toBe(false);
  });

  it('nacosListConfigListenersSchema accepts optional aggregation boolean', () => {
    expect(
      nacosListConfigListenersSchema.safeParse({
        instanceId: 'inst-1',
        group: 'DEFAULT_GROUP',
        dataId: 'db.yaml'
      }).success
    ).toBe(true);
    expect(
      nacosListConfigListenersSchema.safeParse({
        instanceId: 'inst-1',
        group: 'DEFAULT_GROUP',
        dataId: 'db.yaml',
        aggregation: false
      }).success
    ).toBe(true);
    expect(
      nacosListConfigListenersSchema.safeParse({
        instanceId: 'inst-1',
        group: 'DEFAULT_GROUP',
        dataId: 'db.yaml',
        aggregation: 'no'
      }).success
    ).toBe(false);
  });

  it('nacosListServiceSubscribersSchema treats group as optional and aggregation as optional boolean', () => {
    expect(
      nacosListServiceSubscribersSchema.safeParse({
        instanceId: 'inst-1',
        serviceName: 'order-service'
      }).success
    ).toBe(true);
    expect(
      nacosListServiceSubscribersSchema.safeParse({
        instanceId: 'inst-1',
        serviceName: 'order-service',
        group: 'DEFAULT_GROUP',
        aggregation: true
      }).success
    ).toBe(true);
    expect(
      nacosListServiceSubscribersSchema.safeParse({
        instanceId: 'inst-1'
      }).success
    ).toBe(false);
  });

  it('nacosListListenedConfigsSchema requires instanceId and ip', () => {
    expect(
      nacosListListenedConfigsSchema.safeParse({
        instanceId: 'inst-1',
        ip: '10.0.0.8'
      }).success
    ).toBe(true);
    expect(
      nacosListListenedConfigsSchema.safeParse({
        instanceId: 'inst-1'
      }).success
    ).toBe(false);
    expect(
      nacosListListenedConfigsSchema.safeParse({
        instanceId: 'inst-1',
        ip: '10.0.0.8',
        aggregation: false
      }).success
    ).toBe(true);
  });

  it('contains schema for all catalog tools in BRIDGE_SCHEMAS_BY_TOOL_NAME', () => {
    expect(Object.keys(BRIDGE_SCHEMAS_BY_TOOL_NAME).sort()).toEqual([
      'nacos_get_cluster_nodes',
      'nacos_get_config',
      'nacos_get_config_history',
      'nacos_get_service',
      'nacos_list_config_history',
      'nacos_list_config_listeners',
      'nacos_list_configs',
      'nacos_list_instances',
      'nacos_list_listened_configs',
      'nacos_list_namespaces',
      'nacos_list_service_instances',
      'nacos_list_service_subscribers',
      'nacos_list_services'
    ]);
  });

  it('JSON Schema descriptions carry namespace, groupNameParam and listing-cost contracts', () => {
    const configNs = NACOS_LIST_CONFIGS_INPUT_SCHEMA.properties?.namespaceId;
    expect(typeof configNs === 'object' && configNs && 'description' in configNs ? configNs.description : '').not.toMatch(
      /defaults to public namespace/i
    );
    expect(typeof configNs === 'object' && configNs && 'description' in configNs ? configNs.description : '').toMatch(
      /nacos_list_namespaces/
    );
    const getConfigNs = NACOS_GET_CONFIG_INPUT_SCHEMA.properties?.namespaceId;
    expect(
      typeof getConfigNs === 'object' && getConfigNs && 'description' in getConfigNs ? getConfigNs.description : ''
    ).not.toMatch(/defaults to public namespace/i);
    const search = NACOS_LIST_CONFIGS_INPUT_SCHEMA.properties?.search;
    expect(typeof search === 'object' && search && 'description' in search ? search.description : '').toMatch(
      /omit.*accurate/i
    );
    const pageSize = NACOS_LIST_CONFIGS_INPUT_SCHEMA.properties?.pageSize;
    expect(typeof pageSize === 'object' && pageSize && 'description' in pageSize ? pageSize.description : '').toMatch(
      /memory|context|expensive/i
    );
    const group = NACOS_LIST_SERVICES_INPUT_SCHEMA.properties?.group;
    expect(typeof group === 'object' && group && 'description' in group ? group.description : '').toContain(
      'groupNameParam'
    );
    const cluster = NACOS_LIST_SERVICE_INSTANCES_INPUT_SCHEMA.properties?.cluster;
    expect(typeof cluster === 'object' && cluster && 'description' in cluster ? cluster.description : '').not.toContain(
      'NacosInstanceQuery'
    );
  });

  it('describeZodError formats error issues into human-readable string', () => {
    const res = nacosGetConfigSchema.safeParse({});
    expect(res.success).toBe(false);
    if (!res.success) {
      const msg = describeZodError(res.error);
      expect(msg).toContain('instanceId');
      expect(msg).toContain('group');
      expect(msg).toContain('dataId');
    }
  });
});
