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
  TestableKimiProvider,
} from '../helpers/providerFactory';

const AUTH_ENV_KEYS = [
  'GH_TOKEN', 'GITHUB_TOKEN', 'CURSOR_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'QWEN_API_KEY', 'DASHSCOPE_API_KEY',
  'CONTINUE_API_KEY', 'CLINE_API_KEY', 'NOUS_API_KEY', 'GLM_API_KEY', 'OPENCLAW_GATEWAY_TOKEN',
  'COPILOT_HOME', 'COPILOT_GITHUB_TOKEN', 'COPILOT_PROVIDER_BASE_URL', 'CLINE_DATA_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'HERMES_HOME',
  'CONTINUE_GLOBAL_DIR', 'OPENCLAW_STATE_DIR', 'LITECLAW_STATE_DIR', 'LITECLAW_AGENT_DIR',
  'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'KIMI_HOME',
  'KIMI_CODE_HOME', 'KIMI_SHARE_DIR', 'KIMI_MODEL_NAME', 'KIMI_MODEL_API_KEY',
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

  it('copilot: isolated ACP sessions do not use stored login or GitHub token policy', async () => {
    write('.copilot/config.json', JSON.stringify({ logged_in_users: [{ host: 'github.com', login: 'octocat' }], theme: 'dark' }));
    const p = new TestableCopilotProvider();
    process.env.COPILOT_GITHUB_TOKEN = 'synthetic-token';
    expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
    const s = await p.checkAuthentication();
    expect(s.authenticated).toBe(false);
  });

  it('copilot: the isolated BYOK endpoint is recognized', async () => {
    process.env.COPILOT_PROVIDER_BASE_URL = 'http://127.0.0.1:1';
    expect((await new TestableCopilotProvider().checkAuthentication()).authenticated).toBe(true);
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

  it('opencode: isolated native transport does not consume the saved login store', async () => {
    write('.local/share/opencode/auth.json', JSON.stringify({ anthropic: { type: 'oauth' } }));
    expect((await new TestableOpenCodeProvider().checkAuthentication()).authenticated).toBe(false);
  });

  it('continue: legacy Hub login ~/.continue/auth.json marks authenticated', async () => {
    write('.continue/auth.json', JSON.stringify({ userId: 'u', accessToken: 't' }));
    const p = new TestableContinueProvider();
    expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
    expect((await p.checkAuthentication()).authenticated).toBe(true);
  });

  it('cline: isolated ACP sessions do not import a saved credential store', async () => {
    // bare data dir — old code reported authenticated on mere existence
    realFs.mkdirSync(path.join(tmpHome, '.cline', 'data'), { recursive: true });
    expect((await new TestableClineProvider().checkAuthentication()).authenticated).toBe(false);
    // real creds present
    write('.cline/data/secrets.json', JSON.stringify({ openRouterApiKey: 'sk-or-1234567890' }));
    expect((await new TestableClineProvider().checkAuthentication()).authenticated).toBe(false);
  });

  it('cline: native ACP requires CLINE_API_KEY rather than unrelated provider keys', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-x';
    expect((await new TestableClineProvider().checkAuthentication()).authenticated).toBe(false);
    process.env.CLINE_API_KEY = 'synthetic-cline-key';
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

  // Kimi Code 2.x keeps its data in ~/.kimi-code, kimi-cli 1.x in ~/.kimi; both
  // store OAuth tokens as credentials/<name>.json (the directory exists before
  // login). Layout verified against 2.0.2 and 1.51/1.52 source and isolated runs.
  const kimiWithVersion = (version: string | null) => {
    const p = new TestableKimiProvider();
    (p as unknown as { _cachedCliVersion: string | null })._cachedCliVersion = version;
    return p;
  };

  it('kimi 2.x: an OAuth credential file under ~/.kimi-code authenticates; the bare credentials dir does not', async () => {
    realFs.mkdirSync(path.join(tmpHome, '.kimi-code', 'credentials', 'mcp'), { recursive: true });
    expect((await kimiWithVersion('2.0.2').checkAuthentication()).authenticated).toBe(false);
    write('.kimi-code/credentials/kimi-code.json', '{}');
    const p = kimiWithVersion('2.0.2');
    expect(await p.checkAuthentication()).toMatchObject({ authenticated: true, user: 'Kimi Code' });
    expect(await p.getAuthConfig()).toMatchObject({ type: 'oauth', isAuthenticated: true });
    // A 1.x install does not read the 2.x home.
    expect((await kimiWithVersion('kimi, version 1.51.0').checkAuthentication()).authenticated).toBe(false);
  });

  it('kimi 1.x: the OAuth credential lives under ~/.kimi, and KIMI_SHARE_DIR moves it', async () => {
    write('.kimi/credentials/kimi-code.json', '{}');
    expect((await kimiWithVersion('kimi, version 1.51.0').checkAuthentication()).authenticated).toBe(true);
    expect((await kimiWithVersion('2.0.2').checkAuthentication()).authenticated).toBe(false);
    // Version not probed yet: either layout counts.
    expect((await kimiWithVersion(null).checkAuthentication()).authenticated).toBe(true);
    realFs.rmSync(path.join(tmpHome, '.kimi'), { recursive: true, force: true });
    const share = path.join(tmpHome, 'share');
    realFs.mkdirSync(path.join(share, 'credentials'), { recursive: true });
    realFs.writeFileSync(path.join(share, 'credentials', 'kimi-code.json'), '{}');
    process.env.KIMI_SHARE_DIR = share;
    expect((await kimiWithVersion('kimi, version 1.51.0').checkAuthentication()).authenticated).toBe(true);
  });

  it('kimi 2.x: KIMI_CODE_HOME relocates the data root', async () => {
    const custom = path.join(tmpHome, 'custom-kimi');
    realFs.mkdirSync(path.join(custom, 'credentials'), { recursive: true });
    realFs.writeFileSync(path.join(custom, 'credentials', 'kimi-code.json'), '{}');
    expect((await kimiWithVersion('2.0.2').checkAuthentication()).authenticated).toBe(false);
    process.env.KIMI_CODE_HOME = custom;
    expect((await kimiWithVersion('2.0.2').checkAuthentication()).authenticated).toBe(true);
    expect((await kimiWithVersion('2.0.2').getAuthConfig()).configPath).toBe(path.join(custom, 'config.toml'));
  });

  it('kimi: an API key in config.toml authenticates; the empty api_key written for OAuth providers does not', async () => {
    write('.kimi-code/config.toml', 'default_model = "kimi-code/k3"\n[providers."managed:kimi-code"]\ntype = "kimi"\napi_key = ""\n');
    expect((await kimiWithVersion('2.0.2').checkAuthentication()).authenticated).toBe(false);
    write('.kimi-code/config.toml', '[providers."managed:moonshot-ai"]\ntype = "kimi"\napi_key = "sk-moonshot-123"\n');
    expect(await kimiWithVersion('2.0.2').checkAuthentication()).toMatchObject({ authenticated: true, user: 'Kimi Config' });
    write('.kimi-code/config.toml', '[providers.kimi.env]\nKIMI_API_KEY = "sk-xxx"\n');
    expect((await kimiWithVersion('2.0.2').checkAuthentication()).authenticated).toBe(true);
    // api_key_env names a shell variable; it is not a key.
    write('.kimi-code/config.toml', '[providers.kimi]\napi_key_env = "MY_KIMI_KEY"\n');
    expect((await kimiWithVersion('2.0.2').checkAuthentication()).authenticated).toBe(false);
  });

  it('kimi 2.x: KIMI_MODEL_NAME + KIMI_MODEL_API_KEY authenticate; shell keys the CLI ignores do not', async () => {
    process.env.MOONSHOT_API_KEY = 'sk-moonshot-env';
    process.env.KIMI_API_KEY = 'sk-kimi-env';
    process.env.ANTHROPIC_AUTH_TOKEN = 'token';
    expect((await kimiWithVersion('2.0.2').checkAuthentication()).authenticated).toBe(false);
    process.env.KIMI_MODEL_NAME = 'kimi-for-coding';
    expect((await kimiWithVersion('2.0.2').checkAuthentication()).authenticated).toBe(false);
    process.env.KIMI_MODEL_API_KEY = 'sk-model';
    expect((await kimiWithVersion('2.0.2').checkAuthentication()).authenticated).toBe(true);
  });

  it('kimi: a bare config with no key is NOT authenticated (existence is not proof)', async () => {
    write('.kimi/config.toml', '# scaffold only\ntheme = "dark"\n');
    write('.kimi-code/config.toml', 'default_permission_mode = "manual"\n');
    const p = kimiWithVersion(null);
    expect((await p.checkAuthentication()).authenticated).toBe(false);
    expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
  });
});
