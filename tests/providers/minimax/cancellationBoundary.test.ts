import { appendFileSync } from 'node:fs';
import type * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MiniMaxProvider } from '../../../src/providers/minimax/MiniMaxProvider';
import type { Settings, StreamChunk, UsageStats } from '../../../src/types';
import { clearConfigurationListeners, clearMockConfig, createMockSecretStorage, setMockConfig } from '../../helpers/mockVscode';

// Each response enqueues exactly one byte chunk and closes before fetch returns.
// This observes buffered parser cancellation, not a pending network read or remote abort.
const fixtureSetTimeout = globalThis.setTimeout;
const fixtureClearTimeout = globalThis.clearTimeout;
const endpoint = 'https://api.minimax.io/v1/chat/completions';
const settings = {
  provider: 'minimax', model: 'MiniMax-M2.7', mode: 'edit-automatically',
  accessLevel: 'full-access', thinkingLevel: 'none', contextMode: 'manual',
} as Settings;
const packet = (delta: Record<string, unknown>) => ({ choices: [{ delta }] });
const usagePacket = (input: number, output: number) => ({
  choices: [], usage: { prompt_tokens: input, completion_tokens: output },
});
const finishPacket = { choices: [{ delta: {}, finish_reason: 'stop' }] };
const wire = (packets: unknown[]) => packets.map(value =>
  'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n').join('');

class Provider extends MiniMaxProvider {
  protected async buildPromptAsync(content: string): Promise<string> { return content; }
}

interface Turn {
  prompt: string;
  packets: unknown[];
  wire: string;
  iterator: AsyncGenerator<StreamChunk>;
  chunks: StreamChunk[];
  settled: boolean;
  returned: boolean;
}
interface Call {
  url: string;
  method: string | undefined;
  body: unknown;
  signal: AbortSignal;
  abortEvents: number;
  response: Response;
  source: { enqueuedChunks: number; enqueuedBytes: number; closed: boolean; cancelCalls: number };
  detach: () => void;
}

async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = fixtureSetTimeout(() => reject(new Error(`Owned MiniMax operation did not settle: ${label}`)), 3000);
    })]);
  } finally { if (timer) fixtureClearTimeout(timer); }
}

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  clearMockConfig(); clearConfigurationListeners();
});

async function ownedCase(kind: 'after-text' | 'after-thinking') {
  clearMockConfig();
  setMockConfig('minimaxRequestTimeout', 30000);
  vi.stubEnv('MINIMAX_API_KEY', '');
  const secrets = createMockSecretStorage();
  await secrets.store('mysti.minimax.apiKey', 'owned-synthetic-minimax-key');
  const provider = new Provider({ subscriptions: [], secrets,
    globalState: { get: () => undefined, update: async () => {} },
    workspaceState: { get: () => undefined, update: async () => {} },
  } as unknown as vscode.ExtensionContext);
  const turns: Turn[] = [], calls: Call[] = [];
  const operations: Array<{ label: string; promise: Promise<unknown>; settled: boolean; status?: string }> = [];
  const notes: Record<string, unknown> = {};
  const actions: string[] = [];
  const cleanupErrors: string[] = [];
  let bodyError: unknown, cleanupRequested = false, rawOperationsSettled = false;
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
    turns: turns.map(turn => ({
      prompt: turn.prompt, packets: turn.packets, wire: turn.wire,
      chunks: [...turn.chunks], settled: turn.settled, returned: turn.returned,
    })),
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const turn = turns[calls.length];
    expect(turn).toBeDefined(); expect(calls.length).toBeLessThan(2);
    expect(String(url)).toBe(endpoint); expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error'); expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      model: 'MiniMax-M2.7', messages: [{ role: 'user', content: turn.prompt }],
      stream: true, temperature: 1, stream_options: { include_usage: true }, reasoning_split: true,
    });
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
    const call: Call = {
      url: String(url), method: init?.method, body, response, signal, source, abortEvents: 0,
      detach() { signal.removeEventListener('abort', onAbort); },
    };
    function onAbort() { call.abortEvents++; }
    signal.addEventListener('abort', onAbort, { once: true });
    calls.push(call);
    return response;
  }));
  const create = (prompt: string, packets: unknown[]) => {
    const turn: Turn = {
      prompt, packets, wire: wire(packets),
      iterator: provider.sendMessage(prompt, [], settings, null, undefined, 'same-panel'),
      chunks: [], settled: false, returned: false,
    };
    turns.push(turn); return turn;
  };
  const drain = (turn: Turn) => retain((async () => {
    for await (const chunk of turn.iterator) turn.chunks.push(chunk);
    turn.settled = true;
  })(), 'drain:' + turn.prompt);
  let beforeCleanup: ReturnType<typeof snapshot> | undefined;
  let afterReaderCleanup: ReturnType<typeof snapshot> | undefined;
  try {
    const first: StreamChunk = kind === 'after-text'
      ? { type: 'text', content: 'Preserved text.' }
      : { type: 'thinking', content: 'Preserved reasoning.' };
    const firstPacket = kind === 'after-text'
      ? packet({ content: first.content })
      : packet({ reasoning_content: first.content, content: 'Forbidden same-frame text.' });
    const a = create('cancel-A', [
      firstPacket, packet({ reasoning_content: 'Forbidden later reasoning.', content: 'Forbidden later text.' }),
      usagePacket(91, 23), finishPacket, '[DONE]',
    ]);
    const observed = await bounded(retain(a.iterator.next(), 'first:A'), 'first A chunk');
    expect(observed.done).toBe(false); expect(observed.value).toEqual(first);
    a.chunks.push(observed.value); actions.push('first-public-chunk');
    notes.beforeStop = snapshot();
    expect(calls[0].source.enqueuedChunks).toBe(1);
    expect(calls[0].source.closed).toBe(true);
    expect(calls[0].signal.aborted).toBe(false);
    expect(calls[0].response.body?.locked).toBe(true);
    provider.cancelCurrentRequest('same-panel'); actions.push('public-stop');
    notes.afterStop = snapshot();
    expect(calls[0].signal.aborted).toBe(true); expect(calls[0].abortEvents).toBe(1);
    // Resume the suspended yield; return() would skip the parser continuation under test.
    await bounded(drain(a), 'drain cancelled A');
    actions.push('A-settled'); notes.afterA = snapshot();
    notes.afterAStoredUsage = provider.getStoredUsage('same-panel');
    const b = create('recovery-B', [packet({ content: 'Healthy recovery.' }), usagePacket(11, 3), finishPacket, '[DONE]']);
    await bounded(drain(b), 'healthy B');
    actions.push('B-settled'); notes.afterB = snapshot();
    notes.afterBStoredUsage = provider.getStoredUsage('same-panel');
    // Preserve complete recovery and baseline defect evidence before semantic assertions.
    expect(b.chunks).toEqual([
      { type: 'text', content: 'Healthy recovery.' },
      { type: 'done', usage: { input_tokens: 11, output_tokens: 3 }, contextWindow: 204800 },
    ]);
    expect(notes.afterBStoredUsage).toEqual({ input_tokens: 11, output_tokens: 3 } satisfies UsageStats);
    const late = a.chunks.slice(1);
    expect(late.filter(chunk => chunk.type !== 'error')).toEqual([]);
    expect(late.length).toBeLessThanOrEqual(1);
    if (late.length) expect(late[0].content).toMatch(/cancel|abort|timed out/i);
    expect(late.every(chunk => !chunk.usage && !chunk.toolCall)).toBe(true);
    expect(notes.afterAStoredUsage).toBeNull();
  } catch (error) { bodyError = error; }
  finally {
    beforeCleanup = snapshot();
    if (turns.some(turn => !turn.settled)) {
      cleanupRequested = true; provider.cancelCurrentRequest('same-panel');
      for (const turn of turns) {
        if (turn.settled) continue;
        retain((async () => {
          let value = await turn.iterator.return(undefined);
          while (!value.done) value = await turn.iterator.return(undefined);
          turn.settled = true; turn.returned = true;
        })().catch(error => { cleanupErrors.push(String(error)); }), 'cleanup-return:' + turn.prompt);
      }
    }
    // Await retained underlying operations, including failure paths. The owned-worker
    // runner provides the outer bound if a broken iterator cannot settle.
    let consumed = 0;
    while (consumed < operations.length) {
      const batch = operations.slice(consumed); consumed = operations.length;
      await Promise.allSettled(batch.map(operation => operation.promise));
    }
    rawOperationsSettled = operations.every(operation => operation.settled);
    afterReaderCleanup = snapshot();
    try { provider.dispose(); } catch (error) { cleanupErrors.push(String(error)); }
    const afterDispose = snapshot();
    calls.forEach(call => call.detach());
    const receipt = {
      test: kind, bodyError: bodyError ? String(bodyError) : null, actions, notes,
      beforeCleanup, afterReaderCleanup, afterDispose, cleanupRequested, cleanupErrors,
      rawOperationsSettled,
      operations: operations.map(({ label, settled, status }) => ({ label, settled, status })),
      actualNetworkRequests: 0, nativeRequests: 0, children: 0,
      scope: 'One preclosed byte chunk per Response; actual public parser/Stop and body-lock observation. No service abort or pending network read claim.',
    };
    if (process.env.PB16_MINIMAX_BUFFERED_CANCELLATION_RECEIPT) {
      appendFileSync(process.env.PB16_MINIMAX_BUFFERED_CANCELLATION_RECEIPT, JSON.stringify(receipt) + '\n');
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
}

describe('MiniMax buffered cancellation boundary', () => {
  it.each(['after-text', 'after-thinking'] as const)(
    'stops buffered output %s and completes a healthy same-panel follow-up',
    async kind => { await ownedCase(kind); },
    15000,
  );
});
