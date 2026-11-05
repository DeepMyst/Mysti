/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { PROCESS_KILL_GRACE_PERIOD_MS } from '../constants';

/** Only mark handles spawned with detached:true on POSIX. Never infer ownership from a PID. */
const ownedProcessGroups = new WeakSet<ChildProcess>();
const ownedDetachedDescendants = new WeakSet<ChildProcess>();
const detachedCleanup = new WeakMap<ChildProcess, Promise<void>>();

export function markOwnedProcessGroup(proc: ChildProcess, captureDetachedDescendants = false): void {
  if (process.platform !== 'win32') {
    ownedProcessGroups.add(proc);
    if (captureDetachedDescendants) { ownedDetachedDescendants.add(proc); }
  }
}

interface ProcessIdentity {
  pid: number;
  parent: number;
  group: number;
  started: string;
}

/** Metadata only: never inspect or retain another process's command or environment. */
function readProcessIdentities(pids?: number[]): Promise<Map<number, ProcessIdentity>> {
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', [...(pids ? ['-p', pids.join(',')] : ['-A']),
      '-o', 'pid=,ppid=,pgid=,stat=,lstart='], {
      encoding: 'utf8', timeout: 1500, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C' },
    }, (error, stdout) => {
      // ps exits 1 when none of the selected PIDs remain.
      if (error && !(pids && error.code === 1 && !stdout.trim())) { reject(error); return; }
      const rows = new Map<number, ProcessIdentity>();
      for (const line of stdout.split('\n')) {
        const row = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+((?:\S+\s+){4}\S+)$/);
        if (!row || row[4].startsWith('Z')) { continue; }
        const pid = Number(row[1]);
        rows.set(pid, { pid, parent: Number(row[2]), group: Number(row[3]), started: row[5] });
      }
      resolve(rows);
    });
  });
}

/** A detached tool changes parent when its CLI exits; its birth time and group remain stable. */
function sameProcessIdentity(before: ProcessIdentity, after: ProcessIdentity | undefined): boolean {
  return !!after && before.pid === after.pid && before.group === after.group && before.started === after.started;
}

async function captureDetachedDescendants(proc: ChildProcess): Promise<ProcessIdentity[]> {
  if (!isProcessLive(proc) || !proc.pid) { return []; }
  const rows = await readProcessIdentities();
  // Do not infer ownership from a reused PID after the actual handle exited.
  if (!isProcessLive(proc) || !rows.has(proc.pid)) { return []; }
  const owned = new Set([proc.pid]);
  const descendants: ProcessIdentity[] = [];
  // Parent-first order prevents terminating a sleep from waking its shell
  // before that shell has received the cancellation signal.
  for (const parent of owned) {
    for (const row of rows.values()) {
      if (row.parent !== parent || owned.has(row.pid)) { continue; }
      owned.add(row.pid);
      if (row.group !== proc.pid) { descendants.push(row); }
    }
  }
  return descendants;
}

async function signalDetachedDescendants(descendants: ProcessIdentity[], signal: NodeJS.Signals): Promise<void> {
  if (!descendants.length) { return; }
  const current = await readProcessIdentities(descendants.map(row => row.pid));
  for (const row of descendants) {
    // Signal only individually verified descendants, never a discovered group
    // or a PID selected by executable name, user, directory or port.
    if (!sameProcessIdentity(row, current.get(row.pid))) { continue; }
    try { process.kill(row.pid, signal); } catch { /* Already exited or inaccessible. */ }
  }
}

async function killWithDetachedDescendants(
  proc: ChildProcess, graceMs: number, options: Omit<KillProcessTreeOptions, 'graceMs'>,
): Promise<void> {
  let descendants: ProcessIdentity[] = [];
  try {
    descendants = await captureDetachedDescendants(proc);
    if (options.initialSignal !== null) {
      await signalDetachedDescendants(descendants, options.initialSignal ?? 'SIGTERM');
    }
  } catch {
    console.warn('[Mysti] Could not inspect owned CLI descendants; continuing process-group cleanup.');
  }
  const groupCleanup = killProcessGroup(proc, graceMs, options);
  if (descendants.length) {
    await new Promise<void>(resolve => setTimeout(resolve, graceMs));
    try { await signalDetachedDescendants(descendants, 'SIGKILL'); }
    catch { console.warn('[Mysti] Could not recheck owned CLI descendants during cleanup.'); }
  }
  await groupCleanup;
}

/** Pause/resume the whole owned group; ordinary provider handles keep single-PID behavior. */
export function signalOwnedProcess(proc: ChildProcess, signal: NodeJS.Signals): boolean {
  if (process.platform === 'win32') { return proc.kill(signal); }
  return sendSignal(proc, signal, ownedProcessGroups.has(proc));
}

function isProcessGroupLive(proc: ChildProcess): boolean {
  if (typeof proc.pid !== 'number') { return false; }
  try { process.kill(-proc.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

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
   * POSIX only. When the process was spawned with `detached: true` it is the
   * leader of its own process group, so signals can be delivered to the whole
   * group via the negative pid (`process.kill(-pid, signal)`). Set this to true
   * ONLY when the spawn used `detached: true`; otherwise group signalling will
   * target an unrelated group (or throw ESRCH — in which case we fall back to
   * signalling the single pid). Defaults to whether the handle was explicitly
   * marked by markOwnedProcessGroup. Ignored on Windows, where the tree is
   * always killed via `taskkill /T`.
   */
  useProcessGroup?: boolean;
  /**
   * Optional logging label (e.g. provider display name) for diagnostics.
   */
  label?: string;
  /**
   * Initial signal to send before escalation. Defaults to 'SIGTERM'. Pass null
   * to observe cancellation already initiated by the owner without duplicating
   * its signal; exit/group settlement and bounded escalation still apply.
   * Callers that have a frozen (SIGSTOP'd) process should pass 'SIGKILL' so the
   * signal is delivered to the stopped process without first resuming it.
   */
  initialSignal?: NodeJS.Signals | null;
}

/**
 * Windows tree kill: `taskkill /PID <pid> /T /F` terminates the process AND all
 * of its descendants. This matters because every provider spawn on Windows uses
 * `shell: true`, so the tracked pid is a cmd.exe shim — signalling only that pid
 * kills the shell and ORPHANS the actual CLI underneath it. taskkill /T walks
 * the child tree, so it is safe and correct for every call site (no opt-in).
 *
 * Fallback: if taskkill cannot be spawned, or exits non-zero while the process
 * is still live (e.g. taskkill missing from PATH, access denied), we fall back
 * to the single-pid `proc.kill(signal)` so behaviour is never worse than before.
 *
 * @returns true if a termination attempt was issued without throwing.
 */
function killWindowsProcessTree(proc: ChildProcess, fallbackSignal: NodeJS.Signals): boolean {
  const pid = proc.pid;
  if (typeof pid !== 'number') {
    // No pid (spawn failed very early) — nothing for taskkill to target.
    try {
      proc.kill(fallbackSignal);
      return true;
    } catch {
      return false;
    }
  }
  const singlePidFallback = () => {
    if (!isProcessLive(proc)) {
      return;
    }
    try {
      proc.kill(fallbackSignal);
    } catch {
      // ESRCH/EPERM — process already gone or unreachable.
    }
  };
  try {
    const taskkill = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    taskkill.on('error', () => {
      // taskkill itself failed to spawn — fall back to signalling the one pid.
      singlePidFallback();
    });
    taskkill.on('exit', (code) => {
      if (code !== 0) {
        // Non-zero exit (128 = no such process, 1 = access denied, ...). Only
        // fall back if the target is actually still live.
        singlePidFallback();
      }
    });
    return true;
  } catch {
    try {
      proc.kill(fallbackSignal);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Send a signal to a process — or to its entire process tree where possible:
 *  - Windows: always `taskkill /PID <pid> /T /F` (kills the cmd.exe shim's
 *    children too), with a single-pid fallback if taskkill fails.
 *  - POSIX with `useProcessGroup`: negative-pid group signal for detached
 *    spawns, falling back to the single pid if the group signal throws.
 *  - POSIX default: single-pid `proc.kill(signal)` (unchanged behaviour).
 * Swallows ESRCH/EPERM so callers never have to guard a kill on an
 * already-exited / reaped process.
 *
 * @returns true if the signal was sent without throwing.
 */
function sendSignal(
  proc: ChildProcess,
  signal: NodeJS.Signals,
  useProcessGroup: boolean,
): boolean {
  if (process.platform === 'win32') {
    return killWindowsProcessTree(proc, signal);
  }
  if (useProcessGroup && typeof proc.pid === 'number') {
    try {
      // Negative pid targets the process group led by proc (detached spawns).
      process.kill(-proc.pid, signal);
      return true;
    } catch {
      // ESRCH/EPERM on the group (child not spawned detached, or already
      // reaped) — fall back to signalling the single pid below.
    }
  }
  try {
    return proc.kill(signal);
  } catch {
    // ESRCH (no such process) / EPERM — process is already gone or unreachable.
    return false;
  }
}

/**
 * Gracefully terminate a child process — and its process TREE where possible —
 * with reliable SIGKILL escalation. On Windows every signal step is delivered
 * as `taskkill /PID <pid> /T /F` (whole tree — reaches through the `shell:true`
 * cmd.exe shim); on POSIX, pass `useProcessGroup: true` for `detached: true`
 * spawns to signal the whole process group.
 *
 * Behaviour:
 *  - If the process is already dead (exitCode/signalCode set, or null handle),
 *    resolves immediately — safe to call on an already-exited process; never throws.
 *  - Otherwise sends the initial signal (SIGTERM by default), then schedules a
 *    SIGKILL escalation after `graceMs`. The escalation fires ONLY if the process
 *    is still live at that point (checked via exitCode/signalCode, NOT `.killed`).
 *  - Listens for the process 'exit' event: the timer is cleared and the promise
 *    resolves unless an explicitly owned group still contains descendants.
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
  if (proc && ownedDetachedDescendants.has(proc) && process.platform !== 'win32') {
    // Stop, the stream's finally, and ProviderManager may all cancel the same
    // handle. They must share the snapshot before any path kills its parent.
    let cleanup = detachedCleanup.get(proc);
    if (!cleanup) {
      cleanup = killWithDetachedDescendants(proc, graceMs, options);
      detachedCleanup.set(proc, cleanup);
    }
    return cleanup;
  }
  return killProcessGroup(proc, graceMs, options);
}

function killProcessGroup(
  proc: ChildProcess | null | undefined,
  graceMs: number,
  options: Omit<KillProcessTreeOptions, 'graceMs'>,
): Promise<void> {
  const { label, initialSignal = 'SIGTERM' } = options;
  const useProcessGroup = process.platform !== 'win32'
    && (options.useProcessGroup ?? (proc ? ownedProcessGroups.has(proc) : false));
  const treeIsLive = () => isProcessLive(proc) || (useProcessGroup && !!proc && isProcessGroupLive(proc));

  return new Promise<void>((resolve) => {
    // Already dead (or no handle): nothing to do.
    if (!treeIsLive()) {
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
      // A launcher can exit before its native child. Keep the group's deadline
      // until its descendants are gone, even though the leader was reaped.
      if (!useProcessGroup || !isProcessGroupLive(child)) { cleanupAndResolve(); }
    };

    child.on('exit', onExit);

    // Send the initial signal. If it could not be sent the process is already
    // gone — but the 'exit' listener will have fired (or will), so we still rely
    // on it / the immediate liveness re-check below.
    if (initialSignal !== null) { sendSignal(child, initialSignal, useProcessGroup); }

    // Re-check liveness synchronously: the signal may have terminated the process
    // immediately (or it was already reaped between the first check and now).
    if (!treeIsLive()) {
      cleanupAndResolve();
      return;
    }

    // Schedule SIGKILL escalation — fires only if still live after the grace period.
    escalationTimer = setTimeout(() => {
      escalationTimer = null;
      if (treeIsLive()) {
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
