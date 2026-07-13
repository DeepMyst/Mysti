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
 * Workspace-settings clamp (Plan 17 P0.7b / Plan 10 Part 1 step 4).
 *
 * A repository's .vscode/settings.json is UNTRUSTED relative to the user: a
 * malicious repo must not be able to silently raise Mysti's authority (e.g.
 * `"mysti.accessLevel": "full-access"` or an auto-editing mode) just by being
 * opened. Rule: a WORKSPACE-scope value may only LOWER authority relative to
 * the user's own (user-scope or default) value — when it tries to raise it,
 * the runtime settings are clamped back to the user-scope value.
 *
 * The clamp fires only when the runtime setting matches the workspace's
 * escalated value (i.e. it plausibly came from the workspace seed) — a user's
 * own stricter choice is never loosened.
 */

import type { Settings, AccessLevel, OperationMode } from '../types';

/** Shape of vscode's WorkspaceConfiguration.inspect() result (subset). */
export interface SettingInspection {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
  defaultValue?: unknown;
}

export type InspectFn = (section: string) => SettingInspection | undefined;

/** Higher = more restrictive. */
const ACCESS_RANK: Record<AccessLevel, number> = {
  'read-only': 2,
  'ask-permission': 1,
  'full-access': 0,
};

/** Higher = more restrictive (plan modes never write; auto-edit is loosest). */
const MODE_RANK: Record<OperationMode, number> = {
  'quick-plan': 3,
  'detailed-plan': 3,
  'ask-before-edit': 2,
  'default': 1,
  'edit-automatically': 0,
};

/** Higher = more restrictive (conservative auto-approves least). */
const SAFETY_RANK: Record<string, number> = {
  'conservative': 2,
  'balanced': 1,
  'aggressive': 0,
};

function clampOne<T extends string>(
  current: T,
  inspection: SettingInspection | undefined,
  rank: Record<T, number>,
  fallback: T,
): { value: T; clamped: boolean } {
  if (!inspection) { return { value: current, clamped: false }; }
  const ws = (inspection.workspaceFolderValue ?? inspection.workspaceValue) as T | undefined;
  if (ws === undefined || !(ws in rank)) { return { value: current, clamped: false }; }
  const userFloor = ((inspection.globalValue as T | undefined) ?? (inspection.defaultValue as T | undefined) ?? fallback);
  const floorRank = rank[userFloor] ?? rank[fallback];
  // Workspace tried to be LESS restrictive than the user's own policy…
  if (rank[ws] < floorRank && rank[current] <= rank[ws]) {
    // …and the runtime setting reflects that escalation (or worse): clamp back.
    return { value: userFloor, clamped: true };
  }
  return { value: current, clamped: false };
}

/**
 * Clamp the autonomous safety mode: a workspace may only make it MORE
 * conservative than the user's own policy, never more aggressive (review [3]).
 * Read directly by AutonomousManager (safetyMode isn't part of Settings).
 */
export function clampSafetyMode(current: string, inspect: InspectFn): { value: string; clamped: boolean } {
  return clampOne<string>(current, inspect('autonomous.safetyMode'), SAFETY_RANK, 'balanced');
}

/**
 * Clamp runtime settings to the user's own policy. Returns the (possibly)
 * adjusted settings and which fields were clamped, so the caller can warn once.
 */
export function clampSettingsToUserPolicy(
  settings: Settings,
  inspect: InspectFn,
): { settings: Settings; clampedFields: string[] } {
  const clampedFields: string[] = [];

  const access = clampOne<AccessLevel>(
    settings.accessLevel, inspect('accessLevel'), ACCESS_RANK, 'ask-permission');
  if (access.clamped) { clampedFields.push('accessLevel'); }

  const mode = clampOne<OperationMode>(
    settings.mode, inspect('defaultMode'), MODE_RANK, 'default');
  if (mode.clamped) { clampedFields.push('mode'); }

  if (clampedFields.length === 0) { return { settings, clampedFields }; }
  return {
    settings: { ...settings, accessLevel: access.value, mode: mode.value },
    clampedFields,
  };
}
