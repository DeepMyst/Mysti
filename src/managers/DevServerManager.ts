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
import * as path from 'path';
import * as fs from 'fs';
import {
  VISUAL_TEST_SERVER_STARTUP_TIMEOUT_MS,
  VISUAL_TEST_SERVER_HEALTH_POLL_MS,
  VISUAL_TEST_SERVER_KILL_GRACE_MS
} from '../constants';

interface DevServerProcess {
  process: ChildProcess;
  url: string;
  pid: number;
  stdout: string;
  stderr: string;
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
   */
  async start(
    panelId: string,
    command: string,
    cwd: string,
    readyPattern?: string
  ): Promise<{ url: string; pid: number }> {
    // Stop any existing process for this panel
    await this.stop(panelId);

    const args = command.split(' ');
    const cmd = args.shift()!;
    const proc = spawn(cmd, args, {
      cwd,
      shell: true,
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

    proc.stdout?.on('data', (data: Buffer) => {
      entry.stdout += data.toString();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      entry.stderr += data.toString();
    });

    proc.on('error', (err) => {
      console.error(`[Mysti] DevServer error for ${panelId}:`, err.message);
    });

    proc.on('exit', (code) => {
      console.log(`[Mysti] DevServer exited for ${panelId} with code ${code}`);
    });

    // Wait for server to be ready
    const pattern = new RegExp(
      readyPattern || 'localhost:\\d+|127\\.0\\.0\\.1:\\d+|ready in|compiled successfully|VITE|started server on',
      'i'
    );

    const url = await this._waitForReady(panelId, pattern, VISUAL_TEST_SERVER_STARTUP_TIMEOUT_MS);
    entry.url = url;

    return { url, pid: entry.pid };
  }

  /**
   * Wait for server readiness by watching stdout, then HTTP polling as fallback.
   */
  private async _waitForReady(
    panelId: string,
    pattern: RegExp,
    timeoutMs: number
  ): Promise<string> {
    const entry = this._processes.get(panelId);
    if (!entry) { throw new Error('Dev server not started'); }

    const startTime = Date.now();

    return new Promise<string>((resolve, reject) => {
      let resolved = false;

      // Watch stdout for ready pattern
      const checkOutput = () => {
        if (resolved) { return; }
        const combined = entry.stdout + entry.stderr;
        const match = combined.match(pattern);
        if (match) {
          resolved = true;
          // Try to extract URL from output
          const urlMatch = combined.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+/);
          resolve(urlMatch ? urlMatch[0] : 'http://localhost:3000');
        }
      };

      entry.process.stdout?.on('data', () => checkOutput());
      entry.process.stderr?.on('data', () => checkOutput());

      // Fallback: HTTP poll
      const pollInterval = setInterval(async () => {
        if (resolved) {
          clearInterval(pollInterval);
          return;
        }

        if (Date.now() - startTime > timeoutMs) {
          clearInterval(pollInterval);
          if (!resolved) {
            resolved = true;
            reject(new Error(`Dev server did not become ready within ${timeoutMs / 1000}s`));
          }
          return;
        }

        // Try HTTP GET
        try {
          const isUp = await this._httpCheck('http://localhost:3000');
          if (isUp && !resolved) {
            resolved = true;
            clearInterval(pollInterval);
            resolve('http://localhost:3000');
          }
        } catch {
          // Not ready yet
        }
      }, VISUAL_TEST_SERVER_HEALTH_POLL_MS);

      // Handle process exit before ready
      entry.process.on('exit', (code) => {
        if (!resolved) {
          resolved = true;
          clearInterval(pollInterval);
          reject(new Error(`Dev server exited with code ${code} before becoming ready.\nstderr: ${entry.stderr.slice(-500)}`));
        }
      });
    });
  }

  /**
   * Simple HTTP health check.
   */
  private _httpCheck(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(url, (res) => {
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
   * Stop the dev server for a panel.
   */
  async stop(panelId: string): Promise<void> {
    const entry = this._processes.get(panelId);
    if (!entry) { return; }

    const proc = entry.process;
    if (proc.exitCode !== null) {
      this._processes.delete(panelId);
      return;
    }

    // SIGTERM first
    proc.kill('SIGTERM');

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        // Force kill after grace period
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
        resolve();
      }, VISUAL_TEST_SERVER_KILL_GRACE_MS);

      proc.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this._processes.delete(panelId);
  }

  /**
   * Check if a dev server is running for a panel.
   */
  isRunning(panelId: string): boolean {
    const entry = this._processes.get(panelId);
    return !!entry && entry.process.exitCode === null;
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
