import { t } from '../i18n/t';
import { formatError } from '../utils/errors';
import { escapeAttr } from './html';

/**
 * The chrome every panel in this extension is built from, and the two
 * functions all of them need on the way in and out.
 *
 * It exists for the same reason `openPanels` does: M3 wrote all of this
 * inside `ClusterStatusPanel` because there was one panel, and M4 has three.
 * Everything here is markup or plumbing -- what a row of a table means stays
 * in the panel that knows.
 */

/**
 * The title, the sentence under it, and the Refresh button.
 *
 * The button is part of the header rather than a parameter because every
 * panel has one and they all do the same thing: the page posts `refresh`, the
 * extension side reads the server again and serves the whole document back.
 * A panel that could opt out would be a panel showing a snapshot with no way
 * to say how old it is.
 */
export function renderPanelHeader(options: { title: string; description: string }): string {
  return `  <header class="panel-header">
    <div>
      <h1>${escapeAttr(options.title)}</h1>
      <p>${escapeAttr(options.description)}</p>
    </div>
    <button id="refreshButton" class="primary-action" type="button">${escapeAttr(t('Refresh'))}</button>
  </header>`;
}

export function renderPanelSection(title: string, content: string): string {
  return `  <section class="panel-section">
    <h2>${escapeAttr(title)}</h2>
    ${content}
  </section>`;
}

export function note(message: string): string {
  return `<p class="section-note">${escapeAttr(message)}</p>`;
}

export function errorNote(message: string): string {
  return `<p class="section-error" role="status">${escapeAttr(message)}</p>`;
}

export function loadingNote(): string {
  return note(t('Loading...'));
}

/** Not "0" and not "-": the server did not say, and those two would claim it did. */
export function notReported(): string {
  return `<span class="not-reported">${escapeAttr(t('not reported'))}</span>`;
}

/**
 * The `type` of a message from a page, for a value that arrived across the
 * Webview boundary and is therefore `unknown` in the strict sense: a page
 * script can post a number, a string, or nothing at all.
 */
export function messageType(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const { type } = message as { type?: unknown };
  return typeof type === 'string' ? type : undefined;
}

/**
 * One capability's answer, or the redacted reason there is none.
 *
 * Panels read several capabilities at once and a server can serve one and
 * refuse another, so each has to be able to fail without blanking the
 * sections that succeeded.
 */
export async function settle<T>(run: () => Promise<T>): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await run() };
  } catch (error) {
    return { error: formatError(error) };
  }
}
