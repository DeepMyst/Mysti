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
 * Plan 01 Phase 3 — QwenCodeProvider.discoverModels.
 *
 * qwen-code drives an OpenAI-COMPATIBLE endpoint, so `GET {baseUrl}/models` is
 * the list its `-m` flag accepts. The security-relevant half of this file is the
 * PAIRING rule: a key is only ever sent to the endpoint it was configured for.
 * OPENAI_API_KEY is very commonly set for a completely different provider, so it
 * must never travel to qwen-code's default DashScope endpoint.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestableQwenProvider } from '../../helpers/providerFactory';

const DASHSCOPE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

describe('QwenCodeProvider.discoverModels (Plan 01 Phase 3)', () => {
  let provider: TestableQwenProvider;
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'DASHSCOPE_API_KEY', 'QWEN_API_KEY']) {
      delete process.env[key];
    }
    provider = new TestableQwenProvider();
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'qwen3-coder-plus' }, { id: 'qwen-max' }, { id: 'qwen3-coder-plus' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('probes an explicitly configured OpenAI-compatible endpoint with its paired key', async () => {
    process.env.OPENAI_BASE_URL = 'https://my-endpoint.example.com/v1/';
    process.env.OPENAI_API_KEY = 'sk-paired';

    const models = await provider.discoverModels(5000);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // Trailing slash trimmed so the path is not doubled.
    expect(url).toBe('https://my-endpoint.example.com/v1/models');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-paired');
    // Deduped, id-labelled.
    expect(models).toEqual([
      { id: 'qwen3-coder-plus', name: 'qwen3-coder-plus' },
      { id: 'qwen-max', name: 'qwen-max' },
    ]);
  });

  it('falls back to DashScope only for a DashScope/Qwen key', async () => {
    process.env.DASHSCOPE_API_KEY = 'ds-key';
    await provider.discoverModels(5000);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DASHSCOPE}/models`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ds-key');
  });

  it('accepts QWEN_API_KEY for the DashScope default too', async () => {
    process.env.QWEN_API_KEY = 'qwen-key';
    await provider.discoverModels(5000);
    expect(fetchMock.mock.calls[0][0]).toBe(`${DASHSCOPE}/models`);
  });

  it('NEVER sends OPENAI_API_KEY to DashScope when no base URL was configured', async () => {
    // The common case: the user has an OpenAI key exported for some other tool
    // and signed into qwen-code with OAuth. Shipping that key to Alibaba would
    // leak a third party's credential — so the probe must not happen at all.
    process.env.OPENAI_API_KEY = 'sk-someone-elses-openai-key';

    await expect(provider.discoverModels(5000)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null with no usable key pair at all (OAuth login path)', async () => {
    await expect(provider.discoverModels(5000)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a non-http(s) OPENAI_BASE_URL', async () => {
    process.env.OPENAI_BASE_URL = 'file:///etc/passwd';
    process.env.OPENAI_API_KEY = 'sk-paired';

    await expect(provider.discoverModels(5000)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null on a non-OK response, an empty catalog, or a throw', async () => {
    process.env.DASHSCOPE_API_KEY = 'ds-key';

    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    await expect(provider.discoverModels(5000)).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });
    await expect(provider.discoverModels(5000)).resolves.toBeNull();

    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await expect(provider.discoverModels(5000)).resolves.toBeNull();
  });
});
