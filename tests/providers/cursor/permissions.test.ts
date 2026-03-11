import { describe, it, expect, beforeEach } from 'vitest';
import { TestableCursorProvider } from '../../helpers/providerFactory';
import { createCursorSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';

function s(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default', thinkingLevel: 'none', accessLevel: 'ask-permission',
    contextMode: 'auto', model: '', provider: 'cursor', ...overrides,
  };
}

describe('Cursor permission flag mapping', () => {
  let provider: TestableCursorProvider;

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableCursorProvider();
  });

  // Plan modes and read-only → no --force
  it.each([
    ['quick-plan'],
    ['detailed-plan'],
  ] as const)('should NOT include --force for %s mode', (mode) => {
    const args = provider.buildCliArgs(s({ mode }), createCursorSession());
    expect(args).not.toContain('--force');
  });

  it('should NOT include --force for read-only access', () => {
    const args = provider.buildCliArgs(s({ accessLevel: 'read-only' }), createCursorSession());
    expect(args).not.toContain('--force');
  });

  // Active modes → --force
  it.each([
    { mode: 'edit-automatically' as const, accessLevel: 'full-access' as const },
    { mode: 'default' as const, accessLevel: 'full-access' as const },
    { mode: 'default' as const, accessLevel: 'ask-permission' as const },
    { mode: 'ask-before-edit' as const, accessLevel: 'ask-permission' as const },
  ])('should include --force for mode=$mode access=$accessLevel', ({ mode, accessLevel }) => {
    const args = provider.buildCliArgs(s({ mode, accessLevel }), createCursorSession());
    expect(args).toContain('--force');
  });
});
