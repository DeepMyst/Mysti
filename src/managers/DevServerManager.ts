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
import { killProcessTree, isProcessLive } from '../utils/processKill';

interface DevServerProcess {
  process: ChildProcess;
  url: string;
  pid: number;
  stdout: string;
  stderr: string;
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
    expectedUrl?: string
  ): Promise<{ url: string; pid: number }> {
    // Stop any existing process for this panel
    await this.stop(panelId);

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
      stderr: ''
    };

    this._processes.set(panelId, entry);

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

    try {
      const url = await this._waitForReady(panelId, pattern, VISUAL_TEST_SERVER_STARTUP_TIMEOUT_MS, expectedUrl);
      entry.url = url;
      return { url, pid: entry.pid };
    } catch (err) {
      // A server that never became ready is still a live process — reap it here
      // rather than relying on every caller's error path to do it.
      await this.stop(panelId).catch(() => { /* best effort */ });
      throw err;
    }
  }

  /**
   * Wait for server readiness by watching stdout, then HTTP polling as fallback.
   */
  private async _waitForReady(
    panelId: string,
    pattern: RegExp,
    timeoutMs: number,
    expectedUrl?: string
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
          const isUp = await this._httpCheck(fallbackUrl);
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
  private _httpCheck(url: string): Promise<boolean> {
    return new Promise((resolve) => {
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
   * detached (its own process group), so killProcessTree signals the group
   * (SIGTERM, then SIGKILL after the grace period); on Windows it uses
   * `taskkill /PID <pid> /T /F`. Signalling only the shell pid (the old
   * behaviour) orphaned the real node/vite child.
   */
  async stop(panelId: string): Promise<void> {
    const entry = this._processes.get(panelId);
    if (!entry) { return; }

    await killProcessTree(entry.process, VISUAL_TEST_SERVER_KILL_GRACE_MS, {
      useProcessGroup: process.platform !== 'win32',
      label: `DevServer(${panelId})`
    });

    this._processes.delete(panelId);
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
    const stops = Array.from(this._processes.keys()).map(id => this.stop(id));
    await Promise.all(stops);
  }
}
