import type * as vscode from 'vscode';
import { appendFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAIProvider } from '../../../src/providers/localai/LocalAIProvider';
import type { Settings, StreamChunk } from '../../../src/types';
import { clearConfigurationListeners, clearMockConfig, createMockSecretStorage, setMockConfig } from '../../helpers/mockVscode';

// All fetches terminate here. No endpoint, socket, child or LocalAI invocation.
const endpoint = 'http://owned-localai.invalid:8080';
// Retain raw iterator operations and use real fixture deadlines. No fake clock.
const fixtureSetTimeout = globalThis.setTimeout;
const fixtureClearTimeout = globalThis.clearTimeout;
const settings = { provider: 'localai', model: 'owned-model', mode: 'quick-plan', accessLevel: 'read-only',
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
  pulls: number;
  waitForPull: (count: number) => Promise<void>;
  enqueue: (packet: unknown) => void;
  close: () => void;
  cleanup: () => void;
  detach: () => void;
}
interface PendingNext {
  promise: Promise<IteratorResult<StreamChunk>>;
  settled: boolean;
}
interface Turn {
  iterator: AsyncGenerator<StreamChunk>;
  chunks: StreamChunk[];
  settled: boolean;
  returned: boolean;
}

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); clearMockConfig(); clearConfigurationListeners();
});

async function ownedCase(name: string, body: (h: {
  provider: LocalAIProvider;
  requests: OwnedResponse[];
  notes: Record<string, unknown>;
  start: (prompt: string, text: string) => Promise<Turn>;
  publishUsage: (turn: Turn, request: OwnedResponse, input: number, output: number) => Promise<PendingNext>;
  finish: (turn: Turn, request: OwnedResponse, pending: PendingNext) => Promise<void>;
}) => Promise<void>) {
  clearMockConfig(); setMockConfig('localaiEndpoint', endpoint);
  const provider = new LocalAIProvider(context());
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
    expect(address).toBe(`${endpoint}/v1/chat/completions`);
    expect(init?.method).toBe('POST');
    expect(requests.length).toBeLessThan(2);
    const signal = init?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    const requestBody = JSON.parse(String(init?.body));
    expect(requestBody).toMatchObject({ model: 'owned-model', stream: true });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const pullWaiters: Array<{ count: number; resolve: () => void }> = [];
    // No prefetch: the next pull after a choice-bearing usage packet proves the public
    // reader consumed that packet and requested another read while EOF is held.
    const stream = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      pull() {
        request.pulls++;
        for (const waiter of pullWaiters) if (request.pulls >= waiter.count) waiter.resolve();
      },
    }, { highWaterMark: 0 });
    const request: OwnedResponse = {
      signal: signal as AbortSignal, body: requestBody, sourceState: 'open', abortEvents: 0,
      pulls: 0, waitForPull(count) {
        if (request.pulls >= count) return Promise.resolve();
        return new Promise<void>(resolve => { pullWaiters.push({ count, resolve }); });
      },
      enqueue(packet) {
        if (request.sourceState === 'open') controller.enqueue(encoder.encode('data: ' + JSON.stringify(packet) + '\n\n'));
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
  function beginNext(turn: Turn): PendingNext {
    const operation = { promise: undefined!, settled: false } as PendingNext;
    operation.promise = retain(turn.iterator.next()).then(result => {
      operation.settled = true;
      if (result.done) turn.settled = true;
      else turn.chunks.push(result.value);
      return result;
    }, error => { operation.settled = true; throw error; });
    retain(operation.promise);
    return operation;
  }
  async function next(turn: Turn) {
    return bounded(beginNext(turn).promise, 'public next');
  }
  async function drain(turn: Turn) { while (!turn.settled) await next(turn); }
  try {
    await body({ provider, requests, notes,
      async start(prompt, text) {
        const index = turns.length;
        const turn = { iterator: provider.sendMessage(prompt, [], settings, null, undefined, 'same-panel'),
          chunks: [], settled: false, returned: false } as Turn;
        turns.push(turn);
        const first = next(turn);
        const request = await bounded(ready[index].promise, 'captured POST');
        expect(request.body.messages).toEqual([{ role: 'user', content: prompt }]);
        await bounded(request.waitForPull(1), 'initial public reader demand');
        request.enqueue({ choices: [{ delta: { content: text }, finish_reason: null }] });
        expect((await first).value).toEqual({ type: 'text', content: text });
        return turn;
      },
      async publishUsage(turn, request, input, output) {
        // Each turn is paused at its first text yield. Resume it to a real read,
        // then inject a choice-bearing usage packet. A subsequent pull witnesses packet
        // consumption without accessing the provider's shared usage field.
        const waitingForPacket = request.waitForPull(2);
        const operation = beginNext(turn);
        await bounded(waitingForPacket, 'reader awaiting completion packet');
        const waitingForEof = request.waitForPull(3);
        // Keep choices:[] usage parsing separate from request ownership.
        request.enqueue({ choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: input, completion_tokens: output } });
        await bounded(waitingForEof, 'completion packet consumed before EOF');
        return operation;
      },
      async finish(turn, request, operation) {
        request.close();
        await bounded(operation.promise, 'terminal public chunk');
        await drain(turn);
      },
    });
  } catch (error) { bodyError = error; }
  finally {
    notes.beforeCleanup = requests.map(request => ({ sourceState: request.sourceState,
      aborted: request.signal.aborted, abortEvents: request.abortEvents, pulls: request.pulls }));
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
        aborted: request.signal.aborted, abortEvents: request.abortEvents, pulls: request.pulls })),
      turns: turns.map(turn => ({ chunks: turn.chunks, settled: turn.settled, returned: turn.returned })),
      cleanupErrors, allSourcesSettled: requests.every(request => request.sourceState !== 'open'),
      allGeneratorsSettled: turns.every(turn => turn.settled), underlyingSettled,
      retainedIteratorOperations: pending.length, nativeRequests: 0, children: 0 };
    if (process.env.PB14_LOCALAI_USAGE_RECEIPT) {
      appendFileSync(process.env.PB14_LOCALAI_USAGE_RECEIPT, JSON.stringify(receipt) + '\n');
    }
    if (!bodyError) {
      expect(cleanupErrors).toEqual([]);
      expect(receipt.allSourcesSettled && receipt.allGeneratorsSettled).toBe(true);
      expect(receipt.underlyingSettled).toBe(true);
      expect(requests.some(request => request.sourceState === 'cleanup-closed')).toBe(false);
      expect(urls.filter(url => url.endsWith('/v1/chat/completions'))).toHaveLength(2);
      expect(urls).toHaveLength(2);
    }
  }
  if (bodyError) throw bodyError;
}

describe('LocalAI request-local usage ownership', () => {
  it('keeps distinct overlapping same-panel completion usage with each public request', async () => {
    await ownedCase('overlapping-completion-usage', async h => {
      const a = await h.start('usage-A', 'A answer.');
      const b = await h.start('usage-B', 'B answer.');
      expect(h.requests[0].signal).not.toBe(h.requests[1].signal);
      const aPending = await h.publishUsage(a, h.requests[0], 11, 3);
      const bPending = await h.publishUsage(b, h.requests[1], 29, 7);
      h.notes.beforeEof = {
        pending: [aPending.settled, bPending.settled],
        sources: h.requests.map(request => ({ sourceState: request.sourceState,
          aborted: request.signal.aborted, pulls: request.pulls })),
        chunks: [a.chunks.slice(), b.chunks.slice()],
      };
      // Complete both readers before checking accounting. A failing baseline
      // retains both terminal outputs and cannot disguise usage loss as cleanup.
      await h.finish(a, h.requests[0], aPending);
      h.notes.afterA = h.requests.map(request => ({ sourceState: request.sourceState,
        aborted: request.signal.aborted, abortEvents: request.abortEvents }));
      h.notes.replacementControlOwned = (h.provider as any)._panelSessions.get('same-panel')
        ?.abortController?.signal === h.requests[1].signal;
      await h.finish(b, h.requests[1], bPending);
      h.notes.finalControlCleared = (h.provider as any)._panelSessions.get('same-panel')
        ?.abortController === null;
      expect(h.notes.beforeEof).toEqual({ pending: [false, false],
        sources: [{ sourceState: 'open', aborted: false, pulls: 3 },
          { sourceState: 'open', aborted: false, pulls: 3 }],
        chunks: [[{ type: 'text', content: 'A answer.' }], [{ type: 'text', content: 'B answer.' }]],
      });
      expect(h.notes.afterA).toEqual([
        { sourceState: 'closed', aborted: true, abortEvents: 1 },
        { sourceState: 'open', aborted: false, abortEvents: 0 },
      ]);
      expect(h.notes.replacementControlOwned).toBe(true);
      expect(h.notes.finalControlCleared).toBe(true);
      expect([a.chunks, b.chunks]).toEqual([
        [{ type: 'text', content: 'A answer.' },
          { type: 'done', usage: { input_tokens: 11, output_tokens: 3 } }],
        [{ type: 'text', content: 'B answer.' },
          { type: 'done', usage: { input_tokens: 29, output_tokens: 7 } }],
      ]);
    });
  }, 15000);
});
