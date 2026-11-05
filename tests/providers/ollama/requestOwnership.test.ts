import type * as vscode from 'vscode';
import { appendFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaProvider } from '../../../src/providers/ollama/OllamaProvider';
import type { Settings, StreamChunk } from '../../../src/types';
import { clearConfigurationListeners, clearMockConfig, createMockSecretStorage, setMockConfig } from '../../helpers/mockVscode';

// All fetches terminate here. No endpoint, socket, child or Ollama invocation.
const endpoint = 'http://owned-ollama.invalid:11434';
// The timer-ownership case virtualizes only production request deadlines.
// Fixture waits must still fail on real time if a pending read never settles.
const fixtureSetTimeout = globalThis.setTimeout;
const fixtureClearTimeout = globalThis.clearTimeout;
const settings = { provider: 'ollama', model: 'owned-model', mode: 'quick-plan', accessLevel: 'read-only',
  thinkingLevel: 'none', contextMode: 'manual' } as Settings;
const context = () => ({ subscriptions: [], secrets: createMockSecretStorage(),
  globalState: { get: () => undefined, update: async () => {} },
  workspaceState: { get: () => undefined, update: async () => {} } } as unknown as vscode.ExtensionContext);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = fixtureSetTimeout(() => reject(new Error(`Owned fixture did not settle: ${label}`)), 3000);
    })]);
  } finally { if (timer) fixtureClearTimeout(timer); }
}

interface OwnedResponse {
  signal: AbortSignal;
  body: Record<string, unknown>;
  sourceState: 'open' | 'closed' | 'aborted' | 'cleanup-closed';
  abortEvents: number;
  enqueue: (packet: unknown) => void;
  close: () => void;
  cleanup: () => void;
  detach: () => void;
}
interface Turn {
  iterator: AsyncGenerator<StreamChunk>;
  chunks: StreamChunk[];
  settled: boolean;
  returned: boolean;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); clearMockConfig(); clearConfigurationListeners();
});

async function ownedCase(name: string, body: (h: {
  provider: OllamaProvider;
  requests: OwnedResponse[];
  notes: Record<string, unknown>;
  start: (prompt: string, text: string) => Promise<Turn>;
  finish: (turn: Turn, request: OwnedResponse, text: string) => Promise<void>;
  drain: (turn: Turn) => Promise<void>;
  returnTurn: (turn: Turn) => Promise<void>;
}) => Promise<void>) {
  clearMockConfig(); setMockConfig('ollamaEndpoint', endpoint);
  const provider = new OllamaProvider(context());
  vi.spyOn(provider as any, 'buildPromptAsync').mockImplementation(async (content: unknown) => String(content));
  const requests: OwnedResponse[] = [];
  const turns: Turn[] = [];
  const pending: Promise<unknown>[] = [];
  const ready = [deferred<OwnedResponse>(), deferred<OwnedResponse>()];
  const notes: Record<string, unknown> = {};
  const urls: string[] = [];
  const cleanupErrors: string[] = [];
  let bodyError: unknown;
  let underlyingSettled = false;
  function retain<T>(operation: Promise<T>): Promise<T> {
    pending.push(operation);
    void operation.catch(() => {});
    return operation;
  }
  const encoder = new TextEncoder();
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url); urls.push(address);
    if (address === `${endpoint}/api/ps` && !init?.body) {
      return new Response(JSON.stringify({ models: [{ name: 'owned-model', context_length: 4096 }] }));
    }
    expect(address).toBe(`${endpoint}/api/chat`);
    expect(init?.method).toBe('POST');
    expect(requests.length).toBeLessThan(2);
    const signal = init?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    const requestBody = JSON.parse(String(init?.body));
    expect(requestBody).toMatchObject({ model: 'owned-model', stream: true });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const request: OwnedResponse = {
      signal: signal as AbortSignal, body: requestBody, sourceState: 'open', abortEvents: 0,
      enqueue(packet) {
        if (request.sourceState === 'open') controller.enqueue(encoder.encode(JSON.stringify(packet) + '\n'));
      },
      close() {
        if (request.sourceState === 'open') { request.sourceState = 'closed'; controller.close(); }
      },
      cleanup() {
        if (request.sourceState === 'open') { request.sourceState = 'cleanup-closed'; controller.close(); }
      },
      detach() { request.signal.removeEventListener('abort', onAbort); },
    };
    function onAbort() {
      request.abortEvents++;
      if (request.sourceState === 'open') {
        request.sourceState = 'aborted';
        controller.error(new DOMException('Owned HTTP request aborted', 'AbortError'));
      }
    }
    request.signal.addEventListener('abort', onAbort, { once: true });
    if (request.signal.aborted) onAbort();
    const index = requests.length; requests.push(request); ready[index].resolve(request);
    return new Response(stream);
  }));
  async function next(turn: Turn) {
    const result = await bounded(retain(turn.iterator.next()), 'public next');
    if (result.done) turn.settled = true;
    else turn.chunks.push(result.value);
    return result;
  }
  async function drain(turn: Turn) { while (!turn.settled) await next(turn); }
  async function returnTurn(turn: Turn) {
    const result = await bounded(retain(turn.iterator.return(undefined)), 'public return');
    expect(result.done).toBe(true); turn.settled = true; turn.returned = true;
  }
  try {
    await body({ provider, requests, notes, drain, returnTurn,
      async start(prompt, text) {
        const index = turns.length;
        const turn = { iterator: provider.sendMessage(prompt, [], settings, null, undefined, 'same-panel'),
          chunks: [], settled: false, returned: false } as Turn;
        turns.push(turn);
        const first = next(turn);
        const request = await bounded(ready[index].promise, 'captured POST');
        expect(request.body.messages).toEqual([{ role: 'user', content: prompt }]);
        request.enqueue({ message: { content: text }, done: false });
        expect((await first).value).toEqual({ type: 'text', content: text });
        return turn;
      },
      async finish(turn, request, text) {
        request.enqueue({ message: { content: text }, done: false });
        request.enqueue({ done: true, prompt_eval_count: 7, eval_count: 3 });
        request.close(); await drain(turn);
      },
    });
  } catch (error) { bodyError = error; }
  finally {
    notes.beforeCleanup = requests.map(request => ({ sourceState: request.sourceState,
      aborted: request.signal.aborted, abortEvents: request.abortEvents }));
    for (const request of requests) request.cleanup();
    for (const turn of turns) {
      if (turn.settled) continue;
      retain((async () => {
        // Drain even an accidental finally-yield, and retain the underlying
        // operation if the ordinary bounded waiter previously timed out.
        let result = await turn.iterator.return(undefined);
        while (!result.done) result = await turn.iterator.return(undefined);
        turn.settled = true; turn.returned = true;
      })().catch(error => { cleanupErrors.push(String(error)); }));
    }
    // Do not restore globals while raw iterator work remains alive. The later
    // runner's 120s worker bound contains a broken cleanup that never settles.
    await Promise.allSettled(pending);
    underlyingSettled = true;
    for (const request of requests) request.detach();
    provider.dispose();
    const receipt = { test: name, urls, notes, bodyError: bodyError ? String(bodyError) : null,
      requests: requests.map(request => ({ body: request.body, sourceState: request.sourceState,
        aborted: request.signal.aborted, abortEvents: request.abortEvents })),
      turns: turns.map(turn => ({ chunks: turn.chunks, settled: turn.settled, returned: turn.returned })),
      cleanupErrors, allSourcesSettled: requests.every(request => request.sourceState !== 'open'),
      allGeneratorsSettled: turns.every(turn => turn.settled), underlyingSettled,
      retainedIteratorOperations: pending.length, nativeRequests: 0, children: 0 };
    if (process.env.PB13_OLLAMA_OWNERSHIP_RECEIPT) {
      appendFileSync(process.env.PB13_OLLAMA_OWNERSHIP_RECEIPT, JSON.stringify(receipt) + '\n');
    }
    if (!bodyError) {
      expect(cleanupErrors).toEqual([]);
      expect(receipt.allSourcesSettled && receipt.allGeneratorsSettled).toBe(true);
      expect(receipt.underlyingSettled).toBe(true);
      expect(requests.some(request => request.sourceState === 'cleanup-closed')).toBe(false);
      expect(urls.filter(url => url.endsWith('/api/chat'))).toHaveLength(2);
      expect(urls.filter(url => url.endsWith('/api/ps'))).toHaveLength(1);
    }
  }
  if (bodyError) throw bodyError;
}

describe('Ollama HTTP request ownership', () => {
  it('returning an old reader aborts only its source while the same-panel replacement finishes', async () => {
    await ownedCase('old-return-replacement-completes', async h => {
      const a = await h.start('prompt-A', 'A partial.');
      const b = await h.start('prompt-B', 'B partial.');
      expect(h.requests[0].signal).not.toBe(h.requests[1].signal);
      await h.returnTurn(a);
      h.notes.afterOldReturn = h.requests.map(request => ({ aborted: request.signal.aborted,
        sourceState: request.sourceState, abortEvents: request.abortEvents }));
      h.notes.replacementControlOwned = (h.provider as any)._panelSessions.get('same-panel')
        ?.abortController?.signal === h.requests[1].signal;
      // Complete/drain B before assertions so a failing baseline retains its actual outcome.
      await h.finish(b, h.requests[1], 'B final.');
      expect(h.notes.afterOldReturn).toEqual([
        { aborted: true, sourceState: 'aborted', abortEvents: 1 },
        { aborted: false, sourceState: 'open', abortEvents: 0 },
      ]);
      expect(h.notes.replacementControlOwned).toBe(true);
      expect(a.chunks).toEqual([{ type: 'text', content: 'A partial.' }]);
      expect(b.chunks).toEqual([{ type: 'text', content: 'B partial.' }, { type: 'text', content: 'B final.' },
        { type: 'done', usage: { input_tokens: 7, output_tokens: 3 }, contextWindow: 4096 }]);
    });
  }, 10000);

  it('public Stop aborts the current source and a fresh same-panel request completes', async () => {
    await ownedCase('current-stop-fresh-recovery', async h => {
      const a = await h.start('stopped-A', 'Stopped partial.');
      h.provider.cancelCurrentRequest('same-panel');
      await h.drain(a);
      expect(h.requests[0].signal.aborted).toBe(true);
      expect(a.chunks).toEqual([{ type: 'text', content: 'Stopped partial.' },
        { type: 'error', content: 'Request cancelled or timed out' }, { type: 'done' }]);
      const b = await h.start('recovery-B', 'Recovery partial.');
      expect(h.requests[1].signal.aborted).toBe(false);
      await h.finish(b, h.requests[1], 'Recovery final.');
      expect(b.chunks).toEqual([{ type: 'text', content: 'Recovery partial.' }, { type: 'text', content: 'Recovery final.' },
        { type: 'done', usage: { input_tokens: 7, output_tokens: 3 }, contextWindow: 4096 }]);
    });
  }, 10000);

  it('an old request timeout aborts only its source while the newer same-panel request finishes', async () => {
    await ownedCase('old-timeout-replacement-completes', async h => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      setMockConfig('ollamaRequestTimeout', 60);
      const a = await h.start('timeout-A', 'Timeout A partial.');
      await vi.advanceTimersByTimeAsync(20);
      const b = await h.start('timeout-B', 'Timeout B partial.');
      await vi.advanceTimersByTimeAsync(40); // A is due at 60; B is due at 80.
      h.notes.afterOldTimeout = h.requests.map(request => ({ aborted: request.signal.aborted,
        sourceState: request.sourceState, abortEvents: request.abortEvents }));
      h.notes.replacementControlOwned = (h.provider as any)._panelSessions.get('same-panel')
        ?.abortController?.signal === h.requests[1].signal;
      await h.returnTurn(a);
      await h.finish(b, h.requests[1], 'Timeout B final.');
      expect(h.notes.afterOldTimeout).toEqual([
        { aborted: true, sourceState: 'aborted', abortEvents: 1 },
        { aborted: false, sourceState: 'open', abortEvents: 0 },
      ]);
      expect(h.notes.replacementControlOwned).toBe(true);
      expect(a.chunks).toEqual([{ type: 'text', content: 'Timeout A partial.' }]);
      expect(b.chunks).toEqual([{ type: 'text', content: 'Timeout B partial.' },
        { type: 'text', content: 'Timeout B final.' },
        { type: 'done', usage: { input_tokens: 7, output_tokens: 3 }, contextWindow: 4096 }]);
      expect(vi.getTimerCount()).toBe(0);
    });
  }, 10000);
});
