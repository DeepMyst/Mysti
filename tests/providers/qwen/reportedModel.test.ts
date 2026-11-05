import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { TestableQwenProvider } from '../../helpers/providerFactory';
import { createQwenSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';

const providers: TestableQwenProvider[] = [];
function provider() { const p = new TestableQwenProvider(); providers.push(p); return p; }
afterEach(() => { providers.splice(0).forEach(p => p.dispose()); vi.restoreAllMocks(); clearMockConfig(); });
const init = (model: unknown, session = 'qwen-owned') => ({ type: 'system', subtype: 'init', session_id: session, model });
const fallback = (model: unknown) => ({ type: 'system', subtype: 'model_fallback', parent_tool_use_id: null,
  data: { fromModel: 'qwen3-coder', toModel: model, statusCode: 429, fallbackIndex: 1 } });

describe('Qwen reported model', () => {
  it('reports every root init, including a resumed session, without losing session activation', () => {
    const p = provider(), session = createQwenSession();
    expect(p.parseStreamLine(JSON.stringify(init('coder-model')), session)).toEqual({
      type: 'session_active', sessionId: 'qwen-owned', reportedModel: 'coder-model',
    });
    expect(p.parseStreamLine(JSON.stringify(init('qwen3-coder-next')), session)).toEqual({
      type: 'model_info', reportedModel: 'qwen3-coder-next',
    });
    expect(session.sessionId).toBe('qwen-owned');
  });

  it('reports the exact nested fallback target and updates context accounting', () => {
    const p = provider(), session = createQwenSession();
    (p as any)._panelSessions.set(session.panelId, session);
    p.parseStreamLine(JSON.stringify(init('qwen3-coder')), session);
    expect(p.parseStreamLine(JSON.stringify(fallback('coder-model')), session)).toEqual({
      type: 'model_info', reportedModel: 'coder-model',
    });
    expect((p as any).takeReportedContextWindow(session.panelId)).toBe(1000000);
  });

  it('rejects malformed and subagent model reports without changing a root report', () => {
    const p = provider(), session = createQwenSession();
    p.parseStreamLine(JSON.stringify(init('coder-model')), session);
    for (const value of ['', 'bad\nmodel', '<img>', 'x'.repeat(129), 7, null, {}]) {
      expect(p.parseStreamLine(JSON.stringify(fallback(value)), session)).toBeNull();
    }
    for (const field of ['parent_tool_use_id', 'agent_id', 'agentId']) {
      expect(p.parseStreamLine(JSON.stringify({ ...fallback('other-model'), [field]: 'child' }), session)).toBeNull();
      expect(p.parseStreamLine(JSON.stringify({ ...init('other-model'), [field]: 'child' }), session)).toBeNull();
    }
    expect(session.reportedModel).toBe('coder-model');
  });

  it('keeps independent panels reports and requested argv separate', () => {
    const p = provider(), a = createQwenSession('a'), b = createQwenSession('b');
    p.parseStreamLine(JSON.stringify(init('coder-model', 'a-session')), a);
    p.parseStreamLine(JSON.stringify(init('qwen3-coder-next', 'b-session')), b);
    expect(a.reportedModel).toBe('coder-model'); expect(b.reportedModel).toBe('qwen3-coder-next');
    const settings: Settings = { provider: 'qwen-code', model: 'qwen3-coder', mode: 'edit-automatically',
      accessLevel: 'full-access', thinkingLevel: 'none', contextMode: 'manual' };
    expect(p.buildCliArgs(settings, a)).toEqual(expect.arrayContaining(['--resume', 'a-session', '--model', 'qwen3-coder']));
    expect(settings.model).toBe('qwen3-coder');
  });

  it('keeps each actual stream parser model local across overlap and a later turn without init', async () => {
    const p = provider(), session = createQwenSession();
    (p as any)._panelSessions.set(session.panelId, session);
    // Real Base stream decoding, with finite in-memory child output. No fake
    // timer or parser replacement: only the already-exited process handle is synthetic.
    const child = () => ({ stdout: new PassThrough(), exitCode: 0, signalCode: null });
    const a = child(), b = child(), c = child();
    const streams: AsyncGenerator<StreamChunk>[] = [];
    try {
      session.process = a as any;
      const first = (p as any).processStream({ output: '' }, session) as AsyncGenerator<StreamChunk>; streams.push(first);
      a.stdout.write(JSON.stringify(init('qwen3-coder')) + '\n'); await first.next();
      session.process = b as any;
      const second = (p as any).processStream({ output: '' }, session) as AsyncGenerator<StreamChunk>; streams.push(second);
      b.stdout.write(JSON.stringify(init('coder-model')) + '\n'); await second.next();
      a.stdout.write(JSON.stringify(fallback('qwen3-coder-next')) + '\n');
      expect((await first.next()).value).toMatchObject({ reportedModel: 'qwen3-coder-next' });
      await first.return(undefined);
      b.stdout.end(); expect((await second.next()).done).toBe(true);
      expect((p as any).takeReportedContextWindow(session.panelId)).toBe(1000000);
      session.process = c as any;
      const third = (p as any).processStream({ output: '' }, session) as AsyncGenerator<StreamChunk>; streams.push(third);
      c.stdout.end(JSON.stringify({ type: 'result', result: 'No model report.' }) + '\n');
      expect((await third.next()).value).toMatchObject({ type: 'text' });
      expect((await third.next()).done).toBe(true);
      expect((p as any).takeReportedContextWindow(session.panelId)).toBeUndefined();
    } finally {
      a.stdout.destroy(); b.stdout.destroy(); c.stdout.destroy();
      for (const stream of streams) await stream.return(undefined);
      session.process = null;
    }
  });

  it('carries structured model metadata through a successful owned child without leaking stderr', async () => {
    const p = provider();
    const events = [init('coder-model'), { type: 'stream_event', event: { type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: 'Owned response.' } } }, { type: 'result', is_error: false, session_id: 'qwen-owned' }];
    const source = `const timer=setTimeout(()=>process.exit(92),5000);process.stdin.resume();process.stdin.on('end',()=>{
      process.stderr.write('Warning: unsupported requested model; PRIVATE_STDERR_MUST_NOT_RENDER\\n');
      for(const e of ${JSON.stringify(events)})process.stdout.write(JSON.stringify(e)+'\\n');clearTimeout(timer);});`;
    vi.spyOn(p, 'getCliPath').mockReturnValue(process.execPath);
    vi.spyOn(p as any, '_getWorkingDirectory').mockReturnValue(process.cwd());
    vi.spyOn(p, 'buildCliArgs').mockReturnValue(['-e', source]);
    vi.spyOn(p as any, 'buildPromptAsync').mockResolvedValue('Owned fixture only.');
    let child: ChildProcess | undefined, closed: Promise<void> | undefined;
    let exit: unknown, close: unknown;
    const tracker = { registerProcess: (_id: string, proc: ChildProcess) => {
      child = proc; proc.once('exit', (code, signal) => { exit = { code, signal }; });
      closed = new Promise<void>(resolve => proc.once('close', (code, signal) => { close = { code, signal }; resolve(); }));
    }, clearProcess: () => {} };
    const settings: Settings = { provider: 'qwen-code', model: 'qwen3-coder', mode: 'edit-automatically',
      accessLevel: 'full-access', thinkingLevel: 'none', contextMode: 'manual' };
    const chunks: StreamChunk[] = [];
    try {
      for await (const chunk of p.sendMessage('Owned fixture only.', [], settings, null, undefined, 'owned-model', tracker)) chunks.push(chunk);
      await closed;
      expect(exit).toEqual({ code: 0, signal: null }); expect(close).toEqual(exit);
      expect(chunks.filter(c => c.type === 'text').map(c => c.content)).toEqual(['Owned response.']);
      expect(chunks.filter(c => c.type === 'error' || c.type === 'auth_error')).toEqual([]);
      expect(chunks.find(c => c.type === 'session_active')).toMatchObject({ reportedModel: 'coder-model' });
      expect(JSON.stringify(chunks)).not.toContain('PRIVATE_STDERR');
      expect(settings.model).toBe('qwen3-coder');
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  });
});
