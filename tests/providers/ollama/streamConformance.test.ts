/**
 * Ollama tool-card resolution strategy (Plan 02 Phase 3).
 *
 * Ollama emits tool_use chunks (the model can request tool calls) but NEVER
 * executes them, so no tool_result follows and none may be fabricated. The
 * chosen, documented strategy: declare `emitsToolResults: false` in the
 * capability manifest and rely on the webview auto-resolving running tool
 * cards when the response completes.
 */
import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { OllamaProvider } from '../../../src/providers/ollama/OllamaProvider';

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

describe('OllamaProvider stream conformance', () => {
  it('declares emitsToolResults: false — webview auto-resolves tool cards', () => {
    const provider = new OllamaProvider(createMockContext());
    expect(provider.capabilities.emitsToolResults).toBe(false);
  });
});

describe('OllamaProvider context window', () => {
  it('reports the num_ctx Ollama LOADED (/api/ps), not the trained maximum', async () => {
    const provider = new OllamaProvider(createMockContext());
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith('/api/ps')) {
        return new Response(JSON.stringify({ models: [{ name: 'deepseek-r1:latest', model: 'deepseek-r1:latest', context_length: 4096 }] }));
      }
      const body = JSON.stringify({ message: { content: 'hi' }, done: false }) + '\n'
        + JSON.stringify({ done: true, prompt_eval_count: 3000, eval_count: 5 }) + '\n';
      return new Response(body);
    }) as typeof fetch;
    try {
      const settings = { provider: 'ollama', model: 'deepseek-r1', mode: 'default', accessLevel: 'ask-permission', thinkingLevel: 'none', contextMode: 'auto' } as never;
      const chunks = [];
      for await (const c of provider.sendMessage('hi', [], settings, null, undefined, 'p1')) { chunks.push(c); }
      const done = chunks.find(c => c.type === 'done');
      expect(done?.contextWindow).toBe(4096);
      expect(done?.usage).toMatchObject({ input_tokens: 3000 });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
