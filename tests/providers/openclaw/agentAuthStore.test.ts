import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DatabaseSync } from 'node:sqlite';
const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('os', async original => {
  const actual = await original<typeof import('os')>();
  const homedir = () => fixture.home || actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { resolveOpenClawPaths } from '../../../src/utils/platform';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';

const envKeys = ['OPENCLAW_CONFIG_PATH', 'OPENCLAW_STATE_DIR', 'OPENCLAW_HOME', 'OPENCLAW_AGENT_DIR',
  'OPENCLAW_TEST_FAST', 'LITECLAW_STATE_DIR', 'LITECLAW_AGENT_DIR', 'PI_CODING_AGENT_DIR',
  'OPENCLAW_GATEWAY_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'];
const providers: TestableOpenClawProvider[] = [];
let previousFolders: typeof vscode.workspace.workspaceFolders;
const state = () => path.join(fixture.home, '.openclaw');
const agentDir = (id = 'main') => path.join(state(), 'agents', id, 'agent');
const key = { type: 'api_key', provider: 'anthropic', key: 'synthetic-key' };
const profiles = (value: unknown = key) => ({ version: 1, profiles: { 'anthropic:default': value } });
function write(file: string, text: string) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function configure(list: unknown) { write(path.join(state(), 'openclaw.json'), JSON.stringify({ agents: { list } })); }
function jsonStore(dir: string, data: unknown = profiles()) { write(path.join(dir, 'auth-profiles.json'), JSON.stringify(data)); }
function sqliteStore(dir: string, data: unknown = profiles(), rowKey = 'primary') {
  fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, 'openclaw-agent.sqlite');
  const db = new DatabaseSync(file);
  try {
    // Reproducible fixture setup tests reads, not power-loss durability.
    db.exec('PRAGMA synchronous=OFF');
    db.exec('CREATE TABLE IF NOT EXISTS auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT, updated_at INTEGER)');
    db.prepare('INSERT OR REPLACE INTO auth_profile_store VALUES (?, ?, 1)').run(rowKey, JSON.stringify(data));
  } finally { db.close(); }
  return file;
}
function provider() { const p = new TestableOpenClawProvider(); providers.push(p); return p; }
beforeEach(() => {
  previousFolders = vscode.workspace.workspaceFolders;
  (vscode.workspace as any).workspaceFolders = undefined;
  fixture.home = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-agent-auth-'));
  for (const key of envKeys) vi.stubEnv(key, '');
  clearMockConfig(); setMockConfig('openclawUseGateway', false);
});
afterEach(() => {
  (vscode.workspace as any).workspaceFolders = previousFolders;
  providers.splice(0).forEach(p => p.dispose());
  vi.unstubAllEnvs(); clearMockConfig(); fs.rmSync(fixture.home, { recursive: true, force: true }); fixture.home = '';
});

describe('OpenClaw configured default agent credentials', () => {
  it.each([
    ['first listed agent', [{ id: 'writer' }, { id: 'reviewer' }], 'writer'],
    ['explicit default', [{ id: 'writer' }, { id: 'reviewer', default: true }], 'reviewer'],
    ['first of multiple defaults', [{ id: 'writer', default: true }, { id: 'reviewer', default: true }], 'writer'],
    ['normalized id', [{ id: ' Review Team ' }], 'review-team'],
    ['valid trailing hyphen', [{ id: 'Writer-' }], 'writer-'],
    ['invalid leading hyphen', [{ id: '-Writer' }], 'writer'],
    ['missing list', undefined, 'main'],
    ['empty list', [], 'main'],
  ] as const)('uses %s', async (_label, list, id) => {
    configure(list); jsonStore(agentDir(id));
    expect(resolveOpenClawPaths().agentDir).toBe(agentDir(id));
    expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
  });
  it.each(['absolute', 'relative', 'tilde'])('resolves a configured %s agent directory', async kind => {
    const selected = path.join(fixture.home, 'selected-agent');
    const configured = kind === 'absolute' ? selected : kind === 'tilde' ? '~/selected-agent' : path.relative(process.cwd(), selected);
    configure([{ id: 'writer', default: true, agentDir: ` ${configured} ` }]); jsonStore(selected);
    expect(resolveOpenClawPaths().agentDir).toBe(selected);
    expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
  });
  it('uses the first matching normalized agent entry for its directory', async () => {
    const selected = path.join(fixture.home, 'first-agent');
    configure([{ id: 'writer', agentDir: selected }, { id: 'WRITER', default: true, agentDir: '~/unused' }]); jsonStore(selected);
    expect(resolveOpenClawPaths().agentDir).toBe(selected);
    expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
  });
  it('does not borrow another listed agent’s credentials', async () => {
    configure([{ id: 'writer', default: true }, { id: 'reviewer' }]); jsonStore(agentDir('reviewer'));
    expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
  });
  it('honors the explicit JSON5 config and rechecks after the default changes', async () => {
    const selected = path.join(fixture.home, 'selected-config.json5'); vi.stubEnv('OPENCLAW_CONFIG_PATH', selected);
    configure([{ id: 'unused' }]);
    write(selected, '{ agents: { list: [{ id: "writer", default: true, }], }, }'); jsonStore(agentDir('writer'));
    const p = provider(); expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
    write(selected, '{ agents: { list: [{ id: "reviewer", default: true }] } }');
    expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
    jsonStore(agentDir('reviewer')); expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
  });
  it.each(['OPENCLAW_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'LITECLAW_AGENT_DIR'])(
    'does not use deprecated %s for commands that explicitly resolve the configured agent', async envKey => {
      const unused = path.join(fixture.home, 'unused-override'); vi.stubEnv(envKey, unused); jsonStore(unused);
      configure([{ id: 'writer' }]);
      expect(resolveOpenClawPaths().agentDir).toBe(agentDir('writer'));
      expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
      jsonStore(agentDir('writer')); expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
    });
});

describe('OpenClaw SQLite auth stores', () => {
  it.each(['main', 'writer'])('reads the %s agent primary store without modifying it', async id => {
    configure([{ id }]); const file = sqliteStore(agentDir(id)); const before = fs.readFileSync(file);
    const p = provider(); expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
    expect((await p.checkAuthentication()).authenticated).toBe(true);
    expect(fs.readFileSync(file)).toEqual(before); expect(fs.readdirSync(agentDir(id))).toEqual(['openclaw-agent.sqlite']);
  });
  it('reads setup and revocation on the same provider without leaving a database open', async () => {
    const p = provider(); expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
    sqliteStore(agentDir()); expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
    sqliteStore(agentDir(), { profiles: {} }); expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
    fs.renameSync(path.join(agentDir(), 'openclaw-agent.sqlite'), path.join(agentDir(), 'moved.sqlite'));
    expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
  });
  it.each([{}, { version: 1 }, { profiles: {} }, profiles({ type: 'oauth', provider: 'anthropic' }),
    profiles({ type: 'token', provider: 'anthropic', token: 'synthetic-expired', expires: 1 })])(
    'rejects unusable stored records without falling back to stale JSON: %j', async data => {
      sqliteStore(agentDir(), data); jsonStore(agentDir());
      expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
    });
  it.each(['corrupt database', 'missing table', 'wrong row', 'malformed JSON'])(
    'does not fall back to stale JSON for %s', async kind => {
      jsonStore(agentDir()); const file = path.join(agentDir(), 'openclaw-agent.sqlite');
      if (kind === 'corrupt database') fs.writeFileSync(file, 'not sqlite');
      else {
        const db = new DatabaseSync(file);
        try {
          if (kind !== 'missing table') {
            // Reproducible malformed-row setup does not test power-loss durability.
            db.exec('PRAGMA synchronous=OFF');
            db.exec('CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT)');
            db.prepare('INSERT INTO auth_profile_store VALUES (?, ?)').run(kind === 'wrong row' ? 'other' : 'primary', kind === 'malformed JSON' ? '{ invalid' : JSON.stringify(profiles()));
          }
        } finally { db.close(); }
      }
      expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
    });
  it('keeps legacy JSON credentials available when no SQLite database exists', async () => {
    write(path.join(agentDir(), 'auth.json'), JSON.stringify({ anthropic: key }));
    expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
  });
  it('does not create any state files during a missing-store check', async () => {
    expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
    expect(fs.readdirSync(fixture.home)).toEqual([]);
  });
});

describe('OpenClaw main-store inheritance', () => {
  it('inherits main credentials for a configured agent with an empty local store', async () => {
    configure([{ id: 'writer' }]); sqliteStore(agentDir()); sqliteStore(agentDir('writer'), { profiles: {} });
    expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
  });
  it('lets a valid local profile replace an expired main profile', async () => {
    configure([{ id: 'writer' }]); sqliteStore(agentDir(), profiles({ type: 'token', provider: 'anthropic', token: 'synthetic-expired', expires: 1 }));
    sqliteStore(agentDir('writer')); expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
  });
  it('does not resurrect a main profile shadowed by an expired agent-local token', async () => {
    configure([{ id: 'writer' }]); sqliteStore(agentDir());
    sqliteStore(agentDir('writer'), profiles({ type: 'token', provider: 'anthropic', token: 'synthetic-expired', expires: 1 }));
    expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
  });
  it('ignores a malformed local entry instead of shadowing the inherited profile', async () => {
    configure([{ id: 'writer' }]); sqliteStore(agentDir()); sqliteStore(agentDir('writer'), profiles({ type: 'invalid' }));
    expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
  });
  it('keeps an independently named main profile when another is shadowed', async () => {
    configure([{ id: 'writer' }]); sqliteStore(agentDir(), { profiles: { 'anthropic:default': key, 'anthropic:backup': key } });
    sqliteStore(agentDir('writer'), profiles({ type: 'oauth', provider: 'anthropic' }));
    expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
  });
});
