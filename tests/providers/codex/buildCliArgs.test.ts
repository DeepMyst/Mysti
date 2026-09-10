import { describe, it, expect, beforeEach } from 'vitest';
import { TestableCodexProvider } from '../../helpers/providerFactory';
import { createCodexSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';
const settings = (extra: Partial<Settings> = {}): Settings => ({ mode: 'default', thinkingLevel: 'none', accessLevel: 'ask-permission', contextMode: 'auto', model: '', provider: 'openai-codex', ...extra });
beforeEach(clearMockConfig);
describe('Codex native app-server launch', () => {
  it('uses stdio app-server with conservative launch authority', () => {
    const args = new TestableCodexProvider().buildCliArgs(settings(), createCodexSession());
    expect(args.slice(0, 3)).toEqual(['app-server', '--listen', 'stdio://']);
    expect(args).toContain('sandbox_mode="read-only"');
    expect(args).toContain('approval_policy="on-request"');
    expect(args).toContain('approvals_reviewer="user"');
    expect(args).toContain('notify=[]');
    expect(args).not.toContain('exec'); expect(args).not.toContain('-');
  });
  it.each([['high', 'high'], ['max', 'xhigh']] as const)('maps %s effort to pinned native %s', (effortLevel, expected) => {
    const args = new TestableCodexProvider().buildCliArgs(settings({ effortLevel }), createCodexSession());
    expect(args).toContain(`model_reasoning_effort="${expected}"`);
  });
  it('leaves native effort default alone when unset', () => {
    const args = new TestableCodexProvider().buildCliArgs(settings(), createCodexSession());
    expect(args.some(arg => arg.startsWith('model_reasoning_effort'))).toBe(false);
  });
});
