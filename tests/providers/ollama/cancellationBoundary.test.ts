import { appendFileSync } from 'node:fs';
import type * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaProvider } from '../../../src/providers/ollama/OllamaProvider';
import type { Settings, StreamChunk } from '../../../src/types';
import { clearConfigurationListeners, clearMockConfig, createMockSecretStorage, setMockConfig } from '../../helpers/mockVscode';

// Each owned chat Response supplies one complete byte chunk before fetch returns.
// This observes buffered parser cancellation, not pending network demand or remote abort.
const fixtureSetTimeout = globalThis.setTimeout;
const fixtureClearTimeout = globalThis.clearTimeout;
const endpoint = 'http://owned-ollama.invalid:11434';
const settings = { provider: 'ollama', model: 'owned-model', mode: 'quick-plan',
  accessLevel: 'read-only', thinkingLevel: 'none', contextMode: 'manual' } as Settings;
const packet = (message: Record<string, unknown>) => ({ message, done: false });
const finishPacket = (input: number, output: number) => ({
  done: true, prompt_eval_count: input, eval_count: output,
});

class Provider extends OllamaProvider {
  protected async buildPromptAsync(content: string): Promise<string> { return content; }
}
interface Turn {
  prompt: string; packets: unknown[]; wire: string;
  iterator: AsyncGenerator<StreamChunk>; chunks: StreamChunk[];
  settled: boolean; returned: boolean;
}
interface ContextCall {
  url: string; duringPrompt: string; held: boolean; signal: AbortSignal; abortEvents: number;
  state: 'pending' | 'resolved' | 'aborted'; releaseKind: 'none' | 'immediate' | 'baseline-fallback' | 'cleanup' | 'abort';
  response?: Response; release: (kind: 'baseline-fallback' | 'cleanup') => void; detach: () => void;
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
      timer = fixtureSetTimeout(() => reject(new Error(`Owned Ollama operation did not settle: ${label}`)), 3000);
    })]);
  } finally { if (timer) fixtureClearTimeout(timer); }
}
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); clearMockConfig(); clearConfigurationListeners();
});

describe('Ollama buffered cancellation boundary', () => {
  it.each(['buffered', 'pending-context'] as const)(
    'preserves cancellation terminals and recovers after %s Stop', async mode => {
    clearMockConfig(); setMockConfig('ollamaEndpoint', endpoint);
    setMockConfig('ollamaRequestTimeout', 30000);
    const provider = new Provider({ subscriptions: [], secrets: createMockSecretStorage(),
      globalState: { get: () => undefined, update: async () => {} },
      workspaceState: { get: () => undefined, update: async () => {} },
    } as unknown as vscode.ExtensionContext);
    const turns: Turn[] = [], calls: Call[] = [];
    const contextCalls: ContextCall[] = [];
    let contextReadyResolve!: (call: ContextCall) => void;
    const contextReady = new Promise<ContextCall>(resolve => { contextReadyResolve = resolve; });
    const operations: Array<{ label: string; promise: Promise<unknown>; settled: boolean; status: string }> = [];
    const actions: string[] = [], cleanupErrors: string[] = [];
    const notes: Record<string, unknown> = {};
    let bodyError: unknown, cleanupRequested = false, baselineContextReleased = false;
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
      contextCalls: contextCalls.map(call => ({ url: call.url, duringPrompt: call.duringPrompt,
        held: call.held, signalAborted: call.signal.aborted, abortEvents: call.abortEvents,
        state: call.state, releaseKind: call.releaseKind, bodyUsed: call.response?.bodyUsed ?? null })),
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
      if (String(url) === endpoint + '/api/ps') {
        expect(init?.body).toBeUndefined(); expect(init?.method ?? 'GET').toBe('GET');
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(contextCalls.length).toBeLessThan(2);
        const duringPrompt = turns[turns.length - 1].prompt;
        const held = mode === 'pending-context' && duringPrompt === 'cancel-A';
        const signal = init!.signal as AbortSignal;
        const response = () => new Response(JSON.stringify({ models: [
          { name: 'owned-model', context_length: 4096 },
        ] }), { headers: { 'content-type': 'application/json' } });
        let resolve!: (value: Response) => void, reject!: (reason: Error) => void;
        const waiting = held ? new Promise<Response>((accept, fail) => { resolve = accept; reject = fail; }) : undefined;
        const call: ContextCall = {
          url: String(url), duringPrompt, held, signal, abortEvents: 0,
          state: held ? 'pending' : 'resolved', releaseKind: held ? 'none' : 'immediate',
          response: held ? undefined : response(),
          release(kind) {
            if (call.state !== 'pending') return;
            call.state = 'resolved'; call.releaseKind = kind; call.response = response();
            resolve(call.response);
          },
          detach() { signal.removeEventListener('abort', onAbort); },
        };
        function onAbort() {
          call.abortEvents++;
          if (call.state === 'pending') {
            call.state = 'aborted'; call.releaseKind = 'abort';
            reject(new DOMException('Owned context lookup aborted', 'AbortError'));
          }
        }
        // Observe a rejection immediately, while preserving the original promise
        // that the provider actually awaits through fetch.
        const pending = waiting ? retain(waiting, 'context:cancel-A') : undefined;
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
        contextCalls.push(call);
        if (held) contextReadyResolve(call);
        return pending ? await pending : call.response!;
      }
      const turn = turns[calls.length];
      expect(turn).toBeDefined(); expect(calls.length).toBeLessThan(2);
      expect(String(url)).toBe(endpoint + '/api/chat');
      expect(init?.method).toBe('POST'); expect(init?.signal).toBeInstanceOf(AbortSignal);
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ model: 'owned-model', stream: true, keep_alive: '5m',
        options: { temperature: 0.7 }, messages: [{ role: 'user', content: turn.prompt }] });
      const source = { enqueuedChunks: 0, enqueuedBytes: 0, closed: false, cancelCalls: 0 };
      const response = new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const bytes = new TextEncoder().encode(turn.wire);
          controller.enqueue(bytes); source.enqueuedChunks++; source.enqueuedBytes += bytes.byteLength;
          controller.close(); source.closed = true;
        },
        cancel() { source.cancelCalls++; },
      }), { headers: { 'content-type': 'application/x-ndjson' } });
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
        JSON.stringify(value) + '\n').join(''),
      iterator: provider.sendMessage(prompt, [], settings, null, undefined, 'same-panel'),
      chunks: [], settled: false, returned: false };
      turns.push(turn); return turn;
    };
    const drain = (turn: Turn) => retain((async () => {
      for await (const chunk of turn.iterator) turn.chunks.push(chunk);
      turn.settled = true;
    })(), 'drain:' + turn.prompt);
    try {
      const a = create('cancel-A', mode === 'buffered' ? [
        packet({ content: 'Preserved partial.' }),
        // Ollama emits proposals before text and continues past that record.
        // Keep the proposal in a distinct buffered record after the first yield.
        packet({ tool_calls: [{ function: { name: 'Edit', arguments: {
          file_path: '/owned/canary.txt', old_string: 'before', new_string: 'after',
        } } }] }),
        packet({ content: 'Forbidden later text.' }), finishPacket(91, 23),
      ] : [packet({ content: 'Preserved partial.' }), finishPacket(91, 23)]);
      const first = await bounded(retain(a.iterator.next(), 'first:A'), 'first A chunk');
      expect(first.done).toBe(false); expect(first.value).toEqual({ type: 'text', content: 'Preserved partial.' });
      a.chunks.push(first.value); actions.push('first-public-text');
      let aDrain: Promise<void> | undefined, heldContext: ContextCall | undefined;
      if (mode === 'pending-context') {
        aDrain = drain(a); actions.push('A-drain-started');
        heldContext = await bounded(contextReady, 'actual context fetch pending');
        actions.push('context-fetch-pending'); notes.contextPending = snapshot();
        expect(heldContext.state).toBe('pending'); expect(heldContext.signal.aborted).toBe(false);
      }
      notes.beforeStop = snapshot();
      expect(calls[0].source.enqueuedChunks).toBe(1); expect(calls[0].source.closed).toBe(true);
      expect(calls[0].response.body?.locked).toBe(true); expect(calls[0].signal.aborted).toBe(false);
      provider.cancelCurrentRequest('same-panel'); actions.push('public-stop');
      notes.afterStop = snapshot();
      expect(calls[0].signal.aborted).toBe(true); expect(calls[0].abortEvents).toBe(1);
      // Baseline uses an unrelated context signal. Complete that finite input
      // explicitly so both actual outcomes survive; green must never use this fallback.
      if (heldContext && !heldContext.signal.aborted) {
        baselineContextReleased = true; actions.push('baseline-context-release');
        heldContext.release('baseline-fallback');
      }
      // Resume this suspended yield; return() would bypass the continuation under test.
      await bounded(aDrain ?? drain(a), 'drain stopped A');
      actions.push('A-settled'); notes.afterA = snapshot();
      const b = create('recovery-B', [
        packet({ content: 'Healthy recovery.' }), finishPacket(7, 3),
      ]);
      await bounded(drain(b), 'healthy B');
      actions.push('B-settled'); notes.afterB = snapshot();
      // Retain both actual responses before asserting the predicted baseline failure.
      expect(b.chunks).toEqual([{ type: 'text', content: 'Healthy recovery.' },
        { type: 'done', usage: { input_tokens: 7, output_tokens: 3 }, contextWindow: 4096 }]);
      expect(contextCalls.some(call => call.duringPrompt === 'recovery-B' && call.response?.bodyUsed)).toBe(true);
      expect(calls[0].signal).not.toBe(calls[1].signal);
      const late = a.chunks.slice(1);
      // Preserve Ollama's established cancellation terminal convention.
      expect(late).toEqual([{ type: 'error', content: 'Request cancelled or timed out' },
        { type: 'done' }]);
      expect(late.every(chunk => !chunk.usage && !chunk.toolCall)).toBe(true);
      expect(calls.every(call => !call.response.body?.locked)).toBe(true);
      if (heldContext) {
        expect(heldContext.signal.aborted).toBe(true); expect(heldContext.abortEvents).toBe(1);
        expect(heldContext.state).toBe('aborted'); expect(heldContext.releaseKind).toBe('abort');
        expect(baselineContextReleased).toBe(false);
      }
    } catch (error) { bodyError = error; }
    finally {
      const beforeCleanup = snapshot();
      if (turns.some(turn => !turn.settled)) {
        cleanupRequested = true; provider.cancelCurrentRequest('same-panel');
        // Release an unchanged baseline's independent context gate on failures,
        // before asking its still-running generator to return.
        for (const call of contextCalls) call.release('cleanup');
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
      calls.forEach(call => call.detach()); contextCalls.forEach(call => call.detach());
      const receipt = {
        test: mode === 'buffered' ? 'after-text-buffered-proposal-text-and-completion'
          : 'stop-during-pending-context-lookup', actions, notes, baselineContextReleased,
        bodyError: bodyError ? String(bodyError) : null,
        beforeCleanup, afterReaderCleanup, afterDispose, cleanupRequested, cleanupErrors,
        rawOperationsSettled,
        operations: operations.map(({ label, settled, status }) => ({ label, settled, status })),
        actualNetworkRequests: 0, nativeRequests: 0, children: 0,
        scope: 'Two preclosed single-chunk NDJSON chat Responses plus owned context JSON. Buffered case resumes the parser after Stop; pending-context case observes actual fetch signal and rejection. Baseline fallback is explicit finite input release, never green. No pending chat read or remote-cancellation claim.',
      };
      if (process.env.PB13_OLLAMA_BUFFERED_CANCELLATION_RECEIPT) {
        appendFileSync(process.env.PB13_OLLAMA_BUFFERED_CANCELLATION_RECEIPT, JSON.stringify(receipt) + '\n');
      }
      if (!bodyError) {
        expect(calls).toHaveLength(2); expect(cleanupRequested).toBe(false);
        expect(cleanupErrors).toEqual([]); expect(rawOperationsSettled).toBe(true);
        expect(baselineContextReleased).toBe(false);
        expect(turns.every(turn => turn.settled && !turn.returned)).toBe(true);
        expect(calls.every(call => call.signal.aborted && call.abortEvents === 1
          && call.response.bodyUsed && !call.response.body?.locked && call.source.closed)).toBe(true);
        expect(beforeCleanup).toEqual(afterReaderCleanup); expect(afterDispose).toEqual(afterReaderCleanup);
      }
    }
    if (bodyError) throw bodyError;
  }, 15000);
});
