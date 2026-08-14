import * as vscode from 'vscode';
import type { NacosInstanceConfig } from '../config/schema';
import { t } from '../i18n/t';
import type { NacosClient } from '../nacos/NacosClient';
import type { NacosInstance, NacosServiceRef } from '../nacos/driver/normalize';
import { assertWritable, confirmWrite } from './confirmWrite';

export type UpdateInstanceHealthClient = Pick<NacosClient, 'updateInstanceHealth'>;

export interface ToggleInstanceEnabledOptions {
  instance: NacosInstanceConfig;
  serviceRef: NacosServiceRef;
  serviceInstance: NacosInstance;
  enabled: boolean;
  connect: () => Promise<UpdateInstanceHealthClient>;
  onUpdated?: () => void;
}

/**
 * Enables or disables a registered service instance on Nacos.
 *
 * Disabling an instance stops Nacos from routing traffic to it while leaving
 * the registration in place.
 */
export async function toggleServiceInstanceEnabled(options: ToggleInstanceEnabledOptions): Promise<boolean> {
  const { instance, serviceRef, serviceInstance, enabled, connect, onUpdated } = options;

  assertWritable(instance);

  const address = `${serviceInstance.ip}:${serviceInstance.port}`;
  const confirmed = await confirmWrite({
    summary: enabled
      ? t('Enable instance {address} for service {serviceName} on {instance}?', {
          address,
          serviceName: serviceRef.serviceName,
          instance: instance.label
        })
      : t('Disable instance {address} for service {serviceName} on {instance}?', {
          address,
          serviceName: serviceRef.serviceName,
          instance: instance.label
        }),
    confirmLabel: enabled ? t('Enable') : t('Disable'),
    detail: enabled
      ? t('Enabling the instance allows Nacos to route traffic to it again.')
      : t('Disabling the instance stops Nacos from routing traffic to it.')
  });

  if (!confirmed) {
    return false;
  }

  const client = await connect();
  await client.updateInstanceHealth({
    service: serviceRef,
    instance: serviceInstance,
    enabled
  });

  onUpdated?.();

  await vscode.window.showInformationMessage(
    enabled
      ? t('Instance {address} is now enabled and receiving traffic.', { address })
      : t('Instance {address} is now disabled and traffic routing is stopped.', { address })
  );
  return true;
}
