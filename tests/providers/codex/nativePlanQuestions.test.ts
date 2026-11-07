import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import { TestableCodexProvider } from '../../helpers/providerFactory';
import { answerCodexQuestion, codexAppServerInput, handleCodexAppServer, type CodexAppServerState } from '../../../src/providers/codex/CodexAppServerProtocol';
import { NativeApprovalRequests } from '../../../src/providers/base/NativeApprovalRequests';
import type { Settings, StreamChunk } from '../../../src/types';

const base: Settings = { provider: 'openai-codex', mode: 'ask-before-edit', accessLevel: 'ask-permission',
  model: '', thinkingLevel: 'none', contextMode: 'manual' };

// Codex's own Plan collaboration mode and request_user_input, held for the
// question card like Claude Code's AskUserQuestion (protocol level).
function protocol(overrides: Partial<Settings> = {}) {
  const state: CodexAppServerState = { settings: { ...base, ...overrides }, cwd: '/fixture', model: 'selected-model', effort: 'low',
    threadId: 'thread', turnId: 'turn', initialized: true, nextId: 0, requests: new Map(), items: new Map(), streamed: new Set() };
  const written: any[] = [];
  const proc = Object.assign(new EventEmitter(), {
    stdin: { writable: true, destroyed: false, write: (line: string) => written.push(JSON.parse(line)) },
  }) as unknown as ChildProcess;
  const controller = new AbortController();
  const approvals = new NativeApprovalRequests({ providerId: 'openai-codex', panelId: 'panel', process: proc,
    signal: controller.signal, handler: undefined, isCurrent: () => !controller.signal.aborted });
  const handle = (data: Record<string, unknown>) => handleCodexAppServer(data, state, proc, approvals);
  const ask = (questions: unknown[], params: Record<string, unknown> = {}) => handle({ id: 4, method: 'item/tool/requestUserInput',
    params: { threadId: 'thread', turnId: 'turn', itemId: 'call', isBlocking: true, questions, ...params } }) as StreamChunk | null;
  return { state, written, approvals, controller, handle, ask };
}
const LANGUAGE = { id: 'language', header: 'Language', question: 'Which language?', isOther: true, isSecret: false,
  options: [{ label: 'Python', description: 'Py' }, { label: 'Go', description: 'Golang' }] };

describe('Codex native Plan mode and request_user_input (protocol)', () => {
  it('opts into the experimental app-server API at initialize', () => {
    const h = protocol(); h.state.initialized = false; h.state.threadId = null;
    expect(JSON.parse(codexAppServerInput(h.state, 'hi')).params.capabilities).toEqual({ experimentalApi: true, requestAttestation: false });
  });

  it.each(['quick-plan', 'detailed-plan'] as const)('%s turns use Codex Plan collaboration mode with its built-in instructions', mode => {
    const h = protocol({ mode });
    expect(JSON.parse(codexAppServerInput(h.state, 'plan it')).params.collaborationMode).toEqual({
      mode: 'plan', settings: { model: 'selected-model', reasoning_effort: 'low', developer_instructions: null },
    });
  });

  it.each(['ask-before-edit', 'edit-automatically'] as const)('%s turns explicitly reset a thread to Default mode', mode => {
    const h = protocol({ mode });
    expect(JSON.parse(codexAppServerInput(h.state, 'do it')).params.collaborationMode).toMatchObject({ mode: 'default', settings: { developer_instructions: null } });
  });

  it('fills the collaboration mode from the model and effort the thread actually started with', () => {
    const h = protocol({ mode: 'quick-plan' }); h.state.initialized = false; h.state.threadId = null;
    h.state.model = undefined; h.state.effort = undefined;
    codexAppServerInput(h.state, 'plan it');
    h.handle({ id: 1, result: {} });
    h.handle({ id: 2, result: { config: {} } });
    h.handle({ id: 3, result: { thread: { id: 'thread' }, model: 'server-model', reasoningEffort: 'high' } });
    expect(h.written.at(-1)).toMatchObject({ method: 'turn/start', params: { collaborationMode: {
      mode: 'plan', settings: { model: 'server-model', reasoning_effort: 'high', developer_instructions: null } } } });
  });

  it('holds the question and answers Codex in the same turn, keyed by question id', () => {
    const h = protocol({ mode: 'quick-plan' });
    const chunk = h.ask([LANGUAGE, { id: 'extras', header: '', question: 'Which extras?', isOther: false, isSecret: false, options: null }]);
    expect(chunk).toMatchObject({ type: 'ask_user_question', askUserQuestion: { questions: [
      { header: 'Language', question: 'Which language?', options: [{ label: 'Python', description: 'Py' }, { label: 'Go', description: 'Golang' }] },
      { question: 'Which extras?', options: [] },
    ] } });
    expect(h.written).toEqual([]); expect(h.approvals.hasPending).toBe(true);
    const id = (chunk as any).askUserQuestion.toolCallId;
    expect(answerCodexQuestion(h.state, id, { Language: 'Go', extras: ['tests', 'docs'] })).toBe(true);
    expect(h.written).toEqual([{ id: 4, result: { answers: { language: { answers: ['Go'] }, extras: { answers: ['tests', 'docs'] } } } }]);
    expect(h.approvals.hasPending).toBe(false);
    expect(answerCodexQuestion(h.state, id, { Language: 'Python' })).toBe(false);
  });

  it('accepts card keys Q<n> for a question shown without a header', () => {
    const h = protocol({ mode: 'quick-plan' });
    const chunk = h.ask([LANGUAGE, { id: 'name', header: '', question: 'Name?', isOther: true, isSecret: false, options: null }]);
    answerCodexQuestion(h.state, (chunk as any).askUserQuestion.toolCallId, { Q2: 'hello' });
    expect(h.written).toEqual([{ id: 4, result: { answers: { name: { answers: ['hello'] } } } }]);
  });

  it('a skipped question sends Codex no answers instead of inventing one', () => {
    const h = protocol({ mode: 'quick-plan' }); const chunk = h.ask([LANGUAGE]);
    expect(answerCodexQuestion(h.state, (chunk as any).askUserQuestion.toolCallId, null)).toBe(true);
    expect(h.written).toEqual([{ id: 4, result: { answers: {} } }]);
  });

  it('cancels a held question with its turn; a late answer is not claimed', () => {
    const h = protocol({ mode: 'quick-plan' }); const chunk = h.ask([LANGUAGE]);
    h.controller.abort();
    expect(h.written).toEqual([{ id: 4, result: { answers: {} } }]);
    expect(answerCodexQuestion(h.state, (chunk as any).askUserQuestion.toolCallId, { Language: 'Go' })).toBe(false);
    expect(h.written).toHaveLength(1);
  });

  it('releases a question Codex resolved itself, so a late answer becomes a follow-up', () => {
    const h = protocol({ mode: 'quick-plan' }); const chunk = h.ask([LANGUAGE]);
    h.handle({ method: 'serverRequest/resolved', params: { threadId: 'other', requestId: 4 } });
    expect(h.approvals.hasPending).toBe(true);
    h.handle({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 4 } });
    expect(h.approvals.hasPending).toBe(false);
    expect(answerCodexQuestion(h.state, (chunk as any).askUserQuestion.toolCallId, { Language: 'Go' })).toBe(false);
  });

  it('does not claim an unknown question, so the host can fall back to a follow-up', () => {
    const h = protocol(); expect(answerCodexQuestion(h.state, 'never-asked', { Language: 'Go' })).toBe(false);
  });

  it('answers a stale-turn question immediately and shows nothing', () => {
    const h = protocol({ mode: 'quick-plan' });
    expect(h.ask([LANGUAGE], { turnId: 'old' })).toBeNull();
    expect(h.written).toEqual([{ id: 4, result: { answers: {} } }]); expect(h.approvals.hasPending).toBe(false);
  });

  it('never shows a secret question as a plain card: Codex continues without an answer', () => {
    const h = protocol({ mode: 'quick-plan' });
    expect(h.ask([LANGUAGE, { ...LANGUAGE, id: 'token', header: 'Token', question: 'Paste your API token', isSecret: true }])).toBeNull();
    expect(h.written).toEqual([{ id: 4, result: { answers: {} } }]); expect(h.approvals.hasPending).toBe(false);
  });

  it('streams the proposed plan once', () => {
    const h = protocol({ mode: 'quick-plan' });
    expect(h.handle({ method: 'item/plan/delta', params: { threadId: 'thread', turnId: 'turn', itemId: 'plan', delta: '1. Step' } }))
      .toEqual({ type: 'text', content: '1. Step' });
    expect(h.handle({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: { type: 'plan', id: 'plan', text: '1. Step' } } })).toBeNull();
    expect(h.handle({ method: 'item/plan/delta', params: { threadId: 'thread', turnId: 'old', itemId: 'plan', delta: 'stale' } })).toBeNull();
  });
});

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) { await cleanup(); } vi.restoreAllMocks(); });
function provider() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-codex-question-'));
  const folders = vscode.workspace.workspaceFolders;
  Object.defineProperty(vscode.workspace, 'workspaceFolders', { value: [{ uri: vscode.Uri.file(directory), name: 'fixture', index: 0 }], configurable: true });
  const codex = new TestableCodexProvider();
  vi.spyOn(codex, 'getCliPath').mockReturnValue(process.execPath);
  const build = codex.buildPersistentCliArgs.bind(codex);
  vi.spyOn(codex, 'buildPersistentCliArgs').mockImplementation((s, session) => {
    build(s, session);
    return [path.resolve(__dirname, 'fixtures/codexQuestionAgent.cjs')];
  });
  vi.spyOn(codex as unknown as { buildPromptAsync(): Promise<string> }, 'buildPromptAsync').mockResolvedValue('fixture');
  cleanups.push(async () => {
    const processes = [...(codex as any)._panelSessions.values()].flatMap((s: any) => [s.process, s.persistentProcess]).filter(Boolean);
    const closed = processes.map(proc => new Promise<void>(resolve => {
      if (proc.exitCode !== null || proc.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(resolve, 2500); proc.once('close', () => { clearTimeout(timer); resolve(); });
    }));
    codex.dispose(); await Promise.all(closed);
    Object.defineProperty(vscode.workspace, 'workspaceFolders', { value: folders });
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  // The main chat claims each question it shows; Brainstorm/background runs do not.
  const send = async (mode: Settings['mode'], onQuestion?: (toolCallId: string) => void, claim = true) => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of codex.sendMessage('fixture', [], { ...base, mode }, null, undefined, 'panel')) {
      chunks.push(chunk);
      if (chunk.type !== 'ask_user_question') { continue; }
      if (claim) { codex.claimNativeQuestion('panel', chunk.askUserQuestion!.toolCallId); }
      onQuestion?.(chunk.askUserQuestion!.toolCallId);
    }
    return { chunks, text: chunks.filter(c => c.type === 'text').map(c => c.content).join('') };
  };
  return { codex, send };
}

describe('Codex native questions through a real child process', () => {
  it('declares native Plan so Mysti stops restating it in the prompt', () => {
    expect(new TestableCodexProvider().capabilities.nativeModes).toEqual({ plan: true, readOnly: true, approvals: true });
  });

  it('the user answer reaches Codex inside the same plan turn; no follow-up turn is needed', async () => {
    const h = provider(); const claimed: boolean[] = [];
    const { chunks, text } = await h.send('quick-plan', id => claimed.push(h.codex.answerNativeQuestion('panel', id, { Language: 'Go' })));
    expect(claimed).toEqual([true]);
    expect(text).toBe('answered:{"language":{"answers":["Go"]}}');
    expect(chunks.filter(c => c.type === 'done')).toHaveLength(1);
    expect(chunks.some(c => c.type === 'error')).toBe(false);
    // Leaving Plan resets the resumed thread to Codex's Default mode.
    expect((await h.send('ask-before-edit')).text).toBe('mode:default');
  });

  it('the answer can arrive after the stream moves on, because the chat claimed the question', async () => {
    const h = provider(); let answer: () => boolean = () => false;
    const run = h.send('quick-plan', id => { answer = () => h.codex.answerNativeQuestion('panel', id, { Language: 'Python' }); });
    await vi.waitFor(() => expect(answer()).toBe(true), { interval: 5 });
    expect((await run).text).toBe('answered:{"language":{"answers":["Python"]}}');
  });

  it('hands an unclaimed question back to Codex instead of holding the turn (Brainstorm, background runs)', async () => {
    const h = provider(); let asked = '';
    const { text, chunks } = await h.send('quick-plan', id => { asked = id; }, false);
    expect(text).toBe('answered:{}');
    expect(chunks.filter(c => c.type === 'done')).toHaveLength(1);
    expect(h.codex.answerNativeQuestion('panel', asked, { Language: 'Go' })).toBe(false);
  });

  it('Stop cancels the held question; a late answer falls back to the host', async () => {
    const h = provider(); let asked = '';
    await h.send('quick-plan', id => { asked = id; h.codex.cancelCurrentRequest('panel'); });
    expect(asked).not.toBe('');
    expect(h.codex.answerNativeQuestion('panel', asked, { Language: 'Go' })).toBe(false);
  });
});
