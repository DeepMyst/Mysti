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
 * Plan 28 Phase 1 — the Trust ladder.
 *
 * Mysti asks one question ("what may this agent do without me?") through four
 * separate controls: the `behavior-popup`, `mode-select`, `access-select` and
 * `autonomy-select`. `OperationMode` has five values and `AccessLevel` has
 * three, so the settings panel can express FIFTEEN authority combinations —
 * and `shouldGateToolUse` gives distinct meaning to four of them. The other
 * eleven land on the Plan 23 B1 fail-closed tail. That tail is correct, but a
 * UI able to express eleven meaningless states is a UI that will eventually
 * express a twelfth, and the B1 regression was exactly that class of bug.
 *
 * This module is a PRESENTATION collapse, not a new authority model:
 *
 *   - `OperationMode` and `AccessLevel` remain the stored truth. Nothing here
 *     is persisted; nothing here is consulted by the gate.
 *   - `shouldGateToolUse` gains NO branch. Every pair produced by
 *     `authorityForTrust` is one the gate already handles today.
 *   - `trustForAuthority` is TOTAL over all fifteen combinations and reports
 *     the stop whose BEHAVIOUR the stored pair already has — so the pill never
 *     claims to be more restrictive than the gate is actually being.
 *
 * Unattended running is deliberately absent. It is a DURATION granted on top
 * of `auto` or `full` (it sets `Settings.autonomousMode`, which routes through
 * the `SafetyClassifier` branch of `ChatViewProvider._shouldGateToolUse`), not
 * a fifth rung. Adding it here would recreate the seam this module removes.
 */

import { AccessLevel, OperationMode } from '../types';

/** The four rungs, ordered from most restrictive to least. */
export type TrustStop = 'plan' | 'ask' | 'auto' | 'full';

/** Ordered most-restrictive first. Index in this array IS the rung number. */
export const TRUST_STOPS: readonly TrustStop[] = Object.freeze(
  ['plan', 'ask', 'auto', 'full'] as const
) as readonly TrustStop[];

/** The stored authority a rung maps onto. */
export interface TrustAuthority {
  mode: OperationMode;
  accessLevel: AccessLevel;
}

/**
 * Rung -> stored pair. Every one of these four pairs hits a branch that
 * `shouldGateToolUse` handles explicitly today:
 *
 *   plan  quick-plan         + read-only       not gated here; the CLI's own
 *                                              permission mode enforces it and
 *                                              the coordinator refuses local
 *                                              execution in this tier.
 *   ask   ask-before-edit    + ask-permission  gate every change.
 *   auto  edit-automatically + ask-permission  edits auto-apply; bash, delete,
 *                                              web-request and delegate gated.
 *   full  edit-automatically + full-access     not gated here.
 */
const TRUST_AUTHORITY: Readonly<Record<TrustStop, TrustAuthority>> = Object.freeze({
  plan: Object.freeze({ mode: 'quick-plan', accessLevel: 'read-only' }),
  ask: Object.freeze({ mode: 'ask-before-edit', accessLevel: 'ask-permission' }),
  auto: Object.freeze({ mode: 'edit-automatically', accessLevel: 'ask-permission' }),
  full: Object.freeze({ mode: 'edit-automatically', accessLevel: 'full-access' }),
}) as Readonly<Record<TrustStop, TrustAuthority>>;

/** Short label + what the rung permits, in the user's words. */
export const TRUST_COPY: Readonly<Record<TrustStop, { label: string; permits: string }>> =
  Object.freeze({
    plan: Object.freeze({
      label: 'Plan',
      permits: 'Reads and plans. Writes nothing, runs nothing.',
    }),
    ask: Object.freeze({
      label: 'Ask',
      permits: 'Edits files, but asks before every write and every command.',
    }),
    auto: Object.freeze({
      label: 'Auto',
      permits: 'Edits inside the workspace on its own. Asks to leave it or reach the network.',
    }),
    full: Object.freeze({
      label: 'Full',
      permits: 'Edits, runs commands, reaches the network. Only machine policy still holds it back.',
    }),
  }) as Readonly<Record<TrustStop, { label: string; permits: string }>>;

/** True for a value that is actually one of the four rungs. */
export function isTrustStop(value: unknown): value is TrustStop {
  return typeof value === 'string' && (TRUST_STOPS as readonly string[]).includes(value);
}

/**
 * Rung -> the settings to store.
 *
 * `current` is honoured for one thing only: a user already on `detailed-plan`
 * keeps it when they land on `plan`, instead of being silently downgraded to
 * `quick-plan` by a round trip through the pill. The two plan modes differ in
 * output depth, not in authority, so both are correct for this rung.
 */
export function authorityForTrust(stop: TrustStop, current?: OperationMode): TrustAuthority {
  const target = TRUST_AUTHORITY[stop];
  if (stop === 'plan' && current === 'detailed-plan') {
    return { mode: 'detailed-plan', accessLevel: target.accessLevel };
  }
  return { mode: target.mode, accessLevel: target.accessLevel };
}

/**
 * Stored pair -> the rung to show. TOTAL over all fifteen combinations, and
 * ordered so that the STRICTEST thing the user has set is what the pill
 * reports. Each branch mirrors an existing behaviour of `shouldGateToolUse`
 * (or, for the plan/read-only tiers, of the CLI permission mode above it) —
 * see the table in `TRUST_AUTHORITY`.
 *
 * Callers pass values that may not belong to the unions at all (settings read
 * off disk); `normalizeAuthoritySettings` is the boundary that coerces those,
 * and the final `return 'ask'` here is the belt to it. Never `full`.
 */
export function trustForAuthority(mode: OperationMode, accessLevel: AccessLevel): TrustStop {
  // 1. A plan mode never writes, whatever the access level says.
  if (mode === 'quick-plan' || mode === 'detailed-plan') { return 'plan'; }
  // 2. Read-only never writes either, whatever the mode says.
  if (accessLevel === 'read-only') { return 'plan'; }
  // 3. `ask-before-edit` gates every change on any access level.
  if (mode === 'ask-before-edit') { return 'ask'; }
  // 4. Under ask-permission, only `edit-automatically` reaches the
  //    accept-edits tier; every other mode still gates everything.
  if (accessLevel === 'ask-permission') {
    return mode === 'edit-automatically' ? 'auto' : 'ask';
  }
  // 5. full-access with a writing mode is ungated here.
  if (accessLevel === 'full-access') { return 'full'; }
  return 'ask';
}

/**
 * Next rung for a `Shift+Tab` press. Wraps. `delta` may be negative for a
 * reverse cycle; anything out of range is clamped to a single step so a stray
 * value cannot skip a rung and hand out authority nobody asked for.
 */
export function cycleTrust(stop: TrustStop, delta: number = 1): TrustStop {
  const n = TRUST_STOPS.length;
  const from = TRUST_STOPS.indexOf(stop);
  const start = from < 0 ? 0 : from;
  const step = delta < 0 ? -1 : 1;
  return TRUST_STOPS[(start + step + n) % n];
}
