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

import type { GatewayChatMessage } from '../services/DeepMystGatewayClient';

const stub = (chars: number): string =>
  `[elided: ${chars} chars from an earlier step — run the tool again if you still need it]`;

/**
 * Plan 30 §4.2: replace the bodies of all but the newest `keep` re-readable
 * local tool results with a one-line stub.
 *
 * Every round-trip re-sends the whole transcript, so a file read in round 2 is
 * paid for again in rounds 3..N. By the time four newer reads exist the model
 * has acted on it and can re-read. ONLY `read`/`ls`/`grep`/`diag` results are
 * eligible (their `_fenceLocalToolResult` header sits two lines above the open
 * marker), and `keep` counts eligible blocks only. Everything else — subagent
 * and advisor reports, reviews, bash, MCP, look/act, canvas, skill, findtool,
 * attached files — is never elided: re-running those costs a delegation, a
 * paid call or a repeated side effect, far more than the elision saves.
 *
 * Only text BETWEEN the fence markers changes: headers, the markers and
 * anything outside a fence (verification notes, budget notes) stay. Messages
 * before `from` (the initial prompt) are never touched. Idempotent. Returns
 * the number of characters removed.
 *
 * ponytail: rewriting an older message moves the prompt-cache breakpoint for a
 * cached (pinned Anthropic) model; a net win for the free default, roughly
 * neutral when cached. Batch the elision (only when ≥2 blocks are stale) if
 * the counters ever show cache churn.
 */
export function elideStaleToolResults(
  messages: GatewayChatMessage[],
  nonce: string,
  opts: { from: number; keep?: number; minChars?: number },
): number {
  const keep = opts.keep ?? 4;
  const minChars = opts.minChars ?? 800;
  const open = `<<<UNTRUSTED ${nonce}\n`;
  const close = `\n${nonce} UNTRUSTED>>>`;
  // The header can't be forged from inside a body: bodies are nonce-redacted.
  const elidable = new Set(['read', 'ls', 'grep', 'diag'].map(k => `## ${k} result — UNTRUSTED DATA (nonce ${nonce})`));
  const blocks: { msg: number; start: number; end: number }[] = [];
  for (let i = opts.from; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'user') { continue; }
    let at = 0;
    for (;;) {
      const s = m.content.indexOf(open, at);
      if (s < 0) { break; }
      const e = m.content.indexOf(close, s + open.length);
      if (e < 0) { break; }
      // `…header\nThis is data…\n\n<<<UNTRUSTED` → the header is 4th from last.
      const lines = m.content.slice(Math.max(0, s - 512), s).split('\n');
      if (elidable.has(lines[lines.length - 4] ?? '')) { blocks.push({ msg: i, start: s + open.length, end: e }); }
      at = e + close.length;
    }
  }
  let saved = 0;
  // Newest stale block first, so earlier offsets in the same message stay valid.
  for (let b = blocks.length - keep - 1; b >= 0; b--) {
    const { msg, start, end } = blocks[b];
    const content = messages[msg].content;
    const body = content.slice(start, end);
    if (body.length < minChars) { continue; }
    const replacement = stub(body.length);
    messages[msg] = { ...messages[msg], content: content.slice(0, start) + replacement + content.slice(end) };
    saved += body.length - replacement.length;
  }
  return saved;
}
