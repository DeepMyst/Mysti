import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as fs from 'fs';
import * as path from 'path';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn(async () => {}), execAsync: vi.fn() }));
vi.mock('child_process', async () => {
  const actual = await vi.importActual<any>('child_process');
  const { promisify } = await import('util');
  const exec = vi.fn(); Object.defineProperty(exec, promisify.custom, { value: mocks.execAsync });
  return { ...actual, spawn: mocks.spawn, exec };
});
vi.mock('../../src/utils/processKill', () => ({ killProcessTree: mocks.kill }));
vi.mock('fs', async () => ({ ...await vi.importActual<any>('fs'), accessSync: vi.fn(), existsSync: vi.fn(), readdirSync: vi.fn() }));
import { SetupManager } from '../../src/managers/SetupManager';

const hostPlatform = process.platform;

let manager: any;
let proc: any;
beforeEach(() => {
  vi.useFakeTimers(); mocks.spawn.mockReset(); mocks.kill.mockClear();
  mocks.execAsync.mockReset().mockImplementation((_command, options) => new Promise((_resolve, reject) => {
    if (options?.timeout) { setTimeout(() => reject(new Error('probe timed out')), options.timeout); }
  }));
  vi.mocked(fs.accessSync).mockReset().mockImplementation(() => { throw new Error('not found'); });
  vi.mocked(fs.existsSync).mockReset().mockReturnValue(false);
  vi.mocked(fs.readdirSync).mockReset().mockReturnValue([]);
  proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  mocks.spawn.mockReturnValue(proc);
  manager = new SetupManager({ globalState: { get: () => undefined } } as any, {} as any) as any;
  manager._npmPath = '/fixture/Selected Node/bin/npm';
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: hostPlatform });
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
});

function complete(stdout: string) { proc.stdout.write(stdout); proc.emit('close', 0); }
async function flush() { for (let i = 0; i < 20; i++) { await Promise.resolve(); } }

describe('PC-02 setup prerequisite probes', () => {
  it.each(['_checkNpmDirect', '_checkNpmViaLoginShell', '_checkNodeVersion', '_getNodeVersion', 'checkNetworkConnectivity'])('bounds a stalled %s subprocess', async method => {
    let done = false;
    const pending = manager[method]().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(done).toBe(true);
    await pending;
    if (mocks.spawn.mock.calls.length > 0) { expect(mocks.kill).toHaveBeenCalledTimes(1); }
  });

  it('bounds the whole NVM search if several candidate npm launchers stall', async () => {
    vi.mocked(fs.accessSync).mockImplementation(() => {});
    let done = false;
    const pending = manager._checkNpmInNvmPaths().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(done).toBe(true);
    await pending;
    expect(mocks.spawn.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('checks Node with the selected npm directory first, rather than rejecting the older PATH runtime', async () => {
    manager._npmPath = null;
    const select = vi.spyOn(manager, 'checkNpmAvailable').mockImplementation(async () => {
      manager._npmPath = '/fixture/Selected Node/bin/npm'; return true;
    });
    mocks.execAsync.mockResolvedValue({ stdout: 'v16.20.2', stderr: '' });
    const pending = manager._checkNodeVersion(); await flush();
    expect(select).toHaveBeenCalledTimes(1);
    const [command, args, options] = mocks.spawn.mock.calls[0];
    expect(command).toBe('node'); expect(args).toEqual(['--version']);
    const pathKey = Object.keys(options.env).find(key => key.toLowerCase() === 'path')!;
    expect(options.env[pathKey].split(path.delimiter)[0]).toBe('/fixture/Selected Node/bin');
    complete('v22.23.3');
    expect(await pending).toEqual({ meets: true, version: 'v22.23.3' });
  });

  it('pings the selected npm executable using its sibling Node directory', async () => {
    const pending = manager.checkNetworkConnectivity();
    expect(mocks.spawn.mock.calls[0]?.slice(0, 2)).toEqual(['/fixture/Selected Node/bin/npm', ['ping']]);
    const env = mocks.spawn.mock.calls[0][2].env;
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path')!;
    expect(env[pathKey].split(path.delimiter)[0]).toBe('/fixture/Selected Node/bin');
    complete(''); expect(await pending).toBe(true);
  });

  it('rejects an unrecognized Node response instead of treating it as supported', async () => {
    mocks.execAsync.mockResolvedValue({ stdout: 'Please finish setup first', stderr: '' });
    const pending = manager._checkNodeVersion(); complete('Please finish setup first');
    expect(await pending).toMatchObject({ meets: false });
  });

  it('uses argv for a login shell path containing spaces', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.stubEnv('SHELL', '/fixture/Shell App/bin/bash');
    const pending = manager._checkNpmViaLoginShell();
    expect(mocks.spawn.mock.calls[0]?.slice(0, 2)).toEqual(['/fixture/Shell App/bin/bash', ['-l', '-c', 'npm --version']]);
    complete('10.9.2'); expect(await pending).toBe(true);
  });

  it('checks Node and the registry through the same login shell that found npm', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.stubEnv('SHELL', '/fixture/Shell App/bin/bash');
    manager._npmPath = 'npm';
    const detect = manager._checkNpmViaLoginShell(); complete('10.9.2'); await detect;
    const version = manager._getNodeVersion();
    expect(mocks.spawn.mock.calls.at(-1)?.slice(0, 2)).toEqual(['/fixture/Shell App/bin/bash', ['-l', '-c', 'node --version']]);
    complete('v22.23.3'); expect(await version).toBe('v22.23.3');
    const network = manager.checkNetworkConnectivity();
    expect(mocks.spawn.mock.calls.at(-1)?.slice(0, 2)).toEqual(['/fixture/Shell App/bin/bash', ['-l', '-c', 'npm ping']]);
    complete(''); expect(await network).toBe(true);
  });

  it('tries the newest installed NVM runtime before an older single-digit version', async () => {
    vi.stubEnv('NVM_DIR', '/fixture/NVM with spaces');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['v9.0.0', 'v22.23.3'] as any);
    vi.mocked(fs.accessSync).mockImplementation(file => {
      if (!String(file).includes(path.join('versions', 'node') + path.sep)) { throw new Error('not found'); }
    });
    const pending = manager._checkNpmInNvmPaths();
    const selected = path.join('/fixture/NVM with spaces', 'versions', 'node', 'v22.23.3', 'bin', process.platform === 'win32' ? 'npm.cmd' : 'npm');
    expect(mocks.spawn.mock.calls[0]?.[0]).toBe(process.platform === 'win32' ? `"${selected}"` : selected);
    complete('10.9.2'); expect(await pending).toBe(selected);
  });

  it('does not invoke a POSIX login shell on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.stubEnv('SHELL', '/fixture/Shell App/bin/bash');
    expect(await manager._checkNpmViaLoginShell()).toBe(false);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
