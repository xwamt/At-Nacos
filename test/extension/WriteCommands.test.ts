import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from '../../src/extension';
import { ConfigTreeItem, ServiceInstanceTreeItem } from '../../src/tree/NacosTreeItems';
import {
  commands as fixtureCommands,
  window as fixtureWindow,
  workspace as fixtureWorkspace
} from '../../test-fixtures/vscode';
import { extensionContext } from './extensionContext';
import * as publishModule from '../../src/write/publishConfig';
import * as deleteModule from '../../src/write/deleteConfig';
import * as draftModule from '../../src/document/openDraftDocument';
import * as rollbackModule from '../../src/write/rollbackConfig';
import * as updateHealthModule from '../../src/write/updateInstanceHealth';
import { NacosInstanceConfigManager } from '../../src/config/NacosInstanceConfigManager';
import { NacosClientPool } from '../../src/nacos/NacosClientPool';
import { ConfigHistoryPanel } from '../../src/webview/ConfigHistoryPanel';

const instance = {
  id: 'inst-1',
  label: 'Dev Instance',
  serverUrl: 'http://localhost:8848/nacos',
  readOnly: false
};

const configSummary = {
  namespaceId: 'dev',
  group: 'DEFAULT_GROUP',
  dataId: 'app.yaml',
  type: 'yaml'
};

const serviceRef = {
  namespaceId: 'dev',
  group: 'DEFAULT_GROUP',
  serviceName: 'order-service'
};

const serviceInstance = {
  instanceId: 'inst-100',
  ip: '192.168.1.100',
  port: 8080,
  healthy: true,
  enabled: true,
  weight: 1,
  ephemeral: true,
  clusterName: 'DEFAULT',
  metadata: {}
};

describe('WriteCommands integration', () => {
  beforeEach(async () => {
    await deactivate();
    fixtureCommands.__clearRegisteredCommands();
    fixtureWindow.__clearTreeViews();
    fixtureWindow.__clearLogChannels();
    fixtureWorkspace.__clearContentProviders();
    fixtureWorkspace.__clearFileSystemProviders();
    fixtureWorkspace.__clearDocumentListeners();
  });

  afterEach(async () => {
    await deactivate();
    fixtureWorkspace.__clearDocumentListeners();
    vi.restoreAllMocks();
  });

  it('registers nacos-draft file system provider upon activation', async () => {
    activate(extensionContext());
    const providers = fixtureWorkspace.__getFileSystemProviders();
    expect(providers.some((p) => p.scheme === 'nacos-draft')).toBe(true);
  });

  it('invokes openDraftDocument when atNacos.editConfig is executed', async () => {
    const editSpy = vi.spyOn(draftModule, 'openDraftDocument').mockResolvedValue({} as vscode.TextDocument);
    vi.spyOn(NacosInstanceConfigManager.prototype, 'getInstance').mockResolvedValue(instance as never);

    activate(extensionContext());

    const item = new ConfigTreeItem('config', instance as never, 'dev', configSummary);
    const handler = fixtureCommands.__getRegisteredCommands().get('atNacos.editConfig');
    expect(handler).toBeDefined();

    await handler?.(item as never);
    expect(editSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        instance: expect.objectContaining({ id: 'inst-1' }),
        ref: configSummary
      })
    );
  });

  it('invokes publishConfig when atNacos.publishConfig is executed with tree item', async () => {
    const publishSpy = vi.spyOn(publishModule, 'publishConfig').mockResolvedValue(true);
    vi.spyOn(NacosInstanceConfigManager.prototype, 'getInstance').mockResolvedValue(instance as never);

    activate(extensionContext());

    const item = new ConfigTreeItem('config', instance as never, 'dev', configSummary);
    const handler = fixtureCommands.__getRegisteredCommands().get('atNacos.publishConfig');
    expect(handler).toBeDefined();

    await handler?.(item as never);
    expect(publishSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        instance: expect.objectContaining({ id: 'inst-1' }),
        ref: configSummary
      })
    );
  });

  it('invokes deleteConfig when atNacos.deleteConfig is executed', async () => {
    const deleteSpy = vi.spyOn(deleteModule, 'deleteConfig').mockResolvedValue(true);
    vi.spyOn(NacosInstanceConfigManager.prototype, 'getInstance').mockResolvedValue(instance as never);

    activate(extensionContext());

    const item = new ConfigTreeItem('config', instance as never, 'dev', configSummary);
    const handler = fixtureCommands.__getRegisteredCommands().get('atNacos.deleteConfig');
    expect(handler).toBeDefined();

    await handler?.(item as never);
    expect(deleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        instance: expect.objectContaining({ id: 'inst-1' }),
        ref: configSummary
      })
    );
  });

  it('invokes toggleServiceInstanceEnabled when enable/disable commands are executed', async () => {
    const toggleSpy = vi.spyOn(updateHealthModule, 'toggleServiceInstanceEnabled').mockResolvedValue(true);
    vi.spyOn(NacosInstanceConfigManager.prototype, 'getInstance').mockResolvedValue(instance as never);

    activate(extensionContext());

    const item = new ServiceInstanceTreeItem('service', instance as never, serviceRef, serviceInstance);
    const enableHandler = fixtureCommands.__getRegisteredCommands().get('atNacos.enableServiceInstance');
    const disableHandler = fixtureCommands.__getRegisteredCommands().get('atNacos.disableServiceInstance');

    expect(enableHandler).toBeDefined();
    expect(disableHandler).toBeDefined();

    await enableHandler?.(item as never);
    expect(toggleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        instance: expect.objectContaining({ id: 'inst-1' }),
        serviceRef,
        serviceInstance,
        enabled: true
      })
    );

    await disableHandler?.(item as never);
    expect(toggleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        instance: expect.objectContaining({ id: 'inst-1' }),
        serviceRef,
        serviceInstance,
        enabled: false
      })
    );
  });

  it('triggers publishConfig when a dirty draft document is saved', async () => {
    const publishSpy = vi.spyOn(publishModule, 'publishConfig').mockResolvedValue(true);
    vi.spyOn(NacosInstanceConfigManager.prototype, 'getInstance').mockResolvedValue(instance as never);

    activate(extensionContext());

    const draftProvider = fixtureWorkspace
      .__getFileSystemProviders()
      .find((p) => p.scheme === 'nacos-draft')?.provider as unknown as {
        initDraft: (instId: string, ref: unknown, detail: unknown) => vscode.Uri;
        writeFile: (uri: vscode.Uri, content: Uint8Array, options: unknown) => void;
      };
    expect(draftProvider).toBeDefined();

    const uri = draftProvider.initDraft('inst-1', configSummary, {
      ...configSummary,
      content: 'original: true'
    });

    // Make the draft dirty
    draftProvider.writeFile(uri, Buffer.from('modified: true'), { create: false, overwrite: true });

    // Fire save document event
    fixtureWorkspace.__fireDidSaveTextDocument({ uri } as vscode.TextDocument);

    // Wait a tick for async handler
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(publishSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        instance: expect.objectContaining({ id: 'inst-1' }),
        ref: expect.objectContaining({
          dataId: 'app.yaml',
          group: 'DEFAULT_GROUP',
          namespaceId: 'dev'
        })
      })
    );
  });

  it('does not trigger publishConfig when a clean draft document is saved', async () => {
    const publishSpy = vi.spyOn(publishModule, 'publishConfig').mockResolvedValue(true);
    vi.spyOn(NacosInstanceConfigManager.prototype, 'getInstance').mockResolvedValue(instance as never);

    activate(extensionContext());

    const draftProvider = fixtureWorkspace
      .__getFileSystemProviders()
      .find((p) => p.scheme === 'nacos-draft')?.provider as unknown as {
        initDraft: (instId: string, ref: unknown, detail: unknown) => vscode.Uri;
      };

    const uri = draftProvider.initDraft('inst-1', configSummary, {
      ...configSummary,
      content: 'original: true'
    });

    // Fire save without modifying content
    fixtureWorkspace.__fireDidSaveTextDocument({ uri } as vscode.TextDocument);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('cleans up draft entry when a clean draft document is closed', async () => {
    activate(extensionContext());

    const draftProvider = fixtureWorkspace
      .__getFileSystemProviders()
      .find((p) => p.scheme === 'nacos-draft')?.provider as unknown as {
        initDraft: (instId: string, ref: unknown, detail: unknown) => vscode.Uri;
        getDraft: (uri: vscode.Uri) => unknown;
      };

    const uri = draftProvider.initDraft('inst-1', configSummary, {
      ...configSummary,
      content: 'original: true'
    });

    expect(draftProvider.getDraft(uri)).toBeDefined();

    fixtureWorkspace.__fireDidCloseTextDocument({ uri } as vscode.TextDocument);

    expect(draftProvider.getDraft(uri)).toBeUndefined();
  });

  /**
   * A write that just succeeded is proof the cached client works -- the server
   * accepted its JWT and answered its probed endpoints a moment ago -- so the
   * refresh a write triggers must not throw the pool away, and must redraw
   * only the tree the write changed. Only the explicit Refresh buttons clear
   * the pool: those are the user's "start over" after something changed
   * behind the extension's back.
   */
  describe('client pool survival across writes', () => {
    /** One change listener per tree, in view order: configs first, services second. */
    function observeTreeChanges() {
      const [configChanged, serviceChanged] = fixtureWindow.__getTreeViews().map((view) => {
        const listener = vi.fn();
        (view.treeDataProvider as vscode.TreeDataProvider<unknown>).onDidChangeTreeData?.(listener);
        return listener;
      });
      return { configChanged, serviceChanged };
    }

    it('keeps the pool and redraws only the config tree when a publish lands', async () => {
      const clearSpy = vi.spyOn(NacosClientPool.prototype, 'clear');
      vi.spyOn(publishModule, 'publishConfig').mockImplementation(async (options) => {
        options.onPublished?.();
        return true;
      });
      vi.spyOn(NacosInstanceConfigManager.prototype, 'getInstance').mockResolvedValue(instance as never);

      activate(extensionContext());
      const { configChanged, serviceChanged } = observeTreeChanges();

      const item = new ConfigTreeItem('config', instance as never, 'dev', configSummary);
      await fixtureCommands.__getRegisteredCommands().get('atNacos.publishConfig')?.(item as never);

      expect(clearSpy).not.toHaveBeenCalled();
      expect(configChanged).toHaveBeenCalledTimes(1);
      // A publish changed configuration data only; redrawing the service tree
      // would drop its caches for a change it cannot be showing.
      expect(serviceChanged).not.toHaveBeenCalled();
    });

    it('keeps the pool and redraws only the config tree when a delete lands', async () => {
      const clearSpy = vi.spyOn(NacosClientPool.prototype, 'clear');
      vi.spyOn(deleteModule, 'deleteConfig').mockImplementation(async (options) => {
        options.onDeleted?.();
        return true;
      });
      vi.spyOn(NacosInstanceConfigManager.prototype, 'getInstance').mockResolvedValue(instance as never);

      activate(extensionContext());
      const { configChanged, serviceChanged } = observeTreeChanges();

      const item = new ConfigTreeItem('config', instance as never, 'dev', configSummary);
      await fixtureCommands.__getRegisteredCommands().get('atNacos.deleteConfig')?.(item as never);

      expect(clearSpy).not.toHaveBeenCalled();
      expect(configChanged).toHaveBeenCalledTimes(1);
      expect(serviceChanged).not.toHaveBeenCalled();
    });

    it('keeps the pool and redraws only the config tree when a rollback lands', async () => {
      const clearSpy = vi.spyOn(NacosClientPool.prototype, 'clear');
      // The rollback callback lives inside the options the history panel is
      // opened with, so the panel is mocked and the callback invoked directly
      // -- the same seam ConfigInspectionCommands.test.ts reaches diffs by.
      const open = vi.spyOn(ConfigHistoryPanel, 'open').mockResolvedValue();
      vi.spyOn(rollbackModule, 'rollbackConfig').mockImplementation(async (options) => {
        options.onRollback?.();
        return true;
      });
      vi.spyOn(NacosInstanceConfigManager.prototype, 'getInstance').mockResolvedValue(instance as never);

      activate(extensionContext());
      const { configChanged, serviceChanged } = observeTreeChanges();

      const item = new ConfigTreeItem('config', instance as never, 'dev', configSummary);
      await fixtureCommands.__getRegisteredCommands().get('atNacos.showConfigHistory')?.(item as never);
      await open.mock.calls[0]?.[1]?.rollback?.({ id: '1044', opType: 'U' } as never);

      expect(clearSpy).not.toHaveBeenCalled();
      expect(configChanged).toHaveBeenCalledTimes(1);
      expect(serviceChanged).not.toHaveBeenCalled();
    });

    it.each([
      ['atNacos.enableServiceInstance'],
      ['atNacos.disableServiceInstance']
    ])('keeps the pool and redraws only the service tree for %s', async (command) => {
      const clearSpy = vi.spyOn(NacosClientPool.prototype, 'clear');
      vi.spyOn(updateHealthModule, 'toggleServiceInstanceEnabled').mockImplementation(async (options) => {
        options.onUpdated?.();
        return true;
      });
      vi.spyOn(NacosInstanceConfigManager.prototype, 'getInstance').mockResolvedValue(instance as never);

      activate(extensionContext());
      const { configChanged, serviceChanged } = observeTreeChanges();

      const item = new ServiceInstanceTreeItem('service', instance as never, serviceRef, serviceInstance);
      await fixtureCommands.__getRegisteredCommands().get(command)?.(item as never);

      expect(clearSpy).not.toHaveBeenCalled();
      expect(serviceChanged).toHaveBeenCalledTimes(1);
      expect(configChanged).not.toHaveBeenCalled();
    });

    it.each([
      ['atNacos.refreshConfigs'],
      ['atNacos.refreshServices']
    ])('still clears the pool for the explicit %s command', async (command) => {
      const clearSpy = vi.spyOn(NacosClientPool.prototype, 'clear');
      activate(extensionContext());

      await fixtureCommands.__getRegisteredCommands().get(command)?.();

      expect(clearSpy).toHaveBeenCalledTimes(1);
    });
  });
});

