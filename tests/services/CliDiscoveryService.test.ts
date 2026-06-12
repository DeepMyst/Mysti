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
 * CliDiscoveryService tests (Plan 03 Phase 3a — cached CLI discovery):
 * cache-through reads, TTL expiry, seeding from onProviderReady/whenReady,
 * invalidation (manual, per-provider, mysti.* config change, in-flight
 * races), and forced refresh (force passed through to discoverCli).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  CliDiscoveryService,
  type DiscoveryProviderSource,
} from '../../src/services/CliDiscoveryService';
import type { ICliProvider } from '../../src/providers/base/IProvider';
import { fireConfigurationChange, clearConfigurationListeners } from '../helpers/mockVscode';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

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
    discoverCli,
    checkAuthentication,
  } as unknown as ICliProvider;
  return { provider, discoverCli, checkAuthentication };
}

class FakeSource implements DiscoveryProviderSource {
  private readonly _providers = new Map<string, ICliProvider>();
  readonly readyEmitter = new vscode.EventEmitter<string>();
  readonly onProviderReady = this.readyEmitter.event;
  readonly whenReady: Promise<void>;
  readonly resolveReady: () => void;

  constructor(providers: FakeProvider[]) {
    for (const p of providers) {
      this._providers.set(p.provider.id, p.provider);
    }
    let resolve!: () => void;
    // whenReady stays pending unless a test resolves it explicitly, so the
    // constructor's safety-net seeding never confounds call-count assertions.
    this.whenReady = new Promise<void>((res) => {
      resolve = res;
    });
    this.resolveReady = resolve;
  }

  getAllProviders(): ICliProvider[] {
    return Array.from(this._providers.values());
  }

  getProviderInstance(name: string): ICliProvider | undefined {
    return this._providers.get(name);
  }
}

/** Let queued microtasks (probe chains) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CliDiscoveryService', () => {
  let service: CliDiscoveryService | undefined;

  afterEach(() => {
    service?.dispose();
    service = undefined;
    clearConfigurationListeners();
    vi.useRealTimers();
  });

  describe('cache-through reads', () => {
    it('probes on cache miss and serves the cache afterwards', async () => {
      const claude = fakeProvider('claude-code', { version: '2.0.1' });
      service = new CliDiscoveryService(new FakeSource([claude]));

      const first = await service.getStatus('claude-code');
      expect(first).toMatchObject({
        providerId: 'claude-code',
        found: true,
        path: '/usr/local/bin/claude-code',
        version: '2.0.1',
        authenticated: true,
      });
      expect(typeof first!.checkedAt).toBe('number');

      const second = await service.getStatus('claude-code');
      expect(second).toBe(first);
      expect(claude.discoverCli).toHaveBeenCalledTimes(1);
      expect(claude.checkAuthentication).toHaveBeenCalledTimes(1);
    });

    it('skips the auth check when the CLI is not found', async () => {
      const missing = fakeProvider('cursor', { found: false });
      service = new CliDiscoveryService(new FakeSource([missing]));

      const status = await service.getStatus('cursor');
      expect(status).toMatchObject({ found: false, authenticated: false });
      expect(missing.checkAuthentication).not.toHaveBeenCalled();
    });

    it('returns undefined for unknown provider ids', async () => {
      service = new CliDiscoveryService(new FakeSource([]));
      expect(await service.getStatus('nope')).toBeUndefined();
    });

    it('caches discovery errors as not-found (no re-probe storm within TTL)', async () => {
      const broken = fakeProvider('gemini');
      broken.discoverCli.mockRejectedValue(new Error('boom'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      service = new CliDiscoveryService(new FakeSource([broken]));

      const status = await service.getStatus('gemini');
      expect(status).toMatchObject({ found: false, authenticated: false });

      await service.getStatus('gemini');
      expect(broken.discoverCli).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('single-flights concurrent probes for the same provider', async () => {
      const claude = fakeProvider('claude-code');
      service = new CliDiscoveryService(new FakeSource([claude]));

      const [a, b] = await Promise.all([
        service.getStatus('claude-code'),
        service.getStatus('claude-code'),
      ]);
      expect(a).toBe(b);
      expect(claude.discoverCli).toHaveBeenCalledTimes(1);
    });

    it('getAllStatuses probes only stale/missing entries and returns all', async () => {
      const claude = fakeProvider('claude-code');
      const codex = fakeProvider('openai-codex', { found: false });
      service = new CliDiscoveryService(new FakeSource([claude, codex]));

      // Warm one entry
      await service.getStatus('claude-code');
      claude.discoverCli.mockClear();

      const all = await service.getAllStatuses();
      expect(all.map((s) => s.providerId)).toEqual(['claude-code', 'openai-codex']);
      expect(claude.discoverCli).not.toHaveBeenCalled();
      expect(codex.discoverCli).toHaveBeenCalledTimes(1);
    });
  });

  describe('TTL expiry', () => {
    it('re-probes once the entry is older than the TTL', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-06-12T10:00:00Z'));

      const claude = fakeProvider('claude-code');
      service = new CliDiscoveryService(new FakeSource([claude]), { ttlMs: 5 * 60 * 1000 });

      await service.getStatus('claude-code');
      expect(claude.discoverCli).toHaveBeenCalledTimes(1);

      // Within TTL — cache hit
      vi.setSystemTime(new Date('2026-06-12T10:04:59Z'));
      await service.getStatus('claude-code');
      expect(claude.discoverCli).toHaveBeenCalledTimes(1);
      expect(service.getCachedStatus('claude-code')).toBeDefined();

      // Past TTL — fresh-only reads miss, async reads re-probe
      vi.setSystemTime(new Date('2026-06-12T10:05:01Z'));
      expect(service.getCachedStatus('claude-code')).toBeUndefined();
      // Stale entry is still peekable (stale-while-revalidate consumers)
      expect(service.peekStatus('claude-code')).toBeDefined();

      await service.getStatus('claude-code');
      expect(claude.discoverCli).toHaveBeenCalledTimes(2);
    });
  });

  describe('seeding from background provider init', () => {
    it('probes a provider when its onProviderReady event fires', async () => {
      const claude = fakeProvider('claude-code');
      const source = new FakeSource([claude]);
      service = new CliDiscoveryService(source);

      source.readyEmitter.fire('claude-code');
      await flush();

      expect(claude.discoverCli).toHaveBeenCalledTimes(1);
      // Panel-open read is now a pure cache hit
      const status = await service.getStatus('claude-code');
      expect(status!.found).toBe(true);
      expect(claude.discoverCli).toHaveBeenCalledTimes(1);
    });

    it('fills entries missed before construction once whenReady resolves', async () => {
      const claude = fakeProvider('claude-code');
      const codex = fakeProvider('openai-codex');
      const source = new FakeSource([claude, codex]);
      service = new CliDiscoveryService(source);

      // No onProviderReady events observed (e.g. registry settled earlier)
      source.resolveReady();
      await flush();

      expect(claude.discoverCli).toHaveBeenCalledTimes(1);
      expect(codex.discoverCli).toHaveBeenCalledTimes(1);
      expect(service.getCachedStatus('claude-code')).toBeDefined();
      expect(service.getCachedStatus('openai-codex')).toBeDefined();
    });
  });

  describe('invalidation', () => {
    it('invalidate() drops everything; next read re-probes', async () => {
      const claude = fakeProvider('claude-code');
      service = new CliDiscoveryService(new FakeSource([claude]));

      await service.getStatus('claude-code');
      service.invalidate();
      expect(service.peekStatus('claude-code')).toBeUndefined();

      await service.getStatus('claude-code');
      expect(claude.discoverCli).toHaveBeenCalledTimes(2);
    });

    it('invalidate(providerId) drops only that provider', async () => {
      const claude = fakeProvider('claude-code');
      const codex = fakeProvider('openai-codex');
      service = new CliDiscoveryService(new FakeSource([claude, codex]));

      await service.getStatus('claude-code');
      await service.getStatus('openai-codex');

      service.invalidate('claude-code');
      expect(service.peekStatus('claude-code')).toBeUndefined();
      expect(service.peekStatus('openai-codex')).toBeDefined();
    });

    it('invalidates on mysti.* configuration changes only', async () => {
      const claude = fakeProvider('claude-code');
      service = new CliDiscoveryService(new FakeSource([claude]));
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await service.getStatus('claude-code');

      fireConfigurationChange('editor.fontSize');
      expect(service.peekStatus('claude-code')).toBeDefined();

      fireConfigurationChange('mysti.claudeCodePath');
      expect(service.peekStatus('claude-code')).toBeUndefined();
      logSpy.mockRestore();
    });

    it('an in-flight probe does not write a result that predates an invalidation', async () => {
      const claude = fakeProvider('claude-code');
      let resolveDiscovery!: (value: unknown) => void;
      claude.discoverCli.mockImplementation(
        () => new Promise((res) => { resolveDiscovery = res; })
      );
      service = new CliDiscoveryService(new FakeSource([claude]));

      const pending = service.getStatus('claude-code');
      // Install/auth mutation happens while the probe is mid-flight
      service.invalidate('claude-code');
      resolveDiscovery({ found: false, path: 'claude' });

      const result = await pending;
      expect(result).toMatchObject({ found: false });
      // ...but the stale result must not have been cached
      expect(service.peekStatus('claude-code')).toBeUndefined();
    });

    it('stops listening after dispose()', async () => {
      const claude = fakeProvider('claude-code');
      service = new CliDiscoveryService(new FakeSource([claude]));
      await service.getStatus('claude-code');

      service.dispose();
      // Must not throw, and no listeners should remain registered
      fireConfigurationChange('mysti.defaultMode');
    });
  });

  describe('refresh (forced re-probe)', () => {
    it('re-probes fresh entries, passing force=true through to discoverCli', async () => {
      const ollama = fakeProvider('ollama');
      service = new CliDiscoveryService(new FakeSource([ollama]));

      await service.getStatus('ollama');
      expect(ollama.discoverCli).toHaveBeenLastCalledWith(false);

      const refreshed = await service.refresh('ollama');
      expect(ollama.discoverCli).toHaveBeenCalledTimes(2);
      // Ollama/LocalAI use force to bypass their probe-failure TTL (Phase 2)
      expect(ollama.discoverCli).toHaveBeenLastCalledWith(true);
      expect(refreshed).toHaveLength(1);
      expect(refreshed[0].providerId).toBe('ollama');
    });

    it('refresh() with no id re-probes every provider in parallel and fires onDidUpdate', async () => {
      const claude = fakeProvider('claude-code');
      const codex = fakeProvider('openai-codex', { found: false });
      service = new CliDiscoveryService(new FakeSource([claude, codex]));

      await service.getAllStatuses();
      claude.discoverCli.mockClear();
      codex.discoverCli.mockClear();

      const updates: unknown[] = [];
      service.onDidUpdate((statuses) => updates.push(statuses));

      const refreshed = await service.refresh();
      expect(claude.discoverCli).toHaveBeenCalledTimes(1);
      expect(codex.discoverCli).toHaveBeenCalledTimes(1);
      expect(refreshed.map((s) => s.providerId).sort()).toEqual(['claude-code', 'openai-codex']);
      expect(updates).toHaveLength(1);
    });

    it('survives one provider rejecting during a bulk refresh (allSettled)', async () => {
      const good = fakeProvider('claude-code');
      const bad = fakeProvider('openai-codex');
      bad.checkAuthentication.mockRejectedValue(new Error('auth probe exploded'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      service = new CliDiscoveryService(new FakeSource([good, bad]));

      const refreshed = await service.refresh();
      expect(refreshed).toHaveLength(2);
      const badStatus = refreshed.find((s) => s.providerId === 'openai-codex');
      expect(badStatus).toMatchObject({ found: true, authenticated: false });
      warnSpy.mockRestore();
    });
  });
});
