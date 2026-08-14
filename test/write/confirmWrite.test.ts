import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { assertWritable, confirmWrite } from '../../src/write/confirmWrite';

describe('confirmWrite', () => {
  describe('assertWritable', () => {
    it('does not throw for a writable instance', () => {
      expect(() => assertWritable({ label: 'prod', readOnly: false })).not.toThrow();
    });

    it('throws a descriptive error for a read-only instance', () => {
      expect(() => assertWritable({ label: 'prod-cluster', readOnly: true })).toThrowError(
        /prod-cluster.*read-only/
      );
    });
  });

  describe('confirmWrite', () => {
    it('returns true when user confirms modal prompt', async () => {
      vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValueOnce('Publish' as unknown as undefined);

      const confirmed = await confirmWrite({
        summary: 'Publish config changes to server?',
        confirmLabel: 'Publish'
      });

      expect(confirmed).toBe(true);
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        'Publish config changes to server?',
        { modal: true, detail: undefined },
        'Publish'
      );
    });

    it('returns false when user cancels or dismisses modal prompt', async () => {
      vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValueOnce(undefined);

      const confirmed = await confirmWrite({
        summary: 'Delete configuration?',
        confirmLabel: 'Delete'
      });

      expect(confirmed).toBe(false);
    });

    it('opens diff editor before modal confirmation when diff is provided', async () => {
      const execSpy = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
      vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValueOnce('Publish' as unknown as undefined);

      const leftUri = vscode.Uri.file('/tmp/left');
      const rightUri = vscode.Uri.file('/tmp/right');

      const confirmed = await confirmWrite({
        summary: 'Publish config?',
        confirmLabel: 'Publish',
        detail: 'This will overwrite production.',
        diff: {
          leftUri,
          rightUri,
          title: 'Config diff'
        }
      });

      expect(confirmed).toBe(true);
      expect(execSpy).toHaveBeenCalledWith('vscode.diff', leftUri, rightUri, 'Config diff');
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        'Publish config?',
        { modal: true, detail: 'This will overwrite production.' },
        'Publish'
      );
    });
  });
});
