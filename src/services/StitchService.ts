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
import type { StitchScreenRef, StitchDeviceType, StitchModel, StitchCreativeRange, StitchVariantAspect, DesignTheme } from '../types';
import { STITCH_API_TIMEOUT_MS } from '../constants';

// SDK types — resolved at runtime via dynamic import() since the package is ESM-only
type StitchSdk = any;
type StitchToolClientType = any;

/**
 * Service wrapping the Google Stitch SDK for UI screen generation.
 * Handles authentication, project management, screen generation/editing/variants,
 * and Design DNA extraction.
 *
 * The SDK is ESM-only, so we use dynamic import() to load it at runtime.
 */
export class StitchService {
  /** F-24: maximum redirects the download helper follows before erroring. */
  private static readonly _maxDownloadRedirects = 5;

  private _client: StitchToolClientType | null = null;
  private _stitch: StitchSdk | null = null;
  private _sdkModule: any = null;

  // Key injected by the caller (resolved from CanvasSecrets). The service no
  // longer reads `mysti.canvas.stitchApiKey` or `process.env` for the key,
  // and no longer mutates `process.env` (F-11). Call `setApiKey()` before use.
  private _apiKey = '';

  // ── Authentication ──

  /**
   * Inject the Stitch API key resolved from SecretStorage (F-11). Re-callable
   * (e.g. after the user enters a key); resets cached SDK instances so the new
   * key takes effect on the next call.
   */
  setApiKey(key: string): void {
    const next = (key || '').trim();
    if (next === this._apiKey) { return; }
    this._apiKey = next;
    // Cached SDK/client were built with the old key — force a rebuild.
    this._stitch = null;
    this._client = null;
    this._sdkModule = null;
  }

  get isAvailable(): boolean {
    return !!this._getApiKey();
  }

  private _getApiKey(): string {
    // F-11: key comes from SecretStorage via setApiKey(); no settings/env reads.
    return this._apiKey;
  }

  /**
   * Checks for a Stitch API key. If none is configured, shows a VS Code input
   * box so the user can enter one on the spot. The entered key is applied
   * in-memory via {@link setApiKey} and handed to the optional `persistKey`
   * callback so the caller can store it in SecretStorage (F-11). Throws if the
   * user cancels or provides an empty key.
   *
   * @param persistKey optional async callback (wired by ChatViewProvider to
   *                    `CanvasSecrets.set('stitch', key)`) invoked with the
   *                    entered key so it survives across sessions.
   */
  async ensureAuth(persistKey?: (key: string) => Promise<void>): Promise<void> {
    if (this.isAvailable) { return; }

    const action = await vscode.window.showWarningMessage(
      'Google Stitch API key is required for Canvas generation.',
      'Enter API Key'
    );

    if (action === 'Enter API Key') {
      const key = await vscode.window.showInputBox({
        title: 'Google Stitch API Key',
        prompt: 'Paste your Stitch API key (from stitch.withgoogle.com → Profile → Settings → API Keys)',
        placeHolder: 'AQ.xxxxxxxx...',
        password: true,
        ignoreFocusOut: true,
      });

      if (key?.trim()) {
        const trimmed = key.trim();
        // Apply in-memory (also resets cached SDK instances).
        this.setApiKey(trimmed);
        // Persist to SecretStorage via the caller-supplied hook (F-11).
        if (persistKey) {
          try {
            await persistKey(trimmed);
            console.log('[Mysti] Stitch API key saved to SecretStorage.');
          } catch (err: any) {
            console.warn(`[Mysti] Stitch API key persistence failed: ${err?.message}`);
          }
        }
        return;
      }
    }

    throw new Error(
      'Google Stitch API key required.\n\n' +
      'Setup:\n' +
      '1. Go to stitch.withgoogle.com → Profile → Settings → API Keys\n' +
      '2. Create a new API key\n' +
      '3. Re-run the canvas command and paste your key when prompted.'
    );
  }

  /**
   * Dynamically import the ESM-only @google/stitch-sdk package.
   * Uses Function-based import() to bypass webpack's static analysis,
   * since webpack would otherwise transform import() into require()
   * which fails for ESM-only packages.
   */
  private async _loadSdk(): Promise<any> {
    if (this._sdkModule) { return this._sdkModule; }
    // eslint-disable-next-line no-new-func
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    this._sdkModule = await dynamicImport('@google/stitch-sdk');
    return this._sdkModule;
  }

  /**
   * Get or create a Stitch instance bound to the injected API key.
   *
   * The exported `stitch` singleton only reads `STITCH_API_KEY` from the
   * environment, which previously forced us to mutate `process.env` (F-11).
   * Instead we construct `new Stitch(toolClient)` directly, where the tool
   * client carries the explicit `{ apiKey }` — no env mutation, and a key
   * change (via setApiKey) is picked up because the cache is reset there.
   */
  private async _getStitch(): Promise<StitchSdk> {
    if (this._stitch) { return this._stitch; }

    const sdk = await this._loadSdk();
    const client = await this._getToolClient();
    this._stitch = new sdk.Stitch(client);
    return this._stitch!;
  }

  private async _getToolClient(): Promise<StitchToolClientType> {
    if (this._client) { return this._client; }
    const apiKey = this._getApiKey();
    const sdk = await this._loadSdk();
    this._client = new sdk.StitchToolClient(apiKey ? { apiKey } : undefined);
    return this._client;
  }

  // ── Project Management ──

  async createProject(title: string): Promise<{ id: string; [key: string]: any }> {
    await this.ensureAuth();
    const client = await this._getToolClient();
    const raw = await client.callTool('create_project', { title });

    // Extract project ID — may be in .name (e.g. "projects/abc"), .projectId, or .id
    let id = raw?.projectId || raw?.id;
    if (!id && raw?.name) {
      id = raw.name.startsWith('projects/') ? raw.name.slice(9) : raw.name;
    }
    if (!id) {
      console.error('[Mysti] Stitch: Unexpected createProject response:', JSON.stringify(raw).substring(0, 500));
      throw new Error('Stitch did not return a project ID');
    }

    console.log(`[Mysti] Stitch: Created project "${title}" (${id})`);
    return { id, ...raw };
  }

  async listProjects(): Promise<any[]> {
    await this.ensureAuth();
    const client = await this._getToolClient();
    const raw = await client.callTool('list_projects', {});
    return raw?.projects || [];
  }

  async listScreens(projectId: string): Promise<any[]> {
    await this.ensureAuth();
    const client = await this._getToolClient();
    const raw = await client.callTool('list_screens', { projectId });
    return raw?.screens || [];
  }

  // ── Screen Generation ──

  /**
   * Extract a screen's ID from the raw API response.
   * The response shape varies — handle multiple formats robustly.
   */
  private _extractScreenFromRaw(raw: any, projectId: string): { screenId: string; htmlUrl?: string; imageUrl?: string } {
    // Search ALL outputComponents — the first may be a designSystem, the screen is often in a later entry
    const components = raw?.outputComponents || [];
    for (const oc of components) {
      const screens = oc?.design?.screens;
      if (screens && screens.length > 0) {
        const s = screens[0];
        const id = s.id || s.screenId || (s.name?.split('/screens/')?.[1]);
        if (id) {
          return {
            screenId: id,
            htmlUrl: s.htmlCode?.downloadUrl,
            imageUrl: s.screenshot?.downloadUrl,
          };
        }
      }
    }
    // Flat screen object with id/screenId
    if (raw?.id || raw?.screenId) {
      return {
        screenId: raw.screenId || raw.id,
        htmlUrl: raw.htmlCode?.downloadUrl,
        imageUrl: raw.screenshot?.downloadUrl,
      };
    }
    // Nested under design directly
    if (raw?.design?.screens?.[0]) {
      const s = raw.design.screens[0];
      return {
        screenId: s.id || s.screenId || (s.name?.split('/screens/')?.[1]),
        htmlUrl: s.htmlCode?.downloadUrl,
        imageUrl: s.screenshot?.downloadUrl,
      };
    }
    // Screens array at top level
    if (raw?.screens?.[0]) {
      const s = raw.screens[0];
      return {
        screenId: s.id || s.screenId || (s.name?.split('/screens/')?.[1]),
        htmlUrl: s.htmlCode?.downloadUrl,
        imageUrl: s.screenshot?.downloadUrl,
      };
    }

    // Log all top-level keys and outputComponents structure for debugging
    const ocKeys = components.map((c: any, i: number) => `[${i}]: ${Object.keys(c || {}).join(', ')}`).join('; ');
    console.error(`[Mysti] Stitch: Could not find screen in response. outputComponents: ${ocKeys}`);
    console.error('[Mysti] Stitch: Full response (first 1000 chars):', JSON.stringify(raw).substring(0, 1000));
    throw new Error('Stitch returned an unexpected response — could not extract screen ID');
  }

  async generateScreen(
    projectId: string,
    prompt: string,
    deviceType?: StitchDeviceType,
    modelId?: StitchModel
  ): Promise<StitchScreenRef> {
    const result = await this.generateScreenWithRaw(projectId, prompt, deviceType, modelId);
    return result.ref;
  }

  // ── Screen Content Retrieval ──

  async getScreenHtml(ref: StitchScreenRef): Promise<string> {
    await this.ensureAuth();
    let htmlUrl = ref.htmlUrl;

    if (!htmlUrl) {
      const client = await this._getToolClient();
      const raw = await client.callTool('get_screen', {
        projectId: ref.projectId,
        screenId: ref.screenId,
        name: `projects/${ref.projectId}/screens/${ref.screenId}`,
      });
      htmlUrl = raw?.htmlCode?.downloadUrl;
    }

    if (!htmlUrl) { throw new Error('Stitch did not return an HTML URL'); }
    const buffer = await this._downloadUrl(htmlUrl);
    return buffer.toString('utf-8');
  }

  async getScreenImage(ref: StitchScreenRef): Promise<string> {
    await this.ensureAuth();
    let imageUrl = ref.imageUrl;

    if (!imageUrl) {
      const client = await this._getToolClient();
      const raw = await client.callTool('get_screen', {
        projectId: ref.projectId,
        screenId: ref.screenId,
        name: `projects/${ref.projectId}/screens/${ref.screenId}`,
      });
      imageUrl = raw?.screenshot?.downloadUrl;
    }

    if (!imageUrl) { throw new Error('Stitch did not return an image URL'); }
    const buffer = await this._downloadUrl(imageUrl);
    return buffer.toString('base64');
  }

  // ── Screen Editing ──

  async editScreen(
    ref: StitchScreenRef,
    editPrompt: string,
    deviceType?: StitchDeviceType,
    modelId?: StitchModel
  ): Promise<StitchScreenRef> {
    await this.ensureAuth();
    const client = await this._getToolClient();

    console.log(`[Mysti] Stitch: Editing screen ${ref.screenId} in project ${ref.projectId}`);

    const raw = await client.callTool('edit_screens', {
      projectId: ref.projectId,
      selectedScreenIds: [ref.screenId],
      prompt: editPrompt,
      deviceType: deviceType || undefined,
      modelId: modelId || undefined,
    });

    const screen = this._extractScreenFromRaw(raw, ref.projectId);
    return {
      projectId: ref.projectId,
      screenId: screen.screenId,
      htmlUrl: screen.htmlUrl,
      imageUrl: screen.imageUrl,
    };
  }

  // ── Variant Generation ──

  async generateVariants(
    ref: StitchScreenRef,
    prompt: string,
    options: {
      variantCount: number;
      creativeRange: StitchCreativeRange;
      aspects: StitchVariantAspect[];
    },
    deviceType?: StitchDeviceType,
    modelId?: StitchModel
  ): Promise<StitchScreenRef[]> {
    await this.ensureAuth();
    const client = await this._getToolClient();

    console.log(`[Mysti] Stitch: Generating ${options.variantCount} variants for screen ${ref.screenId}`);

    const raw = await client.callTool('generate_variants', {
      projectId: ref.projectId,
      selectedScreenIds: [ref.screenId],
      prompt,
      variantOptions: {
        variantCount: options.variantCount,
        creativeRange: options.creativeRange,
        aspects: options.aspects,
      },
      deviceType: deviceType || undefined,
      modelId: modelId || undefined,
    });

    // Extract all screens from all output components
    const screens: StitchScreenRef[] = [];
    const components = raw?.outputComponents || [];
    for (const comp of components) {
      const compScreens = comp?.design?.screens || [];
      for (const s of compScreens) {
        const id = s.id || s.screenId || (s.name?.split('/screens/')?.[1]);
        if (id) {
          screens.push({
            projectId: ref.projectId,
            screenId: id,
            htmlUrl: s.htmlCode?.downloadUrl,
            imageUrl: s.screenshot?.downloadUrl,
          });
        }
      }
    }

    if (screens.length === 0) {
      console.warn('[Mysti] Stitch: No variants returned, raw:', JSON.stringify(raw).substring(0, 500));
    }

    return screens;
  }

  // ── Design DNA Extraction ──

  async extractDesignDna(ref: StitchScreenRef): Promise<Record<string, unknown>> {
    await this.ensureAuth();
    const client = await this._getToolClient();

    console.log(`[Mysti] Stitch: Extracting design DNA from screen ${ref.screenId}`);

    try {
      const result = await client.callTool('extract_design_context', {
        projectId: ref.projectId,
        screenId: ref.screenId,
      });
      return result;
    } catch (err: any) {
      console.warn(`[Mysti] Stitch: Design DNA extraction failed: ${err.message}`);
      return {};
    }
  }

  // ── Design System Extraction ──

  /**
   * Extract the designSystem block from a raw Stitch API response.
   * The generate/edit responses include designSystem data in outputComponents.
   */
  extractDesignSystemFromRaw(raw: any): { displayName?: string; designMd?: string; colorMode?: string; customColor?: string; bodyFont?: string } | null {
    const components = raw?.outputComponents || [];
    for (const oc of components) {
      const ds = oc?.designSystem?.designSystem || oc?.designSystem;
      if (ds) {
        return {
          displayName: ds.displayName,
          designMd: ds.theme?.designMd || ds.designMd,
          colorMode: ds.theme?.colorMode || ds.colorMode,
          customColor: ds.theme?.customColor || ds.customColor,
          bodyFont: ds.theme?.bodyFont || ds.bodyFont,
        };
      }
    }
    return null;
  }

  /**
   * Generate a Stitch screen and return both the screen ref and raw response
   * (so callers can extract the design system).
   */
  async generateScreenWithRaw(
    projectId: string,
    prompt: string,
    deviceType?: StitchDeviceType,
    modelId?: StitchModel
  ): Promise<{ ref: StitchScreenRef; raw: any }> {
    await this.ensureAuth();
    const client = await this._getToolClient();

    console.log(`[Mysti] Stitch: Generating screen in project ${projectId} (device=${deviceType || 'DESKTOP'}, model=${modelId || 'default'})`);

    const raw = await client.callTool('generate_screen_from_text', {
      projectId,
      prompt,
      deviceType: deviceType || 'DESKTOP',
      modelId: modelId || undefined,
    });

    const screen = this._extractScreenFromRaw(raw, projectId);
    console.log(`[Mysti] Stitch: Generated screen ${screen.screenId}`);

    return {
      ref: {
        projectId,
        screenId: screen.screenId,
        htmlUrl: screen.htmlUrl,
        imageUrl: screen.imageUrl,
      },
      raw,
    };
  }

  /**
   * Parse Stitch's designMd markdown + hints into a structured DesignTheme.
   * The designMd contains a full design spec with colors, typography, spacing, etc.
   */
  parseDesignMdToTheme(designMd: string, hints?: { customColor?: string; colorMode?: string; bodyFont?: string }): DesignTheme {
    const isDark = hints?.colorMode?.toUpperCase() === 'DARK';
    const primary = hints?.customColor || '#3B82F6';

    // Extract hex colors from the markdown
    const hexColors = [...designMd.matchAll(/#[0-9A-Fa-f]{6}\b/g)].map(m => m[0]);

    // Try to extract named color roles from markdown sections
    const colorMap: Record<string, string> = {};
    const colorPatterns = [
      { key: 'primary', patterns: [/primary[^#]*?(#[0-9A-Fa-f]{6})/i, /action[^#]*?(#[0-9A-Fa-f]{6})/i] },
      { key: 'secondary', patterns: [/secondary[^#]*?(#[0-9A-Fa-f]{6})/i] },
      { key: 'accent', patterns: [/accent[^#]*?(#[0-9A-Fa-f]{6})/i, /highlight[^#]*?(#[0-9A-Fa-f]{6})/i] },
      { key: 'background', patterns: [/background[^#]*?(#[0-9A-Fa-f]{6})/i, /bg[^#]*?(#[0-9A-Fa-f]{6})/i] },
      { key: 'surface', patterns: [/surface[^#]*?(#[0-9A-Fa-f]{6})/i, /card[^#]*?(#[0-9A-Fa-f]{6})/i] },
      { key: 'text', patterns: [/(?:body |main |primary )?text[^#]*?(#[0-9A-Fa-f]{6})/i] },
      { key: 'error', patterns: [/error[^#]*?(#[0-9A-Fa-f]{6})/i, /danger[^#]*?(#[0-9A-Fa-f]{6})/i] },
      { key: 'success', patterns: [/success[^#]*?(#[0-9A-Fa-f]{6})/i] },
    ];

    for (const { key, patterns } of colorPatterns) {
      for (const p of patterns) {
        const m = designMd.match(p);
        if (m) { colorMap[key] = m[1]; break; }
      }
    }

    // Extract font family
    const fontMatch = designMd.match(/font[- ]?family[:\s]*["']?([A-Za-z\s,]+?)["']?\s*[,;\n]/i)
      || designMd.match(/(?:heading|body|primary)\s*(?:font|typeface)[:\s]*["']?([A-Za-z\s]+?)["']?\s*[,;\n.]/i);
    const fontFamily = fontMatch?.[1]?.trim() || hints?.bodyFont || 'Inter';

    // Extract border radius values
    const radiusMatch = designMd.match(/border[- ]?radius[:\s]*(\d+)\s*px/i);
    const baseRadius = radiusMatch ? parseInt(radiusMatch[1], 10) : 8;

    return {
      colors: {
        primary: colorMap.primary || primary,
        secondary: colorMap.secondary || hexColors[1] || '#6366F1',
        accent: colorMap.accent || hexColors[2] || '#F59E0B',
        background: colorMap.background || (isDark ? '#0F172A' : '#FFFFFF'),
        surface: colorMap.surface || (isDark ? '#1E293B' : '#F8FAFC'),
        text: colorMap.text || (isDark ? '#F1F5F9' : '#0F172A'),
        textSecondary: isDark ? '#94A3B8' : '#64748B',
        border: isDark ? '#334155' : '#E2E8F0',
        error: colorMap.error || '#EF4444',
        success: colorMap.success || '#22C55E',
      },
      typography: {
        fontFamily: `${fontFamily}, system-ui, sans-serif`,
        scale: [12, 14, 16, 20, 24, 32, 48],
        lineHeight: 1.5,
        weights: { regular: 400, medium: 500, bold: 700 },
      },
      spacing: { unit: 4, scale: [1, 2, 3, 4, 6, 8, 12, 16] },
      radii: { sm: Math.max(2, baseRadius / 2), md: baseRadius, lg: baseRadius * 2, full: 9999 },
      shadows: {
        sm: isDark ? '0 1px 2px rgba(0,0,0,0.4)' : '0 1px 2px rgba(0,0,0,0.05)',
        md: isDark ? '0 4px 6px rgba(0,0,0,0.5)' : '0 4px 6px rgba(0,0,0,0.07)',
        lg: isDark ? '0 10px 15px rgba(0,0,0,0.6)' : '0 10px 15px rgba(0,0,0,0.1)',
      },
    };
  }

  // ── Cleanup ──

  async dispose(): Promise<void> {
    // `_stitch` wraps `_client`, so closing the client tears both down.
    if (this._client) {
      try { await this._client.close(); } catch { /* ignore */ }
      this._client = null;
    }
    this._stitch = null;
  }

  // ── Private Helpers ──

  private _downloadUrl(url: string, depth = 0): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (depth > StitchService._maxDownloadRedirects) {
        reject(new Error(`Stitch download exceeded ${StitchService._maxDownloadRedirects} redirects`));
        return;
      }
      const parsedUrl = new URL(url);
      const options: https.RequestOptions = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: { 'Accept': '*/*' },
      };

      const req = https.request(options, (res) => {
        // Follow redirects (F-24: capped at _maxDownloadRedirects).
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this._downloadUrl(new URL(res.headers.location, url).toString(), depth + 1).then(resolve).catch(reject);
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const data = Buffer.concat(chunks);
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          } else {
            resolve(data);
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(STITCH_API_TIMEOUT_MS, () => {
        req.destroy(new Error('Stitch download timed out'));
      });
      req.end();
    });
  }
}
