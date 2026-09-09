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
 * Plan 27 lane M (§21.6c #9) — every tool-use permission PRODUCER sends the
 * structurally intact `toolInput` (P0#2 / H-1, "you approve edits you cannot
 * see"), not only the CLI stream gate.
 *
 * `tests/integration/chatViewTrustAndGate.test.ts` covers the helper
 * (`_permissionToolDetails`) and the stream-gate consumer. The four other
 * producers — mention collaboration, sub-agent, Mysti delegation, Mysti
 * orchestration — each build their own `requestPermissionInline(...)` call
 * and had no test. This suite is STATIC over ChatViewProvider.ts (the file is
 * not in this lane): it finds every `requestPermissionInline(` call whose
 * title is a "<who> wants to: <tool>" card and asserts the details object
 * spreads `_permissionToolDetails(<the same toolCall>)`.
 *
 * Two properties:
 *  1. the five known producers are present and each spreads the helper;
 *  2. a sixth producer added without the spread fails HERE (whole-file sweep).
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

const SRC = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'src', 'providers', 'ChatViewProvider.ts'), 'utf8'
);

/** Balanced-paren argument text of every `requestPermissionInline(` call in `text`. */
function permissionCalls(text: string): Array<{ index: number; args: string }> {
  const out: Array<{ index: number; args: string }> = [];
  const needle = 'requestPermissionInline(';
  let at = text.indexOf(needle);
  while (at !== -1) {
    let depth = 0;
    let i = at + needle.length - 1;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === '(') { depth++; }
      else if (ch === ')') { depth--; if (depth === 0) { break; } }
    }
    out.push({ index: at, args: text.slice(at + needle.length, i) });
    at = text.indexOf(needle, i);
  }
  return out;
}

/** A tool-use permission card: its title interpolates `wants to: ${...toolCall.name}`. */
function isToolUseCard(args: string): boolean {
  return /wants to: \$\{[^}]*toolCall\.name\}/.test(args);
}

/** Name of the class method enclosing `index` (nearest preceding member signature). */
function enclosingMethod(text: string, index: number): string {
  const head = text.slice(0, index);
  const re = /^ {2}(?:private |public |protected )?(?:static )?(?:async )?(_?[A-Za-z0-9]+)\(/gm;
  let name = '<none>';
  let m: RegExpExecArray | null;
  while ((m = re.exec(head)) !== null) { name = m[1]; }
  return name;
}

/** The `toolCall` expression the card's title names (e.g. `toolCall` or `chunk.toolCall`). */
function toolCallExpr(args: string): string {
  const m = /wants to: \$\{[^}]*?([A-Za-z_.]*toolCall)\.name\}/.exec(args);
  return m ? m[1] : '';
}

/** Assert every tool-use card in `text` spreads the helper over its own toolCall. */
function assertAllProducersSpread(text: string): string[] {
  const producers: string[] = [];
  for (const call of permissionCalls(text)) {
    if (!isToolUseCard(call.args)) { continue; }
    const method = enclosingMethod(text, call.index);
    const expr = toolCallExpr(call.args);
    const spread = `...this._permissionToolDetails(${expr})`;
    if (!call.args.includes(spread)) {
      throw new Error(`${method}: permission card does not spread ${spread}\n${call.args}`);
    }
    producers.push(method);
  }
  return producers;
}

const EXPECTED_PRODUCERS = [
  '_runMentionCollaboration',  // @agent:role collaboration gate (onGate)
  '_gateSubAgentToolUse',      // legacy @agent sub-agent gate
  '_handleSendMessageForTurn', // CLI stream gate (covered elsewhere too)
  '_runMystiDelegation',       // Mysti coordinator delegation (onGate)
  '_runMystiOrchestration',    // Mysti orchestration (onGate)
  '_handleStartSession',       // Plan 29 session lane gate (onGate)
];

describe('tool-use permission producers all send toolInput (static over ChatViewProvider.ts)', () => {
  it('finds the known producers, each spreading _permissionToolDetails over its own toolCall', () => {
    const producers = assertAllProducersSpread(SRC);
    for (const name of EXPECTED_PRODUCERS) {
      expect(producers, `producer ${name} not found as a "wants to:" card`).toContain(name);
    }
  });

  it('every "wants to: <tool>" card in the file spreads the helper (a new producer fails here)', () => {
    const producers = assertAllProducersSpread(SRC);
    // The sweep is the property; the count documents today's surface so a
    // silent sixth producer is noticed even when it happens to comply.
    expect(producers.length).toBe(EXPECTED_PRODUCERS.length);
  });

  it('the checker itself is sensitive: removing one spread makes it throw naming the producer', () => {
    // Mutate a copy of the source: strip the spread from the collaboration site only.
    const marker = '`${spec.label || spec.agentId} wants to: ${toolCall.name}`,\n        { command: preview, riskLevel, ...this._permissionToolDetails(toolCall) },';
    expect(SRC).toContain(marker);
    const mutated = SRC.replace(marker, marker.replace(', ...this._permissionToolDetails(toolCall)', ''));
    expect(mutated).not.toBe(SRC);
    expect(() => assertAllProducersSpread(mutated)).toThrow(/_runMentionCollaboration: permission card does not spread/);
  });

  it('the checker recognises the sub-agent shape (chunk.toolCall) and the stream gate', () => {
    const calls = permissionCalls(SRC).filter(c => isToolUseCard(c.args));
    const exprs = new Set(calls.map(c => toolCallExpr(c.args)));
    expect(exprs).toEqual(new Set(['toolCall', 'chunk.toolCall']));
  });
});
