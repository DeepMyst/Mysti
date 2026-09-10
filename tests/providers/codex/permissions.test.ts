import { describe, it, expect, beforeEach } from 'vitest';
import { TestableCodexProvider } from '../../helpers/providerFactory';
import { createCodexSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';
beforeEach(clearMockConfig);
describe('Codex native approval launch boundary', () => {
  it.each([
    ['default', 'ask-permission'], ['quick-plan', 'full-access'], ['detailed-plan', 'full-access'],
    ['default', 'read-only'], ['edit-automatically', 'full-access'], ['edit-automatically', 'ask-permission'], ['ask-before-edit', 'full-access'],
  ] as const)('keeps %s/%s in a read-only sandbox pending individual native grants', (mode, accessLevel) => {
    const provider = new TestableCodexProvider();
    const settings: Settings = { mode, accessLevel, thinkingLevel: 'none', contextMode: 'auto', model: '', provider: 'openai-codex' };
    const args = provider.buildCliArgs(settings, createCodexSession());
    expect(provider.capabilities.supportsNativeApproval).toBe(true);
    expect(args).toContain('sandbox_mode="read-only"');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--full-auto');
    expect(args).not.toContain('workspace-write');
  });
});
