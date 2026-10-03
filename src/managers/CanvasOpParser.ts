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

import type { CanvasOpKind } from '../types';

/** A canvas op parsed from a fenced block (runId/author stamped by caller). */
export interface ParsedCanvasOp {
  kind: CanvasOpKind;
  targetPageId?: string;
  baseVersion?: number;
  proposedValue: unknown;
}

export type CanvasOpParseResult =
  | { ok: true; op: ParsedCanvasOp; raw: string }
  | { ok: false; error: string; raw: string };

const VALID_KINDS: ReadonlySet<string> = new Set<CanvasOpKind>([
  'insert_page',
  'edit_page',
  'delete_page',
  'reorder',
  'set_theme',
  'set_format',
  'edit_element',
  'add_asset',
]);

/** Opening fence: ```canvas-op (optional trailing spaces) then a newline. */
const OPEN_FENCE = /```canvas-op[ \t]*\r?\n/;
/** Longest incomplete opening marker we must retain across chunk boundaries. */
const MAX_TAIL = 32;

/**
 * Fallback transport for providers without workable MCP support (Plan 05
 * Phase 2.4). The system prompt instructs the agent to emit ` ```canvas-op `
 * fenced JSON; this stateful parser pulls complete blocks out of a streamed
 * text feed (tolerant of fences split across chunks) and turns them into op
 * submissions. Malformed blocks surface as `{ ok: false }` so the caller can
 * emit a visible `op_error` rather than silently dropping the edit.
 *
 * It mirrors the existing stream-marker scanning seam in ChatViewProvider;
 * feed it the same incremental text the marker/visual-test regexes see.
 */
export class CanvasOpParser {
  private _buffer = '';

  /** Discard any buffered partial block (call on turn end / cancel). */
  reset(): void {
    this._buffer = '';
  }

  /**
   * Append a streamed text chunk and return every newly-completed op block.
   * Returns an empty array when no block closed in this chunk.
   */
  push(chunk: string): CanvasOpParseResult[] {
    this._buffer += chunk;
    const results: CanvasOpParseResult[] = [];

    for (;;) {
      const open = this._buffer.match(OPEN_FENCE);
      if (!open || open.index === undefined) {
        // No open fence: keep only a short tail in case a marker is mid-arrival.
        if (this._buffer.length > MAX_TAIL) {
          this._buffer = this._buffer.slice(-MAX_TAIL);
        }
        break;
      }

      const bodyStart = open.index + open[0].length;
      const close = this._buffer.indexOf('```', bodyStart);
      if (close === -1) {
        // Block still streaming — retain from the opening fence onward.
        this._buffer = this._buffer.slice(open.index);
        break;
      }

      const body = this._buffer.slice(bodyStart, close).trim();
      const raw = this._buffer.slice(open.index, close + 3);
      this._buffer = this._buffer.slice(close + 3);
      results.push(this._parseBody(body, raw));
    }

    return results;
  }

  private _parseBody(body: string, raw: string): CanvasOpParseResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      return { ok: false, error: `invalid JSON in canvas-op block: ${err instanceof Error ? err.message : String(err)}`, raw };
    }
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, error: 'canvas-op block must be a JSON object', raw };
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.kind !== 'string' || !VALID_KINDS.has(obj.kind)) {
      return { ok: false, error: `unknown canvas-op kind: ${String(obj.kind)}`, raw };
    }
    if (!('proposedValue' in obj)) {
      return { ok: false, error: 'canvas-op block requires a proposedValue', raw };
    }
    const op: ParsedCanvasOp = {
      kind: obj.kind as CanvasOpKind,
      proposedValue: obj.proposedValue,
    };
    if (typeof obj.targetPageId === 'string') { op.targetPageId = obj.targetPageId; }
    if (typeof obj.baseVersion === 'number') { op.baseVersion = obj.baseVersion; }
    return { ok: true, op, raw };
  }
}
