import * as vscode from 'vscode';
import type { NacosInstanceConfig } from '../config/schema';
import { t } from '../i18n/t';

export interface WriteConfirmation {
  /** A one-sentence explanation of what is about to happen, already localized. */
  summary: string;
  /** The label of the modal button that confirms the write (e.g. "Publish", "Delete", "Rollback"). */
  confirmLabel: string;
  /** Optional secondary detail text displayed inside the modal dialog. */
  detail?: string;
  /** When diff comparison is needed, opened before displaying the confirmation dialog. */
  diff?: {
    leftUri: vscode.Uri;
    rightUri: vscode.Uri;
    title: string;
  };
}

/**
 * Asserts that the instance is writable.
 *
 * **Two layers of defense:** UI elements are hidden on read-only instances,
 * but commands can still be invoked from the command palette, keybindings,
 * or other extensions. Asserting here prevents any bypass.
 */
export function assertWritable(instance: Pick<NacosInstanceConfig, 'label' | 'readOnly'>): void {
  if (instance.readOnly) {
    throw new Error(
      t('The Nacos instance {label} is configured as read-only. Modifying configurations or service instances is disabled for this server.', {
        label: instance.label
      })
    );
  }
}

/**
 * The single confirmation gate for all write operations.
 *
 * Uses a modal warning dialog (`{ modal: true }`) so that it cannot be accidentally
 * dismissed or ignored. If diff information is supplied, opens the native diff editor
 * first so the operator can inspect the exact changes before confirming.
 */
export async function confirmWrite(confirmation: WriteConfirmation): Promise<boolean> {
  if (confirmation.diff) {
    await vscode.commands.executeCommand(
      'vscode.diff',
      confirmation.diff.leftUri,
      confirmation.diff.rightUri,
      confirmation.diff.title
    );
  }

  const items: string[] = [confirmation.confirmLabel];
  const options: vscode.MessageOptions = {
    modal: true,
    detail: confirmation.detail
  };

  const choice = await vscode.window.showWarningMessage(confirmation.summary, options, ...items);
  return choice === confirmation.confirmLabel;
}
