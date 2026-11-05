/**
 * LocalAI tool-card resolution strategy (Plan 02 Phase 3).
 *
 * LocalAI emits tool_use chunks (OpenAI-style tool_calls deltas) but NEVER
 * executes them, so no tool_result follows and none may be fabricated. The
 * chosen, documented strategy: declare `emitsToolResults: false` in the
 * capability manifest and rely on the webview auto-resolving running tool
 * cards when the response completes.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { appendFileSync } from 'node:fs';
import type { Settings, StreamChunk } from '../../../src/types';
import { clearConfigurationListeners, clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
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

// Complete, preclosed SSE responses only: this checks accounting, not EOF policy.
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); clearMockConfig(); clearConfigurationListeners();
});

describe('LocalAIProvider final usage frames', () => {
  it.each([
    { name: 'choice-bearing usage', choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 3 },
      expected: { input_tokens: 11, output_tokens: 3 } },
    { name: 'empty-choice usage', choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 3 },
      expected: { input_tokens: 11, output_tokens: 3 } },
    { name: 'absent usage estimate', choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: undefined,
      expected: { input_tokens: 0, output_tokens: 2, estimated: true } },
  ])('preserves exact accounting for $name', async row => {
    clearMockConfig();
    const endpoint = 'http://owned-localai.invalid:8080';
    setMockConfig('localaiEndpoint', endpoint);
    const provider = new LocalAIProvider(createMockContext());
    vi.spyOn(provider as any, 'buildPromptAsync').mockImplementation(async (content: unknown) => String(content));
    const settings = { provider: 'localai', model: 'owned-model', mode: 'quick-plan', accessLevel: 'read-only',
      thinkingLevel: 'none', contextMode: 'manual' } as Settings;
    const packets = [
      { choices: [{ delta: { content: 'A ' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'reply.' }, finish_reason: null }] },
      { choices: row.choices, ...(row.usage ? { usage: row.usage } : {}) },
    ];
    const wire = packets.map(packet => 'data: ' + JSON.stringify(packet) + '\n\n').join('')
      + 'data: [DONE]\n\n';
    let signal: AbortSignal | undefined;
    const calls: Array<{ url: string; method: string | undefined; body: unknown }> = [];
    // A real Response owns a complete body; every fetch is intercepted here.
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) });
      expect(String(url)).toBe(endpoint + '/v1/chat/completions');
      expect(init?.method).toBe('POST');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      signal = init!.signal as AbortSignal;
      return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
    }));
    const chunks: StreamChunk[] = [];
    let settled = false;
    try {
      for await (const chunk of provider.sendMessage('usage-frame request', [], settings, null, undefined, 'usage-panel')) {
        chunks.push(chunk);
      }
      settled = true;
      // Retain actual outputs before the accounting assertion on a red run.
      if (process.env.PB14_LOCALAI_USAGE_FRAMES_RECEIPT) {
        appendFileSync(process.env.PB14_LOCALAI_USAGE_FRAMES_RECEIPT, JSON.stringify({
          test: row.name, packets, calls, chunks, settled, signalAborted: signal?.aborted,
          nativeRequests: 0, children: 0,
        }) + '\n');
      }
      expect(calls).toHaveLength(1);
      expect(calls[0].body).toMatchObject({ model: 'owned-model', stream: true,
        messages: [{ role: 'user', content: 'usage-frame request' }] });
      expect(signal?.aborted).toBe(true);
      expect(chunks).toEqual([
        { type: 'text', content: 'A ' },
        { type: 'text', content: 'reply.' },
        { type: 'done', usage: row.expected },
      ]);
    } finally { provider.dispose(); }
  }, 5000);
});
