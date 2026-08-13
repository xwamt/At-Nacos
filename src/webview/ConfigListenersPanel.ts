import * as vscode from 'vscode';
import { buildWebviewStrings, t } from '../i18n/t';
import type { NacosClient } from '../nacos/NacosClient';
import type { NacosConfigListener, NacosConfigRef } from '../nacos/driver/normalize';
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

/**
 * Two capabilities, because the question needs both.
 *
 * A listener reports the md5 it currently holds, and that number means
 * nothing on its own -- it is only informative against the configuration's
 * own md5, which is what says whether that client is running on the values
 * that were last published.
 */
export type ConfigListenersClient = Pick<NacosClient, 'listConfigListeners' | 'getConfig'>;

export interface ConfigListenersSnapshot {
  listeners: NacosConfigListener[];
  /** The configuration's own md5. Absent means no row may be called stale. */
  currentMd5?: string;
  /** Already redacted; both come through `formatError`. */
  listenersError?: string;
  configError?: string;
}

export interface ConfigListenersView {
  body: string;
  data: Record<string, unknown>;
}

export interface RenderConfigListenersOptions {
  instanceLabel: string;
  ref: NacosConfigRef;
  /** Absent while the first fetch is still in flight. */
  snapshot?: ConfigListenersSnapshot;
}

export interface ConfigListenersMessageOptions {
  instanceLabel: string;
  ref: NacosConfigRef;
  load: () => Promise<ConfigListenersSnapshot>;
  renderDocument: (view: ConfigListenersView) => string;
}

export interface ConfigListenersPanelOptions {
  instance: { id: string; label: string };
  ref: NacosConfigRef;
  /** Built per open and per refresh, so an edited instance takes effect immediately. */
  connect: () => Promise<ConfigListenersClient>;
}

/** Where one client stands relative to what was last published. */
type ListenerState = 'current' | 'behind' | 'unknown';

export class ConfigListenersPanel {
  static async open(context: vscode.ExtensionContext, options: ConfigListenersPanelOptions): Promise<void> {
    const panel = openOrRevealPanel(
      panelKey('configListeners', options.instance.id, options.ref.namespaceId, options.ref.group, options.ref.dataId),
      () =>
        vscode.window.createWebviewPanel(
          'atNacos.configListeners',
          configListenersTitle(options.ref),
          vscode.ViewColumn.Active,
          { enableScripts: true, localResourceRoots: [context.extensionUri] }
        )
    );
    if (!panel) {
      return;
    }

    const messageOptions: ConfigListenersMessageOptions = {
      instanceLabel: options.instance.label,
      ref: options.ref,
      load: () => loadConfigListeners(options.connect, options.ref),
      renderDocument: (view) =>
        renderWebviewHtml(
          panel.webview,
          {
            script: vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'nacos-consumers.js'),
            style: vscode.Uri.joinPath(context.extensionUri, 'webview', 'nacos-consumers', 'index.css')
          },
          view.body,
          view.data
        )
    };
    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      await handleConfigListenersMessage(message, panel, messageOptions);
    });

    panel.webview.html = messageOptions.renderDocument(
      renderConfigListeners({ instanceLabel: options.instance.label, ref: options.ref })
    );
    panel.webview.html = messageOptions.renderDocument(await configListenersView(messageOptions));
  }
}

export async function handleConfigListenersMessage(
  message: unknown,
  panel: Pick<vscode.WebviewPanel, 'dispose' | 'webview'>,
  options: ConfigListenersMessageOptions
): Promise<boolean> {
  if (messageType(message) !== 'refresh') {
    return false;
  }
  panel.webview.html = options.renderDocument(await configListenersView(options));
  return true;
}

/**
 * Reads who is holding this configuration, and what the configuration
 * currently is.
 *
 * **Only the md5 of the detail survives this function.** The rest of it is
 * the configuration body, which is the thing that holds the database
 * passwords -- and the snapshot it would otherwise land in is handed
 * straight to a renderer. Dropping it here, at the one place both halves
 * meet, is what makes the panel unable to leak it.
 */
export async function loadConfigListeners(
  connect: () => Promise<ConfigListenersClient>,
  ref: NacosConfigRef
): Promise<ConfigListenersSnapshot> {
  let client: ConfigListenersClient;
  try {
    client = await connect();
  } catch (error) {
    // Nothing was reached, so both halves have to say so: reporting it on the
    // listener list alone would leave the md5 column reading as a server that
    // simply does not keep one.
    const message = formatError(error);
    return { listeners: [], listenersError: message, configError: message };
  }

  const [listeners, detail] = await Promise.all([
    settle(() => client.listConfigListeners(ref)),
    settle(() => client.getConfig(ref))
  ]);
  return {
    listeners: listeners.value ?? [],
    listenersError: listeners.error,
    currentMd5: detail.value?.md5,
    configError: detail.error
  };
}

/** Never rejects: the view is the only place a failure here can be read. */
async function configListenersView(options: ConfigListenersMessageOptions): Promise<ConfigListenersView> {
  const base = { instanceLabel: options.instanceLabel, ref: options.ref };
  try {
    return renderConfigListeners({ ...base, snapshot: await options.load() });
  } catch (error) {
    const message = formatError(error);
    return renderConfigListeners({
      ...base,
      snapshot: { listeners: [], listenersError: message, configError: message }
    });
  }
}

export function renderConfigListeners(options: RenderConfigListenersOptions): ConfigListenersView {
  const { instanceLabel, ref, snapshot } = options;
  const body = `<main class="panel-shell">
${renderPanelHeader({
  title: configListenersTitle(ref),
  description: t('The clients holding a copy of {dataId} in group {group}, on {instance}.', {
    dataId: ref.dataId,
    group: ref.group,
    instance: instanceLabel
  })
})}
${renderPanelSection(t('Listeners'), renderListenerSection(snapshot))}
</main>`;

  return {
    body,
    data: {
      atNacosStrings: buildWebviewStrings({
        refresh: 'Refresh',
        refreshing: 'Refreshing...'
      })
    }
  };
}

function renderListenerSection(snapshot: ConfigListenersSnapshot | undefined): string {
  if (!snapshot) {
    return loadingNote();
  }
  const parts: string[] = [];
  if (snapshot.listenersError) {
    parts.push(errorNote(t('AT Nacos could not read the listeners of this configuration: {message}', {
      message: snapshot.listenersError
    })));
  }
  if (snapshot.configError) {
    // Its own line, and not fatal: the client list is worth showing without
    // the comparison, and the table says per row that it cannot judge.
    parts.push(
      errorNote(
        t('AT Nacos could not read this configuration itself, so no client can be compared against it: {message}', {
          message: snapshot.configError
        })
      )
    );
  }
  if (snapshot.listeners.length > 0) {
    parts.push(renderStalenessSummary(snapshot), renderListenerTable(snapshot));
  } else if (!snapshot.listenersError) {
    // Not a failure: a configuration nobody is long-polling answers exactly
    // this, and so does one nobody has ever published (§14.8 ㉗).
    parts.push(
      note(
        t(
          'Nacos reported no client holding this configuration. Only a client that is long-polling this server appears here, and a client that has never read this configuration never will.'
        )
      )
    );
  }
  return parts.join('\n    ');
}

/**
 * The one sentence this panel exists to produce.
 *
 * A table of md5s answers the question only for someone willing to compare
 * thirty-two hex digits by eye, and the thing an operator came here to find
 * out -- did my publish reach everyone -- is a count.
 */
function renderStalenessSummary(snapshot: ConfigListenersSnapshot): string {
  if (snapshot.currentMd5 === undefined) {
    return note(
      t('The current md5 of this configuration is unknown, so AT Nacos cannot say which of these clients is behind.')
    );
  }
  const behind = snapshot.listeners.filter(
    (entry) => listenerState(entry, snapshot.currentMd5) === 'behind'
  ).length;
  if (behind === 0) {
    return note(t('Every client holding this configuration has the version that was last published.'));
  }
  return errorNote(
    t('{behind} of {total} clients are still holding an older version of this configuration.', {
      behind,
      total: snapshot.listeners.length
    })
  );
}

function renderListenerTable(snapshot: ConfigListenersSnapshot): string {
  return `<table class="listener-table">
      <thead>
        <tr>
          <th>${escapeAttr(t('Client'))}</th>
          <th>${escapeAttr(t('Version held'))}</th>
          <th>${escapeAttr(t('State'))}</th>
        </tr>
      </thead>
      <tbody>
      ${snapshot.listeners.map((entry) => renderListener(entry, snapshot.currentMd5)).join('\n      ')}
      </tbody>
    </table>`;
}

function renderListener(entry: NacosConfigListener, currentMd5: string | undefined): string {
  return `<tr class="listener-row">
          <td class="listener-address">${escapeAttr(entry.ip)}</td>
          <td class="listener-md5">${entry.md5 === '' ? notReported() : escapeAttr(entry.md5)}</td>
          <td>${renderListenerState(listenerState(entry, currentMd5))}</td>
        </tr>`;
}

/**
 * Three states, not two. Without the configuration's own md5 there is no
 * comparison to make, and painting a row green or red then would be a claim
 * with nothing behind it.
 */
function listenerState(entry: NacosConfigListener, currentMd5: string | undefined): ListenerState {
  if (currentMd5 === undefined) {
    return 'unknown';
  }
  return entry.md5 === currentMd5 ? 'current' : 'behind';
}

function renderListenerState(state: ListenerState): string {
  switch (state) {
    case 'current':
      return `<span class="listener-state listener-current">${escapeAttr(t('up to date'))}</span>`;
    case 'behind':
      return `<span class="listener-state listener-behind">${escapeAttr(
        t('has not picked up the latest publish')
      )}</span>`;
    default:
      return `<span class="listener-state">${escapeAttr(t('cannot be compared'))}</span>`;
  }
}

function configListenersTitle(ref: NacosConfigRef): string {
  return t('Listeners: {dataId}', { dataId: ref.dataId });
}
