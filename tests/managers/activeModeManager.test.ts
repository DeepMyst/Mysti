/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 27 §21.6c #10 (lane N-2) — `mysti.activeMode.autoStartDaemon`.
 *
 * The setting shipped declared, window-scoped, default false and READ BY
 * NOTHING. Its description promised "Automatically start OpenClaw daemon if
 * not running on extension activation"; the only thing that ever started the
 * daemon was the webview's Start button (`startDaemon()` → `exec('openclaw
 * gateway start')`). This wires the setting to that same method, behind
 * two gates a repository cannot open: the setting is machine-scoped, and the
 * workspace must be trusted. The daemon is only started when the first
 * connect attempt fails — an already-running gateway is never re-spawned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exec } from 'child_process';
import * as vscode from 'vscode';
import { setMockConfig, clearMockConfig } from '../helpers/mockVscode';

const execState = vi.hoisted(() => ({ error: new Error('mocked exec') as Error | null }));

vi.mock('child_process', () => ({
  exec: vi.fn((_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
    // Default to failure so auto-start tests do not arm the 3 s reconnect timer.
    cb?.(execState.error);
    return {} as unknown;
  }),
}));

const gatewayState = { connected: false };

vi.mock('../../src/providers/openclaw/OpenClawGateway', () => ({
  OpenClawGateway: class {
    async connect(): Promise<boolean> { return gatewayState.connected; }
    isConnected(): boolean { return gatewayState.connected; }
    disconnect(): void { /* noop */ }
    async getGatewayStatus() { return null; }
    async listChannels() { return []; }
    async getActivityLog() { return []; }
    subscribeToChannelEvents() { return () => {}; }
  },
}));

import { ActiveModeManager } from '../../src/managers/ActiveModeManager';

const execMock = vi.mocked(exec);
const mockWorkspace = vscode.workspace as unknown as { isTrusted?: boolean };

/**
 * `initialize()` fires `startDaemon()` without awaiting it (fire-and-forget by
 * design — activation must not block on a spawn), and `startDaemon()` reaches
 * `exec` only after `await import('child_process')`. Let those ticks run so
 * that the NEGATIVE assertions below are not vacuous.
 */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 25));
}

function daemonStartCommands(): string[] {
  return execMock.mock.calls
    .map(c => String(c[0]))
    .filter(cmd => cmd.startsWith('openclaw gateway'));
}

function manager(): ActiveModeManager {
  const m = new ActiveModeManager({} as unknown as vscode.ExtensionContext);
  // The CLI is "installed" and skills fetching (a real `require('child_process')`
  // exec the module mock cannot intercept) is a no-op for these tests.
  vi.spyOn(m as unknown as { _detectCli(): Promise<boolean> }, '_detectCli').mockResolvedValue(true);
  vi.spyOn(m as unknown as { _fetchSkills(): void }, '_fetchSkills').mockImplementation(() => {});
  // Never let a failed connect arm the 60 s reconnect timer in a test.
  vi.spyOn(m as unknown as { _scheduleReconnect(): void }, '_scheduleReconnect').mockImplementation(() => {});
  return m;
}

describe('ActiveModeManager — mysti.activeMode.autoStartDaemon (Plan 27 N-2)', () => {
  let m: ActiveModeManager | undefined;

  beforeEach(() => {
    clearMockConfig();
    execMock.mockClear();
    execState.error = new Error('mocked exec');
    gatewayState.connected = false;
    delete mockWorkspace.isTrusted;
  });

  afterEach(() => {
    m?.dispose();
    m = undefined;
    vi.useRealTimers();
    delete mockWorkspace.isTrusted;
    clearMockConfig();
  });

  it('default (off): a daemon that is not reachable is NOT started', async () => {
    mockWorkspace.isTrusted = true;
    m = manager();
    await m.initialize();
    await settle();
    expect(daemonStartCommands()).toEqual([]);
  });

  it('on + trusted workspace + daemon unreachable: issues `openclaw gateway start` once', async () => {
    setMockConfig('activeMode.autoStartDaemon', true);
    mockWorkspace.isTrusted = true;
    m = manager();
    await m.initialize();
    await settle();
    expect(daemonStartCommands()).toEqual(['openclaw gateway start']);
  });

  it('reports success only after the service command succeeds and the gateway connects', async () => {
    vi.useFakeTimers();
    execState.error = null;
    gatewayState.connected = true;
    m = manager();
    const connect = vi.spyOn(m as unknown as { _connectAndStartPolling(): Promise<void> }, '_connectAndStartPolling');

    const result = m.startDaemon();
    await vi.advanceTimersByTimeAsync(3000);

    await expect(result).resolves.toBe(true);
    expect(daemonStartCommands()).toEqual(['openclaw gateway start']);
    expect(connect).toHaveBeenCalledOnce();
  });

  it('returns false without a fallback when the service command fails', async () => {
    m = manager();
    const connect = vi.spyOn(m as unknown as { _connectAndStartPolling(): Promise<void> }, '_connectAndStartPolling');

    await expect(m.startDaemon()).resolves.toBe(false);

    expect(daemonStartCommands()).toEqual(['openclaw gateway start']);
    expect(connect).not.toHaveBeenCalled();
  });

  it('returns false without a fallback when the CLI exits zero but no gateway connects', async () => {
    // OpenClaw can report a missing service installation with exit code zero.
    vi.useFakeTimers();
    execState.error = null;
    m = manager();
    const connect = vi.spyOn(m as unknown as { _connectAndStartPolling(): Promise<void> }, '_connectAndStartPolling');

    const result = m.startDaemon();
    await vi.advanceTimersByTimeAsync(3000);

    await expect(result).resolves.toBe(false);
    expect(daemonStartCommands()).toEqual(['openclaw gateway start']);
    expect(connect).toHaveBeenCalledOnce();
  });

  it('on but UNTRUSTED workspace: never starts the daemon (a repo cannot buy a process by being opened)', async () => {
    setMockConfig('activeMode.autoStartDaemon', true);
    mockWorkspace.isTrusted = false;
    m = manager();
    await m.initialize();
    await settle();
    expect(daemonStartCommands()).toEqual([]);
  });

  it('on but trust state UNKNOWN (isTrusted undefined): treated as untrusted', async () => {
    setMockConfig('activeMode.autoStartDaemon', true);
    m = manager();
    await m.initialize();
    await settle();
    expect(daemonStartCommands()).toEqual([]);
  });

  it('on + trusted, but the daemon is already reachable: nothing is spawned', async () => {
    setMockConfig('activeMode.autoStartDaemon', true);
    mockWorkspace.isTrusted = true;
    gatewayState.connected = true;
    m = manager();
    await m.initialize();
    await settle();
    expect(daemonStartCommands()).toEqual([]);
  });

  it('a non-boolean value (a hand-edited settings file) does not count as "on"', async () => {
    setMockConfig('activeMode.autoStartDaemon', 'true');
    mockWorkspace.isTrusted = true;
    m = manager();
    await m.initialize();
    await settle();
    expect(daemonStartCommands()).toEqual([]);
  });

  it('activeMode.enabled=false short-circuits before any auto-start', async () => {
    setMockConfig('activeMode.enabled', false);
    setMockConfig('activeMode.autoStartDaemon', true);
    mockWorkspace.isTrusted = true;
    m = manager();
    await m.initialize();
    await settle();
    expect(daemonStartCommands()).toEqual([]);
  });
});
