import * as vscode from 'vscode';
import type { NacosInstanceConfig } from '../config/schema';
import { t } from '../i18n/t';
import { NacosApiError } from '../nacos/NacosApiError';
import type { NacosClient } from '../nacos/NacosClient';
import type { NacosConfigHistoryEntry, NacosConfigRef, NacosNamespace } from '../nacos/driver/normalize';
import { formatTimestamp } from '../utils/time';
import { buildConfigHistoryUri, buildConfigUri } from './configUri';

/** Which server a configuration is on, and where on it. */
export interface ConfigLocation {
  instance: { id: string; label: string };
  ref: NacosConfigRef;
}

/** Reading one history row is all "diff with previous" needs. */
export type PreviousVersionClient = Pick<NacosClient, 'listConfigHistory'>;

/**
 * The namespaces to offer, and the one probe that decides whether there is
 * anything to compare with.
 */
export type CompareConfigClient = Pick<NacosClient, 'listNamespaces' | 'getConfig'>;

export interface DiffWithPreviousOptions {
  instanceId: string;
  ref: NacosConfigRef;
  connect: () => Promise<PreviousVersionClient>;
}

export interface CompareAcrossEnvironmentsOptions {
  source: ConfigLocation;
  listInstances: () => Promise<NacosInstanceConfig[]>;
  connect: (instance: NacosInstanceConfig) => Promise<CompareConfigClient>;
}

/**
 * Opens VS Code's own diff editor on one past version and the current
 * content.
 *
 * `vscode.diff` rather than anything of ours: side-by-side comparison,
 * syntax highlighting, inline navigation and the whole diff gutter come with
 * it, and reimplementing them is exactly what putting configurations in real
 * documents (M2) was for. Both sides are `nacos:` addresses, so the content
 * provider fetches them and neither is ever written to disk.
 *
 * The history address on the left, because that is the older of the two and
 * left-is-original is what every diff in this editor means.
 */
export async function openConfigVersionDiff(
  instanceId: string,
  ref: NacosConfigRef,
  entry: NacosConfigHistoryEntry
): Promise<void> {
  await vscode.commands.executeCommand(
    'vscode.diff',
    buildConfigHistoryUri(instanceId, ref, entry.id),
    buildConfigUri(instanceId, ref),
    t('{dataId}: version {version} compared with the current version', {
      dataId: ref.dataId,
      version: historyVersionLabel(entry)
    })
  );
}

/**
 * Diffs the current content against the version immediately before it.
 *
 * One row, because Nacos writes a history record holding the content *as it
 * was before* a change -- so the most recent record is the previous version,
 * and the endpoint returns them newest first.
 *
 * A configuration with no history gets a sentence rather than a diff. An
 * empty left-hand pane would read as a configuration created from nothing a
 * moment ago, and empty is the ordinary state: nothing on the server this was
 * verified against has ever been republished.
 */
export async function diffWithPreviousVersion(options: DiffWithPreviousOptions): Promise<void> {
  const client = await options.connect();
  const page = await client.listConfigHistory({ ...options.ref, pageNo: 1, pageSize: 1 });
  const previous = page.items[0];
  if (!previous) {
    await vscode.window.showInformationMessage(
      t('Nacos keeps no earlier version of {dataId}, so there is nothing to compare the current content with.', {
        dataId: options.ref.dataId
      })
    );
    return;
  }
  await openConfigVersionDiff(options.instanceId, options.ref, previous);
}

/**
 * Diffs one configuration against the same configuration somewhere else: a
 * namespace of this server, or a namespace of another.
 *
 * Single configuration, deliberately, rather than a report of everything two
 * environments disagree about -- that was the shape chosen when the
 * requirement was written down, and the two are different features.
 *
 * The target instance may be the source instance. That is not an oversight:
 * two namespaces of one server are the ordinary way a team keeps a staging
 * and a production copy, and it is the only arrangement this milestone could
 * verify against a real server. What is excluded is the source namespace of
 * the source instance, because both sides would then be one address and the
 * editor would show a file with no changes.
 */
export async function compareConfigAcrossEnvironments(options: CompareAcrossEnvironmentsOptions): Promise<void> {
  const target = await pickTargetInstance(options);
  if (!target) {
    return;
  }
  const client = await options.connect(target);
  const namespace = await pickTargetNamespace(await client.listNamespaces(), options.source, target);
  if (!namespace) {
    return;
  }

  const targetRef = { ...options.source.ref, namespaceId: namespace.namespaceId };
  if (!(await hasConfig(client, targetRef))) {
    await vscode.window.showInformationMessage(
      t('{instance} has no configuration {dataId} in group {group} under namespace {namespace}.', {
        dataId: targetRef.dataId,
        group: targetRef.group,
        instance: target.label,
        namespace: namespaceAddress(namespace.namespaceId)
      })
    );
    return;
  }

  await vscode.commands.executeCommand(
    'vscode.diff',
    buildConfigUri(options.source.instance.id, options.source.ref),
    buildConfigUri(target.id, targetRef),
    t('{dataId}: {source} compared with {target}', {
      dataId: targetRef.dataId,
      source: environmentAddress(options.source.instance.label, options.source.ref.namespaceId),
      target: environmentAddress(target.label, namespace.namespaceId)
    })
  );
}

/**
 * Whether the target holds this configuration at all.
 *
 * `resource-not-found` is the one kind that answers this question: it is
 * raised for a dataId nobody published and deliberately does not fall
 * through, so it can be told apart from a server that could not be reached.
 * Anything else is a failure and is left to the caller, which reports it --
 * reading a 500 as "not there" would send a user looking for a config they
 * still have.
 *
 * The content it fetches is thrown away; the diff refetches both sides
 * through the document provider. That is one extra read of one configuration,
 * and it buys the difference between a sentence and a blank pane.
 */
async function hasConfig(client: CompareConfigClient, ref: NacosConfigRef): Promise<boolean> {
  try {
    await client.getConfig(ref);
    return true;
  } catch (error) {
    if (error instanceof NacosApiError && error.kind === 'resource-not-found') {
      return false;
    }
    throw error;
  }
}

/**
 * Which server to compare with: the only one, or the one picked.
 *
 * One instance is not a choice -- and it is still the useful case, because
 * the namespace pick below is where two environments of one server are told
 * apart.
 */
async function pickTargetInstance(
  options: CompareAcrossEnvironmentsOptions
): Promise<NacosInstanceConfig | undefined> {
  const instances = await options.listInstances();
  if (instances.length === 0) {
    await vscode.window.showInformationMessage(t('No Nacos instances configured yet.'));
    return undefined;
  }
  if (instances.length === 1) {
    return instances[0];
  }
  const picked = await vscode.window.showQuickPick(
    instances.map((instance) => ({
      label: instance.label,
      description: instance.serverUrl,
      instance
    })),
    { placeHolder: t('Select the Nacos instance to compare with') }
  );
  return picked?.instance;
}

async function pickTargetNamespace(
  namespaces: NacosNamespace[],
  source: ConfigLocation,
  target: NacosInstanceConfig
): Promise<NacosNamespace | undefined> {
  const candidates = namespaces.filter(
    (namespace) => target.id !== source.instance.id || namespace.namespaceId !== source.ref.namespaceId
  );
  if (candidates.length === 0) {
    // A pick with no entries is a dialog that opens and closes on the same
    // click, which reads as a command that is broken rather than as an
    // instance that has nowhere to compare against.
    await vscode.window.showInformationMessage(
      t('{instance} has no other namespace to compare {dataId} with.', {
        dataId: source.ref.dataId,
        instance: target.label
      })
    );
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    candidates.map((namespace) => ({
      label: namespaceChoiceLabel(namespace),
      description: namespace.namespaceId,
      namespace
    })),
    { placeHolder: t('Select the namespace to compare with') }
  );
  return picked?.namespace;
}

/**
 * What to call a namespace in the pick. 1.x and 2.x give the default
 * namespace an empty id *and* an empty name, which would render an invisible
 * entry.
 */
function namespaceChoiceLabel(namespace: NacosNamespace): string {
  return namespace.displayName || namespace.namespaceId || t('public');
}

/**
 * One side of a comparison, as an address rather than a sentence: the
 * instance the user named and the namespace on it.
 *
 * Untranslated, deliberately. Both halves are identifiers -- a label the user
 * typed and an id the server keeps -- and `public` is literally the id from
 * Nacos 3.x on, so translating it would print something no server answers to.
 */
function environmentAddress(instanceLabel: string, namespaceId: string): string {
  return `${instanceLabel} / ${namespaceAddress(namespaceId)}`;
}

function namespaceAddress(namespaceId: string): string {
  return namespaceId === '' ? 'public' : namespaceId;
}

/**
 * How to name one version of a configuration.
 *
 * When it was written, where the server said -- that is what somebody looking
 * for "the version from before the incident" is matching against. The record
 * id is the fallback rather than the first choice: it is unique and
 * meaningless, and `modifiedAt` is optional on the wire.
 */
export function historyVersionLabel(entry: Pick<NacosConfigHistoryEntry, 'id' | 'modifiedAt'>): string {
  return entry.modifiedAt === undefined ? `#${entry.id}` : formatTimestamp(entry.modifiedAt);
}
