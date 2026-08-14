import * as vscode from 'vscode';
import { configLanguageId } from '../nacos/driver/configLanguage';
import type { NacosConfigSummary } from '../nacos/driver/normalize';
import { buildConfigUri } from './configUri';

/**
 * Opens one configuration in VS Code's editor, in the right language mode.
 *
 * Takes the summary the tree already holds rather than a bare ref, because
 * `type` is what decides the highlighting and only the listing carries it --
 * fetching the detail here to read it would double every open.
 *
 * The mode is set through `setTextDocumentLanguage` rather than inferred from
 * the address. Inferring means appending an extension the dataId does not
 * have, and VS Code titles the tab after the last path segment: a config
 * called `application-uat` would open as `application-uat.yaml`, and one
 * called `application-uat.yml` as `application-uat.yml.yaml`.
 *
 * Set before the editor is revealed, so the text is tokenized once rather
 * than re-tokenized a frame after it appears. No failure is caught: every id
 * `configLanguageId` can return is a language VS Code ships built in, so a
 * rejection means that table is wrong and should be seen rather than shown as
 * an unhighlighted document.
 */
export async function openConfigDocument(
  instanceId: string,
  config: NacosConfigSummary,
  options?: vscode.TextDocumentShowOptions
): Promise<vscode.TextDocument> {
  const opened = await vscode.workspace.openTextDocument(buildConfigUri(instanceId, config));
  const document = await vscode.languages.setTextDocumentLanguage(opened, configLanguageId(config));
  await vscode.window.showTextDocument(document, { preview: false, ...options });
  return document;
}
