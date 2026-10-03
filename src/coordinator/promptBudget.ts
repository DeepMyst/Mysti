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

/**
 * Size budgets for text the coordinator puts in front of a model (Plan 30 §4).
 * Every round-trip re-sends the whole transcript, so an uncapped blob is paid
 * for once per remaining round.
 */

/** Keep `head` chars from the start and `tail` from the end, with a marker between. */
export function clampHeadTail(text: string, head: number, tail: number, note = 'clamped'): string {
  if (text.length <= head + tail) { return text; }
  return `${text.slice(0, head)}\n… [${note} — ${text.length} chars total] …\n${text.slice(-tail)}`;
}

export const ATTACHED_FILE_CHARS = 8_000;
export const ATTACHED_TOTAL_CHARS = 24_000;

/** Fold attached files under a per-file and a total budget; reports what was cut. */
export function capAttachedFiles(
  files: readonly { path: string; content?: string }[],
  perFile = ATTACHED_FILE_CHARS,
  total = ATTACHED_TOTAL_CHARS,
): { files: { path: string; body: string; truncated: boolean }[]; omitted: number } {
  const out: { path: string; body: string; truncated: boolean }[] = [];
  let used = 0;
  let omitted = 0;
  for (const f of files) {
    if (used >= total) { omitted++; continue; }
    const full = f.content || '';
    const body = full.slice(0, Math.min(perFile, total - used));
    used += body.length;
    out.push({ path: f.path, body, truncated: full.length > body.length });
  }
  return { files: out, omitted };
}
