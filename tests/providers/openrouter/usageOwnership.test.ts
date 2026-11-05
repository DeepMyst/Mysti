import { appendFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestableOpenRouterProvider } from '../../helpers/providerFactory';
import { clearConfigurationListeners, clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import { OpenRouterClient, OPENROUTER_BASE_URL } from '../../../src/services/OpenRouterClient';
import type { GatewayChatParams } from '../../../src/services/DeepMystGatewayClient';
import type { Settings, StreamChunk } from '../../../src/types';

// Source-only usage candidate; public provider and actual SSE client over injected in-memory fetch only.
// The synthetic mock setting never reads or changes a real key/configuration.
const syntheticKey = 'owned-openrouter-fixture-key';
const fixtureSetTimeout = globalThis.setTimeout;
const fixtureClearTimeout = globalThis.clearTimeout;
type ReportedUsage = { input: number; output: number };
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
  packets: unknown[];
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
  start: (prompt: string, label: string, usage?: ReportedUsage) => Promise<Turn>;
  finish: (turn: Turn, index: number) => Promise<void>;
  drain: (turn: Turn) => Promise<void>;
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
      signal: init!.signal as AbortSignal, body, packets: [], stream, state: 'open',
      abortEvents: 0, cancelCalls: 0, cancelSettled: false,
      enqueue(...packets) {
        if (source.state !== 'open') return;
        // The public post-usage text is emitted only after the real parser crosses the preceding usage frame.
        source.packets.push(...packets);
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
  try {
    await exercise({ provider, notes, snapshot, drain,
      currentOwns(index) {
        return (provider as any)._panelSessions.get('same-panel')?.abortController?.signal === issued[index].signal;
      },
      async start(prompt, label, usage) {
        const index = turns.length;
        const turn: Turn = { iterator: provider.sendMessage(prompt, [], settings, null, undefined, 'same-panel'),
          chunks: [], settled: false, returned: false };
        turns.push(turn);
        const first = retain(next(turn));
        const source = await bounded(ready[index].promise, 'captured POST');
        expect(source.body.messages).toEqual([{ role: 'user', content: prompt }]);
        source.enqueue(textPacket(label + ' before.'));
        expect((await first).value).toEqual({ type: 'text', content: label + ' before.' });
        const afterUsage = retain(next(turn));
        source.enqueue(...(usage ? [{ choices: [], usage: {
          prompt_tokens: usage.input, completion_tokens: usage.output,
        } }] : []), textPacket(label + ' after.'));
        expect((await afterUsage).value).toEqual({ type: 'text', content: label + ' after.' });
        return turn;
      },
      async finish(turn, index) {
        sources[index].enqueue({ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]');
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
      sources: sources.map(source => ({ body: source.body, packets: source.packets, state: source.state,
        aborted: source.signal.aborted, abortEvents: source.abortEvents, cancelCalls: source.cancelCalls,
        cancelSettled: source.cancelSettled, readerLocked: source.stream.locked })),
      turns: turns.map(turn => ({ chunks: turn.chunks, settled: turn.settled, returned: turn.returned })),
      cleanupErrors, allSourcesSettled: sources.every(source => source.state !== 'open'),
      allGeneratorsSettled: turns.every(turn => turn.settled), underlyingSettled,
      retainedIteratorOperations: pending.length, unexpectedGlobalFetch, actualNetworkRequests: 0, children: 0 };
    if (process.env.PB15_OPENROUTER_USAGE_RECEIPT) {
      appendFileSync(process.env.PB15_OPENROUTER_USAGE_RECEIPT, JSON.stringify(receipt) + '\n');
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

function expected(label: string, usage?: ReportedUsage): StreamChunk[] {
  return [{ type: 'text', content: label + ' before.' }, { type: 'text', content: label + ' after.' },
    { type: 'done', contextWindow: 4096,
      ...(usage ? { usage: { input_tokens: usage.input, output_tokens: usage.output } } : {}) }];
}

function finalOwnership(h: { notes: Record<string, unknown>; snapshot: () => unknown }) {
  h.notes.afterBoth = h.snapshot();
  const final = h.notes.afterBoth as { issued: unknown; sources: Array<{ state: string; aborted: boolean; readerLocked: boolean }> };
  expect(final.issued).toEqual([{ aborted: true, abortEvents: 1 }, { aborted: true, abortEvents: 1 }]);
  expect(final.sources).toHaveLength(2);
  expect(final.sources.every(source => source.state === 'closed' && !source.aborted && !source.readerLocked)).toBe(true);
}

describe('OpenRouter reported usage ownership', () => {
  it('a later same-panel turn without usage does not inherit completed usage', async () => {
    await ownedCase('sequential-usage-then-absent', async h => {
      const a = await h.start('sequential-A', 'A', { input: 11, output: 3 });
      await h.finish(a, 0);
      h.notes.afterA = h.snapshot();
      const b = await h.start('sequential-B', 'B');
      await h.finish(b, 1);
      finalOwnership(h);
      // Complete both public turns before asserting the accounting outcome.
      expect(a.chunks).toEqual(expected('A', { input: 11, output: 3 }));
      expect(b.chunks).toEqual(expected('B'));
    });
  }, 15000);

  it('overlapping same-panel turns keep distinct reported usage at independent completion', async () => {
    await ownedCase('overlapping-distinct-usage', async h => {
      const a = await h.start('overlap-A', 'A', { input: 11, output: 3 });
      const b = await h.start('overlap-B', 'B', { input: 29, output: 7 });
      h.notes.afterBothUsageMarkers = h.snapshot();
      await h.finish(a, 0);
      h.notes.afterA = h.snapshot();
      h.notes.replacementControlOwned = h.currentOwns(1);
      await h.finish(b, 1);
      finalOwnership(h);
      expect(h.notes.replacementControlOwned).toBe(true);
      expect(a.chunks).toEqual(expected('A', { input: 11, output: 3 }));
      expect(b.chunks).toEqual(expected('B', { input: 29, output: 7 }));
    });
  }, 15000);

  it('an overlapping turn without usage does not borrow the replacement usage', async () => {
    await ownedCase('overlapping-absent-then-reported', async h => {
      const a = await h.start('absent-A', 'A');
      const b = await h.start('reported-B', 'B', { input: 29, output: 7 });
      h.notes.afterBothUsageMarkers = h.snapshot();
      await h.finish(a, 0);
      h.notes.afterA = h.snapshot();
      h.notes.replacementControlOwned = h.currentOwns(1);
      await h.finish(b, 1);
      finalOwnership(h);
      expect(h.notes.replacementControlOwned).toBe(true);
      expect(a.chunks).toEqual(expected('A'));
      expect(b.chunks).toEqual(expected('B', { input: 29, output: 7 }));
    });
  }, 15000);
});
