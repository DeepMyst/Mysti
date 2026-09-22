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

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { listMcpTools, callMcpTool } from '../managers/CanvasMcpBridge';
import type { CanvasToolContext } from '../managers/CanvasToolDispatch';
import type { PreviewIssue } from './CanvasPreviewService';
import type { CanvasMediaService, MediaKind } from './CanvasMediaService';
import type { CanvasMediaOperation } from '../canvas/CanvasMediaOperation';

export interface CanvasMediaRequest {
  readonly requestId: string | number;
  readonly signal: AbortSignal;
}

/** The async render-to-PNG + vision-critique tool (Playwright/vision injected). */
export type RenderPagePreviewHook = (
  args: Record<string, unknown>,
  ctx: CanvasToolContext,
) => Promise<{ issues: PreviewIssue[]; previewBase64?: string; error?: string }>;

const RENDER_PREVIEW_TOOL = {
  name: 'render_page_preview',
  description: 'READ-ONLY (render the page to an image and vision-critique it — returns visual issues to fix). Run before declaring a new page done.',
  inputSchema: {
    type: 'object',
    properties: { pageId: { type: 'string' }, questions: { type: 'array', items: { type: 'string' } } },
    required: ['pageId'],
  },
} as const;

const MEDIA_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string' },
    role: { type: 'string', description: 'hero | background | illustration | icon | photo | decoration' },
    sourcePageId: { type: 'string' },
    width: { type: 'number' },
    height: { type: 'number' },
  },
  required: ['prompt'],
} as const;

const GENERATE_VISUAL_TOOL = {
  name: 'generate_visual',
  description: 'WRITE (stages an edit): generate an image (fal via DeepMyst, or a local key) and register it as a provenance-tracked asset. Returns the asset:// ref to use in a page. Generate with negative space when text will sit on it.',
  inputSchema: MEDIA_TOOL_SCHEMA,
} as const;

const GENERATE_VIDEO_TOOL = {
  name: 'generate_video',
  description: 'WRITE (stages an edit): generate a short video clip (fal via DeepMyst, or a local key) and register it as a provenance-tracked asset. Returns the asset:// ref.',
  inputSchema: MEDIA_TOOL_SCHEMA,
} as const;

/**
 * The `mysti-canvas` MCP server (Plan 05 Phase 2.2 / continuation M3). It wraps
 * the transport-agnostic {@link CanvasMcpBridge} in an actual
 * `@modelcontextprotocol/sdk` Server: `tools/list` returns the artifact-editing
 * tool catalog and `tools/call` routes through {@link callMcpTool}. The handlers
 * resolve the live canvas context (artifact + executor) per call via the
 * injected resolver, so the server runs **in the extension host** (Open Q4) and
 * reaches the in-process `ArtifactStore`/`CanvasOpExecutor` directly.
 *
 * Transport is left to the caller (`connect(transport)`): an in-memory pair for
 * tests, a stdio/HTTP transport for a live CLI session.
 */
export interface CanvasToolServerOptions {
  /** Resolve the current canvas tool context, or null when no canvas is active. */
  resolveContext: () => CanvasToolContext | null;
  /** Optional render-to-PNG + vision self-QA tool; when set, exposes render_page_preview. */
  renderPagePreview?: RenderPagePreviewHook;
  /** Optional media generation; when set, exposes generate_visual/generate_video. */
  mediaService?: CanvasMediaService;
  /** Capture lifetime authority; a synchronous tool context alone cannot authorize async writes. */
  captureMediaOperation?: (ctx: CanvasToolContext, request: CanvasMediaRequest) => CanvasMediaOperation | null;
  serverName?: string;
  version?: string;
}

export class CanvasToolServer {
  private _server: Server;
  private _resolveContext: () => CanvasToolContext | null;
  private _renderPagePreview?: RenderPagePreviewHook;
  private _mediaService?: CanvasMediaService;
  private _captureMediaOperation?: CanvasToolServerOptions['captureMediaOperation'];

  constructor(opts: CanvasToolServerOptions) {
    this._resolveContext = opts.resolveContext;
    this._renderPagePreview = opts.renderPagePreview;
    this._mediaService = opts.mediaService;
    this._captureMediaOperation = opts.captureMediaOperation;
    this._server = new Server(
      { name: opts.serverName ?? 'mysti-canvas', version: opts.version ?? '0.1.0' },
      { capabilities: { tools: {} } },
    );
    this._registerHandlers();
  }

  /** The underlying SDK server (for advanced wiring/tests). */
  get server(): Server {
    return this._server;
  }

  /** Bind a transport (in-memory for tests; stdio/HTTP for a live CLI). */
  async connect(transport: Transport): Promise<void> {
    await this._server.connect(transport);
  }

  async close(): Promise<void> {
    await this._server.close();
  }

  private _registerHandlers(): void {
    this._server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = [...listMcpTools()];
      if (this._renderPagePreview) { tools.push(RENDER_PREVIEW_TOOL); }
      if (this._mediaService) { tools.push(GENERATE_VISUAL_TOOL, GENERATE_VIDEO_TOOL); }
      return { tools };
    });

    this._server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const ctx = this._resolveContext();
      if (!ctx) {
        return { content: [{ type: 'text', text: 'No active canvas to edit. Open the canvas first.' }], isError: true };
      }
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;

      // Media generation (fal via DeepMyst hub / local key) — async, out of band.
      if (req.params.name === 'generate_visual' || req.params.name === 'generate_video') {
        if (!this._mediaService) {
          return { content: [{ type: 'text', text: `${req.params.name} is not available.` }], isError: true };
        }
        const kind: MediaKind = req.params.name === 'generate_video' ? 'video' : 'image';
        const size = typeof args.width === 'number' && typeof args.height === 'number'
          ? { width: args.width as number, height: args.height as number } : undefined;
        const operation = this._captureMediaOperation?.(ctx, { requestId: extra.requestId, signal: extra.signal });
        if (!operation) {
          return { content: [{ type: 'text', text: 'No current Canvas media operation. Reopen the Canvas or start a new request.' }], isError: true };
        }
        const result = await this._mediaService.generate(operation, {
          kind,
          prompt: String(args.prompt ?? ''),
          role: typeof args.role === 'string' ? args.role : undefined,
          sourcePageId: typeof args.sourcePageId === 'string' ? args.sourcePageId : undefined,
          size,
        });
        if (!result.ok) {
          const hint = result.connectHint ? ` <<<MYSTI_CONNECT:${result.connectHint}>>>` : '';
          // An accepted edit whose save needs retry must never look like a
          // cancelled edit with no effects; retain that distinction on MCP.
          return { content: [{ type: 'text', text: result.committed
            ? JSON.stringify(result) : `${result.error}${hint}` }], isError: true };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ ...result,
            asset: { id: result.asset!.id, ref: result.asset!.ref, role: result.asset!.role } }) }],
        };
      }

      // Async self-QA tool, handled out of band from the sync dispatch.
      if (req.params.name === 'render_page_preview') {
        if (!this._renderPagePreview) {
          return { content: [{ type: 'text', text: 'render_page_preview is not available.' }], isError: true };
        }
        const preview = await this._renderPagePreview(args, ctx);
        if (preview.error) {
          return { content: [{ type: 'text', text: preview.error }], isError: true };
        }
        const ok = preview.issues.every(i => i.severity !== 'error');
        return { content: [{ type: 'text', text: JSON.stringify({ ok, issues: preview.issues }) }] };
      }

      const result = callMcpTool(req.params.name, args, ctx);
      return { content: result.content, isError: result.isError ?? false };
    });
  }
}
