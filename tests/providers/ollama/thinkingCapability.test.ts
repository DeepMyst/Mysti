import { appendFileSync } from 'node:fs';
import type * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaProvider } from '../../../src/providers/ollama/OllamaProvider';
import type { Settings, StreamChunk } from '../../../src/types';
import { clearConfigurationListeners, clearMockConfig, createMockSecretStorage, setMockConfig } from '../../helpers/mockVscode';

// Public provider sends use owned HTTP Responses only. No server, native model,
// network, credential or subprocess is involved.
// Tests keep Vitest's default case budget; each fixture waiter has its own 3s
// bound. An approved future runner must also bound underlying worker cleanup.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const endpointA = 'http://owned-ollama-a.invalid:11434';
const endpointB = 'http://owned-ollama-b.invalid:11434';
const base = { provider: 'ollama', model: 'selected-model', mode: 'quick-plan',
  accessLevel: 'read-only', thinkingLevel: 'none', contextMode: 'manual' } as Settings;

class Provider extends OllamaProvider {
  protected async buildPromptAsync(content: string): Promise<string> { return content; }
}
interface Reply {
  metadata?: unknown;
  status?: number;
  invalidJson?: boolean;
  rejectFetch?: boolean;
  holdBody?: boolean;
  legacyNonThinking?: boolean;
  onShow?: () => void;
}
interface Call {
  url: string; method: string; body?: any; signal: AbortSignal;
  response?: Response; abortEvents: number;
  state: 'closed' | 'held' | 'aborted' | 'cleanup' | 'rejected';
  jsonState?: 'pending' | 'fulfilled' | 'rejected';
  jsonStart?: { bodyUsed: boolean; readerLocked: boolean; signalAborted: boolean };
  fetchError?: string;
  cleanup: () => void; detach: () => void;
}
interface Turn {
  iterator: AsyncGenerator<StreamChunk>; chunks: StreamChunk[]; settled: boolean;
}
async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = realSetTimeout(() => reject(new Error(`Owned metadata fixture deadline: ${label}`)), 3000);
    })]);
  } finally { if (timer) realClearTimeout(timer); }
}
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); clearMockConfig(); clearConfigurationListeners();
});

async function fixture(name: string, body: (h: {
  provider: Provider; calls: Call[]; turns: Turn[]; notes: Record<string, unknown>;
  run: (reply: Reply, settings?: Partial<Settings>) => Promise<StreamChunk[]>;
  startHeld: (settings?: Partial<Settings>) => {
    done: Promise<StreamChunk[]>; bodyReady: Promise<Call>; turn: Turn;
  };
}) => Promise<void>) {
  clearMockConfig();
  setMockConfig('ollamaEndpoint', endpointA);
  setMockConfig('ollamaRequestTimeout', 30000);
  const provider = new Provider({ subscriptions: [], secrets: createMockSecretStorage(),
    globalState: { get: () => undefined, update: async () => {} },
    workspaceState: { get: () => undefined, update: async () => {} },
  } as unknown as vscode.ExtensionContext);
  const calls: Call[] = [], turns: Turn[] = [];
  const operations: Array<{ label: string; promise: Promise<unknown>; settled: boolean; status: string }> = [];
  const cleanupErrors: string[] = [];
  const notes: Record<string, unknown> = {};
  let reply: Reply = {}, bodyReady: ((call: Call) => void) | undefined;
  let bodyError: unknown;
  const retain = <T>(promise: Promise<T>, label: string) => {
    const op = { label, promise, settled: false, status: 'pending' };
    operations.push(op);
    void promise.then(() => { op.settled = true; op.status = 'fulfilled'; },
      () => { op.settled = true; op.status = 'rejected'; });
    return promise;
  };
  const snapshot = () => ({
    calls: calls.map(c => ({ url: c.url, method: c.method, body: c.body,
      state: c.state, aborted: c.signal.aborted, abortEvents: c.abortEvents,
      jsonState: c.jsonState, jsonStart: c.jsonStart, fetchError: c.fetchError,
      bodyUsed: c.response?.bodyUsed ?? null, readerLocked: c.response?.body?.locked ?? null })),
    turns: turns.map(t => ({ chunks: [...t.chunks], settled: t.settled })),
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url);
    expect([endpointA, endpointB].some(e => address.startsWith(e + '/api/'))).toBe(true);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const signal = init!.signal as AbortSignal;
    const call: Call = { url: address, method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined, signal,
      abortEvents: 0, state: 'closed', cleanup() {}, detach() {} };
    calls.push(call);
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    const onAbort = () => {
      call.abortEvents++;
      if (call.state === 'held') {
        call.state = 'aborted';
        source!.error(new DOMException('Owned metadata body aborted', 'AbortError'));
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    call.detach = () => signal.removeEventListener('abort', onAbort);
    if (address.endsWith('/api/show')) {
      expect(call.method).toBe('POST');
      expect(Object.keys(call.body)).toEqual(['model']);
      reply.onShow?.();
      if (reply.rejectFetch) {
        call.state = 'rejected';
        call.fetchError = 'Owned metadata fetch rejected';
        throw new Error(call.fetchError);
      }
      if (reply.holdBody) {
        call.state = 'held';
        call.response = new Response(new ReadableStream<Uint8Array>({
          start(controller) { source = controller; },
        }), { headers: { 'content-type': 'application/json' } });
        const originalJson = call.response.json.bind(call.response);
        call.response.json = () => {
          // Start the real Response body reader before announcing readiness.
          // Return and retain that exact operation, without substituting data.
          const reading = originalJson();
          call.jsonState = 'pending';
          call.jsonStart = { bodyUsed: call.response!.bodyUsed,
            readerLocked: call.response!.body!.locked, signalAborted: signal.aborted };
          retain(reading, 'held-metadata:json');
          void reading.then(() => { call.jsonState = 'fulfilled'; },
            () => { call.jsonState = 'rejected'; });
          bodyReady?.(call);
          return reading;
        };
        call.cleanup = () => {
          if (call.state !== 'held') return;
          call.state = 'cleanup';
          source!.error(new DOMException('Fixture cleanup', 'AbortError'));
        };
      } else {
        call.response = new Response(reply.invalidJson ? '{' : JSON.stringify(reply.metadata ?? {}),
          { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
      }
      if (signal.aborted) onAbort();
      return call.response;
    }
    if (address.endsWith('/api/ps')) {
      expect(call.method).toBe('GET'); expect(call.body).toBeUndefined();
      call.response = new Response(JSON.stringify({ models: [] }));
      return call.response;
    }
    expect(address.endsWith('/api/chat')).toBe(true);
    expect(call.method).toBe('POST');
    // Faithful legacy non-thinking rejection from the pinned ChatHandler:
    // nonempty named thinking is enabled and fails before scheduling inference.
    if (reply.legacyNonThinking && call.body.think !== undefined && call.body.think !== false) {
      call.response = new Response(JSON.stringify({ error: 'selected model does not support thinking' }),
        { status: 400, headers: { 'content-type': 'application/json' } });
    } else {
      call.response = new Response(JSON.stringify({ message: { content: 'Healthy answer.' }, done: false }) + '\n'
        + JSON.stringify({ done: true, prompt_eval_count: 7, eval_count: 3 }) + '\n');
    }
    return call.response;
  }));
  const start = (next: Reply, selected: Partial<Settings> = {}) => {
    reply = next;
    const turn: Turn = { iterator: provider.sendMessage('Owned task.', [],
      { ...base, effortLevel: 'high', ...selected }, null, undefined, 'panel'),
      chunks: [], settled: false };
    turns.push(turn);
    const done = retain((async () => {
      while (true) {
        const result = await turn.iterator.next();
        if (result.done) { turn.settled = true; return turn.chunks; }
        turn.chunks.push(result.value);
      }
    })(), `collect:${turns.length}`);
    return { turn, done };
  };
  let beforeCleanup: unknown;
  try {
    await body({ provider, calls, turns, notes,
      run: async (next, selected) => {
        bodyReady = undefined;
        return within(start(next, selected).done, 'public collection');
      },
      startHeld: selected => {
        const ready = new Promise<Call>(resolve => { bodyReady = resolve; });
        const active = start({ holdBody: true }, selected);
        return { ...active, bodyReady: ready };
      },
    });
  } catch (error) { bodyError = error; }
  finally {
    beforeCleanup = snapshot();
    provider.cancelCurrentRequest();
    for (const call of calls) call.cleanup();
    for (const turn of turns) {
      if (turn.settled) continue;
      retain((async () => {
        let end = await turn.iterator.return(undefined);
        while (!end.done) end = await turn.iterator.return(undefined);
        turn.settled = true;
      })().catch(error => { cleanupErrors.push(String(error)); }), 'cleanup:return');
    }
    // Retain the raw collection/return promises; never restore fetch while
    // underlying provider work is still active. A future runner needs an outer bound.
    await Promise.allSettled(operations.map(op => op.promise));
    provider.dispose();
    for (const call of calls) call.detach();
    const receipt = { test: name, notes, beforeCleanup, afterCleanup: snapshot(),
      bodyError: bodyError ? String(bodyError) : null, cleanupErrors,
      operations: operations.map(({ label, settled, status }) => ({ label, settled, status })),
      allTurnsSettled: turns.every(t => t.settled),
      allSourcesSettled: calls.every(c => c.state !== 'held'),
      noNativeOrNetwork: true };
    if (process.env.PB13_OLLAMA_THINKING_RECEIPT) {
      appendFileSync(process.env.PB13_OLLAMA_THINKING_RECEIPT, JSON.stringify(receipt) + '\n');
    }
    if (!bodyError) {
      expect(cleanupErrors).toEqual([]);
      expect(receipt.allTurnsSettled && receipt.allSourcesSettled).toBe(true);
      expect(operations.every(op => op.settled)).toBe(true);
      expect(calls.some(c => c.state === 'cleanup')).toBe(false);
    }
  }
  if (bodyError) throw bodyError;
}
function healthy(chunks: StreamChunk[]) {
  expect(chunks).toEqual([
    { type: 'text', content: 'Healthy answer.' },
    { type: 'done', usage: { input_tokens: 7, output_tokens: 3 } },
  ]);
}
const chats = (calls: Call[]) => calls.filter(c => c.url.endsWith('/api/chat'));
const shows = (calls: Call[]) => calls.filter(c => c.url.endsWith('/api/show'));

describe('Ollama model-specific thinking controls', () => {
  it('keeps explicit non-thinking and legacy non-thinking models usable with effort set', async () => {
    await fixture('nonthinking', async h => {
      const first = await h.run({ metadata: { capabilities: ['completion'],
        thinking: { values: [false], default: false } }, legacyNonThinking: true });
      const second = await h.run({ metadata: { capabilities: ['completion'] }, legacyNonThinking: true });
      healthy(first); healthy(second);
      expect(shows(h.calls)).toHaveLength(2);
      expect(chats(h.calls).map(c => c.body.think)).toEqual([undefined, undefined]);
    });
  });

  it('clamps only to each reported standard subset, retaining xhigh and valid max', async () => {
    await fixture('named-subsets', async h => {
      const shapes = [
        { values: ['low', 'medium', 'high'], default: 'medium', effort: 'max', expected: 'high' },
        { values: ['low', 'medium', 'xhigh'], default: 'medium', effort: 'xhigh', expected: 'xhigh' },
        { values: ['low', 'medium', 'xhigh'], default: 'medium', effort: 'high', expected: 'medium' },
        { values: [false, 'high', 'max'], default: 'high', effort: 'max', expected: 'max' },
      ] as const;
      for (const shape of shapes) {
        healthy(await h.run({ metadata: { capabilities: ['completion', 'thinking'],
          thinking: { values: shape.values, default: shape.default } } }, { effortLevel: shape.effort }));
      }
      expect(shows(h.calls)).toHaveLength(shapes.length);
      expect(chats(h.calls).map(c => c.body.think)).toEqual(shapes.map(s => s.expected));
    });
  });

  it('uses supported boolean-on or a declared custom default instead of invented levels', async () => {
    await fixture('boolean-legacy-custom', async h => {
      const metadata = [
        { capabilities: ['completion', 'thinking'], thinking: { values: [false, true], default: true } },
        { capabilities: ['completion', 'thinking'] },
        { capabilities: ['completion', 'thinking'],
          thinking: { values: [false, 'brief', 'deliberate'], default: 'deliberate' } },
      ];
      for (const value of metadata) healthy(await h.run({ metadata: value }, { effortLevel: 'max' }));
      expect(shows(h.calls)).toHaveLength(3);
      expect(chats(h.calls).map(c => c.body.think)).toEqual([true, true, 'deliberate']);
    });
  });

  it('omits unknown and malformed controls without poisoning a later valid lookup or retrying chat', async () => {
    await fixture('unknown-then-valid', async h => {
      const replies: Reply[] = [
        { status: 503 },
        { rejectFetch: true },
        { invalidJson: true },
        { metadata: {} },
        { metadata: { thinking: { values: ['high'], default: 'missing' } } },
        { metadata: { capabilities: ['completion', 'thinking'],
          thinking: { values: ['high'], default: 'high' } } },
      ];
      for (const value of replies) healthy(await h.run(value));
      expect(shows(h.calls)).toHaveLength(6);
      expect(chats(h.calls)).toHaveLength(6);
      expect(shows(h.calls).filter(c => c.state === 'rejected').map(c => c.fetchError))
        .toEqual(['Owned metadata fetch rejected']);
      expect(chats(h.calls).map(c => c.body.think))
        .toEqual([undefined, undefined, undefined, undefined, undefined, 'high']);
    });
  });

  it('leaves the existing no-effort send path free of metadata probes', async () => {
    await fixture('unset-effort', async h => {
      healthy(await h.run({}, { effortLevel: undefined }));
      expect(shows(h.calls)).toHaveLength(0);
      expect(h.calls.map(c => c.url)).toEqual([endpointA + '/api/chat', endpointA + '/api/ps']);
      expect(chats(h.calls)[0].body).not.toHaveProperty('think');
    });
  });

  it('binds lookup and chat to the captured effective endpoint and routed model', async () => {
    await fixture('captured-target', async h => {
      healthy(await h.run({ metadata: { capabilities: ['completion'] },
        onShow: () => setMockConfig('ollamaEndpoint', endpointB) },
      { model: 'visible-A', routedModel: 'routed-A' }));
      healthy(await h.run({ metadata: { capabilities: ['completion', 'thinking'],
        thinking: { values: ['high'], default: 'high' } } },
      { model: 'visible-B', routedModel: 'routed-B' }));
      expect(shows(h.calls).map(c => [c.url, c.body])).toEqual([
        [endpointA + '/api/show', { model: 'routed-A' }],
        [endpointB + '/api/show', { model: 'routed-B' }],
      ]);
      expect(chats(h.calls).map(c => [c.url, c.body.model, c.body.think])).toEqual([
        [endpointA + '/api/chat', 'routed-A', undefined],
        [endpointB + '/api/chat', 'routed-B', 'high'],
      ]);
    });
  });

  it('aborts a held metadata body before chat and recovers on the next public request', async () => {
    await fixture('stop-metadata-body', async h => {
      const active = h.startHeld();
      // A baseline without lookup can finish first. Retain that real outcome
      // rather than fabricate a lookup or wait for a signal that never exists.
      const lookup = await within(Promise.race([
        active.bodyReady, active.done.then(() => undefined),
      ]), 'metadata body consumption or baseline completion');
      const readState = () => lookup ? {
        bodyUsed: lookup.response!.bodyUsed, readerLocked: lookup.response!.body!.locked,
        signalAborted: lookup.signal.aborted, sourceState: lookup.state,
        jsonState: lookup.jsonState, abortEvents: lookup.abortEvents,
      } : null;
      const beforeStop = readState();
      h.notes.beforeStop = beforeStop;
      h.provider.cancelCurrentRequest('panel');
      h.notes.immediatelyAfterStop = readState();
      const cancelled = await within(active.done, 'cancelled public collection');
      h.notes.afterCancelledCollection = readState();
      healthy(await h.run({ metadata: { capabilities: ['completion', 'thinking'],
        thinking: { values: ['high'], default: 'high' } } }));
      expect(lookup).toBeDefined();
      expect(lookup!.jsonStart).toEqual({
        bodyUsed: true, readerLocked: true, signalAborted: false,
      });
      expect(beforeStop).toEqual({ bodyUsed: true, readerLocked: true,
        signalAborted: false, sourceState: 'held', jsonState: 'pending', abortEvents: 0 });
      expect(lookup!.jsonState).toBe('rejected');
      expect(lookup!.state).toBe('aborted');
      expect(lookup!.signal.aborted).toBe(true);
      expect(lookup!.abortEvents).toBe(1);
      expect(cancelled).toEqual([
        { type: 'error', content: 'Request cancelled or timed out' }, { type: 'done' },
      ]);
      expect(chats(h.calls)).toHaveLength(1);
      expect(shows(h.calls)).toHaveLength(2);
      expect(chats(h.calls)[0].body.think).toBe('high');
    });
  });
});
