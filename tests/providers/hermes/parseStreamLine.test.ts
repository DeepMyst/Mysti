/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * HermesProvider ACP parsing: the reactive JSON-RPC handshake
 * (initialize → session/new → session/prompt driven from parseStreamLine),
 * session/update mapping, permission auto-response, and the diagnostic
 * fallback path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { ChildProcess } from 'child_process';
import { Writable } from 'node:stream';
import { TestableHermesProvider } from '../../helpers/providerFactory';
import { createHermesSession } from '../../helpers/sessionFactory';
import type { HermesSessionState } from '../../../src/providers/hermes/HermesProvider';
import type { Settings } from '../../../src/types';

function settings(overrides?: Partial<Settings>): Settings {
  return {
    mode: 'default', thinkingLevel: 'none', accessLevel: 'ask-permission',
    contextMode: 'auto', model: '', provider: 'hermes', ...overrides,
  } as Settings;
}

/** Fake persistent process capturing stdin writes (JSON-RPC lines). */
function fakeProc(): { proc: ChildProcess; written: string[] } {
  const written: string[] = [];
  const proc = {
    stdin: new Writable({ write(chunk, _encoding, callback) { written.push(String(chunk)); callback(); } })
  } as unknown as ChildProcess;
  return { proc, written };
}

function writtenJson(written: string[]): Record<string, unknown>[] {
  return written.flatMap(w => w.split('\n').filter(Boolean).map(l => JSON.parse(l)));
}

describe('Hermes ACP handshake', () => {
  let provider: TestableHermesProvider;
  let session: HermesSessionState;
  let written: string[];

  beforeEach(() => {
    provider = new TestableHermesProvider();
    session = createHermesSession();
    const fake = fakeProc();
    session.persistentProcess = fake.proc;
    written = fake.written;
  });

  it('first input on a fresh process is an initialize request; the prompt is stashed', () => {
    provider.buildPersistentCliArgs(settings(), session);
    const input = provider.formatPersistentInput('hello hermes', session);
    const msg = JSON.parse(input);

    expect(msg.method).toBe('initialize');
    expect(msg.params.protocolVersion).toBe(1);
    expect(msg.params.clientCapabilities.fs.readTextFile).toBe(false);
    expect(session.pendingPrompt).toBe('hello hermes');
  });

  it('initialize response triggers session/new with the workspace cwd', () => {
    provider.buildPersistentCliArgs(settings(), session);
    provider.formatPersistentInput('hello', session);

    const chunk = provider.parseStreamLine(
      JSON.stringify({ jsonrpc: '2.0', id: session.rpcId, result: { protocolVersion: 1 } }),
      session
    );
    expect(chunk).toBeNull();

    const sent = writtenJson(written);
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('session/new');
    expect((sent[0].params as Record<string, unknown>).mcpServers).toEqual([]);
  });

  it('session/new response sends the stashed prompt but emits NO chunk (death-before-answer must surface as an error)', () => {
    provider.buildPersistentCliArgs(settings(), session);
    provider.formatPersistentInput('do the thing', session);
    provider.parseStreamLine(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), session); // initialize resp

    const chunk = provider.parseStreamLine(
      JSON.stringify({ jsonrpc: '2.0', id: 2, result: { sessionId: 'sess_42' } }),
      session
    );

    // No chunk: usedPersistent must flip only at the prompt boundary
    expect(chunk).toBeNull();
    expect(session.acpSessionId).toBe('sess_42');
    expect(session.sessionId).toBe('sess_42');

    const sent = writtenJson(written);
    const promptReq = sent.find(m => m.method === 'session/prompt')!;
    expect(promptReq).toBeDefined();
    const params = promptReq.params as { sessionId: string; prompt: Array<{ type: string; text: string }> };
    expect(params.sessionId).toBe('sess_42');
    expect(params.prompt[0].text).toBe('do the thing');
  });

  it('session/new error maps to auth_error with the setup command', () => {
    provider.buildPersistentCliArgs(settings(), session);
    provider.formatPersistentInput('x', session);
    provider.parseStreamLine(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), session);

    const chunk = provider.parseStreamLine(
      JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'authentication required' } }),
      session
    );
    expect(chunk?.type).toBe('auth_error');
    expect(chunk?.authCommand).toBe('hermes setup');
  });

  it('subsequent prompts on a live session go straight to session/prompt', () => {
    session.acpSessionId = 'sess_42';
    const input = provider.formatPersistentInput('second turn', session);
    const msg = JSON.parse(input);
    expect(msg.method).toBe('session/prompt');
    expect(msg.params.sessionId).toBe('sess_42');
    expect(session.promptId).toBe(msg.id);
  });

  it('prompt response stores usage and yields a harmless session_active chunk', () => {
    session.acpSessionId = 'sess_42';
    provider.formatPersistentInput('turn', session);

    const chunk = provider.parseStreamLine(
      JSON.stringify({ jsonrpc: '2.0', id: session.promptId, result: { stopReason: 'end_turn', usage: { inputTokens: 900, outputTokens: 120 } } }),
      session
    );
    expect(chunk?.type).toBe('session_active');
    expect(provider.getStoredUsage('test-panel')).toBeNull(); // different panel id — not stored there
    expect(session.lastUsageStats).toEqual({ input_tokens: 900, output_tokens: 120 });
  });

  it('buildPersistentCliArgs resets protocol state and snapshots access level', () => {
    session.acpSessionId = 'stale';
    session.sessionId = 'stale';
    session.rpcId = 9;
    const args = provider.buildPersistentCliArgs(settings({ accessLevel: 'read-only' }), session);
    expect(args).toEqual(['acp']);
    expect(session.acpSessionId).toBeNull();
    expect(session.sessionId).toBeNull();
    expect(session.rpcId).toBe(0);
    expect(session.acpAccessLevel).toBe('read-only');
  });
});

describe('Hermes ACP session updates', () => {
  let provider: TestableHermesProvider;
  let session: HermesSessionState;

  beforeEach(() => {
    provider = new TestableHermesProvider();
    session = createHermesSession();
    session.persistentProcess = fakeProc().proc;
  });

  const update = (u: Record<string, unknown>) =>
    JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: u } });

  it('maps agent_message_chunk to text', () => {
    const chunk = provider.parseStreamLine(
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello!' } }),
      session
    );
    expect(chunk).toEqual({ type: 'text', content: 'Hello!' });
  });

  it('maps agent_thought_chunk to thinking', () => {
    const chunk = provider.parseStreamLine(
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } }),
      session
    );
    expect(chunk).toEqual({ type: 'thinking', content: 'hmm' });
  });

  it('tolerates snake_case field names', () => {
    const chunk = provider.parseStreamLine(
      update({ session_update: 'agent_message_chunk', content: { type: 'text', text: 'snake' } }),
      session
    );
    expect(chunk).toEqual({ type: 'text', content: 'snake' });
  });

  it('names tool_use from the semantic ACP kind, not the display title', () => {
    // Title is "terminal: rm -rf …" — must NOT leak into the tool name
    const chunk = provider.parseStreamLine(
      update({ sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'terminal: rm -rf /tmp/x', kind: 'execute', status: 'pending', rawInput: { command: 'rm -rf /tmp/x' } }),
      session
    );
    expect(chunk?.type).toBe('tool_use');
    expect(chunk?.toolCall?.name).toBe('Bash');
    expect(chunk?.toolCall?.kind).toBe('execute');
    expect(chunk?.toolCall?.input).toEqual({ command: 'rm -rf /tmp/x' });
  });

  it('maps every ACP kind to a canonical tool name', () => {
    const cases: Array<[string, string]> = [
      ['read', 'Read'], ['edit', 'Edit'], ['delete', 'Delete'],
      ['move', 'Move'], ['search', 'Grep'], ['fetch', 'WebFetch']
    ];
    for (const [kind, name] of cases) {
      const chunk = provider.parseStreamLine(
        update({ sessionUpdate: 'tool_call', toolCallId: `tc-${kind}`, title: `${kind}: something`, kind, status: 'pending' }),
        session
      );
      expect(chunk?.toolCall?.name, kind).toBe(name);
    }
  });

  it('maps completed tool_call_update → tool_result with extracted content text', () => {
    provider.parseStreamLine(
      update({ sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'bash', status: 'pending', rawInput: { command: 'ls' } }),
      session
    );
    const chunk = provider.parseStreamLine(
      update({
        sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'file-a\nfile-b' } }]
      }),
      session
    );
    expect(chunk?.type).toBe('tool_result');
    expect(chunk?.toolCall?.status).toBe('completed');
    expect(chunk?.toolCall?.output).toBe('file-a\nfile-b');
    expect(chunk?.toolCall?.name).toBe('Bash');
  });

  it('ignores in_progress tool updates and telemetry updates', () => {
    expect(provider.parseStreamLine(update({ sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'in_progress' }), session)).toBeNull();
    expect(provider.parseStreamLine(update({ sessionUpdate: 'usage_update', size: 100000, used: 5000 }), session)).toBeNull();
    expect(provider.parseStreamLine(update({ sessionUpdate: 'plan', entries: [] }), session)).toBeNull();
  });

  it('ignores non-JSON noise in persistent mode', () => {
    expect(provider.parseStreamLine('some stray log line', session)).toBeNull();
  });
});

describe('Hermes ACP permission auto-response', () => {
  let provider: TestableHermesProvider;
  let session: HermesSessionState;
  let written: string[];

  const requestFor = (kind: string) => JSON.stringify({
    jsonrpc: '2.0', id: 77, method: 'session/request_permission',
    params: {
      sessionId: 's',
      toolCall: { kind, title: `${kind}: op` },
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'allow_session', kind: 'allow_always', name: 'Allow for session' },
        { optionId: 'deny', kind: 'reject_once', name: 'Deny' }
      ]
    }
  });
  const outcomeId = (written: string[]) =>
    ((writtenJson(written)[0].result as { outcome: { optionId?: string; outcome: string } }).outcome);

  beforeEach(() => {
    provider = new TestableHermesProvider();
    session = createHermesSession();
    const fake = fakeProc();
    session.persistentProcess = fake.proc;
    written = fake.written;
  });

  it('DENIES a dangerous tool in the default ask mode (fail closed — no synchronous user prompt possible)', () => {
    session.acpAccessLevel = 'ask-permission';
    session.acpMode = 'ask-before-edit';
    const chunk = provider.parseStreamLine(requestFor('execute'), session);
    expect(chunk).toBeNull();
    expect(outcomeId(written).optionId).toBe('deny');
  });

  it('allows any tool under full-access (autonomous)', () => {
    session.acpAccessLevel = 'full-access';
    session.acpMode = 'edit-automatically';
    provider.parseStreamLine(requestFor('execute'), session);
    expect(outcomeId(written).optionId).toBe('allow_once');
  });

  it('always allows read-only kinds even in ask mode', () => {
    session.acpAccessLevel = 'ask-permission';
    session.acpMode = 'ask-before-edit';
    provider.parseStreamLine(requestFor('read'), session);
    expect(outcomeId(written).optionId).toBe('allow_once');
  });

  it('accept-edits tier allows edits but denies commands', () => {
    session.acpAccessLevel = 'ask-permission';
    session.acpMode = 'edit-automatically';
    provider.parseStreamLine(requestFor('edit'), session);
    expect(outcomeId(written).optionId).toBe('allow_once');

    const fake = fakeProc();
    session.persistentProcess = fake.proc;
    provider.parseStreamLine(requestFor('execute'), session);
    expect(outcomeId(fake.written).optionId).toBe('deny');
  });

  it('denies when the panel is read-only', () => {
    session.acpAccessLevel = 'read-only';
    provider.parseStreamLine(requestFor('execute'), session);
    expect(outcomeId(written).optionId).toBe('deny');
  });

  it('fails closed when allowing but no allow option is offered', () => {
    session.acpAccessLevel = 'full-access';
    session.acpMode = 'edit-automatically';
    const request = JSON.stringify({
      jsonrpc: '2.0', id: 77, method: 'session/request_permission',
      params: { toolCall: { kind: 'execute' }, options: [{ optionId: 'deny', kind: 'reject_once' }] }
    });
    provider.parseStreamLine(request, session);
    expect(outcomeId(written).optionId).toBe('deny');
  });

  it('never selects options[0] when denying (deny option not first)', () => {
    session.acpAccessLevel = 'read-only';
    const request = JSON.stringify({
      jsonrpc: '2.0', id: 77, method: 'session/request_permission',
      params: {
        toolCall: { kind: 'execute' },
        options: [{ optionId: 'allow_once', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }]
      }
    });
    provider.parseStreamLine(request, session);
    expect(outcomeId(written).optionId).toBe('deny');
  });

  it('fails CLOSED (cancelled) when denying but ONLY allow options are offered', () => {
    session.acpAccessLevel = 'read-only';
    const request = JSON.stringify({
      jsonrpc: '2.0', id: 77, method: 'session/request_permission',
      params: { toolCall: { kind: 'execute' }, options: [{ optionId: 'allow_once', kind: 'allow_once' }] }
    });
    provider.parseStreamLine(request, session);
    const outcome = outcomeId(written);
    expect(outcome.outcome).toBe('cancelled');
    expect(outcome.optionId).toBeUndefined();
  });

  it('responds method-not-found to unexpected server requests', () => {
    provider.parseStreamLine(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'fs/read_text_file', params: {} }), session);
    const sent = writtenJson(written);
    expect((sent[0].error as { code: number }).code).toBe(-32601);
  });
});

describe('Hermes response boundary + interrupt + fallback', () => {
  let provider: TestableHermesProvider;
  let session: HermesSessionState;

  beforeEach(() => {
    provider = new TestableHermesProvider();
    session = createHermesSession();
  });

  it('boundary fires only on prompt responses (stopReason) and error responses', () => {
    expect(provider.isResponseBoundary(JSON.stringify({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } }))).toBe(true);
    expect(provider.isResponseBoundary(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'auth' } }))).toBe(true);
    // initialize / session-new success responses do NOT end the turn
    expect(provider.isResponseBoundary(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }))).toBe(false);
    expect(provider.isResponseBoundary(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { sessionId: 's' } }))).toBe(false);
    // server→client requests carry method — never a boundary
    expect(provider.isResponseBoundary(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: {} }))).toBe(false);
    // notifications and junk
    expect(provider.isResponseBoundary(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {} }))).toBe(false);
    expect(provider.isResponseBoundary('not json')).toBe(false);
  });

  it('interrupt DROPS the process (no session/cancel, no raw Ctrl+C byte) so the next turn respawns clean', () => {
    const fake = fakeProc();
    session.persistentProcess = fake.proc;
    session.persistentReady = true;
    session.acpSessionId = 'sess_42';
    provider.interruptPersistentProcess(session);
    // No JSON-RPC written, no \x03 — the process is simply dropped
    expect(fake.written).toEqual([]);
    expect(session.persistentProcess).toBeNull();
    expect(session.persistentReady).toBe(false);
  });

  it('_persistentSettingsMatch forces a respawn when access level changes under a plan mode (fresh permission snapshot)', () => {
    // Spawn snapshot: detailed-plan + full-access. The base collapses both
    // detailed-plan+full-access and detailed-plan+read-only to permissionMode
    // 'plan', so WITHOUT the override a read-only flip would NOT respawn and
    // the permission snapshot would go stale (the confirmed bug).
    provider.buildPersistentCliArgs(settings({ accessLevel: 'full-access', mode: 'detailed-plan' }), session);
    session.persistentSettings = { model: undefined, permissionMode: 'plan', thinkingLevel: 'none', effortLevel: '' };

    expect(provider.persistentSettingsMatch(session, settings({ accessLevel: 'full-access', mode: 'detailed-plan' }))).toBe(true);
    // Flip access to read-only under the same plan mode → must break the match
    expect(provider.persistentSettingsMatch(session, settings({ accessLevel: 'read-only', mode: 'detailed-plan' }))).toBe(false);
  });

  it('fallback diagnostics yield exactly one actionable error', () => {
    provider.buildCliArgs({} as Settings, session);
    expect(session.fallbackDiagnostics).toBe(true);

    const first = provider.parseStreamLine('ACP dependency missing: acp>=0.4', session);
    expect(first?.type).toBe('error');
    expect(first?.content).toContain('hermes acp');
    // subsequent lines are swallowed
    expect(provider.parseStreamLine('more output', session)).toBeNull();
  });
});
