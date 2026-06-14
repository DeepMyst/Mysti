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
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import {
  CANVAS_DIR,
  CANVAS_ASSETS_DIR,
  CANVAS_AUTOSAVE_DEBOUNCE_MS,
  CANVAS_MAX_VARIANTS,
  CANVAS_RENDER_DEFAULT_VIEWPORT,
  CANVAS_ASSET_REF_PREFIX,
  STITCH_DEVICE_DIMENSIONS,
  STITCH_PROJECT_NAME_PREFIX
} from '../constants';
import type { StitchService } from '../services/StitchService';
import type {
  CanvasSession,
  CanvasSnapshot,
  CanvasObjectSummary,
  CanvasPromptRequest,
  CanvasStreamChunk,
  CanvasUnifiedParsed,
  ComponentProp,
  GeneratedFile,
  ElementSelection,
  ElementEditPayload,
  DesignNode,
  DesignTheme,
  DesignSpec,
  DesignAssetRef,
  Settings,
  StreamChunk,
  Attachment,
  StitchScreenRef,
  CanvasArtifact,
  ArtifactPage
} from '../types';
import { DesignSpecManager } from './DesignSpecManager';
import { ArtifactStore } from './ArtifactStore';
import type { CodeGenerationService } from '../services/CodeGenerationService';
import { ImageGenerationService } from '../services/ImageGenerationService';
import type { VideoGenerationService } from '../services/VideoGenerationService';
import type { BrowserManager } from '../services/BrowserManager';
import type { ScreenshotService } from '../services/ScreenshotService';
import { DevServerManager } from '../managers/DevServerManager';

// ProviderManager type — avoid circular import
interface ProviderManagerLike {
  sendMessage(
    content: string,
    context: any[],
    settings: Settings,
    conversation: any,
    persona?: any,
    panelId?: string,
    agentConfig?: any,
    attachments?: Attachment[]
  ): AsyncGenerator<StreamChunk>;
}

/**
 * Manages canvas sessions, persistence, snapshot serialization,
 * reimagination orchestration, and per-frame prompting.
 */
export class CanvasManager {
  private _context: vscode.ExtensionContext;
  private _saveTimers: Map<string, NodeJS.Timeout> = new Map();
  private _gitIgnoreCreated = false;
  private _designSpecManager = new DesignSpecManager();
  private _artifactStore = new ArtifactStore();
  // canvasId (== session.id) → in-memory artifact (source of truth, Plan 05).
  private _artifactByCanvas: Map<string, CanvasArtifact> = new Map();
  private _stitchService!: StitchService;
  private _stitchProjectIds: Map<string, string> = new Map(); // canvasId → stitchProjectId
  // F-11: persists a Stitch key entered via the ensureAuth input-box flow into
  // SecretStorage (wired from extension.ts to CanvasSecrets.set('stitch', …)).
  private _stitchKeyPersister?: (key: string) => Promise<void>;

  // Static cache — shared across all canvas panels, invalidated on workspace change
  private static _projectProfileCache: string | null = null;
  private static _profileWorkspaceRoot: string | null = null;

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
  }

  setStitchService(service: StitchService): void {
    this._stitchService = service;
  }

  /**
   * F-11: register a callback that persists a Stitch API key entered through
   * the {@link StitchService.ensureAuth} input box. Wired from extension.ts to
   * `CanvasSecrets.set('stitch', key)` so a key entered on the fly survives
   * across sessions. Used by `_ensureStitchAuth()`.
   */
  setStitchKeyPersister(persist: (key: string) => Promise<void>): void {
    this._stitchKeyPersister = persist;
  }

  /** Auth gate that forwards the SecretStorage persist callback (F-11). */
  private async _ensureStitchAuth(): Promise<void> {
    await this._stitchService.ensureAuth(this._stitchKeyPersister);
  }

  // ========================================================================
  // Session CRUD
  // ========================================================================

  createSession(name: string): CanvasSession {
    const session: CanvasSession = {
      id: crypto.randomUUID(),
      name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      canvasJson: '{"version":"6.0.0","objects":[]}',
      assetPaths: [],
    };
    // Plan 05 Phase 1: every session gets a linked artifact (source of truth).
    // Built in memory here (no I/O); persisted on first page write / saveSession.
    const artifact = this._artifactStore.createArtifact({ name, kind: 'board' });
    session.artifactId = artifact.id;
    this._artifactByCanvas.set(session.id, artifact);
    return session;
  }

  /** Shared {@link ArtifactStore} (consumed by the op executor + linker). */
  getArtifactStore(): ArtifactStore {
    return this._artifactStore;
  }

  /**
   * Resolve the linked artifact for a session: in-memory cache first, then the
   * persisted store, creating + linking one if none exists yet. Seeds the
   * Stitch project-id cache from the artifact (fixes restart amnesia).
   */
  async ensureArtifact(session: CanvasSession): Promise<CanvasArtifact> {
    const cached = this._artifactByCanvas.get(session.id);
    if (cached) { return cached; }
    let artifact: CanvasArtifact | null = null;
    if (session.artifactId) {
      artifact = await this._artifactStore.load(session.artifactId);
    }
    if (!artifact) {
      artifact = this._artifactStore.createArtifact({ name: session.name, kind: 'board' });
      session.artifactId = artifact.id;
    }
    this._artifactByCanvas.set(session.id, artifact);
    if (artifact.stitchProjectId) {
      this._stitchProjectIds.set(session.id, artifact.stitchProjectId);
    }
    return artifact;
  }

  /**
   * Append an `html`-mode page (Stitch screen / plain HTML) to the canvas's
   * artifact and persist. Best-effort: a persistence failure never disrupts the
   * generator's user-visible output. Returns the new page, or null when there
   * is no artifact context (e.g. no workspace).
   */
  async recordHtmlPage(
    canvasId: string,
    opts: { html?: string; actionTitle?: string; stitchRef?: StitchScreenRef; source?: string }
  ): Promise<ArtifactPage | null> {
    try {
      const artifact = this._artifactByCanvas.get(canvasId);
      if (!artifact) { return null; }
      const page = this._artifactStore.makePage({
        mode: 'html',
        htmlSource: opts.html,
        actionTitle: opts.actionTitle,
        stitchRef: opts.stitchRef,
        source: opts.source ?? 'stitch',
      });
      this._artifactStore.insertPage(artifact, page);
      if (opts.stitchRef?.projectId) {
        artifact.stitchProjectId = opts.stitchRef.projectId;
      }
      await this._artifactStore.save(artifact);
      return page;
    } catch (err) {
      console.log('[Mysti] Canvas: recordHtmlPage failed (non-fatal):', err);
      return null;
    }
  }

  async loadSession(id: string): Promise<CanvasSession | null> {
    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) { return null; }
    const filePath = vscode.Uri.file(path.join(workspaceRoot, CANVAS_DIR, `${id}.json`));
    try {
      const data = await vscode.workspace.fs.readFile(filePath);
      return JSON.parse(Buffer.from(data).toString('utf-8')) as CanvasSession;
    } catch {
      return null;
    }
  }

  async saveSession(session: CanvasSession): Promise<void> {
    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) { return; }
    session.updatedAt = Date.now();
    const dirUri = vscode.Uri.file(path.join(workspaceRoot, CANVAS_DIR));
    try { await vscode.workspace.fs.createDirectory(dirUri); } catch { /* exists */ }

    // Externalize inline base64 assets to content-addressed files
    if (session.canvasJson) {
      try {
        const { externalizedJson, assetPaths } = await this.externalizeAssets(session.canvasJson);
        session.canvasJson = externalizedJson;
        session.assetPaths = assetPaths;
      } catch (err) {
        console.log('[Mysti] Canvas: asset externalization failed, saving inline:', err);
      }
    }

    const filePath = vscode.Uri.file(path.join(workspaceRoot, CANVAS_DIR, `${session.id}.json`));
    const content = Buffer.from(JSON.stringify(session, null, 2), 'utf-8');
    await vscode.workspace.fs.writeFile(filePath, content);

    // Plan 05 Phase 1: persist the linked artifact (the structured source of
    // truth) alongside the freeform fabric layer. Best-effort — a failure here
    // must not block the session save.
    const artifact = this._artifactByCanvas.get(session.id);
    if (artifact) {
      this._artifactStore.save(artifact).catch(err =>
        console.log('[Mysti] Canvas: artifact save failed (non-fatal):', err)
      );
    }

    // Ensure .gitignore exists for captures/
    this._ensureGitIgnore().catch(() => {});
  }

  debouncedSave(session: CanvasSession): void {
    const existing = this._saveTimers.get(session.id);
    if (existing) { clearTimeout(existing); }
    this._saveTimers.set(session.id, setTimeout(() => {
      this.saveSession(session).catch(err =>
        console.log('[Mysti] Canvas: save error:', err)
      );
      this._saveTimers.delete(session.id);
    }, CANVAS_AUTOSAVE_DEBOUNCE_MS));
  }

  async listSessions(): Promise<CanvasSession[]> {
    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) { return []; }
    const dirUri = vscode.Uri.file(path.join(workspaceRoot, CANVAS_DIR));
    try {
      const entries = await vscode.workspace.fs.readDirectory(dirUri);
      const sessions: CanvasSession[] = [];
      for (const [name, type] of entries) {
        if (type === vscode.FileType.File && name.endsWith('.json')) {
          const id = name.replace('.json', '');
          const session = await this.loadSession(id);
          if (session) { sessions.push(session); }
        }
      }
      return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  // ========================================================================
  // Snapshot Serialization
  // ========================================================================

  buildSnapshot(
    canvasJson: any,
    imageBase64: string,
    selectedRegion?: { imageBase64: string; bounds: { left: number; top: number; width: number; height: number } }
  ): CanvasSnapshot {
    const objects = this._extractObjects(canvasJson);
    const sceneDescription = this._buildSceneDescription(objects);

    let region: CanvasSnapshot['selectedRegion'] | undefined;
    if (selectedRegion) {
      // Filter objects within region bounds
      const regionObjects = objects.filter(obj => {
        const objRight = obj.position.left + obj.size.width;
        const objBottom = obj.position.top + obj.size.height;
        const regRight = selectedRegion.bounds.left + selectedRegion.bounds.width;
        const regBottom = selectedRegion.bounds.top + selectedRegion.bounds.height;
        return obj.position.left < regRight && objRight > selectedRegion.bounds.left
            && obj.position.top < regBottom && objBottom > selectedRegion.bounds.top;
      });
      region = {
        imageBase64: selectedRegion.imageBase64,
        objects: regionObjects,
        bounds: selectedRegion.bounds,
      };
    }

    // Save captures to .mysti/canvas/captures/<timestamp>/ for debugging
    this._lastCaptureDir = this._saveCapture(imageBase64, region);

    return { imageBase64, sceneDescription, objects, selectedRegion: region };
  }

  /** Path to the most recent capture folder (used by generation methods to append prompts) */
  private _lastCaptureDir: string | null = null;

  /**
   * Create a timestamped capture folder with canvas images and metadata.
   * Returns the folder path so generation methods can append prompt data.
   */
  private _saveCapture(
    fullImageBase64: string,
    region?: CanvasSnapshot['selectedRegion']
  ): string | null {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders?.length) { return null; }

      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const queryDir = path.join(workspaceFolders[0].uri.fsPath, '.mysti', 'canvas', 'captures', ts);
      fs.mkdirSync(queryDir, { recursive: true });

      // Save full canvas capture
      fs.writeFileSync(
        path.join(queryDir, 'full-canvas.png'),
        Buffer.from(fullImageBase64, 'base64')
      );

      // Save selected region capture if present
      if (region?.imageBase64) {
        fs.writeFileSync(
          path.join(queryDir, 'selected-region.png'),
          Buffer.from(region.imageBase64, 'base64')
        );
        fs.writeFileSync(
          path.join(queryDir, 'region-metadata.json'),
          JSON.stringify({
            bounds: region.bounds,
            objectCount: region.objects.length,
            objects: region.objects.map(o => ({
              type: o.type,
              position: o.position,
              size: o.size,
              content: o.content?.substring(0, 100),
            })),
          }, null, 2)
        );
      }

      console.log(`[Mysti] Canvas capture saved to ${queryDir}`);
      return queryDir;
    } catch (err) {
      console.warn('[Mysti] Failed to save canvas capture:', err);
      return null;
    }
  }

  /**
   * Append prompt and generation details to the most recent capture folder.
   */
  private _saveCapturePrompt(data: {
    userPrompt: string;
    enhancedPrompt: string;
    background?: string;
    provider?: string;
    genOptions?: Record<string, any>;
    result?: { revisedPrompt?: string };
  }, captureDir?: string | null): void {
    const dir = captureDir || this._lastCaptureDir;
    if (!dir) { return; }
    try {
      fs.writeFileSync(
        path.join(dir, 'prompt.json'),
        JSON.stringify({
          userPrompt: data.userPrompt,
          enhancedPrompt: data.enhancedPrompt,
          background: data.background,
          provider: data.provider,
          genOptions: data.genOptions,
          revisedPrompt: data.result?.revisedPrompt,
          timestamp: new Date().toISOString(),
        }, null, 2)
      );
      // Also save enhanced prompt as plain text for quick reading
      fs.writeFileSync(
        path.join(dir, 'enhanced-prompt.txt'),
        data.enhancedPrompt
      );
    } catch (err) {
      console.warn('[Mysti] Failed to save capture prompt:', err);
    }
  }

  private _extractObjects(canvasJson: any): CanvasObjectSummary[] {
    const objects: CanvasObjectSummary[] = [];
    const fabricObjects = canvasJson?.objects || [];
    for (const obj of fabricObjects) {
      objects.push(this._fabricObjToSummary(obj));
    }
    return objects;
  }

  private _fabricObjToSummary(obj: any): CanvasObjectSummary {
    const type = this._mapFabricType(obj.type);
    const summary: CanvasObjectSummary = {
      id: obj.id || obj.name || crypto.randomUUID(),
      type,
      position: { left: obj.left || 0, top: obj.top || 0 },
      size: { width: obj.width || 0, height: obj.height || 0 },
    };
    if (obj.text) { summary.content = obj.text; }
    if (obj.label) { summary.label = obj.label; }
    if (obj.description) { summary.description = obj.description; }
    if (obj.metadata) { summary.metadata = obj.metadata; }
    if (obj.src) { summary.imagePath = obj.src; }
    if (obj.objects) {
      summary.children = obj.objects.map((child: any) => child.id || child.name || 'unknown');
    }
    return summary;
  }

  private _mapFabricType(fabricType: string): CanvasObjectSummary['type'] {
    switch (fabricType) {
      case 'path': return 'path';
      case 'i-text': case 'textbox': case 'text': return 'text';
      case 'image': return 'image';
      case 'rect': return 'frame';
      case 'group': return 'group';
      default: return 'path';
    }
  }

  private _buildSceneDescription(objects: CanvasObjectSummary[]): string {
    if (objects.length === 0) { return 'Empty canvas.'; }
    const lines: string[] = [`Canvas contains ${objects.length} object(s):`];
    for (const obj of objects) {
      let desc = `- ${obj.type} at (${obj.position.left}, ${obj.position.top}), size ${obj.size.width}x${obj.size.height}`;
      if (obj.content) { desc += `, text: "${obj.content.substring(0, 80)}"`; }
      if (obj.label) { desc += `, label: "${obj.label}"`; }
      if (obj.imagePath) { desc += `, image`; }
      if (obj.children?.length) { desc += `, ${obj.children.length} children`; }
      lines.push(desc);
    }
    return lines.join('\n');
  }

  // ========================================================================
  // Smart Prompt Construction
  // ========================================================================

  /**
   * Separate canvas objects into text annotations (user design notes) and visual elements.
   */
  private _extractCanvasAnnotations(objects: CanvasObjectSummary[]): {
    annotations: string[];
    elements: string[];
  } {
    const annotations: string[] = [];
    const elements: string[] = [];
    for (const obj of objects) {
      if ((obj.type === 'text' || obj.type === 'comment') && obj.content) {
        annotations.push(obj.content);
      } else {
        const desc = `${obj.type} at (${obj.position.left},${obj.position.top}) size ${obj.size.width}x${obj.size.height}`;
        elements.push(obj.content ? `${desc}: "${obj.content.substring(0, 80)}"` : desc);
      }
    }
    return { annotations, elements };
  }

  /**
   * Uses the AI provider to construct an optimized generation prompt that
   * respects selection size, detects transparency needs, matches theme from
   * surrounding elements, and accounts for overlapping content.
   */
  private async _buildSmartPrompt(
    userPrompt: string,
    providerManager: ProviderManagerLike,
    settings: Settings,
    context: {
      frameBounds?: { left: number; top: number; width: number; height: number };
      regionImageBase64?: string;
      projectContext?: string;
      selectionDescription?: string;
      regionObjects?: CanvasObjectSummary[];
      mediaType: 'image' | 'video';
    }
  ): Promise<{ prompt: string; background: 'transparent' | 'opaque' | 'auto' }> {
    const bounds = context.frameBounds;
    const orientation = bounds
      ? (bounds.width > bounds.height ? 'landscape' : bounds.width < bounds.height ? 'portrait' : 'square')
      : 'unknown';
    const dimInfo = bounds ? `${Math.round(bounds.width)}x${Math.round(bounds.height)}px (${orientation})` : 'no frame selected';
    const projectLine = context.projectContext ? `Project: ${context.projectContext}` : '';

    // Separate text annotations (user's design notes) from visual elements
    const { annotations, elements } = context.regionObjects
      ? this._extractCanvasAnnotations(context.regionObjects)
      : { annotations: [] as string[], elements: [] as string[] };
    const annotationsBlock = annotations.length > 0
      ? `USER'S CANVAS ANNOTATIONS (treat these as design directives — the user wrote these on the canvas to guide you):\n${annotations.map(a => `- "${a}"`).join('\n')}`
      : '';
    const elementsBlock = elements.length > 0
      ? `VISUAL ELEMENTS ON CANVAS:\n${elements.join('\n')}`
      : (context.selectionDescription ? `Selected area contains: ${context.selectionDescription}` : '');

    const hasReference = !!context.regionImageBase64;

    const systemPrompt = `You are an expert prompt engineer for AI ${context.mediaType} generation.
You are analyzing a canvas design region and the user's request to produce a generation prompt.

Frame dimensions: ${dimInfo}
${projectLine}

${annotationsBlock}

${elementsBlock}

User request: ${userPrompt}

${hasReference ? `VISUAL REFERENCE IMAGE ATTACHED — analyze it carefully:
1. Extract EXACT hex color codes (#xxxxxx) for every distinct color
2. Identify visual style: flat, gradient, glassmorphism, skeuomorphic, neumorphism, etc.
3. Note typography: weight, size, serif/sans-serif
4. Note layout: spacing, alignment, grid, composition
5. Note any hand-drawn sketches, arrows, or annotations — these indicate the user's design intent` : ''}

${hasReference ? `CRITICAL: A reference image of this canvas region will ALSO be sent directly to the image generation API.
Your prompt MUST:
- Instruct the model to CLOSELY MATCH the reference image's colors, layout, and style
- Reference specific hex colors you extracted from the screenshot
- Incorporate the user's text annotations as design requirements
- Describe spatial composition matching what's shown in the reference
- Begin with "Following the attached reference image closely, ..." or similar directive` : ''}

Return JSON:
{
  "prompt": "Detailed prompt that ${hasReference ? 'instructs the model to follow the attached reference image, with' : 'includes'} specific hex colors, exact style descriptors, spatial composition for the frame dimensions, and content description.",
  "background": "transparent" or "opaque"
}

Rules:
- "transparent" for UI components, icons, buttons, overlays, logos
- "opaque" for full scenes, backgrounds, photos, hero images
- Include every hex color extracted from the reference — not generic color names
- Treat canvas text annotations as user requirements (e.g., text saying "blue button" means the user wants a blue button)
${hasReference ? '- The prompt MUST start with a directive like "Following the attached reference image closely, ..." or "Matching the visual reference exactly, ..."' : ''}
- Describe spatial composition appropriate for ${dimInfo}
- Example good prompt: "Following the attached reference image closely, create a navigation bar on dark navy (#1a1a2e) background with electric blue (#0ea5e9) text links, thin 1px bottom border in (#333), sans-serif typography, minimal flat design, matching the exact layout and spacing shown in the reference"
- Example bad prompt: "A modern navigation bar with blue theme"

Return ONLY the JSON object.`;

    const attachments: Attachment[] = [];
    if (context.regionImageBase64) {
      attachments.push({
        id: `smart-prompt-region-${Date.now()}`,
        type: 'image',
        fileName: 'selected-region.png',
        base64Data: context.regionImageBase64,
        size: context.regionImageBase64.length,
        mimeType: 'image/png',
      });
    }

    let aiResponse = '';
    const stream = providerManager.sendMessage(systemPrompt, [], settings, null, undefined, undefined, undefined, attachments);
    for await (const chunk of stream) {
      if (chunk.type === 'text' && chunk.content) {
        aiResponse += chunk.content;
      }
    }

    try {
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          prompt: parsed.prompt || userPrompt,
          background: parsed.background === 'transparent' ? 'transparent' : parsed.background === 'opaque' ? 'opaque' : 'auto',
        };
      }
    } catch {
      console.log('[Mysti] Canvas: failed to parse smart prompt response, using original');
    }
    return { prompt: userPrompt, background: 'auto' };
  }

  /**
   * Builds 4 optimized reimagination prompts using the AI provider.
   * Each prompt gets its own background decision and detailed description.
   */
  private async _buildReimaginePrompts(
    userPrompt: string,
    providerManager: ProviderManagerLike,
    settings: Settings,
    context: {
      frameBounds?: { left: number; top: number; width: number; height: number };
      regionImageBase64?: string;
      projectContext?: string;
      selectionDescription?: string;
      regionObjects?: CanvasObjectSummary[];
    }
  ): Promise<Array<{ prompt: string; background: string; description: string }>> {
    const bounds = context.frameBounds;
    const orientation = bounds
      ? (bounds.width > bounds.height ? 'landscape' : bounds.width < bounds.height ? 'portrait' : 'square')
      : 'unknown';
    const dimInfo = bounds ? `${Math.round(bounds.width)}x${Math.round(bounds.height)}px (${orientation})` : 'no frame selected';
    const projectLine = context.projectContext ? `Project: ${context.projectContext}` : '';
    const hasReference = !!context.regionImageBase64;

    // Separate text annotations from visual elements
    const { annotations, elements } = context.regionObjects
      ? this._extractCanvasAnnotations(context.regionObjects)
      : { annotations: [] as string[], elements: [] as string[] };
    const annotationsBlock = annotations.length > 0
      ? `USER'S CANVAS ANNOTATIONS (design directives):\n${annotations.map(a => `- "${a}"`).join('\n')}`
      : '';
    const elementsBlock = elements.length > 0
      ? `Visual elements on canvas:\n${elements.join('\n')}`
      : (context.selectionDescription || '');

    const systemPrompt = `You are a prompt engineer for AI image generation. The user wants 4 distinct visual reimaginations of a selected region on their design canvas.

Frame dimensions: ${dimInfo}
${projectLine}
${annotationsBlock}
${elementsBlock}

${userPrompt ? `User guidance: ${userPrompt}` : ''}

${hasReference ? `VISUAL REFERENCE IMAGE ATTACHED — A reference image will also be sent to the image generation API alongside each prompt.
Analyze the reference carefully: extract exact hex colors, visual style, typography, and layout.
Each variant should respect the reference's color palette and overall visual language while offering a different design direction.` : ''}

Produce exactly 4 different image generation prompts. Each should offer a meaningfully different design direction while serving the same purpose/content.
${hasReference ? 'Each prompt MUST begin with "Following the attached reference image, ..." and reference the exact hex colors from the screenshot.' : 'Each prompt must be self-contained and detailed.'}
${annotations.length > 0 ? 'Incorporate the user\'s canvas annotations as design requirements in every variant.' : ''}

Return JSON:
[
  { "prompt": "Detailed generation prompt...", "background": "transparent" or "opaque", "description": "Brief label for this variant" },
  { "prompt": "Detailed generation prompt...", "background": "transparent" or "opaque", "description": "Brief label" },
  { "prompt": "Detailed generation prompt...", "background": "transparent" or "opaque", "description": "Brief label" },
  { "prompt": "Detailed generation prompt...", "background": "transparent" or "opaque", "description": "Brief label" }
]

Guidelines:
- Set background to "transparent" for UI components, icons, buttons, overlays, stickers, or layered elements
- Set background to "opaque" for full scenes, backgrounds, photos, hero images, or standalone artwork
- Match the visual theme/style of the reference image — use the same color palette
- Include specific dimensions guidance (${dimInfo}) in each prompt
- Be descriptive about colors (#hex), style, composition, and layout

Return ONLY the JSON array, no other text.`;

    const attachments: Attachment[] = [];
    if (context.regionImageBase64) {
      attachments.push({
        id: `reimagine-smart-${Date.now()}`,
        type: 'image',
        fileName: 'selected-region.png',
        base64Data: context.regionImageBase64,
        size: context.regionImageBase64.length,
        mimeType: 'image/png',
      });
    }

    let aiResponse = '';
    const stream = providerManager.sendMessage(systemPrompt, [], settings, null, undefined, undefined, undefined, attachments);
    for await (const chunk of stream) {
      if (chunk.type === 'text' && chunk.content) {
        aiResponse += chunk.content;
      }
    }

    try {
      const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.slice(0, 4).map((v: any) => ({
            prompt: v.prompt || userPrompt,
            background: v.background || 'auto',
            description: v.description || '',
          }));
        }
      }
    } catch {
      console.log('[Mysti] Canvas: failed to parse reimagine smart prompts, falling back');
    }

    // Fallback: generate 4 basic variations of the user prompt
    return [
      { prompt: userPrompt || 'A modern, clean design variation', background: 'auto', description: 'Variation 1' },
      { prompt: userPrompt || 'A bold, colorful design variation', background: 'auto', description: 'Variation 2' },
      { prompt: userPrompt || 'A minimal, elegant design variation', background: 'auto', description: 'Variation 3' },
      { prompt: userPrompt || 'A creative, unique design variation', background: 'auto', description: 'Variation 4' },
    ];
  }

  // ========================================================================
  // Reimagination
  // ========================================================================

  async *generateImageVariants(
    request: CanvasPromptRequest,
    providerManager: ProviderManagerLike,
    imageGenService: ImageGenerationService,
    settings: Settings,
    projectContext?: string
  ): AsyncGenerator<CanvasStreamChunk> {
    yield { type: 'canvas_reimagine_started', canvasId: request.canvasId };

    try {
      const bounds = request.snapshot.selectedRegion?.bounds;
      const regionDesc = request.snapshot.selectedRegion
        ? `Selected region contains:\n${request.snapshot.selectedRegion.objects.map(o =>
            `- ${o.type}${o.content ? `: "${o.content.substring(0, 60)}"` : ''}`
          ).join('\n')}`
        : request.snapshot.sceneDescription;

      // Use _buildSmartPrompt to construct 4 optimized prompts via the AI
      const smartPrompts = await this._buildReimaginePrompts(
        request.prompt || '',
        providerManager,
        settings,
        {
          frameBounds: bounds,
          regionImageBase64: request.snapshot.selectedRegion?.imageBase64,
          projectContext,
          selectionDescription: regionDesc,
          regionObjects: request.snapshot.selectedRegion?.objects,
        }
      );

      // Generate all 4 images in parallel
      const genPromises = smartPrompts.map((sp, i) => {
        const bg = sp.background === 'transparent' ? 'transparent' as const
          : sp.background === 'opaque' ? 'opaque' as const : 'auto' as const;
        const genOptions = bounds
          ? { frameBounds: { width: bounds.width, height: bounds.height }, background: bg }
          : { background: bg };
        return imageGenService.generate(sp.prompt, genOptions)
          .then(result => ({
            success: true as const,
            index: i,
            imageBase64: result.imageBase64,
            description: sp.description,
          }))
          .catch((err: any) => ({
            success: false as const,
            index: i,
            error: err.message,
            description: sp.description,
          }));
      });

      const results = await Promise.all(genPromises);

      // Yield results in order
      for (const result of results) {
        if (result.success) {
          yield {
            type: 'canvas_reimagine_variant',
            canvasId: request.canvasId,
            variant: {
              id: `variant-${result.index}-${Date.now()}`,
              imageBase64: result.imageBase64,
              description: result.description || `Variant ${result.index + 1}`,
            },
          };
        } else {
          console.log(`[Mysti] Canvas: image generation failed for variant ${result.index}:`, result.error);
          yield {
            type: 'canvas_error',
            canvasId: request.canvasId,
            error: `Image generation failed for variant ${result.index + 1}: ${result.error}`,
          };
        }
      }

      yield { type: 'canvas_reimagine_complete', canvasId: request.canvasId };
    } catch (err: any) {
      yield { type: 'canvas_error', canvasId: request.canvasId, error: err.message };
    }
  }

  // ========================================================================
  // Reimagine via Stitch Variants
  // ========================================================================

  async *reimagineWithStitch(
    canvasId: string,
    stitchScreenRef: StitchScreenRef,
    prompt: string,
  ): AsyncGenerator<CanvasStreamChunk> {
    yield { type: 'canvas_reimagine_started', canvasId };

    try {
      await this._ensureStitchAuth();

      const config = vscode.workspace.getConfiguration('mysti');
      const model = config.get<string>('canvas.stitchModel', 'GEMINI_3_PRO') as import('../types').StitchModel;
      const creativeRange = config.get<string>('canvas.stitchCreativeRange', 'EXPLORE') as import('../types').StitchCreativeRange;

      yield { type: 'canvas_stitch_started', canvasId, content: 'Generating Stitch variants...' };

      const variants = await this._stitchService.generateVariants(
        stitchScreenRef,
        prompt || 'Explore different design directions',
        { variantCount: 4, creativeRange, aspects: ['LAYOUT', 'COLOR_SCHEME', 'IMAGES'] },
        undefined,
        model
      );

      // Download each variant's screenshot and yield as reimagine variant
      for (let i = 0; i < variants.length; i++) {
        try {
          const imageBase64 = await this._stitchService.getScreenImage(variants[i]);
          yield {
            type: 'canvas_reimagine_variant',
            canvasId,
            variant: {
              id: `stitch-variant-${i}-${Date.now()}`,
              imageBase64,
              description: `Stitch variant ${i + 1}`,
            },
          };
        } catch (err: any) {
          console.warn(`[Mysti] Stitch: Failed to download variant ${i} screenshot:`, err.message);
          yield { type: 'canvas_error', canvasId, error: `Variant ${i + 1} download failed: ${err.message}` };
        }
      }

      yield { type: 'canvas_reimagine_complete', canvasId };
    } catch (err: any) {
      yield { type: 'canvas_error', canvasId, error: `Stitch reimagine failed: ${err.message}` };
    }
  }

  // ========================================================================
  // Draft Generation
  // ========================================================================

  async *generateDraft(
    canvasId: string,
    prompt: string,
    imageGenService: ImageGenerationService,
    providerManager: ProviderManagerLike,
    settings: Settings,
    frameBounds?: { left: number; top: number; width: number; height: number },
    projectContext?: string,
    selectionDescription?: string,
    regionImageBase64?: string,
    regionObjects?: CanvasObjectSummary[]
  ): AsyncGenerator<CanvasStreamChunk> {
    yield { type: 'canvas_draft_started', canvasId, progress: 0 };

    try {
      // Use AI to construct an optimized prompt with transparency detection and theme matching
      yield { type: 'canvas_draft_progress', canvasId, progress: 10, content: 'Constructing prompt...' };
      const smart = await this._buildSmartPrompt(prompt, providerManager, settings, {
        frameBounds,
        regionImageBase64,
        projectContext,
        selectionDescription,
        regionObjects,
        mediaType: 'image',
      });

      const genOptions: Record<string, any> = {};
      if (frameBounds) { genOptions.frameBounds = { width: frameBounds.width, height: frameBounds.height }; }
      if (smart.background !== 'auto') { genOptions.background = smart.background; }
      if (regionImageBase64) { genOptions.referenceImageBase64 = regionImageBase64; }

      yield { type: 'canvas_draft_progress', canvasId, progress: 30, content: 'Generating image...' };
      const result = await imageGenService.generate(smart.prompt, Object.keys(genOptions).length > 0 ? genOptions : undefined);

      // Save enhanced prompt and generation details to capture folder
      this._saveCapturePrompt({
        userPrompt: prompt,
        enhancedPrompt: smart.prompt,
        background: smart.background,
        provider: imageGenService.provider,
        genOptions,
        result: { revisedPrompt: result.revisedPrompt },
      });

      yield { type: 'canvas_draft_progress', canvasId, progress: 90, content: 'Image ready' };
      yield {
        type: 'canvas_draft_complete',
        canvasId,
        variant: {
          id: `draft-${Date.now()}`,
          imageBase64: result.imageBase64,
          description: result.revisedPrompt || prompt,
        },
        progress: 100,
      };
    } catch (err: any) {
      yield { type: 'canvas_error', canvasId, error: err.message };
    }
  }

  // ========================================================================
  // Video Generation
  // ========================================================================

  async *generateVideo(
    canvasId: string,
    prompt: string,
    videoGenService: VideoGenerationService,
    providerManager: ProviderManagerLike,
    settings: Settings,
    frameBounds?: { left: number; top: number; width: number; height: number },
    projectContext?: string,
    selectionDescription?: string,
    regionImageBase64?: string,
    regionObjects?: CanvasObjectSummary[]
  ): AsyncGenerator<CanvasStreamChunk> {
    yield { type: 'canvas_video_started', canvasId, progress: 0 };

    try {
      // Use AI to construct an optimized prompt with theme matching
      const smart = await this._buildSmartPrompt(prompt, providerManager, settings, {
        frameBounds,
        regionImageBase64,
        projectContext,
        selectionDescription,
        regionObjects,
        mediaType: 'video',
      });

      const genOptions = frameBounds
        ? { frameBounds: { width: frameBounds.width, height: frameBounds.height } }
        : undefined;

      const result = await videoGenService.generate(
        smart.prompt,
        genOptions,
        (message: string, progress: number) => {
          console.log(`[Mysti] Canvas video: ${message} (${progress}%)`);
        }
      );

      this._saveCapturePrompt({
        userPrompt: prompt,
        enhancedPrompt: smart.prompt,
        background: smart.background,
        provider: 'video',
        genOptions,
        result: { revisedPrompt: result.revisedPrompt },
      });

      yield {
        type: 'canvas_video_progress',
        canvasId,
        progress: 90,
        content: 'Video ready',
      };

      yield {
        type: 'canvas_video_complete',
        canvasId,
        videoBase64: result.videoBase64,
        mimeType: result.mimeType,
        durationSeconds: result.durationSeconds,
        label: result.revisedPrompt || prompt,
      };
    } catch (err: any) {
      yield { type: 'canvas_error', canvasId, error: err.message };
    }
  }

  // ========================================================================
  // Stitch Screen Generation (replaces layout/multipass/SVG pipeline)
  // ========================================================================

  /**
   * Generate a UI screen using Google Stitch SDK.
   * This is the primary generation method — replaces generateLayout, generateLayoutMultiPass, and generateMockup.
   */
  async *generateScreen(
    canvasId: string,
    prompt: string,
    deviceType?: import('../types').StitchDeviceType,
    projectContext?: string,
    frameBounds?: { left: number; top: number; width: number; height: number },
  ): AsyncGenerator<CanvasStreamChunk> {
    yield { type: 'canvas_stitch_started', canvasId };

    try {
      await this._ensureStitchAuth();

      // Build enhanced prompt with context
      const deviceLabel = deviceType || 'DESKTOP';
      const dims = STITCH_DEVICE_DIMENSIONS[deviceLabel] || STITCH_DEVICE_DIMENSIONS.DESKTOP;
      const contextPrefix = projectContext ? `Project: ${projectContext}.\n` : '';
      const enhancedPrompt = `${contextPrefix}${prompt}`;

      // Create or reuse Stitch project
      let stitchProjectId: string = this._stitchProjectIds.get(canvasId) || '';
      if (!stitchProjectId) {
        const project = await this._stitchService.createProject(
          STITCH_PROJECT_NAME_PREFIX + (canvasId.substring(0, 8))
        );
        stitchProjectId = project.id;
        this._stitchProjectIds.set(canvasId, stitchProjectId);
      }

      // Get model from settings
      const model = vscode.workspace.getConfiguration('mysti')
        .get<string>('canvas.stitchModel', 'GEMINI_3_PRO') as import('../types').StitchModel;

      // Generate screen
      yield { type: 'canvas_stitch_screen_ready', canvasId, content: 'Generating screen...' };
      const ref = await this._stitchService.generateScreen(stitchProjectId, enhancedPrompt, deviceType, model);

      // Download screenshot and HTML in parallel
      yield { type: 'canvas_layout_progress', canvasId, content: 'Downloading screen assets...' };
      const [imageBase64, htmlContent] = await Promise.all([
        this._stitchService.getScreenImage(ref),
        this._stitchService.getScreenHtml(ref),
      ]);

      // Build DesignNode with Stitch assets
      const nodeId = crypto.randomUUID();
      const x = frameBounds?.left ?? 0;
      const y = frameBounds?.top ?? 0;
      const width = frameBounds?.width ?? dims.width;
      const height = frameBounds?.height ?? dims.height;

      if (!imageBase64) {
        console.warn('[Mysti] Stitch returned empty screenshot — skipping image asset');
      }

      const assets: DesignAssetRef[] = [];
      if (imageBase64) {
        assets.push({
          id: `img-${ref.screenId}`,
          type: 'image',
          src: `data:image/png;base64,${imageBase64}`,
          prompt,
          alt: prompt,
        });
      }
      if (htmlContent) {
        assets.push({
          id: `html-${ref.screenId}`,
          type: 'html',
          src: htmlContent,
          prompt,
          alt: 'Stitch HTML',
        });
      }

      const node: DesignNode = {
        id: nodeId,
        type: 'page',
        name: prompt.substring(0, 60),
        x, y, width, height,
        layout: { display: 'block' },
        style: {},
        assets,
        metadata: {
          engine: 'stitch',
          stitchProjectId: ref.projectId,
          stitchScreenId: ref.screenId,
        },
      };

      // Plan 05 Phase 1: persist the screen into the artifact (reload-safe).
      await this.recordHtmlPage(canvasId, {
        html: htmlContent,
        actionTitle: prompt.substring(0, 60),
        stitchRef: ref,
      });

      yield { type: 'canvas_stitch_html_ready', canvasId, stitchHtml: htmlContent, stitchScreenRef: ref };
      yield { type: 'canvas_mockup_complete', canvasId, designNodes: [node], designTheme: DesignSpecManager.getDefaultTheme() };
    } catch (err: any) {
      yield { type: 'canvas_error', canvasId, error: `Stitch generation failed: ${err.message}` };
    }
  }

  /**
   * Edit an existing Stitch screen with a text prompt.
   */
  async *editStitchScreen(
    canvasId: string,
    editPrompt: string,
    stitchScreenRef: import('../types').StitchScreenRef,
    frameBounds?: { left: number; top: number; width: number; height: number },
  ): AsyncGenerator<CanvasStreamChunk> {
    yield { type: 'canvas_stitch_started', canvasId, content: 'Editing screen...' };

    try {
      await this._ensureStitchAuth();

      const model = vscode.workspace.getConfiguration('mysti')
        .get<string>('canvas.stitchModel', 'GEMINI_3_PRO') as import('../types').StitchModel;

      const newRef = await this._stitchService.editScreen(stitchScreenRef, editPrompt, undefined, model);

      const [imageBase64, htmlContent] = await Promise.all([
        this._stitchService.getScreenImage(newRef),
        this._stitchService.getScreenHtml(newRef),
      ]);

      // F-23: guard against an empty image download — a bare
      // `data:image/png;base64,` URI is invalid and renders as a broken image.
      if (!imageBase64 && !htmlContent) {
        yield { type: 'canvas_error', canvasId, error: 'Stitch returned no screen content for the edit.' };
        return;
      }

      const nodeId = crypto.randomUUID();
      const dims = STITCH_DEVICE_DIMENSIONS.DESKTOP;
      const editAssets: DesignAssetRef[] = [];
      if (imageBase64) {
        editAssets.push({ id: `img-${newRef.screenId}`, type: 'image', src: `data:image/png;base64,${imageBase64}`, prompt: editPrompt, alt: editPrompt });
      }
      if (htmlContent) {
        editAssets.push({ id: `html-${newRef.screenId}`, type: 'html', src: htmlContent, prompt: editPrompt, alt: 'Stitch HTML' });
      }
      const node: DesignNode = {
        id: nodeId,
        type: 'page',
        name: `Edit: ${editPrompt.substring(0, 50)}`,
        x: frameBounds?.left ?? 0,
        y: frameBounds?.top ?? 0,
        width: frameBounds?.width ?? dims.width,
        height: frameBounds?.height ?? dims.height,
        layout: { display: 'block' },
        style: {},
        assets: editAssets,
        metadata: {
          engine: 'stitch',
          stitchProjectId: newRef.projectId,
          stitchScreenId: newRef.screenId,
        },
      };

      // Plan 05 Phase 1: persist the edited screen into the artifact.
      await this.recordHtmlPage(canvasId, {
        html: htmlContent,
        actionTitle: `Edit: ${editPrompt.substring(0, 50)}`,
        stitchRef: newRef,
      });

      yield { type: 'canvas_stitch_html_ready', canvasId, stitchHtml: htmlContent, stitchScreenRef: newRef };
      yield { type: 'canvas_mockup_complete', canvasId, designNodes: [node], designTheme: DesignSpecManager.getDefaultTheme() };
    } catch (err: any) {
      yield { type: 'canvas_error', canvasId, error: `Stitch edit failed: ${err.message}` };
    }
  }

  /**
   * Generate design variants of an existing Stitch screen.
   */
  async *generateStitchVariants(
    canvasId: string,
    stitchScreenRef: import('../types').StitchScreenRef,
    prompt: string,
    options: {
      variantCount: number;
      creativeRange: import('../types').StitchCreativeRange;
      aspects: import('../types').StitchVariantAspect[];
    },
    baseX: number,
    baseY: number,
  ): AsyncGenerator<CanvasStreamChunk> {
    yield { type: 'canvas_stitch_started', canvasId, content: 'Generating variants...' };

    try {
      await this._ensureStitchAuth();

      const model = vscode.workspace.getConfiguration('mysti')
        .get<string>('canvas.stitchModel', 'GEMINI_3_PRO') as import('../types').StitchModel;

      const variantRefs = await this._stitchService.generateVariants(
        stitchScreenRef, prompt, options, undefined, model
      );

      const dims = STITCH_DEVICE_DIMENSIONS.DESKTOP;
      const nodes: DesignNode[] = [];

      for (let i = 0; i < variantRefs.length; i++) {
        const ref = variantRefs[i];
        yield { type: 'canvas_layout_progress', canvasId, content: `Downloading variant ${i + 1}/${variantRefs.length}...` };

        const [imageBase64, htmlContent] = await Promise.all([
          this._stitchService.getScreenImage(ref),
          this._stitchService.getScreenHtml(ref),
        ]);

        // F-23: skip variants that came back with no content rather than push a
        // node with a broken `data:image/png;base64,` URI.
        if (!imageBase64 && !htmlContent) {
          continue;
        }

        // F-23: only include the image asset when the download succeeded.
        const variantAssets: DesignAssetRef[] = [];
        if (imageBase64) {
          variantAssets.push({ id: `img-${ref.screenId}`, type: 'image', src: `data:image/png;base64,${imageBase64}`, prompt, alt: `Variant ${i + 1}` });
        }
        if (htmlContent) {
          variantAssets.push({ id: `html-${ref.screenId}`, type: 'html', src: htmlContent, prompt, alt: 'Stitch HTML' });
        }

        nodes.push({
          id: crypto.randomUUID(),
          type: 'page',
          name: `Variant ${i + 1}`,
          x: baseX + i * (dims.width + 100),
          y: baseY,
          width: dims.width,
          height: dims.height,
          layout: { display: 'block' },
          style: {},
          assets: variantAssets,
          metadata: {
            engine: 'stitch',
            stitchProjectId: ref.projectId,
            stitchScreenId: ref.screenId,
          },
        });
      }

      yield { type: 'canvas_stitch_variants_ready', canvasId, variantCount: nodes.length };
      yield { type: 'canvas_mockup_complete', canvasId, designNodes: nodes, designTheme: DesignSpecManager.getDefaultTheme() };
    } catch (err: any) {
      yield { type: 'canvas_error', canvasId, error: `Stitch variants failed: ${err.message}` };
    }
  }

  /**
   * Extract Design DNA from a Stitch screen and generate DESIGN.md.
   */
  async *extractDesignDna(
    canvasId: string,
    stitchScreenRef: import('../types').StitchScreenRef,
  ): AsyncGenerator<CanvasStreamChunk> {
    yield { type: 'canvas_stitch_started', canvasId, content: 'Extracting design system...' };

    try {
      await this._ensureStitchAuth();

      const dna = await this._stitchService.extractDesignDna(stitchScreenRef);

      // Convert DNA to DesignTheme (best-effort mapping)
      const theme = DesignSpecManager.getDefaultTheme();
      if (dna.colors && typeof dna.colors === 'object') {
        Object.assign(theme.colors, dna.colors);
      }
      if (dna.typography && typeof dna.typography === 'object') {
        const typo = dna.typography as Record<string, any>;
        if (typo.fontFamily) theme.typography.fontFamily = typo.fontFamily;
      }

      // Write DESIGN.md to workspace
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        const designMdPath = path.join(workspaceFolders[0].uri.fsPath, 'DESIGN.md');
        const designMdContent = this._buildDesignMdContent(stitchScreenRef.projectId, dna);
        // F-19: confirm before clobbering an existing DESIGN.md so we don't
        // silently overwrite a hand-authored design system.
        let shouldWrite = true;
        if (fs.existsSync(designMdPath)) {
          const choice = await vscode.window.showWarningMessage(
            'DESIGN.md already exists. Overwrite it with the extracted Design DNA?',
            { modal: true },
            'Overwrite'
          );
          shouldWrite = choice === 'Overwrite';
        }
        if (shouldWrite) {
          fs.writeFileSync(designMdPath, designMdContent, 'utf-8');
          console.log(`[Mysti] Stitch: Wrote DESIGN.md to ${designMdPath}`);
        } else {
          console.log('[Mysti] Stitch: DESIGN.md overwrite declined by user.');
        }
      }

      yield { type: 'canvas_stitch_design_dna', canvasId, designTheme: theme };
    } catch (err: any) {
      yield { type: 'canvas_error', canvasId, error: `Design DNA extraction failed: ${err.message}` };
    }
  }

  private _buildDesignMdContent(projectId: string, dna: Record<string, unknown>): string {
    const title = (dna.projectTitle as string) || 'Untitled Project';
    const atmosphere = (dna.atmosphere as string) || 'Modern, clean aesthetic';
    const colors = dna.colors as Record<string, string> | undefined;
    const typography = dna.typography as Record<string, any> | undefined;
    const components = dna.components as Record<string, any> | undefined;
    const layout = dna.layout as Record<string, any> | undefined;

    let md = `# Design System: ${title}\n**Project ID:** ${projectId}\n\n`;
    md += `## 1. Visual Theme & Atmosphere\n${atmosphere}\n\n`;

    md += `## 2. Color Palette & Roles\n`;
    if (colors) {
      for (const [name, hex] of Object.entries(colors)) {
        md += `- **${name}**: ${hex}\n`;
      }
    } else {
      md += 'No color data extracted.\n';
    }
    md += '\n';

    md += `## 3. Typography Rules\n`;
    if (typography) {
      md += `- Font Family: ${typography.fontFamily || 'System default'}\n`;
      md += `- Weights: ${JSON.stringify(typography.weights || [])}\n`;
    } else {
      md += 'No typography data extracted.\n';
    }
    md += '\n';

    md += `## 4. Component Stylings\n`;
    if (components) {
      md += JSON.stringify(components, null, 2) + '\n';
    } else {
      md += 'No component data extracted.\n';
    }
    md += '\n';

    md += `## 5. Layout Principles\n`;
    if (layout) {
      md += JSON.stringify(layout, null, 2) + '\n';
    } else {
      md += 'No layout data extracted.\n';
    }

    return md;
  }


  // ========================================================================
  // Website Generation (Multi-Page via Stitch)
  // ========================================================================

  /**
   * Generate a multi-page website using Stitch. All pages share the same Stitch
   * project for design consistency. Pages are arranged horizontally on the canvas.
   */
  async *generateWebsite(
    canvasId: string,
    prompt: string,
    projectContext?: string,
  ): AsyncGenerator<CanvasStreamChunk> {
    yield { type: 'canvas_website_started', canvasId };

    try {
      await this._ensureStitchAuth();

      const model = vscode.workspace.getConfiguration('mysti')
        .get<string>('canvas.stitchModel', 'GEMINI_3_PRO') as import('../types').StitchModel;

      // Create a Stitch project for the whole website
      const project = await this._stitchService.createProject(
        STITCH_PROJECT_NAME_PREFIX + 'website-' + canvasId.substring(0, 8)
      );
      const stitchProjectId = project.id;
      this._stitchProjectIds.set(canvasId, stitchProjectId);

      // Plan pages from the prompt (simple heuristic — 4 common pages)
      const pageNames = this._inferWebsitePages(prompt);
      const PAGE_GAP = 100;
      const allPageNodes: DesignNode[] = [];

      for (let pi = 0; pi < pageNames.length; pi++) {
        const pageName = pageNames[pi];
        yield { type: 'canvas_website_page_started', canvasId, pageIndex: pi, totalPages: pageNames.length, pageName };

        const pagePrompt = projectContext
          ? `Project: ${projectContext}.\n${pageName} page: ${prompt}`
          : `${pageName} page: ${prompt}`;

        const ref = await this._stitchService.generateScreen(stitchProjectId, pagePrompt, 'DESKTOP', model);

        // Download screenshot + HTML
        const [imageBase64, htmlContent] = await Promise.all([
          this._stitchService.getScreenImage(ref),
          this._stitchService.getScreenHtml(ref),
        ]);

        const dims = STITCH_DEVICE_DIMENSIONS.DESKTOP;
        const node: DesignNode = {
          id: crypto.randomUUID(),
          type: 'page',
          name: pageName,
          x: pi * (dims.width + PAGE_GAP),
          y: 0,
          width: dims.width,
          height: dims.height,
          layout: { display: 'block' },
          style: {},
          assets: [
            { id: `img-${ref.screenId}`, type: 'image', src: `data:image/png;base64,${imageBase64}`, prompt: pagePrompt, alt: pageName },
            { id: `html-${ref.screenId}`, type: 'html', src: htmlContent, prompt: pagePrompt, alt: `${pageName} HTML` },
          ],
          metadata: { engine: 'stitch', stitchProjectId: ref.projectId, stitchScreenId: ref.screenId },
        };

        allPageNodes.push(node);
      }

      const theme = DesignSpecManager.getDefaultTheme();
      yield { type: 'canvas_mockup_complete', canvasId, designNodes: allPageNodes, designTheme: theme };
    } catch (err: any) {
      yield { type: 'canvas_error', canvasId, error: err.message };
    }
  }

  /**
   * Infer page names from a website prompt. Returns 4-6 common pages.
   */
  private _inferWebsitePages(prompt: string): string[] {
    const lower = prompt.toLowerCase();
    const pages = ['Home'];

    if (lower.includes('ecommerce') || lower.includes('e-commerce') || lower.includes('shop') || lower.includes('store')) {
      pages.push('Products', 'Product Detail', 'Cart', 'Checkout');
    } else if (lower.includes('saas') || lower.includes('software') || lower.includes('app')) {
      pages.push('Features', 'Pricing', 'About', 'Contact');
    } else if (lower.includes('portfolio') || lower.includes('personal')) {
      pages.push('Projects', 'About', 'Contact');
    } else if (lower.includes('blog')) {
      pages.push('Blog List', 'Blog Post', 'About', 'Contact');
    } else {
      pages.push('About', 'Features', 'Contact');
    }

    return pages;
  }

  // F-15: `generateBatchContent` (the ~100-LoC batch-generation pipeline) was
  // removed — it had no webview producer (`canvasBatchGenerate` is gone too).
  // `_computeCompositionGuide` (below) is intentionally kept: it is reused by
  // the smart-prompt builders.

  /**
   * Compute composition guidance for a frame — tells the AI how the image will be cropped
   * and where to place content so it survives the cover-crop.
   */
  private _computeCompositionGuide(frameW: number, frameH: number, role?: string, componentType?: string): {
    apiSizeLabel: string;
    visiblePercent: { w: number; h: number };
    cropSeverity: 'none' | 'mild' | 'severe';
    gravity: { x: 'left' | 'center' | 'right'; y: 'top' | 'center' | 'bottom' };
    gridCells: string;
    compositionInstruction: string;
  } {
    // Determine API output size
    const apiSizeLabel = ImageGenerationService.mapToApiSize(frameW, frameH);
    const [apiW, apiH] = apiSizeLabel.split('x').map(Number);

    // Simulate cover-crop math
    const scaleX = frameW / apiW;
    const scaleY = frameH / apiH;
    const scale = Math.max(scaleX, scaleY);
    const visibleW = frameW / scale;
    const visibleH = frameH / scale;
    const wPct = Math.round((visibleW / apiW) * 100);
    const hPct = Math.round((visibleH / apiH) * 100);

    // Crop severity
    const minPct = Math.min(wPct, hPct);
    const cropSeverity: 'none' | 'mild' | 'severe' = minPct < 50 ? 'severe' : minPct < 80 ? 'mild' : 'none';

    // Gravity from role/componentType
    const r = (role || '').toLowerCase();
    const t = (componentType || '').toLowerCase();
    let gravityY: 'top' | 'center' | 'bottom' = 'center';
    if (/nav|header/.test(r) || /navbar|header/.test(t)) { gravityY = 'top'; }
    else if (/footer/.test(r) || /footer/.test(t)) { gravityY = 'bottom'; }
    let gravityX: 'left' | 'center' | 'right' = 'center';
    if (/sidebar/.test(r)) { gravityX = /right/.test(t) ? 'right' : 'left'; }

    // Compute target grid cells (4x4 grid: columns A-D, rows 1-4)
    const cols = ['A', 'B', 'C', 'D'];
    const rows = ['1', '2', '3', '4'];
    const cellW = apiW / 4;
    const cellH = apiH / 4;

    // Visible region position in API pixels based on gravity
    let visLeft: number;
    if (gravityX === 'left') { visLeft = 0; }
    else if (gravityX === 'right') { visLeft = apiW - visibleW; }
    else { visLeft = (apiW - visibleW) / 2; }

    let visTop: number;
    if (gravityY === 'top') { visTop = 0; }
    else if (gravityY === 'bottom') { visTop = apiH - visibleH; }
    else { visTop = (apiH - visibleH) / 2; }

    // Which grid cells overlap with visible region
    const startCol = Math.floor(visLeft / cellW);
    const endCol = Math.min(3, Math.floor((visLeft + visibleW - 1) / cellW));
    const startRow = Math.floor(visTop / cellH);
    const endRow = Math.min(3, Math.floor((visTop + visibleH - 1) / cellH));
    const gridCells = `${cols[startCol]}${rows[startRow]}-${cols[endCol]}${rows[endRow]}`;

    // Build human-readable composition instruction with grid
    let instruction = `Image will be generated at ${apiSizeLabel}. GRID: 4x4 grid (columns A-D, rows 1-4). Target cells: ${gridCells}.`;
    if (cropSeverity === 'severe') {
      instruction += ` SEVERE CROP: Only ${Math.min(wPct, hPct)}% of the image will be visible. Place ALL meaningful content ONLY within cells ${gridCells}. Fill all other cells with a solid background color.`;
    } else if (cropSeverity === 'mild') {
      instruction += ` After cropping, ${wPct}% width and ${hPct}% height visible. Center content within cells ${gridCells}.`;
    } else {
      instruction += ` Nearly all content visible. Compose normally across the grid.`;
    }

    return {
      apiSizeLabel,
      visiblePercent: { w: wPct, h: hPct },
      cropSeverity,
      gravity: { x: gravityX, y: gravityY },
      gridCells,
      compositionInstruction: instruction,
    };
  }

  // F-15: `_buildBatchDesignBrief` removed alongside `generateBatchContent`
  // (its only caller). The annotation-extraction and composition-guide helpers
  // it used are retained for the per-frame smart-prompt builders.

  // ========================================================================
  // Per-Frame Prompt
  // ========================================================================

  async *promptFrame(
    request: CanvasPromptRequest,
    providerManager: ProviderManagerLike,
    settings: Settings
  ): AsyncGenerator<CanvasStreamChunk> {
    try {
      const regionDesc = request.snapshot.selectedRegion
        ? `Selected region:\n${request.snapshot.selectedRegion.objects.map(o =>
            `- ${o.type} at (${o.position.left},${o.position.top}) size ${o.size.width}x${o.size.height}${o.content ? `: "${o.content.substring(0, 60)}"` : ''}`
          ).join('\n')}`
        : request.snapshot.sceneDescription;

      const prompt = `You are analyzing a visual design canvas. The user has selected a region and is asking about it.

${regionDesc}

Full canvas context:
${request.snapshot.sceneDescription}

User prompt: ${request.prompt}

Respond helpfully about the selected region. If the user asks for changes, describe what code modifications would be needed.`;

      const attachments: Attachment[] = [];
      if (request.snapshot.selectedRegion?.imageBase64) {
        attachments.push({
          id: `frame-prompt-${Date.now()}`,
          type: 'image',
          fileName: 'frame-region.png',
          base64Data: request.snapshot.selectedRegion.imageBase64,
          size: request.snapshot.selectedRegion.imageBase64.length,
          mimeType: 'image/png',
        });
      }

      const stream = providerManager.sendMessage(prompt, [], settings, null, undefined, undefined, undefined, attachments);
      for await (const chunk of stream) {
        if (chunk.type === 'text' && chunk.content) {
          yield { type: 'canvas_prompt_response', canvasId: request.canvasId, content: chunk.content };
        }
      }
    } catch (err: any) {
      yield { type: 'canvas_error', canvasId: request.canvasId, error: err.message };
    }
  }

  // ========================================================================
  // Asset Management
  // ========================================================================

  async saveAsset(base64: string, mimeType: string): Promise<string> {
    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) { throw new Error('No workspace open'); }
    const ext = mimeType.includes('png') ? 'png' : mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : 'png';
    const fileName = `${crypto.randomUUID()}.${ext}`;
    const dirUri = vscode.Uri.file(path.join(workspaceRoot, CANVAS_ASSETS_DIR));
    try { await vscode.workspace.fs.createDirectory(dirUri); } catch { /* exists */ }
    const filePath = vscode.Uri.file(path.join(workspaceRoot, CANVAS_ASSETS_DIR, fileName));
    const buffer = Buffer.from(base64, 'base64');
    await vscode.workspace.fs.writeFile(filePath, buffer);
    return path.join(CANVAS_ASSETS_DIR, fileName);
  }

  async loadAsset(assetPath: string): Promise<string> {
    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) { throw new Error('No workspace open'); }
    const filePath = vscode.Uri.file(path.join(workspaceRoot, assetPath));
    const data = await vscode.workspace.fs.readFile(filePath);
    return Buffer.from(data).toString('base64');
  }

  // ========================================================================
  // Asset Externalization & Rehydration
  // ========================================================================

  /**
   * Extract inline base64 data URIs from canvas JSON into content-addressed
   * asset files on disk. Returns lightweight JSON with asset:// references.
   */
  async externalizeAssets(canvasJsonStr: string): Promise<{ externalizedJson: string; assetPaths: string[] }> {
    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) { return { externalizedJson: canvasJsonStr, assetPaths: [] }; }

    let parsed: any;
    try { parsed = JSON.parse(canvasJsonStr); } catch { return { externalizedJson: canvasJsonStr, assetPaths: [] }; }

    const objects = parsed.objects;
    if (!Array.isArray(objects)) { return { externalizedJson: canvasJsonStr, assetPaths: [] }; }

    const assetPaths: string[] = [];
    const dirUri = vscode.Uri.file(path.join(workspaceRoot, CANVAS_ASSETS_DIR));
    try { await vscode.workspace.fs.createDirectory(dirUri); } catch { /* exists */ }

    for (const obj of objects) {
      // Externalize image src (data URI → asset file)
      if (obj.src && typeof obj.src === 'string' && obj.src.startsWith('data:')) {
        const ref = await this._externalizeDataUri(obj.src, workspaceRoot);
        if (ref) { obj.src = ref; assetPaths.push(ref); }
      }

      // Externalize video data (raw base64 → asset file)
      if (obj.videoData && typeof obj.videoData === 'string' && !obj.videoData.startsWith(CANVAS_ASSET_REF_PREFIX)) {
        const mimeType = obj.videoMimeType || 'video/mp4';
        const ref = await this._externalizeBase64(obj.videoData, mimeType, workspaceRoot);
        if (ref) { obj.videoData = ref; assetPaths.push(ref); }
      }

      // Handle already-externalized refs (collect paths)
      if (obj.src && typeof obj.src === 'string' && obj.src.startsWith(CANVAS_ASSET_REF_PREFIX)) {
        assetPaths.push(obj.src);
      }
      if (obj.videoData && typeof obj.videoData === 'string' && obj.videoData.startsWith(CANVAS_ASSET_REF_PREFIX)) {
        assetPaths.push(obj.videoData);
      }
    }

    return { externalizedJson: JSON.stringify(parsed), assetPaths };
  }

  private async _externalizeDataUri(dataUri: string, workspaceRoot: string): Promise<string | null> {
    // Parse data URI: data:<mime>;base64,<data>
    const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) { return null; }
    const mimeType = match[1];
    const base64 = match[2];
    return this._externalizeBase64(base64, mimeType, workspaceRoot);
  }

  private async _externalizeBase64(base64: string, mimeType: string, workspaceRoot: string): Promise<string | null> {
    try {
      const buffer = Buffer.from(base64, 'base64');
      const hash = crypto.createHash('sha256').update(buffer).digest('hex').substring(0, 16);
      const ext = mimeType.includes('png') ? 'png'
        : mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg'
        : mimeType.includes('mp4') ? 'mp4'
        : mimeType.includes('webm') ? 'webm'
        : 'bin';
      const fileName = `${hash}.${ext}`;
      const filePath = path.join(workspaceRoot, CANVAS_ASSETS_DIR, fileName);

      // Content-addressed dedup: only write if file doesn't exist
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
        // File exists — skip write
      } catch {
        await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), buffer);
      }

      return `${CANVAS_ASSET_REF_PREFIX}${CANVAS_ASSETS_DIR}/${fileName}`;
    } catch (err) {
      console.log('[Mysti] Canvas: failed to externalize asset:', err);
      return null;
    }
  }

  /**
   * Replace asset:// references in canvas JSON with inline data URIs
   * so the webview can render them directly.
   */
  async rehydrateAssets(canvasJsonStr: string): Promise<string> {
    let parsed: any;
    try { parsed = JSON.parse(canvasJsonStr); } catch { return canvasJsonStr; }

    const objects = parsed.objects;
    if (!Array.isArray(objects)) { return canvasJsonStr; }

    for (const obj of objects) {
      // Rehydrate image src
      if (obj.src && typeof obj.src === 'string' && obj.src.startsWith(CANVAS_ASSET_REF_PREFIX)) {
        const assetPath = obj.src.substring(CANVAS_ASSET_REF_PREFIX.length);
        try {
          const base64 = await this.loadAsset(assetPath);
          const ext = path.extname(assetPath).substring(1);
          const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : `image/${ext}`;
          obj.src = `data:${mime};base64,${base64}`;
        } catch (err) {
          console.log('[Mysti] Canvas: failed to rehydrate asset:', assetPath, err);
        }
      }

      // Rehydrate video data
      if (obj.videoData && typeof obj.videoData === 'string' && obj.videoData.startsWith(CANVAS_ASSET_REF_PREFIX)) {
        const assetPath = obj.videoData.substring(CANVAS_ASSET_REF_PREFIX.length);
        try {
          const base64 = await this.loadAsset(assetPath);
          obj.videoData = base64;
        } catch (err) {
          console.log('[Mysti] Canvas: failed to rehydrate video asset:', assetPath, err);
        }
      }
    }

    return JSON.stringify(parsed);
  }

  /**
   * Return the most recently updated session, or null if none exist.
   */
  async getLatestSession(): Promise<CanvasSession | null> {
    const sessions = await this.listSessions();
    return sessions.length > 0 ? sessions[0] : null;
  }

  /**
   * Create .mysti/canvas/.gitignore to exclude captures/ from git tracking.
   */
  private async _ensureGitIgnore(): Promise<void> {
    if (this._gitIgnoreCreated) { return; }
    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) { return; }
    const gitignorePath = path.join(workspaceRoot, CANVAS_DIR, '.gitignore');
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(gitignorePath));
      // Already exists
    } catch {
      const content = Buffer.from('captures/\n', 'utf-8');
      await vscode.workspace.fs.writeFile(vscode.Uri.file(gitignorePath), content);
    }
    this._gitIgnoreCreated = true;
  }

  // ========================================================================
  // Project Context
  // ========================================================================

  /**
   * Build a rich project context using one-time AI analysis.
   * On first call, gathers project signals (package.json, README, mysti.md, language markers)
   * and asks the AI to synthesize a concise project profile. The result is cached and reused
   * for all subsequent canvas generation commands until the workspace changes.
   */
  static async buildProjectContext(
    providerManager?: ProviderManagerLike,
    settings?: Settings,
    projectContextManager?: { getMystiMdContent(): string },
    imageService?: ImageGenerationService
  ): Promise<string> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return ''; }
    const root = folders[0].uri.fsPath;

    // Return cache if still valid for this workspace
    if (CanvasManager._projectProfileCache && CanvasManager._profileWorkspaceRoot === root) {
      return CanvasManager._projectProfileCache;
    }

    // Gather raw project signals (fast, synchronous reads)
    const rawContext = CanvasManager._gatherRawProjectContext(root, projectContextManager);

    // Prefer vision API (direct, no CLI) for project analysis
    if (imageService?.isVisionAvailable) {
      try {
        const profile = await CanvasManager._analyzeProjectWithVisionAPI(rawContext, imageService);
        CanvasManager._projectProfileCache = profile;
        CanvasManager._profileWorkspaceRoot = root;
        console.log('[Mysti] Canvas: AI project profile generated via vision API and cached');
        return profile;
      } catch (err) {
        console.log('[Mysti] Canvas: Vision API project analysis failed:', err);
      }
    }

    // Fallback: CLI provider
    if (providerManager && settings) {
      try {
        const profile = await CanvasManager._analyzeProjectWithAI(rawContext, providerManager, settings);
        CanvasManager._projectProfileCache = profile;
        CanvasManager._profileWorkspaceRoot = root;
        console.log('[Mysti] Canvas: AI project profile generated via CLI and cached');
        return profile;
      } catch (err) {
        console.log('[Mysti] Canvas: AI project analysis failed, using raw context:', err);
      }
    }

    // Fallback: structured raw context (no AI)
    CanvasManager._projectProfileCache = rawContext;
    CanvasManager._profileWorkspaceRoot = root;
    return rawContext;
  }

  /**
   * Invalidate the cached project profile (e.g., on workspace folder change).
   */
  static invalidateProjectProfileCache(): void {
    CanvasManager._projectProfileCache = null;
    CanvasManager._profileWorkspaceRoot = null;
  }

  /**
   * Gather raw project signals from the workspace for AI analysis.
   * Reads package.json, README, mysti.md, and language marker files.
   */
  private static _gatherRawProjectContext(
    root: string,
    projectContextManager?: { getMystiMdContent(): string }
  ): string {
    const folderName = path.basename(root);
    const lines: string[] = [`Workspace: ${folderName}`];

    // package.json: name, description, key deps
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
      if (pkg.name) { lines.push(`Package name: ${pkg.name}`); }
      if (pkg.description) { lines.push(`Description: ${pkg.description}`); }
      const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      const depNames = Object.keys(allDeps).slice(0, 20);
      if (depNames.length) { lines.push(`Dependencies: ${depNames.join(', ')}`); }
    } catch { /* no package.json or not a JS project */ }

    // README (first 500 chars)
    for (const readme of ['README.md', 'readme.md', 'README']) {
      try {
        const content = fs.readFileSync(path.join(root, readme), 'utf-8');
        lines.push(`README excerpt: ${content.substring(0, 500)}`);
        break;
      } catch { /* not found */ }
    }

    // mysti.md (user-written project description, first 500 chars)
    if (projectContextManager) {
      const mystiMd = projectContextManager.getMystiMdContent();
      if (mystiMd) { lines.push(`Project config (mysti.md): ${mystiMd.substring(0, 500)}`); }
    }

    // Language/framework markers
    const markers: Record<string, string> = {
      'tsconfig.json': 'TypeScript', 'pyproject.toml': 'Python', 'requirements.txt': 'Python',
      'Cargo.toml': 'Rust', 'go.mod': 'Go', 'build.gradle': 'Java/Kotlin', 'pom.xml': 'Java',
    };
    for (const [file, lang] of Object.entries(markers)) {
      try {
        if (fs.existsSync(path.join(root, file))) { lines.push(`Language marker: ${lang} (${file})`); }
      } catch { /* ignore */ }
    }

    return lines.join('\n');
  }

  /**
   * Send gathered project signals to the AI to synthesize a concise project profile
   * optimized for image/video generation context.
   */
  private static async _analyzeProjectWithAI(
    rawContext: string,
    providerManager: ProviderManagerLike,
    settings: Settings
  ): Promise<string> {
    const systemPrompt = `You are analyzing a software project to help an AI image/video generator produce relevant visuals. Given the project information below, produce a concise project profile.

${rawContext}

Return a short profile (max 6 lines) in this format:
Project: <name>
Type: <what kind of app/library/tool it is, e.g. "VSCode extension for AI-assisted coding", "E-commerce web app", "REST API for user management">
Tech: <primary language, frameworks, key libraries>
Design: <inferred visual style/branding, e.g. "developer-focused, dark theme, code-centric", "modern SaaS, clean UI, blue/white palette">
Audience: <who uses this, e.g. "developers", "end consumers", "enterprise teams">
Key features: <2-3 main features that might appear in visuals>

Be specific and concise. This profile will be injected into image generation prompts so the AI produces project-relevant content instead of generic images.
Return ONLY the profile lines, no other text.`;

    let aiResponse = '';
    const stream = providerManager.sendMessage(systemPrompt, [], settings, null);
    for await (const chunk of stream) {
      if (chunk.type === 'text' && chunk.content) {
        aiResponse += chunk.content;
      }
    }

    const trimmed = aiResponse.trim();
    if (trimmed && trimmed.includes('Project:')) {
      return trimmed;
    }

    // If AI response doesn't look like a profile, fall back to raw
    return rawContext;
  }

  /**
   * Analyze project context using the direct vision API (no CLI dependency).
   */
  private static async _analyzeProjectWithVisionAPI(
    rawContext: string,
    imageService: ImageGenerationService
  ): Promise<string> {
    const prompt = `You are analyzing a software project to help an AI image/video generator produce relevant visuals. Given the project information below, produce a concise project profile.

${rawContext}

Return a short profile (max 6 lines) in this format:
Project: <name>
Type: <what kind of app/library/tool it is>
Tech: <primary language, frameworks, key libraries>
Design: <inferred visual style/branding>
Audience: <who uses this>
Key features: <2-3 main features>

Be specific and concise. Return ONLY the profile lines, no other text.`;

    const response = await imageService.analyzeImage('', prompt);
    const trimmed = response.trim();
    if (trimmed && trimmed.includes('Project:')) {
      return trimmed;
    }
    return rawContext;
  }

  // ========================================================================
  // Image → SVG Conversion
  // ========================================================================

  async *convertToSvg(
    canvasId: string,
    imageBase64: string,
    prompt: string,
    imageService: ImageGenerationService,
    frameBounds?: { left: number; top: number; width: number; height: number },
    frameMetadata?: Record<string, string>
  ): AsyncGenerator<CanvasStreamChunk> {
    yield { type: 'canvas_svg_started', canvasId };
    yield { type: 'canvas_svg_progress', canvasId, content: 'Analyzing image...', progress: 10 };

    const viewBoxW = frameBounds?.width || 800;
    const viewBoxH = frameBounds?.height || 600;

    const svgPrompt = `You are an expert SVG designer. Convert the provided image into clean, semantic SVG markup.

RULES:
1. Use viewBox="0 0 ${viewBoxW} ${viewBoxH}" to match the design dimensions.
2. Group logical elements with descriptive id and class attributes.
3. Preserve all colors as hex values.
4. Use <text> for text elements, <path> for shapes, <rect>/<circle>/<ellipse> for geometric shapes.
5. Minimize complexity — produce clean, production-ready SVG.
6. Do NOT include raster images or <image> tags — recreate everything as vector elements.
7. Use appropriate stroke-width, fill, and opacity values.
${prompt ? `8. Additional instructions: ${prompt}` : ''}

Return ONLY the SVG markup wrapped in <svg>...</svg> tags. No explanation.`;

    let fullResponse = '';
    try {
      yield { type: 'canvas_svg_progress', canvasId, content: 'Converting to SVG...', progress: 30 };
      fullResponse = await imageService.analyzeImage(imageBase64, svgPrompt);
    } catch (err: any) {
      console.log(`[Mysti] Canvas SVG: Vision API error: ${err.message}`);
      yield { type: 'canvas_error', canvasId, error: `SVG conversion failed: ${err.message}` };
      return;
    }

    console.log(`[Mysti] Canvas SVG: AI response length=${fullResponse.length}, first 500 chars: ${fullResponse.substring(0, 500)}`);

    // Extract SVG block from response — try direct match first, then code fences
    let svgMarkup: string | null = null;
    const directMatch = fullResponse.match(/<svg[\s\S]*?<\/svg>/i);
    if (directMatch) {
      svgMarkup = directMatch[0];
    } else {
      // AI might wrap SVG in markdown code fences
      const codeBlockMatch = fullResponse.match(/```(?:svg|xml|html)?\s*\n([\s\S]*?)```/);
      if (codeBlockMatch) {
        const inner = codeBlockMatch[1].trim();
        const innerSvg = inner.match(/<svg[\s\S]*?<\/svg>/i);
        if (innerSvg) { svgMarkup = innerSvg[0]; }
      }
    }

    if (!svgMarkup) {
      console.log(`[Mysti] Canvas SVG: No SVG found in response. Full response:\n${fullResponse.substring(0, 500)}`);
      yield { type: 'canvas_error', canvasId, error: 'AI did not return valid SVG markup' };
      return;
    }

    console.log(`[Mysti] Canvas SVG: Extracted SVG markup, length=${svgMarkup.length}`);

    // Save SVG to assets
    yield { type: 'canvas_svg_progress', canvasId, content: 'Saving SVG asset...', progress: 80 };
    try {
      const buffer = Buffer.from(svgMarkup, 'utf-8');
      const hash = crypto.createHash('sha256').update(buffer).digest('hex').substring(0, 16);
      const fileName = `${hash}.svg`;
      const workspaceRoot = this._getWorkspaceRoot();
      if (workspaceRoot) {
        const dirUri = vscode.Uri.file(path.join(workspaceRoot, CANVAS_ASSETS_DIR));
        try { await vscode.workspace.fs.createDirectory(dirUri); } catch { /* exists */ }
        const filePath = vscode.Uri.file(path.join(workspaceRoot, CANVAS_ASSETS_DIR, fileName));
        try {
          await vscode.workspace.fs.stat(filePath);
        } catch {
          await vscode.workspace.fs.writeFile(filePath, buffer);
        }
        console.log(`[Mysti] Canvas: saved SVG asset ${fileName}`);
      }
    } catch (err) {
      console.log('[Mysti] Canvas: failed to save SVG asset:', err);
    }

    yield { type: 'canvas_svg_complete', canvasId, svgMarkup, progress: 100 };
  }

  // ========================================================================
  // SVG/Image → Component Code + Storybook
  // ========================================================================

  async *generateCode(
    canvasId: string,
    svgMarkup: string | null,
    imageBase64: string | null,
    prompt: string,
    codeGenService: CodeGenerationService,
    imageService: ImageGenerationService,
    frameLabel?: string,
    frameMetadata?: Record<string, string>,
    projectContext?: string,
    frameBounds?: { left: number; top: number; width: number; height: number },
    designTheme?: DesignTheme,
    designAssets?: DesignAssetRef[]
  ): AsyncGenerator<CanvasStreamChunk> {
    yield { type: 'canvas_code_started', canvasId };

    // Detect framework from project context
    const workspaceRoot = this._getWorkspaceRoot();
    const framework = codeGenService.detectFramework(projectContext || '', workspaceRoot || undefined);

    // Derive component name
    const componentName = codeGenService.deriveComponentName(frameLabel, prompt);

    yield {
      type: 'canvas_code_progress', canvasId,
      content: `Generating ${framework} component "${componentName}"...`,
      progress: 20
    };

    // Delegate to CodeGenerationService
    let files: GeneratedFile[] = [];
    let props: ComponentProp[] = [];

    const dimHint = frameBounds && frameBounds.width > 0
      ? ` (target dimensions: ${Math.round(frameBounds.width)}x${Math.round(frameBounds.height)}px)`
      : '';

    // Build structured design context for the AI prompt
    let designContext = '';
    if (designTheme) {
      designContext += '\n\nDesign System Theme:\n';
      designContext += `Colors: ${JSON.stringify(designTheme.colors)}\n`;
      designContext += `Typography: font-family: ${designTheme.typography.fontFamily}, scale: ${designTheme.typography.scale.join(', ')}px\n`;
      designContext += `Spacing unit: ${designTheme.spacing.unit}px\n`;
      designContext += `Border radii: sm=${designTheme.radii.sm}px, md=${designTheme.radii.md}px, lg=${designTheme.radii.lg}px\n`;
      designContext += 'Use these exact design tokens in the generated code.\n';
    }
    if (designAssets?.length) {
      const resolved = designAssets.filter(a => a.src);
      if (resolved.length) {
        designContext += '\nAvailable assets:\n';
        for (const a of resolved) {
          designContext += `- ${a.id} (${a.type}): ${a.alt || a.prompt || 'unnamed'}\n`;
        }
        designContext += 'Reference these assets by their descriptions when generating image/media elements.\n';
      }
    }

    const genStream = codeGenService.generateComponent({
      svgMarkup: svgMarkup || undefined,
      imageBase64: imageBase64 || undefined,
      componentName,
      framework,
      description: (frameMetadata?.description || frameLabel || '') + dimHint,
      metadata: frameMetadata,
      projectContext,
      imageService,
      designContext: designContext || undefined,
    });

    for await (const chunk of genStream) {
      if (chunk.type === 'progress' && chunk.content) {
        yield { type: 'canvas_code_progress', canvasId, content: chunk.content, progress: 50 };
      }
      if (chunk.type === 'complete') {
        files = chunk.files || [];
        props = chunk.props || [];
      }
      if (chunk.type === 'error' && chunk.content) {
        yield { type: 'canvas_error', canvasId, error: chunk.content };
        return;
      }
    }

    if (files.length === 0) {
      yield { type: 'canvas_error', canvasId, error: 'AI did not produce any code files' };
      return;
    }

    // Write files to workspace
    yield { type: 'canvas_code_progress', canvasId, content: 'Writing files...', progress: 80 };
    if (workspaceRoot) {
      try {
        await codeGenService.writeToWorkspace(files, workspaceRoot);
        // Open the primary component file in editor
        const componentFile = files.find(f => f.fileType === 'component');
        if (componentFile) {
          await codeGenService.openInEditor(componentFile.filePath, workspaceRoot);
        }
      } catch (err: any) {
        console.log('[Mysti] Canvas: failed to write code files:', err);
      }
    }

    yield {
      type: 'canvas_code_complete',
      canvasId,
      generatedFiles: files,
      componentProps: props,
      framework,
      componentName,
      progress: 100
    };
  }

  // ========================================================================
  // Code Generation from Stitch HTML
  // ========================================================================

  async *generateCodeFromStitch(
    canvasId: string,
    stitchScreenRef: StitchScreenRef,
    prompt: string,
    codeGenService: CodeGenerationService,
    imageService: ImageGenerationService,
    projectContext?: string,
  ): AsyncGenerator<CanvasStreamChunk> {
    yield { type: 'canvas_code_started', canvasId };

    try {
      await this._ensureStitchAuth();

      yield { type: 'canvas_code_progress', canvasId, content: 'Fetching Stitch HTML...', progress: 10 };

      // Get the HTML source from Stitch
      const htmlContent = await this._stitchService.getScreenHtml(stitchScreenRef);
      if (!htmlContent) {
        yield { type: 'canvas_error', canvasId, error: 'Stitch did not return HTML content' };
        return;
      }

      const workspaceRoot = this._getWorkspaceRoot();
      const framework = codeGenService.detectFramework(projectContext || '', workspaceRoot || undefined);
      const componentName = codeGenService.deriveComponentName(undefined, prompt || 'StitchScreen');

      // For HTML framework: write the Stitch HTML directly
      if (framework === 'html') {
        const files: GeneratedFile[] = [{
          filePath: `src/components/${componentName}.html`,
          fileName: `${componentName}.html`,
          content: htmlContent,
          fileType: 'component',
        }];

        if (workspaceRoot) {
          try {
            await codeGenService.writeToWorkspace(files, workspaceRoot);
            await codeGenService.openInEditor(files[0].filePath, workspaceRoot);
          } catch (err: any) {
            console.warn('[Mysti] Failed to write Stitch HTML file:', err.message);
          }
        }

        yield {
          type: 'canvas_code_complete', canvasId,
          generatedFiles: files, componentProps: [],
          framework, componentName, progress: 100,
        };
        return;
      }

      // For React/Vue: pass Stitch HTML to CodeGenerationService for conversion
      yield { type: 'canvas_code_progress', canvasId, content: `Converting to ${framework} component...`, progress: 30 };

      const designContext = `\n\nSource HTML from Stitch (high-fidelity UI generation):\n\`\`\`html\n${htmlContent.substring(0, 15000)}\n\`\`\`\n\nConvert this HTML into a clean, well-structured ${framework} component. Preserve the visual design, colors, typography, and layout exactly. Use the HTML as the definitive reference — do not infer from images.\n`;

      let files: GeneratedFile[] = [];
      let props: ComponentProp[] = [];

      const genStream = codeGenService.generateComponent({
        componentName,
        framework,
        description: prompt || `Stitch-generated UI screen`,
        projectContext,
        imageService,
        designContext,
      });

      for await (const chunk of genStream) {
        if (chunk.type === 'progress' && chunk.content) {
          yield { type: 'canvas_code_progress', canvasId, content: chunk.content, progress: 50 };
        }
        if (chunk.type === 'complete') {
          files = chunk.files || [];
          props = chunk.props || [];
        }
        if (chunk.type === 'error' && chunk.content) {
          yield { type: 'canvas_error', canvasId, error: chunk.content };
          return;
        }
      }

      if (files.length === 0) {
        yield { type: 'canvas_error', canvasId, error: 'Code generation produced no files' };
        return;
      }

      yield { type: 'canvas_code_progress', canvasId, content: 'Writing files...', progress: 80 };
      if (workspaceRoot) {
        try {
          await codeGenService.writeToWorkspace(files, workspaceRoot);
          const componentFile = files.find(f => f.fileType === 'component');
          if (componentFile) {
            await codeGenService.openInEditor(componentFile.filePath, workspaceRoot);
          }
        } catch (err: any) {
          console.warn('[Mysti] Failed to write code files:', err.message);
        }
      }

      yield {
        type: 'canvas_code_complete', canvasId,
        generatedFiles: files, componentProps: props,
        framework, componentName, progress: 100,
      };
    } catch (err: any) {
      yield { type: 'canvas_error', canvasId, error: `Stitch code generation failed: ${err.message}` };
    }
  }

  // ========================================================================
  // Element Editing — AI-powered element-level modifications
  // ========================================================================

  async *editElement(
    canvasId: string,
    instruction: string,
    elementSelection: ElementSelection,
    imageService: ImageGenerationService,
    codeGenService: CodeGenerationService,
    editType: 'edit-element' | 'edit-layout' = 'edit-element'
  ): AsyncGenerator<CanvasStreamChunk> {
    yield { type: 'canvas_element_edit_started', canvasId };

    const { componentSource, componentName, framework, selectorPath, tagName, computedStyles, textContent, domSnapshot } = elementSelection;

    if (!componentSource) {
      yield { type: 'canvas_error', canvasId, error: 'No component source code available for editing' };
      return;
    }

    const styleDesc = Object.entries(computedStyles || {})
      .filter(([, v]) => v && v !== 'none' && v !== 'normal' && v !== '0px')
      .map(([k, v]) => `${k}: ${v}`)
      .join('; ');

    const contextType = editType === 'edit-layout' ? 'layout' : 'element';
    const prompt = `You are modifying a ${framework || 'React'} component named "${componentName || 'Component'}".

CURRENT COMPONENT SOURCE CODE:
\`\`\`
${componentSource}
\`\`\`

SELECTED ELEMENT:
- CSS Selector: ${selectorPath}
- Tag: <${tagName}>
- Current text: "${textContent || ''}"
- Current styles: ${styleDesc || 'none extracted'}
${domSnapshot ? `\nRENDERED DOM SNIPPET:\n${domSnapshot.substring(0, 2000)}` : ''}

USER'S ${contextType.toUpperCase()} EDIT INSTRUCTION:
${instruction}

RULES:
1. Return the COMPLETE updated component source code.
2. Only modify what the user asked for — do not change unrelated parts.
3. Keep the same component name, exports, and overall structure.
4. Apply changes inline in the component code (not as external CSS).
5. Maintain code quality — clean, readable, idiomatic ${framework || 'React'}.

Return ONLY the updated component code in a single code block:
\`\`\`component
// updated code here
\`\`\``;

    try {
      const response = await imageService.analyzeImage('', prompt);

      // Extract component code from response
      const componentMatch = response.match(/```component\s*\n([\s\S]*?)```/);
      const fallbackMatch = response.match(/```(?:tsx?|jsx?|vue|html)\s*\n([\s\S]*?)```/);
      const updatedCode = (componentMatch?.[1] || fallbackMatch?.[1] || '').trim();

      if (!updatedCode) {
        yield { type: 'canvas_error', canvasId, error: 'AI did not return updated component code' };
        return;
      }

      // Build updated file
      const updatedFiles: GeneratedFile[] = [{
        filePath: `canvas-components/${componentName || 'Component'}${framework === 'vue' ? '.vue' : '.tsx'}`,
        fileName: `${componentName || 'Component'}${framework === 'vue' ? '.vue' : '.tsx'}`,
        fileType: 'component',
        content: updatedCode,
      }];

      yield {
        type: 'canvas_element_edit_complete',
        canvasId,
        generatedFiles: updatedFiles,
        componentName: componentName || 'Component',
        framework: (framework as 'react' | 'vue' | 'html') || 'react',
        objectId: elementSelection.objectId,
        progress: 100,
      };

    } catch (err: any) {
      yield { type: 'canvas_error', canvasId, error: `Element edit failed: ${err.message}` };
    }
  }

  async *applyElementEdits(
    canvasId: string,
    payload: ElementEditPayload,
    imageService: ImageGenerationService
  ): AsyncGenerator<CanvasStreamChunk> {
    yield { type: 'canvas_element_edit_started', canvasId };

    const editsDesc = payload.edits
      .map(e => `- ${e.property}: "${e.value}" on element "${e.selectorPath}"`)
      .join('\n');

    const prompt = `You are modifying a ${payload.framework || 'React'} component named "${payload.componentName}".

CURRENT COMPONENT SOURCE CODE:
\`\`\`
${payload.currentCode}
\`\`\`

APPLY THESE CHANGES:
${editsDesc}

RULES:
1. Return the COMPLETE updated component source code with all changes applied.
2. Apply style changes as inline styles or by modifying existing style values in the code.
3. Apply text changes by updating the text content in the JSX/template.
4. Keep the same component name, exports, and overall structure.
5. Do not add comments about what was changed.

Return ONLY the updated component code in a single code block:
\`\`\`component
// updated code here
\`\`\``;

    try {
      const response = await imageService.analyzeImage('', prompt);

      const componentMatch = response.match(/```component\s*\n([\s\S]*?)```/);
      const fallbackMatch = response.match(/```(?:tsx?|jsx?|vue|html)\s*\n([\s\S]*?)```/);
      const updatedCode = (componentMatch?.[1] || fallbackMatch?.[1] || '').trim();

      if (!updatedCode) {
        yield { type: 'canvas_error', canvasId, error: 'AI did not return updated component code' };
        return;
      }

      const updatedFiles: GeneratedFile[] = [{
        filePath: `canvas-components/${payload.componentName}${payload.framework === 'vue' ? '.vue' : '.tsx'}`,
        fileName: `${payload.componentName}${payload.framework === 'vue' ? '.vue' : '.tsx'}`,
        fileType: 'component',
        content: updatedCode,
      }];

      yield {
        type: 'canvas_element_edit_complete',
        canvasId,
        generatedFiles: updatedFiles,
        componentName: payload.componentName,
        framework: (payload.framework as 'react' | 'vue' | 'html') || 'react',
        objectId: payload.objectId,
        progress: 100,
      };

    } catch (err: any) {
      yield { type: 'canvas_error', canvasId, error: `Element edit failed: ${err.message}` };
    }
  }

  // ========================================================================
  // CLI Integration — Send generated code to CLI for project integration
  // ========================================================================

  async *integrateComponent(
    canvasId: string,
    files: GeneratedFile[],
    componentName: string,
    framework: string,
    providerManager: ProviderManagerLike,
    settings: Settings,
    panelId?: string
  ): AsyncGenerator<CanvasStreamChunk> {
    yield { type: 'canvas_integrate_started', canvasId, content: 'Integrating component...', progress: 10 };

    const fileList = files.map(f => f.filePath).join('\n');
    const componentFile = files.find(f => f.fileType === 'component');

    const integrationPrompt = `I've generated a ${framework} component "${componentName}". The files have been written to the workspace at:\n${fileList}\n\nComponent code:\n\`\`\`\n${componentFile?.content || ''}\n\`\`\`\n\nPlease integrate this component into the project:\n1. Add necessary imports where the component should be used\n2. If there's a router, add a route for it (or add it to an existing page)\n3. Install any missing dependencies\n4. Keep it modular — don't duplicate code that already exists in the project\n5. Do NOT modify the generated component file itself\n\nBe minimal — only add what's needed to make the component accessible in the app.`;

    try {
      const stream = providerManager.sendMessage(
        integrationPrompt,
        [],
        settings,
        null,
        undefined,
        panelId
      );

      for await (const chunk of stream) {
        if (chunk.type === 'text') {
          yield { type: 'canvas_integrate_progress', canvasId, content: chunk.content || '', progress: 50 };
        }
        if (chunk.type === 'done') {
          yield { type: 'canvas_integrate_complete', canvasId, content: `Component "${componentName}" integrated`, progress: 100 };
        }
      }
    } catch (err: any) {
      console.log(`[Mysti] Canvas: Integration failed: ${err.message}`);
      yield { type: 'canvas_error', canvasId, error: `Integration failed: ${err.message}` };
    }
  }

  // ========================================================================
  // Unified Prompt Parsing
  // ========================================================================

  static parseUnifiedPrompt(text: string): CanvasUnifiedParsed {
    const trimmed = text.trim();

    if (trimmed.startsWith('/render')) {
      const arg = trimmed.slice('/render'.length).trim();
      return { action: 'render', argument: arg };
    }
    // /design → Stitch generateScreen (primary design command)
    if (trimmed.startsWith('/design-dna')) {
      const arg = trimmed.slice('/design-dna'.length).trim();
      return { action: 'design-dna', argument: arg };
    }
    if (trimmed.startsWith('/design')) {
      const arg = trimmed.slice('/design'.length).trim();
      return { action: 'page', argument: arg };
    }
    // /image and /generate both → AI image generation (DALL-E/Gemini). The
    // prompt bar emits /image; /generate is the canonical alias asserted by
    // tests and kept in sync with the webview vocabulary (F-4).
    if (trimmed.startsWith('/generate')) {
      const arg = trimmed.slice('/generate'.length).trim();
      return { action: 'generate', argument: arg };
    }
    if (trimmed.startsWith('/image')) {
      const arg = trimmed.slice('/image'.length).trim();
      return { action: 'generate', argument: arg };
    }
    // /reimagine → AI variant generation of the selected screen/image
    // (Stitch variants when a Stitch screen is selected, else image variants).
    if (trimmed.startsWith('/reimagine')) {
      const arg = trimmed.slice('/reimagine'.length).trim();
      return { action: 'reimagine', argument: arg };
    }
    if (trimmed.startsWith('/video')) {
      const arg = trimmed.slice('/video'.length).trim();
      return { action: 'video', argument: arg };
    }
    if (trimmed.startsWith('/website')) {
      const arg = trimmed.slice('/website'.length).trim();
      return { action: 'website', argument: arg };
    }
    if (trimmed.startsWith('/svg')) {
      const arg = trimmed.slice('/svg'.length).trim();
      return { action: 'svg', argument: arg };
    }
    if (trimmed.startsWith('/code')) {
      const arg = trimmed.slice('/code'.length).trim();
      return { action: 'code', argument: arg };
    }
    if (trimmed.startsWith('/edit-element')) {
      const arg = trimmed.slice('/edit-element'.length).trim();
      return { action: 'edit-element', argument: arg };
    }
    if (trimmed.startsWith('/edit-layout')) {
      const arg = trimmed.slice('/edit-layout'.length).trim();
      return { action: 'edit-layout', argument: arg };
    }
    if (trimmed.startsWith('/theme')) {
      const arg = trimmed.slice('/theme'.length).trim();
      return { action: 'theme', argument: arg };
    }
    if (trimmed.startsWith('/edit')) {
      const arg = trimmed.slice('/edit'.length).trim();
      return { action: 'stitch-edit', argument: arg };
    }
    if (trimmed.startsWith('/variants')) {
      const arg = trimmed.slice('/variants'.length).trim();
      return { action: 'stitch-variants', argument: arg };
    }
    if (trimmed.startsWith('/html')) {
      const arg = trimmed.slice('/html'.length).trim();
      return { action: 'stitch-html', argument: arg };
    }
    return { action: 'prompt', argument: trimmed };
  }

  // ========================================================================
  // Page Rendering (headless browser)
  // ========================================================================

  async *renderPage(
    canvasId: string,
    panelId: string,
    urlOrSelector: string,
    browserManager: BrowserManager,
    screenshotService: ScreenshotService,
    devServerManager: DevServerManager
  ): AsyncGenerator<CanvasStreamChunk> {
    yield { type: 'canvas_render_started', canvasId };

    try {
      let url: string | undefined;
      let selector: string | undefined;

      // Determine if argument is a URL, CSS selector, or empty (auto-detect)
      if (urlOrSelector.startsWith('http://') || urlOrSelector.startsWith('https://') || urlOrSelector.startsWith('localhost')) {
        url = urlOrSelector.startsWith('localhost') ? `http://${urlOrSelector}` : urlOrSelector;
      } else if (urlOrSelector.startsWith('.') || urlOrSelector.startsWith('#') || urlOrSelector.startsWith('[')) {
        selector = urlOrSelector;
      } else if (urlOrSelector) {
        // Treat as URL if it looks like host:port
        url = urlOrSelector.includes(':') ? `http://${urlOrSelector}` : undefined;
      }

      // Auto-detect dev server if no URL
      if (!url) {
        if (devServerManager.isRunning(panelId)) {
          url = devServerManager.getUrl(panelId) || undefined;
        }
        if (!url) {
          const workspaceRoot = this._getWorkspaceRoot();
          if (workspaceRoot) {
            const cmd = DevServerManager.detectDevCommand(workspaceRoot);
            if (cmd) {
              yield { type: 'canvas_render_progress', canvasId, progress: 10, content: 'Starting dev server...' };
              const result = await devServerManager.start(panelId, cmd, workspaceRoot);
              url = result.url;
            }
          }
        }
        if (!url) {
          yield { type: 'canvas_error', canvasId, error: 'No dev server found. Use /render http://... with an explicit URL.' };
          return;
        }
      }

      yield { type: 'canvas_render_progress', canvasId, progress: 30, content: `Launching browser → ${url}` };

      // Launch headless browser
      const config = {
        url,
        browser: 'chromium' as const,
        headless: true,
        viewportWidth: CANVAS_RENDER_DEFAULT_VIEWPORT.width,
        viewportHeight: CANVAS_RENDER_DEFAULT_VIEWPORT.height,
        screenshotMode: (selector ? 'element' : 'viewport') as 'viewport' | 'element',
        elementSelector: selector,
        waitForSelector: selector,
        waitForTimeout: 10000,
        maxIterations: 1,
        interactionsEnabled: false,
        requirements: '',
      };

      const page = await browserManager.launch(panelId, config);

      yield { type: 'canvas_render_progress', canvasId, progress: 70, content: 'Capturing screenshot...' };

      // Capture screenshot
      const workspaceRoot = this._getWorkspaceRoot() || '/tmp';
      const screenshot = await screenshotService.capture(page, {
        mode: selector ? 'element' : 'viewport',
        elementSelector: selector,
        iteration: 0,
        label: 'canvas-render',
        outputDir: path.join(workspaceRoot, '.mysti', 'canvas', 'assets'),
      });

      // Close browser
      await browserManager.close(panelId);

      yield {
        type: 'canvas_render_complete',
        canvasId,
        imageBase64: screenshot.base64Data,
        label: `Render: ${url}${selector ? ` (${selector})` : ''}`,
        url,
        progress: 100,
      };
    } catch (err: any) {
      // Clean up browser on error
      try { await browserManager.close(panelId); } catch { /* ignore */ }

      const message = err.message || String(err);
      if (message.includes('playwright') || message.includes('Cannot find module')) {
        yield { type: 'canvas_error', canvasId, error: 'Playwright not installed. Run: npm install playwright && npx playwright install chromium' };
      } else {
        yield { type: 'canvas_error', canvasId, error: `Render failed: ${message}` };
      }
    }
  }

  // ========================================================================
  // Theme Generation — Stitch design system extraction → DesignTheme
  // ========================================================================

  async *generateTheme(
    canvasId: string,
    prompt: string,
    providerManager: ProviderManagerLike,
    settings: Settings
  ): AsyncGenerator<CanvasStreamChunk> {
    yield { type: 'canvas_mockup_started', canvasId };

    try {
      // Use Stitch to generate a screen with the theme prompt, then extract the design system
      if (this._stitchService?.isAvailable) {
        yield { type: 'canvas_stitch_started', canvasId, content: 'Extracting theme from Stitch...' };

        // Get or create Stitch project for this canvas
        let stitchProjectId = this._stitchProjectIds.get(canvasId) || '';
        if (!stitchProjectId) {
          const project = await this._stitchService.createProject(
            STITCH_PROJECT_NAME_PREFIX + (canvasId.substring(0, 8))
          );
          stitchProjectId = project.id;
          this._stitchProjectIds.set(canvasId, stitchProjectId);
        }

        const model = vscode.workspace.getConfiguration('mysti')
          .get<string>('canvas.stitchModel', 'GEMINI_3_PRO') as import('../types').StitchModel;

        // Generate a screen with the theme description — Stitch returns a designSystem alongside
        const themePrompt = `A modern landing page with this design aesthetic: ${prompt}`;
        const { raw } = await this._stitchService.generateScreenWithRaw(
          stitchProjectId, themePrompt, 'DESKTOP', model
        );

        // Extract design system from the response
        const ds = this._stitchService.extractDesignSystemFromRaw(raw);
        if (ds?.designMd) {
          const theme = this._stitchService.parseDesignMdToTheme(ds.designMd, {
            customColor: ds.customColor,
            colorMode: ds.colorMode,
            bodyFont: ds.bodyFont,
          });
          console.log(`[Mysti] Stitch: Theme extracted from design system "${ds.displayName || 'unnamed'}"`);
          yield { type: 'canvas_theme_complete', canvasId, designTheme: theme };
          return;
        }

        console.warn('[Mysti] Stitch: No designSystem in response, falling back to LLM theme generation');
      }

      // Fallback: LLM-based theme generation via provider
      const systemPrompt = `You are a design system expert. Generate a complete theme as JSON.

Return ONLY a JSON object with this exact structure (no markdown, no explanation):
{
  "colors": {
    "primary": "#hex", "secondary": "#hex", "accent": "#hex",
    "background": "#hex", "surface": "#hex",
    "text": "#hex", "textSecondary": "#hex", "border": "#hex",
    "error": "#hex", "success": "#hex"
  },
  "typography": {
    "fontFamily": "font stack",
    "scale": [12, 14, 16, 20, 24, 32, 48],
    "lineHeight": 1.5,
    "weights": { "regular": 400, "medium": 500, "bold": 700 }
  },
  "spacing": { "unit": 4, "scale": [1, 2, 3, 4, 6, 8, 12, 16] },
  "radii": { "sm": 4, "md": 8, "lg": 16, "full": 9999 },
  "shadows": {
    "sm": "css shadow", "md": "css shadow", "lg": "css shadow"
  }
}

Theme description: "${prompt}"`;

      let fullResponse = '';
      const stream = providerManager.sendMessage(
        systemPrompt, [], settings,
        { id: `theme-${canvasId}`, messages: [] },
        undefined, undefined, undefined, undefined
      );

      for await (const chunk of stream) {
        if (chunk.type === 'text' && chunk.content) { fullResponse += chunk.content; }
        if (chunk.type === 'error') {
          yield { type: 'canvas_error', canvasId, error: chunk.content || 'Theme generation failed' };
          return;
        }
      }

      const theme = this._parseJsonFromResponse<DesignTheme>(fullResponse);
      if (!theme || !theme.colors) {
        yield { type: 'canvas_error', canvasId, error: 'Failed to parse theme from AI response' };
        return;
      }

      yield { type: 'canvas_theme_complete', canvasId, designTheme: theme };
    } catch (err: any) {
      yield { type: 'canvas_error', canvasId, error: `Theme generation failed: ${err.message}` };
    }
  }

  // ========================================================================
  // Design Node Code Generation (deterministic, no vision API)
  // ========================================================================

  async *generateCodeFromDesignNode(
    canvasId: string,
    node: DesignNode,
    theme: DesignTheme,
    framework: 'react' | 'vue' | 'html',
    componentName: string,
    projectContext?: string,
    assets?: DesignAssetRef[]
  ): AsyncGenerator<CanvasStreamChunk> {
    yield { type: 'canvas_code_started', canvasId };

    try {
      const code = this._designNodeToCode(node, theme, framework, componentName, projectContext, assets);
      const themeCSS = this._generateThemeCssVars(theme);
      const files: Array<{ filePath: string; fileName: string; fileType: 'component' | 'story' | 'styles'; content: string }> = [];

      // Add theme CSS custom properties file
      files.push({
        filePath: `src/components/${componentName}.theme.css`,
        fileName: `${componentName}.theme.css`,
        fileType: 'styles',
        content: themeCSS,
      });

      if (framework === 'react') {
        files.push({
          filePath: `src/components/${componentName}.tsx`,
          fileName: `${componentName}.tsx`,
          fileType: 'component',
          content: code,
        });
        files.push({
          filePath: `src/components/${componentName}.stories.tsx`,
          fileName: `${componentName}.stories.tsx`,
          fileType: 'story',
          content: this._generateStorybook(componentName, framework),
        });
      } else if (framework === 'vue') {
        files.push({
          filePath: `src/components/${componentName}.vue`,
          fileName: `${componentName}.vue`,
          fileType: 'component',
          content: code,
        });
      } else {
        files.push({
          filePath: `src/components/${componentName}.html`,
          fileName: `${componentName}.html`,
          fileType: 'component',
          content: code,
        });
      }

      yield {
        type: 'canvas_code_complete',
        canvasId,
        generatedFiles: files,
        componentName,
        framework,
      };
    } catch (err: any) {
      yield { type: 'canvas_error', canvasId, error: `Code generation failed: ${err.message}` };
    }
  }

  get designSpecManager(): DesignSpecManager {
    return this._designSpecManager;
  }

  // ========================================================================
  // Asset Generation Pipeline
  // ========================================================================

  async *generateDesignAssets(
    canvasId: string,
    unresolvedAssets: DesignAssetRef[],
    imageGenService: ImageGenerationService
  ): AsyncGenerator<CanvasStreamChunk> {
    // Keywords that suggest the asset is a full UI screen/section (Stitch-eligible)
    const screenKeywords = /\b(page|section|layout|screen|dashboard|form|card|modal|dialog|panel|sidebar|navbar|header|footer|hero)\b/i;

    for (const asset of unresolvedAssets) {
      if (!asset.prompt) { continue; }

      try {
        // Use Stitch for full UI screen/section assets
        if (asset.type === 'image' && this._stitchService?.isAvailable
            && asset.prompt.length > 30 && screenKeywords.test(asset.prompt)) {
          let stitchProjectId = this._stitchProjectIds.get(canvasId) || '';
          if (!stitchProjectId) {
            const project = await this._stitchService.createProject(
              STITCH_PROJECT_NAME_PREFIX + (canvasId.substring(0, 8))
            );
            stitchProjectId = project.id;
            this._stitchProjectIds.set(canvasId, stitchProjectId);
          }

          const model = vscode.workspace.getConfiguration('mysti')
            .get<string>('canvas.stitchModel', 'GEMINI_3_PRO') as import('../types').StitchModel;

          const ref = await this._stitchService.generateScreen(stitchProjectId, asset.prompt, 'DESKTOP', model);
          const imageBase64 = await this._stitchService.getScreenImage(ref);
          if (imageBase64) {
            asset.src = `data:image/png;base64,${imageBase64}`;
            yield { type: 'canvas_asset_generated', canvasId, asset: { ...asset } };
            continue;
          }
        }

        // Use ImageGenService for icons, small images, and non-UI assets
        if (asset.type === 'image' || asset.type === 'icon') {
          const imageResult = await imageGenService.generate(asset.prompt);
          if (imageResult?.imageBase64) {
            asset.src = `data:image/png;base64,${imageResult.imageBase64}`;
            yield { type: 'canvas_asset_generated', canvasId, asset: { ...asset } };
          }
        } else if (asset.type === 'svg') {
          asset.src = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#e5e7eb"/><text x="50" y="55" text-anchor="middle" fill="#6b7280" font-size="10">' + (asset.alt || 'SVG') + '</text></svg>')}`;
          yield { type: 'canvas_asset_generated', canvasId, asset: { ...asset } };
        }
        // Video assets are handled separately by VideoGenerationService
      } catch (err: any) {
        console.warn(`[Mysti] Asset generation failed for ${asset.id}:`, err.message);
      }
    }
  }

  // ========================================================================
  // Private: JSON parsing helpers
  // ========================================================================

  private _parseJsonFromResponse<T>(response: string): T | null {
    // Try extracting JSON from markdown code blocks first
    const codeBlockMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : response.trim();

    try {
      return JSON.parse(jsonStr) as T;
    } catch {
      // Try finding the first [ or { to start of JSON
      const arrayStart = jsonStr.indexOf('[');
      const objStart = jsonStr.indexOf('{');
      const start = arrayStart >= 0 && (objStart < 0 || arrayStart < objStart) ? arrayStart : objStart;
      if (start >= 0) {
        try {
          return JSON.parse(jsonStr.slice(start)) as T;
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  // ========================================================================
  // Private: Deterministic code generation from DesignNode
  // ========================================================================

  private _designNodeToCode(
    node: DesignNode,
    theme: DesignTheme,
    framework: 'react' | 'vue' | 'html',
    componentName: string,
    projectContext?: string,
    assets?: DesignAssetRef[]
  ): string {
    if (framework === 'react') {
      return this._designNodeToReact(node, theme, componentName, projectContext, assets);
    } else if (framework === 'vue') {
      return this._designNodeToVue(node, theme, componentName);
    }
    return this._designNodeToHtmlCode(node, theme);
  }

  private _resolveStyleToken(value: string | undefined, theme: DesignTheme, useVars = false): string {
    if (!value) { return ''; }
    if (theme.colors[value]) {
      if (useVars) { return `var(--color-${value.replace(/([A-Z])/g, '-$1').toLowerCase()})`; }
      return theme.colors[value];
    }
    if ((theme.shadows as any)[value]) {
      if (useVars) { return `var(--shadow-${value})`; }
      return (theme.shadows as any)[value];
    }
    return value;
  }

  private _nodeStyleToCSS(node: DesignNode, theme: DesignTheme, useVars = false): string {
    const parts: string[] = [];
    const s = node.style;
    const l = node.layout;
    const t = node.typography;

    // Layout
    if (l) {
      parts.push(`display: ${l.display || 'flex'}`);
      if (l.display === 'flex') {
        parts.push(`flex-direction: ${l.direction || 'column'}`);
        if (l.wrap) { parts.push('flex-wrap: wrap'); }
      }
      if (l.display === 'grid' && l.gridCols) {
        parts.push(`grid-template-columns: repeat(${l.gridCols}, 1fr)`);
      }
      if (l.gap !== undefined) { parts.push(`gap: ${l.gap}px`); }
      if (l.padding !== undefined) {
        if (Array.isArray(l.padding)) {
          parts.push(`padding: ${l.padding.map(p => p + 'px').join(' ')}`);
        } else {
          parts.push(`padding: ${l.padding}px`);
        }
      }
      const alignMap: Record<string, string> = { start: 'flex-start', end: 'flex-end', center: 'center', stretch: 'stretch' };
      const justifyMap: Record<string, string> = { start: 'flex-start', end: 'flex-end', center: 'center', between: 'space-between', around: 'space-around' };
      if (l.align) { parts.push(`align-items: ${alignMap[l.align] || l.align}`); }
      if (l.justify) { parts.push(`justify-content: ${justifyMap[l.justify] || l.justify}`); }
    }

    // Style
    if (s) {
      if (s.background) { parts.push(`background-color: ${this._resolveStyleToken(s.background, theme, useVars)}`); }
      if (s.radius !== undefined) { parts.push(`border-radius: ${s.radius}px`); }
      if (s.shadow) { parts.push(`box-shadow: ${this._resolveStyleToken(s.shadow, theme, useVars)}`); }
      if (s.opacity !== undefined) { parts.push(`opacity: ${s.opacity}`); }
      if (s.overflow) { parts.push(`overflow: ${s.overflow}`); }
      if (s.border) {
        parts.push(`border: ${s.border.width}px ${s.border.style} ${this._resolveStyleToken(s.border.color, theme, useVars)}`);
      }
    }

    // Typography
    if (t) {
      if (t.family) { parts.push(`font-family: ${t.family}`); }
      else if (useVars) { parts.push('font-family: var(--font-family)'); }
      else if (theme.typography.fontFamily) { parts.push(`font-family: ${theme.typography.fontFamily}`); }
      if (t.size) { parts.push(`font-size: ${t.size}px`); }
      if (t.weight) { parts.push(`font-weight: ${t.weight}`); }
      if (t.color) { parts.push(`color: ${this._resolveStyleToken(t.color, theme, useVars)}`); }
      if (t.lineHeight) { parts.push(`line-height: ${t.lineHeight}`); }
      if (t.align) { parts.push(`text-align: ${t.align}`); }
    }

    // Size
    parts.push(`width: ${node.width}px`);
    parts.push(`min-height: ${node.height}px`);

    return parts.join('; ');
  }

  private _designNodeToReact(
    node: DesignNode,
    theme: DesignTheme,
    componentName: string,
    projectContext?: string,
    assets?: DesignAssetRef[]
  ): string {
    const lines: string[] = [];
    // Project context header comment
    if (projectContext) {
      lines.push(`/**`);
      lines.push(` * ${componentName} — generated from design spec`);
      lines.push(` * ${projectContext.split('\n')[0]}`);
      lines.push(` */`);
    }
    lines.push(`import React from 'react';`);
    lines.push(`import './${componentName}.theme.css';`);
    lines.push('');
    lines.push(`const ${componentName}: React.FC = () => {`);
    lines.push('  return (');
    lines.push(this._nodeToJSX(node, theme, 2, true, assets));
    lines.push('  );');
    lines.push('};');
    lines.push('');
    lines.push(`export default ${componentName};`);
    return lines.join('\n');
  }

  private _nodeToJSX(node: DesignNode, theme: DesignTheme, indent: number, useVars = false, allAssets?: DesignAssetRef[]): string {
    const pad = ' '.repeat(indent * 2);
    const style = this._nodeStyleToCSS(node, theme, useVars);
    const lines: string[] = [];

    lines.push(`${pad}<div style={{${this._cssToReactStyle(style)}}}`);
    if (node.componentType) { lines[lines.length - 1] += ` /* ${node.componentType} */`; }
    lines[lines.length - 1] += '>';

    if (node.text) {
      const typoStyle = node.typography ? this._cssToReactStyle(this._nodeStyleToCSS({ ...node, layout: { display: 'block' }, style: {}, children: undefined } as any, theme, useVars)) : '';
      lines.push(`${pad}  <span${typoStyle ? ` style={{${typoStyle}}}` : ''}>{${JSON.stringify(node.text)}}</span>`);
    }

    if (node.assets) {
      for (const nodeAsset of node.assets) {
        // Resolve from global asset library if available
        const resolved = allAssets?.find(a => a.id === nodeAsset.id) || nodeAsset;
        if (resolved.type === 'image' || resolved.type === 'icon' || resolved.type === 'svg') {
          if (resolved.src) {
            lines.push(`${pad}  <img src="${resolved.src}" alt="${resolved.alt || resolved.prompt || ''}" style={{objectFit: '${resolved.fit || 'cover'}', width: '100%'}} />`);
          } else {
            lines.push(`${pad}  {/* TODO: Generate asset — prompt: "${resolved.prompt || 'unnamed'}" */}`);
            lines.push(`${pad}  <img src="/placeholder.png" alt="${resolved.alt || resolved.prompt || ''}" style={{objectFit: '${resolved.fit || 'cover'}', width: '100%'}} />`);
          }
        } else if (resolved.type === 'video') {
          if (resolved.src) {
            lines.push(`${pad}  <video src="${resolved.src}" autoPlay muted loop style={{objectFit: '${resolved.fit || 'cover'}', width: '100%'}} />`);
          } else {
            lines.push(`${pad}  {/* TODO: Generate video — prompt: "${resolved.prompt || 'unnamed'}" */}`);
            lines.push(`${pad}  <video src="" autoPlay muted loop style={{objectFit: '${resolved.fit || 'cover'}', width: '100%'}} />`);
          }
        }
      }
    }

    if (node.children) {
      for (const child of node.children) {
        lines.push(this._nodeToJSX(child, theme, indent + 1, useVars, allAssets));
      }
    }

    lines.push(`${pad}</div>`);
    return lines.join('\n');
  }

  private _cssToReactStyle(css: string): string {
    return css.split(';').map(s => s.trim()).filter(Boolean).map(prop => {
      const [key, ...valParts] = prop.split(':');
      const val = valParts.join(':').trim();
      const camelKey = key.trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const isNum = /^\d+px$/.test(val);
      return `${camelKey}: ${isNum ? parseInt(val, 10) : `'${val}'`}`;
    }).join(', ');
  }

  private _designNodeToVue(node: DesignNode, theme: DesignTheme, componentName: string): string {
    return `<template>\n${this._nodeToVueTemplate(node, theme, 1)}\n</template>\n\n<script setup lang="ts">\n// ${componentName}\n</script>`;
  }

  private _nodeToVueTemplate(node: DesignNode, theme: DesignTheme, indent: number): string {
    const pad = ' '.repeat(indent * 2);
    const style = this._nodeStyleToCSS(node, theme);
    const lines: string[] = [];
    lines.push(`${pad}<div style="${style}">`);
    if (node.text) { lines.push(`${pad}  <span>${node.text}</span>`); }
    if (node.children) {
      for (const child of node.children) { lines.push(this._nodeToVueTemplate(child, theme, indent + 1)); }
    }
    lines.push(`${pad}</div>`);
    return lines.join('\n');
  }

  private _designNodeToHtmlCode(node: DesignNode, theme: DesignTheme): string {
    return `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>\n<body style="margin:0;font-family:${theme.typography.fontFamily}">\n${this._nodeToVueTemplate(node, theme, 1)}\n</body></html>`;
  }

  private _generateStorybook(componentName: string, framework: string): string {
    return `import type { Meta, StoryObj } from '@storybook/react';\nimport ${componentName} from './${componentName}';\n\nconst meta: Meta<typeof ${componentName}> = {\n  title: 'Components/${componentName}',\n  component: ${componentName},\n};\n\nexport default meta;\ntype Story = StoryObj<typeof ${componentName}>;\n\nexport const Default: Story = {};`;
  }

  // ========================================================================
  // Theme CSS Variables
  // ========================================================================

  private _generateThemeCssVars(theme: DesignTheme): string {
    const vars: string[] = [];
    for (const [key, val] of Object.entries(theme.colors)) {
      vars.push(`  --color-${key.replace(/([A-Z])/g, '-$1').toLowerCase()}: ${val};`);
    }
    vars.push(`  --font-family: ${theme.typography.fontFamily};`);
    theme.typography.scale.forEach((s, i) => vars.push(`  --font-size-${i}: ${s}px;`));
    vars.push(`  --spacing-unit: ${theme.spacing.unit}px;`);
    for (const [key, val] of Object.entries(theme.radii)) {
      vars.push(`  --radius-${key}: ${val}px;`);
    }
    for (const [key, val] of Object.entries(theme.shadows)) {
      vars.push(`  --shadow-${key}: ${val};`);
    }
    return `:root {\n${vars.join('\n')}\n}`;
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  private _getWorkspaceRoot(): string | null {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
  }
}
