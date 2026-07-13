/**
 * ClaudeCodeProvider auth detection — regression guard for the wrong-path bug:
 * Claude Code v2.x stores the signed-in account in ~/.claude.json (the
 * `oauthAccount` object), NOT ~/.claude/config.json. The old check looked at the
 * legacy path only, so a signed-in user was reported not-authenticated and the
 * Mysti coordinator skipped delegating to claude-code.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as realFs from 'fs';
import * as realOs from 'os';
import * as path from 'path';

// Redirect os.homedir() to a per-test temp dir (homedir is non-configurable, so
// spyOn fails — mock the module with a hoisted mutable holder instead).
const hoisted = vi.hoisted(() => ({ home: '' }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => hoisted.home || actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});

import { TestableClaudeProvider } from '../../helpers/providerFactory';

describe('ClaudeCodeProvider auth detection (v2.x ~/.claude.json)', () => {
  let tmpHome: string;
  let provider: TestableClaudeProvider;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpHome = realFs.mkdtempSync(path.join(realOs.tmpdir(), 'mysti-claude-home-'));
    hoisted.home = tmpHome;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    provider = new TestableClaudeProvider();
  });

  afterEach(() => {
    hoisted.home = '';
    realFs.rmSync(tmpHome, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  function writeHomeConfig(obj: unknown): void {
    realFs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify(obj));
  }

  it('reports authenticated when ~/.claude.json has an oauthAccount (v2.x login)', async () => {
    writeHomeConfig({ numStartups: 12, oauthAccount: { emailAddress: 'dev@example.com', accountUuid: 'u-123' } });
    const auth = await provider.getAuthConfig();
    expect(auth.isAuthenticated).toBe(true);
    const status = await provider.checkAuthentication();
    expect(status.authenticated).toBe(true);
    expect(status.user).toBe('dev@example.com'); // surfaces the signed-in email
  });

  it('reports NOT authenticated when ~/.claude.json exists but has no account (fresh, never logged in)', async () => {
    // The file is created on first run (numStartups etc.) BEFORE any login, so
    // mere existence must not count as authenticated.
    writeHomeConfig({ numStartups: 3, tipsHistory: {} });
    expect((await provider.getAuthConfig()).isAuthenticated).toBe(false);
    expect((await provider.checkAuthentication()).authenticated).toBe(false);
  });

  it('reports NOT authenticated when nothing exists', async () => {
    expect((await provider.getAuthConfig()).isAuthenticated).toBe(false);
  });

  it('accepts the legacy ~/.claude/config.json location (older installs)', async () => {
    realFs.mkdirSync(path.join(tmpHome, '.claude'));
    realFs.writeFileSync(path.join(tmpHome, '.claude', 'config.json'), JSON.stringify({ email: 'legacy@example.com' }));
    expect((await provider.getAuthConfig()).isAuthenticated).toBe(true);
  });

  it('accepts env-var authentication (ANTHROPIC_API_KEY) with no config file', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    expect((await provider.getAuthConfig()).isAuthenticated).toBe(true);
  });

  it('does not treat a corrupt ~/.claude.json as authenticated', async () => {
    realFs.writeFileSync(path.join(tmpHome, '.claude.json'), '{ not valid json');
    expect((await provider.getAuthConfig()).isAuthenticated).toBe(false);
  });
});
