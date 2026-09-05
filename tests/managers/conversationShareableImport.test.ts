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
 * Plan 27 lane G (G-1) — `importFromShareable` is reachable from the
 * UNAUTHENTICATED `vscode://…/import?data=…` deep link, so its payload is the
 * least trusted input the conversation store ever persists. Every field must
 * land coerced (provider), capped (content, title, message count, inflated
 * bytes) or dropped (non-record elements, non-array `m`) — never thrown, never
 * persisted raw.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as zlib from 'zlib';
import {
  ConversationManager,
  SHAREABLE_CONTENT_CAP,
  SHAREABLE_MESSAGE_LIMIT,
} from '../../src/managers/ConversationManager';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';
import type * as vscode from 'vscode';

const STORAGE_KEY = 'mysti.conversations';

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
    } as unknown as vscode.ExtensionContext,
  };
}

/** Encode an arbitrary JSON value exactly the way `exportToShareable` does. */
function encode(payload: unknown): string {
  return zlib.deflateSync(Buffer.from(JSON.stringify(payload))).toString('base64url');
}

describe('ConversationManager.importFromShareable — deep-link payload hardening (G-1)', () => {
  beforeEach(() => {
    clearMockConfig();
  });

  it('round-trips a legitimate export (sanity)', () => {
    const { context } = createMockContext();
    const manager = new ConversationManager(context);
    const conv = manager.getCurrentConversation()!;
    manager.addMessage('user', 'hello there');
    manager.addMessage('assistant', 'hi');
    manager.updateConversationSettings({ provider: 'google-gemini' });

    const imported = manager.importFromShareable(manager.exportToShareable(conv.id));
    expect(imported).not.toBeNull();
    expect(imported!.messages.map(m => m.content)).toEqual(['hello there', 'hi']);
    expect(imported!.messages.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(imported!.provider).toBe('google-gemini');
  });

  it('never persists a provider id that is not a ProviderType', async () => {
    setMockConfig('defaultProvider', 'openai-codex');
    const { store, context } = createMockContext();
    const manager = new ConversationManager(context);

    const imported = manager.importFromShareable(encode({
      t: 'Shared',
      p: 'evil-provider',
      m: [{ r: 'u', c: 'hi' }],
    }));
    expect(imported).not.toBeNull();
    expect(imported!.provider).toBe('openai-codex');

    await Promise.resolve();
    expect(JSON.stringify(store[STORAGE_KEY])).not.toContain('evil-provider');
  });

  it('falls back to a real ProviderType when mysti.defaultProvider is itself not one', async () => {
    // `mysti.defaultProvider` is window-scoped, so a cloned repository's
    // .vscode/settings.json can carry any string. The fallback half of
    // `_coerceProvider` must validate too, or "never persists a non-ProviderType"
    // holds only for the payload half.
    setMockConfig('defaultProvider', 'repo-invented-provider');
    const { store, context } = createMockContext();
    const manager = new ConversationManager(context);

    const imported = manager.importFromShareable(encode({
      t: 'Shared',
      p: 'evil-provider',
      m: [{ r: 'u', c: 'hi' }],
    }));
    expect(imported).not.toBeNull();
    expect(imported!.provider).toBe('claude-code');

    await Promise.resolve();
    const persisted = JSON.stringify(store[STORAGE_KEY]);
    expect(persisted).not.toContain('evil-provider');
    expect(persisted).not.toContain('repo-invented-provider');
  });

  it('caps a 200 KB message at the same length exportToShareable emits', async () => {
    const { store, context } = createMockContext();
    const manager = new ConversationManager(context);
    const huge = 'x'.repeat(200 * 1024);

    const imported = manager.importFromShareable(encode({
      t: 'Shared',
      m: [{ r: 'a', c: huge }],
    }));
    expect(imported).not.toBeNull();
    expect(imported!.messages).toHaveLength(1);
    expect(imported!.messages[0].content.length).toBe(SHAREABLE_CONTENT_CAP);
    expect(SHAREABLE_CONTENT_CAP).toBe(2000);

    await Promise.resolve();
    // Nothing in the persisted blob may carry the raw payload.
    expect(JSON.stringify(store[STORAGE_KEY]).length).toBeLessThan(huge.length);
  });

  it('treats a scalar where the message array is expected as an empty import (no throw, nothing persisted)', async () => {
    for (const m of ['not-an-array', 42, true, { r: 'u', c: 'hi' }, null]) {
      const { store, context } = createMockContext();
      const manager = new ConversationManager(context);
      const before = JSON.stringify(store[STORAGE_KEY]);

      let result: unknown = 'unset';
      expect(() => { result = manager.importFromShareable(encode({ t: 'Shared', m })); }).not.toThrow();
      expect(result).toBeNull();

      await Promise.resolve();
      expect(JSON.stringify(store[STORAGE_KEY])).toBe(before);
      expect(manager.getAllConversations()).toHaveLength(1); // only the constructor's fresh one
    }
  });

  it('drops scalar / null / non-string-content elements and keeps the well-formed ones', async () => {
    const { store, context } = createMockContext();
    const manager = new ConversationManager(context);

    const imported = manager.importFromShareable(encode({
      t: 'Shared',
      m: ['a-bare-string', 42, null, ['nested'], { r: 'u', c: 12345 }, { r: 'u' }, { r: 'u', c: 'kept' }],
    }));
    expect(imported).not.toBeNull();
    expect(imported!.messages).toHaveLength(1);
    expect(imported!.messages[0].content).toBe('kept');
    expect(imported!.messages[0].role).toBe('user');

    await Promise.resolve();
    const persisted = JSON.stringify(store[STORAGE_KEY]);
    expect(persisted).not.toContain('a-bare-string');
    expect(persisted).not.toContain('12345');
    // A message whose content is not a string must never be persisted with
    // a non-string (or missing) content.
    for (const c of imported!.messages) { expect(typeof c.content).toBe('string'); }
  });

  it('coerces a non-string title and caps an oversized one', () => {
    const { context } = createMockContext();
    const manager = new ConversationManager(context);

    const objTitle = manager.importFromShareable(encode({ t: { evil: true }, m: [{ r: 'u', c: 'hi' }] }));
    expect(objTitle!.title).toBe('Shared Conversation');

    const longTitle = manager.importFromShareable(encode({ t: 'T'.repeat(50_000), m: [{ r: 'u', c: 'hi' }] }));
    expect(longTitle!.title.length).toBeLessThan(1000);
    expect(longTitle!.title.length).toBeGreaterThan(0);
  });

  it('keeps at most the number of messages exportToShareable emits', () => {
    const { context } = createMockContext();
    const manager = new ConversationManager(context);
    const many = Array.from({ length: 5_000 }, (_, i) => ({ r: 'u', c: `m${i}` }));

    const imported = manager.importFromShareable(encode({ t: 'Shared', m: many }));
    expect(imported).not.toBeNull();
    expect(imported!.messages.length).toBeLessThanOrEqual(SHAREABLE_MESSAGE_LIMIT);
    expect(SHAREABLE_MESSAGE_LIMIT).toBe(10);
  });

  it('returns null for a non-object top level and for garbage bytes, never throwing', async () => {
    const { store, context } = createMockContext();
    const manager = new ConversationManager(context);
    const before = JSON.stringify(store[STORAGE_KEY]);

    for (const data of [encode('a-string'), encode(null), encode(7), encode([{ r: 'u', c: 'hi' }]), 'not-base64-deflate!!', '']) {
      let result: unknown = 'unset';
      expect(() => { result = manager.importFromShareable(data); }).not.toThrow();
      expect(result).toBeNull();
    }
    await Promise.resolve();
    expect(JSON.stringify(store[STORAGE_KEY])).toBe(before);
  });

  it('refuses a deflate bomb instead of inflating it into memory', () => {
    const { context } = createMockContext();
    const manager = new ConversationManager(context);
    // 64 MB of JSON deflates to well under 100 KB — a URI-sized payload that
    // would otherwise be inflated in full before a single field is checked.
    const bomb = encode({ t: 'Shared', m: [{ r: 'u', c: 'a'.repeat(64 * 1024 * 1024) }] });
    expect(bomb.length).toBeLessThan(100 * 1024);

    let result: unknown = 'unset';
    expect(() => { result = manager.importFromShareable(bomb); }).not.toThrow();
    expect(result).toBeNull();
  });
});
