import { describe, it, expect, beforeEach } from 'vitest';
import { TestableCursorProvider } from '../../helpers/providerFactory';
import { createCursorSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';

function defaultSettings(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default', thinkingLevel: 'none', accessLevel: 'ask-permission',
    contextMode: 'auto', model: '', provider: 'cursor', ...overrides,
  };
}

describe('CursorProvider.buildCliArgs', () => {
  let provider: TestableCursorProvider;

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableCursorProvider();
  });

  it('should include base flags', () => {
    const args = provider.buildCliArgs(defaultSettings(), createCursorSession());
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--print');
    expect(args).toContain('--stream-partial-output');
  });

  it('should not include --force for read-only', () => {
    const args = provider.buildCliArgs(defaultSettings({ accessLevel: 'read-only' }), createCursorSession());
    expect(args).not.toContain('--force');
  });

  it('should not include --force for plan modes', () => {
    const args = provider.buildCliArgs(defaultSettings({ mode: 'quick-plan' }), createCursorSession());
    expect(args).not.toContain('--force');
  });

  it('should include --force for full-access + edit-automatically', () => {
    const args = provider.buildCliArgs(defaultSettings({
      accessLevel: 'full-access', mode: 'edit-automatically',
    }), createCursorSession());
    expect(args).toContain('--force');
  });

  it('should include --force for default ask-permission (bypassing CLI permissions)', () => {
    const args = provider.buildCliArgs(defaultSettings({ accessLevel: 'ask-permission' }), createCursorSession());
    expect(args).toContain('--force');
  });
});
