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

  it('should map effort to -c model_reasoning_effort', () => {
    const args = provider.buildCliArgs(defaultSettings({ effortLevel: 'high' }), createCodexSession());
    const i = args.indexOf('-c');
    expect(args).toContain('-c');
    // the -c value carrying the effort override
    expect(args.some(a => a === 'model_reasoning_effort="high"')).toBe(true);
  });

  it('should clamp max down to xhigh (Codex has no max tier)', () => {
    const args = provider.buildCliArgs(defaultSettings({ effortLevel: 'max' }), createCodexSession());
    expect(args.some(a => a === 'model_reasoning_effort="xhigh"')).toBe(true);
  });

  it('should omit the effort override when effortLevel is unset', () => {
    const args = provider.buildCliArgs(defaultSettings(), createCodexSession());
    expect(args.some(a => a.startsWith('model_reasoning_effort'))).toBe(false);
  });
});

// Plan 18 Wave 3: the bespoke sendMessage override is gone — the base
// single-shot path sends the prompt on stdin, so buildCliArgs MUST end with
// the `-` stdin marker or `codex exec` waits on argv it never gets.
describe('stdin marker (Plan 18 Wave 3)', () => {
  it('args end with "-" so the base stdin path feeds the prompt', () => {
    const provider = new TestableCodexProvider();
    const args = provider.buildCliArgs(defaultSettings(), createCodexSession());
    expect(args[args.length - 1]).toBe('-');
  });
});
