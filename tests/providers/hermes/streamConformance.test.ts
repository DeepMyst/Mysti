/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Hermes ACP stream-conformance fixture: a full turn over the real
 * transport shape — handshake responses, session/update notifications,
 * tool lifecycle, and the final prompt response. Asserts the normalized
 * stream contract (kinds stamped, tools resolve, parser never emits done).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { ChildProcess } from 'child_process';
import { TestableHermesProvider } from '../../helpers/providerFactory';
import { createHermesSession } from '../../helpers/sessionFactory';
import type { HermesSessionState } from '../../../src/providers/hermes/HermesProvider';
import type { Settings } from '../../../src/types';
import { runFixture, expectStreamConformance, toolUsesById } from '../../helpers/fixtureRunner';

describe('HermesProvider stream conformance (ACP fixture)', () => {
  let provider: TestableHermesProvider;
  let session: HermesSessionState;

  const upd = (u: Record<string, unknown>) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'hm_sess_01', update: u } });

  const FIXTURE = [
    // Handshake responses (requests were written to stdin by the provider)
    { jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } },
    { jsonrpc: '2.0', id: 2, result: { sessionId: 'hm_sess_01' } },
    // Streamed turn
    upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Editing the file then running the tests.' } }),
    upd({ sessionUpdate: 'tool_call', toolCallId: 'hm_tc_01', title: 'edit', kind: 'edit', status: 'pending', rawInput: { path: '/src/a.ts' } }),
    upd({ sessionUpdate: 'tool_call_update', toolCallId: 'hm_tc_01', status: 'in_progress' }),
    upd({ sessionUpdate: 'tool_call_update', toolCallId: 'hm_tc_01', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'edited' } }] }),
    upd({ sessionUpdate: 'tool_call', toolCallId: 'hm_tc_02', title: 'bash', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } }),
    upd({ sessionUpdate: 'tool_call_update', toolCallId: 'hm_tc_02', status: 'completed', rawOutput: 'all green' }),
    upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' Done.' } }),
    upd({ sessionUpdate: 'usage_update', size: 200000, used: 12000 }),
    // Prompt response — the response boundary
    { jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn', usage: { inputTokens: 1200, outputTokens: 300 } } },
  ];

  beforeEach(() => {
    provider = new TestableHermesProvider();
    session = createHermesSession();
    session.persistentProcess = {
      stdin: { writable: true, write: () => true }
    } as unknown as ChildProcess;
    provider.buildPersistentCliArgs(
      { mode: 'default', thinkingLevel: 'none', accessLevel: 'ask-permission', contextMode: 'auto', model: '', provider: 'hermes' } as Settings,
      session
    );
    provider.formatPersistentInput('edit and test', session);
  });

  it('conforms to the normalized stream contract', () => {
    const chunks = runFixture(provider, session, FIXTURE);
    expectStreamConformance(chunks, { emitsToolResults: true });
  });

  it('streams text, resolves both tools, and captures usage', () => {
    const chunks = runFixture(provider, session, FIXTURE);

    const text = chunks.filter(c => c.type === 'text').map(c => c.content).join('');
    expect(text).toBe('Editing the file then running the tests. Done.');

    const editUses = toolUsesById(chunks, 'hm_tc_01');
    const bashUses = toolUsesById(chunks, 'hm_tc_02');
    expect(editUses.length).toBeGreaterThan(0);
    expect(bashUses.length).toBeGreaterThan(0);
    expect(editUses.every(c => c.toolCall?.name === 'Edit' && c.toolCall?.kind === 'edit')).toBe(true);
    expect(bashUses.every(c => c.toolCall?.name === 'Bash' && c.toolCall?.kind === 'execute')).toBe(true);

    const results = chunks.filter(c => c.type === 'tool_result');
    expect(results.map(c => c.toolCall?.output)).toEqual(['edited', 'all green']);

    expect(session.lastUsageStats).toEqual({ input_tokens: 1200, output_tokens: 300 });
  });

  it('the boundary line is the prompt response and nothing earlier', () => {
    const lines = FIXTURE.map(e => JSON.stringify(e));
    const boundaries = lines.map(l => provider.isResponseBoundary(l));
    expect(boundaries.slice(0, -1).every(b => b === false)).toBe(true);
    expect(boundaries[boundaries.length - 1]).toBe(true);
  });
});
