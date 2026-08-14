import { describe, expect, it } from 'vitest';
import { AT_NACOS_PLUGIN_ID, AT_NACOS_TOOL_CATALOG } from '../../src/mcp/toolCatalog';
import { BRIDGE_SCHEMAS_BY_TOOL_NAME } from '../../src/mcp/bridgeSchemas';

describe('toolCatalog', () => {
  it('pluginId matches reverse-domain requirement', () => {
    expect(AT_NACOS_PLUGIN_ID).toBe('at.nacos');
    expect(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(AT_NACOS_PLUGIN_ID)).toBe(true);
  });

  it('declares exactly 7 read-only tools matching nacos_ prefix', () => {
    expect(AT_NACOS_TOOL_CATALOG).toHaveLength(7);
    for (const tool of AT_NACOS_TOOL_CATALOG) {
      expect(tool.name).toMatch(/^nacos_[a-z0-9_]+$/);
      expect(tool.risk).toBe('read');
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeDefined();
      expect(BRIDGE_SCHEMAS_BY_TOOL_NAME[tool.name]).toBeDefined();
    }
  });
});
