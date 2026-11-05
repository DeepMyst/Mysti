import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn(async () => {}) }));
vi.mock('child_process', async () => ({ ...await vi.importActual<any>('child_process'), spawn: mocks.spawn }));
vi.mock('../../src/utils/processKill', () => ({ killProcessTree: mocks.kill }));
import { checkCommandExists, probeCliOutput, probeCliVersion, resolveCommandOnPath } from '../../src/utils/platform';

const realPlatform = process.platform;
let proc: any;
let log: ReturnType<typeof vi.spyOn>;
const diagnostics = () => log.mock.calls.filter(call => call[0] === '[Mysti CLI probe]')
  .map(call => JSON.parse(String(call[1])));
const flushDiagnostics = async () => { await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => {
  vi.useFakeTimers();
  mocks.spawn.mockReset(); mocks.kill.mockReset().mockResolvedValue(undefined);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), pid: 41001 });
  mocks.spawn.mockReturnValue(proc);
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  vi.useRealTimers(); vi.restoreAllMocks();
});

describe('PC-02 bounded CLI probes', () => {
  it.each(['2.1.263 (Claude Code)', 'codex-cli 0.153.4', 'v1.2.3', 'Kimi Code, version 1.20.0'])('retains supported decorated version %s', async version => {
    const pending = probeCliVersion('/fixture/CLI with spaces/agent');
    proc.stdout.write(version + '\n'); proc.emit('close', 0);
    expect(await pending).toBe(version);
    expect(diagnostics().filter(row => row.event === 'settled')).toEqual([
      expect.objectContaining({ reason: 'close-zero', resultKind: 'output', outputChars: version.length + 1 }),
    ]);
  });

  it('ignores warnings before a valid version and strips terminal colors', async () => {
    const pending = probeCliVersion('/fixture/bin/agent');
    proc.stdout.write('Warning: optional integration requires 9.9.9\n\u001b[32mcodex-cli 0.153.4\u001b[0m\n'); proc.emit('close', 0);
    expect(await pending).toBe('codex-cli 0.153.4');
  });

  it.each(['Error: missing dependency', '2.1.263 (Claude Code)'])('does not publish output from a failed version command (%s)', async output => {
    const pending = probeCliVersion('/fixture/bin/agent');
    proc.stdout.write(output); proc.emit('close', 1);
    expect(await pending).toBeUndefined();
    expect(diagnostics().find(row => row.event === 'settled')?.reason).toBe('close-nonzero');
  });

  it('reports unrecognized success output as unknown instead of a version', async () => {
    const pending = probeCliVersion('/fixture/bin/agent');
    proc.stdout.write('Please sign in to continue'); proc.emit('close', 0);
    expect(await pending).toBeUndefined();
    // Raw successful output is distinct from a recognized version.
    expect(diagnostics().find(row => row.event === 'settled')).toMatchObject({ reason: 'close-zero', resultKind: 'output' });
  });

  it.each(['lookup', 'exists'])('bounds a stalled PATH %s and cleans up its own process tree', async kind => {
    const pending = kind === 'lookup' ? resolveCommandOnPath('fixture-agent') : checkCommandExists('fixture-agent');
    let done = false; void pending.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(5001);
    expect(done).toBe(true);
    expect(await pending).toBe(kind === 'lookup' ? null : false);
    expect(mocks.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('kills a noisy probe immediately and never returns its truncated output as a version', async () => {
    const pending = probeCliVersion('/fixture/bin/agent');
    proc.stdout.write('1.2.3\n' + 'x'.repeat(5000)); proc.emit('close', 0);
    expect(await pending).toBeUndefined();
    expect(mocks.kill).toHaveBeenCalledTimes(1);
    expect(diagnostics().filter(row => row.event === 'settled')).toEqual([
      expect.objectContaining({ reason: 'output-limit', resultKind: 'undefined' }),
    ]);
  });

  it('uses a quoted command-shell invocation for a Windows npm shim with spaces', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const file = 'C:\\Users\\Test User\\AppData\\Roaming\\npm\\agent.cmd';
    const pending = probeCliVersion(file);
    const [command, args, options] = mocks.spawn.mock.calls[0];
    expect(command).toBe(`"${file}"`);
    expect(args).toEqual(['"--version"']);
    expect(options.shell).toBe(true);
    proc.stdout.write('1.2.3'); proc.emit('close', 0);
    expect(await pending).toBe('1.2.3');
  });

  it('never sends a Windows shim containing command expansion to the shell', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const pending = probeCliVersion('C:\\CLI\\%unexpected%\\agent.cmd');
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(await pending).toBeUndefined();
    expect(diagnostics().find(row => row.event === 'settled')?.reason).toBe('invalid-windows-shim');
  });

  it('retains the default deadline reason and late captured closure without delaying the result for cleanup', async () => {
    let finishCleanup!: () => void;
    mocks.kill.mockImplementationOnce(() => {
      // Timer cleanup reaches the actual helper before any new sink call.
      expect(diagnostics().some(row => row.event === 'settled' || row.event === 'cleanup-requested')).toBe(false);
      return new Promise<void>(resolve => { finishCleanup = resolve; });
    });
    const pending = probeCliVersion('/private/selected-cli');
    proc.emit('spawn');
    await vi.advanceTimersByTimeAsync(4999);
    expect(diagnostics().some(row => row.event === 'settled')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeUndefined();
    expect(mocks.kill).toHaveBeenCalledExactlyOnceWith(proc, 0, {
      label: 'CLI probe', useProcessGroup: process.platform !== 'win32', initialSignal: 'SIGKILL',
    });
    expect(diagnostics().find(row => row.event === 'timer-armed')).toMatchObject({ timeoutMs: 5000, childPid: 41001 });
    expect(diagnostics().filter(row => row.event === 'settled')).toEqual([
      expect.objectContaining({ reason: 'deadline', resultKind: 'undefined', outputChars: 0 }),
    ]);
    expect(diagnostics().some(row => row.event === 'cleanup-helper-settled')).toBe(false);
    proc.stdout.write('9.9.9 late output');
    proc.emit('exit', null, 'SIGKILL'); proc.emit('close', null, 'SIGKILL');
    finishCleanup(); await flushDiagnostics();
    const events = diagnostics();
    expect(events.filter(row => row.event === 'settled')).toHaveLength(1);
    expect(events.find(row => row.event === 'exit')).toMatchObject({ childPid: 41001, code: null, signal: 'SIGKILL' });
    expect(events.find(row => row.event === 'close')).toMatchObject({ childPid: 41001, code: null, signal: 'SIGKILL' });
    expect(events.some(row => row.event === 'cleanup-helper-settled')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['synchronous', 'asynchronous'] as const)('records a %s spawn failure without disclosing its private error', async kind => {
    const error = new Error('private-token-and-path') as NodeJS.ErrnoException;
    error.code = 'PRIVATE_ERROR_CODE';
    if (kind === 'synchronous') mocks.spawn.mockImplementationOnce(() => { throw error; });
    const pending = probeCliVersion('/private-token-and-path');
    if (kind === 'asynchronous') proc.emit('error', error);
    expect(await pending).toBeUndefined();
    if (kind === 'asynchronous') proc.emit('close', -2, null);
    await flushDiagnostics();
    expect(diagnostics().filter(row => row.event === 'settled')).toEqual([
      expect.objectContaining({ reason: kind === 'synchronous' ? 'spawn-throw' : 'spawn-error' }),
    ]);
    expect(JSON.stringify(diagnostics())).not.toMatch(/private-token-and-path|PRIVATE_ERROR_CODE/);
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the character bound and omits all raw path, argument, environment and output data', async () => {
    const pending = probeCliOutput('/PRIVATE_PATH', ['PRIVATE_ARGUMENT'], undefined, { PRIVATE_ENV: 'PRIVATE_VALUE' });
    proc.stdout.write('😀'.repeat(2048)); //4096 JavaScript characters,8192 UTF8 bytes.
    expect(mocks.kill).not.toHaveBeenCalled();
    proc.stdout.write('x');
    expect(await pending).toBeUndefined();
    await flushDiagnostics();
    expect(diagnostics().find(row => row.event === 'settled')).toMatchObject({ reason: 'output-limit', outputChars: 4097 });
    expect(JSON.stringify(diagnostics())).not.toMatch(/PRIVATE_|😀/);
    const [command, args, options] = mocks.spawn.mock.calls[0];
    expect(command).toBe('/PRIVATE_PATH'); expect(args).toEqual(['PRIVATE_ARGUMENT']);
    expect(options).toMatchObject({ env: { PRIVATE_ENV: 'PRIVATE_VALUE' }, stdio: ['ignore', 'pipe', 'ignore'], shell: false });
  });

  it('keeps old closure attributed to its captured handle while another probe succeeds', async () => {
    const old = proc;
    const current = Object.assign(new EventEmitter(), { stdout: new PassThrough(), pid: 41002 });
    mocks.spawn.mockReturnValueOnce(old).mockReturnValueOnce(current);
    const oldPending = probeCliVersion('/old');
    const currentPending = probeCliVersion('/current');
    current.stdout.write('2.3.4'); current.emit('exit', 0, null); current.emit('close', 0, null);
    expect(await currentPending).toBe('2.3.4');
    await vi.advanceTimersByTimeAsync(5000); expect(await oldPending).toBeUndefined();
    old.emit('exit', null, 'SIGKILL'); old.emit('close', null, 'SIGKILL');
    await flushDiagnostics();
    const events = diagnostics(), terminals = events.filter(row => row.event === 'settled');
    expect(terminals).toHaveLength(2);
    const oldId = terminals.find(row => row.childPid === 41001).probeId;
    const currentId = terminals.find(row => row.childPid === 41002).probeId;
    expect(oldId).not.toBe(currentId);
    expect(events.filter(row => row.event === 'close')).toEqual(expect.arrayContaining([
      expect.objectContaining({ probeId: oldId, childPid: 41001, signal: 'SIGKILL' }),
      expect.objectContaining({ probeId: currentId, childPid: 41002, code: 0 }),
    ]));
    expect(mocks.kill).toHaveBeenCalledExactlyOnceWith(old, 0, expect.any(Object));
  });

  it('contains log sink failures without changing success or deadline cleanup', async () => {
    log.mockImplementation(() => { throw new Error('broken diagnostic sink'); });
    const success = probeCliVersion('/success');
    proc.stdout.write('1.2.3'); proc.emit('close', 0, null);
    expect(await success).toBe('1.2.3');
    proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), pid: 41003 });
    mocks.spawn.mockReturnValue(proc);
    const stalled = probeCliVersion('/stalled');
    await vi.advanceTimersByTimeAsync(5000);
    expect(await stalled).toBeUndefined();
    expect(mocks.kill).toHaveBeenCalledExactlyOnceWith(proc, 0, expect.any(Object));
    await flushDiagnostics();
    expect(log).toHaveBeenCalled();
  });


  it('records rejected cleanup separately without retrying or changing the first result', async () => {
    mocks.kill.mockRejectedValueOnce(new Error('PRIVATE_CLEANUP_ERROR'));
    const pending = probeCliVersion('/fixture/agent');
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBeUndefined();
    proc.emit('exit', null, 'SIGKILL'); proc.emit('close', null, 'SIGKILL');
    await flushDiagnostics();
    const events = diagnostics();
    expect(events.filter(row => row.event === 'settled')).toEqual([
      expect.objectContaining({ reason: 'deadline' }),
    ]);
    expect(events.filter(row => row.event === 'cleanup-helper-rejected')).toHaveLength(1);
    expect(events.some(row => row.event === 'cleanup-helper-settled')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('PRIVATE_CLEANUP_ERROR');
    expect(mocks.kill).toHaveBeenCalledTimes(1);
  });

});
