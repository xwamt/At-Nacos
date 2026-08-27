import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { NacosInstanceConfig } from '../../src/config/schema';
import { activate, deactivate } from '../../src/extension';
import { InstanceTreeItem } from '../../src/tree/NacosTreeItems';
import { ClusterStatusPanel } from '../../src/webview/ClusterStatusPanel';
import { commands as fixtureCommands, window as fixtureWindow } from '../../test-fixtures/vscode';
import { startTestHttpServer, type TestHttpServer } from '../nacos/testHttpServer';
import { extensionContext, INSTANCES_KEY, storedInstance } from './extensionContext';

function run(command: string, ...args: unknown[]): Promise<unknown> {
  const handler = fixtureCommands.__getRegisteredCommands().get(command);
  expect(handler, command).toBeDefined();
  return Promise.resolve(handler?.(...(args as never[])));
}

/** The tree node the instance context menu hands over. */
function instanceNode(overrides: Record<string, unknown> = {}): InstanceTreeItem {
  return new InstanceTreeItem('config', storedInstance(overrides) as unknown as NacosInstanceConfig);
}

/** What `ClusterStatusPanel.open` was asked to show. */
function openedWith(open: ReturnType<typeof spyOnOpen>): { id: string; label: string } | undefined {
  return open.mock.calls[0]?.[1]?.instance;
}

function spyOnOpen() {
  return vi.spyOn(ClusterStatusPanel, 'open').mockResolvedValue();
}

let server: TestHttpServer | undefined;

describe('atNacos.openClusterStatus', () => {
  beforeEach(async () => {
    await deactivate();
    fixtureCommands.__clearRegisteredCommands();
    fixtureWindow.__clearTreeViews();
    fixtureWindow.__clearLogChannels();
  });

  afterEach(async () => {
    await deactivate();
    await server?.close();
    server = undefined;
    vi.restoreAllMocks();
  });

  it('opens the panel for the only instance configured, without asking which', async () => {
    const open = spyOnOpen();
    const showQuickPick = vi.spyOn(vscode.window, 'showQuickPick');
    activate(extensionContext({ [INSTANCES_KEY]: [storedInstance()] }));

    await run('atNacos.openClusterStatus');

    expect(open).toHaveBeenCalledTimes(1);
    expect(openedWith(open)).toMatchObject({ id: 'instance-1', label: 'prod' });
    expect(showQuickPick).not.toHaveBeenCalled();
  });

  it('asks which instance when more than one is configured', async () => {
    const open = spyOnOpen();
    const showQuickPick = vi
      .spyOn(vscode.window, 'showQuickPick')
      .mockImplementation((async (items: readonly unknown[] | Thenable<readonly unknown[]>) =>
        (await items)[1]) as never);
    activate(
      extensionContext({
        [INSTANCES_KEY]: [storedInstance(), storedInstance({ id: 'instance-2', label: 'uat' })]
      })
    );

    await run('atNacos.openClusterStatus');

    expect(showQuickPick.mock.calls[0]?.[1]).toMatchObject({
      placeHolder: 'Select a Nacos instance to show the cluster status of'
    });
    expect(openedWith(open)).toMatchObject({ id: 'instance-2', label: 'uat' });
  });

  it('opens the panel for the node it was invoked on, without asking which', async () => {
    const open = spyOnOpen();
    const showQuickPick = vi.spyOn(vscode.window, 'showQuickPick');
    activate(
      extensionContext({
        // Two instances, so a handler that fell back to the pick would show.
        [INSTANCES_KEY]: [storedInstance(), storedInstance({ id: 'instance-2', label: 'uat' })]
      })
    );

    await run('atNacos.openClusterStatus', instanceNode({ id: 'instance-2', label: 'uat' }));

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(openedWith(open)).toMatchObject({ id: 'instance-2', label: 'uat' });
  });

  it('opens the panel on the stored record rather than the copy a stale node still holds', async () => {
    const open = spyOnOpen();
    activate(extensionContext({ [INSTANCES_KEY]: [storedInstance()] }));

    await run('atNacos.openClusterStatus', instanceNode({ label: 'renamed since the tree drew' }));

    expect(openedWith(open)).toMatchObject({ id: 'instance-1', label: 'prod' });
  });

  /** A node outlives the record behind it: deleted elsewhere, it still sits in the tree until a refresh. */
  it('opens nothing for a node whose instance is no longer configured', async () => {
    const open = spyOnOpen();
    activate(extensionContext());

    await run('atNacos.openClusterStatus', instanceNode());

    expect(open).not.toHaveBeenCalled();
  });

  it('opens nothing when that pick is dismissed', async () => {
    const open = spyOnOpen();
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined);
    activate(
      extensionContext({
        [INSTANCES_KEY]: [storedInstance(), storedInstance({ id: 'instance-2', label: 'uat' })]
      })
    );

    await run('atNacos.openClusterStatus');

    expect(open).not.toHaveBeenCalled();
  });

  /** The view title carries this button before there is anything to point it at. */
  it('offers to add the first instance when none is configured', async () => {
    const open = spyOnOpen();
    const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage');
    activate(extensionContext());

    await run('atNacos.openClusterStatus');

    expect(showInformationMessage).toHaveBeenCalledWith('No Nacos instances configured yet.', 'Add Instance');
    expect(open).not.toHaveBeenCalled();
  });

  /**
   * The panel reaches its server through this closure and nothing else, so a
   * closure built over the wrong instance is a panel showing the wrong
   * cluster -- and every assertion above would still pass.
   */
  it('hands the panel a connection to the address that instance was saved with', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ code: 0, data: { version: '2.3.2', startup_mode: 'standalone' } }));
    });
    const open = spyOnOpen();
    activate(extensionContext({ [INSTANCES_KEY]: [storedInstance({ serverUrl: server.origin })] }));
    await run('atNacos.openClusterStatus');

    const client = await open.mock.calls[0]?.[1]?.connect();

    expect(typeof client?.listClusterNodes).toBe('function');
    expect(server.requests.length).toBeGreaterThan(0);
  });

  it('reports a panel it could not open instead of failing silently', async () => {
    const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage');
    vi.spyOn(ClusterStatusPanel, 'open').mockRejectedValue(new Error('no editor group available'));
    activate(extensionContext({ [INSTANCES_KEY]: [storedInstance()] }));

    await expect(run('atNacos.openClusterStatus')).resolves.toBeUndefined();

    expect(showErrorMessage).toHaveBeenCalledWith(
      'Could not open the cluster status panel: no editor group available'
    );
    const logged = fixtureWindow.__getLogChannels()[0]?.lines.map((line) => line.message).join('\n');
    expect(logged).toContain('openClusterStatus');
  });

  /** `listInstances` throws on a record it cannot parse, before any panel exists. */
  it('reports a damaged stored record instead of rejecting', async () => {
    const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage');
    activate(extensionContext({ [INSTANCES_KEY]: [{ label: 'no id or url' }] }));

    await expect(run('atNacos.openClusterStatus')).resolves.toBeUndefined();

    expect(vi.mocked(showErrorMessage).mock.calls[0]?.[0]).toMatch(/^Could not open the cluster status panel: /);
  });
});
