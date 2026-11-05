// Public transport regression against a source-derived owned Node CLI fixture.
// No installed OpenClaw invocation, native account/config read or network.
import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
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
const nativeConflict = 'Use either --message or --message-file, not both.';
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

// OpenClaw 2026.6.34 resolveAgentMessageOpts performs this exclusive-input
// check BEFORE readAgentMessageFile and local dispatch. There is deliberately
// no polling, delayed read or retry: the file must exist at child startup.
function fixtureSource(directory: string): string {
  return `
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(1),value=flag=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1]};
const message=value('--message'),rawFile=value('--message-file'),file=rawFile?.trim();
const receipt={pid:process.pid,args,stdin:fs.readFileSync(0,'utf8')};
const save=()=>fs.writeFileSync(path.join(${JSON.stringify(directory)},process.pid+'.json'),JSON.stringify(receipt));
try {
  if(message!==undefined&&file)throw new Error(${JSON.stringify(nativeConflict)});
  if(rawFile!==undefined&&!file)throw new Error('--message-file must not be empty.');
  if(!file)throw new Error('Owned fixture requires the native file-input route');
  const stat=fs.lstatSync(file),parent=fs.lstatSync(path.dirname(file));
  const prompt=new TextDecoder('utf-8',{fatal:true}).decode(fs.readFileSync(file)).replace(/^\\uFEFF/,'');
  Object.assign(receipt,{file,prompt,fileMode:stat.mode&511,directoryMode:parent.mode&511,fileSymlink:stat.isSymbolicLink(),directorySymlink:parent.isSymbolicLink()});
  if(!prompt.trim())throw new Error('Message file is empty: '+file);
  if(prompt==='OWNED_NONZERO')throw new Error('Owned local child failed after reading its prompt');
  save();process.stdout.write(JSON.stringify({payloads:[{text:'Owned reply'}],meta:{agentMeta:{sessionId:'owned-native-session',usage:{input:3,output:2},contextTokens:8192}}},null,2));
}catch(error){receipt.error=error.message;save();process.stderr.write(error.message+'\\n');process.exitCode=message!==undefined&&file?1:7}
`;
}

type Receipt = { child: ChildProcess; argv: string[]; exit?: unknown; close?: unknown;
  closed: Promise<void>; stderr: string; signals: string[]; chunks: StreamChunk[] };
async function withFixture(run: (fixture: {
  provider: () => TestableOpenClawProvider;
  start: (provider: TestableOpenClawProvider, prompt: string) => AsyncGenerator<StreamChunk>;
  collect: (stream: AsyncGenerator<StreamChunk>) => Promise<StreamChunk[]>;
  latest: () => Receipt;
  actual: (receipt: Receipt) => any;
  directory: string;
  panelId: string;
}) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-openclaw-delivery-test-'));
  const panelId = path.basename(directory);
  // The baseline disposer uses this legacy name; never collide with another owner.
  if (fs.existsSync(path.join(os.tmpdir(), `mysti-openclaw-${panelId}.txt`))) { throw new Error('Unexpected existing legacy prompt path'); }
  const previousFolders = vscode.workspace.workspaceFolders;
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(directory), name: 'owned', index: 0 }];
  clearMockConfig(); setMockConfig('openclawUseGateway', false);
  const providers: TestableOpenClawProvider[] = [], children: Receipt[] = [];
  const streams: AsyncGenerator<StreamChunk>[] = [];
  const tracker = {
    registerProcess: (_panel: string, child: ChildProcess) => {
      const receipt: Receipt = { child, argv: [...child.spawnargs], stderr: '', signals: [], chunks: [], closed: Promise.resolve() };
      receipt.closed = new Promise<void>(resolve => child.once('close', (code, signal) => {
        receipt.close = { code, signal }; resolve();
      }));
      child.once('exit', (code, signal) => { receipt.exit = { code, signal }; });
      child.stderr?.on('data', data => { receipt.stderr += data.toString(); });
      children.push(receipt);
    }, clearProcess: () => {},
  };
  const provider = () => {
    const instance = new TestableOpenClawProvider(); providers.push(instance);
    const realArgs = instance.buildCliArgs.bind(instance);
    vi.spyOn(instance, 'getCliPath').mockReturnValue(process.execPath);
    vi.spyOn(instance, 'buildCliArgs').mockImplementation((s, session) => ['-e', fixtureSource(directory), '--', ...realArgs(s, session)]);
    vi.spyOn(instance as any, 'buildPromptAsync').mockImplementation(async (...args: unknown[]) => String(args[0]));
    return instance;
  };
  const start = (instance: TestableOpenClawProvider, prompt: string) => {
    const stream = instance.sendMessage(prompt, [], settings, null, undefined, panelId, tracker);
    streams.push(stream); return stream;
  };
  const collect = async (stream: AsyncGenerator<StreamChunk>) => {
    const chunks: StreamChunk[] = [];
    await bounded((async () => { for await (const chunk of stream) { chunks.push(chunk); } })(), 'public owned-child request');
    const receipt = children.at(-1)!; receipt.chunks = chunks;
    await bounded(receipt.closed, 'owned child close');
    return chunks;
  };
  const actual = (receipt: Receipt) => JSON.parse(fs.readFileSync(path.join(directory, receipt.child.pid + '.json'), 'utf8'));
  try { await run({ provider, start, collect, latest: () => children.at(-1)!, actual, directory, panelId }); }
  finally {
    // Capture close before exposing each handle. Reap only these exact children
    // before returning suspended generators or deleting the owned fixture.
    let cleanupComplete = false;
    try {
      for (const receipt of children) {
        if (receipt.child.pid && receipt.child.exitCode === null && receipt.child.signalCode === null) {
          receipt.signals.push('finally-owned-SIGKILL'); receipt.child.kill('SIGKILL');
        }
      }
      const closures = await Promise.allSettled(children.map(receipt => bounded(receipt.closed, 'finally owned child close')));
      const missedClose = closures.find(result => result.status === 'rejected');
      if (missedClose?.status === 'rejected') { throw missedClose.reason; }
      for (const stream of streams) { await bounded(stream.return(undefined as never), 'finally owned generator return'); }
      cleanupComplete = true;
    } finally {
      for (const instance of providers) { instance.dispose(); }
      const allChildrenClosed = children.every(receipt => receipt.close !== undefined);
      const evidence = {
        cleanupComplete, allChildrenClosed, fixtureRetained: !cleanupComplete || !allChildrenClosed,
        directory,
        children: children.map(receipt => ({ pid: receipt.child.pid, argv: receipt.argv,
          exit: receipt.exit, close: receipt.close, stderr: receipt.stderr, signals: receipt.signals,
          chunks: receipt.chunks, actual: receipt.child.pid && fs.existsSync(path.join(directory, receipt.child.pid+'.json')) ? actual(receipt) : null })),
        installedOpenClawInvocations: 0,
      };
      const evidenceFile = process.env.PB07_OPENCLAW_DELIVERY_RECEIPT;
      if (evidenceFile) { fs.appendFileSync(evidenceFile, JSON.stringify(evidence) + '\n'); }
      vi.restoreAllMocks(); clearMockConfig();
      (vscode.workspace as any).workspaceFolders = previousFolders;
      if (cleanupComplete && allChildrenClosed) { fs.rmSync(directory, { recursive: true, force: true }); }
      else { fs.writeFileSync(path.join(directory, 'incomplete-cleanup.json'), JSON.stringify(evidence, null, 2) + '\n'); }
    }
  }
}
function assertSuccess(chunks: StreamChunk[], receipt: Receipt): void {
  expect(chunks.filter(c => c.type === 'error' || c.type === 'auth_error')).toEqual([]);
  expect(chunks.filter(c => c.type === 'text').map(c => c.content)).toEqual(['Owned reply']);
  expect(chunks.filter(c => c.type === 'done')).toHaveLength(1);
  expect(receipt.exit).toEqual({ code: 0, signal: null }); expect(receipt.close).toEqual(receipt.exit);
}
function assertRemoved(receipt: Receipt): void {
  const file = receipt.argv[receipt.argv.indexOf('--message-file') + 1];
  expect(typeof file).toBe('string'); expect(fs.existsSync(file)).toBe(false);
  expect(fs.existsSync(path.dirname(file))).toBe(false);
}

describe('OpenClaw actual public CLI prompt delivery', () => {
  it('uses one private file immediately, keeps native flags, and removes the request directory', async () => withFixture(async f => {
    const p = f.provider(), prompt = 'Explain this owned change.\nمرحبا 🌍';
    const chunks = await f.collect(f.start(p, prompt)), receipt = f.latest();
    assertSuccess(chunks, receipt);
    const actual = f.actual(receipt);
    expect(actual.prompt).toBe(prompt); expect(actual.stdin).toBe('');
    expect(actual.args).toEqual(['agent', '--json', '--session-key', `mysti-${f.panelId}`, '--thinking', 'medium', '--local', '--session-id', f.panelId, '--message-file', actual.file]);
    expect(actual.args).not.toContain(prompt); expect(actual.args).not.toContain('--message');
    expect(actual.fileSymlink).toBe(false); expect(actual.directorySymlink).toBe(false);
    if (process.platform !== 'win32') { expect(actual.fileMode).toBe(0o600); expect(actual.directoryMode).toBe(0o700); }
    assertRemoved(receipt);
  }), 15000);

  it('delivers a long multiline Unicode prompt without placing it in argv', async () => withFixture(async f => {
    const prompt = 'Owned long prompt\n' + 'مرحبا 🌍\n'.repeat(5000);
    const chunks = await f.collect(f.start(f.provider(), prompt)), receipt = f.latest();
    assertSuccess(chunks, receipt); expect(f.actual(receipt).prompt).toBe(prompt);
    expect(receipt.argv).not.toContain(prompt); assertRemoved(receipt);
  }), 15000);

  it('cleans a native nonzero failure then succeeds with a fresh same-panel request', async () => withFixture(async f => {
    const p = f.provider(), failed = await f.collect(f.start(p, 'OWNED_NONZERO')), first = f.latest();
    expect(first.exit).toEqual({ code: 7, signal: null }); expect(first.close).toEqual(first.exit);
    expect(failed.filter(c => c.type === 'error').map(c => c.content)).toEqual(['OpenClaw exited with code 7.\nOwned local child failed after reading its prompt\n']);
    expect(failed.filter(c => c.type === 'done')).toHaveLength(1); assertRemoved(first);
    const chunks = await f.collect(f.start(p, 'Fresh owned prompt')), next = f.latest();
    assertSuccess(chunks, next); assertRemoved(next);
    expect(f.actual(first).file).not.toBe(f.actual(next).file);
    const again = await f.collect(f.start(p, 'Preserve native session'));
    assertSuccess(again, f.latest());
    const args = f.actual(f.latest()).args;
    expect(args[args.indexOf('--session-id') + 1]).toBe('owned-native-session'); assertRemoved(f.latest());
  }), 20000);

  it('cleans a spawn failure and permits a fresh same-panel request', async () => withFixture(async f => {
    const p = f.provider(); vi.mocked(p.getCliPath).mockReturnValue(path.join(f.directory, 'does-not-exist'));
    const failed = await f.collect(f.start(p, 'Owned spawn failure')), receipt = f.latest();
    expect(receipt.child.pid).toBeUndefined(); expect(receipt.close).toBeDefined();
    expect(failed.some(c => c.type === 'error' && c.content?.includes('ENOENT'))).toBe(true);
    expect(failed.filter(c => c.type === 'done')).toHaveLength(1); assertRemoved(receipt);
    vi.mocked(p.getCliPath).mockReturnValue(process.execPath);
    const chunks = await f.collect(f.start(p, 'Fresh after failed spawn'));
    assertSuccess(chunks, f.latest()); assertRemoved(f.latest());
  }), 15000);

  it('keeps identical panel IDs in different providers isolated when an older turn finishes', async () => withFixture(async f => {
    const first = f.start(f.provider(), 'First provider prompt');
    expect((await bounded(first.next(), 'first public yield')).value?.type).toBe('text');
    const a = f.latest(); await bounded(a.closed, 'first child close');
    const second = f.start(f.provider(), 'Second provider prompt');
    expect((await bounded(second.next(), 'second public yield')).value?.type).toBe('text');
    const b = f.latest(); await bounded(b.closed, 'second child close');
    const af = f.actual(a).file, bf = f.actual(b).file;
    expect(af).not.toBe(bf); expect(fs.readFileSync(af, 'utf8')).toBe('First provider prompt');
    for await (const _ of first) { /* finish the older request */ }
    assertRemoved(a); expect(fs.readFileSync(bf, 'utf8')).toBe('Second provider prompt');
    for await (const _ of second) { /* finish this request */ }
    assertRemoved(b);
  }), 15000);

  it.each(['panel', 'provider'] as const)('removes its private file on %s disposal while the consumer is paused', async kind => withFixture(async f => {
    const p = f.provider(), stream = f.start(p, 'Paused public response');
    expect((await bounded(stream.next(), 'paused public yield')).value?.type).toBe('text');
    const receipt = f.latest(); await bounded(receipt.closed, 'paused child close');
    expect(fs.readFileSync(f.actual(receipt).file, 'utf8')).toBe('Paused public response');
    if (kind === 'panel') { p.disposeSession(f.panelId); } else { p.dispose(); }
    assertRemoved(receipt);
    await bounded(stream.return(undefined as never), 'paused public return');
  }), 15000);
});
