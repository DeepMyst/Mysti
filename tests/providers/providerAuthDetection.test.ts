/**
 * Provider auth-detection regression guard — the wrong-path false-negative bug
 * (a signed-in user reported not-authenticated → the Mysti coordinator skips
 * delegating to that backend). One block per provider fixed in the audit sweep.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as realFs from 'fs';
import * as realOs from 'os';
import * as path from 'path';

const hoisted = vi.hoisted(() => ({ home: '' }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => hoisted.home || actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});

import {
  TestableCopilotProvider,
  TestableCursorProvider,
  TestableQwenProvider,
  TestableOpenCodeProvider,
  TestableContinueProvider,
  TestableClineProvider,
  TestableOpenClawProvider,
  TestableHermesProvider,
} from '../helpers/providerFactory';

const AUTH_ENV_KEYS = [
  'GH_TOKEN', 'GITHUB_TOKEN', 'CURSOR_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'QWEN_API_KEY', 'DASHSCOPE_API_KEY',
  'CONTINUE_API_KEY', 'CLINE_API_KEY', 'NOUS_API_KEY', 'GLM_API_KEY', 'OPENCLAW_GATEWAY_TOKEN',
  'COPILOT_HOME', 'CLINE_DATA_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'HERMES_HOME',
  'CONTINUE_GLOBAL_DIR', 'OPENCLAW_STATE_DIR', 'LITECLAW_STATE_DIR', 'LITECLAW_AGENT_DIR',
];

describe('provider auth detection (wrong-path false-negative fixes)', () => {
  let tmpHome: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpHome = realFs.mkdtempSync(path.join(realOs.tmpdir(), 'mysti-provauth-'));
    hoisted.home = tmpHome;
    for (const k of AUTH_ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });

  afterEach(() => {
    hoisted.home = '';
    realFs.rmSync(tmpHome, { recursive: true, force: true });
    for (const k of AUTH_ENV_KEYS) {
      if (saved[k] === undefined) { delete process.env[k]; } else { process.env[k] = saved[k]; }
    }
  });

  function write(rel: string, content: string): void {
    const p = path.join(tmpHome, rel);
    realFs.mkdirSync(path.dirname(p), { recursive: true });
    realFs.writeFileSync(p, content);
  }

  it('copilot: signed in via ~/.copilot/config.json (logged_in_users), NOT ~/.config/github-copilot', async () => {
    write('.copilot/config.json', JSON.stringify({ logged_in_users: [{ host: 'github.com', login: 'octocat' }], theme: 'dark' }));
    const p = new TestableCopilotProvider();
    expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
    const s = await p.checkAuthentication();
    expect(s.authenticated).toBe(true);
    expect(s.user).toContain('octocat');
  });

  it('copilot: a pre-login config.json (banner/theme only, no logged_in_users) is NOT authenticated', async () => {
    write('.copilot/config.json', JSON.stringify({ theme: 'dark', banner_shown: true }));
    expect((await new TestableCopilotProvider().checkAuthentication()).authenticated).toBe(false);
  });

  it('cursor: signed in via ~/.cursor/cli-config.json authInfo (offline, no agent spawn)', async () => {
    write('.cursor/cli-config.json', JSON.stringify({ authInfo: { email: 'dev@example.com', authId: 'google-oauth2|1' } }));
    const p = new TestableCursorProvider();
    expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
    expect((await p.checkAuthentication()).user).toBe('dev@example.com');
  });

  it('qwen: OAuth via ~/.qwen/oauth_creds.json, and DASHSCOPE_API_KEY env', async () => {
    write('.qwen/oauth_creds.json', JSON.stringify({ access_token: 'x' }));
    expect((await new TestableQwenProvider().getAuthConfig()).isAuthenticated).toBe(true);
    realFs.rmSync(path.join(tmpHome, '.qwen'), { recursive: true, force: true });
    process.env.DASHSCOPE_API_KEY = 'sk-dash';
    expect((await new TestableQwenProvider().checkAuthentication()).authenticated).toBe(true);
  });

  it('opencode: OPENROUTER_API_KEY env is recognized (was previously missed)', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-x';
    const s = await new TestableOpenCodeProvider().checkAuthentication();
    expect(s.authenticated).toBe(true);
    expect(s.user).toBe('OPENROUTER_API_KEY');
  });

  it('opencode: ~/.local/share/opencode/auth.json marks authenticated', async () => {
    write('.local/share/opencode/auth.json', JSON.stringify({ anthropic: { type: 'oauth' } }));
    expect((await new TestableOpenCodeProvider().checkAuthentication()).authenticated).toBe(true);
  });

  it('continue: legacy Hub login ~/.continue/auth.json marks authenticated', async () => {
    write('.continue/auth.json', JSON.stringify({ userId: 'u', accessToken: 't' }));
    const p = new TestableContinueProvider();
    expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
    expect((await p.checkAuthentication()).authenticated).toBe(true);
  });

  it('cline: real secrets.json creds authenticate; a bare data dir (no creds) does NOT (false-positive fixed)', async () => {
    // bare data dir — old code reported authenticated on mere existence
    realFs.mkdirSync(path.join(tmpHome, '.cline', 'data'), { recursive: true });
    expect((await new TestableClineProvider().checkAuthentication()).authenticated).toBe(false);
    // real creds present
    write('.cline/data/secrets.json', JSON.stringify({ openRouterApiKey: 'sk-or-1234567890' }));
    expect((await new TestableClineProvider().checkAuthentication()).authenticated).toBe(true);
  });

  it('cline: env-var auth (OPENROUTER_API_KEY) is recognized', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-x';
    expect((await new TestableClineProvider().checkAuthentication()).authenticated).toBe(true);
  });

  it('openclaw: real auth-profiles.json store authenticates (not the channel credentials/ dir)', async () => {
    write('.openclaw/agents/main/agent/auth-profiles.json', JSON.stringify({ profiles: { 'anthropic:default': { type: 'oauth' } } }));
    expect((await new TestableOpenClawProvider().getAuthConfig()).isAuthenticated).toBe(true);
  });

  it('hermes: config.yaml fallback + a broad env key (GLM_API_KEY) authenticate', async () => {
    write('.hermes/config.yaml', 'model:\n  provider: glm');
    expect((await new TestableHermesProvider().checkAuthentication()).authenticated).toBe(true);
    realFs.rmSync(path.join(tmpHome, '.hermes'), { recursive: true, force: true });
    process.env.GLM_API_KEY = 'glm-x';
    expect((await new TestableHermesProvider().checkAuthentication()).authenticated).toBe(true);
  });
});
