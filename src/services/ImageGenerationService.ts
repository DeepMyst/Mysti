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
import * as https from 'https';
import type { ImageGenerationProvider } from '../types';

interface GenerateOptions {
  size?: string;
  style?: string;
  model?: string;
  frameBounds?: { width: number; height: number };
  background?: 'transparent' | 'opaque' | 'auto';
  referenceImageBase64?: string;
}

interface GenerateResult {
  imageBase64: string;
  revisedPrompt?: string;
}

/**
 * Pluggable image generation service with GPT Image (OpenAI) and Gemini (Google) adapters.
 */
export class ImageGenerationService {
  private _provider: ImageGenerationProvider;

  constructor() {
    this._provider = vscode.workspace.getConfiguration('mysti')
      .get<ImageGenerationProvider>('canvas.imageGenerationProvider', 'none');
  }

  get provider(): ImageGenerationProvider {
    return this._provider;
  }

  get isAvailable(): boolean {
    const provider = this._resolveProvider();
    if (provider === 'none') { return false; }
    if (provider === 'gpt-image-1.5' || provider === 'gpt-image-1' || provider === 'gpt-image-1-mini') {
      return !!this._getOpenAIKey();
    }
    if (provider === 'nano-banana' || provider === 'nano-banana-pro') {
      return !!this._getGeminiKey();
    }
    return false;
  }

  get isVisionAvailable(): boolean {
    return this._resolveVisionProvider() !== 'none';
  }

  /**
   * Send an image (base64 PNG) + text prompt to a vision model and return the text response.
   * Uses Gemini (preferred) or OpenAI Chat Completions with vision.
   * If imageBase64 is empty, sends a text-only prompt.
   */
  async analyzeImage(imageBase64: string, prompt: string): Promise<string> {
    const provider = this._resolveVisionProvider();
    if (provider === 'none') {
      throw new Error('No API key configured for vision analysis. Set mysti.canvas.geminiApiKey or mysti.canvas.openaiApiKey in settings.');
    }

    console.log(`[Mysti] Vision: Using ${provider} for image analysis (imageSize=${imageBase64.length})`);

    if (provider === 'gemini') {
      return this._analyzeWithGemini(imageBase64, prompt);
    }
    return this._analyzeWithOpenAI(imageBase64, prompt);
  }

  private async _analyzeWithGemini(imageBase64: string, prompt: string): Promise<string> {
    const apiKey = this._getGeminiKey();
    const parts: any[] = [{ text: prompt }];
    if (imageBase64) {
      parts.push({
        inline_data: {
          mime_type: 'image/png',
          data: imageBase64,
        }
      });
    }

    const body = JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ['TEXT'],
        maxOutputTokens: 16384,
      },
    });

    const response = await this._httpsRequest({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, body);

    const parsed = JSON.parse(response);
    if (parsed.error) {
      throw new Error(`Gemini vision error: ${parsed.error.message}`);
    }

    const candidates = parsed.candidates || [];
    for (const candidate of candidates) {
      const parts = candidate.content?.parts || [];
      for (const part of parts) {
        if (part.text) { return part.text; }
      }
    }

    throw new Error('Gemini vision: No text response received');
  }

  private async _analyzeWithOpenAI(imageBase64: string, prompt: string): Promise<string> {
    const apiKey = this._getOpenAIKey();
    const content: any[] = [{ type: 'text', text: prompt }];
    if (imageBase64) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${imageBase64}` },
      });
    }

    const body = JSON.stringify({
      model: 'gpt-5-mini',
      max_tokens: 16384,
      messages: [{ role: 'user', content }],
    });

    const response = await this._httpsRequest({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, body);

    const parsed = JSON.parse(response);
    if (parsed.error) {
      throw new Error(`OpenAI vision error: ${parsed.error.message}`);
    }

    const text = parsed.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error('OpenAI vision: No text response received');
    }
    return text;
  }

  private _resolveVisionProvider(): 'gemini' | 'openai' | 'none' {
    if (this._getGeminiKey()) { return 'gemini'; }
    if (this._getOpenAIKey()) { return 'openai'; }
    return 'none';
  }

  /**
   * Resolve provider: use explicit setting, or auto-detect from available API keys.
   */
  private _resolveProvider(): ImageGenerationProvider {
    // Re-read config in case user changed it
    const configured = vscode.workspace.getConfiguration('mysti')
      .get<ImageGenerationProvider>('canvas.imageGenerationProvider', 'none');

    if (configured !== 'none') { return configured; }

    // Auto-detect: prefer Gemini (cheaper/faster), fall back to GPT Image
    if (this._getGeminiKey()) { return 'nano-banana'; }
    if (this._getOpenAIKey()) { return 'gpt-image-1.5'; }
    return 'none';
  }

  async generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult> {
    this._provider = this._resolveProvider();

    switch (this._provider) {
      case 'gpt-image-1.5':
        return this._generateGptImage(prompt, 'gpt-image-1.5', options);
      case 'gpt-image-1':
        return this._generateGptImage(prompt, 'gpt-image-1', options);
      case 'gpt-image-1-mini':
        return this._generateGptImage(prompt, 'gpt-image-1-mini', options);
      case 'nano-banana':
        return this._generateNanoBanana(prompt, 'gemini-3.1-flash-image-preview', options);
      case 'nano-banana-pro':
        return this._generateNanoBanana(prompt, 'gemini-3-pro-image-preview', options);
      case 'none':
      default:
        throw new Error('No image generation provider available. Set GEMINI_API_KEY or OPENAI_API_KEY environment variable, or configure mysti.canvas.imageGenerationProvider in settings.');
    }
  }

  // ========================================================================
  // GPT Image Adapter (OpenAI)
  // ========================================================================

  private async _generateGptImage(prompt: string, model: string, options?: GenerateOptions): Promise<GenerateResult> {
    const apiKey = this._getOpenAIKey();
    if (!apiKey) { throw new Error('OpenAI API key not configured. Set mysti.canvas.openaiApiKey in settings.'); }

    const size = options?.frameBounds
      ? ImageGenerationService.mapToApiSize(options.frameBounds.width, options.frameBounds.height)
      : (options?.size || '1024x1024');

    // When a reference image is provided, use /v1/images/edits (multipart/form-data)
    if (options?.referenceImageBase64) {
      const imageBuffer = Buffer.from(options.referenceImageBase64, 'base64');
      const fields: Record<string, string> = {
        model,
        prompt,
        n: '1',
        size,
        input_fidelity: 'high',
      };
      if (options.background) { fields.background = options.background; }
      const { body, boundary } = this._buildMultipartBody(fields, imageBuffer, 'image');

      const response = await this._httpsRequestBuffer({
        hostname: 'api.openai.com',
        path: '/v1/images/edits',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': body.length,
        },
      }, body);

      const parsed = JSON.parse(response);
      if (parsed.error) {
        throw new Error(`GPT Image error: ${parsed.error.message}`);
      }
      const imageData = parsed.data?.[0];
      if (!imageData?.b64_json) {
        throw new Error('GPT Image: No image data in response');
      }
      return { imageBase64: imageData.b64_json, revisedPrompt: imageData.revised_prompt };
    }

    // Text-only generation (no reference image)
    const body = JSON.stringify({
      model,
      prompt,
      n: 1,
      size,
      output_format: 'png',
      ...(options?.background ? { background: options.background } : {}),
    });

    const response = await this._httpsRequest({
      hostname: 'api.openai.com',
      path: '/v1/images/generations',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, body);

    const parsed = JSON.parse(response);
    if (parsed.error) {
      throw new Error(`GPT Image error: ${parsed.error.message}`);
    }

    const imageData = parsed.data?.[0];
    if (!imageData?.b64_json) {
      throw new Error('GPT Image: No image data in response');
    }

    return {
      imageBase64: imageData.b64_json,
      revisedPrompt: imageData.revised_prompt,
    };
  }

  // ========================================================================
  // Nano Banana Adapter (Google Gemini API)
  // ========================================================================

  private async _generateNanoBanana(prompt: string, model: string, options?: GenerateOptions): Promise<GenerateResult> {
    const apiKey = this._getGeminiKey();
    if (!apiKey) { throw new Error('Gemini API key not configured. Set mysti.canvas.geminiApiKey in settings.'); }

    // Map frame dimensions to Gemini aspect ratio
    const generationConfig: Record<string, any> = {
      responseModalities: ['TEXT', 'IMAGE'],
    };
    if (options?.frameBounds) {
      const { width, height } = options.frameBounds;
      generationConfig.imageConfig = {
        aspectRatio: ImageGenerationService._mapToGeminiAspectRatio(width, height),
      };
    }

    const parts: any[] = [{ text: `Generate an image: ${prompt}` }];
    if (options?.referenceImageBase64) {
      parts.push({
        inline_data: {
          mime_type: 'image/png',
          data: options.referenceImageBase64,
        }
      });
    }

    const body = JSON.stringify({
      contents: [{ parts }],
      generationConfig,
    });

    const response = await this._httpsRequest({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, body);

    const parsed = JSON.parse(response);
    if (parsed.error) {
      throw new Error(`Nano Banana error: ${parsed.error.message}`);
    }

    // Extract image from response parts
    const candidates = parsed.candidates || [];
    for (const candidate of candidates) {
      const parts = candidate.content?.parts || [];
      for (const part of parts) {
        if (part.inlineData?.mimeType?.startsWith('image/')) {
          return {
            imageBase64: part.inlineData.data,
            revisedPrompt: parts.find((p: any) => p.text)?.text,
          };
        }
      }
    }

    throw new Error('Nano Banana: No image data in response');
  }

  // ========================================================================
  // Size Mapping
  // ========================================================================

  /**
   * Map frame dimensions to the closest supported GPT Image API size.
   * Supported: 1024x1024, 1024x1536 (portrait), 1536x1024 (landscape), auto.
   */
  static mapToApiSize(width: number, height: number): string {
    const ratio = width / height;
    if (ratio > 1.2) { return '1536x1024'; }
    if (ratio < 0.8) { return '1024x1536'; }
    return '1024x1024';
  }

  /**
   * Map frame dimensions to closest Gemini-supported aspect ratio.
   * Valid: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9
   */
  static _mapToGeminiAspectRatio(width: number, height: number): string {
    const ratio = width / height;
    const options = [
      { r: 1, label: '1:1' },
      { r: 2 / 3, label: '2:3' },
      { r: 3 / 2, label: '3:2' },
      { r: 3 / 4, label: '3:4' },
      { r: 4 / 3, label: '4:3' },
      { r: 4 / 5, label: '4:5' },
      { r: 5 / 4, label: '5:4' },
      { r: 9 / 16, label: '9:16' },
      { r: 16 / 9, label: '16:9' },
      { r: 21 / 9, label: '21:9' },
    ];
    let closest = options[0];
    let minDiff = Math.abs(ratio - closest.r);
    for (const opt of options) {
      const diff = Math.abs(ratio - opt.r);
      if (diff < minDiff) { minDiff = diff; closest = opt; }
    }
    return closest.label;
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  private _getOpenAIKey(): string {
    // Priority: canvas-specific setting → environment variable
    const settingsKey = vscode.workspace.getConfiguration('mysti').get('canvas.openaiApiKey', '');
    if (settingsKey) { return settingsKey; }
    return process.env.OPENAI_API_KEY || '';
  }

  private _getGeminiKey(): string {
    // Priority: canvas-specific setting → environment variable
    const settingsKey = vscode.workspace.getConfiguration('mysti').get('canvas.geminiApiKey', '');
    if (settingsKey) { return settingsKey; }
    return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  }

  private _buildMultipartBody(fields: Record<string, string>, imageBuffer?: Buffer, imageFieldName?: string): { body: Buffer; boundary: string } {
    const boundary = '----MystiBoundary' + Date.now().toString(36);
    const parts: Buffer[] = [];

    for (const [key, value] of Object.entries(fields)) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
      ));
    }

    if (imageBuffer && imageFieldName) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${imageFieldName}[]"; filename="canvas-snapshot.png"\r\nContent-Type: image/png\r\n\r\n`
      ));
      parts.push(imageBuffer);
      parts.push(Buffer.from('\r\n'));
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return { body: Buffer.concat(parts), boundary };
  }

  private _httpsRequestBuffer(options: https.RequestOptions, body: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode && res.statusCode >= 400) {
            try {
              const errBody = JSON.parse(data);
              reject(new Error(errBody.error?.message || `HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
            } catch {
              reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
            }
          } else {
            resolve(data);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(120000, () => {
        req.destroy(new Error('Image edit request timed out (120s)'));
      });
      req.write(body);
      req.end();
    });
  }

  private _httpsRequest(options: https.RequestOptions, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode && res.statusCode >= 400) {
            try {
              const errBody = JSON.parse(data);
              reject(new Error(errBody.error?.message || `HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
            } catch {
              reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
            }
          } else {
            resolve(data);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(60000, () => {
        req.destroy(new Error('Image generation request timed out (60s)'));
      });
      req.write(body);
      req.end();
    });
  }
}
