/** Mysti — SPDX-License-Identifier: Apache-2.0 */

/**
 * Terminate a group whose leader was spawned detached by this runtime, then
 * establish absence. ESRCH is the only successful absence result. On macOS a
 * zombie-only group can return EPERM until its parent reaps the leader.
 */
export async function terminateOwnedProcessGroup(pid: number, timeoutMs = 5000): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1) { throw new Error('Invalid owned process group'); }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) { throw new Error('Invalid group cleanup deadline'); }
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  try { process.kill(-pid, 'SIGKILL'); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') { return; }
    if (code !== 'EPERM') { throw error; }
    lastError = error;
  }
  // Issuing SIGKILL is not confirmation of exit. Keep storage and ownership
  // until the group disappears; an inaccessible live group must fail cleanup.
  for (;;) {
    try { process.kill(-pid, 0); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') { return; }
      if (code !== 'EPERM') { throw error; }
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Owned process group ${pid} did not exit before cleanup deadline`, { cause: lastError });
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
