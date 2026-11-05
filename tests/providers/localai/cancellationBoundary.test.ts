import { appendFileSync } from 'node:fs';
import type * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAIProvider } from '../../../src/providers/localai/LocalAIProvider';
import type { Settings, StreamChunk } from '../../../src/types';
import { clearConfigurationListeners, clearMockConfig, createMockSecretStorage, setMockConfig } from '../../helpers/mockVscode';

// Each owned Response supplies one complete byte chunk before fetch returns.
// This observes buffered parser cancellation, not pending network demand or remote abort.
const fixtureSetTimeout = globalThis.setTimeout;
const fixtureClearTimeout = globalThis.clearTimeout;
const endpoint = 'http://owned-localai.invalid:8080';
const settings = { provider: 'localai', model: 'owned-model', mode: 'quick-plan',
  accessLevel: 'read-only', thinkingLevel: 'none', contextMode: 'manual' } as Settings;
const packet = (delta: Record<string, unknown>) => ({ choices: [{ delta, finish_reason: null }] });
const usagePacket = (input: number, output: number) => ({
  choices: [], usage: { prompt_tokens: input, completion_tokens: output },
});
const finishPacket = { choices: [{ delta: {}, finish_reason: 'stop' }] };

class Provider extends LocalAIProvider {
  protected async buildPromptAsync(content: string): Promise<string> { return content; }
}
interface Turn {
  prompt: string; packets: unknown[]; wire: string;
  iterator: AsyncGenerator<StreamChunk>; chunks: StreamChunk[];
  settled: boolean; returned: boolean;
}
interface Call {
  url: string; method: string | undefined; body: unknown;
  signal: AbortSignal; abortEvents: number; response: Response;
  source: { enqueuedChunks: number; enqueuedBytes: number; closed: boolean; cancelCalls: number };
  detach: () => void;
}
async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = fixtureSetTimeout(() => reject(new Error(`Owned LocalAI operation did not settle: ${label}`)), 3000);
    })]);
  } finally { if (timer) fixtureClearTimeout(timer); }
}
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); clearMockConfig(); clearConfigurationListeners();
});

describe('LocalAI buffered cancellation boundary', () => {
  it('stops buffered proposals, text and usage, preserves cancellation terminals, releases readers and recovers in the same panel', async () => {
    clearMockConfig(); setMockConfig('localaiEndpoint', endpoint);
    setMockConfig('localaiRequestTimeout', 30000);
    const provider = new Provider({ subscriptions: [], secrets: createMockSecretStorage(),
      globalState: { get: () => undefined, update: async () => {} },
      workspaceState: { get: () => undefined, update: async () => {} },
    } as unknown as vscode.ExtensionContext);
    const turns: Turn[] = [], calls: Call[] = [];
    const operations: Array<{ label: string; promise: Promise<unknown>; settled: boolean; status: string }> = [];
    const actions: string[] = [], cleanupErrors: string[] = [];
    const notes: Record<string, unknown> = {};
    let bodyError: unknown, cleanupRequested = false;
    const retain = <T>(promise: Promise<T>, label: string) => {
      const operation = { label, promise, settled: false, status: 'pending' };
      operations.push(operation);
      void promise.then(
        () => { operation.settled = true; operation.status = 'fulfilled'; },
        () => { operation.settled = true; operation.status = 'rejected'; },
      );
      return promise;
    };
    const snapshot = () => ({
      calls: calls.map(call => ({
        url: call.url, method: call.method, body: call.body,
        signalAborted: call.signal.aborted, abortEvents: call.abortEvents,
        bodyUsed: call.response.bodyUsed, readerLocked: call.response.body?.locked ?? null,
        source: { ...call.source },
      })),
      turns: turns.map(turn => ({ prompt: turn.prompt, packets: turn.packets, wire: turn.wire,
        chunks: [...turn.chunks], settled: turn.settled, returned: turn.returned })),
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const turn = turns[calls.length];
      expect(turn).toBeDefined(); expect(calls.length).toBeLessThan(2);
      expect(String(url)).toBe(endpoint + '/v1/chat/completions');
      expect(init?.method).toBe('POST'); expect(init?.signal).toBeInstanceOf(AbortSignal);
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ model: 'owned-model', stream: true, temperature: 0.7,
        messages: [{ role: 'user', content: turn.prompt }] });
      const source = { enqueuedChunks: 0, enqueuedBytes: 0, closed: false, cancelCalls: 0 };
      const response = new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const bytes = new TextEncoder().encode(turn.wire);
          controller.enqueue(bytes); source.enqueuedChunks++; source.enqueuedBytes += bytes.byteLength;
          controller.close(); source.closed = true;
        },
        cancel() { source.cancelCalls++; },
      }), { headers: { 'content-type': 'text/event-stream' } });
      const signal = init!.signal as AbortSignal;
      expect(signal.aborted).toBe(false);
      const call: Call = { url: String(url), method: init?.method, body, signal, response,
        source, abortEvents: 0, detach() { signal.removeEventListener('abort', onAbort); } };
      function onAbort() { call.abortEvents++; }
      signal.addEventListener('abort', onAbort, { once: true });
      calls.push(call);
      return response;
    }));
    const create = (prompt: string, packets: unknown[]) => {
      const turn: Turn = { prompt, packets, wire: packets.map(value =>
        'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n').join(''),
      iterator: provider.sendMessage(prompt, [], settings, null, undefined, 'same-panel'),
      chunks: [], settled: false, returned: false };
      turns.push(turn); return turn;
    };
    const drain = (turn: Turn) => retain((async () => {
      for await (const chunk of turn.iterator) turn.chunks.push(chunk);
      turn.settled = true;
    })(), 'drain:' + turn.prompt);
    try {
      const a = create('cancel-A', [
        packet({ content: 'Preserved partial.', tool_calls: [{ id: 'forbidden-proposal', function: {
          name: 'Edit', arguments: JSON.stringify({ file_path: '/owned/canary.txt',
            old_string: 'before', new_string: 'after' }),
        } }] }),
        packet({ content: 'Forbidden later text.' }), usagePacket(91, 23), finishPacket, '[DONE]',
      ]);
      const first = await bounded(retain(a.iterator.next(), 'first:A'), 'first A chunk');
      expect(first.done).toBe(false); expect(first.value).toEqual({ type: 'text', content: 'Preserved partial.' });
      a.chunks.push(first.value); actions.push('first-public-text');
      notes.beforeStop = snapshot();
      expect(calls[0].source.enqueuedChunks).toBe(1); expect(calls[0].source.closed).toBe(true);
      expect(calls[0].response.body?.locked).toBe(true); expect(calls[0].signal.aborted).toBe(false);
      provider.cancelCurrentRequest('same-panel'); actions.push('public-stop');
      notes.afterStop = snapshot();
      expect(calls[0].signal.aborted).toBe(true); expect(calls[0].abortEvents).toBe(1);
      // Resume this suspended yield; return() would bypass the continuation under test.
      await bounded(drain(a), 'drain stopped A');
      actions.push('A-settled'); notes.afterA = snapshot();
      const b = create('recovery-B', [
        packet({ content: 'Healthy recovery.' }), usagePacket(7, 3), finishPacket, '[DONE]',
      ]);
      await bounded(drain(b), 'healthy B');
      actions.push('B-settled'); notes.afterB = snapshot();
      // Retain both actual responses before asserting the predicted baseline failure.
      expect(b.chunks).toEqual([{ type: 'text', content: 'Healthy recovery.' },
        { type: 'done', usage: { input_tokens: 7, output_tokens: 3 } }]);
      expect(calls[0].signal).not.toBe(calls[1].signal);
      const late = a.chunks.slice(1);
      // Preserve LocalAI's established cancellation terminal convention.
      expect(late).toEqual([{ type: 'error', content: 'Request cancelled or timed out' },
        { type: 'done' }]);
      expect(late.every(chunk => !chunk.usage && !chunk.toolCall)).toBe(true);
      expect(calls.every(call => !call.response.body?.locked)).toBe(true);
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
          })().catch(error => { cleanupErrors.push(String(error)); }), 'cleanup-return:' + turn.prompt);
        }
      }
      // Await actual operations, including failure paths. Future execution needs
      // an owned-worker outer deadline if a broken iterator never settles.
      let consumed = 0;
      while (consumed < operations.length) {
        const batch = operations.slice(consumed); consumed = operations.length;
        await Promise.allSettled(batch.map(operation => operation.promise));
      }
      const rawOperationsSettled = operations.every(operation => operation.settled);
      const afterReaderCleanup = snapshot();
      try { provider.dispose(); } catch (error) { cleanupErrors.push(String(error)); }
      const afterDispose = snapshot();
      calls.forEach(call => call.detach());
      const receipt = {
        test: 'after-text-same-record-proposal-and-buffered-tail', actions, notes,
        bodyError: bodyError ? String(bodyError) : null,
        beforeCleanup, afterReaderCleanup, afterDispose, cleanupRequested, cleanupErrors,
        rawOperationsSettled,
        operations: operations.map(({ label, settled, status }) => ({ label, settled, status })),
        actualNetworkRequests: 0, nativeRequests: 0, children: 0,
        scope: 'Two preclosed single-chunk Responses. Public Stop and resumed parser; actual signals, reader locks and raw operations. No pending-read or remote-cancellation claim.',
      };
      if (process.env.PB14_LOCALAI_BUFFERED_CANCELLATION_RECEIPT) {
        appendFileSync(process.env.PB14_LOCALAI_BUFFERED_CANCELLATION_RECEIPT, JSON.stringify(receipt) + '\n');
      }
      if (!bodyError) {
        expect(calls).toHaveLength(2); expect(cleanupRequested).toBe(false);
        expect(cleanupErrors).toEqual([]); expect(rawOperationsSettled).toBe(true);
        expect(turns.every(turn => turn.settled && !turn.returned)).toBe(true);
        expect(calls.every(call => call.signal.aborted && call.abortEvents === 1
          && call.response.bodyUsed && !call.response.body?.locked && call.source.closed)).toBe(true);
        expect(beforeCleanup).toEqual(afterReaderCleanup); expect(afterDispose).toEqual(afterReaderCleanup);
      }
    }
    if (bodyError) throw bodyError;
  }, 15000);
});
