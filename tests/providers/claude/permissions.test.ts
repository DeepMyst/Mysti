import { describe, it, expect, beforeEach } from 'vitest';
import { TestableClaudeProvider } from '../../helpers/providerFactory';
import { createClaudeSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';

function s(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default', thinkingLevel: 'none', accessLevel: 'ask-permission',
    contextMode: 'auto', model: '', provider: 'claude-code', ...overrides,
  };
}

describe('Claude permission flag mapping', () => {
  let provider: TestableClaudeProvider;

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableClaudeProvider();
  });

  // Plan modes → --permission-mode plan
  it.each([
    ['quick-plan'],
    ['detailed-plan'],
  ] as const)('should use --permission-mode plan for %s mode', (mode) => {
    const args = provider.buildCliArgs(s({ mode }), createClaudeSession());
    expect(args).toContain('--permission-mode');
    expect(args).toContain('plan');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  // Read-only → --permission-mode plan
  it('should use --permission-mode plan for read-only access', () => {
    const args = provider.buildCliArgs(s({ accessLevel: 'read-only' }), createClaudeSession());
    expect(args).toContain('--permission-mode');
    expect(args).toContain('plan');
  });

  // All non-plan, non-read-only → --dangerously-skip-permissions
  it.each([
    { mode: 'default' as const, accessLevel: 'ask-permission' as const },
    { mode: 'default' as const, accessLevel: 'full-access' as const },
    { mode: 'edit-automatically' as const, accessLevel: 'full-access' as const },
    { mode: 'edit-automatically' as const, accessLevel: 'ask-permission' as const },
    { mode: 'ask-before-edit' as const, accessLevel: 'ask-permission' as const },
    { mode: 'ask-before-edit' as const, accessLevel: 'full-access' as const },
  ])('should use --dangerously-skip-permissions for mode=$mode access=$accessLevel', ({ mode, accessLevel }) => {
    const args = provider.buildCliArgs(s({ mode, accessLevel }), createClaudeSession());
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--permission-mode');
  });
});
