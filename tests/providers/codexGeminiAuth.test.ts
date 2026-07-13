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

describe('Codex + Gemini OAuth auth detection', () => {
  let tmpHome: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpHome = realFs.mkdtempSync(path.join(realOs.tmpdir(), 'mysti-oauth-home-'));
    hoisted.home = tmpHome;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
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
      expect((await new TestableCodexProvider().getAuthConfig()).isAuthenticated).toBe(false);
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

    it('is NOT authenticated with nothing present', async () => {
      expect((await new TestableGeminiProvider().checkAuthentication()).authenticated).toBe(false);
    });
  });
});
