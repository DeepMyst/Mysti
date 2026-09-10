import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCliStdout } from '../../../src/providers/base/readCliStdout';
import { killProcessTree } from '../../../src/utils/processKill';

vi.mock('../../../src/utils/processKill', () => ({ killProcessTree: vi.fn(async () => {}) }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
function harness(initialPending = false) {
  vi.useFakeTimers();
  const controller = new AbortController();
  let resolve!: (value: IteratorResult<Buffer>) => void;
  const pendingRead = new Promise<IteratorResult<Buffer>>(done => { resolve = done; });
  const next = vi.fn(() => pendingRead);
  const returned = vi.fn(async () => ({ done: true, value: undefined }));
  const proc = Object.assign(new EventEmitter(), {
    stdout: { [Symbol.asyncIterator]: () => ({ next, return: returned }) },
  }) as unknown as ChildProcess;
  const listeners = new Set<() => void>();
  const approvals = { hasPending: initialPending, onPendingChanged: (listener: () => void) => {
    listeners.add(listener); return () => { listeners.delete(listener); };
  } };
  const stream = readCliStdout(proc, { signal: controller.signal, isCurrent: () => !controller.signal.aborted,
    stderr: { output: '' }, inactivityMs: 100, label: 'Fixture', approvals });
  const setPending = (value: boolean) => { approvals.hasPending = value; listeners.forEach(listener => listener()); };
  return { controller, proc, next, returned, listeners, stream, setPending, resolve };
}

describe('single-shot reads while native approval is pending', () => {
  it('pauses an existing inactivity deadline without losing or duplicating the stdout read', async () => {
    const h = harness();
    const first = h.stream.next();
    await vi.advanceTimersByTimeAsync(50);
    h.setPending(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(killProcessTree).not.toHaveBeenCalled();
    expect(h.next).toHaveBeenCalledOnce();
    h.resolve({ done: false, value: Buffer.from('native response') });
    expect((await first).value?.toString()).toBe('native response');
    await h.stream.return(undefined);
    expect(h.listeners.size).toBe(0); expect(h.returned).toHaveBeenCalledOnce();
    expect(h.proc.listenerCount('error')).toBe(0);
  });

  it('resumes the inactivity deadline after the native decision settles', async () => {
    const h = harness(true);
    const first = h.stream.next();
    const failed = expect(first).rejects.toThrow('request timed out');
    await vi.advanceTimersByTimeAsync(10000);
    expect(killProcessTree).not.toHaveBeenCalled();
    h.setPending(false);
    await vi.advanceTimersByTimeAsync(100);
    await failed;
    expect(killProcessTree).toHaveBeenCalledOnce();
    expect(h.listeners.size).toBe(0); expect(h.next).toHaveBeenCalledOnce();
  });

  it('Stop wakes a pending approval without waiting for stdout or its inactivity deadline', async () => {
    const h = harness(true);
    const first = h.stream.next(); h.controller.abort();
    expect((await first).done).toBe(true);
    expect(killProcessTree).not.toHaveBeenCalled();
    expect(h.listeners.size).toBe(0); expect(h.returned).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
