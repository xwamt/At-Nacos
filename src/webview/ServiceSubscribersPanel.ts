import * as vscode from 'vscode';
import { buildWebviewStrings, t } from '../i18n/t';
import type { NacosClient } from '../nacos/NacosClient';
import type { NacosServiceRef, NacosSubscriber } from '../nacos/driver/normalize';
import { formatError } from '../utils/errors';
import { escapeAttr, renderWebviewHtml } from './html';
import { openOrRevealPanel, panelKey } from './openPanels';
import { errorNote, loadingNote, messageType, note, notReported, renderPanelHeader, renderPanelSection } from './panelParts';

/**
 * The one capability this panel reads.
 *
 * A panel of its own rather than a mode of the listener panel, even though
 * both answer "who is using this": the rows have nothing in common but an IP
 * address. A listener is judged against the configuration's md5 and a
 * subscriber has no such notion, they hang off different tree nodes, and the
 * listener panel needs a second capability this one has no analogue for. What
 * the two really share -- the dedupe map, the chrome, the refresh round trip,
 * the page script and the stylesheet -- they share already, without a mode
 * flag branching every function over a union that never overlaps.
 */
export type ServiceSubscribersClient = Pick<NacosClient, 'listSubscribers'>;

export interface ServiceSubscribersSnapshot {
  subscribers: NacosSubscriber[];
  /** Already redacted; comes through `formatError`. */
  error?: string;
}

export interface ServiceSubscribersView {
  body: string;
  data: Record<string, unknown>;
}

export interface RenderServiceSubscribersOptions {
  instanceLabel: string;
  ref: NacosServiceRef;
  /** Absent while the first fetch is still in flight. */
  snapshot?: ServiceSubscribersSnapshot;
}

export interface ServiceSubscribersMessageOptions {
  instanceLabel: string;
  ref: NacosServiceRef;
  load: () => Promise<ServiceSubscribersSnapshot>;
  renderDocument: (view: ServiceSubscribersView) => string;
}

export interface ServiceSubscribersPanelOptions {
  instance: { id: string; label: string };
  ref: NacosServiceRef;
  /** Built per open and per refresh, so an edited instance takes effect immediately. */
  connect: () => Promise<ServiceSubscribersClient>;
}

export class ServiceSubscribersPanel {
  static async open(context: vscode.ExtensionContext, options: ServiceSubscribersPanelOptions): Promise<void> {
    const panel = openOrRevealPanel(
      panelKey(
        'serviceSubscribers',
        options.instance.id,
        options.ref.namespaceId,
        options.ref.group,
        options.ref.serviceName
      ),
      () =>
        vscode.window.createWebviewPanel(
          'atNacos.serviceSubscribers',
          serviceSubscribersTitle(options.ref),
          vscode.ViewColumn.Active,
          { enableScripts: true, localResourceRoots: [context.extensionUri] }
        )
    );
    if (!panel) {
      return;
    }

    const messageOptions: ServiceSubscribersMessageOptions = {
      instanceLabel: options.instance.label,
      ref: options.ref,
      load: () => loadServiceSubscribers(options.connect, options.ref),
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
      await handleServiceSubscribersMessage(message, panel, messageOptions);
    });

    panel.webview.html = messageOptions.renderDocument(
      renderServiceSubscribers({ instanceLabel: options.instance.label, ref: options.ref })
    );
    panel.webview.html = messageOptions.renderDocument(await serviceSubscribersView(messageOptions));
  }
}

export async function handleServiceSubscribersMessage(
  message: unknown,
  panel: Pick<vscode.WebviewPanel, 'dispose' | 'webview'>,
  options: ServiceSubscribersMessageOptions
): Promise<boolean> {
  if (messageType(message) !== 'refresh') {
    return false;
  }
  panel.webview.html = options.renderDocument(await serviceSubscribersView(options));
  return true;
}

export async function loadServiceSubscribers(
  connect: () => Promise<ServiceSubscribersClient>,
  ref: NacosServiceRef
): Promise<ServiceSubscribersSnapshot> {
  try {
    const client = await connect();
    return { subscribers: await client.listSubscribers(ref) };
  } catch (error) {
    return { subscribers: [], error: formatError(error) };
  }
}

/** Never rejects: the view is the only place a failure here can be read. */
async function serviceSubscribersView(
  options: ServiceSubscribersMessageOptions
): Promise<ServiceSubscribersView> {
  const base = { instanceLabel: options.instanceLabel, ref: options.ref };
  try {
    return renderServiceSubscribers({ ...base, snapshot: await options.load() });
  } catch (error) {
    return renderServiceSubscribers({ ...base, snapshot: { subscribers: [], error: formatError(error) } });
  }
}

export function renderServiceSubscribers(options: RenderServiceSubscribersOptions): ServiceSubscribersView {
  const { instanceLabel, ref, snapshot } = options;
  const body = `<main class="panel-shell">
${renderPanelHeader({
  title: serviceSubscribersTitle(ref),
  description: t('The clients watching {serviceName} in group {group}, on {instance}.', {
    group: ref.group,
    instance: instanceLabel,
    serviceName: ref.serviceName
  })
})}
${renderPanelSection(t('Subscribers'), renderSubscriberSection(snapshot))}
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

function renderSubscriberSection(snapshot: ServiceSubscribersSnapshot | undefined): string {
  if (!snapshot) {
    return loadingNote();
  }
  if (snapshot.error) {
    return errorNote(t('AT Nacos could not read the subscribers of this service: {message}', {
      message: snapshot.error
    }));
  }
  if (snapshot.subscribers.length === 0) {
    // Not a failure. A service nobody is watching and a service nobody
    // registered answer the same empty list under HTTP 200 (§14.8 ⑥).
    return note(
      t(
        'Nacos reported no client watching this service. A client appears here only while it is subscribed, so a caller that resolves this service some other way never will.'
      )
    );
  }
  return renderSubscriberTable(snapshot.subscribers);
}

function renderSubscriberTable(subscribers: NacosSubscriber[]): string {
  return `<table class="subscriber-table">
      <thead>
        <tr>
          <th>${escapeAttr(t('Client'))}</th>
          <th>${escapeAttr(t('Callback port'))}</th>
          <th>${escapeAttr(t('Client agent'))}</th>
          <th>${escapeAttr(t('Application'))}</th>
          <th>${escapeAttr(t('Cluster'))}</th>
        </tr>
      </thead>
      <tbody>
      ${subscribers.map((subscriber) => renderSubscriber(subscriber)).join('\n      ')}
      </tbody>
    </table>`;
}

function renderSubscriber(subscriber: NacosSubscriber): string {
  return `<tr class="subscriber-row">
          <td class="subscriber-address">${escapeAttr(subscriber.ip)}</td>
          <td>${renderCallbackPort(subscriber.port)}</td>
          <td>${renderText(subscriber.agent)}</td>
          <td>${renderText(subscriber.app)}</td>
          <td>${renderText(subscriber.cluster)}</td>
        </tr>`;
}

/**
 * Zero is an answer, not a gap: a gRPC subscriber has no callback port, and
 * every subscriber on a 2.x server is one. Writing the digit would read as a
 * port nobody can connect to, and the not-reported style would claim the
 * server stayed silent when it did not.
 */
function renderCallbackPort(port: number): string {
  return port === 0 ? `<span class="no-port">${escapeAttr(t('none'))}</span>` : escapeAttr(String(port));
}

function renderText(value: string | undefined): string {
  return value === undefined || value === '' ? notReported() : escapeAttr(value);
}

function serviceSubscribersTitle(ref: NacosServiceRef): string {
  return t('Subscribers: {serviceName}', { serviceName: ref.serviceName });
}
