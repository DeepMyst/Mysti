/** Real POSIX process trees: Stop must not leave delayed descendant effects. */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { killProcessTree } from '../../src/utils/processKill';

const posix = process.platform !== 'win32';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) { await fs.rm(dir, { recursive: true, force: true }); } });

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(file: string) {
  for (const deadline = Date.now() + 5000; !(await fs.stat(file).catch(() => undefined))?.size;) {
    if (Date.now() > deadline) { throw new Error(`${file} never appeared`); }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return Number((await fs.readFile(file, 'utf8')).trim());
}
async function tempDir() { const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mysti-tree-'))); dirs.push(dir); return dir; }

describe.skipIf(!posix)('killProcessTree descendants', () => {
  it('kills a detached group, its background job and an ordinary grandchild', { timeout: 10000 }, async () => {
    const dir = await tempDir();
    const agent = `const { spawn } = require('node:child_process');
      spawn('/bin/sh', ['-c', 'echo $$ > leader.pid; (sleep 1; printf late > group-job.txt) & sleep 1; printf late > group-leader.txt; wait'], { detached: true, stdio: 'ignore' }).unref();
      spawn('/bin/sh', ['-c', 'echo $$ > plain.pid; sleep 1; printf late > plain.txt'], { stdio: 'ignore' });
      setInterval(() => {}, 1000);`;
    const child: ChildProcess = spawn(process.execPath, ['-e', agent], { cwd: dir, stdio: 'ignore' });
    const leader = await waitFor(path.join(dir, 'leader.pid'));
    const plain = await waitFor(path.join(dir, 'plain.pid'));
    await killProcessTree(child, 2000, { label: 'tree fixture' });
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect([alive(leader), alive(plain), child.exitCode !== null || child.signalCode !== null]).toEqual([false, false, true]);
    expect((await fs.readdir(dir)).filter(name => name.endsWith('.txt'))).toEqual([]);
  });

  it('never signals a pid that is not a real child of this process', { timeout: 10000 }, async () => {
    const dir = await tempDir();
    // An orphan: its launcher exits, so it is nobody's child we own.
    const launcher = spawn('/bin/sh', ['-c', `sh -c 'echo $$ > orphan.pid; sleep 3' >/dev/null 2>&1 &`], { cwd: dir, stdio: 'ignore' });
    await new Promise(resolve => launcher.once('close', resolve));
    const orphan = await waitFor(path.join(dir, 'orphan.pid'));
    const fake = Object.assign(new EventEmitter(), { pid: orphan, exitCode: null, signalCode: null, kill: () => true });
    const done = killProcessTree(fake as unknown as ChildProcess, 50);
    await done;
    expect(alive(orphan)).toBe(true);
    process.kill(orphan, 'SIGKILL');
  });
});
