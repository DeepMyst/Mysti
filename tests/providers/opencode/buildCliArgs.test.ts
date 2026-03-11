import { describe, it, expect, beforeEach } from 'vitest';
import { TestableOpenCodeProvider } from '../../helpers/providerFactory';
import { createOpenCodeSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';

function defaultSettings(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default', thinkingLevel: 'none', accessLevel: 'ask-permission',
    contextMode: 'auto', model: '', provider: 'opencode', ...overrides,
  };
}

describe('OpenCodeProvider.buildCliArgs', () => {
  let provider: TestableOpenCodeProvider;

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableOpenCodeProvider();
  });

  it('should include run --format json --thinking', () => {
    const args = provider.buildCliArgs(defaultSettings(), createOpenCodeSession());
    expect(args).toContain('run');
    expect(args).toContain('--format');
    expect(args).toContain('json');
    expect(args).toContain('--thinking');
  });

  it('should include --session for session resume', () => {
    const session = createOpenCodeSession();
    session.sessionId = 'oc_sess_1';
    const args = provider.buildCliArgs(defaultSettings(), session);
    expect(args).toContain('--session');
    expect(args).toContain('oc_sess_1');
  });

  it('should not pass model for default', () => {
    const args = provider.buildCliArgs(defaultSettings({ model: 'default' }), createOpenCodeSession());
    expect(args).not.toContain('-m');
  });
});
