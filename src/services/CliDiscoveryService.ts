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
/** Bound discovery + authentication so one stalled backend cannot block every provider. */
export const CLI_DISCOVERY_TIMEOUT_MS = 15_000;

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
  private readonly _probeTimeoutMs: number;
  private _disposed = false;
  private readonly _cache: Map<string, CliStatus> = new Map();
  /** Single-flight guard: one in-flight probe per provider. */
  private readonly _inflight = new Map<string, {
    promise: Promise<CliStatus | undefined>;
    startTick: number;
    force: boolean;
    controller: AbortController;
  }>();
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

  private readonly _onDidChangeEmitter = new vscode.EventEmitter<CliStatus>();
  /**
   * Fires for the first retained discovery and changes to availability,
   * authentication, executable path or version. Open panels also consume this
   * event to refresh capabilities that depend on the discovered CLI version.
   * A new checkedAt alone does not require repainting the same provider facts.
   */
  public readonly onDidChange: vscode.Event<CliStatus> = this._onDidChangeEmitter.event;

  constructor(source: DiscoveryProviderSource, options?: { ttlMs?: number; probeTimeoutMs?: number }) {
    this._source = source;
    this._ttlMs = options?.ttlMs ?? CLI_DISCOVERY_TTL_MS;
    this._probeTimeoutMs = options?.probeTimeoutMs ?? CLI_DISCOVERY_TIMEOUT_MS;

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
      if (this._disposed) { return; }
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
    if (this._disposed) { return []; }
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
    if (this._disposed) { return []; }
    const ids = providerId
      ? [providerId]
      : this._source.getAllProviders().map((p) => p.id);

    const results = await Promise.allSettled(ids.map((id) => this._probe(id, true)));

    const statuses: CliStatus[] = [];
    for (const result of results) {
      // A settings/auth mutation or a newer probe may supersede an individual
      // result while a slower sibling finishes. Never broadcast that old state.
      if (result.status === 'fulfilled' && result.value) {
        const current = this._cache.get(result.value.providerId);
        if (current && this.isFresh(current)) { statuses.push(current); }
      }
    }
    if (statuses.length > 0) {
      this._onDidUpdateEmitter.fire(statuses);
    }
    return statuses;
  }

  /**
   * Mark cached entries stale (one provider or all) so the next read
   * re-probes. In-flight probes started before the invalidation will not
   * write their (now stale) results. Called on mysti.* config changes, wizard
   * install/auth mutations, and manual refresh.
   *
   * Stale, not DELETED: every agent/model pick writes a mysti.* setting, and
   * deleting made each installed CLI read as "not installed" to peekStatus
   * consumers until the re-probe landed — the Mysti sign-in card then said no
   * other agent was installed while the agent menu listed several.
   */
  public invalidate(providerId?: string): void {
    this._clock++;
    if (providerId) {
      this._invalidateTicks.set(providerId, this._clock);
    } else {
      this._invalidateAllTick = this._clock;
      this._invalidateTicks.clear();
    }
    for (const [id, status] of this._cache) {
      if (!providerId || id === providerId) {
        this._cache.set(id, { ...status, checkedAt: 0 });
      }
    }
  }

  public dispose(): void {
    this._disposed = true;
    for (const run of this._inflight.values()) { run.controller.abort(); }
    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables.length = 0;
    this._onDidUpdateEmitter.dispose();
    this._onDidChangeEmitter.dispose();
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
    if (this._disposed) { return Promise.resolve(undefined); }
    const existing = this._inflight.get(providerId);
    if (existing) {
      if (this._isInvalidatedSince(providerId, existing.startTick) || (force && !existing.force)) {
        // Preserve one active probe, but a refresh after installation/path/auth
        // changes must actually re-probe. Concurrent waiters share the next run.
        return existing.promise.then(() => this._probe(providerId, force));
      }
      return existing.promise;
    }

    const provider = this._source.getProviderInstance(providerId);
    if (!provider) {
      return Promise.resolve(undefined);
    }

    const startTick = this._clock;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Provider discovery timed out. Refresh detection to retry.')), this._probeTimeoutMs);
    const task = (async (): Promise<CliStatus | undefined> => {
      try {
        let discovery: CliDiscoveryResult;
        try {
          // Widened call: Ollama/LocalAI accept `force` to bypass their
          // probe-failure TTL (Plan 03 Phase 2); other providers ignore it.
          discovery = await this._awaitProbe(() => (provider.discoverCli.bind(provider) as ForceableDiscoverCli)(force), controller.signal);
        } catch (error) {
          if (this._disposed) { return undefined; }
          console.warn(`[Mysti] CliDiscoveryService: discoverCli failed for ${providerId}:`, error);
          discovery = { found: false, path: '' };
        }
        if (this._disposed) { return undefined; }

        let authenticated = false;
        if (discovery.found) {
          try {
            authenticated = (await this._awaitProbe(() => provider.checkAuthentication(), controller.signal)).authenticated;
          } catch (error) {
            if (this._disposed) { return undefined; }
            console.warn(`[Mysti] CliDiscoveryService: checkAuthentication failed for ${providerId}:`, error);
          }
        }
        if (this._disposed) { return undefined; }

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
          const prev = this._cache.get(providerId);
          this._cache.set(providerId, status);
          if (!prev || prev.found !== status.found || prev.authenticated !== status.authenticated
            || prev.path !== status.path || prev.version !== status.version) {
            this._onDidChangeEmitter.fire(status);
          }
        }
        return status;
      } finally {
        clearTimeout(timeout);
        this._inflight.delete(providerId);
      }
    })();

    this._inflight.set(providerId, { promise: task, startTick, force, controller });
    return task;
  }

  /** Stop waiting on timeout/disposal and observe late results without publishing them. */
  private _awaitProbe<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (complete: () => void) => {
        if (settled) { return; }
        settled = true;
        signal.removeEventListener('abort', abort);
        complete();
      };
      const abort = () => finish(() => reject(signal.reason));
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      try {
        task().then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }

  private _isInvalidatedSince(providerId: string, tick: number): boolean {
    if (this._invalidateAllTick > tick) {
      return true;
    }
    return (this._invalidateTicks.get(providerId) ?? 0) > tick;
  }
}
