import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { NacosConfigHistoryEntry, NacosConfigRef } from '../../src/nacos/driver/normalize';
import {
  ConfigHistoryPanel,
  handleConfigHistoryMessage,
  loadConfigHistory,
  renderConfigHistory,
  type ConfigHistoryClient,
  type ConfigHistorySnapshot,
  type ConfigHistoryView
} from '../../src/webview/ConfigHistoryPanel';
import { renderWebviewHtml } from '../../src/webview/html';
import { disposeOpenPanels } from '../../src/webview/openPanels';

const translate = vscode.l10n.t.bind(vscode.l10n);

beforeEach(() => {
  vi.restoreAllMocks();
  disposeOpenPanels();
});

function ref(overrides: Partial<NacosConfigRef> = {}): NacosConfigRef {
  return { namespaceId: 'cl-parent', group: 'cl-intimfy', dataId: 'application-dev.yml', ...overrides };
}

/**
 * One history row with every optional field filled.
 *
 * **Fixture only.** The server this milestone was written against has never
 * republished a configuration, so no row of this shape has ever been
 * measured -- see architecture §14.8 ㉗. The field names come from Nacos's
 * `ConfigHistoryInfo`, and the milliseconds are what `normalizeConfigHistoryEntry`
 * produces from either of the two wire spellings.
 */
function entry(overrides: Partial<NacosConfigHistoryEntry> = {}): NacosConfigHistoryEntry {
  return {
    ...ref(),
    id: '1044',
    opType: 'U',
    modifiedAt: Date.parse('2026-08-14T02:03:04Z'),
    srcIp: '192.168.66.9',
    srcUser: 'nacos',
    ...overrides
  };
}

function snapshot(overrides: Partial<ConfigHistorySnapshot> = {}): ConfigHistorySnapshot {
  return { entries: [entry()], totalCount: 1, ...overrides };
}

function bodyOf(current?: ConfigHistorySnapshot): string {
  return renderConfigHistory({ instanceLabel: 'prod', ref: ref(), snapshot: current }).body;
}

/** The document the panel serves, so an assertion can be made about the whole page. */
function documentOf(view: ConfigHistoryView): string {
  return renderWebviewHtml(
    { cspSource: 'vscode-webview:', asWebviewUri: (uri: unknown) => uri } as never,
    { script: vscode.Uri.file('/ext/dist/webview/nacos-config-history.js') } as never,
    view.body,
    view.data
  );
}

describe('renderConfigHistory, the version table', () => {
  it('renders every field a version reported', () => {
    const body = bodyOf(snapshot());

    expect(body).toContain('1044');
    expect(body).toContain('192.168.66.9');
    expect(body).toContain('nacos');
    // Local time, so the exact string depends on the machine's zone; that it
    // is a timestamp at all is what this asserts.
    expect(body).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  });

  /**
   * The three operations Nacos records, written out. `U` in a column of its
   * own is a database letter, not a sentence -- and this is the column an
   * operator scans to find the publish that broke something.
   */
  it.each([
    ['I', 'created'],
    ['U', 'updated'],
    ['D', 'deleted']
  ])('writes the %s operation out as %s', (opType, expected) => {
    expect(bodyOf(snapshot({ entries: [entry({ opType })] }))).toContain(expected);
  });

  /**
   * The same discipline the cluster panel's state badge follows: a value from
   * some later Nacos is still the server's answer, and calling it one of the
   * three we know would report an operation nobody performed.
   */
  it('renders an operation it does not know as itself', () => {
    expect(bodyOf(snapshot({ entries: [entry({ opType: 'X' })] }))).toContain('>X<');
  });

  it('says a field was not reported rather than rendering undefined', () => {
    const body = bodyOf(
      snapshot({ entries: [{ ...ref(), id: '1044', opType: 'U' }] })
    );

    expect(body).not.toContain('undefined');
    expect(body.match(/not reported/g)).toHaveLength(3);
  });

  it('renders one row per version', () => {
    const body = bodyOf(
      snapshot({
        entries: [entry({ id: '1046' }), entry({ id: '1045' }), entry({ id: '1044' })],
        totalCount: 3
      })
    );

    expect(body.match(/class="version-row"/g)).toHaveLength(3);
  });

  /** Every row offers the one action a history panel exists for. */
  it('gives each version a control carrying the id the diff is fetched by', () => {
    const body = bodyOf(snapshot({ entries: [entry({ id: '1046' }), entry({ id: '1044' })], totalCount: 2 }));

    expect(body).toContain('data-version-id="1046"');
    expect(body).toContain('data-version-id="1044"');
  });

  /**
   * The common case on a server nobody has republished on, and the one this
   * milestone's live server is in: empty is not a failure, and a table with a
   * header and no rows says nothing about why.
   */
  it('explains an empty history instead of drawing a table with no rows', () => {
    const body = bodyOf({ entries: [], totalCount: 0 });

    expect(body).not.toContain('<table');
    expect(body).toContain('no history');
  });

  /**
   * The history endpoint is the one paged endpoint Nacos clamps server-side,
   * and this panel asks for a single page. A user reading fifty rows as the
   * whole history would conclude a change was never made.
   */
  it('says so when the page it drew is only part of the history', () => {
    const body = bodyOf({ entries: [entry(), entry({ id: '1043' })], totalCount: 137 });

    expect(body).toContain('most recent');
    expect(body).toContain('137');
  });

  it('says nothing about paging when the page is the whole history', () => {
    expect(bodyOf(snapshot())).not.toContain('most recent');
  });

  it('names the configuration, its group and the instance it belongs to', () => {
    const body = bodyOf(snapshot());

    expect(body).toContain('application-dev.yml');
    expect(body).toContain('cl-intimfy');
    expect(body).toContain('prod');
  });

  it('says the panel is still loading before the first fetch answers', () => {
    const body = renderConfigHistory({ instanceLabel: 'prod', ref: ref() }).body;

    expect(body).toContain('Loading');
    expect(body).not.toContain('not reported');
  });

  it('reports a listing that failed, rather than showing an empty history', () => {
    const body = bodyOf({ entries: [], totalCount: 0, error: 'HTTP 403' });

    expect(body).toContain('HTTP 403');
    expect(body).not.toContain('no history');
  });

  it('escapes a source user that tries to open a tag of its own', () => {
    const hostile = '"><script>alert(1)</script>';
    const view = renderConfigHistory({
      instanceLabel: hostile,
      ref: ref({ dataId: hostile }),
      snapshot: snapshot({ entries: [entry({ srcUser: hostile, srcIp: hostile, opType: hostile })] })
    });

    expect(view.body).not.toContain('<script>alert(1)');
    expect(view.body).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    // The data block and the bundle, and nothing a row smuggled in.
    expect(documentOf(view).match(/<\/script>/g)).toHaveLength(2);
  });

  it('escapes a version id, which reaches the page as an attribute', () => {
    const view = renderConfigHistory({
      instanceLabel: 'prod',
      ref: ref(),
      snapshot: snapshot({ entries: [entry({ id: '" onmouseover="alert(1)' })] })
    });

    expect(view.body).not.toContain('onmouseover="alert(1)"');
    expect(view.body).toContain('&quot; onmouseover=&quot;alert(1)');
  });

  it('hands the page the copy it renders at runtime', () => {
    const { data } = renderConfigHistory({ instanceLabel: 'prod', ref: ref(), snapshot: snapshot() });

    expect(data.atNacosStrings).toMatchObject({ refresh: 'Refresh', refreshing: 'Refreshing...' });
  });

  it('gives the page a refresh button to post from', () => {
    expect(bodyOf(snapshot())).toContain('id="refreshButton"');
  });
});

describe('loadConfigHistory', () => {
  function client(overrides: Partial<Record<keyof ConfigHistoryClient, unknown>> = {}): ConfigHistoryClient {
    return {
      listConfigHistory: async () => ({ items: [entry()], totalCount: 1, pageNumber: 1, pagesAvailable: 1 }),
      ...overrides
    } as ConfigHistoryClient;
  }

  it('reads the first page of the history of the configuration it was given', async () => {
    const asked: unknown[] = [];

    const loaded = await loadConfigHistory(
      async () =>
        client({
          listConfigHistory: async (query: unknown) => {
            asked.push(query);
            return { items: [entry()], totalCount: 1, pageNumber: 1, pagesAvailable: 1 };
          }
        }),
      ref()
    );

    expect(asked).toEqual([{ ...ref(), pageNo: 1, pageSize: 100 }]);
    expect(loaded).toEqual({ entries: [entry()], totalCount: 1 });
  });

  /**
   * Empty is the ordinary state of a configuration nobody has republished, so
   * it has to arrive as an empty snapshot rather than as an error -- the panel
   * has different copy for the two, and only one of them is worth alarming a
   * user about.
   */
  it('answers an empty history with an empty snapshot rather than an error', async () => {
    const loaded = await loadConfigHistory(
      async () => client({ listConfigHistory: async () => ({ items: [], totalCount: 0, pageNumber: 1, pagesAvailable: 0 }) }),
      ref()
    );

    expect(loaded).toEqual({ entries: [], totalCount: 0 });
  });

  it('turns a listing that failed into copy rather than a rejection', async () => {
    const loaded = await loadConfigHistory(
      async () => client({ listConfigHistory: async () => Promise.reject(new Error('HTTP 403')) }),
      ref()
    );

    expect(loaded).toEqual({ entries: [], totalCount: 0, error: 'HTTP 403' });
  });

  it('reports a connection that never happened', async () => {
    const loaded = await loadConfigHistory(async () => Promise.reject(new Error('connect ECONNREFUSED')), ref());

    expect(loaded.error).toBe('connect ECONNREFUSED');
  });

  it('redacts a credential the failure quoted', async () => {
    const loaded = await loadConfigHistory(async () => {
      throw new Error('login failed: {"username":"nacos","password":"hunter2"}');
    }, ref());

    expect(loaded.error).not.toContain('hunter2');
    expect(loaded.error).toContain('[REDACTED]');
  });
});

describe('handleConfigHistoryMessage', () => {
  interface TestPanel {
    webview: { html: string; postMessage(message: unknown): Promise<boolean> };
    dispose(): void;
  }

  function createPanel(): TestPanel {
    return {
      webview: { html: '', postMessage: async () => true },
      dispose: () => undefined
    };
  }

  function asPanel(panel: TestPanel): Parameters<typeof handleConfigHistoryMessage>[1] {
    return panel as unknown as Parameters<typeof handleConfigHistoryMessage>[1];
  }

  function options(
    overrides: Partial<Parameters<typeof handleConfigHistoryMessage>[2]> = {}
  ): Parameters<typeof handleConfigHistoryMessage>[2] {
    return {
      instanceLabel: 'prod',
      ref: ref(),
      load: async () => snapshot(),
      renderDocument: (view: ConfigHistoryView) => `<!DOCTYPE html>${view.body}`,
      shownVersions: () => [entry()],
      openDiff: async () => undefined,
      ...overrides
    };
  }

  it('reads the server again and serves what came back', async () => {
    const panel = createPanel();
    const load = vi.fn(async () => snapshot({ entries: [entry({ srcIp: '10.0.0.7' })] }));

    const handled = await handleConfigHistoryMessage({ type: 'refresh' }, asPanel(panel), options({ load }));

    expect(handled).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(panel.webview.html).toContain('10.0.0.7');
  });

  it('diffs the version the page named against the current content', async () => {
    const openDiff = vi.fn(async () => undefined);

    const handled = await handleConfigHistoryMessage(
      { type: 'diff', id: '1044' },
      asPanel(createPanel()),
      options({ openDiff })
    );

    expect(handled).toBe(true);
    expect(openDiff).toHaveBeenCalledWith(entry());
  });

  /**
   * A page can post anything at all, and the id it posts becomes an `nid` in
   * a request to the server. Answering only for versions this panel actually
   * drew is what keeps a compromised page from using the extension host as a
   * cursor over someone else's history.
   */
  it('ignores a version id the panel is not showing', async () => {
    const openDiff = vi.fn(async () => undefined);

    const handled = await handleConfigHistoryMessage(
      { type: 'diff', id: '9999' },
      asPanel(createPanel()),
      options({ openDiff })
    );

    expect(handled).toBe(true);
    expect(openDiff).not.toHaveBeenCalled();
  });

  it.each([[{ type: 'diff' }], [{ type: 'diff', id: 1044 }], [{ type: 'diff', id: '' }]])(
    'ignores the malformed diff message %j',
    async (message) => {
      const openDiff = vi.fn(async () => undefined);

      await handleConfigHistoryMessage(message, asPanel(createPanel()), options({ openDiff }));

      expect(openDiff).not.toHaveBeenCalled();
    }
  );

  it('leaves a message it does not own to whoever does', async () => {
    const load = vi.fn(async () => snapshot());
    const panel = asPanel(createPanel());

    expect(await handleConfigHistoryMessage({ type: 'submit' }, panel, options({ load }))).toBe(false);
    expect(await handleConfigHistoryMessage(undefined, panel, options({ load }))).toBe(false);
    expect(await handleConfigHistoryMessage('refresh', panel, options({ load }))).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('renders a reload that threw instead of rejecting', async () => {
    const panel = createPanel();

    await expect(
      handleConfigHistoryMessage(
        { type: 'refresh' },
        asPanel(panel),
        options({ load: async () => Promise.reject(new Error('boom')) })
      )
    ).resolves.toBe(true);

    expect(panel.webview.html).toContain('boom');
  });

  /**
   * The diff is opened by the extension host, which can refuse -- and a
   * rejection out of a message handler is an unhandled promise with a panel
   * left silent in front of it.
   */
  it('renders a diff that could not be opened rather than rejecting', async () => {
    const panel = createPanel();

    await expect(
      handleConfigHistoryMessage(
        { type: 'diff', id: '1044' },
        asPanel(panel),
        options({ openDiff: async () => Promise.reject(new Error('no editor group available')) })
      )
    ).resolves.toBe(true);
  });
});

describe('ConfigHistoryPanel.open', () => {
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

  function connect(): Promise<ConfigHistoryClient> {
    return Promise.resolve({
      listConfigHistory: async () => ({ items: [entry()], totalCount: 1, pageNumber: 1, pagesAvailable: 1 })
    } as ConfigHistoryClient);
  }

  function open(overrides: Partial<Parameters<typeof ConfigHistoryPanel.open>[1]> = {}): Promise<void> {
    return ConfigHistoryPanel.open(context, {
      instance: { id: 'instance-1', label: 'prod' },
      ref: ref(),
      connect,
      openDiff: async () => undefined,
      ...overrides
    });
  }

  it('serves the panel under the shared CSP, with the bundle, its stylesheet and its copy', async () => {
    const created = trackCreated();

    await open();

    const html = created[0]?.webview.html ?? '';
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('/ext/dist/webview/nacos-config-history.js');
    expect(html).toContain('/ext/webview/nacos-config-history/index.css');
    expect(html).toContain('id="atNacosStrings"');
    expect(html).toContain('1044');
  });

  it('names the panel after the configuration it is showing', async () => {
    const created = trackCreated();

    await open();

    expect(created[0]?.title).toBe('History: application-dev.yml');
  });

  it('reveals the panel a configuration already has rather than opening a second', async () => {
    const created = trackCreated();
    await open();
    const reveal = vi.spyOn(created[0] as vscode.WebviewPanel, 'reveal');

    await open();

    expect(created).toHaveLength(1);
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  /**
   * Two configurations of one instance, and the same configuration in two
   * namespaces, are different things to show -- the panel key carries the
   * whole address for the same reason the document URI does.
   */
  it.each([
    ['another dataId', { ref: ref({ dataId: 'application-uat.yml' }) }],
    ['another namespace', { ref: ref({ namespaceId: 'cl-parent-offline' }) }],
    ['another group', { ref: ref({ group: 'other' }) }],
    ['another instance', { instance: { id: 'instance-2', label: 'uat' } }]
  ])('opens a panel of its own for %s', async (_case, overrides) => {
    const created = trackCreated();

    await open();
    await open(overrides);

    expect(created).toHaveLength(2);
  });

  it('opens a panel that says what went wrong when the server cannot be reached', async () => {
    const created = trackCreated();

    await open({ connect: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.9:8848')) });

    expect(created[0]?.webview.html).toContain('connect ECONNREFUSED 10.0.0.9:8848');
  });

  it('closes with every other panel when the extension shuts down', async () => {
    const created = trackCreated();
    await open();
    const disposed = vi.spyOn(created[0] as vscode.WebviewPanel, 'dispose');

    disposeOpenPanels();

    expect(disposed).toHaveBeenCalledTimes(1);
  });

  /** The page can only ask to diff a version the panel drew, so the panel has to remember what it drew. */
  it('diffs a version the page names after the panel has rendered it', async () => {
    const created = trackCreated();
    const openDiff = vi.fn(async () => undefined);
    await open({ openDiff });

    await postToPanel(created[0], { type: 'diff', id: '1044' });

    expect(openDiff).toHaveBeenCalledWith(entry());
  });
});

/** Delivers a message as the page would, to whatever handler `open()` wired up. */
async function postToPanel(panel: vscode.WebviewPanel | undefined, message: unknown): Promise<void> {
  const webview = panel?.webview as unknown as { __fireMessage(message: unknown): Promise<void> };
  await webview.__fireMessage(message);
}

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

    renderConfigHistory({ instanceLabel: 'prod', ref: ref() });
    renderConfigHistory({ instanceLabel: 'prod', ref: ref(), snapshot: snapshot() });
    renderConfigHistory({ instanceLabel: 'prod', ref: ref(), snapshot: { entries: [], totalCount: 0 } });
    renderConfigHistory({
      instanceLabel: 'prod',
      ref: ref(),
      snapshot: { entries: [{ ...ref(), id: '1', opType: 'D' }, entry({ opType: 'I' })], totalCount: 99 }
    });
    renderConfigHistory({ instanceLabel: 'prod', ref: ref(), snapshot: { entries: [], totalCount: 0, error: 'x' } });

    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(Object.keys(bundle), source).toContain(source);
    }
  });
});
