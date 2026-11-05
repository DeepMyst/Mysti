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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-openclaw-store-format-'));
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
const dir = (id = 'main') => path.join(defaultState(), 'agents', id, 'agent');
function configure(agent = 'main') {
  write(path.join(defaultState(), 'openclaw.json'), JSON.stringify({ agents: { list: [{ id: agent, model: 'owned/fixture' }] } }));
}
function jsonStore(agent = 'main', file = 'auth-profiles.json') {
  write(path.join(dir(agent), file), JSON.stringify(file === 'auth.json' ? { owned: credential } : { version: 1, profiles: { chosen: credential } }));
}
function sqliteStore(profiles: object = { chosen: credential }, agent = 'main') {
  fs.mkdirSync(dir(agent), { recursive: true }); const db = new DatabaseSync(path.join(dir(agent), 'openclaw-agent.sqlite'));
  try {
    // Reproducible fixture setup tests formats, not power-loss durability.
    db.exec('PRAGMA synchronous=OFF');
    db.exec('CREATE TABLE IF NOT EXISTS auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT)');
    db.prepare('INSERT OR REPLACE INTO auth_profile_store VALUES (?, ?)').run('primary', JSON.stringify({ profiles }));
  } finally { db.close(); }
}
function selected(version: string | null, cliPath = path.join(root, 'standalone-openclaw')) {
  const p = provider(); (p as any)._cachedCliVersion = version; (p as any)._cachedCliPath = cliPath; return p;
}
function installation(version: string, name = 'openclaw') {
  const install = path.join(root, 'install-' + name), entry = path.join(install, 'openclaw.mjs');
  write(entry, '// Owned fixture, never executed\n');
  write(path.join(install, 'package.json'), JSON.stringify({ name, version, bin: { openclaw: './openclaw.mjs' } }));
  return entry;
}
it.each(['2026.6.5', 'OpenClaw 2026.6.34 (owned)', '2026.7.2-beta.5'])('does not count a JSON-only store for the SQLite CLI %s', async version => {
  configure(); jsonStore(); const p = selected(version);
  expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
  expect((await p.checkAuthentication()).authenticated).toBe(false);
  expect(fs.readdirSync(dir())).toEqual(['auth-profiles.json']);
});
it.each(['auth-profiles.json', 'auth.json'])('does not inherit retired %s credentials for a current CLI', async file => {
  configure('writer'); jsonStore('main', file);
  expect((await selected('2026.6.34').getAuthConfig()).isAuthenticated).toBe(false);
});
it('detects the current npm package through the selected symlink before version discovery', async () => {
  configure(); jsonStore(); const entry = installation('2026.6.34'); const link = path.join(root, 'openclaw'); fs.symlinkSync(entry, link);
  expect((await selected(null, link).getAuthConfig()).isAuthenticated).toBe(false);
});
it('prefers fresh selected-package metadata over a stale discovered version after an upgrade', async () => {
  configure(); jsonStore(); const entry = installation('2026.6.1'), p = selected('2026.6.1', entry);
  expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
  installation('2026.6.34'); expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
  sqliteStore(); expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
});
it('follows a retargeted relative executable from the CLI workspace', async () => {
  configure(); jsonStore(); const entry = installation('2026.6.1');
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: workspace } }];
  const link = path.join(workspace, 'openclaw'); fs.symlinkSync(entry, link);
  const p = selected(null, './openclaw'); expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
  const current = path.join(root, 'current'); fs.mkdirSync(current);
  write(path.join(current, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.6.34', bin: './cli.mjs' }));
  write(path.join(current, 'cli.mjs'), '// Owned fixture, never executed');
  fs.unlinkSync(link); fs.symlinkSync(path.join(current, 'cli.mjs'), link);
  expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
});
it('follows the selected installation rather than a neighboring package', async () => {
  configure(); jsonStore(); const foreign = installation('2026.6.34', 'other-tool');
  expect((await selected('2026.6.1', foreign).getAuthConfig()).isAuthenticated).toBe(true);
  const entry = installation('2026.6.34'); const wrapper = path.join(path.dirname(entry), 'other-wrapper'); write(wrapper, '// Not the declared OpenClaw bin');
  expect((await selected('2026.6.1', wrapper).getAuthConfig()).isAuthenticated).toBe(true);
});
it('rejects current SQLite metadata when its bin points to a different file', async () => {
  configure(); jsonStore(); const entry = installation('2026.6.34');
  write(path.join(path.dirname(entry), 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.6.34', bin: { openclaw: 'different.mjs' } }));
  expect((await selected('2026.6.1', entry).getAuthConfig()).isAuthenticated).toBe(true);
});
it.each(['2026.5.28', '2026.6.1'])('keeps legacy JSON authoritative for %s even if a newer database exists', async version => {
  configure(); jsonStore(); sqliteStore({}); const p = selected(version);
  expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
  fs.unlinkSync(path.join(dir(), 'auth-profiles.json')); sqliteStore();
  expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
});
it('uses the SQLite store when current and never resurrects removed credentials from JSON', async () => {
  configure(); jsonStore(); sqliteStore(); const p = selected('2026.6.34');
  expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
  sqliteStore({}); expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
});
it.each([null, 'custom-build-without-version', '2026.6.3-alpha.1'])('retains bounded format compatibility when the version is unqualified: %j', async version => {
  configure(); jsonStore(); const p = selected(version); expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
  sqliteStore({}); expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
});
it('keeps configured backend keys available without a credential database', async () => {
  configure(); jsonStore(); const p = selected('2026.6.34');
  write(path.join(defaultState(), 'openclaw.json'), JSON.stringify({ agents: { defaults: { model: 'owned/fixture' } }, models: { providers: { owned: { apiKey: 'owned-config-key' } } } }));
  expect((await p.getAuthConfig()).isAuthenticated).toBe(true);
});
it('does not inspect the CLI or local stores for a configured gateway credential', async () => {
  vi.stubEnv('OPENCLAW_GATEWAY_TOKEN', 'owned-gateway-key'); setMockConfig('openclawUseGateway', true);
  const p = selected('2026.6.34'); const getPath = vi.spyOn(p, 'getCliPath');
  expect((await p.getAuthConfig()).isAuthenticated).toBe(true); expect(getPath).not.toHaveBeenCalled();
});
