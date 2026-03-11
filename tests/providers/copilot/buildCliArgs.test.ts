import { describe, it, expect, beforeEach } from 'vitest';
import { TestableCopilotProvider } from '../../helpers/providerFactory';
import { createCopilotSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';

function defaultSettings(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default', thinkingLevel: 'none', accessLevel: 'ask-permission',
    contextMode: 'auto', model: '', provider: 'github-copilot', ...overrides,
  };
}

describe('CopilotProvider.buildCliArgs', () => {
  let provider: TestableCopilotProvider;

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableCopilotProvider();
  });

  it('should include --allow-all-tools for default ask-permission (bypassing CLI permissions)', () => {
    const args = provider.buildCliArgs(defaultSettings(), createCopilotSession());
    expect(args).toContain('--allow-all-tools');
  });

  it('should deny shell and write tools for read-only access', () => {
    const args = provider.buildCliArgs(defaultSettings({ accessLevel: 'read-only' }), createCopilotSession());
    expect(args).toContain('--deny-tool');
    expect(args).toContain('shell');
    expect(args).toContain('write');
    expect(args).not.toContain('--allow-all-tools');
  });

  it('should deny shell and write tools for plan modes', () => {
    const args = provider.buildCliArgs(defaultSettings({ mode: 'quick-plan' }), createCopilotSession());
    expect(args).toContain('--deny-tool');
    expect(args).toContain('shell');
  });

  it('should allow all tools for edit-automatically + full-access', () => {
    const args = provider.buildCliArgs(defaultSettings({
      mode: 'edit-automatically', accessLevel: 'full-access',
    }), createCopilotSession());
    expect(args).toContain('--allow-all-tools');
  });

  it('should include --resume for session resume', () => {
    const session = createCopilotSession();
    session.sessionId = 'copilot_sess_1';
    const args = provider.buildCliArgs(defaultSettings(), session);
    expect(args).toContain('--resume');
    expect(args).toContain('copilot_sess_1');
  });

  it('should include --model when set', () => {
    const args = provider.buildCliArgs(defaultSettings({ model: 'gpt-4o' }), createCopilotSession());
    expect(args).toContain('--model');
    expect(args).toContain('gpt-4o');
  });
});
