import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QwenCodeProvider } from '../../../src/providers/qwen/QwenCodeProvider';
import { GeminiProvider } from '../../../src/providers/gemini/GeminiProvider';
import * as nativeConfig from '../../../src/providers/qwen/QwenNativeConfig';
import type { AcpNativeLaunch, AcpNativeLaunchContext } from '../../../src/providers/base/AcpNativeTypes';
import { createMockContext } from '../../helpers/providerFactory';
import { createGeminiSession, createQwenSession } from '../../helpers/sessionFactory';

vi.mock('fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('fs/promises')>() }));
vi.mock('os', async importOriginal => ({ ...await importOriginal<typeof import('os')>() }));

// Exercise the actual launch preparation and capture, never a native process.
// Case-insensitive lookup is selected synthetically; this is not Windows-native acceptance.
type Flavor = 'qwen' | 'gemini';
const dirs: string[] = [];
const providers: Array<QwenCodeProvider | GeminiProvider> = [];
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

afterEach(async () => {
  for (const provider of providers.splice(0)) { provider.dispose(); }
  vi.restoreAllMocks(); Object.defineProperty(process, 'platform', originalPlatform);
  for (const dir of dirs.splice(0)) { await fs.rm(dir, { recursive: true, force: true }); }
});

async function fixture(flavor: Flavor, platform = 'win32') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-family-launch-'))); dirs.push(root);
  const cwd = path.join(root, 'work'); const state = path.join(root, 'selected'); const fallback = path.join(root, 'fallback');
  const cliDir = path.join(root, 'cli'); const extension = path.join(root, 'extension');
  const policyDir = path.join(extension, 'resources', `${flavor}-policy`);
  await Promise.all([fs.mkdir(cwd), fs.mkdir(state), fs.mkdir(fallback), fs.mkdir(cliDir), fs.mkdir(policyDir, { recursive: true })]);
  const cliPath = path.join(cliDir, 'cli.js'); await fs.writeFile(cliPath, '// Inert package inspected only; never executed.');
  await fs.writeFile(path.join(cliDir, 'package.json'), JSON.stringify({
    name: flavor === 'qwen' ? '@qwen-code/qwen-code' : '@google/gemini-cli', version: flavor === 'qwen' ? '0.23.0' : '0.58.0',
  }));
  await Promise.all(['settings.json', 'host.toml', 'readonly.toml'].map(file => fs.writeFile(path.join(policyDir, file), '{}')));
  const homeKey = flavor === 'qwen' ? 'QWEN_HOME' : 'GEMINI_CLI_HOME';
  const prefix = flavor === 'qwen' ? 'QWEN_CODE' : 'GEMINI_CLI';
  const nativeDir = flavor === 'qwen' ? state : path.join(state, '.gemini'); await fs.mkdir(nativeDir, { recursive: true });
  const settingsFile = path.join(nativeDir, 'settings.json');
  await fs.writeFile(settingsFile, JSON.stringify(flavor === 'qwen' ? { providerProtocol: { fixture: 'openai' } } : {}));

  // All file content stays in this fixture. Outside ancestor/system metadata is
  // absent, and os.homedir() resolves to an inert fixture home, never a user store.
  const lstat = fs.lstat; const readFile = fs.readFile;
  const owns = (file: unknown) => typeof file === 'string' && (file === root || file.startsWith(`${root}${path.sep}`));
  vi.spyOn(fs, 'lstat').mockImplementation(((file: string, ...args: unknown[]) => owns(file)
    ? (lstat as (...args: unknown[]) => unknown)(file, ...args)
    : Promise.reject(Object.assign(new Error('Absent outside isolated fixture'), { code: 'ENOENT' }))) as typeof fs.lstat);
  vi.spyOn(fs, 'readFile').mockImplementation(((file: string, ...args: unknown[]) => {
    if (!owns(file)) { throw new Error('Unexpected content read outside isolated fixture'); }
    return (readFile as (...args: unknown[]) => unknown)(file, ...args);
  }) as typeof fs.readFile);
  vi.spyOn(os, 'homedir').mockReturnValue(fallback);
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
  const context = createMockContext(); context.extensionPath = extension;
  const provider = flavor === 'qwen' ? new QwenCodeProvider(context) : new GeminiProvider(context); providers.push(provider);
  const captureOriginal = nativeConfig.captureNativeFamilyConfig; const capturedEnvironments: NodeJS.ProcessEnv[] = [];
  const capture = vi.spyOn(nativeConfig, 'captureNativeFamilyConfig').mockImplementation(options => {
    capturedEnvironments.push({ ...options.env }); return captureOriginal(options);
  });
  const prepare = (env: NodeJS.ProcessEnv) => (provider as unknown as {
    _prepareAcpLaunch(context: AcpNativeLaunchContext): Promise<AcpNativeLaunch>;
  })._prepareAcpLaunch({ cliPath, cwd, env, signal: new AbortController().signal,
    session: flavor === 'qwen' ? createQwenSession() : createGeminiSession(),
    settings: { provider: provider.id, mode: 'default', accessLevel: 'ask-permission', model: '', thinkingLevel: 'none', contextMode: 'auto' },
  });
  return { root, cwd, state, fallback, homeKey, prefix, settingsFile, policyDir, prepare, capture, capturedEnvironments };
}

describe.each(['qwen', 'gemini'] as const)('%s captured native environment', flavor => {
  it.each(['lowercase', 'mixedcase', 'identical aliases'])('checks and launches the same Windows home for %s keys', async casing => {
    const test = await fixture(flavor); const key = casing === 'lowercase' ? test.homeKey.toLowerCase()
      : test.homeKey.toLowerCase().replace(/(^|_)[a-z]/g, part => part.toUpperCase());
    const source = { [key]: test.state, ...(casing === 'identical aliases' ? { [test.homeKey]: test.state } : {}) };
    const original = { ...source }; const launch = await test.prepare(source);
    expect(launch.env[test.homeKey]).toBe(test.state);
    expect(Object.keys(launch.env).filter(key => key.toUpperCase() === test.homeKey)).toEqual([test.homeKey]);
    expect(test.capture.mock.calls[0][0].env).toBe(launch.env);
    expect(test.capturedEnvironments[0][test.homeKey]).toBe(test.state);
    if (flavor === 'qwen') {
      expect(test.capturedEnvironments[0].QWEN_CODE_MANAGED_NPM_PIN).toBeUndefined();
      expect(JSON.parse(launch.env.QWEN_CODE_MANAGED_NPM_PIN!)).toEqual({ bootstrap: launch.cliPath, version: null, updateRoot: path.dirname(launch.cliPath!) });
      expect(launch.env[test.homeKey]).toBe(test.capturedEnvironments[0][test.homeKey]);
    }
    expect(source).toEqual(original);
    await expect(launch.assertUnchanged?.()).resolves.toBeUndefined();
    await fs.writeFile(test.settingsFile, '{"ui":{"theme":"changed-after-capture"}}');
    await expect(launch.assertUnchanged?.()).rejects.toThrow('configuration changed during startup');
  });
  it('refuses unsafe settings in a mixed-case Windows home before a process can launch', async () => {
    const test = await fixture(flavor); await fs.writeFile(test.settingsFile, '{"hooks":{"SessionStart":"SECRET_COMMAND"}}');
    const launch = test.prepare({ [test.homeKey.toLowerCase()]: test.state });
    await expect(launch).rejects.toThrow('unsupported customization');
    await expect(launch).rejects.not.toThrow('SECRET_COMMAND');
  });
  it('refuses conflicting Windows home aliases without exposing either value', async () => {
    const test = await fixture(flavor); const launch = test.prepare({ [test.homeKey]: test.state, [test.homeKey.toLowerCase()]: 'SECRET_OTHER_HOME' });
    await expect(launch).rejects.toThrow('conflicting native configuration environment aliases');
    await expect(launch).rejects.not.toThrow('SECRET_OTHER_HOME');
    expect(test.capture).not.toHaveBeenCalled();
  });
  it.each(['SYSTEM_SETTINGS_PATH', 'SYSTEM_DEFAULTS_PATH'])('preserves inherited Windows %s refusal while retaining owned policies', async suffix => {
    const test = await fixture(flavor); const inherited = path.join(test.root, 'inherited-settings.json'); await fs.writeFile(inherited, '{}');
    await expect(test.prepare({ [test.homeKey]: test.state, [`${test.prefix}_${suffix}`.toLowerCase()]: inherited }))
      .rejects.toThrow('managed native settings would conflict with the host policy');
  });
  it.each(['SYSTEM_SETTINGS_PATH', 'SYSTEM_DEFAULTS_PATH'])('captures an absent inherited Windows %s before overriding it', async suffix => {
    const test = await fixture(flavor); const inherited = path.join(test.root, 'initially-absent.json');
    const launch = await test.prepare({ [test.homeKey]: test.state, [`${test.prefix}_${suffix}`.toLowerCase()]: inherited });
    for (const suffix of ['SYSTEM_SETTINGS_PATH', 'SYSTEM_DEFAULTS_PATH']) {
      const key = `${test.prefix}_${suffix}`;
      expect(launch.env[key]).toBe(path.join(test.policyDir, 'settings.json'));
      expect(Object.keys(launch.env).filter(candidate => candidate.toUpperCase() === key)).toEqual([key]);
    }
    expect(test.capture.mock.calls[0][0].env).toBe(launch.env);
    await fs.writeFile(inherited, '{}');
    await expect(launch.assertUnchanged?.()).rejects.toThrow('configuration changed during startup');
  });
  it.each(['SYSTEM_SETTINGS_PATH', 'SYSTEM_DEFAULTS_PATH'])('refuses conflicting Windows %s aliases', async suffix => {
    const test = await fixture(flavor); const key = `${test.prefix}_${suffix}`;
    const launch = test.prepare({ [test.homeKey]: test.state, [key]: 'SECRET_ONE', [key.toLowerCase()]: 'SECRET_TWO' });
    await expect(launch).rejects.toThrow('conflicting native configuration environment aliases');
    await expect(launch).rejects.not.toThrow('SECRET_'); expect(test.capture).not.toHaveBeenCalled();
  });
  it('keeps POSIX lowercase selectors inert and captures the actual fallback home', async () => {
    const test = await fixture(flavor, 'linux'); const ignoredSettings = path.join(test.root, 'ignored-managed.json'); await fs.writeFile(ignoredSettings, '{}');
    await fs.writeFile(test.settingsFile, '{"hooks":{"SessionStart":"not-selected"}}');
    const launch = await test.prepare({ [test.homeKey.toLowerCase()]: test.state, [`${test.prefix}_SYSTEM_SETTINGS_PATH`.toLowerCase()]: ignoredSettings });
    const expectedHome = flavor === 'qwen' ? path.join(test.fallback, '.qwen') : test.fallback;
    expect(launch.env[test.homeKey]).toBe(expectedHome);
    expect(launch.env[test.homeKey.toLowerCase()]).toBe(test.state);
    expect(test.capture.mock.calls[0][0].env).toBe(launch.env);
    const capturedDir = flavor === 'qwen' ? expectedHome : path.join(expectedHome, '.gemini'); await fs.mkdir(capturedDir, { recursive: true });
    await fs.writeFile(path.join(capturedDir, 'settings.json'), '{}');
    await expect(launch.assertUnchanged?.()).rejects.toThrow('configuration changed during startup');
  });
});
