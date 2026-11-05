import { execFileSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { TestableClaudeProvider } from '../../helpers/providerFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings } from '../../../src/types';
import type { PanelSessionState } from '../../../src/providers/base/BaseCliProvider';

function running(pid: number): boolean {
  try { return !execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim().startsWith('Z'); }
  catch { return false; }
}

/** Actual local wrapper/native descendants; no installed agent or account is used. */
function fixture(persistent: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-stop-descendants-'));
  const trigger = path.join(dir, 'allow-write');
  const canary = path.join(dir, 'queued-write.txt');
  const oldFolders = vscode.workspace.workspaceFolders;
  Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: [{ uri: { fsPath: dir } }] });
  const provider = new TestableClaudeProvider();
  Object.defineProperty(provider, 'capabilities', { value: { ...provider.capabilities, supportsPersistentProcess: persistent } });
  // Single-shot is the shared Base route, exercised independently of Claude's
  // real requirement to use its native approval transport.
  if (!persistent) vi.spyOn(provider as any, 'requiresPersistentTransport').mockReturnValue(false);
  const native = `const fs = require('node:fs');
    process.stdout.write(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'READY:'+process.pid}}})+'\\n');
    setInterval(() => { if (fs.existsSync(${JSON.stringify(trigger)})) fs.writeFileSync(${JSON.stringify(canary)}, 'unapproved descendant write'); }, 10);`;
  const wrapper = `require('node:child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(native)}], {stdio:'inherit'});`;
  vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
  vi.spyOn(provider, 'buildCliArgs').mockReturnValue(['-e', wrapper]);
  vi.spyOn(provider, 'buildPersistentCliArgs').mockReturnValue(['-e', wrapper]);
  vi.spyOn(provider as any, 'buildPromptAsync').mockResolvedValue('controlled fixture');
  const processes: ChildProcess[] = [];
  const children: number[] = [];
  const start = async () => {
    const stream = provider.sendMessage('controlled fixture', [], {} as Settings, null, undefined, 'panel');
    const first = await stream.next();
    expect(first.value).toMatchObject({ type: 'text', content: expect.stringMatching(/^READY:\d+$/) });
    const pid = Number(first.value!.content!.slice('READY:'.length));
    children.push(pid);
    const session: PanelSessionState = (provider as any)._getSession('panel');
    const proc = session.process!;
    processes.push(proc);
    return { stream, pid, proc };
  };
  return { provider, start, trigger, canary,
    async cleanup() {
      for (const pid of children) { try { process.kill(pid, 'SIGKILL'); } catch { /* Owned fixture exited. */ } }
      for (const proc of processes) { try { proc.kill('SIGKILL'); } catch { /* Owned fixture exited. */ } }
      provider.dispose();
      await vi.waitFor(() => expect(children.some(running)).toBe(false), { timeout: 3000 });
      fs.rmSync(dir, { recursive: true, force: true });
      Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: oldFolders });
    },
  };
}

describe.skipIf(process.platform === 'win32')('Base CLI Stop owns wrapper descendants', () => {
  afterEach(() => { vi.restoreAllMocks(); clearMockConfig(); });

  it.each([false, true])('Stop prevents the queued descendant write and preserves a replacement (persistent=%s)', async persistent => {
    const h = fixture(persistent);
    try {
      const first = await h.start();
      h.provider.cancelCurrentRequest('panel');
      fs.writeFileSync(h.trigger, 'The cancelled child may now attempt its queued write.');
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(fs.existsSync(h.canary), 'A native child must not perform a queued write after Stop').toBe(false);
      await vi.waitFor(() => expect(running(first.pid)).toBe(false), { timeout: 1000 });
      fs.unlinkSync(h.trigger);
      const next = await h.start();
      await first.stream.return(undefined);
      expect(running(next.pid), 'Late cleanup of the old process must preserve its replacement').toBe(true);
      h.provider.cancelCurrentRequest('panel');
      await next.stream.return(undefined);
      await vi.waitFor(() => expect(running(next.pid)).toBe(false), { timeout: 1000 });
    } finally { await h.cleanup(); }
  }, 10_000);

  it.each([false, true])('an exited wrapper cannot leave a writing child beyond Stop (persistent=%s)', async persistent => {
    const h = fixture(persistent);
    try {
      const first = await h.start();
      const exited = new Promise<void>(resolve => first.proc.once('exit', () => resolve()));
      // Only terminate this fixture's launcher. Its inherited-pipe child has
      // no automatic parent-death signal and keeps running on the old code.
      first.proc.kill('SIGTERM'); await exited;
      h.provider.cancelCurrentRequest('panel');
      fs.writeFileSync(h.trigger, 'Attempt a queued write after the tracked wrapper exited.');
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(fs.existsSync(h.canary), 'Reaped wrapper liveness must not hide its owned live descendants').toBe(false);
      await vi.waitFor(() => expect(running(first.pid)).toBe(false), { timeout: 1000 });
      await first.stream.return(undefined);
    } finally { await h.cleanup(); }
  }, 10_000);
});
