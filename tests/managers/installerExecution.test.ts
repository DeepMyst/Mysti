import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), killTree: vi.fn(async () => {}) }));
vi.mock('../../src/utils/processKill', () => ({ killProcessTree: mocks.killTree }));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: vi.fn(actual.homedir) };
});
vi.mock('child_process', async () => ({ ...await vi.importActual<any>('child_process'), spawn: mocks.spawn }));
import { SetupManager } from '../../src/managers/SetupManager';
describe('installer execution', () => {
  let manager: any;
  let proc: any;
  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SetupManager({ globalState: { get: () => undefined } } as any, { getProviderInstance: () => undefined } as any);
    proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    mocks.spawn.mockReturnValue(proc);
  });
  it('uses discovered npm and sibling node on PATH, and enforces package Node requirements', async () => {
    manager._npmPath = path.resolve('fixture-nvm', 'bin', 'npm');
    const result = manager._runCommand('npm install -g example');
    const options = mocks.spawn.mock.calls[0][2];
    const key = Object.keys(options.env).find(key => key.toLowerCase() === 'path')!;
    expect(options.env[key].split(path.delimiter)[0]).toBe(path.dirname(manager._npmPath));
    expect(options.env.npm_config_engine_strict).toBe('true');
    proc.emit('close', 0);
    expect(await result).toMatchObject({ success: true });
  });
  it('keeps global layout when falling back to a writable user directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-prefix-test-'));
    const home = vi.mocked(os.homedir);
    const original = home.getMockImplementation()!;
    home.mockReturnValue(dir);
    const run = vi.spyOn(manager, '_runCommand').mockResolvedValue({ success: true });
    try {
      expect(await manager._installToLocalPrefix('npm install -g cline', false)).toEqual({ success: true });
      const command = run.mock.calls[0][0] as string;
      expect(command).toMatch(/npm install --prefix .* -g cline$/);
      expect(command).toContain(path.join(dir, '.mysti', 'cli'));
    } finally { home.mockImplementation(original); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('returns install error details and classifies incompatible Node versions', async () => {
    const result = manager._runCommand('npm install -g example');
    proc.stderr.write('EBADENGINE Required node >=22');
    proc.emit('close', 1);
    expect(await result).toMatchObject({ success: false, error: 'EBADENGINE Required node >=22' });
    expect(manager._classifyError('EBADENGINE Required node >=22', 1)).toBe('version');
  });
  it('reports process launch errors and timeout without claiming success', async () => {
    const result = manager._runCommand('npm install -g example');
    proc.emit('error', new Error('ENOENT'));
    expect(await result).toMatchObject({ success: false, error: 'ENOENT' });
    vi.useFakeTimers();
    try {
      const timed = manager._runCommand('npm install -g example', 10);
      await vi.advanceTimersByTimeAsync(10);
      expect(mocks.killTree).toHaveBeenCalledWith(proc, 1000, { label: 'Installer', useProcessGroup: process.platform !== 'win32', initialSignal: 'SIGKILL' });
      expect(await timed).toMatchObject({ success: false, error: 'Command timed out' });
    } finally { vi.useRealTimers(); }
  });
  it('refuses auto-install when a provider needs an interactive setup', async () => {
    manager._providerManager = { getProviderInstance: () => ({ displayName: 'Manual CLI', capabilities: { supportsAutoInstall: false } }) };
    expect(await manager.autoInstallCli('manual')).toMatchObject({ success: false, requiresManual: true });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it('refuses install if npm is missing', async () => {
    manager._providerManager = { getProviderInstance: () => ({ displayName: 'CLI', capabilities: { supportsAutoInstall: true }, getInstallCommand: () => 'npm install -g example' }) };
    vi.spyOn(manager, 'checkNpmAvailable').mockResolvedValue(false);
    expect(await manager.autoInstallCli('example')).toMatchObject({ success: false, errorCategory: 'not-found' });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
