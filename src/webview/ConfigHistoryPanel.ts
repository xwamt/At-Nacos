import * as vscode from 'vscode';
import { buildWebviewStrings, t } from '../i18n/t';
import type { NacosClient } from '../nacos/NacosClient';
import type { NacosConfigHistoryEntry, NacosConfigRef } from '../nacos/driver/normalize';
import { formatError } from '../utils/errors';
import { formatTimestamp } from '../utils/time';
import { escapeAttr, renderWebviewHtml } from './html';
import { openOrRevealPanel, panelKey } from './openPanels';
import { errorNote, loadingNote, messageType, note, notReported, renderPanelHeader, renderPanelSection } from './panelParts';

/** The one capability this panel reads; the diff it opens is somebody else's job. */
export type ConfigHistoryClient = Pick<NacosClient, 'listConfigHistory'>;

/**
 * One page, deliberately, and no Load more.
 *
 * The history endpoint is the only paged endpoint Nacos clamps server-side
 * (500, §10), and a panel is not a tree: what an operator comes here for is
 * the last few publishes, not an archive. The count that came back is
 * rendered whenever it exceeds what was drawn, so nobody reads a page as the
 * whole history.
 */
const HISTORY_PAGE_SIZE = 100;

export interface ConfigHistorySnapshot {
  entries: NacosConfigHistoryEntry[];
  /** What the server says there are, which can exceed what one page brought. */
  totalCount: number;
  /** Already redacted; comes through `formatError`. */
  error?: string;
}

export interface ConfigHistoryView {
  /** The `<main>` the page is built from. */
  body: string;
  /** Keyed by element id, serialized into the page by `renderWebviewHtml`. */
  data: Record<string, unknown>;
}

export interface RenderConfigHistoryOptions {
  instanceLabel: string;
  ref: NacosConfigRef;
  readOnly?: boolean;
  /** Absent while the first fetch is still in flight. */
  snapshot?: ConfigHistorySnapshot;
}

export interface ConfigHistoryMessageOptions {
  instanceLabel: string;
  ref: NacosConfigRef;
  readOnly?: boolean;
  /** Read again on every refresh. */
  load: () => Promise<ConfigHistorySnapshot>;
  /** Wraps a view in the document to serve; `open` binds this to `renderWebviewHtml`. */
  renderDocument: (view: ConfigHistoryView) => string;
  /**
   * The versions currently on screen.
   *
   * A page can post any id at all, and an id becomes an `nid` in a request to
   * the server -- so the handler answers only for versions this panel drew,
   * rather than forwarding whatever arrived.
   */
  shownVersions: () => NacosConfigHistoryEntry[];
  /** Opens the native diff of one version against the current content. */
  openDiff: (entry: NacosConfigHistoryEntry) => Promise<void>;
  /** Rolls back to the past version when requested and allowed. */
  rollback?: (entry: NacosConfigHistoryEntry) => Promise<void>;
}

export interface ConfigHistoryPanelOptions {
  instance: { id: string; label: string; readOnly?: boolean };
  ref: NacosConfigRef;
  /** Built per open and per refresh, so an edited instance takes effect immediately. */
  connect: () => Promise<ConfigHistoryClient>;
  openDiff: (entry: NacosConfigHistoryEntry) => Promise<void>;
  rollback?: (entry: NacosConfigHistoryEntry) => Promise<void>;
}

export class ConfigHistoryPanel {
  static async open(context: vscode.ExtensionContext, options: ConfigHistoryPanelOptions): Promise<void> {
    // One panel per configuration rather than per instance: two configs of one
    // server have two histories, and revealing one for the other would answer
    // a question about the wrong file.
    const panel = openOrRevealPanel(
      panelKey('configHistory', options.instance.id, options.ref.namespaceId, options.ref.group, options.ref.dataId),
      () =>
        vscode.window.createWebviewPanel(
          'atNacos.configHistory',
          configHistoryTitle(options.ref),
          vscode.ViewColumn.Active,
          { enableScripts: true, localResourceRoots: [context.extensionUri] }
        )
    );
    if (!panel) {
      return;
    }

    // What the page is currently showing, which is the only thing it may ask
    // to diff. Updated by `load` rather than tracked by the page, so a stale
    // page that survived a refresh cannot name a version that is gone.
    let shown: NacosConfigHistoryEntry[] = [];

    const messageOptions: ConfigHistoryMessageOptions = {
      instanceLabel: options.instance.label,
      ref: options.ref,
      readOnly: options.instance.readOnly,
      load: async () => {
        const snapshot = await loadConfigHistory(options.connect, options.ref);
        shown = snapshot.entries;
        return snapshot;
      },
      renderDocument: (view) =>
        renderWebviewHtml(
          panel.webview,
          {
            script: vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'nacos-config-history.js'),
            style: vscode.Uri.joinPath(context.extensionUri, 'webview', 'nacos-config-history', 'index.css')
          },
          view.body,
          view.data
        ),
      shownVersions: () => shown,
      openDiff: options.openDiff,
      rollback: options.rollback
    };
    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      await handleConfigHistoryMessage(message, panel, messageOptions);
    });

    // On screen before the first fetch, as the cluster panel is: reaching a
    // Nacos server costs a probe and a round trip, and a menu item that opens
    // nothing for several seconds reads as one that did nothing.
    panel.webview.html = messageOptions.renderDocument(
      renderConfigHistory({ instanceLabel: options.instance.label, ref: options.ref, readOnly: options.instance.readOnly })
    );
    panel.webview.html = messageOptions.renderDocument(await configHistoryView(messageOptions));
  }
}

/**
 * Everything the panel does with a message from the page, as a function of
 * its arguments. Returns whether the message was one this panel owns.
 */
export async function handleConfigHistoryMessage(
  message: unknown,
  panel: Pick<vscode.WebviewPanel, 'dispose' | 'webview'>,
  options: ConfigHistoryMessageOptions
): Promise<boolean> {
  const type = messageType(message);
  if (type === 'refresh') {
    panel.webview.html = options.renderDocument(await configHistoryView(options));
    return true;
  }
  if (type === 'rollback') {
    const entry = options.shownVersions().find((shown) => shown.id === diffVersionId(message));
    if (entry && options.rollback) {
      await options.rollback(entry).catch(() => undefined);
    }
    return true;
  }
  if (type !== 'diff') {
    return false;
  }
  const entry = options.shownVersions().find((shown) => shown.id === diffVersionId(message));
  if (entry) {
    // The panel owns the message either way, so a failure here must not
    // reject: an unhandled rejection out of a message handler leaves the
    // extension host complaining into a log nobody has open.
    await options.openDiff(entry).catch(() => undefined);
  }
  return true;
}

/**
 * Reads the first page of one configuration's history, and turns whatever
 * failed into copy rather than a rejection -- the panel is the surface this
 * failure has to be reported on, and an empty one reports nothing.
 */
export async function loadConfigHistory(
  connect: () => Promise<ConfigHistoryClient>,
  ref: NacosConfigRef
): Promise<ConfigHistorySnapshot> {
  try {
    const client = await connect();
    const page = await client.listConfigHistory({ ...ref, pageNo: 1, pageSize: HISTORY_PAGE_SIZE });
    return { entries: page.items, totalCount: page.totalCount };
  } catch (error) {
    return { entries: [], totalCount: 0, error: formatError(error) };
  }
}

/** Never rejects: the view is the only place a failure here can be read. */
async function configHistoryView(options: ConfigHistoryMessageOptions): Promise<ConfigHistoryView> {
  const base = { instanceLabel: options.instanceLabel, ref: options.ref, readOnly: options.readOnly };
  try {
    return renderConfigHistory({ ...base, snapshot: await options.load() });
  } catch (error) {
    return renderConfigHistory({ ...base, snapshot: { entries: [], totalCount: 0, error: formatError(error) } });
  }
}

/** The id a `diff` or `rollback` message named, if it named one at all. */
function diffVersionId(message: unknown): string | undefined {
  const { id } = message as { id?: unknown };
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

export function renderConfigHistory(options: RenderConfigHistoryOptions): ConfigHistoryView {
  const { instanceLabel, ref, snapshot, readOnly } = options;
  const body = `<main class="panel-shell">
${renderPanelHeader({
  title: configHistoryTitle(ref),
  description: t('The versions Nacos still keeps of {dataId} in group {group}, on {instance}.', {
    dataId: ref.dataId,
    group: ref.group,
    instance: instanceLabel
  })
})}
${renderPanelSection(t('Versions'), renderVersionSection(snapshot, readOnly))}
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

function renderVersionSection(snapshot: ConfigHistorySnapshot | undefined, readOnly?: boolean): string {
  if (!snapshot) {
    return loadingNote();
  }
  if (snapshot.error) {
    return errorNote(t('AT Nacos could not read the history of this configuration: {message}', {
      message: snapshot.error
    }));
  }
  if (snapshot.entries.length === 0) {
    // Empty is the ordinary state of a configuration nobody has republished,
    // not a failure -- and it is the state of every configuration on the
    // server this milestone was verified against.
    return note(
      t(
        'Nacos reported no history for this configuration. A version is recorded when a configuration is changed or deleted, and Nacos prunes records older than its retention period.'
      )
    );
  }
  const parts = [renderVersionTable(snapshot.entries, readOnly)];
  if (snapshot.totalCount > snapshot.entries.length) {
    parts.push(
      note(
        t('Showing the {shown} most recent of {total} versions.', {
          shown: snapshot.entries.length,
          total: snapshot.totalCount
        })
      )
    );
  }
  return parts.join('\n    ');
}

function renderVersionTable(entries: NacosConfigHistoryEntry[], readOnly?: boolean): string {
  return `<table class="version-table">
      <thead>
        <tr>
          <th>${escapeAttr(t('Version'))}</th>
          <th>${escapeAttr(t('Operation'))}</th>
          <th>${escapeAttr(t('Changed at'))}</th>
          <th>${escapeAttr(t('Source IP'))}</th>
          <th>${escapeAttr(t('Source user'))}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
      ${entries.map((entry) => renderVersion(entry, readOnly)).join('\n      ')}
      </tbody>
    </table>`;
}

function renderVersion(entry: NacosConfigHistoryEntry, readOnly?: boolean): string {
  const rollbackBtn = readOnly
    ? ''
    : `<button class="version-rollback" type="button" data-version-id="${escapeAttr(
        entry.id
      )}">${escapeAttr(t('Roll back'))}</button>`;

  return `<tr class="version-row">
          <td class="version-id">${escapeAttr(entry.id)}</td>
          <td>${renderOperation(entry.opType)}</td>
          <td>${renderTime(entry.modifiedAt)}</td>
          <td>${renderText(entry.srcIp)}</td>
          <td>${renderText(entry.srcUser)}</td>
          <td>
            <div class="version-actions-cell">
              <button class="version-action" type="button" data-version-id="${escapeAttr(
                entry.id
              )}">${escapeAttr(t('Compare with current'))}</button>
              ${rollbackBtn}
            </div>
          </td>
        </tr>`;
}

/**
 * The operation, written out where it is one of the three Nacos records and
 * carried verbatim where it is not. A fourth letter from some later version
 * is still the server's answer, and calling it an update would report a
 * change nobody made.
 *
 * A switch rather than a lookup table, so that every `t()` here takes a
 * literal -- and so that `__proto__` arriving as an opType answers with
 * nothing rather than with something inherited.
 */
function renderOperation(opType: string): string {
  switch (opType) {
    case 'I':
      return operationBadge('i', t('created'));
    case 'U':
      return operationBadge('u', t('updated'));
    case 'D':
      return operationBadge('d', t('deleted'));
    default:
      return `<span class="operation">${escapeAttr(opType)}</span>`;
  }
}

function operationBadge(kind: string, label: string): string {
  return `<span class="operation operation-${kind}">${escapeAttr(label)}</span>`;
}

function renderTime(epochMillis: number | undefined): string {
  return epochMillis === undefined ? notReported() : escapeAttr(formatTimestamp(epochMillis));
}

function renderText(value: string | undefined): string {
  return value === undefined || value === '' ? notReported() : escapeAttr(value);
}

function configHistoryTitle(ref: NacosConfigRef): string {
  return t('History: {dataId}', { dataId: ref.dataId });
}
