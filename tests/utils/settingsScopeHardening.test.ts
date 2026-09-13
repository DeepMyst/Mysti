/**
 * Plan 21 Phase 0 — a repository must not be able to choose what Mysti runs,
 * where it connects, or which credential it uses.
 *
 * A workspace `.vscode/settings.json` travels with the repo and is applied on
 * open. VSCode's `scope` field is the only thing that stops a workspace value
 * from taking effect: without it a setting is window-scoped and therefore
 * workspace-writable.
 *
 * Twelve executable-path settings shipped unscoped. A cloned repo could point
 * `mysti.claudeCodePath` at a binary inside itself and Mysti would spawn it —
 * code execution on first use, with no prompt. `mysti.openclawGatewayUrl` was
 * the same shape one layer out: retarget the socket and the real `~/.openclaw`
 * operator token is sent to the attacker's host in the connect handshake.
 *
 * `settingsClamp` does NOT cover this class. It clamps `accessLevel`,
 * `defaultMode` and `autonomous.safetyMode` — value-ranking settings where
 * "less restrictive" is meaningful. A path or a URL has no ordering to clamp
 * against, so the only available control is refusing the workspace scope
 * outright.
 *
 * This test is the guard rather than the fix, and it is deliberately derived
 * from key SHAPE (`*Path`, `*ApiKey`) rather than a hand-list, so that a
 * provider added later fails here instead of shipping unscoped.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');

/** `application` is stricter than `machine`; both deny the workspace scope. */
const WORKSPACE_DENYING = new Set(['machine', 'application']);

interface ConfigProp { scope?: string; type?: string }

function configProperties(): Record<string, ConfigProp> {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const cfg = pkg.contributes.configuration;
  return Array.isArray(cfg)
    ? Object.assign({}, ...cfg.map((c: { properties: object }) => c.properties))
    : cfg.properties;
}

function assertDeniesWorkspace(key: string, prop: ConfigProp, why: string): void {
  expect(
    WORKSPACE_DENYING.has(prop.scope ?? ''),
    `${key} is workspace-writable (scope: ${JSON.stringify(prop.scope ?? null)}). ${why}`,
  ).toBe(true);
}

describe('settings scope hardening (Plan 21 Phase 0)', () => {
  const props = configProperties();

  it('declares at least one setting (guards against a shape change in package.json)', () => {
    expect(Object.keys(props).length).toBeGreaterThan(20);
  });

  it('every executable-path setting denies the workspace scope', () => {
    const paths = Object.keys(props).filter(k => /Path$/.test(k));
    // Sanity: the provider roster is large; if this collapses, the filter broke.
    expect(paths.length).toBeGreaterThanOrEqual(12);
    for (const key of paths) {
      assertDeniesWorkspace(
        key, props[key],
        'A repo must never choose which binary Mysti spawns — that is code execution on open.',
      );
    }
  });

  it('every API-key setting denies the workspace scope', () => {
    const keys = Object.keys(props).filter(k => /ApiKey$/.test(k));
    expect(keys.length).toBeGreaterThanOrEqual(2);
    for (const key of keys) {
      assertDeniesWorkspace(
        key, props[key],
        'A credential set by a repo can be committed to that repo.',
      );
    }
  });

  it('endpoint and credential-routing settings deny the workspace scope', () => {
    const named: Record<string, string> = {
      'mysti.openclawGatewayUrl':
        'Retargeting the socket sends the real OpenClaw operator token to the attacker host.',
      'mysti.deepmyst.gatewayUrl':
        'Retargeting the gateway redirects prompts and the dm_ bearer.',
      'mysti.deepmyst.webUrl':
        'Auth and connect flows are opened against this origin.',
      'mysti.deepmyst.useInLocalClis':
        'This injects a live account credential into locally spawned CLIs.',
      'mysti.visualTest.allowedOrigins':
        'This is the allowlist a workspace must not be able to widen.',
      'mysti.mysti.visualTools':
        'The visual-tool kill switch must not be flippable by a cloned repo.',
    };
    for (const [key, why] of Object.entries(named)) {
      expect(props[key], `${key} must be declared in package.json`).toBeDefined();
      assertDeniesWorkspace(key, props[key], why);
    }
  });

  it('no setting under mysti.desk.* is workspace-writable', () => {
    // Plan 21 §8.8: a cloned repo must not be able to enable Desk, name a peer,
    // widen the share ceiling, point at a relay, or raise a budget. Derived from
    // the namespace so a setting added in a later phase fails here rather than
    // shipping open.
    const desk = Object.keys(props).filter(k => k.startsWith('mysti.desk.'));
    expect(desk.length).toBeGreaterThan(0);
    for (const key of desk) {
      assertDeniesWorkspace(
        key, props[key],
        'Desk settings decide what leaves this machine and who may ask.',
      );
    }
  });

  it('every mysti.desk.* setting defaults to off, empty, or the strictest option', () => {
    // A capability that ships on is a capability nobody chose.
    // shareCeiling now gates the owner-prepared workspace lookup snapshot.
    const defaults: Record<string, unknown> = {
      'mysti.desk.enabled': false,
      'mysti.desk.serve': false,
      'mysti.desk.shareCeiling': [],
      'mysti.desk.minRetentionClass': 'zero-retention',
    };
    for (const [key, expected] of Object.entries(defaults)) {
      expect(props[key], `${key} must exist`).toBeDefined();
      expect((props[key] as { default?: unknown }).default, `${key} default`).toEqual(expected);
    }
  });

  it('no setting under mysti.mysti.* is workspace-writable', () => {
    // The coordinator's own spend/permission surface is machine-scoped by
    // policy (CLAUDE.md: "workspace settings may only LOWER authority").
    const coordinator = Object.keys(props).filter(k => k.startsWith('mysti.mysti.'));
    expect(coordinator.length).toBeGreaterThan(0);
    for (const key of coordinator) {
      assertDeniesWorkspace(
        key, props[key],
        'mysti.mysti.* carries spend and permission authority for the coordinator.',
      );
    }
  });
});
