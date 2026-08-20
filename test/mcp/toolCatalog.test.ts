import { describe, expect, it } from 'vitest';
import { AT_NACOS_PLUGIN_ID, AT_NACOS_TOOL_CATALOG } from '../../src/mcp/toolCatalog';
import { BRIDGE_SCHEMAS_BY_TOOL_NAME } from '../../src/mcp/bridgeSchemas';

describe('toolCatalog', () => {
  it('pluginId matches reverse-domain requirement', () => {
    expect(AT_NACOS_PLUGIN_ID).toBe('at.nacos');
    expect(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(AT_NACOS_PLUGIN_ID)).toBe(true);
  });

  it('declares read-only nacos_ tools including service instances as a separate tool', () => {
    expect(AT_NACOS_TOOL_CATALOG).toHaveLength(13);
    expect(AT_NACOS_TOOL_CATALOG.map((tool) => tool.name).sort()).toEqual([
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
    const names = AT_NACOS_TOOL_CATALOG.map((tool) => tool.name);
    expect(names).toContain('nacos_list_service_instances');
    expect(names).toContain('nacos_list_instances');
    expect(names).toContain('nacos_list_config_history');
    expect(names).toContain('nacos_get_config_history');
    expect(names).toContain('nacos_list_config_listeners');
    expect(names).toContain('nacos_list_service_subscribers');
    expect(names).toContain('nacos_list_listened_configs');
    const getService = AT_NACOS_TOOL_CATALOG.find((tool) => tool.name === 'nacos_get_service');
    expect(getService?.description).toMatch(/not including instance list|不含实例/i);
    expect(getService?.description).toContain('nacos_list_service_instances');
    const namespaces = AT_NACOS_TOOL_CATALOG.find((tool) => tool.name === 'nacos_list_namespaces');
    expect(namespaces?.description).toMatch(/empty string on 1\.x\/2\.x/i);
    expect(namespaces?.description).toMatch(/"public" on 3\.x/i);
    const clusterNodes = AT_NACOS_TOOL_CATALOG.find((tool) => tool.name === 'nacos_get_cluster_nodes');
    expect(clusterNodes?.description).toMatch(/metrics may be omitted/i);
    const listConfigs = AT_NACOS_TOOL_CATALOG.find((tool) => tool.name === 'nacos_list_configs');
    expect(listConfigs?.description).toMatch(/type/);
    expect(listConfigs?.description).toMatch(/configTags/);
    expect(listConfigs?.description).toMatch(/appName/);
    expect(listConfigs?.description).toMatch(/omit search for accurate/i);
    expect(listConfigs?.description).toMatch(/\*/);
    expect(listConfigs?.description).toMatch(/no bodies|without bodies|strips it/i);
    expect(listConfigs?.description).toMatch(/max 500/);
    const listServices = AT_NACOS_TOOL_CATALOG.find((tool) => tool.name === 'nacos_list_services');
    expect(listServices?.description).toContain('groupNameParam');
    expect(listServices?.description).toContain('serviceNameParam');
    expect(listServices?.description).toMatch(/withInstances is never exposed/i);
    expect(listServices?.description).toMatch(/expensive|memory|cost/i);
    const listServiceInstances = AT_NACOS_TOOL_CATALOG.find((tool) => tool.name === 'nacos_list_service_instances');
    expect(listServiceInstances?.description).not.toContain('NacosInstanceQuery');
    expect(listServiceInstances?.description).toMatch(/omit.*cluster|every cluster/i);
    for (const tool of AT_NACOS_TOOL_CATALOG) {
      expect(tool.name).toMatch(/^nacos_[a-z0-9_]+$/);
      expect(tool.risk).toBe('read');
      expect(BRIDGE_SCHEMAS_BY_TOOL_NAME[tool.name]).toBeDefined();
    }
  });
});
