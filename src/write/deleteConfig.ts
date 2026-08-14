import * as vscode from 'vscode';
import type { NacosInstanceConfig } from '../config/schema';
import type { NacosDraftFileSystemProvider } from '../document/NacosDraftFileSystemProvider';
import { t } from '../i18n/t';
import type { NacosClient } from '../nacos/NacosClient';
import type { NacosConfigRef } from '../nacos/driver/normalize';
import { assertWritable, confirmWrite } from './confirmWrite';

export type DeleteConfigClient = Pick<NacosClient, 'deleteConfig'>;

export interface DeleteConfigOptions {
  instance: NacosInstanceConfig;
  ref: NacosConfigRef;
  connect: () => Promise<DeleteConfigClient>;
  draftProvider?: NacosDraftFileSystemProvider;
  refreshDocument?: (instanceId: string, ref: NacosConfigRef) => void;
  onDeleted?: () => void;
}

/**
 * Deletes a configuration from Nacos after modal confirmation.
 */
export async function deleteConfig(options: DeleteConfigOptions): Promise<boolean> {
  const { instance, ref, connect, draftProvider, refreshDocument, onDeleted } = options;

  assertWritable(instance);

  const confirmed = await confirmWrite({
    summary: t('Are you sure you want to delete configuration {dataId} from group {group} on {instance}?', {
      dataId: ref.dataId,
      group: ref.group,
      instance: instance.label
    }),
    confirmLabel: t('Delete'),
    detail: t('This operation is permanent. The configuration will be removed from the server.')
  });

  if (!confirmed) {
    return false;
  }

  const client = await connect();
  await client.deleteConfig(ref);

  draftProvider?.deleteDraft({ instanceId: instance.id, ref });
  refreshDocument?.(instance.id, ref);
  onDeleted?.();

  await vscode.window.showInformationMessage(
    t('Configuration {dataId} was deleted successfully.', { dataId: ref.dataId })
  );
  return true;
}
