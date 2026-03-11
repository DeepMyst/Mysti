import { describe, it, expect, beforeEach } from 'vitest';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { createOpenClawSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';

function s(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default', thinkingLevel: 'medium', accessLevel: 'ask-permission',
    contextMode: 'auto', model: '', provider: 'openclaw', ...overrides,
  };
}

describe('OpenClaw permission flag mapping', () => {
  let provider: TestableOpenClawProvider;

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableOpenClawProvider();
  });

  it.each([
    ['quick-plan'],
    ['detailed-plan'],
  ] as const)('should use --sandbox for %s mode', (mode) => {
    const args = provider.buildCliArgs(s({ mode }), createOpenClawSession());
    expect(args).toContain('--sandbox');
    expect(args).not.toContain('--yolo');
  });

  it('should use --sandbox for read-only access', () => {
    const args = provider.buildCliArgs(s({ accessLevel: 'read-only' }), createOpenClawSession());
    expect(args).toContain('--sandbox');
    expect(args).not.toContain('--yolo');
  });

  it.each([
    { mode: 'edit-automatically' as const, accessLevel: 'full-access' as const },
    { mode: 'default' as const, accessLevel: 'full-access' as const },
    { mode: 'default' as const, accessLevel: 'ask-permission' as const },
    { mode: 'ask-before-edit' as const, accessLevel: 'ask-permission' as const },
  ])('should use --yolo for mode=$mode access=$accessLevel', ({ mode, accessLevel }) => {
    const args = provider.buildCliArgs(s({ mode, accessLevel }), createOpenClawSession());
    expect(args).toContain('--yolo');
    expect(args).not.toContain('--sandbox');
  });
});
