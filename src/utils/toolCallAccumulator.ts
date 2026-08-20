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
 * Streaming tool_call accumulator (Plan 19 Phase 4). OpenAI-style streaming
 * delivers each tool call as a series of deltas keyed by `index`: the `id` and
 * `function.name` arrive in an early fragment, then `function.arguments`
 * streams in pieces to be concatenated. Both the OpenRouter and DeepMyst
 * gateway SSE parsers feed their `choices[0].delta.tool_calls` deltas here and
 * `finalize()` once the turn ends.
 */

export interface AccumulatedToolCall {
  id: string;
  name: string;
  /** Raw (concatenated) JSON arguments string — parse with parseToolArgs. */
  arguments: string;
}

export interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export class ToolCallAccumulator {
  private readonly _byIndex = new Map<number, { id: string; name: string; args: string }>();

  add(deltas: ToolCallDelta[] | undefined): void {
    if (!Array.isArray(deltas)) { return; }
    for (const d of deltas) {
      const idx = typeof d.index === 'number' ? d.index : 0;
      const cur = this._byIndex.get(idx) ?? { id: '', name: '', args: '' };
      if (d.id) { cur.id = d.id; }
      if (d.function?.name) { cur.name = d.function.name; }
      if (typeof d.function?.arguments === 'string') { cur.args += d.function.arguments; }
      this._byIndex.set(idx, cur);
    }
  }

  hasAny(): boolean { return this._byIndex.size > 0; }

  /** Final tool calls in index order (a synthetic id is minted if the stream omitted one). */
  finalize(): AccumulatedToolCall[] {
    return [...this._byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, v]) => ({ id: v.id || `call_${idx}`, name: v.name, arguments: v.args }))
      .filter(c => c.name); // drop malformed (no function name)
  }
}

/**
 * Why a tool call's arguments could not be used (Plan 20 §3.3 "two encodings").
 *
 * `truncated` is the load-bearing one. The coordinator caps generation at
 * `maxTokens` and BOTH length-continuation branches are explicitly skipped on a
 * tool-call turn, so a call cut mid-JSON used to be indistinguishable from a
 * call with no arguments — and the model was told "reissue with corrected
 * arguments" when the truth was "your call was cut off". Told the truth, it can
 * shrink the payload (or move a whole artboard onto the `<canvaspage:NONCE>`
 * text directive, which reassembles across a length cut) instead of re-emitting
 * the same oversized call until its turn budget is gone.
 */
export type ToolArgsStatus =
  /** Parsed to a JSON object — `args` is usable. */
  | 'ok'
  /** No arguments were streamed at all (a genuinely nullary call). */
  | 'empty'
  /** A well-formed but INCOMPLETE JSON prefix — the stream was cut. */
  | 'truncated'
  /** Not a JSON prefix at any length — the model emitted something else. */
  | 'malformed'
  /** Valid JSON, but an array/string/number rather than an argument object. */
  | 'not-an-object';

export interface ParsedToolArgs {
  /** The parsed arguments — ALWAYS `{}` unless `status === 'ok'`. */
  args: Record<string, unknown>;
  /** Shorthand for `status === 'truncated'`. */
  truncated: boolean;
  status: ToolArgsStatus;
}

/**
 * Parse a tool_call's accumulated JSON arguments and say WHY it failed.
 *
 * A partially-recovered argument object is deliberately NOT returned: half a
 * `write` or half a `bash` is far more dangerous than no call at all, so a
 * truncated payload yields `{}` and the caller reports the truncation instead
 * of dispatching.
 */
export function parseToolArgsChecked(argsJson: string): ParsedToolArgs {
  if (!argsJson || !argsJson.trim()) { return { args: {}, truncated: false, status: 'empty' }; }
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown>, truncated: false, status: 'ok' };
    }
    return { args: {}, truncated: false, status: 'not-an-object' };
  } catch {
    const incomplete = scanJsonPrefix(argsJson) === 'incomplete';
    return { args: {}, truncated: incomplete, status: incomplete ? 'truncated' : 'malformed' };
  }
}

/** Safely parse a tool_call's accumulated JSON arguments; {} on any error. */
export function parseToolArgs(argsJson: string): Record<string, unknown> {
  return parseToolArgsChecked(argsJson).args;
}

/* ────────────────────────── JSON prefix scanner ──────────────────────────── */

/**
 * `valid` — the text is a complete JSON document with nothing trailing.
 * `incomplete` — the text is a valid PREFIX of a JSON document that ran out of
 *   input mid-value (an unterminated string, an unclosed object/array, a
 *   dangling `\` or `\u00`, a `"key":` with no value yet). This is what a
 *   token-limit cut through a well-formed emission always looks like.
 * `invalid` — a syntax error occurs at some point, so no amount of additional
 *   text could have made it parse (`{bad`, `{"a":1,}`, `{"a":1} trailing`).
 */
type JsonScan = 'valid' | 'incomplete' | 'invalid';

/** Nesting deeper than this is treated as malformed — a scan is never a DoS. */
const JSON_MAX_DEPTH = 100;

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const HEX = /^[0-9a-fA-F]$/;
const ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

/**
 * Single-pass, recursion-bounded JSON scanner that separates "cut off" from
 * "never was JSON". Deliberately strict (no trailing commas, no comments, no
 * NaN) so it agrees with `JSON.parse` on what `valid` means.
 */
class JsonPrefixScanner {
  private _i = 0;
  private _depth = 0;

  constructor(private readonly _s: string) {}

  scan(): JsonScan {
    const r = this._value();
    if (r !== 'valid') { return r; }
    this._ws();
    return this._i < this._s.length ? 'invalid' : 'valid';
  }

  private _eof(): boolean { return this._i >= this._s.length; }

  private _ws(): void {
    while (!this._eof() && WHITESPACE.has(this._s[this._i])) { this._i++; }
  }

  private _value(): JsonScan {
    this._ws();
    if (this._eof()) { return 'incomplete'; }
    const c = this._s[this._i];
    if (c === '{') { return this._container('}'); }
    if (c === '[') { return this._container(']'); }
    if (c === '"') { return this._string(); }
    if (c === '-' || (c >= '0' && c <= '9')) { return this._number(); }
    if (c === 't') { return this._literal('true'); }
    if (c === 'f') { return this._literal('false'); }
    if (c === 'n') { return this._literal('null'); }
    return 'invalid';
  }

  private _literal(word: string): JsonScan {
    for (let k = 0; k < word.length; k++) {
      if (this._i + k >= this._s.length) { return 'incomplete'; }
      if (this._s[this._i + k] !== word[k]) { return 'invalid'; }
    }
    this._i += word.length;
    return 'valid';
  }

  private _string(): JsonScan {
    this._i++;                                     // opening quote
    for (;;) {
      if (this._eof()) { return 'incomplete'; }
      const c = this._s[this._i];
      if (c === '"') { this._i++; return 'valid'; }
      if (c === '\\') {
        this._i++;
        if (this._eof()) { return 'incomplete'; }   // stream cut on the escape
        const e = this._s[this._i];
        if (!ESCAPES.has(e)) { return 'invalid'; }
        this._i++;
        if (e === 'u') {
          for (let k = 0; k < 4; k++) {
            if (this._eof()) { return 'incomplete'; }
            if (!HEX.test(this._s[this._i])) { return 'invalid'; }
            this._i++;
          }
        }
        continue;
      }
      if (c < ' ') { return 'invalid'; }            // raw control char
      this._i++;
    }
  }

  private _digits(): number {
    const start = this._i;
    while (!this._eof() && this._s[this._i] >= '0' && this._s[this._i] <= '9') { this._i++; }
    return this._i - start;
  }

  private _number(): JsonScan {
    if (this._s[this._i] === '-') {
      this._i++;
      if (this._eof()) { return 'incomplete'; }
    }
    if (this._s[this._i] === '0') { this._i++; } else if (this._digits() === 0) { return 'invalid'; }
    if (this._eof()) { return 'valid'; }            // a complete number so far
    if (this._s[this._i] === '.') {
      this._i++;
      if (this._eof()) { return 'incomplete'; }
      if (this._digits() === 0) { return 'invalid'; }
      if (this._eof()) { return 'valid'; }
    }
    if (this._s[this._i] === 'e' || this._s[this._i] === 'E') {
      this._i++;
      if (this._eof()) { return 'incomplete'; }
      if (this._s[this._i] === '+' || this._s[this._i] === '-') {
        this._i++;
        if (this._eof()) { return 'incomplete'; }
      }
      if (this._digits() === 0) { return 'invalid'; }
    }
    return 'valid';
  }

  /** Objects and arrays differ only in whether each element carries a `"key":`. */
  private _container(close: '}' | ']'): JsonScan {
    if (++this._depth > JSON_MAX_DEPTH) { return 'invalid'; }
    this._i++;                                     // opening brace/bracket
    let atStart = true;
    for (;;) {
      this._ws();
      if (this._eof()) { return 'incomplete'; }
      if (this._s[this._i] === close) {
        if (!atStart) {
          // Only reachable straight after a `,` — a trailing comma is not JSON.
          return 'invalid';
        }
        this._i++;
        this._depth--;
        return 'valid';
      }
      if (close === '}') {
        if (this._s[this._i] !== '"') { return 'invalid'; }
        const key = this._string();
        if (key !== 'valid') { return key; }
        this._ws();
        if (this._eof()) { return 'incomplete'; }
        if (this._s[this._i] !== ':') { return 'invalid'; }
        this._i++;
      }
      const v = this._value();
      if (v !== 'valid') { return v; }
      this._ws();
      if (this._eof()) { return 'incomplete'; }
      if (this._s[this._i] === close) { this._i++; this._depth--; return 'valid'; }
      if (this._s[this._i] !== ',') { return 'invalid'; }
      this._i++;
      atStart = false;
    }
  }
}

function scanJsonPrefix(text: string): JsonScan {
  return new JsonPrefixScanner(text).scan();
}
