import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { NacosInstanceConfig } from '../../src/config/schema';
import { buildConfigHistoryUri, buildConfigUri } from '../../src/document/configUri';
import { activate, deactivate } from '../../src/extension';
import { ConfigTreeItem, ServiceTreeItem } from '../../src/tree/NacosTreeItems';
import { ConfigHistoryPanel } from '../../src/webview/ConfigHistoryPanel';
import { ConfigListenersPanel } from '../../src/webview/ConfigListenersPanel';
import { ServiceSubscribersPanel } from '../../src/webview/ServiceSubscribersPanel';
import { commands as fixtureCommands, window as fixtureWindow } from '../../test-fixtures/vscode';
import { startTestHttpServer, type TestHttpServer } from '../nacos/testHttpServer';
import { extensionContext, INSTANCES_KEY, storedInstance } from './extensionContext';

let server: TestHttpServer | undefined;

function run(command: string, ...args: unknown[]): Promise<unknown> {
  const handler = fixtureCommands.__getRegisteredCommands().get(command);
  expect(handler, command).toBeDefined();
  return Promise.resolve(handler?.(...(args as never[])));
}

function instance(overrides: Partial<NacosInstanceConfig> = {}): NacosInstanceConfig {
  return {
    id: 'instance-1',
    label: 'prod',
    serverUrl: server?.origin ?? 'http://nacos.example.com:8848/nacos',
    authMode: 'none',
    readOnly: false,
    allowBackgroundAccess: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  };
}

/** The node a right-click hands the command, exactly as the tree builds it. */
function configNode(): ConfigTreeItem {
  return new ConfigTreeItem('config', instance(), 'cl-parent', {
    namespaceId: 'cl-parent',
    group: 'cl-intimfy',
    dataId: 'application-dev.yml',
    type: 'yaml'
  });
}

function serviceNode(): ServiceTreeItem {
  return new ServiceTreeItem('service', instance(), 'cl-parent-offline', {
    namespaceId: 'cl-parent-offline',
    group: 'cl-intimfy',
    serviceName: 'cl-auth-offline'
  });
}

const CONFIG_REF = { namespaceId: 'cl-parent', group: 'cl-intimfy', dataId: 'application-dev.yml' };

/**
 * A Nacos 2.3.2 in miniature: enough of it for a command to build a client,
 * probe the version and reach one endpoint. Routing on the path rather than
 * answering everything alike, because which endpoint was reached is half of
 * what these tests are about.
 */
interface FakeNacos {
  history?: unknown[];
  namespaces?: unknown[];
  /** Absent means the config does not exist: HTTP 200 with an empty body, as a real 2.3.2 answers. */
  config?: unknown;
}

async function startNacos(options: FakeNacos = {}): Promise<TestHttpServer> {
  return startTestHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const url = request.url ?? '';
    response.setHeader('content-type', 'application/json');
    if (url.includes('/cs/history')) {
      const pageItems = options.history ?? [];
      response.end(JSON.stringify({ totalCount: pageItems.length, pageNumber: 1, pagesAvailable: 1, pageItems }));
      return;
    }
    if (url.includes('namespace')) {
      response.end(JSON.stringify({ code: 200, data: options.namespaces ?? [] }));
      return;
    }
    if (url.includes('/cs/configs')) {
      response.end(options.config === undefined ? '' : JSON.stringify(options.config));
      return;
    }
    response.end(JSON.stringify({ code: 0, data: { version: '2.3.2', startup_mode: 'standalone' } }));
  });
}

function historyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1044,
    lastId: -1,
    dataId: 'application-dev.yml',
    group: 'cl-intimfy',
    tenant: 'cl-parent',
    appName: '',
    // Trailing space and ISO string, exactly as `ConfigHistoryInfo` serializes them.
    opType: 'U ',
    srcIp: '192.168.66.9',
    srcUser: 'nacos',
    createdTime: '2026-08-14T02:03:04.000+08:00',
    lastModifiedTime: '2026-08-14T02:03:04.000+08:00',
    ...overrides
  };
}

function diffCall(executeCommand: ReturnType<typeof spyOnExecuteCommand>): unknown[] | undefined {
  return executeCommand.mock.calls.find((call) => call[0] === 'vscode.diff');
}

function spyOnExecuteCommand() {
  return vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
}

function loggedLines(): string {
  return (fixtureWindow.__getLogChannels()[0]?.lines ?? []).map((line) => line.message).join('\n');
}

describe('the configuration and service inspection commands', () => {
  beforeEach(async () => {
    await deactivate();
    fixtureCommands.__clearRegisteredCommands();
    fixtureWindow.__clearTreeViews();
    fixtureWindow.__clearLogChannels();
    fixtureWindow.__resetDialogs();
  });

  afterEach(async () => {
    await deactivate();
    await server?.close();
    server = undefined;
    vi.restoreAllMocks();
  });

  describe('atNacos.showConfigHistory', () => {
    it('opens the history panel for the configuration the node names', async () => {
      const open = vi.spyOn(ConfigHistoryPanel, 'open').mockResolvedValue();
      activate(extensionContext({ [INSTANCES_KEY]: [storedInstance()] }));

      await run('atNacos.showConfigHistory', configNode());

      expect(open.mock.calls[0]?.[1]).toMatchObject({
        instance: { id: 'instance-1', label: 'prod' },
        ref: CONFIG_REF
      });
    });

    /**
     * The panel reaches its server through this closure and nothing else, and
     * it is built per refresh rather than once -- an instance edited while the
     * panel is open has to take effect on the next Refresh.
     */
    it('hands the panel a connection to the address that instance is saved with', async () => {
      server = await startNacos();
      const open = vi.spyOn(ConfigHistoryPanel, 'open').mockResolvedValue();
      activate(extensionContext({ [INSTANCES_KEY]: [storedInstance({ serverUrl: server.origin })] }));
      await run('atNacos.showConfigHistory', configNode());

      const client = await open.mock.calls[0]?.[1]?.connect();

      expect(typeof client?.listConfigHistory).toBe('function');
      expect(server.requests.length).toBeGreaterThan(0);
    });

    /** Clicking a version in the panel has to reach the native diff editor. */
    it('hands the panel a diff that compares one version with the current content', async () => {
      const executeCommand = spyOnExecuteCommand();
      const open = vi.spyOn(ConfigHistoryPanel, 'open').mockResolvedValue();
      activate(extensionContext({ [INSTANCES_KEY]: [storedInstance()] }));
      await run('atNacos.showConfigHistory', configNode());

      await open.mock.calls[0]?.[1]?.openDiff({ ...CONFIG_REF, id: '1044', opType: 'U' });

      expect(String(diffCall(executeCommand)?.[1])).toBe(
        buildConfigHistoryUri('instance-1', CONFIG_REF, '1044').toString()
      );
      expect(String(diffCall(executeCommand)?.[2])).toBe(buildConfigUri('instance-1', CONFIG_REF).toString());
    });

    it('says the instance is gone when it was deleted while the panel stayed open', async () => {
      const open = vi.spyOn(ConfigHistoryPanel, 'open').mockResolvedValue();
      activate(extensionContext());
      await run('atNacos.showConfigHistory', configNode());

      await expect(open.mock.calls[0]?.[1]?.connect()).rejects.toThrow(/no longer configured/);
    });

    it('reports a panel it could not open instead of failing silently', async () => {
      const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage');
      vi.spyOn(ConfigHistoryPanel, 'open').mockRejectedValue(new Error('no editor group available'));
      activate(extensionContext({ [INSTANCES_KEY]: [storedInstance()] }));

      await expect(run('atNacos.showConfigHistory', configNode())).resolves.toBeUndefined();

      expect(vi.mocked(showErrorMessage).mock.calls[0]?.[0]).toContain('no editor group available');
      expect(loggedLines()).toContain('showConfigHistory');
    });
  });

  describe('atNacos.diffWithPrevious', () => {
    it('diffs the current content against the most recent version on the server', async () => {
      server = await startNacos({ history: [historyRow()] });
      const executeCommand = spyOnExecuteCommand();
      activate(extensionContext({ [INSTANCES_KEY]: [storedInstance({ serverUrl: server.origin })] }));

      await run('atNacos.diffWithPrevious', configNode());

      expect(String(diffCall(executeCommand)?.[1])).toBe(
        buildConfigHistoryUri('instance-1', CONFIG_REF, '1044').toString()
      );
      expect(String(diffCall(executeCommand)?.[2])).toBe(buildConfigUri('instance-1', CONFIG_REF).toString());
    });

    /**
     * The state of every configuration on the server this milestone was
     * verified against. A diff with an empty left-hand pane would read as a
     * configuration created from nothing a moment ago.
     */
    it('says there is no earlier version rather than opening an empty diff', async () => {
      server = await startNacos({ history: [] });
      const executeCommand = spyOnExecuteCommand();
      const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage');
      activate(extensionContext({ [INSTANCES_KEY]: [storedInstance({ serverUrl: server.origin })] }));

      await run('atNacos.diffWithPrevious', configNode());

      expect(diffCall(executeCommand)).toBeUndefined();
      expect(String(vi.mocked(showInformationMessage).mock.calls[0]?.[0])).toContain('application-dev.yml');
    });

    it('reports a history read that failed instead of failing silently', async () => {
      const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage');
      activate(
        extensionContext({ [INSTANCES_KEY]: [storedInstance({ serverUrl: 'http://127.0.0.1:1/nacos' })] })
      );

      await expect(run('atNacos.diffWithPrevious', configNode())).resolves.toBeUndefined();

      expect(showErrorMessage).toHaveBeenCalled();
      expect(loggedLines()).toContain('diffWithPrevious');
    });
  });

  describe('atNacos.compareAcrossEnvironments', () => {
    const namespaces = [
      { namespace: 'cl-parent', namespaceShowName: 'cl-parent', type: 2 },
      { namespace: 'cl-parent-offline', namespaceShowName: 'cl-parent-offline', type: 2 }
    ];

    it('diffs the configuration against the namespace that was picked', async () => {
      server = await startNacos({
        namespaces,
        config: { dataId: 'application-dev.yml', group: 'cl-intimfy', tenant: 'cl-parent-offline', content: 'a: 2\n' }
      });
      const executeCommand = spyOnExecuteCommand();
      vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (
        items: readonly unknown[] | Thenable<readonly unknown[]>
      ) => (await items)[0]) as never);
      activate(extensionContext({ [INSTANCES_KEY]: [storedInstance({ serverUrl: server.origin })] }));

      await run('atNacos.compareAcrossEnvironments', configNode());

      expect(String(diffCall(executeCommand)?.[1])).toBe(buildConfigUri('instance-1', CONFIG_REF).toString());
      expect(String(diffCall(executeCommand)?.[2])).toBe(
        buildConfigUri('instance-1', { ...CONFIG_REF, namespaceId: 'cl-parent-offline' }).toString()
      );
    });

    /**
     * A configuration that exists in one environment and not in the other is
     * the interesting answer, not an error -- and an empty right-hand pane
     * would look like an empty configuration.
     */
    it('says the target namespace has no such configuration', async () => {
      server = await startNacos({ namespaces });
      const executeCommand = spyOnExecuteCommand();
      const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage');
      vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (
        items: readonly unknown[] | Thenable<readonly unknown[]>
      ) => (await items)[0]) as never);
      activate(extensionContext({ [INSTANCES_KEY]: [storedInstance({ serverUrl: server.origin })] }));

      await run('atNacos.compareAcrossEnvironments', configNode());

      expect(diffCall(executeCommand)).toBeUndefined();
      const message = String(vi.mocked(showInformationMessage).mock.calls[0]?.[0]);
      expect(message).toContain('application-dev.yml');
      expect(message).toContain('cl-parent-offline');
    });

    it('reports a comparison that failed instead of failing silently', async () => {
      const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage');
      activate(
        extensionContext({ [INSTANCES_KEY]: [storedInstance({ serverUrl: 'http://127.0.0.1:1/nacos' })] })
      );

      await expect(run('atNacos.compareAcrossEnvironments', configNode())).resolves.toBeUndefined();

      expect(showErrorMessage).toHaveBeenCalled();
      expect(loggedLines()).toContain('compareAcrossEnvironments');
    });
  });

  describe('atNacos.showConfigListeners', () => {
    it('opens the listener panel for the configuration the node names', async () => {
      const open = vi.spyOn(ConfigListenersPanel, 'open').mockResolvedValue();
      activate(extensionContext({ [INSTANCES_KEY]: [storedInstance()] }));

      await run('atNacos.showConfigListeners', configNode());

      expect(open.mock.calls[0]?.[1]).toMatchObject({
        instance: { id: 'instance-1', label: 'prod' },
        ref: CONFIG_REF
      });
    });

    it('hands the panel a connection that can read both the listeners and the configuration', async () => {
      server = await startNacos();
      const open = vi.spyOn(ConfigListenersPanel, 'open').mockResolvedValue();
      activate(extensionContext({ [INSTANCES_KEY]: [storedInstance({ serverUrl: server.origin })] }));
      await run('atNacos.showConfigListeners', configNode());

      const client = await open.mock.calls[0]?.[1]?.connect();

      expect(typeof client?.listConfigListeners).toBe('function');
      expect(typeof client?.getConfig).toBe('function');
    });

    it('reports a panel it could not open instead of failing silently', async () => {
      const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage');
      vi.spyOn(ConfigListenersPanel, 'open').mockRejectedValue(new Error('no editor group available'));
      activate(extensionContext({ [INSTANCES_KEY]: [storedInstance()] }));

      await expect(run('atNacos.showConfigListeners', configNode())).resolves.toBeUndefined();

      expect(showErrorMessage).toHaveBeenCalled();
      expect(loggedLines()).toContain('showConfigListeners');
    });
  });

  describe('atNacos.showServiceSubscribers', () => {
    it('opens the subscriber panel for the service the node names', async () => {
      const open = vi.spyOn(ServiceSubscribersPanel, 'open').mockResolvedValue();
      activate(extensionContext({ [INSTANCES_KEY]: [storedInstance()] }));

      await run('atNacos.showServiceSubscribers', serviceNode());

      expect(open.mock.calls[0]?.[1]).toMatchObject({
        instance: { id: 'instance-1', label: 'prod' },
        ref: { namespaceId: 'cl-parent-offline', group: 'cl-intimfy', serviceName: 'cl-auth-offline' }
      });
    });

    it('hands the panel a connection to the address that instance is saved with', async () => {
      server = await startNacos();
      const open = vi.spyOn(ServiceSubscribersPanel, 'open').mockResolvedValue();
      activate(extensionContext({ [INSTANCES_KEY]: [storedInstance({ serverUrl: server.origin })] }));
      await run('atNacos.showServiceSubscribers', serviceNode());

      const client = await open.mock.calls[0]?.[1]?.connect();

      expect(typeof client?.listSubscribers).toBe('function');
    });

    it('reports a panel it could not open instead of failing silently', async () => {
      const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage');
      vi.spyOn(ServiceSubscribersPanel, 'open').mockRejectedValue(new Error('no editor group available'));
      activate(extensionContext({ [INSTANCES_KEY]: [storedInstance()] }));

      await expect(run('atNacos.showServiceSubscribers', serviceNode())).resolves.toBeUndefined();

      expect(showErrorMessage).toHaveBeenCalled();
      expect(loggedLines()).toContain('showServiceSubscribers');
    });
  });
});
