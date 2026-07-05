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
 * ModelRegistryService tests (Plan 01 Phases 1 + 3).
 *
 * Phase 1 (registry core, behavior-neutral): merge precedence
 * (custom > discovered > curated), globalState cache round-trip, addCustomModel
 * cap + invalid rejection, removeCustomModel, and onDidUpdateModels firing.
 *
 * Phase 3 (live discovery + caching): refresh() drives the provider's optional
 * discoverModels() under a timeout race — a non-null result persists
 * {models, fetchedAt} and fires onDidUpdateModels; null / empty / throw / timeout
 * keeps the stale cache and stays silent. getModels() is stale-while-revalidate
 * (returns the current merge synchronously, schedules a deduped background
 * refresh past the per-provider TTL). refreshAll() staggers per-provider probes.
 * All Phase 3 discovery is driven by a fully stubbed discoverModels (resolve /
 * null / reject / delay) — no real CLI spawning.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ExtensionContext } from 'vscode';
import {
  ModelRegistryService,
  MODEL_REGISTRY_CACHE_KEY,
  type ModelRegistryProviderSource,
  type DiscoverableProvider,
} from '../../src/services/ModelRegistryService';
import {
  MODEL_CUSTOM_MAX_PER_PROVIDER,
  MODEL_CACHE_TTL_CLI_MS,
  MODEL_CACHE_TTL_LOCAL_MS,
  MODEL_DISCOVERY_TIMEOUT_MS,
  DEFAULT_FALLBACK_MODEL,
} from '../../src/constants';
import type { ModelInfo } from '../../src/types';
import {
  setMockConfig,
  clearMockConfig,
  getMockConfigUpdates,
  createMockMemento,
} from '../helpers/mockVscode';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Curated config per the structural ModelRegistryProviderSource contract. */
function makeSource(
  configs: Record<string, { models: ModelInfo[]; defaultModel: string }>,
  instances?: Record<string, DiscoverableProvider>
): ModelRegistryProviderSource {
  return {
    getProvider(id: string) {
      return configs[id];
    },
    getAllProviderIds() {
      return Object.keys(configs);
    },
    getProviderInstance(id: string) {
      return instances?.[id];
    },
  };
}

/**
 * A fake provider whose discoverModels is fully controlled by the test (resolve
 * with a list, resolve null/empty, reject, or delay) — no real CLI spawning.
 */
function makeProvider(
  id: string,
  discoverModels?: DiscoverableProvider['discoverModels']
): DiscoverableProvider {
  return discoverModels ? { id, discoverModels } : { id };
}

/** Minimal ExtensionContext exposing only globalState (the registry's sole use). */
function makeContext() {
  const globalState = createMockMemento();
  return {
    context: { globalState } as unknown as ExtensionContext,
    globalState,
  };
}

const CURATED = {
  'claude-code': {
    defaultModel: 'claude-sonnet-4-5-20250929',
    models: [
      { id: 'claude-sonnet-4-5-20250929', name: 'Sonnet 4.5', contextWindow: 200000 },
      { id: 'claude-opus-4-5-20251101', name: 'Opus 4.5', contextWindow: 200000 },
    ] as ModelInfo[],
  },
  'google-gemini': {
    defaultModel: 'gemini-3-pro',
    models: [{ id: 'gemini-3-pro', name: 'Gemini 3 Pro' }] as ModelInfo[],
  },
};

describe('ModelRegistryService', () => {
  beforeEach(() => {
    clearMockConfig();
  });
  afterEach(() => {
    clearMockConfig();
  });

  // -------------------------------------------------------------------------
  // Behavior-neutral baseline (Phase 1)
  // -------------------------------------------------------------------------

  it('returns the bundled curated list byte-identically when no cache/custom', () => {
    const { context } = makeContext();
    const registry = new ModelRegistryService(context);
    registry.setProviderSource(makeSource(CURATED));

    const state = registry.getModels('claude-code');
    expect(state.models.map(m => m.id)).toEqual([
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-5-20251101',
    ]);
    expect(state.models.every(m => m.source === 'curated')).toBe(true);
    expect(state.defaultModel).toBe('claude-sonnet-4-5-20250929');
    expect(state.fetchedAt).toBe(0);
    expect(state.discoveryStatus).toBe('fallback');
    registry.dispose();
  });

  it('getDefaultModel falls back to DEFAULT_FALLBACK_MODEL for an unknown provider', () => {
    const { context } = makeContext();
    const registry = new ModelRegistryService(context);
    registry.setProviderSource(makeSource(CURATED));
    expect(registry.getDefaultModel('nope')).toBe(DEFAULT_FALLBACK_MODEL);
    registry.dispose();
  });

  it('getContextWindow returns the model window or undefined when unknown', () => {
    const { context } = makeContext();
    const registry = new ModelRegistryService(context);
    registry.setProviderSource(makeSource(CURATED));
    expect(registry.getContextWindow('claude-code', 'claude-sonnet-4-5-20250929')).toBe(200000);
    expect(registry.getContextWindow('claude-code', 'who-knows')).toBeUndefined();
    expect(registry.getContextWindow('google-gemini', 'gemini-3-pro')).toBeUndefined();
    registry.dispose();
  });

  // -------------------------------------------------------------------------
  // Merge precedence: custom > discovered > curated
  // -------------------------------------------------------------------------

  it('merges curated + discovered + custom with custom > discovered > curated', async () => {
    setMockConfig('customModels', { 'claude-code': ['my-custom-model', 'claude-sonnet-4-5-20250929'] });
    const { context } = makeContext();
    const registry = new ModelRegistryService(context);
    registry.setProviderSource(makeSource(CURATED));

    // Discovered layer overrides the curated entry for the same id (different name)
    // and adds a brand-new id.
    await registry._setDiscoveredModels('claude-code', [
      { id: 'claude-opus-4-5-20251101', name: 'Opus 4.5 (discovered)', contextWindow: 1000000 },
      { id: 'discovered-only', name: 'Discovered Only' },
    ]);

    const byId = new Map(registry.getModels('claude-code').models.map(m => [m.id, m]));

    // curated-only id stays curated
    expect(byId.get('discovered-only')?.source).toBe('discovered');

    // discovered overrides curated metadata for the same id
    expect(byId.get('claude-opus-4-5-20251101')?.name).toBe('Opus 4.5 (discovered)');
    expect(byId.get('claude-opus-4-5-20251101')?.contextWindow).toBe(1000000);
    expect(byId.get('claude-opus-4-5-20251101')?.source).toBe('discovered');

    // custom wins even over a curated id of the same name
    expect(byId.get('claude-sonnet-4-5-20250929')?.source).toBe('custom');
    expect(byId.get('my-custom-model')?.source).toBe('custom');
    registry.dispose();
  });

  it('drops invalid / non-string custom-model entries from the merged view', () => {
    setMockConfig('customModels', { 'claude-code': ['bad model', 'has;semicolon', 42, '', 'good-model'] });
    const { context } = makeContext();
    const registry = new ModelRegistryService(context);
    registry.setProviderSource(makeSource(CURATED));
    const ids = registry.getModels('claude-code').models.map(m => m.id);
    expect(ids).toContain('good-model');
    expect(ids).not.toContain('bad model');
    expect(ids).not.toContain('has;semicolon');
    registry.dispose();
  });

  // -------------------------------------------------------------------------
  // globalState cache round-trip
  // -------------------------------------------------------------------------

  it('persists discovered models to globalState and rehydrates them on construction', async () => {
    const { context, globalState } = makeContext();
    const registry = new ModelRegistryService(context);
    registry.setProviderSource(makeSource(CURATED));

    await registry._setDiscoveredModels('claude-code', [
      { id: 'cached-model', name: 'Cached Model', contextWindow: 500000 },
    ]);

    // Persisted under the single versioned key.
    const raw = globalState.get<Record<string, { models: ModelInfo[]; fetchedAt: number }>>(MODEL_REGISTRY_CACHE_KEY);
    expect(raw?.['claude-code']?.models?.[0]?.id).toBe('cached-model');
    expect(typeof raw?.['claude-code']?.fetchedAt).toBe('number');
    registry.dispose();

    // A fresh registry over the same globalState rehydrates the cache.
    const registry2 = new ModelRegistryService(context);
    registry2.setProviderSource(makeSource(CURATED));
    const state = registry2.getModels('claude-code');
    expect(state.discoveryStatus).toBe('cached');
    expect(state.fetchedAt).toBeGreaterThan(0);
    expect(state.models.find(m => m.id === 'cached-model')?.source).toBe('discovered');
    registry2.dispose();
  });

  // -------------------------------------------------------------------------
  // addCustomModel: validation, cap, persistence, event
  // -------------------------------------------------------------------------

  it('addCustomModel writes the setting (Global) and fires onDidUpdateModels', async () => {
    const { context } = makeContext();
    const registry = new ModelRegistryService(context);
    registry.setProviderSource(makeSource(CURATED));

    const fired: string[] = [];
    registry.onDidUpdateModels(e => fired.push(e.providerId));

    await registry.addCustomModel('claude-code', 'claude-opus-4-6[1m]');

    const written = getMockConfigUpdates()['customModels'] as Record<string, string[]>;
    expect(written['claude-code']).toEqual(['claude-opus-4-6[1m]']);
    expect(fired).toEqual(['claude-code']);
    registry.dispose();
  });

  it('addCustomModel rejects invalid ids without writing or firing', async () => {
    const { context } = makeContext();
    const registry = new ModelRegistryService(context);
    registry.setProviderSource(makeSource(CURATED));

    const fired: string[] = [];
    registry.onDidUpdateModels(e => fired.push(e.providerId));

    await registry.addCustomModel('claude-code', 'bad model with spaces');
    expect(getMockConfigUpdates()['customModels']).toBeUndefined();
    expect(fired).toEqual([]);
    registry.dispose();
  });

  it('addCustomModel is a no-op (no event) when the id already exists', async () => {
    setMockConfig('customModels', { 'claude-code': ['already-here'] });
    const { context } = makeContext();
    const registry = new ModelRegistryService(context);
    registry.setProviderSource(makeSource(CURATED));

    const fired: string[] = [];
    registry.onDidUpdateModels(e => fired.push(e.providerId));

    await registry.addCustomModel('claude-code', 'already-here');
    expect(getMockConfigUpdates()['customModels']).toBeUndefined();
    expect(fired).toEqual([]);
    registry.dispose();
  });

  it('addCustomModel enforces MODEL_CUSTOM_MAX_PER_PROVIDER', async () => {
    const atCap = Array.from({ length: MODEL_CUSTOM_MAX_PER_PROVIDER }, (_, i) => `m-${i}`);
    setMockConfig('customModels', { 'claude-code': atCap });
    const { context } = makeContext();
    const registry = new ModelRegistryService(context);
    registry.setProviderSource(makeSource(CURATED));

    const fired: string[] = [];
    registry.onDidUpdateModels(e => fired.push(e.providerId));

    await registry.addCustomModel('claude-code', 'one-too-many');
    expect(getMockConfigUpdates()['customModels']).toBeUndefined();
    expect(fired).toEqual([]);
    registry.dispose();
  });

  // -------------------------------------------------------------------------
  // removeCustomModel
  // -------------------------------------------------------------------------

  it('removeCustomModel persists the trimmed list and fires only when something changed', async () => {
    setMockConfig('customModels', { 'claude-code': ['keep', 'drop'] });
    const { context } = makeContext();
    const registry = new ModelRegistryService(context);
    registry.setProviderSource(makeSource(CURATED));

    const fired: string[] = [];
    registry.onDidUpdateModels(e => fired.push(e.providerId));

    // Removing an absent id is a no-op.
    await registry.removeCustomModel('claude-code', 'never-existed');
    expect(fired).toEqual([]);

    await registry.removeCustomModel('claude-code', 'drop');
    const written = getMockConfigUpdates()['customModels'] as Record<string, string[]>;
    expect(written['claude-code']).toEqual(['keep']);
    expect(fired).toEqual(['claude-code']);
    registry.dispose();
  });

  // -------------------------------------------------------------------------
  // refresh() — curated-only providers and signature parity (Phase 3)
  // -------------------------------------------------------------------------

  it('refresh() on a curated-only provider (no discoverModels) is a silent no-op', async () => {
    const { context, globalState } = makeContext();
    const registry = new ModelRegistryService(context);
    // No provider instance => no discoverModels => curated-only.
    registry.setProviderSource(makeSource(CURATED));

    const fired: string[] = [];
    registry.onDidUpdateModels(e => fired.push(e.providerId));

    await expect(registry.refresh('claude-code')).resolves.toBeUndefined();
    // Nothing discovered, so no cache written and no event.
    expect(globalState.get(MODEL_REGISTRY_CACHE_KEY)).toBeUndefined();
    expect(fired).toEqual([]);
    registry.dispose();
  });

  // -------------------------------------------------------------------------
  // Phase 3: refresh() drives discoverModels — persist + event on success
  // -------------------------------------------------------------------------

  it('refresh() persists a non-null discovery result and fires onDidUpdateModels', async () => {
    const { context, globalState } = makeContext();
    const registry = new ModelRegistryService(context);

    const discovered: ModelInfo[] = [
      { id: 'discovered-a', name: 'Discovered A', contextWindow: 128000 },
      { id: 'discovered-b', name: 'Discovered B' },
    ];
    const discoverModels = vi.fn(async () => discovered);
    registry.setProviderSource(
      makeSource(CURATED, { 'claude-code': makeProvider('claude-code', discoverModels) })
    );

    const fired: string[] = [];
    registry.onDidUpdateModels(e => fired.push(e.providerId));

    await registry.refresh('claude-code');

    // discoverModels was called with the hard discovery budget.
    expect(discoverModels).toHaveBeenCalledTimes(1);
    expect(discoverModels).toHaveBeenCalledWith(MODEL_DISCOVERY_TIMEOUT_MS);

    // Cache persisted under the single key with a numeric fetchedAt.
    const raw = globalState.get<Record<string, { models: ModelInfo[]; fetchedAt: number }>>(MODEL_REGISTRY_CACHE_KEY);
    expect(raw?.['claude-code']?.models.map(m => m.id)).toEqual(['discovered-a', 'discovered-b']);
    expect(typeof raw?.['claude-code']?.fetchedAt).toBe('number');

    // Event fired and the merged view now carries the discovered entries.
    expect(fired).toEqual(['claude-code']);
    const byId = new Map(registry.getModels('claude-code').models.map(m => [m.id, m]));
    expect(byId.get('discovered-a')?.source).toBe('discovered');
    expect(byId.get('discovered-a')?.contextWindow).toBe(128000);
    registry.dispose();
  });

  // -------------------------------------------------------------------------
  // Phase 3: null / empty / throw keep the stale cache, no event
  // -------------------------------------------------------------------------

  it('refresh() returning null keeps the prior cache and does NOT fire', async () => {
    const { context } = makeContext();
    const registry = new ModelRegistryService(context);

    // Prime a prior discovery so we can prove it survives a later null probe.
    let result: ModelInfo[] | null = [{ id: 'first-discovered', name: 'First' }];
    const discoverModels = vi.fn(async () => result);
    registry.setProviderSource(
      makeSource(CURATED, { 'claude-code': makeProvider('claude-code', discoverModels) })
    );

    await registry.refresh('claude-code');
    expect(registry.getModels('claude-code').models.some(m => m.id === 'first-discovered')).toBe(true);

    // Now discovery becomes unavailable.
    result = null;
    const fired: string[] = [];
    registry.onDidUpdateModels(e => fired.push(e.providerId));

    await registry.refresh('claude-code');

    // Stale cache preserved; no event for the null result.
    expect(registry.getModels('claude-code').models.some(m => m.id === 'first-discovered')).toBe(true);
    expect(fired).toEqual([]);
    registry.dispose();
  });

  it('refresh() with an empty array is treated as null (stale cache, no event)', async () => {
    const { context, globalState } = makeContext();
    const registry = new ModelRegistryService(context);
    const discoverModels = vi.fn(async () => [] as ModelInfo[]);
    registry.setProviderSource(
      makeSource(CURATED, { 'claude-code': makeProvider('claude-code', discoverModels) })
    );

    const fired: string[] = [];
    registry.onDidUpdateModels(e => fired.push(e.providerId));

    await registry.refresh('claude-code');
    expect(globalState.get(MODEL_REGISTRY_CACHE_KEY)).toBeUndefined();
    expect(fired).toEqual([]);
    registry.dispose();
  });

  it('refresh() never throws when discoverModels rejects, and keeps the stale cache', async () => {
    const { context } = makeContext();
    const registry = new ModelRegistryService(context);

    // Prime a good cache first.
    let mode: 'ok' | 'reject' = 'ok';
    const discoverModels = vi.fn(async () => {
      if (mode === 'reject') {
        throw new Error('spawn ENOENT');
      }
      return [{ id: 'primed', name: 'Primed' }] as ModelInfo[];
    });
    registry.setProviderSource(
      makeSource(CURATED, { 'claude-code': makeProvider('claude-code', discoverModels) })
    );

    await registry.refresh('claude-code');
    expect(registry.getModels('claude-code').models.some(m => m.id === 'primed')).toBe(true);

    mode = 'reject';
    const fired: string[] = [];
    registry.onDidUpdateModels(e => fired.push(e.providerId));

    // Must not reject to the caller.
    await expect(registry.refresh('claude-code')).resolves.toBeUndefined();
    // Stale cache survives, no event.
    expect(registry.getModels('claude-code').models.some(m => m.id === 'primed')).toBe(true);
    expect(fired).toEqual([]);
    registry.dispose();
  });

  // -------------------------------------------------------------------------
  // Phase 3: timeout race — an overrunning probe yields null (stale cache)
  // -------------------------------------------------------------------------

  it('refresh() times out a slow probe (keeps stale cache, no event)', async () => {
    vi.useFakeTimers();
    try {
      const { context, globalState } = makeContext();
      const registry = new ModelRegistryService(context);

      // Probe that never settles within the budget.
      const discoverModels = vi.fn(
        () =>
          new Promise<ModelInfo[] | null>(resolve => {
            setTimeout(() => resolve([{ id: 'too-late', name: 'Too Late' }]), MODEL_DISCOVERY_TIMEOUT_MS * 10);
          })
      );
      registry.setProviderSource(
        makeSource(CURATED, { 'claude-code': makeProvider('claude-code', discoverModels) })
      );

      const fired: string[] = [];
      registry.onDidUpdateModels(e => fired.push(e.providerId));

      const pending = registry.refresh('claude-code');
      // Advance past the registry's timeout race so the timeout branch wins.
      await vi.advanceTimersByTimeAsync(MODEL_DISCOVERY_TIMEOUT_MS + 1);
      await pending;

      // Timeout wins => treated as null => no cache, no event.
      expect(globalState.get(MODEL_REGISTRY_CACHE_KEY)).toBeUndefined();
      expect(fired).toEqual([]);
      registry.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  // -------------------------------------------------------------------------
  // Phase 3: in-flight dedup — concurrent triggers share one probe
  // -------------------------------------------------------------------------

  it('refresh() dedups concurrent triggers for the same provider (single spawn)', async () => {
    const { context } = makeContext();
    const registry = new ModelRegistryService(context);

    let resolveProbe!: (v: ModelInfo[] | null) => void;
    const discoverModels = vi.fn(
      () => new Promise<ModelInfo[] | null>(resolve => { resolveProbe = resolve; })
    );
    registry.setProviderSource(
      makeSource(CURATED, { 'claude-code': makeProvider('claude-code', discoverModels) })
    );

    const a = registry.refresh('claude-code');
    const b = registry.refresh('claude-code');
    // Both callers share the single in-flight probe.
    expect(discoverModels).toHaveBeenCalledTimes(1);

    resolveProbe([{ id: 'shared', name: 'Shared' }]);
    await Promise.all([a, b]);
    expect(discoverModels).toHaveBeenCalledTimes(1);
    registry.dispose();
  });

  // -------------------------------------------------------------------------
  // Phase 3: getModels() stale-while-revalidate
  // -------------------------------------------------------------------------

  it('getModels() schedules a background refresh on first read of a discoverable provider but answers now', async () => {
    const { context } = makeContext();
    const registry = new ModelRegistryService(context);

    let resolveProbe!: (v: ModelInfo[] | null) => void;
    const discoverModels = vi.fn(
      () => new Promise<ModelInfo[] | null>(resolve => { resolveProbe = resolve; })
    );
    registry.setProviderSource(
      makeSource(CURATED, { 'claude-code': makeProvider('claude-code', discoverModels) })
    );

    // No cache yet => _isStale true for a discoverable provider => kick refresh,
    // but the curated list is returned synchronously right now.
    const state = registry.getModels('claude-code');
    expect(state.models.map(m => m.id)).toEqual([
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-5-20251101',
    ]);
    expect(state.discoveryStatus).toBe('fallback');
    // The background probe was kicked (deduped).
    expect(discoverModels).toHaveBeenCalledTimes(1);

    // Let the background refresh land and verify it updated the merge.
    resolveProbe([{ id: 'bg-discovered', name: 'BG' }]);
    await registry.refresh('claude-code'); // joins the in-flight promise
    expect(registry.getModels('claude-code').models.some(m => m.id === 'bg-discovered')).toBe(true);
    registry.dispose();
  });

  it('getModels() does NOT re-probe while the CLI cache is within its TTL', async () => {
    vi.useFakeTimers();
    try {
      const { context } = makeContext();
      const registry = new ModelRegistryService(context);
      const discoverModels = vi.fn(async () => [{ id: 'cli-model', name: 'CLI' }] as ModelInfo[]);
      registry.setProviderSource(
        makeSource(CURATED, { 'claude-code': makeProvider('claude-code', discoverModels) })
      );

      // First refresh writes a fresh cache.
      await registry.refresh('claude-code');
      expect(discoverModels).toHaveBeenCalledTimes(1);

      // Within the CLI TTL: getModels() must NOT kick another probe.
      vi.advanceTimersByTime(MODEL_CACHE_TTL_CLI_MS - 1000);
      registry.getModels('claude-code');
      expect(discoverModels).toHaveBeenCalledTimes(1);

      // Past the CLI TTL: getModels() schedules a background refresh.
      vi.advanceTimersByTime(2000); // now beyond MODEL_CACHE_TTL_CLI_MS
      registry.getModels('claude-code');
      expect(discoverModels).toHaveBeenCalledTimes(2);
      registry.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies local servers (ollama) with the short local TTL', async () => {
    vi.useFakeTimers();
    try {
      const localCurated = {
        ollama: {
          defaultModel: 'llama3',
          models: [{ id: 'llama3', name: 'Llama 3' }] as ModelInfo[],
        },
      };
      const { context } = makeContext();
      const registry = new ModelRegistryService(context);
      const discoverModels = vi.fn(async () => [{ id: 'llama3.1', name: 'Llama 3.1' }] as ModelInfo[]);
      registry.setProviderSource(
        makeSource(localCurated, { ollama: makeProvider('ollama', discoverModels) })
      );

      await registry.refresh('ollama');
      expect(discoverModels).toHaveBeenCalledTimes(1);

      // Just within the SHORT local TTL: no re-probe.
      vi.advanceTimersByTime(MODEL_CACHE_TTL_LOCAL_MS - 1000);
      registry.getModels('ollama');
      expect(discoverModels).toHaveBeenCalledTimes(1);

      // Past the local TTL (but FAR below the CLI TTL): re-probe scheduled —
      // proves ollama uses MODEL_CACHE_TTL_LOCAL_MS, not the CLI TTL.
      vi.advanceTimersByTime(2000);
      registry.getModels('ollama');
      expect(discoverModels).toHaveBeenCalledTimes(2);
      registry.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  // -------------------------------------------------------------------------
  // Phase 3: refreshAll() — staggered, skips curated-only providers
  // -------------------------------------------------------------------------

  it('refreshAll() staggers per-provider probes and skips curated-only providers', async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const configs = {
        'provider-a': { defaultModel: 'a', models: [{ id: 'a', name: 'A' }] as ModelInfo[] },
        'provider-b': { defaultModel: 'b', models: [{ id: 'b', name: 'B' }] as ModelInfo[] },
        'curated-only': { defaultModel: 'c', models: [{ id: 'c', name: 'C' }] as ModelInfo[] },
      };
      const discoverA = vi.fn(async () => { order.push('a'); return [{ id: 'a', name: 'A' }] as ModelInfo[]; });
      const discoverB = vi.fn(async () => { order.push('b'); return [{ id: 'b', name: 'B' }] as ModelInfo[]; });
      const { context } = makeContext();
      const registry = new ModelRegistryService(context);
      registry.setProviderSource(
        makeSource(configs, {
          'provider-a': makeProvider('provider-a', discoverA),
          'provider-b': makeProvider('provider-b', discoverB),
          // 'curated-only' has NO discoverModels => must be skipped entirely.
          'curated-only': makeProvider('curated-only'),
        })
      );

      const all = registry.refreshAll();

      // The first probe fires immediately; the second is staggered behind a delay.
      await vi.advanceTimersByTimeAsync(0);
      expect(discoverA).toHaveBeenCalledTimes(1);
      expect(discoverB).toHaveBeenCalledTimes(0);

      // Advance past the stagger delay (REFRESH_ALL_STAGGER_MS = 400ms internally).
      await vi.advanceTimersByTimeAsync(500);
      expect(discoverB).toHaveBeenCalledTimes(1);

      await all;
      // curated-only never probed (no spawn).
      expect(order).toEqual(['a', 'b']);
      registry.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
