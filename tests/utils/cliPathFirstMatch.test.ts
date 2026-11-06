import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn(async (_proc: any) => {}) }));
vi.mock('child_process', async () => ({ ...await vi.importActual<any>('child_process'), spawn: mocks.spawn }));
vi.mock('../../src/utils/processKill', () => ({ killProcessTree: mocks.kill }));
import { probeCliOutput, probeCliVersion, resolveCommandOnPath } from '../../src/utils/platform';

const realPlatform = process.platform;
const realChildren: Array<{ child: ChildProcess; closed: Promise<void> }> = [];
const makeProcess = (pid: number) => {
  const owned = Object.assign(new EventEmitter(), {
    pid, stdout: new PassThrough(), exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null, kill: vi.fn((_signal?: NodeJS.Signals) => true),
  });
  owned.kill.mockImplementation(() => {
    queueMicrotask(() => {
      owned.signalCode = 'SIGKILL';
      owned.emit('exit', null, 'SIGKILL'); owned.emit('close', null, 'SIGKILL');
    });
    return true;
  });
  return owned;
};
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
let proc: ReturnType<typeof makeProcess>;
let log: ReturnType<typeof vi.spyOn>;
const events = () => log.mock.calls.filter(call => call[0] === '[Mysti CLI probe]')
  .map(call => JSON.parse(String(call[1])));

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  vi.stubEnv('SystemRoot', 'C:\\Windows');
  mocks.spawn.mockReset(); mocks.kill.mockReset();
  proc = makeProcess(41001);
  mocks.spawn.mockReturnValue(proc);
  mocks.kill.mockImplementation(async owned => {
    // Model independent process closure after the requested cleanup. A result
    // alone is not evidence that a helper has exited.
    await Promise.resolve();
    owned.signalCode = 'SIGKILL';
    owned.emit('exit', null, 'SIGKILL');
    owned.emit('close', null, 'SIGKILL');
  });
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  for (const { child } of realChildren) {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); }
  }
  await Promise.all(realChildren.map(owned => owned.closed));
  realChildren.length = 0;
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

describe('Windows PATH lookup consumes the first complete native result', () => {
  it('returns the first split complete path and cleans up without waiting for later PATH enumeration', async () => {
    let result: string | null | undefined;
    const pending = resolveCommandOnPath('agent');
    void pending.then(value => { result = value; });
    proc.stdout.write('C:\\Tools With Spaces\\');
    await flush(); expect(result).toBeUndefined();
    proc.stdout.write('agent.cmd\r');
    await flush(); expect(result).toBeUndefined();
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(proc.kill).not.toHaveBeenCalled();
    proc.stdout.write('\nC:\\Later\\agent.exe\r\n');
    await flush();
    expect(result).toBe('C:\\Tools With Spaces\\agent.cmd');
    expect(await pending).toBe(result);
    expect(proc.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(mocks.kill).not.toHaveBeenCalled();
    await flush();
    expect(events().filter(row => row.event === 'settled')).toEqual([
      expect.objectContaining({ reason: 'first-match', resultKind: 'output', childPid: proc.pid }),
    ]);
    expect(events().find(row => row.event === 'close')).toMatchObject({ childPid: proc.pid, signal: 'SIGKILL' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the host SystemRoot helper while preserving the caller search environment and argv', async () => {
    const env = { PATH: 'C:\\First;C:\\Second', PATHEXT: '.CMD;.EXE', SystemRoot: 'C:\\Shadow' };
    const pending = resolveCommandOnPath('agent', env);
    expect(mocks.spawn).toHaveBeenCalledWith('C:\\Windows\\System32\\where.exe', ['agent'],
      expect.objectContaining({ env, shell: false, windowsHide: true, detached: false }));
    proc.stdout.write('C:\\First\\agent.cmd\n');
    expect(await pending).toBe('C:\\First\\agent.cmd');
  });

  it.each(['', 'relative-root'])('retains successful-exit semantics when SystemRoot is not absolute (%s)', async root => {
    vi.stubEnv('SystemRoot', root);
    let resolved = false;
    const pending = resolveCommandOnPath('agent');
    void pending.then(() => { resolved = true; });
    expect(mocks.spawn.mock.calls[0][0]).toBe('where');
    proc.stdout.write('C:\\First\\agent.cmd\n');
    await flush(); expect(resolved).toBe(false);
    expect(mocks.kill).not.toHaveBeenCalled();
    proc.emit('close', 1, null);
    expect(await pending).toBeNull();
  });

  it('accepts an absolute UNC result and ignores preceding blank complete lines', async () => {
    const pending = resolveCommandOnPath('agent');
    proc.stdout.write('\r\n\\\\server\\tools\\agent.cmd\r\n');
    expect(await pending).toBe('\\\\server\\tools\\agent.cmd');
  });

  it('preserves a UTF-8 path split inside a multibyte character', async () => {
    const expected = 'C:\\Tools\\équipe\\agent.cmd';
    const bytes = Buffer.from(expected + '\r\n');
    const split = bytes.indexOf(Buffer.from('é')) + 1;
    const pending = resolveCommandOnPath('agent');
    proc.stdout.write(bytes.subarray(0, split));
    await flush(); expect(proc.kill).not.toHaveBeenCalled();
    proc.stdout.write(bytes.subarray(split));
    expect(await pending).toBe(expected);
  });

  it('does not promote an incomplete path to a result at the original deadline', async () => {
    const pending = resolveCommandOnPath('agent');
    proc.stdout.write('C:\\Partial\\agent');
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBeNull();
    expect(mocks.kill).toHaveBeenCalledExactlyOnceWith(proc, 0, expect.any(Object));
    expect(events().find(row => row.event === 'settled')?.reason).toBe('deadline');
  });

  it.each(['relative\\agent.cmd\n', 'C:drive-relative.cmd\n', 'not a result\nC:\\Later\\agent.cmd\n'])
    ('rejects nonabsolute first output even after successful exit (%s)', async output => {
      const pending = resolveCommandOnPath('agent');
      proc.stdout.write(output); proc.emit('close', 0, null);
      expect(await pending).toBeNull(); expect(mocks.kill).not.toHaveBeenCalled();
    });

  it('retains a successful EOF result without a newline and rejects known failure before data', async () => {
    const pending = resolveCommandOnPath('agent');
    proc.stdout.write('C:\\Tools\\agent.exe'); proc.emit('close', 0, null);
    expect(await pending).toBe('C:\\Tools\\agent.exe');
    const failed = makeProcess(41002); mocks.spawn.mockReturnValue(failed);
    const failure = resolveCommandOnPath('agent');
    failed.emit('exit', 1, null); failed.stdout.write('C:\\Tools\\agent.exe\n'); failed.emit('close', 1, null);
    expect(await failure).toBeNull(); expect(mocks.kill).not.toHaveBeenCalled();
  });

  it('preserves the output bound and keeps paths and output out of diagnostics', async () => {
    const pending = resolveCommandOnPath('PRIVATE_AGENT');
    proc.stdout.write('C:\\PRIVATE_PATH\\' + 'x'.repeat(4096) + '\n');
    expect(await pending).toBeNull(); await flush();
    expect(events().find(row => row.event === 'settled')?.reason).toBe('output-limit');
    expect(events().filter(row => row.event === 'first-output')).toHaveLength(1);
    expect(JSON.stringify(events())).not.toMatch(/PRIVATE_|xxxx/);
  });

  it('keeps generic and version probes dependent on successful exit', async () => {
    const generic = probeCliOutput('C:\\Windows\\System32\\where.exe', ['agent']);
    proc.stdout.write('C:\\Tools\\agent.cmd\n'); await flush();
    expect(mocks.kill).not.toHaveBeenCalled(); proc.emit('close', 1, null);
    expect(await generic).toBeUndefined();
    const versionProc = makeProcess(41002); mocks.spawn.mockReturnValue(versionProc);
    const version = probeCliVersion('C:\\Tools\\agent.exe');
    versionProc.stdout.write('1.2.3\n'); versionProc.emit('close', 1, null);
    expect(await version).toBeUndefined(); expect(mocks.kill).not.toHaveBeenCalled();
  });

  it('does not terminate an already exited successful helper', async () => {
    const pending = resolveCommandOnPath('agent');
    proc.exitCode = 0; proc.emit('exit', 0, null);
    proc.stdout.write('C:\\Tools\\agent.exe\n'); proc.emit('close', 0, null);
    expect(await pending).toBe('C:\\Tools\\agent.exe');
    expect(proc.kill).not.toHaveBeenCalled(); expect(mocks.kill).not.toHaveBeenCalled();
  });

  it.each(['false', 'throw'])('uses owned tree cleanup only if direct termination fails (%s)', async failure => {
    proc.kill.mockImplementation(() => { if (failure === 'throw') throw new Error('private failure'); return false; });
    const pending = resolveCommandOnPath('agent');
    proc.stdout.write('C:\\Tools\\agent.exe\n');
    expect(await pending).toBe('C:\\Tools\\agent.exe'); await flush();
    expect(proc.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(mocks.kill).toHaveBeenCalledExactlyOnceWith(proc, 0, {
      label: 'CLI probe', useProcessGroup: false, initialSignal: 'SIGKILL',
    });
    expect(events().filter(row => row.event === 'settled')).toHaveLength(1);
    expect(events().find(row => row.event === 'close')).toMatchObject({ childPid: proc.pid, signal: 'SIGKILL' });
  });

  it('keeps delayed cleanup on its captured helper when a later lookup starts', async () => {
    let closeOld!: () => void;
    const old = proc;
    old.kill.mockImplementationOnce(() => {
      closeOld = () => { old.signalCode = 'SIGKILL'; old.emit('close', null, 'SIGKILL'); };
      return true;
    });
    const first = resolveCommandOnPath('first');
    old.stdout.write('C:\\Tools\\first.exe\n');
    expect(await first).toBe('C:\\Tools\\first.exe');
    const next = makeProcess(41002); mocks.spawn.mockReturnValue(next);
    const second = resolveCommandOnPath('second');
    closeOld(); old.stdout.write('C:\\Stale\\wrong.exe\n');
    next.stdout.write('C:\\Tools\\second.cmd\n');
    expect(await second).toBe('C:\\Tools\\second.cmd');
    await flush();
    expect(old.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(next.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(events().filter(row => row.event === 'settled').map(row => row.childPid)).toEqual([41001, 41002]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('terminates a real held-open helper while an unrelated owned control stays alive', async () => {
    vi.useRealTimers();
    const { spawn: actualSpawn } = await vi.importActual<typeof import('child_process')>('child_process');
    const start = (script: string) => {
      const child = actualSpawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
      realChildren.push({ child, closed });
      return { child, closed };
    };
    const control = start('process.stdout.write("ready\\n"); setInterval(() => {}, 1000);');
    await once(control.child.stdout, 'data');
    const expected = 'C:\\Owned Fixture\\agent.cmd';
    let helper: ReturnType<typeof start> | undefined;
    mocks.spawn.mockImplementationOnce(() => {
      helper = start(`process.stdout.write(${JSON.stringify(expected + '\n')}); setInterval(() => {}, 1000);`);
      return helper.child;
    });
    expect(await resolveCommandOnPath('agent')).toBe(expected);
    expect(helper).toBeDefined();
    await helper!.closed;
    expect(helper!.child.exitCode !== null || helper!.child.signalCode !== null).toBe(true);
    expect(control.child.exitCode).toBeNull(); expect(control.child.signalCode).toBeNull();
    expect(mocks.kill).not.toHaveBeenCalled();
  });
});
