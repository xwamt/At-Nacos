import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { NacosConfigDetail, NacosConfigListener, NacosConfigRef } from '../../src/nacos/driver/normalize';
import { ConfigHistoryPanel } from '../../src/webview/ConfigHistoryPanel';
import {
  ConfigListenersPanel,
  handleConfigListenersMessage,
  loadConfigListeners,
  renderConfigListeners,
  type ConfigListenersClient,
  type ConfigListenersSnapshot,
  type ConfigListenersView
} from '../../src/webview/ConfigListenersPanel';
import { renderWebviewHtml } from '../../src/webview/html';
import { disposeOpenPanels } from '../../src/webview/openPanels';

const translate = vscode.l10n.t.bind(vscode.l10n);

beforeEach(() => {
  vi.restoreAllMocks();
  disposeOpenPanels();
});

/** The md5 a real 2.3.2 reported for `cl-parent/cl-intimfy/application-dev.yml`. */
const CURRENT_MD5 = 'dfc21930265a48abe3257155966ca5b2';
const OLDER_MD5 = 'b376d467f70b91694bd88f76571415a1';

function ref(overrides: Partial<NacosConfigRef> = {}): NacosConfigRef {
  return { namespaceId: 'cl-parent', group: 'cl-intimfy', dataId: 'application-dev.yml', ...overrides };
}

/**
 * One listener row.
 *
 * **Fixture only.** Nothing was long-polling the server this milestone was
 * verified against, so `lisentersGroupkeyStatus` came back empty on every
 * configuration in every namespace -- see architecture §14.8 ㉗.
 */
function listener(overrides: Partial<NacosConfigListener> = {}): NacosConfigListener {
  return { ip: '192.168.99.92', md5: CURRENT_MD5, ...overrides };
}

function snapshot(overrides: Partial<ConfigListenersSnapshot> = {}): ConfigListenersSnapshot {
  return { listeners: [listener()], currentMd5: CURRENT_MD5, ...overrides };
}

function bodyOf(current?: ConfigListenersSnapshot): string {
  return renderConfigListeners({ instanceLabel: 'prod', ref: ref(), snapshot: current }).body;
}

function documentOf(view: ConfigListenersView): string {
  return renderWebviewHtml(
    { cspSource: 'vscode-webview:', asWebviewUri: (uri: unknown) => uri } as never,
    { script: vscode.Uri.file('/ext/dist/webview/nacos-consumers.js') } as never,
    view.body,
    view.data
  );
}

describe('renderConfigListeners, the listener table', () => {
  it('renders the address and the md5 of each client holding this configuration', () => {
    const body = bodyOf(snapshot({ listeners: [listener({ ip: '10.0.0.1' }), listener({ ip: '10.0.0.2' })] }));

    expect(body).toContain('10.0.0.1');
    expect(body).toContain('10.0.0.2');
    expect(body).toContain(CURRENT_MD5);
    expect(body.match(/class="listener-row"/g)).toHaveLength(2);
  });

  /**
   * The single most useful thing this view can tell an operator: a client
   * whose md5 is not the configuration's current md5 has not picked up the
   * latest publish, and is still running on the old values.
   */
  it('marks a client holding an md5 other than the current one as behind', () => {
    const body = bodyOf(snapshot({ listeners: [listener({ ip: '10.0.0.1', md5: OLDER_MD5 })] }));

    expect(body).toContain('listener-behind');
    expect(body).toContain('not picked up');
  });

  it('marks a client holding the current md5 as up to date', () => {
    const body = bodyOf(snapshot());

    expect(body).toContain('listener-current');
    expect(body).not.toContain('listener-behind');
  });

  /**
   * The comparison needs both md5s. Without the configuration's own -- a 403
   * on the detail endpoint, or a server that does not report one -- calling a
   * client behind would be an accusation nothing supports.
   */
  it('claims nothing about a client when the current md5 could not be read', () => {
    const body = bodyOf({ listeners: [listener({ md5: OLDER_MD5 })], configError: 'HTTP 403' });

    expect(body).not.toContain('listener-behind');
    expect(body).not.toContain('listener-current');
    expect(body).toContain('cannot be compared');
    expect(body).toContain(OLDER_MD5);
  });

  it('still lists the clients when only the configuration itself could not be read', () => {
    const body = bodyOf({ listeners: [listener({ ip: '10.0.0.1' })], configError: 'HTTP 403' });

    expect(body).toContain('10.0.0.1');
    expect(body).toContain('HTTP 403');
  });

  it('counts how many clients are behind, so the answer is readable without reading the table', () => {
    const body = bodyOf(
      snapshot({
        listeners: [listener({ ip: '10.0.0.1', md5: OLDER_MD5 }), listener({ ip: '10.0.0.2' }), listener({ ip: '10.0.0.3', md5: '' })]
      })
    );

    expect(body).toContain('2');
    expect(body).toContain('3');
    expect(body).toContain('older version');
  });

  it('says so plainly when every client has the current version', () => {
    const body = bodyOf(snapshot({ listeners: [listener({ ip: '10.0.0.1' }), listener({ ip: '10.0.0.2' })] }));

    expect(body).toContain('Every client');
    expect(body).not.toContain('older version');
  });

  /**
   * The ordinary state of a configuration on a server whose clients are all
   * long-polling something else, and the state of every configuration on the
   * server this milestone was verified against. Not a failure.
   */
  it('explains an empty listener list instead of drawing a table with no rows', () => {
    const body = bodyOf({ listeners: [], currentMd5: CURRENT_MD5 });

    expect(body).not.toContain('<table');
    expect(body).toContain('no client');
  });

  it('reports a listener listing that failed rather than showing no clients', () => {
    const body = bodyOf({ listeners: [], listenersError: 'HTTP 500' });

    expect(body).toContain('HTTP 500');
    expect(body).not.toContain('no client');
  });

  it('says the panel is still loading before the first fetch answers', () => {
    expect(renderConfigListeners({ instanceLabel: 'prod', ref: ref() }).body).toContain('Loading');
  });

  it('names the configuration, its group and the instance it belongs to', () => {
    const body = bodyOf(snapshot());

    expect(body).toContain('application-dev.yml');
    expect(body).toContain('cl-intimfy');
    expect(body).toContain('prod');
  });

  it('escapes an address and an md5 that try to open a tag of their own', () => {
    const hostile = '"><script>alert(1)</script>';
    const view = renderConfigListeners({
      instanceLabel: hostile,
      ref: ref({ dataId: hostile }),
      snapshot: { listeners: [{ ip: hostile, md5: hostile }], currentMd5: hostile }
    });

    expect(view.body).not.toContain('<script>alert(1)');
    expect(documentOf(view).match(/<\/script>/g)).toHaveLength(2);
  });

  it('gives the page a refresh button to post from', () => {
    expect(bodyOf(snapshot())).toContain('id="refreshButton"');
  });
});

describe('loadConfigListeners', () => {
  const detail: NacosConfigDetail = {
    ...ref(),
    content: 'spring:\n  redis:\n    password: hunter2\n',
    md5: CURRENT_MD5
  };

  function client(overrides: Partial<Record<keyof ConfigListenersClient, unknown>> = {}): ConfigListenersClient {
    return {
      listConfigListeners: async () => [listener()],
      getConfig: async () => detail,
      ...overrides
    } as ConfigListenersClient;
  }

  it('reads the listeners and the configuration of the ref it was given', async () => {
    const asked: unknown[] = [];
    const loaded = await loadConfigListeners(
      async () =>
        client({
          listConfigListeners: async (target: unknown) => {
            asked.push(target);
            return [listener()];
          }
        }),
      ref()
    );

    expect(asked).toEqual([ref()]);
    expect(loaded).toEqual({ listeners: [listener()], currentMd5: CURRENT_MD5 });
  });

  /**
   * The detail is fetched for one field. Its body is the configuration
   * itself, passwords included, and the snapshot is handed to a renderer --
   * so nothing but the md5 may leave this function.
   */
  it('keeps the md5 of the configuration and nothing else of it', async () => {
    const loaded = await loadConfigListeners(async () => client(), ref());

    expect(JSON.stringify(loaded)).not.toContain('hunter2');
    expect(JSON.stringify(loaded)).not.toContain('spring:');
  });

  it('keeps the listeners when the configuration could not be read', async () => {
    const loaded = await loadConfigListeners(
      async () => client({ getConfig: async () => Promise.reject(new Error('HTTP 403')) }),
      ref()
    );

    expect(loaded.listeners).toEqual([listener()]);
    expect(loaded.currentMd5).toBeUndefined();
    expect(loaded.configError).toBe('HTTP 403');
    expect(loaded.listenersError).toBeUndefined();
  });

  it('keeps the current md5 when the listener endpoint refused', async () => {
    const loaded = await loadConfigListeners(
      async () => client({ listConfigListeners: async () => Promise.reject(new Error('HTTP 501')) }),
      ref()
    );

    expect(loaded.listeners).toEqual([]);
    expect(loaded.listenersError).toBe('HTTP 501');
    expect(loaded.currentMd5).toBe(CURRENT_MD5);
  });

  it('answers an unwatched configuration with an empty list rather than an error', async () => {
    const loaded = await loadConfigListeners(async () => client({ listConfigListeners: async () => [] }), ref());

    expect(loaded).toEqual({ listeners: [], currentMd5: CURRENT_MD5 });
  });

  /** Nothing was reached, so both halves have to say so rather than one. */
  it('reports a connection that never happened on both halves', async () => {
    const loaded = await loadConfigListeners(async () => Promise.reject(new Error('connect ECONNREFUSED')), ref());

    expect(loaded.listenersError).toBe('connect ECONNREFUSED');
    expect(loaded.configError).toBe('connect ECONNREFUSED');
  });

  it('redacts a credential the failure quoted', async () => {
    const loaded = await loadConfigListeners(async () => {
      throw new Error('login failed: {"username":"nacos","password":"hunter2"}');
    }, ref());

    expect(loaded.listenersError).not.toContain('hunter2');
    expect(loaded.listenersError).toContain('[REDACTED]');
  });

  /**
   * A configuration whose detail carries no md5 is not a configuration whose
   * clients are all behind. The field is optional on the wire.
   */
  it('leaves the current md5 unknown when the server did not report one', async () => {
    const loaded = await loadConfigListeners(
      async () => client({ getConfig: async () => ({ ...ref(), content: 'a: 1\n' }) }),
      ref()
    );

    expect(loaded.currentMd5).toBeUndefined();
    expect(loaded.configError).toBeUndefined();
  });
});

describe('handleConfigListenersMessage', () => {
  interface TestPanel {
    webview: { html: string; postMessage(message: unknown): Promise<boolean> };
    dispose(): void;
  }

  function createPanel(): TestPanel {
    return { webview: { html: '', postMessage: async () => true }, dispose: () => undefined };
  }

  function asPanel(panel: TestPanel): Parameters<typeof handleConfigListenersMessage>[1] {
    return panel as unknown as Parameters<typeof handleConfigListenersMessage>[1];
  }

  function options(load: () => Promise<ConfigListenersSnapshot>): Parameters<typeof handleConfigListenersMessage>[2] {
    return {
      instanceLabel: 'prod',
      ref: ref(),
      load,
      renderDocument: (view: ConfigListenersView) => `<!DOCTYPE html>${view.body}`
    };
  }

  it('reads the server again and serves what came back', async () => {
    const panel = createPanel();
    const load = vi.fn(async () => snapshot({ listeners: [listener({ ip: '10.0.0.7' })] }));

    expect(await handleConfigListenersMessage({ type: 'refresh' }, asPanel(panel), options(load))).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(panel.webview.html).toContain('10.0.0.7');
  });

  it('leaves a message it does not own to whoever does', async () => {
    const load = vi.fn(async () => snapshot());
    const panel = asPanel(createPanel());

    expect(await handleConfigListenersMessage({ type: 'diff' }, panel, options(load))).toBe(false);
    expect(await handleConfigListenersMessage(undefined, panel, options(load))).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('renders a reload that threw instead of rejecting', async () => {
    const panel = createPanel();

    await expect(
      handleConfigListenersMessage({ type: 'refresh' }, asPanel(panel), options(async () => Promise.reject(new Error('boom'))))
    ).resolves.toBe(true);

    expect(panel.webview.html).toContain('boom');
  });
});

describe('ConfigListenersPanel.open', () => {
  const context = { extensionUri: vscode.Uri.file('/ext') } as unknown as vscode.ExtensionContext;

  function trackCreated(): vscode.WebviewPanel[] {
    const created: vscode.WebviewPanel[] = [];
    const createWebviewPanel = vscode.window.createWebviewPanel;
    vi.spyOn(vscode.window, 'createWebviewPanel').mockImplementation((viewType, title, showOptions, panelOptions) => {
      const panel = createWebviewPanel(viewType, title, showOptions, panelOptions);
      created.push(panel);
      return panel;
    });
    return created;
  }

  function open(overrides: Partial<Parameters<typeof ConfigListenersPanel.open>[1]> = {}): Promise<void> {
    return ConfigListenersPanel.open(context, {
      instance: { id: 'instance-1', label: 'prod' },
      ref: ref(),
      connect: async () =>
        ({
          listConfigListeners: async () => [listener({ ip: '10.0.0.1' })],
          getConfig: async () => ({ ...ref(), content: 'a: 1\n', md5: CURRENT_MD5 })
        }) as ConfigListenersClient,
      ...overrides
    });
  }

  it('serves the panel under the shared CSP, with the bundle, its stylesheet and its copy', async () => {
    const created = trackCreated();

    await open();

    const html = created[0]?.webview.html ?? '';
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('/ext/dist/webview/nacos-consumers.js');
    expect(html).toContain('/ext/webview/nacos-consumers/index.css');
    expect(html).toContain('id="atNacosStrings"');
    expect(html).toContain('10.0.0.1');
  });

  it('names the panel after the configuration it is showing', async () => {
    const created = trackCreated();

    await open();

    expect(created[0]?.title).toBe('Listeners: application-dev.yml');
  });

  it('reveals the panel a configuration already has rather than opening a second', async () => {
    const created = trackCreated();
    await open();
    const reveal = vi.spyOn(created[0] as vscode.WebviewPanel, 'reveal');

    await open();

    expect(created).toHaveLength(1);
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it('opens a panel of its own for another configuration', async () => {
    const created = trackCreated();

    await open();
    await open({ ref: ref({ dataId: 'application-uat.yml' }) });

    expect(created).toHaveLength(2);
  });

  /**
   * The history panel and this one are about the same configuration and are
   * not the same panel, so their keys must not collide.
   */
  it('does not collide with another kind of panel about the same configuration', async () => {
    const created = trackCreated();

    await open();
    await ConfigHistoryPanel.open(context, {
      instance: { id: 'instance-1', label: 'prod' },
      ref: ref(),
      connect: async () => ({ listConfigHistory: async () => ({ items: [], totalCount: 0, pageNumber: 1, pagesAvailable: 0 }) }) as never,
      openDiff: async () => undefined
    });

    expect(created).toHaveLength(2);
  });

  it('opens a panel that says what went wrong when the server cannot be reached', async () => {
    const created = trackCreated();

    await open({ connect: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.9:8848')) });

    expect(created[0]?.webview.html).toContain('connect ECONNREFUSED 10.0.0.9:8848');
  });
});

describe('localization', () => {
  it('routes every string it shows through a key the zh-cn bundle translates', async () => {
    const bundle = JSON.parse(readFileSync(resolve(process.cwd(), 'l10n/bundle.l10n.zh-cn.json'), 'utf8')) as Record<
      string,
      string
    >;
    const sources: string[] = [];
    vi.spyOn(vscode.l10n, 't').mockImplementation((messageOrOptions: string | { message: string }, ...args: never[]) => {
      const message = typeof messageOrOptions === 'string' ? messageOrOptions : messageOrOptions.message;
      sources.push(message);
      return translate(message, ...args);
    });

    renderConfigListeners({ instanceLabel: 'prod', ref: ref() });
    renderConfigListeners({ instanceLabel: 'prod', ref: ref(), snapshot: snapshot() });
    renderConfigListeners({ instanceLabel: 'prod', ref: ref(), snapshot: { listeners: [], currentMd5: CURRENT_MD5 } });
    renderConfigListeners({
      instanceLabel: 'prod',
      ref: ref(),
      snapshot: { listeners: [listener({ md5: OLDER_MD5 })], currentMd5: CURRENT_MD5 }
    });
    renderConfigListeners({
      instanceLabel: 'prod',
      ref: ref(),
      snapshot: { listeners: [listener()], listenersError: 'x', configError: 'y' }
    });

    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(Object.keys(bundle), source).toContain(source);
    }
  });
});
