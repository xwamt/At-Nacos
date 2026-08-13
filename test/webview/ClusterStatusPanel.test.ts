import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { NacosClusterNode, NacosServerMetrics } from '../../src/nacos/driver/normalize';
import {
  ClusterStatusPanel,
  handleClusterStatusMessage,
  loadClusterStatus,
  renderClusterStatus,
  type ClusterStatusClient,
  type ClusterStatusSnapshot,
  type ClusterStatusView
} from '../../src/webview/ClusterStatusPanel';
import { renderWebviewHtml } from '../../src/webview/html';
import { disposeOpenPanels } from '../../src/webview/openPanels';

const translate = vscode.l10n.t.bind(vscode.l10n);

beforeEach(() => {
  vi.restoreAllMocks();
  disposeOpenPanels();
});

/**
 * The node a real Nacos 2.3.2 answered with on 2026-08-14, normalized. Every
 * optional field is filled, which is what makes it the fixture for "the whole
 * shape" -- the ones below take it apart.
 */
function liveNode(overrides: Partial<NacosClusterNode> = {}): NacosClusterNode {
  return {
    address: '172.25.0.2:8848',
    ip: '172.25.0.2',
    port: 8848,
    state: 'UP',
    version: '2.3.2',
    raftPort: '7848',
    failAccessCnt: 0,
    raftGroups: [
      { group: 'naming_instance_metadata', leader: '172.25.0.2:7848', members: ['172.25.0.2:7848'], term: 1 },
      { group: 'naming_persistent_service_v2', leader: '172.25.0.2:7848', members: ['172.25.0.2:7848'], term: 1 },
      { group: 'naming_service_metadata', leader: '172.25.0.2:7848', members: ['172.25.0.2:7848'], term: 1 }
    ],
    ...overrides
  };
}

/** What `/v1/ns/operator/metrics?onlyStatus=false` answered on that same server. */
function liveMetrics(overrides: Partial<NacosServerMetrics> = {}): NacosServerMetrics {
  return {
    status: 'UP',
    serviceCount: 13,
    instanceCount: 13,
    subscribeCount: 38,
    clientCount: 13,
    cpu: 0.12,
    load: 4.68,
    mem: 1,
    ...overrides
  };
}

function liveSnapshot(overrides: Partial<ClusterStatusSnapshot> = {}): ClusterStatusSnapshot {
  return { nodes: [liveNode()], metrics: liveMetrics(), ...overrides };
}

function bodyOf(snapshot?: ClusterStatusSnapshot): string {
  return renderClusterStatus({ instanceLabel: 'prod', snapshot }).body;
}

/** The document the panel serves, so an assertion can be made about the whole page. */
function documentOf(view: ClusterStatusView): string {
  return renderWebviewHtml(
    { cspSource: 'vscode-webview:', asWebviewUri: (uri: unknown) => uri } as never,
    { script: vscode.Uri.file('/ext/dist/webview/nacos-cluster-status.js') } as never,
    view.body,
    view.data
  );
}

describe('renderClusterStatus, the node table', () => {
  it('renders every field a node in full reported', () => {
    const body = bodyOf(liveSnapshot());

    expect(body).toContain('172.25.0.2:8848');
    expect(body).toContain('>UP<');
    expect(body).toContain('2.3.2');
    expect(body).toContain('7848');
    expect(body).toContain('naming_persistent_service_v2');
    expect(body).toContain('172.25.0.2:7848');
  });

  it('renders the raft group each node takes part in, with its term and members', () => {
    const body = bodyOf({
      nodes: [
        liveNode({
          raftGroups: [
            {
              group: 'naming_persistent_service_v2',
              leader: '10.0.0.1:7848',
              members: ['10.0.0.1:7848', '10.0.0.2:7848', '10.0.0.3:7848'],
              term: 7
            }
          ]
        })
      ]
    });

    expect(body).toContain('naming_persistent_service_v2');
    expect(body).toContain('10.0.0.2:7848');
    expect(body).toContain('10.0.0.3:7848');
    expect(body).toContain('>7<');
  });

  /**
   * Everything but `address` and `state` is optional on the wire, and a panel
   * that writes `undefined` into a cell has turned a server that did not
   * answer into a server that answered nonsense.
   */
  it('says a field was not reported rather than rendering undefined', () => {
    const body = bodyOf({
      nodes: [
        {
          address: '10.0.0.1:8848',
          ip: '10.0.0.1',
          port: 8848,
          state: 'UP'
        }
      ]
    });

    expect(body).toContain('10.0.0.1:8848');
    expect(body).not.toContain('undefined');
    expect(body).toContain('not reported');
  });

  it('offers no raft expansion for a node that named no raft group', () => {
    // An expander that opens onto nothing reads as a panel that failed to load
    // the detail, so the row keeps its address and loses only the control.
    expect(bodyOf({ nodes: [liveNode()] })).toContain('node-toggle');
    for (const raftGroups of [undefined, []]) {
      const body = bodyOf({ nodes: [liveNode({ raftGroups })] });
      expect(body).toContain('172.25.0.2:8848');
      expect(body).not.toContain('node-toggle');
    }
  });

  it('explains an empty cluster instead of drawing a table with no rows', () => {
    const body = bodyOf({ nodes: [] });

    expect(body).not.toContain('<table');
    expect(body).toContain('Nacos reported no cluster node');
  });

  it('renders one row per node of a multi-node cluster', () => {
    const body = bodyOf({
      nodes: [
        liveNode({ address: '10.0.0.1:8848', ip: '10.0.0.1', state: 'UP' }),
        liveNode({ address: '10.0.0.2:8848', ip: '10.0.0.2', state: 'SUSPICIOUS' }),
        liveNode({ address: '10.0.0.3:8848', ip: '10.0.0.3', state: 'DOWN' })
      ]
    });

    expect(body.match(/class="node-summary"/g)).toHaveLength(3);
    expect(body).toContain('10.0.0.1:8848');
    expect(body).toContain('10.0.0.2:8848');
    expect(body).toContain('10.0.0.3:8848');
  });

  /**
   * Nacos has five node states, not the up/down pair the word "health"
   * suggests. Collapsing `STARTING`, `SUSPICIOUS` and `ISOLATION` into either
   * end would report a node as fine while it is joining, or as dead while it
   * is only suspected.
   */
  it.each([
    ['STARTING', 'state-starting'],
    ['UP', 'state-up'],
    ['SUSPICIOUS', 'state-suspicious'],
    ['DOWN', 'state-down'],
    ['ISOLATION', 'state-isolation']
  ])('gives the %s state a style of its own', (state, className) => {
    const body = bodyOf({ nodes: [liveNode({ state })] });

    expect(body).toContain(`state-badge ${className}`);
    expect(body).toContain(`>${state}<`);
  });

  it('renders a state from some later Nacos as itself, in the unknown style', () => {
    // `normalizeClusterNode` carries the state verbatim precisely so that a
    // sixth value is still the server's answer. Dropping it here would undo
    // that at the last step.
    const body = bodyOf({ nodes: [liveNode({ state: 'QUARANTINED' })] });

    expect(body).toContain('state-badge state-unknown');
    expect(body).toContain('>QUARANTINED<');
  });

  it('escapes a state that tries to open a tag of its own', () => {
    const hostile = '"><script>alert(1)</script>';
    const view = renderClusterStatus({ instanceLabel: 'prod', snapshot: { nodes: [liveNode({ state: hostile })] } });

    expect(view.body).not.toContain('<script>alert(1)');
    expect(view.body).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    // The data block and the bundle, and nothing the node smuggled in.
    expect(documentOf(view).match(/<\/script>/g)).toHaveLength(2);
  });

  it('escapes an address, a version and a raft group the same way', () => {
    const hostile = '"><img src=x onerror=alert(1)>';
    const view = renderClusterStatus({
      instanceLabel: hostile,
      snapshot: {
        nodes: [
          liveNode({
            address: hostile,
            version: hostile,
            raftGroups: [{ group: hostile, leader: hostile, members: [hostile], term: 1 }]
          })
        ]
      }
    });

    expect(view.body).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(view.body).not.toContain('<img src=x');
    expect(documentOf(view)).not.toContain('<img src=x');
  });
});

describe('renderClusterStatus, the server metrics', () => {
  it('renders every metric the server reported', () => {
    const body = bodyOf(liveSnapshot());

    expect(body).toContain('>13<');
    expect(body).toContain('>38<');
    expect(body).toContain('>0.12<');
    expect(body).toContain('>4.68<');
  });

  /**
   * Every count is optional: without `onlyStatus=false` the server answers
   * `{"status":"UP"}` and nothing else (§14.5 ⑧), and that is a server
   * answering, not a server broken.
   */
  it('says a metric was not reported rather than rendering undefined', () => {
    const body = bodyOf({ nodes: [liveNode()], metrics: { status: 'UP' } });

    expect(body).not.toContain('undefined');
    expect(body.match(/not reported/g)).toHaveLength(7);
  });

  it('trims a float to four decimals rather than showing the noise of the wire value', () => {
    expect(bodyOf({ nodes: [], metrics: liveMetrics({ cpu: 0.09375, mem: 0.6666666666666666 }) })).toContain('0.0938');
    expect(bodyOf({ nodes: [], metrics: liveMetrics({ cpu: 0.09375, mem: 0.6666666666666666 }) })).toContain('0.6667');
  });

  it('renders a zero count as zero, since a registry can really be empty', () => {
    // The trap in every `value || fallback`: a real zero would read as "not
    // reported", which is a different claim about the server.
    const body = bodyOf({ nodes: [], metrics: liveMetrics({ serviceCount: 0, instanceCount: 0 }) });

    expect(body).toContain('>0<');
    expect(body.match(/not reported/g)).toBeNull();
  });

  it('badges the reported status the way it badges a node state', () => {
    expect(bodyOf({ nodes: [], metrics: liveMetrics({ status: 'DOWN' }) })).toContain('state-badge state-down');
  });
});

describe('renderClusterStatus, before and after a failure', () => {
  it('says the panel is still loading before the first fetch answers', () => {
    const body = renderClusterStatus({ instanceLabel: 'prod' }).body;

    expect(body).toContain('Loading');
    expect(body).not.toContain('not reported');
  });

  it('reports a node listing that failed, in the section it belongs to', () => {
    const body = bodyOf({ nodes: [], nodesError: 'connect ETIMEDOUT 10.0.0.9:8848' });

    expect(body).toContain('connect ETIMEDOUT 10.0.0.9:8848');
    expect(body).toContain('could not read the cluster nodes');
  });

  /**
   * A 3.x console-only chain has no metrics endpoint at all (§14.5 ⑱), so
   * this is the ordinary case there rather than an outage: the node table has
   * to survive it.
   */
  it('still shows the nodes when only the metrics failed', () => {
    const body = bodyOf({ nodes: [liveNode()], metricsError: 'No Nacos API flavor could serve server-metrics' });

    expect(body).toContain('172.25.0.2:8848');
    expect(body).toContain('could not read the server metrics');
    expect(body).toContain('No Nacos API flavor could serve server-metrics');
  });

  it('names the instance the panel is showing', () => {
    expect(bodyOf(liveSnapshot())).toContain('prod');
  });

  it('hands the page the copy it renders at runtime', () => {
    const { data } = renderClusterStatus({ instanceLabel: 'prod', snapshot: liveSnapshot() });

    expect(data.atNacosStrings).toMatchObject({ refresh: 'Refresh', refreshing: 'Refreshing...' });
  });

  it('gives the page a refresh button to post from', () => {
    expect(bodyOf(liveSnapshot())).toContain('id="refreshButton"');
  });
});

describe('loadClusterStatus', () => {
  function client(overrides: Partial<Record<keyof ClusterStatusClient, unknown>> = {}): ClusterStatusClient {
    return {
      listClusterNodes: async () => [liveNode()],
      getServerMetrics: async () => liveMetrics(),
      ...overrides
    } as ClusterStatusClient;
  }

  it('reads the nodes and the metrics of the client it is given', async () => {
    expect(await loadClusterStatus(async () => client())).toEqual({
      nodes: [liveNode()],
      metrics: liveMetrics()
    });
  });

  /**
   * Two capabilities, two failures. `NacosClient` keeps them apart for the
   * same reason -- a server can serve one and not the other -- and folding
   * them back together here would let the endpoint a 3.x console cannot serve
   * blank the table it can.
   */
  it('keeps the nodes when the metrics endpoint refused', async () => {
    const snapshot = await loadClusterStatus(async () =>
      client({ getServerMetrics: async () => Promise.reject(new Error('no metrics on this API')) })
    );

    expect(snapshot.nodes).toEqual([liveNode()]);
    expect(snapshot.metrics).toBeUndefined();
    expect(snapshot.metricsError).toBe('no metrics on this API');
    expect(snapshot.nodesError).toBeUndefined();
  });

  it('keeps the metrics when the node listing refused', async () => {
    const snapshot = await loadClusterStatus(async () =>
      client({ listClusterNodes: async () => Promise.reject(new Error('HTTP 403')) })
    );

    expect(snapshot.nodes).toEqual([]);
    expect(snapshot.nodesError).toBe('HTTP 403');
    expect(snapshot.metrics).toEqual(liveMetrics());
  });

  /** Nothing was reached, so both sections have to say so rather than one. */
  it('reports a connection that never happened on both sections', async () => {
    const snapshot = await loadClusterStatus(async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.9:8848');
    });

    expect(snapshot.nodesError).toBe('connect ECONNREFUSED 10.0.0.9:8848');
    expect(snapshot.metricsError).toBe('connect ECONNREFUSED 10.0.0.9:8848');
    expect(snapshot.nodes).toEqual([]);
  });

  it('redacts a credential the failure quoted', async () => {
    const snapshot = await loadClusterStatus(async () => {
      throw new Error('login failed: {"username":"nacos","password":"hunter2"}');
    });

    expect(snapshot.nodesError).not.toContain('hunter2');
    expect(snapshot.nodesError).toContain('[REDACTED]');
  });
});

describe('handleClusterStatusMessage', () => {
  interface TestPanel {
    disposeCount: number;
    dispose(): void;
    webview: { html: string; postMessage(message: unknown): Promise<boolean> };
  }

  function createPanel(): TestPanel {
    const panel: TestPanel = {
      disposeCount: 0,
      dispose() {
        panel.disposeCount += 1;
      },
      webview: {
        html: '',
        postMessage: async () => true
      }
    };
    return panel;
  }

  /** The handler only ever touches `dispose` and the webview. */
  function asPanel(panel: TestPanel): Parameters<typeof handleClusterStatusMessage>[1] {
    return panel as unknown as Parameters<typeof handleClusterStatusMessage>[1];
  }

  function options(load: () => Promise<ClusterStatusSnapshot>): Parameters<typeof handleClusterStatusMessage>[2] {
    return {
      instanceLabel: 'prod',
      load,
      renderDocument: (view: ClusterStatusView) => `<!DOCTYPE html>${view.body}`
    };
  }

  it('reads the server again and serves what came back', async () => {
    const panel = createPanel();
    const load = vi.fn(async () => liveSnapshot());

    const handled = await handleClusterStatusMessage({ type: 'refresh' }, asPanel(panel), options(load));

    expect(handled).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(panel.webview.html).toContain('172.25.0.2:8848');
  });

  it('leaves a message it does not own to whoever does', async () => {
    const panel = createPanel();
    const load = vi.fn(async () => liveSnapshot());

    expect(await handleClusterStatusMessage({ type: 'submit' }, asPanel(panel), options(load))).toBe(false);
    expect(await handleClusterStatusMessage(undefined, asPanel(panel), options(load))).toBe(false);
    expect(await handleClusterStatusMessage('refresh', asPanel(panel), options(load))).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  /**
   * `loadClusterStatus` answers a failure with copy rather than a rejection,
   * but the seam it comes through can reject anyway -- and a rejection here is
   * an unhandled promise in the extension host with a panel left on the stale
   * page in front of it.
   */
  it('renders a reload that threw instead of rejecting', async () => {
    const panel = createPanel();

    await expect(
      handleClusterStatusMessage({ type: 'refresh' }, asPanel(panel), options(async () => Promise.reject(new Error('boom'))))
    ).resolves.toBe(true);

    expect(panel.webview.html).toContain('boom');
    expect(panel.disposeCount).toBe(0);
  });
});

describe('ClusterStatusPanel.open', () => {
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

  function connect(): Promise<ClusterStatusClient> {
    return Promise.resolve({
      listClusterNodes: async () => [liveNode()],
      getServerMetrics: async () => liveMetrics()
    } as ClusterStatusClient);
  }

  it('serves the panel under the shared CSP, with the bundle, its stylesheet and its copy', async () => {
    const created = trackCreated();

    await ClusterStatusPanel.open(context, { instance: { id: 'instance-1', label: 'prod' }, connect });

    const html = created[0]?.webview.html ?? '';
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('/ext/dist/webview/nacos-cluster-status.js');
    expect(html).toContain('/ext/webview/nacos-cluster-status/index.css');
    expect(html).toContain('id="atNacosStrings"');
    expect(html).toContain('172.25.0.2:8848');
  });

  it('names the panel after the instance it is showing', async () => {
    const created = trackCreated();

    await ClusterStatusPanel.open(context, { instance: { id: 'instance-1', label: 'prod' }, connect });

    expect(created[0]?.title).toBe('Nacos Cluster: prod');
  });

  it('reveals the panel an instance already has rather than opening a second', async () => {
    const created = trackCreated();
    await ClusterStatusPanel.open(context, { instance: { id: 'instance-1', label: 'prod' }, connect });
    const reveal = vi.spyOn(created[0] as vscode.WebviewPanel, 'reveal');

    await ClusterStatusPanel.open(context, { instance: { id: 'instance-1', label: 'prod' }, connect });

    expect(created).toHaveLength(1);
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it('opens a panel of its own for each instance', async () => {
    const created = trackCreated();

    await ClusterStatusPanel.open(context, { instance: { id: 'instance-1', label: 'prod' }, connect });
    await ClusterStatusPanel.open(context, { instance: { id: 'instance-2', label: 'uat' }, connect });

    expect(created.map((panel) => panel.title)).toEqual(['Nacos Cluster: prod', 'Nacos Cluster: uat']);
  });

  /** A closed panel is not the panel to reveal on the next click. */
  it('opens a new panel once the one that instance had has been closed', async () => {
    const created = trackCreated();
    await ClusterStatusPanel.open(context, { instance: { id: 'instance-1', label: 'prod' }, connect });
    created[0]?.dispose();

    await ClusterStatusPanel.open(context, { instance: { id: 'instance-1', label: 'prod' }, connect });

    expect(created).toHaveLength(2);
  });

  it('opens a panel that says what went wrong when the server cannot be reached', async () => {
    const created = trackCreated();

    await ClusterStatusPanel.open(context, {
      instance: { id: 'instance-1', label: 'prod' },
      connect: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.9:8848'))
    });

    expect(created[0]?.webview.html).toContain('connect ECONNREFUSED 10.0.0.9:8848');
  });

  it('closes every panel it still has open when the extension shuts down', async () => {
    const created = trackCreated();
    await ClusterStatusPanel.open(context, { instance: { id: 'instance-1', label: 'prod' }, connect });
    const disposed = vi.spyOn(created[0] as vscode.WebviewPanel, 'dispose');

    disposeOpenPanels();

    expect(disposed).toHaveBeenCalledTimes(1);
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
    vi.spyOn(vscode.l10n, 't').mockImplementation((messageOrOptions: string | { message: string }, ...args: never[]) => {
      const message = typeof messageOrOptions === 'string' ? messageOrOptions : messageOrOptions.message;
      sources.push(message);
      return translate(message, ...args);
    });

    renderClusterStatus({ instanceLabel: 'prod' });
    renderClusterStatus({ instanceLabel: 'prod', snapshot: liveSnapshot() });
    renderClusterStatus({ instanceLabel: 'prod', snapshot: { nodes: [{ address: 'a:1', ip: 'a', port: 1, state: 'UP' }] } });
    renderClusterStatus({
      instanceLabel: 'prod',
      snapshot: { nodes: [], metrics: { status: 'UP' }, nodesError: 'x', metricsError: 'y' }
    });
    await ClusterStatusPanel.open({ extensionUri: vscode.Uri.file('/ext') } as unknown as vscode.ExtensionContext, {
      instance: { id: 'instance-1', label: 'prod' },
      connect: () => Promise.reject(new Error('nope'))
    });

    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(Object.keys(bundle), source).toContain(source);
    }
  });
});
