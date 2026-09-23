/** OpenCode shell gate plugin: runs the generated module on every OS. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openCodeShellGatePlugin, prepareOpenCodeNativeLaunch, OPENCODE_HOST_AGENT } from '../../../src/providers/opencode/OpenCodeNative';
import { createOpenCodeSession } from '../../helpers/sessionFactory';
import type { Settings } from '../../../src/types';

type Hooks = {
  config(cfg: Record<string, unknown>): Promise<void>;
  event(input: { event: { type: string; properties: Record<string, unknown> } }): Promise<void>;
  'tool.execute.before'(input: { tool: string; sessionID: string; callID: string }, output: { args: object }): Promise<void>;
  'shell.env'(input: { cwd: string; sessionID?: string; callID?: string }, output: { env: object }): Promise<void>;
};
const settings: Settings = { mode: 'default', thinkingLevel: 'none', accessLevel: 'ask-permission', contextMode: 'auto', model: 'anthropic/claude-sonnet-4-5', provider: 'opencode' };
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) { await fs.rm(dir, { recursive: true, force: true }); } });
const tempDir = async () => { const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-oc-gate-'))); dirs.push(dir); return dir; };

async function gate() {
  const dir = await tempDir();
  const file = path.join(dir, 'gate.mjs');
  await fs.writeFile(file, openCodeShellGatePlugin('fixture-nonce', path.join(dir, 'attested.json'), path.join(dir, 'stopped')));
  const hooks = await (await import(pathToFileURL(file).href)).default.server({ directory: dir }) as Hooks;
  const before = (callID: string, tool = 'bash') => hooks['tool.execute.before']({ tool, sessionID: 's', callID }, { args: { command: 'x' } });
  const asked = (callID: string, id: string, permission = 'bash') => hooks.event({ event: { type: 'permission.asked', properties: { id, sessionID: 's', permission, patterns: ['x'], tool: { messageID: 'm', callID } } } });
  const replied = (id: string, reply: string) => hooks.event({ event: { type: 'permission.replied', properties: { sessionID: 's', requestID: id, reply } } });
  const spawn = (callID?: string) => hooks['shell.env']({ cwd: dir, sessionID: 's', callID }, { env: {} });
  return { dir, hooks, before, asked, replied, spawn };
}

describe('OpenCode shell gate plugin', () => {
  it('enables shell only by registering, and attests the plugins it was loaded with', async () => {
    const g = await gate();
    const cfg = { permission: { '*': 'deny' }, agent: { [OPENCODE_HOST_AGENT]: { permission: { '*': 'deny' } } }, plugin_origins: [{ spec: 'file:///gate.mjs' }] };
    await g.hooks.config(cfg);
    expect(cfg.permission).toEqual({ '*': 'deny', bash: 'ask' });
    expect(cfg.agent[OPENCODE_HOST_AGENT].permission).toEqual({ '*': 'deny', bash: 'ask' });
    expect(JSON.parse(await fs.readFile(path.join(g.dir, 'attested.json'), 'utf8'))).toEqual({ nonce: 'fixture-nonce', directory: g.dir, plugins: ['file:///gate.mjs'] });
    const other = await gate();
    await other.hooks.config({ permission: {}, agent: {} });
    await expect(fs.stat(path.join(other.dir, 'attested.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('spawns only after this call’s own bash request was answered once, and only once', async () => {
    const g = await gate();
    await g.before('call'); await g.asked('call', 'per_1'); await g.replied('per_1', 'once');
    await expect(g.spawn('call')).resolves.toBeUndefined();
    await expect(g.spawn('call')).rejects.toThrow('did not submit for approval');
  });

  it.each([
    ['no permission request (e.g. a bare redirection)', async (g: Awaited<ReturnType<typeof gate>>) => { await g.before('call'); }],
    ['a rejected request', async (g: Awaited<ReturnType<typeof gate>>) => { await g.before('call'); await g.asked('call', 'per_1'); await g.replied('per_1', 'reject'); }],
    ['an always reply', async (g: Awaited<ReturnType<typeof gate>>) => { await g.before('call'); await g.asked('call', 'per_1'); await g.replied('per_1', 'always'); }],
    ['a pending request', async (g: Awaited<ReturnType<typeof gate>>) => { await g.before('call'); await g.asked('call', 'per_1'); }],
    ['another call’s approval', async (g: Awaited<ReturnType<typeof gate>>) => { await g.before('call'); await g.before('other'); await g.asked('other', 'per_1'); await g.replied('per_1', 'once'); }],
    ['a non-shell permission', async (g: Awaited<ReturnType<typeof gate>>) => { await g.before('call'); await g.asked('call', 'per_1', 'external_directory'); await g.replied('per_1', 'once'); }],
    ['a duplicate call id', async (g: Awaited<ReturnType<typeof gate>>) => { await g.before('call'); await g.before('call'); await g.asked('call', 'per_1'); await g.replied('per_1', 'once'); }],
    ['a request without a tool execution', async (g: Awaited<ReturnType<typeof gate>>) => { await g.asked('call', 'per_1'); await g.replied('per_1', 'once'); }],
    ['a reused id after a rejection', async (g: Awaited<ReturnType<typeof gate>>) => {
      await g.before('call'); await g.asked('call', 'per_1'); await g.replied('per_1', 'reject'); await g.before('call');
    }],
    ['a reused id after an approved spawn', async (g: Awaited<ReturnType<typeof gate>>) => {
      await g.before('call'); await g.asked('call', 'per_1'); await g.replied('per_1', 'once'); await g.spawn('call'); await g.before('call');
    }],
  ])('refuses the spawn after %s', async (_name, setup) => {
    const g = await gate(); await setup(g);
    await expect(g.spawn('call')).rejects.toThrow('did not submit for approval');
  });

  it('refuses even an approved call once Stop has begun', async () => {
    const g = await gate();
    await g.before('call'); await g.asked('call', 'per_1'); await g.replied('per_1', 'once');
    await fs.writeFile(path.join(g.dir, 'stopped'), '');
    await expect(g.spawn('call')).rejects.toThrow('after Stop');
  });

  it('refuses shells without a call identity and ignores other tools', async () => {
    const g = await gate();
    await g.before('call', 'read');
    await expect(g.spawn(undefined)).rejects.toThrow();
    await expect(g.spawn('call')).rejects.toThrow();
  });
});

describe('OpenCode shell gate launch', () => {
  const launchFor = async (platform: NodeJS.Platform, extra: Partial<Settings> = {}) => {
    const cwd = await tempDir();
    return { cwd, launch: await prepareOpenCodeNativeLaunch({ settings: { ...settings, ...extra }, session: createOpenCodeSession(), cwd,
      env: { ANTHROPIC_API_KEY: 'inert-fixture' }, cliPath: '/inert', signal: new AbortController().signal }, settings.model, platform) };
  };
  const attest = async (launch: Awaited<ReturnType<typeof launchFor>>['launch'], directory: string, plugins?: string[]) => {
    const config = JSON.parse(launch.env!.OPENCODE_CONFIG_CONTENT!);
    const hooks = await (await import(config.plugin[0])).default.server({ directory }) as Hooks;
    await hooks.config({ ...config, plugin_origins: (plugins ?? config.plugin).map((spec: string) => ({ spec })) });
  };

  it('macOS unrestricted tiers load only the gate, without pure mode, and verify its attestation', async () => {
    const { cwd, launch } = await launchFor('darwin');
    try {
      const config = JSON.parse(launch.env!.OPENCODE_CONFIG_CONTENT!);
      expect(launch.args).not.toContain('--pure'); expect(launch.env!.OPENCODE_PURE).toBeUndefined();
      expect(config.plugin).toHaveLength(1); expect(config.permission.bash).toBeUndefined(); expect(config.permission['*']).toBe('deny');
      expect(launch.cancelGraceMs).toBeGreaterThan(0);
      await expect(launch.configure!({} as never, {}, {})).rejects.toThrow('did not attest');
      await attest(launch, cwd);
      await expect(launch.configure!({} as never, {}, {})).resolves.toBeUndefined();
    } finally { await launch.cleanup!(); }
  });

  it('Stop revokes the gate synchronously for an already approved call', async () => {
    const { cwd, launch } = await launchFor('darwin');
    try {
      const config = JSON.parse(launch.env!.OPENCODE_CONFIG_CONTENT!);
      const hooks = await (await import(config.plugin[0])).default.server({ directory: cwd }) as Hooks;
      await hooks['tool.execute.before']({ tool: 'bash', sessionID: 's', callID: 'call' }, { args: {} });
      await hooks.event({ event: { type: 'permission.asked', properties: { id: 'per_1', sessionID: 's', permission: 'bash', tool: { callID: 'call' } } } });
      await hooks.event({ event: { type: 'permission.replied', properties: { requestID: 'per_1', reply: 'once' } } });
      launch.onStop!();
      await expect(hooks['shell.env']({ cwd, sessionID: 's', callID: 'call' }, { env: {} })).rejects.toThrow('after Stop');
    } finally { await launch.cleanup!(); }
  });

  it.each([['another plugin', 'extra'], ['another directory', 'directory']] as const)('refuses the turn when the gate reports %s', async (_name, fault) => {
    const { cwd, launch } = await launchFor('darwin');
    try {
      const spec = JSON.parse(launch.env!.OPENCODE_CONFIG_CONTENT!).plugin[0];
      await attest(launch, fault === 'directory' ? path.join(cwd, 'other') : cwd, fault === 'extra' ? [spec, 'file:///late.js'] : undefined);
      await expect(launch.configure!({} as never, {}, {})).rejects.toThrow('did not attest');
    } finally { await launch.cleanup!(); }
  });

  it.each([
    ['linux', {}], ['win32', {}], ['darwin', { accessLevel: 'read-only' as const }], ['darwin', { mode: 'quick-plan' as const }],
  ] as const)('%s %j keeps shell removed with pure mode and no plugin', async (platform, extra) => {
    const { launch } = await launchFor(platform, extra);
    try {
      expect(launch.args).toContain('--pure'); expect(launch.env!.OPENCODE_PURE).toBe('true');
      expect(JSON.parse(launch.env!.OPENCODE_CONFIG_CONTENT!).plugin).toEqual([]);
      expect(launch.configure).toBeUndefined(); expect(launch.cancelGraceMs).toBeUndefined(); expect(launch.onStop).toBeUndefined();
    } finally { await launch.cleanup!(); }
  });
});
