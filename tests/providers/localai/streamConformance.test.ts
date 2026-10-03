/**
 * LocalAI tool-card resolution strategy (Plan 02 Phase 3).
 *
 * LocalAI emits tool_use chunks (OpenAI-style tool_calls deltas) but NEVER
 * executes them, so no tool_result follows and none may be fabricated. The
 * chosen, documented strategy: declare `emitsToolResults: false` in the
 * capability manifest and rely on the webview auto-resolving running tool
 * cards when the response completes.
 */
import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { LocalAIProvider } from '../../../src/providers/localai/LocalAIProvider';

function createMockContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    globalState: { get: () => undefined, update: () => Promise.resolve(), keys: () => [], setKeysForSync: () => {} },
    workspaceState: { get: () => undefined, update: () => Promise.resolve(), keys: () => [] },
    extensionPath: '/mock/extension',
    extensionUri: vscode.Uri.file('/mock/extension'),
    storageUri: vscode.Uri.file('/mock/storage'),
    globalStorageUri: vscode.Uri.file('/mock/global-storage'),
    logUri: vscode.Uri.file('/mock/logs'),
    extensionMode: 1,
    extension: {} as never,
    environmentVariableCollection: {} as never,
    secrets: {} as never,
    languageModelAccessInformation: {} as never,
  } as unknown as vscode.ExtensionContext;
}

describe('LocalAIProvider stream conformance', () => {
  it('declares emitsToolResults: false — webview auto-resolves tool cards', () => {
    const provider = new LocalAIProvider(createMockContext());
    expect(provider.capabilities.emitsToolResults).toBe(false);
  });
});
