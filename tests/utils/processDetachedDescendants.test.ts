import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('child_process', () => ({ execFile: mocks.execFile, spawn: vi.fn() }));
import { killProcessTree, markOwnedProcessGroup } from '../../src/utils/processKill';

// Installed-backend companion (opt-in macOS, scripted loopback model only):
// node scripts/validation/opencode-tool-stop.cjs --cli /path/to/native/opencode
// Accepted native receipts: plans/48-opencode-tool-stop-evidence.json.

class Handle extends EventEmitter {
  pid = 420001;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn(() => true);
  child() { return this as unknown as ChildProcess; }
  exit() { this.exitCode = 0; this.emit('exit', 0, null); }
}

const row = (pid: number, parent: number, group: number, started = 'Thu Nov 5 12:00:00 2026', state = 'S') =>
  `${pid} ${parent} ${group} ${state} ${started}`;

describe.skipIf(process.platform === 'win32')('owned tools in independent POSIX groups', () => {
  let proc: Handle;
  let rows: string[];
  let signals: Array<[number, number | NodeJS.Signals | undefined]>;

  beforeEach(() => {
    vi.useFakeTimers(); mocks.execFile.mockReset();
    proc = new Handle(); markOwnedProcessGroup(proc.child(), true);
    rows = [row(proc.pid, 10, proc.pid)]; signals = [];
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, rows.join('\n')); return {};
    });
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (signal === 0) {
        if (proc.exitCode !== null) { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }
        return true;
      }
      signals.push([pid, signal]);
      if (pid === -proc.pid) { proc.exit(); }
      return true;
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('captures transitive ownership once, signals parents before children, and excludes unrelated processes', async () => {
    rows.push(row(420004, 420003, 420003), row(420003, 420002, 420003),
      row(420002, proc.pid, proc.pid), row(420005, 10, 420005));
    const cleanup = killProcessTree(proc.child(), 100);
    expect(killProcessTree(proc.child(), 100)).toBe(cleanup);
    await vi.advanceTimersByTimeAsync(0);
    expect(signals).toEqual([[420003, 'SIGTERM'], [420004, 'SIGTERM'], [-proc.pid, 'SIGTERM']]);
    expect(mocks.execFile.mock.calls.filter(([, args]) => args[0] === '-A')).toHaveLength(1);
    // The CLI has exited and the tools have been adopted by init. Their
    // verified identities still belong to this cancelled invocation.
    rows = [row(420003, 1, 420003), row(420004, 1, 420003)];
    await vi.advanceTimersByTimeAsync(100); await cleanup;
    expect(signals.slice(3)).toEqual([[420003, 'SIGKILL'], [420004, 'SIGKILL']]);
    expect(proc.listenerCount('exit')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never escalates a reused PID, a changed group, a zombie, or an absent descendant', async () => {
    for (let pid = 420002; pid <= 420005; pid++) { rows.push(row(pid, proc.pid, pid)); }
    const cleanup = killProcessTree(proc.child(), 100);
    await vi.advanceTimersByTimeAsync(0);
    const initialCount = signals.length;
    rows = [row(420002, 1, 420002, 'Thu Nov 5 12:00:01 2026'),
      row(420003, 1, 420099), row(420004, 1, 420004, undefined, 'Z')];
    await vi.advanceTimersByTimeAsync(100); await cleanup;
    expect(signals).toHaveLength(initialCount);
  });

  it('rechecks ownership before the first descendant signal', async () => {
    rows.push(row(420002, proc.pid, 420002));
    mocks.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
      callback(null, rows.join('\n'));
      rows = [row(proc.pid, 10, proc.pid), row(420002, 10, 420002, 'Thu Nov 5 12:00:01 2026')];
      return {};
    });
    const cleanup = killProcessTree(proc.child(), 100);
    await vi.advanceTimersByTimeAsync(100); await cleanup;
    expect(signals).toEqual([[-proc.pid, 'SIGTERM']]);
  });

  it('does not establish descendant ownership after its actual child handle exits', async () => {
    rows.push(row(420002, proc.pid, 420002));
    mocks.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
      proc.exit(); callback(null, rows.join('\n')); return {};
    });
    await killProcessTree(proc.child(), 100);
    expect(signals).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains ordinary group cleanup if process inspection is unavailable', async () => {
    mocks.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
      callback(new Error('ps unavailable'), ''); return {};
    });
    await killProcessTree(proc.child(), 100);
    expect(signals).toEqual([[-proc.pid, 'SIGTERM']]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('process-group cleanup'));
  });
});
