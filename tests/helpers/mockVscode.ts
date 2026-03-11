/**
 * Mock vscode module for testing providers outside of VS Code.
 * Provides the minimum surface area needed by BaseCliProvider and subclasses.
 */

const configValues: Record<string, unknown> = {};

export function setMockConfig(key: string, value: unknown): void {
  configValues[key] = value;
}

export function clearMockConfig(): void {
  for (const key of Object.keys(configValues)) {
    delete configValues[key];
  }
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
  update() {
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
};

export const commands = {
  registerCommand: () => ({ dispose: () => {} }),
  executeCommand: () => Promise.resolve(),
};

export const EventEmitter = class {
  event = () => ({ dispose: () => {} });
  fire() {}
  dispose() {}
};

export const Disposable = {
  from: () => ({ dispose: () => {} }),
};

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
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
};
