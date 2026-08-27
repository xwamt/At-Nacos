import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import * as vscode from 'vscode';
import { NacosInstanceConfigManager } from '../../src/config/NacosInstanceConfigManager';
import type { ExtensionMemento, SecretStore } from '../../src/config/NacosInstanceConfigManager';
import type { NacosInstanceConfig } from '../../src/config/schema';
import type {
  NacosConnectionTestOptions,
  NacosConnectionTestResult,
  NacosConnectionTestSuccess
} from '../../src/nacos/testNacosConnection';
import {
  handleInstanceFormMessage,
  NacosInstanceFormPanel,
  parseCustomHeaders,
  renderInstanceForm,
  type InstanceFormConfigManager
} from '../../src/webview/NacosInstanceFormPanel';
import { renderWebviewHtml } from '../../src/webview/html';
import { readSavedInstanceFormState } from '../../webview/nacos-instance-form/state';

/**
 * The exact copy the handler sends back. Spelled out here rather than imported
 * so that rewording a message has to be a deliberate edit in two places -- the
 * l10n bundle is keyed on these strings character for character.
 */
const LABEL_REQUIRED = 'Label is required.';
const SERVER_URL_REQUIRED = 'A valid Nacos server URL is required.';
const CONSOLE_URL_INVALID = 'The console URL must start with http:// or https://.';
const USERNAME_REQUIRED = 'A username is required for username and password authentication.';
const PASSWORD_REQUIRED = 'A password is required for username and password authentication.';
const HEADERS_REQUIRED = 'At least one custom header is required for custom header authentication.';
const UNREADABLE_PAYLOAD = 'This form sent a value AT Nacos could not read. Reload the panel and try again.';

const translate = vscode.l10n.t.bind(vscode.l10n);

beforeEach(() => {
  vi.restoreAllMocks();
});

interface PostedMessage {
  type?: string;
  payload?: unknown;
}

interface TestPanel {
  posted: PostedMessage[];
  disposeCount: number;
  dispose(): void;
  webview: { postMessage(message: PostedMessage): Promise<boolean> };
}

function createPanel(): TestPanel {
  const panel: TestPanel = {
    posted: [],
    disposeCount: 0,
    dispose() {
      panel.disposeCount += 1;
    },
    webview: {
      async postMessage(message: PostedMessage) {
        panel.posted.push(message);
        return true;
      }
    }
  };
  return panel;
}

/** The handler only ever touches `dispose` and `webview.postMessage`. */
function asPanel(panel: TestPanel): Parameters<typeof handleInstanceFormMessage>[4] {
  return panel as unknown as Parameters<typeof handleInstanceFormMessage>[4];
}

interface ManagerStub {
  createInstance: Mock;
  updateInstance: Mock;
  getPassword: Mock;
  getCustomHeaders: Mock;
}

function createManager(overrides: Partial<ManagerStub> = {}): ManagerStub {
  return {
    createInstance: vi.fn(async () => existingInstance()),
    updateInstance: vi.fn(async () => existingInstance()),
    getPassword: vi.fn(async () => undefined),
    getCustomHeaders: vi.fn(async () => undefined),
    ...overrides
  };
}

function asManager(manager: ManagerStub): InstanceFormConfigManager {
  return manager as unknown as InstanceFormConfigManager;
}

function existingInstance(overrides: Partial<NacosInstanceConfig> = {}): NacosInstanceConfig {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    label: 'prod',
    serverUrl: 'http://nacos.example.com:8848/nacos',
    authMode: 'none',
    readOnly: false,
    allowBackgroundAccess: false,
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  };
}

/** A complete payload as the page sends it: every field, every time. */
function formPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    label: 'prod',
    serverUrl: 'http://nacos.example.com:8848/nacos',
    consoleUrl: '',
    authMode: 'none',
    username: '',
    password: '',
    customHeaders: '',
    readOnly: false,
    allowBackgroundAccess: false,
    ...overrides
  };
}

function submit(overrides: Record<string, unknown> = {}): unknown {
  return { type: 'submit', payload: formPayload(overrides) };
}

function testConnectionMessage(overrides: Record<string, unknown> = {}): unknown {
  return { type: 'testConnection', payload: formPayload(overrides) };
}

function errorPayload(panel: TestPanel): unknown {
  return panel.posted.find((entry) => entry.type === 'error')?.payload;
}

function testOutcome(panel: TestPanel): { ok?: boolean; message?: string; consoleUrl?: string } {
  const message = panel.posted.find((entry) => entry.type === 'connectionTestResult');
  return (message?.payload ?? {}) as { ok?: boolean; message?: string; consoleUrl?: string };
}

/** Declares the parameter so that `mock.calls[0][0]` is the probe's input rather than `never`. */
function stubProbe(result: NacosConnectionTestResult = successResult()) {
  return vi.fn(async (_options: NacosConnectionTestOptions) => result);
}

function successResult(overrides: Partial<NacosConnectionTestSuccess> = {}): NacosConnectionTestSuccess {
  return {
    ok: true,
    message: 'Connected to Nacos 2.2.3 at http://nacos.example.com:8848/nacos (standalone mode).',
    baseUrl: 'http://nacos.example.com:8848/nacos',
    version: '2.2.3',
    majorVersion: 2,
    startupMode: 'standalone',
    authEnabled: false,
    ...overrides
  };
}

describe('handleInstanceFormMessage: creating an instance', () => {
  it('creates the instance and closes the panel', async () => {
    const manager = createManager();
    const panel = createPanel();
    const onSaved = vi.fn();

    const handled = await handleInstanceFormMessage(submit(), undefined, asManager(manager), onSaved, asPanel(panel));

    expect(handled).toBe(true);
    expect(manager.createInstance).toHaveBeenCalledTimes(1);
    expect(manager.createInstance.mock.calls[0][0]).toMatchObject({
      label: 'prod',
      serverUrl: 'http://nacos.example.com:8848/nacos',
      authMode: 'none'
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(panel.disposeCount).toBe(1);
    expect(panel.posted).toEqual([]);
  });

  it('trims the label and the server URL before they are stored', async () => {
    const manager = createManager();

    await handleInstanceFormMessage(
      submit({ label: '  prod  ', serverUrl: '  http://nacos.example.com:8848/nacos  ' }),
      undefined,
      asManager(manager),
      vi.fn(),
      asPanel(createPanel())
    );

    expect(manager.createInstance.mock.calls[0][0]).toMatchObject({
      label: 'prod',
      serverUrl: 'http://nacos.example.com:8848/nacos'
    });
  });

  it('carries the read-only checkbox into the stored instance', async () => {
    const manager = createManager();

    await handleInstanceFormMessage(
      submit({ readOnly: true }),
      undefined,
      asManager(manager),
      vi.fn(),
      asPanel(createPanel())
    );

    expect(manager.createInstance.mock.calls[0][0]).toMatchObject({ readOnly: true });
  });

  it('carries the background-access checkbox into the stored instance', async () => {
    const manager = createManager();

    await handleInstanceFormMessage(
      submit({ allowBackgroundAccess: true }),
      undefined,
      asManager(manager),
      vi.fn(),
      asPanel(createPanel())
    );

    expect(manager.createInstance.mock.calls[0][0]).toMatchObject({ allowBackgroundAccess: true });
  });

  it('stores a console URL when one is given and leaves it unset when the field is blank', async () => {
    const withConsole = createManager();
    const withoutConsole = createManager();

    await handleInstanceFormMessage(
      submit({ consoleUrl: ' http://nacos.example.com:8080 ' }),
      undefined,
      asManager(withConsole),
      vi.fn(),
      asPanel(createPanel())
    );
    await handleInstanceFormMessage(
      submit({ consoleUrl: '   ' }),
      undefined,
      asManager(withoutConsole),
      vi.fn(),
      asPanel(createPanel())
    );

    expect(withConsole.createInstance.mock.calls[0][0]).toMatchObject({ consoleUrl: 'http://nacos.example.com:8080' });
    expect(withoutConsole.createInstance.mock.calls[0][0].consoleUrl).toBeUndefined();
  });

  it('stores the typed password only for the mode that uses it', async () => {
    const userPassword = createManager();
    const none = createManager();

    await handleInstanceFormMessage(
      submit({ authMode: 'userPassword', username: 'nacos', password: 'hunter2' }),
      undefined,
      asManager(userPassword),
      vi.fn(),
      asPanel(createPanel())
    );
    await handleInstanceFormMessage(
      submit({ password: 'left over' }),
      undefined,
      asManager(none),
      vi.fn(),
      asPanel(createPanel())
    );

    expect(userPassword.createInstance.mock.calls[0][0]).toMatchObject({ username: 'nacos', password: 'hunter2' });
    expect(none.createInstance.mock.calls[0][0].password).toBeUndefined();
  });

  it('stores the parsed custom headers for the custom header mode', async () => {
    const manager = createManager();

    await handleInstanceFormMessage(
      submit({ authMode: 'customHeader', customHeaders: 'Authorization: Bearer abc' }),
      undefined,
      asManager(manager),
      vi.fn(),
      asPanel(createPanel())
    );

    expect(manager.createInstance.mock.calls[0][0]).toMatchObject({
      authMode: 'customHeader',
      customHeaders: { Authorization: 'Bearer abc' }
    });
  });
});

describe('handleInstanceFormMessage: rejecting bad input', () => {
  const invalidFields: Array<[string, Record<string, unknown>, string]> = [
    ['an empty label', { label: '' }, LABEL_REQUIRED],
    ['a whitespace-only label', { label: '   ' }, LABEL_REQUIRED],
    ['a missing server URL', { serverUrl: '' }, SERVER_URL_REQUIRED],
    ['a whitespace-only server URL', { serverUrl: '  ' }, SERVER_URL_REQUIRED],
    ['a non-http server URL', { serverUrl: 'ftp://nacos.example.com' }, SERVER_URL_REQUIRED],
    ['a server URL that is not a URL', { serverUrl: 'nacos.example.com' }, SERVER_URL_REQUIRED],
    ['an invalid console URL', { consoleUrl: 'ftp://nacos.example.com' }, CONSOLE_URL_INVALID],
    ['a console URL that is not a URL', { consoleUrl: 'not a url' }, CONSOLE_URL_INVALID],
    [
      'username and password with no username',
      { authMode: 'userPassword', username: '  ', password: 'hunter2' },
      USERNAME_REQUIRED
    ],
    [
      'username and password with no password',
      { authMode: 'userPassword', username: 'nacos', password: '' },
      PASSWORD_REQUIRED
    ],
    ['custom headers with an empty textarea', { authMode: 'customHeader', customHeaders: '\n  \n' }, HEADERS_REQUIRED]
  ];

  it.each(invalidFields)('answers %s with an error instead of saving', async (_name, overrides, expected) => {
    const manager = createManager();
    const panel = createPanel();
    const onSaved = vi.fn();

    const handled = await handleInstanceFormMessage(
      submit(overrides),
      undefined,
      asManager(manager),
      onSaved,
      asPanel(panel)
    );

    expect(handled).toBe(true);
    expect(errorPayload(panel)).toBe(expected);
    expect(manager.createInstance).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(panel.disposeCount).toBe(0);
  });

  it('refuses an AK/SK authentication mode the form never offers', async () => {
    // The page can post anything. This mode is unimplemented, and a stored
    // instance carrying it fails much later, inside `createAuthStrategy`.
    const manager = createManager();
    const panel = createPanel();

    await handleInstanceFormMessage(submit({ authMode: 'akSk' }), undefined, asManager(manager), vi.fn(), asPanel(panel));

    expect(errorPayload(panel)).toBe(UNREADABLE_PAYLOAD);
    expect(manager.createInstance).not.toHaveBeenCalled();
  });

  const malformedMessages: Array<[string, unknown]> = [
    ['a missing field', { type: 'submit', payload: { label: 'prod' } }],
    ['a field of the wrong type', { type: 'submit', payload: formPayload({ readOnly: 'yes' }) }],
    ['a null payload', { type: 'submit', payload: null }],
    ['no payload at all', { type: 'submit' }],
    ['a payload that is not an object', { type: 'submit', payload: 'prod' }],
    ['an unknown authentication mode', { type: 'submit', payload: formPayload({ authMode: 'kerberos' }) }]
  ];

  it.each(malformedMessages)('answers %s with an error rather than a crash', async (_name, message) => {
    const manager = createManager();
    const panel = createPanel();

    const handled = await handleInstanceFormMessage(message, undefined, asManager(manager), vi.fn(), asPanel(panel));

    expect(handled).toBe(true);
    expect(errorPayload(panel)).toBe(UNREADABLE_PAYLOAD);
    expect(manager.createInstance).not.toHaveBeenCalled();
  });

  const ignoredMessages: Array<[string, unknown]> = [
    ['an unknown type', { type: 'deleteEverything', payload: formPayload() }],
    ['no type', { payload: formPayload() }],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'submit']
  ];

  it.each(ignoredMessages)('ignores %s without touching anything', async (_name, message) => {
    const manager = createManager();
    const panel = createPanel();

    const handled = await handleInstanceFormMessage(message, undefined, asManager(manager), vi.fn(), asPanel(panel));

    expect(handled).toBe(false);
    expect(panel.posted).toEqual([]);
    expect(manager.createInstance).not.toHaveBeenCalled();
    expect(panel.disposeCount).toBe(0);
  });

  it('reports a rejected save as an error instead of an unhandled rejection', async () => {
    const manager = createManager({
      createInstance: vi.fn(async () => {
        throw new Error('globalState is full');
      })
    });
    const panel = createPanel();
    const onSaved = vi.fn();

    await expect(
      handleInstanceFormMessage(submit(), undefined, asManager(manager), onSaved, asPanel(panel))
    ).resolves.toBe(true);

    expect(errorPayload(panel)).toBe('globalState is full');
    expect(onSaved).not.toHaveBeenCalled();
    expect(panel.disposeCount).toBe(0);
  });

  it('closes the panel even when the caller cannot refresh what it shows', async () => {
    // The instance is already written by this point. Leaving the form open on
    // an error invites a second Save, which creates a second instance.
    const manager = createManager();
    const panel = createPanel();

    await handleInstanceFormMessage(
      submit(),
      undefined,
      asManager(manager),
      () => {
        throw new Error('the tree exploded');
      },
      asPanel(panel)
    );

    expect(manager.createInstance).toHaveBeenCalledTimes(1);
    expect(panel.disposeCount).toBe(1);
  });

  it('survives a page that is no longer there to answer', async () => {
    // Closing the panel mid-save leaves this post with nowhere to go. It is a
    // UI update to a page that no longer exists, not a failure to report.
    const panel = createPanel();
    panel.webview.postMessage = async () => {
      throw new Error('Webview is disposed');
    };

    await expect(
      handleInstanceFormMessage(submit({ label: '' }), undefined, asManager(createManager()), vi.fn(), asPanel(panel))
    ).resolves.toBe(true);
  });

  it('redacts a credential that a failed save echoed back', async () => {
    const manager = createManager({
      createInstance: vi.fn(async () => {
        throw new Error('rejected {"password": "hunter2"}');
      })
    });
    const panel = createPanel();

    await handleInstanceFormMessage(submit(), undefined, asManager(manager), vi.fn(), asPanel(panel));

    expect(errorPayload(panel)).not.toContain('hunter2');
  });
});

describe('handleInstanceFormMessage: editing an instance', () => {
  const existing = existingInstance({ authMode: 'userPassword', username: 'nacos' });

  it('updates the instance and closes the panel', async () => {
    // An instance already on username and password has a password stored: the
    // form demanded one when it was created.
    const manager = createManager({ getPassword: vi.fn(async () => 'stored') });
    const panel = createPanel();
    const onSaved = vi.fn();

    await handleInstanceFormMessage(
      submit({ label: 'staging', authMode: 'userPassword', username: 'nacos', password: '' }),
      existing,
      asManager(manager),
      onSaved,
      asPanel(panel)
    );

    expect(manager.createInstance).not.toHaveBeenCalled();
    expect(manager.updateInstance).toHaveBeenCalledTimes(1);
    expect(manager.updateInstance.mock.calls[0][0]).toBe(existing.id);
    expect(manager.updateInstance.mock.calls[0][1]).toMatchObject({ label: 'staging' });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(panel.disposeCount).toBe(1);
  });

  it('keeps the stored password when the box is left blank', async () => {
    const manager = createManager({ getPassword: vi.fn(async () => 'stored') });

    await handleInstanceFormMessage(
      submit({ authMode: 'userPassword', username: 'nacos', password: '' }),
      existing,
      asManager(manager),
      vi.fn(),
      asPanel(createPanel())
    );

    expect(manager.updateInstance.mock.calls[0][2].password).toBeUndefined();
  });

  it('replaces the stored password when a new one is typed', async () => {
    const manager = createManager({ getPassword: vi.fn(async () => 'stored') });

    await handleInstanceFormMessage(
      submit({ authMode: 'userPassword', username: 'nacos', password: 'fresh' }),
      existing,
      asManager(manager),
      vi.fn(),
      asPanel(createPanel())
    );

    expect(manager.updateInstance.mock.calls[0][2]).toMatchObject({ password: 'fresh' });
  });

  it('demands a password when the mode needs one and nothing is stored yet', async () => {
    // Switching an anonymous instance to username and password with the box
    // blank would otherwise save a login with no credential behind it.
    const manager = createManager({ getPassword: vi.fn(async () => undefined) });
    const panel = createPanel();

    await handleInstanceFormMessage(
      submit({ authMode: 'userPassword', username: 'nacos', password: '' }),
      existingInstance(),
      asManager(manager),
      vi.fn(),
      asPanel(panel)
    );

    expect(errorPayload(panel)).toBe(PASSWORD_REQUIRED);
    expect(manager.updateInstance).not.toHaveBeenCalled();
  });

  it('clears the stored password when the instance stops using one', async () => {
    // A credential no setting can reach any more has no reason to stay in
    // SecretStorage. The empty string is what the manager reads as "clear it";
    // `undefined` means "keep it".
    const manager = createManager({ getPassword: vi.fn(async () => 'stored') });

    await handleInstanceFormMessage(
      submit({ authMode: 'none' }),
      existing,
      asManager(manager),
      vi.fn(),
      asPanel(createPanel())
    );

    expect(manager.updateInstance.mock.calls[0][1]).toMatchObject({ authMode: 'none' });
    expect(manager.updateInstance.mock.calls[0][2]).toMatchObject({ password: '' });
  });

  it('keeps the stored custom headers when the textarea is left blank', async () => {
    const manager = createManager({ getCustomHeaders: vi.fn(async () => ({ Authorization: 'Bearer stored' })) });

    await handleInstanceFormMessage(
      submit({ authMode: 'customHeader', customHeaders: '' }),
      existingInstance({ authMode: 'customHeader' }),
      asManager(manager),
      vi.fn(),
      asPanel(createPanel())
    );

    expect(manager.updateInstance.mock.calls[0][2].customHeaders).toBeUndefined();
  });

  it('demands headers when the mode needs them and none are stored yet', async () => {
    const manager = createManager({ getCustomHeaders: vi.fn(async () => undefined) });
    const panel = createPanel();

    await handleInstanceFormMessage(
      submit({ authMode: 'customHeader', customHeaders: '' }),
      existingInstance(),
      asManager(manager),
      vi.fn(),
      asPanel(panel)
    );

    expect(errorPayload(panel)).toBe(HEADERS_REQUIRED);
    expect(manager.updateInstance).not.toHaveBeenCalled();
  });

  it('clears a console URL the user emptied', async () => {
    const manager = createManager();

    await handleInstanceFormMessage(
      submit({ consoleUrl: '' }),
      existingInstance({ consoleUrl: 'http://nacos.example.com:8080' }),
      asManager(manager),
      vi.fn(),
      asPanel(createPanel())
    );

    const patch = manager.updateInstance.mock.calls[0][1] as Record<string, unknown>;
    expect('consoleUrl' in patch).toBe(true);
    expect(patch.consoleUrl).toBeUndefined();
  });
});

describe('handleInstanceFormMessage: against the real config manager', () => {
  function createStore(): { memento: ExtensionMemento; secrets: SecretStore } {
    const state = new Map<string, unknown>();
    const secretValues = new Map<string, string>();
    return {
      memento: {
        get: <T>(key: string, defaultValue: T): T => (state.has(key) ? (state.get(key) as T) : defaultValue),
        update: async (key: string, value: unknown) => {
          state.set(key, value);
        }
      },
      secrets: {
        get: async (key: string) => secretValues.get(key),
        store: async (key: string, value: string) => {
          secretValues.set(key, value);
        },
        delete: async (key: string) => {
          secretValues.delete(key);
        }
      }
    };
  }

  it('hands the manager an instance its schema accepts, with the password in SecretStorage', async () => {
    // The stubs above prove what the handler passes; only the real manager
    // proves the schema takes it.
    const { memento, secrets } = createStore();
    const manager = new NacosInstanceConfigManager(memento, secrets);

    await handleInstanceFormMessage(
      submit({ authMode: 'userPassword', username: 'nacos', password: 'hunter2', readOnly: true }),
      undefined,
      manager,
      vi.fn(),
      asPanel(createPanel())
    );

    const [stored] = await manager.listInstances();
    expect(stored).toMatchObject({ label: 'prod', authMode: 'userPassword', username: 'nacos', readOnly: true });
    expect(await manager.getPassword(stored.id)).toBe('hunter2');
  });

  it('advances updatedAt and keeps the password when an edit leaves the box blank', async () => {
    const { memento, secrets } = createStore();
    const manager = new NacosInstanceConfigManager(memento, secrets);
    const created = await manager.createInstance({
      label: 'prod',
      serverUrl: 'http://nacos.example.com:8848/nacos',
      authMode: 'userPassword',
      username: 'nacos',
      password: 'hunter2'
    });
    vi.spyOn(Date, 'now').mockReturnValue(created.updatedAt + 5000);

    await handleInstanceFormMessage(
      submit({ label: 'staging', authMode: 'userPassword', username: 'nacos', password: '' }),
      created,
      manager,
      vi.fn(),
      asPanel(createPanel())
    );

    const [stored] = await manager.listInstances();
    expect(stored.label).toBe('staging');
    expect(stored.updatedAt).toBe(created.updatedAt + 5000);
    expect(stored.createdAt).toBe(created.createdAt);
    expect(await manager.getPassword(stored.id)).toBe('hunter2');
  });

  it('leaves no usable password behind when the instance switches to anonymous access', async () => {
    const { memento, secrets } = createStore();
    const manager = new NacosInstanceConfigManager(memento, secrets);
    const created = await manager.createInstance({
      label: 'prod',
      serverUrl: 'http://nacos.example.com:8848/nacos',
      authMode: 'userPassword',
      username: 'nacos',
      password: 'hunter2'
    });

    await handleInstanceFormMessage(submit({ authMode: 'none' }), created, manager, vi.fn(), asPanel(createPanel()));

    expect(await manager.getPassword(created.id)).toBe('');
  });
});

describe('handleInstanceFormMessage: testing the connection', () => {
  it('reports success without saving anything', async () => {
    const manager = createManager();
    const panel = createPanel();
    const onSaved = vi.fn();
    const testConnection = stubProbe();

    const handled = await handleInstanceFormMessage(
      testConnectionMessage(),
      undefined,
      asManager(manager),
      onSaved,
      asPanel(panel),
      { testConnection }
    );

    expect(handled).toBe(true);
    expect(testOutcome(panel)).toEqual({ ok: true, message: 'Connected to Nacos 2.2.3 (standalone mode).' });
    expect(manager.createInstance).not.toHaveBeenCalled();
    expect(manager.updateInstance).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(panel.disposeCount).toBe(0);
  });

  it('names the console it discovered', async () => {
    const panel = createPanel();

    await handleInstanceFormMessage(
      testConnectionMessage(),
      undefined,
      asManager(createManager()),
      vi.fn(),
      asPanel(panel),
      {
        testConnection: async () =>
          successResult({ version: '3.0.1', majorVersion: 3, consoleUrl: 'http://nacos.example.com:8080' })
      }
    );

    expect(testOutcome(panel).message).toBe(
      'Connected to Nacos 3.0.1 (standalone mode). Its console is at http://nacos.example.com:8080.'
    );
  });

  /**
   * Naming the console in the success sentence and then dropping it is how the
   * discovery got lost: the instance is saved with whatever the field holds, so
   * the field is where the discovered address has to end up.
   */
  it('sends the discovered console address back so the blank field can be filled with it', async () => {
    const panel = createPanel();

    await handleInstanceFormMessage(
      testConnectionMessage({ consoleUrl: '' }),
      undefined,
      asManager(createManager()),
      vi.fn(),
      asPanel(panel),
      {
        testConnection: async () =>
          successResult({ version: '3.2.3', majorVersion: 3, consoleUrl: 'http://nacos.example.com:8080' })
      }
    );

    expect(testOutcome(panel).consoleUrl).toBe('http://nacos.example.com:8080');
  });

  it('sends nothing back for the console field the user filled in themselves', async () => {
    const panel = createPanel();

    await handleInstanceFormMessage(
      testConnectionMessage({ consoleUrl: 'http://console.example.com:8080' }),
      undefined,
      asManager(createManager()),
      vi.fn(),
      asPanel(panel),
      {
        testConnection: async () =>
          successResult({ version: '3.2.3', majorVersion: 3, consoleUrl: 'http://console.example.com:8080' })
      }
    );

    expect(testOutcome(panel).consoleUrl).toBeUndefined();
  });

  it('sends no console address back when the probe found none', async () => {
    const panel = createPanel();

    await handleInstanceFormMessage(
      testConnectionMessage({ consoleUrl: '' }),
      undefined,
      asManager(createManager()),
      vi.fn(),
      asPanel(panel),
      { testConnection: async () => successResult() }
    );

    expect(testOutcome(panel).consoleUrl).toBeUndefined();
  });

  it('says so when a secured server was reached with no credentials', async () => {
    // `authEnabled` is on the success result for exactly this warning: the
    // state endpoint can be readable anonymously on a server whose data is not.
    const panel = createPanel();

    await handleInstanceFormMessage(
      testConnectionMessage({ authMode: 'none' }),
      undefined,
      asManager(createManager()),
      vi.fn(),
      asPanel(panel),
      { testConnection: async () => successResult({ authEnabled: true }) }
    );

    expect(testOutcome(panel).ok).toBe(true);
    expect(testOutcome(panel).message).toContain('authentication enabled');
  });

  it('leaves the warning off when the instance does send credentials', async () => {
    const panel = createPanel();

    await handleInstanceFormMessage(
      testConnectionMessage({ authMode: 'userPassword', username: 'nacos', password: 'hunter2' }),
      undefined,
      asManager(createManager()),
      vi.fn(),
      asPanel(panel),
      { testConnection: async () => successResult({ authEnabled: true }) }
    );

    expect(testOutcome(panel).message).not.toContain('authentication enabled');
  });

  it('names the startup mode a server declined to report', async () => {
    const panel = createPanel();

    await handleInstanceFormMessage(
      testConnectionMessage(),
      undefined,
      asManager(createManager()),
      vi.fn(),
      asPanel(panel),
      { testConnection: async () => successResult({ startupMode: 'unknown' }) }
    );

    expect(testOutcome(panel).message).toBe('Connected to Nacos 2.2.3 (startup mode not reported).');
  });

  it('passes the probe the address and credentials the form is holding', async () => {
    const testConnection = stubProbe();

    await handleInstanceFormMessage(
      testConnectionMessage({
        serverUrl: ' http://nacos.example.com:8848/nacos ',
        consoleUrl: 'http://nacos.example.com:8080',
        authMode: 'userPassword',
        username: ' nacos ',
        password: 'typed'
      }),
      undefined,
      asManager(createManager()),
      vi.fn(),
      asPanel(createPanel()),
      { testConnection }
    );

    expect(testConnection.mock.calls[0][0]).toMatchObject({
      serverUrl: 'http://nacos.example.com:8848/nacos',
      consoleUrl: 'http://nacos.example.com:8080',
      authMode: 'userPassword',
      username: 'nacos',
      password: 'typed'
    });
  });

  it('tests the typed password rather than the one already stored', async () => {
    // Testing the saved password while the form shows a new one answers a
    // question nobody asked.
    const manager = createManager({ getPassword: vi.fn(async () => 'stored') });
    const testConnection = stubProbe();

    await handleInstanceFormMessage(
      testConnectionMessage({ authMode: 'userPassword', username: 'nacos', password: 'typed' }),
      existingInstance({ authMode: 'userPassword', username: 'nacos' }),
      asManager(manager),
      vi.fn(),
      asPanel(createPanel()),
      { testConnection }
    );

    expect(testConnection.mock.calls[0][0]).toMatchObject({ password: 'typed' });
  });

  it('falls back to the stored password when the box is blank, which is what blank means', async () => {
    const manager = createManager({ getPassword: vi.fn(async () => 'stored') });
    const testConnection = stubProbe();

    await handleInstanceFormMessage(
      testConnectionMessage({ authMode: 'userPassword', username: 'nacos', password: '' }),
      existingInstance({ authMode: 'userPassword', username: 'nacos' }),
      asManager(manager),
      vi.fn(),
      asPanel(createPanel()),
      { testConnection }
    );

    expect(testConnection.mock.calls[0][0]).toMatchObject({ password: 'stored' });
  });

  it('sends the headers in the textarea, and the stored ones when it is blank', async () => {
    const manager = createManager({ getCustomHeaders: vi.fn(async () => ({ Authorization: 'Bearer stored' })) });
    const typed = stubProbe();
    const blank = stubProbe();
    const existing = existingInstance({ authMode: 'customHeader' });

    await handleInstanceFormMessage(
      testConnectionMessage({ authMode: 'customHeader', customHeaders: 'Authorization: Bearer typed' }),
      existing,
      asManager(manager),
      vi.fn(),
      asPanel(createPanel()),
      { testConnection: typed }
    );
    await handleInstanceFormMessage(
      testConnectionMessage({ authMode: 'customHeader', customHeaders: '' }),
      existing,
      asManager(manager),
      vi.fn(),
      asPanel(createPanel()),
      { testConnection: blank }
    );

    expect(typed.mock.calls[0][0]).toMatchObject({ customHeaders: { Authorization: 'Bearer typed' } });
    expect(blank.mock.calls[0][0]).toMatchObject({ customHeaders: { Authorization: 'Bearer stored' } });
  });

  it('reports a failure with the sentence the probe wrote', async () => {
    const panel = createPanel();

    await handleInstanceFormMessage(
      testConnectionMessage(),
      undefined,
      asManager(createManager()),
      vi.fn(),
      asPanel(panel),
      {
        testConnection: async () => ({
          ok: false,
          message: 'Could not reach nacos.example.com:8848 (ECONNREFUSED).',
          reason: 'network',
          triedBaseUrls: ['http://nacos.example.com:8848/nacos']
        })
      }
    );

    expect(testOutcome(panel)).toEqual({
      ok: false,
      message: 'Could not reach nacos.example.com:8848 (ECONNREFUSED).'
    });
  });

  it('refuses to probe an address the server could never answer on', async () => {
    const testConnection = stubProbe();
    const panel = createPanel();

    await handleInstanceFormMessage(
      testConnectionMessage({ serverUrl: 'ftp://nacos.example.com' }),
      undefined,
      asManager(createManager()),
      vi.fn(),
      asPanel(panel),
      { testConnection }
    );

    expect(testConnection).not.toHaveBeenCalled();
    expect(testOutcome(panel)).toEqual({ ok: false, message: SERVER_URL_REQUIRED });
  });

  it('reports unparseable headers instead of probing with half of them', async () => {
    const testConnection = stubProbe();
    const panel = createPanel();

    await handleInstanceFormMessage(
      testConnectionMessage({ authMode: 'customHeader', customHeaders: 'Authorization Bearer abc' }),
      undefined,
      asManager(createManager()),
      vi.fn(),
      asPanel(panel),
      { testConnection }
    );

    expect(testConnection).not.toHaveBeenCalled();
    expect(testOutcome(panel).ok).toBe(false);
  });

  it('turns a probe that throws into a reported failure', async () => {
    // `testNacosConnection` promises never to reject, but it is injectable and
    // a panel left spinning on "Testing connection..." is the worst outcome.
    const panel = createPanel();

    await handleInstanceFormMessage(
      testConnectionMessage(),
      undefined,
      asManager(createManager()),
      vi.fn(),
      asPanel(panel),
      {
        testConnection: async () => {
          throw new Error('probe exploded');
        }
      }
    );

    expect(testOutcome(panel)).toEqual({ ok: false, message: 'probe exploded' });
  });

  it('reports a credential store that will not open, rather than rejecting', async () => {
    // Reading the saved password happens before the probe runs, so a failure
    // here is outside the try that wraps it.
    const manager = createManager({
      getPassword: vi.fn(async () => {
        throw new Error('SecretStorage is locked');
      })
    });
    const panel = createPanel();

    await expect(
      handleInstanceFormMessage(
        testConnectionMessage({ authMode: 'userPassword', username: 'nacos', password: '' }),
        existingInstance({ authMode: 'userPassword', username: 'nacos' }),
        asManager(manager),
        vi.fn(),
        asPanel(panel),
        { testConnection: stubProbe() }
      )
    ).resolves.toBe(true);

    expect(testOutcome(panel)).toEqual({ ok: false, message: 'SecretStorage is locked' });
  });

  it('rejects a crafted test message the same way it rejects a crafted save', async () => {
    const testConnection = stubProbe();
    const panel = createPanel();

    await handleInstanceFormMessage(
      { type: 'testConnection', payload: formPayload({ authMode: 'akSk' }) },
      undefined,
      asManager(createManager()),
      vi.fn(),
      asPanel(panel),
      { testConnection }
    );

    expect(testConnection).not.toHaveBeenCalled();
    expect(errorPayload(panel)).toBe(UNREADABLE_PAYLOAD);
  });
});

describe('parseCustomHeaders', () => {
  it('reads one "Name: value" per line', () => {
    expect(parseCustomHeaders('Authorization: Bearer abc\nX-Tenant: acme')).toEqual({
      ok: true,
      headers: { Authorization: 'Bearer abc', 'X-Tenant': 'acme' }
    });
  });

  it('skips blank lines, including the trailing newline every textarea leaves', () => {
    expect(parseCustomHeaders('\n\nAuthorization: Bearer abc\n   \n')).toEqual({
      ok: true,
      headers: { Authorization: 'Bearer abc' }
    });
  });

  it('reads a textarea that arrives with CRLF line endings', () => {
    expect(parseCustomHeaders('Authorization: Bearer abc\r\nX-Tenant: acme')).toEqual({
      ok: true,
      headers: { Authorization: 'Bearer abc', 'X-Tenant': 'acme' }
    });
  });

  it('trims the whitespace around both the name and the value', () => {
    expect(parseCustomHeaders('   Authorization  :   Bearer abc   ')).toEqual({
      ok: true,
      headers: { Authorization: 'Bearer abc' }
    });
  });

  it('splits on the first colon only, so a value may contain one', () => {
    expect(parseCustomHeaders('X-Target: host:8848')).toEqual({ ok: true, headers: { 'X-Target': 'host:8848' } });
  });

  it('keeps the last of a repeated name, whatever its casing', () => {
    // A record cannot hold both spellings, and sending both would leave the
    // server to choose. The later line wins: it is what the user typed last.
    expect(parseCustomHeaders('Authorization: first\nauthorization: second')).toEqual({
      ok: true,
      headers: { authorization: 'second' }
    });
  });

  it('accepts an empty value, which is a legal header', () => {
    expect(parseCustomHeaders('X-Debug:')).toEqual({ ok: true, headers: { 'X-Debug': '' } });
  });

  it('reports a line with no colon rather than dropping it', () => {
    // Skipping it silently would send the request without the credential and
    // leave the user reading a 403 that has nothing to do with their token.
    const result = parseCustomHeaders('Authorization: Bearer abc\nX-Tenant acme');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toBe('Custom header line 2 must be written as "Name: value".');
  });

  it('reports a line whose name is empty', () => {
    expect(parseCustomHeaders(': Bearer abc').ok).toBe(false);
  });

  it('reports a name that is not a legal HTTP header name', () => {
    // A space in the name is rejected by the HTTP stack at request time, which
    // is a long way from the field that caused it.
    const result = parseCustomHeaders('X Tenant: acme');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toBe('"X Tenant" is not a valid HTTP header name.');
  });

  it('reads an empty textarea as no headers rather than as an error', () => {
    expect(parseCustomHeaders('   \n  ')).toEqual({ ok: true, headers: {} });
  });
});

describe('renderInstanceForm', () => {
  it('offers exactly the three authentication modes this milestone implements', () => {
    const { body } = renderInstanceForm();

    expect(body).toContain('value="none"');
    expect(body).toContain('value="userPassword"');
    expect(body).toContain('value="customHeader"');
    expect(body).not.toContain('akSk');
  });

  it('titles itself for the instance being added', () => {
    const { body } = renderInstanceForm();

    expect(body).toContain('Add Nacos Instance');
    expect(body).toContain('Add Instance');
  });

  it('fills the fields from the instance being edited', () => {
    const { body } = renderInstanceForm({
      existing: existingInstance({
        label: 'staging',
        serverUrl: 'https://nacos.example.com/nacos',
        consoleUrl: 'https://nacos.example.com:8080',
        authMode: 'userPassword',
        username: 'nacos',
        readOnly: true,
        allowBackgroundAccess: true
      })
    });

    expect(body).toContain('value="staging"');
    expect(body).toContain('value="https://nacos.example.com/nacos"');
    expect(body).toContain('value="https://nacos.example.com:8080"');
    expect(body).toContain('value="nacos"');
    expect(body).toContain('value="userPassword" selected');
    expect(body.match(/ checked/g)).toHaveLength(2);
    expect(body).toContain('Save Instance');
  });

  it('falls back to anonymous for a mode this version cannot render', () => {
    // `akSk` is storable -- the schema accepts it -- but the select has no
    // option for it, and a select with nothing selected submits its first
    // option anyway.
    const { body } = renderInstanceForm({ existing: existingInstance({ authMode: 'akSk' }) });

    expect(body).toContain('value="none" selected');
    expect(body.match(/selected/g)).toHaveLength(1);
  });

  it('says that a blank credential box keeps what is stored, and only when something is', () => {
    expect(renderInstanceForm({ existing: existingInstance(), hasStoredPassword: true }).body).toContain(
      'Leave blank to keep the saved password.'
    );
    expect(renderInstanceForm({ existing: existingInstance(), hasStoredHeaders: true }).body).toContain(
      'Leave blank to keep the saved headers.'
    );
    expect(renderInstanceForm().body).not.toContain('Leave blank to keep');
  });

  it('never writes a stored credential into the page', () => {
    // The password and the headers are SecretStorage values. The form asks for
    // them again rather than round-tripping them through the DOM.
    const { body } = renderInstanceForm({ existing: existingInstance(), hasStoredPassword: true });

    expect(body).toMatch(/name="password"/);
    expect(body).not.toMatch(/name="password"[^>]*value=/);
    expect(body).toMatch(/name="customHeaders"[^>]*><\/textarea>/);
  });

  it('hands the page the copy it renders at runtime', () => {
    const { data } = renderInstanceForm();

    expect(data.atNacosStrings).toMatchObject({
      saving: 'Saving...',
      testing: 'Testing connection...',
      testConnection: 'Test Connection',
      submit: 'Add Instance'
    });
  });

  it('escapes a label that tries to break out of the attribute it lands in', () => {
    const hostile = '"><script>alert(1)</script>';
    const { body, data } = renderInstanceForm({ existing: existingInstance({ label: hostile }) });

    expect(body).not.toContain('<script>alert(1)');
    expect(body).toContain('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');

    const html = renderWebviewHtml(
      { cspSource: 'vscode-webview:', asWebviewUri: (uri: unknown) => uri } as never,
      { script: vscode.Uri.file('/ext/dist/webview/nacos-instance-form.js') } as never,
      body,
      data
    );
    expect(html).not.toContain('<script>alert(1)');
    // The data block and the bundle: the hostile label closed neither.
    expect(html.match(/<\/script>/g)).toHaveLength(2);
  });
});

describe('NacosInstanceFormPanel.open', () => {
  const context = { extensionUri: vscode.Uri.file('/ext') } as unknown as vscode.ExtensionContext;

  function openWith(existing?: NacosInstanceConfig): Promise<vscode.WebviewPanel> {
    const created: vscode.WebviewPanel[] = [];
    const createWebviewPanel = vscode.window.createWebviewPanel;
    vi.spyOn(vscode.window, 'createWebviewPanel').mockImplementation((viewType, title, showOptions, options) => {
      const panel = createWebviewPanel(viewType, title, showOptions, options);
      created.push(panel);
      return panel;
    });
    const manager = new NacosInstanceConfigManager(
      { get: <T>(_key: string, fallback: T): T => fallback, update: async () => undefined },
      { get: async () => undefined, store: async () => undefined, delete: async () => undefined }
    );
    return NacosInstanceFormPanel.open(context, manager, vi.fn(), existing).then(() => created[0]);
  }

  it('names the panel after the instance it is editing', async () => {
    expect((await openWith()).title).toBe('Add Nacos Instance');
    expect((await openWith(existingInstance({ label: 'staging' }))).title).toBe('Edit Nacos Instance: staging');
  });

  it('serves the form under the shared CSP, with the bundle and its copy', async () => {
    const html = (await openWith()).webview.html;

    expect(html).toContain("default-src 'none'");
    expect(html).toContain('/ext/dist/webview/nacos-instance-form.js');
    expect(html).toContain('/ext/webview/nacos-instance-form/index.css');
    expect(html).toContain('id="atNacosStrings"');
    expect(html).toContain('name="serverUrl"');
  });

  it('keeps the page alive while its tab is hidden, so unsaved fields survive a tab switch', async () => {
    // Without this flag a hidden webview is torn down, and a half-typed
    // password or URL is gone when the user switches back.
    const panel = await openWith();

    expect(panel.options).toMatchObject({ enableScripts: true, retainContextWhenHidden: true });
  });
});

describe('readSavedInstanceFormState', () => {
  // The page half that owns `setState` touches `document` the moment it loads
  // and cannot be imported under Node, so what gets tested is the round-trip
  // guard it delegates to: a state `payloadFromForm()` wrote is exactly what
  // this reader accepts. `formPayload()` is that shape, field for field.
  it('accepts the payload shape the page writes', () => {
    const payload = formPayload({ password: 'hunter2', readOnly: true });

    expect(readSavedInstanceFormState(payload)).toEqual(payload);
  });

  it('answers undefined on a first open, when no state was ever written', () => {
    expect(readSavedInstanceFormState(undefined)).toBeUndefined();
  });

  const rejected: Array<[string, unknown]> = [
    ['a state missing a field', (({ password: _password, ...rest }) => rest)(formPayload())],
    ['a field of the wrong type', formPayload({ readOnly: 'yes' })],
    ['null', null],
    ['a state that is not an object', 'prod']
  ];

  it.each(rejected)('rejects %s rather than restoring half a form', (_name, value) => {
    expect(readSavedInstanceFormState(value)).toBeUndefined();
  });
});

describe('localization', () => {
  it('routes every string it shows through a key the zh-cn bundle translates', async () => {
    // A source string that reaches `t()` but is missing from the bundle falls
    // back to English silently. Nothing else notices.
    const bundle = JSON.parse(readFileSync(resolve(process.cwd(), 'l10n/bundle.l10n.zh-cn.json'), 'utf8')) as Record<
      string,
      string
    >;
    const sources: string[] = [];
    // `l10n.t` is overloaded, so the stub takes the widest first parameter of
    // the set rather than the string form the code actually uses.
    vi.spyOn(vscode.l10n, 't').mockImplementation(
      (messageOrOptions: string | { message: string }, ...args: never[]) => {
        const message = typeof messageOrOptions === 'string' ? messageOrOptions : messageOrOptions.message;
        sources.push(message);
        return translate(message, ...args);
      }
    );

    renderInstanceForm();
    renderInstanceForm({ existing: existingInstance(), hasStoredPassword: true, hasStoredHeaders: true });
    for (const overrides of [
      { label: '' },
      { serverUrl: 'ftp://x' },
      { consoleUrl: 'ftp://x' },
      { authMode: 'userPassword', username: '', password: '' },
      { authMode: 'userPassword', username: 'nacos', password: '' },
      { authMode: 'customHeader', customHeaders: '' },
      { authMode: 'customHeader', customHeaders: 'no colon here' },
      { authMode: 'customHeader', customHeaders: 'Bad Name: v' },
      { authMode: 'akSk' }
    ]) {
      await handleInstanceFormMessage(
        submit(overrides),
        undefined,
        asManager(createManager()),
        vi.fn(),
        asPanel(createPanel())
      );
    }
    for (const result of [
      successResult(),
      successResult({ startupMode: 'cluster' }),
      successResult({ startupMode: 'unknown' }),
      successResult({ authEnabled: true, consoleUrl: 'http://nacos.example.com:8080' })
    ]) {
      await handleInstanceFormMessage(
        testConnectionMessage(),
        undefined,
        asManager(createManager()),
        vi.fn(),
        asPanel(createPanel()),
        { testConnection: async () => result }
      );
    }

    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(Object.keys(bundle), source).toContain(source);
    }
  });
});
