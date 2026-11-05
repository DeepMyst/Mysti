import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'child_process';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestableClineProvider } from '../../helpers/providerFactory';
import { clearConfigurationListeners, clearMockConfig } from '../../helpers/mockVscode';
import type { AgentConfiguration, Settings, StreamChunk } from '../../../src/types';
import type { AgentContextManager } from '../../../src/managers/AgentContextManager';
import type { PersonaConfig } from '../../../src/providers/base/IProvider';

// Only the process boundary is substituted. Public send/cancel/clear/dispose,
// prompt construction, stream parsing and actual owned filesystem I/O are real.
const native = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn() }));
vi.mock('child_process', async () => ({ ...await vi.importActual<typeof import('child_process')>('child_process'), spawn: native.spawn }));
vi.mock('../../../src/utils/processKill', async () => ({
  ...await vi.importActual<typeof import('../../../src/utils/processKill')>('../../../src/utils/processKill'),
  killProcessTree: native.kill,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const settings: Settings = { provider: 'cline', model: '', mode: 'default', accessLevel: 'full-access', thinkingLevel: 'none', contextMode: 'manual' };
const original = Buffer.from('User rules\r\nPreserve trailing spaces.  \n');
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  native.spawn.mockReset(); native.kill.mockReset();
  for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { vi.restoreAllMocks(); clearMockConfig(); clearConfigurationListeners(); }
});

function harness(initial: Buffer | null = original) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-pb04-rules-')));
  const rules = path.join(directory, '.clinerules');
  if (initial !== null) fs.writeFileSync(rules, initial);
  const previousFolders = vscode.workspace.workspaceFolders;
  Object.defineProperty(vscode.workspace, 'workspaceFolders', {
    value: [{ uri: vscode.Uri.file(directory), name: 'owned-pb04', index: 0 }], configurable: true,
  });
  const provider = new TestableClineProvider();
  const cli = path.join(directory, 'owned-fake-cline');
  vi.spyOn(provider, 'getCliPath').mockReturnValue(cli);
  const children: Array<{
    proc: ChildProcess; args: string[]; contextAtSpawn: string;
    finish: (code?: number, signal?: NodeJS.Signals | null) => void;
  }> = [];
  const turns: Array<{ done: Promise<StreamChunk[]>; active: Promise<void>; chunks: StreamChunk[] }> = [];
  native.spawn.mockImplementation((file: string, args: string[], options: SpawnOptions) => {
    expect(file).toBe(cli); expect(options.cwd).toBe(directory); expect(options.shell).toBe(false);
    const files = args.filter(arg => path.isAbsolute(arg) && path.relative(directory, arg).split(path.sep)[0] !== '..')
      .filter(arg => { try { return fs.statSync(arg).isFile(); } catch { return false; } });
    let ruleText = '';
    try { if (fs.statSync(rules).isFile()) ruleText = fs.readFileSync(rules, 'utf8'); } catch { /* absent native rules */ }
    const proc = Object.assign(new EventEmitter(), {
      pid: undefined, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, killed: false,
    });
    const child = { proc: proc as unknown as ChildProcess, args: [...args],
      contextAtSpawn: [...args, ruleText, ...files.map(file => fs.readFileSync(file, 'utf8'))].join('\n'),
      finish(code = 0, signal: NodeJS.Signals | null = null) {
        if (proc.exitCode !== null || proc.signalCode !== null) return;
        proc.exitCode = code; proc.signalCode = signal;
        if (!signal && code === 0) proc.stdout.write(JSON.stringify({ type: 'agent_event', event: { type: 'content_start', contentType: 'text', text: 'Owned fixture completed.' } }) + '\n');
        if (code !== 0) proc.stderr.write('Owned fake CLI failed.\n');
        proc.stdout.end(); proc.stderr.end(); proc.emit('exit', code, signal); proc.emit('close', code, signal);
      },
    };
    children.push(child); return proc;
  });
  native.kill.mockImplementation(async (proc: ChildProcess) => {
    const child = children.find(row => row.proc === proc);
    if (!child) throw new Error('Attempted to clean up a non-owned fake child');
    child.finish(0, 'SIGTERM');
  });
  const tracked = new Map<string, ChildProcess>();
  const tracker = {
    registerProcess(panel: string, proc: ChildProcess) { tracked.set(panel, proc); },
    clearProcess(panel: string, proc?: ChildProcess) { if (!proc || tracked.get(panel) === proc) tracked.delete(panel); },
  };
  const begin = (panel: string, instructions = `PB04_CONTEXT_${panel}`, options: { agentConfig?: AgentConfiguration; requestId?: string; persona?: PersonaConfig } = {}) => {
    provider.setChannelSystemContext(panel, instructions);
    const started = deferred<void>(); const chunks: StreamChunk[] = [];
    const done = (async () => {
      for await (const chunk of provider.sendMessage(`PB04_REQUEST_${options.requestId || panel}: Review the owned fixture.`, [], settings, null, options.persona, panel, tracker, options.agentConfig)) {
        chunks.push(chunk); if (chunk.type === 'session_active') started.resolve();
      }
      return chunks;
    })();
    // Retain failures immediately while still allowing the test to inspect them.
    void done.catch(() => {});
    const turn = { done, active: started.promise, chunks }; turns.push(turn); return turn;
  };
  const childFor = (panel: string) => children.find(child => child.args.some(arg => arg.includes(`PB04_REQUEST_${panel}:`)));
  const settle = async (panel: string, turn: ReturnType<typeof begin>, code = 0) => {
    await turn.active; const child = childFor(panel); expect(child).toBeDefined(); child!.finish(code); return turn.done;
  };
  cleanups.push(async () => {
    provider.dispose(); children.forEach(child => child.finish(0, 'SIGTERM'));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([Promise.allSettled(turns.map(turn => turn.done)).then(() => true), new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 1500); })]);
    clearTimeout(timeout);
    Object.defineProperty(vscode.workspace, 'workspaceFolders', { value: previousFolders, configurable: true });
    if (completed) fs.rmSync(directory, { recursive: true, force: true });
    expect(completed, `Every owned send must finish before workspace cleanup: ${directory}`).toBe(true);
  });
  return { directory, rules, provider, begin, childFor, children, settle, tracked };
}

describe('PB04 public Cline requests preserve workspace rules', () => {
  it('restores the original bytes after a permitted turn and delivers its system context', async () => {
    const h = harness(); const turn = h.begin('A'); await turn.active;
    expect(fs.readFileSync(h.rules)).toEqual(original);
    expect(h.childFor('A')!.args.join('\n').split('PB04_CONTEXT_A')).toHaveLength(2);
    await h.settle('A', turn); expect(fs.readFileSync(h.rules)).toEqual(original);
  });

  it('preserves binary bytes that cannot round-trip through a UTF-8 string backup', async () => {
    const bytes = Buffer.concat([original, Buffer.from([0xff, 0xfe, 0x00, 0x80])]);
    const h = harness(bytes); const turn = h.begin('A'); await h.settle('A', turn);
    expect(fs.readFileSync(h.rules)).toEqual(bytes);
  });

  it('leaves no rules file after a turn that started without one', async () => {
    const h = harness(null); const turn = h.begin('A'); await turn.active; expect(fs.existsSync(h.rules)).toBe(false); await h.settle('A', turn);
    expect(fs.existsSync(h.rules)).toBe(false);
  });

  it.each([true, false])('keeps user edits made during a turn (preexisting=%s)', async preexisting => {
    const h = harness(preexisting ? original : null); const turn = h.begin('A'); await turn.active;
    const edited = Buffer.from('User updated rules during the request.\r\n'); fs.writeFileSync(h.rules, edited);
    await h.settle('A', turn); expect(fs.readFileSync(h.rules)).toEqual(edited);
  });

  it('does not recreate a file that the user deleted during the request', async () => {
    const h = harness(); const turn = h.begin('A'); await turn.active; fs.unlinkSync(h.rules);
    await h.settle('A', turn); expect(fs.existsSync(h.rules)).toBe(false);
  });

  it('keeps an atomic user replacement of the rules file', async () => {
    const h = harness(); const turn = h.begin('A'); await turn.active;
    const replacement = path.join(h.directory, 'replacement'), edited = Buffer.from('Atomic user save\n');
    fs.writeFileSync(replacement, edited); fs.renameSync(replacement, h.rules);
    const replaced = fs.statSync(h.rules);
    await h.settle('A', turn); expect(fs.readFileSync(h.rules)).toEqual(edited); expect(fs.statSync(h.rules).ino).toBe(replaced.ino);
  });

  it('preserves a replacement inode even when its bytes match the rules at request start', async () => {
    const h = harness(); const turn = h.begin('A'); await turn.active;
    const replacement = path.join(h.directory, 'replacement'), edited = fs.readFileSync(h.rules);
    fs.writeFileSync(replacement, edited); fs.renameSync(replacement, h.rules); const replaced = fs.statSync(h.rules);
    await h.settle('A', turn); expect(fs.readFileSync(h.rules)).toEqual(edited); expect(fs.statSync(h.rules).ino).toBe(replaced.ino);
  });

  it('does not follow a replacement symlink or overwrite its target on cleanup', async () => {
    const h = harness(); const turn = h.begin('A'); await turn.active;
    const target = path.join(h.directory, 'user-target'); fs.writeFileSync(target, 'Do not overwrite target\n');
    fs.unlinkSync(h.rules); fs.symlinkSync(target, h.rules);
    await h.settle('A', turn); expect(fs.lstatSync(h.rules).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('Do not overwrite target\n');
  });

  it('leaves a user replacement directory and its content intact', async () => {
    const h = harness(); const turn = h.begin('A'); await turn.active; fs.unlinkSync(h.rules); fs.mkdirSync(h.rules);
    const child = path.join(h.rules, 'user.md'); fs.writeFileSync(child, 'User folder rules\n');
    await h.settle('A', turn); expect(fs.lstatSync(h.rules).isDirectory()).toBe(true); expect(fs.readFileSync(child, 'utf8')).toBe('User folder rules\n');
  });

  for (const preferredFirst of ['A', 'B']) {
    it(`isolates overlapping panel contexts and preserves the baseline (${preferredFirst} completes first when concurrently admitted)`, async () => {
      const h = harness(); const a = h.begin('A'); await a.active; const b = h.begin('B');
      // Serialized workspace admission is valid. Do not force two children to
      // share temporary rules; reverse completion applies only if both start.
      await tick(); await tick();
      if (preferredFirst === 'B' && h.childFor('B')) { await h.settle('B', b); await h.settle('A', a); }
      else { await h.settle('A', a); await h.settle('B', b); }
      expect(h.children).toHaveLength(2);
      for (const [panel, other] of [['A', 'B'], ['B', 'A']]) {
        expect(h.childFor(panel)!.contextAtSpawn).toContain(`PB04_CONTEXT_${panel}`);
        expect(h.childFor(panel)!.contextAtSpawn).not.toContain(`PB04_CONTEXT_${other}`);
        expect(h.childFor(panel)!.args.join('\n').split(`PB04_CONTEXT_${panel}`)).toHaveLength(2);
      }
      expect(fs.readFileSync(h.rules)).toEqual(original);
    });
  }

  it('preserves a user update while overlapping sends are active or queued', async () => {
    const h = harness(); const a = h.begin('A'); await a.active; const b = h.begin('B'); await tick(); await tick();
    const edited = Buffer.from('User update shared by both panels\n'); fs.writeFileSync(h.rules, edited);
    await h.settle('A', a); await h.settle('B', b); expect(fs.readFileSync(h.rules)).toEqual(edited);
  });

  it.each(['cancel', 'clear-one', 'clear-all', 'dispose'] as const)('preserves original rules when the public lifecycle calls %s', async action => {
    const h = harness(); const turn = h.begin('A'); await turn.active;
    if (action === 'cancel') h.provider.cancelCurrentRequest('A');
    else if (action === 'clear-one') h.provider.clearSession('A');
    else if (action === 'clear-all') h.provider.clearSession();
    else h.provider.dispose();
    await turn.done; expect(fs.readFileSync(h.rules)).toEqual(original);
  });

  it('preserves a user edit when the active request is cancelled', async () => {
    const h = harness(); const turn = h.begin('A'); await turn.active; fs.writeFileSync(h.rules, 'User edit before Stop\n');
    h.provider.cancelCurrentRequest('A'); await turn.done; expect(fs.readFileSync(h.rules, 'utf8')).toBe('User edit before Stop\n');
  });

  it('restores original rules after a CLI crash', async () => {
    const h = harness(); const turn = h.begin('A'); const chunks = await h.settle('A', turn, 7);
    expect(chunks.some(chunk => chunk.type === 'error')).toBe(true); expect(fs.readFileSync(h.rules)).toEqual(original);
  });

  it('restores original rules after synchronous spawn failure', async () => {
    const h = harness(); native.spawn.mockImplementationOnce(() => { throw new Error('Owned synthetic spawn failure'); });
    const chunks = await h.begin('A').done; expect(chunks.some(chunk => chunk.type === 'error' && chunk.content?.includes('synthetic spawn failure'))).toBe(true);
    expect(fs.readFileSync(h.rules)).toEqual(original); expect(h.children).toHaveLength(0);
  });

  it.each(['cancel', 'clear-one', 'clear-all', 'dispose'] as const)('does not start a late child after %s during asynchronous context preparation', async action => {
    const h = harness(); const entered = deferred<void>(); const release = deferred<void>();
    h.provider.setAgentContextManager({
      async buildPromptContext() {
        entered.resolve(); await release.promise;
        return { systemPrompt: 'Deferred persona context', untrustedBlock: '', warnings: [], estimatedTokens: 4 };
      },
    } as unknown as AgentContextManager);
    const turn = h.begin('A', 'PB04_CONTEXT_A', { agentConfig: { personaId: 'owned-deferred-persona', enabledSkills: [] } });
    await entered.promise;
    if (action === 'cancel') h.provider.cancelCurrentRequest('A');
    else if (action === 'clear-one') h.provider.clearSession('A');
    else if (action === 'clear-all') h.provider.clearSession();
    else h.provider.dispose();
    release.resolve(); await tick(); await tick();
    // A broken implementation is allowed to finish its owned fake child so the
    // assertion reports the unauthorized late spawn rather than timing out.
    h.children.forEach(child => child.finish()); await turn.done;
    expect(native.spawn).not.toHaveBeenCalled(); expect(fs.readFileSync(h.rules)).toEqual(original);
  });

  it('a late old same-panel completion cannot kill or unregister the replacement request', async () => {
    const h = harness(); const old = h.begin('A', 'PB04_CONTEXT_OLD', { requestId: 'old' }); await old.active;
    const oldChild = h.childFor('old')!;
    // Simulate a child that acknowledges cancellation late; all signaling is
    // restricted to in-memory fake handles and no OS signal is issued.
    native.kill.mockImplementation(async (proc: ChildProcess) => {
      if (proc !== oldChild.proc) h.children.find(child => child.proc === proc)!.finish(0, 'SIGTERM');
    });
    const replacement = h.begin('A', 'PB04_CONTEXT_NEW', { requestId: 'new' }); await replacement.active;
    const newChild = h.childFor('new')!;
    expect(newChild.contextAtSpawn).not.toContain('PB04_CONTEXT_OLD');
    oldChild.finish(); await old.done;
    expect(newChild.proc.exitCode).toBeNull(); expect(newChild.proc.signalCode).toBeNull();
    expect(h.tracked.get('A')).toBe(newChild.proc);
    expect(fs.readFileSync(h.rules)).toEqual(original);
    await h.settle('new', replacement); expect(h.tracked.has('A')).toBe(false);
  });

  it('delivers a custom persona and channel context once through the request without replacing native rules or system flags', async () => {
    const h = harness(); const turn = h.begin('A', 'PB04_CONTEXT_A', { persona: { type: 'custom', customPrompt: 'PB04_CUSTOM_PERSONA' } });
    await turn.active; const args = h.childFor('A')!.args; const prompt = args.at(-1)!;
    for (const marker of ['PB04_CUSTOM_PERSONA', 'PB04_CONTEXT_A', 'PB04_REQUEST_A']) expect(prompt.split(marker)).toHaveLength(2);
    expect(prompt.indexOf('PB04_CUSTOM_PERSONA')).toBeLessThan(prompt.indexOf('PB04_CONTEXT_A'));
    expect(args).toEqual(expect.arrayContaining(['--auto-approve', 'true'])); expect(args).not.toContain('--system');
    expect(fs.readFileSync(h.rules)).toEqual(original); await h.settle('A', turn);
  });

  it.each([true, false])('delivers agent context with persona precedence/fallback (agent instructions=%s)', async hasAgent => {
    const h = harness(); const build = vi.fn(async () => ({
      systemPrompt: hasAgent ? 'PB04_TRUSTED_AGENT\n' : '',
      untrustedBlock: hasAgent ? '[Untrusted reference] PB04_UNTRUSTED_AGENT [/Untrusted reference]' : '', warnings: [], estimatedTokens: 8,
    }));
    h.provider.setAgentContextManager({ buildPromptContext: build } as unknown as AgentContextManager);
    const turn = h.begin('A', 'PB04_CONTEXT_A', { persona: { type: 'custom', customPrompt: 'PB04_PERSONA_FALLBACK' }, agentConfig: { personaId: 'owned-persona', enabledSkills: [] } });
    await turn.active; const prompt = h.childFor('A')!.args.at(-1)!;
    expect(build).toHaveBeenCalledTimes(1); expect(prompt.split('PB04_CONTEXT_A')).toHaveLength(2);
    if (hasAgent) {
      for (const marker of ['PB04_TRUSTED_AGENT', 'PB04_UNTRUSTED_AGENT']) expect(prompt.split(marker)).toHaveLength(2);
      expect(prompt).not.toContain('PB04_PERSONA_FALLBACK');
      expect(prompt.indexOf('PB04_TRUSTED_AGENT')).toBeLessThan(prompt.indexOf('PB04_UNTRUSTED_AGENT'));
      expect(prompt.indexOf('PB04_UNTRUSTED_AGENT')).toBeLessThan(prompt.indexOf('PB04_CONTEXT_A'));
    } else expect(prompt.split('PB04_PERSONA_FALLBACK')).toHaveLength(2);
    expect(prompt.indexOf('PB04_CONTEXT_A')).toBeLessThan(prompt.indexOf('PB04_REQUEST_A'));
    expect(fs.readFileSync(h.rules)).toEqual(original); await h.settle('A', turn);
  });

  it('does not emit an old done after a failed request is superseded while yielding its error', async () => {
    const h = harness(); native.spawn.mockImplementationOnce(() => { throw new Error('Owned first request failed'); });
    const old = h.provider.sendMessage('PB04_REQUEST_old: fail before replacement', [], settings, null, undefined, 'A');
    try {
      expect((await old.next()).value).toMatchObject({ type: 'error', content: 'Owned first request failed' });
      const replacement = h.begin('A', 'PB04_CONTEXT_NEW', { requestId: 'new' }); await replacement.active;
      expect(await old.next()).toEqual({ done: true, value: undefined });
      expect(h.childFor('new')!.proc.exitCode).toBeNull();
      await h.settle('new', replacement); expect(fs.readFileSync(h.rules)).toEqual(original);
    } finally { await old.return(undefined); }
  });
});
