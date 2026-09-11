import { describe, it, expect } from 'vitest';
import { TestableQwenProvider } from '../../helpers/providerFactory';
import { createQwenSession } from '../../helpers/sessionFactory';
import type { Settings } from '../../../src/types';

const modes = ['default', 'ask-before-edit', 'edit-automatically', 'quick-plan', 'detailed-plan'] as const;
const levels = ['ask-permission', 'full-access', 'read-only'] as const;
describe('Qwen native permission startup', () => {
  it.each(modes.flatMap(mode => levels.map(accessLevel => ({ mode, accessLevel }))))('keeps native confirmation for $mode/$accessLevel', value => {
    const provider = new TestableQwenProvider();
    const settings: Settings = { ...value, provider: 'qwen-code', model: '', thinkingLevel: 'none', contextMode: 'auto' };
    const args = provider.buildCliArgs(settings, createQwenSession());
    expect(args).toContain('--acp');
    expect(args[args.indexOf('--approval-mode') + 1]).toBe('default');
    expect(args).not.toContain('--yolo');
    expect(args).not.toContain('auto-edit');
    expect(args).not.toContain('--bare');
    const restricted = value.accessLevel === 'read-only' || value.mode === 'quick-plan' || value.mode === 'detailed-plan';
    expect(args.includes('edit,notebook_edit,run_shell_command')).toBe(restricted);
    expect(args).toContain('--exclude-tools');
    provider.dispose();
  });
});
