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
  CANVAS_BATCH_CONCURRENCY,
  CANVAS_ASSET_REF_PREFIX
} from '../constants';
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
  Settings,
  StreamChunk,
  Attachment
} from '../types';
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

  // Static cache — shared across all canvas panels, invalidated on workspace change
  private static _projectProfileCache: string | null = null;
  private static _profileWorkspaceRoot: string | null = null;

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
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
    return session;
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

  async deleteSession(id: string): Promise<void> {
    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) { return; }
    const filePath = vscode.Uri.file(path.join(workspaceRoot, CANVAS_DIR, `${id}.json`));
    try { await vscode.workspace.fs.delete(filePath); } catch { /* not found */ }
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

  async *reimagine(
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
  // Layout Generation
  // ========================================================================

  async *generateLayout(
    canvasId: string,
    level: 'page' | 'section' | 'component',
    prompt: string,
    providerManager: ProviderManagerLike,
    settings: Settings,
    projectContext?: string,
    frameBounds?: { left: number; top: number; width: number; height: number },
    selectionDescription?: string,
    regionImageBase64?: string,
    regionObjects?: CanvasObjectSummary[]
  ): AsyncGenerator<CanvasStreamChunk> {
    yield { type: 'canvas_layout_started', canvasId };

    try {
      // Step 1: Enhance the user's prompt via AI (like _buildSmartPrompt for images)
      yield { type: 'canvas_layout_progress', canvasId, content: 'Enhancing layout prompt...' };
      const enhancedPrompt = await this._buildLayoutPrompt(
        prompt, level, providerManager, settings, {
          frameBounds, regionImageBase64, projectContext, selectionDescription, regionObjects,
        }
      );

      // Step 2: Generate the layout frames using the enhanced prompt
      yield { type: 'canvas_layout_progress', canvasId, content: 'Generating layout frames...' };
      const levelGuide: Record<string, string> = {
        page: `Generate a full page wireframe layout with 5-12 frames covering: navigation/header, hero section, key content sections (features, pricing, testimonials, etc.), and footer. Stack frames vertically in logical page flow order. Use full-width frames for major sections and side-by-side frames for grid layouts (e.g., feature cards, pricing tiers).`,
        section: `Generate a section wireframe layout with 3-8 component frames. This is one section of a larger page (e.g., a pricing section with title + 3 price cards + CTA, or a features grid with heading + 4 feature blocks). Arrange frames in a logical grid or flow within a single section.`,
        component: `Generate a single component wireframe frame. This is one UI component (e.g., a login form, a navigation bar, a product card, a sidebar). Return exactly 1 frame with appropriate dimensions for the component type.`,
      };

      // When a container frame is selected, frames must fit inside it
      const hasContainer = !!(frameBounds && frameBounds.width > 0 && frameBounds.height > 0);
      const contentWidth = hasContainer ? Math.round(frameBounds!.width) : 1200;
      const contentHeight = hasContainer ? Math.round(frameBounds!.height) : undefined;
      const selectionLine = selectionDescription ? `\nExisting content in selected area: ${selectionDescription}` : '';
      const containerConstraint = hasContainer
        ? `\nIMPORTANT: A container frame is selected (${contentWidth}x${contentHeight}px). All generated frames MUST fit within this container. Use positions relative to (0, 0) as the top-left of the container. The total layout height must not exceed ${contentHeight}px and width must not exceed ${contentWidth}px. Pad 16px inside the container edges.`
        : '';

      const systemPrompt = `You are a UI layout architect. Given the project context and user request, generate a wireframe layout.

Project context:
${projectContext || 'General web project'}

Enhanced request: ${enhancedPrompt}
${selectionLine}${containerConstraint}

${levelGuide[level]}

Return a JSON array of frame objects. Each frame has a label, description (what should be rendered inside), and metadata:
[
  {
    "left": 0, "top": 0, "width": ${contentWidth}, "height": 72,
    "label": "Navigation Bar",
    "description": "Top nav with logo on left, menu links (Features, Pricing, Docs) in center, Sign In and Get Started buttons on right. Dark background, white text.",
    "metadata": { "role": "navigation", "componentType": "navbar" }
  },
  {
    "left": 0, "top": 88, "width": ${contentWidth}, "height": 480,
    "label": "Hero Section",
    "description": "Large hero with headline, subheading, CTA button, and illustration on the right. Gradient background.",
    "metadata": { "role": "hero", "componentType": "hero-banner" }
  }
]

Guidelines:
- Content width is ${contentWidth}px. Full-width frames should be ${contentWidth}px wide.
- For grid layouts (e.g., 3 cards), divide width evenly with 16px gaps between columns.
- Use realistic web dimensions (header: 60-80px tall, hero: 400-600px, cards: 280-360px tall).
- Leave 16px vertical gaps between frames.
- Labels: short name (e.g., "Navigation Bar", "Feature Card 1").
- Descriptions: detailed, specific to the project — describe what to render inside (colors, layout, content). This will be used by an image generation AI.
- Metadata: include "role" (navigation, hero, content, sidebar, footer, card, form, etc.) and "componentType" (navbar, hero-banner, feature-grid, pricing-card, footer, login-form, etc.).
- All positions start from (0, 0) — the consumer will offset them to the current viewport.

Return ONLY the JSON array, no markdown, no explanation.`;

      let aiResponse = '';
      const stream = providerManager.sendMessage(systemPrompt, [], settings, null);
      for await (const chunk of stream) {
        if (chunk.type === 'text' && chunk.content) {
          aiResponse += chunk.content;
        }
      }
      yield { type: 'canvas_layout_progress', canvasId, content: 'Processing layout...' };

      // Parse JSON array from response
      const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        throw new Error('AI did not return a valid layout. Try again with a more specific prompt.');
      }

      const frames = JSON.parse(jsonMatch[0]);

      if (!Array.isArray(frames) || frames.length === 0) {
        throw new Error('AI returned an empty layout.');
      }

      // Validate and sanitize frame data
      const sanitized = frames
        .filter((f: any) => typeof f.left === 'number' && typeof f.top === 'number' &&
                     typeof f.width === 'number' && typeof f.height === 'number' &&
                     f.width > 0 && f.height > 0)
        .map((f: any) => ({
          left: Math.round(f.left),
          top: Math.round(f.top),
          width: Math.round(f.width),
          height: Math.round(f.height),
          label: String(f.label || 'Frame'),
          description: f.description ? String(f.description) : undefined,
          metadata: (f.metadata && typeof f.metadata === 'object') ? f.metadata : undefined,
        }));

      if (sanitized.length === 0) {
        throw new Error('AI returned invalid frame data.');
      }

      yield { type: 'canvas_layout_complete', canvasId, frames: sanitized };
    } catch (err: any) {
      yield { type: 'canvas_error', canvasId, error: err.message };
    }
  }

  // ========================================================================
  // Website Generation (Multi-Page)
  // ========================================================================

  /**
   * Generate a multi-page website layout. Creates a site plan, then generates
   * per-page layouts arranged horizontally on the canvas.
   */
  async *generateWebsite(
    canvasId: string,
    prompt: string,
    providerManager: ProviderManagerLike,
    settings: Settings,
    projectContext?: string,
    regionImageBase64?: string,
    regionObjects?: CanvasObjectSummary[]
  ): AsyncGenerator<CanvasStreamChunk> {
    yield { type: 'canvas_website_started', canvasId };

    try {
      // Step 1: AI generates site plan — list of pages with descriptions
      yield { type: 'canvas_layout_progress', canvasId, content: 'Planning website structure...' };
      const sitePlan = await this._buildWebsitePlan(prompt, providerManager, settings, projectContext);

      const PAGE_WIDTH = 1440;
      const PAGE_GAP = 100;
      const allPages: Array<{ name: string; description: string; frames: Array<{ left: number; top: number; width: number; height: number; label: string; description?: string; metadata?: Record<string, string> }> }> = [];

      // Step 2: For each page, generate layout frames
      for (let pi = 0; pi < sitePlan.length; pi++) {
        const page = sitePlan[pi];
        yield { type: 'canvas_website_page_started', canvasId, pageIndex: pi, totalPages: sitePlan.length, pageName: page.name };

        const pageFrames = await this._generatePageFrames(
          page, providerManager, settings, projectContext, PAGE_WIDTH, regionImageBase64, regionObjects
        );

        // Offset frames horizontally for this page's column
        const pageOffsetX = pi * (PAGE_WIDTH + PAGE_GAP);
        const offsetFrames = pageFrames.map(f => ({ ...f, left: f.left + pageOffsetX }));

        allPages.push({ name: page.name, description: page.description, frames: offsetFrames });
      }

      // Step 3: Yield all pages at once so webview can render them
      yield { type: 'canvas_website_complete', canvasId, pages: allPages };
    } catch (err: any) {
      yield { type: 'canvas_error', canvasId, error: err.message };
    }
  }

  /**
   * Build a website site plan — list of pages with names, descriptions, and key sections.
   */
  private async _buildWebsitePlan(
    userPrompt: string,
    providerManager: ProviderManagerLike,
    settings: Settings,
    projectContext?: string
  ): Promise<Array<{ name: string; description: string; sections: string[] }>> {
    const systemPrompt = `You are a website information architect. Given the user's website description, produce a site plan.

Project context: ${projectContext || 'General web project'}

User request: ${userPrompt || 'A modern website'}

Generate a JSON array of pages for this website. Each page has:
- "name": Short page name (e.g., "Homepage", "Pricing", "About Us", "Documentation")
- "description": What this page contains and its purpose (2-3 sentences)
- "sections": Array of section names this page should have (e.g., ["Navigation", "Hero", "Features Grid", "Testimonials", "Footer"])

Guidelines:
- Generate 4-7 pages for a typical website
- Always include a Homepage as the first page
- Include pages appropriate for the project type (e.g., SaaS: pricing, features, docs; Portfolio: projects, about, contact; E-commerce: products, cart, checkout)
- Each page should have 4-8 sections
- Navigation and footer sections should be consistent across pages
- Be specific to the project — use real feature names, not generic placeholders

Return ONLY the JSON array, no markdown, no explanation.`;

    let aiResponse = '';
    const stream = providerManager.sendMessage(systemPrompt, [], settings, null);
    for await (const chunk of stream) {
      if (chunk.type === 'text' && chunk.content) {
        aiResponse += chunk.content;
      }
    }

    const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error('AI did not return a valid site plan. Try again with a more specific description.');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('AI returned an empty site plan.');
    }

    return parsed.slice(0, 8).map((p: any) => ({
      name: String(p.name || 'Page'),
      description: String(p.description || ''),
      sections: Array.isArray(p.sections) ? p.sections.map(String) : [],
    }));
  }

  /**
   * Generate layout frames for a single page of a website.
   * Reuses the same AI prompt logic as generateLayout(level='page').
   */
  private async _generatePageFrames(
    page: { name: string; description: string; sections: string[] },
    providerManager: ProviderManagerLike,
    settings: Settings,
    projectContext?: string,
    pageWidth: number = 1440,
    regionImageBase64?: string,
    regionObjects?: CanvasObjectSummary[]
  ): Promise<Array<{ left: number; top: number; width: number; height: number; label: string; description?: string; metadata?: Record<string, string> }>> {
    const sectionsGuide = page.sections.length > 0
      ? `This page should include these sections: ${page.sections.join(', ')}.`
      : '';

    const systemPrompt = `You are a UI layout architect. Generate a wireframe layout for a single page of a multi-page website.

Project context: ${projectContext || 'General web project'}

Page: "${page.name}"
Purpose: ${page.description}
${sectionsGuide}

Generate a full page wireframe layout with 5-12 frames covering all sections of this page. Stack frames vertically in logical page flow order. Use full-width frames for major sections and side-by-side frames for grid layouts.

Return a JSON array of frame objects:
[
  {
    "left": 0, "top": 0, "width": ${pageWidth}, "height": 72,
    "label": "Navigation Bar",
    "description": "Top nav with logo on left, menu links in center, CTA button on right. Dark background.",
    "metadata": { "role": "navigation", "componentType": "navbar" }
  }
]

Guidelines:
- Content width is ${pageWidth}px. Full-width frames should be ${pageWidth}px wide.
- For grid layouts (e.g., 3 cards), divide width evenly with 16px gaps between columns.
- Use realistic web dimensions (header: 60-80px tall, hero: 400-600px, cards: 280-360px tall).
- Leave 16px vertical gaps between frames.
- Labels: short name prefixed with page name (e.g., "${page.name} - Navigation", "${page.name} - Hero").
- Descriptions: detailed, specific to the project — describe what to render inside.
- Metadata: include "role" and "componentType".
- All positions start from (0, 0).

Return ONLY the JSON array, no markdown, no explanation.`;

    let aiResponse = '';
    const stream = providerManager.sendMessage(systemPrompt, [], settings, null);
    for await (const chunk of stream) {
      if (chunk.type === 'text' && chunk.content) {
        aiResponse += chunk.content;
      }
    }

    const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      // Fallback: single frame for the whole page
      return [{
        left: 0, top: 0, width: pageWidth, height: 800,
        label: page.name, description: page.description,
        metadata: { role: 'page', componentType: 'full-page' },
      }];
    }

    const frames = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(frames) || frames.length === 0) {
      return [{
        left: 0, top: 0, width: pageWidth, height: 800,
        label: page.name, description: page.description,
        metadata: { role: 'page', componentType: 'full-page' },
      }];
    }

    return frames
      .filter((f: any) => typeof f.left === 'number' && typeof f.top === 'number' &&
                   typeof f.width === 'number' && typeof f.height === 'number' &&
                   f.width > 0 && f.height > 0)
      .map((f: any) => ({
        left: Math.round(f.left),
        top: Math.round(f.top),
        width: Math.round(f.width),
        height: Math.round(f.height),
        label: String(f.label || 'Frame'),
        description: f.description ? String(f.description) : undefined,
        metadata: (f.metadata && typeof f.metadata === 'object') ? f.metadata : undefined,
      }));
  }

  /**
   * Generate content (images/videos) for all frames in a layout with a unified visual theme.
   * Uses a single AI call to build a design brief, then generates content in parallel.
   */
  async *generateBatchContent(
    canvasId: string,
    frames: Array<{
      frameId: string; left: number; top: number; width: number; height: number;
      label: string; description?: string; metadata?: Record<string, string>;
    }>,
    imageGenService: { generate(prompt: string, options?: any): Promise<{ imageBase64: string; revisedPrompt?: string }> },
    videoGenService: { isAvailable: boolean; generate(prompt: string, options?: any, onProgress?: any): Promise<{ videoBase64: string; mimeType: string }> },
    providerManager: ProviderManagerLike,
    settings: Settings,
    projectContext?: string,
    regionImageBase64?: string,
    regionObjects?: CanvasObjectSummary[]
  ): AsyncGenerator<CanvasStreamChunk> {
    yield { type: 'canvas_batch_started', canvasId, totalFrames: frames.length };

    try {
      // Step 1: Build unified design brief with per-frame prompts
      const briefs = await this._buildBatchDesignBrief(
        frames, providerManager, settings, projectContext, regionImageBase64, regionObjects
      );

      // Save batch briefs to capture folder
      this._saveCapturePrompt({
        userPrompt: frames.map(f => `[${f.label}] ${f.description || ''}`).join('\n'),
        enhancedPrompt: briefs.map((b, i) => `[Frame ${i}: ${frames[i].label}] ${b.prompt}`).join('\n\n'),
        provider: 'batch',
        genOptions: { frameCount: frames.length },
      });

      // Step 2: Generate content in batches of CANVAS_BATCH_CONCURRENCY
      for (let batchStart = 0; batchStart < frames.length; batchStart += CANVAS_BATCH_CONCURRENCY) {
        const batchEnd = Math.min(batchStart + CANVAS_BATCH_CONCURRENCY, frames.length);
        const batchIndices = Array.from({ length: batchEnd - batchStart }, (_, i) => batchStart + i);

        // Yield frame_started for each frame in this batch
        for (const idx of batchIndices) {
          yield {
            type: 'canvas_batch_frame_started', canvasId,
            frameId: frames[idx].frameId, frameIndex: idx,
            totalFrames: frames.length, label: frames[idx].label,
          };
        }

        // Run this batch in parallel
        const results: CanvasStreamChunk[] = [];
        const promises = batchIndices.map(async (idx) => {
          const frame = frames[idx];
          const brief = briefs[idx];
          try {
            if (brief.mediaType === 'video' && videoGenService.isAvailable) {
              const result = await videoGenService.generate(brief.prompt, {
                frameBounds: { width: frame.width, height: frame.height },
              });
              results.push({
                type: 'canvas_batch_frame_complete', canvasId,
                frameId: frame.frameId, frameIndex: idx, totalFrames: frames.length,
                videoBase64: result.videoBase64, mimeType: result.mimeType,
                label: frame.label,
              });
            } else {
              const genOpts: Record<string, any> = {
                frameBounds: { width: frame.width, height: frame.height },
              };
              if (brief.background !== 'auto') { genOpts.background = brief.background; }
              if (regionImageBase64) { genOpts.referenceImageBase64 = regionImageBase64; }
              const result = await imageGenService.generate(brief.prompt, genOpts);
              results.push({
                type: 'canvas_batch_frame_complete', canvasId,
                frameId: frame.frameId, frameIndex: idx, totalFrames: frames.length,
                imageBase64: result.imageBase64, label: frame.label,
              });
            }
          } catch (err: any) {
            results.push({
              type: 'canvas_error', canvasId,
              frameId: frame.frameId,
              error: `Failed to generate ${frame.label}: ${err.message}`,
            });
          }
        });

        await Promise.all(promises);

        // Yield all results from this batch (sorted by frameIndex for deterministic order)
        results.sort((a, b) => (a.frameIndex ?? 0) - (b.frameIndex ?? 0));
        for (const chunk of results) {
          yield chunk;
        }
      }

      yield { type: 'canvas_batch_complete', canvasId, totalFrames: frames.length };
    } catch (err: any) {
      yield { type: 'canvas_error', canvasId, error: err.message };
    }
  }

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

  /**
   * Build a unified design brief for all frames in a layout.
   * One AI call produces per-frame generation prompts that share a consistent visual theme.
   */
  private async _buildBatchDesignBrief(
    frames: Array<{ label: string; width?: number; height?: number; description?: string; metadata?: Record<string, string> }>,
    providerManager: ProviderManagerLike,
    settings: Settings,
    projectContext?: string,
    regionImageBase64?: string,
    regionObjects?: CanvasObjectSummary[]
  ): Promise<Array<{ prompt: string; background: 'transparent' | 'opaque' | 'auto'; mediaType: 'image' | 'video' }>> {
    const frameList = frames.map((f, i) => {
      const w = Math.round(f.width || 0);
      const h = Math.round(f.height || 0);
      const orient = w > h ? 'landscape' : w < h ? 'portrait' : 'square';
      const guide = this._computeCompositionGuide(w, h, f.metadata?.role, f.metadata?.componentType);
      return `${i + 1}. "${f.label}" (${w}x${h}px, ${orient}) — ${f.description || 'No description'} [role: ${f.metadata?.role || 'unknown'}, type: ${f.metadata?.componentType || 'unknown'}]\n   COMPOSITION: ${guide.compositionInstruction}`;
    }).join('\n');

    const hasReference = !!regionImageBase64;

    // Extract annotations from canvas objects
    const { annotations } = regionObjects
      ? this._extractCanvasAnnotations(regionObjects)
      : { annotations: [] as string[] };
    const annotationsBlock = annotations.length > 0
      ? `\nUSER'S CANVAS ANNOTATIONS (treat as design directives):\n${annotations.map(a => `- "${a}"`).join('\n')}`
      : '';

    const systemPrompt = `You are a UI design director creating a unified visual design brief for a multi-frame layout.

Project context: ${projectContext || 'General web project'}${annotationsBlock}${hasReference ? `\n\nCRITICAL — CANVAS SCREENSHOT ATTACHED:
Analyze the screenshot and extract exact hex colors, visual style, typography, and layout patterns. Your design brief MUST use these EXACT colors and styles. Do NOT invent a new palette — match what exists on the canvas.
A reference image will ALSO be sent directly to each frame's image generation API call. Every prompt MUST instruct the model to closely follow the reference image's visual style.
${annotations.length > 0 ? 'The user has written annotations on the canvas — treat these as binding design requirements.' : ''}` : ''}

The layout has ${frames.length} frames:
${frameList}

Generate a JSON array with exactly ${frames.length} entries (one per frame, in the same order). Each entry has:
- "prompt": A detailed image generation prompt for this frame. Include the shared color palette, typography style, and visual theme in EVERY prompt so each frame is visually consistent. Be specific about layout, colors (#hex), content, and style. The prompt should describe what the rendered UI component looks like as a flat design mockup.
- "background": "opaque" for full section backgrounds and heroes, "transparent" for icons/logos/overlays, "auto" otherwise.
- "mediaType": "video" ONLY if the frame explicitly suits motion (hero animations, background videos, animated carousels). Default to "image" for everything else.

CRITICAL COMPOSITION & GRID RULES:
- Each frame includes a COMPOSITION note with: the API output size, a 4x4 GRID target (columns A-D, rows 1-4), and crop severity.
- The generated image is divided into a 4x4 grid. Each frame specifies which grid cells should contain content (e.g., "cells A1-D1" = top row only).
- For SEVERE CROP frames: Place ALL meaningful content ONLY within the specified grid cells. Fill ALL other cells with a solid background color matching the palette. Do NOT compose a full scene — cells outside the target will be cropped away entirely.
- For mild/no crop frames: Center content within the target grid cells. Content may extend to adjacent cells.
- Use explicit spatial placement: "logo at top-left of target cells", "nav links spread horizontally across target row", "sidebar items stacked vertically in target column".

The prompts MUST all reference the same:
- Color palette (specify 3-5 exact hex colors)
- Typography style (modern/classic/minimal etc.)
- Visual treatment (flat/gradient/glassmorphism/etc.)
- Overall mood (professional/playful/elegant/etc.)

Return ONLY the JSON array, no markdown, no explanation.`;

    let aiResponse = '';
    const attachments: Attachment[] = [];
    if (regionImageBase64) {
      attachments.push({
        id: `batch-brief-region-${Date.now()}`,
        type: 'image',
        fileName: 'canvas-snapshot.png',
        base64Data: regionImageBase64,
        size: regionImageBase64.length,
        mimeType: 'image/png',
      });
    }
    const stream = providerManager.sendMessage(systemPrompt, [], settings, null, undefined, undefined, undefined, attachments);
    for await (const chunk of stream) {
      if (chunk.type === 'text' && chunk.content) {
        aiResponse += chunk.content;
      }
    }

    const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error('AI did not return a valid design brief.');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('AI returned an empty design brief.');
    }

    // Validate and pad/trim to match frame count
    return frames.map((_, i) => {
      const entry = parsed[i] || parsed[parsed.length - 1];
      return {
        prompt: String(entry.prompt || `Generate a UI component for: ${frames[i].label}`),
        background: (['transparent', 'opaque', 'auto'].includes(entry.background) ? entry.background : 'auto') as 'transparent' | 'opaque' | 'auto',
        mediaType: (entry.mediaType === 'video' ? 'video' : 'image') as 'image' | 'video',
      };
    });
  }

  /**
   * Enhance the user's layout request using AI — similar to _buildSmartPrompt for images.
   * Adds project specificity, visual style hints, and component naming guidance.
   */
  private async _buildLayoutPrompt(
    userPrompt: string,
    level: 'page' | 'section' | 'component',
    providerManager: ProviderManagerLike,
    settings: Settings,
    context: {
      frameBounds?: { left: number; top: number; width: number; height: number };
      regionImageBase64?: string;
      projectContext?: string;
      selectionDescription?: string;
      regionObjects?: CanvasObjectSummary[];
    }
  ): Promise<string> {
    const bounds = context.frameBounds;
    const dimInfo = bounds ? `${Math.round(bounds.width)}x${Math.round(bounds.height)}px` : 'no selection';
    const projectLine = context.projectContext ? `Project: ${context.projectContext}` : '';
    const hasReference = !!context.regionImageBase64;

    // Extract annotations from canvas objects
    const { annotations, elements } = context.regionObjects
      ? this._extractCanvasAnnotations(context.regionObjects)
      : { annotations: [] as string[], elements: [] as string[] };
    const annotationsBlock = annotations.length > 0
      ? `USER'S CANVAS ANNOTATIONS (design directives):\n${annotations.map(a => `- "${a}"`).join('\n')}`
      : '';
    const elementsBlock = elements.length > 0
      ? `Existing content nearby:\n${elements.join('\n')}`
      : (context.selectionDescription ? `Existing content nearby: ${context.selectionDescription}` : '');

    const systemPrompt = `You are a prompt engineer for UI layout generation. Given the user's request and project context, produce an enhanced layout description.

Layout level: ${level}
Target area: ${dimInfo}
${projectLine}
${annotationsBlock}
${elementsBlock}
${hasReference ? 'A screenshot of the current canvas area is attached — analyze its colors, style, and layout to inform your response.' : ''}

User request: ${userPrompt || `Generate a typical ${level} layout`}

Produce a single enhanced prompt that:
- Is specific to the project (use real feature names, not generic placeholders)
- Describes the visual style and theme that matches the project${hasReference ? ' and the attached reference image' : ''}
- Names specific sections/components appropriate for this type of project
${annotations.length > 0 ? '- Incorporates the user\'s canvas annotations as layout requirements' : ''}
- For page: describes all major sections from top to bottom
- For section: describes all components within the section
- For component: describes the component in detail

Return ONLY the enhanced prompt text, no JSON, no explanation.`;

    const attachments: Attachment[] = [];
    if (context.regionImageBase64) {
      attachments.push({
        id: `layout-prompt-region-${Date.now()}`,
        type: 'image',
        fileName: 'canvas-area.png',
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

    const trimmed = aiResponse.trim();
    return trimmed || userPrompt || `Generate a typical ${level} layout`;
  }

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
    projectContext?: string
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

    const genStream = codeGenService.generateComponent({
      svgMarkup: svgMarkup || undefined,
      imageBase64: imageBase64 || undefined,
      componentName,
      framework,
      description: frameMetadata?.description || frameLabel,
      metadata: frameMetadata,
      projectContext,
      imageService,
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
    if (trimmed.startsWith('/generate')) {
      const arg = trimmed.slice('/generate'.length).trim();
      return { action: 'generate', argument: arg };
    }
    if (trimmed.startsWith('/reimagine')) {
      const arg = trimmed.slice('/reimagine'.length).trim();
      return { action: 'reimagine', argument: arg };
    }
    if (trimmed.startsWith('/video')) {
      const arg = trimmed.slice('/video'.length).trim();
      return { action: 'video', argument: arg };
    }
    if (trimmed.startsWith('/page')) {
      const arg = trimmed.slice('/page'.length).trim();
      return { action: 'page', argument: arg };
    }
    if (trimmed.startsWith('/section')) {
      const arg = trimmed.slice('/section'.length).trim();
      return { action: 'section', argument: arg };
    }
    if (trimmed.startsWith('/component')) {
      const arg = trimmed.slice('/component'.length).trim();
      return { action: 'component', argument: arg };
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
  // Helpers
  // ========================================================================

  private _getWorkspaceRoot(): string | null {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
  }
}
