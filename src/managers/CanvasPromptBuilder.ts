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

import { buildArtifactIndex, CANVAS_TOOLS } from './CanvasToolDispatch';
import { buildFormatPersona } from './CanvasFormats';
import { CanvasCapabilityRegistry } from './CanvasCapabilityRegistry';
import type { CanvasApprovalMode } from './CanvasOpExecutor';
import type { CanvasArtifact } from '../types';

/**
 * Assembles the **stateful canvas block** injected into the design sub-agent's
 * system prompt (Plan 05 §2 / §10 / Phase 2.3b / Phase 7.2). The persona and
 * skill (loaded separately by AgentLoader) carry the designer's character; this
 * block carries the live, per-turn state the agent needs: the artifact index,
 * the active format's layout guidance, the read-before-write/no-past-tense
 * rules, the tool surface, the approval mode, and which generation capabilities
 * are connected (or need connecting).
 */

export interface CanvasPromptOptions {
  artifact: CanvasArtifact;
  approvalMode: CanvasApprovalMode;
  /** When provided, gates generation guidance to the connected capabilities. */
  registry?: CanvasCapabilityRegistry;
  /** Include the READ-ONLY/WRITE tool list (default true). */
  includeToolGuide?: boolean;
}

/** The READ-ONLY/WRITE tool list, grouped by access. */
export function buildCanvasToolGuide(): string {
  const reads = CANVAS_TOOLS.filter(t => t.access === 'read-only').map(t => t.name);
  const writes = CANVAS_TOOLS.filter(t => t.access === 'write').map(t => t.name);
  return [
    `READ-ONLY tools: ${reads.join(', ')}.`,
    `WRITE tools (stage edits): ${writes.join(', ')}.`,
  ].join('\n');
}

export function buildCanvasContextBlock(opts: CanvasPromptOptions): string {
  const { artifact, approvalMode, registry, includeToolGuide = true } = opts;
  const parts: string[] = [];

  parts.push('## Canvas state');
  parts.push(buildArtifactIndex(artifact));
  parts.push('');
  parts.push(`Layout guidance — ${buildFormatPersona(artifact.format)}`);
  parts.push('');

  parts.push('Editing rules:');
  parts.push('- Call `read_page` (and `get_artifact_index`) before editing; pass the returned version back as `baseVersion` so you never clobber a human edit.');
  parts.push('- Never describe an edit in past tense unless a WRITE tool actually ran this turn.');
  parts.push('- After writing or changing a page, run `validate_page` (and `render_page_preview` when available) and fix issues before declaring it done.');
  parts.push('- Use theme tokens, not raw hex; use `page_coordinates` for placement; one focal point per page.');

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
