import { appendFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestableOpenRouterProvider } from '../../helpers/providerFactory';
import { clearConfigurationListeners, clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import { OpenRouterClient, OPENROUTER_BASE_URL } from '../../../src/services/OpenRouterClient';
import type { GatewayChatParams } from '../../../src/services/DeepMystGatewayClient';
import type { Settings, StreamChunk } from '../../../src/types';

// Actual provider and SSE client over injected in-memory fetch only.
// The synthetic mock setting never reads or changes a real key/configuration.
const syntheticKey = 'owned-openrouter-fixture-key';
const fixtureSetTimeout = globalThis.setTimeout;
const fixtureClearTimeout = globalThis.clearTimeout;
const settings = { provider: 'openrouter', model: 'owned/model', mode: 'quick-plan',
  accessLevel: 'read-only', thinkingLevel: 'none', contextMode: 'manual' } as Settings;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = fixtureSetTimeout(() => reject(new Error(`Owned OpenRouter fixture did not settle: ${label}`)), 3000);
    })]);
  } finally { if (timer) fixtureClearTimeout(timer); }
}

interface Issued {
  signal: AbortSignal;
  abortEvents: number;
  detach: () => void;
}
interface Source {
  signal: AbortSignal;
  body: Record<string, unknown>;
  stream: ReadableStream<Uint8Array>;
  state: 'open' | 'closed' | 'aborted' | 'cancelled' | 'cleanup-closed';
  abortEvents: number;
  cancelCalls: number;
  cancelSettled: boolean;
  enqueue: (...packets: unknown[]) => void;
  close: (cleanup?: boolean) => void;
  detach: () => void;
}
interface Turn {
  iterator: AsyncGenerator<StreamChunk>;
  chunks: StreamChunk[];
  settled: boolean;
  returned: boolean;
}

// Preserve the actual client's generator object and this/arguments/return.
// Only record the provider-issued signal before the real client derives its own.
class ObservedClient extends OpenRouterClient {
  constructor(fetchImpl: typeof fetch, private readonly observe: (params: GatewayChatParams) => void) {
    super(() => syntheticKey, { fetchImpl, maxRetries: 0 });
  }
  override streamChat(params: GatewayChatParams) {
    this.observe(params);
    return super.streamChat(params);
  }
}

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); clearMockConfig(); clearConfigurationListeners();
});

async function ownedCase(name: string, exercise: (h: {
  provider: TestableOpenRouterProvider;
  notes: Record<string, unknown>;
  start: (prompt: string, text: string, bufferedLateText?: string) => Promise<Turn>;
  finish: (turn: Turn, index: number, text: string) => Promise<void>;
  drain: (turn: Turn) => Promise<void>;
  returnTurn: (turn: Turn) => Promise<void>;
  snapshot: () => unknown;
  currentOwns: (index: number) => boolean;
}) => Promise<void>) {
  clearMockConfig();
  setMockConfig('openrouter.apiKey', syntheticKey);
  const provider = new TestableOpenRouterProvider();
  vi.spyOn(provider as any, 'buildPromptAsync').mockImplementation(async (content: unknown) => String(content));
  const issued: Issued[] = [], sources: Source[] = [], turns: Turn[] = [];
  const ready = [deferred<Source>(), deferred<Source>()];
  const pending: Promise<unknown>[] = [], urls: string[] = [], cleanupErrors: string[] = [];
  const notes: Record<string, unknown> = {};
  let bodyError: unknown, underlyingSettled = false, unexpectedGlobalFetch = 0;
  const retain = <T>(operation: Promise<T>) => {
    pending.push(operation); void operation.catch(() => {}); return operation;
  };
  const snapshot = () => ({
    issued: issued.map(item => ({ aborted: item.signal.aborted, abortEvents: item.abortEvents })),
    sources: sources.map(source => ({ state: source.state, aborted: source.signal.aborted,
      abortEvents: source.abortEvents, cancelCalls: source.cancelCalls,
      cancelSettled: source.cancelSettled, readerLocked: source.stream.locked })),
    turns: turns.map(turn => ({ chunks: [...turn.chunks], settled: turn.settled, returned: turn.returned })),
  });
  vi.stubGlobal('fetch', vi.fn(async () => {
    unexpectedGlobalFetch++;
    throw new Error('Unexpected global fetch; all OpenRouter fixture traffic must remain injected');
  }));
  const encoder = new TextEncoder();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input); urls.push(url);
    if (url === `${OPENROUTER_BASE_URL}/models`) {
      expect(init?.method ?? 'GET').toBe('GET');
      return new Response(JSON.stringify({ data: [
        { id: 'owned/model', context_length: 4096, pricing: { prompt: '0', completion: '0' } },
      ] }), { headers: { 'Content-Type': 'application/json' } });
    }
    expect(url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`);
    expect(init?.method).toBe('POST'); expect(sources.length).toBeLessThan(2);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: 'owned/model', stream: true, stream_options: { include_usage: true } });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let source!: Source;
    const stream = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      cancel() {
        source.cancelCalls++;
        if (source.state === 'open') source.state = 'cancelled';
        // Retain this real underlying cancel operation despite the client's void cancel().
        return retain(Promise.resolve().then(() => { source.cancelSettled = true; }));
      },
    });
    source = {
      signal: init!.signal as AbortSignal, body, stream, state: 'open',
      abortEvents: 0, cancelCalls: 0, cancelSettled: false,
      enqueue(...packets) {
        if (source.state !== 'open') return;
        // Multiple events in one byte chunk allow a real already-parsed late event after Stop.
        controller.enqueue(encoder.encode(packets.map(packet =>
          `data: ${typeof packet === 'string' ? packet : JSON.stringify(packet)}\n\n`).join('')));
      },
      close(cleanup = false) {
        if (source.state === 'open') {
          source.state = cleanup ? 'cleanup-closed' : 'closed';
          controller.close();
        }
      },
      detach() { source.signal.removeEventListener('abort', onAbort); },
    };
    function onAbort() {
      source.abortEvents++;
      if (source.state === 'open') {
        source.state = 'aborted';
        controller.error(new DOMException('Owned OpenRouter source aborted', 'AbortError'));
      }
    }
    source.signal.addEventListener('abort', onAbort, { once: true });
    if (source.signal.aborted) onAbort();
    const index = sources.length; sources.push(source); ready[index].resolve(source);
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  provider.setClient(new ObservedClient(fetchImpl, params => {
    expect(params.signal).toBeInstanceOf(AbortSignal);
    expect(issued.length).toBeLessThan(2);
    const item: Issued = { signal: params.signal!, abortEvents: 0,
      detach() { item.signal.removeEventListener('abort', onAbort); } };
    function onAbort() { item.abortEvents++; }
    item.signal.addEventListener('abort', onAbort, { once: true });
    issued.push(item);
  }));
  const textPacket = (content: string) => ({ choices: [{ delta: { content }, finish_reason: null }] });
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
    await exercise({ provider, notes, snapshot, drain, returnTurn,
      currentOwns(index) {
        return (provider as any)._panelSessions.get('same-panel')?.abortController?.signal === issued[index].signal;
      },
      async start(prompt, text, bufferedLateText) {
        const index = turns.length;
        const turn: Turn = { iterator: provider.sendMessage(prompt, [], settings, null, undefined, 'same-panel'),
          chunks: [], settled: false, returned: false };
        turns.push(turn);
        const first = retain(next(turn));
        const source = await bounded(ready[index].promise, 'captured POST');
        expect(source.body.messages).toEqual([{ role: 'user', content: prompt }]);
        source.enqueue(textPacket(text), ...(bufferedLateText ? [textPacket(bufferedLateText)] : []));
        expect((await first).value).toEqual({ type: 'text', content: text });
        return turn;
      },
      async finish(turn, index, text) {
        // No usage packet: this candidate proves controller ownership only.
        sources[index].enqueue(textPacket(text), { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]');
        sources[index].close();
        await drain(turn);
      },
    });
  } catch (error) { bodyError = error; }
  finally {
    notes.beforeCleanup = snapshot();
    for (const source of sources) source.close(true);
    for (const turn of turns) {
      if (turn.settled) continue;
      retain((async () => {
        let result = await turn.iterator.return(undefined);
        while (!result.done) result = await turn.iterator.return(undefined);
        turn.settled = true; turn.returned = true;
      })().catch(error => { cleanupErrors.push(String(error)); }));
    }
    // Operations may append real reader.cancel promises while generators unwind.
    // Drain every actual operation before restoring globals; the runner bounds a broken fixture.
    let consumed = 0;
    while (consumed < pending.length) {
      const batch = pending.slice(consumed); consumed = pending.length;
      await Promise.allSettled(batch);
    }
    underlyingSettled = true;
    notes.afterReaderCleanup = snapshot();
    provider.dispose();
    for (const item of issued) item.detach();
    for (const source of sources) source.detach();
    const receipt = { test: name, urls, notes, bodyError: bodyError ? String(bodyError) : null,
      issued: issued.map(item => ({ aborted: item.signal.aborted, abortEvents: item.abortEvents })),
      sources: sources.map(source => ({ body: source.body, state: source.state,
        aborted: source.signal.aborted, abortEvents: source.abortEvents, cancelCalls: source.cancelCalls,
        cancelSettled: source.cancelSettled, readerLocked: source.stream.locked })),
      turns: turns.map(turn => ({ chunks: turn.chunks, settled: turn.settled, returned: turn.returned })),
      cleanupErrors, allSourcesSettled: sources.every(source => source.state !== 'open'),
      allGeneratorsSettled: turns.every(turn => turn.settled), underlyingSettled,
      retainedIteratorOperations: pending.length, unexpectedGlobalFetch, actualNetworkRequests: 0, children: 0 };
    if (process.env.PB15_OPENROUTER_OWNERSHIP_RECEIPT) {
      appendFileSync(process.env.PB15_OPENROUTER_OWNERSHIP_RECEIPT, JSON.stringify(receipt) + '\n');
    }
    if (!bodyError) {
      expect(issued).toHaveLength(2); expect(sources).toHaveLength(2); expect(turns).toHaveLength(2);
      expect(cleanupErrors).toEqual([]);
      expect(receipt.allSourcesSettled && receipt.allGeneratorsSettled && underlyingSettled).toBe(true);
      expect(sources.every(source => !source.stream.locked && source.state !== 'cleanup-closed')).toBe(true);
      expect(sources.every(source => source.cancelCalls === 0 || source.cancelSettled)).toBe(true);
      expect(unexpectedGlobalFetch).toBe(0);
      expect(urls.filter(url => url.endsWith('/chat/completions'))).toHaveLength(2);
      expect(urls.filter(url => url.endsWith('/models'))).toHaveLength(1);
    }
  }
  if (bodyError) throw bodyError;
}

describe('OpenRouter HTTP request ownership', () => {
  it('returning an old reader preserves the live same-panel replacement and releases its own reader', async () => {
    await ownedCase('old-return-replacement-completes', async h => {
      const a = await h.start('prompt-A', 'A partial.');
      const b = await h.start('prompt-B', 'B partial.');
      await h.returnTurn(a);
      const observed = h.snapshot() as { issued: unknown; sources: unknown };
      h.notes.afterOldReturn = observed;
      h.notes.replacementControlOwned = h.currentOwns(1);
      // Complete B before checking the ownership defect, preserving the actual failing outcome.
      await h.finish(b, 1, 'B final.');
      expect(observed.issued).toEqual([{ aborted: true, abortEvents: 1 }, { aborted: false, abortEvents: 0 }]);
      expect(h.notes.replacementControlOwned).toBe(true);
      expect(observed.sources).toEqual([
        { state: 'cancelled', aborted: false, abortEvents: 0, cancelCalls: 1, cancelSettled: true, readerLocked: false },
        { state: 'open', aborted: false, abortEvents: 0, cancelCalls: 0, cancelSettled: false, readerLocked: true },
      ]);
      expect(a.chunks).toEqual([{ type: 'text', content: 'A partial.' }]);
      expect(b.chunks).toEqual([{ type: 'text', content: 'B partial.' },
        { type: 'text', content: 'B final.' }, { type: 'done', contextWindow: 4096 }]);
    });
  }, 15000);

  it('public Stop suppresses a buffered late event and a fresh same-panel request completes', async () => {
    await ownedCase('current-stop-buffered-event-recovery', async h => {
      const a = await h.start('stopped-A', 'Stopped partial.', 'LATE_AFTER_STOP');
      h.provider.cancelCurrentRequest('same-panel');
      h.notes.afterStop = h.snapshot();
      await h.drain(a);
      // Do not fail before the independent recovery leg is observed.
      const b = await h.start('recovery-B', 'Recovery partial.');
      await h.finish(b, 1, 'Recovery final.');
      const stopped = h.notes.afterStop as { issued: unknown; sources: Array<{ state: string; aborted: boolean }> };
      expect(stopped.issued).toEqual([{ aborted: true, abortEvents: 1 }]);
      expect(stopped.sources[0]).toMatchObject({ state: 'aborted', aborted: true });
      expect(a.chunks).toEqual([{ type: 'text', content: 'Stopped partial.' },
        { type: 'done', contextWindow: 4096 }]);
      expect(b.chunks).toEqual([{ type: 'text', content: 'Recovery partial.' },
        { type: 'text', content: 'Recovery final.' }, { type: 'done', contextWindow: 4096 }]);
    });
  }, 15000);
});
