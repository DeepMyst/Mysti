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

import type { ModelEntry, ProviderModelState } from '../../src/types';

/**
 * Minimal ModelRegistryService stand-in for ChatViewProvider harnesses.
 *
 * The provider SUBSCRIBES to onDidUpdateModels in its constructor (Plan 01
 * Phase 4 — automatic model-list updates are pushed to open panels), so a bare
 * `noop` is no longer a usable stub. `emit()` fires that event the way a real
 * background discovery refresh would, which is what lets a test assert the
 * 'modelsUpdated' broadcast.
 */
export interface ModelRegistryStub {
  onDidUpdateModels(listener: (e: { providerId: string }) => void): { dispose(): void };
  getModels(providerId: string): ProviderModelState;
  getDefaultModel(providerId: string): string;
  getContextWindow(providerId: string, modelId: string): number | undefined;
  refresh(providerId: string, opts?: { force?: boolean }): Promise<void>;
  /** Test hook: fire onDidUpdateModels for a provider. */
  emit(providerId: string): void;
  /** Test hook: replace what getModels() answers for a provider. */
  setModels(providerId: string, state: Partial<ProviderModelState>): void;
  /** Test hook: every refresh() call, in order. */
  readonly refreshCalls: Array<{ providerId: string; force?: boolean }>;
}

export function createModelRegistryStub(
  initial: Record<string, Partial<ProviderModelState>> = {}
): ModelRegistryStub {
  const listeners = new Set<(e: { providerId: string }) => void>();
  const states = new Map<string, ProviderModelState>();
  const refreshCalls: Array<{ providerId: string; force?: boolean }> = [];

  const normalize = (partial: Partial<ProviderModelState>): ProviderModelState => ({
    models: (partial.models ?? []) as ModelEntry[],
    defaultModel: partial.defaultModel ?? '',
    fetchedAt: partial.fetchedAt ?? 0,
    discoveryStatus: partial.discoveryStatus ?? 'fallback',
  });

  for (const [providerId, partial] of Object.entries(initial)) {
    states.set(providerId, normalize(partial));
  }

  return {
    onDidUpdateModels(listener) {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    getModels(providerId) {
      return states.get(providerId) ?? normalize({});
    },
    getDefaultModel(providerId) {
      return states.get(providerId)?.defaultModel ?? '';
    },
    getContextWindow(providerId, modelId) {
      return states.get(providerId)?.models.find(m => m.id === modelId)?.contextWindow;
    },
    async refresh(providerId, opts) {
      refreshCalls.push({ providerId, force: opts?.force });
    },
    emit(providerId) {
      for (const listener of listeners) {
        listener({ providerId });
      }
    },
    setModels(providerId, state) {
      states.set(providerId, normalize(state));
    },
    refreshCalls,
  };
}
