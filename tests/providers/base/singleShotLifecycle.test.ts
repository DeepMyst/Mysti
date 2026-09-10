/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliLifecycleProvider } from '../../helpers/cliLifecycleProvider';
import { clearMockConfig } from '../../helpers/mockVscode';
import { ProviderManager } from '../../../src/managers/ProviderManager';
import { killProcessTree } from '../../../src/utils/processKill';
import type { Attachment, Settings, StreamChunk } from '../../../src/types';
import type { PanelSessionState } from '../../../src/providers/base/BaseCliProvider';
import { PROCESS_TIMEOUT_MS, STREAM_INACTIVITY_TIMEOUT_MS } from '../../../src/constants';

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
    stdin: Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() }),
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
}

function harness() {
  const provider = new CliLifecycleProvider();
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
  const send = (attachments?: Attachment[], panelId = 'panel') => provider.sendMessage(
    'hello', [], {} as Settings, null, undefined, panelId, tracker, undefined, attachments,
  );
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
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

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
    expect(vi.mocked(spawn).mock.calls.length).toBe(0);
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

  it('Stop settles a silent stdout read without waiting for process close', async () => {
    vi.useFakeTimers();
    const { provider, cleanup, send } = harness();
    vi.mocked((provider as any).processStream).mockRestore();
    const child = fakeProcess();
    const reading = deferred<void>();
    const returned = vi.fn(async () => ({ done: true, value: undefined }));
    Object.assign(child.stdout!, {
      [Symbol.asyncIterator]: () => ({
        next: () => { reading.resolve(); return new Promise(() => {}); },
        return: returned,
      }),
    });
    vi.mocked(spawn).mockReturnValue(child);
    const stream = send();
    const completion = collect(stream);
    await reading.promise;
    // return() queues behind the pending read; cancellation is the operation
    // that wakes it, as required by the provider iterator contract.
    const returning = stream.return(undefined);
    provider.cancelCurrentRequest('panel');
    const settled = vi.fn();
    void completion.then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledWith([]);
    expect(returned).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect((await returning).done).toBe(true);
  });

  it('concurrent sends own attachment records and never mutate caller-owned paths', async () => {
    const { prepare, prompt, send } = harness();
    const attachment: Attachment = {
      id: 'shared', type: 'image', fileName: 'image.png', mimeType: 'image/png', size: 3, base64Data: 'YWJj',
    };
    const prepared: Attachment[] = [];
    const promptPaths: string[] = [];
    prepare.mockImplementation(async (attachments: Attachment[]) => {
      const record = attachments[0];
      prepared.push(record);
      record.filePath = `/temporary/request-${prepared.length}`;
      return async () => { record.filePath = undefined; };
    });
    prompt.mockImplementation(async (...args: unknown[]) => {
      promptPaths.push((args[6] as Attachment[])[0].filePath!);
      return 'prompt';
    });
    vi.mocked(spawn).mockReturnValueOnce(fakeProcess()).mockReturnValueOnce(fakeProcess());
    const first = send([attachment], 'first');
    const second = send([attachment], 'second');
    await Promise.all([first.next(), second.next()]);
    expect(prepared[0]).not.toBe(prepared[1]);
    expect(prepared).not.toContain(attachment);
    expect(promptPaths.sort()).toEqual(['/temporary/request-1', '/temporary/request-2']);
    expect(attachment.filePath).toBeUndefined();
    await first.return(undefined);
    expect(prepared[1].filePath).toBe('/temporary/request-2');
    await second.return(undefined);
    expect(attachment.filePath).toBeUndefined();
  });

  it('stderr activity extends the deadline without discarding the pending stdout read', async () => {
    vi.useFakeTimers();
    const { provider, session } = harness();
    vi.mocked((provider as any).processStream).mockRestore();
    const child = fakeProcess();
    const output = deferred<{ done: boolean; value: Buffer }>();
    const next = vi.fn(() => output.promise);
    Object.assign(child.stdout!, {
      [Symbol.asyncIterator]: () => ({ next, return: async () => ({ done: true, value: undefined }) }),
    });
    session().process = child;
    const stderr = { output: '' };
    const gen = (provider as any).processStream(stderr, session());
    const first = gen.next();
    stderr.output = 'tool progress';
    await vi.advanceTimersByTimeAsync(STREAM_INACTIVITY_TIMEOUT_MS);
    expect(next).toHaveBeenCalledOnce();
    output.resolve({ done: false, value: Buffer.from('{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}\n') });
    expect((await first).value).toMatchObject({ type: 'text', content: 'answer' });
    await gen.return(undefined);
  });

  it('a process-exit deadline only kills its captured process and releases listeners', async () => {
    vi.useFakeTimers();
    const { provider, session } = harness();
    const old = fakeProcess();
    const replacement = fakeProcess();
    session().process = old;
    const waiting = (provider as any).waitForProcess(session());
    const rejected = expect(waiting).rejects.toThrow('Process timeout');
    session().process = replacement;
    await vi.advanceTimersByTimeAsync(PROCESS_TIMEOUT_MS);
    await rejected;
    expect(vi.mocked(killProcessTree).mock.calls.map(call => call[0])).toEqual([old]);
    expect(old.listenerCount('close')).toBe(0);
    expect(old.listenerCount('error')).toBe(0);
    expect(session().process).toBe(replacement);
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

  it('attachment cleanup releases only its own native host turn scope', async () => {
    const { provider, prepare, cleanup, state, send } = harness();
    const signals: AbortSignal[] = [];
    provider.setNativeApprovalHost({ handlerForPanel: (_panelId, signal) => {
      signals.push(signal!);
      return async () => false;
    } });
    const cleaning = deferred<void>();
    const cleaned = deferred<void>();
    prepare.mockResolvedValueOnce(async () => { cleaning.resolve(); await cleaned.promise; });
    const old = fakeProcess();
    const replacement = fakeProcess();
    vi.mocked(spawn).mockReturnValueOnce(old).mockReturnValueOnce(replacement);
    const oldCompletion = collect(send());
    await cleaning.promise;

    const current = send();
    expect((await current.next()).value).toMatchObject({ type: 'text' });
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    cleaned.resolve();
    await oldCompletion;
    expect(signals[1].aborted).toBe(false);
    expect(state._activePanelProcesses.get('panel')).toBe(replacement);

    await collect(current);
    expect(signals[1].aborted).toBe(true);
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

  it('an asynchronous closed stdin pipe settles the issuing child without an unhandled error', async () => {
    const { spawn: realSpawn } = await vi.importActual<typeof import('child_process')>('child_process');
    const proc = realSpawn(process.execPath, ['-e',
      "require('node:fs').closeSync(0); process.stdout.write('ready'); setInterval(() => {}, 1000);",
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise<void>(resolve => proc.once('close', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        proc.once('error', reject);
        proc.stdout!.once('data', () => { proc.removeListener('error', reject); resolve(); });
      });
      const { provider, deliver, cleanup, send } = harness();
      deliver.mockRestore();
      vi.mocked((provider as any).processStream).mockRestore();
      vi.mocked(spawn).mockReturnValue(proc);
      vi.mocked(killProcessTree).mockImplementation(async target => { target.kill(); });
      const chunks = await collect(send());
      expect(chunks).toContainEqual(expect.objectContaining({ type: 'error', content: expect.stringMatching(/EPIPE|broken pipe/i) }));
      await exited;
      expect(cleanup).toHaveBeenCalledOnce();
      expect(proc.stdin!.listenerCount('error')).toBe(0);
    } finally {
      proc.kill();
      await exited;
    }
  });
});
