import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from '../../src/extension';
import { NacosInstanceFormPanel } from '../../src/webview/NacosInstanceFormPanel';
import { commands as fixtureCommands, window as fixtureWindow } from '../../test-fixtures/vscode';
import { startTestHttpsServer, type TestHttpsServer } from '../nacos/testHttpServer';
import { extensionContext, INSTANCES_KEY, storedInstance } from './extensionContext';

function run(command: string): Promise<unknown> {
  const handler = fixtureCommands.__getRegisteredCommands().get(command);
  expect(handler, command).toBeDefined();
  return Promise.resolve(handler?.());
}

/** What the second quick pick offers, resolved the way the extension resolves it. */
const EDIT = 'Edit';
const DELETE = 'Delete';

/**
 * Takes the first instance offered, then answers the Edit/Delete pick with
 * `action`. One implementation covers both picks because the command shows
 * them in sequence and a single spy sees both.
 */
function answerQuickPicks(action: string) {
  // `as never`: `showQuickPick` is four overloads deep, and TypeScript matches
  // a mock implementation against the last of them. The same cast the sibling
  // tests use for `mockResolvedValue`.
  const answer = async (items: readonly unknown[] | Thenable<readonly unknown[]>): Promise<unknown> => {
    const offered = await items;
    return offered[0] === EDIT ? action : offered[0];
  };
  return vi.spyOn(vscode.window, 'showQuickPick').mockImplementation(answer as never);
}

let httpsServer: TestHttpsServer | undefined;

describe('atNacos instance commands', () => {
  beforeEach(async () => {
    await deactivate();
    fixtureCommands.__clearRegisteredCommands();
    fixtureWindow.__clearTreeViews();
    fixtureWindow.__clearLogChannels();
  });

  afterEach(async () => {
    await deactivate();
    await httpsServer?.close();
    httpsServer = undefined;
    vi.restoreAllMocks();
  });

  it('opens the instance form for atNacos.addInstance', async () => {
    const createWebviewPanel = vi.spyOn(vscode.window, 'createWebviewPanel');
    activate(extensionContext());

    await expect(run('atNacos.addInstance')).resolves.toBeUndefined();

    expect(createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(createWebviewPanel.mock.calls[0]?.[1]).toBe('Add Nacos Instance');
  });

  it('reports a form that could not be opened instead of rejecting', async () => {
    // An unhandled rejection out of a command handler surfaces to the user as
    // nothing at all: the palette entry appears to do nothing.
    const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage');
    vi.spyOn(vscode.window, 'createWebviewPanel').mockImplementation(() => {
      throw new Error('no editor group available');
    });
    activate(extensionContext());

    await expect(run('atNacos.addInstance')).resolves.toBeUndefined();

    expect(showErrorMessage).toHaveBeenCalledWith(
      'Could not open the Nacos instance form: no editor group available'
    );
  });

  it('offers to add the first instance when none are configured', async () => {
    const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage');
    activate(extensionContext());

    await run('atNacos.manageInstances');

    expect(showInformationMessage).toHaveBeenCalledWith('No Nacos instances configured yet.', 'Add Instance');
  });

  it('opens the form when that offer is accepted', async () => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Add Instance' as never);
    const createWebviewPanel = vi.spyOn(vscode.window, 'createWebviewPanel');
    activate(extensionContext());

    await run('atNacos.manageInstances');

    expect(createWebviewPanel).toHaveBeenCalledTimes(1);
  });

  it('lists the configured instances by label and address', async () => {
    const showQuickPick = vi.spyOn(vscode.window, 'showQuickPick');
    activate(extensionContext({ [INSTANCES_KEY]: [storedInstance()] }));

    await run('atNacos.manageInstances');

    expect(showQuickPick).toHaveBeenCalledTimes(1);
    expect(showQuickPick.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ label: 'prod', description: 'http://nacos.example.com:8848/nacos' })
    ]);
    expect(showQuickPick.mock.calls[0]?.[1]).toMatchObject({
      placeHolder: 'Select a Nacos instance to edit or delete'
    });
  });

  /** The quick pick shows the stored address, and an address is not a place to keep a password. */
  it('shows no credential in the pick description of an instance stored with one in its address', async () => {
    const showQuickPick = vi.spyOn(vscode.window, 'showQuickPick');
    activate(
      extensionContext({
        [INSTANCES_KEY]: [storedInstance({ serverUrl: 'http://admin:hunter2@nacos.example.com:8848/nacos' })]
      })
    );

    await run('atNacos.manageInstances');

    expect(showQuickPick.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ description: 'http://nacos.example.com:8848/nacos' })
    ]);
  });

  it('does nothing when the instance pick is dismissed', async () => {
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined);
    const createWebviewPanel = vi.spyOn(vscode.window, 'createWebviewPanel');
    activate(extensionContext({ [INSTANCES_KEY]: [storedInstance()] }));

    await run('atNacos.manageInstances');

    expect(createWebviewPanel).not.toHaveBeenCalled();
  });

  it('opens the form on the picked instance for Edit', async () => {
    answerQuickPicks(EDIT);
    const createWebviewPanel = vi.spyOn(vscode.window, 'createWebviewPanel');
    activate(extensionContext({ [INSTANCES_KEY]: [storedInstance()] }));

    await run('atNacos.manageInstances');

    // The title is the one thing that proves the existing instance was passed
    // through: the form renders "Edit ..." only for an instance it was given.
    expect(createWebviewPanel.mock.calls[0]?.[1]).toBe('Edit Nacos Instance: prod');
  });

  it('deletes the picked instance once the modal is confirmed', async () => {
    answerQuickPicks(DELETE);
    const showWarningMessage = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(DELETE as never);
    const context = extensionContext({ [INSTANCES_KEY]: [storedInstance()] });
    activate(context);

    await run('atNacos.manageInstances');

    expect(showWarningMessage).toHaveBeenCalledWith('Delete Nacos instance "prod"?', { modal: true }, DELETE);
    expect(context.globalState.get(INSTANCES_KEY, [])).toEqual([]);
  });

  it('keeps the instance when the delete modal is dismissed', async () => {
    answerQuickPicks(DELETE);
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    const context = extensionContext({ [INSTANCES_KEY]: [storedInstance()] });
    activate(context);

    await run('atNacos.manageInstances');

    expect(context.globalState.get<unknown[]>(INSTANCES_KEY, [])).toHaveLength(1);
  });

  it('redraws both trees after a delete', async () => {
    answerQuickPicks(DELETE);
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(DELETE as never);
    activate(extensionContext({ [INSTANCES_KEY]: [storedInstance()] }));
    const changed = fixtureWindow.__getTreeViews().map((view) => {
      const listener = vi.fn();
      (view.treeDataProvider as vscode.TreeDataProvider<unknown>).onDidChangeTreeData?.(listener);
      return listener;
    });

    await run('atNacos.manageInstances');

    // An instance is a root node in both views, so redrawing only one would
    // leave the other listing a server that no longer exists.
    expect(changed.map((listener) => listener.mock.calls.length)).toEqual([1, 1]);
  });

  it('hands the form a connection test that can prompt for an untrusted certificate', async () => {
    // The form's own default probe builds a client with no certificate
    // verifier, so without this seam Test Connection would report a TLS
    // failure for the same server the tree is able to prompt for and reach.
    httpsServer = await startTestHttpsServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ code: 0, data: { version: '3.0.1', startup_mode: 'standalone' } }));
    });
    const showWarningMessage = vi
      .spyOn(vscode.window, 'showWarningMessage')
      .mockResolvedValue('Trust Certificate' as never);
    const open = vi.spyOn(NacosInstanceFormPanel, 'open').mockResolvedValue();
    activate(extensionContext());
    await run('atNacos.addInstance');

    const result = await open.mock.calls[0]?.[4]?.testConnection?.({
      serverUrl: httpsServer.origin,
      authMode: 'none'
    });

    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, version: '3.0.1' });
  });

  it('reports a damaged stored record instead of rejecting', async () => {
    // `listInstances` throws rather than dropping a record it cannot parse, so
    // this is reachable from a real profile, not just from a test.
    const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage');
    activate(extensionContext({ [INSTANCES_KEY]: [{ label: 'no id or url' }] }));

    await expect(run('atNacos.manageInstances')).resolves.toBeUndefined();

    expect(showErrorMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(showErrorMessage).mock.calls[0]?.[0]).toMatch(/^Could not manage Nacos instances: /);
  });
});
