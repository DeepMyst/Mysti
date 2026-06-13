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
 * Unit tests for killProcessTree / isProcessLive (Plan 00 Batch 2.1, bug B3).
 *
 * The crux of B3: the old code gated SIGKILL escalation on `ChildProcess.killed`,
 * which flips true once a signal is *delivered* (not on exit), making escalation
 * dead code. These tests pin the corrected semantics:
 *   - liveness via exitCode === null && signalCode === null (NOT .killed)
 *   - alive → SIGTERM → still alive after grace → SIGKILL
 *   - already-exited process → no-op, no throw
 *   - escalation timer cleared on the 'exit' event (no leaked timers)
 */
import { EventEmitter } from 'events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import { killProcessTree, isProcessLive } from '../../src/utils/processKill';

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
  });

  afterEach(() => {
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
});
