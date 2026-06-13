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
 * Minimal structural view of ProviderManager — the registry only needs the
 * curated per-provider config (models + defaultModel) and the list of
 * registered provider ids. Declared structurally to avoid a hard import cycle
 * (ProviderManager imports nothing from this file; this file injects via a
 * setter from extension.ts after both are constructed).
 */
export interface ModelRegistryProviderSource {
  getProvider(id: string): { models: ModelInfo[]; defaultModel: string } | undefined;
  getAllProviderIds(): string[];
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
 * ModelRegistryService — single authority for "what models does provider X
 * have, and what are their context windows" (Plan 01).
 *
 * Phase 1 (this code) is behavior-neutral: getModels() merges the bundled
 * curated config.models with any persisted discovery cache and user custom
 * models, but refresh() is a no-op (live discovery adapters land in Phase 3).
 * With no cache and no custom models, getModels() returns exactly today's
 * bundled list — byte-identical output.
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
   * appended (deduped). Phase 3 adds stale-while-revalidate scheduling here.
   */
  public getModels(providerId: string): ProviderModelState {
    const curated = this._getCuratedModels(providerId);
    const cached = this._memoryCache.get(providerId);
    const customIds = this._getCustomModelIds(providerId);

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
   * Refresh a single provider's model list. Phase 1: NO-OP — the curated list
   * already serves via getModels(). Phase 3 replaces the body with the
   * discovery probe + timeout race + cache write + event. The in-flight dedup
   * map is wired now so concurrent triggers never double-spawn a CLI later.
   *
   * Never throws to the caller (failures fall back to the cached/curated list).
   */
  public async refresh(providerId: string, _opts?: { force?: boolean }): Promise<void> {
    const pending = this._inFlight.get(providerId);
    if (pending) {
      return pending;
    }
    // Phase 1: synchronous no-op wrapped in a resolved promise so the dedup map
    // and call sites behave identically once Phase 3 fills in real work.
    const promise = Promise.resolve();
    this._inFlight.set(providerId, promise);
    try {
      await promise;
    } finally {
      this._inFlight.delete(providerId);
    }
  }

  /**
   * Refresh every registered provider (fire-and-forget; Phase 3 staggers these
   * post-activation). Phase 1: each refresh() is a no-op.
   */
  public async refreshAll(opts?: { force?: boolean }): Promise<void> {
    const ids = this._source?.getAllProviderIds() ?? [];
    await Promise.all(ids.map(id => this.refresh(id, opts)));
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Bundled curated list for a provider (the per-provider config.models). */
  private _getCuratedModels(providerId: string): ModelInfo[] {
    return this._source?.getProvider(providerId)?.models ?? [];
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
