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
import type { ModelInfo, ModelEntry, ProviderModelState } from '../types';
import { validateModelName } from '../utils/validation';
import {
  DEFAULT_FALLBACK_MODEL,
  MODEL_CUSTOM_MAX_PER_PROVIDER,
  MODEL_DISCOVERY_TIMEOUT_MS,
  MODEL_CACHE_TTL_CLI_MS,
  MODEL_CACHE_TTL_LOCAL_MS,
} from '../constants';

/**
 * Persisted (globalState) cache entry for one provider. Kept intentionally
 * small — model ids + metadata only (R7: bounded globalState growth).
 */
interface CachedProviderModels {
  models: ModelInfo[];
  fetchedAt: number;
}

/** globalState shape under MODEL_REGISTRY_CACHE_KEY. */
type ModelRegistryCache = Record<string, CachedProviderModels>;

/**
 * A provider instance that may implement live model discovery (Plan 01 Phase 3).
 * The registry only touches the optional discoverModels method; everything else
 * about the provider is irrelevant here, so the shape is intentionally minimal.
 */
export interface DiscoverableProvider {
  readonly id: string;
  discoverModels?(timeoutMs: number): Promise<ModelInfo[] | null>;
}

/**
 * Minimal structural view of ProviderManager — the registry needs the curated
 * per-provider config (models + defaultModel), the list of registered provider
 * ids, and (Phase 3) access to the provider instance so it can invoke the
 * optional discoverModels() probe. Declared structurally to avoid a hard import
 * cycle (ProviderManager imports nothing from this file; this file injects via a
 * setter from extension.ts after both are constructed). ProviderManager already
 * satisfies all three members (getProvider/getAllProviderIds/getProviderInstance).
 */
export interface ModelRegistryProviderSource {
  getProvider(id: string): { models: ModelInfo[]; defaultModel: string } | undefined;
  getAllProviderIds(): string[];
  /**
   * Optional in Phase 1/tests; required for live discovery. Returns the
   * concrete provider instance whose discoverModels() the registry calls.
   */
  getProviderInstance?(id: string): DiscoverableProvider | undefined;
}

/**
 * One globalState key for the whole registry (R7). Versioned so a future
 * cache-shape change can invalidate cleanly.
 */
export const MODEL_REGISTRY_CACHE_KEY = 'mysti.modelRegistry.v1';

/**
 * Setting that backs user-defined custom models, keyed by provider id.
 * Phase 4 routes the webview "Custom..." flow through addCustomModel(); Phase 1
 * already reads this so any value present is merged into getModels().
 */
const CUSTOM_MODELS_SETTING = 'customModels';

/**
 * Provider ids whose model list is served by a local server (Ollama / LocalAI).
 * These use the SHORT local TTL (MODEL_CACHE_TTL_LOCAL_MS) because the installed
 * set changes often (a user runs `ollama pull` and expects it to show up soon).
 * Every other provider is CLI/HTTP-derived and uses the long CLI TTL. Kept as a
 * small set here rather than a provider-declared hint so the registry stays the
 * single place that classifies cache freshness.
 */
const LOCAL_SERVER_PROVIDER_IDS: ReadonlySet<string> = new Set(['ollama', 'localai']);

/**
 * Stagger delay between per-provider discovery probes in refreshAll() (R4). A
 * burst of CLI spawns at the same instant spikes CPU on activation; spacing
 * them ~400ms apart keeps the cost diffuse while still warming every list
 * within a few seconds.
 */
const REFRESH_ALL_STAGGER_MS = 400;

/**
 * ModelRegistryService — single authority for "what models does provider X
 * have, and what are their context windows" (Plan 01).
 *
 * getModels() merges the bundled curated config.models with any persisted
 * discovery cache and user custom models, answering synchronously and never
 * throwing. With no cache and no custom models it returns exactly today's
 * bundled list. Phase 3 (this code) makes refresh() real: it calls the
 * provider's optional discoverModels() under a timeout race; on a fresh
 * (non-null, non-empty) result it persists {models, fetchedAt} and fires
 * onDidUpdateModels; on null/throw/timeout it keeps the existing cache (stale)
 * and stays silent. getModels() is stale-while-revalidate: it returns the
 * current merge immediately and, when the cached entry is older than its
 * per-provider TTL, kicks a deduped background refresh.
 *
 * Merge precedence (low → high): curated → discovered → custom. Higher sources
 * override lower ones for the same model id; custom always wins.
 */
export class ModelRegistryService {
  private readonly _context: vscode.ExtensionContext;
  private _source?: ModelRegistryProviderSource;

  /** In-memory mirror of the globalState discovery cache (per provider). */
  private readonly _memoryCache: Map<string, CachedProviderModels> = new Map();

  /** Per-provider in-flight refresh dedup (R4): concurrent triggers share one promise. */
  private readonly _inFlight: Map<string, Promise<void>> = new Map();

  private readonly _onDidUpdateModels = new vscode.EventEmitter<{ providerId: string }>();
  /** Fires when a provider's merged model list may have changed (cache/custom update). */
  public readonly onDidUpdateModels = this._onDidUpdateModels.event;

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
    this._loadCacheFromGlobalState();
  }

  /**
   * Inject the provider source post-construction (extension.ts wires this after
   * ProviderManager is built — avoids a construction-order/import cycle).
   */
  public setProviderSource(source: ModelRegistryProviderSource): void {
    this._source = source;
  }

  // ---------------------------------------------------------------------------
  // Synchronous read API (never throws, always answers)
  // ---------------------------------------------------------------------------

  /**
   * Merged, deduped model list for a provider. Always answers synchronously
   * from memory cache / globalState / bundled curated. Custom models are always
   * appended (deduped).
   *
   * Stale-while-revalidate (Phase 3): if the cached discovery entry is older
   * than the provider's TTL (or there is no cache yet but the provider supports
   * discovery), a background refresh() is kicked (deduped via _inFlight) and the
   * CURRENT merge is still returned now — the message-send path never awaits
   * discovery. The refresh fires onDidUpdateModels when it lands, prompting
   * consumers to re-read.
   */
  public getModels(providerId: string): ProviderModelState {
    const curated = this._getCuratedModels(providerId);
    const cached = this._memoryCache.get(providerId);
    const customIds = this._getCustomModelIds(providerId);

    if (this._isStale(providerId, cached)) {
      // Fire-and-forget; deduped by refresh()'s in-flight map. Never awaited.
      void this.refresh(providerId);
    }

    // Merge by id, low → high precedence so later sources override earlier.
    const merged = new Map<string, ModelEntry>();

    for (const m of curated) {
      merged.set(m.id, { ...m, source: 'curated' });
    }

    // Discovered layer (Phase 3 populates the cache; Phase 1 cache is empty
    // unless seeded). Discovered overrides curated for the same id.
    if (cached) {
      for (const m of cached.models) {
        const existing = merged.get(m.id);
        merged.set(m.id, { ...existing, ...m, source: 'discovered' });
      }
    }

    // Custom layer always wins.
    for (const id of customIds) {
      const existing = merged.get(id);
      merged.set(id, {
        ...(existing ?? { id, name: id }),
        id,
        source: 'custom',
      });
    }

    const models = Array.from(merged.values());
    const fetchedAt = cached?.fetchedAt ?? 0;
    const discoveryStatus: ProviderModelState['discoveryStatus'] = cached
      ? 'cached'
      : 'fallback';

    return {
      models,
      defaultModel: this.getDefaultModel(providerId),
      fetchedAt,
      discoveryStatus,
    };
  }

  /**
   * Context window for a specific model, or undefined when unknown (the caller
   * applies its own numeric fallback — see ProviderManager.getModelContextWindow).
   */
  public getContextWindow(providerId: string, modelId: string): number | undefined {
    const { models } = this.getModels(providerId);
    return models.find(m => m.id === modelId)?.contextWindow;
  }

  /**
   * Default model for a provider: the curated config default when available,
   * else the centralized DEFAULT_FALLBACK_MODEL.
   */
  public getDefaultModel(providerId: string): string {
    const provider = this._source?.getProvider(providerId);
    return provider?.defaultModel || DEFAULT_FALLBACK_MODEL;
  }

  // ---------------------------------------------------------------------------
  // Custom model management (writes mysti.customModels, Global target)
  // ---------------------------------------------------------------------------

  /**
   * Add a user-defined custom model for a provider. Validates the id, enforces
   * MODEL_CUSTOM_MAX_PER_PROVIDER, persists to mysti.customModels (Global), and
   * fires onDidUpdateModels. No-op (no event) when the id is invalid, already
   * present, or the per-provider cap is reached.
   */
  public async addCustomModel(providerId: string, modelId: string): Promise<void> {
    const trimmed = (modelId ?? '').trim();
    const validation = validateModelName(trimmed);
    if (!validation.valid) {
      console.warn(`[Mysti] ModelRegistry: rejected custom model "${modelId}" for ${providerId}: ${validation.error}`);
      return;
    }

    const all = this._readCustomModelsSetting();
    const existing = all[providerId] ?? [];
    if (existing.includes(trimmed)) {
      return; // already present — no change, no event
    }
    if (existing.length >= MODEL_CUSTOM_MAX_PER_PROVIDER) {
      console.warn(`[Mysti] ModelRegistry: custom model cap (${MODEL_CUSTOM_MAX_PER_PROVIDER}) reached for ${providerId}; "${trimmed}" not added`);
      return;
    }

    all[providerId] = [...existing, trimmed];
    await this._writeCustomModelsSetting(all);
    this._onDidUpdateModels.fire({ providerId });
  }

  /**
   * Remove a user-defined custom model. Persists and fires onDidUpdateModels
   * only when something was actually removed.
   */
  public async removeCustomModel(providerId: string, modelId: string): Promise<void> {
    const all = this._readCustomModelsSetting();
    const existing = all[providerId] ?? [];
    if (!existing.includes(modelId)) {
      return;
    }
    const next = existing.filter(m => m !== modelId);
    if (next.length > 0) {
      all[providerId] = next;
    } else {
      delete all[providerId];
    }
    await this._writeCustomModelsSetting(all);
    this._onDidUpdateModels.fire({ providerId });
  }

  // ---------------------------------------------------------------------------
  // Refresh (Phase 1: no-op returning curated; Phase 3 adds discovery)
  // ---------------------------------------------------------------------------

  /**
   * Refresh a single provider's model list (Plan 01 Phase 3).
   *
   * Calls the provider's optional discoverModels() under a timeout race
   * (MODEL_DISCOVERY_TIMEOUT_MS). On a fresh, non-null, non-empty result it
   * persists {models, fetchedAt, source:'discovered'} to the globalState cache
   * and fires onDidUpdateModels. On null / empty / throw / timeout it KEEPS the
   * existing cache (stale) and stays silent (no event) — the dropdown is never
   * emptied. Providers without discoverModels are curated-only no-ops.
   *
   * Concurrent triggers for the same provider share one in-flight promise (R4:
   * never double-spawn a CLI). `opts.force` is accepted for signature parity
   * with the spec; refresh() always probes when called, so force only matters at
   * the getModels()/stale-while-revalidate gate, not here.
   *
   * Never throws to the caller (failures fall back to the cached/curated list).
   */
  public async refresh(providerId: string, _opts?: { force?: boolean }): Promise<void> {
    const pending = this._inFlight.get(providerId);
    if (pending) {
      return pending;
    }
    const promise = this._doRefresh(providerId);
    this._inFlight.set(providerId, promise);
    try {
      await promise;
    } finally {
      this._inFlight.delete(providerId);
    }
  }

  /**
   * The actual discovery probe for one provider. Separated from refresh() so the
   * in-flight dedup wrapper stays trivial. Catches everything: discoverModels is
   * contractually non-throwing, but the registry defends regardless.
   */
  private async _doRefresh(providerId: string): Promise<void> {
    const instance = this._source?.getProviderInstance?.(providerId);
    if (!instance || typeof instance.discoverModels !== 'function') {
      // Curated-only provider (or no instance access in this build/test) — nothing
      // to discover. Keep whatever is cached; do not fire.
      return;
    }

    let discovered: ModelInfo[] | null = null;
    try {
      discovered = await this._raceTimeout(
        instance.discoverModels(MODEL_DISCOVERY_TIMEOUT_MS),
        MODEL_DISCOVERY_TIMEOUT_MS
      );
    } catch (err) {
      // discoverModels should never throw, but if it does (or the timeout
      // rejects), treat it as discovery-unavailable: keep stale cache, no event.
      console.warn(`[Mysti] ModelRegistry: discovery failed for ${providerId}: ${String(err)}`);
      return;
    }

    // null / empty array → "no models discovered" → keep stale cache, no event.
    if (!Array.isArray(discovered) || discovered.length === 0) {
      return;
    }

    // Fresh result: persist {models, fetchedAt} (source recorded at merge time)
    // and notify consumers.
    this._memoryCache.set(providerId, { models: discovered, fetchedAt: Date.now() });
    await this._persistCache();
    this._onDidUpdateModels.fire({ providerId });
  }

  /**
   * Race a discovery promise against a timeout. Resolves to the provider's
   * result if it lands first, or null if the timeout wins — so a CLI/HTTP probe
   * that overruns its budget never blocks or wedges the in-flight slot. The
   * losing promise is left to settle (and is swallowed) so an eventual rejection
   * doesn't surface as an unhandled rejection.
   */
  private _raceTimeout(
    probe: Promise<ModelInfo[] | null>,
    timeoutMs: number
  ): Promise<ModelInfo[] | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    // Swallow a late rejection from the probe once the timeout has already won.
    probe.catch(() => undefined);
    return Promise.race([probe, timeout]).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    });
  }

  /**
   * Refresh every registered provider that implements discoverModels, STAGGERED
   * (R4): probes are spaced REFRESH_ALL_STAGGER_MS apart so a burst of CLI
   * spawns at activation doesn't spike CPU. Fire-and-forget — the post-activation
   * trigger in extension.ts does not await this. Providers without discoverModels
   * are skipped entirely (no spawn, no delay).
   */
  public async refreshAll(opts?: { force?: boolean }): Promise<void> {
    const ids = this._source?.getAllProviderIds() ?? [];
    const targets = ids.filter(id => this._providerSupportsDiscovery(id));

    for (let i = 0; i < targets.length; i++) {
      const id = targets[i];
      // Stagger every provider after the first; the first probes immediately.
      if (i > 0) {
        await this._delay(REFRESH_ALL_STAGGER_MS);
      }
      // Don't await the individual refresh inside the stagger loop — let probes
      // run concurrently-but-offset so one slow CLI doesn't stall the rest.
      void this.refresh(id, opts).catch(() => undefined);
    }
  }

  /** Whether a provider exposes discoverModels (skips curated-only ids in refreshAll). */
  private _providerSupportsDiscovery(providerId: string): boolean {
    const instance = this._source?.getProviderInstance?.(providerId);
    return !!instance && typeof instance.discoverModels === 'function';
  }

  /** Promise-based delay used to stagger refreshAll probes. */
  private _delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Bundled curated list for a provider (the per-provider config.models). */
  private _getCuratedModels(providerId: string): ModelInfo[] {
    return this._source?.getProvider(providerId)?.models ?? [];
  }

  /**
   * TTL (ms) for a provider's discovery cache. Local servers (Ollama/LocalAI)
   * use the SHORT local TTL because their installed set changes often (a user
   * runs `ollama pull` and expects it to show up soon); every other provider is
   * CLI/HTTP-derived and uses the long CLI TTL. Classified by id here so the
   * registry stays the single place that decides cache freshness.
   */
  private _getTtl(providerId: string): number {
    return LOCAL_SERVER_PROVIDER_IDS.has(providerId)
      ? MODEL_CACHE_TTL_LOCAL_MS
      : MODEL_CACHE_TTL_CLI_MS;
  }

  /**
   * Whether getModels() should kick a background refresh for this provider
   * (stale-while-revalidate). True when:
   *  - the provider supports discovery (no point probing a curated-only provider), AND
   *  - there is no cache yet, OR the cache is older than the provider's TTL.
   * The current merge is still returned synchronously regardless; this only
   * decides whether to warm the cache in the background.
   */
  private _isStale(providerId: string, cached: CachedProviderModels | undefined): boolean {
    if (!this._providerSupportsDiscovery(providerId)) {
      return false;
    }
    if (!cached) {
      return true; // never discovered — warm it once
    }
    return Date.now() - cached.fetchedAt > this._getTtl(providerId);
  }

  private _getCustomModelIds(providerId: string): string[] {
    const all = this._readCustomModelsSetting();
    const entries = all[providerId];
    if (!Array.isArray(entries)) {
      return [];
    }
    // Re-validate every entry (the setting is user/JSON-editable, R6) and dedup.
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of entries) {
      if (typeof raw !== 'string') {
        continue;
      }
      const trimmed = raw.trim();
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }
      if (!validateModelName(trimmed).valid) {
        continue;
      }
      seen.add(trimmed);
      out.push(trimmed);
    }
    return out;
  }

  private _readCustomModelsSetting(): Record<string, string[]> {
    const config = vscode.workspace.getConfiguration('mysti');
    const value = config.get<Record<string, string[]>>(CUSTOM_MODELS_SETTING, {});
    // Defensive clone so callers can mutate without aliasing the cached config.
    return value ? JSON.parse(JSON.stringify(value)) : {};
  }

  private async _writeCustomModelsSetting(value: Record<string, string[]>): Promise<void> {
    const config = vscode.workspace.getConfiguration('mysti');
    await config.update(CUSTOM_MODELS_SETTING, value, vscode.ConfigurationTarget.Global);
  }

  private _loadCacheFromGlobalState(): void {
    const cache = this._context.globalState.get<ModelRegistryCache>(MODEL_REGISTRY_CACHE_KEY);
    if (!cache || typeof cache !== 'object') {
      return;
    }
    for (const [providerId, entry] of Object.entries(cache)) {
      if (entry && Array.isArray(entry.models) && typeof entry.fetchedAt === 'number') {
        this._memoryCache.set(providerId, { models: entry.models, fetchedAt: entry.fetchedAt });
      }
    }
  }

  /**
   * Persist the in-memory discovery cache to globalState. Phase 3 calls this
   * after a successful refresh; exposed now so the round-trip is testable.
   */
  private async _persistCache(): Promise<void> {
    const cache: ModelRegistryCache = {};
    for (const [providerId, entry] of this._memoryCache.entries()) {
      cache[providerId] = entry;
    }
    await this._context.globalState.update(MODEL_REGISTRY_CACHE_KEY, cache);
  }

  /**
   * Seed the discovery cache for a provider (Phase 3 discovery writes here).
   * Exposed for Phase 3 + tests; persists to globalState and fires the update
   * event so the merged view round-trips.
   */
  public async _setDiscoveredModels(providerId: string, models: ModelInfo[]): Promise<void> {
    this._memoryCache.set(providerId, { models, fetchedAt: Date.now() });
    await this._persistCache();
    this._onDidUpdateModels.fire({ providerId });
  }

  public dispose(): void {
    this._onDidUpdateModels.dispose();
    this._inFlight.clear();
    this._memoryCache.clear();
  }
}
