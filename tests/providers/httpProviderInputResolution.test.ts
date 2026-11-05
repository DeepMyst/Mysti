import { appendFileSync } from 'node:fs';
import type * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OllamaProvider } from '../../src/providers/ollama/OllamaProvider';
import { LocalAIProvider } from '../../src/providers/localai/LocalAIProvider';
import { MiniMaxProvider } from '../../src/providers/minimax/MiniMaxProvider';
import { OpenRouterProvider } from '../../src/providers/openrouter/OpenRouterProvider';
import { OpenRouterClient } from '../../src/services/OpenRouterClient';
import type { GatewayChatParams } from '../../src/services/DeepMystGatewayClient';
import type { ProviderInputResolver } from '../../src/providers/base/IProvider';
import type { ContextItem, Settings, StreamChunk } from '../../src/types';
import { clearConfigurationListeners, clearMockConfig, createMockSecretStorage, setMockConfig } from '../helpers/mockVscode';

const kinds = ['ollama', 'localai', 'minimax', 'openrouter'] as const;
type Kind = typeof kinds[number];
type Hold = 'instructions' | 'thinking' | 'credentials' | 'transport' | 'metadata';
const manual: ContextItem = { id: 'manual', type: 'file', path: '/manual.ts', content: 'MANUAL_BYTES', enabled: true };
const automatic: ContextItem = { id: 'automatic', type: 'selection', path: '/editor.ts', content: 'AUTO_BYTES', enabled: true, startLine: 4, endLine: 7 };
const baseline = { content: 'MANUAL_QUESTION', context: [manual] };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}
async function collect(stream: AsyncGenerator<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
const cleanups: Array<() => Promise<void>> = [];

function harness(kind: Kind, hold?: Hold) {
  const extension = { subscriptions: [], secrets: createMockSecretStorage(),
    globalState: { get: () => undefined, update: async () => {} },
    workspaceState: { get: () => undefined, update: async () => {} } } as unknown as vscode.ExtensionContext;
  const provider = kind === 'ollama' ? new OllamaProvider(extension) : kind === 'localai' ? new LocalAIProvider(extension)
    : kind === 'minimax' ? new MiniMaxProvider(extension) : new OpenRouterProvider(extension);
  const gate = deferred(), entered = deferred(), wireGate = deferred(), wireEntered = deferred();
  const requests: Array<{ url: string; body: any; headers: unknown; redirect: unknown; signal: AbortSignal }> = [];
  const turns: Array<Promise<StreamChunk[]>> = [];
  const canonical: unknown[] = [];
  let holdOnce = true, holdWire = false;
  async function pause(seam: Hold) {
    if (hold === seam && holdOnce) { holdOnce = false; entered.resolve(); await gate.promise; }
  }
  const instructions = vi.spyOn(provider as any, 'buildAgentInstructionsAsync').mockImplementation(async () => {
    await pause('instructions'); return 'TRUSTED_ROLE';
  });
  if (kind === 'ollama') {
    vi.spyOn(provider as any, '_thinkingControl').mockImplementation(async () => { await pause('thinking'); return true; });
    vi.spyOn(provider as any, '_loadedContextLength').mockResolvedValue(4096);
  }
  if (kind === 'minimax') vi.spyOn(provider as any, '_getApiKey').mockImplementation(async () => { await pause('credentials'); return 'owned-key'; });
  if (kind === 'openrouter' || kind === 'localai') vi.spyOn(provider as any, '_getApiKey').mockReturnValue('owned-key');
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url);
    expect(address).toBe(kind === 'ollama' ? 'http://owned.invalid:11434/api/chat' : kind === 'localai'
      ? 'http://owned.invalid:8080/v1/chat/completions' : kind === 'minimax'
        ? 'https://api.minimax.io/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions');
    expect(init?.method).toBe('POST'); expect(init?.signal?.aborted).toBe(false);
    requests.push({ url: address, body: JSON.parse(String(init?.body)), headers: init?.headers,
      redirect: init?.redirect, signal: init?.signal as AbortSignal });
    if (holdWire) { holdWire = false; wireEntered.resolve(); await wireGate.promise; }
    const content = kind === 'ollama'
      ? JSON.stringify({ message: { content: 'owned answer' }, done: false }) + '\n' + JSON.stringify({ done: true, prompt_eval_count: 3, eval_count: 2 }) + '\n'
      : 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'owned answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }) + '\n\ndata: [DONE]\n\n';
    return new Response(content);
  });
  vi.stubGlobal('fetch', fetchMock);
  if (kind === 'openrouter') {
    const client = new OpenRouterClient(() => 'owned-key', { fetchImpl: fetchMock });
    (provider as any)._client = { async *streamChat(params: GatewayChatParams) {
      canonical.push(structuredClone(params.messages));
      await pause('transport'); yield* client.streamChat(params);
    } };
    vi.spyOn(provider as any, '_contextWindowOf').mockImplementation(async () => { await pause('metadata'); return 8192; });
  }
  const settings = { provider: kind, model: kind === 'minimax' ? 'MiniMax-M2.7' : 'owned-model',
    mode: 'quick-plan', accessLevel: 'read-only', thinkingLevel: 'none', contextMode: 'auto', effortLevel: 'high' } as Settings;
  function send(resolveInput?: ProviderInputResolver) {
    const pending = collect((provider.sendMessage as any)(baseline.content, baseline.context, settings, null,
      undefined, 'owned-panel', undefined, undefined, undefined, resolveInput));
    turns.push(pending); return pending;
  }
  cleanups.push(async () => {
    gate.resolve(); wireGate.resolve();
    const settled = await Promise.allSettled(turns);
    provider.dispose();
    if (process.env.MYSTI_HTTP_CONTEXT_RECEIPTS) appendFileSync(process.env.MYSTI_HTTP_CONTEXT_RECEIPTS, JSON.stringify({ kind, hold,
      test: expect.getState().currentTestName, requests: requests.map(({ signal, ...r }) => ({ ...r, abortedAfter: signal.aborted })),
      canonical, turns: settled }) + '\n');
    expect(settled.every(turn => turn.status === 'fulfilled')).toBe(true);
  });
  return { provider, settings, gate, entered, requests, canonical, send, instructions, wireGate, wireEntered,
    holdResponse: () => { holdWire = true; }, session: () => (provider as any)._getSession('owned-panel') };
}

describe('HTTP providers resolve trusted input at actual delivery', () => {
  beforeEach(() => {
    clearMockConfig(); setMockConfig('ollamaEndpoint', 'http://owned.invalid:11434');
    setMockConfig('localaiEndpoint', 'http://owned.invalid:8080');
    setMockConfig('ollamaContextLength', 2048); setMockConfig('localaiMaxTokens', 91); setMockConfig('minimaxMaxTokens', 92);
  });
  afterEach(async () => {
    try { for (const cleanup of cleanups.splice(0)) await cleanup(); }
    finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); clearMockConfig(); clearConfigurationListeners(); }
  });

  for (const kind of kinds) {
    it(`${kind} includes current automatic input without mutating the canonical manual request`, async () => {
      const h = harness(kind);
      const chunks = await h.send(() => ({ content: 'DYNAMIC_QUESTION', context: [manual, automatic] }));
      expect(h.requests).toHaveLength(1);
      const prompt = h.requests[0].body.messages[0].content;
      expect(prompt).toContain('DYNAMIC_QUESTION'); expect(prompt).toContain('AUTO_BYTES'); expect(prompt).toContain('MANUAL_BYTES');
      expect(prompt).toContain('TRUSTED_ROLE'); expect(prompt).toContain('[Planning Mode]');
      expect(baseline).toEqual({ content: 'MANUAL_QUESTION', context: [manual] });
      expect(chunks.filter(c => c.type === 'done')).toHaveLength(1);
    });

    it(`${kind} returns initially obsolete input without touching the previous request`, async () => {
      const h = harness(kind), previous = new AbortController(); h.session().abortController = previous;
      expect(await h.send(() => undefined)).toEqual([]);
      expect(previous.signal.aborted).toBe(false); expect(h.session().abortController).toBe(previous);
      expect(h.instructions).not.toHaveBeenCalled(); expect(h.requests).toEqual([]);
    });

    it(`${kind} preserves no-resolver prompt, body controls and terminal behavior`, async () => {
      const h = harness(kind);
      const prompt = vi.spyOn(h.provider as any, 'buildPromptAsync').mockResolvedValue('EXACT_LEGACY_PROMPT');
      const chunks = await h.send();
      expect(prompt).toHaveBeenCalledOnce(); expect(h.requests).toHaveLength(1);
      expect(h.requests[0].body).toMatchObject({ model: h.settings.model, messages: [{ role: 'user', content: 'EXACT_LEGACY_PROMPT' }], stream: true });
      if (kind === 'ollama') expect(h.requests[0].body).toMatchObject({ options: { temperature: 0.7, num_ctx: 2048 }, think: true, keep_alive: '5m' });
      if (kind === 'localai') expect(h.requests[0].body).toMatchObject({ temperature: 0.7, max_tokens: 91, reasoning_effort: 'high' });
      if (kind === 'minimax') { expect(h.requests[0].body).toMatchObject({ max_completion_tokens: 92, reasoning_split: true }); expect(h.requests[0].redirect).toBe('error'); }
      if (kind !== 'ollama') expect(h.requests[0].headers).toMatchObject({ Authorization: 'Bearer owned-key' });
      expect(chunks.filter(c => c.type === 'text').map(c => c.content).join('')).toBe('owned answer');
      expect(chunks.filter(c => c.type === 'done')).toHaveLength(1);
    });

    it(`${kind} rechecks cancellation caused by the final resolver before serializing a body`, async () => {
      const h = harness(kind); let calls = 0;
      const chunks = await h.send(() => {
        if (++calls > 1) h.provider.cancelCurrentRequest('owned-panel');
        return { content: 'CANCELLED_DURING_RESOLUTION', context: [automatic] };
      });
      expect(calls).toBe(2); expect(h.requests).toEqual([]);
      expect(chunks.some(c => c.type === 'text' || c.type === 'done')).toBe(false);
      expect(h.session().abortController).toBeNull();
    });

    it(`${kind} honors Stop while instruction preparation is pending without a completion claim`, async () => {
      const h = harness(kind, 'instructions');
      const pending = h.send(() => ({ content: 'STOPPED_REQUEST', context: [automatic] }));
      await Promise.race([h.entered.promise, pending.then(() => { throw new Error('Preparation ended before Stop'); })]);
      h.provider.cancelCurrentRequest('owned-panel'); h.gate.resolve(); const chunks = await pending;
      expect(h.requests).toEqual([]); expect(chunks.some(c => c.type === 'text' || c.type === 'done')).toBe(false);
      expect(h.session().abortController).toBeNull();
    });

    const seams: Hold[] = ['instructions', ...(kind === 'ollama' ? ['thinking' as const] : kind === 'minimax'
      ? ['credentials' as const] : kind === 'openrouter' ? ['transport' as const] : [])];
    for (const seam of seams) {
      it(`${kind} refreshes exact outgoing input after held ${seam}`, async () => {
        const h = harness(kind, seam); let enabled = true;
        const pending = h.send(() => ({ content: enabled ? 'WITH_AUTO' : 'WITHOUT_AUTO', context: enabled ? [manual, automatic] : [manual] }));
        await Promise.race([h.entered.promise, pending.then(() => { throw new Error('Preparation ended before hold'); })]);
        enabled = false; h.gate.resolve(); await pending;
        expect(h.requests).toHaveLength(1); const prompt = h.requests[0].body.messages[0].content;
        expect(prompt).toContain('WITHOUT_AUTO'); expect(prompt).toContain('MANUAL_BYTES'); expect(prompt).toContain('TRUSTED_ROLE');
        expect(prompt).not.toContain('AUTO_BYTES'); expect(prompt).not.toContain('WITH_AUTO');
        if (seam === 'transport') expect(JSON.stringify(h.canonical)).not.toContain('AUTO_BYTES');
      });
      it(`${kind} never dispatches or reports completion after revocation during ${seam}`, async () => {
        const h = harness(kind, seam); let current = true;
        const pending = h.send(() => current ? { content: 'WITH_AUTO', context: [manual, automatic] } : undefined);
        await Promise.race([h.entered.promise, pending.then(() => { throw new Error('Preparation ended before hold'); })]);
        current = false; h.gate.resolve(); const chunks = await pending;
        expect(h.requests).toEqual([]); expect(chunks.some(c => c.type === 'done' || c.type === 'text')).toBe(false);
        expect(h.session().abortController).toBeNull();
      });
    }

    it(`${kind} cannot deliver an older pending prompt or clear its successor controller`, async () => {
      const h = harness(kind, 'instructions');
      const old = h.send(() => ({ content: 'OLD_REQUEST', context: [automatic] }));
      await Promise.race([h.entered.promise, old.then(() => { throw new Error('Old request did not pause'); })]);
      h.holdResponse(); const next = h.send(() => ({ content: 'NEW_REQUEST', context: [manual] }));
      await Promise.race([h.wireEntered.promise, next.then(() => { throw new Error('Successor did not dispatch'); })]);
      const successor = h.session().abortController;
      h.gate.resolve(); const oldChunks = await old;
      expect(h.requests).toHaveLength(1); expect(h.requests[0].body.messages[0].content).toContain('NEW_REQUEST');
      expect(oldChunks.some(c => c.type === 'text' || c.type === 'done')).toBe(false);
      expect(h.session().abortController).toBe(successor); expect(successor.signal.aborted).toBe(false);
      h.wireGate.resolve(); expect((await next).some(c => c.type === 'done')).toBe(true);
    });
  }

  for (const dynamic of [false, true]) {
    const mode = dynamic ? 'dynamic' : 'static';
    it(`openrouter ${mode} Stop during terminal metadata cannot report completion`, async () => {
      const h = harness('openrouter', 'metadata');
      const resolver = dynamic ? () => ({ content: 'CURRENT_REQUEST', context: [manual, automatic] }) : undefined;
      const pending = h.send(resolver);
      await Promise.race([h.entered.promise, pending.then(() => { throw new Error('Metadata did not pause'); })]);
      h.provider.cancelCurrentRequest('owned-panel'); h.gate.resolve(); const chunks = await pending;
      expect(chunks.filter(c => c.type === 'text')).toHaveLength(1);
      expect(chunks.some(c => c.type === 'done')).toBe(false); expect(h.session().abortController).toBeNull();
      expect((await h.send(resolver)).filter(c => c.type === 'done')).toHaveLength(1);
    });
    it(`openrouter ${mode} metadata completion cannot overtake or clear its successor`, async () => {
      const h = harness('openrouter', 'metadata');
      const resolver = dynamic ? () => ({ content: 'CURRENT_REQUEST', context: [manual, automatic] }) : undefined;
      const old = h.send(resolver);
      await Promise.race([h.entered.promise, old.then(() => { throw new Error('Metadata did not pause'); })]);
      h.holdResponse(); const next = h.send(resolver);
      await Promise.race([h.wireEntered.promise, next.then(() => { throw new Error('Successor did not dispatch'); })]);
      const successor = h.session().abortController;
      h.gate.resolve(); expect((await old).some(c => c.type === 'done')).toBe(false);
      expect(h.session().abortController).toBe(successor); expect(successor.signal.aborted).toBe(false);
      h.wireGate.resolve(); expect((await next).filter(c => c.type === 'done')).toHaveLength(1);
    });
  }
});
