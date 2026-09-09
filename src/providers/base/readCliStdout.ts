/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import type { ChildProcess } from 'child_process';
import { PROCESS_KILL_GRACE_PERIOD_MS } from '../../constants';
import { killProcessTree } from '../../utils/processKill';

export class CliStreamInactivityError extends Error {}

/** One captured child owns the pending read, cancellation, and inactivity clock. */
export async function* readCliStdout(proc: ChildProcess | null, options: {
  signal?: AbortSignal;
  isCurrent(): boolean;
  stderr: { output: string };
  inactivityMs: number;
  label: string;
}): AsyncGenerator<Buffer | string> {
  if (!proc?.stdout || !options.isCurrent()) { return; }
  const iterator = proc.stdout[Symbol.asyncIterator]();
  let onAbort = () => {};
  const aborted = new Promise<'aborted'>(resolve => { onAbort = () => resolve('aborted'); });
  let onError: (error: Error) => void = () => {};
  const failed = new Promise<never>((_resolve, reject) => { onError = reject; });
  options.signal?.addEventListener('abort', onAbort, { once: true });
  proc.on('error', onError);
  let lastStderrLen = options.stderr.output.length;
  try {
    let pendingRead = iterator.next();
    while (options.isCurrent()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), options.inactivityMs);
      });
      let result: Awaited<ReturnType<typeof iterator.next>> | 'aborted' | 'timeout';
      try {
        result = await Promise.race([pendingRead, aborted, failed, timeout]);
      } finally {
        clearTimeout(timer);
      }
      if (!options.isCurrent() || result === 'aborted') { return; }
      if (result === 'timeout') {
        if (options.stderr.output.length > lastStderrLen) {
          lastStderrLen = options.stderr.output.length;
          continue;
        }
        void killProcessTree(proc, PROCESS_KILL_GRACE_PERIOD_MS, { label: `${options.label} inactivity-timeout` });
        throw new CliStreamInactivityError(`${options.label} produced no output for ${Math.round(options.inactivityMs / 60000)} minutes — the request timed out and the process was terminated.`);
      }
      if (result.done) { return; }
      yield result.value;
      if (!options.isCurrent()) { return; }
      pendingRead = iterator.next();
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    proc.removeListener('error', onError);
    try { void Promise.resolve(iterator.return?.(undefined)).catch(() => {}); } catch { /* best-effort */ }
  }
}
