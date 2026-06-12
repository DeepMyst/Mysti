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

import * as vscode from 'vscode';
import type { ICliProvider, CliDiscoveryResult } from '../providers/base/IProvider';

/**
 * Default time-to-live for cached CLI discovery results (Plan 03 Phase 3a).
 * Within this window, panel opens and wizard status reads never re-probe.
 */
export const CLI_DISCOVERY_TTL_MS = 5 * 60 * 1000;

/**
 * Cached discovery + authentication status for a single provider CLI.
 */
export interface CliStatus {
  providerId: string;
  found: boolean;
  path: string;
  version?: string;
  installCommand?: string;
  authenticated: boolean;
  /** Epoch ms of the probe that produced this entry (drives TTL expiry). */
  checkedAt: number;
}

/**
 * Narrow structural view of ProviderManager — everything the discovery
 * service needs. Kept minimal so tests can supply a lightweight fake.
 */
export interface DiscoveryProviderSource {
  getAllProviders(): ICliProvider[];
  getProviderInstance(name: string): ICliProvider | undefined;
  /** Resolves when the background provider init (initializeAll) settles. */
  readonly whenReady: Promise<void>;
  /** Fires each provider id as its initialize() settles. */
  readonly onProviderReady: vscode.Event<string>;
}

/**
 * Some providers (Ollama, LocalAI — Plan 03 Phase 2) accept a `force`
 * parameter on discoverCli() to bypass their failed-probe TTL. The base
 * ICliProvider interface declares no parameter, so explicit refresh() calls
 * widen the signature; providers without the parameter simply ignore it.
 */
type ForceableDiscoverCli = (force?: boolean) => Promise<CliDiscoveryResult>;

/**
 * CliDiscoveryService — single prober and in-memory cache for provider CLI
 * discovery + authentication status (Plan 03 Phase 3a).
 *
 * Responsibilities:
 * - Serve `{found, path, version, authenticated, checkedAt}` per provider
 *   from an in-memory map with a TTL (default 5 min).
 * - Seed the cache from ProviderRegistry's background init: each
 *   onProviderReady event triggers a background probe of that provider, so
 *   by the time a panel opens the cache is warm and the open never probes.
 * - `refresh(providerId?)` forces a parallel re-probe (Promise.allSettled),
 *   passing `force` through to providers with probe-failure TTLs.
 * - Invalidation: any `mysti.*` configuration change, wizard install/auth
 *   mutations (SetupManager calls `invalidate()`), and manual refresh.
 */
export class CliDiscoveryService implements vscode.Disposable {
  private readonly _source: DiscoveryProviderSource;
  private readonly _ttlMs: number;
  private readonly _cache: Map<string, CliStatus> = new Map();
  /** Single-flight guard: one in-flight probe per provider. */
  private readonly _inflight: Map<string, Promise<CliStatus | undefined>> = new Map();
  private readonly _disposables: vscode.Disposable[] = [];

  /**
   * Invalidation bookkeeping: probes capture `_clock` when they start and
   * only write to the cache if no relevant invalidation happened since —
   * an install/auth mutation can't be overwritten by a stale in-flight probe.
   */
  private _clock = 0;
  private _invalidateAllTick = 0;
  private readonly _invalidateTicks: Map<string, number> = new Map();

  private readonly _onDidUpdateEmitter = new vscode.EventEmitter<CliStatus[]>();
  /** Fires with the refreshed statuses after an explicit refresh() completes. */
  public readonly onDidUpdate: vscode.Event<CliStatus[]> = this._onDidUpdateEmitter.event;

  constructor(source: DiscoveryProviderSource, options?: { ttlMs?: number }) {
    this._source = source;
    this._ttlMs = options?.ttlMs ?? CLI_DISCOVERY_TTL_MS;

    // Seed: as each provider's background initialize() settles, probe it once
    // (discovery + auth) so panel opens read a warm cache. initialize()
    // discards its own discoverCli() result, so the service is the single
    // place the result is retained.
    this._disposables.push(
      this._source.onProviderReady((providerId) => {
        void this._probe(providerId).catch((error) => {
          console.warn(`[Mysti] CliDiscoveryService: seed probe failed for ${providerId}:`, error);
        });
      })
    );

    // Safety net: events fired before this service was constructed (or a
    // registry that settled instantly) — fill any entries still missing.
    void this._source.whenReady.then(() => {
      for (const provider of this._source.getAllProviders()) {
        if (!this._cache.has(provider.id) && !this._inflight.has(provider.id)) {
          void this._probe(provider.id).catch((error) => {
            console.warn(`[Mysti] CliDiscoveryService: seed probe failed for ${provider.id}:`, error);
          });
        }
      }
    });

    // Invalidate on any mysti.* settings change (CLI paths, endpoints, API
    // keys, … can all alter discovery/auth results).
    this._disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('mysti')) {
          console.log('[Mysti] CliDiscoveryService: mysti.* configuration changed — invalidating status cache');
          this.invalidate();
        }
      })
    );
  }

  /**
   * Get the status for one provider. Returns the cached entry when fresh;
   * otherwise probes (single-flight). Undefined for unknown provider ids.
   */
  public async getStatus(providerId: string): Promise<CliStatus | undefined> {
    const cached = this._cache.get(providerId);
    if (cached && this.isFresh(cached)) {
      return cached;
    }
    return this._probe(providerId);
  }

  /**
   * Get statuses for all providers. Stale/missing entries are re-probed in
   * parallel (Promise.allSettled); fresh entries are served from the cache.
   */
  public async getAllStatuses(): Promise<CliStatus[]> {
    const providers = this._source.getAllProviders();
    const stale = providers.filter((p) => {
      const cached = this._cache.get(p.id);
      return !cached || !this.isFresh(cached);
    });
    if (stale.length > 0) {
      await Promise.allSettled(stale.map((p) => this._probe(p.id)));
    }
    return providers
      .map((p) => this._cache.get(p.id))
      .filter((s): s is CliStatus => s !== undefined);
  }

  /**
   * Synchronous cache read — fresh entries only (TTL respected).
   */
  public getCachedStatus(providerId: string): CliStatus | undefined {
    const cached = this._cache.get(providerId);
    return cached && this.isFresh(cached) ? cached : undefined;
  }

  /**
   * Synchronous cache read regardless of TTL (stale-while-revalidate
   * consumers, e.g. getWizardStatusCached, prefer old data over none).
   */
  public peekStatus(providerId: string): CliStatus | undefined {
    return this._cache.get(providerId);
  }

  /** Snapshot of every cached entry, fresh or stale. */
  public getAllCachedStatuses(): CliStatus[] {
    return Array.from(this._cache.values());
  }

  /** Whether a cache entry is within the TTL. */
  public isFresh(status: CliStatus): boolean {
    return Date.now() - status.checkedAt < this._ttlMs;
  }

  /**
   * Force a re-probe of one provider (or all) in parallel, bypassing the
   * cache and any provider-side probe-failure TTLs (force is passed through
   * to discoverCli). Fires onDidUpdate with the refreshed statuses.
   */
  public async refresh(providerId?: string): Promise<CliStatus[]> {
    const ids = providerId
      ? [providerId]
      : this._source.getAllProviders().map((p) => p.id);

    const results = await Promise.allSettled(ids.map((id) => this._probe(id, true)));

    const statuses: CliStatus[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        statuses.push(result.value);
      }
    }
    if (statuses.length > 0) {
      this._onDidUpdateEmitter.fire(statuses);
    }
    return statuses;
  }

  /**
   * Drop cached entries (one provider or all). In-flight probes started
   * before the invalidation will not write their (now stale) results.
   * Called on mysti.* config changes, wizard install/auth mutations, and
   * manual refresh.
   */
  public invalidate(providerId?: string): void {
    this._clock++;
    if (providerId) {
      this._invalidateTicks.set(providerId, this._clock);
      this._cache.delete(providerId);
    } else {
      this._invalidateAllTick = this._clock;
      this._invalidateTicks.clear();
      this._cache.clear();
    }
  }

  public dispose(): void {
    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables.length = 0;
    this._onDidUpdateEmitter.dispose();
    this._cache.clear();
    this._inflight.clear();
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  /**
   * Probe one provider (discovery + auth when found) and cache the result.
   * Single-flight per provider: concurrent callers share the same promise.
   * Discovery errors are cached as not-found so a permanently failing
   * provider doesn't get re-probed on every read within the TTL.
   */
  private _probe(providerId: string, force = false): Promise<CliStatus | undefined> {
    const existing = this._inflight.get(providerId);
    if (existing) {
      return existing;
    }

    const provider = this._source.getProviderInstance(providerId);
    if (!provider) {
      return Promise.resolve(undefined);
    }

    const startTick = this._clock;
    const task = (async (): Promise<CliStatus | undefined> => {
      try {
        let discovery: CliDiscoveryResult;
        try {
          // Widened call: Ollama/LocalAI accept `force` to bypass their
          // probe-failure TTL (Plan 03 Phase 2); other providers ignore it.
          discovery = await (provider.discoverCli.bind(provider) as ForceableDiscoverCli)(force);
        } catch (error) {
          console.warn(`[Mysti] CliDiscoveryService: discoverCli failed for ${providerId}:`, error);
          discovery = { found: false, path: '' };
        }

        let authenticated = false;
        if (discovery.found) {
          try {
            authenticated = (await provider.checkAuthentication()).authenticated;
          } catch (error) {
            console.warn(`[Mysti] CliDiscoveryService: checkAuthentication failed for ${providerId}:`, error);
          }
        }

        const status: CliStatus = {
          providerId,
          found: discovery.found,
          path: discovery.path,
          version: discovery.version,
          installCommand: discovery.installCommand,
          authenticated,
          checkedAt: Date.now()
        };

        if (!this._isInvalidatedSince(providerId, startTick)) {
          this._cache.set(providerId, status);
        }
        return status;
      } finally {
        this._inflight.delete(providerId);
      }
    })();

    this._inflight.set(providerId, task);
    return task;
  }

  private _isInvalidatedSince(providerId: string, tick: number): boolean {
    if (this._invalidateAllTick > tick) {
      return true;
    }
    return (this._invalidateTicks.get(providerId) ?? 0) > tick;
  }
}
