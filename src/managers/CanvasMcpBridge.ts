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

import { CANVAS_TOOLS, dispatchCanvasTool } from './CanvasToolDispatch';
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

  let payload: Record<string, unknown>;
  if (result.op !== undefined) {
    const op = result.op;
    payload = op
      ? { ok: true, op: { opId: op.opId, kind: op.kind, status: op.status, targetPageId: op.targetPageId, baseVersion: op.baseVersion } }
      : { ok: false, error: 'op rejected' };
  } else {
    payload = { ok: true, data: result.data };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structured: payload,
  };
}
