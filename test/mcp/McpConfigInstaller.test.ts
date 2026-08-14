import { describe, expect, it } from 'vitest';
import {
  ensureAtSeriesConfigForCurrentIde,
  resolveMcpInstallerTarget,
  uninstallAtSeriesConfigForCurrentIde
} from '../../src/mcp/McpConfigInstaller';

describe('McpConfigInstaller', () => {
  it('resolveMcpInstallerTarget maps host apps correctly', () => {
    expect(resolveMcpInstallerTarget('cursor')).toBe('cursor');
    expect(resolveMcpInstallerTarget('kiro')).toBe('kiro');
    expect(resolveMcpInstallerTarget('continue', '/workspace')).toBe('continue');
    expect(resolveMcpInstallerTarget('continue')).toBeUndefined();
    expect(resolveMcpInstallerTarget('vscode')).toBeUndefined();
  });

  it('skips installer when hostApp target is not resolvable', async () => {
    const res = await ensureAtSeriesConfigForCurrentIde({
      appName: 'Visual Studio Code'
    });
    expect(res).toBeUndefined();

    const uninstallRes = await uninstallAtSeriesConfigForCurrentIde({
      appName: 'Visual Studio Code'
    });
    expect(uninstallRes).toBeUndefined();
  });
});
