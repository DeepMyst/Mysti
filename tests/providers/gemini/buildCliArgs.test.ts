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

  it('should include --output-format stream-json', () => {
    const args = provider.buildCliArgs(defaultSettings(), createGeminiSession());
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
  });

  it('should include -m for model selection', () => {
    const args = provider.buildCliArgs(defaultSettings({ model: 'gemini-2.5-pro' }), createGeminiSession());
    expect(args).toContain('-m');
    expect(args).toContain('gemini-2.5-pro');
  });

  it('should include --resume for session resume', () => {
    const session = createGeminiSession();
    session.sessionId = 'gemini_sess_1';
    const args = provider.buildCliArgs(defaultSettings(), session);
    expect(args).toContain('--resume');
    expect(args).toContain('gemini_sess_1');
  });
});
