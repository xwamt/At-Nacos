import * as vscode from 'vscode';
import type { NacosInstanceConfig } from '../config/schema';
import { configLanguageId } from '../nacos/driver/configLanguage';
import type { NacosConfigRef } from '../nacos/driver/normalize';
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
}

/**
 * Opens an editable draft of a configuration in VS Code's editor.
 *
 * Checks that the instance is writable first (`assertWritable`).
 * Fetches the configuration from the server on first open to initialize the draft.
 * Sets the appropriate language mode from the config's `type` / dataId suffix.
 */
export async function openDraftDocument(options: OpenDraftDocumentOptions): Promise<vscode.TextDocument> {
  const { instance, ref, draftProvider, connect, showOptions } = options;

  assertWritable(instance);

  let draft = draftProvider.getDraft({ instanceId: instance.id, ref });
  if (!draft) {
    const client = await connect();
    const detail = await client.getConfig(ref);
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
