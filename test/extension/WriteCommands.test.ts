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
import * as updateHealthModule from '../../src/write/updateInstanceHealth';
import { NacosInstanceConfigManager } from '../../src/config/NacosInstanceConfigManager';

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
  });

  afterEach(async () => {
    await deactivate();
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
});
