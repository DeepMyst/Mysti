import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
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

// Gemini CLI refuses a headless run in a folder it has not been told to trust
// ("Gemini CLI is not running in a trusted directory ..."). VS Code's workspace
// trust is the user's decision for the same folder, so forward it — and only it.
describe('GeminiProvider folder trust', () => {
  const ws = vscode.workspace as unknown as { isTrusted?: boolean };
  afterEach(() => { delete ws.isTrusted; });

  it('trusts the folder for the CLI when VS Code trusts the workspace', () => {
    ws.isTrusted = true;
    expect(new TestableGeminiProvider().getExtraSpawnEnv(defaultSettings()).GEMINI_CLI_TRUST_WORKSPACE).toBe('true');
  });

  it('does not trust the folder when VS Code does not', () => {
    ws.isTrusted = false;
    expect(new TestableGeminiProvider().getExtraSpawnEnv(defaultSettings())).not.toHaveProperty('GEMINI_CLI_TRUST_WORKSPACE');
  });

  it('strips ANSI colour codes from the CLI error shown to the user', () => {
    const stderr = '\x1b[31mGemini CLI is not running in a trusted directory.\x1b[0m\n';
    expect((new TestableGeminiProvider() as any)._cleanStderr(stderr)).toBe('Gemini CLI is not running in a trusted directory.');
  });
});
