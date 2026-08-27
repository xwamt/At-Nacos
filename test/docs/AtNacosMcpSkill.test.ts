import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('AT Nacos MCP skill', () => {
  it('keeps YAML description free of Hub workflow shortcut', () => {
    const skill = readFileSync('skills/at-nacos-mcp/SKILL.md', 'utf8');
    const match = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    expect(match).not.toBeNull();
    expect(match![1]).not.toMatch(/discover\s*→\s*select/i);
    expect(match![1]).not.toMatch(/first-class call/i);
  });

  it('points Nacos tools at SuperOps discovery and the instance vs host split', () => {
    const skill = readFileSync('skills/at-nacos-mcp/SKILL.md', 'utf8');
    expect(skill).toContain('super-ops');
    expect(skill).toContain('at.nacos');
    expect(skill).toContain('nacos_list_instances');
    expect(skill).toContain('nacos_list_service_instances');
    expect(skill).toMatch(/never mid-investigation/i);
    expect(skill).toContain('references/tool-selection.md');
  });

  it('documents all 13 read-only tools without exposing writes', () => {
    const table = readFileSync('skills/at-nacos-mcp/references/tool-selection.md', 'utf8');
    for (const name of [
      'nacos_list_instances',
      'nacos_list_namespaces',
      'nacos_list_configs',
      'nacos_get_config',
      'nacos_list_services',
      'nacos_get_service',
      'nacos_list_service_instances',
      'nacos_get_cluster_nodes',
      'nacos_list_config_history',
      'nacos_get_config_history',
      'nacos_list_config_listeners',
      'nacos_list_listened_configs',
      'nacos_list_service_subscribers'
    ]) {
      expect(table).toContain(name);
    }
    expect(table).not.toContain('nacos_publish');
    expect(table).not.toContain('nacos_delete');
    expect(table).toMatch(/risk:\s*read/i);
  });
});
