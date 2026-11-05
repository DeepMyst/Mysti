import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { readOpenClawToken, resolveOpenClawPaths } from '../../../src/utils/platform';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';

const environmentKeys = ['OPENCLAW_CONFIG_PATH', 'OPENCLAW_STATE_DIR', 'OPENCLAW_HOME',
  'OPENCLAW_AGENT_DIR', 'OPENCLAW_TEST_FAST', 'LITECLAW_STATE_DIR', 'LITECLAW_AGENT_DIR',
  'PI_CODING_AGENT_DIR', 'OPENCLAW_GATEWAY_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'];
const providers: TestableOpenClawProvider[] = [];
let root: string;
let previousFolders: typeof vscode.workspace.workspaceFolders;
function write(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
}
function config(file: string, token = 'synthetic-selected-token') {
  write(file, `{ // owned fixture\n email: 'selected@example.invalid', gateway: { auth: { token: '${token}' } } }`);
}
function credentials(agentDir: string) {
  write(path.join(agentDir, 'auth-profiles.json'), JSON.stringify({ profiles: {
    'owned:default': { type: 'api_key', provider: 'anthropic', key: 'synthetic-profile-key' },
  } }));
}
function provider() { const p = new TestableOpenClawProvider(); providers.push(p); return p; }
async function expectSelected(file: string, agentDir: string) {
  config(file); credentials(agentDir);
  expect(readOpenClawToken()).toBe('synthetic-selected-token');
  const p = provider();
  expect(await p.getAuthConfig()).toMatchObject({ configPath: file, isAuthenticated: true });
  expect(await p.checkAuthentication()).toMatchObject({ authenticated: true, user: 'selected@example.invalid' });
}
const defaultState = () => path.join(fixture.home, '.openclaw');
const defaultAgent = () => path.join(defaultState(), 'agents/main/agent');
beforeEach(() => {
  previousFolders = vscode.workspace.workspaceFolders;
  (vscode.workspace as any).workspaceFolders = undefined;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-openclaw-paths-'));
  fixture.home = path.join(root, 'home'); fs.mkdirSync(fixture.home);
  for (const key of environmentKeys) vi.stubEnv(key, '');
  clearMockConfig(); setMockConfig('openclawUseGateway', false);
});
afterEach(() => {
  (vscode.workspace as any).workspaceFolders = previousFolders;
  providers.splice(0).forEach(p => p.dispose()); vi.unstubAllEnvs();
  clearMockConfig();
  fixture.home = ''; fs.rmSync(root, { recursive: true, force: true });
});

describe('OpenClaw selected configuration paths', () => {
  it('keeps default config and credential discovery', async () => {
    await expectSelected(path.join(defaultState(), 'openclaw.json'), defaultAgent());
  });

  it('uses an explicit config ahead of state and default configurations', async () => {
    const state = path.join(root, 'state'); vi.stubEnv('OPENCLAW_STATE_DIR', state);
    const selected = path.join(root, 'custom/config.json5'); vi.stubEnv('OPENCLAW_CONFIG_PATH', selected);
    config(path.join(defaultState(), 'openclaw.json'), 'synthetic-default-decoy');
    config(path.join(state, 'openclaw.json'), 'synthetic-state-decoy');
    await expectSelected(selected, path.join(state, 'agents/main/agent'));
  });

  it.each(['absolute', 'tilde', 'relative'] as const)('resolves a %s explicit config path', async kind => {
    const selected = path.join(fixture.home, 'selected/openclaw.json');
    const value = kind === 'absolute' ? selected : kind === 'tilde' ? '~/selected/openclaw.json' : path.relative(process.cwd(), selected);
    vi.stubEnv('OPENCLAW_CONFIG_PATH', `  ${value}  `);
    await expectSelected(selected, defaultAgent());
  });

  it.each(['absolute', 'tilde', 'relative'] as const)('resolves a %s state directory for both config and credentials', async kind => {
    const state = path.join(fixture.home, 'relocated-state');
    const value = kind === 'absolute' ? state : kind === 'tilde' ? '~/relocated-state' : path.relative(process.cwd(), state);
    vi.stubEnv('OPENCLAW_STATE_DIR', `  ${value}  `);
    config(path.join(defaultState(), 'openclaw.json'), 'synthetic-default-decoy');
    await expectSelected(path.join(state, 'openclaw.json'), path.join(state, 'agents/main/agent'));
  });

  it.each(['absolute', 'tilde'] as const)('honors a %s OpenClaw home without modifying the OS home', async kind => {
    const home = path.join(fixture.home, 'selected-home');
    vi.stubEnv('OPENCLAW_HOME', kind === 'absolute' ? home : '~/selected-home');
    const state = path.join(home, '.openclaw');
    await expectSelected(path.join(state, 'openclaw.json'), path.join(state, 'agents/main/agent'));
  });

  it('supports the legacy state/config location when the modern state is absent', async () => {
    const state = path.join(fixture.home, '.clawdbot');
    await expectSelected(path.join(state, 'clawdbot.json'), path.join(state, 'agents/main/agent'));
  });

  it('finds a legacy config even when the default modern state already exists', async () => {
    fs.mkdirSync(defaultState());
    await expectSelected(path.join(fixture.home, '.clawdbot/clawdbot.json'), defaultAgent());
  });

  it.each(['missing', 'malformed'] as const)('does not borrow another config token when the explicit config is %s', async kind => {
    config(path.join(defaultState(), 'openclaw.json'), 'synthetic-wrong-account');
    const selected = path.join(root, 'selected.json'); vi.stubEnv('OPENCLAW_CONFIG_PATH', selected);
    vi.stubEnv('OPENCLAW_GATEWAY_TOKEN', 'synthetic-environment-token');
    if (kind === 'malformed') write(selected, '{ not valid');
    expect(readOpenClawToken()).toBe('synthetic-environment-token');
    expect((await provider().getAuthConfig()).configPath).toBe(selected);
  });

  it('does not fall back to a default config when an explicit state has no config', async () => {
    const state = path.join(root, 'empty-state'); vi.stubEnv('OPENCLAW_STATE_DIR', state);
    config(path.join(defaultState(), 'openclaw.json'), 'synthetic-wrong-account');
    expect(readOpenClawToken()).toBeUndefined();
    expect((await provider().getAuthConfig()).configPath).toBe(path.join(state, 'openclaw.json'));
  });

  it.each(['OPENCLAW_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'LITECLAW_AGENT_DIR'])('ignores deprecated %s for configured-agent execution', async key => {
    vi.stubEnv(key, ' ~/selected-agent ');
    await expectSelected(path.join(defaultState(), 'openclaw.json'), defaultAgent());
    expect(resolveOpenClawPaths().agentDir).toBe(defaultAgent());
  });

  it('keeps configured-agent discovery independent of SDK directory overrides', async () => {
    const selected = path.join(root, 'current-agent'); vi.stubEnv('OPENCLAW_AGENT_DIR', selected);
    vi.stubEnv('PI_CODING_AGENT_DIR', path.join(root, 'unused-pi-agent'));
    vi.stubEnv('LITECLAW_AGENT_DIR', path.join(root, 'unused-legacy-agent'));
    await expectSelected(path.join(defaultState(), 'openclaw.json'), defaultAgent());
    expect(resolveOpenClawPaths().agentDir).toBe(defaultAgent());
  });

  it('preserves the legacy state alias when no current override is set', async () => {
    const state = path.join(root, 'legacy-state'); vi.stubEnv('LITECLAW_STATE_DIR', state);
    await expectSelected(path.join(state, 'openclaw.json'), path.join(state, 'agents/main/agent'));
  });

  it('ignores whitespace-only overrides', async () => {
    for (const key of environmentKeys) vi.stubEnv(key, '   ');
    await expectSelected(path.join(defaultState(), 'openclaw.json'), defaultAgent());
  });
});
