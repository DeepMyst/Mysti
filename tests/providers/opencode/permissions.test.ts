import { describe, it, expect, beforeEach } from 'vitest';
import { TestableOpenCodeProvider } from '../../helpers/providerFactory';
import { createOpenCodeSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';

function s(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default', thinkingLevel: 'none', accessLevel: 'ask-permission',
    contextMode: 'auto', model: '', provider: 'opencode', ...overrides,
  };
}

describe('OpenCode permission flag mapping', () => {
  let provider: TestableOpenCodeProvider;

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableOpenCodeProvider();
  });

  it.each(['quick-plan', 'detailed-plan'] as const)('rejects unsupported local %s before dispatch', mode => {
    expect(() => provider.buildCliArgs(s({ mode }), createOpenCodeSession())).toThrow(/OpenCode CLI cannot enforce.*native approvals/);
  });

  it('rejects unsupported local read-only access', () => {
    expect(() => provider.buildCliArgs(s({ accessLevel: 'read-only' }), createOpenCodeSession())).toThrow(/OpenCode CLI cannot enforce.*native approvals/);
  });

  it.each([
    { mode: 'default' as const, accessLevel: 'full-access' as const },
    { mode: 'default' as const, accessLevel: 'ask-permission' as const },
    { mode: 'edit-automatically' as const, accessLevel: 'full-access' as const },
    { mode: 'ask-before-edit' as const, accessLevel: 'ask-permission' as const },
  ])('honors or explicitly rejects mode=$mode access=$accessLevel', ({ mode, accessLevel }) => {
    if (accessLevel !== 'full-access') {
      expect(() => provider.buildCliArgs(s({ mode, accessLevel }), createOpenCodeSession())).toThrow(/native approvals/);
      return;
    }
    const args = provider.buildCliArgs(s({ mode, accessLevel }), createOpenCodeSession());
    expect(args).toContain('--agent');
    expect(args).toContain('build');
  });
});
