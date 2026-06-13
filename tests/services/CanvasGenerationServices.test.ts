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
 * Service-level tests for the canvas generation services (Plan 05 Phase 0):
 * - F-11: key injection via setKeys() drives isAvailable (no settings/env reads).
 * - F-7:  CodeGenerationService.regenerateWithProps embeds the current source.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ImageGenerationService } from '../../src/services/ImageGenerationService';
import { VideoGenerationService } from '../../src/services/VideoGenerationService';
import { CodeGenerationService } from '../../src/services/CodeGenerationService';
import { setMockConfig, clearMockConfig } from '../helpers/mockVscode';

afterEach(() => {
  clearMockConfig();
});

describe('ImageGenerationService key injection (F-11)', () => {
  it('isAvailable is false before any key is injected', () => {
    const svc = new ImageGenerationService();
    expect(svc.isAvailable).toBe(false);
    expect(svc.isVisionAvailable).toBe(false);
  });

  it('isAvailable becomes true after an OpenAI key is injected (auto-detect)', () => {
    const svc = new ImageGenerationService();
    svc.setKeys({ openai: 'sk-test' });
    expect(svc.isAvailable).toBe(true);
    expect(svc.isVisionAvailable).toBe(true);
  });

  it('isAvailable becomes true after a Gemini key is injected (auto-detect)', () => {
    const svc = new ImageGenerationService();
    svc.setKeys({ gemini: 'gem-test' });
    expect(svc.isAvailable).toBe(true);
    expect(svc.isVisionAvailable).toBe(true);
  });

  it('does NOT read keys from settings (F-11)', () => {
    // Even if a legacy plaintext setting is present, the service ignores it.
    setMockConfig('canvas.openaiApiKey', 'sk-from-settings');
    const svc = new ImageGenerationService();
    expect(svc.isAvailable).toBe(false);
  });

  it('respects an explicitly-configured provider with the matching key', () => {
    setMockConfig('canvas.imageGenerationProvider', 'gpt-image-1.5');
    const svc = new ImageGenerationService();
    expect(svc.isAvailable).toBe(false); // provider set, but no key yet
    svc.setKeys({ openai: 'sk-test' });
    expect(svc.isAvailable).toBe(true);
    expect(svc.provider).toBe('gpt-image-1.5');
  });

  it('clearing keys via setKeys flips isAvailable back to false', () => {
    const svc = new ImageGenerationService();
    svc.setKeys({ openai: 'sk-test' });
    expect(svc.isAvailable).toBe(true);
    svc.setKeys({});
    expect(svc.isAvailable).toBe(false);
  });
});

describe('VideoGenerationService key injection (F-11)', () => {
  it('isAvailable is false before any key is injected', () => {
    const svc = new VideoGenerationService();
    expect(svc.isAvailable).toBe(false);
  });

  it('isAvailable becomes true after an OpenAI (Sora) key is injected', () => {
    const svc = new VideoGenerationService();
    svc.setKeys({ openai: 'sk-test' });
    expect(svc.isAvailable).toBe(true);
  });

  it('isAvailable becomes true after a Gemini (Veo) key is injected', () => {
    const svc = new VideoGenerationService();
    svc.setKeys({ gemini: 'gem-test' });
    expect(svc.isAvailable).toBe(true);
  });

  it('does NOT read keys from settings (F-11)', () => {
    setMockConfig('canvas.geminiApiKey', 'gem-from-settings');
    const svc = new VideoGenerationService();
    expect(svc.isAvailable).toBe(false);
  });
});

/** Minimal ImageGenerationService stand-in that captures the prompt. */
function fakeImageService(response: string) {
  const calls: Array<{ image: string; prompt: string }> = [];
  const stub = {
    calls,
    async analyzeImage(image: string, prompt: string): Promise<string> {
      calls.push({ image, prompt });
      return response;
    },
  };
  return stub;
}

const VALID_RESPONSE = [
  '```component',
  'export const Card = ({ title = "New Title" }) => <div>{title}</div>;',
  '```',
  '```story',
  'export default { title: "Card" };',
  '```',
].join('\n');

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) { out.push(v); }
  return out;
}

describe('CodeGenerationService.regenerateWithProps (F-7)', () => {
  it('includes the current component source in the regeneration prompt', async () => {
    const svc = new CodeGenerationService();
    const img = fakeImageService(VALID_RESPONSE);
    const currentSource = 'export const Card = ({ title = "Old Title" }) => <div>{title}</div>;';

    await drain(svc.regenerateWithProps({
      svgMarkup: '',
      modifiedProps: [{ id: 'p1', name: 'title', type: 'text', value: 'New Title', category: 'content' } as any],
      framework: 'react',
      componentName: 'Card',
      imageService: img as any,
      currentSource,
    }));

    expect(img.calls.length).toBe(1);
    const prompt = img.calls[0].prompt;
    expect(prompt).toContain('Current component source');
    expect(prompt).toContain(currentSource);
    expect(prompt).toContain('title: text = "New Title"');
  });

  it('includes the SVG markup when provided', async () => {
    const svc = new CodeGenerationService();
    const img = fakeImageService(VALID_RESPONSE);
    const svg = '<svg><rect width="10" height="10"/></svg>';

    await drain(svc.regenerateWithProps({
      svgMarkup: svg,
      modifiedProps: [{ id: 'p1', name: 'title', type: 'text', value: 'X', category: 'content' } as any],
      framework: 'react',
      componentName: 'Card',
      imageService: img as any,
    }));

    expect(img.calls[0].prompt).toContain(svg);
    expect(img.calls[0].prompt).toContain('Original SVG');
  });

  it('falls back gracefully when neither source nor SVG is provided', async () => {
    const svc = new CodeGenerationService();
    const img = fakeImageService(VALID_RESPONSE);

    const chunks = await drain(svc.regenerateWithProps({
      svgMarkup: '',
      modifiedProps: [{ id: 'p1', name: 'title', type: 'text', value: 'X', category: 'content' } as any],
      framework: 'react',
      componentName: 'Card',
      imageService: img as any,
    }));

    expect(img.calls[0].prompt).toContain('No existing source was provided');
    // Still produces a parsed component file from the response.
    const complete = chunks.find(c => c.type === 'complete');
    expect(complete?.files?.length).toBeGreaterThan(0);
  });
});
