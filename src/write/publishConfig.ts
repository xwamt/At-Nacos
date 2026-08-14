import * as vscode from 'vscode';
import type { NacosInstanceConfig } from '../config/schema';
import { buildConfigUri } from '../document/configUri';
import type { NacosDraftFileSystemProvider } from '../document/NacosDraftFileSystemProvider';
import { buildDraftUri } from '../document/draftUri';
import { t } from '../i18n/t';
import { NacosApiError } from '../nacos/NacosApiError';
import type { NacosClient } from '../nacos/NacosClient';
import type { NacosConfigDetail, NacosConfigRef } from '../nacos/driver/normalize';
import { assertWritable, confirmWrite } from './confirmWrite';

export type PublishConfigClient = Pick<NacosClient, 'getConfig' | 'publishConfig'>;

export interface PublishConfigOptions {
  instance: NacosInstanceConfig;
  ref: NacosConfigRef;
  draftProvider: NacosDraftFileSystemProvider;
  connect: () => Promise<PublishConfigClient>;
  refreshDocument?: (instanceId: string, ref: NacosConfigRef) => void;
  onPublished?: () => void;
}

/**
 * Publishes an in-memory configuration draft to the Nacos server.
 *
 * Enforces the safety gate:
 * 1. Re-fetches the server's current configuration to detect concurrent modifications.
 * 2. Opens native VS Code diff between server content and the local draft.
 * 3. Shows a modal confirmation dialog.
 * 4. Carries existing metadata (`type`, `appName`, `description`) across so the
 *    server does not reset the configuration type to `text`.
 */
export async function publishConfig(options: PublishConfigOptions): Promise<boolean> {
  const { instance, ref, draftProvider, connect, refreshDocument, onPublished } = options;

  assertWritable(instance);

  const draft = draftProvider.getDraft({ instanceId: instance.id, ref });
  if (!draft) {
    await vscode.window.showWarningMessage(
      t('No open draft found for {dataId}. Open it in edit mode first.', { dataId: ref.dataId })
    );
    return false;
  }

  const client = await connect();
  let latestDetail: NacosConfigDetail | undefined;
  try {
    latestDetail = await client.getConfig(ref);
  } catch (error) {
    if (error instanceof NacosApiError && error.kind === 'resource-not-found') {
      latestDetail = undefined;
    } else {
      throw error;
    }
  }

  const serverContent = latestDetail ? latestDetail.content : '';
  const isConflict = latestDetail !== undefined && draft.baseContent !== serverContent;

  const detailText = isConflict
    ? t(
        'Warning: The configuration on the server was modified by someone else after you opened this draft. Publishing will overwrite the latest server version.'
      )
    : undefined;

  const confirmed = await confirmWrite({
    summary: t('Publish configuration {dataId} to {instance}?', {
      dataId: ref.dataId,
      instance: instance.label
    }),
    confirmLabel: t('Publish'),
    detail: detailText,
    diff: {
      leftUri: buildConfigUri(instance.id, ref),
      rightUri: buildDraftUri(instance.id, ref),
      title: t('{dataId}: Current Server vs Draft to Publish', { dataId: ref.dataId })
    }
  });

  if (!confirmed) {
    return false;
  }

  const configType = draft.type ?? latestDetail?.type ?? 'text';
  await client.publishConfig({
    namespaceId: ref.namespaceId,
    group: ref.group,
    dataId: ref.dataId,
    content: draft.content,
    type: configType,
    appName: draft.appName ?? latestDetail?.appName,
    description: draft.description ?? latestDetail?.description
  });

  draftProvider.markClean({ instanceId: instance.id, ref }, draft.content);
  refreshDocument?.(instance.id, ref);
  onPublished?.();

  await vscode.window.showInformationMessage(
    t('Configuration {dataId} has been published successfully.', { dataId: ref.dataId })
  );
  return true;
}
