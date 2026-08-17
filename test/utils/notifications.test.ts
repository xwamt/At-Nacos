import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  showTimedNotification,
  withLoadingProgress
} from '../../src/utils/notifications';

describe('showTimedNotification', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows timed notification with withProgress', async () => {
    const withProgress = vi.spyOn(vscode.window, 'withProgress').mockImplementation(async (_options, task) => {
      return await task({ report: () => undefined }, {} as vscode.CancellationToken);
    });

    await showTimedNotification('Operation succeeded', 'info', 10);

    expect(withProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        location: vscode.ProgressLocation.Notification,
        title: '$(info) Operation succeeded',
        cancellable: false
      }),
      expect.any(Function)
    );
  });
});

describe('withLoadingProgress', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('invokes vscode.window.withProgress and returns the task result', async () => {
    const withProgress = vi.spyOn(vscode.window, 'withProgress').mockImplementation(async (_options, task) => {
      return await task({ report: () => undefined }, {} as vscode.CancellationToken);
    });

    const result = await withLoadingProgress('Loading data...', async () => {
      return 42;
    });

    expect(result).toBe(42);
    expect(withProgress).toHaveBeenCalledWith(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Loading data...',
        cancellable: false
      },
      expect.any(Function)
    );
  });

  it('supports custom location and cancellable options', async () => {
    const withProgress = vi.spyOn(vscode.window, 'withProgress').mockImplementation(async (_options, task) => {
      return await task({ report: () => undefined }, {} as vscode.CancellationToken);
    });

    const result = await withLoadingProgress(
      'Loading window data...',
      async () => 'ok',
      { location: vscode.ProgressLocation.Window, cancellable: true }
    );

    expect(result).toBe('ok');
    expect(withProgress).toHaveBeenCalledWith(
      {
        location: vscode.ProgressLocation.Window,
        title: 'Loading window data...',
        cancellable: true
      },
      expect.any(Function)
    );
  });

  it('propagates errors when task fails', async () => {
    vi.spyOn(vscode.window, 'withProgress').mockImplementation(async (_options, task) => {
      return await task({ report: () => undefined }, {} as vscode.CancellationToken);
    });

    await expect(
      withLoadingProgress('Loading failing task...', async () => {
        throw new Error('network failed');
      })
    ).rejects.toThrow('network failed');
  });
});
