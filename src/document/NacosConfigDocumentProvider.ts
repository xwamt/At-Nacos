import * as vscode from 'vscode';
import type { NacosInstanceConfigManager } from '../config/NacosInstanceConfigManager';
import type { NacosInstanceConfig } from '../config/schema';
import { t } from '../i18n/t';
import { NacosApiError } from '../nacos/NacosApiError';
import type { NacosClient } from '../nacos/NacosClient';
import type { NacosConfigRef } from '../nacos/driver/normalize';
import { formatError } from '../utils/errors';
import { buildConfigUri, parseConfigUri, type NacosConfigDocumentTarget } from './configUri';

/**
 * Only the two read capabilities, so this provider cannot reach an endpoint
 * reading a config has no business calling.
 *
 * Both are here because both serve documents under this scheme: which of them
 * answers is decided by the address, and `getConfigHistory` returns the same
 * `NacosConfigDetail` that `getConfig` does precisely so that nothing below
 * that branch has to know which side of a diff it is rendering.
 */
export type NacosConfigDocumentClient = Pick<NacosClient, 'getConfig' | 'getConfigHistory'>;

/**
 * Injected for the same reason the tree's is: assembling a client means an
 * HTTP client, an auth strategy, a TLS verifier and a version probe, all of
 * which belong to the composition root. Building one per request is also what
 * makes an edit to the instance's address or credentials take effect the next
 * time a document is refreshed.
 */
export type NacosConfigDocumentClientFactory = (instance: NacosInstanceConfig) => Promise<NacosConfigDocumentClient>;

/**
 * Puts a Nacos configuration into VS Code's own editor, under the `nacos:`
 * scheme.
 *
 * A virtual document rather than a Webview, so that syntax highlighting,
 * folding, Ctrl+F, the minimap and -- in M4 -- the built-in side-by-side diff
 * editor all come for free rather than being reimplemented. Documents served
 * this way are read-only by construction, which is what M2 wants; M5's
 * editing takes a different route.
 */
export class NacosConfigDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();

  /** VS Code re-asks `provideTextDocumentContent` for every open document this fires for. */
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(
    private readonly configManager: Pick<NacosInstanceConfigManager, 'getInstance'>,
    private readonly createClient: NacosConfigDocumentClientFactory
  ) {}

  /**
   * Takes the ref rather than the URI, so that a caller holding a tree item
   * does not have to know how an address is spelled. Nothing fires it yet:
   * the refresh command that will is M2's Task 5 and M5's publish path.
   */
  refresh(instanceId: string, ref: NacosConfigRef): void {
    this.onDidChangeEmitter.fire(buildConfigUri(instanceId, ref));
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  /**
   * Resolves with a readable message on every failure instead of rejecting.
   * VS Code renders a rejected `provideTextDocumentContent` as an empty
   * editor and says nothing about why, so a rejection here is
   * indistinguishable to the user from a configuration that really is empty.
   */
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const target = parseConfigUri(uri);
    if (!target) {
      return t('AT Nacos cannot read this address as a configuration. Open the configuration again from the AT Nacos view.');
    }
    try {
      const instance = await this.configManager.getInstance(target.instanceId);
      if (!instance) {
        // Distinct from a fetch failure because nothing about the server is
        // wrong: the tab outlived the instance it was opened from, and no
        // amount of retrying will bring it back.
        return t(
          'This configuration belongs to a Nacos instance that is no longer configured. It was probably deleted while this editor stayed open.'
        );
      }
      const client = await this.createClient(instance);
      const detail =
        target.nid === undefined
          ? await client.getConfig(target.ref)
          : await client.getConfigHistory({ ...target.ref, nid: target.nid });
      return detail.content;
    } catch (error) {
      return describeReadFailure(error, target);
    }
  }
}

/**
 * Neither branch lets a raw error message through: the first does not quote
 * one at all and the second goes through `formatError`. This text lands in a
 * buffer the user can select, copy and paste into an issue, which outlives
 * any notification -- and a Nacos error message quotes the request that
 * failed, query string and all.
 */
function describeReadFailure(error: unknown, target: NacosConfigDocumentTarget): string {
  const { ref } = target;
  // The dataId is gone, not the endpoint -- the other half of Nacos's
  // overloaded 404. Quoting the API's own answer here would send the user
  // looking for a server fault instead of a deleted config.
  if (error instanceof NacosApiError && error.kind === 'resource-not-found') {
    // A missing *version* is its own sentence. Nacos prunes config history
    // after 30 days by default, so a history panel left open across a long
    // weekend can offer a version the server has since dropped -- and saying
    // the configuration was deleted there would report a deletion that never
    // happened, of something the user can still see in the tree.
    if (target.nid !== undefined) {
      return t(
        'Version {version} of {dataId} is no longer on the server. Nacos keeps a configuration\'s history for a limited time and prunes what is older.',
        { dataId: ref.dataId, version: target.nid }
      );
    }
    return t('The configuration {dataId} no longer exists in group {group}. It may have been deleted on the server.', {
      dataId: ref.dataId,
      group: ref.group
    });
  }
  return t('AT Nacos could not read the configuration {dataId}: {message}', {
    dataId: ref.dataId,
    message: formatError(error)
  });
}
