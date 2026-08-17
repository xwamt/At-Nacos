import * as vscode from 'vscode';

export type TimedNotificationKind = 'info' | 'warning' | 'error';

export const TIMED_NOTIFICATION_MS = 3000;
export const FAILED_NOTIFICATION_MS = 8000;

export async function showTimedNotification(
  message: string,
  kind: TimedNotificationKind = 'info',
  durationMs = TIMED_NOTIFICATION_MS
): Promise<void> {
  const icon = kind === 'error' ? '$(error)' : kind === 'warning' ? '$(warning)' : '$(info)';
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `${icon} ${message}`,
      cancellable: false
    },
    async () => {
      await delay(durationMs);
    }
  );
}

export function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export interface LoadingProgressOptions {
  location?: vscode.ProgressLocation;
  cancellable?: boolean;
}

/**
 * Wraps an async operation with VS Code's progress notification.
 * Shows a loading indicator with a spinner, title, and optional cancellation.
 */
export async function withLoadingProgress<T>(
  title: string,
  task: (
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken
  ) => Promise<T>,
  options?: LoadingProgressOptions
): Promise<T> {
  return await vscode.window.withProgress(
    {
      location: options?.location ?? vscode.ProgressLocation.Notification,
      title,
      cancellable: options?.cancellable ?? false
    },
    task
  );
}
