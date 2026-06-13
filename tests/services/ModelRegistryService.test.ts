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
 * ModelRegistryService tests (Plan 01 Phase 1 — registry core, behavior-neutral).
 * Covers: merge precedence (custom > discovered > curated), globalState cache
 * round-trip, addCustomModel cap + invalid rejection, and onDidUpdateModels
 * firing. Phase 1 refresh() is a no-op so discovery is exercised via the
 * _setDiscoveredModels seam (the path Phase 3 will drive).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ExtensionContext } from 'vscode';
import {
  ModelRegistryService,
  MODEL_REGISTRY_CACHE_KEY,
  type ModelRegistryProviderSource,
} from '../../src/services/ModelRegistryService';
import { MODEL_CUSTOM_MAX_PER_PROVIDER } from '../../src/constants';
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
  configs: Record<string, { models: ModelInfo[]; defaultModel: string }>
): ModelRegistryProviderSource {
  return {
    getProvider(id: string) {
      return configs[id];
    },
    getAllProviderIds() {
      return Object.keys(configs);
    },
  };
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
    expect(registry.getDefaultModel('nope')).toBe('claude-sonnet-4-5-20250929');
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
  // refresh() Phase-1 no-op + in-flight dedup
  // -------------------------------------------------------------------------

  it('refresh() resolves without error and refreshAll covers all providers (Phase 1 no-op)', async () => {
    const { context } = makeContext();
    const registry = new ModelRegistryService(context);
    registry.setProviderSource(makeSource(CURATED));
    await expect(registry.refresh('claude-code')).resolves.toBeUndefined();
    await expect(registry.refreshAll()).resolves.toBeUndefined();
    registry.dispose();
  });
});
