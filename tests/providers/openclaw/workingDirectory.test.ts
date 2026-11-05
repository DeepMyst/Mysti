import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
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
vi.mock('../../../src/utils/platform', async original => ({
  ...await original<typeof import('../../../src/utils/platform')>(),
  getEnrichedEnv: () => ({ PATH: process.env.PATH || '', OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH }),
}));
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import { readOpenClawToken, resolveOpenClawPaths } from '../../../src/utils/platform';
import type { Settings, StreamChunk } from '../../../src/types';

const envKeys = ['OPENCLAW_CONFIG_PATH', 'OPENCLAW_STATE_DIR', 'OPENCLAW_HOME', 'OPENCLAW_AGENT_DIR',
  'OPENCLAW_TEST_FAST', 'LITECLAW_STATE_DIR', 'LITECLAW_AGENT_DIR', 'PI_CODING_AGENT_DIR',
  'OPENCLAW_GATEWAY_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'];
const providers: TestableOpenClawProvider[] = [];
let owned: string, hostFixture: string, relative: string, workspace: string;
let previousFolders: typeof vscode.workspace.workspaceFolders;
function folders(...paths: string[]) {
  (vscode.workspace as any).workspaceFolders = paths.map((file, index) => ({ uri: vscode.Uri.file(file), name: 'owned', index }));
}
function write(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value));
}
function credentials(dir: string) {
  write(path.join(dir, 'auth-profiles.json'), { profiles: { owned: { type: 'api_key', provider: 'anthropic', key: 'synthetic-key' } } });
}
function config(file: string, dir: string, label: string, token?: string) {
  write(file, { email: label, ownedReply: label, agents: { list: [{ id: 'writer', agentDir: dir }] }, gateway: { auth: { token } } });
}
function provider() { const p = new TestableOpenClawProvider(); providers.push(p); return p; }
beforeEach(() => {
  owned = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-openclaw-cwd-')));
  fixture.home = path.join(owned, 'home'); workspace = path.join(owned, 'workspace');
  fs.mkdirSync(fixture.home); fs.mkdirSync(workspace);
  // Both possible relative targets are owned. Never write a decoy into an
  // actual user config/state directory or change the test process's cwd.
  const outputRoot = path.join(process.cwd(), 'out-test'); fs.mkdirSync(outputRoot, { recursive: true });
  hostFixture = fs.mkdtempSync(path.join(outputRoot, 'cwd-fixture-'));
  relative = path.relative(process.cwd(), hostFixture);
  previousFolders = vscode.workspace.workspaceFolders; folders(workspace);
  for (const key of envKeys) vi.stubEnv(key, '');
  clearMockConfig(); setMockConfig('openclawUseGateway', false);
});
afterEach(() => {
  providers.splice(0).forEach(p => p.dispose()); vi.restoreAllMocks(); vi.unstubAllEnvs(); clearMockConfig();
  (vscode.workspace as any).workspaceFolders = previousFolders; fixture.home = '';
  fs.rmSync(owned, { recursive: true, force: true }); fs.rmSync(hostFixture, { recursive: true, force: true });
});

describe('OpenClaw readiness and CLI working directory', () => {
  it.each(['config', 'state', 'home', 'agentDir'] as const)('resolves a relative %s from the CLI workspace', async kind => {
    let expectedConfig: string, expectedAgent: string;
    if (kind === 'config') {
      vi.stubEnv('OPENCLAW_CONFIG_PATH', path.join(relative, 'openclaw.json'));
      expectedConfig = path.join(workspace, relative, 'openclaw.json'); expectedAgent = path.join(owned, 'workspace-agent');
      config(path.join(hostFixture, 'openclaw.json'), path.join(owned, 'unused-host-agent'), 'host@example.invalid');
      config(expectedConfig, expectedAgent, 'workspace@example.invalid');
    } else if (kind === 'state' || kind === 'home') {
      vi.stubEnv(kind === 'state' ? 'OPENCLAW_STATE_DIR' : 'OPENCLAW_HOME', path.join(relative, 'state-root'));
      const state = path.join(workspace, relative, 'state-root', ...(kind === 'home' ? ['.openclaw'] : []));
      expectedConfig = path.join(state, 'openclaw.json'); expectedAgent = path.join(state, 'agents/main/agent');
      write(expectedConfig, { email: 'workspace@example.invalid' });
    } else {
      expectedConfig = path.join(fixture.home, '.openclaw/openclaw.json'); expectedAgent = path.join(workspace, relative, 'agent');
      config(expectedConfig, path.join(relative, 'agent'), 'workspace@example.invalid');
    }
    credentials(expectedAgent);
    expect(resolveOpenClawPaths(workspace)).toMatchObject({ configPath: expectedConfig, agentDir: expectedAgent });
    const p = provider();
    expect(await p.getAuthConfig()).toMatchObject({ isAuthenticated: true, configPath: expectedConfig });
    expect(await p.checkAuthentication()).toMatchObject({ authenticated: true, user: 'workspace@example.invalid' });
  });
  it('does not borrow credentials from the extension process directory', async () => {
    vi.stubEnv('OPENCLAW_CONFIG_PATH', path.join(relative, 'openclaw.json'));
    const hostAgent = path.join(owned, 'host-agent'); credentials(hostAgent);
    config(path.join(hostFixture, 'openclaw.json'), hostAgent, 'host@example.invalid');
    const expectedConfig = path.join(workspace, relative, 'openclaw.json');
    config(expectedConfig, path.join(owned, 'empty-workspace-agent'), 'workspace@example.invalid');
    expect(await provider().getAuthConfig()).toMatchObject({ isAuthenticated: false, configPath: expectedConfig });
  });
  it.each(['absolute', 'tilde'])('keeps %s configured directories independent of cwd', async kind => {
    const selected = path.join(fixture.home, 'selected-agent'); credentials(selected);
    config(path.join(fixture.home, '.openclaw/openclaw.json'), kind === 'tilde' ? '~/selected-agent' : selected, 'selected@example.invalid');
    expect((await provider().getAuthConfig()).isAuthenticated).toBe(true);
  });
  it.each(['undefined', 'empty'])('uses extension cwd when workspace folders are %s', async kind => {
    if (kind === 'undefined') (vscode.workspace as any).workspaceFolders = undefined; else folders();
    vi.stubEnv('OPENCLAW_CONFIG_PATH', path.join(relative, 'openclaw.json'));
    const dir = path.join(owned, 'host-agent'); credentials(dir); config(path.join(hostFixture, 'openclaw.json'), dir, 'host@example.invalid');
    expect(await provider().getAuthConfig()).toMatchObject({ isAuthenticated: true, configPath: path.join(hostFixture, 'openclaw.json') });
  });
  it('uses the first workspace and rechecks when workspace selection changes', async () => {
    const second = path.join(owned, 'second-workspace'); fs.mkdirSync(second); folders(workspace, second);
    vi.stubEnv('OPENCLAW_CONFIG_PATH', path.join(relative, 'openclaw.json'));
    const firstAgent = path.join(owned, 'first-agent'); credentials(firstAgent);
    config(path.join(workspace, relative, 'openclaw.json'), firstAgent, 'first@example.invalid');
    config(path.join(second, relative, 'openclaw.json'), path.join(owned, 'empty-second-agent'), 'second@example.invalid');
    const p = provider(); expect((await p.checkAuthentication()).user).toBe('first@example.invalid');
    folders(second, workspace); expect((await p.getAuthConfig()).isAuthenticated).toBe(false);
  });
  it('keeps gateway token/config selection at the extension client cwd', async () => {
    setMockConfig('openclawUseGateway', true); vi.stubEnv('OPENCLAW_CONFIG_PATH', path.join(relative, 'openclaw.json'));
    const hostConfig = path.join(hostFixture, 'openclaw.json');
    config(hostConfig, path.join(owned, 'host-agent'), 'gateway@example.invalid', 'synthetic-client-token');
    config(path.join(workspace, relative, 'openclaw.json'), path.join(owned, 'workspace-agent'), 'workspace@example.invalid', 'synthetic-decoy-token');
    expect(readOpenClawToken()).toBe('synthetic-client-token');
    const p = provider(), connect = vi.spyOn((p as any)._gateway, 'connect');
    expect(await p.getAuthConfig()).toMatchObject({ isAuthenticated: true, configPath: hostConfig });
    expect((await p.checkAuthentication()).user).toBe('gateway@example.invalid'); expect(connect).not.toHaveBeenCalled();
  });
  it('uses local workspace credentials when gateway has no connection or token', async () => {
    setMockConfig('openclawUseGateway', true); vi.stubEnv('OPENCLAW_CONFIG_PATH', path.join(relative, 'openclaw.json'));
    const dir = path.join(owned, 'local-agent'); credentials(dir);
    const expectedConfig = path.join(workspace, relative, 'openclaw.json'); config(expectedConfig, dir, 'workspace@example.invalid');
    config(path.join(hostFixture, 'openclaw.json'), path.join(owned, 'unused-host-agent'), 'host@example.invalid');
    expect(await provider().getAuthConfig()).toMatchObject({ isAuthenticated: true, configPath: expectedConfig });
  });
});

const settings = { provider: 'openclaw', model: '', mode: 'edit-automatically', accessLevel: 'full-access', thinkingLevel: 'low', contextMode: 'manual' } as Settings;
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Owned child deadline')), 5000); })]); }
  finally { clearTimeout(timer); }
}
it.each(['workspace', 'empty'])('matches the real public child cwd with %s workspace folders', async kind => {
  if (kind === 'empty') folders();
  const cwd = kind === 'empty' ? process.cwd() : workspace;
  vi.stubEnv('OPENCLAW_CONFIG_PATH', path.join(relative, 'openclaw.json'));
  const target = path.join(cwd, relative, 'openclaw.json'), dir = path.join(owned, 'selected-agent');
  credentials(dir); config(target, dir, 'owned-child@example.invalid');
  const receiptPath = path.join(owned, 'child.json');
  const childSource = `const fs=require('fs'),path=require('path'),args=process.argv.slice(1);\n`
    + `const file=path.resolve(process.env.OPENCLAW_CONFIG_PATH),cfg=JSON.parse(fs.readFileSync(file,'utf8'));\n`
    + `fs.writeFileSync(${JSON.stringify(receiptPath)},JSON.stringify({pid:process.pid,cwd:process.cwd(),configPath:file,args}));\n`
    + `process.stdout.write(JSON.stringify({payloads:[{text:cfg.ownedReply}],meta:{agentMeta:{sessionId:'owned-session'}}}));`;
  const p = provider(), originalArgs = p.buildCliArgs.bind(p);
  vi.spyOn(p, 'getCliPath').mockReturnValue(process.execPath);
  vi.spyOn(p, 'buildCliArgs').mockImplementation((s, session) => ['-e', childSource, '--', ...originalArgs(s, session)]);
  vi.spyOn(p as any, 'buildPromptAsync').mockResolvedValue('OWNED_CWD_REQUEST');
  let child: ChildProcess | undefined, closed: Promise<void> | undefined, exit: unknown;
  const tracker = { registerProcess: (_panel: string, value: ChildProcess) => {
    child = value; closed = new Promise(resolve => value.once('close', (code, signal) => { exit = { code, signal }; resolve(); }));
  }, clearProcess() {} };
  const chunks: StreamChunk[] = [];
  const stream = p.sendMessage('OWNED_CWD_REQUEST', [], settings, null, undefined, 'owned-cwd', tracker);
  try {
    await bounded((async () => { for await (const chunk of stream) chunks.push(chunk); })());
    expect(child).toBeDefined(); await bounded(closed!);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(chunks.filter(chunk => chunk.type === 'error' || chunk.type === 'auth_error')).toEqual([]);
    expect(chunks.find(chunk => chunk.type === 'text')?.content).toBe('owned-child@example.invalid');
    const actual = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    expect(actual.cwd).toBe(cwd); expect(actual.configPath).toBe(target);
    expect(actual.args).toContain('--session-key'); expect(actual.args).toContain('--session-id');
    expect(await p.getAuthConfig()).toMatchObject({ isAuthenticated: true, configPath: actual.configPath });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (closed) await bounded(closed);
    await bounded(stream.return(undefined as never));
    const output = process.env.PB07_OPENCLAW_CWD_RECEIPT;
    if (output) fs.appendFileSync(output, JSON.stringify({ kind, pid: child?.pid, exit, closed: !!closed && exit !== undefined,
      actual: fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) : null,
      nativeProviderCliInvocations: 0, paidRequests: 0 }) + '\n');
  }
}, 15000);
