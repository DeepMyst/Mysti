/**
 * Mock vscode module for testing providers outside of VS Code.
 * Provides the minimum surface area needed by BaseCliProvider and subclasses.
 */

const configValues: Record<string, unknown> = {};

/** Records every `config.update(key, value)` call made by code under test. */
const configUpdates: Record<string, unknown> = {};

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
  inspect() {
    return undefined;
  },
  update(key?: string, value?: unknown) {
    if (typeof key === 'string') {
      configUpdates[key] = value;
    }
    return Promise.resolve();
  },
};

export const workspace = {
  getConfiguration(_section?: string) {
    return mockWorkspaceConfiguration;
  },
  workspaceFolders: [{
    uri: { fsPath: '/mock/workspace' },
    name: 'mock',
    index: 0,
  }],
  onDidChangeConfiguration: () => ({ dispose: () => {} }),
  createFileSystemWatcher: () => ({
    onDidCreate: () => ({ dispose: () => {} }),
    onDidChange: () => ({ dispose: () => {} }),
    onDidDelete: () => ({ dispose: () => {} }),
    dispose: () => {},
  }),
};

export const window = {
  showInformationMessage: () => Promise.resolve(undefined),
  showWarningMessage: () => Promise.resolve(undefined),
  showErrorMessage: () => Promise.resolve(undefined),
  createOutputChannel: () => ({
    appendLine: () => {},
    append: () => {},
    show: () => {},
    dispose: () => {},
  }),
};

export const Uri = {
  file: (path: string) => ({ fsPath: path, scheme: 'file', path }),
  parse: (uri: string) => ({ fsPath: uri, scheme: 'file', path: uri }),
  joinPath: (base: { fsPath?: string; path?: string }, ...segments: string[]) => {
    const joined = [base?.fsPath ?? base?.path ?? '', ...segments].join('/');
    return { fsPath: joined, scheme: 'file', path: joined, toString: () => joined };
  },
};

export const commands = {
  registerCommand: () => ({ dispose: () => {} }),
  executeCommand: () => Promise.resolve(),
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

export const Disposable = {
  from: () => ({ dispose: () => {} }),
};

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
  Uri,
  commands,
  EventEmitter,
  Disposable,
  TreeItemCollapsibleState,
  ConfigurationTarget,
};
