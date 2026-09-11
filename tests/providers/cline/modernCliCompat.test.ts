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
 * Cline 2.0 renamed every flag Mysti used and replaced the entire event
 * vocabulary. Against 3.0.61 the old invocation died on the first argument:
 *
 *   $ cline --output-format json --mode act --yolo
 *   error: unknown option '--output-format'
 *
 * These historical event parsers remain useful for saved streams. Public turns
 * now use the native ACP approval transport.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TestableClineProvider } from '../../helpers/providerFactory';
import { createClineSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';

/** Lines captured verbatim from `cline --json "say hi in 3 words"` on 3.0.61. */
const REAL_3X_STREAM = [
  '{"ts":"2026-09-06T10:40:48.417Z","type":"hook_event","hookEventName":"agent_start","agentId":"agent_1","taskId":"conv_1","parentAgentId":null}',
  '{"ts":"2026-09-06T10:40:48.418Z","type":"agent_event","event":{"type":"iteration_start","iteration":1}}',
  '{"ts":"2026-09-06T10:40:58.661Z","type":"agent_event","event":{"type":"content_start","contentType":"text","text":"Hi","accumulated":"Hi"}}',
  '{"ts":"2026-09-06T10:40:58.661Z","type":"agent_event","event":{"type":"content_start","contentType":"text","text":" there","accumulated":"Hi there"}}',
  '{"ts":"2026-09-06T10:40:58.698Z","type":"agent_event","event":{"type":"usage","inputTokens":95077,"outputTokens":5,"cost":0.024}}',
  '{"ts":"2026-09-06T10:40:58.700Z","type":"agent_event","event":{"type":"content_end","contentType":"text","text":"Hi there"}}',
  '{"ts":"2026-09-06T10:40:58.704Z","type":"agent_event","event":{"type":"iteration_end","iteration":1,"hadToolCalls":false,"toolCallCount":0}}',
  '{"ts":"2026-09-06T10:40:58.705Z","type":"agent_event","event":{"type":"done","reason":"completed","text":"Hi there","iterations":1}}',
  '{"ts":"2026-09-06T10:40:58.899Z","type":"run_result","finishReason":"completed","usage":{"inputTokens":95077,"outputTokens":5},"text":"Hi there"}',
];


/** Pretend discovery probed this `--version` output. */
function withVersion(provider: TestableClineProvider, version: string | null) {
  (provider as unknown as { _cachedCliVersion: string | null })._cachedCliVersion = version;
}

let provider: TestableClineProvider;

beforeEach(() => {
  clearMockConfig();
  provider = new TestableClineProvider();
});

describe('Cline 2.x+ stream parsing', () => {
  it('reads a real 3.0.61 turn into the expected chunks', () => {
    withVersion(provider, '3.0.61');
    const session = createClineSession();
    const chunks = REAL_3X_STREAM
      .map((line) => provider.parseStreamLine(line, session))
      .filter((c): c is NonNullable<typeof c> => !!c);

    const text = chunks.filter((c) => c.type === 'text').map((c) => c.content).join('');
    expect(text).toBe('Hi there');
    expect(chunks.some((c) => c.type === 'error')).toBe(false);
  });

  /**
   * `text` is the delta and `accumulated` the running total. Emitting both — or
   * the wrong one — repeats every character of the answer.
   */
  it('streams the delta, never the accumulated total', () => {
    withVersion(provider, '3.0.61');
    const session = createClineSession();
    const chunk = provider.parseStreamLine(
      '{"type":"agent_event","event":{"type":"content_start","contentType":"text","text":" there","accumulated":"Hi there"}}',
      session,
    );
    expect(chunk).toEqual({ type: 'text', content: ' there' });
  });

  it('routes thinking content away from the answer', () => {
    withVersion(provider, '3.0.61');
    const chunk = provider.parseStreamLine(
      '{"type":"agent_event","event":{"type":"content_start","contentType":"thinking","text":"hmm"}}',
      createClineSession(),
    );
    expect(chunk).toEqual({ type: 'thinking', content: 'hmm' });
  });

  it('records usage without emitting a chunk for it', () => {
    const session = createClineSession();
    const chunk = provider.parseStreamLine(
      '{"type":"agent_event","event":{"type":"usage","inputTokens":95077,"outputTokens":5}}',
      session,
    );
    expect(chunk).toBeNull();
    expect(session.lastUsageStats).toEqual({ input_tokens: 95077, output_tokens: 5 });
  });

  /** `done` repeats the whole answer that was already streamed delta by delta. */
  it('does not re-emit the answer carried by done', () => {
    const session = createClineSession();
    expect(provider.parseStreamLine(
      '{"type":"agent_event","event":{"type":"done","reason":"completed","text":"Hi there"}}',
      session,
    )).toBeNull();
    expect(provider.parseStreamLine(
      '{"type":"run_result","finishReason":"completed","text":"Hi there","usage":{"inputTokens":1,"outputTokens":2}}',
      session,
    )).toBeNull();
  });

  it('surfaces a failed run as an error', () => {
    const chunk = provider.parseStreamLine(
      '{"type":"run_result","finishReason":"max_iterations","text":""}',
      createClineSession(),
    );
    expect(chunk?.type).toBe('error');
  });

  it('ignores lifecycle noise', () => {
    const session = createClineSession();
    for (const line of [
      '{"type":"hook_event","hookEventName":"agent_start"}',
      '{"type":"agent_event","event":{"type":"iteration_start","iteration":1}}',
      '{"type":"agent_event","event":{"type":"iteration_end","iteration":1}}',
    ]) {
      expect(provider.parseStreamLine(line, session)).toBeNull();
    }
  });

  /**
   * The two formats coexist because the payload says which it is — a user on
   * either CLI works without Mysti getting a version check right at parse time.
   */
  it('still understands the 1.x vocabulary', () => {
    const session = createClineSession();
    expect(provider.parseStreamLine(
      '{"type":"say","say":"completion_result","text":"done"}',
      session,
    )).toEqual({ type: 'text', content: 'done' });
  });
});
