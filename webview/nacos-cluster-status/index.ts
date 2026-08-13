/**
 * The page behind `ClusterStatusPanel`. It has exactly two jobs: ask the
 * extension host to read the server again, and open the raft detail under a
 * node. Everything shown is rendered on the extension side, which is the only
 * side that can be tested and the only side that knows how to escape what a
 * server sent.
 */

type VsCodeApi = { postMessage(message: unknown): void };

declare const acquireVsCodeApi: () => VsCodeApi;

interface ClusterStatusStrings {
  refresh: string;
  refreshing: string;
}

/**
 * Only reached if the data block is missing or unparseable, which means the
 * extension side is broken -- but a button that still works in English beats
 * one labelled with nothing.
 */
const FALLBACK_STRINGS: ClusterStatusStrings = {
  refresh: 'Refresh',
  refreshing: 'Refreshing...'
};

const vscode = acquireVsCodeApi();
const strings = readStrings();
const refreshButton = document.querySelector<HTMLButtonElement>('#refreshButton');

function readStrings(): ClusterStatusStrings {
  const block = document.getElementById('atNacosStrings');
  if (!block?.textContent) {
    return FALLBACK_STRINGS;
  }
  try {
    return { ...FALLBACK_STRINGS, ...(JSON.parse(block.textContent) as Partial<ClusterStatusStrings>) };
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
 * One listener on the document rather than one per row: the node table is
 * replaced wholesale on every refresh, and a listener bound to a row would go
 * with it.
 */
document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const toggle = target.closest('.node-toggle');
  if (!(toggle instanceof HTMLElement)) {
    return;
  }
  const detail = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
  if (!detail) {
    return;
  }
  const open = toggle.getAttribute('aria-expanded') === 'true';
  toggle.setAttribute('aria-expanded', String(!open));
  detail.toggleAttribute('hidden', open);
});

// Keeps these names off the global type space. Without it TypeScript treats a
// file with no imports as a script, and the next Webview to declare a
// `strings` collides with this one.
export {};
