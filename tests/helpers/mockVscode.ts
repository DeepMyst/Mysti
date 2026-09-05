/**
 * Mock vscode module for testing providers outside of VS Code.
 * Provides the minimum surface area needed by BaseCliProvider and subclasses.
 */

const configValues: Record<string, unknown> = {};

/** Records every `config.update(key, value)` call made by code under test. */
const configUpdates: Record<string, unknown> = {};

/**
 * Per-scope values returned by `config.inspect(key)`. OPT-IN: a key that was
 * never registered here still makes `inspect()` return undefined, exactly as
 * before, so existing suites are unaffected. Use this when the code under test
 * distinguishes "the user set this explicitly" from "this is the default"
 * (settingsClamp, BoostManager's overlay precedence).
 */
interface MockInspectResult {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
  defaultValue?: unknown;
}
const configInspect: Record<string, MockInspectResult> = {};

export function setMockConfigInspect(key: string, scopes: MockInspectResult): void {
  configInspect[key] = scopes;
}

export function setMockConfig(key: string, value: unknown): void {
  configValues[key] = value;
}

export function clearMockConfig(): void {
  for (const key of Object.keys(configValues)) {
    delete configValues[key];
  }
  for (const key of Object.keys(configUpdates)) {
    delete configUpdates[key];
  }
  for (const key of Object.keys(configInspect)) {
    delete configInspect[key];
  }
}

/** Read back the values written via `config.update()` (record-only; reads still come from setMockConfig). */
export function getMockConfigUpdates(): Record<string, unknown> {
  return configUpdates;
}

const mockWorkspaceConfiguration = {
  get<T>(key: string, defaultValue?: T): T {
    if (key in configValues) {
      return configValues[key] as T;
    }
    return defaultValue as T;
  },
  has(key: string): boolean {
    return key in configValues;
  },
  inspect(key?: string) {
    if (typeof key === 'string' && key in configInspect) {
      return { key, ...configInspect[key] };
    }
    return undefined;
  },
  update(key?: string, value?: unknown) {
    if (typeof key === 'string') {
      configUpdates[key] = value;
    }
    return Promise.resolve();
  },
};

/** Configuration-change event plumbing (used by CliDiscoveryService tests). */
type ConfigChangeListener = (e: { affectsConfiguration: (section: string) => boolean }) => void;
const configChangeListeners: ConfigChangeListener[] = [];

/**
 * Fire a configuration-change event for `changedSection` to all registered
 * onDidChangeConfiguration listeners. affectsConfiguration(query) mirrors
 * VS Code semantics: true when the changed section is the query or nested
 * under it (and vice versa).
 */
export function fireConfigurationChange(changedSection: string): void {
  const event = {
    affectsConfiguration: (section: string) =>
      changedSection === section ||
      changedSection.startsWith(section + '.') ||
      section.startsWith(changedSection + '.'),
  };
  for (const listener of [...configChangeListeners]) {
    listener(event);
  }
}

export function clearConfigurationListeners(): void {
  configChangeListeners.length = 0;
}

export const workspace = {
  getConfiguration(_section?: string) {
    return mockWorkspaceConfiguration;
  },
  workspaceFolders: [{
    uri: { fsPath: '/mock/workspace' },
    name: 'mock',
    index: 0,
  }],
  onDidChangeConfiguration: (listener?: ConfigChangeListener) => {
    if (typeof listener === 'function') {
      configChangeListeners.push(listener);
    }
    return {
      dispose: () => {
        if (listener) {
          const index = configChangeListeners.indexOf(listener);
          if (index >= 0) {
            configChangeListeners.splice(index, 1);
          }
        }
      },
    };
  },
  createFileSystemWatcher: () => ({
    onDidCreate: () => ({ dispose: () => {} }),
    onDidChange: () => ({ dispose: () => {} }),
    onDidDelete: () => ({ dispose: () => {} }),
    dispose: () => {},
  }),
  onDidSaveTextDocument: (_listener?: (doc: unknown) => void) => ({ dispose: () => {} }),
};

/**
 * In-memory SecretStorage stub (vscode.SecretStorage shape). Use via
 * `createMockSecretStorage()` to get an isolated instance per test.
 */
export function createMockSecretStorage() {
  const store = new Map<string, string>();
  const listeners: Array<(e: { key: string }) => void> = [];
  return {
    /** Exposed for assertions in tests (not part of the vscode API). */
    _store: store,
    async get(key: string): Promise<string | undefined> {
      return store.get(key);
    },
    async store(key: string, value: string): Promise<void> {
      store.set(key, value);
      for (const l of [...listeners]) { l({ key }); }
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
      for (const l of [...listeners]) { l({ key }); }
    },
    onDidChange: (listener?: (e: { key: string }) => void) => {
      if (typeof listener === 'function') { listeners.push(listener); }
      return { dispose: () => {
        if (listener) {
          const i = listeners.indexOf(listener);
          if (i >= 0) { listeners.splice(i, 1); }
        }
      } };
    },
  };
}

/**
 * In-memory Memento stub (vscode.Memento shape). Use via
 * `createMockMemento()` for an isolated instance per test.
 */
export function createMockMemento() {
  const store = new Map<string, unknown>();
  return {
    _store: store,
    get<T>(key: string, defaultValue?: T): T | undefined {
      return store.has(key) ? (store.get(key) as T) : defaultValue;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) { store.delete(key); }
      else { store.set(key, value); }
    },
    keys(): readonly string[] {
      return [...store.keys()];
    },
    setKeysForSync(): void { /* no-op */ },
  };
}

export const window = {
  showInformationMessage: () => Promise.resolve(undefined),
  showWarningMessage: () => Promise.resolve(undefined),
  showErrorMessage: () => Promise.resolve(undefined),
  showInputBox: () => Promise.resolve(undefined),
  /**
   * Defaults to "the user cancelled" — the safe answer for a picker, and the
   * one that keeps a test honest unless it deliberately stubs a selection:
   *   window.showQuickPick = async () => [{ label: 'Gemini', id: 'google-gemini' }];
   * Restore it in afterEach; `resetWindowStubs()` below does that for you.
   */
  showQuickPick: (..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined),
  // Invoke the task immediately with a no-op progress + cancellation token and
  // return its promise (matches vscode.window.withProgress semantics).
  withProgress: <T>(_opts: unknown, task: (progress: { report: (v: unknown) => void }, token: { isCancellationRequested: boolean; onCancellationRequested: () => { dispose: () => void } }) => Thenable<T>): Thenable<T> =>
    task({ report: () => {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }),
  createOutputChannel: () => ({
    appendLine: () => {},
    append: () => {},
    show: () => {},
    dispose: () => {},
  }),
};

/** Restore the stubbable `window` members to their defaults (use in afterEach). */
export function resetWindowStubs(): void {
  window.showQuickPick = () => Promise.resolve(undefined);
}

/**
 * `new vscode.RelativePattern(base, pattern)` — the glob form file watchers
 * take. Real enough for code under test to construct one and for assertions to
 * read `base`/`pattern` back; it does no matching, because nothing in the mock
 * watches a real filesystem.
 */
export class RelativePattern {
  public baseUri: { fsPath: string };
  public base: string;
  constructor(base: string | { uri?: { fsPath: string }; fsPath?: string }, public pattern: string) {
    const fsPath = typeof base === 'string'
      ? base
      : (base?.uri?.fsPath ?? base?.fsPath ?? '');
    this.base = fsPath;
    this.baseUri = { fsPath };
  }
}

/** Editor column targets — `createWebviewPanel`'s third argument. */
export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export const env = {
  uriScheme: 'vscode',
  openExternal: () => Promise.resolve(true),
  asExternalUri: (uri: unknown) => Promise.resolve(uri),
};

export const Uri = {
  file: (path: string) => ({ fsPath: path, scheme: 'file', path }),
  parse: (uri: string) => ({ fsPath: uri, scheme: 'file', path: uri, toString: () => uri }),
  joinPath: (base: { fsPath?: string; path?: string }, ...segments: string[]) => {
    const joined = [base?.fsPath ?? base?.path ?? '', ...segments].join('/');
    return { fsPath: joined, scheme: 'file', path: joined, toString: () => joined };
  },
};

export const commands = {
  registerCommand: () => ({ dispose: () => {} }),
  executeCommand: () => Promise.resolve(),
};

export const extensions = {
  getExtension: (_id: string) => undefined as unknown,
  all: [] as unknown[],
};

export const EventEmitter = class<T = unknown> {
  private _listeners: Array<(data: T) => void> = [];
  event = (listener?: (data: T) => void) => {
    if (typeof listener === 'function') {
      this._listeners.push(listener);
    }
    return {
      dispose: () => {
        if (listener) {
          const index = this._listeners.indexOf(listener);
          if (index >= 0) {
            this._listeners.splice(index, 1);
          }
        }
      },
    };
  };
  fire(data: T) {
    for (const listener of [...this._listeners]) {
      listener(data);
    }
  }
  dispose() {
    this._listeners = [];
  }
};

/**
 * vscode.Disposable mock — a real class so `new vscode.Disposable(fn)` works
 * (used by AgentLifecycleManager.onLifecycleEvent) while keeping the static
 * `from(...)` helper available.
 */
export class Disposable {
  private readonly _callOnDispose?: () => void;
  constructor(callOnDispose?: () => void) {
    this._callOnDispose = callOnDispose;
  }
  dispose(): void {
    this._callOnDispose?.();
  }
  static from(...disposables: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => {
      for (const d of disposables) {
        d.dispose();
      }
    });
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

// Default export for `import * as vscode from 'vscode'`
export default {
  workspace,
  window,
  env,
  Uri,
  commands,
  EventEmitter,
  Disposable,
  TreeItemCollapsibleState,
  ConfigurationTarget,
  ProgressLocation,
};
