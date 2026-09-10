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
  aliases: Readonly<Record<string, T>> = {},
): { value: T; clamped: boolean } {
  if (!inspection) { return { value: current, clamped: false }; }
  const ws = (inspection.workspaceFolderValue ?? inspection.workspaceValue) as T | undefined;
  if (ws === undefined) { return { value: current, clamped: false }; }
  if (!Object.prototype.hasOwnProperty.call(rank, ws as string)) {
    // Plan 23 B1: a workspace supplying a value outside the enum used to pass
    // through unclamped. It is not a legitimate setting, and the runtime
    // compares by literal, so leaving it in place is how a cloned repo turns
    // "ask" into "never ask". Clamp to the user's own floor.
    const floor = ((inspection.globalValue as T | undefined) ?? (inspection.defaultValue as T | undefined) ?? fallback);
    return { value: floor, clamped: current !== floor };
  }
  // The floor may be a LEGACY value — someone who picked "plan" in v0.4.0 still
  // has that literal in their global settings.json. `MODE_RANK` has no `plan`
  // key, so ranking it raw collapsed a rank-3 floor to `rank[fallback]` (1) and
  // a repo could then set `defaultMode` to `default` or `ask-before-edit` and be
  // accepted with clampedFields []. Resolve the alias BEFORE ranking, so the
  // one-way ratchet sees the authority the user actually chose.
  const rawFloor = ((inspection.globalValue as T | undefined) ?? (inspection.defaultValue as T | undefined) ?? fallback);
  const userFloor = !isMember(rank, rawFloor) && isMember(rank, aliases[rawFloor as string])
    ? aliases[rawFloor as string]
    : rawFloor;
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
 * `mysti.visualTest.interactions` — the ceiling for a HUMAN driving the Visual
 * Test dashboard. Declared enum order in package.json, low → high authority;
 * `settingsClamp.test.ts` pins this array to that order.
 */
export const VISUAL_INTERACTION_LEVELS = ['off', 'safe', 'full'] as const;
export type VisualInteractionLevel = typeof VISUAL_INTERACTION_LEVELS[number];

/** Higher = more restrictive (off permits nothing; full permits every interaction). */
const VISUAL_INTERACTIONS_RANK: Record<VisualInteractionLevel, number> = {
  'off': 2,
  'safe': 1,
  'full': 0,
};

/** The two boolean/enum visual-test settings the ratchet covers. */
export interface VisualTestAuthority {
  /** `mysti.visualTest.enabled` — the master switch (false < true). */
  enabled: boolean;
  /** `mysti.visualTest.interactions` — the human interaction ceiling. */
  interactions: VisualInteractionLevel;
}

/**
 * Lower-only ratchet for a BOOLEAN setting where `false` is the safe value: a
 * workspace may turn the feature OFF for a user who has it on, never ON for a
 * user who turned it off. Same shape and rules as {@link clampOne}: no
 * inspection or no workspace value ⇒ untouched; a non-boolean workspace value
 * (a hand-edited or cloned settings file) is coerced to the user's own floor.
 */
function clampBooleanOne(
  current: boolean,
  inspection: SettingInspection | undefined,
  fallback: boolean,
): { value: boolean; clamped: boolean } {
  if (!inspection) { return { value: current, clamped: false }; }
  const ws = inspection.workspaceFolderValue ?? inspection.workspaceValue;
  if (ws === undefined) { return { value: current, clamped: false }; }
  const rawFloor = inspection.globalValue ?? inspection.defaultValue ?? fallback;
  const floor = typeof rawFloor === 'boolean' ? rawFloor : fallback;
  if (typeof ws !== 'boolean') {
    return { value: floor, clamped: current !== floor };
  }
  // Workspace tried ON while the user's own policy is OFF, and the runtime
  // value reflects that escalation: clamp back.
  if (ws && !floor && current) {
    return { value: false, clamped: true };
  }
  return { value: current, clamped: false };
}

/**
 * Clamp the visual-test authority settings (Plan 27 §21.6c #6): a workspace
 * may DISABLE visual testing or LOWER the human interaction ceiling for one
 * repo, never re-enable or raise them above the user's own policy.
 *
 * Neither key is part of `Settings` (they are read straight from
 * configuration by `ChatViewProvider._mystiVisualEnabled` and
 * `_visualPolicyDeps`), so — like {@link clampSafetyMode} — this is a
 * standalone ratchet the consumer calls with the raw `config.get` values and
 * `config.inspect`. It is the precondition for moving the two keys from
 * `machine` back to window scope: the scope may move ONLY once both reads go
 * through here, in the same change that lists them in `CLAMPED_SETTINGS`.
 * Until then they stay machine-scoped (a repo cannot set them at all).
 */
export function clampVisualTestSettings(
  current: VisualTestAuthority,
  inspect: InspectFn,
): { settings: VisualTestAuthority; clampedFields: string[] } {
  const clampedFields: string[] = [];

  const enabled = clampBooleanOne(current.enabled, inspect('visualTest.enabled'), true);
  if (enabled.clamped) { clampedFields.push('visualTest.enabled'); }

  const interactions = clampOne<VisualInteractionLevel>(
    current.interactions, inspect('visualTest.interactions'), VISUAL_INTERACTIONS_RANK, 'safe');
  if (interactions.clamped) { clampedFields.push('visualTest.interactions'); }

  if (clampedFields.length === 0) { return { settings: current, clampedFields }; }
  return {
    settings: { enabled: enabled.value, interactions: interactions.value },
    clampedFields,
  };
}

/**
 * The canonical runtime membership lists for the two authority settings.
 *
 * These exist as VALUES, not just types, because the danger is precisely that a
 * runtime value lies about its declared type: `config.get(...) as any` will hand
 * back any string the settings file holds. TypeScript narrows a union away after
 * an equality check and would call a re-test "unreachable" — true of the type,
 * false of the data.
 *
 * `settingsEnumParity.test.ts` asserts these equal both the TS unions and the
 * enums declared in package.json, so the three cannot drift apart silently.
 */
export const ACCESS_LEVELS: readonly string[] = ['read-only', 'ask-permission', 'full-access'];
export const OPERATION_MODES: readonly string[] = ['default', 'ask-before-edit', 'edit-automatically', 'quick-plan', 'detailed-plan'];

/**
 * Own-property membership. `x in RANK` also answers true for every inherited
 * key (`'toString'`, `'constructor'`), so a settings file holding one of those
 * strings used to sail through normalization as if it were a real enum member.
 * The gate stays closed either way (permissionClassifier re-tests against the
 * runtime arrays), but a value that is not a member must be COERCED, not
 * waved through.
 */
function isMember(rank: Record<string, number>, value: unknown): boolean {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(rank, value);
}

/**
 * Values that were selectable in an earlier release and are therefore sitting
 * in real users' settings.json right now, mapped to their nearest modern
 * equivalent that is EQUAL-OR-MORE restrictive.
 *
 * v0.4.0's `mysti.defaultMode` enum was
 * `["ask-before-edit","edit-automatically","plan"]`. `"plan"` meant "produce a
 * plan, make no changes" — the MOST restrictive tier. VS Code does not validate
 * a declared enum at read time (see the note on `normalizeAuthoritySettings`),
 * so the literal string survives the upgrade. Coercing it as merely
 * "unrecognized" landed it on `'default'`, and MODE_RANK counts HIGHER = MORE
 * restrictive: `'quick-plan'` is 3 and `'default'` is 1. That silently moved a
 * user who chose "never write" into a mode that writes.
 *
 * The same mapping already existed for the `/mode plan` slash-command argument
 * (`SlashCommandManager` settings:mode); this is it applied to the persisted
 * setting, which is where it actually matters.
 *
 * INVARIANT, asserted by `settingsClamp.test.ts`: for every alias,
 * `MODE_RANK[alias] >= MODE_RANK[<the modern default>]`. An alias may only ever
 * land on an equal-or-stricter mode. Get that inequality backwards and this map
 * becomes the bug it was written to fix.
 */
export const LEGACY_MODE_ALIASES: Readonly<Record<string, OperationMode>> = Object.freeze({
  plan: 'quick-plan',
});

/**
 * Where a mode that is neither modern nor a known legacy alias lands.
 *
 * `'ask-before-edit'` (rank 2), not `'default'` (rank 1). The module's own rule
 * is that the safe failure is "the user gets asked", not "nothing works", and
 * `'default'` does not actually deliver that: it only gates when `accessLevel`
 * happens to be `ask-permission`, so an unrecognized mode on a full-access
 * install used to gate nothing. `'ask-before-edit'` gates every change at any
 * access level, and still leaves a working install.
 */
const UNKNOWN_MODE_FALLBACK: OperationMode = 'ask-before-edit';

/**
 * Coerce authority settings to known enum members (Plan 23 B1, Plan 27 A-1).
 *
 * `_getSettingsForPanel` reads these with `config.get(...) as any`, and VSCode
 * does NOT validate a declared `enum` at read time — whatever string is in the
 * JSON comes straight through. That matters because every downstream decision
 * compares against string LITERALS, so an unrecognized value matches no branch
 * and lands on the permissive default: `"Ask-Permission"` (capitalized), or any
 * value a hand-edited or cloned-repo settings file supplies, silently became
 * "no gate" rather than "ask".
 *
 * `clampSettingsToUserPolicy` cannot cover this — `clampOne` deliberately
 * early-returns on a value the rank table does not own, so a non-enum workspace
 * value passes through unclamped rather than being rejected.
 *
 * Three rules, in order:
 *  1. a value that IS a known enum member is left alone;
 *  2. a known LEGACY value is migrated through `LEGACY_MODE_ALIASES`, which is
 *     only ever allowed to land on an equal-or-MORE restrictive mode;
 *  3. anything else lands on ASK — `ask-permission` / `ask-before-edit`. The
 *     safe failure here is "the user gets asked", not "nothing works": falling
 *     all the way to read-only would turn a typo into a broken install and
 *     teach people to turn the feature off.
 */
export function normalizeAuthoritySettings(settings: Settings): { settings: Settings; coerced: string[] } {
  const coerced: string[] = [];
  let accessLevel = settings.accessLevel;
  let mode = settings.mode;

  if (!isMember(ACCESS_RANK, accessLevel)) {
    coerced.push(`accessLevel="${String(accessLevel)}"`);
    accessLevel = 'ask-permission';
  }
  if (!isMember(MODE_RANK, mode)) {
    const alias = Object.prototype.hasOwnProperty.call(LEGACY_MODE_ALIASES, String(mode))
      ? LEGACY_MODE_ALIASES[String(mode)]
      : undefined;
    coerced.push(alias
      ? `mode="${String(mode)}" (legacy -> "${alias}")`
      : `mode="${String(mode)}"`);
    mode = alias ?? UNKNOWN_MODE_FALLBACK;
  }
  if (coerced.length === 0) { return { settings, coerced }; }
  return { settings: { ...settings, accessLevel, mode }, coerced };
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
    settings.mode, inspect('defaultMode'), MODE_RANK, 'default', LEGACY_MODE_ALIASES);
  if (mode.clamped) { clampedFields.push('mode'); }

  if (clampedFields.length === 0) { return { settings, clampedFields }; }
  return {
    settings: { ...settings, accessLevel: access.value, mode: mode.value },
    clampedFields,
  };
}

/**
 * The settings this module actually clamps (Plan 27 D-12/D-14).
 *
 * These three are deliberately LEFT window-scoped: a workspace has a legitimate
 * reason to make Mysti *stricter* for a repo ("this project is read-only"), and
 * `clampSettingsToUserPolicy` / `clampSafetyMode` are what make that a one-way
 * ratchet. Machine-scoping them would remove the ability to lower authority per
 * repo, which is the behaviour worth keeping. Never drop one of these without
 * extending the clamp to its replacement in the same change.
 */
export const CLAMPED_SETTINGS: readonly string[] = [
  'mysti.accessLevel',
  'mysti.defaultMode',
  'mysti.autonomous.safetyMode',
];

/**
 * Every setting whose value can raise Mysti's authority, widen its egress, or
 * put attacker-chosen text into a model's instruction surface.
 *
 * The invariant `settingsScopeParity.test.ts` enforces in both directions:
 * each of these is declared in package.json, and each is EITHER machine- (or
 * application-) scoped, so a repository's `.vscode/settings.json` cannot set it
 * at all, OR listed in `CLAMPED_SETTINGS` and therefore ratcheted at runtime.
 * There is no third option, and a new authority-bearing setting that is neither
 * fails the test rather than shipping silently workspace-writable.
 */
export const AUTHORITY_BEARING_SETTINGS: readonly string[] = [
  // Authority level itself — clamped, not machine-scoped (see above).
  'mysti.accessLevel',
  'mysti.defaultMode',
  'mysti.autonomous.safetyMode',

  // Coordinator capability gates: each one turns a capability from
  // "not even parsed" into "exists". All machine-scoped.
  'mysti.mysti.localExecution',
  'mysti.mysti.mcpTools',
  'mysti.mysti.visualTools',
  'mysti.mysti.skills',
  'mysti.mysti.bashNetwork',

  // Permission-card behaviour: `timeoutBehavior: auto-accept` turns an
  // unanswered card into an approval, which is authority by inaction.
  'mysti.permission.timeout',
  'mysti.permission.timeoutBehavior',

  // Egress destinations. A workspace-settable endpoint redirects every prompt
  // (and, for LocalAI, the machine-scoped API key) to a host of its choosing.
  'mysti.ollamaEndpoint',
  'mysti.localaiEndpoint',

  // Shell-shaped surfaces.
  'mysti.useShellForCli',
  // Plan 27 N-2: turns extension activation into `openclaw gateway start`
  // (ActiveModeManager.initialize → startDaemon). Machine-scoped AND gated on
  // a trusted workspace; default off.
  'mysti.activeMode.autoStartDaemon',
  'mysti.visualTest.devServerCommand',
  'mysti.visualTest.allowModelDevServerCommand',
  'mysti.visualTest.allowedOrigins',
  'mysti.visualTest.agentInteractions',
  // Plan 27 I-1: the master switch (default true — a repo could RE-ENABLE it
  // for a user who turned it off) and the HUMAN interaction ceiling. Machine-
  // scoped for now. The intended end state is the lower-only ratchet in
  // `clampVisualTestSettings` (a repo may say "no browser here", never the
  // reverse); the scope moves back to window ONLY when both ChatViewProvider
  // reads go through that function and both keys join CLAMPED_SETTINGS.
  'mysti.visualTest.enabled',
  'mysti.visualTest.interactions',

  // Provider config selector: `codexProfile` becomes `--profile <name>`, which
  // selects the rest of the Codex CLI's configuration (model, reasoning
  // effort, model catalog — and, per the official docs, a profile MAY carry an
  // `approval_policy`). It does NOT decide the sandbox Mysti runs Codex in:
  // every `CodexProvider._addSandboxFlags` branch passes an explicit
  // `--sandbox` / `--dangerously-bypass-approvals-and-sandbox`
  // before `--profile`, and flag-vs-profile precedence is not stated in the
  // official configuration docs we could find
  // (https://learn.chatgpt.com/docs/config-file/config-advanced). Machine
  // scope is still right: a repo must not pick which of the USER's config
  // layers the CLI that judges its code runs with.
  'mysti.codexProfile',

  // Autonomous-mode authority (safetyMode is clamped above; these six decide
  // what an auto-approved decision is allowed to do).
  'mysti.autonomous.maxSessionDuration',
  'mysti.autonomous.blockPatterns',
  'mysti.autonomous.allowFileCreation',
  'mysti.autonomous.allowFileEdit',
  'mysti.autonomous.allowBashCommands',
  'mysti.autonomous.continuationMode',

  // Instruction surface: `*CustomPrompt` is arbitrary text spliced into the
  // system prompt, and `*Persona` selects which instructions get spliced.
  'mysti.agents.claudePersona', 'mysti.agents.claudeCustomPrompt',
  'mysti.agents.codexPersona', 'mysti.agents.codexCustomPrompt',
  'mysti.agents.geminiPersona', 'mysti.agents.geminiCustomPrompt',
  'mysti.agents.clinePersona', 'mysti.agents.clineCustomPrompt',
  'mysti.agents.copilotPersona', 'mysti.agents.copilotCustomPrompt',
  'mysti.agents.cursorPersona', 'mysti.agents.cursorCustomPrompt',
  'mysti.agents.openclawPersona', 'mysti.agents.openclawCustomPrompt',
  'mysti.agents.opencodePersona', 'mysti.agents.opencodeCustomPrompt',
  'mysti.agents.ollamaPersona', 'mysti.agents.ollamaCustomPrompt',
  'mysti.agents.localaiPersona', 'mysti.agents.localaiCustomPrompt',
  'mysti.agents.qwenCodePersona', 'mysti.agents.qwenCodeCustomPrompt',
  'mysti.agents.hermesPersona', 'mysti.agents.hermesCustomPrompt',
  'mysti.agents.continuePersona', 'mysti.agents.continueCustomPrompt',
  'mysti.agents.openrouterPersona', 'mysti.agents.openrouterCustomPrompt',
  'mysti.agents.kimiCodePersona', 'mysti.agents.kimiCodeCustomPrompt',
  'mysti.agents.skillSources',
];
