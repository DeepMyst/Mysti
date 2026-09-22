import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareClineAcpLaunch } from '../../../src/providers/cline/ClineAcp';
import { createClineSession } from '../../helpers/sessionFactory';
import type { Settings } from '../../../src/types';
const dirs: string[] = [];
async function context() { const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-cline-policy-')); dirs.push(cwd); return { cwd, cliPath: '/inert/cline', settings: { mode: 'default', accessLevel: 'ask-permission' } as Settings, session: createClineSession(), signal: new AbortController().signal, env: { CLINE_API_KEY: 'fixture-only', CLINE_DATA_DIR: '/untrusted', CLINE_SESSION_BACKEND_MODE: 'hub', CLINE_BIN_PATH: '/untrusted', NODE_OPTIONS: '--require=untrusted' } }; }
afterEach(async () => { for (const dir of dirs.splice(0)) { await fs.rm(dir, { recursive: true, force: true }); } });
describe('Cline native execution profile', () => {
  it('isolates state, removes injected runtimes, and forces local ownership', async () => {
    const ctx = await context(); const launch = await prepareClineAcpLaunch(ctx);
    try { expect(launch.env?.CLINE_DIR).not.toBe('/untrusted'); expect(launch.env?.CLINE_DATA_DIR).toContain('mysti-cline-acp-'); expect(launch.env?.CLINE_SESSION_BACKEND_MODE).toBe('local'); expect(launch.env?.CLINE_BIN_PATH).toBeUndefined(); expect(launch.env?.NODE_OPTIONS).toBeUndefined(); expect(launch.env?.HOME).toBeUndefined(); await launch.assertUnchanged?.(); }
    finally { await launch.cleanup?.(); }
    await expect(fs.stat(launch.env!.CLINE_DIR!)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('fails before launch when environment authentication is missing', async () => {
    await expect(prepareClineAcpLaunch({ ...await context(), env: {} })).rejects.toThrow('CLINE_API_KEY');
  });
  it('rejects project plugins introduced while startup is pending', async () => {
    const ctx = await context(); const launch = await prepareClineAcpLaunch(ctx);
    try { const plugins = path.join(ctx.cwd, '.cline/plugins'); await fs.mkdir(plugins, { recursive: true }); await fs.writeFile(path.join(plugins, 'override.js'), 'throw new Error("must not execute")'); await expect(launch.assertUnchanged?.()).rejects.toThrow('inherited hooks or plugins'); }
    finally { await launch.cleanup?.(); }
  });
  it('requires explicit native session proof that auto-approval is off', async () => {
    const launch = await prepareClineAcpLaunch(await context());
    try { expect(() => launch.validateSession?.({ configOptions: [{ id: 'auto_approve', currentValue: true }] })).toThrow('auto-approval'); expect(() => launch.validateSession?.({})).toThrow('auto-approval'); }
    finally { await launch.cleanup?.(); }
  });
  it.each(['3.0.64', '3.0.61'])('accepts verified ACP release %s after initialize', async version => {
    const launch = await prepareClineAcpLaunch(await context());
    try { expect(launch.expectedAgentInfo).toEqual({ name: 'cline' }); expect(() => launch.validateInitialize?.({ protocolVersion: 1, agentInfo: { name: 'cline', version } })).not.toThrow(); }
    finally { await launch.cleanup?.(); }
  });
  it.each([['3.0.62'], ['99.0.0'], [undefined]])('refuses unverified ACP release %s before a session exists', async version => {
    const launch = await prepareClineAcpLaunch(await context());
    try { expect(() => launch.validateInitialize?.({ protocolVersion: 1, agentInfo: { name: 'cline', version } })).toThrow('unsupported identity or version'); }
    finally { await launch.cleanup?.(); }
  });
  // 3.0.62+ loads $HOME/.agents/plugins (shared/src/storage/paths.ts
  // resolveAgentPluginSearchPaths) and starts their MCP servers unprompted.
  it('refuses user agent plugins in $HOME/.agents/plugins before and during startup', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-cline-home-')); dirs.push(home);
    const previous = process.env.HOME; process.env.HOME = home;
    try {
      const plugins = path.join(home, '.agents', 'plugins'); await fs.mkdir(plugins, { recursive: true });
      const launch = await prepareClineAcpLaunch(await context());
      try {
        await fs.mkdir(path.join(plugins, 'inert')); await expect(launch.assertUnchanged?.()).rejects.toThrow(path.join(home, '.agents/plugins'));
      } finally { await launch.cleanup?.(); }
      await expect(prepareClineAcpLaunch(await context())).rejects.toThrow('inherited hooks or plugins');
    } finally { if (previous === undefined) { delete process.env.HOME; } else { process.env.HOME = previous; } }
  });
});
