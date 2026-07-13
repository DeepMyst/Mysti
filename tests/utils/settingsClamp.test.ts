/**
 * Workspace-settings clamp (Plan 17 P0.7b) — a repo's .vscode/settings.json
 * may only LOWER Mysti's authority, never raise it above the user's policy.
 */
import { describe, it, expect } from 'vitest';
import { clampSettingsToUserPolicy, clampSafetyMode, type SettingInspection } from '../../src/utils/settingsClamp';
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
