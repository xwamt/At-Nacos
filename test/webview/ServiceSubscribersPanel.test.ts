import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { NacosServiceRef, NacosSubscriber } from '../../src/nacos/driver/normalize';
import { renderWebviewHtml } from '../../src/webview/html';
import { disposeOpenPanels } from '../../src/webview/openPanels';
import {
  ServiceSubscribersPanel,
  handleServiceSubscribersMessage,
  loadServiceSubscribers,
  renderServiceSubscribers,
  type ServiceSubscribersClient,
  type ServiceSubscribersSnapshot,
  type ServiceSubscribersView
} from '../../src/webview/ServiceSubscribersPanel';

const translate = vscode.l10n.t.bind(vscode.l10n);

beforeEach(() => {
  vi.restoreAllMocks();
  disposeOpenPanels();
});

function ref(overrides: Partial<NacosServiceRef> = {}): NacosServiceRef {
  return { namespaceId: 'cl-parent-offline', group: 'cl-intimfy', serviceName: 'cl-auth-offline', ...overrides };
}

/**
 * One subscriber, as a real Nacos 2.3.2 answered on 2026-08-14: a gRPC client
 * with no callback port, no cluster, and the group folded into the service
 * name on the wire (already split off here).
 */
function subscriber(overrides: Partial<NacosSubscriber> = {}): NacosSubscriber {
  return {
    ...ref(),
    ip: '192.168.99.92',
    port: 0,
    agent: 'Nacos-Java-Client:v2.3.2',
    app: 'unknown',
    ...overrides
  };
}

function snapshot(overrides: Partial<ServiceSubscribersSnapshot> = {}): ServiceSubscribersSnapshot {
  return { subscribers: [subscriber()], ...overrides };
}

function bodyOf(current?: ServiceSubscribersSnapshot): string {
  return renderServiceSubscribers({ instanceLabel: 'prod', ref: ref(), snapshot: current }).body;
}

function documentOf(view: ServiceSubscribersView): string {
  return renderWebviewHtml(
    { cspSource: 'vscode-webview:', asWebviewUri: (uri: unknown) => uri } as never,
    { script: vscode.Uri.file('/ext/dist/webview/nacos-consumers.js') } as never,
    view.body,
    view.data
  );
}

describe('renderServiceSubscribers, the subscriber table', () => {
  it('renders every field a subscriber reported', () => {
    const body = bodyOf(snapshot());

    expect(body).toContain('192.168.99.92');
    expect(body).toContain('Nacos-Java-Client:v2.3.2');
    expect(body).toContain('unknown');
  });

  /**
   * `cl-merchant-server-offline` on the live server has two, which is what
   * makes the multi-row branch verifiable at all (§14.8 ⑥).
   */
  it('renders one row per subscriber', () => {
    const body = bodyOf(
      snapshot({ subscribers: [subscriber(), subscriber({ ip: '192.168.66.124' })] })
    );

    expect(body.match(/class="subscriber-row"/g)).toHaveLength(2);
    expect(body).toContain('192.168.66.124');
  });

  /**
   * Port 0 is the ordinary case, not a missing value: every gRPC subscriber
   * reports it, and every subscriber on a 2.x server is one. Rendering
   * `192.168.99.92:0` would look like a bug in this panel.
   */
  it('says a gRPC subscriber has no callback port rather than writing port zero', () => {
    const body = bodyOf(snapshot());

    expect(body).not.toContain(':0');
    expect(body).not.toContain('>0<');
    expect(body).toContain('none');
  });

  it('renders a callback port a subscriber does report', () => {
    expect(bodyOf(snapshot({ subscribers: [subscriber({ port: 8080 })] }))).toContain('8080');
  });

  it('says a field was not reported rather than rendering undefined', () => {
    const body = bodyOf(snapshot({ subscribers: [{ ...ref(), ip: '10.0.0.1', port: 0 }] }));

    expect(body).not.toContain('undefined');
    expect(body).toContain('not reported');
  });

  it('explains an empty subscriber list instead of drawing a table with no rows', () => {
    const body = bodyOf({ subscribers: [] });

    expect(body).not.toContain('<table');
    expect(body).toContain('no client');
  });

  it('reports a listing that failed rather than showing no subscribers', () => {
    const body = bodyOf({ subscribers: [], error: 'HTTP 500' });

    expect(body).toContain('HTTP 500');
    expect(body).not.toContain('no client');
  });

  it('says the panel is still loading before the first fetch answers', () => {
    expect(renderServiceSubscribers({ instanceLabel: 'prod', ref: ref() }).body).toContain('Loading');
  });

  it('names the service, its group and the instance it belongs to', () => {
    const body = bodyOf(snapshot());

    expect(body).toContain('cl-auth-offline');
    expect(body).toContain('cl-intimfy');
    expect(body).toContain('prod');
  });

  it('escapes a client agent that tries to open a tag of its own', () => {
    const hostile = '"><script>alert(1)</script>';
    const view = renderServiceSubscribers({
      instanceLabel: hostile,
      ref: ref({ serviceName: hostile }),
      snapshot: snapshot({ subscribers: [subscriber({ agent: hostile, app: hostile, cluster: hostile })] })
    });

    expect(view.body).not.toContain('<script>alert(1)');
    expect(documentOf(view).match(/<\/script>/g)).toHaveLength(2);
  });

  it('gives the page a refresh button to post from', () => {
    expect(bodyOf(snapshot())).toContain('id="refreshButton"');
  });
});

describe('loadServiceSubscribers', () => {
  it('reads the subscribers of the service it was given', async () => {
    const asked: unknown[] = [];

    const loaded = await loadServiceSubscribers(
      async () =>
        ({
          listSubscribers: async (target: unknown) => {
            asked.push(target);
            return [subscriber()];
          }
        }) as ServiceSubscribersClient,
      ref()
    );

    expect(asked).toEqual([ref()]);
    expect(loaded).toEqual({ subscribers: [subscriber()] });
  });

  /**
   * A service nobody is watching -- and a service nobody registered --
   * answers `{"subscribers":[],"count":0}` under HTTP 200. Neither is a
   * failure (§14.8 ⑥).
   */
  it('answers an unwatched service with an empty list rather than an error', async () => {
    const loaded = await loadServiceSubscribers(
      async () => ({ listSubscribers: async () => [] }) as ServiceSubscribersClient,
      ref()
    );

    expect(loaded).toEqual({ subscribers: [] });
  });

  it('turns a listing that failed into copy rather than a rejection', async () => {
    const loaded = await loadServiceSubscribers(
      async () => ({ listSubscribers: async () => Promise.reject(new Error('HTTP 501')) }) as ServiceSubscribersClient,
      ref()
    );

    expect(loaded).toEqual({ subscribers: [], error: 'HTTP 501' });
  });

  it('redacts a credential the failure quoted', async () => {
    const loaded = await loadServiceSubscribers(async () => {
      throw new Error('login failed: {"username":"nacos","password":"hunter2"}');
    }, ref());

    expect(loaded.error).not.toContain('hunter2');
    expect(loaded.error).toContain('[REDACTED]');
  });
});

describe('handleServiceSubscribersMessage', () => {
  interface TestPanel {
    webview: { html: string; postMessage(message: unknown): Promise<boolean> };
    dispose(): void;
  }

  function createPanel(): TestPanel {
    return { webview: { html: '', postMessage: async () => true }, dispose: () => undefined };
  }

  function asPanel(panel: TestPanel): Parameters<typeof handleServiceSubscribersMessage>[1] {
    return panel as unknown as Parameters<typeof handleServiceSubscribersMessage>[1];
  }

  function options(
    load: () => Promise<ServiceSubscribersSnapshot>
  ): Parameters<typeof handleServiceSubscribersMessage>[2] {
    return {
      instanceLabel: 'prod',
      ref: ref(),
      load,
      renderDocument: (view: ServiceSubscribersView) => `<!DOCTYPE html>${view.body}`
    };
  }

  it('reads the server again and serves what came back', async () => {
    const panel = createPanel();
    const load = vi.fn(async () => snapshot({ subscribers: [subscriber({ ip: '10.0.0.7' })] }));

    expect(await handleServiceSubscribersMessage({ type: 'refresh' }, asPanel(panel), options(load))).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(panel.webview.html).toContain('10.0.0.7');
  });

  it('leaves a message it does not own to whoever does', async () => {
    const load = vi.fn(async () => snapshot());

    expect(await handleServiceSubscribersMessage({ type: 'diff' }, asPanel(createPanel()), options(load))).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('renders a reload that threw instead of rejecting', async () => {
    const panel = createPanel();

    await expect(
      handleServiceSubscribersMessage(
        { type: 'refresh' },
        asPanel(panel),
        options(async () => Promise.reject(new Error('boom')))
      )
    ).resolves.toBe(true);

    expect(panel.webview.html).toContain('boom');
  });
});

describe('ServiceSubscribersPanel.open', () => {
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

  function open(overrides: Partial<Parameters<typeof ServiceSubscribersPanel.open>[1]> = {}): Promise<void> {
    return ServiceSubscribersPanel.open(context, {
      instance: { id: 'instance-1', label: 'prod' },
      ref: ref(),
      connect: async () => ({ listSubscribers: async () => [subscriber()] }) as ServiceSubscribersClient,
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
    expect(html).toContain('192.168.99.92');
  });

  it('names the panel after the service it is showing', async () => {
    const created = trackCreated();

    await open();

    expect(created[0]?.title).toBe('Subscribers: cl-auth-offline');
  });

  it('reveals the panel a service already has rather than opening a second', async () => {
    const created = trackCreated();
    await open();
    const reveal = vi.spyOn(created[0] as vscode.WebviewPanel, 'reveal');

    await open();

    expect(created).toHaveLength(1);
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  /** The same service name in two groups is two services. */
  it.each([
    ['another service', { ref: ref({ serviceName: 'cl-merchant-server-offline' }) }],
    ['another group', { ref: ref({ group: 'DEFAULT_GROUP' }) }],
    ['another namespace', { ref: ref({ namespaceId: 'cl-parent' }) }]
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

    renderServiceSubscribers({ instanceLabel: 'prod', ref: ref() });
    renderServiceSubscribers({ instanceLabel: 'prod', ref: ref(), snapshot: snapshot() });
    renderServiceSubscribers({ instanceLabel: 'prod', ref: ref(), snapshot: { subscribers: [] } });
    renderServiceSubscribers({
      instanceLabel: 'prod',
      ref: ref(),
      snapshot: { subscribers: [{ ...ref(), ip: '10.0.0.1', port: 9090 }] }
    });
    renderServiceSubscribers({ instanceLabel: 'prod', ref: ref(), snapshot: { subscribers: [], error: 'x' } });

    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(Object.keys(bundle), source).toContain(source);
    }
  });
});
