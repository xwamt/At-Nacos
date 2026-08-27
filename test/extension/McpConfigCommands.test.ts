import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activate, deactivate } from '../../src/extension';
import {
  ensureAtSeriesConfigForCurrentIde,
  uninstallAtSeriesConfigForCurrentIde
} from '../../src/mcp/McpConfigInstaller';
import { syncPackagedHub } from '../../src/mcp/hubSync';
import {
  commands as fixtureCommands,
  window as fixtureWindow,
  workspace as fixtureWorkspace
} from '../../test-fixtures/vscode';
import { extensionContext } from './extensionContext';

// The installer and the hub sync both write to the real filesystem, which a
// unit test has no business doing -- and the messaging under test is exactly
// the mapping from what these return to what the user is told, so the returns
// are the fixture.
vi.mock('../../src/mcp/McpConfigInstaller', () => ({
  ensureAtSeriesConfigForCurrentIde: vi.fn(),
  uninstallAtSeriesConfigForCurrentIde: vi.fn()
}));
vi.mock('../../src/mcp/hubSync', () => ({
  syncPackagedHub: vi.fn()
}));

const ensureMock = vi.mocked(ensureAtSeriesConfigForCurrentIde);
const uninstallMock = vi.mocked(uninstallAtSeriesConfigForCurrentIde);
const syncMock = vi.mocked(syncPackagedHub);

async function runCommand(command: string): Promise<void> {
  await fixtureCommands.__getRegisteredCommands().get(command)?.();
}

describe('MCP config command messaging', () => {
  beforeEach(async () => {
    await deactivate();
    fixtureCommands.__clearRegisteredCommands();
    fixtureWindow.__clearTreeViews();
    fixtureWindow.__clearLogChannels();
    fixtureWorkspace.__clearContentProviders();
    ensureMock.mockReset();
    uninstallMock.mockReset();
    // `vi.restoreAllMocks()` in afterEach wipes implementations too, so the
    // hub sync's resolved value has to be re-established per test -- activate
    // chains `.then` straight onto what it returns.
    syncMock.mockReset().mockResolvedValue({ updated: false, activeVersion: '0.0.0' });
  });

  afterEach(async () => {
    await deactivate();
    vi.restoreAllMocks();
  });

  it('tells the user the IDE is unsupported when the installer answers undefined', async () => {
    // The old wording here was "already up to date", which claimed an install
    // that never happened: `resolveMcpInstallerTarget` answers undefined for
    // plain VS Code and every unknown host.
    activate(extensionContext());
    ensureMock.mockResolvedValue(undefined);
    const shown = vi.spyOn(fixtureWindow, 'showInformationMessage');

    await runCommand('atNacos.installMcpConfig');

    expect(shown).toHaveBeenCalledTimes(1);
    expect(shown).toHaveBeenCalledWith('This IDE does not support automatic AT Series MCP configuration install.');
  });

  it('reports an install and asks for an MCP client reconnect when the config was written', async () => {
    activate(extensionContext());
    ensureMock.mockResolvedValue({ updated: true });
    const shown = vi.spyOn(fixtureWindow, 'showInformationMessage');

    await runCommand('atNacos.installMcpConfig');

    expect(shown).toHaveBeenCalledTimes(1);
    expect(shown).toHaveBeenCalledWith(
      'AT Series MCP configuration installed. Reconnect your MCP client to pick up the change.'
    );
  });

  it('reports up to date only when the installer really found the config current', async () => {
    activate(extensionContext());
    ensureMock.mockResolvedValue({ updated: false });
    const shown = vi.spyOn(fixtureWindow, 'showInformationMessage');

    await runCommand('atNacos.installMcpConfig');

    expect(shown).toHaveBeenCalledTimes(1);
    expect(shown).toHaveBeenCalledWith('AT Series MCP configuration is already up to date.');
  });

  it('shows an error rather than a success message when the install throws', async () => {
    activate(extensionContext());
    ensureMock.mockRejectedValue(new Error('disk full'));
    const info = vi.spyOn(fixtureWindow, 'showInformationMessage');
    const error = vi.spyOn(fixtureWindow, 'showErrorMessage');

    await runCommand('atNacos.installMcpConfig');

    expect(info).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });

  it('tells the user the IDE is unsupported when the uninstaller answers undefined', async () => {
    activate(extensionContext());
    uninstallMock.mockResolvedValue(undefined);
    const shown = vi.spyOn(fixtureWindow, 'showInformationMessage');

    await runCommand('atNacos.uninstallMcpConfig');

    expect(shown).toHaveBeenCalledTimes(1);
    expect(shown).toHaveBeenCalledWith('This IDE does not support automatic AT Series MCP configuration removal.');
  });

  it('reports a removal when the uninstaller removed the config', async () => {
    activate(extensionContext());
    uninstallMock.mockResolvedValue({ removed: true });
    const shown = vi.spyOn(fixtureWindow, 'showInformationMessage');

    await runCommand('atNacos.uninstallMcpConfig');

    expect(shown).toHaveBeenCalledTimes(1);
    expect(shown).toHaveBeenCalledWith('AT Series MCP configuration removed.');
  });

  it('says there was nothing to remove when the config was already gone', async () => {
    activate(extensionContext());
    uninstallMock.mockResolvedValue({ removed: false });
    const shown = vi.spyOn(fixtureWindow, 'showInformationMessage');

    await runCommand('atNacos.uninstallMcpConfig');

    expect(shown).toHaveBeenCalledTimes(1);
    expect(shown).toHaveBeenCalledWith('No AT Series MCP configuration was found to remove.');
  });

  it('shows an error rather than a success message when the uninstall throws', async () => {
    activate(extensionContext());
    uninstallMock.mockRejectedValue(new Error('permission denied'));
    const info = vi.spyOn(fixtureWindow, 'showInformationMessage');
    const error = vi.spyOn(fixtureWindow, 'showErrorMessage');

    await runCommand('atNacos.uninstallMcpConfig');

    expect(info).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('permission denied'));
  });

  it('hands the uninstaller the same host environment and workspace folder the installer gets', async () => {
    activate(extensionContext());
    ensureMock.mockResolvedValue({ updated: false });
    uninstallMock.mockResolvedValue({ removed: false });

    await runCommand('atNacos.installMcpConfig');
    await runCommand('atNacos.uninstallMcpConfig');

    expect(uninstallMock).toHaveBeenCalledTimes(1);
    expect(uninstallMock.mock.calls[0]?.[0]).toEqual(ensureMock.mock.calls[0]?.[0]);
  });
});
