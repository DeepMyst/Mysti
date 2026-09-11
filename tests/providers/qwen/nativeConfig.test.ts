import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureNativeFamilyConfig, nativeFamilyEnvironment } from '../../../src/providers/qwen/QwenNativeConfig';

const dirs: string[] = [];
async function fixture(flavor: 'qwen' | 'gemini' = 'qwen') {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-family-config-'))); dirs.push(dir);
  const cwd = path.join(dir, 'work'); const state = path.join(dir, 'state'); const install = path.join(dir, 'cli');
  await Promise.all([fs.mkdir(cwd), fs.mkdir(state), fs.mkdir(install)]);
  const cliPath = path.join(install, 'cli.js'); const policyFile = path.join(dir, 'host.json');
  await fs.writeFile(cliPath, '// This fixture is inspected, never executed.');
  const packageFile = path.join(install, 'package.json'); const version = flavor === 'qwen' ? '0.23.0' : '0.58.0';
  await fs.writeFile(packageFile, JSON.stringify({ name: flavor === 'qwen' ? '@qwen-code/qwen-code' : '@google/gemini-cli', version }));
  await fs.writeFile(policyFile, '{"host":"policy"}');
  const nativeDir = flavor === 'qwen' ? state : path.join(state, '.gemini'); await fs.mkdir(nativeDir, { recursive: true });
  const options = { flavor, cwd, env: { QWEN_HOME: state, GEMINI_CLI_HOME: state }, cliPath, version, policyFiles: [policyFile] };
  return { dir, cwd, nativeDir, packageFile, policyFile, options };
}
afterEach(async () => { for (const dir of dirs.splice(0)) { await fs.rm(dir, { recursive: true, force: true }); } });
describe('native family startup authority snapshots', () => {
  it('removes interpreter, shell, native IDE and private-parent startup hooks without changing the input environment', () => {
    const source = { PATH: '/usr/bin', QWEN_HOME: '/native/qwen', NODE_OPTIONS: '--require attacker.js', BUN_OPTIONS: '--preload attacker.js',
      QWEN_CODE_RELAUNCH_ARGS: '["--approval-mode","yolo"]', QWEN_CODE_MANAGED_NPM_PIN: 'untrusted', QWEN_CODE_LAUNCHER_PATH: '/untrusted', QWEN_CODE_STARTUP_VERSION: 'fake',
      BASH_ENV: '/startup', ENV: '/startup', GEMINI_SANDBOX_PROXY_COMMAND: 'unreviewed', GEMINI_CLI_IDE_SERVER_STDIO_COMMAND: 'unreviewed',
      QWEN_CODE_ACP_PARENT_CAPABILITY: 'untrusted', QWEN_CODE_IDE_SERVER_STDIO_COMMAND: 'unreviewed', GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES: '1' };
    const env = nativeFamilyEnvironment(source);
    expect(env).toEqual({ PATH: '/usr/bin', QWEN_HOME: '/native/qwen', GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES: '0' });
    expect(source.NODE_OPTIONS).toBe('--require attacker.js');
  });
  it.each(['qwen', 'gemini'] as const)('accepts verified %s package and unchanged policy without reading credentials', async flavor => {
    const test = await fixture(flavor);
    await fs.writeFile(path.join(test.nativeDir, 'oauth_creds.json'), 'not-json-and-must-never-be-parsed');
    const captured = await captureNativeFamilyConfig(test.options); await expect(captured.assertUnchanged()).resolves.toBeUndefined();
  });
  it('retains inherited native deny/allow rules while the bundled ask policy controls approvals', async () => {
    const test = await fixture(); await fs.writeFile(path.join(test.nativeDir, 'settings.json'), JSON.stringify({ $version: 4, permissions: { allow: ['run_shell_command'], deny: ['edit(/protected/**)'] } }));
    await expect(captureNativeFamilyConfig(test.options)).resolves.toHaveProperty('assertUnchanged');
  });
  it.each(['hooks', 'agents', 'policies', 'extensions', 'commands', 'skills'])('rejects executable %s customization before starting native code', async name => {
    const test = await fixture(); const custom = path.join(test.nativeDir, name); await fs.mkdir(custom); await fs.writeFile(path.join(custom, 'custom'), 'do not execute');
    await expect(captureNativeFamilyConfig(test.options)).rejects.toThrow(`custom native ${name}`);
  });
  it('allows only metadata-only empty extension creation and still catches an added payload', async () => {
    const test = await fixture(); const captured = await captureNativeFamilyConfig(test.options);
    const extensions = path.join(test.nativeDir, 'extensions'); await fs.mkdir(extensions); await fs.writeFile(path.join(extensions, 'extension-enablement.json'), '{}');
    await expect(captured.assertUnchanged()).resolves.toBeUndefined();
    await fs.writeFile(path.join(extensions, 'payload.js'), 'do not execute'); await expect(captured.assertUnchanged()).rejects.toThrow('extensions');
  });
  it('rejects workspace .env redirection without disclosing its values', async () => {
    const test = await fixture(); await fs.writeFile(path.join(test.cwd, '.env'), 'QWEN_CODE_SYSTEM_SETTINGS_PATH=SECRET_SENTINEL');
    await expect(captureNativeFamilyConfig(test.options)).rejects.toThrow('workspace .env');
    await expect(captureNativeFamilyConfig(test.options)).rejects.not.toThrow('SECRET_SENTINEL');
  });
  it('also checks the main checkout behind a linked worktree without invoking Git', async () => {
    const test = await fixture(); const main = path.join(test.dir, 'main'); const metadata = path.join(main, '.git', 'worktrees', 'linked');
    await fs.mkdir(metadata, { recursive: true }); await fs.writeFile(path.join(metadata, 'commondir'), '../..\n');
    await fs.writeFile(path.join(test.cwd, '.git'), `gitdir: ${metadata}\n`);
    await fs.mkdir(path.join(main, '.qwen')); await fs.writeFile(path.join(main, '.qwen', 'settings.json'), '{"hooks":{"SessionStart":"unreviewed"}}');
    await expect(captureNativeFamilyConfig(test.options)).rejects.toThrow('unsupported customization');
  });
  it('rejects unsupported CLI versions without executing --version', async () => {
    const test = await fixture(); await fs.writeFile(test.packageFile, JSON.stringify({ name: '@qwen-code/qwen-code', version: '99.0.0' }));
    await expect(captureNativeFamilyConfig(test.options)).rejects.toThrow('only version 0.23.0');
  });
  it.each([
    { modelProviders: { openai: [{ id: 'test', apiKeyCommand: 'SECRET_EXECUTION' }] } },
    { security: { auth: { credential_source: { executable: { command: 'SECRET_EXECUTION' } } } } },
    { model: { auth: { key: '!SECRET_EXECUTION' } } },
  ])('rejects executable model/auth helpers without exposing configuration contents', async settings => {
    const test = await fixture(); await fs.writeFile(path.join(test.nativeDir, 'settings.json'), JSON.stringify(settings));
    await expect(captureNativeFamilyConfig(test.options)).rejects.toThrow('executable native model/auth');
    await expect(captureNativeFamilyConfig(test.options)).rejects.not.toThrow('SECRET_EXECUTION');
  });
  it('rejects source symlinks and policy changes before model input', async () => {
    const test = await fixture(); const captured = await captureNativeFamilyConfig(test.options);
    await fs.writeFile(test.policyFile, '{"changed":true}'); await expect(captured.assertUnchanged()).rejects.toThrow('configuration changed');
    await fs.symlink(test.policyFile, path.join(test.nativeDir, 'settings.json'));
    await expect(captureNativeFamilyConfig(test.options)).rejects.toThrow('symbolic link');
  });
});
