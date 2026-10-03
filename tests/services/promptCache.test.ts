/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Explicit prompt-cache breakpoints for the coordinator's own model calls.
 */

import { describe, it, expect } from 'vitest';
import {
  applyCacheBreakpoints,
  supportsExplicitCacheControl,
  readCacheTokens,
} from '../../src/services/PromptCache';

/** A block long enough to clear Anthropic's minimum cacheable size. */
const BIG = 'x'.repeat(2048 * 4 + 1);

interface Msg { role: string; content: unknown; name?: string }

function partsOf(m: Msg): Array<Record<string, unknown>> {
  expect(Array.isArray(m.content)).toBe(true);
  return m.content as Array<Record<string, unknown>>;
}

describe('PromptCache', () => {
  describe('which models get an explicit breakpoint', () => {
    it('marks Anthropic models, which cache nothing without one', () => {
      expect(supportsExplicitCacheControl('anthropic/claude-sonnet-5')).toBe(true);
      expect(supportsExplicitCacheControl('claude-opus-5')).toBe(true);
      expect(supportsExplicitCacheControl('haiku-4-5')).toBe(true);
    });

    it('leaves models that cache automatically alone', () => {
      // Sending these a cache_control part is at best ignored and at worst a
      // 400 — and they already cache long prefixes on their own.
      expect(supportsExplicitCacheControl('gpt-6')).toBe(false);
      expect(supportsExplicitCacheControl('google/gemini-3.5-flash')).toBe(false);
      expect(supportsExplicitCacheControl(undefined)).toBe(false);
    });

    it('returns the array untouched for a non-Anthropic model', () => {
      const messages: Msg[] = [{ role: 'system', content: BIG }, { role: 'user', content: BIG }];
      expect(applyCacheBreakpoints(messages, 'gpt-6')).toBe(messages);
    });
  });

  describe('where the breakpoints land', () => {
    it('marks the system prompt — the block re-sent on every round-trip', () => {
      const out = applyCacheBreakpoints<Msg>(
        [{ role: 'system', content: BIG }, { role: 'user', content: 'hi' }],
        'anthropic/claude-sonnet-5',
      );
      const parts = partsOf(out[0]);
      expect(parts[0].type).toBe('text');
      expect(parts[0].text).toBe(BIG);
      expect(parts[0].cache_control).toEqual({ type: 'ephemeral' });
      // The short trailing user message has nothing worth a write premium.
      expect(out[1].content).toBe('hi');
    });

    it('marks the last user message once there is real prefix ahead of it', () => {
      const out = applyCacheBreakpoints<Msg>(
        [
          { role: 'system', content: BIG },
          { role: 'user', content: 'first' },
          { role: 'assistant', content: BIG },
          { role: 'user', content: 'follow-up' },
        ],
        'claude-opus-5',
      );
      expect(Array.isArray(out[0].content)).toBe(true);
      expect(Array.isArray(out[3].content)).toBe(true);
      // Only the LAST user message — two breakpoints, not one per turn.
      expect(out[1].content).toBe('first');
    });

    it('never rewrites tool or assistant messages', () => {
      // Their shape varies by provider (tool_calls arrays, tool_call_id pairing)
      // and a rewrite risks breaking call/result pairing for a marginal gain.
      const out = applyCacheBreakpoints<Msg>(
        [
          { role: 'system', content: BIG },
          { role: 'user', content: BIG },
          { role: 'assistant', content: BIG },
          { role: 'tool', content: BIG, name: 'read' },
        ],
        'claude-opus-5',
      );
      expect(out[2].content).toBe(BIG);
      expect(out[3].content).toBe(BIG);
      expect(out[3].name).toBe('read');
    });

    it('skips a prefix below the minimum cacheable size', () => {
      // Marking a sub-1024-token block buys the write premium for something the
      // API refuses to cache — strictly worse than not marking it.
      const messages: Msg[] = [{ role: 'system', content: 'short' }, { role: 'user', content: 'hi' }];
      expect(applyCacheBreakpoints(messages, 'claude-opus-5')).toBe(messages);
    });

    it('does not mutate the caller’s array', () => {
      const messages: Msg[] = [{ role: 'system', content: BIG }];
      const out = applyCacheBreakpoints(messages, 'claude-opus-5');
      expect(out).not.toBe(messages);
      expect(messages[0].content).toBe(BIG);
    });

    it('leaves content already in parts form alone', () => {
      const parts = [{ type: 'text', text: BIG }];
      const out = applyCacheBreakpoints<Msg>([{ role: 'system', content: parts }], 'claude-opus-5');
      expect(out[0].content).toBe(parts);
    });

    it('handles an empty array', () => {
      const empty: Msg[] = [];
      expect(applyCacheBreakpoints(empty, 'claude-opus-5')).toBe(empty);
    });
  });

  describe('reading cache figures back off a usage frame', () => {
    it('reads the OpenAI prompt_tokens_details shape', () => {
      expect(readCacheTokens({ prompt_tokens: 100_000, prompt_tokens_details: { cached_tokens: 90_000 } }))
        .toEqual({ cacheReadTokens: 90_000 });
    });

    it('reads the Anthropic passthrough shape', () => {
      expect(readCacheTokens({ cache_read_input_tokens: 5, cache_creation_input_tokens: 7 }))
        .toEqual({ cacheReadTokens: 5, cacheCreationTokens: 7 });
    });

    it('omits fields rather than reporting a zero it did not measure', () => {
      expect(readCacheTokens({ prompt_tokens: 10 })).toEqual({});
      expect(readCacheTokens({ prompt_tokens_details: { cached_tokens: 0 } })).toEqual({});
      expect(readCacheTokens(undefined)).toEqual({});
      expect(readCacheTokens('nonsense')).toEqual({});
    });
  });
});
