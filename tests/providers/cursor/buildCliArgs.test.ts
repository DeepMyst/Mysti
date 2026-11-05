import { describe, it, expect, beforeEach } from 'vitest';
import { TestableCursorProvider } from '../../helpers/providerFactory';
import { createCursorSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';

function defaultSettings(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default', thinkingLevel: 'none', accessLevel: 'full-access',
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
    // Individual partials and their summaries have no reliable distinguishing
    // tag. Consume the CLI's complete stream-json blocks instead.
    expect(args).not.toContain('--stream-partial-output');
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

  it('rejects Ask without a native approval channel', () => {
    expect(() => provider.buildCliArgs(defaultSettings({ accessLevel: 'ask-permission' }), createCursorSession())).toThrow(/native approvals/);
  });
});
