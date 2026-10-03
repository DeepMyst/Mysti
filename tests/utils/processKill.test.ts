/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for killProcessTree / isProcessLive (Plan 00 Batch 2.1, bug B3;
 * Plan 18 Wave 4 item 1.2, real tree kill).
 *
 * The crux of B3: the old code gated SIGKILL escalation on `ChildProcess.killed`,
 * which flips true once a signal is *delivered* (not on exit), making escalation
 * dead code. These tests pin the corrected semantics:
 *   - liveness via exitCode === null && signalCode === null (NOT .killed)
 *   - alive → SIGTERM → still alive after grace → SIGKILL
 *   - already-exited process → no-op, no throw
 *   - escalation timer cleared on the 'exit' event (no leaked timers)
 *
 * Plan 18 Wave 4 adds REAL tree-kill semantics:
 *   - Windows: every signal step is `taskkill /PID <pid> /T /F` (reaches the
 *     children of the `shell:true` cmd.exe shim), with single-pid fallback when
 *     taskkill can't spawn or exits non-zero while the target is still live
 *   - POSIX + useProcessGroup: negative-pid group signal, falling back to the
 *     single pid when the group signal throws (child not spawned detached)
 */
import { EventEmitter } from 'events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { killProcessTree, isProcessLive } from '../../src/utils/processKill';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

const spawnMock = vi.mocked(spawn);

/** The real platform, restored after every test that overrides it. */
const REAL_PLATFORM = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

/**
 * Minimal EventEmitter-based fake ChildProcess.
 *
 * Mirrors the real Node contract that killProcessTree relies on:
 *   - exitCode / signalCode are null while running, non-null after exit
 *   - .killed flips true once a signal is delivered (we set it on kill() to prove
 *     the util does NOT rely on it)
 *   - kill(signal) records the signal and returns true (or throws when configured
 *     to simulate an already-reaped process)
 */
class FakeProc extends EventEmitter {
  public pid = 4242;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public killed = false;
  public readonly signals: NodeJS.Signals[] = [];
  public throwOnKill = false;

  kill(signal?: NodeJS.Signals): boolean {
    if (this.throwOnKill) {
      const err = new Error('kill ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    }
    this.signals.push((signal ?? 'SIGTERM') as NodeJS.Signals);
    // Real Node: .killed becomes true on successful signal delivery — NOT on exit.
    this.killed = true;
    return true;
  }

  /** Simulate the process actually exiting (sets exitCode/signalCode + emits 'exit'). */
  simulateExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

describe('isProcessLive', () => {
  it('returns false for null / undefined handles', () => {
    expect(isProcessLive(null)).toBe(false);
    expect(isProcessLive(undefined)).toBe(false);
  });

  it('returns true while exitCode and signalCode are both null', () => {
    const proc = new FakeProc();
    expect(isProcessLive(proc.asChildProcess())).toBe(true);
  });

  it('does NOT trust .killed — a signalled-but-alive process is still live', () => {
    const proc = new FakeProc();
    proc.kill('SIGTERM'); // .killed = true, but exitCode/signalCode still null
    expect(proc.killed).toBe(true);
    expect(isProcessLive(proc.asChildProcess())).toBe(true);
  });

  it('returns false once exitCode is set (normal exit)', () => {
    const proc = new FakeProc();
    proc.exitCode = 0;
    expect(isProcessLive(proc.asChildProcess())).toBe(false);
  });

  it('returns false once signalCode is set (killed by signal)', () => {
    const proc = new FakeProc();
    proc.signalCode = 'SIGKILL';
    expect(isProcessLive(proc.asChildProcess())).toBe(false);
  });
});

describe('killProcessTree', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Pin a POSIX platform so these tests are deterministic on any host OS
    // (on win32 the util routes every signal through taskkill instead).
    setPlatform('darwin');
    spawnMock.mockReset();
  });

  afterEach(() => {
    setPlatform(REAL_PLATFORM);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('alive → SIGTERM → still alive after grace → SIGKILL', async () => {
    const proc = new FakeProc();
    const grace = 5000;

    const done = killProcessTree(proc.asChildProcess(), grace);

    // SIGTERM sent immediately; no SIGKILL yet.
    expect(proc.signals).toEqual(['SIGTERM']);

    // Process ignores SIGTERM (stays alive). Advance past the grace period.
    await vi.advanceTimersByTimeAsync(grace);

    // Escalation must fire because the process is still live (exitCode/signalCode null).
    expect(proc.signals).toEqual(['SIGTERM', 'SIGKILL']);

    await done; // resolves after escalation
  });

  it('does not escalate to SIGKILL if the process exits within the grace period', async () => {
    const proc = new FakeProc();
    const grace = 5000;

    const done = killProcessTree(proc.asChildProcess(), grace);
    expect(proc.signals).toEqual(['SIGTERM']);

    // Process honours SIGTERM and exits before grace elapses.
    proc.simulateExit(null, 'SIGTERM');

    await done; // resolves on 'exit'

    // Advancing past grace must NOT produce a SIGKILL (timer was cleared).
    await vi.advanceTimersByTimeAsync(grace * 2);
    expect(proc.signals).toEqual(['SIGTERM']);
  });

  it('clears the escalation timer on the exit event (no leaked timers)', async () => {
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    const proc = new FakeProc();

    const done = killProcessTree(proc.asChildProcess(), 5000);
    proc.simulateExit(0);
    await done;

    expect(clearSpy).toHaveBeenCalled();
    // No pending timers should remain.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('already-exited process → no-op (no signals, no throw), resolves immediately', async () => {
    const proc = new FakeProc();
    proc.exitCode = 0; // already dead

    await expect(killProcessTree(proc.asChildProcess(), 5000)).resolves.toBeUndefined();
    expect(proc.signals).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('null handle → no-op, resolves immediately, no timers', async () => {
    await expect(killProcessTree(null, 5000)).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('safe when kill() throws (already reaped) — swallows the error and resolves', async () => {
    const proc = new FakeProc();
    proc.throwOnKill = true; // kill() throws ESRCH like an already-reaped process

    // Should not throw; resolves once the (still-"live") handle escalates/settles.
    const done = killProcessTree(proc.asChildProcess(), 5000);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(done).resolves.toBeUndefined();
  });

  it('honours a custom initialSignal (suspended process → SIGKILL directly)', async () => {
    const proc = new FakeProc();
    const grace = 5000;

    const done = killProcessTree(proc.asChildProcess(), grace, { initialSignal: 'SIGKILL' });

    // First signal is SIGKILL (no SIGTERM), matching the suspended-process path.
    expect(proc.signals).toEqual(['SIGKILL']);

    // Still "alive" in the fake → escalation also sends SIGKILL after grace.
    await vi.advanceTimersByTimeAsync(grace);
    expect(proc.signals).toEqual(['SIGKILL', 'SIGKILL']);

    await done;
  });

  it('sends to the process group (negative pid) when useProcessGroup is set', async () => {
    const proc = new FakeProc();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const done = killProcessTree(proc.asChildProcess(), 5000, { useProcessGroup: true });

    // Group signalling targets -pid via process.kill, not proc.kill().
    expect(killSpy).toHaveBeenCalledWith(-proc.pid, 'SIGTERM');
    expect(proc.signals).toEqual([]);

    proc.simulateExit(null, 'SIGTERM');
    await done;
    killSpy.mockRestore();
  });

  it('uses PROCESS_KILL_GRACE_PERIOD_MS as the default grace period', async () => {
    const { PROCESS_KILL_GRACE_PERIOD_MS } = await import('../../src/constants');
    const proc = new FakeProc();

    const done = killProcessTree(proc.asChildProcess()); // no grace arg
    expect(proc.signals).toEqual(['SIGTERM']);

    // Just before default grace: no escalation yet.
    await vi.advanceTimersByTimeAsync(PROCESS_KILL_GRACE_PERIOD_MS - 1);
    expect(proc.signals).toEqual(['SIGTERM']);

    // At default grace: escalation fires.
    await vi.advanceTimersByTimeAsync(1);
    expect(proc.signals).toEqual(['SIGTERM', 'SIGKILL']);

    await done;
  });

  it('falls back to the single pid when the group signal throws (child not detached)', async () => {
    const proc = new FakeProc();
    const err = new Error('kill ESRCH') as NodeJS.ErrnoException;
    err.code = 'ESRCH';
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw err;
    });

    const done = killProcessTree(proc.asChildProcess(), 5000, { useProcessGroup: true });

    // Group signal was attempted (negative pid) and threw...
    expect(killSpy).toHaveBeenCalledWith(-proc.pid, 'SIGTERM');
    // ...so the util fell back to signalling the single pid via proc.kill().
    expect(proc.signals).toEqual(['SIGTERM']);

    proc.simulateExit(null, 'SIGTERM');
    await done;
    killSpy.mockRestore();
  });

  it('never routes through taskkill on POSIX', async () => {
    const proc = new FakeProc();
    const done = killProcessTree(proc.asChildProcess(), 5000);
    proc.simulateExit(0);
    await done;
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('killProcessTree on Windows (taskkill tree kill)', () => {
  /** Fake taskkill child process handle returned by the mocked spawn(). */
  class FakeTaskkill extends EventEmitter {}

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    setPlatform('win32');
    spawnMock.mockReset();
  });

  afterEach(() => {
    setPlatform(REAL_PLATFORM);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('kills the whole tree via `taskkill /PID <pid> /T /F` (not the single pid)', async () => {
    const taskkill = new FakeTaskkill();
    spawnMock.mockReturnValue(taskkill as unknown as ReturnType<typeof spawn>);
    const proc = new FakeProc();

    const done = killProcessTree(proc.asChildProcess(), 5000);

    expect(spawnMock).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', String(proc.pid), '/T', '/F'],
      expect.objectContaining({ windowsHide: true })
    );
    // No direct single-pid signal — that would kill only the cmd.exe shim.
    expect(proc.signals).toEqual([]);

    taskkill.emit('exit', 0);
    proc.simulateExit(1);
    await done;
    expect(proc.signals).toEqual([]);
  });

  it('escalation after the grace period issues another taskkill, still no raw signal', async () => {
    spawnMock.mockImplementation(() => new FakeTaskkill() as unknown as ReturnType<typeof spawn>);
    const proc = new FakeProc();

    const done = killProcessTree(proc.asChildProcess(), 5000);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Process survives the grace period → escalation re-runs taskkill /T /F.
    await vi.advanceTimersByTimeAsync(5000);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(proc.signals).toEqual([]);

    await done;
  });

  it('falls back to proc.kill when taskkill cannot be spawned (spawn throws)', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('spawn taskkill ENOENT');
    });
    const proc = new FakeProc();

    const done = killProcessTree(proc.asChildProcess(), 5000);
    expect(proc.signals).toEqual(['SIGTERM']);

    proc.simulateExit(null, 'SIGTERM');
    await done;
  });

  it("falls back to proc.kill when the taskkill child emits 'error'", async () => {
    const taskkill = new FakeTaskkill();
    spawnMock.mockReturnValue(taskkill as unknown as ReturnType<typeof spawn>);
    const proc = new FakeProc();

    const done = killProcessTree(proc.asChildProcess(), 5000);
    expect(proc.signals).toEqual([]);

    taskkill.emit('error', new Error('spawn taskkill ENOENT'));
    expect(proc.signals).toEqual(['SIGTERM']);

    proc.simulateExit(null, 'SIGTERM');
    await done;
  });

  it('falls back to proc.kill when taskkill exits non-zero and the process is still live', async () => {
    const taskkill = new FakeTaskkill();
    spawnMock.mockReturnValue(taskkill as unknown as ReturnType<typeof spawn>);
    const proc = new FakeProc();

    const done = killProcessTree(proc.asChildProcess(), 5000);
    expect(proc.signals).toEqual([]);

    taskkill.emit('exit', 128); // "no such process" / access denied etc.
    expect(proc.signals).toEqual(['SIGTERM']);

    proc.simulateExit(null, 'SIGTERM');
    await done;
  });

  it('does NOT fall back when taskkill exits non-zero but the process already exited', async () => {
    const taskkill = new FakeTaskkill();
    spawnMock.mockReturnValue(taskkill as unknown as ReturnType<typeof spawn>);
    const proc = new FakeProc();

    const done = killProcessTree(proc.asChildProcess(), 5000);
    proc.simulateExit(1); // process died before taskkill reported back
    await done;

    taskkill.emit('exit', 128);
    expect(proc.signals).toEqual([]); // liveness-gated: no redundant signal
  });
});
