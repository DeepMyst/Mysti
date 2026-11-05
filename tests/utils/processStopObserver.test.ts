import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { killProcessTree, markOwnedProcessGroup } from '../../src/utils/processKill';

class OwnedHandle extends EventEmitter {
  pid = 424242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn(() => true);
  child() { return this as unknown as ChildProcess; }
  exit() { this.exitCode = 0; this.emit('exit', 0, null); }
}

describe.skipIf(process.platform === 'win32')('observe provider-owned cancellation without another initial signal', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('sends no initial signal and escalates a still-running handle at the existing deadline', async () => {
    const proc = new OwnedHandle();
    const completed = killProcessTree(proc.child(), 5000, { initialSignal: null });
    expect(proc.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4999); expect(proc.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await completed;
    expect(proc.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it('removes its timer and listener when an ungrouped handle exits', async () => {
    const proc = new OwnedHandle(); const completed = killProcessTree(proc.child(), 5000, { initialSignal: null });
    proc.exit(); await completed;
    expect(vi.getTimerCount()).toBe(0); expect(proc.listenerCount('exit')).toBe(0);
    await vi.advanceTimersByTimeAsync(10000); expect(proc.kill).not.toHaveBeenCalled();
  });

  it('settles an absent owned group at leader exit and never targets a subsequently reused group number', async () => {
    const proc = new OwnedHandle(); markOwnedProcessGroup(proc.child());
    let groupExists = false;
    const signal = vi.spyOn(process, 'kill').mockImplementation((_pid, value) => {
      if (value === 0 && !groupExists) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return true;
    });
    const completed = killProcessTree(proc.child(), 5000, { initialSignal: null });
    proc.exit(); await completed; expect(vi.getTimerCount()).toBe(0);
    groupExists = true; await vi.advanceTimersByTimeAsync(10000);
    expect(signal.mock.calls.filter(([, value]) => value !== 0)).toEqual([]);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('retains group cleanup after the leader exits while ordinary descendants remain', async () => {
    const proc = new OwnedHandle(); markOwnedProcessGroup(proc.child());
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
    const completed = killProcessTree(proc.child(), 5000, { initialSignal: null });
    proc.exit(); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5000); await completed;
    expect(signal.mock.calls.filter(([, value]) => value !== 0)).toEqual([[-proc.pid, 'SIGKILL']]);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('does not signal a group that drains after its leader exit', async () => {
    const proc = new OwnedHandle(); markOwnedProcessGroup(proc.child()); let groupExists = true;
    const signal = vi.spyOn(process, 'kill').mockImplementation((_pid, value) => {
      if (value === 0 && !groupExists) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return true;
    });
    const completed = killProcessTree(proc.child(), 5000, { initialSignal: null });
    proc.exit(); groupExists = false;
    await vi.advanceTimersByTimeAsync(5000); await completed;
    expect(signal.mock.calls.filter(([, value]) => value !== 0)).toEqual([]);
    expect(proc.kill).not.toHaveBeenCalled();
  });
});
