import { describe, it, expect, beforeEach } from 'vitest';
import { TestableGeminiProvider } from '../../helpers/providerFactory';
import { createGeminiSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';

function s(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default', thinkingLevel: 'none', accessLevel: 'ask-permission',
    contextMode: 'auto', model: '', provider: 'google-gemini', ...overrides,
  };
}

describe('Gemini permission flag mapping', () => {
  let provider: TestableGeminiProvider;

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableGeminiProvider();
  });

  it.each([
    ['quick-plan'],
    ['detailed-plan'],
  ] as const)('should use --sandbox for %s mode', (mode) => {
    const args = provider.buildCliArgs(s({ mode }), createGeminiSession());
    expect(args).toContain('--sandbox');
    expect(args).not.toContain('--yolo');
  });

  it('should use --sandbox for read-only access', () => {
    const args = provider.buildCliArgs(s({ accessLevel: 'read-only' }), createGeminiSession());
    expect(args).toContain('--sandbox');
    expect(args).not.toContain('--yolo');
  });

  it.each([
    { mode: 'edit-automatically' as const, accessLevel: 'full-access' as const },
    { mode: 'default' as const, accessLevel: 'full-access' as const },
    { mode: 'default' as const, accessLevel: 'ask-permission' as const },
    { mode: 'ask-before-edit' as const, accessLevel: 'ask-permission' as const },
  ])('should use --yolo for mode=$mode access=$accessLevel', ({ mode, accessLevel }) => {
    const args = provider.buildCliArgs(s({ mode, accessLevel }), createGeminiSession());
    expect(args).toContain('--yolo');
    expect(args).not.toContain('--sandbox');
  });
});
