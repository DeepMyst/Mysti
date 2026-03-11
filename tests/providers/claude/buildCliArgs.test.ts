import { describe, it, expect, beforeEach } from 'vitest';
import { TestableClaudeProvider } from '../../helpers/providerFactory';
import { createClaudeSession } from '../../helpers/sessionFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';
import type { ClaudeSessionState } from '../../../src/providers/claude/ClaudeCodeProvider';

function defaultSettings(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default',
    thinkingLevel: 'none',
    accessLevel: 'ask-permission',
    contextMode: 'auto',
    model: 'claude-sonnet-4-5-20250929',
    provider: 'claude-code',
    ...overrides,
  };
}

describe('ClaudeCodeProvider.buildCliArgs', () => {
  let provider: TestableClaudeProvider;
  let session: ClaudeSessionState;

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableClaudeProvider();
    session = createClaudeSession();
  });

  it('should include base flags', () => {
    const args = provider.buildCliArgs(defaultSettings(), session);
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--include-partial-messages');
    expect(args).toContain('--verbose');
    expect(args).toContain('--print');
  });

  it('should use plan permission mode for quick-plan', () => {
    const args = provider.buildCliArgs(defaultSettings({ mode: 'quick-plan' }), session);
    expect(args).toContain('--permission-mode');
    expect(args).toContain('plan');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('should use plan permission mode for read-only access', () => {
    const args = provider.buildCliArgs(defaultSettings({ accessLevel: 'read-only' }), session);
    expect(args).toContain('--permission-mode');
    expect(args).toContain('plan');
  });

  it('should skip permissions for full-access + edit-automatically', () => {
    const args = provider.buildCliArgs(defaultSettings({
      accessLevel: 'full-access',
      mode: 'edit-automatically',
    }), session);
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--permission-mode');
  });

  it('should include --resume with session ID', () => {
    session.sessionId = 'sess_test123';
    const args = provider.buildCliArgs(defaultSettings(), session);
    expect(args).toContain('--resume');
    expect(args).toContain('sess_test123');
  });

  it('should not include --resume without session ID', () => {
    const args = provider.buildCliArgs(defaultSettings(), session);
    expect(args).not.toContain('--resume');
  });

  it('should include model from settings', () => {
    const args = provider.buildCliArgs(defaultSettings({ model: 'claude-opus-4-6' }), session);
    expect(args).toContain('--model');
    expect(args).toContain('claude-opus-4-6');
  });

  it('should prefer custom model from config over settings', () => {
    setMockConfig('claudeCodeModel', 'my-custom-model');
    const args = provider.buildCliArgs(defaultSettings({ model: 'claude-sonnet-4-5-20250929' }), session);
    expect(args).toContain('--model');
    expect(args).toContain('my-custom-model');
  });

  it('should include --append-system-prompt for channel context', () => {
    session.channelSystemContext = 'You are a helpful assistant';
    const args = provider.buildCliArgs(defaultSettings(), session);
    expect(args).toContain('--append-system-prompt');
    expect(args).toContain('You are a helpful assistant');
  });
});
