/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestableClaudeProvider } from '../../helpers/providerFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';
import type { PanelSessionState } from '../../../src/providers/base/BaseCliProvider';
import { killProcessTree } from '../../../src/utils/processKill';

vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof import('child_process')>(),
  spawn: vi.fn(),
}));
vi.mock('../../../src/utils/processKill', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/utils/processKill')>(),
  killProcessTree: vi.fn(async () => undefined),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function fakeProcess() {
  const written = deferred<void>();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const write = vi.fn(() => { written.resolve(); return true; });
  const proc = Object.assign(new EventEmitter(), {
    pid: 4001,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdout, stderr,
    stdin: { writable: true, write },
    kill: vi.fn(() => true),
  });
  return { proc: proc as unknown as ChildProcess, stdout, stderr, write, written };
}

function harness() {
  const provider = new TestableClaudeProvider();
  vi.spyOn(provider, 'getCliPath').mockReturnValue('/mock/claude');
  const cleanup = vi.fn(async () => undefined);
  vi.spyOn(provider as any, 'prepareAttachments').mockResolvedValue(cleanup);
  const prompt = vi.spyOn(provider as any, 'buildPromptAsync').mockResolvedValue('test prompt');
  const fallback = vi.spyOn(provider as any, '_sendSingleShot').mockImplementation(async function* () {
    yield { type: 'text', content: 'single-shot fallback' };
  });
  const send = (panelId = 'panel') => provider.sendMessage('hello', [], {} as Settings, null, undefined, panelId);
  const session = (panelId = 'panel'): PanelSessionState => (provider as any)._getSession(panelId);
  return { provider, cleanup, prompt, fallback, send, session };
}

const TEXT = JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } },
}) + '\n';
const BOUNDARY = JSON.stringify({ type: 'result', result: '' }) + '\n';

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) { chunks.push(chunk); }
  return chunks;
}

describe('persistent process ownership and turn cleanup', () => {
  beforeEach(() => { clearMockConfig(); vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it.each(['exit', 'error'] as const)('an old process %s cannot evict or contaminate its replacement', async event => {
    const { provider, session } = harness();
    const old = fakeProcess();
    const replacement = fakeProcess();
    vi.mocked(spawn).mockReturnValueOnce(old.proc).mockReturnValueOnce(replacement.proc);
    await provider.preSpawnPersistentProcess('panel', {} as Settings);
    provider.disposePersistentProcess('panel');
    await provider.preSpawnPersistentProcess('panel', {} as Settings);
    replacement.stderr.emit('data', Buffer.from('replacement diagnostic'));
    old.stderr.emit('data', Buffer.from('old diagnostic'));
    old.proc.emit(event, event === 'error' ? new Error('late error') : 0);
    expect(session().persistentProcess).toBe(replacement.proc);
    expect(session().persistentReady).toBe(true);
    expect(session()._persistentStderr).toBe('replacement diagnostic');
    provider.dispose();
  });

  it.each([false, true])('consumer return releases attachments and stops an incomplete turn (suspended=%s)', async suspended => {
    const { cleanup, send, session } = harness();
    const child = fakeProcess();
    vi.mocked(spawn).mockReturnValue(child.proc);
    const gen = send();
    const next = gen.next();
    await child.written.promise;
    child.stdout.emit('data', Buffer.from(TEXT));
    expect((await next).value).toMatchObject({ type: 'text' });
    session().suspended = suspended;
    await gen.return(undefined);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(killProcessTree).toHaveBeenCalledWith(child.proc, expect.any(Number), expect.any(Object));
    expect(session().persistentProcess).toBeNull();
    expect(session().process).toBeNull();
    expect(session().suspended).toBe(false);
    if (suspended) {
      expect(killProcessTree).toHaveBeenCalledWith(child.proc, expect.any(Number), expect.objectContaining({ initialSignal: 'SIGKILL' }));
    }
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.proc.listenerCount('close')).toBe(0);
  });

  it('a completed response retains its process and cleans attachments', async () => {
    const { cleanup, fallback, send, session } = harness();
    const child = fakeProcess();
    vi.mocked(spawn).mockReturnValue(child.proc);
    const completion = collect(send());
    await child.written.promise;
    child.stdout.emit('data', Buffer.from(TEXT + BOUNDARY));
    expect(await completion).toEqual([{ type: 'text', content: 'answer' }, { type: 'done' }]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(killProcessTree).not.toHaveBeenCalled();
    expect(session().persistentProcess).toBe(child.proc);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('Stop settles a silent read immediately and leaves another panel running', async () => {
    vi.useFakeTimers();
    const { provider, cleanup, send, session } = harness();
    const cancelled = fakeProcess();
    const other = fakeProcess();
    vi.mocked(spawn).mockReturnValueOnce(cancelled.proc).mockReturnValueOnce(other.proc);
    const cancelledCompletion = collect(send());
    await cancelled.written.promise;
    const otherGen = send('other');
    const otherNext = otherGen.next();
    await other.written.promise;
    provider.cancelCurrentRequest('panel');
    const settled = vi.fn();
    void cancelledCompletion.then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledWith([{ type: 'done' }]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(session('other').process).toBe(other.proc);
    other.stdout.emit('data', Buffer.from(BOUNDARY));
    await otherNext;
    await otherGen.return(undefined);
  });

  it('a cancelled prompt build cannot submit or fall back after a new turn starts', async () => {
    const { provider, cleanup, prompt, fallback, send, session } = harness();
    const old = fakeProcess();
    const replacement = fakeProcess();
    vi.mocked(spawn).mockReturnValueOnce(old.proc).mockReturnValueOnce(replacement.proc);
    const building = deferred<void>();
    const built = deferred<string>();
    prompt.mockImplementationOnce(() => { building.resolve(); return built.promise; });
    const oldCompletion = collect(send());
    await building.promise;
    provider.cancelCurrentRequest('panel');
    const replacementGen = send();
    const replacementNext = replacementGen.next();
    await replacement.written.promise;
    built.resolve('obsolete prompt');
    expect(await oldCompletion).toEqual([{ type: 'done' }]);
    expect(old.write).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    expect(session().persistentProcess).toBe(replacement.proc);
    expect(cleanup).toHaveBeenCalledOnce();
    replacement.stdout.emit('data', Buffer.from(BOUNDARY));
    await replacementNext;
    await replacementGen.return(undefined);
  });

  it('a prompt build failure releases attachments before a safe fallback', async () => {
    const { cleanup, prompt, fallback, send, session } = harness();
    const child = fakeProcess();
    vi.mocked(spawn).mockReturnValue(child.proc);
    prompt.mockRejectedValueOnce(new Error('context unavailable'));
    await collect(send());
    expect(cleanup).toHaveBeenCalledOnce();
    expect(child.write).not.toHaveBeenCalled();
    expect(session().persistentProcess).toBeNull();
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('a process error after submitting is surfaced without a replay', async () => {
    const { cleanup, fallback, send, session } = harness();
    const child = fakeProcess();
    vi.mocked(spawn).mockReturnValue(child.proc);
    const completion = collect(send());
    await child.written.promise;
    child.proc.emit('error', new Error('transport failed'));
    expect(await completion).toEqual([{ type: 'error', content: 'transport failed' }, { type: 'done' }]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(session().persistentProcess).toBeNull();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('a synchronous input write error is terminal because delivery is uncertain', async () => {
    const { cleanup, fallback, send } = harness();
    const child = fakeProcess();
    child.write.mockImplementation(() => { throw new Error('broken pipe'); });
    vi.mocked(spawn).mockReturnValue(child.proc);
    expect(await collect(send())).toEqual([{ type: 'error', content: 'broken pipe' }, { type: 'done' }]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('disposing a provider during attachment preparation cannot restart it', async () => {
    const { provider, cleanup, prompt, fallback, send } = harness();
    const child = fakeProcess();
    vi.mocked(spawn).mockReturnValue(child.proc);
    const preparing = deferred<void>();
    const prepared = deferred<() => Promise<void>>();
    vi.mocked((provider as any).prepareAttachments).mockImplementationOnce(() => {
      preparing.resolve();
      return prepared.promise;
    });
    const completion = collect(send());
    await preparing.promise;
    provider.dispose();
    prepared.resolve(cleanup);
    expect(await completion).toEqual([{ type: 'done' }]);
    expect(prompt).not.toHaveBeenCalled();
    expect(child.write).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('a response boundary with no parsed chunks is terminal and cannot replay the prompt', async () => {
    const { provider, fallback, send } = harness();
    const child = fakeProcess();
    vi.mocked(spawn).mockReturnValue(child.proc);
    vi.spyOn(provider, 'parseStreamLine').mockReturnValue(null);
    const completion = collect(send());
    await child.written.promise;
    child.stdout.emit('data', Buffer.from(BOUNDARY));
    expect(await completion).toEqual([{ type: 'done' }]);
    expect(fallback).not.toHaveBeenCalled();
  });
});
