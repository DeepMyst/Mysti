/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 27 A-2 — make the settings-authority lists BINDING.
 *
 * `settingsClamp.ts` exports two hand-maintained lists, `CLAMPED_SETTINGS` and
 * `AUTHORITY_BEARING_SETTINGS`. Until this file existed, `AUTHORITY_BEARING_SETTINGS`
 * was referenced by nothing at all: it documented an invariant that no code and
 * no test enforced, which is strictly worse than having no list, because it
 * reads like a guarantee.
 *
 * The invariant, in one sentence: **every setting that can raise Mysti's
 * authority, widen its egress, or put attacker-chosen text into a model's
 * instruction surface is EITHER machine-scoped (so a repository's
 * `.vscode/settings.json` cannot set it at all) OR clamped at runtime (so a
 * workspace value may only LOWER authority). There is no third option.**
 *
 * This file checks that in both directions, checks the clamp list against what
 * the clamp functions actually do rather than against a comment, and derives
 * the scope rules from key SHAPE so that a sixteenth provider fails here rather
 * than shipping open.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import {
  CLAMPED_SETTINGS,
  AUTHORITY_BEARING_SETTINGS,
  clampSettingsToUserPolicy,
  clampSafetyMode,
  type SettingInspection,
} from '../../src/utils/settingsClamp';
import { MODEL_NAME_PATTERN, MODEL_NAME_MAX_LENGTH } from '../../src/utils/validation';
import type { Settings } from '../../src/types';

const ROOT = path.resolve(__dirname, '..', '..');

/** `application` is stricter than `machine`; both deny the workspace scope. */
const WORKSPACE_DENYING = new Set(['machine', 'application']);

interface ConfigProp { scope?: string; type?: string; description?: string; markdownDescription?: string }

function configProperties(): Record<string, ConfigProp> {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const cfg = pkg.contributes.configuration;
  return Array.isArray(cfg)
    ? Object.assign({}, ...cfg.map((c: { properties: object }) => c.properties))
    : cfg.properties;
}

const props = configProperties();
const declared = new Set(Object.keys(props));

function deniesWorkspace(key: string): boolean {
  return WORKSPACE_DENYING.has(props[key]?.scope ?? '');
}

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

describe('authority-bearing settings are machine-scoped OR clamped (Plan 27 A-2)', () => {
  it('sanity: package.json still declares a full configuration block', () => {
    expect(declared.size).toBeGreaterThan(100);
    expect(AUTHORITY_BEARING_SETTINGS.length).toBeGreaterThan(40);
  });

  it('every authority-bearing setting is actually declared in package.json', () => {
    // A list entry that names nothing is a list entry that protects nothing.
    const missing = AUTHORITY_BEARING_SETTINGS.filter(k => !declared.has(k));
    expect(missing, `AUTHORITY_BEARING_SETTINGS names settings package.json does not declare: ${missing.join(', ')}`).toEqual([]);
  });

  it('every authority-bearing setting is machine-scoped OR clamped — never neither', () => {
    const clamped = new Set(CLAMPED_SETTINGS);
    const open = AUTHORITY_BEARING_SETTINGS.filter(k => !deniesWorkspace(k) && !clamped.has(k));
    expect(
      open,
      'These settings can raise authority and a repo can set them: '
      + open.map(k => `${k} (scope: ${JSON.stringify(props[k]?.scope ?? null)})`).join(', '),
    ).toEqual([]);
  });

  it('every clamped setting is listed as authority-bearing (the reverse direction)', () => {
    const bearing = new Set(AUTHORITY_BEARING_SETTINGS);
    const orphans = CLAMPED_SETTINGS.filter(k => !bearing.has(k));
    expect(orphans, `clamped but not listed as authority-bearing: ${orphans.join(', ')}`).toEqual([]);
  });

  it('every clamped setting is declared in package.json', () => {
    const missing = CLAMPED_SETTINGS.filter(k => !declared.has(k));
    expect(missing, `CLAMPED_SETTINGS names settings package.json does not declare: ${missing.join(', ')}`).toEqual([]);
  });
});

/**
 * A list that drifts from the implementation is worse than no list. These drive
 * the real clamp functions with a workspace value that tries to RAISE authority
 * above the user's own, and assert it loses. If someone deletes a clamp but
 * leaves its name in CLAMPED_SETTINGS, this is what catches it.
 */
describe('CLAMPED_SETTINGS matches what the clamp functions actually ratchet', () => {
  it('mysti.accessLevel: a workspace cannot raise it above the user value', () => {
    const r = clampSettingsToUserPolicy(
      settings({ accessLevel: 'full-access' }),
      inspector({ accessLevel: { workspaceValue: 'full-access', globalValue: 'ask-permission' } }),
    );
    expect(r.clampedFields).toContain('accessLevel');
    expect(r.settings.accessLevel).toBe('ask-permission');
  });

  it('mysti.accessLevel: a workspace CAN still lower it (the ratchet is one-way, not a wall)', () => {
    const r = clampSettingsToUserPolicy(
      settings({ accessLevel: 'read-only' }),
      inspector({ accessLevel: { workspaceValue: 'read-only', globalValue: 'full-access' } }),
    );
    expect(r.clampedFields).toEqual([]);
    expect(r.settings.accessLevel).toBe('read-only');
  });

  it('mysti.defaultMode: a workspace cannot raise it above the user value', () => {
    const r = clampSettingsToUserPolicy(
      settings({ mode: 'edit-automatically' }),
      inspector({ defaultMode: { workspaceValue: 'edit-automatically', globalValue: 'ask-before-edit' } }),
    );
    expect(r.clampedFields).toContain('mode');
    expect(r.settings.mode).toBe('ask-before-edit');
  });

  it('mysti.defaultMode: a workspace CAN still lower it', () => {
    const r = clampSettingsToUserPolicy(
      settings({ mode: 'quick-plan' }),
      inspector({ defaultMode: { workspaceValue: 'quick-plan', globalValue: 'edit-automatically' } }),
    );
    expect(r.clampedFields).toEqual([]);
    expect(r.settings.mode).toBe('quick-plan');
  });

  it('mysti.autonomous.safetyMode: a workspace cannot make it more aggressive', () => {
    const r = clampSafetyMode(
      'aggressive',
      inspector({ 'autonomous.safetyMode': { workspaceValue: 'aggressive', globalValue: 'conservative' } }),
    );
    expect(r.clamped).toBe(true);
    expect(r.value).toBe('conservative');
  });

  it('mysti.autonomous.safetyMode: a workspace CAN still make it more conservative', () => {
    const r = clampSafetyMode(
      'conservative',
      inspector({ 'autonomous.safetyMode': { workspaceValue: 'conservative', globalValue: 'aggressive' } }),
    );
    expect(r.clamped).toBe(false);
    expect(r.value).toBe('conservative');
  });

  it('the clamp covers exactly the three settings CLAMPED_SETTINGS names', () => {
    // The package.json key -> the section name the clamp actually inspects.
    // A fourth clamped setting must be added here (and to CLAMPED_SETTINGS)
    // together, or this fails.
    const sections: Record<string, string> = {
      'mysti.accessLevel': 'accessLevel',
      'mysti.defaultMode': 'defaultMode',
      'mysti.autonomous.safetyMode': 'autonomous.safetyMode',
    };
    expect(Object.keys(sections).sort()).toEqual([...CLAMPED_SETTINGS].sort());

    // And nothing outside those sections is inspected: hand clampSettingsToUserPolicy
    // an inspector that records every section it is asked about.
    const asked: string[] = [];
    clampSettingsToUserPolicy(settings(), (s) => { asked.push(s); return undefined; });
    clampSafetyMode('balanced', (s) => { asked.push(s); return undefined; });
    expect(asked.sort()).toEqual(Object.values(sections).sort());
  });
});

/**
 * The three clamped settings stay WINDOW-scoped, on purpose.
 *
 * "Hardening" them to `machine` would look like an improvement and would in
 * fact DELETE the behaviour worth keeping: a workspace has a legitimate reason
 * to make Mysti *stricter* for one repo ("this project is read-only"), and the
 * clamp is what makes that a one-way ratchet rather than an escalation path.
 * Machine-scoping them removes the ability to lower authority per repo and
 * leaves the clamp dead code. Do not change these to machine.
 */
describe('the three clamped settings remain window-scoped (do not "harden" these)', () => {
  for (const key of ['mysti.accessLevel', 'mysti.defaultMode', 'mysti.autonomous.safetyMode']) {
    it(`${key} is window-scoped so a repo can still LOWER authority`, () => {
      expect(props[key], `${key} must be declared`).toBeDefined();
      expect(
        WORKSPACE_DENYING.has(props[key].scope ?? ''),
        `${key} was machine-scoped. That deletes "a workspace may only LOWER authority" `
        + 'and makes clampSettingsToUserPolicy/clampSafetyMode unreachable. See the '
        + 'comment on CLAMPED_SETTINGS before changing this.',
      ).toBe(false);
    });
  }
});

/**
 * Shape-derived scope rules. These are deliberately NOT hand-lists: a
 * sixteenth provider adds `mysti.agents.<x>Persona`, `mysti.agents.<x>CustomPrompt`
 * and `mysti.<x>Path` in one commit, and must fail HERE rather than ship open.
 */
describe('no setting is declared and read by nothing (Plan 27 §24 Tier A)', () => {
  /**
   * A declared setting that nothing reads is worse than no setting: it appears
   * in the Settings UI, invites the user to change it, and silently does
   * nothing. Eight were deleted in the Tier A cut — four `canvas.*`, three
   * `desk.*`, and `activeMode.showActivityFeed`.
   *
   * This pins the DELETIONS so they cannot drift back, and — more usefully —
   * catches the next one at the moment it is added. The scanner below is the
   * repo-wide one already used for read-but-undeclared, run in reverse.
   */
  const DELETED = [
    'mysti.canvas.autoSave',
    'mysti.canvas.defaultVariantCount',
    'mysti.canvas.stitchDeviceType',
    'mysti.canvas.stitchVariantCount',
    'mysti.desk.bind',
    'mysti.desk.maxDeskCalls',
    'mysti.desk.shareCeiling',
    'mysti.activeMode.showActivityFeed',
  ];

  it('the eight Tier A settings stay deleted', () => {
    const back = DELETED.filter((k) => k in props);
    expect(
      back,
      'these were removed because NOTHING read them. If one is genuinely needed now, wire a read '
      + 'in the same commit that re-declares it, then delete it from this list.',
    ).toEqual([]);
  });

  it('re-declaring one without wiring a read fails here', () => {
    // Proves the guard above is a real check and not a tautology: the same
    // predicate, applied to a key that IS declared, must see it.
    expect('mysti.defaultAgent' in props).toBe(true);
  });
});

describe('scope rules derived from key shape', () => {
  const shapes: Array<{ name: string; re: RegExp; min: number; why: string }> = [
    {
      name: '*CustomPrompt',
      re: /^mysti\.agents\..*CustomPrompt$/,
      min: 14,
      why: 'Arbitrary text spliced into the system prompt. A repo that can set this owns the instruction surface.',
    },
    {
      name: '*Persona',
      re: /^mysti\.agents\..*Persona$/,
      min: 14,
      why: 'Selects which instructions get spliced into the system prompt.',
    },
    {
      name: '*Endpoint',
      re: /Endpoint$/,
      min: 2,
      why: 'A repo-settable endpoint redirects every prompt (and any paired API key) to a host of its choosing.',
    },
    {
      name: '*Path',
      re: /Path$/,
      min: 12,
      why: 'A repo must never choose which binary Mysti spawns — that is code execution on open.',
    },
    {
      name: '*ApiKey',
      re: /ApiKey$/,
      min: 2,
      why: 'A credential set by a repo can be committed to that repo.',
    },
  ];

  for (const shape of shapes) {
    it(`every ${shape.name} setting denies the workspace scope`, () => {
      const keys = Object.keys(props).filter(k => shape.re.test(k));
      // If the roster collapses, the filter broke — that would silently pass.
      expect(keys.length, `${shape.name} matched ${keys.length} settings; the filter looks broken`)
        .toBeGreaterThanOrEqual(shape.min);
      const open = keys.filter(k => !deniesWorkspace(k));
      expect(open, `${open.join(', ')} — ${shape.why}`).toEqual([]);
    });
  }

  it('Persona and CustomPrompt cover the same agent roster', () => {
    const agents = (suffix: string) => Object.keys(props)
      .filter(k => k.startsWith('mysti.agents.') && k.endsWith(suffix))
      .map(k => k.slice('mysti.agents.'.length, -suffix.length))
      .sort();
    // A provider that got one but not the other is a half-wired provider.
    expect(agents('Persona')).toEqual(agents('CustomPrompt'));
  });

  it('every mysti.agents.*Persona / *CustomPrompt is listed as authority-bearing', () => {
    const bearing = new Set(AUTHORITY_BEARING_SETTINGS);
    const instruction = Object.keys(props).filter(k => /^mysti\.agents\..*(Persona|CustomPrompt)$/.test(k));
    const unlisted = instruction.filter(k => !bearing.has(k));
    expect(
      unlisted,
      `a provider was added without listing its instruction-surface settings: ${unlisted.join(', ')}`,
    ).toEqual([]);
  });
});

/**
 * Plan 27 I-1 — the invariant, derived STRUCTURALLY.
 *
 * The first describe in this file checks `AUTHORITY_BEARING_SETTINGS`, but a
 * hand-written list can only catch what someone remembered to write down:
 * `mysti.visualTest.enabled` (the hard block at visualTestPolicy.ts — a repo
 * could RE-ENABLE it for a user who turned it off), `.interactions` (the human
 * ceiling), `.url` and `mysti.codexProfile` (which of the USER's Codex config
 * layers the CLI runs with — see the N-3 note in settingsClamp.ts: the sandbox
 * itself is always an explicit flag) all shipped workspace-writable while the list advertised
 * an invariant it structurally could not enforce.
 *
 * So the candidate set is now derived from package.json by SHAPE — the
 * namespaces and suffixes where authority lives — and every candidate must be
 * machine/application-scoped, clamped, or carry an explicit, reasoned exemption
 * below. A fifth `mysti.visualTest.*` (or a new `*Profile`) fails HERE, whether
 * or not anyone remembered the list. The list stays as documentation.
 */
describe('authority-shaped namespaces are machine-scoped OR clamped (structural, Plan 27 I-1)', () => {
  /**
   * `tripwire` shapes have NO members today. They exist so that the first
   * `*Token` a future change declares is judged here rather than shipping open;
   * the roster-collapse check is skipped for them, by design.
   */
  const NAMESPACES: Array<{ name: string; re: RegExp; min: number; tripwire?: true }> = [
    { name: 'mysti.visualTest.*', re: /^mysti\.visualTest\./, min: 10 },
    { name: '*Profile', re: /Profile$/, min: 1 },
    { name: '*Endpoint', re: /Endpoint$/, min: 2 },
    { name: '*Path', re: /Path$/, min: 12 },
    { name: '*ApiKey', re: /ApiKey$/, min: 2 },
    { name: 'mysti.agents.*', re: /^mysti\.agents\./, min: 30 },
    { name: 'mysti.autonomous.*', re: /^mysti\.autonomous\./, min: 7 },
    { name: 'mysti.mysti.*', re: /^mysti\.mysti\./, min: 10 },
    { name: 'mysti.desk.*', re: /^mysti\.desk\./, min: 4 },  // 7 -> 4: bind / maxDeskCalls / shareCeiling were declared-and-unread (Plan 27 §24 Tier A).
    // Plan 27 §21.6c #10 (lane N-2): suffix shapes. Until these existed the
    // "a fifth one fails HERE" property held only inside the nine above;
    // `mysti.visualTest.url` was caught by its namespace, not by being a URL.
    { name: '*Url', re: /[Uu]rl$/, min: 5 },
    { name: '*Command', re: /Command$/, min: 2 },
    { name: '*Token', re: /Token$/, min: 0, tripwire: true },
    { name: '*Model(s)', re: /Models?$/, min: 18 },
  ];

  /**
   * Candidates that match a shape but carry NO authority: bounded (enum or
   * min/max) knobs whose worst workspace value is a cosmetic or resource
   * nuisance, never a capability. Every entry needs a reason, and an entry
   * that is also in AUTHORITY_BEARING_SETTINGS is a contradiction (asserted).
   * To add one you must be able to write the sentence.
   */
  const EXEMPT: Record<string, string> = {
    'mysti.visualTest.maxIterations': 'bounded 1..20 iteration cap; a resource knob, not a capability',
    'mysti.visualTest.browser': 'enum of three Playwright engines; which engine renders is not authority',
    'mysti.visualTest.headless': 'a repo forcing a visible browser window is a nuisance, not a capability',
    'mysti.visualTest.viewportWidth': 'bounded 320..3840; per-repo viewports (mobile apps) are legitimate',
    'mysti.visualTest.viewportHeight': 'bounded 240..2160; per-repo viewports (mobile apps) are legitimate',
    'mysti.agents.autoSuggest': 'only toggles the recommendation UI; the user still picks the agent',
    'mysti.agents.maxTokenBudget': 'size cap (0 = unlimited, else <= 16000) on agent content whose TRUST is decided by the loader, not here — a repo can lift the cap, not the trust',
    'mysti.autonomous.maxMemoryEntries': 'bounded 50..5000 capacity of the learning memory; not a decision input',
    'mysti.canvas.stitchModel': 'enum of Stitch model ids; which Stitch model renders a design is not authority',
  };

  /**
   * Open values (a string cannot carry an enum) that are nonetheless not
   * authority, because a MACHINE-scoped sibling bounds them at runtime. The
   * value here is the sibling; the test asserts it exists and denies the
   * workspace scope, so weakening the bound fails HERE too.
   *
   * `mysti.visualTest.url` is the worked example — and a reversal. Plan 27
   * round 3 machine-scoped it; Plan 21 (§ scope hardening) had deliberately
   * left it window-scoped because `visualTestPolicy.ts` refuses any configured
   * URL outside `mysti.visualTest.allowedOrigins` (machine, loopback default)
   * and says so in its error text. The url only picks the port; a repo setting
   * its dev-server port in .vscode/settings.json is the legitimate use.
   */
  const EXTERNALLY_BOUNDED: Record<string, string> = {
    'mysti.visualTest.url': 'mysti.visualTest.allowedOrigins',
  };

  /**
   * Model SELECTORS (Plan 27 N-2). An open string, so neither EXEMPT (which
   * demands a bound) nor EXTERNALLY_BOUNDED (no sibling setting bounds it) —
   * and yet not authority: a model id selects WHICH weights answer, never what
   * they may do. It reaches the backend as one argv element (array spawn; the
   * shell-mode path rejects `SHELL_INJECTION_CHARS` in
   * `BaseCliProvider._isUnsafeShellArg`) or as a JSON field sent to an endpoint
   * that is itself machine-scoped (`*Endpoint`, `mysti.deepmyst.gatewayUrl`).
   * The worst a repo can do is pick an expensive or unavailable model — cost
   * and quality, which is what the user sees in the dropdown, not a
   * capability. The one `*Model(s)` key that is NOT a plain selector,
   * `mysti.customModels` (an object the UI writes only at Global scope, and
   * whose entries `_getPanelModel` accepts WITHOUT `validateModelName`), is
   * machine-scoped and pinned below instead.
   *
   * The reasoning above rests on `MODEL_NAME_PATTERN` rejecting whitespace and
   * shell metacharacters; that fact is asserted in this describe so the class
   * cannot outlive its premise.
   */
  const MODEL_SELECTOR_REASON = 'selects which model answers; argv element or JSON field to a machine-scoped endpoint; cost, not capability';
  const MODEL_SELECTORS: Record<string, string> = {
    'mysti.defaultModel': MODEL_SELECTOR_REASON,
    'mysti.claudeCodeModel': MODEL_SELECTOR_REASON,
    'mysti.codexModel': MODEL_SELECTOR_REASON,
    'mysti.geminiModel': MODEL_SELECTOR_REASON,
    'mysti.clineModel': MODEL_SELECTOR_REASON,
    'mysti.copilotModel': MODEL_SELECTOR_REASON,
    'mysti.cursorModel': MODEL_SELECTOR_REASON,
    'mysti.openclawModel': MODEL_SELECTOR_REASON,
    'mysti.opencodeModel': MODEL_SELECTOR_REASON,
    'mysti.qwenCodeModel': MODEL_SELECTOR_REASON,
    'mysti.ollamaModel': MODEL_SELECTOR_REASON,
    'mysti.localaiModel': MODEL_SELECTOR_REASON,
    'mysti.hermesModel': MODEL_SELECTOR_REASON,
    'mysti.continueModel': MODEL_SELECTOR_REASON,
    'mysti.openrouterModel': MODEL_SELECTOR_REASON,
    'mysti.kimiCodeModel': MODEL_SELECTOR_REASON,
    'mysti.compaction.smart.cheapModel':
      'the summarisation model; a JSON `model` field sent only to the machine-scoped `mysti.deepmyst.gatewayUrl`, '
      + 'metered on the user\'s own entitlement — cost, not capability',
  };

  /**
   * Window-scoped keys OUTSIDE every shape that Plan 27 §21.6c #10 named, each
   * reviewed and kept open for a written reason. The test below keeps the
   * record honest: the key must still be declared with the recorded type and
   * still be workspace-writable — narrowing one means deleting its line here,
   * so the review is redone rather than silently outlived.
   */
  const REVIEWED_OPEN: Record<string, { type: string; why: string }> = {
    'mysti.openclawUseGateway': {
      type: 'boolean',
      why: 'selects between two transports the user already has (Gateway WebSocket at the machine-scoped '
        + '`mysti.openclawGatewayUrl`, or the CLI); neither path has more authority than the other',
    },
    'mysti.commitSignature.enabled': {
      type: 'boolean',
      why: 'badge bookkeeping — tracks that Mysti made a commit; off hides a statistic, on records one; no decision input',
    },
    'mysti.checkpoints.enabled': {
      type: 'boolean',
      why: 'a recovery convenience (pre-turn snapshots into a private repo outside the project). A repo turning it off '
        + 'removes a safety net but does not widen what the agent may write — that is bounded by the clamped '
        + 'accessLevel/defaultMode. Per-repo opt-out (huge monorepos, `checkpoints.maxFiles`) is the legitimate use',
    },
    'mysti.claude.backgroundWaitCeilingMs': {
      type: 'number',
      why: 'how long the headless claude process waits for background subagents (env CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS). '
        + 'Worst case is a slow exit inside PROCESS_TIMEOUT — a resource nuisance, not a capability',
    },
  };

  const clamped = new Set(CLAMPED_SETTINGS);
  const bearing = new Set(AUTHORITY_BEARING_SETTINGS);
  const candidates = Object.keys(props).filter(k => NAMESPACES.some(n => n.re.test(k)));

  it('the shape filters still match a real roster (a collapse would pass silently)', () => {
    for (const n of NAMESPACES) {
      const count = Object.keys(props).filter(k => n.re.test(k)).length;
      if (n.tripwire) {
        // A tripwire with members is no longer a tripwire — promote it to a real shape with a min.
        expect(count, `${n.name} is marked tripwire but matched ${count} settings; give it a real min`).toBe(0);
        continue;
      }
      expect(count, `${n.name} matched ${count} settings; the filter looks broken`).toBeGreaterThanOrEqual(n.min);
    }
  });

  it('every exemption still names a declared candidate, is bounded, and is not authority-bearing', () => {
    for (const [key, why] of Object.entries(EXEMPT)) {
      expect(props[key], `EXEMPT names ${key}, which package.json no longer declares — delete the line`).toBeDefined();
      expect(candidates, `${key} no longer matches any shape — the exemption is dead, delete it`).toContain(key);
      expect(bearing.has(key), `${key} is in AUTHORITY_BEARING_SETTINGS and EXEMPT at once (${why})`).toBe(false);
      const p = props[key] as ConfigProp & { enum?: unknown[]; minimum?: number; maximum?: number };
      const bounded = Array.isArray(p.enum)
        || (typeof p.minimum === 'number' && typeof p.maximum === 'number')
        || p.type === 'boolean';
      expect(bounded, `${key} is exempt but unbounded — an open string/number cannot be "just a knob"`).toBe(true);
    }
  });

  it('every externally-bounded setting names a declared, machine-scoped sibling that bounds it', () => {
    for (const [key, by] of Object.entries(EXTERNALLY_BOUNDED)) {
      expect(props[key], `EXTERNALLY_BOUNDED names ${key}, which package.json no longer declares`).toBeDefined();
      expect(candidates, `${key} no longer matches any shape — the entry is dead, delete it`).toContain(key);
      expect(bearing.has(key), `${key} is in AUTHORITY_BEARING_SETTINGS and EXTERNALLY_BOUNDED at once`).toBe(false);
      expect(props[by], `${key} claims to be bounded by ${by}, which package.json does not declare`).toBeDefined();
      expect(deniesWorkspace(by), `${key} is bounded by ${by}, but ${by} is workspace-writable — the bound is not a bound`).toBe(true);
    }
  });

  it('every model selector is a declared, shape-matched, open STRING that is not authority-bearing or double-classed', () => {
    for (const [key, why] of Object.entries(MODEL_SELECTORS)) {
      expect(props[key], `MODEL_SELECTORS names ${key}, which package.json no longer declares — delete the line`).toBeDefined();
      expect(candidates, `${key} no longer matches any shape — the entry is dead, delete it`).toContain(key);
      expect(props[key].type, `${key} is a model selector but not a string`).toBe('string');
      expect(bearing.has(key), `${key} is in AUTHORITY_BEARING_SETTINGS and MODEL_SELECTORS at once (${why})`).toBe(false);
      expect(key in EXEMPT || key in EXTERNALLY_BOUNDED, `${key} is classed twice`).toBe(false);
      expect(why.length, `${key} needs a written reason`).toBeGreaterThan(20);
    }
    // Every declared *Model string selector is accounted for by SOME class.
    const selectors = Object.keys(props).filter(k => /Models?$/.test(k) && props[k].type === 'string' && !deniesWorkspace(k));
    const unclassed = selectors.filter(k => !(k in MODEL_SELECTORS) && !(k in EXEMPT));
    expect(unclassed, `new *Model selectors need a MODEL_SELECTORS (or enum EXEMPT) entry: ${unclassed.join(', ')}`).toEqual([]);
  });

  it('the premise of MODEL_SELECTORS holds: MODEL_NAME_PATTERN rejects whitespace and shell metacharacters', () => {
    for (const bad of ['a b', 'x;rm -rf /', '$(id)', '`id`', 'a|b', 'a&b', 'a>b', 'a"b', "a'b", 'a\\b', 'a\nb', '--dangerously-skip-permissions']) {
      expect(MODEL_NAME_PATTERN.test(bad), `MODEL_NAME_PATTERN accepted ${JSON.stringify(bad)}`).toBe(false);
    }
    for (const good of ['claude-opus-4-6[1m]', 'owner/model:free', 'gpt-5.5', 'llama3.2']) {
      expect(MODEL_NAME_PATTERN.test(good), `MODEL_NAME_PATTERN rejected ${good}`).toBe(true);
    }
    expect(MODEL_NAME_MAX_LENGTH).toBeLessThanOrEqual(128);
  });

  it('mysti.customModels is machine-scoped (the one *Model(s) key that is not a plain selector)', () => {
    // Written only at ConfigurationTarget.Global by ModelRegistryService; a
    // repo has no legitimate reason to set it, and `_getPanelModel` returns a
    // listed entry without `validateModelName`. Machine scope closes that path.
    const key = 'mysti.customModels';
    expect(props[key]).toBeDefined();
    expect(deniesWorkspace(key), `${key} is workspace-writable again (scope: ${JSON.stringify(props[key]?.scope ?? null)})`).toBe(true);
    expect(key in MODEL_SELECTORS).toBe(false);
  });

  it('mysti.activeMode.autoStartDaemon is machine-scoped AND authority-bearing (it execs `openclaw gateway --detach`)', () => {
    const key = 'mysti.activeMode.autoStartDaemon';
    expect(props[key], `${key} must stay declared — it is read by ActiveModeManager.initialize()`).toBeDefined();
    expect(props[key].default, `${key} must default OFF`).toBe(false);
    expect(deniesWorkspace(key), `${key} is workspace-writable (scope: ${JSON.stringify(props[key]?.scope ?? null)})`).toBe(true);
    expect(bearing.has(key), `${key} turns activation into a spawned process; list it`).toBe(true);
  });

  it('every REVIEWED_OPEN key is still declared with the recorded type, still open, and not authority-bearing', () => {
    for (const [key, { type, why }] of Object.entries(REVIEWED_OPEN)) {
      expect(props[key], `REVIEWED_OPEN names ${key}, which package.json no longer declares — delete the line`).toBeDefined();
      expect(props[key].type, `${key} changed type; redo the review (${why})`).toBe(type);
      expect(deniesWorkspace(key), `${key} was narrowed; delete its REVIEWED_OPEN line so the record stays true`).toBe(false);
      expect(bearing.has(key), `${key} is authority-bearing and REVIEWED_OPEN at once`).toBe(false);
      expect(candidates, `${key} now matches a shape — it belongs in EXEMPT/MODEL_SELECTORS, not REVIEWED_OPEN`).not.toContain(key);
    }
  });

  it('every authority-shaped setting is machine-scoped, clamped, or explicitly exempt — never merely open', () => {
    const open = candidates.filter(k => !deniesWorkspace(k) && !clamped.has(k)
      && !(k in EXEMPT) && !(k in EXTERNALLY_BOUNDED) && !(k in MODEL_SELECTORS));
    expect(
      open,
      'A repository\'s .vscode/settings.json can set these, and their shape says they carry authority. '
      + 'Either add "scope": "machine" in package.json, clamp them, or write an EXEMPT / MODEL_SELECTORS reason: '
      + open.map(k => `${k} (scope: ${JSON.stringify(props[k]?.scope ?? null)})`).join(', '),
    ).toEqual([]);
  });

  it('the three that shipped open are now listed AND machine-scoped (regression pin)', () => {
    for (const key of ['mysti.visualTest.enabled', 'mysti.visualTest.interactions', 'mysti.codexProfile']) {
      expect(bearing.has(key), `${key} dropped from AUTHORITY_BEARING_SETTINGS`).toBe(true);
      expect(deniesWorkspace(key), `${key} is workspace-writable again (scope: ${JSON.stringify(props[key]?.scope ?? null)})`).toBe(true);
    }
  });

  it('mysti.visualTest.url is deliberately window-scoped and bounded by allowedOrigins (pins the round-3 reversal)', () => {
    // Round 3 machine-scoped it; that was reverted — see EXTERNALLY_BOUNDED above.
    // Both directions are pinned: re-narrowing it silently, or dropping the bound.
    const key = 'mysti.visualTest.url';
    expect(deniesWorkspace(key), `${key} was machine-scoped again — per-repo dev-server ports are the legitimate use`).toBe(false);
    expect(bearing.has(key), `${key} is back in AUTHORITY_BEARING_SETTINGS; it is bounded by allowedOrigins, not authority`).toBe(false);
    expect(EXTERNALLY_BOUNDED[key]).toBe('mysti.visualTest.allowedOrigins');
  });
});

/**
 * Settings that are READ at runtime but declared nowhere.
 *
 * A key that `config.get()` reads but package.json does not declare is invisible
 * in the Settings UI, has no scope (so it is workspace-writable by default), and
 * silently falls back to whatever literal the call site passes. Each one is
 * either a rename that was only half-done or dead code.
 *
 * This list is PINNED so it can only ever SHRINK. A new undeclared read fails
 * here. Removing one — by declaring it with a scope, or by deleting the dead
 * read — just means deleting a line below.
 *
 * Why a TEXTUAL scan and not a call-graph one: 61 of the ~190 declared keys are
 * reached through computed access (`agents.${key}Persona`, `${provider}Path`) or
 * through a sub-section handle (`getConfiguration('mysti.canvas').get('x')`), so
 * "declared but never read" is NOT decidable this way and is deliberately not
 * asserted. The one-directional check — "read, therefore must be declared" — is
 * decidable, and it is the direction where the security bug lives.
 */
describe('no NEW read-but-undeclared configuration keys', () => {
  const KNOWN_UNDECLARED: readonly string[] = [
    // ManusProvider is not registered in ProviderRegistry — orphaned code, so
    // these two reads are unreachable. They must not be DECLARED (that would
    // advertise a provider that does not ship); they go when the file does.
    'mysti.manusApiKey',
    'mysti.manusModel',
    // Four more lived here until Plan 27 lane B rewrote the call sites to the
    // keys package.json actually declares (`mysti.defaultMode`,
    // `mysti.defaultModel`, `mysti.accessLevel`; `mysti.autonomous.enabled` was
    // a setting that never existed). They are gone on purpose — a read of
    // `mysti.mode`, `mysti.model`, `mysti.defaultAccessLevel` or
    // `mysti.autonomous.enabled` coming back fails the test above, which is the
    // point.
  ];

  function sourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') { continue; }
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { sourceFiles(p, acc); }
      else if (/\.(ts|js)$/.test(entry.name)) { acc.push(p); }
    }
    return acc;
  }

  /** Every `<section>.<key>` reached through a get/inspect/update call. */
  function readKeys(): Map<string, string[]> {
    const hits = new Map<string, string[]>();
    const record = (key: string, file: string, index: number, text: string) => {
      const line = text.slice(0, index).split('\n').length;
      const at = `${path.relative(ROOT, file)}:${line}`;
      const list = hits.get(key);
      if (list) { if (!list.includes(at)) { list.push(at); } } else { hits.set(key, [at]); }
    };
    for (const file of [...sourceFiles(path.join(ROOT, 'src')), ...sourceFiles(path.join(ROOT, 'media'))]) {
      const text = fs.readFileSync(file, 'utf8');
      // getConfiguration('x').get('y') — either quote style; ClineProvider and
      // CursorProvider read with double quotes.
      for (const m of text.matchAll(
        /getConfiguration\(\s*['"]([^'"]*)['"]\s*\)\s*\.\s*(?:get|inspect|update)(?:<[^>]*>)?\(\s*['"]([^'"]+)['"]/g)) {
        record(`${m[1]}.${m[2]}`, file, m.index ?? 0, text);
      }
      // const cfg = getConfiguration('x'); … cfg.get('y')
      const handles = new Map<string, string>();
      for (const m of text.matchAll(
        /(?:const|let|var)\s+(\w+)\s*=\s*(?:vscode\.)?workspace\.getConfiguration\(\s*['"]([^'"]*)['"]\s*\)/g)) {
        handles.set(m[1], m[2]);
      }
      for (const [name, section] of handles) {
        const re = new RegExp(`\\b${name}\\s*\\.\\s*(?:get|inspect|update)(?:<[^>]*>)?\\(\\s*['"]([^'"]+)['"]`, 'g');
        for (const m of text.matchAll(re)) { record(`${section}.${m[1]}`, file, m.index ?? 0, text); }
      }
    }
    return hits;
  }

  const hits = readKeys();

  it('the scanner still finds the reads it is supposed to scan', () => {
    // If a refactor changes how config is read, this test must fail loudly
    // rather than pass by finding nothing.
    expect(hits.size).toBeGreaterThan(100);
    expect(hits.has('mysti.accessLevel')).toBe(true);
    expect(hits.has('mysti.defaultMode')).toBe(true);
    // Round-3 gate: ClineProvider/CursorProvider read with DOUBLE quotes
    // (`getConfiguration("mysti").get<string>("cursorPath", …)`). A scanner that
    // only matched single quotes was blind to those five reads, so an
    // undeclared double-quoted key could never fail the test below.
    expect(hits.has('mysti.cursorPath')).toBe(true);
    expect(hits.has('mysti.debugVerbose')).toBe(true);
  });

  it('no configuration key is read that package.json does not declare', () => {
    const undeclaredKeys = [...hits.keys()]
      .filter(k => k.startsWith('mysti.') && !declared.has(k))
      .filter(k => !KNOWN_UNDECLARED.includes(k))
      .sort();
    expect(
      undeclaredKeys,
      'These keys are read at runtime but declared nowhere, so they are invisible in the '
      + 'Settings UI and workspace-writable by default: '
      + undeclaredKeys.map(k => `${k} (${hits.get(k)?.slice(0, 2).join(', ')})`).join('; '),
    ).toEqual([]);
  });

  it('the pinned list only ever shrinks', () => {
    // Every pinned entry must still be a real read AND still undeclared.
    // When one is fixed, delete its line — do not leave it here.
    const stale = KNOWN_UNDECLARED.filter(k => !hits.has(k) || declared.has(k));
    expect(
      stale,
      `these are fixed now — delete them from KNOWN_UNDECLARED: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  /**
   * The reverse defect, for the one case where it IS decidable: a setting that
   * was declared (so it showed in the Settings UI) but read by nothing, and
   * whose job is done by another key. `mysti.visualTest.interactionsEnabled`
   * ("Allow AI to interact with the page", window-scoped, default TRUE) was
   * superseded by the machine-scoped, default-OFF `visualTest.agentInteractions`
   * (the model ceiling) and `visualTest.interactions` (the human ceiling);
   * `visualTestPolicy` merely EMITS a `VisualTestConfig.interactionsEnabled`
   * field of the same name. Declared, it told users a default-on AI switch
   * existed that nothing honoured. Plan 27 I-2 deleted it; a re-declaration or
   * a resurrected read fails here.
   */
  it('superseded settings are neither declared nor read', () => {
    for (const key of ['mysti.visualTest.interactionsEnabled']) {
      expect(declared.has(key), `${key} is declared again — it is superseded by visualTest.agentInteractions / .interactions`).toBe(false);
      expect(hits.has(key), `${key} is read again at ${hits.get(key)?.join(', ')}`).toBe(false);
    }
  });
});
