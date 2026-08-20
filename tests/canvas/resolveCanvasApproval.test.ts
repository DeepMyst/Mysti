/**
 * `resolveCanvasApproval` tests (Plan 20 §3.2 item 6) — the one derivation of
 * `'staged' | 'auto'` that replaces the three hardcoded `'auto'` literals in
 * `ChatViewProvider`.
 *
 * The expectation tables below are written out **explicitly** rather than
 * computed from the rules, so a change to the mapping shows up as a diff in the
 * table rather than silently agreeing with itself. Every `OperationMode` ×
 * `AccessLevel` combination appears, twice (autonomous off / on).
 */
import { describe, it, expect } from 'vitest';
import { resolveCanvasApproval } from '../../src/canvas/resolveCanvasApproval';
import type { CanvasApprovalSettings } from '../../src/canvas/resolveCanvasApproval';
import type { AccessLevel, OperationMode } from '../../src/types';

const MODES: OperationMode[] = ['default', 'ask-before-edit', 'edit-automatically', 'quick-plan', 'detailed-plan'];
const ACCESS: AccessLevel[] = ['read-only', 'ask-permission', 'full-access'];

type Verdict = 'staged' | 'auto';

/** mode → { accessLevel → verdict } with `autonomousMode` off. */
const MANUAL: Record<OperationMode, Record<AccessLevel, Verdict>> = {
  'default':            { 'read-only': 'staged', 'ask-permission': 'staged', 'full-access': 'auto' },
  'ask-before-edit':    { 'read-only': 'staged', 'ask-permission': 'staged', 'full-access': 'staged' },
  'edit-automatically': { 'read-only': 'staged', 'ask-permission': 'staged', 'full-access': 'auto' },
  'quick-plan':         { 'read-only': 'staged', 'ask-permission': 'staged', 'full-access': 'staged' },
  'detailed-plan':      { 'read-only': 'staged', 'ask-permission': 'staged', 'full-access': 'staged' },
};

/** Same grid with `autonomousMode: true` — read-only still refuses. */
const AUTONOMOUS: Record<OperationMode, Record<AccessLevel, Verdict>> = {
  'default':            { 'read-only': 'staged', 'ask-permission': 'auto', 'full-access': 'auto' },
  'ask-before-edit':    { 'read-only': 'staged', 'ask-permission': 'auto', 'full-access': 'auto' },
  'edit-automatically': { 'read-only': 'staged', 'ask-permission': 'auto', 'full-access': 'auto' },
  'quick-plan':         { 'read-only': 'staged', 'ask-permission': 'auto', 'full-access': 'auto' },
  'detailed-plan':      { 'read-only': 'staged', 'ask-permission': 'auto', 'full-access': 'auto' },
};

describe('resolveCanvasApproval — full mode × access grid', () => {
  for (const mode of MODES) {
    for (const accessLevel of ACCESS) {
      it(`${mode} + ${accessLevel} → ${MANUAL[mode][accessLevel]}`, () => {
        expect(resolveCanvasApproval({ mode, accessLevel })).toBe(MANUAL[mode][accessLevel]);
        // `autonomousMode: false` must behave exactly like omitting it.
        expect(resolveCanvasApproval({ mode, accessLevel, autonomousMode: false }))
          .toBe(MANUAL[mode][accessLevel]);
      });

      it(`${mode} + ${accessLevel} + autonomous → ${AUTONOMOUS[mode][accessLevel]}`, () => {
        expect(resolveCanvasApproval({ mode, accessLevel, autonomousMode: true }))
          .toBe(AUTONOMOUS[mode][accessLevel]);
      });
    }
  }
});

describe('resolveCanvasApproval — invariants', () => {
  it('never returns auto under read-only, in any mode, autonomous or not', () => {
    for (const mode of MODES) {
      for (const autonomousMode of [undefined, false, true]) {
        expect(resolveCanvasApproval({ mode, accessLevel: 'read-only', autonomousMode })).toBe('staged');
      }
    }
  });

  it('matches the shipped defaults (defaultMode=ask-before-edit, accessLevel=ask-permission)', () => {
    // Today's three hardcoded 'auto' literals contradict this — which is why the
    // prompt promises "your edits apply immediately" to a user who asked to be
    // asked, and why this test exists.
    expect(resolveCanvasApproval({ mode: 'ask-before-edit', accessLevel: 'ask-permission' })).toBe('staged');
  });

  it('agrees with CanvasOpExecutor.submit()\'s own default when nothing is set', () => {
    expect(resolveCanvasApproval({})).toBe('staged');
  });

  it('is pure — the same input always gives the same answer and the input is untouched', () => {
    const settings: CanvasApprovalSettings = { mode: 'edit-automatically', accessLevel: 'full-access' };
    const frozen = Object.freeze({ ...settings });
    expect(resolveCanvasApproval(frozen)).toBe('auto');
    expect(resolveCanvasApproval(frozen)).toBe('auto');
    expect(frozen).toEqual(settings);
  });
});

describe('resolveCanvasApproval — fails closed', () => {
  it('stages an unrecognized access level even in the most permissive mode', () => {
    const settings = { mode: 'edit-automatically', accessLevel: 'godmode' } as unknown as CanvasApprovalSettings;
    expect(resolveCanvasApproval(settings)).toBe('staged');
  });

  it('stages an unrecognized mode even at full-access', () => {
    const settings = { mode: 'plan', accessLevel: 'full-access' } as unknown as CanvasApprovalSettings;
    // `package.json`'s `mysti.defaultMode` enum still lists a legacy `plan`
    // value that is not an OperationMode — it must not read as permissive.
    expect(resolveCanvasApproval(settings)).toBe('staged');
  });

  it('stages when the mode is absent', () => {
    expect(resolveCanvasApproval({ accessLevel: 'full-access' })).toBe('staged');
  });

  it('does not let an unrecognized access level be escalated by autonomous', () => {
    const settings = { mode: 'default', accessLevel: '' } as unknown as CanvasApprovalSettings;
    expect(resolveCanvasApproval({ ...settings, autonomousMode: true })).toBe('staged');
  });

  it('only a literal true escalates — a truthy non-boolean does not', () => {
    const settings = {
      mode: 'ask-before-edit',
      accessLevel: 'ask-permission',
      autonomousMode: 'true',
    } as unknown as CanvasApprovalSettings;
    expect(resolveCanvasApproval(settings)).toBe('staged');
  });

  it('survives an absent settings object', () => {
    expect(resolveCanvasApproval(undefined as unknown as CanvasApprovalSettings)).toBe('staged');
    expect(resolveCanvasApproval(null as unknown as CanvasApprovalSettings)).toBe('staged');
  });
});
