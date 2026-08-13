/**
 * The page behind the two "who is using this" panels -- a configuration's
 * listeners and a service's subscribers.
 *
 * One page for both because both do exactly one thing: ask the extension host
 * to read the server again. What a row means differs between them and is
 * rendered on the extension side, which is the only side that can be tested
 * and the only side that knows how to escape what a server sent.
 */

type VsCodeApi = { postMessage(message: unknown): void };

declare const acquireVsCodeApi: () => VsCodeApi;

interface ConsumersStrings {
  refresh: string;
  refreshing: string;
}

/**
 * Only reached if the data block is missing or unparseable, which means the
 * extension side is broken -- but a button that still works in English beats
 * one labelled with nothing.
 */
const FALLBACK_STRINGS: ConsumersStrings = {
  refresh: 'Refresh',
  refreshing: 'Refreshing...'
};

const vscode = acquireVsCodeApi();
const strings = readStrings();
const refreshButton = document.querySelector<HTMLButtonElement>('#refreshButton');

function readStrings(): ConsumersStrings {
  const block = document.getElementById('atNacosStrings');
  if (!block?.textContent) {
    return FALLBACK_STRINGS;
  }
  try {
    return { ...FALLBACK_STRINGS, ...(JSON.parse(block.textContent) as Partial<ConsumersStrings>) };
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

// Keeps these names off the global type space. Without it TypeScript treats a
// file with no imports as a script, and the next Webview to declare a
// `strings` collides with this one.
export {};
