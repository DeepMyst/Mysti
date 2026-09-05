/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 27 lane D — the conversation store must never take activation down.
 *
 * `ConversationManager` is constructed unguarded from `activate()`, hundreds of
 * lines before the webview provider is registered, so anything thrown while
 * reading `mysti.conversations` means the extension does not activate at all —
 * no sidebar, no commands, and therefore no way for the user to clear the blob
 * that is breaking them. These tests pin the contract:
 *
 *   a store that cannot read its own bytes starts empty, KEEPS the bytes it
 *   could not read, says so once, and never throws toward activate().
 *
 * They also pin the store-side write guard (base64 + tool-string caps), which
 * used to live at one ChatViewProvider call site and was bypassed by the
 * import path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ConversationManager,
  CONVERSATIONS_SCHEMA_VERSION,
  PERSISTED_TOOL_STRING_CAP,
} from '../../src/managers/ConversationManager';
import { clearMockConfig, setMockConfig, window } from '../helpers/mockVscode';
import type { Conversation } from '../../src/types';

const STORAGE_KEY = 'mysti.conversations';
const CORRUPT_PREFIX = 'mysti.conversations.corrupt.';

function createMockContext(initialStore?: Record<string, unknown>) {
  const store: Record<string, unknown> = { ...(initialStore || {}) };
  return {
    store,
    context: {
      globalState: {
        get: <T>(key: string, defaultValue?: T): T =>
          (key in store ? store[key] : defaultValue) as T,
        update: async (key: string, value: unknown) => { store[key] = value; },
      },
    } as any,
  };
}

function parkedKeys(store: Record<string, unknown>): string[] {
  return Object.keys(store).filter(k => k.startsWith(CORRUPT_PREFIX));
}

function legacyConversation(id: string): Conversation {
  return {
    id,
    title: `Conversation ${id}`,
    messages: [{ id: `${id}-m1`, role: 'user', content: 'hello', timestamp: 1000 }],
    createdAt: 1000,
    updatedAt: 2000,
    mode: 'ask-before-edit',
    model: 'claude-sonnet-4-5-20250929',
    provider: 'claude-code',
  };
}

describe('ConversationManager — unreadable store never breaks activation (D-1)', () => {
  beforeEach(() => {
    clearMockConfig();
    vi.restoreAllMocks();
  });

  // Each of these threw a TypeError out of `new Map(stored.conversations)`
  // before the fix, i.e. out of the constructor, i.e. out of activate().
  const malformed: Array<[string, unknown]> = [
    ['a Record instead of entry pairs', { conversations: { a: legacyConversation('a') }, currentId: null }],
    ['a string', { conversations: 'abc', currentId: null }],
    ['scalar elements', { conversations: [1, 2], currentId: null }],
    ['a null element', { conversations: [null], currentId: null }],
    ['a non-object top level', 'not-an-object'],
    ['an array top level', [['a', legacyConversation('a')]]],
  ];

  for (const [label, blob] of malformed) {
    it(`starts empty instead of throwing when the stored blob is ${label}`, async () => {
      const warn = vi.spyOn(window, 'showWarningMessage');
      const before = JSON.parse(JSON.stringify(blob));
      const { store, context } = createMockContext({ [STORAGE_KEY]: blob });

      let manager!: ConversationManager;
      expect(() => { manager = new ConversationManager(context); }).not.toThrow();

      // Usable: the constructor fell back to a fresh conversation.
      expect(manager.getCurrentConversation()).not.toBeNull();
      expect(manager.getLoadDiagnostic()).not.toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);

      // Nothing was destroyed: the original bytes are parked verbatim.
      await Promise.resolve();
      const parked = parkedKeys(store);
      expect(parked).toHaveLength(1);
      // A DEEP snapshot taken before construction. `expect(store[parked[0]])
      // .toEqual(blob)` compared the object with itself — the mock stores by
      // reference and the park kept that same reference — so it passed even
      // when the loader mutated the blob before parking it.
      expect(JSON.parse(JSON.stringify(store[parked[0]]))).toEqual(before);

      // ...and the live key now holds a valid, stamped store.
      const saved = store[STORAGE_KEY] as { schemaVersion: number; conversations: unknown[] };
      expect(saved.schemaVersion).toBe(CONVERSATIONS_SCHEMA_VERSION);
      expect(Array.isArray(saved.conversations)).toBe(true);
    });
  }

  it('keeps the readable conversations and parks the blob when only SOME entries are bad', async () => {
    const good = legacyConversation('good-1');
    const { store, context } = createMockContext({
      [STORAGE_KEY]: {
        conversations: [['good-1', good], null, ['', good], ['bad', { title: 'no messages array' }]],
        currentId: 'good-1',
      },
    });

    const manager = new ConversationManager(context);
    expect(manager.getAllConversations().map(c => c.id)).toEqual(['good-1']);
    expect(manager.getCurrentConversation()!.id).toBe('good-1');

    await Promise.resolve();
    expect(parkedKeys(store)).toHaveLength(1);
    expect(manager.getLoadDiagnostic()).toContain('3 stored conversation entries were not readable');
  });

  it('drops a currentId that does not name a surviving conversation', () => {
    const { context } = createMockContext({
      [STORAGE_KEY]: {
        conversations: [['keep', legacyConversation('keep')]],
        currentId: 'gone',
      },
    });
    const manager = new ConversationManager(context);
    expect(manager.getConversation('keep')).not.toBeNull();
    expect(manager.getCurrentConversation()).toBeNull();
  });

  it('loads the unstamped v0.4.0 shape untouched, and re-saves it stamped', async () => {
    const legacy = legacyConversation('v040');
    const { store, context } = createMockContext({
      [STORAGE_KEY]: { conversations: [['v040', legacy]], currentId: 'v040' },
    });
    const warn = vi.spyOn(window, 'showWarningMessage');

    const manager = new ConversationManager(context);
    expect(manager.getConversation('v040')!.messages).toHaveLength(1);
    expect(manager.getLoadDiagnostic()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(parkedKeys(store)).toHaveLength(0);

    manager.updateConversationTitle('v040', 'renamed');
    await Promise.resolve();
    expect((store[STORAGE_KEY] as { schemaVersion: number }).schemaVersion)
      .toBe(CONVERSATIONS_SCHEMA_VERSION);
  });

  it('refuses to read OR overwrite a blob written by a newer Mysti', async () => {
    const future = {
      schemaVersion: CONVERSATIONS_SCHEMA_VERSION + 1,
      conversations: [['future-1', legacyConversation('future-1')]],
      currentId: 'future-1',
    };
    const { store, context } = createMockContext({ [STORAGE_KEY]: future });
    const warn = vi.spyOn(window, 'showWarningMessage');

    const manager = new ConversationManager(context);
    expect(manager.getConversation('future-1')).toBeNull();
    expect(manager.isPersistenceDisabled()).toBe(true);
    expect(manager.getLoadDiagnostic()).toContain('newer version of Mysti');
    expect(warn).toHaveBeenCalledTimes(1);

    // The user's history survives the downgrade: byte-identical, not parked.
    manager.addMessage('user', 'this session is not persisted');
    await Promise.resolve();
    expect(store[STORAGE_KEY]).toEqual(future);
    expect(parkedKeys(store)).toHaveLength(0);
  });

  it('survives a globalState read that throws, and then refuses to write over it', async () => {
    const store: Record<string, unknown> = { [STORAGE_KEY]: { conversations: [], currentId: null } };
    const context = {
      globalState: {
        get: () => { throw new Error('state.vscdb is locked'); },
        update: async (key: string, value: unknown) => { store[key] = value; },
      },
    } as any;

    let manager!: ConversationManager;
    expect(() => { manager = new ConversationManager(context); }).not.toThrow();
    expect(manager.isPersistenceDisabled()).toBe(true);
    expect(manager.getCurrentConversation()).not.toBeNull();

    await Promise.resolve();
    expect(store[STORAGE_KEY]).toEqual({ conversations: [], currentId: null });
  });

  it('never rejects when the underlying globalState write fails', async () => {
    const context = {
      globalState: {
        get: () => undefined,
        update: async () => { throw new Error('disk full'); },
      },
    } as any;
    const error = vi.spyOn(window, 'showErrorMessage');

    const manager = new ConversationManager(context);
    // Every one of the 16 internal call sites floats this promise, so a
    // rejection here is an unhandled rejection, not a signal anyone consumes.
    await expect((manager as any)._saveConversations()).resolves.toBe(false);
    expect(error).toHaveBeenCalled();
  });
});

describe('ConversationManager — the storage guard lives in the store (D-2)', () => {
  beforeEach(() => {
    clearMockConfig();
    vi.restoreAllMocks();
  });

  const BIG = 'x'.repeat(200_000);

  function mystiExport(extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      format: 'mysti',
      version: 1,
      conversation: {
        id: 'imported-1',
        title: 'Imported',
        messages: [{
          id: 'm1',
          role: 'user',
          content: 'hi',
          timestamp: 1,
          attachments: [{
            id: 'a1', type: 'image', fileName: 'huge.png',
            mimeType: 'image/png', size: 200_000, base64Data: BIG,
          }],
          toolCalls: [{
            id: 't1', name: 'Write', input: { content: BIG }, output: BIG, status: 'completed',
          }],
        }],
        ...extra,
      },
    });
  }

  it('strips base64 and caps tool strings on the IMPORT path, not just the send path', async () => {
    const { store, context } = createMockContext();
    const manager = new ConversationManager(context);

    const imported = manager.importFromContent(mystiExport(), 'chat.mysti.json');
    expect(imported).not.toBeNull();

    const message = imported!.messages[0];
    expect(message.attachments![0].base64Data).toBeUndefined();
    // The attachment card itself is kept — only the payload is dropped.
    expect(message.attachments![0].fileName).toBe('huge.png');
    expect((message.toolCalls![0].input.content as string).length).toBe(PERSISTED_TOOL_STRING_CAP);
    expect(message.toolCalls![0].output!.length).toBe(PERSISTED_TOOL_STRING_CAP);
    expect(message.toolCalls![0].truncated).toBe(true);

    await Promise.resolve();
    const blob = JSON.stringify(store[STORAGE_KEY]);
    expect(blob).not.toContain(BIG);
    expect(blob.length).toBeLessThan(50_000);
  });

  it('never persists a provider id that is not a ProviderType', async () => {
    setMockConfig('defaultProvider', 'openai-codex');
    const { store, context } = createMockContext();
    const manager = new ConversationManager(context);

    const imported = manager.importFromContent(mystiExport(), 'chat.mysti.json');
    expect(imported!.provider).toBe('openai-codex');

    await Promise.resolve();
    expect(JSON.stringify(store[STORAGE_KEY])).not.toContain('"imported"');
  });

  it('keeps a valid provider id from the imported file', () => {
    const { context } = createMockContext();
    const manager = new ConversationManager(context);
    const imported = manager.importFromContent(mystiExport({ provider: 'google-gemini' }), 'chat.mysti.json');
    expect(imported!.provider).toBe('google-gemini');
  });

  it('strips base64 on the in-place update path too', () => {
    const { context } = createMockContext();
    const manager = new ConversationManager(context);
    const conversation = manager.getCurrentConversation()!;
    const message = manager.addMessageToConversation(conversation.id, 'user', 'hi');

    manager.updateMessageInConversation(conversation.id, message.id, {
      attachments: [{
        id: 'a1', type: 'image', fileName: 'huge.png',
        mimeType: 'image/png', size: 200_000, base64Data: BIG,
      }],
      toolCalls: [{ id: 't1', name: 'Write', input: { content: BIG }, output: BIG, status: 'completed' }],
    });

    const stored = manager.getConversation(conversation.id)!.messages[0];
    expect(stored.attachments![0].base64Data).toBeUndefined();
    expect((stored.toolCalls![0].input.content as string).length).toBe(PERSISTED_TOOL_STRING_CAP);
  });

  it('does not duplicate an oversized payload when forking a pre-guard conversation', () => {
    const dirty: Conversation = {
      ...legacyConversation('dirty'),
      messages: [{
        id: 'dm1', role: 'user', content: 'hi', timestamp: 1,
        attachments: [{
          id: 'a1', type: 'image', fileName: 'huge.png',
          mimeType: 'image/png', size: 200_000, base64Data: BIG,
        }],
      }],
    };
    const { context } = createMockContext({
      [STORAGE_KEY]: { conversations: [['dirty', dirty]], currentId: 'dirty' },
    });
    const manager = new ConversationManager(context);

    const fork = manager.forkConversation('dirty', 'dm1');
    expect(fork).not.toBeNull();
    expect(fork!.messages[0].attachments![0].base64Data).toBeUndefined();
    // The source is untouched.
    expect(manager.getConversation('dirty')!.messages[0].attachments![0].base64Data).toBe(BIG);
  });
});

describe('Plan 27 gate — partial corruption is neither silent nor self-multiplying', () => {
  beforeEach(() => { clearMockConfig(); vi.restoreAllMocks(); });

  const good = legacyConversation('a');

  function storeWith(messages: unknown[]) {
    return {
      schemaVersion: CONVERSATIONS_SCHEMA_VERSION,
      conversations: [['a', { ...good, messages }]],
      currentId: 'a',
    };
  }

  it('a dropped MESSAGE is reported and parked, not silently deleted', () => {
    // These elements used to vanish with no park, getLoadDiagnostic() === null,
    // zero warnings — and the next save wrote the deletion through. The loader
    // this replaced kept and re-persisted them.
    const blob = storeWith([good.messages[0], 'CORRUPTED-DATA', 42]);
    const before = JSON.parse(JSON.stringify(blob));
    const { store, context } = createMockContext({ [STORAGE_KEY]: blob });
    const warn = vi.spyOn(window, 'showWarningMessage');

    const mgr = new ConversationManager(context);

    expect(mgr.getConversation('a')!.messages).toHaveLength(1);
    expect(mgr.getLoadDiagnostic()).toContain('2 stored messages were not readable');
    expect(warn).toHaveBeenCalled();
    const parked = parkedKeys(store);
    expect(parked).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(store[parked[0]]))).toEqual(before);
  });

  it('the parked copy keeps the elements that were dropped from the live store', () => {
    const blob = storeWith([good.messages[0], 'SCALAR-MESSAGE']);
    const { store, context } = createMockContext({ [STORAGE_KEY]: blob });

    new ConversationManager(context);

    const parked = parkedKeys(store);
    expect(JSON.stringify(store[parked[0]])).toContain('SCALAR-MESSAGE');
  });

  it('repairs the live key so a later activation does not park another copy', () => {
    // With survivors present the constructor does not mint a fresh conversation,
    // so nothing rewrote the malformed live value and every activation parked a
    // full duplicate under a new timestamped key that nothing ever deletes.
    const { store, context } = createMockContext({
      [STORAGE_KEY]: storeWith([good.messages[0], 'CORRUPTED-DATA']),
    });

    new ConversationManager(context);
    expect(parkedKeys(store)).toHaveLength(1);

    for (let i = 0; i < 4; i++) { new ConversationManager(context); }

    expect(parkedKeys(store), 'each activation parked another full copy').toHaveLength(1);
    const live = store[STORAGE_KEY] as { conversations: Array<[string, { messages: unknown[] }]> };
    expect(live.conversations[0][1].messages).toHaveLength(1);
  });

  it('does not mutate the value the memento handed back', () => {
    const blob = storeWith([good.messages[0], 'SCALAR-MESSAGE']);
    const { context } = createMockContext({ [STORAGE_KEY]: blob });

    new ConversationManager(context);

    expect((blob.conversations[0][1] as { messages: unknown[] }).messages).toHaveLength(2);
  });
});
