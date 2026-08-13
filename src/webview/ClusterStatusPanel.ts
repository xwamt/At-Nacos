import * as vscode from 'vscode';
import { buildWebviewStrings, t } from '../i18n/t';
import type { NacosClient } from '../nacos/NacosClient';
import type { NacosClusterNode, NacosRaftGroup, NacosServerMetrics } from '../nacos/driver/normalize';
import { formatError } from '../utils/errors';
import { escapeAttr, renderWebviewHtml } from './html';
import { openOrRevealPanel, panelKey } from './openPanels';
import {
  errorNote,
  loadingNote,
  messageType,
  note,
  notReported,
  renderPanelHeader,
  renderPanelSection,
  settle
} from './panelParts';

/** The two capabilities this panel shows, and the only ones it asks for. */
export type ClusterStatusClient = Pick<NacosClient, 'listClusterNodes' | 'getServerMetrics'>;

/**
 * What one fetch produced, with each half able to fail on its own.
 *
 * The two errors are separate because the two capabilities are: a 3.x console
 * chain serves the node list and has no metrics endpoint at all (§14.5 ⑱), so
 * one shared error field would let the endpoint that cannot exist blank the
 * table that can.
 */
export interface ClusterStatusSnapshot {
  nodes: NacosClusterNode[];
  metrics?: NacosServerMetrics;
  /** Already redacted; both messages come through `formatError`. */
  nodesError?: string;
  metricsError?: string;
}

export interface ClusterStatusView {
  /** The `<main>` the page is built from. */
  body: string;
  /** Keyed by element id, serialized into the page by `renderWebviewHtml`. */
  data: Record<string, unknown>;
}

export interface RenderClusterStatusOptions {
  instanceLabel: string;
  /** Absent while the first fetch is still in flight. */
  snapshot?: ClusterStatusSnapshot;
}

export interface ClusterStatusMessageOptions {
  instanceLabel: string;
  /** Read again on every refresh, which is the whole of what the button does. */
  load: () => Promise<ClusterStatusSnapshot>;
  /** Wraps a view in the document to serve; `open` binds this to `renderWebviewHtml`. */
  renderDocument: (view: ClusterStatusView) => string;
}

export interface ClusterStatusPanelOptions {
  instance: { id: string; label: string };
  /** Built per open and per refresh, so an edited instance takes effect immediately. */
  connect: () => Promise<ClusterStatusClient>;
}

/**
 * The five states Nacos's `NodeState` enum has, each with a style of its own.
 *
 * A Map rather than an object literal because the key is whatever the server
 * sent: `__proto__` and `constructor` are ordinary strings on the wire, and an
 * object would answer them with something inherited instead of undefined.
 */
const STATE_CLASSES = new Map<string, string>([
  ['STARTING', 'state-starting'],
  ['UP', 'state-up'],
  ['SUSPICIOUS', 'state-suspicious'],
  ['DOWN', 'state-down'],
  ['ISOLATION', 'state-isolation']
]);

export class ClusterStatusPanel {
  static async open(context: vscode.ExtensionContext, options: ClusterStatusPanelOptions): Promise<void> {
    // One per instance, so a second click reveals rather than duplicates.
    const panel = openOrRevealPanel(panelKey('clusterStatus', options.instance.id), () =>
      vscode.window.createWebviewPanel(
        'atNacos.clusterStatus',
        clusterStatusTitle(options.instance.label),
        vscode.ViewColumn.Active,
        { enableScripts: true, localResourceRoots: [context.extensionUri] }
      )
    );
    if (!panel) {
      return;
    }

    const messageOptions: ClusterStatusMessageOptions = {
      instanceLabel: options.instance.label,
      load: () => loadClusterStatus(options.connect),
      renderDocument: (view) =>
        renderWebviewHtml(
          panel.webview,
          {
            script: vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'nacos-cluster-status.js'),
            style: vscode.Uri.joinPath(context.extensionUri, 'webview', 'nacos-cluster-status', 'index.css')
          },
          view.body,
          view.data
        )
    };
    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      await handleClusterStatusMessage(message, panel, messageOptions);
    });

    // The panel is on screen before the first fetch, unlike the instance form:
    // reaching a Nacos server costs a probe and a round trip per capability,
    // and a toolbar button that opens nothing for several seconds reads as a
    // button that did nothing. It also means the second click of a double
    // click finds a panel to reveal instead of opening a twin.
    panel.webview.html = messageOptions.renderDocument(
      renderClusterStatus({ instanceLabel: options.instance.label })
    );
    panel.webview.html = messageOptions.renderDocument(await clusterStatusView(messageOptions));
  }
}

/**
 * Everything the panel does with a message from the page, as a function of its
 * arguments: the class above is only the wiring. Returns whether the message
 * was one this panel owns.
 */
export async function handleClusterStatusMessage(
  message: unknown,
  panel: Pick<vscode.WebviewPanel, 'dispose' | 'webview'>,
  options: ClusterStatusMessageOptions
): Promise<boolean> {
  if (messageType(message) !== 'refresh') {
    return false;
  }
  // The whole document, rather than a message the page patches itself into:
  // the body is built here, so re-serving it is the only way the page and this
  // module cannot disagree about what a node row looks like.
  panel.webview.html = options.renderDocument(await clusterStatusView(options));
  return true;
}

/**
 * Reads both capabilities, and turns whatever failed into copy rather than a
 * rejection -- a panel is the surface this failure has to be reported on, and
 * an empty one reports nothing.
 */
export async function loadClusterStatus(connect: () => Promise<ClusterStatusClient>): Promise<ClusterStatusSnapshot> {
  let client: ClusterStatusClient;
  try {
    client = await connect();
  } catch (error) {
    // Nothing was reached, so both sections have to say so. Reporting it in
    // one of them only would leave the other reading as a server that simply
    // does not keep that number.
    const message = formatError(error);
    return { nodes: [], nodesError: message, metricsError: message };
  }

  const [nodes, metrics] = await Promise.all([
    settle(() => client.listClusterNodes()),
    settle(() => client.getServerMetrics())
  ]);
  return {
    nodes: nodes.value ?? [],
    nodesError: nodes.error,
    metrics: metrics.value,
    metricsError: metrics.error
  };
}

/** Never rejects: the view is the only place a failure here can be read. */
async function clusterStatusView(options: ClusterStatusMessageOptions): Promise<ClusterStatusView> {
  try {
    return renderClusterStatus({ instanceLabel: options.instanceLabel, snapshot: await options.load() });
  } catch (error) {
    const message = formatError(error);
    return renderClusterStatus({
      instanceLabel: options.instanceLabel,
      snapshot: { nodes: [], nodesError: message, metricsError: message }
    });
  }
}

export function renderClusterStatus(options: RenderClusterStatusOptions): ClusterStatusView {
  const { instanceLabel, snapshot } = options;
  const body = `<main class="cluster-shell">
${renderPanelHeader({
  title: clusterStatusTitle(instanceLabel),
  description: t('The servers this Nacos deployment is made of, and what its naming module reports.')
})}
${renderPanelSection(t('Cluster nodes'), renderNodeSection(snapshot))}
${renderPanelSection(t('Server metrics'), renderMetricSection(snapshot))}
</main>`;

  return {
    body,
    // The page renders these itself, so they have to be translated here --
    // `vscode.l10n` exists only in the extension host.
    data: {
      atNacosStrings: buildWebviewStrings({
        refresh: 'Refresh',
        refreshing: 'Refreshing...'
      })
    }
  };
}

function renderNodeSection(snapshot: ClusterStatusSnapshot | undefined): string {
  if (!snapshot) {
    return loadingNote();
  }
  const parts: string[] = [];
  if (snapshot.nodesError) {
    parts.push(errorNote(t('AT Nacos could not read the cluster nodes: {message}', { message: snapshot.nodesError })));
  }
  if (snapshot.nodes.length > 0) {
    parts.push(renderNodeTable(snapshot.nodes));
  } else if (!snapshot.nodesError) {
    parts.push(
      note(
        t(
          'Nacos reported no cluster node. Even a standalone server usually lists itself, so an empty list means this deployment does not answer for its own cluster.'
        )
      )
    );
  }
  return parts.join('\n    ');
}

function renderNodeTable(nodes: NacosClusterNode[]): string {
  return `<table class="node-table">
      <thead>
        <tr>
          <th>${escapeAttr(t('Address'))}</th>
          <th>${escapeAttr(t('State'))}</th>
          <th>${escapeAttr(t('Version'))}</th>
          <th>${escapeAttr(t('Raft port'))}</th>
          <th>${escapeAttr(t('Failed access'))}</th>
        </tr>
      </thead>
      ${nodes.map((node, index) => renderNode(node, index)).join('\n      ')}
    </table>`;
}

/**
 * One node, as its own `<tbody>` so that the summary row and the raft detail
 * below it are one unit -- the detail row is the summary's, and a table with
 * one long body would let a stylesheet stripe them apart.
 */
function renderNode(node: NacosClusterNode, index: number): string {
  const raftGroups = node.raftGroups ?? [];
  const detailId = `node-raft-${index}`;
  return `<tbody class="node">
        <tr class="node-summary">
          <td>${renderNodeAddress(node, raftGroups, detailId)}</td>
          <td>${renderStateBadge(node.state)}</td>
          <td>${renderText(node.version)}</td>
          <td>${renderText(node.raftPort)}</td>
          <td>${renderNumber(node.failAccessCnt)}</td>
        </tr>${raftGroups.length === 0 ? '' : renderRaftRow(detailId, raftGroups)}
      </tbody>`;
}

/**
 * The address, and the control that expands the raft detail under it.
 *
 * A node with no raft metadata gets no control: 1.x has no JRaft at all, and
 * an expander that opens onto nothing reads as a panel that failed to load
 * something.
 */
function renderNodeAddress(node: NacosClusterNode, raftGroups: NacosRaftGroup[], detailId: string): string {
  if (raftGroups.length === 0) {
    return `<span class="node-address">${escapeAttr(node.address)}</span>`;
  }
  // The label does not change when the row opens -- `aria-expanded` is what
  // says which way it is, and a label that contradicted it would be read out
  // twice, differently.
  const label = t('Show the raft groups of {address}', { address: node.address });
  return `<button class="node-toggle" type="button" aria-expanded="false" aria-controls="${escapeAttr(
    detailId
  )}" aria-label="${escapeAttr(label)}"><span class="toggle-caret" aria-hidden="true"></span>${escapeAttr(
    node.address
  )}</button>`;
}

function renderRaftRow(detailId: string, raftGroups: NacosRaftGroup[]): string {
  const rows = raftGroups
    .map(
      (group) => `<tr>
                <td>${escapeAttr(group.group)}</td>
                <td>${escapeAttr(group.leader)}</td>
                <td>${escapeAttr(group.members.join(', '))}</td>
                <td>${escapeAttr(String(group.term))}</td>
              </tr>`
    )
    .join('\n              ');
  return `
        <tr class="node-raft" id="${escapeAttr(detailId)}" hidden>
          <td colspan="5">
            <table class="raft-table">
              <thead>
                <tr>
                  <th>${escapeAttr(t('Raft group'))}</th>
                  <th>${escapeAttr(t('Leader'))}</th>
                  <th>${escapeAttr(t('Members'))}</th>
                  <th>${escapeAttr(t('Term'))}</th>
                </tr>
              </thead>
              <tbody>
              ${rows}
              </tbody>
            </table>
          </td>
        </tr>`;
}

function renderMetricSection(snapshot: ClusterStatusSnapshot | undefined): string {
  if (!snapshot) {
    return loadingNote();
  }
  const parts: string[] = [];
  if (snapshot.metricsError) {
    parts.push(
      errorNote(t('AT Nacos could not read the server metrics: {message}', { message: snapshot.metricsError }))
    );
  }
  if (snapshot.metrics) {
    parts.push(renderMetricGrid(snapshot.metrics));
  } else if (!snapshot.metricsError) {
    parts.push(note(t('Nacos reported no server metrics.')));
  }
  return parts.join('\n    ');
}

/**
 * A description list rather than a table: these are eight labelled values, not
 * rows of anything, and only the node list has more than one of each.
 */
function renderMetricGrid(metrics: NacosServerMetrics): string {
  const entries: [string, string][] = [
    [t('Status'), renderStateBadge(metrics.status)],
    [t('Services'), renderNumber(metrics.serviceCount)],
    [t('Instances'), renderNumber(metrics.instanceCount)],
    [t('Subscribers'), renderNumber(metrics.subscribeCount)],
    [t('Clients'), renderNumber(metrics.clientCount)],
    [t('CPU'), renderNumber(metrics.cpu)],
    [t('Load'), renderNumber(metrics.load)],
    [t('Memory'), renderNumber(metrics.mem)]
  ];
  return `<dl class="metric-grid">
      ${entries
        .map(([label, value]) => `<div class="metric"><dt>${escapeAttr(label)}</dt><dd>${value}</dd></div>`)
        .join('\n      ')}
    </dl>`;
}

/**
 * The state, styled by which of the five it is and written out whatever it is.
 *
 * An unrecognized value keeps its own text and takes the neutral style, for
 * the reason `normalizeClusterNode` carries it verbatim: a sixth state from a
 * later Nacos is still the server's answer, and painting it as UP or DOWN
 * would report a health nobody claimed.
 */
function renderStateBadge(state: string): string {
  const className = STATE_CLASSES.get(state) ?? 'state-unknown';
  return `<span class="state-badge ${className}">${escapeAttr(state)}</span>`;
}

function renderText(value: string | undefined): string {
  return value === undefined ? notReported() : escapeAttr(value);
}

function renderNumber(value: number | undefined): string {
  return value === undefined ? notReported() : escapeAttr(formatNumber(value));
}

/**
 * Four decimals, and no trailing zeroes.
 *
 * The counts are integers and pass through untouched; `cpu` and `mem` are
 * ratios that arrive as full doubles (0.09375 on the server this was written
 * against, and a third of a machine's memory would arrive as
 * 0.3333333333333333). Rendering those in full turns a status line into
 * noise, and rounding them to two would report a busy server as idle.
 */
function formatNumber(value: number): string {
  return String(Number(value.toFixed(4)));
}

function clusterStatusTitle(instanceLabel: string): string {
  return t('Nacos Cluster: {label}', { label: instanceLabel });
}
