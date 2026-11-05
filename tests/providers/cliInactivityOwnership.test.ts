import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestableClaudeProvider, TestableOpenClawProvider } from '../helpers/providerFactory';
import { createClaudeSession, createOpenClawSession } from '../helpers/sessionFactory';
import { clearMockConfig } from '../helpers/mockVscode';
import { AUTONOMOUS_PROCESS_TIMEOUT_MS, STREAM_INACTIVITY_TIMEOUT_MS } from '../../src/constants';
import * as processKill from '../../src/utils/processKill';
import type { StreamChunk } from '../../src/types';

vi.mock('../../src/utils/platform', async original => ({
  ...await original<typeof import('../../src/utils/platform')>(), readOpenClawToken: () => undefined,
}));

beforeEach(() => { clearMockConfig(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); clearMockConfig(); });

for (const kind of ['shared', 'openclaw'] as const) describe(`${kind} CLI inactivity ownership`, () => {
  async function fixture(test: (f: {
    provider: any; session: any; process: any; replacement: any; stderr: { output: string };
    iterator: any; pull(): { result?: IteratorResult<StreamChunk>; promise: Promise<IteratorResult<StreamChunk>> };
    text(value: string): void; kill: ReturnType<typeof vi.spyOn>;
  }) => Promise<void>) {
    const provider = kind === 'openclaw' ? new TestableOpenClawProvider() : new TestableClaudeProvider();
    const session: any = kind === 'openclaw' ? createOpenClawSession('owned') : createClaudeSession('owned');
    const waiters: Array<(value: IteratorResult<Buffer>) => void> = [];
    let closed = false;
    const close = () => { closed = true; for (const resolve of waiters.splice(0)) resolve({ done: true, value: undefined }); };
    const iterator = {
      next: vi.fn(() => closed ? Promise.resolve({ done: true, value: undefined }) : new Promise<IteratorResult<Buffer>>(resolve => waiters.push(resolve))),
      return: vi.fn(async () => { close(); return { done: true, value: undefined }; }),
    };
    const proc = { pid: undefined, exitCode: null, signalCode: null, kill: vi.fn(), on: vi.fn(), once: vi.fn(), removeListener: vi.fn(),
      stdout: { [Symbol.asyncIterator]: () => iterator }, stderr: null };
    const replacement = { ...proc, kill: vi.fn() }; session.process = proc;
    vi.spyOn(provider as any, 'waitForProcess').mockResolvedValue(0);
    for (const name of ['log', 'warn', 'error'] as const) vi.spyOn(console, name).mockImplementation(() => {});
    const kill = vi.spyOn(processKill, 'killProcessTree').mockResolvedValue(undefined);
    const stderr = { output: '' };
    const stream: AsyncGenerator<StreamChunk> = (provider as any).processStream(stderr, session);
    const pending: Promise<unknown>[] = [];
    const pull = () => {
      const row: { result?: IteratorResult<StreamChunk>; promise: Promise<IteratorResult<StreamChunk>> } = { promise: stream.next() };
      row.promise.then(result => { row.result = result; }); pending.push(row.promise); return row;
    };
    try {
      await test({ provider, session, process: proc, replacement, stderr, iterator, pull, kill,
        text: value => {
          const event = kind === 'openclaw' ? { type: 'text', content: value }
            : { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } } };
          expect(waiters.length).toBeGreaterThan(0); waiters.shift()!({ done: false, value: Buffer.from(JSON.stringify(event) + '\n') });
        },
      });
    } finally {
      close(); await Promise.allSettled(pending); await stream.return(undefined as never); provider.dispose();
      expect(vi.getTimerCount()).toBe(0);
    }
  }

  it('reports a silent open pipe at the configured bound without waiting for process EOF', async () => {
    await fixture(async f => {
      const first = f.pull(); await vi.advanceTimersByTimeAsync(STREAM_INACTIVITY_TIMEOUT_MS + 1);
      expect(first.result?.value).toMatchObject({ type: 'error', content: expect.stringMatching(/timed out/i) });
      expect(f.kill).toHaveBeenCalledTimes(1); expect(f.kill.mock.calls[0][0]).toBe(f.process);
      const end = await f.pull().promise; expect(end.done).toBe(true);
      expect(f.provider.waitForProcess).not.toHaveBeenCalled();
    });
  });

  it('keeps the same pending stdout read across stderr-only progress so the next reply is not lost', async () => {
    await fixture(async f => {
      const first = f.pull(); await vi.advanceTimersByTimeAsync(STREAM_INACTIVITY_TIMEOUT_MS - 1);
      f.stderr.output += 'Still working\n'; await vi.advanceTimersByTimeAsync(2);
      expect(first.result).toBeUndefined(); expect(f.kill).not.toHaveBeenCalled();
      f.text('Reply after stderr progress'); await vi.advanceTimersByTimeAsync(0);
      expect(first.result?.value).toMatchObject({ type: 'text', content: 'Reply after stderr progress' });
    });
  });

  it('preserves partial text before one inactivity error', async () => {
    await fixture(async f => {
      const first = f.pull(); f.text('Useful partial reply'); await vi.advanceTimersByTimeAsync(0);
      expect(first.result?.value).toMatchObject({ type: 'text', content: 'Useful partial reply' });
      const next = f.pull(); await vi.advanceTimersByTimeAsync(STREAM_INACTIVITY_TIMEOUT_MS + 1);
      expect(next.result?.value).toMatchObject({ type: 'error', content: expect.stringMatching(/timed out/i) });
      expect((await f.pull().promise).done).toBe(true); expect(f.kill).toHaveBeenCalledTimes(1);
    });
  });

  it('uses the longer autonomous inactivity allowance', async () => {
    await fixture(async f => {
      f.session.autonomousMode = true; const first = f.pull();
      await vi.advanceTimersByTimeAsync(STREAM_INACTIVITY_TIMEOUT_MS + 1);
      expect(first.result).toBeUndefined(); expect(f.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(AUTONOMOUS_PROCESS_TIMEOUT_MS - STREAM_INACTIVITY_TIMEOUT_MS);
      expect(first.result?.value).toMatchObject({ type: 'error', content: expect.stringMatching(/timed out/i) });
      expect(f.kill).toHaveBeenCalledTimes(1);
    });
  });

  it('reports the issuing request allowance when later session settings change', async () => {
    await fixture(async f => {
      const first = f.pull(); f.session.autonomousMode = true;
      await vi.advanceTimersByTimeAsync(STREAM_INACTIVITY_TIMEOUT_MS + 1);
      expect(first.result?.value).toMatchObject({ type: 'error', content: expect.stringContaining('30 minutes') });
    });
  });

  it('never signals a replacement process after ownership has changed', async () => {
    await fixture(async f => {
      const first = f.pull(); f.session.process = f.replacement;
      await vi.advanceTimersByTimeAsync(STREAM_INACTIVITY_TIMEOUT_MS + 1);
      expect(first.result?.value.type).toBe('error'); expect(f.kill).not.toHaveBeenCalled();
      expect(f.replacement.kill).not.toHaveBeenCalled();
    });
  });
});
