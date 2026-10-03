import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import { codexAppServerInput, handleCodexAppServer, isCodexAppServerBoundary, type CodexAppServerState } from '../../../src/providers/codex/CodexAppServerProtocol';
import type { NativeApprovalRequests } from '../../../src/providers/base/NativeApprovalRequests';
import type { Settings } from '../../../src/types';
function harness(overrides: Partial<Settings> = {}) {
  const state: CodexAppServerState = { settings: { mode: 'ask-before-edit', accessLevel: 'ask-permission', provider: 'openai-codex', model: '', contextMode: 'manual', thinkingLevel: 'none', ...overrides },
    cwd: '/fixture', model: 'selected-model', threadId: 'thread', turnId: 'turn', initialized: true, nextId: 0, requests: new Map(), items: new Map(), streamed: new Set() };
  const written: any[] = [];
  const proc = { stdin: { writable: true, destroyed: false, write: (line: string) => written.push(JSON.parse(line)) }, kill: vi.fn() } as unknown as ChildProcess;
  const approval = { request: vi.fn() };
  const handle = (data: Record<string, unknown>) => handleCodexAppServer(data, state, proc, approval as unknown as NativeApprovalRequests);
  return { state, written, proc, approval, handle };
}
describe('Codex app-server protocol boundaries and policy', () => {
  it('denies unowned/stale requests and never lets another turn finish this turn', () => {
    const h = harness();
    h.handle({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'other', turnId: 'turn' } });
    expect(h.approval.request).not.toHaveBeenCalled(); expect(h.written).toEqual([{ id: 7, result: { decision: 'cancel' } }]);
    expect(isCodexAppServerBoundary({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'old' } } }, h.state)).toBe(false);
    expect(isCodexAppServerBoundary({ id: 99, error: { message: 'unrelated' } }, h.state)).toBe(false);
  });
  it('a delete inside a patch is not automatically approved as an edit', () => {
    const h = harness({ mode: 'edit-automatically' });
    h.state.items.set('file', { changes: [{ path: '/fixture/file', kind: { type: 'delete' }, diff: '-old' }] });
    h.handle({ id: 9, method: 'item/fileChange/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: 'file' } });
    expect(h.approval.request.mock.calls[0][1]).toMatchObject({ name: 'Delete' });
    expect(h.approval.request.mock.calls[0][2]).toBe('ask');
    h.approval.request.mock.calls[0][3]('allow', h.proc);
    expect(h.written).toEqual([{ id: 9, result: { decision: 'accept' } }]);
  });
  it('declines broad permission grants rather than granting a whole turn', () => {
    const h = harness(); h.handle({ id: 1, method: 'item/permissions/requestApproval' });
    expect(h.written).toEqual([{ id: 1, result: { permissions: {}, scope: 'turn' } }]);
  });
  it('preserves question text/options for the existing follow-up UI', () => {
    const h = harness(); const chunk = h.handle({ id: 2, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'color', header: 'Color', question: 'Which color?', options: [{ label: 'Blue', description: 'Cool' }] }] } });
    expect(chunk).toMatchObject({ type: 'ask_user_question', askUserQuestion: { questions: [{ question: 'Which color?', options: [{ label: 'Blue' }] }] } });
    expect(h.written[0]).toEqual({ id: 2, result: { answers: {} } });
  });
  it('streams text once and preserves usage and actual context window', () => {
    const h = harness(); expect(h.handle({ method: 'item/agentMessage/delta', params: { threadId: 'thread', itemId: 'text', delta: 'hello' } })).toEqual({ type: 'text', content: 'hello' });
    expect(h.handle({ method: 'item/completed', params: { threadId: 'thread', item: { type: 'agentMessage', id: 'text', text: 'hello' } } })).toBeNull();
    h.handle({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread', tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 20 }, modelContextWindow: 272000 } } });
    expect(h.state.usage).toEqual({ input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 }); expect(h.state.contextWindow).toBe(272000);
  });
  it('reads inherited configuration and disables each external tool source in restricted mode', () => {
    const h = harness(); h.state.initialized = false;
    const init = JSON.parse(codexAppServerInput(h.state, 'fixture'));
    h.handle({ id: init.id, result: {} });
    const read = h.written.at(-1); expect(read.method).toBe('config/read');
    h.handle({ id: read.id, result: { config: { mcp_servers: { external: { command: 'example' } }, apps: { configured: { enabled: true } } } } });
    const thread = h.written.at(-1);
    expect(thread.params).toMatchObject({ model: 'selected-model', sandbox: 'read-only', approvalPolicy: 'untrusted', approvalsReviewer: 'user', config: { mcp_servers: { external: { enabled: false } }, apps: { configured: { enabled: false }, _default: { enabled: false } } } });
  });
});
