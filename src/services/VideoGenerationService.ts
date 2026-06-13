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
import type { VideoGenerationProvider } from '../types';
import {
  CANVAS_VIDEO_POLL_INTERVAL_MS,
  CANVAS_VIDEO_POLL_MAX_MS,
  CANVAS_VIDEO_DEFAULT_DURATION_S
} from '../constants';

interface VideoGenerateOptions {
  frameBounds?: { width: number; height: number };
  durationSeconds?: number;
}

interface VideoGenerateResult {
  videoBase64: string;
  mimeType: string;
  durationSeconds: number;
  revisedPrompt?: string;
}

/**
 * Video generation service with OpenAI Sora 2 and Google Veo 3.1 adapters.
 * All video APIs are async: POST to create → poll for status → retrieve result.
 */
export class VideoGenerationService {
  /** F-24: maximum redirects followed by the download helpers before erroring. */
  private static readonly _maxDownloadRedirects = 5;

  private _provider: VideoGenerationProvider;

  // Keys injected by the caller (resolved from CanvasSecrets). The service no
  // longer reads `mysti.canvas.*ApiKey` settings or `process.env` for keys
  // (F-11). Call `setKeys()` before `isAvailable`/`generate`.
  private _openaiKey = '';
  private _geminiKey = '';

  constructor() {
    this._provider = vscode.workspace.getConfiguration('mysti')
      .get<VideoGenerationProvider>('canvas.videoGenerationProvider', 'none');
  }

  /**
   * Inject the API keys resolved from SecretStorage (F-11). Either field may be
   * omitted/empty when the user hasn't configured that provider. Re-callable.
   */
  setKeys(keys: { openai?: string; gemini?: string }): void {
    this._openaiKey = keys.openai || '';
    this._geminiKey = keys.gemini || '';
  }

  get provider(): VideoGenerationProvider {
    return this._provider;
  }

  get isAvailable(): boolean {
    const provider = this._resolveProvider();
    if (provider === 'none') { return false; }
    if (provider === 'sora') { return !!this._getOpenAIKey(); }
    if (provider === 'veo') { return !!this._getGeminiKey(); }
    return false;
  }

  private _resolveProvider(): VideoGenerationProvider {
    const configured = vscode.workspace.getConfiguration('mysti')
      .get<VideoGenerationProvider>('canvas.videoGenerationProvider', 'none');
    if (configured !== 'none') { return configured; }

    // Auto-detect: prefer Sora (better video quality), fall back to Veo
    if (this._getOpenAIKey()) { return 'sora'; }
    if (this._getGeminiKey()) { return 'veo'; }
    return 'none';
  }

  async generate(
    prompt: string,
    options?: VideoGenerateOptions,
    onProgress?: (message: string, progress: number) => void
  ): Promise<VideoGenerateResult> {
    this._provider = this._resolveProvider();

    switch (this._provider) {
      case 'sora':
        return this._generateSora(prompt, options, onProgress);
      case 'veo':
        return this._generateVeo(prompt, options, onProgress);
      case 'none':
      default:
        throw new Error('No video generation provider available. Set OPENAI_API_KEY or GEMINI_API_KEY, or configure mysti.canvas.videoGenerationProvider in settings.');
    }
  }

  /**
   * Map frame dimensions to video resolution.
   * Sora supports: 1280x720 (landscape), 720x1280 (portrait), 1080x1080 (square)
   */
  static mapToVideoSize(width: number, height: number): string {
    const ratio = width / height;
    if (ratio > 1.2) { return '1280x720'; }
    if (ratio < 0.8) { return '720x1280'; }
    return '1080x1080';
  }

  // ========================================================================
  // Sora 2 Adapter (OpenAI)
  // ========================================================================

  private async _generateSora(
    prompt: string,
    options?: VideoGenerateOptions,
    onProgress?: (message: string, progress: number) => void
  ): Promise<VideoGenerateResult> {
    const apiKey = this._getOpenAIKey();
    if (!apiKey) { throw new Error('OpenAI API key not configured.'); }

    const duration = options?.durationSeconds || CANVAS_VIDEO_DEFAULT_DURATION_S;
    const size = options?.frameBounds
      ? VideoGenerationService.mapToVideoSize(options.frameBounds.width, options.frameBounds.height)
      : '1280x720';

    // Step 1: Create video generation job (multipart/form-data)
    onProgress?.('Submitting video generation...', 10);
    const boundary = '----MystiVideoBoundary' + Date.now();
    const formParts: string[] = [];
    const addField = (name: string, value: string) => {
      formParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`);
    };
    addField('model', 'sora-2');
    addField('prompt', prompt);
    addField('size', size);
    addField('seconds', String(duration));
    const createBody = formParts.join('\r\n') + `\r\n--${boundary}--\r\n`;

    const createResponse = await this._httpsRequest({
      hostname: 'api.openai.com',
      path: '/v1/videos',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(createBody),
      },
    }, createBody);

    const created = JSON.parse(createResponse);
    if (created.error) {
      throw new Error(`Sora error: ${created.error.message}`);
    }
    const videoId = created.id;
    if (!videoId) {
      throw new Error('Sora: No video ID in creation response');
    }

    // Step 2: Poll for completion
    onProgress?.('Generating video...', 20);
    const videoData = await this._pollSoraStatus(apiKey, videoId, onProgress);

    // Step 3: Download the video content
    onProgress?.('Downloading video...', 85);
    const videoContent = await this._downloadSoraVideo(apiKey, videoId);

    return {
      videoBase64: videoContent,
      mimeType: 'video/mp4',
      durationSeconds: duration,
      revisedPrompt: videoData.revised_prompt,
    };
  }

  private async _pollSoraStatus(
    apiKey: string,
    videoId: string,
    onProgress?: (message: string, progress: number) => void
  ): Promise<any> {
    const startTime = Date.now();
    let attempt = 0;

    while (Date.now() - startTime < CANVAS_VIDEO_POLL_MAX_MS) {
      await this._sleep(CANVAS_VIDEO_POLL_INTERVAL_MS);
      attempt++;

      const progress = Math.min(20 + (attempt * 5), 80);
      onProgress?.(`Generating video... (${Math.round((Date.now() - startTime) / 1000)}s)`, progress);

      const response = await this._httpsRequest({
        hostname: 'api.openai.com',
        path: `/v1/videos/${videoId}`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });

      const status = JSON.parse(response);
      if (status.error) {
        throw new Error(`Sora polling error: ${status.error.message}`);
      }

      if (status.status === 'completed') {
        return status;
      }
      if (status.status === 'failed') {
        throw new Error(`Sora video generation failed: ${status.failure_reason || 'Unknown reason'}`);
      }
    }

    throw new Error(`Sora video generation timed out after ${CANVAS_VIDEO_POLL_MAX_MS / 1000}s`);
  }

  private async _downloadSoraVideo(apiKey: string, videoId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.openai.com',
        path: `/v1/videos/${videoId}/content`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}` },
      }, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          // Follow redirect to actual video URL
          const redirectUrl = res.headers.location;
          if (redirectUrl) {
            this._downloadUrl(redirectUrl).then(resolve).catch(reject);
            return;
          }
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Failed to download video: HTTP ${res.statusCode}`));
          } else {
            resolve(Buffer.concat(chunks).toString('base64'));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(60000, () => req.destroy(new Error('Video download timed out')));
      req.end();
    });
  }

  // ========================================================================
  // Veo 3.1 Adapter (Google Gemini API)
  // ========================================================================

  private async _generateVeo(
    prompt: string,
    options?: VideoGenerateOptions,
    onProgress?: (message: string, progress: number) => void
  ): Promise<VideoGenerateResult> {
    const apiKey = this._getGeminiKey();
    if (!apiKey) { throw new Error('Gemini API key not configured.'); }

    // Veo only accepts 4, 6, or 8 seconds
    const rawDuration = options?.durationSeconds || CANVAS_VIDEO_DEFAULT_DURATION_S;
    const duration = [4, 6, 8].reduce((prev, curr) =>
      Math.abs(curr - rawDuration) < Math.abs(prev - rawDuration) ? curr : prev
    );
    let sizeHint = '';
    if (options?.frameBounds) {
      const { width, height } = options.frameBounds;
      const orientation = width > height ? 'landscape' : width < height ? 'portrait' : 'square';
      sizeHint = ` The video should be ${orientation} orientation.`;
    }

    // Step 1: Create video generation request via predictLongRunning
    onProgress?.('Submitting video generation...', 10);
    // Veo only supports 16:9 and 9:16
    const aspectRatio = options?.frameBounds
      ? (options.frameBounds.height > options.frameBounds.width ? '9:16' : '16:9')
      : '16:9';
    const params: Record<string, any> = {
      aspectRatio,
      resolution: '720p',
    };
    // Only include durationSeconds if explicitly requested (API default is 8).
    // F-9: send the Veo-legal snapped value, not the raw caller value.
    if (options?.durationSeconds) {
      params.durationSeconds = duration;
    }
    const createBody = JSON.stringify({
      instances: [{
        prompt: `${prompt}${sizeHint}`,
      }],
      parameters: params,
    });

    const createResponse = await this._httpsRequest({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/veo-3.1-generate-preview:predictLongRunning?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(createBody),
      },
    }, createBody);

    const created = JSON.parse(createResponse);
    if (created.error) {
      throw new Error(`Veo error: ${created.error.message}`);
    }

    const operationName = created.name;
    if (!operationName) {
      throw new Error('Veo: No operation name in creation response');
    }

    // Step 2: Poll operation for completion
    onProgress?.('Generating video...', 20);
    const result = await this._pollVeoOperation(apiKey, operationName, onProgress);

    // Step 3: Download the video from the returned URI
    onProgress?.('Downloading video...', 85);
    const genResponse = result.response?.generateVideoResponse || result.generateVideoResponse || {};
    const samples = genResponse.generatedSamples || [];
    if (samples.length === 0) {
      throw new Error('Veo: No video in generation response');
    }

    const videoUri = samples[0].video?.uri || samples[0].video?.gcsUri;
    if (!videoUri) {
      throw new Error('Veo: No video URI in response');
    }

    const videoBase64 = await this._downloadUrl(videoUri, apiKey);

    return {
      videoBase64,
      mimeType: 'video/mp4',
      // F-9: report the snapped duration that was actually requested.
      durationSeconds: duration,
    };
  }

  private async _pollVeoOperation(
    apiKey: string,
    operationName: string,
    onProgress?: (message: string, progress: number) => void
  ): Promise<any> {
    const startTime = Date.now();
    let attempt = 0;

    while (Date.now() - startTime < CANVAS_VIDEO_POLL_MAX_MS) {
      await this._sleep(CANVAS_VIDEO_POLL_INTERVAL_MS);
      attempt++;

      const progress = Math.min(20 + (attempt * 5), 80);
      onProgress?.(`Generating video... (${Math.round((Date.now() - startTime) / 1000)}s)`, progress);

      const response = await this._httpsRequest({
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/${operationName}?key=${apiKey}`,
        method: 'GET',
        headers: {},
      });

      const status = JSON.parse(response);
      if (status.error) {
        throw new Error(`Veo polling error: ${status.error.message}`);
      }

      if (status.done) {
        return status;
      }
    }

    throw new Error(`Veo video generation timed out after ${CANVAS_VIDEO_POLL_MAX_MS / 1000}s`);
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  private _getOpenAIKey(): string {
    // F-11: keys come from SecretStorage via setKeys(); no settings/env reads.
    return this._openaiKey;
  }

  private _getGeminiKey(): string {
    // F-11: keys come from SecretStorage via setKeys(); no settings/env reads.
    return this._geminiKey;
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Download a video URL and return base64.
   *
   * F-10: when the URL targets the Gemini Files API
   * (generativelanguage.googleapis.com), the download requires the API key —
   * forward it via the `x-goog-api-key` header.
   * F-24: cap redirect recursion at _maxDownloadRedirects to avoid
   * unbounded recursion on a redirect loop. The key is intentionally NOT
   * forwarded across a redirect to a different host (avoid key leakage).
   */
  private _downloadUrl(url: string, apiKey?: string, depth = 0): Promise<string> {
    return new Promise((resolve, reject) => {
      if (depth > VideoGenerationService._maxDownloadRedirects) {
        reject(new Error(`Video download exceeded ${VideoGenerationService._maxDownloadRedirects} redirects`));
        return;
      }
      const parsedUrl = new URL(url);
      const mod = parsedUrl.protocol === 'https:' ? https : require('http');
      const headers: Record<string, string> = {};
      if (apiKey && parsedUrl.hostname === 'generativelanguage.googleapis.com') {
        headers['x-goog-api-key'] = apiKey;
      }
      const req = mod.request(url, { headers }, (res: any) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          const redirect = res.headers.location;
          if (redirect) {
            // Only forward the key when the redirect stays on the Gemini host.
            const nextHost = new URL(redirect, url).hostname;
            const forwardKey = nextHost === 'generativelanguage.googleapis.com' ? apiKey : undefined;
            this._downloadUrl(new URL(redirect, url).toString(), forwardKey, depth + 1).then(resolve).catch(reject);
            return;
          }
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          } else {
            resolve(Buffer.concat(chunks).toString('base64'));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(60000, () => req.destroy(new Error('Video download timed out')));
      req.end();
    });
  }

  private _httpsRequest(options: https.RequestOptions, body?: string): Promise<string> {
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
        req.destroy(new Error('Video generation request timed out (60s)'));
      });
      if (body) { req.write(body); }
      req.end();
    });
  }
}
