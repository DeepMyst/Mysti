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
 *
 * Plan 22 §3.3 — normalizing the coordinator's TWO canvas encodings onto the
 * ONE dispatcher.
 *
 * The split exists for a verified reason, not for taste: the coordinator streams
 * at `maxTokens` 4096, and both length-continuation branches in the agentic loop
 * are explicitly skipped on tool-call turns — so a native `tool_calls` payload
 * physically cannot carry a whole artboard. Structured small ops therefore ride
 * native tool calls, and verbatim page source rides the nonce-fenced
 * `<canvaspage:…>` TEXT directive, where the scanner already reassembles a
 * payload split by a length cut.
 *
 * Both land here, and both come out as `{ tool, args }` for `dispatchCanvasTool`
 * — so there is exactly one write path, and neither encoding is more trusted
 * than the other. Keeping this pure (no vscode, no provider state) is what lets
 * the equivalence be asserted in a test rather than asserted in a comment.
 */

import type { MystiDirective } from '../utils/mystiDelegateParser';
import { normalizeCanvasToolName } from '../services/coordinatorTools';

/** A canvas-bearing coordinator directive, in either encoding. */
export type CanvasDirective = Extract<MystiDirective, { kind: 'canvas' | 'canvaspage' }>;

/** The dispatcher call a directive normalizes to. */
export interface CanvasToolCall {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Why a directive could not be turned into a dispatcher call. Returned rather
 * than thrown so the caller can hand the model an actionable sentence — the
 * failure mode Plan 22 Phase 0 calls out is an edit that dies silently in a
 * `console.warn`, teaching the model nothing.
 */
export interface CanvasDirectiveError {
  error: string;
}

export function isCanvasDirectiveError(v: CanvasToolCall | CanvasDirectiveError): v is CanvasDirectiveError {
  return (v as CanvasDirectiveError).error !== undefined;
}

/**
 * Normalize either encoding onto one `dispatchCanvasTool` call.
 *
 * `<canvaspage:…>` maps to **`write_page_jsx`**, which already means
 * "create-or-replace this page's JSX" (it edits when given a `pageId` and
 * inserts when not). Two reasons it is the right target rather than
 * hand-routing to `insert_page`/`edit_page`:
 *
 *  1. The model does not have to know which it is doing — it just says "here is
 *     this page's source", which is how models actually write.
 *  2. `write_page_jsx` runs the source through `cleanJsx` first. Routing the
 *     text lane anywhere else would let a fenced page bypass the validation the
 *     tool lane gets, which is exactly the "second, less-validated write path"
 *     Plan 22 exists to eliminate.
 */
export function canvasDirectiveToToolCall(d: CanvasDirective): CanvasToolCall | CanvasDirectiveError {
  if (d.kind === 'canvas') {
    // Malformed JSON must be reported AS malformed. Running the tool with `{}`
    // would tell the model its arguments were wrong when the truth is that its
    // payload never parsed — two different fixes.
    if (d.argsError) {
      return { error: `arguments were not valid JSON (${d.argsError}) — re-send this call with valid JSON` };
    }
    // Canonicalize on the TEXT lane too. `normalizeCanvasToolName` used to run
    // only inside `toolCallToDirective` (the native lane), so the always-on
    // text lane could not express the very spelling its own refusal message
    // hands the model: `<canvas:N tool="canvas_open">` was compared to the bare
    // literal `'open'`, missed, and answered "No canvas is open. Call
    // canvas_open first" — a livelock that burned the whole run for any model
    // without native function calling. Both lanes must land on the SAME
    // `{tool}` value or the text lane is a second, differently-addressed
    // surface.
    const tool = normalizeCanvasToolName(d.tool);
    if (!tool) { return { error: 'no tool name given' }; }
    return { tool, args: d.args ?? {} };
  }

  const source = d.source ?? '';
  if (!source.trim()) {
    return { error: 'the page body was empty — send the full `function Page(){…}` source between the tags' };
  }

  const args: Record<string, unknown> = { jsx: source };
  if (d.title) { args.actionTitle = d.title; }
  if (d.pageId) { args.pageId = d.pageId; }
  return { tool: 'write_page_jsx', args };
}
