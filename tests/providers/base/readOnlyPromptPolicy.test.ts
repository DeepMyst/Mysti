import { afterEach, describe, expect, it } from 'vitest';
import { TestableClaudeProvider, TestableCopilotProvider, TestableHermesProvider } from '../../helpers/providerFactory';
import type { Settings } from '../../../src/types';

class CopilotPrompt extends TestableCopilotProvider {
  sync(settings: Settings, text = 'Review this file.'): string { return this.buildPrompt(text, [], null, settings); }
  async async(settings: Settings, text = 'Review this file.'): Promise<string> { return this.buildPromptAsync(text, [], null, settings); }
}
class ClaudePrompt extends TestableClaudeProvider {
  sync(settings: Settings, text = 'Review this file.'): string { return this.buildPrompt(text, [], null, settings); }
  async async(settings: Settings, text = 'Review this file.'): Promise<string> { return this.buildPromptAsync(text, [], null, settings); }
}
// Native approval without native plan enforcement: prompt-level guidance still applies.
class HermesPrompt extends TestableHermesProvider {
  sync(settings: Settings, text = 'Review this file.'): string { return this.buildPrompt(text, [], null, settings); }
  async async(settings: Settings, text = 'Review this file.'): Promise<string> { return this.buildPromptAsync(text, [], null, settings); }
}
const providers: Array<CopilotPrompt | ClaudePrompt | HermesPrompt> = [];
afterEach(() => providers.splice(0).forEach(provider => provider.dispose()));
function settings(mode: Settings['mode'], accessLevel: Settings['accessLevel']): Settings {
  return { mode, accessLevel, provider: 'github-copilot', model: 'auto', thinkingLevel: 'none', contextMode: 'manual' };
}

describe.each(['sync', 'async'] as const)('%s prompt permission guidance', method => {
  // Hermes declares no natively enforced modes, so Mysti still states them in text.
  describe.each([['Hermes', HermesPrompt]] as const)('%s', (_name, Provider) => {
    it.each(['default', 'ask-before-edit', 'edit-automatically'] as const)('Read Only overrides conflicting %s editing guidance', async mode => {
      const provider = new Provider(); providers.push(provider);
      const prompt = await provider[method](settings(mode, 'read-only'));
      expect(prompt).toContain('Read Only');
      expect(prompt).toContain('Do not modify files');
      expect(prompt).toContain('permission setting');
      expect(prompt).not.toContain('Ask before making any edits');
      expect(prompt).not.toContain('You may edit files directly');
      expect(prompt).not.toContain('wait for approval before modifying');
    });
  });
  it.each(['quick-plan', 'detailed-plan'] as const)('preserves %s planning guidance while making its write restriction explicit', async mode => {
    const provider = new HermesPrompt(); providers.push(provider);
    const prompt = await provider[method](settings(mode, 'full-access'));
    expect(prompt).toContain(mode === 'quick-plan' ? 'ONE concise implementation plan' : 'Create a detailed plan');
    expect(prompt).toContain('Do not modify files');
  });
  it('retains native approval guidance when edits can actually be approved', async () => {
    const provider = new HermesPrompt(); providers.push(provider);
    const prompt = await provider[method](settings('ask-before-edit', 'ask-permission'));
    expect(prompt).toContain('native tool request waits for the user’s approval card');
    expect(prompt).not.toContain('Read Only');
  });
  it('retains explicitly automatic editing outside Read Only', async () => {
    const provider = new HermesPrompt(); providers.push(provider);
    const prompt = await provider[method](settings('edit-automatically', 'full-access'));
    expect(prompt).toContain('You may edit files directly');
    expect(prompt).not.toContain('Read Only');
  });
  // Claude Code enforces every Mysti mode natively (--permission-mode plan,
  // native approval requests), so its prompt carries no restated policy.
  it.each([['quick-plan', 'full-access'], ['detailed-plan', 'ask-permission'], ['ask-before-edit', 'read-only'], ['edit-automatically', 'full-access']] as const)(
    'sends Claude the message alone in %s / %s', async (mode, access) => {
      const provider = new ClaudePrompt(); providers.push(provider);
      expect(await provider[method](settings(mode, access))).toBe('Review this file.');
    });
  // Copilot blocks writes natively (--deny-tool shell/write) but has no plan mode
  // on Mysti's transport: only the planning instruction remains.
  it.each(['quick-plan', 'detailed-plan'] as const)('gives Copilot %s planning guidance without restating the native read-only block', async mode => {
    const provider = new CopilotPrompt(); providers.push(provider);
    const prompt = await provider[method](settings(mode, 'full-access'));
    expect(prompt).toContain(mode === 'quick-plan' ? 'ONE concise implementation plan' : 'Create a detailed plan');
    expect(prompt).not.toContain('Read Only');
  });
  it('sends Copilot full-access edits without restating its native auto-approval', async () => {
    const provider = new CopilotPrompt(); providers.push(provider);
    expect(await provider[method](settings('edit-automatically', 'full-access'))).toBe('Review this file.');
  });
  it('keeps native slash-command payloads unchanged', async () => {
    const provider = new ClaudePrompt(); providers.push(provider);
    expect(await provider[method](settings('ask-before-edit', 'read-only'), '/compact')).toBe('/compact');
  });
});
