import type * as vscode from 'vscode';
import { appendFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaProvider } from '../../src/providers/ollama/OllamaProvider';
import { LocalAIProvider } from '../../src/providers/localai/LocalAIProvider';
import type { Settings, StreamChunk } from '../../src/types';
import { clearConfigurationListeners, clearMockConfig, createMockSecretStorage, setMockConfig } from '../helpers/mockVscode';

// Public HTTP provider lifecycle over owned in-memory streams only.
// No endpoint, socket, child, installed runtime or account is accessed.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const providers = [
  { id: 'ollama', Provider: OllamaProvider, endpoint: 'http://owned-ollama.invalid:11434', route: '/api/chat' },
  { id: 'localai', Provider: LocalAIProvider, endpoint: 'http://owned-localai.invalid:8080', route: '/v1/chat/completions' },
] as const;
type ProviderCase = typeof providers[number];
type Operation = 'cancel-all' | 'clear-all' | 'dispose-all' | 'dispose-panel';
type HttpProvider = OllamaProvider | LocalAIProvider;
type SourceState = 'open' | 'aborted' | 'closed' | 'cleanup-closed';
interface Source {
  panel: string;
  signal: AbortSignal;
  body: Record<string, unknown>;
  state: SourceState;
  abortEvents: number;
  enqueue: (packet: unknown) => void;
  close: (cleanup?: boolean) => void;
  detach: () => void;
}
interface Turn {
  panel: string;
  iterator: AsyncGenerator<StreamChunk>;
  chunks: StreamChunk[];
  settled: boolean;
  returned: boolean;
}
const context = () => ({ subscriptions: [], secrets: createMockSecretStorage(),
  globalState: { get: () => undefined, update: async () => {} },
  workspaceState: { get: () => undefined, update: async () => {} } } as unknown as vscode.ExtensionContext);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = realSetTimeout(() => reject(new Error(`Owned lifecycle fixture did not settle: ${label}`)), 3000);
    })]);
  } finally { if (timer) realClearTimeout(timer); }
}

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); clearMockConfig(); clearConfigurationListeners();
});

async function exercise(spec: ProviderCase, operation: Operation) {
  clearMockConfig(); setMockConfig(`${spec.id}Endpoint`, spec.endpoint);
  // Production timeouts must not manufacture cancellation during the fixture.
  setMockConfig(`${spec.id}RequestTimeout`, 60000);
  const provider: HttpProvider = new spec.Provider(context());
  vi.spyOn(provider as any, 'buildPromptAsync').mockImplementation(async (content: unknown) => String(content));
  const settings = { provider: spec.id, model: 'owned-model', mode: 'quick-plan', accessLevel: 'read-only',
    thinkingLevel: 'none', contextMode: 'manual' } as Settings;
  const ready = [deferred<Source>(), deferred<Source>()];
  const sources: Source[] = [], turns: Turn[] = [], pending: Promise<unknown>[] = [], urls: string[] = [];
  const cleanupErrors: string[] = [];
  const observations: Record<string, unknown> = {};
  const encoder = new TextEncoder();
  let bodyError: unknown;
  let underlyingSettled = false;
  const retain = <T>(promise: Promise<T>) => {
    pending.push(promise); void promise.catch(() => {}); return promise;
  };
  const snapshot = () => ({
    sources: sources.map(source => ({ panel: source.panel, state: source.state,
      aborted: source.signal.aborted, abortEvents: source.abortEvents })),
    turns: turns.map(turn => ({ panel: turn.panel, chunks: [...turn.chunks],
      settled: turn.settled, returned: turn.returned })),
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url); urls.push(address);
    if (spec.id === 'ollama' && address === `${spec.endpoint}/api/ps` && !init?.body) {
      return new Response(JSON.stringify({ models: [{ name: 'owned-model', context_length: 4096 }] }));
    }
    expect(address).toBe(spec.endpoint + spec.route);
    expect(init?.method).toBe('POST'); expect(sources.length).toBeLessThan(2);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init?.body));
    const index = sources.length, panel = index === 0 ? 'panel-A' : 'panel-B';
    expect(body).toMatchObject({ model: 'owned-model', stream: true,
      messages: [{ role: 'user', content: `${panel} request` }] });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const bodyStream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const source: Source = {
      panel, signal: init!.signal as AbortSignal, body, state: 'open', abortEvents: 0,
      enqueue(packet) {
        if (source.state !== 'open') return;
        const text = spec.id === 'ollama' ? JSON.stringify(packet) + '\n'
          : 'data: ' + (typeof packet === 'string' ? packet : JSON.stringify(packet)) + '\n\n';
        controller.enqueue(encoder.encode(text));
      },
      close(cleanup = false) {
        if (source.state === 'open') {
          source.state = cleanup ? 'cleanup-closed' : 'closed'; controller.close();
        }
      },
      detach() { source.signal.removeEventListener('abort', onAbort); },
    };
    function onAbort() {
      source.abortEvents++;
      if (source.state === 'open') {
        source.state = 'aborted';
        controller.error(new DOMException('Owned HTTP source aborted', 'AbortError'));
      }
    }
    source.signal.addEventListener('abort', onAbort, { once: true });
    if (source.signal.aborted) onAbort();
    sources.push(source); ready[index].resolve(source);
    return new Response(bodyStream);
  }));
  const textPacket = (content: string) => spec.id === 'ollama'
    ? { message: { content }, done: false }
    : { choices: [{ delta: { content }, finish_reason: null }] };
  async function next(turn: Turn) {
    const result = await bounded(retain(turn.iterator.next()), `${turn.panel} next`);
    if (result.done) turn.settled = true;
    else turn.chunks.push(result.value);
    return result;
  }
  async function start(panel: string) {
    const index = turns.length;
    const turn: Turn = { panel, iterator: provider.sendMessage(`${panel} request`, [], settings, null, undefined, panel),
      chunks: [], settled: false, returned: false };
    turns.push(turn);
    const first = retain(next(turn));
    const source = await bounded(ready[index].promise, `${panel} POST`);
    source.enqueue(textPacket(`${panel} partial.`));
    expect((await first).value).toEqual({ type: 'text', content: `${panel} partial.` });
    return turn;
  }
  function collect(turn: Turn) {
    return retain((async () => { while (!turn.settled) await next(turn); })());
  }
  function finishB() {
    const source = sources[1];
    source.enqueue(textPacket('panel-B final.'));
    if (spec.id === 'ollama') source.enqueue({ done: true, prompt_eval_count: 7, eval_count: 3 });
    else {
      // Choice-bearing usage keeps the separate choices:[] parser gap out of scope.
      source.enqueue({ choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 3 } });
      source.enqueue('[DONE]');
    }
    source.close();
  }
  try {
    const a = await start('panel-A'), b = await start('panel-B');
    expect(sources[0].signal).not.toBe(sources[1].signal);
    observations.beforeOperation = snapshot();
    // Resume both public readers before invoking the lifecycle action.
    const collecting = [collect(a), collect(b)];
    if (operation === 'cancel-all') provider.cancelCurrentRequest();
    else if (operation === 'clear-all') provider.clearSession();
    else if (operation === 'dispose-all') provider.dispose();
    else provider.disposeSession('panel-A');
    observations.afterOperation = snapshot();
    const expectedAborts = operation === 'dispose-panel' ? [true, false] : [true, true];
    expect(sources.map(source => source.signal.aborted)).toEqual(expectedAborts);
    expect(sources.map(source => source.abortEvents)).toEqual(expectedAborts.map(value => value ? 1 : 0));
    if (operation === 'dispose-panel') {
      observations.panelAEvicted = !(provider as any)._panelSessions.has('panel-A');
      observations.panelBStillOwned = (provider as any)._panelSessions.get('panel-B')?.abortController?.signal === sources[1].signal;
      expect(observations.panelAEvicted).toBe(true);
      expect(observations.panelBStillOwned).toBe(true);
      expect(sources[1].state).toBe('open');
      finishB();
    }
    await bounded(Promise.all(collecting), 'readers after lifecycle action');
    observations.afterReaders = snapshot();
    const cancelled = (panel: string) => [{ type: 'text', content: `${panel} partial.` },
      { type: 'error', content: 'Request cancelled or timed out' }, { type: 'done' }];
    expect(a.chunks).toEqual(cancelled('panel-A'));
    if (operation === 'dispose-panel') {
      expect(b.chunks).toEqual([{ type: 'text', content: 'panel-B partial.' },
        { type: 'text', content: 'panel-B final.' },
        { type: 'done', usage: { input_tokens: 7, output_tokens: 3 },
          ...(spec.id === 'ollama' ? { contextWindow: 4096 } : {}) }]);
    } else expect(b.chunks).toEqual(cancelled('panel-B'));
    expect(turns.every(turn => turn.settled)).toBe(true);
  } catch (error) { bodyError = error; }
  finally {
    observations.beforeCleanup = snapshot();
    // A failed baseline may leave both sources open. Label those forced closes
    // explicitly; never count their later iterator settlement as product abort.
    for (const source of sources) source.close(true);
    for (const turn of turns) {
      if (turn.settled) continue;
      retain((async () => {
        let result = await turn.iterator.return(undefined);
        while (!result.done) result = await turn.iterator.return(undefined);
        turn.settled = true; turn.returned = true;
      })().catch(error => { cleanupErrors.push(String(error)); }));
    }
    // Retain actual operations, not only their real-time bounded waiters.
    // Execution requires an outer owned-worker deadline before this is run.
    await Promise.allSettled(pending);
    underlyingSettled = true;
    observations.afterReaderCleanup = snapshot();
    provider.dispose();
    for (const source of sources) source.detach();
    const receipt = { test: `${spec.id}:${operation}`, provider: spec.id, operation, urls,
      observations, bodyError: bodyError ? String(bodyError) : null, cleanupErrors,
      requests: sources.map(source => ({ panel: source.panel, body: source.body, state: source.state,
        aborted: source.signal.aborted, abortEvents: source.abortEvents })),
      turns: turns.map(turn => ({ panel: turn.panel, chunks: turn.chunks,
        settled: turn.settled, returned: turn.returned })),
      allSourcesSettled: sources.every(source => source.state !== 'open'),
      allGeneratorsSettled: turns.every(turn => turn.settled), underlyingSettled,
      retainedIteratorOperations: pending.length, nativeRequests: 0, children: 0 };
    if (process.env.PB13_HTTP_ALL_SESSION_RECEIPT) {
      appendFileSync(process.env.PB13_HTTP_ALL_SESSION_RECEIPT, JSON.stringify(receipt) + '\n');
    }
    if (!bodyError) {
      expect(sources).toHaveLength(2); expect(turns).toHaveLength(2);
      expect(cleanupErrors).toEqual([]);
      expect(receipt.allSourcesSettled && receipt.allGeneratorsSettled && underlyingSettled).toBe(true);
      expect(sources.some(source => source.state === 'cleanup-closed')).toBe(false);
      expect(urls.filter(url => url === spec.endpoint + spec.route)).toHaveLength(2);
      expect(urls.filter(url => url.endsWith('/api/ps'))).toHaveLength(
        spec.id === 'ollama' && operation === 'dispose-panel' ? 1 : 0);
    }
  }
  if (bodyError) throw bodyError;
}

describe.each(providers)('$id all-session HTTP lifecycle', spec => {
  it.each(['cancel-all', 'clear-all', 'dispose-all'] as const)(
    '%s aborts both distinct live panels and settles their cancelled readers',
    async operation => { await exercise(spec, operation); }, 15000);
  it('disposeSession aborts only the selected panel while its sibling completes',
    async () => { await exercise(spec, 'dispose-panel'); }, 15000);
});
