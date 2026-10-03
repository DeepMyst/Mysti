/**
 * Workspace-settings clamp (Plan 17 P0.7b) — a repo's .vscode/settings.json
 * may only LOWER Mysti's authority, never raise it above the user's policy.
 */
import { describe, it, expect } from 'vitest';
import {
  clampSettingsToUserPolicy,
  clampSafetyMode,
  normalizeAuthoritySettings,
  LEGACY_MODE_ALIASES,
  OPERATION_MODES,
  ACCESS_LEVELS,
  clampVisualTestSettings,
  VISUAL_INTERACTION_LEVELS,
  type SettingInspection,
} from '../../src/utils/settingsClamp';
import { shouldGateToolUse } from '../../src/utils/permissionClassifier';
import type { Settings } from '../../src/types';

function settings(over: Partial<Settings> = {}): Settings {
  return {
    mode: 'default',
    thinkingLevel: 'none',
    accessLevel: 'ask-permission',
    contextMode: 'auto',
    model: 'claude-sonnet-4-5-20250929',
    provider: 'claude-code',
    ...over,
  };
}

function inspector(map: Record<string, SettingInspection>) {
  return (section: string) => map[section];
}

describe('clampSettingsToUserPolicy', () => {
  it('clamps a workspace-escalated accessLevel back to the user policy', () => {
    const r = clampSettingsToUserPolicy(
      settings({ accessLevel: 'full-access' }),
      inspector({ accessLevel: { workspaceValue: 'full-access', defaultValue: 'ask-permission' } }),
    );
    expect(r.clampedFields).toEqual(['accessLevel']);
    expect(r.settings.accessLevel).toBe('ask-permission');
  });

  it('review[42]: clamps to the EXPLICIT global floor, not the default, when the user hardened it', () => {
    // User globally hardened to read-only; a malicious repo tries full-access.
    // Must clamp to the user's read-only floor — NOT back up to the default.
    const r = clampSettingsToUserPolicy(
      settings({ accessLevel: 'full-access' }),
      inspector({ accessLevel: { workspaceValue: 'full-access', globalValue: 'read-only', defaultValue: 'ask-permission' } }),
    );
    expect(r.clampedFields).toEqual(['accessLevel']);
    expect(r.settings.accessLevel).toBe('read-only');
  });

  it('respects an explicit USER-scope grant (workspace matches user ⇒ no clamp)', () => {
    const r = clampSettingsToUserPolicy(
      settings({ accessLevel: 'full-access' }),
      inspector({ accessLevel: { globalValue: 'full-access', workspaceValue: 'full-access', defaultValue: 'ask-permission' } }),
    );
    expect(r.clampedFields).toEqual([]);
    expect(r.settings.accessLevel).toBe('full-access');
  });

  it('never LOOSENS: a workspace that lowers authority is untouched', () => {
    const r = clampSettingsToUserPolicy(
      settings({ accessLevel: 'read-only' }),
      inspector({ accessLevel: { workspaceValue: 'read-only', globalValue: 'full-access', defaultValue: 'ask-permission' } }),
    );
    expect(r.clampedFields).toEqual([]);
    expect(r.settings.accessLevel).toBe('read-only');
  });

  it('leaves a stricter runtime choice alone even when the workspace escalates', () => {
    // Workspace says full-access, but the user picked read-only in the UI.
    const r = clampSettingsToUserPolicy(
      settings({ accessLevel: 'read-only' }),
      inspector({ accessLevel: { workspaceValue: 'full-access', defaultValue: 'ask-permission' } }),
    );
    expect(r.clampedFields).toEqual([]);
    expect(r.settings.accessLevel).toBe('read-only');
  });

  it('clamps a workspace-escalated mode (edit-automatically) back to the user default', () => {
    const r = clampSettingsToUserPolicy(
      settings({ mode: 'edit-automatically' }),
      inspector({ defaultMode: { workspaceValue: 'edit-automatically', defaultValue: 'default' } }),
    );
    expect(r.clampedFields).toEqual(['mode']);
    expect(r.settings.mode).toBe('default');
  });

  it('workspaceFolderValue counts as a workspace escalation too', () => {
    const r = clampSettingsToUserPolicy(
      settings({ accessLevel: 'full-access' }),
      inspector({ accessLevel: { workspaceFolderValue: 'full-access', defaultValue: 'ask-permission' } }),
    );
    expect(r.clampedFields).toEqual(['accessLevel']);
  });

  it('no inspection data ⇒ untouched (never blocks a send)', () => {
    const r = clampSettingsToUserPolicy(settings({ accessLevel: 'full-access' }), () => undefined);
    expect(r.clampedFields).toEqual([]);
    expect(r.settings.accessLevel).toBe('full-access');
  });

  it('ignores junk workspace values', () => {
    const r = clampSettingsToUserPolicy(
      settings(),
      inspector({ accessLevel: { workspaceValue: 'yolo-mode', defaultValue: 'ask-permission' } }),
    );
    expect(r.clampedFields).toEqual([]);
  });
});

describe('clampSafetyMode (autonomous, review [3])', () => {
  it('clamps a workspace-escalated safetyMode (aggressive) back to the user floor', () => {
    const r = clampSafetyMode('aggressive', inspector({ 'autonomous.safetyMode': { workspaceValue: 'aggressive', defaultValue: 'balanced' } }));
    expect(r.clamped).toBe(true);
    expect(r.value).toBe('balanced');
  });

  it('honors an explicit user-scope aggressive choice', () => {
    const r = clampSafetyMode('aggressive', inspector({ 'autonomous.safetyMode': { globalValue: 'aggressive', workspaceValue: 'aggressive', defaultValue: 'balanced' } }));
    expect(r.clamped).toBe(false);
    expect(r.value).toBe('aggressive');
  });

  it('leaves a more-conservative workspace value alone', () => {
    const r = clampSafetyMode('conservative', inspector({ 'autonomous.safetyMode': { workspaceValue: 'conservative', globalValue: 'balanced', defaultValue: 'balanced' } }));
    expect(r.clamped).toBe(false);
    expect(r.value).toBe('conservative');
  });
});

/**
 * Plan 27 A-1 — the legacy-value migration.
 *
 * v0.4.0 shipped `"plan"` as a selectable value of `mysti.defaultMode`
 * (`git show v0.4.0:package.json`); head's enum does not contain it. VS Code
 * does not validate a declared enum at read time, so that literal string is
 * still in real users' settings.json after they update. It meant the MOST
 * restrictive tier — "produce a plan, make no changes".
 */
describe('legacy authority values (Plan 27 A-1)', () => {
  const base = (mode: string, accessLevel = 'ask-permission'): Settings =>
    settings({ mode: mode as Settings['mode'], accessLevel: accessLevel as Settings['accessLevel'] });

  it('migrates a legacy "plan" mode UP to quick-plan, not down to default', () => {
    const r = normalizeAuthoritySettings(base('plan'));
    expect(r.settings.mode).toBe('quick-plan');
    // The regression this guards: 'default' is MODE_RANK 1 and writes.
    expect(r.settings.mode).not.toBe('default');
    expect(r.coerced.join(' ')).toContain('plan');
  });

  it('every legacy alias lands on an EQUAL-OR-MORE restrictive mode', () => {
    // The inequality that makes this map a fix rather than the bug it replaced.
    // MODE_RANK counts HIGHER = MORE restrictive, so an alias must never rank
    // below the modern default ('ask-before-edit', package.json's default).
    const RANK: Record<string, number> = {
      'quick-plan': 3, 'detailed-plan': 3, 'ask-before-edit': 2, 'default': 1, 'edit-automatically': 0,
    };
    expect(Object.keys(LEGACY_MODE_ALIASES).length).toBeGreaterThan(0);
    for (const [legacy, modern] of Object.entries(LEGACY_MODE_ALIASES)) {
      expect(OPERATION_MODES, `${legacy} -> ${modern} must be a modern member`).toContain(modern);
      expect(RANK[modern], `alias ${legacy} -> ${modern} must not lower authority`)
        .toBeGreaterThanOrEqual(RANK['ask-before-edit']);
    }
  });

  it('a legacy "plan" install lands in the never-writes tier, not a writing one', () => {
    // Deliberately NOT asserted via shouldGateToolUse: the plan tier is not
    // enforced at the tool gate (it is enforced by the provider's CLI
    // permission mode and by the coordinator refusing local execution), so both
    // 'quick-plan' and the old 'default' answer false there. The property that
    // actually regressed is which TIER the user ends up in.
    const { settings: s } = normalizeAuthoritySettings(base('plan', 'full-access'));
    expect(['quick-plan', 'detailed-plan']).toContain(s.mode);
  });

  it('an unrecognized, non-legacy mode lands on ASK, never on a writing mode', () => {
    // 'default' only gates when accessLevel happens to be ask-permission, so an
    // unknown mode on a full-access install used to gate nothing.
    const r = normalizeAuthoritySettings(base('totally-made-up', 'full-access'));
    expect(r.settings.mode).toBe('ask-before-edit');
    expect(shouldGateToolUse(r.settings, 'Write')).toBe(true);
  });

  it('an inherited Object.prototype key is coerced, not waved through', () => {
    // `'toString' in MODE_RANK` is true. Membership must be an OWN-property test.
    for (const key of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      const r = normalizeAuthoritySettings(base(key, key));
      expect(r.coerced.length, `${key} must be reported as coerced`).toBeGreaterThan(0);
      expect(OPERATION_MODES).toContain(r.settings.mode);
      expect(ACCESS_LEVELS).toContain(r.settings.accessLevel);
    }
  });

  it('clampOne rejects an inherited-key workspace value instead of trusting it', () => {
    // A workspace supplying `"toString"` must be clamped to the user's floor,
    // exactly like any other non-enum value (Plan 23 B1).
    const r = clampSettingsToUserPolicy(
      settings({ accessLevel: 'toString' as Settings['accessLevel'] }),
      inspector({ accessLevel: { workspaceValue: 'toString', globalValue: 'read-only' } }),
    );
    expect(r.clampedFields).toEqual(['accessLevel']);
    expect(r.settings.accessLevel).toBe('read-only');
  });

  it('valid modern values are still passed through untouched', () => {
    for (const mode of OPERATION_MODES) {
      const r = normalizeAuthoritySettings(base(mode));
      expect(r.coerced).toEqual([]);
      expect(r.settings.mode).toBe(mode);
    }
  });
});

describe('Plan 27 gate — a LEGACY floor still ratchets', () => {
  it('a global "plan" floor is not collapsed to rank 1', () => {
    // Someone who chose "plan" in v0.4.0 still has that literal globally.
    // MODE_RANK has no `plan` key, so ranking it raw made the floor
    // `rank['default']` (1) and a repo could set `defaultMode` to `default` —
    // or even `ask-before-edit` — and be accepted with clampedFields [].
    const r = clampSettingsToUserPolicy(
      settings({ mode: 'default' }),
      inspector({ defaultMode: { globalValue: 'plan', workspaceValue: 'default' } }),
    );
    expect(r.clampedFields).toContain('mode');
    expect(r.settings.mode).toBe('quick-plan');
  });

  it('a legacy floor still refuses a workspace trying edit-automatically', () => {
    const r = clampSettingsToUserPolicy(
      settings({ mode: 'edit-automatically' }),
      inspector({ defaultMode: { globalValue: 'plan', workspaceValue: 'edit-automatically' } }),
    );
    expect(r.settings.mode).toBe('quick-plan');
  });

  it('control: a MODERN floor is unaffected by the alias resolution', () => {
    const r = clampSettingsToUserPolicy(
      settings({ mode: 'default' }),
      inspector({ defaultMode: { globalValue: 'quick-plan', workspaceValue: 'default' } }),
    );
    expect(r.settings.mode).toBe('quick-plan');
  });

  it('control: the Plan 23 B1 escape for a NON-ENUM workspace value is unchanged', () => {
    const r = clampSettingsToUserPolicy(
      settings({ mode: 'edit-automatically' }),
      inspector({ defaultMode: { globalValue: 'plan', workspaceValue: 'not-a-mode' } }),
    );
    expect(r.settings.mode).toBe('plan');
  });
});

/**
 * Plan 27 §21.6c #6 (lane N-1) — the lower-only ratchet extended to a boolean
 * and an enum, for `mysti.visualTest.enabled` / `mysti.visualTest.interactions`.
 *
 * Round 3 machine-scoped both, which deletes a repo's ability to LOWER them
 * ("no browser in this project"). The end state is the same one-way ratchet
 * the three clamped settings have. This primitive is the ratchet; the two
 * consumers in ChatViewProvider (`_mystiVisualEnabled`, `_visualPolicyDeps`)
 * must read through it BEFORE the scope moves back to window.
 */
describe('clampVisualTestSettings (Plan 27 N-1)', () => {
  const user = { enabled: true as boolean, interactions: 'safe' as const };

  it('enabled: a workspace cannot RE-ENABLE visual testing for a user who turned it off', () => {
    const r = clampVisualTestSettings(
      { enabled: true, interactions: 'safe' },
      inspector({ 'visualTest.enabled': { workspaceValue: true, globalValue: false } }),
    );
    expect(r.clampedFields).toEqual(['visualTest.enabled']);
    expect(r.settings.enabled).toBe(false);
  });

  it('enabled: a workspace CAN turn it off (the ratchet is one-way, not a wall)', () => {
    const r = clampVisualTestSettings(
      { enabled: false, interactions: 'safe' },
      inspector({ 'visualTest.enabled': { workspaceValue: false, globalValue: true } }),
    );
    expect(r.clampedFields).toEqual([]);
    expect(r.settings.enabled).toBe(false);
  });

  it('enabled: the floor is the user\'s EXPLICIT global value, else the declared default (true)', () => {
    // No global value: default true, workspace true ⇒ nothing to clamp.
    const r = clampVisualTestSettings(
      { enabled: true, interactions: 'safe' },
      inspector({ 'visualTest.enabled': { workspaceValue: true, defaultValue: true } }),
    );
    expect(r.clampedFields).toEqual([]);
    expect(r.settings.enabled).toBe(true);
  });

  it('enabled: a non-boolean workspace value lands on the user floor, never on "on"', () => {
    const r = clampVisualTestSettings(
      { enabled: true, interactions: 'safe' },
      inspector({ 'visualTest.enabled': { workspaceValue: 'yes', globalValue: false } }),
    );
    expect(r.settings.enabled).toBe(false);
    expect(r.clampedFields).toEqual(['visualTest.enabled']);
  });

  it('interactions: a workspace cannot raise the human ceiling (safe → full loses)', () => {
    const r = clampVisualTestSettings(
      { enabled: true, interactions: 'full' },
      inspector({ 'visualTest.interactions': { workspaceValue: 'full', globalValue: 'safe' } }),
    );
    expect(r.clampedFields).toEqual(['visualTest.interactions']);
    expect(r.settings.interactions).toBe('safe');
  });

  it('interactions: a workspace cannot raise off → safe either (the declared default is not a free pass)', () => {
    const r = clampVisualTestSettings(
      { enabled: true, interactions: 'safe' },
      inspector({ 'visualTest.interactions': { workspaceValue: 'safe', globalValue: 'off' } }),
    );
    expect(r.clampedFields).toEqual(['visualTest.interactions']);
    expect(r.settings.interactions).toBe('off');
  });

  it('interactions: a workspace CAN lower it (full → off wins)', () => {
    const r = clampVisualTestSettings(
      { enabled: true, interactions: 'off' },
      inspector({ 'visualTest.interactions': { workspaceValue: 'off', globalValue: 'full' } }),
    );
    expect(r.clampedFields).toEqual([]);
    expect(r.settings.interactions).toBe('off');
  });

  it('interactions: a value outside the enum is coerced to the user floor (Plan 23 B1 rule)', () => {
    const r = clampVisualTestSettings(
      { enabled: true, interactions: 'unrestricted' as unknown as 'safe' },
      inspector({ 'visualTest.interactions': { workspaceValue: 'unrestricted', globalValue: 'safe' } }),
    );
    expect(r.settings.interactions).toBe('safe');
    expect(r.clampedFields).toEqual(['visualTest.interactions']);
  });

  it('the enum order is the declared package.json order, low → high', () => {
    // 'off' < 'safe' < 'full' is exactly `mysti.visualTest.interactions.enum`;
    // the ratchet reads authority off that order.
    expect([...VISUAL_INTERACTION_LEVELS]).toEqual(['off', 'safe', 'full']);
  });

  it('no inspection data ⇒ untouched, and the object identity is preserved', () => {
    const current = { ...user };
    const r = clampVisualTestSettings(current, () => undefined);
    expect(r.clampedFields).toEqual([]);
    expect(r.settings).toBe(current);
  });

  it('inspects exactly the two visualTest sections and nothing else', () => {
    const asked: string[] = [];
    clampVisualTestSettings({ ...user }, (s) => { asked.push(s); return undefined; });
    expect(asked.sort()).toEqual(['visualTest.enabled', 'visualTest.interactions']);
  });
});
