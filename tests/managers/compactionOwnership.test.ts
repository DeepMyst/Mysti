import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CompactionManager } from '../../src/managers/CompactionManager';
import { ConversationManager } from '../../src/managers/ConversationManager';
import { SmartCompactor } from '../../src/managers/SmartCompactor';
import { safePanelSegment } from '../../src/services/HistoryStore';
import type { ProviderManager } from '../../src/managers/ProviderManager';
import type { DeepMystAuthManager } from '../../src/managers/DeepMystAuthManager';
import type { DeepMystGatewayClient } from '../../src/services/DeepMystGatewayClient';
import type { SavingsLedger } from '../../src/managers/SavingsLedger';
import type { Conversation, Settings, StreamChunk } from '../../src/types';

// Clone native module namespaces so spies can pause actual owned-temp I/O.
vi.mock('fs/promises', async original => ({ ...await original<typeof import('fs/promises')>() }));
vi.mock('fs', async original => ({ ...await original<typeof import('fs')>() }));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const settings = { provider: 'ollama', model: 'claude-opus-4-8' } as Settings;
const MEMORY = '## Goal\n' + 'Keep all current conversation facts intact while compacting old context. '.repeat(20) + '\n';
let temporaryRoot: string;
let oldFolders: typeof vscode.workspace.workspaceFolders;
const managers: CompactionManager[] = [];

beforeEach(() => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-compaction-owner-'));
  oldFolders = vscode.workspace.workspaceFolders;
  (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: temporaryRoot }, name: 'isolated', index: 0 }];
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const manager of managers.splice(0)) { manager.dispose(); }
  (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = oldFolders;
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

function history() {
  const writes: Array<{ conversations: Array<[string, Conversation]> }> = [];
  const context = { globalState: { get: () => undefined, update: async (_key: string, value: unknown) => {
    writes.push(JSON.parse(JSON.stringify(value)));
  } } } as unknown as vscode.ExtensionContext;
  const store = new ConversationManager(context);
  const conversation = store.getCurrentConversation()!;
  for (let i = 0; i < 8; i++) { store.addMessageToConversation(conversation.id, i % 2 ? 'assistant' : 'user', 'Original ' + i); }
  conversation.messages[7].thinking = { style: 'streamed', content: 'Preserved reasoning' };
  conversation.messages[7].segments = [{ type: 'text', content: 'Original 7' }];
  conversation.messages[7].toolCalls = [{ id: 'tool', name: 'Read', input: { path: 'old.ts' }, status: 'completed' }];
  const manager = new CompactionManager(context); managers.push(manager);
  return { store, conversation, manager, writes };
}

function client(h: ReturnType<typeof history>, isCurrent?: () => boolean) {
  const entered = deferred(); const release = deferred();
  let closed = false;
  const sendMessage = vi.fn(async function* (): AsyncGenerator<StreamChunk> {
    try { entered.resolve(); await release.promise; yield { type: 'text', content: 'Compacted earlier history' }; yield { type: 'done' }; }
    finally { closed = true; }
  });
  const provider = { sendMessage } as unknown as ProviderManager;
  const pending = h.manager.executeClientSummarization(provider, h.store, settings, h.conversation, 'panel', isCurrent);
  return { entered, release, pending, sendMessage, closed: () => closed };
}

function smart(h: ReturnType<typeof history>, panel = 'panel', options?: { isCurrent?: () => boolean; signal?: AbortSignal }) {
  const entered = deferred(); const release = deferred();
  const gateway = { chatCompletion: vi.fn(async () => {
    entered.resolve(); await release.promise;
    return { text: MEMORY, failed: false, costUsd: 0.001, inputTokens: 100, outputTokens: 200 };
  }) };
  const ledger = { record: vi.fn() };
  const engine = new SmartCompactor(
    { isSignedIn: () => true, hasEntitlement: () => true } as unknown as DeepMystAuthManager,
    gateway as unknown as DeepMystGatewayClient, ledger as unknown as SavingsLedger,
  );
  const pending = engine.summarize({ panelId: panel, conversation: h.conversation,
    providerModel: settings.model, cheapModel: 'claude-haiku-4-5', minSummaryTokens: 5000, ...options });
  return { entered, release, pending, engine, gateway, ledger };
}
function memoryPath(panel = 'panel') { return path.join(temporaryRoot, '.mysti', 'compaction', safePanelSegment(panel), 'memory.md'); }
function writeMemory(value: string, panel = 'panel') {
  const file = memoryPath(panel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file;
}
function stagedFiles(panel = 'panel') {
  const dir = path.dirname(memoryPath(panel));
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.startsWith('.memory-')) : [];
}

describe('client compaction commit ownership', () => {
  it('preserves later messages in the managed conversation and its next durable save', async () => {
    const h = history(); const c = client(h); await c.entered.promise;
    h.store.addMessageToConversation(h.conversation.id, 'user', 'Newer question');
    h.store.addMessageToConversation(h.conversation.id, 'assistant', 'Newer answer');
    c.release.resolve(); expect((await c.pending).success).toBe(false);
    h.store.addMessageToConversation(h.conversation.id, 'system', 'Save again');
    expect(h.writes.at(-1)!.conversations[0][1].messages.map(m => m.content)).toEqual([
      ...Array.from({ length: 8 }, (_, i) => 'Original ' + i), 'Newer question', 'Newer answer', 'Save again',
    ]);
    expect(c.closed()).toBe(true);
  });

  it.each(['content', 'thinking', 'segments', 'toolCalls'] as const)('rejects same-length in-place %s changes', async field => {
    const h = history(); const original = h.conversation.messages; const c = client(h); await c.entered.promise;
    const last = h.conversation.messages[7];
    if (field === 'content') { last.content = 'New content'; }
    if (field === 'thinking') { last.thinking = { style: 'streamed', content: 'New reasoning' }; }
    if (field === 'segments') { last.segments![0].content = 'New segment'; }
    if (field === 'toolCalls') { last.toolCalls![0].input.path = 'new.ts'; }
    const expected = JSON.stringify(original);
    c.release.resolve(); expect((await c.pending).success).toBe(false);
    expect(h.conversation.messages).toBe(original); expect(JSON.stringify(original)).toBe(expected);
  });

  it('admits only one of two concurrent summaries even if both return identical text', async () => {
    const h = history(); const a = client(h); const b = client(h);
    await Promise.all([a.entered.promise, b.entered.promise]); a.release.resolve(); b.release.resolve();
    expect((await Promise.all([a.pending, b.pending])).map(r => r.success).sort()).toEqual([false, true]);
    expect(h.conversation.messages).toHaveLength(5);
    expect(h.conversation.messages[4].thinking).toEqual({ style: 'streamed', content: 'Preserved reasoning' });
    expect(h.conversation.messages[4].toolCalls![0].input.path).toBe('old.ts');
  });

  it('skips submission when already cancelled and closes a stream cancelled while awaiting', async () => {
    const h = history(); const before = h.conversation.messages; let current = false;
    const off = client(h, () => current); expect((await off.pending).success).toBe(false); expect(off.sendMessage).not.toHaveBeenCalled();
    current = true; const active = client(h, () => current); await active.entered.promise;
    current = false; active.release.resolve(); expect((await active.pending).success).toBe(false);
    expect(active.closed()).toBe(true); expect(h.conversation.messages).toBe(before);
  });

  it.each(['error', 'auth_error'] as const)('never commits partial text followed by an explicit %s', async type => {
    const h = history(); const before = h.conversation.messages; let closed = false;
    const provider = { sendMessage: async function* (): AsyncGenerator<StreamChunk> {
      try { yield { type: 'text', content: 'Only part of the summary' }; yield { type, content: '' }; }
      finally { closed = true; }
    } } as unknown as ProviderManager;
    const result = await h.manager.executeClientSummarization(provider, h.store, settings, h.conversation, 'panel');
    expect(result.success).toBe(false); expect(result.error?.trim()).toBeTruthy();
    expect(h.conversation.messages).toBe(before); expect(closed).toBe(true);
  });

  it('refuses text-only EOF and commits only after an explicit done', async () => {
    for (const explicitDone of [false, true]) {
      const h = history(); const before = h.conversation.messages; let pastDone = false;
      const provider = { sendMessage: async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'text', content: 'Complete summary' };
        if (explicitDone) { yield { type: 'done' }; pastDone = true; yield { type: 'error', content: 'Late error after terminal' }; }
      } } as unknown as ProviderManager;
      const result = await h.manager.executeClientSummarization(provider, h.store, settings, h.conversation, 'panel');
      expect(result.success).toBe(explicitDone);
      if (explicitDone) { expect(h.conversation.messages[0].content).toContain('Complete summary'); }
      else { expect(h.conversation.messages).toBe(before); expect(result.error).toContain('before completing'); }
      expect(pastDone).toBe(false);
    }
  });

  it('aborting closes exactly the compaction session transport and commits nothing', async () => {
    const h = history(); const before = h.conversation.messages; const entered = deferred(); const closed = deferred();
    const cancelRequest = vi.fn((id: string) => { if (id === 'panel-compaction') { closed.resolve(); } });
    const provider = { cancelRequest, sendMessage: async function* (): AsyncGenerator<StreamChunk> {
      entered.resolve(); await closed.promise; // A blocked transport ends only when its session is cancelled.
    } } as unknown as ProviderManager;
    const abort = new AbortController();
    const pending = h.manager.executeClientSummarization(provider, h.store, settings, h.conversation, 'panel', () => true, abort.signal);
    await entered.promise; abort.abort();
    expect(cancelRequest.mock.calls).toEqual([['panel-compaction']]);
    expect((await pending).success).toBe(false); expect(h.conversation.messages).toBe(before);
  });

  it('a settled summary detaches its abort listener so a later abort cannot cancel a reused session', async () => {
    const h = history(); const cancelRequest = vi.fn();
    const provider = { cancelRequest, sendMessage: async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', content: 'Summary' }; yield { type: 'done' };
    } } as unknown as ProviderManager;
    const abort = new AbortController();
    expect((await h.manager.executeClientSummarization(provider, h.store, settings, h.conversation, 'panel', () => true, abort.signal)).success).toBe(true);
    abort.abort(); expect(cancelRequest).not.toHaveBeenCalled();
    const sent = vi.fn(); const stopped = new AbortController(); stopped.abort();
    const off = { cancelRequest, sendMessage: sent } as unknown as ProviderManager;
    for await (const _chunk of h.manager.executeNativeCompaction(off, settings, null, 'panel', stopped.signal)) { /* none */ }
    expect(sent).not.toHaveBeenCalled();
  });

  it('retains attempt cooldown during a client summary and after its explicit failure', async () => {
    const h = history(); const release = deferred(); const entered = deferred();
    const due = () => h.manager.shouldCompact('panel', { input_tokens: 950, output_tokens: 0 }, 1000, 20);
    expect(due()).toBe(true);
    const provider = { sendMessage: async function* (): AsyncGenerator<StreamChunk> {
      entered.resolve(); await release.promise; yield { type: 'error', content: 'Failed summary' };
    } } as unknown as ProviderManager;
    const pending = h.manager.executeClientSummarization(provider, h.store, settings, h.conversation, 'panel');
    await entered.promise; expect(due()).toBe(false); release.resolve(); expect((await pending).success).toBe(false);
    expect(due()).toBe(false);
  });
});

describe('smart compaction staged commit', () => {
  it('keeps newer messages and newer memory while a gateway result is pending', async () => {
    const h = history(); const file = writeMemory(MEMORY); const c = smart(h); await c.entered.promise;
    const initialEstimate = c.engine.estimateRemainingTurns();
    for (let i = 0; i < initialEstimate + 2; i++) { c.engine.recordTurn('panel', { input_tokens: 100, output_tokens: 10 }); }
    h.store.addMessageToConversation(h.conversation.id, 'user', 'Newer question');
    fs.writeFileSync(file, 'Newer memory'); c.release.resolve(); expect((await c.pending)?.success).toBe(false);
    expect(h.conversation.messages.at(-1)?.content).toBe('Newer question');
    expect(fs.readFileSync(file, 'utf8')).toBe('Newer memory'); expect(c.ledger.record).not.toHaveBeenCalled();
    expect(c.engine.estimateRemainingTurns()).toBe(initialEstimate); expect(stagedFiles()).toEqual([]);
  });

  it.each(['created', 'changed', 'removed'] as const)('refuses memory %s during the gateway await even without a supplied owner', async change => {
    const h = history(); const before = h.conversation.messages;
    if (change !== 'created') { writeMemory(change === 'removed' ? '' : MEMORY); }
    const c = smart(h); await c.entered.promise;
    if (change === 'removed') { fs.unlinkSync(memoryPath()); } else { writeMemory('Other owner memory'); }
    c.release.resolve(); expect((await c.pending)?.success).toBe(false);
    expect(h.conversation.messages).toBe(before); expect(c.ledger.record).not.toHaveBeenCalled(); expect(stagedFiles()).toEqual([]);
    if (change === 'removed') { expect(fs.existsSync(memoryPath())).toBe(false); }
    else { expect(fs.readFileSync(memoryPath(), 'utf8')).toBe('Other owner memory'); }
  });

  it('commits only one concurrent identical summary, including memory and savings', async () => {
    const h = history(); writeMemory(MEMORY); const a = smart(h); const b = smart(h);
    await Promise.all([a.entered.promise, b.entered.promise]); a.release.resolve(); b.release.resolve();
    expect((await Promise.all([a.pending, b.pending])).map(r => r?.success).sort()).toEqual([false, true]);
    expect(h.conversation.messages).toHaveLength(5);
    expect(a.ledger.record.mock.calls.length + b.ledger.record.mock.calls.length).toBe(1);
    expect(fs.readFileSync(memoryPath(), 'utf8').trim()).toBe(MEMORY.trim()); expect(stagedFiles()).toEqual([]);
  });

  it.each(['owner', 'history', 'memory'] as const)('refuses %s replacement during an actual staged file write and cleans only its temporary output', async change => {
    const h = history(); const before = h.conversation.messages; const file = writeMemory(MEMORY); let current = true;
    const staged = deferred(); const resume = deferred(); const realOpen = fsp.open;
    vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args); const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementation(async (...writeArgs) => { await write(...writeArgs); staged.resolve(); await resume.promise; });
      return handle;
    });
    const c = smart(h, 'panel', { isCurrent: () => current }); await c.entered.promise; c.release.resolve(); await staged.promise;
    if (change === 'owner') { current = false; }
    if (change === 'history') { h.store.addMessageToConversation(h.conversation.id, 'user', 'Newer question'); }
    if (change === 'memory') { fs.writeFileSync(file, 'Newer memory'); }
    const sibling = path.join(path.dirname(file), '.memory-sibling.tmp'); fs.writeFileSync(sibling, 'Sibling output');
    resume.resolve(); expect((await c.pending)?.success).toBe(false);
    expect(h.conversation.messages).toBe(before); expect(c.ledger.record).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe(change === 'memory' ? 'Newer memory' : MEMORY);
    expect(stagedFiles()).toEqual(['.memory-sibling.tmp']); expect(fs.readFileSync(sibling, 'utf8')).toBe('Sibling output');
  });

  it.each(['write', 'rename'] as const)('preserves history and existing memory on a %s failure', async failure => {
    const h = history(); const before = h.conversation.messages; const file = writeMemory(MEMORY);
    if (failure === 'write') {
      const realOpen = fsp.open;
      vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
        const handle = await realOpen(...args); await handle.close(); return handle; // Actual EBADF on write.
      });
    } else { vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw Object.assign(new Error('Rename denied'), { code: 'EACCES' }); }); }
    const c = smart(h); await c.entered.promise; c.release.resolve(); expect((await c.pending)?.success).toBe(false);
    expect(h.conversation.messages).toBe(before); expect(fs.readFileSync(file, 'utf8')).toBe(MEMORY);
    expect(c.ledger.record).not.toHaveBeenCalled(); expect(stagedFiles()).toEqual([]);
  });

  it('does not remove a colliding temporary path it never owned', async () => {
    const h = history(); const before = h.conversation.messages; const realOpen = fsp.open;
    vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
      fs.writeFileSync(args[0] as fs.PathLike, 'Other owner'); return realOpen(...args);
    });
    const c = smart(h); await c.entered.promise; c.release.resolve(); expect((await c.pending)?.success).toBe(false);
    expect(h.conversation.messages).toBe(before); expect(fs.existsSync(memoryPath())).toBe(false);
    const leftovers = stagedFiles(); expect(leftovers).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(memoryPath()), leftovers[0]), 'utf8')).toBe('Other owner');
  });

  it('does not block an independent panel behind a delayed summary', async () => {
    const slow = smart(history(), 'slow'); const fast = smart(history(), 'fast');
    await Promise.all([slow.entered.promise, fast.entered.promise]); fast.release.resolve();
    expect((await fast.pending)?.success).toBe(true); expect(fs.existsSync(memoryPath('slow'))).toBe(false);
    slow.release.resolve(); expect((await slow.pending)?.success).toBe(true);
  });

  it('skips a pre-aborted gateway call and refuses an ignored abort after submission', async () => {
    const h = history(); const before = h.conversation.messages; const abort = new AbortController(); abort.abort();
    const off = smart(h, 'panel', { signal: abort.signal }); expect((await off.pending)?.success).toBe(false);
    expect(off.gateway.chatCompletion).not.toHaveBeenCalled();
    const activeAbort = new AbortController(); const active = smart(h, 'panel', { signal: activeAbort.signal });
    await active.entered.promise; activeAbort.abort(); active.release.resolve(); expect((await active.pending)?.success).toBe(false);
    expect(h.conversation.messages).toBe(before); expect(fs.existsSync(memoryPath())).toBe(false);
  });

  it('does not submit to the gateway if the owner changes during the actual memory read', async () => {
    const h = history(); const file = writeMemory(MEMORY); const before = h.conversation.messages;
    const entered = deferred(); const resume = deferred(); const read = fsp.readFile; let current = true;
    vi.spyOn(fsp, 'readFile').mockImplementation(async (...args) => {
      const result = await read(...args); entered.resolve(); await resume.promise; return result;
    });
    const c = smart(h, 'panel', { isCurrent: () => current }); await entered.promise; current = false; resume.resolve();
    expect((await c.pending)?.success).toBe(false); expect(c.gateway.chatCompletion).not.toHaveBeenCalled();
    expect(h.conversation.messages).toBe(before); expect(fs.readFileSync(file, 'utf8')).toBe(MEMORY);
  });

  it('forwards the manager callback into the smart commit owner', async () => {
    const h = history(); const before = h.conversation.messages; const entered = deferred(); const release = deferred(); let current = true;
    const ledger = { record: vi.fn() };
    const engine = new SmartCompactor(
      { isSignedIn: () => true, hasEntitlement: () => true } as unknown as DeepMystAuthManager,
      { chatCompletion: async () => { entered.resolve(); await release.promise; return { text: MEMORY, failed: false }; } } as unknown as DeepMystGatewayClient,
      ledger as unknown as SavingsLedger,
    );
    h.manager.setSmartCompactor(engine); h.manager.setBoostOverlay({ compactionThreshold: () => undefined, smartCompactionEnabled: () => true });
    const pending = h.manager.executeSmartSummarization(settings, h.conversation, 'panel', () => current);
    await entered.promise; current = false; release.resolve(); expect((await pending)?.success).toBe(false);
    expect(h.conversation.messages).toBe(before); expect(fs.existsSync(memoryPath())).toBe(false); expect(ledger.record).not.toHaveBeenCalled();
  });

  it('reports successful history/memory commit even if optional savings accounting throws', async () => {
    const h = history(); const c = smart(h); c.ledger.record.mockImplementation(() => { throw new Error('Optional accounting failed'); });
    await c.entered.promise; c.release.resolve(); expect((await c.pending)?.success).toBe(true);
    expect(h.conversation.messages[0].content).toContain('Keep all current conversation facts');
    expect(fs.readFileSync(memoryPath(), 'utf8').trim()).toBe(MEMORY.trim()); expect(stagedFiles()).toEqual([]);
  });

  it('creates replacement memory privately instead of inheriting default write permissions', async () => {
    const h = history(); const file = writeMemory(MEMORY); fs.chmodSync(file, 0o600);
    const open = vi.spyOn(fsp, 'open'); const c = smart(h); await c.entered.promise; c.release.resolve();
    expect((await c.pending)?.success).toBe(true); expect(open).toHaveBeenCalledWith(expect.any(String), 'wx', 0o600);
    if (process.platform !== 'win32') { expect(fs.statSync(file).mode & 0o777).toBe(0o600); }
  });

  it('retains manager attempt cooldown through an in-flight and failed smart gateway request', async () => {
    const h = history(); const entered = deferred(); const release = deferred();
    const engine = new SmartCompactor(
      { isSignedIn: () => true, hasEntitlement: () => true } as unknown as DeepMystAuthManager,
      { chatCompletion: async () => { entered.resolve(); await release.promise; return { failed: true, text: '', error: 'Gateway unavailable' }; } } as unknown as DeepMystGatewayClient,
      { record: vi.fn() } as unknown as SavingsLedger,
    );
    h.manager.setSmartCompactor(engine); h.manager.setBoostOverlay({ compactionThreshold: () => undefined, smartCompactionEnabled: () => true });
    const due = () => h.manager.shouldCompact('panel', { input_tokens: 950, output_tokens: 0 }, 1000, 20);
    expect(due()).toBe(true); const pending = h.manager.executeSmartSummarization(settings, h.conversation, 'panel');
    await entered.promise; expect(due()).toBe(false); release.resolve(); expect(await pending).toBeNull(); expect(due()).toBe(false);
  });
});
