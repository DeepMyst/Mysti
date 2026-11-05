import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import { BaseCliProvider } from '../../../src/providers/base/BaseCliProvider';
import { contextFillTokens, normalizeUsage } from '../../../src/services/TokenAccounting';
import { TestableOpenCodeProvider } from '../../helpers/providerFactory';
import { createOpenCodeSession } from '../../helpers/sessionFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import type { OpenCodeSessionState } from '../../../src/providers/opencode/OpenCodeProvider';
import type { Settings, StreamChunk } from '../../../src/types';

class Provider extends TestableOpenCodeProvider {
  session(panel: string): OpenCodeSessionState { return this._getSession(panel) as OpenCodeSessionState; }
  stream(session: OpenCodeSessionState): AsyncGenerator<StreamChunk> { return this.processStream({ output: '' }, session); }
  done(panel: string): StreamChunk { return this._doneChunk(panel); }
}
type StreamReader = (stderr: { output: string }, session: OpenCodeSessionState, drainOnReturn?: boolean) => AsyncGenerator<StreamChunk>;
let provider: Provider;
const settings = { provider: 'opencode', model: 'owned/fixture', mode: 'default', accessLevel: 'full-access', thinkingLevel: 'none' } as Settings;
const finish = (id: string, input = 10, output = 5) => JSON.stringify({ type: 'step_finish', sessionID: 'native-session',
  part: { id, type: 'step-finish', reason: 'stop', tokens: { total: input + output, input, output, reasoning: 0, cache: { read: 0, write: 0 } } } });
// Shapes captured from installed OpenCode 1.18.29, with fixture paths/IDs shortened.
const tool = (status = 'completed', type = 'tool_use') => JSON.stringify({ type, sessionID: 'native-session',
  part: { id: 'part-tool', type: 'tool', tool: 'bash', callID: 'call-owned', state: { status,
    input: { command: 'owned-command', description: 'Owned canary' },
    ...(status === 'error' ? { error: 'The user rejected permission to use this specific tool call.' } : { output: '(no output)', metadata: { exit: 0 } }) } } });

beforeEach(() => { clearMockConfig(); provider = new Provider(); });
afterEach(() => { provider.dispose(); clearMockConfig(); vi.restoreAllMocks(); });
describe('installed OpenCode CLI event shapes', () => {
  it('shows a terminal tool_use as a completed named tool with input and output', () => {
    const session = createOpenCodeSession();
    expect(provider.parseStreamLine(tool(), session)).toMatchObject({ type: 'tool_result', content: '(no output)',
      toolCall: { id: 'call-owned', name: 'Bash', input: { command: 'owned-command' }, output: '(no output)', status: 'completed' } });
    expect(session.activeToolCalls.size).toBe(0);
  });
  it('keeps a native tool rejection as a failed result', () => {
    expect(provider.parseStreamLine(tool('error'), createOpenCodeSession())).toMatchObject({ type: 'tool_result',
      toolCall: { id: 'call-owned', name: 'Bash', status: 'failed', output: 'The user rejected permission to use this specific tool call.' } });
  });
  it('deduplicates terminal snapshots and does not reopen a completed card', () => {
    const session = createOpenCodeSession();
    expect(provider.parseStreamLine(tool(), session)?.type).toBe('tool_result');
    expect(provider.parseStreamLine(tool('completed', 'message.part.updated'), session)).toBeNull();
    expect(provider.parseStreamLine(tool('running', 'message.part.updated'), session)).toBeNull();
    expect(session.activeToolCalls.size).toBe(0);
  });
  it('retains native running input before a terminal part update', () => {
    const session = createOpenCodeSession();
    expect(provider.parseStreamLine(tool('running', 'message.part.updated'), session)).toMatchObject({ type: 'tool_use',
      toolCall: { id: 'call-owned', name: 'Bash', status: 'running', input: { command: 'owned-command' } } });
    expect(provider.parseStreamLine(tool('completed', 'message.part.updated'), session)?.toolCall?.status).toBe('completed');
  });
  it('shows a top-level native reasoning event', () => {
    expect(provider.parseStreamLine(JSON.stringify({ type: 'reasoning', sessionID: 'native-session',
      part: { id: 'part-reasoning', type: 'reasoning', text: 'Owned reasoning marker.' } }), createOpenCodeSession()))
      .toEqual({ type: 'thinking', content: 'Owned reasoning marker.' });
  });
  it('sums distinct native steps and ignores a repeated terminal receipt', () => {
    const session = provider.session('a');
    provider.parseStreamLine(finish('step-one'), session);
    provider.parseStreamLine(finish('step-two'), session);
    provider.parseStreamLine(finish('step-two'), session);
    expect(provider.getStoredUsage('a')).toEqual({ input_tokens: 20, output_tokens: 10 });
    expect(provider.getStoredUsage('a')).toBeNull();
  });
  it('starts a resumed request without partial usage or tool state from its predecessor', () => {
    const session = provider.session('a');
    provider.parseStreamLine(finish('old-step', 100, 50), session);
    provider.parseStreamLine(tool('running', 'message.part.updated'), session);
    const args = provider.buildCliArgs(settings, session);
    expect(args).toContain('--session');
    expect(session.activeToolCalls.size).toBe(0);
    expect(provider.getStoredUsage('a')).toBeNull();
    provider.parseStreamLine(finish('new-step'), session);
    expect(provider.getStoredUsage('a')).toEqual({ input_tokens: 10, output_tokens: 5 });
  });
  it('isolates per-panel usage and clears all pending accounting on reset', () => {
    provider.parseStreamLine(finish('a', 10, 5), provider.session('a'));
    provider.parseStreamLine(finish('b', 30, 7), provider.session('b'));
    expect(provider.getStoredUsage('a')).toEqual({ input_tokens: 10, output_tokens: 5 });
    provider.clearSession();
    expect(provider.getStoredUsage('b')).toBeNull();
  });
  it('counts steps without IDs without replacing preceding usage', () => {
    const session = provider.session('a');
    provider.parseStreamLine(JSON.stringify({ type: 'step_finish', part: { tokens: { input: 8, output: 2 } } }), session);
    provider.parseStreamLine(JSON.stringify({ type: 'step_finish', part: { tokens: { input: 9, output: 3 } } }), session);
    expect(provider.getStoredUsage('a')).toEqual({ input_tokens: 17, output_tokens: 5 });
  });
  it('separates cumulative usage from the latest model call used for context fill', () => {
    const session = provider.session('a');
    provider.parseStreamLine(finish('first'), session);
    provider.parseStreamLine(finish('last', 18, 7), session);
    expect(provider.done('a')).toMatchObject({ type: 'done', usage: { input_tokens: 28, output_tokens: 12 },
      contextUsage: { input_tokens: 18, output_tokens: 7 } });
  });
  it('keeps latest context unknown when a new native step has no usage receipt', () => {
    const session = provider.session('a');
    provider.parseStreamLine(finish('first'), session);
    provider.parseStreamLine(JSON.stringify({ type: 'step_start', sessionID: 'native-session', part: { id: 'next' } }), session);
    expect(provider.done('a')).toMatchObject({ usage: { input_tokens: 10, output_tokens: 5 }, contextUsage: null });
  });
  it('preserves disjoint cache buckets emitted by OpenCode even for an OpenAI-compatible backend', () => {
    const session = provider.session('a');
    const receipt = (id: string) => JSON.stringify({ type: 'step_finish', part: { id,
      tokens: { input: 8, output: 5, cache: { read: 2, write: 0 } } } });
    provider.parseStreamLine(receipt('first'), session); provider.parseStreamLine(receipt('last'), session);
    const done = provider.done('a');
    expect(done.usage).toEqual({ input_tokens: 16, output_tokens: 10, cache_read_input_tokens: 4 });
    expect(done.contextUsage).toEqual({ input_tokens: 8, output_tokens: 5, cache_read_input_tokens: 2 });
    expect(provider.capabilities.usageConvention).toBe('anthropic');
    expect(contextFillTokens(normalizeUsage(done.contextUsage!, provider.capabilities.usageConvention!))).toBe(10);
  });
  it('keeps remote usage unavailable until that transport reports it', () => {
    setMockConfig('opencodeEndpoint', 'http://localhost:4096');
    expect(provider.capabilities.emitsUsage).toBe(false);
    expect(provider.capabilities.usageConvention).toBe('none');
  });
  it('announces a terminal-only tool before resolving it so the host can persist and render its card', async () => {
    const session = provider.session('a');
    session.process = { exitCode: 0, signalCode: null } as ChildProcess;
    vi.spyOn(BaseCliProvider.prototype as unknown as { processStream: StreamReader }, 'processStream')
      .mockImplementation(async function* (_stderr, reader) {
        yield provider.parseStreamLine(tool(), reader)!;
      });
    const chunks: StreamChunk[] = []; for await (const chunk of provider.stream(session)) { chunks.push(chunk); }
    expect(chunks.map(c => c.type)).toEqual(['tool_use', 'tool_result']);
    expect(chunks[0].toolCall).toMatchObject({ id: 'call-owned', name: 'Bash', status: 'completed', output: '(no output)' });
    expect(chunks[1].toolCall).toMatchObject({ id: 'call-owned', status: 'completed' });
  });
  it('does not leak a superseded reader\'s usage into the replacement turn', async () => {
    const session = provider.session('a');
    session.process = { exitCode: 0, signalCode: null } as ChildProcess;
    vi.spyOn(BaseCliProvider.prototype as unknown as { processStream: StreamReader }, 'processStream')
      .mockImplementation(async function* (_stderr, reader) {
        yield { type: 'text', content: 'first' };
        provider.parseStreamLine(finish('late-old', 1000, 1000), reader);
        yield { type: 'text', content: 'late old output' };
      });
    const stream = provider.stream(session); expect((await stream.next()).value).toEqual({ type: 'text', content: 'first' });
    session.process = { exitCode: 0, signalCode: null } as ChildProcess;
    provider.buildCliArgs(settings, session);
    provider.parseStreamLine(finish('replacement', 30, 7), session);
    expect((await stream.next()).done).toBe(true);
    expect(provider.getStoredUsage('a')).toEqual({ input_tokens: 30, output_tokens: 7 });
  });
  it('stops between a terminal tool announcement and its result', async () => {
    const session = provider.session('a');
    session.process = { exitCode: 0, signalCode: null } as ChildProcess;
    let readerClosed = false;
    vi.spyOn(BaseCliProvider.prototype as unknown as { processStream: StreamReader }, 'processStream')
      .mockImplementation(async function* (_stderr, reader) {
        try { yield provider.parseStreamLine(tool(), reader)!; }
        finally { readerClosed = true; }
      });
    const stream = provider.stream(session); expect((await stream.next()).value.type).toBe('tool_use');
    session.cancelled = true;
    expect((await stream.next()).done).toBe(true); expect(readerClosed).toBe(true);
    expect(session.completedToolCalls.size).toBe(0);
  });
});
