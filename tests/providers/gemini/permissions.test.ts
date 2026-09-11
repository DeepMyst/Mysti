import { describe, it, expect } from 'vitest';
import { TestableGeminiProvider } from '../../helpers/providerFactory';
import { createGeminiSession } from '../../helpers/sessionFactory';
import type { Settings } from '../../../src/types';

const modes = ['default', 'ask-before-edit', 'edit-automatically', 'quick-plan', 'detailed-plan'] as const;
const levels = ['ask-permission', 'full-access', 'read-only'] as const;
describe('Gemini native permission startup', () => {
  it.each(modes.flatMap(mode => levels.map(accessLevel => ({ mode, accessLevel }))))('keeps native confirmation for $mode/$accessLevel', value => {
    const provider = new TestableGeminiProvider();
    const settings: Settings = { ...value, provider: 'google-gemini', model: '', thinkingLevel: 'none', contextMode: 'auto' };
    const args = provider.buildCliArgs(settings, createGeminiSession());
    expect(args).toContain('--acp');
    expect(args[args.indexOf('--approval-mode') + 1]).toBe('default');
    expect(args).not.toContain('--yolo');
    expect(args).not.toContain('auto-edit');
    expect(args).not.toContain('--bare');
    const restricted = value.accessLevel === 'read-only' || value.mode === 'quick-plan' || value.mode === 'detailed-plan';
    expect(args[args.indexOf('--admin-policy') + 1]).toMatch(restricted ? /readonly\.toml$/ : /host\.toml$/);
    provider.dispose();
  });
});
