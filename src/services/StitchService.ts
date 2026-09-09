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
import type { Stitch, StitchToolClient } from '@google/stitch-sdk';
import { asRecord, asRecords, asString, errorMessage } from '../utils/valueGuards';
import type { StitchScreenRef, StitchDeviceType, StitchModel, StitchCreativeRange, StitchVariantAspect, DesignTheme } from '../types';
import { STITCH_API_TIMEOUT_MS } from '../constants';

// Keep the SDK import visible to webpack so it ships inside the extension.
type StitchSdkModule = typeof import('@google/stitch-sdk');

type ScreenLocation = Pick<StitchScreenRef, 'screenId' | 'htmlUrl' | 'imageUrl'>;

function screenLocation(value: unknown): ScreenLocation | undefined {
  const screen = asRecord(value);
  if (!screen) { return undefined; }
  const screenId = asString(screen.screenId) || asString(screen.id)
    || asString(screen.name)?.split('/screens/')[1];
  if (!screenId) { return undefined; }
  return {
    screenId,
    htmlUrl: asString(asRecord(screen.htmlCode)?.downloadUrl),
    imageUrl: asString(asRecord(screen.screenshot)?.downloadUrl),
  };
}

/**
 * Service wrapping the Google Stitch SDK for UI screen generation.
 * Handles authentication, project management, screen generation/editing/variants,
 * and Design DNA extraction.
 *
 * The ESM SDK is bundled and loaded lazily when a Stitch operation needs it.
 */
export class StitchService {
  /** F-24: maximum redirects the download helper follows before erroring. */
  private static readonly _maxDownloadRedirects = 5;

  private _client: StitchToolClient | null = null;
  private _stitch: Stitch | null = null;
  private _sdkModule: StitchSdkModule | null = null;

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
          } catch (err: unknown) {
            console.warn(`[Mysti] Stitch API key persistence failed: ${errorMessage(err)}`);
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
   * Load the bundled SDK lazily. A hidden runtime import would require an SDK
   * installation in node_modules, which the VSIX deliberately does not ship.
   */
  private async _loadSdk(): Promise<StitchSdkModule> {
    if (this._sdkModule) { return this._sdkModule; }
    this._sdkModule = await import('@google/stitch-sdk');
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
  private async _getStitch(): Promise<Stitch> {
    if (this._stitch) { return this._stitch; }

    const sdk = await this._loadSdk();
    const client = await this._getToolClient();
    this._stitch = new sdk.Stitch(client);
    return this._stitch!;
  }

  private async _getToolClient(): Promise<StitchToolClient> {
    if (this._client) { return this._client; }
    const apiKey = this._getApiKey();
    const sdk = await this._loadSdk();
    this._client = new sdk.StitchToolClient(apiKey ? { apiKey } : undefined);
    return this._client;
  }

  // ── Project Management ──

  async createProject(title: string): Promise<{ id: string; [key: string]: unknown }> {
    await this.ensureAuth();
    const client = await this._getToolClient();
    const raw = asRecord(await client.callTool('create_project', { title }));

    // Extract project ID — may be in .name (e.g. "projects/abc"), .projectId, or .id
    let id = asString(raw?.projectId) || asString(raw?.id);
    const name = asString(raw?.name);
    if (!id && name) {
      id = name.startsWith('projects/') ? name.slice(9) : name;
    }
    if (!id) {
      console.error('[Mysti] Stitch: Unexpected createProject response:', String(JSON.stringify(raw)).substring(0, 500));
      throw new Error('Stitch did not return a project ID');
    }

    console.log(`[Mysti] Stitch: Created project "${title}" (${id})`);
    return { ...raw, id };
  }

  async listProjects(): Promise<Record<string, unknown>[]> {
    await this.ensureAuth();
    const client = await this._getToolClient();
    const raw = await client.callTool('list_projects', {});
    return asRecords(asRecord(raw)?.projects);
  }

  async listScreens(projectId: string): Promise<Record<string, unknown>[]> {
    await this.ensureAuth();
    const client = await this._getToolClient();
    const raw = await client.callTool('list_screens', { projectId });
    return asRecords(asRecord(raw)?.screens);
  }

  // ── Screen Generation ──

  /**
   * Extract a screen's ID from the raw API response.
   * The response shape varies — handle multiple formats robustly.
   */
  private _extractScreenFromRaw(raw: unknown, _projectId: string): ScreenLocation {
    const payload = asRecord(raw);
    // A design system may precede the screen, and malformed entries must not
    // prevent a later valid output component from being discovered.
    const components = asRecords(payload?.outputComponents);
    const candidates: unknown[] = [
      ...components.flatMap(component => asRecords(asRecord(component.design)?.screens)),
      payload,
      ...asRecords(asRecord(payload?.design)?.screens),
      ...asRecords(payload?.screens),
    ];
    for (const candidate of candidates) {
      const location = screenLocation(candidate);
      if (location) { return location; }
    }
    console.error('[Mysti] Stitch: Could not find a screen ID in the response.');
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
      htmlUrl = asString(asRecord(asRecord(raw)?.htmlCode)?.downloadUrl);
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
      imageUrl = asString(asRecord(asRecord(raw)?.screenshot)?.downloadUrl);
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

    // Extract all valid screens from all output components.
    const screens: StitchScreenRef[] = [];
    for (const component of asRecords(asRecord(raw)?.outputComponents)) {
      for (const candidate of asRecords(asRecord(component.design)?.screens)) {
        const location = screenLocation(candidate);
        if (location) { screens.push({ projectId: ref.projectId, ...location }); }
      }
    }

    if (screens.length === 0) {
      console.warn('[Mysti] Stitch: No variants returned, raw:', String(JSON.stringify(raw)).substring(0, 500));
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
      return asRecord(result) ?? {};
    } catch (err: unknown) {
      console.warn(`[Mysti] Stitch: Design DNA extraction failed: ${errorMessage(err)}`);
      return {};
    }
  }

  // ── Design System Extraction ──

  /**
   * Extract the designSystem block from a raw Stitch API response.
   * The generate/edit responses include designSystem data in outputComponents.
   */
  extractDesignSystemFromRaw(raw: unknown): { displayName?: string; designMd?: string; colorMode?: string; customColor?: string; bodyFont?: string } | null {
    for (const component of asRecords(asRecord(raw)?.outputComponents)) {
      const wrapper = asRecord(component.designSystem);
      const design = asRecord(wrapper?.designSystem) ?? wrapper;
      if (!design) { continue; }
      const theme = asRecord(design.theme);
      return {
        displayName: asString(design.displayName),
        designMd: asString(theme?.designMd) || asString(design.designMd),
        colorMode: asString(theme?.colorMode) || asString(design.colorMode),
        customColor: asString(theme?.customColor) || asString(design.customColor),
        bodyFont: asString(theme?.bodyFont) || asString(design.bodyFont),
      };
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
  ): Promise<{ ref: StitchScreenRef; raw: unknown }> {
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
