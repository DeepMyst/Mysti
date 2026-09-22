/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, ChildProcess } from 'child_process';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs';
import {
  VISUAL_TEST_SERVER_STARTUP_TIMEOUT_MS,
  VISUAL_TEST_SERVER_HEALTH_POLL_MS,
  VISUAL_TEST_SERVER_KILL_GRACE_MS,
  VISUAL_DEVSERVER_LOG_MAX_CHARS,
  VISUAL_MAX_READY_PATTERN_LENGTH
} from '../constants';
import { isProcessLive } from '../utils/processKill';
import { assertVisualOperation, VisualOperationCancelled, awaitVisualCleanup, type VisualOperationControl } from '../services/VisualOperation';

interface DevServerProcess {
  process: ChildProcess;
  url: string;
  pid: number;
  stdout: string;
  stderr: string;
  closed: boolean;
  stopping?: Promise<void>;
  cleanupFailed?: boolean;
  groupGone?: boolean;
}

const DEFAULT_READY_PATTERN = 'localhost:\\d+|127\\.0\\.0\\.1:\\d+|ready in|compiled successfully|VITE|started server on';

/**
 * Compile a user-supplied ready pattern safely.
 *
 * The pattern is matched repeatedly against a growing output buffer, so a
 * catastrophically-backtracking regex would wedge the extension host. The
 * setting is machine-scoped (a cloned repo's `.vscode/settings.json` cannot
 * reach it) and length-capped here; anything that fails to compile falls back
 * to the default rather than throwing on the startup path.
 */
export function compileReadyPattern(readyPattern?: string): RegExp {
  const raw = (readyPattern || '').trim();
  if (raw && raw.length <= VISUAL_MAX_READY_PATTERN_LENGTH) {
    try {
      return new RegExp(raw, 'i');
    } catch {
      console.warn('[Mysti] Invalid visualTest.serverReadyPattern — falling back to the default.');
    }
  } else if (raw) {
    console.warn(`[Mysti] visualTest.serverReadyPattern exceeds ${VISUAL_MAX_READY_PATTERN_LENGTH} chars — falling back to the default.`);
  }
  return new RegExp(DEFAULT_READY_PATTERN, 'i');
}

/** Append to a log buffer, keeping only the most recent VISUAL_DEVSERVER_LOG_MAX_CHARS. */
function appendCapped(buf: string, chunk: string): string {
  const next = buf + chunk;
  return next.length > VISUAL_DEVSERVER_LOG_MAX_CHARS
    ? next.slice(next.length - VISUAL_DEVSERVER_LOG_MAX_CHARS)
    : next;
}

/**
 * Manages dev server lifecycle for visual testing.
 * Spawns, monitors, and stops the user's dev server process.
 */
export class DevServerManager {
  private _processes: Map<string, DevServerProcess> = new Map();
  private _pendingCleanup = new Map<DevServerProcess, string>();

  /**
   * Start a dev server for the given panel.
   * Watches stdout for the ready pattern, falls back to HTTP polling.
   *
   * `expectedUrl` is the address the caller intends to test. It is what we poll
   * and what we return when the server prints no URL of its own — the old code
   * hardcoded `http://localhost:3000` in both places, so a Vite app on :5173
   * either timed out or (worse) reported success because something unrelated
   * answered on :3000.
   */
  async start(
    panelId: string,
    command: string,
    cwd: string,
    readyPattern?: string,
    expectedUrl?: string,
    control?: VisualOperationControl,
  ): Promise<{ url: string; pid: number }> {
    assertVisualOperation(control);
    // Stop any existing process for this panel
    await this.stop(panelId);
    assertVisualOperation(control);

    const args = command.split(' ');
    const cmd = args.shift()!;
    // POSIX: spawn DETACHED so the shell (`sh -c "npm run dev"`) becomes the
    // leader of its own process group and stop() can kill the WHOLE tree via a
    // negative-pid group signal — a plain SIGTERM to the shell would orphan the
    // real node/vite child underneath it. Nothing relies on the dev server
    // sharing the extension host's group (terminal Ctrl+C semantics don't apply
    // in an extension host), and we keep stdio piped + the 'exit' listener, so
    // readiness detection and liveness tracking are unchanged.
    // Windows: keep detached: false (detached would allocate a new console);
    // stop() uses `taskkill /T /F` there, which walks the child tree itself.
    const proc = spawn(cmd, args, {
      cwd,
      shell: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0' },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const entry: DevServerProcess = {
      process: proc,
      url: '',
      pid: proc.pid || 0,
      stdout: '',
      stderr: '', closed: false,
    };

    this._processes.set(panelId, entry);
    proc.once('close', () => { entry.closed = true; });

    // Ring-buffered: a chatty dev server left warm for the whole session would
    // otherwise grow these strings without bound.
    proc.stdout?.on('data', (data: Buffer) => {
      entry.stdout = appendCapped(entry.stdout, data.toString());
    });

    proc.stderr?.on('data', (data: Buffer) => {
      entry.stderr = appendCapped(entry.stderr, data.toString());
    });

    proc.on('error', (err) => {
      console.error(`[Mysti] DevServer error for ${panelId}:`, err.message);
    });

    proc.on('exit', (code) => {
      console.log(`[Mysti] DevServer exited for ${panelId} with code ${code}`);
    });

    const pattern = compileReadyPattern(readyPattern);

    const onAbort = () => { void this._stopEntry(panelId, entry).catch(() => {}); };
    control?.signal.addEventListener('abort', onAbort, { once: true });
    try {
      assertVisualOperation(control);
      const url = await this._waitForReady(panelId, pattern, VISUAL_TEST_SERVER_STARTUP_TIMEOUT_MS, expectedUrl, control);
      assertVisualOperation(control);
      entry.url = url;
      return { url, pid: entry.pid };
    } catch (err) {
      // A server that never became ready is still a live process — reap it here
      // rather than relying on every caller's error path to do it.
      try { await this._stopEntry(panelId, entry); }
      catch (cleanupError) {
        if (control?.signal.aborted || err instanceof VisualOperationCancelled) { throw new VisualOperationCancelled(true); }
        throw cleanupError;
      }
      assertVisualOperation(control);
      throw err;
    } finally { control?.signal.removeEventListener('abort', onAbort); }
  }

  /**
   * Wait for server readiness by watching stdout, then HTTP polling as fallback.
   */
  private async _waitForReady(
    panelId: string,
    pattern: RegExp,
    timeoutMs: number,
    expectedUrl?: string,
    control?: VisualOperationControl,
  ): Promise<string> {
    const entry = this._processes.get(panelId);
    if (!entry) { throw new Error('Dev server not started'); }

    const startTime = Date.now();
    const fallbackUrl = expectedUrl || 'http://localhost:3000';

    return new Promise<string>((resolve, reject) => {
      let resolved = false;
      // Held in an object because `cleanup` closes over it before the interval
      // is created (checkOutput can settle on already-buffered output).
      const timers: { poll?: NodeJS.Timeout } = {};

      // Every listener this promise installs is removed on settle — otherwise a
      // warm session that restarts its server accumulates handlers (and Node's
      // MaxListeners warning) for the life of the extension host.
      const cleanup = () => {
        if (timers.poll) { clearInterval(timers.poll); }
        entry.process.stdout?.removeListener('data', onData);
        entry.process.stderr?.removeListener('data', onData);
        entry.process.removeListener('exit', onExit);
        entry.process.removeListener('error', onError);
        control?.signal.removeEventListener('abort', onAbort);
      };
      const settle = (fn: () => void) => {
        if (resolved) { return; }
        resolved = true;
        cleanup();
        fn();
      };

      const checkOutput = () => {
        if (resolved) { return; }
        const combined = entry.stdout + entry.stderr;
        if (!pattern.test(combined)) { return; }
        // Prefer a URL the server actually printed; otherwise the caller's.
        const urlMatch = combined.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+/);
        settle(() => resolve(urlMatch ? urlMatch[0] : fallbackUrl));
      };

      const onData = () => checkOutput();
      const onExit = (code: number | null) => settle(() => reject(
        new Error(`Dev server exited with code ${code} before becoming ready.\nstderr: ${entry.stderr.slice(-500)}`)
      ));
      // A spawn failure (ENOENT — the command does not exist) fires 'error'
      // WITHOUT 'exit'. Without this the startup burned the full 30s timeout,
      // and the port poll could meanwhile "succeed" against an unrelated server.
      const onError = (err: Error) => settle(() => reject(
        new Error(`Dev server failed to start: ${err.message}`)
      ));

      const onAbort = () => settle(() => reject(new VisualOperationCancelled()));
      control?.signal.addEventListener('abort', onAbort, { once: true });
      if (control?.signal.aborted) { onAbort(); return; }
      entry.process.stdout?.on('data', onData);
      entry.process.stderr?.on('data', onData);
      entry.process.on('exit', onExit);
      entry.process.on('error', onError);

      // Output that arrived before this promise attached its listeners.
      checkOutput();
      if (resolved) { return; }

      timers.poll = setInterval(async () => {
        if (resolved) { return; }
        if (Date.now() - startTime > timeoutMs) {
          settle(() => reject(new Error(`Dev server did not become ready within ${timeoutMs / 1000}s`)));
          return;
        }
        try {
          const isUp = await this._httpCheck(fallbackUrl, control?.signal);
          if (isUp) { settle(() => resolve(fallbackUrl)); }
        } catch {
          // Not ready yet
        }
      }, VISUAL_TEST_SERVER_HEALTH_POLL_MS);
    });
  }

  /**
   * Simple HTTP health check.
   */
  private _httpCheck(url: string, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (signal?.aborted) { resolve(false); return; }
      let get: typeof http.get;
      try {
        get = new URL(url).protocol === 'https:' ? https.get : http.get;
      } catch {
        resolve(false);
        return;
      }
      const req = get(url, (res) => {
        res.resume();
        resolve(res.statusCode !== undefined && res.statusCode < 500);
      });
      const abort = () => { req.destroy(); resolve(false); };
      signal?.addEventListener('abort', abort, { once: true });
      req.on('close', () => signal?.removeEventListener('abort', abort));
      if (signal?.aborted) { abort(); }
      req.on('error', () => resolve(false));
      req.setTimeout(2000, () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  /**
   * Auto-detect dev server command from package.json.
   */
  static detectDevCommand(workspaceRoot: string): string | null {
    const pkgPath = path.join(workspaceRoot, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const scripts = pkg.scripts || {};
      // Priority order: dev, start, serve
      for (const name of ['dev', 'start', 'serve']) {
        if (scripts[name]) {
          return `npm run ${name}`;
        }
      }
    } catch {
      // No package.json or parse error
    }
    return null;
  }

  /**
   * Stop the dev server for a panel — killing the whole process TREE, not just
   * the `shell: true` wrapper we spawned. On POSIX the server was spawned
   * detached (its own process group), so owned cleanup signals the group
   * (SIGTERM, then SIGKILL after the grace period); on Windows it uses
   * `taskkill /PID <pid> /T /F`. Signalling only the shell pid (the old
   * behaviour) orphaned the real node/vite child.
   */
  async stop(panelId: string): Promise<void> {
    const entries = new Set([...this._pendingCleanup].filter(([, key]) => key === panelId).map(([entry]) => entry));
    const entry = this._processes.get(panelId);
    if (entry) { entries.add(entry); }
    await Promise.all([...entries].map(value => this._stopEntry(panelId, value)));
  }

  private _stopEntry(panelId: string, entry: DevServerProcess): Promise<void> {
    if (entry.stopping) { return entry.stopping; }
    if (this._processes.get(panelId) === entry) { this._processes.delete(panelId); }
    const proc = entry.process;
    if (typeof proc.pid !== 'number') { return Promise.resolve(); }
    const pid = proc.pid;
    this._pendingCleanup.set(entry, panelId);
    // Retrying a dead root could target a recycled PID/group. Keep the failed
    // exact handle for truthful reporting, but never grant fresh signal authority.
    if (entry.cleanupFailed && !isProcessLive(proc)) {
      return Promise.reject(new Error('Visual dev-server cleanup incomplete: the failed root is no longer live; retry cannot safely identify its tree.'));
    }
    // A dead shell is not proof its group is dead. Keep escalation alive until
    // the owned group disappears or KILL has reached its remaining members.
    entry.stopping = process.platform === 'win32'
      ? this._stopWindows(proc, entry)
      : new Promise<void>((resolve, reject) => {
        let escalated = false;
        let finished = false;
        let grace: NodeJS.Timeout | undefined;
        let watchdog: NodeJS.Timeout | undefined;
        let poll: NodeJS.Timeout | undefined;
        const alive = () => {
          if (entry.groupGone) { return false; }
          try { process.kill(-pid, 0); return true; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { entry.groupGone = true; return false; } throw error; }
        };
        const finish = (error?: unknown) => {
          if (finished) { return; } finished = true;
          clearTimeout(grace); clearTimeout(watchdog); clearInterval(poll);
          proc.removeListener('close', check);
          if (error) { reject(error); } else { resolve(); }
        };
        const check = () => {
          try {
            if (escalated) { if (entry.closed) { finish(); } return; }
            if (!alive() && entry.closed) { finish(); }
          }
          catch (error) { finish(error); }
        };
        const signal = (value: NodeJS.Signals) => {
          if (entry.groupGone) { return; }
          try { process.kill(-pid, value); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error; } entry.groupGone = true; }
        };
        try {
          if (alive()) {
            if (!isProcessLive(proc)) { throw new Error('Visual dev-server cleanup incomplete: the root exited before tree ownership could be confirmed.'); }
            signal('SIGTERM');
          }
          proc.on('close', check);
          check(); if (finished) { return; }
          grace = setTimeout(() => {
            try { if (!entry.groupGone) { signal('SIGKILL'); escalated = true; } check(); }
            catch (error) { finish(error); }
          }, VISUAL_TEST_SERVER_KILL_GRACE_MS);
          poll = setInterval(check, 50);
          watchdog = setTimeout(() => finish(new Error('Visual dev-server cleanup incomplete: owned process closure was not confirmed.')),
            VISUAL_TEST_SERVER_KILL_GRACE_MS + 1000);
        } catch (error) { finish(error); }
      });
    entry.stopping = entry.stopping.then(() => { this._pendingCleanup.delete(entry); }, error => {
      entry.cleanupFailed = true;
      entry.stopping = undefined;
      // Unconfirmed descendants are reported, but their inherited streams must
      // not hold the extension/test runner open indefinitely.
      proc.stdout?.destroy(); proc.stderr?.destroy(); proc.unref();
      throw error;
    });
    return entry.stopping;
  }

  private async _stopWindows(proc: ChildProcess, entry: DevServerProcess): Promise<void> {
    // Taskkill cannot reliably discover descendants once their root exited.
    if (!isProcessLive(proc)) {
      throw new Error('Visual dev-server cleanup incomplete: the Windows root exited before tree closure was confirmed.');
    }
    const helper = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    let onError!: (error: Error) => void;
    let onExit!: (code: number | null) => void;
    let helperFinished = false;
    try {
      await awaitVisualCleanup(new Promise<void>((resolve, reject) => {
        onError = error => { helperFinished = true; reject(error); };
        onExit = code => { helperFinished = true; code === 0 ? resolve() : reject(new Error(`Visual dev-server taskkill failed (${code}).`)); };
        helper.once('error', onError); helper.once('exit', onExit);
      }), 'Visual dev-server tree');
    } finally {
      helper.removeListener('error', onError); helper.removeListener('exit', onExit);
      if (!helperFinished) { helper.on('error', () => {}); helper.kill(); helper.unref(); }
    }
    if (!entry.closed) {
      let onClose!: () => void;
      try { await awaitVisualCleanup(new Promise<void>(resolve => { onClose = resolve; proc.once('close', onClose); }), 'Visual dev-server pipes'); }
      finally { proc.removeListener('close', onClose); }
    }

  }

  /**
   * Check if a dev server is running for a panel.
   */
  isRunning(panelId: string): boolean {
    const entry = this._processes.get(panelId);
    // W4 review: exitCode-only misses a signal-killed process (exitCode stays
    // null, signalCode set) — real liveness, same lesson as processKill B3/B4.
    return !!entry && isProcessLive(entry.process);
  }

  /**
   * Get the URL of a running dev server.
   */
  getUrl(panelId: string): string | null {
    return this._processes.get(panelId)?.url || null;
  }

  /**
   * Dispose all dev servers.
   */
  async dispose(): Promise<void> {
    const entries = new Map([...this._pendingCleanup, ...[...this._processes].map(([key, entry]) => [entry, key] as const)]);
    await Promise.all([...entries].map(([entry, key]) => this._stopEntry(key, entry)));
  }
}
