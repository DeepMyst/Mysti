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
 * Plan 02 Phase 3 — persisted message structure.
 *
 * Covers:
 *  - round-trip of the new Message fields (provider, model, toolCalls,
 *    structured thinking, segments) through globalState and a fresh
 *    ConversationManager (simulated extension-host restart)
 *  - backward compatibility: legacy conversations persisted before Phase 3
 *    (no new fields, plain-string thinking) still load and accept new messages
 *  - the persistence truncation cap for tool inputs/outputs
 *    (PERSISTED_TOOL_STRING_CAP stopgap until Plan 03 Phase 6)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ConversationManager, PERSISTED_TOOL_STRING_CAP } from '../../src/managers/ConversationManager';
import { clearMockConfig } from '../helpers/mockVscode';
import type { Conversation, Message, MessageSegment, MessageThinking, ToolCall } from '../../src/types';

/**
 * Functional globalState store shared across ConversationManager instances,
 * so a second manager constructed over the same store behaves like a reload.
 */
function createMockContext(initialStore?: Record<string, unknown>) {
  const store: Record<string, unknown> = { ...(initialStore || {}) };
  return {
    store,
    context: {
      globalState: {
        get: <T>(key: string, defaultValue?: T): T =>
          (key in store ? store[key] : defaultValue) as T,
        update: async (key: string, value: unknown) => {
          store[key] = value;
        },
      },
    } as any,
  };
}

const STORAGE_KEY = 'mysti.conversations';

describe('ConversationManager — Plan 02 Phase 3 persistence', () => {
  beforeEach(() => {
    clearMockConfig();
  });

  describe('new field round-trip', () => {
    it('persists provider, model, toolCalls, segments, and structured thinking — and survives a reload', () => {
      const { store, context } = createMockContext();
      const manager = new ConversationManager(context);
      const conversation = manager.getCurrentConversation()!;

      const toolCalls: ToolCall[] = [
        {
          id: 'tool-1',
          name: 'Read',
          input: { file_path: '/src/index.ts' },
          output: 'file contents',
          status: 'completed',
          kind: 'read',
        },
      ];
      const segments: MessageSegment[] = [
        { type: 'thinking', content: 'pondering' },
        { type: 'text', content: 'Here is ' },
        { type: 'tool', toolCallId: 'tool-1' },
        { type: 'text', content: 'the answer.' },
      ];
      const thinking: MessageThinking = { style: 'streamed', content: 'pondering' };

      const message = manager.addMessageToConversation(
        conversation.id,
        'assistant',
        'Here is the answer.',
        undefined,
        undefined,
        thinking,
        {
          provider: 'claude-code',
          model: 'claude-opus-4-6',
          toolCalls,
          segments,
        }
      );

      expect(message.provider).toBe('claude-code');
      expect(message.model).toBe('claude-opus-4-6');
      expect(message.thinking).toEqual({ style: 'streamed', content: 'pondering' });
      expect(message.toolCalls).toHaveLength(1);
      expect(message.toolCalls![0].kind).toBe('read');
      expect(message.toolCalls![0].truncated).toBeUndefined();
      expect(message.segments).toEqual(segments);

      // Simulated extension-host restart: a fresh manager over the same store
      const reloadedManager = new ConversationManager({
        globalState: {
          get: <T>(key: string, defaultValue?: T): T =>
            (key in store ? store[key] : defaultValue) as T,
          update: async (key: string, value: unknown) => { store[key] = value; },
        },
      } as any);

      const restored = reloadedManager.getConversation(conversation.id);
      expect(restored).not.toBeNull();
      const restoredMsg = restored!.messages.find(m => m.id === message.id)!;
      expect(restoredMsg.provider).toBe('claude-code');
      expect(restoredMsg.model).toBe('claude-opus-4-6');
      expect(restoredMsg.thinking).toEqual({ style: 'streamed', content: 'pondering' });
      expect(restoredMsg.toolCalls).toEqual(message.toolCalls);
      expect(restoredMsg.segments).toEqual(segments);
    });

    it('omits the new fields entirely when extras are not provided', () => {
      const { context } = createMockContext();
      const manager = new ConversationManager(context);
      const conversation = manager.getCurrentConversation()!;

      const message = manager.addMessageToConversation(
        conversation.id, 'assistant', 'plain response'
      );

      expect('provider' in message).toBe(false);
      expect('model' in message).toBe(false);
      expect('toolCalls' in message).toBe(false);
      expect('segments' in message).toBe(false);
    });

    it('still accepts legacy plain-string thinking', () => {
      const { context } = createMockContext();
      const manager = new ConversationManager(context);
      const conversation = manager.getCurrentConversation()!;

      const message = manager.addMessageToConversation(
        conversation.id, 'assistant', 'response', undefined, undefined, 'raw thinking text'
      );

      expect(message.thinking).toBe('raw thinking text');
    });
  });

  describe('legacy conversation compatibility', () => {
    it('loads conversations persisted before Phase 3 (no new fields) and appends new-style messages', () => {
      // Old-shape persisted state: messages without provider/model/segments,
      // thinking as a plain string, no toolCalls.
      const legacyConversation: Conversation = {
        id: 'legacy-1',
        title: 'Legacy Conversation',
        messages: [
          {
            id: 'legacy-msg-1',
            role: 'user',
            content: 'old question',
            timestamp: 1000,
          },
          {
            id: 'legacy-msg-2',
            role: 'assistant',
            content: 'old answer',
            timestamp: 2000,
            thinking: 'old plain thinking',
          } as Message,
        ],
        createdAt: 1000,
        updatedAt: 2000,
        mode: 'ask-before-edit',
        model: 'claude-sonnet-4-5-20250929',
        provider: 'claude-code',
      };

      const { context } = createMockContext({
        [STORAGE_KEY]: {
          conversations: [['legacy-1', legacyConversation]],
          currentId: 'legacy-1',
        },
      });

      const manager = new ConversationManager(context);
      const restored = manager.getConversation('legacy-1');
      expect(restored).not.toBeNull();
      expect(restored!.messages).toHaveLength(2);
      expect(restored!.messages[1].thinking).toBe('old plain thinking');
      expect(restored!.messages[1].provider).toBeUndefined();
      expect(restored!.messages[1].segments).toBeUndefined();

      // Appending a new-style message to the legacy conversation works
      const appended = manager.addMessageToConversation(
        'legacy-1', 'assistant', 'new answer', undefined, undefined,
        { style: 'complete-blocks', content: 'block thinking' },
        { provider: 'openai-codex', model: 'gpt-5.2-codex' }
      );
      expect(appended.provider).toBe('openai-codex');
      expect(manager.getConversation('legacy-1')!.messages).toHaveLength(3);
    });
  });

  describe('tool input/output truncation cap (Plan 03 Phase 6 stopgap)', () => {
    function persistToolCall(toolCall: ToolCall): Message {
      const { context } = createMockContext();
      const manager = new ConversationManager(context);
      const conversation = manager.getCurrentConversation()!;
      return manager.addMessageToConversation(
        conversation.id, 'assistant', 'done', undefined, undefined, undefined,
        { toolCalls: [toolCall] }
      );
    }

    it('truncates oversized string input fields to the cap and sets the truncated flag', () => {
      const big = 'x'.repeat(PERSISTED_TOOL_STRING_CAP + 5000);
      const message = persistToolCall({
        id: 't1',
        name: 'Write',
        input: { file_path: '/a.ts', content: big },
        status: 'completed',
      });

      const persisted = message.toolCalls![0];
      expect((persisted.input.content as string).length).toBe(PERSISTED_TOOL_STRING_CAP);
      expect(persisted.input.file_path).toBe('/a.ts');
      expect(persisted.truncated).toBe(true);
    });

    it('truncates oversized output to the cap and sets the truncated flag', () => {
      const bigOutput = 'y'.repeat(PERSISTED_TOOL_STRING_CAP * 3);
      const message = persistToolCall({
        id: 't2',
        name: 'Bash',
        input: { command: 'ls' },
        output: bigOutput,
        status: 'completed',
      });

      const persisted = message.toolCalls![0];
      expect(persisted.output!.length).toBe(PERSISTED_TOOL_STRING_CAP);
      expect(persisted.truncated).toBe(true);
    });

    it('leaves small inputs/outputs untouched with no truncated flag', () => {
      const message = persistToolCall({
        id: 't3',
        name: 'Read',
        input: { file_path: '/small.ts' },
        output: 'short output',
        status: 'completed',
      });

      const persisted = message.toolCalls![0];
      expect(persisted.input).toEqual({ file_path: '/small.ts' });
      expect(persisted.output).toBe('short output');
      expect(persisted.truncated).toBeUndefined();
    });

    it('replaces inputs whose nested (non-string) bloat survives per-field capping with a preview stub', () => {
      // 5000 array entries — no single string field exceeds the cap, but the
      // serialized input is far over the whole-input ceiling.
      const hugeArray = Array.from({ length: 5000 }, (_, i) => `item-${i}`);
      const message = persistToolCall({
        id: 't4',
        name: 'Custom',
        input: { items: hugeArray },
        status: 'completed',
      });

      const persisted = message.toolCalls![0];
      expect(typeof persisted.input._preview).toBe('string');
      expect((persisted.input._preview as string).length).toBeLessThanOrEqual(PERSISTED_TOOL_STRING_CAP);
      expect(persisted.truncated).toBe(true);
    });

    it('does not mutate the caller-supplied toolCall objects', () => {
      const big = 'z'.repeat(PERSISTED_TOOL_STRING_CAP * 2);
      const original: ToolCall = {
        id: 't5',
        name: 'Write',
        input: { content: big },
        output: big,
        status: 'completed',
      };
      persistToolCall(original);

      expect((original.input.content as string).length).toBe(big.length);
      expect(original.output!.length).toBe(big.length);
      expect(original.truncated).toBeUndefined();
    });
  });
});
