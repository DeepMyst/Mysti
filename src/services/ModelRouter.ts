/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://deepmyst.com
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * ModelRouter (Plan 24 Phase 2) — suggests a delegation tier and effort for
 * UN-tiered delegations when Boost mode is on. It deliberately does NOT pick
 * models: suggestions feed the existing `_resolveTierModel` → `spec.model` →
 * `routedModel` path, which already honors backend capabilities
 * (`modelSelection === 'none'` backends ignore routing) and the custom-model
 * precedence contract (types.ts routedModel doc).
 *
 * Routing rules are asymmetric on purpose (Plan 24: "route effort down by
 * default, up eagerly"):
 *  - Security/review/perimeter-shaped tasks are forced to `strong`, in every
 *    profile. Escalation is nearly free (measured: Opus-tier `max` costs ~6%
 *    over `xhigh`); a missed escalation is not.
 *  - `fast` is suggested ONLY for a conservative allowlist of prose-shaped
 *    verbs (summarize/explain/translate/…). Code-writing tasks are never
 *    auto-routed to the fast tier — that keeps the "Sonnet-tier floor for
 *    delegated code" invariant without needing to classify code tasks at all.
 *  - The `quality` profile never suggests `fast`.
 * Anything else returns undefined ⇒ existing default routing, untouched.
 */

import { BoostProfile, EffortLevel } from '../types';

/** Effort tiers, weakest → strongest. Used to compare parent vs child effort. */
const EFFORT_ORDER: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface BoostRoutingConfig {
  enabled: boolean;
  profile: BoostProfile;
}

export type SuggestedTier = 'fast' | 'strong';

/**
 * Tasks that look like security, review, or trust-perimeter work are forced to
 * the strong tier. Matched case-insensitively anywhere in the task text.
 * Word-ish boundaries are used where a bare substring would over-match
 * (e.g. `auth` inside `author`).
 */
const STRONG_PATTERNS: RegExp[] = [
  /\bsecurit(y|ies)\b/i,
  /\bpermission/i,
  /\bgate\b|\bgating\b|\bfail[- ]?(open|closed)\b/i,
  /\bclamp/i,
  /\bnonce\b/i,
  /\bsandbox/i,
  /\baudit/i,
  /\badversarial/i,
  /\breview\b|\breviewing\b/i,
  /\bvulnerab/i,
  /\bexploit/i,
  /\binjection\b/i,
  /\bsecret(s)?\b|\bcredential/i,
  /\bauth\b|\bauthenticat|\bauthoriz/i,
  // Trust-perimeter files by name (Plan 20/23): never route these down.
  /settingsClamp|permissionClassifier|toolNames|MystiLocalExec|MystiLocalTools|visualTestPolicy|CollaboratorPool|SafetyClassifier|AgentLoader|SkillStaging/,
  /\btrust[- ]perimeter\b|\bthreat[- ]model\b/i,
];

/**
 * Leading prose-shaped verbs that are safe on a fast/cheap tier. Anchored to
 * the start of the task (after optional pleasantries) so an incidental
 * "…then summarize" inside a code task does not downgrade it.
 *
 * `document` and `list` are deliberately ABSENT: they read as prose verbs but
 * routinely head tasks that end in code edits ("Document the public API by
 * adding TSDoc to X.ts", "List the dead code and delete it"), which the leading
 * -verb anchor alone cannot tell apart from real prose work.
 */
const FAST_LEAD_RE =
  /^\s*(?:please\s+|now\s+|then\s+)?(summari[sz]e|explain|describe|translate|proofread|rephrase|reword|write\s+release\s+notes|draft\s+release\s+notes)\b/i;

/**
 * Second gate on the fast lane: a task that also asks for an EDIT never gets
 * downgraded. A fast-tier delegation still runs with `gated-write` access, so
 * the Sonnet-floor invariant has to be enforced on intent, not just on the
 * opening verb — a leading prose verb is no evidence that nothing gets written
 * ("Explain the flaky test and then fix it").
 *
 * Two signals, both deliberately conservative:
 *  - an edit verb in VERB position (after and/then/also/to/by or a comma).
 *    Matching those verbs anywhere would fire on ordinary nouns — "summarize
 *    the changes" is the canonical fast task, and `chang\w*` would kill it.
 *  - a filename-shaped token (`.ts`, `.json`), which means the task points at
 *    a concrete file rather than at prose.
 * Erring toward NOT downgrading is intentional: a missed downgrade costs a
 * little money, a wrong one sends code edits to a Haiku-class model.
 */
const EDIT_INTENT_RE =
  /(?:\band|\bthen|\balso|\bto|\bby|,)\s+(?:fix|refactor|implement|delet|remov|renam|add|edit|updat|chang|migrat|modif|creat|insert|append|patch|rewrit|replac|wire)\w*\b|\.[a-z]{1,4}\b/i;

export class ModelRouter {
  constructor(private readonly _cfg: () => BoostRoutingConfig) {}

  /**
   * Suggest a tier for an UN-tiered delegation. Returns undefined when Boost is
   * off or the task doesn't match a rule — the caller must treat undefined as
   * "leave routing exactly as it is today".
   */
  public suggestTier(task: string): SuggestedTier | undefined {
    const cfg = this._cfg();
    if (!cfg.enabled) { return undefined; }
    const text = (task || '').slice(0, 2000);
    if (STRONG_PATTERNS.some((re) => re.test(text))) { return 'strong'; }
    if (cfg.profile !== 'quality' && FAST_LEAD_RE.test(text) && !EDIT_INTENT_RE.test(text)) {
      return 'fast';
    }
    return undefined;
  }

  /**
   * Effort override for a delegation lane. Only the economy profile lowers
   * effort, and only on fast lanes; everything else inherits the parent's
   * effort (undefined).
   *
   * Never RAISES: `clampEffort` clamps to the provider's declared tiers, not to
   * the parent's value, and CollaboratorPool's spec.effortLevel overrides the
   * inherited setting — so a parent already at or below 'medium' must return
   * undefined and simply be inherited, or a 'low'-effort parent would spawn a
   * 'medium'-effort child.
   */
  public delegationEffort(
    tier: SuggestedTier | undefined,
    parentEffort?: EffortLevel,
  ): EffortLevel | undefined {
    const cfg = this._cfg();
    if (!cfg.enabled) { return undefined; }
    if (cfg.profile !== 'economy' || tier !== 'fast') { return undefined; }
    const parentRank = parentEffort ? EFFORT_ORDER.indexOf(parentEffort) : -1;
    // Unknown/absent parent effort ⇒ assume the 'high' default (package.json).
    const effectiveParent = parentRank >= 0 ? parentRank : EFFORT_ORDER.indexOf('high');
    return effectiveParent > EFFORT_ORDER.indexOf('medium') ? 'medium' : undefined;
  }
}
