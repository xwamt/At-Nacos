import { describe, expect, it } from 'vitest';
import { AT_NACOS_PLUGIN_ID, AT_NACOS_TOOL_CATALOG } from '../../src/mcp/toolCatalog';
import { BRIDGE_SCHEMAS_BY_TOOL_NAME } from '../../src/mcp/bridgeSchemas';

describe('toolCatalog', () => {
  it('pluginId matches reverse-domain requirement', () => {
    expect(AT_NACOS_PLUGIN_ID).toBe('at.nacos');
    expect(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(AT_NACOS_PLUGIN_ID)).toBe(true);
  });

  it('declares read-only nacos_ tools including service instances as a separate tool', () => {
    const names = AT_NACOS_TOOL_CATALOG.map((tool) => tool.name);
    expect(names).toContain('nacos_list_service_instances');
    expect(names).toContain('nacos_list_instances');
    const getService = AT_NACOS_TOOL_CATALOG.find((tool) => tool.name === 'nacos_get_service');
    expect(getService?.description).toMatch(/not including instance list|不含实例/i);
    expect(getService?.description).toContain('nacos_list_service_instances');
    for (const tool of AT_NACOS_TOOL_CATALOG) {
      expect(tool.name).toMatch(/^nacos_[a-z0-9_]+$/);
      expect(tool.risk).toBe('read');
      expect(BRIDGE_SCHEMAS_BY_TOOL_NAME[tool.name]).toBeDefined();
    }
  });
});
