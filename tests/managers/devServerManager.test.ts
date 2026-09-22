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
import { VisualOperationCancelled } from '../../src/services/VisualOperation';
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
  public stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  public stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  public unref = vi.fn();

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push((signal ?? 'SIGTERM') as NodeJS.Signals);
    this.killed = true;
    return true;
  }

  simulateExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
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

      const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
        if (signal === 0 && (child.exitCode !== null || child.signalCode !== null)) { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }
        if (signal === 'SIGKILL') { child.simulateExit(null, 'SIGKILL'); }
        return true;
      });

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
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
        if (signal === 0 && (child.exitCode !== null || child.signalCode !== null)) { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }
        if (signal === 'SIGKILL') { child.simulateExit(null, 'SIGKILL'); }
        return true;
      });

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

      const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
        if (signal === 0 && (child.exitCode !== null || child.signalCode !== null)) { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }
        if (signal === 'SIGKILL') { child.simulateExit(null, 'SIGKILL'); }
        return true;
      });
      await mgr.stop('panel-1');

      expect(child.signals).toEqual([]);
      expect(killSpy.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
      expect(mgr.isRunning('panel-1')).toBe(false);
    });
  });
  it('refuses an already aborted start before touching any process', async () => {
    const manager = new DevServerManager(); const controller = new AbortController(); controller.abort();
    await expect(manager.start('owned', 'inert', '/inert', undefined, undefined,
      { signal: controller.signal, isCurrent: () => true })).rejects.toBeInstanceOf(VisualOperationCancelled);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rechecks Stop after waiting for the prior process, before spawning', async () => {
    const manager = new DevServerManager(); const controller = new AbortController(); let release!: () => void;
    vi.spyOn(manager, 'stop').mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const pending = manager.start('owned', 'inert', '/inert', undefined, undefined,
      { signal: controller.signal, isCurrent: () => true });
    controller.abort(); release(); await expect(pending).rejects.toBeInstanceOf(VisualOperationCancelled);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('aborting readiness stops the exact owned process and removes its waiter listeners', async () => {
    const manager = new DevServerManager(); const controller = new AbortController(); const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (child.signalCode !== null) { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }
      if (signal === 'SIGTERM') { child.simulateExit(null, 'SIGTERM'); } return true;
    });
    const pending = manager.start('owned', 'inert', '/inert', undefined, 'http://127.0.0.1:9',
      { signal: controller.signal, isCurrent: () => true });
    const rejected = expect(pending).rejects.toBeInstanceOf(VisualOperationCancelled);
    await new Promise(resolve => setImmediate(resolve)); controller.abort(); await rejected;
    expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM'); expect(manager.isRunning('owned')).toBe(false);
    expect(child.stdout.listenerCount('data')).toBe(1); expect(child.listenerCount('exit')).toBe(1);
  });

  it('Windows dead root reports unconfirmed descendants even when its own pipes closed', async () => {
    setPlatform('win32'); const manager = new DevServerManager(); const child = new FakeChild();
    await startServer(manager, child); child.simulateExit(0);
    await expect(manager.stop('panel-1')).rejects.toThrow(/cleanup incomplete/);
    expect(child.stdout.destroy).toHaveBeenCalledOnce(); expect(child.unref).toHaveBeenCalledOnce();
  });

  it('Windows failed tree helper is observed and releases owned handles without claiming cleanup', async () => {
    setPlatform('win32'); const manager = new DevServerManager(); const child = new FakeChild(); await startServer(manager, child);
    const helper = new EventEmitter(); spawnMock.mockReturnValueOnce(helper as unknown as ReturnType<typeof spawn>);
    const stopped = manager.stop('panel-1'); const rejected = expect(stopped).rejects.toThrow(/taskkill failed/);
    helper.emit('exit', 1); await rejected; expect(helper.listenerCount('exit')).toBe(0);
    expect(child.stdout.destroy).toHaveBeenCalledOnce(); expect(child.stderr.destroy).toHaveBeenCalledOnce();
  });

  it('retains a failed Windows tree and retries only that live root while a successor remains active', async () => {
    setPlatform('win32'); const manager = new DevServerManager(); const old = new FakeChild(); await startServer(manager, old, 'old');
    const failedHelper = new EventEmitter(); spawnMock.mockReturnValueOnce(failedHelper as unknown as ReturnType<typeof spawn>);
    const failed = manager.stop('old'); const rejected = expect(failed).rejects.toThrow(/taskkill failed/); failedHelper.emit('exit', 1); await rejected;
    expect((manager as any)._pendingCleanup.size).toBe(1); expect(manager.isRunning('old')).toBe(false);
    const next = new FakeChild(); next.pid = 888; await startServer(manager, next, 'new');
    const recoveredHelper = new EventEmitter(); spawnMock.mockReturnValueOnce(recoveredHelper as unknown as ReturnType<typeof spawn>);
    const recovered = manager.stop('old'); expect(spawnMock).toHaveBeenLastCalledWith('taskkill',['/PID','777','/T','/F'],expect.anything());
    recoveredHelper.emit('exit', 0); old.simulateExit(1); await recovered;
    expect((manager as any)._pendingCleanup.size).toBe(0); expect(manager.isRunning('new')).toBe(true); expect(next.signals).toEqual([]);
  });

  it('retains failed dead roots without issuing a later taskkill against a potentially recycled PID', async () => {
    setPlatform('win32'); const manager = new DevServerManager(); const child = new FakeChild(); await startServer(manager, child);
    child.simulateExit(0); await expect(manager.stop('panel-1')).rejects.toThrow(/cleanup incomplete/);
    const before = spawnMock.mock.calls.length;
    await expect(manager.dispose()).rejects.toThrow(/retry cannot safely identify/);
    expect(spawnMock).toHaveBeenCalledTimes(before); expect((manager as any)._pendingCleanup.size).toBe(1);
  });

  it('does not equate a vanished group with closed inherited pipes or signal the vanished group again', async () => {
    const manager = new DevServerManager(); const child = new FakeChild(); await startServer(manager, child); vi.useFakeTimers();
    const kill = vi.spyOn(process,'kill').mockImplementation(()=>{throw Object.assign(new Error('gone'),{code:'ESRCH'});});
    const pending = manager.stop('panel-1'); const rejected = expect(pending).rejects.toThrow(/closure was not confirmed/);
    await vi.advanceTimersByTimeAsync(VISUAL_TEST_SERVER_KILL_GRACE_MS + 1000); await rejected;
    expect(kill.mock.calls).toEqual([[-child.pid,0]]); expect(child.stdout.destroy).toHaveBeenCalledOnce();
  });

});
