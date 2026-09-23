/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, execFile, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
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
   * POSIX only. When the process was spawned with `detached: true` it is the
   * leader of its own process group, so signals can be delivered to the whole
   * group via the negative pid (`process.kill(-pid, signal)`). Set this to true
   * ONLY when the spawn used `detached: true`; otherwise group signalling will
   * target an unrelated group (or throw ESRCH — in which case we fall back to
   * signalling the single pid). Defaults to false: no provider spawns detached;
   * DevServerManager does (and opts in). Ignored on Windows, where the tree is
   * always killed via `taskkill /T`.
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
  /**
   * POSIX only, default true. Before signalling a real child spawned by this
   * process, freeze it, then find and SIGKILL every descendant (and every
   * process group a descendant leads). CLI agents run approved shell commands
   * in their own detached groups; signalling only the agent orphans them and
   * their delayed effects survive Stop. See {@link killDescendants}.
   */
  descendants?: boolean;
}

interface ProcessRow { pid: number; ppid: number; pgid: number }

async function processTable(): Promise<ProcessRow[]> {
  if (process.platform === 'linux') {
    // /proc works in minimal containers that ship without procps.
    const rows: ProcessRow[] = [];
    for (const name of await fs.readdir('/proc')) {
      if (!/^\d+$/.test(name)) { continue; }
      try {
        const stat = await fs.readFile(`/proc/${name}/stat`, 'utf8');
        // "pid (comm) state ppid pgrp ..."; comm may itself contain ") ".
        const [, ppid, pgid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        rows.push({ pid: Number(name), ppid: Number(ppid), pgid: Number(pgid) });
      } catch { /* Exited while scanning. */ }
    }
    return rows;
  }
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid='], { maxBuffer: 16 * 1024 * 1024 },
      (error, out) => (error ? reject(error) : resolve(out)));
  });
  return stdout.split('\n').map(line => line.trim().split(/\s+/).map(Number))
    .filter(fields => fields.length === 3 && fields.every(Number.isSafeInteger))
    .map(([pid, ppid, pgid]) => ({ pid, ppid, pgid }));
}

function signalQuietly(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(pid, signal); } catch { /* ESRCH/EPERM: already gone. */ }
}

/**
 * Freeze and SIGKILL every descendant of `rootPid`, including whole process
 * groups led by a descendant (a detached shell and its background jobs).
 * Acts only while `rootPid` is verifiably this process's own child, so a stale
 * or fake pid can never reach an unrelated process. The caller keeps the root
 * frozen (SIGSTOP) meanwhile, so it cannot exit and orphan the tree; frozen
 * descendants cannot fork. Rescans until no new descendant appears.
 *
 * ponytail: a descendant that already re-parented itself (double-fork daemon,
 * setsid before the first scan) is out of reach without OS containment such as
 * cgroups; the approval contract does not claim otherwise.
 */
async function killDescendants(rootPid: number): Promise<void> {
  const found = new Map<number, number>();
  for (let round = 0; round < 5; round++) {
    const table = await processTable();
    const root = table.find(row => row.pid === rootPid);
    if (!root || root.ppid !== process.pid) { break; }
    const children = new Map<number, ProcessRow[]>();
    for (const row of table) { children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]); }
    const fresh: ProcessRow[] = [];
    for (const queue = [rootPid]; queue.length;) {
      for (const row of children.get(queue.pop()!) ?? []) {
        if (row.pid === process.pid) { continue; }
        queue.push(row.pid);
        if (!found.has(row.pid)) { fresh.push(row); }
      }
    }
    if (!fresh.length) { break; }
    for (const row of fresh) { found.set(row.pid, row.pgid); signalQuietly(row.pid, 'SIGSTOP'); }
  }
  for (const [pid, pgid] of found) { if (pid === pgid) { signalQuietly(-pgid, 'SIGKILL'); } }
  for (const pid of found.keys()) { signalQuietly(pid, 'SIGKILL'); }
}

/** Real, unreaped children only; test doubles and foreign pids are never frozen. */
function isOwnedChild(proc: ChildProcess): boolean {
  try { return proc instanceof ChildProcess && typeof proc.pid === 'number'; } catch { return false; }
}

/**
 * POSIX only: freeze and SIGKILL the child's current descendants (see
 * {@link killDescendants}) while the child itself keeps running, e.g. so an
 * agent can still finish its own cancellation. Without the root frozen it may
 * fork during the scan; the rescans catch what appears meanwhile, and the
 * caller's later tree kill remains the backstop. A no-op on Windows and for
 * test doubles.
 */
export async function killProcessDescendants(proc: ChildProcess): Promise<void> {
  if (process.platform === 'win32' || !isOwnedChild(proc) || !isProcessLive(proc)) { return; }
  await killDescendants(proc.pid as number);
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
 *  - POSIX default: single-pid `proc.kill(signal)`.
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
    proc.kill(signal);
    return true;
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
 * spawns to signal the whole process group. On POSIX a real child is first
 * frozen and its descendants, including detached groups they lead, are killed
 * (`descendants`, default true); test doubles skip this and signal synchronously.
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
  const { useProcessGroup = false, label, initialSignal = 'SIGTERM', descendants = true } = options;

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

    // Schedule SIGKILL escalation — fires only if still live after the grace period.
    const scheduleEscalation = () => {
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
    };

    const tree = descendants && process.platform !== 'win32' && isOwnedChild(child);
    const begin = () => {
      if (settled) {
        return;
      }
      // Send the initial signal. If it could not be sent the process is already
      // gone — but the 'exit' listener will have fired (or will), so we still rely
      // on it / the immediate liveness re-check below.
      sendSignal(child, initialSignal, useProcessGroup);
      if (tree) {
        // Resume the frozen root so the pending signal is delivered.
        sendSignal(child, 'SIGCONT', useProcessGroup);
      }
      // Re-check liveness synchronously: the signal may have terminated the process
      // immediately (or it was already reaped between the first check and now).
      if (!isProcessLive(child)) {
        cleanupAndResolve();
        return;
      }
      scheduleEscalation();
    };

    if (!tree) {
      begin();
      return;
    }
    // Freeze synchronously: the root must not exit (orphaning its tree to init)
    // while descendants are found. It is unreaped, so the pid is still ours.
    signalQuietly(child.pid as number, 'SIGSTOP');
    void killDescendants(child.pid as number).catch((error) => {
      console.warn(`[Mysti] ${label ?? 'process'}: descendant cleanup failed`, error);
    }).then(begin);
  });
}
