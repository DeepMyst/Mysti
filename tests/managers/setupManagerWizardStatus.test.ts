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
 * SetupManager wizard status tests (Plan 03 Phase 3a): getWizardStatus reads
 * through CliDiscoveryService (no per-provider serial probing on cache hit),
 * getWizardStatusCached returns immediately and emits onWizardStatusUpdated
 * after its background refresh, and resetNpmCache invalidates the discovery
 * cache.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { SetupManager, type WizardStatusResult } from '../../src/managers/SetupManager';
import { CliDiscoveryService } from '../../src/services/CliDiscoveryService';
import type { ICliProvider } from '../../src/providers/base/IProvider';
import { clearConfigurationListeners } from '../helpers/mockVscode';

interface FakeProvider {
  provider: ICliProvider;
  discoverCli: ReturnType<typeof vi.fn>;
  checkAuthentication: ReturnType<typeof vi.fn>;
}

function fakeProvider(
  id: string,
  opts: { found?: boolean; authenticated?: boolean; version?: string } = {}
): FakeProvider {
  const discoverCli = vi.fn(async (_force?: boolean) => ({
    found: opts.found ?? true,
    path: `/usr/local/bin/${id}`,
    version: opts.version,
    installCommand: `npm install -g ${id}`,
  }));
  const checkAuthentication = vi.fn(async () => ({
    authenticated: opts.authenticated ?? true,
  }));
  const provider = {
    id,
    displayName: id,
    capabilities: { supportsAutoInstall: true },
    discoverCli,
    checkAuthentication,
    getInstallCommand: () => `npm install -g ${id}`,
    getAuthCommand: () => `${id} auth login`,
  } as unknown as ICliProvider;
  return { provider, discoverCli, checkAuthentication };
}

function buildHarness(fakes: FakeProvider[]) {
  const byId = new Map(fakes.map((f) => [f.provider.id, f.provider]));
  const readyEmitter = new vscode.EventEmitter<string>();

  // Discovery source: whenReady stays pending so the service's safety-net
  // seeding never warms the cache behind the test's back.
  const discoverySource = {
    getAllProviders: () => Array.from(byId.values()),
    getProviderInstance: (id: string) => byId.get(id),
    whenReady: new Promise<void>(() => {}),
    onProviderReady: readyEmitter.event,
  } as any;

  const service = new CliDiscoveryService(discoverySource);

  // ProviderManager fake for SetupManager: background init already settled.
  const providerManager = {
    getAllProviders: () => Array.from(byId.values()),
    getProviderInstance: (id: string) => byId.get(id),
    whenReady: Promise.resolve(),
  } as any;

  const context = { globalState: { get: () => undefined, update: async () => undefined } } as any;
  const setupManager = new SetupManager(context, providerManager, service);

  // Never exec npm/node in unit tests
  vi.spyOn(setupManager, 'checkNpmAvailable').mockResolvedValue(true);
  (setupManager as any)._getNodeVersion = async () => 'v20.0.0';

  return { setupManager, service, readyEmitter };
}

describe('SetupManager wizard status (Plan 03 Phase 3a)', () => {
  let service: CliDiscoveryService;

  afterEach(() => {
    service?.dispose();
    clearConfigurationListeners();
    vi.restoreAllMocks();
  });

  it('getWizardStatus reads through the discovery cache — no re-probe on cache hit', async () => {
    const claude = fakeProvider('claude-code', { version: '2.0.1' });
    const codex = fakeProvider('openai-codex', { found: false });
    const h = buildHarness([claude, codex]);
    service = h.service;

    // Warm the cache (simulates activation-time seeding)
    await service.getAllStatuses();
    claude.discoverCli.mockClear();
    claude.checkAuthentication.mockClear();
    codex.discoverCli.mockClear();

    const status = await h.setupManager.getWizardStatus();

    expect(claude.discoverCli).not.toHaveBeenCalled();
    expect(codex.discoverCli).not.toHaveBeenCalled();
    expect(status.anyReady).toBe(true);
    expect(status.nodeVersion).toBe('v20.0.0');

    const claudeStatus = status.providers.find((p) => p.providerId === 'claude-code');
    expect(claudeStatus).toMatchObject({
      installed: true,
      authenticated: true,
      cliVersion: '2.0.1',
      installCommand: 'npm install -g claude-code',
      authCommand: 'claude-code auth login',
    });
    expect(status.providers.find((p) => p.providerId === 'openai-codex')).toMatchObject({
      installed: false,
      authenticated: false,
    });
  });

  it('getWizardStatusCached returns immediately and fires onWizardStatusUpdated after the background refresh', async () => {
    const claude = fakeProvider('claude-code');
    const h = buildHarness([claude]);
    service = h.service;

    const updated = new Promise<WizardStatusResult>((resolve) => {
      h.setupManager.onWizardStatusUpdated(resolve);
    });

    // Cold cache: synchronous, no probing has happened yet
    const cached = h.setupManager.getWizardStatusCached();
    expect(cached.complete).toBe(false);
    expect(cached.anyReady).toBe(false);
    expect(cached.providers.find((p) => p.providerId === 'claude-code')).toMatchObject({
      installed: false,
      authenticated: false,
    });

    // ...but the kicked background refresh lands with real statuses
    const fresh = await updated;
    expect(fresh.anyReady).toBe(true);
    expect(fresh.providers.find((p) => p.providerId === 'claude-code')).toMatchObject({
      installed: true,
      authenticated: true,
    });

    // Cache is now warm and fresh
    const warm = h.setupManager.getWizardStatusCached();
    expect(warm.complete).toBe(true);
    expect(warm.anyReady).toBe(true);
    expect(claude.discoverCli).toHaveBeenCalledTimes(1);
  });

  it('ensureProviderStatusFresh probes only the requested provider', async () => {
    const claude = fakeProvider('claude-code');
    const codex = fakeProvider('openai-codex');
    const h = buildHarness([claude, codex]);
    service = h.service;

    const status = await h.setupManager.ensureProviderStatusFresh('claude-code');
    expect(status).toMatchObject({ providerId: 'claude-code', found: true });
    expect(claude.discoverCli).toHaveBeenCalledTimes(1);
    expect(codex.discoverCli).not.toHaveBeenCalled();
  });

  it('resetNpmCache invalidates the discovery cache (manual refresh semantics)', async () => {
    const claude = fakeProvider('claude-code');
    const h = buildHarness([claude]);
    service = h.service;

    await service.getStatus('claude-code');
    expect(service.peekStatus('claude-code')).toBeDefined();

    h.setupManager.resetNpmCache();
    expect(service.peekStatus('claude-code')).toBeUndefined();
  });

  it('refreshWizardStatus force-probes every provider', async () => {
    const claude = fakeProvider('claude-code');
    const h = buildHarness([claude]);
    service = h.service;

    await service.getStatus('claude-code');
    expect(claude.discoverCli).toHaveBeenLastCalledWith(false);

    const status = await h.setupManager.refreshWizardStatus();
    expect(claude.discoverCli).toHaveBeenLastCalledWith(true);
    expect(status.anyReady).toBe(true);
  });
});
