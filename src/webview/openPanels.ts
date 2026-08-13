import * as vscode from 'vscode';

/**
 * Every Webview panel this extension has open, keyed by what it is showing.
 *
 * One map for all of them rather than one per panel class. The two things it
 * owns -- "a second click reveals rather than duplicates" and "nothing
 * outlives the extension host" -- are the same rule for every panel, and M3
 * kept a copy of it inside `ClusterStatusPanel` on the understanding that the
 * third panel type would lift it out. M4 brings two more.
 */
const openPanels = new Map<string, vscode.WebviewPanel>();

/**
 * The panel for this key, created if there is none and revealed if there is.
 *
 * Answers `undefined` when it revealed one, which is what tells the caller
 * not to render again: a panel that is already on screen has its own content
 * and its own message handler, and serving it a second document would throw
 * away whatever the user had scrolled to.
 *
 * The disposal bookkeeping is here rather than at the call sites because it
 * has a subtlety each of them would otherwise have to remember:
 * `disposeOpenPanels` empties the map *before* the callbacks fire, so a
 * callback has to check that the entry is still its own panel before removing
 * it -- otherwise an older panel's disposal deletes the newer panel that has
 * since taken its key, and the next click opens a twin.
 */
export function openOrRevealPanel(key: string, create: () => vscode.WebviewPanel): vscode.WebviewPanel | undefined {
  const existing = openPanels.get(key);
  if (existing) {
    existing.reveal();
    return undefined;
  }
  const panel = create();
  openPanels.set(key, panel);
  panel.onDidDispose(() => {
    if (openPanels.get(key) === panel) {
      openPanels.delete(key);
    }
  });
  return panel;
}

/**
 * Closes every panel still open, for `deactivate`.
 *
 * A panel outliving the extension host keeps its Refresh button, and the
 * handler behind it is gone -- clicking it would do nothing at all. Iterates
 * a snapshot because each `dispose()` fires the callback that mutates the map.
 */
export function disposeOpenPanels(): void {
  const panels = [...openPanels.values()];
  openPanels.clear();
  for (const panel of panels) {
    panel.dispose();
  }
}

/**
 * The key for one panel of one kind about one thing.
 *
 * The parts are percent-encoded before being joined, for the reason
 * `treeItemId` encodes its own: a group named `a:b` holding dataId `c` and a
 * group named `a` holding dataId `b:c` would otherwise write one key between
 * them, and one of two real configurations would reveal the other's panel.
 * The kind is written by this extension and needs no encoding, but it goes
 * first so that two kinds of panel about one instance can never collide.
 */
export function panelKey(kind: string, ...parts: string[]): string {
  return `${kind}:${parts.map(encodeURIComponent).join(':')}`;
}
