/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import type { ChildProcess } from 'child_process';
import type { Settings, StreamChunk } from '../../types';
import type { NativeApprovalRequests } from '../base/NativeApprovalRequests';
import { allowsUnrestrictedNativeTools, nativeToolDecision } from '../base/NativeApprovalPolicy';
import { isRecord } from '../../utils/valueGuards';
import { toolKind } from '../../utils/toolNames';

export interface CodexAppServerState {
  settings: Settings;
  cwd: string;
  profile?: string;
  disabledApps?: Record<string, { enabled: false }>;
  disabledMcp?: Record<string, { enabled: false }>;
  model?: string;
  effort?: string;
  threadId: string | null;
  turnId?: string;
  initialized: boolean;
  pendingPrompt?: string;
  nextId: number;
  requests: Map<number, string>;
  items: Map<string, Record<string, unknown>>;
  streamed: Set<string>;
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
  contextWindow?: number;
}

const json = (value: unknown) => JSON.stringify(value) + '\n';
function request(state: CodexAppServerState, method: string, params: Record<string, unknown>): string {
  const id = ++state.nextId;
  state.requests.set(id, method);
  return json({ id, method, params });
}

function policy(state: CodexAppServerState): Record<string, unknown> {
  const unrestricted = allowsUnrestrictedNativeTools(state.settings);
  const readonly = state.settings.accessLevel === 'read-only' || state.settings.mode === 'quick-plan' || state.settings.mode === 'detailed-plan';
  return {
    cwd: state.cwd, model: state.model, approvalsReviewer: 'user',
    // Restrictive tiers start read-only. Every filesystem mutation must cross
    // a native approval boundary; workspace-write would silently apply patches.
    approvalPolicy: readonly ? 'never' : unrestricted ? 'never' : 'untrusted',
    sandbox: unrestricted ? 'danger-full-access' : 'read-only',
    config: {
      ...(state.effort ? { model_reasoning_effort: state.effort } : {}),
      // Remote MCP/app tools have no per-call host authorization contract in
      // this protocol version. They remain available only in explicit full
      // access; a filesystem sandbox cannot constrain their remote effects.
      ...(!unrestricted ? { mcp_servers: state.disabledMcp || {}, apps: { ...state.disabledApps, _default: { enabled: false } } } : {}),
    },
  };
}

function turn(state: CodexAppServerState, prompt: string): string {
  state.turnId = undefined;
  state.items.clear(); state.streamed.clear(); state.usage = undefined;
  return request(state, 'turn/start', {
    threadId: state.threadId, input: [{ type: 'text', text: prompt, text_elements: [] }], effort: state.effort,
  });
}

export function codexAppServerInput(state: CodexAppServerState, prompt: string): string {
  if (state.initialized && state.threadId) { return turn(state, prompt); }
  state.pendingPrompt = prompt;
  return request(state, 'initialize', { clientInfo: { name: 'mysti', title: 'Mysti', version: '0.5.1' } });
}

export function isCodexAppServerBoundary(data: Record<string, unknown>, state?: CodexAppServerState): boolean {
  const params = isRecord(data.params) ? data.params : {};
  const completed = isRecord(params.turn) ? params.turn : {};
  if (data.method === 'turn/completed') {
    return !state || (params.threadId === state.threadId && (!state.turnId || completed.id === state.turnId));
  }
  return data.method === undefined && typeof data.id === 'number' && isRecord(data.error)
    && (!state || state.requests.has(data.id));
}

/** App-server v2 stdio; all decisions target the captured issuing process. */
export function handleCodexAppServer(
  data: Record<string, unknown>, state: CodexAppServerState, proc: ChildProcess | null,
  approvals: NativeApprovalRequests | undefined,
): StreamChunk | null {
  const send = (line: string, target = proc) => {
    if (target?.stdin?.writable && !target.stdin.destroyed) { target.stdin.write(line); }
  };
  const params = isRecord(data.params) ? data.params : {};
  const method = typeof data.method === 'string' ? data.method : '';
  if (!method && typeof data.id === 'number') {
    const pending = state.requests.get(data.id); state.requests.delete(data.id);
    if (!pending) { return null; }
    if (isRecord(data.error)) {
      state.pendingPrompt = undefined;
      return { type: 'error', content: `Codex ${pending} failed: ${String(data.error.message || 'Unknown app-server error')}` };
    }
    const result = isRecord(data.result) ? data.result : {};
    if (pending === 'initialize') {
      send(json({ method: 'initialized' }));
      // Empty TOML tables merge with inherited configuration. Read effective
      // server names and disable each explicitly, without logging credentials.
      send(request(state, 'config/read', { cwd: state.cwd, includeLayers: false }));
    } else if (pending === 'config/read') {
      const config = isRecord(result.config) ? result.config : {};
      const servers = isRecord(config.mcp_servers) ? config.mcp_servers : {};
      const apps = isRecord(config.apps) ? config.apps : {};
      state.disabledApps = Object.fromEntries(Object.keys(apps).map(name => [name, { enabled: false as const }]));
      state.disabledMcp = Object.fromEntries(Object.keys(servers).map(name => [name, { enabled: false as const }]));
      send(request(state, state.threadId ? 'thread/resume' : 'thread/start', {
        ...policy(state), ...(state.threadId ? { threadId: state.threadId } : {}),
      }));
    } else if (pending === 'thread/start' || pending === 'thread/resume') {
      const thread = isRecord(result.thread) ? result.thread : {};
      if (typeof thread.id !== 'string') {
        // Terminate the process so the base cannot wait forever for a turn that
        // was never created, or replay an ambiguously submitted prompt.
        proc?.kill();
        return { type: 'error', content: 'Codex returned no thread ID. Update the CLI and retry.' };
      }
      state.threadId = thread.id; state.initialized = true;
      const prompt = state.pendingPrompt; state.pendingPrompt = undefined;
      if (prompt !== undefined) { send(turn(state, prompt)); }
      return { type: 'session_active', sessionId: state.threadId };
    } else if (pending === 'turn/start' && isRecord(result.turn) && typeof result.turn.id === 'string') {
      state.turnId = result.turn.id;
    }
    return null;
  }

  const id = data.id;
  if (typeof id === 'string' || typeof id === 'number') {
    const respond = (result: Record<string, unknown>, target = proc) => send(json({ id, result }), target);
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const itemId = typeof params.itemId === 'string' ? params.itemId : String(id);
      const item = state.items.get(itemId) || {};
      const isFile = method === 'item/fileChange/requestApproval';
      if (isFile && (!Array.isArray(item.changes) || item.changes.length === 0)) {
        respond({ decision: 'decline' });
        return { type: 'error', content: 'Codex requested a file change without its patch details. The operation was denied.' };
      }
      const deletes = Array.isArray(item.changes) && item.changes.some(change => isRecord(change) && isRecord(change.kind) && change.kind.type === 'delete');
      const name = isFile ? (deletes ? 'Delete' : 'Edit') : isRecord(params.networkApprovalContext) ? 'WebFetch' : 'Bash';
      const input = isFile ? { changes: item.changes || [], reason: params.reason, grantRoot: params.grantRoot }
        : { command: params.command ?? item.command ?? '', cwd: params.cwd ?? state.cwd,
          reason: params.reason, network: params.networkApprovalContext };
      const matching = params.threadId === state.threadId && (!state.turnId || params.turnId === state.turnId);
      if (!matching || !approvals) { respond({ decision: 'cancel' }); return null; }
      approvals.request(id, { id: itemId, name, input, status: 'running', kind: toolKind(name) },
        nativeToolDecision(state.settings, name), (decision, target) => respond({
          decision: decision === 'allow' ? 'accept' : decision === 'deny' ? 'decline' : 'cancel',
        }, target));
    } else if (method === 'item/permissions/requestApproval') {
      // A per-operation card never authorizes a persistent/whole-turn grant.
      respond({ permissions: {}, scope: 'turn' });
    } else if (method === 'mcpServer/elicitation/request') {
      respond({ action: 'decline', content: null });
    } else if (method === 'item/tool/requestUserInput') {
      respond({ answers: {} });
      return { type: 'ask_user_question', askUserQuestion: {
        toolCallId: `codex-question-${state.threadId}-${state.turnId}-${id}`,
        questions: (Array.isArray(params.questions) ? params.questions : []).filter(isRecord).map(question => ({
          header: String(question.header || question.id || 'Question'), question: String(question.question || ''), multiSelect: false,
          options: (Array.isArray(question.options) ? question.options : []).filter(isRecord).map(option => ({
            label: String(option.label || ''), description: String(option.description || ''),
          })),
        })),
      } };
    } else {
      send(json({ id, error: { code: -32601, message: 'Unsupported Mysti host request' } }));
    }
    return null;
  }
  if (params.threadId && params.threadId !== state.threadId) { return null; }
  if (method === 'turn/started' && isRecord(params.turn) && typeof params.turn.id === 'string') {
    state.turnId = params.turn.id; return null;
  }
  if (method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
    if (typeof params.itemId === 'string') { state.streamed.add(params.itemId); }
    return typeof params.delta === 'string' ? { type: method === 'item/agentMessage/delta' ? 'text' : 'thinking', content: params.delta } : null;
  }
  if (method === 'thread/tokenUsage/updated' && isRecord(params.tokenUsage)) {
    const usage = params.tokenUsage;
    const last = isRecord(usage.last) ? usage.last : {};
    state.usage = { input_tokens: Number(last.inputTokens) || 0, output_tokens: Number(last.outputTokens) || 0,
      cache_read_input_tokens: Number(last.cachedInputTokens) || 0 };
    if (typeof usage.modelContextWindow === 'number') { state.contextWindow = usage.modelContextWindow; }
    return null;
  }
  if (method === 'turn/completed') {
    const completed = isRecord(params.turn) ? params.turn : {};
    if (completed.status !== 'completed' && completed.status !== 'interrupted') {
      const error = isRecord(completed.error) ? completed.error : {};
      return { type: 'error', content: `Codex turn failed: ${String(error.message || completed.status || 'Unknown failure')}` };
    }
    return null;
  }
  if ((method === 'item/started' || method === 'item/completed') && isRecord(params.item)) {
    const item = params.item;
    const itemId = String(item.id || '');
    state.items.set(itemId, item);
    const completed = method === 'item/completed';
    if (item.type === 'agentMessage' || item.type === 'plan') {
      return completed && !state.streamed.has(itemId) && typeof item.text === 'string' ? { type: 'text', content: item.text } : null;
    }
    if (item.type === 'reasoning') {
      return completed && !state.streamed.has(itemId) && Array.isArray(item.summary)
        ? { type: 'thinking', content: item.summary.filter(v => typeof v === 'string').join('\n') } : null;
    }
    const name = item.type === 'commandExecution' ? 'Bash' : item.type === 'fileChange' ? 'Edit'
      : item.type === 'mcpToolCall' ? `mcp__${item.server}__${item.tool}` : undefined;
    if (!name) { return null; }
    const input = item.type === 'commandExecution' ? { command: item.command, cwd: item.cwd }
      : item.type === 'fileChange' ? { changes: item.changes } : isRecord(item.arguments) ? item.arguments : {};
    return { type: completed ? 'tool_result' : 'tool_use', toolCall: {
      id: itemId, name, input, kind: toolKind(name),
      status: completed ? (item.status === 'completed' ? 'completed' : 'failed') : 'running',
      ...(completed ? { output: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : JSON.stringify(item.result ?? item.changes ?? item.error ?? '') } : {}),
    } };
  }
  if (method === 'error' && isRecord(params.error)) {
    return { type: 'error', content: String(params.error.message || 'Codex app-server error') };
  }
  return null;
}
