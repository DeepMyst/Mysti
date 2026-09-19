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
  it.each(['QWEN_AGENT_EXECUTION_BACKEND', 'qwen_agent_execution_backend', 'Qwen_Agent_Execution_Backend', 'qWeN_aGeNt_ExEcUtIoN_bAcKeNd'])(
    'removes inherited execution backend selector %s without changing model/auth data', key => {
      const preserved = { PATH: '/inert/bin', QWEN_HOME: '/inert/state', OPENAI_API_KEY: 'inert-test-key', QWEN_MODEL: 'inert-model', GEMINI_MODEL: 'inert-gemini' };
      const source = { ...preserved, [key]: 'docker' };
      expect(nativeFamilyEnvironment(source)).toEqual({ ...preserved, GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES: '0' });
      expect(source).toEqual({ ...preserved, [key]: 'docker' });
    });
  it('removes all case aliases of existing startup hooks and emits exactly one disabled executable-auth flag', () => {
    const preserved = { PATH: '/inert/bin', QWEN_HOME: '/inert/state', GEMINI_CLI_HOME: '/inert/gemini',
      OPENAI_API_KEY: 'inert-test-key', QWEN_MODEL: 'inert-model', GEMINI_MODEL: 'inert-gemini', unrelated: 'keep-original-case' };
    const blocked = ['QWEN_AGENT_EXECUTION_BACKEND', 'GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_COMPILE_CACHE',
      'CLI_VERSION', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'BUN_OPTIONS', 'BASH_ENV', 'ENV', 'ZDOTDIR', 'ZSH_ENV', 'KSH_ENV',
      'QWEN_CODE_ACP_PARENT_CAPABILITY', 'QWEN_CODE_RELAUNCH_ARGS', 'QWEN_CODE_MANAGED_NPM_PIN', 'QWEN_CODE_LAUNCHER_PATH', 'QWEN_CODE_STARTUP_VERSION',
      'GEMINI_SANDBOX_PROXY_COMMAND', 'GEMINI_CLI_IDE_SERVER_STDIO_COMMAND'];
    const aliases = Object.fromEntries(blocked.flatMap(key => [key, key.toLowerCase(), key.toLowerCase().replace(/(^|_)[a-z]/g, part => part.toUpperCase())].map(key => [key, '1'])));
    const source = { ...preserved, ...aliases }; const original = { ...source };
    expect(nativeFamilyEnvironment(source)).toEqual({ ...preserved, GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES: '0' });
    expect(source).toEqual(original);
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
  it.each(['openai', 'qwen-oauth', 'gemini', 'vertex-ai', 'anthropic'])('accepts a Qwen 0.23 provider alias mapped to %s without changing its settings', async protocol => {
    const test = await fixture(); const file = path.join(test.nativeDir, 'settings.json');
    const settings = JSON.stringify({ $version: 4, providerProtocol: { review_fixture: protocol },
      modelProviders: { review_fixture: [{ id: 'inert-model', baseUrl: 'http://127.0.0.1:1/v1' }] } });
    await fs.writeFile(file, settings);
    const captured = await captureNativeFamilyConfig(test.options);
    await expect(captured.assertUnchanged()).resolves.toBeUndefined();
    expect(await fs.readFile(file, 'utf8')).toBe(settings);
  });
  it.each([
    {},
    { providerProtocol: {} },
    { providerProtocol: JSON.parse('{"my-command-router":"openai","constructor":"anthropic","__proto__":"gemini"}') },
  ])('accepts absent/empty protocol maps and treats arbitrary provider IDs as data: %j', async settings => {
    const test = await fixture(); await fs.writeFile(path.join(test.nativeDir, 'settings.json'), JSON.stringify(settings));
    const captured = await captureNativeFamilyConfig(test.options);
    await expect(captured.assertUnchanged()).resolves.toBeUndefined();
  });
  it.each(['my-command-router', 'constructor', '__proto__'])('accepts provider ID %s paired with its actual model array', async providerId => {
    const test = await fixture(); const settings = { providerProtocol: { [providerId]: 'openai' },
      modelProviders: { [providerId]: [{ id: 'inert-model', baseUrl: 'http://127.0.0.1:1/v1' }] } };
    await fs.writeFile(path.join(test.nativeDir, 'settings.json'), JSON.stringify(settings));
    const captured = await captureNativeFamilyConfig(test.options);
    await expect(captured.assertUnchanged()).resolves.toBeUndefined();
  });
  it.each([
    { apiKeyCommand: 'SECRET_EXECUTION' },
    { auth: { credential_source: { executable: { command: 'SECRET_EXECUTION' } } } },
    { auth: { value: '!SECRET_EXECUTION' } },
    { nested: { preload: 'SECRET_EXECUTION' } },
  ])('still rejects executable fields beneath an arbitrary provider ID', async model => {
    const test = await fixture(); await fs.writeFile(path.join(test.nativeDir, 'settings.json'), JSON.stringify({
      providerProtocol: { 'my-command-router': 'openai' }, modelProviders: { 'my-command-router': [{ id: 'inert-model', ...model }] },
    }));
    const result = captureNativeFamilyConfig(test.options);
    await expect(result).rejects.toThrow('executable native model/auth');
    await expect(result).rejects.not.toThrow('SECRET_EXECUTION');
  });
  it.each(['qwen', 'gemini'] as const)('preserves %s executable-key refusal outside Qwen model-array provider IDs', async flavor => {
    const test = await fixture(flavor); const modelProviders = { command: flavor === 'qwen' ? 'SECRET_EXECUTION' : [{ id: 'inert-model' }] };
    await fs.writeFile(path.join(test.nativeDir, 'settings.json'), JSON.stringify({ modelProviders }));
    await expect(captureNativeFamilyConfig(test.options)).rejects.toThrow('executable native model/auth');
  });
  it.each([
    ['null root', null], ['array root', []], ['string root', 'openai'], ['numeric root', 1], ['boolean root', false],
    ['unknown protocol', { inert: 'future-protocol' }], ['future Responses protocol', { inert: 'openai-responses' }],
    ['uppercase protocol', { inert: 'OPENAI' }], ['padded protocol', { inert: ' openai ' }], ['empty protocol', { inert: '' }],
    ['numeric entry', { inert: 1 }], ['null entry', { inert: null }], ['array entry', { inert: ['openai'] }], ['boolean entry', { inert: true }],
    ['nested protocol', { inert: { protocol: 'openai' } }], ['nested executable', { inert: { command: 'SECRET_EXECUTION' } }],
    ['executable string', { inert: '!SECRET_EXECUTION' }], ['mixed valid and invalid entries', { valid: 'openai', invalid: { executable: 'SECRET_EXECUTION' } }],
    ['prototype-like invalid entry', JSON.parse('{"__proto__":{"command":"SECRET_EXECUTION"}}')],
  ])('rejects unsupported providerProtocol %s without exposing its contents', async (_name, providerProtocol) => {
    const test = await fixture(); await fs.writeFile(path.join(test.nativeDir, 'settings.json'), JSON.stringify({ providerProtocol }));
    const result = captureNativeFamilyConfig(test.options);
    await expect(result).rejects.toThrow('providerProtocol must map provider IDs to supported protocol names');
    await expect(result).rejects.not.toThrow('SECRET_EXECUTION');
  });
  it.each(['hooks', 'tools', 'mcpServers', 'codeMode', 'omni'])('still rejects %s customization alongside a valid protocol map', async key => {
    const test = await fixture(); await fs.writeFile(path.join(test.nativeDir, 'settings.json'), JSON.stringify({ providerProtocol: { inert: 'openai' }, [key]: {} }));
    await expect(captureNativeFamilyConfig(test.options)).rejects.toThrow('unsupported customization');
  });
  it.each([{}, { inert: 'openai' }])('does not allow Qwen protocol maps in Gemini settings: %j', async providerProtocol => {
    const test = await fixture('gemini'); await fs.writeFile(path.join(test.nativeDir, 'settings.json'), JSON.stringify({ providerProtocol }));
    await expect(captureNativeFamilyConfig(test.options)).rejects.toThrow('Gemini CLI native approval setup refused: native settings contain unsupported customization');
  });
  it.each(['changed', 'created'] as const)('rejects a valid protocol mapping %s after startup capture', async scenario => {
    const test = await fixture(); const file = path.join(test.nativeDir, 'settings.json');
    if (scenario === 'changed') { await fs.writeFile(file, JSON.stringify({ providerProtocol: { inert: 'openai' } })); }
    const captured = await captureNativeFamilyConfig(test.options);
    await fs.writeFile(file, JSON.stringify({ providerProtocol: { inert: 'anthropic' } }));
    await expect(captured.assertUnchanged()).rejects.toThrow('configuration changed during startup');
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
  it.each(['0.24.1', '99.0.0'])('rejects unsupported CLI version %s without executing --version', async version => {
    const test = await fixture(); await fs.writeFile(test.packageFile, JSON.stringify({ name: '@qwen-code/qwen-code', version }));
    await expect(captureNativeFamilyConfig(test.options)).rejects.toThrow('only version 0.23.0');
  });
  it.each([
    { modelProviders: { openai: [{ id: 'test', apiKeyCommand: 'SECRET_EXECUTION' }] } },
    { security: { auth: { credential_source: { executable: { command: 'SECRET_EXECUTION' } } } } },
    { model: { auth: { key: '!SECRET_EXECUTION' } } },
  ])('rejects executable model/auth helpers without exposing configuration contents', async settings => {
    const test = await fixture(); await fs.writeFile(path.join(test.nativeDir, 'settings.json'), JSON.stringify({ providerProtocol: { inert: 'openai' }, ...settings }));
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
