import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationManager, PERSISTED_TOOL_STRING_CAP } from '../../src/managers/ConversationManager';
import type { Conversation } from '../../src/types';
import { clearMockConfig } from '../helpers/mockVscode';

const directories: string[] = [];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function store() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-fork-history-')); directories.push(directory);
  const file = path.join(directory, 'memento.json'); fs.writeFileSync(file, '{}');
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const context = { globalState: {
    get: (key: string, fallback?: unknown) => read()[key] ?? fallback,
    // Real Memento semantics: snapshot synchronously, then acknowledge the write.
    update: async (key: string, value: unknown) => { const data = read(); data[key] = clone(value); fs.writeFileSync(file, JSON.stringify(data)); },
  } } as any;
  return { context, read, file };
}
function populate(manager: ConversationManager): Conversation {
  const chat = manager.getCurrentConversation()!;
  manager.updateConversationTitle(chat.id, 'Retry service alternatives');
  manager.updateConversationSettings({ provider: 'openai-codex', model: 'fixture-codex', mode: 'detailed-plan' });
  manager.updateAgentConfig(chat.id, { personaId: 'reviewer', enabledSkills: ['retry-contract', 'tests'], roleId: 'analyst' });
  for (let turn = 0; turn < 4; turn++) {
    const user = manager.addMessageToConversation(chat.id, 'user', `Requirement ${turn}\nTrailing whitespace  \n`,
      [{ path: `/owned/retry-${turn}.ts`, content: `const base = ${73 + turn};`, name: 'retry.ts', type: 'file' }] as any);
    user.checkpoint = { commit: String(turn + 1).repeat(40), createdAt: 100 + turn };
    const assistant = manager.addMessageToConversation(chat.id, 'assistant', `Answer ${turn}`, undefined, undefined,
      { style: 'streamed', content: `Reason ${turn}` }, {
        provider: turn % 2 ? 'claude-code' : 'openai-codex', model: `actual-model-${turn}`, participants: ['openai-codex', 'claude-code'],
        segments: [{ type: 'thinking', content: `Reason ${turn}` }, { type: 'tool', toolCallId: `edit-${turn}` }, { type: 'text', content: `Answer ${turn}` }],
        toolCalls: [{ id: `edit-${turn}`, name: 'Edit', status: 'completed', kind: 'edit', input: { file_path: 'retry.ts', options: { attempts: [{ delay: 73 }] } },
          fileChange: { action: 'edit', filePath: 'retry.ts', fileName: 'retry.ts', linesAdded: 1, linesRemoved: 1,
            diffLines: [{ type: 'addition', content: 'const base = 73;', lineNum: 1 }] } }],
      });
    // Extensible persisted metadata must remain detached too.
    (assistant as any).usage = { tokens: { input: 100 + turn, output: 20 + turn } };
  }
  return chat;
}
beforeEach(clearMockConfig);
afterEach(() => { directories.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true })); clearMockConfig(); });

describe('PC-10 fork prefix and branch independence', () => {
  it.each([
    ['enabled skills', (fork: Conversation) => fork.agentConfig!.enabledSkills.push('branch-only')],
    ['structured thinking', (fork: Conversation) => { (fork.messages[5].thinking as any).content = 'branch-only'; }],
    ['nested tool inputs', (fork: Conversation) => { ((fork.messages[5].toolCalls![0].input.options as any).attempts[0]).delay = 999; }],
    ['resolved file diff', (fork: Conversation) => { fork.messages[5].toolCalls![0].fileChange!.diffLines[0].content = 'branch-only'; }],
    ['nested usage metadata', (fork: Conversation) => { (fork.messages[5] as any).usage.tokens.input = 999; }],
  ] as const)('mutating fork %s never rewrites the original transcript or its saved bytes', async (_name, mutate) => {
    const disk = store(), manager = new ConversationManager(disk.context), source = populate(manager);
    const original = clone(source), fork = manager.forkConversation(source.id, source.messages[5].id)!;
    expect(fork.messages.map(message => message.id)).toEqual(source.messages.slice(0, 6).map(message => message.id));
    expect(clone(fork.messages)).toEqual(original.messages.slice(0, 6));
    expect(manager.getCurrentConversation()!.id).toBe(source.id);
    mutate(fork);
    await manager['_saveConversations']();
    expect(clone(source)).toEqual(original);
    expect(clone(new ConversationManager(disk.context).getConversation(source.id))).toEqual(original);
    expect(fork.id).not.toBe(source.id);
  });

  it('a late completion cannot extend or rewrite the prefix already captured by a fork', async () => {
    const disk = store(), manager = new ConversationManager(disk.context), source = populate(manager);
    const fork = manager.forkConversation(source.id, source.messages[5].id)!;
    const before = clone(fork);
    await Promise.resolve();
    (source.messages[5].thinking as any).content += '\nlate final reasoning';
    (source.messages[5].toolCalls![0].input.options as any).attempts.push({ delay: 146 });
    manager.addMessageToConversation(source.id, 'assistant', 'Late source completion', undefined, undefined, undefined, { provider: 'openai-codex', model: 'fixture-codex' });
    await manager['_saveConversations']();
    expect(clone(fork)).toEqual(before);
    expect(clone(new ConversationManager(disk.context).getConversation(fork.id))).toEqual(before);
    expect(source.messages).toHaveLength(9);
  });

  it('rejects invalid or deleted source/message identities without changing current chat or saved history', async () => {
    const disk = store(), manager = new ConversationManager(disk.context), source = populate(manager);
    await manager['_saveConversations']();
    const bytes = fs.readFileSync(disk.file, 'utf8'), current = manager.getCurrentConversation()!.id;
    for (const [chat, message] of [['missing', source.messages[0].id], [source.id, 'missing'], [source.id, ''], ['', source.messages[0].id]]) {
      expect(manager.forkConversation(chat, message)).toBeNull();
      expect(fs.readFileSync(disk.file, 'utf8')).toBe(bytes);
      expect(manager.getCurrentConversation()!.id).toBe(current);
    }
    const deleted = manager.forkConversation(source.id, source.messages[0].id)!; manager.deleteConversation(deleted.id);
    const afterDelete = clone(manager.getAllConversations());
    expect(manager.forkConversation(deleted.id, deleted.messages[0].id)).toBeNull();
    expect(clone(manager.getAllConversations())).toEqual(afterDelete);
  });

  it('50 branches, depth 10, 20 deletions and repeated disk reloads retain exact independent prefixes', async () => {
    const disk = store(); let manager = new ConversationManager(disk.context);
    const source = populate(manager), sourceId = source.id, sourceSnapshot = clone(source), branchIds: string[] = [];
    const appendedIds = new Set<string>(); let parentId = sourceId;
    for (let n = 0; n < 50; n++) {
      if (n % 10 === 0) parentId = sourceId;
      const parent = manager.getConversation(parentId)!;
      const cutoff = parentId === sourceId ? parent.messages[5] : parent.messages.at(-1)!;
      const prefix = clone(parent.messages.slice(0, parent.messages.indexOf(cutoff) + 1));
      const branch = manager.forkConversation(parentId, cutoff.id)!; branchIds.push(branch.id);
      expect(clone(branch.messages)).toEqual(prefix);
      const message = manager.addMessageToConversation(branch.id, 'user', `Branch ${n}: add bounded jitter; nonce ${n * 73}`);
      expect(appendedIds.has(message.id)).toBe(false); appendedIds.add(message.id);
      branch.agentConfig!.enabledSkills.push(`branch-${n}`);
      parentId = branch.id;
      await manager['_saveConversations']();
      if (n % 7 === 6) {
        const expected = clone(manager.getAllConversations()); manager = new ConversationManager(disk.context);
        expect(clone(manager.getAllConversations())).toEqual(expected);
      }
      expect(clone(manager.getConversation(sourceId))).toEqual(sourceSnapshot);
    }
    expect(manager.getAllConversations()).toHaveLength(51);
    const survivors = new Map(manager.getAllConversations().map(chat => [chat.id, clone(chat)]));
    for (const id of branchIds.slice(0, 20)) { expect(manager.deleteConversation(id)).toBe(true); survivors.delete(id); }
    await manager['_saveConversations'](); manager = new ConversationManager(disk.context);
    expect(new Map(manager.getAllConversations().map(chat => [chat.id, clone(chat)]))).toEqual(survivors);
    expect(manager.getAllConversations()).toHaveLength(31);
    expect(manager.getCurrentConversation()!.id).toBe(sourceId);
  });

  it('forking a pre-guard payload preserves source bytes while bounding only the fork payload', () => {
    const disk = store(), manager = new ConversationManager(disk.context), source = populate(manager);
    const message = source.messages[5];
    message.attachments = [{ id: 'image', fileName: 'capture.png', mimeType: 'image/png', type: 'image', size: 4, base64Data: 'AAAA' }];
    message.toolCalls![0].input = { nested: { text: 'x'.repeat(PERSISTED_TOOL_STRING_CAP * 8) } };
    const original = clone(source);
    const fork = manager.forkConversation(source.id, message.id)!;
    expect(clone(source)).toEqual(original);
    expect(fork.messages[5].attachments![0].base64Data).toBeUndefined();
    expect(fork.messages[5].toolCalls![0].truncated).toBe(true);
    expect(JSON.stringify(fork.messages[5].toolCalls![0].input).length).toBeLessThan(PERSISTED_TOOL_STRING_CAP + 50);
  });
});
