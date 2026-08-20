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

import type { AccessLevel, OperationMode } from '../types';
import type { CanvasApprovalMode } from '../managers/CanvasOpExecutor';

/**
 * Plan 20 §3.2 item 6 — the single derivation of the canvas approval mode.
 *
 * `CanvasOpExecutor.submit()` defaults to `'staged'`, but all three production
 * call sites pass a hardcoded `'auto'` — including the one feeding
 * `buildCanvasContextBlock`, which then tells the model *"AUTO — your edits
 * apply immediately (audited). Work confidently; the user can undo."* while the
 * user sits in `ask-permission` / `ask-before-edit` (the shipped defaults) and
 * no undo affordance exists. Every transport calls this function instead, so
 * the prompt cannot contradict the chrome and neither can contradict settings.
 *
 * ## Mapping
 *
 * Canvas ops are not workspace writes — they touch `.mysti/canvas/<id>/` only,
 * never a shell and never the user's source — so the question is never "may the
 * agent act?" but "does its edit land, or does it land as a suggestion?".
 *
 * | input | verdict | why |
 * |---|---|---|
 * | `accessLevel: 'read-only'` | `staged` | the one setting that means "change nothing". An absolute floor: autonomous does not lift it. |
 * | `autonomousMode: true` (any other access level) | `auto` | autonomous means "stop interrupting me"; parking every artboard behind an accept is precisely the interruption it removes. |
 * | `accessLevel: 'ask-permission'` | `staged` | the user asked to approve changes; a suggestion card *is* that approval, in-canvas rather than modal. |
 * | `mode: 'ask-before-edit'` | `staged` | same intent, expressed as a mode. |
 * | `mode: 'quick-plan'` \| `'detailed-plan'` | `staged` | plan modes produce proposals, not mutations. A plan pass that silently redesigns the canvas is the bug, not the feature. |
 * | `mode: 'edit-automatically'` \| `'default'` with `accessLevel: 'full-access'` | `auto` | the user has said edits may land. |
 * | anything unrecognized / absent | `staged` | fail closed. |
 *
 * **Most restrictive wins** where mode and access level disagree
 * (`edit-automatically` + `ask-permission` → `staged`), with the single
 * exception of `autonomousMode`, which is an explicit, deliberate escalation
 * and outranks the *mode* half — but never `read-only`.
 *
 * @see plans/20-canvas-document-first.md §3.2, §8 open question 2
 */

/**
 * The slice of {@link import('../types').Settings} this decision needs.
 *
 * Deliberately a plain structural object rather than a `vscode` read: the
 * caller resolves settings (it already has them per-panel) and this stays a
 * pure function that a test can enumerate exhaustively. Every field is optional
 * so a partially-populated settings object degrades to the safe verdict instead
 * of throwing.
 */
export interface CanvasApprovalSettings {
  mode?: OperationMode;
  accessLevel?: AccessLevel;
  autonomousMode?: boolean;
}

/**
 * Resolve whether agent canvas edits apply immediately (`'auto'`) or land as
 * accept/reject suggestions (`'staged'`).
 *
 * Pure. Fails closed on unknown or missing input.
 */
export function resolveCanvasApproval(settings: CanvasApprovalSettings): CanvasApprovalMode {
  const accessLevel = settings?.accessLevel;
  const mode = settings?.mode;

  // 1. `read-only` is an absolute floor. Autonomous raises *capability*, never
  //    authority (Plan 19's "capabilities up, authority unchanged"), so it does
  //    not convert "change nothing" into "change everything unattended".
  if (accessLevel === 'read-only') { return 'staged'; }

  // 2. Autonomous outranks the mode half of the decision below.
  if (settings?.autonomousMode === true) {
    // Only for access levels we actually recognize — an unknown level here is
    // corrupt input, and corrupt input must not be an escalation path.
    if (accessLevel === 'full-access' || accessLevel === 'ask-permission') { return 'auto'; }
    return 'staged';
  }

  // 3. "Ask me" — in either vocabulary — means suggestions.
  if (accessLevel !== 'full-access') { return 'staged'; }

  switch (mode) {
    case 'edit-automatically':
    case 'default':
      return 'auto';
    case 'ask-before-edit':
    case 'quick-plan':
    case 'detailed-plan':
      return 'staged';
    default:
      // Absent or unrecognized mode: fail closed even at `full-access`.
      return 'staged';
  }
}
