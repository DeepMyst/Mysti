import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';

const environmentKeys = ['OPENCLAW_CONFIG_PATH', 'OPENCLAW_STATE_DIR', 'OPENCLAW_HOME',
  'OPENCLAW_AGENT_DIR', 'OPENCLAW_TEST_FAST', 'LITECLAW_STATE_DIR', 'LITECLAW_AGENT_DIR',
  'PI_CODING_AGENT_DIR', 'OPENCLAW_GATEWAY_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'AZURE_OPENAI_API_KEY', 'BYTEPLUS_API_KEY', 'CEREBRAS_API_KEY', 'CODEX_API_KEY', 'COHERE_API_KEY', 'COMFY_API_KEY', 'COMFY_CLOUD_API_KEY', 'COPILOT_GITHUB_TOKEN', 'DASHSCOPE_API_KEY', 'FAL_API_KEY', 'FAL_KEY', 'GEMINI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_API_KEY', 'HF_TOKEN', 'HUGGINGFACE_HUB_TOKEN', 'LITELLM_API_KEY', 'LM_API_TOKEN', 'MINIMAX_API_KEY', 'MINIMAX_CODE_PLAN_KEY', 'MINIMAX_CODING_API_KEY', 'MINIMAX_OAUTH_TOKEN', 'MISTRAL_API_KEY', 'NOVITA_API_KEY', 'NVIDIA_API_KEY', 'OLLAMA_API_KEY', 'OPENAI_API_KEY', 'OPENCODE_API_KEY', 'OPENCODE_ZEN_API_KEY', 'OPENROUTER_API_KEY', 'SGLANG_API_KEY', 'SYNTHETIC_API_KEY', 'TOGETHER_API_KEY', 'VLLM_API_KEY', 'VOLCANO_ENGINE_API_KEY', 'VOYAGE_API_KEY', 'VYDRA_API_KEY', 'XAI_API_KEY', 'XIAOMI_API_KEY', 'XIAOMI_TOKEN_PLAN_API_KEY'];
const providers: TestableOpenClawProvider[] = [];
let root: string;
let previousFolders: typeof vscode.workspace.workspaceFolders;
function write(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
}
function provider() { const p = new TestableOpenClawProvider(); providers.push(p); return p; }
const defaultState = () => path.join(fixture.home, '.openclaw');
beforeEach(() => {
  previousFolders = vscode.workspace.workspaceFolders;
  (vscode.workspace as any).workspaceFolders = undefined;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-openclaw-json-precedence-'));
  fixture.home = path.join(root, 'home'); fs.mkdirSync(fixture.home);
  for (const key of [...environmentKeys, 'MODELSTUDIO_API_KEY', 'QWEN_API_KEY', 'OWNED_CONFIG_KEY', 'MISSING_OWNED_KEY']) vi.stubEnv(key, '');
  clearMockConfig(); setMockConfig('openclawUseGateway', false);
});
afterEach(() => {
  (vscode.workspace as any).workspaceFolders = previousFolders;
  providers.splice(0).forEach(p => p.dispose()); vi.unstubAllEnvs();
  clearMockConfig();
  fixture.home = ''; fs.rmSync(root, { recursive: true, force: true });
});

const credential = { type: 'api_key', provider: 'owned', key: 'owned-static-key' };
const expired = { type: 'token', provider: 'owned', token: 'owned-expired', expires: 1 };
const dir = (id = 'main') => path.join(defaultState(), 'agents', id, 'agent');
function configure(model = 'owned/fixture', agent = 'main') {
  write(path.join(defaultState(), 'openclaw.json'), JSON.stringify({ agents: { list: [{ id: agent, model }] } }));
}
function json(name: string, value: unknown, agent = 'main') { write(path.join(dir(agent), name), JSON.stringify(value)); }
function selected(version: string | null = '2026.6.1') { const p = provider(); (p as any)._cachedCliVersion = version; return p; }

it.each([null, '2026.6.1'])('a valid profile envelope supersedes retired auth.json for CLI %j', async version => {
  configure(); json('auth.json', { owned: credential }); const p = selected(version);
  for (const profiles of [{}, { expired }, { malformed: {} }, { unrelated: { ...credential, provider: 'other' } }]) {
    json('auth-profiles.json', { version: 1, profiles });
    expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
  }
});
it('cannot pin a removed legacy profile that is absent from the authoritative JSON store', async () => {
  configure('owned/fixture@owned:default'); json('auth.json', { owned: credential });
  json('auth-profiles.json', { profiles: { alternative: credential } });
  expect((await selected().getAuthConfig()).isAuthenticated).toBe(false);
});
it('rechecks legacy fallback after the modern store is created, cleared and removed', async () => {
  configure(); json('auth.json', { owned: credential }); const p = selected();
  expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
  json('auth-profiles.json', { profiles: {} }); expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
  json('auth-profiles.json', { profiles: { chosen: credential } }); expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
  json('auth-profiles.json', { profiles: {} }); expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
  fs.unlinkSync(path.join(dir(), 'auth-profiles.json')); expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
});
it.each([{ version: 1 }, { profiles: null }, { profiles: [] }, { profiles: 'invalid' }])('keeps native legacy fallback for malformed envelope %j', async modern => {
  configure(); json('auth.json', { owned: credential }); json('auth-profiles.json', modern);
  expect((await selected().getAuthConfig()).isAuthenticated).toBe(true);
});
it('lets runtime JSON order override embedded order and rechecks changes without writes', async () => {
  configure(); json('auth-profiles.json', { profiles: { chosen: expired, alternative: credential }, order: { owned: ['alternative'] } });
  json('auth-state.json', { order: { owned: ['chosen'] } }); const p = selected();
  const snapshot = () => Object.fromEntries(fs.readdirSync(dir()).map(file => [file, fs.readFileSync(path.join(dir(), file), 'utf8')]));
  const before = snapshot(); expect((await p.getAuthConfig()).isAuthenticated).toBe(false); expect(snapshot()).toEqual(before);
  json('auth-state.json', { order: { owned: ['alternative'] } }); expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
  json('auth-state.json', { order: { owned: ['chosen'] } }); expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
  fs.unlinkSync(path.join(dir(), 'auth-state.json')); expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
});
it('uses runtime JSON order to recover from an expired embedded selection', async () => {
  configure(); json('auth-profiles.json', { profiles: { chosen: expired, alternative: credential }, order: { owned: ['chosen'] } });
  json('auth-state.json', { order: { ' OWNED ': [' alternative ', 'alternative', null] } });
  expect((await selected().getAuthConfig()).isAuthenticated).toBe(true);
});
it.each([null, [], {}, { order: { owned: [] } }, { order: { owned: 'alternative' } }, { order: { owned: [null, ' '] } }])('ignores malformed/empty runtime order %j and retains embedded order', async state => {
  configure(); json('auth-profiles.json', { profiles: { chosen: expired, alternative: credential }, order: { owned: ['chosen'] } });
  json('auth-state.json', state); expect((await selected().getAuthConfig()).isAuthenticated).toBe(false);
});
it('keeps embedded order when the runtime state file is unreadable JSON', async () => {
  configure(); json('auth-profiles.json', { profiles: { chosen: credential }, order: { owned: ['chosen'] } });
  write(path.join(dir(), 'auth-state.json'), '{ invalid'); expect((await selected().getAuthConfig()).isAuthenticated).toBe(true);
});
it('inherits the main agent runtime JSON selection', async () => {
  configure('owned/fixture', 'writer'); json('auth-profiles.json', { profiles: { chosen: expired, alternative: credential } });
  json('auth-state.json', { order: { owned: ['chosen'] } });
  expect((await selected().getAuthConfig()).isAuthenticated).toBe(false);
});
it('respects an agent-local runtime order over inherited main order', async () => {
  configure('owned/fixture', 'writer'); json('auth-profiles.json', { profiles: { alternative: credential }, order: { owned: ['alternative'] } });
  json('auth-profiles.json', { profiles: { chosen: expired } }, 'writer');
  json('auth-state.json', { order: { owned: ['chosen'] } }, 'writer');
  expect((await selected().getAuthConfig()).isAuthenticated).toBe(false);
});
it('does not apply a detached runtime JSON state to auth.json fallback', async () => {
  configure(); json('auth.json', { owned: credential }); json('auth-state.json', { order: { owned: ['other'] } });
  expect((await selected().getAuthConfig()).isAuthenticated).toBe(true);
});
it('never mixes retired runtime JSON state into current SQLite selection', async () => {
  configure(); json('auth-state.json', { order: { owned: ['expired'] } });
  const db = new DatabaseSync(path.join(dir(), 'openclaw-agent.sqlite'));
  try { db.exec('CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT)'); db.prepare('INSERT INTO auth_profile_store VALUES (?, ?)').run('primary', JSON.stringify({ profiles: { expired, available: credential } })); }
  finally { db.close(); }
  expect((await selected('2026.6.34').getAuthConfig()).isAuthenticated).toBe(true);
});
it('does not create missing state files during legacy readiness', async () => {
  configure(); const before = fs.readdirSync(defaultState());
  expect((await selected().getAuthConfig()).isAuthenticated).toBe(false);
  expect(fs.readdirSync(defaultState())).toEqual(before);
});
