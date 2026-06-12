import { describe, it, expect, beforeEach } from 'vitest';
import { TestableQwenProvider } from '../../helpers/providerFactory';
import { createQwenSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';

function defaultSettings(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default', thinkingLevel: 'none', accessLevel: 'ask-permission',
    contextMode: 'auto', model: '', provider: 'qwen-code', ...overrides,
  };
}

describe('QwenCodeProvider.buildCliArgs', () => {
  let provider: TestableQwenProvider;

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableQwenProvider();
  });

  it('should include base flags', () => {
    const args = provider.buildCliArgs(defaultSettings(), createQwenSession());
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--include-partial-messages');
  });

  it('should include --resume <sessionId> for session resume (not bare --continue)', () => {
    const session = createQwenSession();
    session.sessionId = 'qwen_sess_1';
    const args = provider.buildCliArgs(defaultSettings(), session);
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('qwen_sess_1');
    // Bare --continue resumes the globally most recent session — cross-panel bleed
    expect(args).not.toContain('--continue');
  });

  it('should start fresh (no resume flags) without session', () => {
    const args = provider.buildCliArgs(defaultSettings(), createQwenSession());
    expect(args).not.toContain('--continue');
    expect(args).not.toContain('--resume');
  });

  it('should include --model when set', () => {
    const args = provider.buildCliArgs(defaultSettings({ model: 'qwen3-coder' }), createQwenSession());
    expect(args).toContain('--model');
    expect(args).toContain('qwen3-coder');
  });
});
