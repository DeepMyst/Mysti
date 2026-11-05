import { describe, it, expect, beforeEach } from 'vitest';
import { TestableCopilotProvider } from '../../helpers/providerFactory';
import { createCopilotSession } from '../../helpers/sessionFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';

function defaultSettings(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default', thinkingLevel: 'none', accessLevel: 'full-access',
    contextMode: 'auto', model: '', provider: 'github-copilot', ...overrides,
  };
}

describe('CopilotProvider.buildCliArgs', () => {
  let provider: TestableCopilotProvider;

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableCopilotProvider();
  });

  it('rejects unsupported Ask on a pre-1.0 CLI', () => {
    (provider as any)._cachedCliVersion = '0.0.372';
    expect(() => provider.buildCliArgs(defaultSettings({ accessLevel: 'ask-permission' }), createCopilotSession())).toThrow(/native approvals/);
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

  it('never passes a local lifecycle ID as a native resume session', () => {
    const session = createCopilotSession();
    session.sessionId = 'copilot_sess_1';
    const args = provider.buildCliArgs(defaultSettings(), session);
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('copilot_sess_1');
  });

  it('should include --model when set', () => {
    const args = provider.buildCliArgs(defaultSettings({ model: 'gpt-4o' }), createCopilotSession());
    expect(args).toContain('--model');
    expect(args).toContain('gpt-4o');
  });

  it('uses Copilot Auto for an unspecified model instead of pinning an unavailable model', () => {
    const args = provider.buildCliArgs(defaultSettings(), createCopilotSession());
    expect(provider.config.defaultModel).toBe('auto');
    expect(provider.config.models.find(model => model.id === 'auto')?.name).toBe('Auto');
    expect(args[args.indexOf('--model') + 1]).toBe('auto');
  });

  it('preserves a configured custom model and an explicitly routed model over Auto', () => {
    setMockConfig('copilotModel', 'gpt-5.4');
    const custom = provider.buildCliArgs(defaultSettings({ model: 'auto' }), createCopilotSession());
    expect(custom[custom.indexOf('--model') + 1]).toBe('gpt-5.4');
    const routed = provider.buildCliArgs(defaultSettings({ model: 'auto', routedModel: 'claude-sonnet-4.6' }), createCopilotSession());
    expect(routed[routed.indexOf('--model') + 1]).toBe('claude-sonnet-4.6');
  });

  it('lets Auto choose effort while preserving explicit model effort settings', () => {
    const automatic = provider.buildCliArgs(defaultSettings({ model: 'auto', effortLevel: 'low' }), createCopilotSession());
    expect(automatic).not.toContain('--effort');
    const explicit = provider.buildCliArgs(defaultSettings({ model: 'gpt-5.4', effortLevel: 'low' }), createCopilotSession());
    expect(explicit[explicit.indexOf('--effort') + 1]).toBe('low');
  });
});
