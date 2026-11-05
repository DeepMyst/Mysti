import { appendFileSync } from 'node:fs';
import type * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaProvider } from '../../../src/providers/ollama/OllamaProvider';
import type { Settings, StreamChunk } from '../../../src/types';
import { clearConfigurationListeners, clearMockConfig, createMockSecretStorage, setMockConfig } from '../../helpers/mockVscode';

// Finite, preclosed in-memory HTTP bodies. No server, network, native model or
// subprocess is involved. Missing EOF markers are fixture input, not cleanup.
const endpoint = 'http://owned-ollama.invalid:11434';
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const settings = { provider: 'ollama', model: 'owned-model', mode: 'quick-plan',
  accessLevel: 'read-only', thinkingLevel: 'none', contextMode: 'manual' } as Settings;
const context = () => ({ subscriptions: [], secrets: createMockSecretStorage(),
  globalState: { get: () => undefined, update: async () => {} },
  workspaceState: { get: () => undefined, update: async () => {} } } as unknown as vscode.ExtensionContext);
class Provider extends OllamaProvider {
  protected async buildPromptAsync(content: string): Promise<string> { return content; }
}
const line = (packet: unknown) => JSON.stringify(packet) + '\n';
const text = (content: string) => ({ message: { content }, done: false });
const final = (input: number, output: number) => ({ done: true, prompt_eval_count: input, eval_count: output });
const proposalInput = { file_path: '/owned/canary.txt', old_string: 'before', new_string: 'after' };
const serverReason = 'Owned model generation failed after partial output';
const recoveryWire = line(text('Fresh recovery.')) + line(final(29, 7));
const recoveryChunks: StreamChunk[] = [{ type: 'text', content: 'Fresh recovery.' },
  { type: 'done', usage: { input_tokens: 29, output_tokens: 7 }, contextWindow: 4096 }];

interface Scenario { name: string; wire: string; outcome: 'server-error' | 'incomplete' | 'tail' | 'tool' | 'cancel';
  splitUtf8?: boolean; stopAfterProposal?: boolean }
const scenarios: Scenario[] = [
  { name: 'partial text then an HTTP 200 streamed server error',
    wire: line(text('Preserved partial.')) + line({ error: serverReason }), outcome: 'server-error' },
  { name: 'partial terminal-free EOF', wire: line(text('Preserved partial.')), outcome: 'incomplete' },
  { name: 'empty terminal-free EOF', wire: '', outcome: 'incomplete' },
  { name: 'truncated final JSON after partial text',
    wire: line(text('Preserved partial.')) + '{"done":true,"eval_count":', outcome: 'incomplete' },
  // Robustness only: the pinned native server normally appends newlines.
  { name: 'complete final JSON without newline across split UTF-8 bytes',
    wire: line(text('Prefix.')) + JSON.stringify({ message: { content: 'Tail 🙂.' }, ...final(11, 3) }),
    outcome: 'tail', splitUtf8: true },
  { name: 'one record with proposal, text, completion and usage',
    wire: line({ message: { content: 'Proposal explanation.', tool_calls: [{ function: {
      name: 'Edit', arguments: proposalInput,
    } }] }, ...final(11, 3) }), outcome: 'tool' },
  { name: 'Stop at a proposal before co-located text and completion',
    wire: line({ message: { content: 'Forbidden after Stop.', tool_calls: [{ function: {
      name: 'Edit', arguments: proposalInput,
    } }] }, ...final(91, 23) }), outcome: 'cancel', stopAfterProposal: true },
];

interface Turn {
  prompt: string; wire: string; splitUtf8: boolean; iterator: AsyncGenerator<StreamChunk>;
  chunks: StreamChunk[]; settled: boolean; returned: boolean;
}
interface ChatCall {
  url: string; body: unknown; signal: AbortSignal; abortEvents: number; response: Response;
  source: { closed: boolean; chunkBytes: number[]; cancelCalls: number }; detach: () => void;
}
async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = realSetTimeout(() => reject(new Error(`Owned Ollama completion fixture did not settle: ${label}`)), 3000);
    })]);
  } finally { if (timer) realClearTimeout(timer); }
}
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); clearMockConfig(); clearConfigurationListeners();
});

async function ownedCase(scenario: Scenario) {
  clearMockConfig(); setMockConfig('ollamaEndpoint', endpoint);
  const provider = new Provider(context());
  const turns: Turn[] = [], calls: ChatCall[] = [], pending: Promise<unknown>[] = [];
  const contextCalls: Array<{ url: string; method: string; response: Response }> = [];
  const cleanupErrors: string[] = [], actions: string[] = [];
  const notes: Record<string, unknown> = {};
  let bodyError: unknown, cleanupRequested = false, rawOperationsSettled = false;
  const retain = <T>(operation: Promise<T>) => {
    pending.push(operation); void operation.catch(() => {}); return operation;
  };
  const snapshot = () => ({
    calls: calls.map(call => ({ url: call.url, body: call.body, signalAborted: call.signal.aborted,
      abortEvents: call.abortEvents, bodyUsed: call.response.bodyUsed,
      readerLocked: call.response.body?.locked ?? null, source: { ...call.source } })),
    contextCalls: contextCalls.map(call => ({ url: call.url, method: call.method,
      bodyUsed: call.response.bodyUsed, readerLocked: call.response.body?.locked ?? null })),
    turns: turns.map(turn => ({ prompt: turn.prompt, wire: turn.wire, splitUtf8: turn.splitUtf8,
      chunks: [...turn.chunks], settled: turn.settled, returned: turn.returned })),
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url);
    if (address === endpoint + '/api/ps') {
      expect(init?.body).toBeUndefined();
      const response = new Response(JSON.stringify({ models: [{ name: 'owned-model', context_length: 4096 }] }));
      contextCalls.push({ url: address, method: init?.method ?? 'GET', response });
      return response;
    }
    expect(address).toBe(endpoint + '/api/chat');
    expect(init?.method).toBe('POST'); expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(calls.length).toBeLessThan(2);
    const turn = turns[calls.length]; expect(turn).toBeDefined();
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ model: 'owned-model', messages: [{ role: 'user', content: turn.prompt }],
      stream: true, keep_alive: '5m', options: { temperature: 0.7 } });
    const bytes = new TextEncoder().encode(turn.wire);
    const segments: Uint8Array[] = [];
    if (turn.splitUtf8) {
      const start = bytes.indexOf(0xf0);
      expect(start).toBeGreaterThan(0);
      // The first chunk ends inside the four-byte emoji, exercising decoding
      // independently of the final JSON record's absent newline.
      segments.push(bytes.slice(0, start + 2), bytes.slice(start + 2, start + 3), bytes.slice(start + 3));
    } else if (bytes.byteLength) segments.push(bytes);
    const source = { closed: false, chunkBytes: [] as number[], cancelCalls: 0 };
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const segment of segments) { controller.enqueue(segment); source.chunkBytes.push(segment.byteLength); }
        controller.close(); source.closed = true;
      },
      cancel() { source.cancelCalls++; },
    }), { headers: { 'content-type': 'application/x-ndjson' } });
    const signal = init!.signal as AbortSignal; expect(signal.aborted).toBe(false);
    const call: ChatCall = { url: address, body, signal, response, source, abortEvents: 0,
      detach() { signal.removeEventListener('abort', onAbort); } };
    function onAbort() { call.abortEvents++; }
    signal.addEventListener('abort', onAbort, { once: true }); calls.push(call);
    return response;
  }));
  const send = async (prompt: string, wire: string, splitUtf8 = false, stopAfterProposal = false) => {
    const turn: Turn = { prompt, wire, splitUtf8,
      iterator: provider.sendMessage(prompt, [], settings, null, undefined, 'same-panel'),
      chunks: [], settled: false, returned: false };
    turns.push(turn);
    if (stopAfterProposal) {
      const first = await bounded(retain(turn.iterator.next()), 'first public proposal');
      expect(first.done).toBe(false); expect(first.value?.type).toBe('tool_use');
      turn.chunks.push(first.value); actions.push('first-public-proposal');
      notes.beforeStop = snapshot();
      expect(calls[0].source.closed).toBe(true); expect(calls[0].source.chunkBytes).toHaveLength(1);
      expect(calls[0].response.body?.locked).toBe(true); expect(calls[0].signal.aborted).toBe(false);
      provider.cancelCurrentRequest('same-panel'); actions.push('public-stop');
      notes.afterStop = snapshot();
      expect(calls[0].signal.aborted).toBe(true); expect(calls[0].abortEvents).toBe(1);
      // Resume the suspended yield through public iteration. return() would
      // bypass the co-located text/completion continuation under test.
    }
    await bounded(retain((async () => {
      for await (const chunk of turn.iterator) turn.chunks.push(chunk);
      turn.settled = true;
    })()), 'public collection: ' + prompt);
    return turn.chunks;
  };
  try {
    const actual = await send('request-A', scenario.wire, scenario.splitUtf8, scenario.stopAfterProposal);
    if (scenario.stopAfterProposal) { actions.push('A-settled'); notes.afterA = snapshot(); }
    // Retain actual same-panel recovery even when the baseline A assertions fail.
    const recovery = await send('request-B', recoveryWire);
    if (scenario.stopAfterProposal) { actions.push('B-settled'); notes.afterB = snapshot(); }
    expect(recovery).toEqual(recoveryChunks);
    expect(provider.getStoredUsage('same-panel')).toBeNull();
    expect(actual.some(chunk => chunk.type === 'tool_result')).toBe(false);
    expect(actual.filter(chunk => chunk.type === 'done')).toHaveLength(1);
    if (scenario.outcome === 'tail' || scenario.outcome === 'tool') {
      expect(actual.filter(chunk => chunk.type === 'error')).toEqual([]);
      expect(actual.at(-1)).toEqual({ type: 'done', usage: { input_tokens: 11, output_tokens: 3 }, contextWindow: 4096 });
      if (scenario.outcome === 'tail') {
        expect(actual.slice(0, -1)).toEqual([{ type: 'text', content: 'Prefix.' }, { type: 'text', content: 'Tail 🙂.' }]);
      } else {
        expect(actual.map(chunk => chunk.type)).toEqual(['tool_use', 'text', 'done']);
        expect(actual[0]).toMatchObject({ type: 'tool_use', toolCall: { id: expect.any(String),
          name: 'Edit', input: proposalInput, status: 'proposed', proposalOnly: true, kind: 'edit' } });
        expect(actual[1]).toEqual({ type: 'text', content: 'Proposal explanation.' });
      }
    } else if (scenario.outcome === 'cancel') {
      expect(actual.map(chunk => chunk.type)).toEqual(['tool_use', 'error', 'done']);
      expect(actual[0]).toMatchObject({ type: 'tool_use', toolCall: { id: expect.any(String),
        name: 'Edit', input: proposalInput, status: 'proposed', proposalOnly: true, kind: 'edit' } });
      expect(actual.slice(1)).toEqual([{ type: 'error', content: 'Request cancelled or timed out' }, { type: 'done' }]);
      expect(actual.every(chunk => chunk.usage === undefined)).toBe(true);
      expect(actions).toEqual(['first-public-proposal', 'public-stop', 'A-settled', 'B-settled']);
      expect(calls[0].signal).not.toBe(calls[1].signal);
    } else {
      const partial = scenario.wire.length > 0;
      expect(actual.filter(chunk => chunk.type === 'text')).toEqual(partial ? [{ type: 'text', content: 'Preserved partial.' }] : []);
      expect(actual.map(chunk => chunk.type)).toEqual(partial ? ['text', 'error', 'done'] : ['error', 'done']);
      const error = actual.find(chunk => chunk.type === 'error');
      if (scenario.outcome === 'server-error') expect(error?.content).toContain(serverReason);
      else expect(error?.content).toMatch(/incomplete|truncat|malformed|invalid|(?:stream|response).*(?:ended|closed).*(?:before|without)/i);
      expect(actual.at(-1)?.usage).toBeUndefined();
    }
  } catch (error) { bodyError = error; }
  finally {
    const beforeCleanup = snapshot();
    if (turns.some(turn => !turn.settled)) {
      cleanupRequested = true; provider.cancelCurrentRequest('same-panel');
      for (const turn of turns) {
        if (turn.settled) continue;
        retain((async () => {
          let result = await turn.iterator.return(undefined);
          while (!result.done) result = await turn.iterator.return(undefined);
          turn.settled = true; turn.returned = true;
        })().catch(error => { cleanupErrors.push(String(error)); }));
      }
    }
    // Keep raw collectors and returns alive until settled. Future execution
    // needs an owned-worker deadline to contain a provider that never settles.
    let consumed = 0;
    while (consumed < pending.length) {
      const batch = pending.slice(consumed); consumed = pending.length; await Promise.allSettled(batch);
    }
    rawOperationsSettled = true;
    const afterReaderCleanup = snapshot();
    provider.dispose(); const afterDispose = snapshot();
    for (const call of calls) call.detach();
    const receipt = { test: scenario.name, outcome: scenario.outcome, bodyError: bodyError ? String(bodyError) : null,
      actions, notes, beforeCleanup, afterReaderCleanup, afterDispose, cleanupRequested, cleanupErrors, rawOperationsSettled,
      retainedIteratorOperations: pending.length, nativeRequests: 0, actualNetworkRequests: 0, children: 0,
      scope: 'Finite preclosed HTTP Responses and actual public provider iteration; no native service or read-demand claim.' };
    if (process.env.PB13_OLLAMA_COMPLETION_RECEIPT) {
      appendFileSync(process.env.PB13_OLLAMA_COMPLETION_RECEIPT, JSON.stringify(receipt) + '\n');
    }
    if (!bodyError) {
      expect(calls).toHaveLength(2); expect(turns).toHaveLength(2);
      expect(cleanupRequested).toBe(false); expect(cleanupErrors).toEqual([]); expect(rawOperationsSettled).toBe(true);
      expect(turns.every(turn => turn.settled && !turn.returned)).toBe(true);
      expect(calls.every(call => call.response.status === 200 && call.source.closed && call.response.bodyUsed
        && !call.response.body?.locked && call.signal.aborted && call.abortEvents === 1)).toBe(true);
      // Body.json() owns its internal reader; only body consumption is a
      // public requirement here. Keep its observed lock state in the receipt.
      expect(contextCalls.every(call => call.response.bodyUsed)).toBe(true);
      expect(beforeCleanup).toEqual(afterReaderCleanup); expect(afterDispose).toEqual(afterReaderCleanup);
    }
  }
  if (bodyError) throw bodyError;
}

describe('Ollama response completion boundary', () => {
  for (const scenario of scenarios) {
    it(`handles ${scenario.name} and a fresh same-panel recovery`, async () => {
      await ownedCase(scenario);
    });
  }
});
