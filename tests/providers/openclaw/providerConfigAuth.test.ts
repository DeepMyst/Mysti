import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('os', async original => {
  const actual = await original<typeof import('os')>();
  const homedir = () => fixture.home || actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});

import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import { hasOpenClawProviderConfigCredentials } from '../../../src/providers/openclaw/OpenClawProviderConfigAuth';

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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-openclaw-config-auth-'));
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

const custom = (apiKey?: unknown, baseUrl = 'https://example.invalid/v1') => ({ baseUrl, api: 'openai-completions', models: [{ id: 'fixture', name: 'Owned fixture' }], ...(apiKey === undefined ? {} : { apiKey }) });
function configure(entry: unknown, extra: object = {}) {
  write(path.join(defaultState(), 'openclaw.json'), JSON.stringify({ agents: { defaults: { model: 'owned/fixture' } }, models: { providers: { owned: entry } }, ...extra }));
}

it.each(['owned-config-key', '  owned-config-key\n', 'tenant:owned-secret'])('recognizes a selected provider literal API key %j', async key => {
  configure(custom(key)); expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
});

it('matches the successful isolated native inference configuration', async () => {
  configure(custom('owned-native-fixture-key', 'http://127.0.0.1:9/v1'));
  const p = provider(); expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
  expect((await p.checkAuthentication()).authenticated).toBe(true);
});

it.each(['$OWNED_CONFIG_KEY', '${OWNED_CONFIG_KEY}', 'secretref-env:OWNED_CONFIG_KEY', '__env__:OWNED_CONFIG_KEY',
  { source: 'env', provider: 'default', id: 'OWNED_CONFIG_KEY' }])('resolves a configured provider env reference %j', async key => {
  vi.stubEnv('OWNED_CONFIG_KEY', 'owned-env-key'); configure(custom(key));
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
});

it('resolves a known environment-variable marker without treating its name as a key', async () => {
  configure(custom('OPENAI_API_KEY')); const p = provider(); expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
  vi.stubEnv('OPENAI_API_KEY', 'owned-marker-key'); expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
  vi.stubEnv('OPENAI_API_KEY', ''); expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
});

it.each(['http://localhost:9/v1', 'http://127.0.0.1:9/v1', 'http://[::1]:9/v1'])('recognizes complete local no-auth provider configuration %s', async url => {
  configure(custom(undefined, url)); expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
});

it.each(['', ' ', '🙂', { value: 'not-a-key' }, { source: 'env', provider: 'default', id: 'MISSING_OWNED_KEY' },
  { source: 'exec', provider: 'default', id: 'not-run' }, { source: 'file', provider: 'default', id: '/not-read' }])('does not borrow availability from an unusable remote config key %j', async key => {
  configure(custom(key)); expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
});

it('refreshes readiness when a literal config key is added, rotated and removed', async () => {
  configure(custom()); const p = provider(); expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
  configure(custom('first')); expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
  configure(custom('second')); expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
  configure(custom()); expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
});

it('uses the selected agent and its fallback override without borrowing an unselected provider key', async () => {
  const p = provider();
  configure(custom('owned-key'), { agents: { defaults: { model: 'other/fixture' } } });
  expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
  configure(custom('owned-key'), { agents: { defaults: { model: { primary: 'other/fixture', fallbacks: ['owned/fixture'] } } } });
  expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
  configure(custom('owned-key'), { agents: { defaults: { model: { primary: 'other/fixture', fallbacks: ['owned/fixture'] } }, list: [{ id: 'writer', model: { primary: 'other/fixture', fallbacks: [] } }] } });
  expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
});

it('recognizes case-normalized provider selection and configured model aliases', async () => {
  configure(custom('owned-key'), { agents: { defaults: { model: 'Owned Alias', models: { 'OWNED/fixture': { alias: 'Owned Alias' } } } } });
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
});

it.each(['owned/fixture@owned-profile', 'unknown/fixture', 'unresolved-alias'])('does not infer configured credentials for %s', async model => {
  configure(custom('owned-key'), { agents: { defaults: { model } } });
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
});

it('enforces a named environment provider allowlist and rechecks rotation', async () => {
  vi.stubEnv('OWNED_CONFIG_KEY', 'owned-ref-key');
  const ref = { source: 'env', provider: 'team', id: 'OWNED_CONFIG_KEY' };
  const p = provider();
  configure(custom(ref), { secrets: { providers: { team: { source: 'env', allowlist: [] } } } });
  expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
  configure(custom(ref), { secrets: { providers: { team: { source: 'env', allowlist: ['OWNED_CONFIG_KEY'] } } } });
  expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
  vi.stubEnv('OWNED_CONFIG_KEY', '🙂');
  expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
});

it.each(['$MISSING_OWNED_KEY', '${MISSING_OWNED_KEY}', 'OPENAI_API_KEY',
  { source: 'env', provider: 'default', id: 'MISSING_OWNED_KEY' },
  { source: 'exec', provider: 'default', id: 'not-run' }])('does not replace unavailable explicit local credentials with no-auth eligibility: %j', async key => {
  configure(custom(key, 'http://localhost:9/v1'));
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
});

it.each(['custom-local', 'ollama-local', 'lmstudio-local', 'oauth:owned', 'AWS_PROFILE', 'secretref-managed'])('only recognizes the marker %s with a complete supported local configuration', async key => {
  const p = provider(); configure(custom(key));
  expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
  configure(custom(key, 'http://localhost:9/v1'));
  expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
  configure({ ...custom(key, 'http://localhost:9/v1'), api: 'anthropic-messages' });
  expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
});

it.each([{ api: '' }, { models: [] }, { baseUrl: 'https://remote.example.invalid' }, { auth: 'oauth' }, { auth: 'token' }, { auth: 'aws-sdk' }])('rejects incomplete or incompatible local no-auth configuration %j', async override => {
  configure({ ...custom(undefined, 'http://localhost:9/v1'), ...override });
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
});

it('never treats an existing profile id or a gateway fallback as configured backend key material', () => {
  const cfg = { agents: { defaults: { model: 'owned/fixture' } }, models: { providers: { owned: custom('owned-profile') } } };
  expect(hasOpenClawProviderConfigCredentials(cfg, { 'owned-profile': { type: 'api_key', provider: 'owned', key: '' } }, {})).toBe(false);
  cfg.models.providers.owned = custom('$MISSING_OWNED_KEY');
  expect(hasOpenClawProviderConfigCredentials(cfg, {}, { OPENCLAW_GATEWAY_TOKEN: 'owned-gateway-only' })).toBe(false);
});
