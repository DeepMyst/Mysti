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
  serverName?: string;
  version?: string;
}

export class CanvasToolServer {
  private _server: Server;
  private _resolveContext: () => CanvasToolContext | null;
  private _renderPagePreview?: RenderPagePreviewHook;

  constructor(opts: CanvasToolServerOptions) {
    this._resolveContext = opts.resolveContext;
    this._renderPagePreview = opts.renderPagePreview;
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
    this._server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this._renderPagePreview ? [...listMcpTools(), RENDER_PREVIEW_TOOL] : listMcpTools(),
    }));

    this._server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const ctx = this._resolveContext();
      if (!ctx) {
        return { content: [{ type: 'text', text: 'No active canvas to edit. Open the canvas first.' }], isError: true };
      }
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;

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
