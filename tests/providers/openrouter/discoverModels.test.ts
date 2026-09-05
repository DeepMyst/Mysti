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

/**
 * Plan 01 Phase 3 — OpenRouterProvider.discoverModels.
 *
 * Scoped to the FREE tier deliberately: the full catalog is ~300 entries (too
 * many to persist per activation, far too many to pick from), the curated list
 * already carries the paid models worth one-click access, and the free tier is
 * the half that actually rotates — so it is the half a background refresh
 * should be keeping current.
 */
import { describe, it, expect, vi } from 'vitest';
import { TestableOpenRouterProvider } from '../../helpers/providerFactory';
import type { OpenRouterClient, OpenRouterModel } from '../../../src/services/OpenRouterClient';

function withFreeModels(
  provider: TestableOpenRouterProvider,
  impl: () => Promise<OpenRouterModel[]>
) {
  const listFreeModels = vi.fn(impl);
  provider.setClient({ listFreeModels } as unknown as OpenRouterClient);
  return listFreeModels;
}

describe('OpenRouterProvider.discoverModels (Plan 01 Phase 3)', () => {
  it('maps the free catalog to ModelInfo, carrying the context window', async () => {
    const provider = new TestableOpenRouterProvider();
    withFreeModels(provider, async () => [
      { id: 'openai/gpt-oss-120b:free', name: 'GPT-OSS 120B (free)', contextLength: 131000, supportsTools: true, free: true },
      { id: 'google/gemma-4-31b-it:free', supportsTools: false, free: true },
    ]);

    const models = await provider.discoverModels(5000);

    expect(models).toEqual([
      {
        id: 'openai/gpt-oss-120b:free',
        name: 'GPT-OSS 120B (free)',
        description: 'Free · tool-capable',
        contextWindow: 131000,
      },
      {
        id: 'google/gemma-4-31b-it:free',
        name: 'google/gemma-4-31b-it:free',
        description: 'Free',
        contextWindow: undefined,
      },
    ]);
  });

  it('returns null on an empty catalog so the curated list keeps serving', async () => {
    const provider = new TestableOpenRouterProvider();
    withFreeModels(provider, async () => []);
    await expect(provider.discoverModels(5000)).resolves.toBeNull();
  });

  it('never throws when the catalog fetch fails', async () => {
    const provider = new TestableOpenRouterProvider();
    withFreeModels(provider, async () => { throw new Error('offline'); });
    await expect(provider.discoverModels(5000)).resolves.toBeNull();
  });
});
