import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import * as vscode from 'vscode';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: mocks.spawn }));
vi.mock('../../../src/utils/platform', async original => ({
  ...await original<typeof import('../../../src/utils/platform')>(),
  readOpenClawToken: () => undefined,
  getEnrichedEnv: () => ({ PATH: process.env.PATH || '' }),
}));
const original = 'Keep my original draft';
const enhanced = 'Clarified draft: أهلاً 🌟';
const envelope = (text = enhanced) => ({ ok: true, capability: 'model.run', transport: 'local', outputs: [{ text }] });
let directory: string, previousFolders: typeof vscode.workspace.workspaceFolders;
let provider: TestableOpenClawProvider, gateway: any;
let scenario: { strict?: boolean; split?: boolean; hang?: boolean; stubborn?: boolean; code?: number; raw?: string };
const children: Array<{ proc: ChildProcess; closed: Promise<void>; close?: unknown; args: string[]; cwd?: string }> = [];
const operations: Promise<unknown>[] = [];
const moreProviders: TestableOpenClawProvider[] = [];
async function bounded<T>(promise: Promise<T>, ms = 9000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Owned enhancement deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}
function run(prompt = original) { const pending = provider.enhancePrompt(prompt); operations.push(pending); return bounded(pending); }
const childSource = `
const fs=require('fs'),path=require('path'),file=process.argv[1],args=process.argv.slice(2),cfg=JSON.parse(fs.readFileSync(file,'utf8'));
const prompt=args[args.indexOf('--prompt')+1],receipt={pid:process.pid,cwd:process.cwd(),args};
const save=()=>fs.writeFileSync(file+'.receipt',JSON.stringify(receipt));
if(cfg.strict&&(args.slice(0,3).join(' ')!=='infer model run'||!args.includes('--local')||!args.includes('--json')||args[args.indexOf('--thinking')+1]!=='off'||!prompt?.includes('Keep my original draft')||process.cwd()!==cfg.cwd)){
 save();process.stderr.write('Owned fixture rejected an invalid text-only invocation');process.exitCode=7;
}else if(cfg.hang){process.on('SIGTERM',()=>{receipt.terminated=true;save();if(!cfg.stubborn)process.exit(0)});save();setTimeout(()=>process.exit(93),8000);
}else{
 save();
 const raw=cfg.raw??JSON.stringify(${JSON.stringify(envelope())},null,2),bytes=Buffer.from(raw);
 process.exitCode=cfg.code??0;
 if(cfg.split){let i=0;const timer=setInterval(()=>{if(i>=bytes.length){clearInterval(timer);return}process.stdout.write(bytes.subarray(i,i+1));i++},1)}else process.stdout.write(bytes);
}
`;
beforeEach(async () => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-enhance-')));
  previousFolders = vscode.workspace.workspaceFolders;
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(directory), name: 'owned', index: 0 }];
  clearMockConfig(); setMockConfig('openclawUseGateway', false);
  provider = new TestableOpenClawProvider(); gateway = (provider as any)._gateway;
  vi.spyOn(gateway, 'isConnected').mockReturnValue(false);
  vi.spyOn(gateway, 'sendAgentMessage').mockImplementation(async function* () { yield { type: 'text', content: 'Gateway enhancement' }; });
  vi.spyOn(gateway, 'cancelAgent').mockResolvedValue(undefined);
  vi.spyOn(provider, 'getCliPath').mockReturnValue('/owned/openclaw');
  scenario = {};
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  mocks.spawn.mockReset().mockImplementation((_command: string, args: string[], options: SpawnOptions) => {
    const file = path.join(directory, `child-${children.length}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...scenario, cwd: directory }));
    const proc = actual.spawn(process.execPath, ['-e', childSource, '--', file, ...args], { ...options, env: { PATH: process.env.PATH } });
    const row = { proc, args, cwd: options.cwd as string, closed: Promise.resolve(), close: undefined as unknown };
    row.closed = new Promise(resolve => proc.once('close', (code, signal) => { row.close = { code, signal }; resolve(); }));
    children.push(row); return proc;
  });
});
afterEach(async () => {
  provider.dispose(); moreProviders.splice(0).forEach(p => p.dispose());
  // Finally owns only the exact test children; all normal tests must settle
  // without this fallback. Keep close evidence even for the red baseline.
  for (const row of children) if (row.proc.exitCode === null && row.proc.signalCode === null) row.proc.kill('SIGKILL');
  await bounded(Promise.all(children.map(row => row.closed)));
  await bounded(Promise.allSettled(operations.splice(0)));
  const receipt = process.env.PB07_OPENCLAW_ENHANCEMENT_RECEIPT;
  if (receipt) fs.appendFileSync(receipt, JSON.stringify({ children: children.map(({ proc, close, args, cwd }) => ({ pid: proc.pid, close, args, cwd })),
    allChildrenClosed: children.every(row => row.close !== undefined), nativeCliInvocations: 0, paidRequests: 0 }) + '\n');
  children.splice(0); vi.restoreAllMocks(); clearMockConfig();
  (vscode.workspace as any).workspaceFolders = previousFolders;
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('OpenClaw text-only enhancement', () => {
  it('honors disabled gateway despite an existing connection and invokes local inference from the workspace', async () => {
    vi.mocked(gateway.isConnected).mockReturnValue(true); scenario.strict = true;
    expect(await run()).toBe(enhanced); expect(gateway.sendAgentMessage).not.toHaveBeenCalled();
    expect(children).toHaveLength(1); expect(children[0].cwd).toBe(directory);
    expect(children[0].args).not.toContain('agent');
  });
  it('uses the native local text-only command with an unavailable gateway', async () => {
    setMockConfig('openclawUseGateway', true); scenario.strict = true;
    expect(await run()).toBe(enhanced); expect(children).toHaveLength(1);
  });
  it.each([false, true])('decodes the full native envelope and UTF-8 (fragmented=%s)', async split => {
    scenario.split = split; expect(await run()).toBe(enhanced);
  });
  it('collects only text output from a successful inference envelope', async () => {
    scenario.raw = JSON.stringify({ ...envelope(), outputs: [{ text: 'First' }, { mediaUrl: 'owned://image' }, { text: 'Second' }] });
    expect(await run()).toBe('First\nSecond');
  });
  it.each([
    'plain error text', '{"outputs":', JSON.stringify({ ...envelope(), ok: false }),
    JSON.stringify({ ...envelope(), outputs: [{ text: {} }] }), JSON.stringify({ ...envelope(), outputs: [] }),
    JSON.stringify({ payloads: [{ text: 'Agent response must not count as text-only inference' }] }),
    JSON.stringify({ content: 'An unrelated JSON response' }),
  ])('preserves the draft on invalid or unsuccessful output: %s', async raw => {
    scenario.raw = raw; expect(await run()).toBe(original); expect(children).toHaveLength(1);
  });
  it('preserves the draft on nonzero exit without retrying a tool-enabled command', async () => {
    scenario.code = 7; scenario.raw = JSON.stringify(envelope()); expect(await run()).toBe(original); expect(children).toHaveLength(1);
  });
  it('preserves the draft on synchronous spawn failure', async () => {
    mocks.spawn.mockImplementationOnce(() => { throw new Error('Owned sync failure'); }); expect(await run()).toBe(original);
  });
  it('preserves the draft on missing executable then recovers', async () => {
    const actual = await vi.importActual<typeof import('child_process')>('child_process');
    mocks.spawn.mockImplementationOnce(() => {
      const proc = actual.spawn(path.join(directory, 'missing'));
      const row = { proc, args: [], closed: Promise.resolve(), close: undefined as unknown };
      row.closed = new Promise(resolve => proc.once('close', (code, signal) => { row.close = { code, signal }; resolve(); }));
      children.push(row); return proc;
    });
    expect(await run()).toBe(original); expect(await run()).toBe(enhanced);
  });
  it('does not dispatch empty input or start enhancement after disposal', async () => {
    expect(await run('  ')).toBe('  '); provider.dispose(); expect(await run()).toBe(original); expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it('rejects output larger than the enhancement limit', async () => {
    scenario.raw = JSON.stringify(envelope('X'.repeat(1024 * 1024 + 1))); expect(await run()).toBe(original);
  });
  it.each(['dispose', 'deadline'])('stops and reaps its local child on %s', async reason => {
    scenario.hang = true;
    let expire: (() => void) | undefined;
    if (reason === 'deadline') {
      const realTimeout = global.setTimeout;
      vi.spyOn(global, 'setTimeout').mockImplementation(((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
        if (ms === 120000) { expire = () => callback(...args); }
        return realTimeout(callback, ms, ...args);
      }) as typeof setTimeout);
    }
    const pending = run();
    while (!fs.existsSync(path.join(directory, 'child-0.json.receipt'))) await new Promise(resolve => setTimeout(resolve, 5));
    if (reason === 'dispose') provider.dispose();
    else expire!(); // Expire only after the owned child installed its signal handler.
    expect(await bounded(pending, 2000)).toBe(original);
    await bounded(children[0].closed, 1000);
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'child-0.json.receipt'), 'utf8')).terminated).toBe(true);
  });
  it('escalates when an enhancement child ignores termination', async () => {
    scenario.hang = true; scenario.stubborn = true;
    const pending = run();
    while (!fs.existsSync(path.join(directory, 'child-0.json.receipt'))) await new Promise(resolve => setTimeout(resolve, 5));
    provider.dispose(); expect(await bounded(pending, 7500)).toBe(original);
    await bounded(children[0].closed, 1000);
    expect(children[0].close).toEqual({ code: null, signal: 'SIGKILL' });
  }, 12000);
  it('keeps concurrent local enhancements independent', async () => {
    scenario.split = true;
    const first = run();
    await bounded((async () => { while (!children.length) await new Promise(resolve => setTimeout(resolve, 5)); })());
    expect(children[0].proc.exitCode).toBeNull();
    const results = await Promise.all([first, run()]); expect(results).toEqual([enhanced, enhanced]);
    expect(children).toHaveLength(2); expect(children[0].proc.pid).not.toBe(children[1].proc.pid);
  });
  it('falls back to process cwd when no workspace folder is available', async () => {
    (vscode.workspace as any).workspaceFolders = [];
    expect(await run()).toBe(enhanced); expect(children[0].cwd).toBe(process.cwd());
  });
  it('uses a separate tool-free gateway session for every enhancement', async () => {
    setMockConfig('openclawUseGateway', true); vi.mocked(gateway.isConnected).mockReturnValue(true);
    expect(await run()).toBe('Gateway enhancement'); expect(await run()).toBe('Gateway enhancement');
    const options = vi.mocked(gateway.sendAgentMessage).mock.calls.map((call: any[]) => call[1]);
    expect(options[0]).toMatchObject({ thinking: 'off', textOnly: true });
    expect(options[0].sessionKey).not.toBe(options[1].sessionKey); expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it.each(['error', 'auth_error', 'tool_use', 'tool_result', 'throw'])('preserves the draft after gateway %s without replaying partial work locally', async type => {
    setMockConfig('openclawUseGateway', true); vi.mocked(gateway.isConnected).mockReturnValue(true);
    vi.mocked(gateway.sendAgentMessage).mockImplementation(async function* () {
      yield { type: 'text', content: 'Partial result' };
      if (type === 'throw') throw new Error('Owned gateway failure');
      yield { type, content: 'Owned failure' };
    });
    expect(await run()).toBe(original); expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

it.each(['success', 'error', 'deadline', 'dispose'])('sends text-only gateway controls and handles %s on the real owned wire', async outcome => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const frames: any[] = [], sockets: Array<{ closed: boolean; close: Promise<void> }> = [];
  let serverClosed = false;
  server.on('connection', socket => {
    const row = { closed: false, close: Promise.resolve() };
    row.close = new Promise(resolve => socket.once('close', () => { row.closed = true; resolve(); })); sockets.push(row);
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString()); frames.push(frame);
      if (frame.method === 'agent' && outcome !== 'success') {
        socket.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { status: 'accepted', runId: 'owned-enhance-run' } }));
        socket.send(JSON.stringify({ type: 'event', event: 'agent', payload: { runId: 'owned-enhance-run', sessionKey: frame.params.sessionKey,
          stream: 'assistant', data: { delta: 'Partial enhancement' } } }));
        if (outcome === 'error') socket.send(JSON.stringify({ type: 'res', id: frame.id, ok: false, error: { message: 'Owned terminal failure' } }));
      } else socket.send(JSON.stringify({ type: 'res', id: frame.id, ok: true,
        payload: frame.method === 'connect' ? { type: 'hello-ok', protocol: 4 } : { text: enhanced } }));
    });
    socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'owned-enhancement' } }));
  });
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setMockConfig('openclawGatewayUrl', url); setMockConfig('openclawUseGateway', true);
  const p = new TestableOpenClawProvider(); moreProviders.push(p);
  try {
    expect((p as any)._gateway._url).toBe(url); await bounded(p.initialize());
    const cancel = vi.spyOn((p as any)._gateway, 'cancelAgent');
    if (outcome === 'deadline') {
      const realTimeout = global.setTimeout;
      vi.spyOn(global, 'setTimeout').mockImplementation(((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => realTimeout(callback, ms === 120000 ? 150 : ms, ...args)) as typeof setTimeout);
    }
    const pending = p.enhancePrompt(original); operations.push(pending);
    await bounded((async () => { while (!frames.some(frame => frame.method === 'agent')) await new Promise(resolve => setTimeout(resolve, 5)); })());
    if (outcome === 'dispose') p.dispose();
    expect(await bounded(pending, 2000)).toBe(outcome === 'success' ? enhanced : original);
    if (outcome === 'success') for await (const _chunk of (p as any)._gateway.sendAgentMessage('Owned normal chat', { sessionKey: 'owned-normal-chat' })) { /* drain */ }
    const requests = frames.filter(frame => frame.method === 'agent'); expect(requests).toHaveLength(outcome === 'success' ? 2 : 1);
    expect(requests[0].params).toMatchObject({ modelRun: true, promptMode: 'none', cleanupBundleMcpOnRunEnd: true });
    if (outcome === 'success') {
      expect(requests[1].params).not.toHaveProperty('modelRun'); expect(requests[1].params).not.toHaveProperty('promptMode');
    }
    if (outcome === 'dispose' || outcome === 'deadline') {
      expect(cancel).toHaveBeenCalledWith(requests[0].params.sessionKey);
      await bounded((async () => { while (!frames.some(frame => frame.method === 'chat.abort')) await new Promise(resolve => setTimeout(resolve, 5)); })(), 1000);
      expect(frames.find(frame => frame.method === 'chat.abort').params.sessionKey).toBe(requests[0].params.sessionKey);
    }
    expect(mocks.spawn).not.toHaveBeenCalled();
  } finally {
    p.dispose(); for (const socket of server.clients) socket.terminate();
    await bounded(new Promise<void>((resolve, reject) => server.close(error => { serverClosed = true; error ? reject(error) : resolve(); })));
    await bounded(Promise.all(sockets.map(row => row.close)));
    const receipt = process.env.PB07_OPENCLAW_ENHANCEMENT_WIRE_RECEIPT;
    if (receipt) fs.appendFileSync(receipt, JSON.stringify({ outcome, frames, serverClosed, allSocketsClosed: sockets.every(row => row.closed), nativeGatewayRequests: 0 }) + '\n');
  }
});
