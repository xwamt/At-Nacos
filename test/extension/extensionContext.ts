import * as vscode from 'vscode';

/**
 * The pieces of `ExtensionContext` this extension touches, backed by real maps
 * so that what a command writes can be read back by the assertion.
 *
 * `stored` seeds `globalState`, which is how a test sets up existing instances
 * -- or a damaged record -- without going through the config manager.
 */
export function extensionContext(stored: Record<string, unknown> = {}): vscode.ExtensionContext {
  const globalStorage = new Map<string, unknown>(Object.entries(stored));
  const secretStorage = new Map<string, string>();
  return {
    extensionUri: vscode.Uri.file('/tmp/extensions/local.at-nacos-0.1.0'),
    globalState: {
      get: (key: string, defaultValue: unknown) => (globalStorage.has(key) ? globalStorage.get(key) : defaultValue),
      update: async (key: string, value: unknown) => {
        globalStorage.set(key, value);
      }
    },
    secrets: {
      get: async (key: string) => secretStorage.get(key),
      store: async (key: string, value: string) => {
        secretStorage.set(key, value);
      },
      delete: async (key: string) => {
        secretStorage.delete(key);
      }
    },
    subscriptions: []
  } as unknown as vscode.ExtensionContext;
}

export const INSTANCES_KEY = 'atNacos.instances';

/** A stored instance, with the audit fields the schema requires already filled in. */
export function storedInstance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'instance-1',
    label: 'prod',
    serverUrl: 'http://nacos.example.com:8848/nacos',
    authMode: 'none',
    readOnly: false,
    allowBackgroundAccess: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  };
}
