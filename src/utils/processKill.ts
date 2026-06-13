/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChildProcess } from 'child_process';
import { PROCESS_KILL_GRACE_PERIOD_MS } from '../constants';

/**
 * A process is considered alive only while BOTH exitCode and signalCode are null.
 *
 * This is the crux of bug B3: `ChildProcess.killed` is NOT a liveness check —
 * it flips to `true` the moment a signal is successfully *delivered* (e.g. after
 * `kill('SIGTERM')`), regardless of whether the process actually exited. Guards
 * written as `if (proc && !proc.killed)` therefore skip every signalled-but-still-
 * running process, which made all SIGKILL escalation dead code and leaked CLIs
 * that ignore SIGTERM.
 *
 * Node sets `exitCode` (non-null) when the process exits normally and `signalCode`
 * (non-null) when it was terminated by a signal. While running, both are null.
 */
export function isProcessLive(proc: ChildProcess | null | undefined): boolean {
  if (!proc) {
    return false;
  }
  return proc.exitCode === null && proc.signalCode === null;
}

/**
 * Options for {@link killProcessTree}.
 */
export interface KillProcessTreeOptions {
  /**
   * Grace period (ms) to wait after SIGTERM before escalating to SIGKILL.
   * Defaults to PROCESS_KILL_GRACE_PERIOD_MS.
   */
  graceMs?: number;
  /**
   * When the process was spawned with `detached: true` it is the leader of its
   * own process group, so signals can be delivered to the whole group via the
   * negative pid (`process.kill(-pid, signal)`). Set this to true ONLY when the
   * spawn used `detached: true`; otherwise group signalling will target an
   * unrelated group (or throw ESRCH). Defaults to false to match the current
   * spawn options (no provider currently spawns detached).
   */
  useProcessGroup?: boolean;
  /**
   * Optional logging label (e.g. provider display name) for diagnostics.
   */
  label?: string;
  /**
   * Initial signal to send before escalation. Defaults to 'SIGTERM'.
   * Callers that have a frozen (SIGSTOP'd) process should pass 'SIGKILL' so the
   * signal is delivered to the stopped process without first resuming it.
   */
  initialSignal?: NodeJS.Signals;
}

/**
 * Send a signal to a process — or, when `useProcessGroup` is set, to the entire
 * process group it leads. Swallows ESRCH/EPERM so callers never have to guard
 * a kill on an already-exited / reaped process.
 *
 * @returns true if the signal was sent without throwing.
 */
function sendSignal(
  proc: ChildProcess,
  signal: NodeJS.Signals,
  useProcessGroup: boolean,
): boolean {
  try {
    if (useProcessGroup && typeof proc.pid === 'number') {
      // Negative pid targets the process group led by proc (detached spawns).
      process.kill(-proc.pid, signal);
    } else {
      proc.kill(signal);
    }
    return true;
  } catch {
    // ESRCH (no such process) / EPERM — process is already gone or unreachable.
    return false;
  }
}

/**
 * Gracefully terminate a child process (and, when applicable, its process group)
 * with reliable SIGKILL escalation.
 *
 * Behaviour:
 *  - If the process is already dead (exitCode/signalCode set, or null handle),
 *    resolves immediately — safe to call on an already-exited process; never throws.
 *  - Otherwise sends the initial signal (SIGTERM by default), then schedules a
 *    SIGKILL escalation after `graceMs`. The escalation fires ONLY if the process
 *    is still live at that point (checked via exitCode/signalCode, NOT `.killed`).
 *  - Listens for the process 'exit' event: when it fires, the escalation timer is
 *    cleared (no leaked timers) and the promise resolves.
 *  - The returned promise resolves when the process is gone (either after the
 *    'exit' event, or after the SIGKILL escalation has been issued for a process
 *    that ignores SIGTERM).
 *
 * @param proc    The child process to terminate (may be null/already-exited).
 * @param graceMs Grace period before SIGKILL escalation. Defaults to
 *                PROCESS_KILL_GRACE_PERIOD_MS.
 */
export function killProcessTree(
  proc: ChildProcess | null | undefined,
  graceMs: number = PROCESS_KILL_GRACE_PERIOD_MS,
  options: Omit<KillProcessTreeOptions, 'graceMs'> = {},
): Promise<void> {
  const { useProcessGroup = false, label, initialSignal = 'SIGTERM' } = options;

  return new Promise<void>((resolve) => {
    // Already dead (or no handle): nothing to do.
    if (!isProcessLive(proc)) {
      resolve();
      return;
    }

    const child = proc as ChildProcess;
    let escalationTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const cleanupAndResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (escalationTimer) {
        clearTimeout(escalationTimer);
        escalationTimer = null;
      }
      child.removeListener('exit', onExit);
      resolve();
    };

    const onExit = () => {
      // Process is gone — clear the escalation timer so no leaked timers remain.
      cleanupAndResolve();
    };

    child.on('exit', onExit);

    // Send the initial signal. If it could not be sent the process is already
    // gone — but the 'exit' listener will have fired (or will), so we still rely
    // on it / the immediate liveness re-check below.
    sendSignal(child, initialSignal, useProcessGroup);

    // Re-check liveness synchronously: the signal may have terminated the process
    // immediately (or it was already reaped between the first check and now).
    if (!isProcessLive(child)) {
      cleanupAndResolve();
      return;
    }

    // Schedule SIGKILL escalation — fires only if still live after the grace period.
    escalationTimer = setTimeout(() => {
      escalationTimer = null;
      if (isProcessLive(child)) {
        if (label) {
          console.warn(`[Mysti] ${label}: Force killing leaked process (SIGKILL)`);
        } else {
          console.warn('[Mysti] Force killing leaked process (SIGKILL)');
        }
        sendSignal(child, 'SIGKILL', useProcessGroup);
      }
      // Resolve regardless: we have done everything we can. The 'exit' listener
      // (still attached until cleanupAndResolve) will fire when the process
      // actually dies, but we don't block the caller on it.
      cleanupAndResolve();
    }, graceMs);
  });
}
