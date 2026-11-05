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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-openclaw-backend-env-'));
  fixture.home = path.join(root, 'home'); fs.mkdirSync(fixture.home);
  for (const key of [...environmentKeys, 'MODELSTUDIO_API_KEY', 'QWEN_API_KEY']) vi.stubEnv(key, '');
  clearMockConfig(); setMockConfig('openclawUseGateway', false);
});
afterEach(() => {
  (vscode.workspace as any).workspaceFolders = previousFolders;
  providers.splice(0).forEach(p => p.dispose()); vi.unstubAllEnvs();
  clearMockConfig();
  fixture.home = ''; fs.rmSync(root, { recursive: true, force: true });
});

function configure(model: unknown, extra: object = {}) {
  write(path.join(defaultState(), 'openclaw.json'), JSON.stringify({ agents: { defaults: { model } }, ...extra }));
}

it.each([
  ['openai', 'OPENAI_API_KEY'], ['openai', 'CODEX_API_KEY'], ['google', 'GEMINI_API_KEY'], ['google', 'GOOGLE_API_KEY'],
  ['openrouter', 'OPENROUTER_API_KEY'], ['github-copilot', 'COPILOT_GITHUB_TOKEN'], ['mistral', 'MISTRAL_API_KEY'],
  ['minimax', 'MINIMAX_CODE_PLAN_KEY'], ['minimax-cn', 'MINIMAX_API_KEY'], ['alibaba', 'DASHSCOPE_API_KEY'],
  ['qwen-dashscope', 'DASHSCOPE_API_KEY'], ['xai', 'XAI_API_KEY'], ['cerebras', 'CEREBRAS_API_KEY'],
  ['novita-ai', 'NOVITA_API_KEY'], ['huggingface', 'HF_TOKEN'], ['byteplus-plan', 'BYTEPLUS_API_KEY'],
])('recognizes configured %s credentials in %s', async (backend, key) => {
  configure(`${backend}/owned-model`); vi.stubEnv(key, 'owned-exported-credential');
  const p = provider(); expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
  expect((await p.checkAuthentication()).authenticated).toBe(true);
});

it.each(['OPENAI_API_KEY', 'CODEX_API_KEY'])('recognizes core %s without explicit model configuration', async key => {
  vi.stubEnv(key, 'owned-key'); expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
});

it.each(['openai', 'google', 'unknown', 'openai-codex'])('does not borrow an Anthropic key for explicitly selected %s', async backend => {
  configure(`${backend}/owned-model`); vi.stubEnv('ANTHROPIC_API_KEY', 'unrelated-credential');
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
});

it('uses the selected default agent model and refreshes readiness after configuration and env changes', async () => {
  configure('anthropic/default', { agents: { defaults: { model: 'anthropic/default' }, list: [
    { id: 'writer', model: { primary: 'google/owned' } }, { id: 'reviewer', default: true, model: 'openai/owned' },
  ] } });
  vi.stubEnv('GEMINI_API_KEY', 'unselected'); const p = provider(); expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
  vi.stubEnv('OPENAI_API_KEY', 'selected'); expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
  vi.stubEnv('OPENAI_API_KEY', ''); expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
  configure({ primary: 'google/owned' }); expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
});

it('recognizes a configured model alias and explicit fallback credentials', async () => {
  configure('fast', { agents: { defaults: { model: 'fast', models: { 'openai/owned': { alias: 'FAST' } } } } });
  vi.stubEnv('OPENAI_API_KEY', 'owned'); expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
  configure({ primary: 'google/owned', fallbacks: ['openai/owned'] });
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
});

it.each([undefined, '', ' ', '\t\n', '\x00\x7f\x9f', '🙂', '“”'])('rejects missing or blank backend environment material %j', async value => {
  configure('openai/owned'); vi.stubEnv('OPENAI_API_KEY', value);
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
});

it('recognizes material left after native secret normalization without mutating the environment', async () => {
  configure('openai/owned'); const value = ' \r owned\nKey🙂 ';
  vi.stubEnv('OPENAI_API_KEY', value); expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
  expect(process.env.OPENAI_API_KEY).toBe(value);
});

it('does not infer a model backend from ambient GitHub credentials alone', async () => {
  vi.stubEnv('GITHUB_TOKEN', 'owned-ambient-token');
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
  configure('github-copilot/owned'); expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
});

it.each(['openai-codex/owned', 'google-gemini-cli/owned', 'unknown/owned', 'openai/owned@pinned'])('does not borrow an OpenAI API key for %s', async model => {
  configure(model); vi.stubEnv('OPENAI_API_KEY', 'wrong-credential');
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
});

it('does not treat a profile-pinned model alias as environment eligibility', async () => {
  configure('pinned', { agents: { defaults: { model: 'pinned', models: { 'openai/owned@pinned': { alias: 'pinned' } } } } });
  vi.stubEnv('OPENAI_API_KEY', 'wrong-credential'); expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
});

it.each(['google/agent', { primary: 'google/agent' }, { primary: 'google/agent', fallbacks: [] }])('lets an agent override clear inherited fallback eligibility: %j', async model => {
  configure(undefined, { agents: { defaults: { model: { primary: 'anthropic/default', fallbacks: ['openai/fallback'] } }, list: [{ id: 'writer', model }] } });
  vi.stubEnv('OPENAI_API_KEY', 'unused-default-fallback');
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
});

it('inherits default fallbacks when the agent does not override the model', async () => {
  configure(undefined, { agents: { defaults: { model: { primary: 'google/default', fallbacks: ['openai/fallback'] } }, list: [{ id: 'writer' }] } });
  vi.stubEnv('OPENAI_API_KEY', 'owned-fallback'); expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
});

it('ignores malformed or unresolved fallback entries without broadening the selected backend', async () => {
  configure({ primary: 'google/owned', fallbacks: [null, {}, 4, '', 'unknown-alias'] });
  vi.stubEnv('OPENAI_API_KEY', 'unrelated'); vi.stubEnv('ANTHROPIC_API_KEY', 'unrelated');
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(false);
});

it('recognizes a unique configured bare model and keeps an exact provider row ahead of an alias', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'owned');
  configure('owned', { models: { providers: { openai: { models: [{ id: 'owned' }] } } } });
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
  configure('openai/owned', { models: { providers: { openai: { models: [{ id: 'owned' }] } } },
    agents: { defaults: { model: 'openai/owned', models: { 'google/other': { alias: 'openai/owned' } } } } });
  expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
});

it('keeps gateway readiness independent of the local backend selection', async () => {
  configure('unknown/owned'); vi.stubEnv('OPENCLAW_GATEWAY_TOKEN', 'owned-gateway');
  setMockConfig('openclawUseGateway', true); const p = provider(); expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
  setMockConfig('openclawUseGateway', false); expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
});
