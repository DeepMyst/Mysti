import { describe, it, expect, beforeEach } from 'vitest';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { createOpenClawSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';

function defaultSettings(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default', thinkingLevel: 'medium', accessLevel: 'ask-permission',
    contextMode: 'auto', model: '', provider: 'openclaw', ...overrides,
  };
}

describe('OpenClawProvider.buildCliArgs', () => {
  let provider: TestableOpenClawProvider;

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableOpenClawProvider();
  });

  it('should include agent --json and --local', () => {
    const args = provider.buildCliArgs(defaultSettings(), createOpenClawSession());
    expect(args).toContain('agent');
    expect(args).toContain('--json');
    expect(args).toContain('--local');
  });

  it('should map thinking level', () => {
    const args = provider.buildCliArgs(defaultSettings({ thinkingLevel: 'high' }), createOpenClawSession());
    expect(args).toContain('--thinking');
    expect(args).toContain('high');
  });

  it('should map none thinking level to off', () => {
    const args = provider.buildCliArgs(defaultSettings({ thinkingLevel: 'none' }), createOpenClawSession());
    expect(args).toContain('--thinking');
    expect(args).toContain('off');
  });
});
