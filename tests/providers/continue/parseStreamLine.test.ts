/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * ContinueProvider output parsing: plain-text lines with newline
 * reconstruction, <think> block extraction (single- and multi-line),
 * and interim JSON status suppression.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TestableContinueProvider } from '../../helpers/providerFactory';
import { createContinueSession } from '../../helpers/sessionFactory';
import type { ContinueSessionState } from '../../../src/providers/continue/ContinueProvider';
import { runFixture, expectStreamConformance } from '../../helpers/fixtureRunner';

describe('Continue parseStreamLine', () => {
  let provider: TestableContinueProvider;
  let session: ContinueSessionState;

  beforeEach(() => {
    provider = new TestableContinueProvider();
    session = createContinueSession();
  });

  it('re-appends the newline the base splitter removed', () => {
    expect(provider.parseStreamLine('Hello world', session)).toEqual({ type: 'text', content: 'Hello world\n' });
  });

  it('extracts a multi-line <think> block as thinking chunks', () => {
    const lines = ['<think>', 'step one', 'step two', '</think>', 'The answer is 42.'];
    const chunks = lines.map(l => provider.parseStreamLine(l, session)).filter(Boolean);

    expect(chunks.map(c => c!.type)).toEqual(['thinking', 'thinking', 'text']);
    expect(chunks[0]!.content).toBe('step one\n');
    expect(chunks[1]!.content).toBe('step two\n');
    expect(chunks[2]!.content).toBe('The answer is 42.\n');
    expect(session.inThinkBlock).toBe(false);
  });

  it('handles a complete <think>…</think> on one line', () => {
    const chunk = provider.parseStreamLine('<think>quick thought</think>', session);
    expect(chunk).toEqual({ type: 'thinking', content: 'quick thought\n' });
    expect(session.inThinkBlock).toBe(false);
  });

  it('preserves surrounding response text when tags and prose share a line', () => {
    const chunk = provider.parseStreamLine('Answer: <think>hidden</think> 42', session);
    expect(chunk?.type).toBe('text');
    expect(chunk?.content).toContain('Answer:');
    expect(chunk?.content).toContain('42');
    expect(chunk?.content).not.toContain('<think>');
    expect(chunk?.content).not.toContain('hidden');
  });

  it('never drops response text after a closing tag mid-line', () => {
    provider.parseStreamLine('<think>', session);
    const chunk = provider.parseStreamLine('done</think> Result follows.', session);
    expect(chunk?.type).toBe('text');
    expect(chunk?.content).toBe('Result follows.\n');
    expect(session.inThinkBlock).toBe(false);
  });

  it('never drops response text preceding an opening tag that spans lines', () => {
    // 'Intro.' is the answer — must survive even though <think> opens after it
    const chunk = provider.parseStreamLine('Intro.<think>reasoning continues', session);
    expect(chunk?.type).toBe('text');
    expect(chunk?.content).toBe('Intro.\n');
    expect(session.inThinkBlock).toBe(true);
    // Following lines are thinking until the close tag
    const next = provider.parseStreamLine('still thinking</think>', session);
    expect(next?.type).toBe('thinking');
    expect(session.inThinkBlock).toBe(false);
  });

  it("passes through the model's own JSON-shaped answers as text (no status filtering)", () => {
    // We never pass --format json, so cn emits no status envelopes to filter;
    // a JSON-shaped line is the model's content and must not be swallowed.
    for (const jsonAnswer of ['{"result": [1, 2, 3]}', '{"status": "ok", "message": "hi"}']) {
      const chunk = provider.parseStreamLine(jsonAnswer, session);
      expect(chunk?.type).toBe('text');
      expect(chunk?.content).toBe(jsonAnswer + '\n');
    }
  });

  it('buildCliArgs resets think-block state between runs', () => {
    provider.parseStreamLine('<think>', session);
    expect(session.inThinkBlock).toBe(true);
    provider.buildCliArgs({ mode: 'default', thinkingLevel: 'none', accessLevel: 'full-access', contextMode: 'auto', model: '', provider: 'continue' } as never, session);
    expect(session.inThinkBlock).toBe(false);
  });

  it('conforms to the normalized stream contract (no done, no tool chunks)', () => {
    const chunks = runFixture(provider, session, [
      '<think>',
      'planning',
      '</think>',
      'Here is the fix:',
      '```ts',
      'const x = 1;',
      '```',
    ]);
    expectStreamConformance(chunks, { emitsToolResults: false });
    expect(chunks.filter(c => c.type === 'tool_use')).toHaveLength(0);
    const text = chunks.filter(c => c.type === 'text').map(c => c.content).join('');
    expect(text).toBe('Here is the fix:\n```ts\nconst x = 1;\n```\n');
  });
});
