/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { PromptEnhancementUnsupportedError } from '../../src/managers/ProviderManager';

vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: () => '<html></html>' }));

/** The host echoes the asking click's id on every enhancement reply, so the webview can drop stale ones. */
describe('prompt enhancement reply identity', () => {
  function host(enhancePrompt: (prompt: string) => Promise<unknown>) {
    const posted = vi.fn();
    const provider = Object.assign(Object.create(ChatViewProvider.prototype), {
      _providerManager: { enhancePrompt: vi.fn(enhancePrompt) }, _postToPanel: posted,
    }) as { _handleEnhancePrompt(request: unknown, panelId: string): Promise<void>; _providerManager: { enhancePrompt: ReturnType<typeof vi.fn> } };
    return { provider, posted };
  }

  it.each([
    ['promptEnhanced', async (prompt: string) => ({ prompt: prompt + '!', changed: true, fallback: false, enhancedBy: 'x', enhancedById: 'x' })],
    ['promptEnhanceUnavailable', async () => { throw new PromptEnhancementUnsupportedError('Fixture'); }],
    ['promptEnhanceError', async () => { throw new Error('failed'); }],
  ] as const)('%s carries the request enhanceId', async (type, enhance) => {
    const h = host(enhance);
    await h.provider._handleEnhancePrompt({ prompt: 'draft', enhanceId: 'enhance-7' }, 'panel');
    expect(h.provider._providerManager.enhancePrompt).toHaveBeenCalledWith('draft');
    expect(h.posted).toHaveBeenCalledWith('panel', expect.objectContaining({ type, payload: expect.objectContaining({ enhanceId: 'enhance-7' }) }));
  });

  it('ignores a request without a prompt string', async () => {
    const h = host(async () => ({}));
    await h.provider._handleEnhancePrompt({ enhanceId: 'enhance-1' }, 'panel');
    expect(h.provider._providerManager.enhancePrompt).not.toHaveBeenCalled();
    expect(h.posted).not.toHaveBeenCalled();
  });
});
