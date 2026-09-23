import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertOpenCodeAuthorityAbsent, decodeOpenCodePermission, openCodeExternalAuthorityPaths, openCodeWorkspaceAuthorityPaths, openCodeIsolatedEnv, openCodeNativeConfig, prepareOpenCodeNativeLaunch, validateOpenCodeConfigUpdate } from '../../../src/providers/opencode/OpenCodeNative';
import { createOpenCodeSession } from '../../helpers/sessionFactory';
import type { Settings } from '../../../src/types';

const settings: Settings = { mode: 'default', thinkingLevel: 'none', accessLevel: 'ask-permission', contextMode: 'auto', model: 'anthropic/claude-sonnet-4-5', provider: 'opencode' };
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) { await fs.rm(dir, { recursive: true, force: true }); } });
// Junctions preserve directory/dangling-link semantics on Windows without
// requiring Developer Mode or the symbolic-link creation privilege.
const directoryLink = (target: string, link: string) => fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
const tool = (kind: string, rawInput: object, extra = {}) => ({ toolCallId: 'call', kind, rawInput, status: 'pending', ...extra });
const request = (kind: string, rawInput: object) => ({ toolCall: tool(kind, rawInput) });

describe('OpenCode isolated native policy', () => {
  it('accepts only configuration updates retaining the captured mode/model', () => {
    const unchanged = [{ id: 'mode', currentValue: 'mysti-host' }, { id: 'model', currentValue: settings.model }];
    expect(() => validateOpenCodeConfigUpdate({ sessionUpdate: 'config_option_update', configOptions: [...unchanged, { id: 'effort', currentValue: 'high' }] }, settings.model)).not.toThrow();
    expect(() => validateOpenCodeConfigUpdate({ sessionUpdate: 'config_option_update', configOptions: [{ id: 'mode', currentValue: 'build' }, unchanged[1]] }, settings.model)).toThrow('captured');
    expect(() => validateOpenCodeConfigUpdate({ sessionUpdate: 'config_option_update', configOptions: [...unchanged, { id: 'allow_all', currentValue: 'on' }] }, settings.model)).toThrow('unsupported');
    expect(() => validateOpenCodeConfigUpdate({ sessionUpdate: 'config_option_update', configOptions: [...unchanged, { id: 'mode', currentValue: 'build' }] }, settings.model)).toThrow('conflicting');
    expect(() => validateOpenCodeConfigUpdate({ sessionUpdate: 'config_option_update', configOptions: [unchanged[0], { id: 'model', currentValue: 'custom/other' }] }, settings.model)).toThrow('captured');
  });
  it.each(['default', 'quick-plan', 'detailed-plan', 'edit-automatically', 'ask-before-edit'] as const)('removes shell/delegation/custom tools for %s', mode => {
    const config = openCodeNativeConfig({ ...settings, mode }, settings.model);
    const permissions = config.permission as Record<string, string>;
    expect(permissions['*']).toBe('deny');
    for (const tool of ['bash', 'shell', 'task', 'execute', 'skill', 'question', 'plan_enter', 'plan_exit', 'mcp_custom']) {
      expect(permissions[tool] ?? permissions['*']).toBe('deny');
    }
    expect(config).toMatchObject({ formatter: false, lsp: false, snapshot: false, share: 'disabled', plugin: [], subagent_depth: 0 });
    expect(permissions.edit).toBe(mode.includes('plan') ? 'deny' : 'ask');
  });
  it('read-only removes edits and fetch even with full host auto-approval', () => {
    expect(openCodeNativeConfig({ ...settings, accessLevel: 'read-only' }, settings.model).permission).toMatchObject({ edit: 'deny', webfetch: 'deny', read: 'ask' });
  });
  it('isolates configuration, login stores, boot injection, npm credentials, and server access', () => {
    const config = openCodeNativeConfig(settings, settings.model);
    const env = openCodeIsolatedEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'inert-key', OPENAI_API_KEY: 'unselected-key', OPENCODE_PERMISSION: '{"*":"allow"}', OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_TEST_HOME: '/other', NODE_OPTIONS: '--require=evil', BUN_OPTIONS: 'evil', npm_config_userconfig: '/private' }, '/fixture', config, 'anthropic');
    expect(env.ANTHROPIC_API_KEY).toBe('inert-key'); expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined(); expect(env.BUN_OPTIONS).toBeUndefined(); expect(env.OPENCODE_TEST_HOME).toBeUndefined();
    expect(env.XDG_DATA_HOME).toBe(path.join('/fixture', 'data')); expect(env.XDG_CONFIG_HOME).toBe(path.join('/fixture', 'config'));
    expect([env.TMPDIR, env.TEMP, env.TMP]).toEqual(['/fixture', '/fixture', '/fixture']);
    expect(env.npm_config_userconfig).toBe(path.join('/fixture', 'empty.npmrc')); expect(env.npm_config_offline).toBe('true');
    expect(JSON.parse(env.OPENCODE_PERMISSION!)).toEqual(config.permission);
    expect(env.OPENCODE_SERVER_PASSWORD).toHaveLength(64);
    expect(openCodeIsolatedEnv({}, '/fixture', config, 'anthropic').OPENCODE_SERVER_PASSWORD).not.toBe(env.OPENCODE_SERVER_PASSWORD);
    expect(env.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe('true'); expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('true');
  });
  it('rejects external configuration including dangling symlinks without reading it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-oc-policy-')); dirs.push(dir);
    await assertOpenCodeAuthorityAbsent([path.join(dir, 'missing')]);
    const external = path.join(dir, 'config'); await directoryLink(path.join(dir, 'missing'), external);
    expect((await fs.lstat(external)).isSymbolicLink()).toBe(true);
    await expect(fs.stat(external)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(assertOpenCodeAuthorityAbsent([external])).rejects.toThrow('cannot isolate');
  });
  it('checks system and managed authority outside isolated XDG directories', () => {
    expect(openCodeExternalAuthorityPaths({}, 'darwin', '/user', 'fixture')).toEqual([path.join('/user', '.opencode'), '/Library/Application Support/opencode', path.join('/Library/Managed Preferences', 'fixture', 'ai.opencode.managed.plist'), '/Library/Managed Preferences/ai.opencode.managed.plist']);
  });
  it.each(['opencode.json', 'opencode.jsonc', '.opencode'])('rejects ancestor %s before allocating native authority', async name => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-oc-ancestor-'))); dirs.push(dir);
    const work = path.join(dir, 'work'); await fs.mkdir(work);
    await directoryLink(path.join(dir, 'missing'), path.join(dir, name));
    const context = { settings, session: createOpenCodeSession(), cwd: work, env: { ANTHROPIC_API_KEY: 'inert-fixture' }, cliPath: '/inert', signal: new AbortController().signal };
    await expect(prepareOpenCodeNativeLaunch(context, settings.model)).rejects.toThrow('cannot isolate');
    expect(await openCodeWorkspaceAuthorityPaths(work)).toContain(path.join(dir, name));
  });
  it('checks both lexical and symlink-resolved workspace ancestors', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-oc-symlink-'))); dirs.push(dir);
    await fs.mkdir(path.join(dir, 'real', 'work'), { recursive: true }); await fs.mkdir(path.join(dir, 'alias'));
    await directoryLink(path.join(dir, 'real', 'work'), path.join(dir, 'alias', 'work'));
    const paths = await openCodeWorkspaceAuthorityPaths(path.join(dir, 'alias', 'work'));
    expect(paths).toContain(path.join(dir, 'real', '.opencode')); expect(paths).toContain(path.join(dir, 'alias', '.opencode'));
  });
  it.each(['linux', 'darwin'] as const)('rechecks newly added authority before native startup on %s', async platform => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-oc-recheck-'))); dirs.push(dir);
    const launch = await prepareOpenCodeNativeLaunch({ settings, session: createOpenCodeSession(), cwd: dir, env: { ANTHROPIC_API_KEY: 'inert-fixture' }, cliPath: '/inert', signal: new AbortController().signal }, settings.model, platform);
    try {
      // Shell-gate launch details are covered in shellGate.test.ts.
      expect(launch.args.includes('--pure')).toBe(platform === 'linux');
      await fs.writeFile(path.join(dir, 'opencode.jsonc'), '{}');
      await expect(launch.assertUnchanged!()).rejects.toThrow('cannot isolate');
    } finally { await launch.cleanup!(); }
  });
  it('rejects a retargeted workspace symlink before a later startup phase', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-oc-retarget-'))); dirs.push(dir);
    const first = path.join(dir, 'first'); const second = path.join(dir, 'second'); const alias = path.join(dir, 'work');
    await fs.mkdir(first); await fs.mkdir(second); await directoryLink(first, alias);
    const launch = await prepareOpenCodeNativeLaunch({ settings, session: createOpenCodeSession(), cwd: alias, env: { ANTHROPIC_API_KEY: 'inert-fixture' }, cliPath: '/inert', signal: new AbortController().signal }, settings.model);
    try {
      await fs.rm(alias, { recursive: true }); await directoryLink(second, alias);
      expect((await fs.stat(first)).isDirectory()).toBe(true);
      await expect(launch.assertUnchanged!()).rejects.toThrow('workspace changed');
    } finally { await launch.cleanup!(); }
  });
  it('fails clearly before allocating native state when model/auth is unsupported', async () => {
    const context = { settings, session: createOpenCodeSession(), cwd: '/work', env: {}, cliPath: '/inert', signal: new AbortController().signal };
    await expect(prepareOpenCodeNativeLaunch(context, undefined)).rejects.toThrow('explicit provider/model');
    await expect(prepareOpenCodeNativeLaunch(context, 'anthropic/claude-sonnet-4-5')).rejects.toThrow('ANTHROPIC_API_KEY');
    await expect(prepareOpenCodeNativeLaunch(context, 'custom/model')).rejects.toThrow('supported provider API key');
  });
});

describe('OpenCode final permission payload binding', () => {
  it('uses final native edit diff instead of an earlier streamed replacement', () => {
    const final = { filepath: '/work/file', diff: '--- old\n+++ new\n@@ -1 +1 @@\n-old\n+new' };
    const decoded = decodeOpenCodePermission(request('edit', final), tool('edit', { filePath: '/work/file', oldString: 'old', newString: 'streamed' }));
    expect(decoded).toMatchObject({ name: 'Edit', input: final }); expect(decoded?.input).not.toHaveProperty('newString');
  });
  it('retains final multi-file move and deletion metadata', () => {
    const files = [{ filePath: '/work/a', movePath: '/work/b', patch: 'patch' }, { filePath: '/work/c', patch: 'deleted' }];
    expect(decodeOpenCodePermission(request('edit', { files }), tool('edit', {}))?.input).toEqual({ files });
  });
  it('binds empty native read metadata to the exact tracked read input', () => {
    const input = { filePath: '/work/file', offset: 4, limit: 9 };
    expect(decodeOpenCodePermission(request('read', {}), tool('read', input))).toMatchObject({ name: 'Read', input });
  });
  it('binds a shell request to the tracked command and its workdir', () => {
    expect(decodeOpenCodePermission(request('execute', { command: '> out' }), tool('execute', { command: '> out', description: 'd', cwd: '/shown' })))
      .toMatchObject({ name: 'Bash', input: { command: '> out' } });
    expect(decodeOpenCodePermission(request('execute', { command: 'ls' }), tool('execute', { command: 'ls', workdir: 'sub' }))?.input)
      .toEqual({ command: 'ls', workdir: 'sub' });
  });
  it.each([
    [request('execute', { command: '> /work/effect' }), tool('execute', {})],
    [request('execute', { command: 'ls' }), tool('execute', { command: 'ls -la' })],
    [request('execute', { command: 'ls', workdir: '/other' }), tool('execute', { command: 'ls' })],
    [request('execute', { command: 'ls' }), tool('execute', { command: 'ls', workdir: 7 })],
    [request('execute', { command: 'ls' }), undefined],
    [request('execute', { command: '' }), tool('execute', { command: '' })],
    [request('execute', { command: 'ls' }), tool('edit', { command: 'ls' })],
    [request('edit', {}), tool('edit', { filePath: '/work/a' })],
    [request('edit', { files: [] }), tool('edit', {})],
    [request('read', {}), undefined],
    [request('read', {}), tool('read', { filePath: '/work/a' }, { toolCallId: 'other' })],
    [request('read', {}), tool('read', { filePath: '/work/a' }, { status: 'completed' })],
    [request('other', {}), tool('read', { filePath: '/work/a' })],
    [request('read', { filePath: '/work/other' }), tool('read', { filePath: '/work/a' })],
    [request('search', { pattern: 'changed' }), tool('search', { pattern: 'original' })],
    [request('fetch', { url: 'https://changed.test' }), tool('fetch', { url: 'https://original.test' })],
  ])('rejects unsupported, incomplete, stale or conflicting authority %#', (params, tracked) => {
    expect(decodeOpenCodePermission(params, tracked)).toBeUndefined();
  });
});
