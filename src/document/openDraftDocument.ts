import * as vscode from 'vscode';
import type { NacosInstanceConfig } from '../config/schema';
import { NacosApiError } from '../nacos/NacosApiError';
import { configLanguageId, configTypeForDataId } from '../nacos/driver/configLanguage';
import type { NacosConfigDetail, NacosConfigRef } from '../nacos/driver/normalize';
import { assertWritable } from '../write/confirmWrite';
import type { NacosDraftFileSystemProvider } from './NacosDraftFileSystemProvider';
import { buildDraftUri } from './draftUri';
import type { NacosClient } from '../nacos/NacosClient';

export interface OpenDraftDocumentOptions {
  instance: NacosInstanceConfig;
  ref: NacosConfigRef;
  draftProvider: NacosDraftFileSystemProvider;
  connect: () => Promise<Pick<NacosClient, 'getConfig'>>;
  showOptions?: vscode.TextDocumentShowOptions;
  /**
   * Start the draft empty without asking the server first. Set by the create
   * flow, where the dataId came from an input box rather than a tree node, so
   * the only thing a fetch could answer is the resource-not-found this option
   * already assumes. Publishing goes through the same pipeline either way --
   * `publishConfig` re-reads the server and treats resource-not-found as
   * empty content, so a dataId that does exist after all is surfaced in the
   * confirmation diff rather than silently overwritten.
   */
  createNew?: boolean;
}

/**
 * Opens an editable draft of a configuration in VS Code's editor.
 *
 * Checks that the instance is writable first (`assertWritable`).
 * Fetches the configuration from the server on first open to initialize the
 * draft -- unless `createNew` skips the fetch, or the server answers
 * resource-not-found, both of which start from an empty draft instead.
 * Sets the appropriate language mode from the config's `type` / dataId suffix.
 */
export async function openDraftDocument(options: OpenDraftDocumentOptions): Promise<vscode.TextDocument> {
  const { instance, ref, draftProvider, connect, showOptions, createNew } = options;

  assertWritable(instance);

  let draft = draftProvider.getDraft({ instanceId: instance.id, ref });
  if (!draft) {
    const detail = createNew ? emptyDetail(ref) : await fetchDetailOrEmpty(connect, ref);
    draftProvider.initDraft(instance.id, ref, detail);
    draft = draftProvider.getDraft({ instanceId: instance.id, ref });
  }

  const uri = buildDraftUri(instance.id, ref);
  const opened = await vscode.workspace.openTextDocument(uri);
  const language = configLanguageId({ ...ref, type: draft?.type });
  const document = await vscode.languages.setTextDocumentLanguage(opened, language);

  await vscode.window.showTextDocument(document, { preview: false, ...showOptions });
  return document;
}

/**
 * What a configuration that does not exist yet starts from. Empty `content`
 * doubles as the draft's `baseContent`, which is the same emptiness
 * `publishConfig` reads off a resource-not-found -- so the first publish is
 * not flagged as a conflict. The type is inferred from the dataId suffix
 * because there is no server record to carry one, and leaving it unset would
 * make the first publish register the config as `text` however it is named.
 */
function emptyDetail(ref: NacosConfigRef): NacosConfigDetail {
  return { ...ref, content: '', type: configTypeForDataId(ref.dataId) };
}

/**
 * The server's current detail, or an empty one when the server says the
 * config does not exist. The fallback makes an edit of a just-deleted config
 * an upsert rather than a dead menu item -- the same reading of
 * resource-not-found that `publishConfig` applies on the way back up. Every
 * other failure still throws: an unreachable or refusing server is not an
 * empty config, and opening a blank draft over a real one invites publishing
 * that blankness.
 */
async function fetchDetailOrEmpty(
  connect: OpenDraftDocumentOptions['connect'],
  ref: NacosConfigRef
): Promise<NacosConfigDetail> {
  const client = await connect();
  try {
    return await client.getConfig(ref);
  } catch (error) {
    if (error instanceof NacosApiError && error.kind === 'resource-not-found') {
      return emptyDetail(ref);
    }
    throw error;
  }
}
