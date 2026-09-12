import { afterEach, describe, expect, it, vi } from 'vitest';
import { terminateOwnedProcessGroup } from '../../../src/providers/openclaw/OwnedProcessGroup';

const failure = (code: string) => Object.assign(new Error(code), { code });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('owned process group settlement', () => {
  it('waits through macOS zombie EPERM until the group is actually absent', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw failure('EPERM'); });
    let settled = false;
    const cleanup = terminateOwnedProcessGroup(2345).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    kill.mockImplementation(() => { throw failure('ESRCH'); });
    await vi.advanceTimersByTimeAsync(20);
    await cleanup;
    expect(kill.mock.calls.filter(call => call[1] === 'SIGKILL')).toEqual([[-2345, 'SIGKILL']]);
  });

  it.each(['EPERM', 'live'])('fails when a %s group remains after the deadline', async state => {
    vi.useFakeTimers();
    vi.spyOn(process, 'kill').mockImplementation(() => {
      if (state === 'EPERM') { throw failure('EPERM'); }
      return true;
    });
    const cleanup = terminateOwnedProcessGroup(2345, 100);
    const rejected = expect(cleanup).rejects.toThrow('did not exit');
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
  });

  it('never sends another signal after establishing group absence', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw failure('ESRCH'); });
    await terminateOwnedProcessGroup(2345);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('reports unexpected signal errors and rejects unsafe group identifiers', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw failure('EINVAL'); });
    for (const pid of [0, 1, -1, NaN, 2.5]) { await expect(terminateOwnedProcessGroup(pid)).rejects.toThrow('Invalid'); }
    expect(kill).not.toHaveBeenCalled();
    await expect(terminateOwnedProcessGroup(2345)).rejects.toThrow('EINVAL');
  });
});
