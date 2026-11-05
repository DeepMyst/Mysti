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
 *
 * AgentLifecycleManager child-process tracking tests (B16). The hadChildren
 * snapshot must be read BEFORE trackedChildPids is reassigned — the old code
 * read it after, so it always reflected the NEW state and neither
 * 'children-detected' nor 'children-cleared' could ever fire. Also verifies
 * registerProcessPid (previously inert — it had no callers) actually feeds
 * lastKnownPid into the child scan.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import type { LifecycleEvent } from '../../src/types';
import { setMockConfig, clearMockConfig, clearConfigurationListeners } from '../helpers/mockVscode';

// Mock the process-tree probing so tests are deterministic and never spawn pgrep.
const getChildPids = vi.fn<(pid: number) => Promise<number[]>>();
const isProcessAlive = vi.fn<(pid: number) => Promise<boolean>>();
vi.mock('../../src/utils/processTree', () => ({
  getChildPids: (pid: number) => getChildPids(pid),
  isProcessAlive: (pid: number) => isProcessAlive(pid),
}));

import { AgentLifecycleManager } from '../../src/managers/AgentLifecycleManager';

function createMockContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    globalState: { get: () => undefined, update: () => Promise.resolve(), keys: () => [], setKeysForSync: () => {} },
  } as unknown as vscode.ExtensionContext;
}

describe('AgentLifecycleManager child tracking (B16)', () => {
  let manager: AgentLifecycleManager;

  beforeEach(() => {
    clearMockConfig();
    getChildPids.mockReset();
    isProcessAlive.mockReset();
    // Keep idle timers/scan interval from firing during the test.
    setMockConfig('lifecycle.enabled', true);
    setMockConfig('lifecycle.processTreeTracking', true);
    setMockConfig('lifecycle.protectActiveChildren', true);
    setMockConfig('lifecycle.idleTimeoutMinutes', 60);
    setMockConfig('lifecycle.checkIntervalSeconds', 600);
    manager = new AgentLifecycleManager(createMockContext());
  });

  afterEach(() => {
    manager.dispose();
    clearMockConfig();
    clearConfigurationListeners();
    vi.restoreAllMocks();
  });

  it('emits children-detected on first scan and children-cleared once they go away (hadChildren snapshot)', async () => {
    const events: LifecycleEvent[] = [];
    manager.onLifecycleEvent((e) => events.push(e));

    manager.registerSession('panel-A', 'claude-code', 'sess-1');
    manager.registerProcessPid('panel-A', 1000); // B16: lastKnownPid now populated

    // Scan 1: a fresh child appears -> children-detected must fire.
    getChildPids.mockResolvedValueOnce([2001]);
    const had = await manager.hasActiveChildren('panel-A');
    expect(had).toBe(true);

    const detected = events.filter((e) => e.type === 'children-detected');
    expect(detected).toHaveLength(1);
    expect(detected[0].childPids).toEqual([2001]);
    expect(events.some((e) => e.type === 'children-cleared')).toBe(false);

    // Scan 2: the child is gone (no new children, tracked one now dead)
    // -> children-cleared must fire exactly once.
    getChildPids.mockResolvedValueOnce([]);
    isProcessAlive.mockResolvedValue(false);
    const stillHas = await manager.hasActiveChildren('panel-A');
    expect(stillHas).toBe(false);

    const cleared = events.filter((e) => e.type === 'children-cleared');
    expect(cleared).toHaveLength(1);
  });

  it('does not re-emit children-detected when the same children persist across scans', async () => {
    const events: LifecycleEvent[] = [];
    manager.onLifecycleEvent((e) => events.push(e));

    manager.registerSession('panel-B', 'openai-codex', null);
    manager.registerProcessPid('panel-B', 1500);

    getChildPids.mockResolvedValue([3001]); // same child on every scan
    isProcessAlive.mockResolvedValue(true);

    await manager.hasActiveChildren('panel-B');
    await manager.hasActiveChildren('panel-B');
    await manager.hasActiveChildren('panel-B');

    // Detected fires exactly once (transition none -> some), not per-scan.
    expect(events.filter((e) => e.type === 'children-detected')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'children-cleared')).toHaveLength(0);
  });

  it('scans children of the PID supplied via registerProcessPid (B16 wiring)', async () => {
    manager.registerSession('panel-C', 'google-gemini', null);
    manager.registerProcessPid('panel-C', 4242);

    getChildPids.mockResolvedValue([]);
    isProcessAlive.mockResolvedValue(false);

    await manager.hasActiveChildren('panel-C');

    expect(getChildPids).toHaveBeenCalledWith(4242);
  });

  it('does not scan when no PID has been registered for the session', async () => {
    manager.registerSession('panel-D', 'claude-code', null);
    // No registerProcessPid -> lastKnownPid stays null.

    getChildPids.mockResolvedValue([9999]);
    const had = await manager.hasActiveChildren('panel-D');

    expect(had).toBe(false);
    expect(getChildPids).not.toHaveBeenCalled();
  });

  const deferredScan = () => {
    let resolve!: (children: number[]) => void;
    getChildPids.mockImplementationOnce(() => new Promise<number[]>(done => { resolve = done; }));
    return (children: number[] = []) => resolve(children);
  };
  const idleSession = () => {
    manager.registerSession('panel', 'openai-codex', 'old-thread');
    manager.registerProcessPid('panel', 1000);
    manager.markIdle('panel');
  };

  it.each(['busy', 'busy-then-idle', 'touch', 'replace'] as const)(
    'an idle expiry scan cannot expire a session after %s activity', async action => {
      vi.spyOn(Date, 'now').mockReturnValue(5000); // Activity can share one millisecond.
      idleSession();
      const events: LifecycleEvent[] = [];
      manager.onLifecycleEvent(event => events.push(event));
      const release = deferredScan();
      const expired = (manager as any)._handleIdleTimeout((manager as any)._sessions.get('panel'));
      if (action === 'replace') {
        manager.removeSession('panel');
        manager.registerSession('panel', 'claude-code', 'new-thread');
        manager.markIdle('panel');
      } else if (action === 'touch') manager.touchSession('panel');
      else {
        manager.markBusy('panel');
        if (action === 'busy-then-idle') manager.markIdle('panel');
      }
      release(); await expired;
      expect(manager.getSession('panel')).toMatchObject({ sessionId: action === 'replace' ? 'new-thread' : 'old-thread' });
      expect(events.filter(event => event.type === 'session-expired')).toEqual([]);
    },
  );

  it.each(['busy', 'replace'] as const)('delayed explicit shutdown abandons a %s successor', async action => {
    idleSession();
    const events: LifecycleEvent[] = [];
    manager.onLifecycleEvent(event => events.push(event));
    const release = deferredScan();
    const shutdown = manager.requestShutdown('panel');
    if (action === 'replace') {
      manager.removeSession('panel');
      manager.registerSession('panel', 'claude-code', 'new-thread');
    } else manager.markBusy('panel');
    release();
    expect(await shutdown).toMatchObject({ success: false });
    expect(manager.getSession('panel')).not.toBeNull();
    expect(events.filter(event => event.type === 'session-shutdown')).toEqual([]);
  });

  it('nonforce shutdown blocks an active turn without scanning or killing it; force targets that same turn', async () => {
    idleSession(); manager.markBusy('panel');
    const events: LifecycleEvent[] = [];
    manager.onLifecycleEvent(event => events.push(event));
    expect(await manager.requestShutdown('panel')).toMatchObject({ success: false, blocked: true, reason: expect.stringMatching(/stop/i) });
    expect(getChildPids).not.toHaveBeenCalled();
    expect(manager.getSession('panel')?.status).toBe('busy');
    expect(await manager.requestShutdown('panel', true)).toEqual({ success: true, blocked: false });
    expect(events.filter(event => event.type === 'session-shutdown')).toHaveLength(1);
  });

  it.each(['shutdown', 'expiry'] as const)('%s callbacks cannot erase a synchronously registered replacement', async action => {
    idleSession();
    getChildPids.mockResolvedValue([]);
    manager.onLifecycleEvent(event => {
      if (event.type === (action === 'shutdown' ? 'session-shutdown' : 'session-expired')) {
        manager.registerSession('panel', 'claude-code', 'replacement-thread');
        manager.markBusy('panel');
      }
    });
    if (action === 'shutdown') await manager.requestShutdown('panel', true);
    else await (manager as any)._handleIdleTimeout((manager as any)._sessions.get('panel'));
    expect(manager.getSession('panel')).toMatchObject({ sessionId: 'replacement-thread', status: 'busy' });
  });

  it('a late child scan cannot attach old PIDs or publish activity for a replacement runtime', async () => {
    idleSession();
    const events: LifecycleEvent[] = [];
    manager.onLifecycleEvent(event => events.push(event));
    const release = deferredScan();
    const scan = manager.hasActiveChildren('panel');
    manager.registerSession('panel', 'claude-code', 'new-thread');
    manager.registerProcessPid('panel', 3000);
    release([2000]); await scan;
    expect(manager.getSession('panel')).toMatchObject({ providerId: 'claude-code', childPids: [] });
    expect(events.filter(event => event.type === 'children-detected')).toEqual([]);
  });

  it('an overlapping child observer cannot consume the only idle expiry decision', async () => {
    idleSession();
    const release = deferredScan();
    const expired = (manager as any)._handleIdleTimeout((manager as any)._sessions.get('panel'));
    const observed = manager.hasActiveChildren('panel');
    expect(getChildPids).toHaveBeenCalledOnce();
    release(); await Promise.all([expired, observed]);
    expect(manager.getSession('panel')).toBeNull();
  });

  it('retains a runtime PID registered before its first native session event and preserves provider attribution', async () => {
    const events: LifecycleEvent[] = [];
    manager.onLifecycleEvent(event => events.push(event));
    manager.registerProcessPid('fresh', 8080, 'openai-codex');
    manager.registerSession('fresh', 'openai-codex', 'native-thread');
    manager.markIdle('fresh');
    getChildPids.mockResolvedValue([8081]);
    expect(await manager.requestShutdown('fresh')).toMatchObject({ success: false, blocked: true, childPids: [8081] });
    expect(getChildPids).toHaveBeenCalledExactlyOnceWith(8080);
    expect(events.filter(event => event.type === 'session-started')).toEqual([
      expect.objectContaining({ panelId: 'fresh', providerId: 'openai-codex' }),
    ]);
    expect(manager.getSession('fresh')).toMatchObject({ providerId: 'openai-codex', sessionId: 'native-thread' });
  });

  it.each(['busy', 'children'] as const)('direct shutdown publishes exactly one blocked event for %s', async reason => {
    idleSession();
    if (reason === 'busy') manager.markBusy('panel');
    else getChildPids.mockResolvedValue([2000]);
    const events: LifecycleEvent[] = [];
    manager.onLifecycleEvent(event => events.push(event));
    const result = await manager.requestShutdown('panel');
    expect(result.blocked).toBe(true);
    expect(events.filter(event => event.type === 'shutdown-blocked')).toEqual([
      expect.objectContaining({ panelId: 'panel', providerId: 'openai-codex', detail: expect.any(String) }),
    ]);
  });
});
