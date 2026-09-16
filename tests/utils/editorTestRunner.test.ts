import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { launchEditor, runEditorCli, cliScript } = require('../../scripts/editor-test-launcher.cjs');
const root = path.resolve(__dirname, '../..');

describe('the editor acceptance runner', () => {
  it('runs sequential hooks and propagates assertion, async, setup, teardown, timeout and uncaught failures', () => {
    const output = execFileSync(process.execPath, ['scripts/check-editor-runner.cjs'], { cwd: root, encoding: 'utf8', timeout: 15_000 });
    expect(output).toContain('28 checks passed');
  });

  it('passes spaces, quotes and shell metacharacters literally to a real CLI subprocess', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti editor cli '));
    try {
      const script = path.join(scratch, 'cli fixture.cjs');
      fs.writeFileSync(script, `console.log(JSON.stringify({ args: process.argv.slice(2), nodeMode: process.env.ELECTRON_RUN_AS_NODE }));`);
      const args = ['--install-extension=C:\\Review Folder\\exact archive.vsix', '--user-data-dir=profile & literal', '"quotes"', '%PATH%', '$(not-a-command)', ';literal'];
      const result = await runEditorCli(process.execPath, script, args);
      expect(JSON.parse(result.stdout)).toEqual({ args, nodeMode: '1' });
      fs.writeFileSync(script, `console.error('fixture install failure'); process.exitCode = 7;`);
      await expect(runEditorCli(process.execPath, script, args)).rejects.toThrow('installation failed (7): fixture install failure');
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  });

  it('locates the packaged CLI entrypoint on each accepted host platform', () => {
    expect(cliScript('C:\\VS Code\\Code.exe', 'win32')).toBe('C:\\VS Code\\resources\\app\\out\\cli.js');
    expect(cliScript('/Applications/Visual Studio Code.app/Contents/MacOS/Electron', 'darwin')).toBe('/Applications/Visual Studio Code.app/Contents/Resources/app/out/cli.js');
    expect(cliScript('/opt/VS Code/code', 'linux')).toBe('/opt/VS Code/resources/app/out/cli.js');
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
    const executable = path.join(root, 'fake-editor');
    const install = vi.fn(async () => { order.push('install'); return { stdout: '' }; });
    const api = {
      downloadAndUnzipVSCode: vi.fn(async () => executable),
      runTests: vi.fn(async () => { order.push('test'); return 0; }),
    };
    const settings = config();
    await launchEditor(settings, api, install);
    expect(order).toEqual(['install', 'test']);
    expect(api.downloadAndUnzipVSCode).toHaveBeenCalledExactlyOnceWith({ version: '1.86.0' });
    expect(install).toHaveBeenCalledWith(executable, cliScript(executable), expect.arrayContaining([
      '--install-extension=' + path.join(root, 'out-test/exact archive.vsix'), '--force',
      '--user-data-dir=' + settings.env.MYSTI_TEST_USER_DATA_DIR,
      '--extensions-dir=' + path.join(root, '.vscode-test/extensions'),
    ]));
    expect(api.runTests).toHaveBeenCalledWith(expect.objectContaining({
      version: '1.86.0', vscodeExecutablePath: executable, extensionDevelopmentPath: path.join(root, 'tests-vscode/driver'),
      extensionTestsPath: path.join(root, 'scripts/editor-test-runner.cjs'),
      extensionTestsEnv: settings.env, reuseMachineInstall: false,
      launchArgs: expect.arrayContaining([path.join(root, 'out-vscode-test/fixture-workspace'), ...settings.launchArgs]),
    }));
  });
  it('does not run the editor after archive installation fails', async () => {
    const api = { downloadAndUnzipVSCode: vi.fn(async () => '/fake/editor'), runTests: vi.fn() };
    await expect(launchEditor(config(), api, async () => { throw new Error('installation failed'); })).rejects.toThrow('installation failed');
    expect(api.runTests).not.toHaveBeenCalled();
  });
  it('fails if the editor reports an unsuccessful exit', async () => {
    const api = { downloadAndUnzipVSCode: vi.fn(async () => '/fake/editor'), runTests: vi.fn(async () => 1) };
    await expect(launchEditor(config(), api, async () => ({ stdout: '' }))).rejects.toThrow('code 1');
  });
});
