/**
 * Codex + Gemini auth detection — regression guard for the OAuth wrong-path bug:
 * codex OAuth lives in ~/.codex/auth.json (the old check looked only at
 * config.toml) and gemini OAuth lives in ~/.gemini/oauth_creds.json (the old
 * check required an `auth` field in settings.json). An OAuth-only install was
 * wrongly reported unauthenticated, so the Mysti coordinator skipped delegating.
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

import { TestableCodexProvider, TestableGeminiProvider } from './../helpers/providerFactory';

/**
 * Every env var the Claude/Codex/Gemini checkAuthentication/getAuthConfig
 * implementations consult (Plan 18 4.8). Scrubbing only OPENAI_API_KEY +
 * GEMINI_API_KEY let an ambient GOOGLE_API_KEY / Vertex config / Claude token
 * on the dev machine flip the negative-auth tests (fail, or pass for the
 * wrong reason via the API-key branch instead of the OAuth-file branch).
 */
const PROVIDER_AUTH_ENV_VARS = [
  // Codex (CodexProvider.getAuthConfig/checkAuthentication)
  'OPENAI_API_KEY',
  // Gemini API-key + Vertex AI mode (GeminiProvider.getAuthConfig/checkAuthentication)
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  // Claude (ClaudeCodeProvider.getAuthConfig)
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

describe('Codex + Gemini OAuth auth detection', () => {
  let tmpHome: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpHome = realFs.mkdtempSync(path.join(realOs.tmpdir(), 'mysti-oauth-home-'));
    hoisted.home = tmpHome;
    for (const key of PROVIDER_AUTH_ENV_VARS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    hoisted.home = '';
    realFs.rmSync(tmpHome, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  function write(rel: string, content: string): void {
    const p = path.join(tmpHome, rel);
    realFs.mkdirSync(path.dirname(p), { recursive: true });
    realFs.writeFileSync(p, content);
  }

  describe('codex', () => {
    it('is authenticated with ~/.codex/auth.json (OAuth login) even without config.toml', async () => {
      write('.codex/auth.json', JSON.stringify({ tokens: { access_token: 'x' } }));
      const provider = new TestableCodexProvider();
      expect((await provider.getAuthConfig()).isAuthenticated).toBe(true);
      expect((await provider.checkAuthentication()).authenticated).toBe(true);
    });

    it('does NOT treat a bare config.toml as auth (review[8]: survives `codex logout`), but OPENAI_API_KEY does', async () => {
      // config.toml (settings, may exist without login) alone must NOT authenticate —
      // it persists after `codex logout` removes auth.json.
      write('.codex/config.toml', 'model = "gpt-5"');
      expect((await new TestableCodexProvider().getAuthConfig()).isAuthenticated).toBe(false);
      realFs.rmSync(path.join(tmpHome, '.codex'), { recursive: true, force: true });
      process.env.OPENAI_API_KEY = 'sk-test';
      expect((await new TestableCodexProvider().getAuthConfig()).isAuthenticated).toBe(true);
    });

    it('is NOT authenticated with nothing present', async () => {
      const provider = new TestableCodexProvider();
      expect((await provider.getAuthConfig()).isAuthenticated).toBe(false);
      const status = await provider.checkAuthentication();
      expect(status.authenticated).toBe(false);
      expect(provider.getAuthCommand()).toBe('codex login');
      expect(status.error).toContain('"codex login"');
    });
  });

  describe('gemini', () => {
    it('is authenticated with ~/.gemini/oauth_creds.json (OAuth login) even without an auth field in settings.json', async () => {
      write('.gemini/oauth_creds.json', JSON.stringify({ access_token: 'x', refresh_token: 'y' }));
      const provider = new TestableGeminiProvider();
      expect((await provider.getAuthConfig()).isAuthenticated).toBe(true);
      expect((await provider.checkAuthentication()).authenticated).toBe(true);
    });

    it('surfaces the account email from google_accounts.json when present', async () => {
      write('.gemini/oauth_creds.json', JSON.stringify({ access_token: 'x' }));
      write('.gemini/google_accounts.json', JSON.stringify({ active: 'dev@example.com' }));
      expect((await new TestableGeminiProvider().checkAuthentication()).user).toBe('dev@example.com');
    });

    // Plan 18 4.7b — accounts.accounts[0] may be an OBJECT; the label must never
    // render "[object Object]".
    it('uses the .email field when accounts.accounts[0] is an object', async () => {
      write('.gemini/oauth_creds.json', JSON.stringify({ access_token: 'x' }));
      write('.gemini/google_accounts.json', JSON.stringify({
        accounts: [{ email: 'obj@example.com', scopes: ['a'] }],
      }));
      expect((await new TestableGeminiProvider().checkAuthentication()).user).toBe('obj@example.com');
    });

    it('falls back to .account/.user fields on an object account entry', async () => {
      write('.gemini/oauth_creds.json', JSON.stringify({ access_token: 'x' }));
      write('.gemini/google_accounts.json', JSON.stringify({
        accounts: [{ account: 'acct@example.com' }],
      }));
      expect((await new TestableGeminiProvider().checkAuthentication()).user).toBe('acct@example.com');

      write('.gemini/google_accounts.json', JSON.stringify({
        accounts: [{ user: 'user@example.com' }],
      }));
      expect((await new TestableGeminiProvider().checkAuthentication()).user).toBe('user@example.com');
    });

    it('falls back to the generic label when the object account entry has no known fields', async () => {
      write('.gemini/oauth_creds.json', JSON.stringify({ access_token: 'x' }));
      write('.gemini/google_accounts.json', JSON.stringify({
        accounts: [{ id: 12345 }],
      }));
      const status = await new TestableGeminiProvider().checkAuthentication();
      expect(status.user).toBe('Google Account');
      expect(status.user).not.toContain('[object Object]');
    });

    it('is NOT authenticated with nothing present', async () => {
      const result = await new TestableGeminiProvider().checkAuthentication();
      expect(result.authenticated).toBe(false);
      expect(result.error).toContain('Gemini Code Assist Standard or Enterprise license');
      expect(result.error).toContain('GEMINI_API_KEY / GOOGLE_API_KEY or Vertex AI');
      expect(result.error).toContain('Antigravity CLI');
    });

    // Plan 18 4.8 — these branches consult exactly the env vars the scrub list
    // covers; with an ambient GOOGLE_API_KEY/Vertex config the negative tests
    // above would fail (or pass through the wrong branch) without the scrub.
    it('authenticates via GOOGLE_API_KEY (scrubbed by the harness, set explicitly here)', async () => {
      process.env.GOOGLE_API_KEY = 'g-key';
      const status = await new TestableGeminiProvider().checkAuthentication();
      expect(status.authenticated).toBe(true);
      expect(status.user).toBe('API Key');
    });

    it('authenticates via Vertex AI env config (GOOGLE_GENAI_USE_VERTEXAI + GOOGLE_CLOUD_PROJECT)', async () => {
      process.env.GOOGLE_GENAI_USE_VERTEXAI = 'true';
      process.env.GOOGLE_CLOUD_PROJECT = 'my-project';
      const status = await new TestableGeminiProvider().checkAuthentication();
      expect(status.authenticated).toBe(true);
      expect(status.user).toBe('Vertex AI');
    });
  });
});
