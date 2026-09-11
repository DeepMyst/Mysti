import { describe, it, expect, beforeEach } from 'vitest';
import { TestableGeminiProvider } from '../../helpers/providerFactory';
import { createGeminiSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';

function defaultSettings(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default', thinkingLevel: 'none', accessLevel: 'ask-permission',
    contextMode: 'auto', model: '', provider: 'google-gemini', ...overrides,
  };
}

describe('GeminiProvider.buildCliArgs', () => {
  let provider: TestableGeminiProvider;

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableGeminiProvider();
  });

  it('should select the bidirectional ACP transport', () => {
    const args = provider.buildCliArgs(defaultSettings(), createGeminiSession());
    expect(args).toContain('--acp');
    expect(args).not.toContain('--output-format');
  });

  it('should include -m for model selection', () => {
    const args = provider.buildCliArgs(defaultSettings({ model: 'gemini-2.5-pro' }), createGeminiSession());
    expect(args).toContain('-m');
    expect(args).toContain('gemini-2.5-pro');
  });

  it('should start a fresh native session and replay panel history', () => {
    const session = createGeminiSession();
    session.sessionId = 'gemini_sess_1';
    const args = provider.buildCliArgs(defaultSettings(), session);
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('gemini_sess_1');
  });
});
