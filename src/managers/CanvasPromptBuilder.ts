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

import { buildArtifactIndex } from './CanvasToolDispatch';
import {
  CANVAS_PIN_RULE,
  CANVAS_PROMPT_EXAMPLES,
  offeredCanvasTools,
  type CanvasPromptExample,
} from '../canvas/CanvasToolSurface';
import { buildFormatPersona } from './CanvasFormats';
import { CanvasCapabilityRegistry } from './CanvasCapabilityRegistry';
import type { CanvasApprovalMode } from './CanvasOpExecutor';
import type { CanvasArtifact } from '../types';

/**
 * Assembles the **stateful canvas block** injected into the designing agent's
 * system prompt. The persona and skill (loaded separately by AgentLoader) carry
 * the designer's character; this block carries the live, per-turn state the
 * agent needs: the artifact index, the active format's layout guidance, the
 * read-before-write rules, the tool surface, the pin rule, the approval mode,
 * and which generation capabilities are connected.
 *
 * Plan 22 Phase 4: the tool guide and the worked examples are GENERATED from
 * `src/canvas/CanvasToolSurface.ts` — the same catalog `dispatchCanvasTool`
 * switches on. That is not tidiness. The bug this replaces was a single worked
 * example teaching `scaffold_page` as a fenced op kind the parser rejected,
 * with the rejection surfacing only as a `console.warn`; a generated guide plus
 * the conformance test that round-trips every rendered example through the real
 * parser and dispatcher makes that class of drift impossible to ship.
 */

export interface CanvasPromptOptions {
  artifact: CanvasArtifact;
  approvalMode: CanvasApprovalMode;
  /** When provided, gates generation guidance to the connected capabilities. */
  registry?: CanvasCapabilityRegistry;
  /** Include the READ-ONLY/WRITE tool list (default true). */
  includeToolGuide?: boolean;
  /**
   * Include the worked call examples (default true). The conformance test
   * parses them back out of the rendered block, so they are load-bearing.
   */
  includeExamples?: boolean;
  /**
   * The run nonce the coordinator's tag scanner is armed with. When present the
   * examples render as real `<canvas:NONCE …>` directives the model can copy;
   * otherwise they render with the `NONCE` placeholder, which is what the
   * MCP/CLI lanes want (they call the tools by name).
   */
  nonce?: string;
}

/** The tool list, grouped by access, generated from the catalog. */
export function buildCanvasToolGuide(): string {
  const offered = offeredCanvasTools();
  const reads = offered.filter(t => t.access === 'read-only').map(t => t.name);
  const writes = offered.filter(t => t.access === 'write').map(t => t.name);
  return [
    `READ-ONLY tools: ${reads.join(', ')}.`,
    `WRITE tools: ${writes.join(', ')}.`,
    'Element ops (`set_text`, `set_style`, `set_prop`, `insert_element`, `remove_element`, `move_element`, `replace_element`) '
    + 'are the SAME ops the human performs by clicking — prefer them over rewriting an artboard, so untouched elements keep '
    + 'their identity and the user\'s own edits survive. Reserve `write_page` for a new screen or a genuine restructure.',
  ].join('\n');
}

/** One worked example, rendered as the directive the model actually emits. */
export function renderCanvasExample(ex: CanvasPromptExample, nonce = 'NONCE'): string {
  if (ex.encoding === 'canvaspage') {
    const { jsx, pageId, actionTitle } = ex.args as { jsx?: string; pageId?: string; actionTitle?: string };
    const attrs = [
      pageId ? ` page="${pageId}"` : '',
      actionTitle ? ` title="${actionTitle}"` : '',
    ].join('');
    return `<canvaspage:${nonce}${attrs}>${String(jsx ?? '')}</canvaspage>   // ${ex.note}`;
  }
  return `<canvas:${nonce} tool="${ex.tool}">${JSON.stringify(ex.args)}</canvas>   // ${ex.note}`;
}

/** All worked examples, in prompt order. */
export function buildCanvasExamples(nonce = 'NONCE'): string {
  return CANVAS_PROMPT_EXAMPLES.map(ex => renderCanvasExample(ex, nonce)).join('\n');
}

export function buildCanvasContextBlock(opts: CanvasPromptOptions): string {
  const { artifact, approvalMode, registry, includeToolGuide = true, includeExamples = true, nonce } = opts;
  const parts: string[] = [];

  parts.push('## Canvas state');
  parts.push(buildArtifactIndex(artifact));
  parts.push('');
  parts.push(`Layout guidance — ${buildFormatPersona(artifact.format)}`);
  parts.push('');

  parts.push('Editing rules:');
  parts.push('- Call `get_page_jsx` (and `get_artifact_index`) before editing; pass the returned version back as `baseVersion` so you never clobber a human edit.');
  parts.push('- Address elements by the `mid="…"` the read handed you. Keep the mids you were given; omit `mid` only on genuinely new elements.');
  parts.push('- Change one element with `set_text` / `set_style` / `set_prop`, not by rewriting the artboard. A rewrite only survives what the diff can match.');
  parts.push(`- ${CANVAS_PIN_RULE}`);
  parts.push('- Never describe an edit in past tense unless a WRITE tool actually ran this turn — check the receipt: `ok` means the document changed, and `dropped` lists what did not.');
  parts.push('- After writing or changing a page, run `validate_page` and fix issues before declaring it done.');
  parts.push('- Use theme tokens, not raw hex (`set_theme_token` for one token, `set_theme` for a whole preset); use `page_coordinates` for placement; one focal point per page.');

  parts.push('');
  parts.push(
    approvalMode === 'auto'
      ? 'Approval mode: AUTO — your edits apply immediately (audited). Work confidently; the user can undo.'
      : 'Approval mode: STAGED — your edits appear as suggestions the user accepts or rejects. Propose freely; nothing lands until accepted.',
  );

  if (includeToolGuide) {
    parts.push('');
    parts.push(buildCanvasToolGuide());
  }

  if (includeExamples) {
    parts.push('');
    parts.push('Worked calls (copy these shapes exactly):');
    parts.push(buildCanvasExamples(nonce));
  }

  if (registry) {
    const enabled = registry.availableCommands();
    const disabled = registry.disabledSlugs();
    parts.push('');
    parts.push(
      enabled.length
        ? `Generation capabilities available: ${enabled.join(', ')}.`
        : 'No generation capabilities are connected — hand-author pages with the artifact tools.',
    );
    if (disabled.length) {
      parts.push(`Not connected (ask the user to connect via DeepMyst if needed): ${disabled.join(', ')}.`);
    }
  }

  return parts.join('\n');
}
