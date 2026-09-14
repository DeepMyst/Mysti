import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { launchEditor } = require('../../scripts/editor-test-launcher.cjs');
const root = path.resolve(__dirname, '../..');

describe('the editor acceptance runner', () => {
  it('runs sequential hooks and propagates assertion, async, setup, teardown, timeout and uncaught failures', () => {
    const output = execFileSync(process.execPath, ['scripts/check-editor-runner.cjs'], { cwd: root, encoding: 'utf8', timeout: 15_000 });
    expect(output).toContain('14 checks passed');
  });

  const config = () => ({
    version: '1.86.0', extensionDevelopmentPath: './tests-vscode/driver',
    workspaceFolder: './out-vscode-test/fixture-workspace',
    env: { MYSTI_TEST_USER_DATA_DIR: path.join(root, 'out-test/private profile'), MYSTI_TEST_OLLAMA_ENDPOINT: 'http://127.0.0.1:1234' },
    launchArgs: ['--user-data-dir=' + path.join(root, 'out-test/private profile'), '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'],
    installExtensions: ['./out-test/exact archive.vsix'],
  });
  it('installs the exact archive before starting the private minimum editor and inert driver', async () => {
    const order: string[] = [];
    const api = {
      runVSCodeCommand: vi.fn(async () => { order.push('install'); return { stdout: '' }; }),
      runTests: vi.fn(async () => { order.push('test'); return 0; }),
    };
    const settings = config();
    await launchEditor(settings, api);
    expect(order).toEqual(['install', 'test']);
    expect(api.runVSCodeCommand).toHaveBeenCalledWith(expect.arrayContaining([
      '--install-extension=' + path.join(root, 'out-test/exact archive.vsix'), '--force',
      '--user-data-dir=' + settings.env.MYSTI_TEST_USER_DATA_DIR,
      '--extensions-dir=' + path.join(root, '.vscode-test/extensions'),
    ]), expect.objectContaining({ version: '1.86.0', reuseMachineInstall: false }));
    expect(api.runTests).toHaveBeenCalledWith(expect.objectContaining({
      version: '1.86.0', extensionDevelopmentPath: path.join(root, 'tests-vscode/driver'),
      extensionTestsPath: path.join(root, 'scripts/editor-test-runner.cjs'),
      extensionTestsEnv: settings.env, reuseMachineInstall: false,
      launchArgs: expect.arrayContaining([path.join(root, 'out-vscode-test/fixture-workspace'), ...settings.launchArgs]),
    }));
  });
  it('does not run the editor after archive installation fails', async () => {
    const api = { runVSCodeCommand: vi.fn(async () => { throw new Error('installation failed'); }), runTests: vi.fn() };
    await expect(launchEditor(config(), api)).rejects.toThrow('installation failed');
    expect(api.runTests).not.toHaveBeenCalled();
  });
  it('fails if the editor reports an unsuccessful exit', async () => {
    const api = { runVSCodeCommand: vi.fn(async () => ({ stdout: '' })), runTests: vi.fn(async () => 1) };
    await expect(launchEditor(config(), api)).rejects.toThrow('code 1');
  });
});
