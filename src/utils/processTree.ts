/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * This file is part of Mysti, licensed under the Business Source License 1.1.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: BUSL-1.1
 */

import { spawn } from 'child_process';
import { LIFECYCLE_PROCESS_SCAN_TIMEOUT_MS } from '../constants';

/**
 * Get direct child PIDs of a given parent process.
 * macOS/Linux: pgrep -P <pid>
 * Windows: wmic process where ParentProcessId=<pid> get ProcessId
 */
export async function getChildPids(parentPid: number): Promise<number[]> {
  return new Promise<number[]>((resolve) => {
    const isWindows = process.platform === 'win32';

    const cmd = isWindows ? 'wmic' : 'pgrep';
    const args = isWindows
      ? ['process', 'where', `ParentProcessId=${parentPid}`, 'get', 'ProcessId']
      : ['-P', String(parentPid)];

    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: LIFECYCLE_PROCESS_SCAN_TIMEOUT_MS,
    });

    let output = '';

    proc.stdout.on('data', (data: Buffer) => {
      output += data.toString();
    });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve([]);
    }, LIFECYCLE_PROCESS_SCAN_TIMEOUT_MS);

    proc.on('close', () => {
      clearTimeout(timer);
      const pids: number[] = [];
      const lines = output.trim().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        // Skip headers (wmic) and empty lines
        if (trimmed && /^\d+$/.test(trimmed)) {
          pids.push(parseInt(trimmed, 10));
        }
      }
      resolve(pids);
    });

    proc.on('error', () => {
      clearTimeout(timer);
      resolve([]);
    });
  });
}

/**
 * Check if a specific PID is still alive.
 * Unix: kill -0 <pid> (sends no signal, just checks existence)
 * Windows: tasklist /FI "PID eq <pid>"
 */
export async function isProcessAlive(pid: number): Promise<boolean> {
  if (process.platform === 'win32') {
    return new Promise<boolean>((resolve) => {
      const proc = spawn('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: LIFECYCLE_PROCESS_SCAN_TIMEOUT_MS,
      });

      let output = '';
      proc.stdout.on('data', (data: Buffer) => { output += data.toString(); });

      proc.on('close', () => {
        resolve(output.includes(String(pid)));
      });
      proc.on('error', () => resolve(false));
    });
  }

  // Unix: try sending signal 0 (existence check)
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
