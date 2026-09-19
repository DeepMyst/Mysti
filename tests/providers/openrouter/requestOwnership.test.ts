import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestableOpenRouterProvider } from '../../helpers/providerFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import type { OpenRouterClient, OpenRouterStreamEvent } from '../../../src/services/OpenRouterClient';
import type { GatewayChatParams } from '../../../src/services/DeepMystGatewayClient';
import type { OpenRouterSessionState } from '../../../src/providers/openrouter/OpenRouterProvider';
import type { Settings, StreamChunk } from '../../../src/types';

class Provider extends TestableOpenRouterProvider {
  prepare = async () => 'inert prepared prompt';
  protected override buildPromptAsync(): Promise<string> { return this.prepare(); }
  owner(panel: string): AbortController | null { return (this._getSession(panel) as OpenRouterSessionState).abortController; }
}
const settings: Settings = { provider: 'openrouter', model: 'openrouter/free', mode: 'default', accessLevel: 'ask-permission', thinkingLevel: 'none', contextMode: 'auto' };
const collect = async (stream: AsyncGenerator<StreamChunk>) => { const events: StreamChunk[] = []; for await (const event of stream) { events.push(event); } return events; };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function client(streamChat: (params: GatewayChatParams) => AsyncGenerator<OpenRouterStreamEvent>): OpenRouterClient { return { streamChat } as OpenRouterClient; }

describe('OpenRouter request ownership', () => {
  let provider: Provider;
  beforeEach(() => { clearMockConfig(); setMockConfig('openrouter.apiKey', 'inert-fixture'); provider = new Provider(); });
  afterEach(() => { provider.dispose(); clearMockConfig(); });
  const send = (provider: Provider, panel = 'panel') => provider.sendMessage('inert', [], settings, null, undefined, panel);

  it.each(['Stop', 'dispose', 'clear'] as const)('%s during prompt preparation prevents submission', async action => {
    const gate = deferred<string>(); const entered = deferred<void>(); let calls = 0;
    provider.prepare = () => { entered.resolve(); return gate.promise; };
    provider.setClient(client(async function* () { calls++; yield { text: 'late' }; yield { done: true }; }));
    const pending = collect(send(provider)); await entered.promise;
    if (action === 'Stop') { provider.cancelCurrentRequest('panel'); }
    else if (action === 'clear') { provider.clearSession('panel'); }
    else { provider.dispose(); }
    gate.resolve('prepared');
    expect(await pending).toEqual([]); expect(calls).toBe(0); expect(provider.owner('panel')).toBeNull();
  });

  it('replacement revokes its predecessor; old finally preserves replacement and sibling', async () => {
    const signals: AbortSignal[] = [];
    provider.setClient(client(async function* (params) { signals.push(params.signal!); yield { text: 'started' }; yield { text: 'later' }; yield { done: true }; }));
    const old = send(provider); await old.next();
    const current = send(provider); await current.next();
    const sibling = send(provider, 'sibling'); await sibling.next();
    expect(signals.map(signal => signal.aborted)).toEqual([true, false, false]);
    await old.return(undefined);
    expect(provider.owner('panel')?.signal).toBe(signals[1]);
    expect(signals.map(signal => signal.aborted)).toEqual([true, false, false]);
    provider.cancelCurrentRequest('panel');
    expect(await collect(current)).toEqual([]);
    expect(signals[2].aborted).toBe(false);
    expect((await collect(sibling)).map(event => event.type)).toEqual(['text', 'done']);
  });

  it('suppresses late events from a replaced request even when the source ignores abort', async () => {
    provider.setClient(client(async function* () { yield { text: 'first' }; yield { text: 'stale', reasoning: 'stale reasoning' }; yield { done: true }; }));
    const old = send(provider); await old.next(); const current = send(provider); await current.next();
    expect(await collect(old)).toEqual([]); expect(provider.owner('panel')?.signal.aborted).toBe(false);
    await current.return(undefined);
  });

  it('Stop between two fields of one event emits no late reasoning or null-controller error', async () => {
    provider.setClient(client(async function* () { yield { text: 'first', reasoning: 'late' }; yield { done: true }; }));
    const stream = send(provider); expect((await stream.next()).value).toEqual({ type: 'text', content: 'first' });
    provider.cancelCurrentRequest('panel'); expect(await collect(stream)).toEqual([]);
  });

  it('returning a generator aborts only that owner', async () => {
    const signals: AbortSignal[] = [];
    provider.setClient(client(async function* (params) { signals.push(params.signal!); yield { text: 'first' }; yield { done: true }; }));
    const first = send(provider); const sibling = send(provider, 'sibling'); await first.next(); await sibling.next();
    await first.return(undefined); expect(signals.map(signal => signal.aborted)).toEqual([true, false]);
    await sibling.return(undefined);
  });

  it('clears the selected default session while preserving its sibling; clear-all revokes both', async () => {
    provider.setClient(client(async function* () { yield { text: 'first' }; yield { text: 'late' }; yield { done: true }; }));
    const first = provider.sendMessage('inert', [], settings, null); const sibling = send(provider, 'sibling');
    await first.next(); await sibling.next(); provider.clearSession('default');
    expect(await collect(first)).toEqual([]); expect(provider.owner('sibling')?.signal.aborted).toBe(false);
    const next = provider.sendMessage('inert', [], settings, null); await next.next(); provider.clearSession();
    expect(await collect(next)).toEqual([]); expect(await collect(sibling)).toEqual([]);
  });

  it('evicts an active session and preserves its newly created replacement against old finally', async () => {
    provider.setClient(client(async function* () { yield { text: 'first' }; yield { done: true }; }));
    const old = send(provider); await old.next(); provider.disposeSession('panel');
    const current = send(provider); await current.next(); const owner = provider.owner('panel');
    await old.return(undefined); expect(provider.owner('panel')).toBe(owner); expect(owner?.signal.aborted).toBe(false);
    expect(await collect(current)).toEqual([{ type: 'done' }]);
  });

  it('usage is local to the response and preserves normalized cache fields', async () => {
    let call = 0;
    provider.setClient(client(async function* () {
      if (call++ === 0) { yield { usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 5, cacheCreationTokens: 3, cacheCreationIncluded: true } }; }
      yield { text: 'ok' }; yield { done: true };
    }));
    expect((await collect(send(provider))).at(-1)).toEqual({ type: 'done', usage: { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 5, cache_creation_input_tokens: 3, normalized: true } });
    expect((await collect(send(provider))).at(-1)).toEqual({ type: 'done' });

  });

  it.each(['length', 'content_filter', 'error', 'tool_calls'])('does not mark %s as successful completion', async finishReason => {
    provider.setClient(client(async function* () { yield { text: 'partial' }; yield { finishReason }; yield { done: true }; }));
    const events = await collect(send(provider)); expect(events[0]).toEqual({ type: 'text', content: 'partial' });
    expect(events.at(-1)?.type).toBe('error'); expect(events.some(event => event.type === 'done')).toBe(false);
  });

  it('rejects a missing completion and releases ownership after prompt failure', async () => {
    provider.setClient(client(async function* () { yield { text: 'partial' }; }));
    expect((await collect(send(provider))).at(-1)?.content).toContain('before completion');
    provider.prepare = async () => { throw new Error('fixture preparation failed'); };
    expect(await collect(send(provider))).toEqual([{ type: 'error', content: 'OpenRouter: fixture preparation failed' }]);
    expect(provider.owner('panel')).toBeNull();
  });
});
