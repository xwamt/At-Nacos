import * as vscode from 'vscode';
import type { NacosInstanceConfig } from '../config/schema';
import { buildConfigHistoryUri, buildConfigUri } from '../document/configUri';
import { historyVersionLabel } from '../document/diffConfig';
import { t } from '../i18n/t';
import { NacosApiError } from '../nacos/NacosApiError';
import type { NacosClient } from '../nacos/NacosClient';
import type { NacosConfigDetail, NacosConfigHistoryEntry, NacosConfigRef } from '../nacos/driver/normalize';
import { assertWritable, confirmWrite } from './confirmWrite';

export type RollbackConfigClient = Pick<NacosClient, 'getConfig' | 'getConfigHistory' | 'publishConfig'>;

export interface RollbackConfigOptions {
  instance: NacosInstanceConfig;
  ref: NacosConfigRef;
  entry: NacosConfigHistoryEntry;
  connect: () => Promise<RollbackConfigClient>;
  refreshDocument?: (instanceId: string, ref: NacosConfigRef) => void;
  onRollback?: () => void;
}

/**
 * Rolls back a configuration to a past historical version.
 *
 * **Publishes a new version rather than erasing history:** Nacos has no API
 * to revert records; rollback reads the past version and publishes it as the
 * latest state, appending a new history row. The confirmation dialog explicitly
 * explains this behavior.
 */
export async function rollbackConfig(options: RollbackConfigOptions): Promise<boolean> {
  const { instance, ref, entry, connect, refreshDocument, onRollback } = options;

  assertWritable(instance);

  const client = await connect();
  const historyDetail = await client.getConfigHistory({ ...ref, nid: entry.id });

  let currentDetail: NacosConfigDetail | undefined;
  try {
    currentDetail = await client.getConfig(ref);
  } catch (error) {
    if (error instanceof NacosApiError && error.kind === 'resource-not-found') {
      currentDetail = undefined;
    } else {
      throw error;
    }
  }

  const versionLabel = historyVersionLabel(entry);
  const confirmed = await confirmWrite({
    summary: t('Roll back configuration {dataId} to version {version} on {instance}?', {
      dataId: ref.dataId,
      version: versionLabel,
      instance: instance.label
    }),
    confirmLabel: t('Roll Back'),
    detail: t(
      'Rolling back publishes the past version as a new configuration update. It creates a new history entry rather than deleting intermediate versions.'
    ),
    diff: {
      leftUri: buildConfigUri(instance.id, ref),
      rightUri: buildConfigHistoryUri(instance.id, ref, entry.id),
      title: t('{dataId}: Current vs Version {version}', {
        dataId: ref.dataId,
        version: versionLabel
      })
    }
  });

  if (!confirmed) {
    return false;
  }

  const configType = historyDetail.type ?? currentDetail?.type ?? 'text';
  await client.publishConfig({
    namespaceId: ref.namespaceId,
    group: ref.group,
    dataId: ref.dataId,
    content: historyDetail.content,
    type: configType,
    appName: historyDetail.appName ?? currentDetail?.appName,
    description: historyDetail.description ?? currentDetail?.description
  });

  refreshDocument?.(instance.id, ref);
  onRollback?.();

  await vscode.window.showInformationMessage(
    t('Configuration {dataId} has been rolled back to version {version}.', {
      dataId: ref.dataId,
      version: versionLabel
    })
  );
  return true;
}
