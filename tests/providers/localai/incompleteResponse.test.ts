import { appendFileSync } from 'node:fs';
import type * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAIProvider } from '../../../src/providers/localai/LocalAIProvider';
import type { Settings, StreamChunk } from '../../../src/types';
import { clearConfigurationListeners, clearMockConfig, createMockSecretStorage, setMockConfig } from '../../helpers/mockVscode';

// Complete in-memory Response bodies only; no endpoint, socket, child or native request.
// A terminal-free body is intentional fixture input, not emergency cleanup.
const endpoint = 'http://owned-localai.invalid:8080';
const fixtureSetTimeout = globalThis.setTimeout;
const fixtureClearTimeout = globalThis.clearTimeout;
const settings = { provider: 'localai', model: 'owned-model', mode: 'quick-plan', accessLevel: 'read-only',
  thinkingLevel: 'none', contextMode: 'manual' } as Settings;
const context = () => ({ subscriptions: [], secrets: createMockSecretStorage(),
  globalState: { get: () => undefined, update: async () => {} },
  workspaceState: { get: () => undefined, update: async () => {} } } as unknown as vscode.ExtensionContext);
const textPacket = (content: string) => ({ choices: [{ delta: { content }, finish_reason: null }] });
const terminalUsage = { choices: [{ delta: {}, finish_reason: 'stop' }],
  usage: { prompt_tokens: 11, completion_tokens: 3 } };
const doneWithUsage: StreamChunk = { type: 'done', usage: { input_tokens: 11, output_tokens: 3 } };

async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = fixtureSetTimeout(() => reject(new Error(`Owned LocalAI EOF fixture did not settle: ${label}`)), 3000);
    })]);
  } finally { if (timer) fixtureClearTimeout(timer); }
}

interface Turn {
  prompt: string;
  packets: unknown[];
  wire: string;
  iterator: AsyncGenerator<StreamChunk>;
  chunks: StreamChunk[];
  settled: boolean;
}
interface Call {
  url: string;
  method: string | undefined;
  body: unknown;
  signal: AbortSignal;
  abortEvents: number;
  response: Response;
  detach: () => void;
}

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); clearMockConfig(); clearConfigurationListeners();
});

async function ownedCase(name: string, exercise: (send: (prompt: string, packets: unknown[]) => Promise<StreamChunk[]>) => Promise<void>) {
  clearMockConfig(); setMockConfig('localaiEndpoint', endpoint);
  const provider = new LocalAIProvider(context());
  vi.spyOn(provider as any, 'buildPromptAsync').mockImplementation(async (content: unknown) => String(content));
  const turns: Turn[] = [], calls: Call[] = [], pending: Promise<unknown>[] = [];
  const cleanupErrors: string[] = [];
  let bodyError: unknown, cleanupRequested = false, rawOperationsSettled = false;
  const retain = <T>(operation: Promise<T>) => {
    pending.push(operation); void operation.catch(() => {}); return operation;
  };
  const snapshot = () => ({
    calls: calls.map(call => ({ url: call.url, method: call.method, body: call.body,
      signalAborted: call.signal.aborted, abortEvents: call.abortEvents,
      bodyUsed: call.response.bodyUsed, readerLocked: call.response.body?.locked ?? null })),
    turns: turns.map(turn => ({ prompt: turn.prompt, packets: turn.packets, wire: turn.wire,
      chunks: [...turn.chunks], settled: turn.settled })),
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const turn = turns[calls.length];
    expect(turn).toBeDefined();
    expect(calls.length).toBeLessThan(2);
    expect(String(url)).toBe(endpoint + '/v1/chat/completions');
    expect(init?.method).toBe('POST');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ model: 'owned-model', stream: true, temperature: 0.7,
      messages: [{ role: 'user', content: turn.prompt }] });
    const response = new Response(turn.wire, { headers: { 'content-type': 'text/event-stream' } });
    // Even the empty string owns a response body; this is not the existing null-body case.
    expect(response.body).not.toBeNull();
    const signal = init!.signal as AbortSignal;
    const call: Call = { url: String(url), method: init?.method, body, response, signal, abortEvents: 0,
      detach() { signal.removeEventListener('abort', onAbort); } };
    function onAbort() { call.abortEvents++; }
    signal.addEventListener('abort', onAbort, { once: true });
    calls.push(call);
    return response;
  }));
  let beforeCleanup: ReturnType<typeof snapshot> | undefined;
  let afterReaderCleanup: ReturnType<typeof snapshot> | undefined;
  try {
    await exercise(async (prompt, packets) => {
      const wire = packets.map(packet =>
        'data: ' + (typeof packet === 'string' ? packet : JSON.stringify(packet)) + '\n\n').join('');
      const turn: Turn = { prompt, packets, wire,
        iterator: provider.sendMessage(prompt, [], settings, null, undefined, 'same-panel'),
        chunks: [], settled: false };
      turns.push(turn);
      const collect = retain((async () => {
        for await (const chunk of turn.iterator) turn.chunks.push(chunk);
        turn.settled = true;
      })());
      await bounded(collect, 'public iteration');
      return turn.chunks;
    });
  } catch (error) { bodyError = error; }
  finally {
    beforeCleanup = snapshot();
    if (turns.some(turn => !turn.settled)) {
      cleanupRequested = true;
      provider.cancelCurrentRequest('same-panel');
      for (const turn of turns) {
        if (turn.settled) continue;
        retain((async () => {
          let result = await turn.iterator.return(undefined);
          while (!result.done) result = await turn.iterator.return(undefined);
          turn.settled = true;
        })().catch(error => { cleanupErrors.push(String(error)); }));
      }
    }
    // Retain actual collectors/returns on failure. Future execution requires a
    // bounded owned-worker runner if a broken provider never settles.
    let consumed = 0;
    while (consumed < pending.length) {
      const batch = pending.slice(consumed); consumed = pending.length;
      await Promise.allSettled(batch);
    }
    rawOperationsSettled = true;
    afterReaderCleanup = snapshot();
    provider.dispose();
    const afterDispose = snapshot();
    for (const call of calls) call.detach();
    const receipt = { test: name, bodyError: bodyError ? String(bodyError) : null,
      beforeCleanup, afterReaderCleanup, afterDispose, cleanupRequested, cleanupErrors,
      rawOperationsSettled, retainedCollectorReturnOperations: pending.length,
      nativeRequests: 0, actualNetworkRequests: 0, children: 0,
      scope: 'Complete preclosed Response bodies. Reader-lock state is recorded, not asserted as released. No underlying read-demand or service cancellation claim.' };
    if (process.env.PB14_LOCALAI_INCOMPLETE_RECEIPT) {
      appendFileSync(process.env.PB14_LOCALAI_INCOMPLETE_RECEIPT, JSON.stringify(receipt) + '\n');
    }
    if (!bodyError) {
      expect(calls).toHaveLength(turns.length);
      expect(cleanupRequested).toBe(false); expect(cleanupErrors).toEqual([]);
      expect(rawOperationsSettled).toBe(true);
      expect(turns.every(turn => turn.settled)).toBe(true);
      expect(calls.every(call => call.signal.aborted && call.abortEvents === 1 && call.response.bodyUsed)).toBe(true);
      expect(beforeCleanup).toEqual(afterReaderCleanup);
      expect(afterDispose).toEqual(afterReaderCleanup);
    }
  }
  if (bodyError) throw bodyError;
}

function expectIncomplete(chunks: StreamChunk[], partial: string | undefined) {
  expect(chunks.filter(chunk => chunk.type === 'text')).toEqual(
    partial ? [{ type: 'text', content: partial }] : []);
  const errors = chunks.filter(chunk => chunk.type === 'error');
  expect(errors).toHaveLength(1);
  // Semantic diagnostic, not a fixed new user-facing sentence.
  expect(errors[0].content).toMatch(/incomplete|truncat|(?:stream|response).*(?:ended|closed).*(?:before|without)/i);
  expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
  expect(chunks.map(chunk => chunk.type)).toEqual(partial ? ['text', 'error', 'done'] : ['error', 'done']);
}

describe('LocalAI incomplete response boundary', () => {
  it.each([
    { name: 'partial terminal-free EOF', partial: 'Preserved partial.' },
    { name: 'empty terminal-free EOF', partial: undefined },
  ])('reports $name and completes a fresh same-panel recovery', async ({ name, partial }) => {
    await ownedCase(name, async send => {
      const failed = await send('request-A', partial ? [textPacket(partial)] : []);
      // Exercise and retain healthy recovery before checking the baseline defect.
      const recovery = await send('request-B', [textPacket('Fresh recovery.'), terminalUsage, '[DONE]']);
      expect(recovery).toEqual([{ type: 'text', content: 'Fresh recovery.' }, doneWithUsage]);
      expectIncomplete(failed, partial);
    });
  }, 15000);

  it('accepts finish_reason-only completion and preserves reported usage', async () => {
    await ownedCase('finish-reason-only usage', async send => {
      const chunks = await send('finish-only', [textPacket('Completed answer.'), terminalUsage]);
      expect(chunks).toEqual([{ type: 'text', content: 'Completed answer.' }, doneWithUsage]);
    });
  }, 15000);

  it('accepts DONE-only completion with an unexecuted tool proposal', async () => {
    await ownedCase('done-only tool proposal', async send => {
      const input = { file_path: '/owned/canary.txt', old_string: 'before', new_string: 'after' };
      const chunks = await send('proposal-only', [
        { choices: [{ delta: { tool_calls: [{ id: 'owned-proposal', function: {
          name: 'Edit', arguments: JSON.stringify(input),
        } }] } }] }, '[DONE]',
      ]);
      expect(chunks).toEqual([
        { type: 'tool_use', toolCall: { id: 'owned-proposal', name: 'Edit', input,
          status: 'proposed', proposalOnly: true, kind: 'edit' } },
        { type: 'done', usage: { input_tokens: 0, output_tokens: 0, estimated: true } },
      ]);
    });
  }, 15000);
});
