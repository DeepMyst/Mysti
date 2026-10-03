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
});
