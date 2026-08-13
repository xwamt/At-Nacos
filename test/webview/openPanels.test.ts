import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { disposeOpenPanels, openOrRevealPanel, panelKey } from '../../src/webview/openPanels';

beforeEach(() => {
  vi.restoreAllMocks();
  disposeOpenPanels();
});

function createPanel(title = 'panel'): vscode.WebviewPanel {
  return vscode.window.createWebviewPanel('atNacos.test', title, vscode.ViewColumn.Active, {});
}

describe('openOrRevealPanel', () => {
  it('creates a panel the first time a key is asked for, and hands it back', () => {
    const created: vscode.WebviewPanel[] = [];

    const panel = openOrRevealPanel('a', () => {
      const made = createPanel();
      created.push(made);
      return made;
    });

    expect(created).toHaveLength(1);
    expect(panel).toBe(created[0]);
  });

  /**
   * The second click of a double click, and the whole reason this map exists:
   * a panel is expensive (a probe and a round trip per capability), and two
   * of them for one thing is a window the user now has to close twice.
   */
  it('reveals the panel a key already has, creates nothing, and answers undefined', () => {
    const first = openOrRevealPanel('a', createPanel) as vscode.WebviewPanel;
    const reveal = vi.spyOn(first, 'reveal');
    let createdAgain = false;

    const second = openOrRevealPanel('a', () => {
      createdAgain = true;
      return createPanel();
    });

    expect(second).toBeUndefined();
    expect(createdAgain).toBe(false);
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it('opens a panel of its own for each key', () => {
    const first = openOrRevealPanel('a', () => createPanel('first'));
    const second = openOrRevealPanel('b', () => createPanel('second'));

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
  });

  /** A closed panel is not the panel to reveal on the next click. */
  it('opens a new panel once the one a key had has been closed', () => {
    const first = openOrRevealPanel('a', createPanel) as vscode.WebviewPanel;
    first.dispose();

    const second = openOrRevealPanel('a', createPanel);

    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  /**
   * `disposeOpenPanels` clears the map before the disposal callbacks run, so
   * an older panel's callback must not delete the entry a newer panel of the
   * same key has taken -- which would let the next click open a twin.
   */
  it('keeps a newer panel when an older one for the same key is disposed afterwards', () => {
    const first = openOrRevealPanel('a', createPanel) as vscode.WebviewPanel;
    disposeOpenPanels();
    const second = openOrRevealPanel('a', createPanel) as vscode.WebviewPanel;
    const reveal = vi.spyOn(second, 'reveal');

    first.dispose();

    expect(openOrRevealPanel('a', createPanel)).toBeUndefined();
    expect(reveal).toHaveBeenCalledTimes(1);
  });
});

describe('disposeOpenPanels', () => {
  /**
   * For `deactivate`. A panel that outlives the extension host keeps its
   * Refresh button, and the handler behind it is gone -- clicking it would do
   * nothing at all.
   */
  it('closes every panel still open, whatever key it was opened under', () => {
    const first = openOrRevealPanel('a', createPanel) as vscode.WebviewPanel;
    const second = openOrRevealPanel('b', createPanel) as vscode.WebviewPanel;
    const disposals = [vi.spyOn(first, 'dispose'), vi.spyOn(second, 'dispose')];

    disposeOpenPanels();

    expect(disposals.map((spy) => spy.mock.calls.length)).toEqual([1, 1]);
  });

  it('is safe to call when nothing is open', () => {
    expect(() => disposeOpenPanels()).not.toThrow();
  });
});

describe('panelKey', () => {
  it('keeps two kinds of panel about one thing apart', () => {
    expect(panelKey('clusterStatus', 'instance-1')).not.toBe(panelKey('configListeners', 'instance-1'));
  });

  /**
   * The same trap `treeItemId` documents: a group named `a:b` with dataId `c`
   * and a group named `a` with dataId `b:c` write one key between them, and
   * one of two real configurations would then reveal the other's panel.
   */
  it('keeps two things apart when the separator falls differently inside their parts', () => {
    expect(panelKey('configHistory', 'i', 'a:b', 'c')).not.toBe(panelKey('configHistory', 'i', 'a', 'b:c'));
  });

  it('gives one thing the same key every time it is asked', () => {
    expect(panelKey('configHistory', 'i', 'ns', '订单/服务.yaml')).toBe(
      panelKey('configHistory', 'i', 'ns', '订单/服务.yaml')
    );
  });
});
