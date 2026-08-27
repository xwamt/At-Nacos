export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2
}

export class TreeItem {
  label?: string;
  collapsibleState?: TreeItemCollapsibleState;
  contextValue?: string;
  command?: unknown;
  description?: string;
  tooltip?: string;

  constructor(label?: string, collapsibleState?: TreeItemCollapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];

  event = (listener: (value: T) => void): { dispose(): void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((entry) => entry !== listener);
      }
    };
  };

  fire(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners = [];
  }
}

export class Uri {
  constructor(
    public readonly fsPath: string,
    public readonly scheme = 'file',
    public readonly path = fsPath,
    public readonly query = '',
    /**
     * The empty string when there is no authority, which is what `vscode.Uri`
     * reports -- never undefined. A fixture answering undefined would let a
     * check for "this URI has no authority" pass here and mean something else
     * in the extension host.
     */
    public readonly authority = ''
  ) {}

  static file(path: string): Uri {
    return new Uri(path);
  }

  static joinPath(base: Uri, ...paths: string[]): Uri {
    return new Uri([base.fsPath, ...paths].join('/'));
  }

  static from(parts: { scheme: string; path: string; query?: string; authority?: string }): Uri {
    return new Uri(parts.path, parts.scheme, parts.path, parts.query ?? '', parts.authority ?? '');
  }

  /**
   * `scheme://authority/path` when there is an authority and `scheme:path`
   * when there is not, as the real one writes it.
   *
   * The one liberty taken is that the components are not percent-encoded
   * again on the way out -- `vscode.Uri` escapes everything outside
   * `A-Za-z0-9-._~/` in a path, so it renders a literal `%` as `%25`. Assert
   * on the components, therefore, and keep any assertion on this string to
   * one that a stricter encoder could not change: two URIs differing, or a
   * secret being absent.
   */
  toString(): string {
    const authority = this.authority ? `//${this.authority}` : '';
    return `${this.scheme}:${authority}${this.path}${this.query ? `?${this.query}` : ''}`;
  }
}

export const ThemeIcon = class {
  constructor(
    public readonly id: string,
    public readonly color?: unknown
  ) {}
};

export const ThemeColor = class {
  constructor(public readonly id: string) {}
};

export interface TextDocument {
  uri: Uri;
  fileName: string;
  languageId?: string;
  isDirty?: boolean;
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15
}

export class StatusBarItem {
  text = '';
  tooltip: string | undefined;
  command: string | undefined;
  visible = false;

  show(): void {
    this.visible = true;
  }

  hide(): void {
    this.visible = false;
  }

  dispose(): void {
    this.visible = false;
  }
}

const didSaveTextDocument = new EventEmitter<TextDocument>();
const didCloseTextDocument = new EventEmitter<TextDocument>();
const didChangeTabs = new EventEmitter<{ closed: unknown[] }>();
const dialogState = {
  openDialogResults: [] as Uri[][],
  saveDialogResults: [] as Uri[],
  inputBoxResults: [] as Array<string | undefined>,
  quickPickResults: [] as unknown[]
};

/**
 * Records what the extension wrote to its `LogOutputChannel`, so a test can
 * assert on the channel without a VS Code host. `__getLogChannels` is the
 * escape hatch; the object itself satisfies the `LogSink` shape
 * `src/utils/logger.ts` expects.
 */
export class LogOutputChannel {
  readonly lines: Array<{ level: string; message: string }> = [];

  constructor(public readonly name: string) {}

  private append(level: string, message: string): void {
    this.lines.push({ level, message });
  }

  error(message: string): void {
    this.append('error', message);
  }

  warn(message: string): void {
    this.append('warn', message);
  }

  info(message: string): void {
    this.append('info', message);
  }

  debug(message: string): void {
    this.append('debug', message);
  }

  trace(message: string): void {
    this.append('trace', message);
  }

  appendLine(message: string): void {
    this.append('info', message);
  }

  show(): void {
    // No-op: nothing to reveal in the fixture.
  }

  dispose(): void {
    this.lines.length = 0;
  }
}

const logChannels: LogOutputChannel[] = [];

/**
 * What `window.createTreeView` was asked for, so a test can assert that
 * `activate` wired the right provider to the right view id. Recorded rather
 * than spied on because `vscode.TreeView` declares a dozen members a fixture
 * has no use for, and a spy would have to fake all of them to typecheck.
 */
export interface RecordedTreeView {
  viewId: string;
  treeDataProvider: unknown;
  disposed: boolean;
  /** What the extension wrote to `TreeView.message`, which is where a tree reports its filter. */
  message: string | undefined;
}

const treeViews: RecordedTreeView[] = [];

/** What the extension wrote to the status bar, so a test can assert a hint was shown. */
const statusBarMessages: string[] = [];

export const window = {
  createOutputChannel: (name: string, _options?: { log: true }): LogOutputChannel => {
    const channel = new LogOutputChannel(name);
    logChannels.push(channel);
    return channel;
  },
  __getLogChannels: (): LogOutputChannel[] => logChannels,
  __clearLogChannels: (): void => {
    logChannels.length = 0;
  },
  __resetDialogs: () => {
    dialogState.openDialogResults = [];
    dialogState.saveDialogResults = [];
    dialogState.inputBoxResults = [];
    dialogState.quickPickResults = [];
  },
  __setOpenDialogResult: (path: string) => {
    dialogState.openDialogResults.push([Uri.file(path)]);
  },
  __setSaveDialogResult: (path: string) => {
    dialogState.saveDialogResults.push(Uri.file(path));
  },
  __setInputBoxResults: (values: Array<string | undefined>) => {
    dialogState.inputBoxResults.push(...values);
  },
  __setQuickPickResults: (values: unknown[]) => {
    dialogState.quickPickResults.push(...values);
  },
  showOpenDialog: async () => dialogState.openDialogResults.shift(),
  showSaveDialog: async () => dialogState.saveDialogResults.shift(),
  // The options are declared, though nothing here reads them, so that a test
  // can spy on this and assert what the extension put in the box -- a prompt
  // or a prefilled value is part of the behaviour, not decoration.
  showInputBox: async (_options?: { prompt?: string; placeHolder?: string; value?: string }) =>
    dialogState.inputBoxResults.shift(),
  showQuickPick: async () => dialogState.quickPickResults.shift(),
  showErrorMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  withProgress: async <T>(
    _options: unknown,
    task: (progress: { report(value: unknown): void }, token: unknown) => PromiseLike<T> | T
  ): Promise<T> =>
    task({
      report: () => undefined
    }, {}),
  createTreeView: (viewId: string, options?: { treeDataProvider?: unknown }) => {
    const record: RecordedTreeView = {
      viewId,
      treeDataProvider: options?.treeDataProvider,
      disposed: false,
      message: undefined
    };
    treeViews.push(record);
    return {
      dispose: () => {
        record.disposed = true;
      },
      // Proxied onto the record rather than held here, so that a test reading
      // `__getTreeViews()` sees what the extension set on the view it was
      // handed -- the view object itself never leaves `activate`.
      get message(): string | undefined {
        return record.message;
      },
      set message(value: string | undefined) {
        record.message = value;
      },
      title: undefined as string | undefined,
      treeDataProvider: options?.treeDataProvider,
      onDidChangeSelection: () => ({ dispose: () => undefined }),
      onDidExpandElement: () => ({ dispose: () => undefined }),
      onDidCollapseElement: () => ({ dispose: () => undefined }),
      reveal: async () => undefined
    };
  },
  __getTreeViews: (): RecordedTreeView[] => treeViews,
  __clearTreeViews: (): void => {
    treeViews.length = 0;
  },
  registerTreeDataProvider: (_viewId: string, _provider: unknown) => ({ dispose: () => undefined }),
  createWebviewPanel: (viewType?: string, title?: string, _showOptions?: unknown, options?: Record<string, unknown>) => {
    const messageListeners: Array<(message: unknown) => unknown> = [];
    const disposeListeners: Array<() => void> = [];
    let disposed = false;
    return {
      viewType,
      title,
      options,
      visible: true,
      reveal: () => undefined,
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        for (const listener of disposeListeners) {
          listener();
        }
      },
      onDidDispose: (listener: () => void) => {
        disposeListeners.push(listener);
        return { dispose: () => undefined };
      },
      webview: {
        html: '',
        cspSource: 'vscode-webview:',
        asWebviewUri: (uri: Uri) => uri,
        postMessage: async () => true,
        onDidReceiveMessage: (listener: (message: unknown) => unknown) => {
          messageListeners.push(listener);
          return { dispose: () => undefined };
        },
        /**
         * Delivers a message as the page would, so a test can drive the
         * handler `open()` wired up rather than the exported function behind
         * it. Awaited, because every handler in this extension is async and
         * an unawaited one would let an assertion run before it finished.
         */
        __fireMessage: async (message: unknown): Promise<void> => {
          for (const listener of messageListeners) {
            await listener(message);
          }
        }
      }
    };
  },
  showTextDocument: async (document: TextDocument) => document,
  createStatusBarItem: (_alignment?: StatusBarAlignment, _priority?: number) => new StatusBarItem(),
  setStatusBarMessage: (text: string, _hideAfterTimeout?: number) => {
    statusBarMessages.push(text);
    return { dispose: () => undefined };
  },
  __getStatusBarMessages: (): string[] => statusBarMessages,
  __clearStatusBarMessages: (): void => {
    statusBarMessages.length = 0;
  },
  tabGroups: {
    onDidChangeTabs: didChangeTabs.event,
    __fireDidChangeTabs: (event: { closed: unknown[] }) => didChangeTabs.fire(event)
  }
};

export const languages = {
  setTextDocumentLanguage: async (document: TextDocument, languageId: string): Promise<TextDocument> => ({
    ...document,
    languageId
  })
};

/** Keyed by command id, so a test can invoke exactly what `activate` registered. */
const registeredCommands = new Map<string, (...args: never[]) => unknown>();

export const commands = {
  registerCommand: (command: string, callback: (...args: never[]) => unknown) => {
    registeredCommands.set(command, callback);
    return {
      dispose: () => {
        // Only if it is still the same handler: a second `activate` overwrites
        // the entry, and disposing the first registration must not take the
        // live one with it.
        if (registeredCommands.get(command) === callback) {
          registeredCommands.delete(command);
        }
      }
    };
  },
  executeCommand: async () => undefined,
  __getRegisteredCommands: (): Map<string, (...args: never[]) => unknown> => registeredCommands,
  __clearRegisteredCommands: (): void => registeredCommands.clear()
};

export class LanguageModelTextPart {
  constructor(public readonly value: string) {}
}

export class LanguageModelToolResult {
  constructor(public readonly content: LanguageModelTextPart[]) {}
}

const registeredTools = new Map<string, { invoke(options: unknown): Promise<unknown> }>();

export const lm = {
  registerTool: (name: string, tool: { invoke(options: unknown): Promise<unknown> }) => {
    registeredTools.set(name, tool);
    return {
      dispose: () => {
        registeredTools.delete(name);
      }
    };
  },
  __getRegisteredTool: (name: string) => registeredTools.get(name),
  __clearRegisteredTools: () => registeredTools.clear()
};

/**
 * What `workspace.registerTextDocumentContentProvider` was handed. Recorded
 * for the reason the tree views are: a provider that is never registered
 * fails only when a user opens a `nacos:` URI, which no unit test does by
 * accident.
 */
export interface RecordedContentProvider {
  scheme: string;
  provider: unknown;
  disposed: boolean;
}

const contentProviders: RecordedContentProvider[] = [];

export class FileSystemError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'FileSystemError';
  }

  static FileNotFound(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(typeof messageOrUri === 'string' ? messageOrUri : 'File not found');
  }

  static NoPermissions(message?: string): FileSystemError {
    return new FileSystemError(message ?? 'No permissions');
  }
}

export interface RecordedFileSystemProvider {
  scheme: string;
  provider: unknown;
  disposed: boolean;
}

const fileSystemProviders: RecordedFileSystemProvider[] = [];

export const workspace = {
  registerTextDocumentContentProvider: (scheme: string, provider: unknown) => {
    const record: RecordedContentProvider = { scheme, provider, disposed: false };
    contentProviders.push(record);
    return {
      dispose: () => {
        record.disposed = true;
      }
    };
  },
  registerFileSystemProvider: (scheme: string, provider: unknown, _options?: { isReadonly?: boolean }) => {
    const record: RecordedFileSystemProvider = { scheme, provider, disposed: false };
    fileSystemProviders.push(record);
    return {
      dispose: () => {
        record.disposed = true;
      }
    };
  },
  __getFileSystemProviders: (): RecordedFileSystemProvider[] => fileSystemProviders,
  __clearFileSystemProviders: (): void => {
    fileSystemProviders.length = 0;
  },
  __getContentProviders: (): RecordedContentProvider[] => contentProviders,
  __clearContentProviders: (): void => {
    contentProviders.length = 0;
  },
  openTextDocument: async (uri: Uri): Promise<TextDocument> => ({
    uri,
    fileName: uri.fsPath,
    isDirty: false
  }),
  onDidSaveTextDocument: didSaveTextDocument.event,
  onDidCloseTextDocument: didCloseTextDocument.event,
  __fireDidSaveTextDocument: (document: TextDocument) => didSaveTextDocument.fire(document),
  __fireDidCloseTextDocument: (document: TextDocument) => didCloseTextDocument.fire(document),
  __clearDocumentListeners: (): void => {
    didSaveTextDocument.dispose();
    didCloseTextDocument.dispose();
  },
  getConfiguration: () => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue
  })
};

export const env = {
  clipboard: {
    writeText: async (_value: string) => undefined
  }
};

export enum ViewColumn {
  Active = -1,
  Beside = -2
}

export const l10n = {
  /**
   * No real translation happens here: tests assert the key and its arguments,
   * not the wording. What is worth copying exactly is the substitution, which
   * the extension host performs with `format2` for every overload -- rest
   * arguments arrive as an array, so `{0}` resolves as `values['0']` and both
   * forms share one code path. Two behaviours ride on that and are easy to get
   * wrong in a fixture: an unresolved placeholder stays literal rather than
   * becoming "undefined", and `??` (not `||`) means `0` and `false` still
   * substitute.
   */
  t(
    message: string,
    ...args: Array<string | number | boolean | Record<string, string | number | boolean>>
  ): string {
    const values: Record<string, unknown> =
      args.length === 1 && typeof args[0] === 'object' && args[0] !== null ? args[0] : { ...args };

    if (Object.keys(values).length === 0) {
      return message;
    }

    return message.replace(/{([^}]+)}/g, (match, key: string) => String(values[key] ?? match));
  }
};
