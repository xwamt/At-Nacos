import * as vscode from 'vscode';
import { t } from '../i18n/t';
import type { NacosConfigDetail, NacosConfigRef } from '../nacos/driver/normalize';
import { buildDraftUri, parseDraftUri } from './draftUri';

export interface DraftConfigMetadata {
  type?: string;
  appName?: string;
  description?: string;
  baseContent: string;
  baseMd5?: string;
}

export interface DraftEntry extends DraftConfigMetadata {
  instanceId: string;
  ref: NacosConfigRef;
  content: string;
  ctime: number;
  mtime: number;
}

/**
 * In-memory FileSystemProvider for editable configuration drafts under the
 * `nacos-draft:` scheme.
 *
 * **Preserves VS Code editor capabilities:** Full syntax highlighting, code
 * completion, formatting, and undo/redo history work out of the box.
 *
 * **Save does not equal publish:** When an operator presses Ctrl+S, VS Code calls
 * `writeFile`, updating the in-memory draft and marking it saved locally.
 * No network requests to the server are made until explicit publish confirmation.
 */
export class NacosDraftFileSystemProvider implements vscode.FileSystemProvider {
  private readonly drafts = new Map<string, DraftEntry>();
  private readonly onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

  readonly onDidChangeFile = this.onDidChangeFileEmitter.event;

  /**
   * Initializes or updates an in-memory draft with the latest content retrieved
   * from the server.
   */
  initDraft(instanceId: string, ref: NacosConfigRef, detail: NacosConfigDetail): vscode.Uri {
    const uri = buildDraftUri(instanceId, ref);
    const key = uri.toString();
    const existing = this.drafts.get(key);
    const now = Date.now();

    const entry: DraftEntry = {
      instanceId,
      ref,
      content: existing ? existing.content : detail.content,
      baseContent: detail.content,
      baseMd5: detail.md5,
      type: detail.type,
      appName: detail.appName,
      description: detail.description,
      ctime: existing ? existing.ctime : now,
      mtime: now
    };

    this.drafts.set(key, entry);
    return uri;
  }

  /**
   * Returns the draft entry for a given URI or target reference.
   */
  getDraft(target: vscode.Uri | { instanceId: string; ref: NacosConfigRef }): DraftEntry | undefined {
    const uri = 'scheme' in target ? target : buildDraftUri(target.instanceId, target.ref);
    return this.drafts.get(uri.toString());
  }

  /**
   * Deletes a draft entry when discarded or cleaned up.
   */
  deleteDraft(target: vscode.Uri | { instanceId: string; ref: NacosConfigRef }): void {
    const uri = 'scheme' in target ? target : buildDraftUri(target.instanceId, target.ref);
    const key = uri.toString();
    if (this.drafts.delete(key)) {
      this.onDidChangeFileEmitter.fire([
        {
          type: 2 as vscode.FileChangeType.Deleted,
          uri
        }
      ]);
    }
  }

  /**
   * Whether the draft has uncommitted local modifications compared to its base content.
   */
  isDirty(target: vscode.Uri | { instanceId: string; ref: NacosConfigRef }): boolean {
    const draft = this.getDraft(target);
    return draft ? draft.content !== draft.baseContent : false;
  }

  /**
   * Marks the draft clean after a successful publish.
   */
  markClean(
    target: vscode.Uri | { instanceId: string; ref: NacosConfigRef },
    newBaseContent: string,
    newBaseMd5?: string
  ): void {
    const draft = this.getDraft(target);
    if (draft) {
      draft.baseContent = newBaseContent;
      draft.content = newBaseContent;
      if (newBaseMd5 !== undefined) {
        draft.baseMd5 = newBaseMd5;
      }
      draft.mtime = Date.now();
    }
  }

  watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: string[] }): vscode.Disposable {
    return { dispose: () => undefined };
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const draft = this.drafts.get(uri.toString());
    if (!draft) {
      const target = parseDraftUri(uri);
      if (!target) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      throw vscode.FileSystemError.FileNotFound(
        t('Configuration draft {dataId} is not currently open.', { dataId: target.ref.dataId })
      );
    }
    const size = Buffer.byteLength(draft.content, 'utf8');
    return {
      type: 1 as vscode.FileType.File,
      ctime: draft.ctime,
      mtime: draft.mtime,
      size,
      permissions: undefined
    };
  }

  readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(_uri: vscode.Uri): void {
    // Read-only virtual directory structure
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const draft = this.drafts.get(uri.toString());
    if (!draft) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return Buffer.from(draft.content, 'utf8');
  }

  writeFile(uri: vscode.Uri, content: Uint8Array, _options: { create: boolean; overwrite: boolean }): void {
    const key = uri.toString();
    const draft = this.drafts.get(key);
    const text = Buffer.from(content).toString('utf8');
    const now = Date.now();

    if (draft) {
      draft.content = text;
      draft.mtime = now;
    } else {
      const target = parseDraftUri(uri);
      if (!target) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      this.drafts.set(key, {
        instanceId: target.instanceId,
        ref: target.ref,
        content: text,
        baseContent: '',
        ctime: now,
        mtime: now
      });
    }

    this.onDidChangeFileEmitter.fire([
      {
        type: 0 as vscode.FileChangeType.Changed,
        uri
      }
    ]);
  }

  delete(uri: vscode.Uri, _options: { recursive: boolean }): void {
    this.deleteDraft(uri);
  }

  rename(_oldUri: vscode.Uri, _newUri: vscode.Uri, _options: { overwrite: boolean }): void {
    throw vscode.FileSystemError.NoPermissions('Renaming configuration drafts is not supported.');
  }

  dispose(): void {
    this.drafts.clear();
    this.onDidChangeFileEmitter.dispose();
  }
}
