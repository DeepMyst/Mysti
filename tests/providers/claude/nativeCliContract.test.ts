import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestableClaudeProvider, TestableHermesProvider } from '../../helpers/providerFactory';
import type { Settings } from '../../../src/types';

const providers: Array<{ dispose(): void }> = [];
afterEach(() => { providers.splice(0).forEach(provider => provider.dispose()); vi.restoreAllMocks(); });
const base = { provider: 'claude-code', model: 'sonnet', thinkingLevel: 'high', effortLevel: 'max', contextMode: 'manual' } as const;
const prompt = async (provider: any, settings: Partial<Settings>) => {
  vi.spyOn(provider, 'buildAgentInstructionsAsync').mockResolvedValue('');
  return provider.buildPromptAsync('hi', [], null, { ...base, ...settings } as Settings);
};

/** Claude Code enforces Mysti's modes natively (--permission-mode plan, native
 * approval requests) and owns reasoning through --effort. Restating either in
 * the prompt or a second token budget makes the model deliberate over them. */
describe('Claude receives the user message, not Mysti policy text', () => {
  it.each([
    ['quick-plan', 'read-only'], ['detailed-plan', 'ask-permission'], ['ask-before-edit', 'ask-permission'],
    ['edit-automatically', 'full-access'], ['default', 'read-only'],
  ] as const)('%s / %s', async (mode, accessLevel) => {
    const claude = new TestableClaudeProvider(); providers.push(claude);
    expect(await prompt(claude, { mode, accessLevel })).toBe('hi');
  });

  it('keeps prompt-level policy for providers without native plan enforcement', async () => {
    const hermes = new TestableHermesProvider(); providers.push(hermes);
    const text = await prompt(hermes, { provider: 'hermes', mode: 'quick-plan', accessLevel: 'read-only' });
    expect(text).toContain('[Planning Mode]'); expect(text).toContain('[Read Only]');
  });

  it('leaves reasoning to --effort instead of also setting MAX_THINKING_TOKENS', () => {
    const claude = new TestableClaudeProvider(); providers.push(claude);
    expect(claude.capabilities.thinkingLevelEffective).toBe(false);
    expect((claude as any).getThinkingTokens('high')).toBeUndefined();
  });
});
