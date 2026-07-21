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

/** Safely parse a tool_call's accumulated JSON arguments; {} on any error. */
export function parseToolArgs(argsJson: string): Record<string, unknown> {
  if (!argsJson || !argsJson.trim()) { return {}; }
  try {
    const o = JSON.parse(argsJson);
    return o && typeof o === 'object' && !Array.isArray(o) ? o as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
