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

  // Plan 18 (4.3): read-only/plan maps to the CLI's documented read-only mode
  // `--approval-mode plan` — NOT `--sandbox`, which is a container/seatbelt
  // boolean that can hard-fail to spawn where no container runtime exists.
  it.each([
    ['quick-plan'],
    ['detailed-plan'],
  ] as const)('should use --approval-mode plan for %s mode', (mode) => {
    const args = provider.buildCliArgs(s({ mode }), createGeminiSession());
    expect(args.join(' ')).toContain('--approval-mode plan');
    expect(args).not.toContain('--yolo');
    expect(args).not.toContain('--sandbox');
  });

  it('should use --approval-mode plan for read-only access', () => {
    const args = provider.buildCliArgs(s({ accessLevel: 'read-only' }), createGeminiSession());
    expect(args.join(' ')).toContain('--approval-mode plan');
    expect(args).not.toContain('--yolo');
    expect(args).not.toContain('--sandbox');
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
    expect(args).not.toContain('--approval-mode');
  });
});
