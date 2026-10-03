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

import { CANVAS_TOOLS, canvasToolPayload, dispatchCanvasTool } from './CanvasToolDispatch';
import type { CanvasToolContext } from './CanvasToolDispatch';

/**
 * The SDK-agnostic core of the `mysti-canvas` MCP server (Plan 05 Phase 2.2 /
 * continuation M2). It maps the {@link CANVAS_TOOLS} contract to MCP `tools/list`
 * descriptors and wraps {@link dispatchCanvasTool} into MCP `tools/call`
 * results. The thin `@modelcontextprotocol/sdk` adapter that lands in M2 only
 * registers two handlers that delegate to {@link listMcpTools} and
 * {@link callMcpTool} — keeping the protocol shape testable without the SDK or a
 * live transport, so the wiring step is near-trivial and de-risked.
 */

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** MCP tool-call result shape (a subset of the SDK's CallToolResult). */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  /** Structured payload mirrored for in-process callers (not part of MCP wire). */
  structured?: unknown;
}

/** MCP `tools/list` — the canvas editing tools, MCP-shaped. */
export function listMcpTools(): McpToolDescriptor[] {
  return CANVAS_TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/**
 * MCP `tools/call` — run a tool against the artifact and shape the response.
 * Errors become `{ isError: true }` with the message; successes serialize the
 * read data, or a compact op summary for writes (so the agent learns the op id,
 * status, and affected page without the full proposed value echoed back).
 */
export function callMcpTool(name: string, args: Record<string, unknown>, ctx: CanvasToolContext): McpToolResult {
  const result = dispatchCanvasTool(name, args, ctx);

  if (!result.ok) {
    return {
      content: [{ type: 'text', text: result.error ?? `tool ${name} failed` }],
      isError: true,
      structured: { ok: false, error: result.error },
    };
  }

  // E2E-3: this lane used to build its own payload, and its `result.op !==
  // undefined` branch discarded `data`, `dropped` and `error` — so a rewrite
  // whose pinned cells the differ refused reached Claude Code (over MCP) as a
  // plain `ok:true, applied`, and the agent's model of the artboard silently
  // diverged from the document. `canvasToolPayload` is the tool contract's own
  // receipt shape — `ok` means the document changed, and `dropped` is how a
  // pinned-cell refusal reaches the model — and it is what the coordinator lane
  // sends too, so the two transports cannot drift.
  const payload = canvasToolPayload(result, ctx.approvalMode);

  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structured: payload,
  };
}
