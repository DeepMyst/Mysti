import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareCopilotAcpLaunch } from '../../../src/providers/copilot/CopilotAcp';
import { createCopilotSession } from '../../helpers/sessionFactory';
import type { Settings } from '../../../src/types';
const dirs: string[] = [];
const hostPlatform = process.platform;
async function context() { const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-copilot-policy-')); dirs.push(cwd); return { cwd, cliPath: '/inert/copilot', settings: { mode: 'default', accessLevel: 'ask-permission' } as Settings, session: createCopilotSession(), signal: new AbortController().signal, env: { COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:1', COPILOT_HOME: '/untrusted', COPILOT_ALLOW_ALL: 'true', COPILOT_SKILLS_DIRS: '/untrusted', COPILOT_CLI_VERSION: '1.0.83', NODE_OPTIONS: '--require=untrusted' } }; }
afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true });
  for (const dir of dirs.splice(0)) { await fs.rm(dir, { recursive: true, force: true }); }
});
describe('Copilot native execution profile', () => {
  beforeEach(() => { Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }); });
  it('isolates inherited grants, hooks, plugins and native version spoofing', async () => {
    const ctx = await context(); const launch = await prepareCopilotAcpLaunch(ctx);
    try { expect(launch.env?.COPILOT_HOME).not.toBe('/untrusted'); expect(launch.env?.COPILOT_ALLOW_ALL).toBeUndefined(); expect(launch.env?.COPILOT_SKILLS_DIRS).toBeUndefined(); expect(launch.env?.COPILOT_CLI_VERSION).toBeUndefined(); expect(launch.env?.NODE_OPTIONS).toBeUndefined(); expect(launch.env?.HOME).toBeUndefined(); await launch.assertUnchanged?.(); }
    finally { await launch.cleanup?.(); }
    await expect(fs.stat(launch.env!.COPILOT_HOME!)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects a native policy weakening during startup', async () => {
    const launch = await prepareCopilotAcpLaunch(await context());
    try { const file = path.join(launch.env!.COPILOT_HOME!, 'settings.json'); const policy = JSON.parse(await fs.readFile(file, 'utf8')); policy.disableAllHooks = false; await fs.writeFile(file, JSON.stringify(policy)); await expect(launch.assertUnchanged?.()).rejects.toThrow('changed the native approval policy'); }
    finally { await launch.cleanup?.(); }
  });
  it('rejects project MCP that could start before a tool permission request', async () => {
    const ctx = await context(); await fs.writeFile(path.join(ctx.cwd, '.mcp.json'), '{}'); await expect(prepareCopilotAcpLaunch(ctx)).rejects.toThrow('inherited executable');
  });
  it('fails without environment authentication instead of importing stored native grants', async () => {
    await expect(prepareCopilotAcpLaunch({ ...await context(), env: {} })).rejects.toThrow('COPILOT_PROVIDER_BASE_URL');
    await expect(prepareCopilotAcpLaunch({ ...await context(), env: { GH_TOKEN: 'fixture-only' } })).rejects.toThrow('managed execution policy');
  });
});

it('rejects Windows machine policy before allocating a native profile', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  await expect(prepareCopilotAcpLaunch(await context())).rejects.toThrow('not enabled on Windows');
});
