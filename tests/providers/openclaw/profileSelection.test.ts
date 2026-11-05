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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-openclaw-profile-selection-'));
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

const key = (provider = 'owned') => ({ type: 'api_key', provider, key: 'owned-key' });
const expired = { type: 'token', provider: 'owned', token: 'expired-owned', expires: 1 };
function store(profiles: object, order?: object, agent = 'main') {
  write(path.join(defaultState(), 'agents', agent, 'agent', 'auth-profiles.json'), JSON.stringify({ profiles, order }));
}
function configure(model: unknown = 'owned/fixture', extra: object = {}) {
  write(path.join(defaultState(), 'openclaw.json'), JSON.stringify({ agents: { defaults: { model } }, ...extra }));
}
function bound(apiKey: unknown, extra: object = {}) {
  return { models: { providers: { owned: { apiKey, api: 'openai-completions', baseUrl: 'https://owned.example.invalid/v1', models: [{ id: 'fixture' }], ...extra } } } };
}
it('does not qualify a backend using an unrelated stored credential and refreshes selection', async () => {
  configure(); store({ unrelated: key('other') }); const p = provider();
  expect((await p.checkAuthentication()).authenticated).toBe(false);
  store({ selected: key() }); expect((await p.checkAuthentication()).authenticated).toBe(true);
  configure('other/fixture'); expect((await p.checkAuthentication()).authenticated).toBe(false);
});
it('honors configured fallbacks and explicit agent fallback removal', async () => {
  store({ backup: key() }); const p = provider();
  configure({ primary: 'other/model', fallbacks: ['owned/fixture'] }); expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
  configure(undefined, { agents: { defaults: { model: { primary: 'other/model', fallbacks: ['owned/fixture'] } }, list: [{ id: 'writer', model: 'other/model' }] } });
  expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
});
it('accepts supported built-in provider auth aliases', async () => {
  store({ selected: key('minimax') }); configure('minimax-api/fixture');
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
});
it.each(['missing', 'expired', 'empty'])('does not replace an explicit %s profile with another credential', async kind => {
  store({ other: key(), ...(kind === 'expired' ? { chosen: expired } : kind === 'empty' ? { chosen: { ...key(), key: '' } } : {}) });
  configure('owned/fixture@chosen', bound('owned-literal'));
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
});
it('accepts an explicit usable profile and honors native deliberate cross-provider pinning', async () => {
  configure('owned/fixture@chosen'); store({ chosen: key('other') });
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
});
it('resolves a pinned model alias', async () => {
  store({ other: key() }); configure(undefined, { agents: { defaults: { model: 'quick@chosen', models: { 'owned/fixture': { alias: 'quick' } } } } });
  const p = provider(); expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
  store({ chosen: key() }); expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
});
it.each(['owned/model@20260101', 'owned/model@q4_k_m', 'owned/model@8bit'])('keeps native model-version and quantization suffixes %s', async model => {
  store({ selected: key() }); configure(model); expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
});
it.each(['owned/model@20260101@chosen', 'owned/model@q4_k_m@chosen'])('recognizes a profile following a native model suffix %s', async model => {
  store({ other: key() }); configure(model); expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
});
it.each(['expired', 'different-provider', 'oauth'])('does not bypass an invalid %s provider-entry profile binding', async kind => {
  const chosen = kind === 'expired' ? expired : kind === 'different-provider' ? key('other') : { type: 'oauth', provider: 'owned', access: 'owned-access' };
  store({ chosen, alternative: key() }); configure('owned/fixture', bound('chosen'));
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
});
it('accepts a bearer profile binding with a matching provider or normalized base URL', async () => {
  store({ chosen: key() }); configure('owned/fixture', bound('chosen')); const p = provider();
  expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
  store({ chosen: key('other') });
  const cfg = bound('chosen'); (cfg.models.providers as any).other = { baseUrl: 'https://owned.example.invalid/v1/?ignored=1#fragment' };
  configure('owned/fixture', cfg); expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
});
it('does not bypass an invalid binding using an exported backend key', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'owned-env'); store({ chosen: { ...expired, provider: 'openai' } });
  configure('openai/fixture', { models: { providers: { openai: { apiKey: 'chosen', api: 'openai-completions' } } } });
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
});
it.each(['config', 'store'])('honors an explicit %s profile order containing an unusable existing profile', async source => {
  store({ chosen: expired, alternative: key() }, source === 'store' ? { owned: ['chosen'] } : undefined);
  configure('owned/fixture', source === 'config' ? { auth: { order: { owned: ['chosen'] } } } : {});
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
});
it('repairs an all-missing stored order but does not ignore an all-missing configured order', async () => {
  store({ selected: key() }, { owned: ['removed'] }); configure(); const p = provider();
  expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
  store({ selected: key() }); configure('owned/fixture', { auth: { order: { owned: ['removed'] } } });
  expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
});
it('uses the agent-local order and keeps local shadowing of an inherited profile', async () => {
  store({ chosen: key(), alternative: key() }, { owned: ['chosen', 'alternative'] });
  store({ chosen: expired }, { owned: ['chosen'] }, 'writer');
  configure(undefined, { agents: { list: [{ id: 'writer', model: 'owned/fixture' }] } });
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
});
it.each(['provider', 'mode'])('rejects incompatible configured profile %s metadata', async mismatch => {
  store({ chosen: key() }); configure('owned/fixture', { auth: { profiles: { chosen: { provider: mismatch === 'provider' ? 'other' : 'owned', mode: mismatch === 'mode' ? 'oauth' : 'api_key' } } } });
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
});
it('enforces direct OpenAI API credential modes when a model API is known', async () => {
  store({ chosen: { type: 'oauth', provider: 'openai', access: 'owned-access' } });
  configure('openai/fixture', { models: { providers: { openai: { api: 'openai-responses', models: [{ id: 'fixture' }] } } } });
  const p = provider(); expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
  configure('openai/fixture', { models: { providers: { openai: { api: 'openai-chatgpt-responses', models: [{ id: 'fixture' }] } } } });
  expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
});

it('uses SQLite runtime order ahead of embedded store order without changing either table', async () => {
  configure();
  const dir = path.join(defaultState(), 'agents/main/agent'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'openclaw-agent.sqlite');
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT); CREATE TABLE auth_profile_state (state_key TEXT PRIMARY KEY, state_json TEXT)');
    db.prepare('INSERT INTO auth_profile_store VALUES (?, ?)').run('primary', JSON.stringify({ profiles: { chosen: expired, alternative: key() }, order: { owned: ['alternative'] } }));
    db.prepare('INSERT INTO auth_profile_state VALUES (?, ?)').run('primary', JSON.stringify({ order: { owned: ['chosen'] } }));
  } finally { db.close(); }
  const bytes = fs.readFileSync(file), p = provider();
  expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
  expect(fs.readFileSync(file)).toEqual(bytes);
  const update = new DatabaseSync(file);
  try { update.prepare('UPDATE auth_profile_state SET state_json = ?').run(JSON.stringify({ order: { owned: ['alternative'] } })); }
  finally { update.close(); }
  expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
});
