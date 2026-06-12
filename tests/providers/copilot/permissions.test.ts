import { describe, it, expect, beforeEach } from 'vitest';
import { TestableCopilotProvider } from '../../helpers/providerFactory';
import { createCopilotSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';

function s(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default', thinkingLevel: 'none', accessLevel: 'ask-permission',
    contextMode: 'auto', model: '', provider: 'github-copilot', ...overrides,
  };
}

describe('Copilot permission flag mapping', () => {
  let provider: TestableCopilotProvider;

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableCopilotProvider();
  });

  it.each([
    ['quick-plan'],
    ['detailed-plan'],
  ] as const)('should deny shell and write tools for %s mode', (mode) => {
    const args = provider.buildCliArgs(s({ mode }), createCopilotSession());
    expect(args).toContain('--deny-tool');
    expect(args).toContain('shell');
    expect(args).toContain('write');
    expect(args).not.toContain('--allow-all-tools');
  });

  it('should deny shell and write tools for read-only access', () => {
    const args = provider.buildCliArgs(s({ accessLevel: 'read-only' }), createCopilotSession());
    expect(args).toContain('--deny-tool');
    expect(args).toContain('shell');
    expect(args).toContain('write');
    expect(args).not.toContain('--allow-all-tools');
  });

  // Auto-approve ONLY where the stream gate is intentionally off
  // (mirrors shouldGateToolUse — Copilot emits plain text, so the gate can
  // never fire and allow-all elsewhere would mean zero approval anywhere).
  it.each([
    { mode: 'edit-automatically' as const, accessLevel: 'full-access' as const },
    { mode: 'edit-automatically' as const, accessLevel: 'ask-permission' as const },
    { mode: 'default' as const, accessLevel: 'full-access' as const },
  ])('should use --allow-all-tools for mode=$mode access=$accessLevel (gate intentionally off)', ({ mode, accessLevel }) => {
    const args = provider.buildCliArgs(s({ mode, accessLevel }), createCopilotSession());
    expect(args).toContain('--allow-all-tools');
    expect(args).not.toContain('--deny-tool');
  });

  // Ask-tier combos: deny-by-default (fail closed) — the CLI cannot prompt
  // and the stream gate never sees tool_use chunks from plain-text output.
  it.each([
    { mode: 'default' as const, accessLevel: 'ask-permission' as const },
    { mode: 'ask-before-edit' as const, accessLevel: 'ask-permission' as const },
    { mode: 'ask-before-edit' as const, accessLevel: 'full-access' as const },
  ])('should deny shell/write for ask-tier mode=$mode access=$accessLevel (fail closed)', ({ mode, accessLevel }) => {
    const args = provider.buildCliArgs(s({ mode, accessLevel }), createCopilotSession());
    expect(args).toContain('--deny-tool');
    expect(args).toContain('shell');
    expect(args).toContain('write');
    expect(args).not.toContain('--allow-all-tools');
  });
});
