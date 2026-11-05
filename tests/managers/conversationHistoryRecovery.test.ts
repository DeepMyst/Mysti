import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationManager, CONVERSATIONS_SCHEMA_VERSION, PERSISTED_TOOL_STRING_CAP } from '../../src/managers/ConversationManager';
import { PROVIDER_DISPLAY_META } from '../../src/providers/base/ProviderManifest';
import type { Conversation, ProviderType } from '../../src/types';
import { clearMockConfig, window } from '../helpers/mockVscode';

const KEY = 'mysti.conversations';
const BACKUP = 'mysti.conversations.corrupt.';
const directories: string[] = [];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

/** JSON bytes in an owned temporary directory, never the user's VS Code store.
 * Each update snapshots its value synchronously, as Memento does, then commits
 * in invocation order. There is no invented out-of-order acknowledgement. */
function diskStore(initial?: unknown) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-history-recovery-'));
  directories.push(directory);
  const file = path.join(directory, 'memento.json');
  fs.writeFileSync(file, JSON.stringify(initial === undefined ? {} : { [KEY]: initial }));
  let rejected = false;
  let writeTarget = file;
  const read = (): Record<string, any> => JSON.parse(fs.readFileSync(file, 'utf8'));
  const context = { globalState: {
    get: <T>(key: string, fallback?: T): T => read()[key] ?? fallback,
    update: vi.fn(async (key: string, value: unknown) => {
      const detached = clone(value);
      if (rejected) { throw Object.assign(new Error('controlled storage full'), { code: 'ENOSPC' }); }
      const store = read(); store[key] = detached;
      fs.writeFileSync(writeTarget, JSON.stringify(store));
    }),
  } } as any;
  return { context, read, file, fail: (value: boolean) => { rejected = value; },
    blockFilesystemWrites: (blocked: boolean) => {
      const obstruction = path.join(directory, 'write-obstruction');
      if (blocked) { fs.mkdirSync(obstruction, { recursive: true }); }
      writeTarget = blocked ? obstruction : file;
    },
  };
}
function conversation(id: string): Conversation {
  return { id, title: `Task ${id}`, messages: [{ id: `${id}-user`, role: 'user', content: `Request ${id}`, timestamp: 10 }],
    createdAt: 10, updatedAt: 20, mode: 'ask-before-edit', provider: 'claude-code', model: 'fixture-model' };
}
function blob(entries: Array<[string, unknown]>, currentId = entries[0]?.[0]) {
  return { schemaVersion: CONVERSATIONS_SCHEMA_VERSION, conversations: entries, currentId };
}
beforeEach(() => { clearMockConfig(); vi.restoreAllMocks(); });
afterEach(() => { directories.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true })); vi.restoreAllMocks(); });

describe('PC-08 exact history ownership and serialized restart', () => {
  it.each(['deleted', 'missing'])('an explicitly %s conversation never receives a fallback write in the current chat', async state => {
    const store = diskStore(blob([['first', conversation('first')], ['second', conversation('second')]], 'second'));
    const manager = new ConversationManager(store.context);
    if (state === 'deleted') manager.deleteConversation('first');
    const before = clone(manager.getAllConversations());
    expect(() => manager.addMessageToConversation(state === 'deleted' ? 'first' : 'missing', 'assistant', 'late old response')).toThrow(/conversation/i);
    expect(manager.getAllConversations()).toEqual(before);
    await manager['_saveConversations']();
    expect(new ConversationManager(store.context).getAllConversations()).toEqual(before);
  });

  it('null and undefined conversation IDs retain the documented current-chat fallback', () => {
    const store = diskStore(blob([['current', conversation('current')]]));
    const manager = new ConversationManager(store.context);
    manager.addMessageToConversation(null, 'user', 'legacy null');
    manager.addMessageToConversation(undefined, 'assistant', 'legacy undefined');
    expect(manager.getCurrentConversation()!.messages.map(message => message.content)).toEqual(['Request current', 'legacy null', 'legacy undefined']);
  });

  it('switching to an older chat survives a restart without requiring a subsequent message', async () => {
    const store = diskStore(blob([['oldest', conversation('oldest')], ['latest', conversation('latest')]], 'latest'));
    const manager = new ConversationManager(store.context);
    expect(manager.switchConversation('oldest')).toBe(true);
    await flush();
    expect(new ConversationManager(store.context).getCurrentConversation()!.id).toBe('oldest');
    const before = fs.readFileSync(store.file, 'utf8');
    expect(manager.switchConversation('unknown')).toBe(false);
    expect(fs.readFileSync(store.file, 'utf8')).toBe(before);
  });

  it('twenty distinct tasks survive detached JSON bytes, full attribution/config/context, and a targeted deletion', async () => {
    const store = diskStore();
    let manager = new ConversationManager(store.context);
    const providers = Object.keys(PROVIDER_DISPLAY_META) as ProviderType[];
    const ids: string[] = [];
    for (let task = 0; task < 20; task++) {
      const chat = task ? manager.createNewConversation() : manager.getCurrentConversation()!;
      ids.push(chat.id);
      const provider = providers[task % providers.length];
      manager.updateConversationSettings({ provider, model: `fixture-model-${task}`, mode: task % 2 ? 'detailed-plan' : 'ask-before-edit' });
      manager.updateAgentConfig(chat.id, { personaId: `persona-${task}`, enabledSkills: [`skill-${task}`, 'shared'], roleId: 'reviewer' });
      manager.updateConversationTitle(chat.id, `Task ${task}: retry / إعادة المحاولة 🧪`);
      for (let turn = 0; turn < 6; turn++) {
        const text = `task=${task}; turn=${turn}; nonce=${task * 100 + turn}\n\nExact trailing spaces  \n`;
        manager.addMessageToConversation(chat.id, 'user', text, [{ id: `context-${task}-${turn}`, type: 'file', name: 'retry.ts', path: `/owned/task-${task}/retry.ts`, content: `context-${turn}` }] as any,
          [{ id: `attachment-${turn}`, fileName: 'retry.png', type: 'image', mimeType: 'image/png', size: 4, base64Data: 'AAAA' }]);
        manager.addMessageToConversation(chat.id, 'assistant', `Answer ${text}`, undefined, undefined, { style: 'streamed', content: `Reasoning ${turn}` }, {
          provider, model: `actual-model-${task}`, participants: [provider],
          segments: [{ type: 'thinking', content: `Reasoning ${turn}` }, { type: 'text', content: `Answer ${text}` }, { type: 'tool', toolCallId: `tool-${turn}` }],
          toolCalls: [{ id: `tool-${turn}`, name: 'Edit', status: 'completed', kind: 'edit', input: { nested: ['large'.repeat(8000)] }, output: 'x'.repeat(PERSISTED_TOOL_STRING_CAP + 25) }],
        });
      }
    }
    const expected = clone(manager.getAllConversations());
    await manager['_saveConversations']();
    const bytes = fs.readFileSync(store.file, 'utf8');
    expect(bytes).not.toContain('AAAA');
    manager = new ConversationManager(store.context);
    expect(manager.getAllConversations()).toEqual(expected);
    expect(manager.getAllConversations()).toHaveLength(20);
    for (const chat of manager.getAllConversations()) {
      expect(chat.messages).toHaveLength(12);
      for (const message of chat.messages.filter(message => message.role === 'assistant')) {
        expect(message.toolCalls![0]).toMatchObject({ truncated: true });
        expect(message.toolCalls![0].output).toHaveLength(PERSISTED_TOOL_STRING_CAP);
        expect(JSON.stringify(message.toolCalls![0].input).length).toBeLessThan(PERSISTED_TOOL_STRING_CAP + 50);
      }
    }
    expect(manager.deleteConversation(ids[7])).toBe(true);
    await manager['_saveConversations']();
    expect(new ConversationManager(store.context).getAllConversations()).toEqual(expected.filter(chat => chat.id !== ids[7]));
  });
});

describe('PC-08 partially malformed history preserves recovery bytes', () => {
  it.each([null, { type: 'text', content: { invalid: 'second paragraph' } }])('discards an invalid mixed segment timeline instead of hiding canonical text: %j', async broken => {
    const chat = conversation('task');
    const content = 'First paragraph.\n\nFinal paragraph.';
    const thinking = { style: 'streamed', content: 'Complete reasoning.' };
    const toolCalls = [{ id: 'tool', name: 'Read', input: { file_path: 'retry.ts' }, output: 'retained result', status: 'completed' }];
    const original = blob([['task', { ...chat, messages: [{ ...chat.messages[0], role: 'assistant', content, thinking, toolCalls,
      segments: [{ type: 'text', content: 'First paragraph.' }, { type: 'tool', toolCallId: 'tool' }, broken],
    }] }]]);
    const store = diskStore(original);
    const manager = new ConversationManager(store.context);
    const restored = manager.getConversation('task')!.messages[0];
    expect(restored.segments).toBeUndefined();
    expect(restored).toMatchObject({ content, thinking, toolCalls });
    await manager['_saveConversations']();
    const backups = Object.keys(store.read()).filter(key => key.startsWith(BACKUP));
    expect(backups).toHaveLength(1);
    expect(store.read()[backups[0]]).toEqual(original);
    expect(new ConversationManager(store.context).getConversation('task')!.messages[0]).toEqual(restored);
  });

  it.each([42, { unexpected: 'model object' }])('removes invalid per-message model attribution %j before historical rendering', async model => {
    const originalChat = conversation('task');
    const original = blob([['task', { ...originalChat, messages: [{ ...originalChat.messages[0], role: 'assistant', model }] }]]);
    const store = diskStore(original);
    const manager = new ConversationManager(store.context);
    const chat = manager.getConversation('task')!;
    expect(chat.messages[0].model).toBeUndefined();
    // Historical attribution falls back to the conversation model; the actual
    // renderer's string-formatting path must receive a string in either case.
    expect(() => (chat.messages[0].model || chat.model).replace(/-/g, ' ')).not.toThrow();
    await manager['_saveConversations']();
    const backups = Object.keys(store.read()).filter(key => key.startsWith(BACKUP));
    expect(backups).toHaveLength(1);
    expect(store.read()[backups[0]]).toEqual(original);
  });

  it('preserves arbitrary valid model strings and unknown extension fields without a false recovery warning', async () => {
    const valid = conversation('task');
    const original = blob([['task', { ...valid, extraConversationData: { revision: 17 }, messages: [{
      ...valid.messages[0], model: 'provider/private-model:v42', extraMessageData: { values: [1, 'preserve me', null] },
    }] }]]);
    const store = diskStore(original);
    const manager = new ConversationManager(store.context);
    expect(manager.getLoadDiagnostic()).toBeNull();
    await manager['_saveConversations']();
    expect(store.read()[KEY]).toEqual(original);
    expect(Object.keys(store.read()).filter(key => key.startsWith(BACKUP))).toEqual([]);
  });

  it('repairs mismatched value IDs to their authoritative map keys, preserving both transcripts and the original blob', async () => {
    const original = blob([['first', { ...conversation('first'), id: 'second' }], ['second', conversation('second')]]);
    const store = diskStore(original);
    const manager = new ConversationManager(store.context);
    for (const chat of manager.getAllConversations()) expect(manager.getConversation(chat.id)).toBe(chat);
    expect(manager.getConversation('first')!.id).toBe('first');
    expect(manager.getLoadDiagnostic()).not.toBeNull();
    await manager['_saveConversations']();
    const backups = Object.keys(store.read()).filter(key => key.startsWith(BACKUP));
    expect(backups).toHaveLength(1);
    expect(store.read()[backups[0]]).toEqual(original);
    const reloaded = new ConversationManager(store.context);
    expect(reloaded.getConversation('first')!.messages[0].content).toBe('Request first');
    expect(reloaded.getLoadDiagnostic()).toBeNull();
  });

  it.each([
    ['object content', { content: { raw: 'unreadable' } }],
    ['unknown role', { role: 'unknown' }],
    ['invalid attachments', { attachments: { raw: 'not an array' } }],
    ['invalid tool calls', { toolCalls: { raw: 'not an array' } }],
    ['invalid context', { context: 'not an array' }],
    ['invalid segments', { segments: 'not an array' }],
    ['invalid nested segments', { segments: [{ type: 'text', content: {} }] }],
    ['invalid attachment elements', { attachments: [null, 'not an attachment'] }],
  ])('recovers %s while retaining valid neighbors and byte-equivalent original data', async (_label, invalid) => {
    const good = conversation('task');
    const original = blob([['task', { ...good, messages: [good.messages[0], { ...good.messages[0], id: 'bad', ...invalid }] }]]);
    const store = diskStore(original);
    const manager = new ConversationManager(store.context);
    expect(manager.getLoadDiagnostic()).not.toBeNull();
    expect(manager.getConversation('task')!.messages[0]).toEqual(good.messages[0]);
    expect(() => manager.exportToShareable('task')).not.toThrow();
    expect(() => manager.exportToJson('task')).not.toThrow();
    expect(() => manager.forkConversation('task', manager.getConversation('task')!.messages.at(-1)!.id)).not.toThrow();
    for (const message of manager.getConversation('task')!.messages) {
      expect(typeof message.content).toBe('string');
      expect(['user', 'assistant', 'system']).toContain(message.role);
      for (const field of ['attachments', 'toolCalls', 'context', 'segments'] as const) {
        expect(message[field] === undefined || Array.isArray(message[field])).toBe(true);
      }
    }
    await manager['_saveConversations']();
    const backups = Object.keys(store.read()).filter(key => key.startsWith(BACKUP));
    expect(backups).toHaveLength(1);
    expect(store.read()[backups[0]]).toEqual(original);
    expect(new ConversationManager(store.context).getLoadDiagnostic()).toBeNull();
    expect(Object.keys(store.read()).filter(key => key.startsWith(BACKUP))).toHaveLength(1);
  });

  it('repairs malformed conversation metadata before history/export consumers use it', async () => {
    const original = blob([['task', { ...conversation('task'), title: {}, model: 42, provider: 'unsupported', createdAt: 'yesterday',
      updatedAt: null, mode: 'unsupported', agentConfig: { personaId: null, enabledSkills: 'not an array' } }]]);
    const store = diskStore(original);
    const manager = new ConversationManager(store.context);
    const restored = manager.getConversation('task')!;
    expect(typeof restored.title).toBe('string');
    expect(typeof restored.model).toBe('string');
    expect(Number.isFinite(restored.createdAt)).toBe(true);
    expect(Number.isFinite(restored.updatedAt)).toBe(true);
    expect(restored.mode).toBe('ask-before-edit');
    expect(restored.provider).toBe('claude-code');
    expect(restored.agentConfig === undefined || Array.isArray(restored.agentConfig.enabledSkills)).toBe(true);
    expect(() => manager.exportToShareable('task')).not.toThrow();
    await manager['_saveConversations']();
    const backups = Object.keys(store.read()).filter(key => key.startsWith(BACKUP));
    expect(backups).toHaveLength(1);
    expect(store.read()[backups[0]]).toEqual(original);
  });
});

describe('PC-08 storage failure and recovery', () => {
  it('retains acknowledged JSON bytes across a real filesystem write error and recovers pending changes', async () => {
    const store = diskStore(blob([['task', conversation('task')]]));
    const manager = new ConversationManager(store.context);
    const original = fs.readFileSync(store.file, 'utf8');
    const notice = vi.spyOn(window, 'showErrorMessage');
    store.blockFilesystemWrites(true);
    manager.addMessage('user', 'pending during real filesystem error');
    expect(await manager['_saveConversations']()).toBe(false);
    expect(notice).toHaveBeenCalledOnce();
    expect(fs.readFileSync(store.file, 'utf8')).toBe(original);
    store.blockFilesystemWrites(false);
    expect(await manager['_saveConversations']()).toBe(true);
    expect(new ConversationManager(store.context).getMessages().map(message => message.content))
      .toEqual(['Request task', 'pending during real filesystem error']);
  });

  it('reports one diagnostic per write outage and saves all accumulated messages after recovery', async () => {
    const store = diskStore(blob([['task', conversation('task')]]));
    const manager = new ConversationManager(store.context);
    const error = vi.spyOn(window, 'showErrorMessage');
    const before = fs.readFileSync(store.file, 'utf8');
    store.fail(true);
    manager.addMessage('user', 'request during outage');
    manager.addMessage('assistant', 'partial result during outage');
    manager.updateConversationTitle('task', 'Recovered retry task');
    expect(await manager['_saveConversations']()).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(store.file, 'utf8')).toBe(before);
    store.fail(false);
    expect(await manager['_saveConversations']()).toBe(true);
    const recovered = new ConversationManager(store.context);
    expect(recovered.getCurrentConversation()).toEqual(clone(manager.getCurrentConversation()));
    store.fail(true);
    manager.addMessage('assistant', 'another outage');
    expect(await manager['_saveConversations']()).toBe(false);
    expect(error).toHaveBeenCalledTimes(2);
  });
});
