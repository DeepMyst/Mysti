import { describe, it, expect, beforeEach } from 'vitest';
import { TestableClineProvider } from '../../helpers/providerFactory';
import { createClineSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';

function s(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default', thinkingLevel: 'none', accessLevel: 'ask-permission',
    contextMode: 'auto', model: '', provider: 'cline', ...overrides,
  };
}

describe('Cline permission flag mapping', () => {
  let provider: TestableClineProvider;

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableClineProvider();
  });

  it.each([
    ['quick-plan'],
    ['detailed-plan'],
  ] as const)('should use --mode plan (no --yolo) for %s', (mode) => {
    const args = provider.buildCliArgs(s({ mode }), createClineSession());
    expect(args).toContain('--mode');
    expect(args).toContain('plan');
    expect(args).not.toContain('--yolo');
  });

  it('should use --mode plan for read-only access', () => {
    const args = provider.buildCliArgs(s({ accessLevel: 'read-only' }), createClineSession());
    expect(args).toContain('--mode');
    expect(args).toContain('plan');
    expect(args).not.toContain('--yolo');
  });

  it.each([
    { mode: 'default' as const, accessLevel: 'ask-permission' as const },
    { mode: 'default' as const, accessLevel: 'full-access' as const },
    { mode: 'edit-automatically' as const, accessLevel: 'full-access' as const },
    { mode: 'ask-before-edit' as const, accessLevel: 'ask-permission' as const },
  ])('should use --mode act --yolo for mode=$mode access=$accessLevel', ({ mode, accessLevel }) => {
    const args = provider.buildCliArgs(s({ mode, accessLevel }), createClineSession());
    expect(args).toContain('--mode');
    expect(args).toContain('act');
    expect(args).toContain('--yolo');
  });
});
