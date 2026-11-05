import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderManager } from '../../src/managers/ProviderManager';
import { PROCESS_KILL_GRACE_PERIOD_MS } from '../../src/constants';
import type { Settings } from '../../src/types';
import { TestableClineProvider } from '../helpers/providerFactory';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 3000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() >= end) { throw new Error('Owned fixture deadline'); } await pause(15); }
}
function state(pid: number): string {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

// Real public Cline sendMessage and real ProviderManager cancellation. Only the
// executable/prompt are replaced with disposable Node fixtures; no native CLI.
async function fixture(mode: 'cooperative' | 'hung') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-manager-stop-'));
  const file = (name: string) => path.join(directory, name);
  const provider = new TestableClineProvider();
  const manager = new ProviderManager({ subscriptions: [], extensionPath: '/mock/extension', extensionUri: vscode.Uri.file('/mock/extension'),
    globalState: { get: () => undefined, update: async () => undefined }, workspaceState: { get: () => undefined, update: async () => undefined },
  } as unknown as vscode.ExtensionContext);
  const internal = manager as unknown as {
    _registry: unknown; _activePanelProcesses: Map<string, ChildProcess>; _panelProviders: Map<string, string>;
  };
  internal._registry = { get: () => provider, getAll: () => [provider], dispose: () => provider.dispose() };
  const originalFolders = vscode.workspace.workspaceFolders;
  Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: [{ uri: vscode.Uri.file(directory), index: 0, name: 'owned stop fixture' }] });
  const script = file('native-like.cjs');
  fs.writeFileSync(script, `
const fs=require('node:fs'),path=require('node:path');const [directory,name,mode]=process.argv.slice(2);
const file=s=>path.join(directory,name+'-'+s);let stopped=false;
process.stdout.on('error',()=>{});
process.on('SIGCONT',()=>fs.appendFileSync(file('continued'),'CONT\\n'));
process.on('SIGTERM',()=>{
 fs.appendFileSync(file('term'),fs.existsSync(file('abort-ack'))?'TERM after acknowledgment\\n':'TERM before acknowledgment\\n');
 if(mode==='hung'||stopped)return;stopped=true;
 setTimeout(()=>{fs.writeFileSync(file('abort-ack'),JSON.stringify({finishReason:'aborted',pid:process.pid}));process.stdout.write(JSON.stringify({type:'run_result',finishReason:'aborted'})+'\\n');setTimeout(()=>process.exit(0),25);},150);
});
setInterval(()=>{if(fs.existsSync(file('trigger')))fs.writeFileSync(file('canary'),'still running');},15);
fs.writeFileSync(file('ready'),String(process.pid));
process.stdout.write(JSON.stringify({type:'agent_event',event:{type:'content_start',contentType:'text',text:'Owned fixture running'}})+'\\n');
`);
  vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
  vi.spyOn(provider, 'buildCliArgs').mockReturnValue([script, directory, 'main', mode]);
  vi.spyOn(provider as any, 'buildPromptAsync').mockResolvedValue('Synthetic cancellation fixture');
  const settings: Settings = { provider: 'cline', model: '', mode: 'quick-plan', accessLevel: 'read-only', thinkingLevel: 'none', contextMode: 'manual' };
  let textSeen = false;
  const completion = (async () => { for await (const chunk of provider.sendMessage('fixture', [], settings, null, undefined, 'panel', manager)) {
    if (chunk.type === 'text') { textSeen = true; }
  } })();
  await until(() => textSeen && fs.existsSync(file('main-ready')));
  const proc = internal._activePanelProcesses.get('panel')!; expect(proc.pid).toBe(Number(fs.readFileSync(file('main-ready'), 'utf8')));
  const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => proc.once('close', (code, signal) => resolve({ code, signal })));
  const extras: ChildProcess[] = [];
  async function extra(name: string): Promise<ChildProcess> {
    const child = spawn(process.execPath, [script, directory, name, 'cooperative'], { detached: true, stdio: 'ignore' }); extras.push(child);
    await until(() => fs.existsSync(file(name + '-ready'))); return child;
  }
  return { manager, provider, internal, file, proc, close, completion, extra,
    async cleanup() {
      manager.dispose();
      for (const child of [proc, ...extras]) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); }
      await completion.catch(() => {});
      await until(() => [proc, ...extras].every(child => child.exitCode !== null || child.signalCode !== null));
      Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, value: originalFolders });
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe.skipIf(process.platform === 'win32')('ProviderManager ordinary Stop grace with real owned processes', () => {
  afterEach(() => vi.restoreAllMocks());

  it('allows cooperative abort acknowledgment before exit through public manager Stop', async () => {
    const h = await fixture('cooperative');
    try {
      h.manager.cancelRequest('panel'); const closed = await h.close; await h.completion;
      expect(fs.existsSync(h.file('main-abort-ack'))).toBe(true);
      expect(JSON.parse(fs.readFileSync(h.file('main-abort-ack'), 'utf8'))).toEqual({ finishReason: 'aborted', pid: h.proc.pid });
      expect(closed).toEqual({ code: 0, signal: null });
      const signals = fs.readFileSync(h.file('main-term'), 'utf8').trim().split('\n');
      expect(signals.filter(signal => signal === 'TERM before acknowledgment')).toHaveLength(1);
      expect(signals.every(signal => ['TERM before acknowledgment', 'TERM after acknowledgment'].includes(signal))).toBe(true);
    } finally { await h.cleanup(); }
  }, 10000);

  it('retains the existing grace then forcibly closes an uncooperative native-like process', async () => {
    const h = await fixture('hung');
    try {
      const start = Date.now(); h.manager.cancelRequest('panel');
      await until(() => fs.existsSync(h.file('main-term')));
      await pause(100); expect(h.proc.exitCode).toBe(null); expect(h.proc.signalCode).toBe(null);
      const closed = await h.close;
      expect(Date.now() - start).toBeGreaterThanOrEqual(PROCESS_KILL_GRACE_PERIOD_MS - 100);
      expect(closed).toEqual({ code: null, signal: 'SIGKILL' });
      expect(fs.existsSync(h.file('main-abort-ack'))).toBe(false);
    } finally { await h.cleanup(); }
  }, 12000);

  it('kills a suspended denied process without resuming it or executing pending work', async () => {
    const h = await fixture('cooperative');
    try {
      expect(h.manager.suspendRequest('panel')).toBe(true); await until(() => state(h.proc.pid!).includes('T'));
      fs.writeFileSync(h.file('main-trigger'), 'must remain unexecuted');
      const start = Date.now(); h.manager.cancelRequest('panel');
      expect(await h.close).toEqual({ code: null, signal: 'SIGKILL' });
      expect(Date.now() - start).toBeLessThan(PROCESS_KILL_GRACE_PERIOD_MS);
      for (const suffix of ['continued', 'canary', 'abort-ack']) expect(fs.existsSync(h.file('main-' + suffix))).toBe(false);
    } finally { await h.cleanup(); }
  }, 10000);

  it.each(['provider cancellation', 'approval abort'] as const)('does not kill or clear a replacement registered by %s or another panel', async replacementPoint => {
    const h = await fixture('cooperative');
    try {
      const replacement = await h.extra('replacement'), other = await h.extra('other');
      h.manager.registerProcess('other-panel', other, 'cline');
      const clearProcessPid = vi.fn(); h.manager.setLifecycleSink({ registerProcessPid: vi.fn(), clearProcessPid });
      const cancel = h.provider.cancelCurrentRequest.bind(h.provider);
      const cancelSpy = vi.spyOn(h.provider, 'cancelCurrentRequest').mockImplementation(panel => { cancel(panel); if (replacementPoint === 'provider cancellation' && panel === 'panel') h.manager.registerProcess('panel', replacement, 'cline'); });
      if (replacementPoint === 'approval abort') {
        const approval = new AbortController(); approval.signal.addEventListener('abort', () => h.manager.registerProcess('panel', replacement, 'cline'));
        (h.manager as unknown as { _nativeApprovalTurns: Map<string, AbortController> })._nativeApprovalTurns.set('panel', approval);
      }
      h.manager.cancelRequest('panel'); await h.close; await h.completion;
      await pause(PROCESS_KILL_GRACE_PERIOD_MS + 100);
      if (replacementPoint === 'approval abort') expect(cancelSpy).not.toHaveBeenCalled();
      expect(h.internal._activePanelProcesses.get('panel')).toBe(replacement);
      expect(h.internal._activePanelProcesses.get('other-panel')).toBe(other);
      expect(h.internal._panelProviders.get('panel')).toBe('cline');
      expect(clearProcessPid).not.toHaveBeenCalledWith('panel', replacement.pid);
      for (const name of ['replacement', 'other']) { fs.writeFileSync(h.file(name + '-trigger'), 'execute'); await until(() => fs.existsSync(h.file(name + '-canary'))); expect(fs.existsSync(h.file(name + '-term'))).toBe(false); }
    } finally { await h.cleanup(); }
  }, 12000);
});
