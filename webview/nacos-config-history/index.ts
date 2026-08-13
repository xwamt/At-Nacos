/**
 * The page behind `ConfigHistoryPanel`. It has exactly two jobs: ask the
 * extension host to read the history again, and say which version the user
 * wants compared with the current content. Everything shown is rendered on
 * the extension side, which is the only side that can be tested and the only
 * side that knows how to escape what a server sent.
 */

type VsCodeApi = { postMessage(message: unknown): void };

declare const acquireVsCodeApi: () => VsCodeApi;

interface ConfigHistoryStrings {
  refresh: string;
  refreshing: string;
}

/**
 * Only reached if the data block is missing or unparseable, which means the
 * extension side is broken -- but a button that still works in English beats
 * one labelled with nothing.
 */
const FALLBACK_STRINGS: ConfigHistoryStrings = {
  refresh: 'Refresh',
  refreshing: 'Refreshing...'
};

const vscode = acquireVsCodeApi();
const strings = readStrings();
const refreshButton = document.querySelector<HTMLButtonElement>('#refreshButton');

function readStrings(): ConfigHistoryStrings {
  const block = document.getElementById('atNacosStrings');
  if (!block?.textContent) {
    return FALLBACK_STRINGS;
  }
  try {
    return { ...FALLBACK_STRINGS, ...(JSON.parse(block.textContent) as Partial<ConfigHistoryStrings>) };
  } catch {
    return FALLBACK_STRINGS;
  }
}

refreshButton?.addEventListener('click', () => {
  // Nothing resets this: the extension host answers a refresh by serving the
  // whole document again, so the button that comes back is a new one.
  refreshButton.disabled = true;
  refreshButton.textContent = strings.refreshing;
  vscode.postMessage({ type: 'refresh' });
});

/**
 * One listener on the document rather than one per row: the version table is
 * replaced wholesale on every refresh, and a listener bound to a row would go
 * with it.
 *
 * Only the id travels. The extension host answers for versions it is
 * currently showing and looks the rest of the row up itself, so a page that
 * sent a doctored timestamp could not put one in a diff title.
 */
document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const action = target.closest('.version-action');
  if (!(action instanceof HTMLElement)) {
    return;
  }
  const id = action.dataset.versionId;
  if (id) {
    vscode.postMessage({ type: 'diff', id });
  }
});

// Keeps these names off the global type space. Without it TypeScript treats a
// file with no imports as a script, and the next Webview to declare a
// `strings` collides with this one.
export {};
