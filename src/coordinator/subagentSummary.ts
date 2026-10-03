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

import { clampHeadTail } from './promptBudget';

/**
 * Plan 30 §2 summary contract. A subagent's whole transcript stays on its tool
 * card; the coordinator — whose context is re-sent every round-trip — gets only
 * the report at the end.
 */
export const SUBAGENT_SUMMARY_CHARS = 6_000;

export const SUMMARY_INSTRUCTIONS = [
  '',
  '',
  '## When you finish',
  'End with a report in EXACTLY this shape (under ~1,000 words). It is the ONLY part of your work the requester sees:',
  '## Result',
  '## Evidence — file:line references for every claim',
  '## Changes — files you changed, or "none"',
  '## Open questions',
].join('\n');

export const ADVISOR_INSTRUCTIONS = [
  '',
  '',
  '## Your role: advisor (read-only)',
  'You are advising another AI agent that will do the work. Do NOT edit files or run commands that change anything.',
  'Reply in EXACTLY this shape (under ~800 words):',
  '## Verdict — your judgment in one or two sentences',
  '## Plan — numbered steps the agent should take',
  '## Risks — what could go wrong and how to check for it',
].join('\n');

/**
 * The part of a subagent's output the parent sees: from its LAST `## Result`
 * (or `## Verdict`) heading to the end, capped. Output without the heading is
 * head+tail clamped instead.
 */
export function extractSubagentSummary(text: string, max = SUBAGENT_SUMMARY_CHARS): string {
  const at = Math.max(text.lastIndexOf('## Result'), text.lastIndexOf('## Verdict'));
  const body = (at >= 0 ? text.slice(at) : text).trim();
  return clampHeadTail(body, Math.floor((max * 2) / 3), Math.floor(max / 3), 'clamped — the full output is on the tool card');
}
