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
 * Unit tests for DevServerManager (Plan 18 Wave 4 item 1.2).
 *
 * The dev server is spawned with `shell: true`, so the tracked pid is a shell
 * wrapper (`sh -c "npm run dev"` / cmd.exe). The old stop() SIGTERM'd only that
 * wrapper, orphaning the real node/vite child. These tests pin the fix:
 *   - POSIX: spawn `detached: true` (own process group) and stop() signals the
 *     whole group via the negative pid (SIGTERM → SIGKILL escalation)
 *   - Windows: spawn non-detached and stop() runs `taskkill /PID <pid> /T /F`
 */
import { EventEmitter } from 'events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'child_process';
import { DevServerManager } from '../../src/managers/DevServerManager';
import { VISUAL_TEST_SERVER_KILL_GRACE_MS } from '../../src/constants';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

const spawnMock = vi.mocked(spawn);

const REAL_PLATFORM = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

/** Fake dev-server ChildProcess: EventEmitter + piped stdout/stderr + kill(). */
class FakeChild extends EventEmitter {
  public pid = 777;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public killed = false;
  public readonly signals: NodeJS.Signals[] = [];
  public stdout = new EventEmitter();
  public stderr = new EventEmitter();

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push((signal ?? 'SIGTERM') as NodeJS.Signals);
    this.killed = true;
    return true;
  }

  simulateExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

/**
 * Start a dev server against a FakeChild and drive it to "ready" by emitting a
 * matching stdout line (event-driven — no timers involved).
 */
async function startServer(
  mgr: DevServerManager,
  child: FakeChild,
  panelId = 'panel-1'
): Promise<{ url: string; pid: number }> {
  spawnMock.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const startPromise = mgr.start(panelId, 'npm run dev', '/mock/workspace');
  // start() awaits stop() before spawning — yield a tick so listeners attach.
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.emit('data', Buffer.from('VITE v5 ready at http://localhost:5173'));
  return startPromise;
}

describe('DevServerManager', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    spawnMock.mockReset();
    setPlatform('darwin');
  });

  afterEach(() => {
    setPlatform(REAL_PLATFORM);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('start()', () => {
    it('spawns the dev server DETACHED on POSIX (its own process group)', async () => {
      const mgr = new DevServerManager();
      const child = new FakeChild();

      const { url, pid } = await startServer(mgr, child);

      expect(url).toBe('http://localhost:5173');
      expect(pid).toBe(777);
      expect(spawnMock).toHaveBeenCalledWith(
        'npm',
        ['run', 'dev'],
        expect.objectContaining({ shell: true, detached: true })
      );
      expect(mgr.isRunning('panel-1')).toBe(true);
    });

    it('spawns NON-detached on Windows (taskkill /T handles the tree there)', async () => {
      setPlatform('win32');
      const mgr = new DevServerManager();
      const child = new FakeChild();

      await startServer(mgr, child);

      expect(spawnMock).toHaveBeenCalledWith(
        'npm',
        ['run', 'dev'],
        expect.objectContaining({ shell: true, detached: false })
      );
    });
  });

  describe('stop()', () => {
    it('POSIX: signals the whole process group (negative pid), not just the shell', async () => {
      const mgr = new DevServerManager();
      const child = new FakeChild();
      await startServer(mgr, child);

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const stopPromise = mgr.stop('panel-1');

      // Group signal to -pid — a plain child.kill('SIGTERM') would orphan the
      // real dev server under the shell wrapper.
      expect(killSpy).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
      expect(child.signals).toEqual([]);

      child.simulateExit(null, 'SIGTERM');
      await stopPromise;

      expect(mgr.isRunning('panel-1')).toBe(false);
      expect(mgr.getUrl('panel-1')).toBeNull();
    });

    it('POSIX: escalates to a group SIGKILL when the server ignores SIGTERM', async () => {
      const mgr = new DevServerManager();
      const child = new FakeChild();
      await startServer(mgr, child);

      vi.useFakeTimers();
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const stopPromise = mgr.stop('panel-1');
      expect(killSpy).toHaveBeenCalledWith(-child.pid, 'SIGTERM');

      await vi.advanceTimersByTimeAsync(VISUAL_TEST_SERVER_KILL_GRACE_MS);
      expect(killSpy).toHaveBeenCalledWith(-child.pid, 'SIGKILL');

      await stopPromise;
      expect(mgr.isRunning('panel-1')).toBe(false);
    });

    it('Windows: kills the tree via `taskkill /PID <pid> /T /F`', async () => {
      setPlatform('win32');
      const mgr = new DevServerManager();
      const child = new FakeChild();
      await startServer(mgr, child);

      const taskkill = new EventEmitter();
      spawnMock.mockReturnValueOnce(taskkill as unknown as ReturnType<typeof spawn>);

      const stopPromise = mgr.stop('panel-1');

      expect(spawnMock).toHaveBeenLastCalledWith(
        'taskkill',
        ['/PID', String(child.pid), '/T', '/F'],
        expect.objectContaining({ windowsHide: true })
      );
      // No raw single-pid signal — that would kill only the cmd.exe shim.
      expect(child.signals).toEqual([]);

      taskkill.emit('exit', 0);
      child.simulateExit(1);
      await stopPromise;

      expect(mgr.isRunning('panel-1')).toBe(false);
    });

    it('is a no-op for an unknown panel', async () => {
      const mgr = new DevServerManager();
      await expect(mgr.stop('nope')).resolves.toBeUndefined();
    });

    it('just clears tracking when the server already exited (no signals sent)', async () => {
      const mgr = new DevServerManager();
      const child = new FakeChild();
      await startServer(mgr, child);

      child.simulateExit(0);

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      await mgr.stop('panel-1');

      expect(child.signals).toEqual([]);
      expect(killSpy).not.toHaveBeenCalledWith(-child.pid, expect.anything());
      expect(mgr.isRunning('panel-1')).toBe(false);
    });
  });
});
