import { describe, it, expect, beforeEach } from 'vitest';
import { TestableCodexProvider } from '../../helpers/providerFactory';
import { createCodexSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';

function defaultSettings(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default', thinkingLevel: 'none', accessLevel: 'ask-permission',
    contextMode: 'auto', model: '', provider: 'openai-codex', ...overrides,
  };
}

describe('CodexProvider.buildCliArgs', () => {
  let provider: TestableCodexProvider;

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableCodexProvider();
  });

  it('should include exec --json --skip-git-repo-check', () => {
    const args = provider.buildCliArgs(defaultSettings(), createCodexSession());
    expect(args).toContain('exec');
    expect(args).toContain('--json');
    expect(args).toContain('--skip-git-repo-check');
  });

  it('should use read-only sandbox for plan modes', () => {
    const args = provider.buildCliArgs(defaultSettings({ mode: 'quick-plan' }), createCodexSession());
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
  });

  it('should use read-only sandbox for read-only access', () => {
    const args = provider.buildCliArgs(defaultSettings({ accessLevel: 'read-only' }), createCodexSession());
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
  });

  it('should bypass approvals for edit-automatically + full-access', () => {
    const args = provider.buildCliArgs(defaultSettings({
      mode: 'edit-automatically', accessLevel: 'full-access',
    }), createCodexSession());
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('should use full-auto for default + full-access', () => {
    const args = provider.buildCliArgs(defaultSettings({
      accessLevel: 'full-access',
    }), createCodexSession());
    expect(args).toContain('--full-auto');
  });

  it('should use full-auto as fallback for ask-permission', () => {
    const args = provider.buildCliArgs(defaultSettings(), createCodexSession());
    expect(args).toContain('--full-auto');
  });
});
