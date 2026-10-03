/**
 * Plan 23 B1 — the permission gate must fail CLOSED.
 *
 * `shouldGateToolUse` decides by comparing against string literals and used to
 * end in a bare `return false`, so any mode/accessLevel it did not recognize
 * landed on the permissive outcome. That matters more than it sounds: every CLI
 * provider runs with its native permissions bypassed, and the `@mysti`
 * coordinator calls straight into this function with no CLI beneath it.
 *
 * The reachable trigger needed no attacker — `package.json` offered a
 * `defaultMode` value (`"plan"`) that `OperationMode` does not contain.
 */
import { describe, it, expect } from 'vitest';
import { shouldGateToolUse } from '../../src/utils/permissionClassifier';
import {
  normalizeAuthoritySettings,
  ACCESS_LEVELS,
  OPERATION_MODES,
} from '../../src/utils/settingsClamp';
import type { Settings, AccessLevel, OperationMode } from '../../src/types';

const base = (mode: string, accessLevel: string): Settings => ({
  provider: 'claude-code',
  model: '',
  mode: mode as OperationMode,
  thinkingLevel: 'none',
  effortLevel: 'high',
  accessLevel: accessLevel as AccessLevel,
  contextMode: 'auto',
  autonomousMode: false,
} as Settings);

// A write is the interesting case: never-gated reads short-circuit earlier.
const WRITE_TOOL = 'Write';

describe('unrecognized authority values gate, rather than falling through', () => {
  const JUNK_ACCESS = ['Ask-Permission', 'full access', 'FULL-ACCESS', '', 'yolo', 'undefined'];
  const JUNK_MODE = ['plan', 'Plan', 'auto', 'edit_automatically', '', 'agent'];

  it('gates for every junk accessLevel, across every known mode', () => {
    for (const access of JUNK_ACCESS) {
      for (const mode of OPERATION_MODES) {
        expect(
          shouldGateToolUse(base(mode, access), WRITE_TOOL),
          `accessLevel="${access}" mode="${mode}" must gate`
        ).toBe(true);
      }
    }
  });

  it('gates for every junk mode, across every known accessLevel', () => {
    for (const mode of JUNK_MODE) {
      for (const access of ACCESS_LEVELS) {
        expect(
          shouldGateToolUse(base(mode, access), WRITE_TOOL),
          `mode="${mode}" accessLevel="${access}" must gate`
        ).toBe(true);
      }
    }
  });

  it('gates the specific value the settings UI used to offer', () => {
    // `"plan"` was in package.json's enum and is not an OperationMode.
    expect(shouldGateToolUse(base('plan', 'full-access'), WRITE_TOOL)).toBe(true);
    expect(shouldGateToolUse(base('plan', 'ask-permission'), WRITE_TOOL)).toBe(true);
  });
});

describe('known combinations are unchanged', () => {
  // The fix must not quietly tighten real tiers — that would be its own bug,
  // and would show up as users being asked in modes they deliberately chose.
  it('ask-before-edit always gates', () => {
    for (const access of ACCESS_LEVELS) {
      expect(shouldGateToolUse(base('ask-before-edit', access), WRITE_TOOL)).toBe(true);
    }
  });

  it('full-access + edit-automatically does not gate', () => {
    expect(shouldGateToolUse(base('edit-automatically', 'full-access'), WRITE_TOOL)).toBe(false);
  });

  it('edit-automatically + ask-permission gates commands but not plain edits', () => {
    const s = base('edit-automatically', 'ask-permission');
    expect(shouldGateToolUse(s, 'Bash')).toBe(true);
    expect(shouldGateToolUse(s, WRITE_TOOL)).toBe(false);
  });

  it('reads are never gated, whatever the settings say', () => {
    expect(shouldGateToolUse(base('ask-before-edit', 'read-only'), 'Read')).toBe(false);
    expect(shouldGateToolUse(base('junk', 'junk'), 'Read')).toBe(false);
  });
});

describe('normalizeAuthoritySettings', () => {
  it('coerces unknown values and reports what it changed', () => {
    const res = normalizeAuthoritySettings(base('plan', 'Ask-Permission'));
    // Plan 27 A-1: 'plan' is not merely "unknown" — it was v0.4.0's MOST
    // restrictive selectable value, so it migrates to 'quick-plan' (MODE_RANK 3),
    // never down to 'default' (MODE_RANK 1, which writes). See
    // LEGACY_MODE_ALIASES and settingsClamp.test.ts.
    expect(res.settings.mode).toBe('quick-plan');
    expect(res.settings.accessLevel).toBe('ask-permission');
    expect(res.coerced.join(' ')).toContain('plan');
    expect(res.coerced.join(' ')).toContain('Ask-Permission');
  });

  it('coerces to ASK, not to read-only', () => {
    // The safe failure is "the user gets asked", not "nothing works" — falling
    // to read-only would turn a typo into a broken install.
    expect(normalizeAuthoritySettings(base('x', 'y')).settings.accessLevel).toBe('ask-permission');
  });

  it('leaves valid settings untouched and reports no coercion', () => {
    for (const mode of OPERATION_MODES) {
      for (const access of ACCESS_LEVELS) {
        const res = normalizeAuthoritySettings(base(mode, access));
        expect(res.coerced).toEqual([]);
        expect(res.settings.mode).toBe(mode);
        expect(res.settings.accessLevel).toBe(access);
      }
    }
  });

  it('a coerced value then gates, end to end', () => {
    const raw = base('plan', 'Full-Access');   // neither is a real member
    const { settings } = normalizeAuthoritySettings(raw);
    expect(shouldGateToolUse(settings, WRITE_TOOL)).toBe(true);
  });
});
