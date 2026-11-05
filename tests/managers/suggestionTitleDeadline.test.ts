import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SuggestionManager } from '../../src/managers/SuggestionManager';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn(async () => {}) }));
vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: mocks.spawn }));
vi.mock('../../src/utils/processKill', async original => ({ ...await original<typeof import('../../src/utils/processKill')>(), killProcessTree: mocks.kill }));
let manager: SuggestionManager;
let child: any;
beforeEach(() => {
  vi.useFakeTimers(); clearMockConfig(); setMockConfig('claudeCodePath', '/controlled/title-worker');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.kill.mockClear();
  mocks.spawn.mockReset().mockImplementation(() => {
    child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
    return child;
  });
  manager = new SuggestionManager({} as any);
});
afterEach(() => { manager.dispose(); child?.emit('close', null); child = undefined; vi.clearAllTimers(); vi.useRealTimers(); clearMockConfig(); vi.restoreAllMocks(); });

describe('title worker allows bounded CLI startup and inference latency', () => {
  it.each([6000, 16000, 19999])('accepts a completed title after %i ms without killing it early', async delay => {
    const pending = manager.generateTitle('Explain caching and cache expiry');
    await vi.advanceTimersByTimeAsync(delay);
    expect(mocks.kill).not.toHaveBeenCalled();
    child.stdout.write('Cache Expiry Explained'); child.emit('close', 0);
    expect(await pending).toBe('Cache Expiry Explained');
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back at twenty seconds and ignores a late successful completion', async () => {
    let result: string | undefined;
    const pending = manager.generateTitle('Explain caching').then(title => { result = title; return title; });
    child.stdout.write('Unfinished generated title');
    await vi.advanceTimersByTimeAsync(19999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe('Explain caching');
    expect(mocks.kill).toHaveBeenCalledWith(child, expect.any(Number), expect.objectContaining({ initialSignal: 'SIGKILL' }));
    child.stdout.write('late output'); child.emit('close', 0);
    expect(result).toBe('Explain caching');
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disposal settles a slow title immediately and clears its remaining deadline', async () => {
    const pending = manager.generateTitle('Explain caching');
    await vi.advanceTimersByTimeAsync(6000);
    expect(mocks.kill).not.toHaveBeenCalled();
    manager.dispose();
    expect(await pending).toBe('Explain caching');
    expect(mocks.kill).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
