import { beforeEach, describe, expect, it } from 'vitest';
import { TestableOpenCodeProvider } from '../../helpers/providerFactory';
import { createOpenCodeSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';

const settings: Settings = { mode: 'default', thinkingLevel: 'none', accessLevel: 'ask-permission', contextMode: 'auto', model: '', provider: 'opencode' };
beforeEach(clearMockConfig);
describe('OpenCode ACP launch arguments', () => {
  it('starts only ACP in pure mode on ephemeral loopback', () => {
    const provider = new TestableOpenCodeProvider();
    expect(provider.buildCliArgs(settings, createOpenCodeSession())).toEqual(['acp', '--pure', '--hostname', '127.0.0.1', '--port', '0']);
    expect(provider.capabilities.supportsNativeApproval).toBe(true);
    expect(provider.capabilities.sessionKind).toBe('prompt-history');
  });
  it('never resumes a native session with inherited approvals', () => {
    const session = createOpenCodeSession(); session.sessionId = 'previous-session';
    const args = new TestableOpenCodeProvider().buildCliArgs(settings, session);
    expect(args).not.toContain('--session'); expect(args).not.toContain('previous-session');
  });
  it('pins the native protocol version in installation instructions', () => {
    expect(new TestableOpenCodeProvider().getInstallCommand()).toBe('npm i -g opencode-ai@1.18.29');
  });
});
