import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServer } from '../../../src/providers/codex/CodexAppServer';
import type { NativeApprovalHandler, NativeApprovalRequest } from '../../../src/providers/base/IProvider';
import type { Settings, StreamChunk } from '../../../src/types';

const fixture = path.resolve(__dirname, '../../fixtures/codex/appServer.mjs');
const children: ChildProcess[] = [];
const closed: Promise<void>[] = [];
const dirs: string[] = [];
const clients: CodexAppServer[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) { client.dispose(); }
  for (const child of children.splice(0)) { child.kill('SIGKILL'); }
  // Windows retains a child's working directory until its handles close.
  await Promise.all(closed.splice(0));
  for (const dir of dirs.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});
function setup(mode = 'command', handler?: NativeApprovalHandler, settings: Pick<Settings, 'mode' | 'accessLevel'> = { mode: 'default', accessLevel: 'ask-permission' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-codex-protocol-')); dirs.push(dir);
  const marker = path.join(dir, 'effect');
  const child = spawn(process.execPath, [fixture, mode, marker], { stdio: ['pipe', 'pipe', 'pipe'], cwd: dir }); children.push(child);
  closed.push(new Promise(resolve => child.once('close', () => resolve())));
  const controller = new AbortController();
  let current = true;
  const client = new CodexAppServer({ process: child, panelId: 'panel', signal: controller.signal, handler, settings, isCurrent: () => current, terminate: () => { child.kill('SIGKILL'); } }); clients.push(client);
  const start = async () => { await client.initialize(); await client.startThread({}); await client.startTurn({ input: [] }); };
  const drain = async () => { const chunks: StreamChunk[] = []; for await (const chunk of client.stream()) { chunks.push(chunk); } return chunks; };
  return { marker, child, client, controller, start, drain, replace: () => { current = false; controller.abort(); } };
}
async function eventually(predicate: () => boolean) { await vi.waitFor(() => expect(predicate()).toBe(true)); }

describe('Codex app-server native authority with inert effect process', () => {
  it.each(['command', 'file'])('holds the actual %s effect until its exact request is accepted once', async mode => {
    let allow!: (value: boolean) => void;
    let request: NativeApprovalRequest | undefined;
    const run = setup(mode, value => { request = value; return new Promise(resolve => { allow = resolve; }); });
    await run.start(); await eventually(() => !!request);
    expect(fs.existsSync(run.marker)).toBe(false);
    expect(request?.nativeRequestId).toBe('native-1');
    expect(request?.defaultDecision).toBe('ask');
    allow(true);
    const chunks = await run.drain();
    expect(fs.readFileSync(run.marker, 'utf8')).toBe('effect\n');
    expect(JSON.parse(fs.readFileSync(`${run.marker}.decision`, 'utf8'))).toEqual({ decision: 'accept' });
    expect(chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.content).join('')).toBe('finished');
    expect(run.client.usage).toMatchObject({ input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 });
  });
  it('keeps the native file snapshot independent of stream consumers and freezes host approval input', async () => {
    let request: NativeApprovalRequest | undefined;
    const run = setup('file-delayed', value => { request = value; return false; });
    await run.start();
    const stream = run.client.stream();
    await stream.next();
    const display = (await stream.next()).value as StreamChunk;
    const changes = display.toolCall?.input.changes as Array<{ diff: string }>;
    changes[0].diff = 'tampered display';
    await eventually(() => !!request);
    expect((request?.toolCall.input.changes as Array<{ diff: string }>)[0].diff).toBe('-before\n+after');
    expect(Object.isFrozen(request?.toolCall.input)).toBe(true);
    expect(Object.isFrozen((request?.toolCall.input.changes as unknown[])[0])).toBe(true);
    for await (const chunk of stream) { expect(chunk.type).not.toBe('error'); }
    expect(fs.existsSync(run.marker)).toBe(false);
  });
  it.each(['command', 'file'])('keeps denied %s effects absent', async mode => {
    const run = setup(mode, async () => false); await run.start(); await run.drain();
    expect(fs.existsSync(run.marker)).toBe(false);
    expect(JSON.parse(fs.readFileSync(`${run.marker}.decision`, 'utf8'))).toEqual({ decision: 'decline' });
  });
  it.each(['command', 'file'])('hard denies %s in read-only even when the host would allow', async mode => {
    const handler = vi.fn(async () => true);
    const run = setup(mode, handler, { mode: 'default', accessLevel: 'read-only' }); await run.start(); await run.drain();
    expect(handler).not.toHaveBeenCalled(); expect(fs.existsSync(run.marker)).toBe(false);
  });
  it.each(['wrong-thread', 'mismatch', 'file-root', 'stdin'])('rejects unsupported or mismatched authority (%s) without showing a card', async mode => {
    const handler = vi.fn(async () => true);
    const run = setup(mode, handler); await run.start(); await run.drain();
    expect(handler).not.toHaveBeenCalled(); expect(fs.existsSync(run.marker)).toBe(false);
  });
  it.each(['cancel', 'replacement'])('retires the pending card and ignores late allow after %s', async mode => {
    let allow!: (value: boolean) => void;
    let request: NativeApprovalRequest | undefined;
    const run = setup('command', value => { request = value; return new Promise(resolve => { allow = resolve; }); });
    await run.start(); await eventually(() => !!request);
    if (mode === 'cancel') { run.controller.abort(); } else { run.replace(); }
    expect(request?.signal.aborted).toBe(true); allow(true); await run.drain();
    expect(fs.existsSync(run.marker)).toBe(false);
  });
  it('revokes on process exit before close and fails a throwing input transport closed', async () => {
    for (const failure of ['exit', 'input']) {
      let request: NativeApprovalRequest | undefined; let allow!: (value: boolean) => void;
      const run = setup('command', value => { request = value; return new Promise(resolve => { allow = resolve; }); });
      await run.start(); await eventually(() => !!request);
      if (failure === 'exit') { run.child.emit('exit', 23, null); }
      else { vi.spyOn(run.child.stdin!, 'write').mockImplementation(() => { throw new Error('closed pipe'); }); allow(true); }
      await run.drain(); expect(request?.signal.aborted).toBe(true); expect(fs.existsSync(run.marker)).toBe(false);
    }
  });
  it('revokes a pending approval on replay before any effect', async () => {
    let request: NativeApprovalRequest | undefined;
    const run = setup('replay', value => { request = value; return new Promise(() => {}); });
    await run.start(); const chunks = await run.drain();
    expect(chunks.some(chunk => chunk.type === 'error' && chunk.content?.includes('Replayed'))).toBe(true);
    expect(request?.signal.aborted).toBe(true); expect(fs.existsSync(run.marker)).toBe(false);
  });
  it.each(['resolved', 'crash'])('retires native pending authority on %s and ignores a late allow', async mode => {
    let allow!: (value: boolean) => void;
    let request: NativeApprovalRequest | undefined;
    const run = setup(mode, value => { request = value; return new Promise(resolve => { allow = resolve; }); });
    await run.start(); await run.drain();
    expect(request?.signal.aborted).toBe(true); allow(true);
    expect(fs.existsSync(run.marker)).toBe(false);
  });
  it('terminates unsupported native request routes', async () => {
    const run = setup('unknown', async () => true); await run.start(); const chunks = await run.drain();
    expect(chunks.some(chunk => chunk.type === 'error')).toBe(true); expect(fs.existsSync(run.marker)).toBe(false);
  });
  it('streams a fail-closed error when an unsupported native request precedes turn/start acknowledgement', async () => {
    const handler = vi.fn(async () => true);
    const run = setup('unknown-early', handler);
    await expect(run.start()).resolves.toBeUndefined();
    const chunks = await run.drain();
    expect(chunks.filter(chunk => chunk.type === 'error')).toEqual([{
      type: 'error', content: 'Codex app-server protocol failed: Unsupported Codex native request: item/permissions/requestApproval',
    }]);
    expect(handler).not.toHaveBeenCalled(); expect(fs.existsSync(run.marker)).toBe(false);
  });
  it.each(['version', 'policy'])('fails before turn submission on incompatible %s', async mode => {
    const run = setup(mode); await expect(run.start()).rejects.toThrow(); expect(fs.existsSync(run.marker)).toBe(false);
  });
  it('auto-edit allows patches but still asks for deletion', async () => {
    const decisions: string[] = [];
    const handler: NativeApprovalHandler = async request => { decisions.push(request.defaultDecision); return true; };
    for (const mode of ['file', 'file-delete']) {
      const run = setup(mode, handler, { mode: 'edit-automatically', accessLevel: 'ask-permission' }); await run.start(); await run.drain();
    }
    expect(decisions).toEqual(['allow', 'ask']);
  });
});
