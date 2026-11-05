// Actual public manager/provider calls with finite, disposable Node children.
// No installed OpenClaw, gateway connection, account/config read or network.
import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ProviderManager } from '../../../src/managers/ProviderManager';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';

vi.mock('../../../src/utils/platform', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/utils/platform')>(),
  readOpenClawToken: () => undefined,
  getEnrichedEnv: () => ({ PATH: process.env.PATH || '' }),
}));

const settings: Settings = { provider: 'openclaw', model: '', mode: 'edit-automatically',
  accessLevel: 'full-access', thinkingLevel: 'medium', contextMode: 'manual' };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

function childSource(directory: string): string {
  return `
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(1);
const value=flag=>args[args.indexOf(flag)+1],file=value('--message-file');
const prompt=fs.readFileSync(file,'utf8'),receipt=path.join(${JSON.stringify(directory)},process.pid+'.jsonl');
const record=event=>fs.appendFileSync(receipt,JSON.stringify({event,at:Date.now(),pid:process.pid,prompt,args})+'\\n');
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
let poll,deadline,stopping=false;
const finish=()=>{clearInterval(poll);clearTimeout(deadline);process.exit(0)};
process.on('SIGTERM',()=>{record('SIGTERM');if(!stopping){stopping=true;clearInterval(poll);setTimeout(finish,100)}});
record('ready');
if(prompt==='OLD_A')emit({type:'tool_call',status:'started',id:'shared-id',name:'old_tool',input:{owner:'A'}});
else {
 if(prompt==='REPLACEMENT_B')emit({type:'tool_call',status:'completed',id:'shared-id',name:'new_tool',input:{owner:'B'},output:'B tool output'});
 emit({type:'text',content:prompt==='DEFERRED_A'?'Obsolete A ran':'B ready'});
}
if(prompt==='DEFERRED_A'){record('complete');process.exitCode=0}
else {
 poll=setInterval(()=>{if(fs.existsSync(path.join(${JSON.stringify(directory)},prompt+'.release'))){
  record('complete');emit({type:'text',content:'B completed'});finish();
 }},5);
 deadline=setTimeout(()=>{record('fixture-deadline');process.exit(93)},4000);
}
`;
}

type Captured = { child: ChildProcess; closed: Promise<void>; exit?: unknown; close?: unknown;
  exitAt?: number; closeAt?: number; stderr: string; cleanupSignals: string[] };
async function fixture(run: (f: {
  provider: TestableOpenClawProvider; manager: ProviderManager; panelId: string;
  gateway: any; prompt: ReturnType<typeof vi.spyOn>; children: Captured[];
  session: () => any; tracked: () => ChildProcess | undefined;
  start: (content: string, override?: Settings) => AsyncGenerator<StreamChunk>;
  next: (stream: AsyncGenerator<StreamChunk>) => Promise<IteratorResult<StreamChunk>>;
  collect: (stream: AsyncGenerator<StreamChunk>) => Promise<StreamChunk[]>;
  release: (prompt: string) => void; cleanupBarrier: (release: () => void) => void;
  events: (child: Captured) => any[];
}) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-openclaw-ownership-'));
  const panelId = path.basename(directory), previousFolders = vscode.workspace.workspaceFolders;
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(directory), name: 'owned', index: 0 }];
  clearMockConfig(); setMockConfig('openclawUseGateway', false);
  const provider = new TestableOpenClawProvider();
  const gateway = (provider as any)._gateway;
  vi.spyOn(gateway, 'isConnected').mockReturnValue(false);
  vi.spyOn(gateway, 'connect').mockResolvedValue(false);
  vi.spyOn(gateway, 'cancelAgent').mockResolvedValue(undefined);
  vi.spyOn(gateway, 'sendAgentMessage').mockImplementation(async function* () {
    yield { type: 'text', content: 'Unexpected stale gateway dispatch' };
  });
  const realArgs = provider.buildCliArgs.bind(provider);
  vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
  vi.spyOn(provider, 'buildCliArgs').mockImplementation((s, session) => ['-e', childSource(directory), '--', ...realArgs(s, session)]);
  const prompt = vi.spyOn(provider as any, 'buildPromptAsync').mockImplementation(async (...args: unknown[]) => String(args[0]));
  const manager = Object.assign(Object.create(ProviderManager.prototype), {
    _activePanelProcesses: new Map(), _panelProviders: new Map(), _nativeApprovalTurns: new Map(),
    _registry: { get: (id: string) => id === 'openclaw' ? provider : undefined },
  }) as ProviderManager;
  const children: Captured[] = [], streams: AsyncGenerator<StreamChunk>[] = [];
  const pending: Array<{ promise: Promise<unknown>; settled: boolean }> = [];
  const barriers: Array<() => void> = [];
  const originalRegister = manager.registerProcess.bind(manager);
  vi.spyOn(manager, 'registerProcess').mockImplementation((panel, child, id) => {
    const captured: Captured = { child, closed: Promise.resolve(), stderr: '', cleanupSignals: [] };
    captured.closed = new Promise<void>(resolve => child.once('close', (code, signal) => {
      captured.close = { code, signal }; captured.closeAt = Date.now(); resolve();
    }));
    child.once('exit', (code, signal) => { captured.exit = { code, signal }; captured.exitAt = Date.now(); });
    child.stderr?.on('data', data => { captured.stderr += data.toString(); });
    children.push(captured); originalRegister(panel, child, id);
  });
  const track = <T>(promise: Promise<T>) => {
    const operation = { promise, settled: false }; pending.push(operation);
    void promise.then(() => { operation.settled = true; }, () => { operation.settled = true; });
    return promise;
  };
  const release = (content: string) => fs.writeFileSync(path.join(directory, content + '.release'), 'release');
  const start = (content: string, override = settings) => {
    const stream = manager.sendMessage(content, [], override, null, undefined, panelId);
    streams.push(stream); return stream;
  };
  try {
    await run({ provider, manager, panelId, gateway, prompt, children,
      session: () => (provider as any)._getSession(panelId),
      tracked: () => (manager as any)._activePanelProcesses.get(panelId), start,
      next: stream => bounded(track(stream.next()), 'owned public next'),
      collect: stream => bounded(track((async () => {
        const chunks: StreamChunk[] = []; for await (const chunk of stream) { chunks.push(chunk); } return chunks;
      })()), 'owned public completion'),
      release, cleanupBarrier: callback => barriers.push(callback),
      events: child => fs.readFileSync(path.join(directory, child.child.pid + '.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)),
    });
  } finally {
    // Track underlying operations, not their timeout wrappers: a timed-out next
    // can still register a child. Release all owned barriers, then return every
    // generator before treating the captured-child inventory as complete.
    for (const unblock of barriers) { unblock(); }
    for (const content of ['OLD_A', 'LIVE_B', 'REPLACEMENT_B']) { release(content); }
    for (const stream of streams) { track(stream.return(undefined as never)); }
    let drained = false, closed = false, cleanupError: unknown;
    try {
      await bounded(Promise.allSettled(pending.map(operation => operation.promise)), 'underlying owned operations settle');
      drained = pending.every(operation => operation.settled);
    } catch (error) { cleanupError = error; }
    try {
      // After a successful drain, no generator can register a later process.
      // If it did not drain, reap the currently captured handles and retain the
      // fixture as incomplete; do not claim a complete child inventory.
      for (const captured of children) {
        const child = captured.child;
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          captured.cleanupSignals.push('finally-owned-SIGKILL'); child.kill('SIGKILL');
        }
      }
      await Promise.all(children.map(child => bounded(child.closed, 'owned fixture close')));
      closed = children.every(child => child.close !== undefined);
    } catch (error) { cleanupError ??= error; }
    finally {
      provider.dispose();
      const evidence = {
        directory, pendingOperations: pending.length, unsettledOperations: pending.filter(operation => !operation.settled).length,
        generatorsDrained: drained, capturedChildrenClosed: closed, childInventoryComplete: drained,
        cleanupComplete: drained && closed, fixtureRetained: !drained || !closed,
        cleanupError: cleanupError instanceof Error ? cleanupError.message : cleanupError ? String(cleanupError) : null,
        children: children.map(captured => {
          const receipt = path.join(directory, captured.child.pid + '.jsonl');
          return { pid: captured.child.pid, argv: captured.child.spawnargs,
            exit: captured.exit, exitAt: captured.exitAt, close: captured.close, closeAt: captured.closeAt,
            stderr: captured.stderr, cleanupSignals: captured.cleanupSignals,
            rawEvents: fs.existsSync(receipt) ? fs.readFileSync(receipt, 'utf8') : null };
        }), installedOpenClawInvocations: 0,
      };
      const evidenceFile = process.env.PB07_OPENCLAW_OWNERSHIP_RECEIPT;
      try {
        if (evidenceFile) { fs.appendFileSync(evidenceFile, JSON.stringify(evidence) + '\n'); }
        if (drained && closed) { fs.rmSync(directory, { recursive: true, force: true }); }
        else { fs.writeFileSync(path.join(directory, 'incomplete-cleanup.json'), JSON.stringify(evidence, null, 2) + '\n'); }
      } finally {
        vi.restoreAllMocks(); clearMockConfig();
        (vscode.workspace as any).workspaceFolders = previousFolders;
      }
    }
    if (cleanupError) { throw cleanupError; }
  }
}

describe('OpenClaw request ownership through ProviderManager', () => {
  it.each(['resolve', 'reject'] as const)('retires deferred A after Stop (%s) without disturbing live B', async outcome => fixture(async f => {
    const entered = deferred<void>(), preparation = deferred<string>();
    f.cleanupBarrier(() => preparation.resolve('DEFERRED_A'));
    f.session().sessionId = 'owned-continuing-session'; f.session().channelSystemContext = 'owned channel context';
    f.prompt.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === 'DEFERRED_A') { entered.resolve(); return preparation.promise; } return String(args[0]);
    });
    const a = f.collect(f.start('DEFERRED_A')).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await bounded(entered.promise, 'A entered prompt preparation');
    expect(f.children).toHaveLength(0); f.manager.cancelRequest(f.panelId);
    const b = f.start('LIVE_B'); expect((await f.next(b)).value).toMatchObject({ type: 'text', content: 'B ready' });
    const ownedB = f.children[0]; expect(f.tracked()).toBe(ownedB.child);
    // Permission refusal must not retire the unrestricted turn already in flight.
    const restricted = await f.collect(f.start('restricted', { ...settings, mode: 'quick-plan', accessLevel: 'read-only' }));
    expect(restricted.map(chunk => chunk.type)).toEqual(['error', 'done']); expect(f.tracked()).toBe(ownedB.child);
    if (outcome === 'resolve') { preparation.resolve('DEFERRED_A'); } else { preparation.reject(new Error('Owned obsolete preparation failed')); }
    expect(await bounded(a, 'retired A settles')).toEqual({ value: [], error: undefined });
    expect(f.children).toHaveLength(1); expect(f.tracked()).toBe(ownedB.child); expect(f.session().process).toBe(ownedB.child);
    expect(ownedB.child.exitCode).toBeNull(); expect(ownedB.child.signalCode).toBeNull();
    const args = f.events(ownedB)[0].args;
    expect(args[args.indexOf('--session-id') + 1]).toBe('owned-continuing-session');
    expect(f.prompt.mock.calls.find(call => call[0] === 'LIVE_B')?.[7]).toBe('owned channel context');
    f.release('LIVE_B'); const result = await f.collect(b); await bounded(ownedB.closed, 'B normal close');
    expect(result.map(chunk => chunk.type)).toEqual(['text', 'done']); expect(result[0].content).toBe('B completed');
    expect(ownedB.close).toEqual({ code: 0, signal: null }); expect(f.events(ownedB).map(event => event.event)).toEqual(['ready', 'complete']);
  }), 15000);

  it.each(['panel', 'provider'] as const)('prevents a deferred request from spawning after %s disposal', async kind => fixture(async f => {
    const entered = deferred<void>(), preparation = deferred<string>(); f.cleanupBarrier(() => preparation.resolve('DEFERRED_A'));
    f.prompt.mockImplementation(async () => { entered.resolve(); return preparation.promise; });
    const result = f.collect(f.start('DEFERRED_A')); await bounded(entered.promise, 'disposal preparation entered');
    if (kind === 'panel') { f.provider.disposeSession(f.panelId); } else { f.provider.dispose(); }
    preparation.resolve('DEFERRED_A'); expect(await result).toEqual([]); expect(f.children).toHaveLength(0);
  }), 10000);

  it('keeps a replacement process and parser state when the older spawned generator returns', async () => fixture(async f => {
    const a = f.start('OLD_A'); expect((await f.next(a)).value).toMatchObject({ type: 'tool_use', toolCall: { name: 'old_tool' } });
    const old = f.children[0];
    const b = f.start('REPLACEMENT_B'), firstB = (await f.next(b)).value;
    const replacement = f.children[1];
    await bounded(a.return(undefined as never), 'older spawned generator return');
    expect(f.tracked()).toBe(replacement.child); expect(f.session().process).toBe(replacement.child);
    expect(replacement.child.exitCode).toBeNull(); expect(replacement.child.signalCode).toBeNull();
    expect(firstB).toMatchObject({ type: 'tool_result', toolCall: { id: 'shared-id', name: 'new_tool', input: { owner: 'B' }, output: 'B tool output' } });
    f.release('REPLACEMENT_B'); const result = await f.collect(b);
    await bounded(Promise.all([old.closed, replacement.closed]), 'both owned processes close');
    expect(result.filter(chunk => chunk.type === 'text').map(chunk => chunk.content)).toEqual(['B ready', 'B completed']);
    expect(result.filter(chunk => chunk.type === 'done')).toHaveLength(1);
    expect(result.some(chunk => chunk.type === 'error')).toBe(false); expect(replacement.close).toEqual({ code: 0, signal: null });
    // Windows forcibly terminates the tree; it cannot run a Node SIGTERM
    // handler. Both paths must close the old child before fixture cleanup.
    expect(old.close).toEqual({ code: process.platform === 'win32' ? 1 : 0, signal: null });
    expect(f.events(old).map(event => event.event)).toEqual(
      process.platform === 'win32' ? ['ready'] : ['ready', 'SIGTERM']);
    expect(f.events(replacement).map(event => event.event)).toEqual(['ready', 'complete']);
  }), 15000);

  it.each([true, false])('does not dispatch after Stop while Gateway reconnect resolves %s', async connected => fixture(async f => {
    setMockConfig('openclawUseGateway', true);
    const entered = deferred<void>(), connection = deferred<boolean>(); f.cleanupBarrier(() => connection.resolve(connected));
    f.gateway.connect.mockImplementation(() => { entered.resolve(); return connection.promise; });
    const result = f.collect(f.start('DEFERRED_A')); await bounded(entered.promise, 'reconnect entered');
    f.manager.cancelRequest(f.panelId); connection.resolve(connected);
    expect(await result).toEqual([]); expect(f.children).toHaveLength(0);
    expect(f.gateway.sendAgentMessage).not.toHaveBeenCalled(); expect(f.prompt).not.toHaveBeenCalled();
  }), 10000);
});


it.each(['cli', 'gateway'])('does not dispatch %s work stopped while reading diagnostic profiles', async transport => {
  await fixture(async f => {
    if (transport === 'gateway') vi.mocked(f.gateway.isConnected).mockReturnValue(true);
    const pending = deferred<(text: string) => string>();
    const capture = vi.spyOn(f.provider as any, '_captureRequestDiagnostics').mockReturnValue(pending.promise);
    f.cleanupBarrier(() => pending.resolve(text => text));
    const running = f.collect(f.start('DEFERRED_A'));
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
    f.provider.cancelCurrentRequest(f.panelId); pending.resolve(text => text);
    expect(await running).toEqual([]); expect(f.children).toHaveLength(0); expect(f.gateway.sendAgentMessage).not.toHaveBeenCalled();
  });
});

it.each(['cli', 'gateway'])('does not dispatch %s work disposed while reading diagnostic profiles', async transport => {
  await fixture(async f => {
    if (transport === 'gateway') vi.mocked(f.gateway.isConnected).mockReturnValue(true);
    const pending = deferred<(text: string) => string>();
    const capture = vi.spyOn(f.provider as any, '_captureRequestDiagnostics').mockReturnValue(pending.promise);
    f.cleanupBarrier(() => pending.resolve(text => text));
    const running = f.collect(f.start('DEFERRED_A'));
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
    f.provider.dispose(); pending.resolve(text => text);
    expect(await running).toEqual([]); expect(f.children).toHaveLength(0); expect(f.gateway.sendAgentMessage).not.toHaveBeenCalled();
  });
});
