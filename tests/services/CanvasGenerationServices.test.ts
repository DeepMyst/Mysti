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
import { describe, it, expect, afterEach, vi } from 'vitest';
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

describe('generation response validation', () => {
  function stubResponse(service: object, value: unknown) {
    const request = vi.fn(async () => JSON.stringify(value));
    Object.defineProperty(service, '_httpsRequest', { value: request });
    return request;
  }

  it.each([false, true])('preserves a successful GPT image response (reference image: %s)', async withReference => {
    setMockConfig('canvas.imageGenerationProvider', 'gpt-image-1.5');
    const service = new ImageGenerationService();
    service.setKeys({ openai: 'test-key' });
    const response = { data: [{ b64_json: 'IMAGE64', revised_prompt: 'A cat on a sunny windowsill' }] };
    const request = vi.fn(async () => JSON.stringify(response));
    Object.defineProperty(service, withReference ? '_httpsRequestBuffer' : '_httpsRequest', { value: request });

    await expect(service.generate('A cat', withReference ? { referenceImageBase64: 'AAAA' } : undefined))
      .resolves.toEqual({ imageBase64: 'IMAGE64', revisedPrompt: 'A cat on a sunny windowsill' });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      hostname: 'api.openai.com', path: withReference ? '/v1/images/edits' : '/v1/images/generations',
    }), expect.anything());
  });

  it('preserves a successful OpenAI vision response', async () => {
    const service = new ImageGenerationService();
    service.setKeys({ openai: 'key' });
    stubResponse(service, { choices: [{ message: { content: 'A blue navigation bar above the page.' } }] });
    await expect(service.analyzeImage('IMAGE64', 'Describe the page')).resolves.toBe('A blue navigation bar above the page.');
  });

  it('completes the Sora create, poll and download flow with typed response data', async () => {
    setMockConfig('canvas.videoGenerationProvider', 'sora');
    const service = new VideoGenerationService();
    service.setKeys({ openai: 'test-key' });
    const responses = [
      { id: 'video-123', status: 'queued' },
      { id: 'video-123', status: 'in_progress' },
      { id: 'video-123', status: 'completed', revised_prompt: 'A cat walking through a garden' },
    ];
    const request = vi.fn(async () => {
      const response = responses.shift();
      if (!response) { throw new Error('Unexpected additional Sora request'); }
      return JSON.stringify(response);
    });
    const download = vi.fn(async () => 'VIDEO64');
    Object.defineProperties(service, {
      _httpsRequest: { value: request },
      _sleep: { value: async () => undefined },
      _downloadSoraVideo: { value: download },
    });

    await expect(service.generate('A cat', { durationSeconds: 8 })).resolves.toEqual({
      videoBase64: 'VIDEO64', mimeType: 'video/mp4', durationSeconds: 8,
      revisedPrompt: 'A cat walking through a garden',
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenNthCalledWith(1, expect.objectContaining({ method: 'POST', path: '/v1/videos' }), expect.any(String));
    expect(request).toHaveBeenNthCalledWith(2, expect.objectContaining({ method: 'GET', path: '/v1/videos/video-123' }));
    expect(download).toHaveBeenCalledWith('test-key', 'video-123');
  });

  it('skips malformed Gemini candidates and returns the first actual text', async () => {
    const service = new ImageGenerationService();
    service.setKeys({ gemini: 'key' });
    stubResponse(service, { candidates: [null, { content: { parts: [null, { text: {} }, { text: 'description' }] } }] });
    await expect(service.analyzeImage('', 'describe')).resolves.toBe('description');
  });

  it('refuses structured OpenAI vision content where plain text is required', async () => {
    const service = new ImageGenerationService();
    service.setKeys({ openai: 'key' });
    stubResponse(service, { choices: [{ message: { content: { injected: true } } }] });
    await expect(service.analyzeImage('', 'describe')).rejects.toThrow('No text response');
  });

  it('refuses non-string generated image data', async () => {
    const service = new ImageGenerationService();
    service.setKeys({ openai: 'key' });
    stubResponse(service, { data: [{ b64_json: { invalid: true } }] });
    await expect(service.generate('a cat')).rejects.toThrow('No image data');
  });

  it('skips malformed Gemini image parts without returning an empty image', async () => {
    const service = new ImageGenerationService();
    service.setKeys({ gemini: 'key' });
    stubResponse(service, { candidates: [{ content: { parts: [
      { inlineData: { mimeType: 'image/png' } },
      { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
      { text: 42 },
    ] } }] });
    await expect(service.generate('a cat')).resolves.toEqual({ imageBase64: 'AAAA', revisedPrompt: undefined });
  });

  it.each(['sora', 'veo'])('rejects malformed %s job identifiers before polling', async provider => {
    setMockConfig('canvas.videoGenerationProvider', provider);
    const service = new VideoGenerationService();
    service.setKeys({ openai: 'key', gemini: 'key' });
    const request = stubResponse(service, { id: 42, name: { invalid: true } });
    await expect(service.generate('a clip')).rejects.toThrow(/No (video ID|operation name)/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-object API response at the boundary', async () => {
    const service = new ImageGenerationService();
    service.setKeys({ openai: 'key' });
    stubResponse(service, null);
    await expect(service.generate('a cat')).rejects.toThrow('Expected a JSON object');
  });

  it('reports a string rejection from a generation adapter without losing its message', async () => {
    const service = new CodeGenerationService();
    const imageService = new ImageGenerationService();
    vi.spyOn(imageService, 'analyzeImage').mockRejectedValue('service offline');
    const chunks = await drain(service.regenerateWithProps({
      svgMarkup: '', modifiedProps: [], framework: 'react', componentName: 'Card', imageService,
    }));
    expect(chunks.at(-1)).toEqual({ type: 'error', content: 'Regeneration failed: service offline' });
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

// ── 6.5: the Gemini key must travel in the x-goog-api-key header, never the
// URL query string (URLs land in logs/proxies). The services build requests
// through the private _httpsRequest seam, which we stub per instance.
describe('Gemini key transport (6.5 — header, not query string)', () => {
  it('vision analyze sends x-goog-api-key and a key-free path', async () => {
    const svc = new ImageGenerationService();
    svc.setKeys({ gemini: 'gem-secret' });
    const calls: any[] = [];
    (svc as any)._httpsRequest = async (opts: any) => {
      calls.push(opts);
      return JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    };
    await expect(svc.analyzeImage('', 'describe')).resolves.toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0].hostname).toBe('generativelanguage.googleapis.com');
    expect(String(calls[0].path)).not.toContain('key=');
    expect(calls[0].headers['x-goog-api-key']).toBe('gem-secret');
  });

  it('nano-banana image generation sends x-goog-api-key and a key-free path', async () => {
    setMockConfig('canvas.imageGenerationProvider', 'nano-banana');
    const svc = new ImageGenerationService();
    svc.setKeys({ gemini: 'gem-secret' });
    const calls: any[] = [];
    (svc as any)._httpsRequest = async (opts: any) => {
      calls.push(opts);
      return JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] } }],
      });
    };
    const res = await svc.generate('a cat');
    expect(res.imageBase64).toBe('AAAA');
    expect(calls).toHaveLength(1);
    expect(String(calls[0].path)).not.toContain('key=');
    expect(calls[0].headers['x-goog-api-key']).toBe('gem-secret');
  });

  it('Veo create + poll both send x-goog-api-key and key-free paths', async () => {
    setMockConfig('canvas.videoGenerationProvider', 'veo');
    const svc = new VideoGenerationService();
    svc.setKeys({ gemini: 'gem-secret' });
    const calls: any[] = [];
    (svc as any)._sleep = async () => {};
    (svc as any)._downloadUrl = async () => 'VIDEO64';
    (svc as any)._httpsRequest = async (opts: any) => {
      calls.push(opts);
      if (opts.method === 'POST') { return JSON.stringify({ name: 'operations/op-1' }); }
      return JSON.stringify({
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [{ video: { uri: 'https://generativelanguage.googleapis.com/dl/v1' } }],
          },
        },
      });
    };
    const res = await svc.generate('a clip');
    expect(res.videoBase64).toBe('VIDEO64');
    expect(calls.length).toBe(2); // create + one poll
    for (const c of calls) {
      expect(c.hostname).toBe('generativelanguage.googleapis.com');
      expect(String(c.path)).not.toContain('key=');
      expect(c.headers['x-goog-api-key']).toBe('gem-secret');
    }
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
