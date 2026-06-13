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
 * ProviderManager panel -> provider routing tests (B12). cancel/suspend/resume/
 * clearSession/disposePersistentProcess must resolve the provider that actually
 * owns the panel's running process, NOT the global default provider. Before the
 * fix these all routed to `_getDefaultProviderId()`, so cancelling a panel
 * running provider X while the default was Y did nothing on X. Also covers the
 * SIGKILL backstop (B3/B4) and the lifecycle-sink PID wiring (B16).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import type { ChildProcess } from 'child_process';
import { ProviderManager } from '../../src/managers/ProviderManager';
import type { ICliProvider } from '../../src/providers/base/IProvider';
import { setMockConfig, clearMockConfig, clearConfigurationListeners } from '../helpers/mockVscode';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    globalState: { get: () => undefined, update: () => Promise.resolve(), keys: () => [], setKeysForSync: () => {} },
    workspaceState: { get: () => undefined, update: () => Promise.resolve(), keys: () => [] },
    extensionPath: '/mock/extension',
    extensionUri: vscode.Uri.file('/mock/extension'),
    extensionMode: 1,
  } as unknown as vscode.ExtensionContext;
}

/** A spy-backed provider that records which lifecycle calls were routed to it. */
interface SpyProvider {
  provider: ICliProvider;
  cancelCurrentRequest: ReturnType<typeof vi.fn>;
  suspendProcess: ReturnType<typeof vi.fn>;
  resumeProcess: ReturnType<typeof vi.fn>;
  clearSession: ReturnType<typeof vi.fn>;
  disposePersistentProcess: ReturnType<typeof vi.fn>;
}

function spyProvider(id: string): SpyProvider {
  const cancelCurrentRequest = vi.fn();
  const suspendProcess = vi.fn(() => true);
  const resumeProcess = vi.fn(() => true);
  const clearSession = vi.fn();
  const disposePersistentProcess = vi.fn();
  const provider = {
    id,
    displayName: id,
    config: { name: id, displayName: id, models: [], defaultModel: `${id}-model` },
    cancelCurrentRequest,
    suspendProcess,
    resumeProcess,
    clearSession,
    disposePersistentProcess,
    hasSession: () => false,
    getSessionId: () => null,
  } as unknown as ICliProvider;
  return { provider, cancelCurrentRequest, suspendProcess, resumeProcess, clearSession, disposePersistentProcess };
}

/**
 * Build a ProviderManager whose registry resolves the given spy providers and
 * whose default provider is `defaultId`. The real registry built in the
 * constructor is swapped out for a minimal lookup over the spy providers so
 * routing is observable without spawning CLIs.
 */
function buildManager(defaultId: string, spies: SpyProvider[]): ProviderManager {
  const byId = new Map(spies.map((s) => [s.provider.id, s.provider]));
  setMockConfig('defaultProvider', defaultId);

  const manager = new ProviderManager(createMockContext());
  (manager as unknown as { _registry: { get(id: string): ICliProvider | undefined; getAll(): ICliProvider[] } })._registry = {
    get: (id: string) => byId.get(id),
    getAll: () => Array.from(byId.values()),
  };
  return manager;
}

/** A fake ChildProcess that looks already-exited so killProcessTree no-ops. */
function deadProcess(): ChildProcess {
  return {
    pid: 4242,
    exitCode: 0,
    signalCode: null,
    kill: vi.fn(() => true),
    on: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as ChildProcess;
}

describe('ProviderManager panel -> provider routing (B12)', () => {
  beforeEach(() => {
    clearMockConfig();
  });
  afterEach(() => {
    clearMockConfig();
    clearConfigurationListeners();
    vi.restoreAllMocks();
  });

  it('cancelRequest routes to the panel-owning provider, not the default', () => {
    const x = spyProvider('provider-x');
    const y = spyProvider('provider-y');
    const manager = buildManager('provider-y', [x, y]); // default is Y

    // Panel P is running provider X.
    manager.registerProcess('panel-P', deadProcess(), 'provider-x');

    manager.cancelRequest('panel-P');

    expect(x.cancelCurrentRequest).toHaveBeenCalledWith('panel-P');
    expect(y.cancelCurrentRequest).not.toHaveBeenCalled();
  });

  it('suspendRequest / resumeRequest route to the panel-owning provider', () => {
    const x = spyProvider('provider-x');
    const y = spyProvider('provider-y');
    const manager = buildManager('provider-y', [x, y]);

    manager.registerProcess('panel-P', deadProcess(), 'provider-x');

    expect(manager.suspendRequest('panel-P')).toBe(true);
    expect(manager.resumeRequest('panel-P')).toBe(true);

    expect(x.suspendProcess).toHaveBeenCalledWith('panel-P');
    expect(x.resumeProcess).toHaveBeenCalledWith('panel-P');
    expect(y.suspendProcess).not.toHaveBeenCalled();
    expect(y.resumeProcess).not.toHaveBeenCalled();
  });

  it('clearSession routes to the panel-owning provider', () => {
    const x = spyProvider('provider-x');
    const y = spyProvider('provider-y');
    const manager = buildManager('provider-y', [x, y]);

    manager.registerProcess('panel-P', deadProcess(), 'provider-x');
    manager.clearSession('panel-P');

    expect(x.clearSession).toHaveBeenCalledWith('panel-P');
    expect(y.clearSession).not.toHaveBeenCalled();
  });

  it('disposePersistentProcess routes to the panel-owning provider', () => {
    const x = spyProvider('provider-x');
    const y = spyProvider('provider-y');
    const manager = buildManager('provider-y', [x, y]);

    manager.registerProcess('panel-P', deadProcess(), 'provider-x');
    manager.disposePersistentProcess('panel-P');

    expect(x.disposePersistentProcess).toHaveBeenCalledWith('panel-P');
    expect(y.disposePersistentProcess).not.toHaveBeenCalled();
  });

  it('falls back to the default provider when the panel has no recorded owner', () => {
    const x = spyProvider('provider-x');
    const y = spyProvider('provider-y');
    const manager = buildManager('provider-y', [x, y]);

    // No registerProcess for this panel -> owner unknown -> default (Y).
    manager.cancelRequest('panel-unknown');

    expect(y.cancelCurrentRequest).toHaveBeenCalledWith('panel-unknown');
    expect(x.cancelCurrentRequest).not.toHaveBeenCalled();
  });

  it('cancelRequest clears the panel -> provider mapping so a later cancel falls back to default', () => {
    const x = spyProvider('provider-x');
    const y = spyProvider('provider-y');
    const manager = buildManager('provider-y', [x, y]);

    manager.registerProcess('panel-P', deadProcess(), 'provider-x');
    manager.cancelRequest('panel-P');
    x.cancelCurrentRequest.mockClear();

    // Mapping was cleared on cancel; a stray second cancel routes to default Y.
    manager.cancelRequest('panel-P');
    expect(x.cancelCurrentRequest).not.toHaveBeenCalled();
    expect(y.cancelCurrentRequest).toHaveBeenCalledWith('panel-P');
  });

  it('SIGKILL backstop fires on the tracked handle even if the owning provider teardown throws', () => {
    const x = spyProvider('provider-x');
    x.cancelCurrentRequest.mockImplementation(() => { throw new Error('teardown boom'); });
    const y = spyProvider('provider-y');
    const manager = buildManager('provider-y', [x, y]);

    // Live process: killProcessTree should send a signal to it.
    const kill = vi.fn(() => true);
    const live = {
      pid: 9999,
      exitCode: null,
      signalCode: null,
      kill,
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as ChildProcess;

    manager.registerProcess('panel-P', live, 'provider-x');

    // Should not throw despite the provider teardown throwing.
    expect(() => manager.cancelRequest('panel-P')).not.toThrow();
    // Backstop reached the tracked handle (initialSignal SIGKILL for cancel).
    expect(kill).toHaveBeenCalled();
  });

  it('registerProcess reports the child PID to the lifecycle sink (B16)', () => {
    const x = spyProvider('provider-x');
    const manager = buildManager('provider-x', [x]);

    const registerProcessPid = vi.fn();
    manager.setLifecycleSink({ registerProcessPid });

    const proc = {
      pid: 12345,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as ChildProcess;
    manager.registerProcess('panel-P', proc, 'provider-x');

    expect(registerProcessPid).toHaveBeenCalledWith('panel-P', 12345);
  });

  it('does not call the lifecycle sink when the process has no pid', () => {
    const x = spyProvider('provider-x');
    const manager = buildManager('provider-x', [x]);

    const registerProcessPid = vi.fn();
    manager.setLifecycleSink({ registerProcessPid });

    const proc = {
      pid: undefined,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as ChildProcess;
    manager.registerProcess('panel-P', proc, 'provider-x');

    expect(registerProcessPid).not.toHaveBeenCalled();
  });
});
