/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestableCodexProvider } from '../../helpers/providerFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import { ProviderManager } from '../../../src/managers/ProviderManager';
import { killProcessTree } from '../../../src/utils/processKill';
import type { Settings, StreamChunk } from '../../../src/types';
import type { PanelSessionState } from '../../../src/providers/base/BaseCliProvider';

vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof import('child_process')>(), spawn: vi.fn(),
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

function fakeProcess(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid: 4001, exitCode: null, signalCode: null,
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: { write: vi.fn(), end: vi.fn() },
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
}

function harness() {
  const provider = new TestableCodexProvider();
  vi.spyOn(provider, 'getCliPath').mockReturnValue('/mock/codex');
  vi.spyOn(provider, 'buildCliArgs').mockReturnValue([]);
  const cleanup = vi.fn(async () => undefined);
  const prepare = vi.spyOn(provider as any, 'prepareAttachments').mockResolvedValue(cleanup);
  const prompt = vi.spyOn(provider as any, 'buildPromptAsync').mockResolvedValue('current prompt');
  const deliver = vi.spyOn(provider as any, '_deliverPrompt').mockResolvedValue(undefined);
  vi.spyOn(provider as any, 'processStream').mockImplementation(async function* () {
    yield { type: 'text', content: 'answer' };
  });
  const state = {
    _activePanelProcesses: new Map<string, ChildProcess>(),
    _panelProviders: new Map<string, string>(),
  };
  const tracker = {
    registerProcess: vi.fn((panelId: string, proc: ChildProcess) => { state._activePanelProcesses.set(panelId, proc); }),
    clearProcess: vi.fn((panelId: string, proc?: ChildProcess) => {
      ProviderManager.prototype.clearProcess.call(state as unknown as ProviderManager, panelId, proc);
    }),
  };
  const send = () => provider.sendMessage('hello', [], {} as Settings, null, undefined, 'panel', tracker);
  const session = (): PanelSessionState => (provider as any)._getSession('panel');
  return { provider, cleanup, prepare, prompt, deliver, tracker, state, send, session };
}

async function collect(gen: AsyncGenerator<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) { chunks.push(chunk); }
  return chunks;
}

describe('single-shot process ownership', () => {
  beforeEach(() => { clearMockConfig(); vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('cancelled prompt preparation cannot write to or clean up its replacement', async () => {
    const { provider, prompt, deliver, cleanup, state, send, session } = harness();
    const old = fakeProcess();
    const replacement = fakeProcess();
    vi.mocked(spawn).mockReturnValueOnce(old).mockReturnValueOnce(replacement);
    const building = deferred<void>();
    const built = deferred<string>();
    prompt.mockImplementationOnce(() => { building.resolve(); return built.promise; });
    const oldCompletion = collect(send());
    await building.promise;
    provider.cancelCurrentRequest('panel');
    const replacementGen = send();
    expect((await replacementGen.next()).value).toMatchObject({ type: 'text' });
    vi.mocked(killProcessTree).mockClear();
    built.resolve('obsolete prompt');
    await oldCompletion;
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(replacement, 'current prompt', session());
    expect(session().process).toBe(replacement);
    expect(state._activePanelProcesses.get('panel')).toBe(replacement);
    expect(vi.mocked(killProcessTree).mock.calls.some(call => call[0] === replacement)).toBe(false);
    expect(old.stderr?.listenerCount('data')).toBe(0);
    expect(cleanup).toHaveBeenCalledOnce();
    await replacementGen.return(undefined);
  });

  it('late cleanup cannot clear a process registered by another provider', async () => {
    const { state, send } = harness();
    const old = fakeProcess();
    const replacement = fakeProcess();
    vi.mocked(spawn).mockReturnValue(old);
    const gen = send();
    await gen.next();
    state._activePanelProcesses.set('panel', replacement);
    state._panelProviders.set('panel', 'gemini');
    await gen.return(undefined);
    expect(state._activePanelProcesses.get('panel')).toBe(replacement);
    expect(state._panelProviders.get('panel')).toBe('gemini');
  });

  it('Stop during attachment preparation does not spawn a process', async () => {
    const { provider, prepare, cleanup, send } = harness();
    const preparing = deferred<void>();
    const prepared = deferred<() => Promise<void>>();
    prepare.mockImplementation(() => { preparing.resolve(); return prepared.promise; });
    const completion = collect(send());
    await preparing.promise;
    provider.cancelCurrentRequest('panel');
    prepared.resolve(cleanup);
    await completion;
    expect(spawn).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('a synchronous spawn error still releases prepared attachments', async () => {
    const { cleanup, send, tracker } = harness();
    vi.mocked(spawn).mockImplementation(() => { throw new Error('spawn unavailable'); });
    const chunks = await collect(send());
    expect(chunks).toEqual([{ type: 'error', content: 'spawn unavailable' }]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(tracker.registerProcess).not.toHaveBeenCalled();
    expect(tracker.clearProcess).not.toHaveBeenCalled();
  });

  it('cancelled prompt delivery cannot consume its replacement stream', async () => {
    const { provider, deliver, state, send, session } = harness();
    const old = fakeProcess();
    const replacement = fakeProcess();
    vi.mocked(spawn).mockReturnValueOnce(old).mockReturnValueOnce(replacement);
    const delivering = deferred<void>();
    const delivered = deferred<void>();
    deliver.mockImplementationOnce(() => { delivering.resolve(); return delivered.promise; });
    const oldCompletion = collect(send());
    await delivering.promise;
    provider.cancelCurrentRequest('panel');
    const replacementGen = send();
    expect((await replacementGen.next()).value).toMatchObject({ type: 'text' });
    delivered.resolve();
    expect(await oldCompletion).toEqual([]);
    expect((provider as any).processStream).toHaveBeenCalledOnce();
    expect(session().process).toBe(replacement);
    expect(state._activePanelProcesses.get('panel')).toBe(replacement);
    await replacementGen.return(undefined);
  });

  it('an already exited process still releases its stderr listener', async () => {
    const { send, cleanup, state } = harness();
    const proc = fakeProcess();
    vi.mocked(spawn).mockReturnValue(proc);
    const gen = send();
    await gen.next();
    Object.defineProperty(proc, 'exitCode', { value: 0 });
    await gen.return(undefined);
    expect(proc.stderr?.listenerCount('data')).toBe(0);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(state._activePanelProcesses.has('panel')).toBe(false);
  });

  it('delivers the prompt and closes the issuing process stdin', async () => {
    const { deliver, send } = harness();
    const proc = fakeProcess();
    vi.mocked(spawn).mockReturnValue(proc);
    deliver.mockRestore();
    await collect(send());
    expect(proc.stdin?.write).toHaveBeenCalledWith('current prompt');
    expect(proc.stdin?.end).toHaveBeenCalledOnce();
  });
});
