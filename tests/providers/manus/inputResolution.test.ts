import { EventEmitter } from 'node:events';
import * as https from 'https';
import type * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManusProvider, type ManusSessionState } from '../../../src/providers/manus/ManusProvider';
import type { ProviderInputResolver } from '../../../src/providers/base/IProvider';
import type { Attachment, ContextItem, Settings, StreamChunk } from '../../../src/types';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';

vi.mock('https', () => ({ request: vi.fn() }));

const settings = { provider: 'manus', model: 'manus-1.6', routedModel: 'manus-1.6-lite', mode: 'quick-plan',
  accessLevel: 'read-only', thinkingLevel: 'none', contextMode: 'auto' } as Settings;
const manual: ContextItem = { id: 'manual', type: 'file', path: '/manual.ts', content: 'MANUAL_BYTES', enabled: true };
const automatic: ContextItem = { id: 'automatic', type: 'file', path: '/editor.ts', content: 'AUTO_BYTES', enabled: true };
// Ninth position is deliberately populated: the resolver belongs in position ten.
const attachments = [{ id: 'reserved', type: 'file', fileName: 'unused.txt', filePath: '/RESERVED_ATTACHMENT' }] as Attachment[];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function drain(gen: AsyncGenerator<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  return chunks;
}
interface WireRequest { method: string; path: string; bytes: string; headers: https.RequestOptions['headers']; destroyed: boolean }
class TestManus extends ManusProvider {
  constructor() { super({ subscriptions: [], globalState: { get: () => undefined, update: async () => undefined } } as unknown as vscode.ExtensionContext); }
  session(panel = 'panel'): ManusSessionState { return this._getSession(panel) as ManusSessionState; }
  hasPanel(panel = 'panel'): boolean { return this._panelSessions.has(panel); }
}
const providers: TestManus[] = [];
function harness(holdInstructions = false) {
  const provider = new TestManus(); providers.push(provider);
  const requests: WireRequest[] = [];
  let nextTask = 0;
  vi.mocked(https.request).mockImplementation(((options: https.RequestOptions, listener: (response: EventEmitter) => void) => {
    const wire: WireRequest = { method: String(options.method), path: String(options.path), headers: options.headers, bytes: '', destroyed: false };
    const request = Object.assign(new EventEmitter(), {
      write(data: string) { wire.bytes += data; return true; },
      destroy() { wire.destroyed = true; return request; },
      end() {
        requests.push(wire);
        const payload = wire.method === 'POST' ? { id: `task-${++nextTask}` }
          : wire.method === 'DELETE' ? { status: 'cancelled' }
            : { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: `ANSWER:${wire.path}` }] }] };
        queueMicrotask(() => {
          if (wire.destroyed) return;
          const response = Object.assign(new EventEmitter(), { statusCode: 200 });
          listener(response);
          response.emit('data', Buffer.from(JSON.stringify(payload)));
          response.emit('end');
        });
        return request;
      },
    });
    return request;
  }) as typeof https.request);
  const gate = deferred(), entered = deferred();
  const instructions = vi.spyOn(provider as any, 'buildAgentInstructionsAsync').mockImplementationOnce(async () => {
    entered.resolve(); if (holdInstructions) await gate.promise; return 'TRUSTED_ROLE';
  }).mockResolvedValue('TRUSTED_ROLE');
  vi.spyOn(provider as any, '_delay').mockResolvedValue(undefined);
  const send = (resolveInput?: ProviderInputResolver, panel = 'panel', content = 'BASELINE_QUESTION', context = [manual]) =>
    (provider.sendMessage as any)(content, context, settings, null, undefined, panel, undefined, undefined, attachments, resolveInput) as AsyncGenerator<StreamChunk>;
  return { provider, requests, instructions, gate, entered, send,
    posts: () => requests.filter(r => r.method === 'POST'),
    body: (index = 0) => JSON.parse(requests.filter(r => r.method === 'POST')[index].bytes) };
}
const enabledInput: ProviderInputResolver = () => ({ content: 'DYNAMIC_QUESTION', context: [manual, automatic] });

describe('dormant Manus input resolution at actual HTTP task creation', () => {
  beforeEach(() => { vi.clearAllMocks(); clearMockConfig(); setMockConfig('manusApiKey', 'fixture-key'); });
  afterEach(() => { for (const provider of providers.splice(0)) provider.dispose(); vi.restoreAllMocks(); clearMockConfig(); });

  it('resolves the tenth argument into the POST bytes without changing canonical input or adding reserved attachments', async () => {
    const h = harness(); const baseline = [manual]; const before = JSON.stringify({ baseline, settings, automatic });
    const chunks = await drain(h.send(enabledInput, 'panel', 'BASELINE_QUESTION', baseline));
    expect(h.body()).toEqual({ model: 'manus-1.6-lite', input: expect.any(String), task_mode: 'agent' });
    expect(h.body().input).toContain('DYNAMIC_QUESTION'); expect(h.body().input).toContain('AUTO_BYTES');
    expect(h.body().input).toContain('MANUAL_BYTES'); expect(h.body().input).toContain('TRUSTED_ROLE');
    expect(h.body().input).toContain('[Planning Mode]'); expect(h.body().input).not.toContain('RESERVED_ATTACHMENT');
    expect(h.body().input).not.toContain('BASELINE_QUESTION'); expect(h.posts()).toHaveLength(1);
    expect(h.requests[0].headers).toMatchObject({ API_KEY: 'fixture-key', 'Content-Length': Buffer.byteLength(h.requests[0].bytes) });
    expect(h.requests[1]).toMatchObject({ method: 'GET', path: '/v1/responses/task-1', bytes: '' });
    expect(chunks.map(c => c.type)).toEqual(['thinking', 'text', 'done']); expect(h.provider.getSessionId('panel')).toBe('task-1');
    expect(JSON.stringify({ baseline, settings, automatic })).toBe(before);
    expect(h.provider.session()).toMatchObject({ abortController: null, currentTaskId: null });
  });

  it('excludes automatic context disabled during instruction preparation and preserves previous response identity', async () => {
    const h = harness(true); h.provider.session().sessionId = 'previous-task'; let enabled = true;
    const pending = drain(h.send(() => ({ content: enabled ? 'WITH_AUTO' : 'MANUAL_QUESTION', context: enabled ? [manual, automatic] : [manual] })));
    try { await h.entered.promise; enabled = false; h.gate.resolve(); await pending; }
    finally { h.gate.resolve(); await pending; }
    expect(h.body()).toMatchObject({ previous_response_id: 'previous-task', model: 'manus-1.6-lite' });
    expect(h.body().input).toContain('MANUAL_QUESTION'); expect(h.body().input).toContain('MANUAL_BYTES');
    expect(h.body().input).not.toContain('WITH_AUTO'); expect(h.body().input).not.toContain('AUTO_BYTES');
  });

  it('does not fall back or create a task when input is revoked during preparation, then recovers on the same panel', async () => {
    const h = harness(true); let current = true;
    const pending = drain(h.send(() => current ? enabledInput() : undefined));
    let chunks: StreamChunk[];
    try { await h.entered.promise; current = false; h.gate.resolve(); chunks = await pending; }
    finally { h.gate.resolve(); await pending; }
    expect(chunks).toEqual([]); expect(h.requests).toEqual([]);
    expect(h.provider.session()).toMatchObject({ abortController: null, currentTaskId: null });
    const healthy = await drain(h.send(enabledInput));
    expect(healthy.map(c => c.type)).toEqual(['thinking', 'text', 'done']); expect(h.posts()).toHaveLength(1);
  });

  it('rejects an already revoked request without cancelling an existing task or preparing input', async () => {
    const h = harness(); const existing = new AbortController();
    Object.assign(h.provider.session(), { abortController: existing, currentTaskId: 'existing-task', sessionId: 'previous-task' });
    const chunks = await drain(h.send(() => undefined));
    expect(chunks).toEqual([]); expect(h.requests).toEqual([]); expect(h.instructions).not.toHaveBeenCalled();
    expect(existing.signal.aborted).toBe(false);
    expect(h.provider.session()).toMatchObject({ abortController: existing, currentTaskId: 'existing-task', sessionId: 'previous-task' });
  });

  it('does not allocate a session or report authentication for an already obsolete input', async () => {
    const h = harness(); clearMockConfig(); vi.stubEnv('MANUS_API_KEY', '');
    try {
      expect(await drain(h.send(() => undefined))).toEqual([]);
      expect(h.provider.hasPanel()).toBe(false); expect(h.requests).toEqual([]);
    } finally { vi.unstubAllEnvs(); }
  });

  for (const action of ['cancel', 'dispose-session', 'dispose-provider'] as const) {
    it(`captures cancellation before preparation so ${action} prevents task creation`, async () => {
      const h = harness(true); const pending = drain(h.send(enabledInput));
      try {
        await h.entered.promise;
        if (action === 'cancel') h.provider.cancelCurrentRequest('panel');
        else if (action === 'dispose-session') h.provider.disposeSession('panel');
        else h.provider.dispose();
        h.gate.resolve(); await pending;
      } finally { h.gate.resolve(); await pending; }
      expect(h.requests).toEqual([]);
      if (action === 'dispose-session') expect(h.provider.hasPanel()).toBe(false);
    });
  }

  it('keeps a successor task owned when older prompt preparation finishes after the successor starts', async () => {
    const h = harness(true); const old = drain(h.send(enabledInput));
    let successor: AsyncGenerator<StreamChunk> | undefined;
    try {
      await h.entered.promise; successor = h.send(() => ({ content: 'SUCCESSOR', context: [manual] }));
      expect((await successor.next()).value?.type).toBe('thinking');
      const owner = h.provider.session().abortController;
      h.gate.resolve(); await old;
      expect(h.posts()).toHaveLength(1); expect(h.body().input).toContain('SUCCESSOR');
      expect(h.provider.session()).toMatchObject({ abortController: owner, currentTaskId: 'task-1' });
      expect(owner?.signal.aborted).toBe(false);
      expect((await drain(successor)).map(c => c.type)).toEqual(['text', 'done']);
      expect(h.provider.getSessionId('panel')).toBe('task-1');
    } finally { h.gate.resolve(); await old; if (successor) await successor.return(undefined); }
  });

  it('cancels only the replaced task, suppresses its paused completion, and leaves a sibling untouched', async () => {
    const h = harness(); const old = h.send(enabledInput); const sibling = h.send(enabledInput, 'sibling');
    try {
      expect((await old.next()).value?.type).toBe('thinking');
      expect((await sibling.next()).value?.type).toBe('thinking');
      const siblingOwner = h.provider.session('sibling').abortController;
      const healthy = await drain(h.send(() => ({ content: 'SUCCESSOR', context: [manual] })));
      expect(h.requests.filter(r => r.method === 'DELETE').map(r => r.path)).toEqual(['/v1/responses/task-1']);
      expect(await drain(old)).toEqual([]);
      expect(healthy.map(c => c.type)).toEqual(['thinking', 'text', 'done']);
      expect(h.provider.session('sibling')).toMatchObject({ abortController: siblingOwner, currentTaskId: 'task-2' });
      expect(siblingOwner?.signal.aborted).toBe(false);
      expect((await drain(sibling)).map(c => c.type)).toEqual(['text', 'done']);
      expect(h.provider.getSessionId('panel')).toBe('task-3'); expect(h.provider.getSessionId('sibling')).toBe('task-2');
      expect(h.requests.filter(r => r.method === 'GET').map(r => r.path)).toEqual(['/v1/responses/task-3', '/v1/responses/task-2']);
    } finally { await old.return(undefined); await sibling.return(undefined); }
  });

  it('retains legacy no-resolver prompt, polling, slash-command and response chaining behavior', async () => {
    const h = harness(); const chunks = await drain(h.send());
    expect(h.body().input).toContain('BASELINE_QUESTION'); expect(h.body().input).toContain('MANUAL_BYTES');
    expect(h.body().input).toContain('TRUSTED_ROLE'); expect(h.body().input).toContain('[Planning Mode]');
    expect(h.body().input).not.toContain('AUTO_BYTES'); expect(chunks.at(-1)).toEqual({ type: 'done' });
    await drain(h.send(undefined, 'panel', ' /compact '));
    expect(h.body(1)).toEqual({ model: 'manus-1.6-lite', input: '/compact', task_mode: 'agent', previous_response_id: 'task-1' });
    expect(h.instructions).toHaveBeenCalledOnce();
  });
});
