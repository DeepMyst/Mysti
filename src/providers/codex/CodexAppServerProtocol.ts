/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import type { ChildProcess } from 'child_process';
import type { Settings, StreamChunk } from '../../types';
import type { NativeApprovalRequests } from '../base/NativeApprovalRequests';
import { allowsUnrestrictedNativeTools, nativeToolDecision } from '../base/NativeApprovalPolicy';
import { isRecord } from '../../utils/valueGuards';
import { toolKind } from '../../utils/toolNames';
import { version as extensionVersion } from '../../../package.json';

/** Answers keyed as the question card keys them: header (or Q1…) or question text. */
export type CodexQuestionAnswers = Record<string, string | string[]>;

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
  /** Distinct native assistant messages need a boundary in the flattened reply. */
  assistantTextItem?: { id: string; trailingLineBreaks: string; needsBoundary: boolean };
  /** Notifications can precede the authoritative turn/start RPC response. */
  pendingNotifications?: Record<string, unknown>[];
  pendingNotificationBytes?: number;
  pendingChunks?: StreamChunk[];
  /** A malformed transport must be replaced before accepting another turn. */
  protocolFailed?: boolean;
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
  contextWindow?: number;
  /** Held request_user_input requests by card toolCallId; null = skipped. */
  questions?: Map<string, (answers: CodexQuestionAnswers | null) => void>;
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
  state.assistantTextItem = undefined;
  state.pendingNotifications = []; state.pendingNotificationBytes = 0; state.pendingChunks = [];
  const planning = state.settings.mode === 'quick-plan' || state.settings.mode === 'detailed-plan';
  return request(state, 'turn/start', {
    threadId: state.threadId, input: [{ type: 'text', text: prompt, text_elements: [] }], effort: state.effort,
    // Codex's own Plan mode (its prompt, <proposed_plan>, request_user_input).
    // The mode is sticky on the thread, so other turns reset it to Default.
    // null instructions = Codex's built-in ones; the sandbox stays policy()'s.
    ...(state.model ? { collaborationMode: { mode: planning ? 'plan' : 'default',
      settings: { model: state.model, reasoning_effort: state.effort ?? null, developer_instructions: null } } } : {}),
  });
}

/** Codex wants { [questionId]: { answers: string[] } }. */
function codexAnswers(questions: Record<string, unknown>[], answers: CodexQuestionAnswers): Record<string, { answers: string[] }> {
  return Object.fromEntries(questions.flatMap((question, index) => {
    const value = answers[questionHeader(question)] ?? answers[`Q${index + 1}`] ?? answers[String(question.question)];
    return value === undefined || !nonblank(question.id) ? [] : [[question.id, { answers: Array.isArray(value) ? value : [value] }]];
  }));
}
const questionHeader = (question: Record<string, unknown>) => String(question.header || question.id || 'Question');
const questionCallId = (state: CodexAppServerState, requestId: unknown) => `codex-question-${state.threadId}-${state.turnId}-${requestId}`;

/** Deliver the user's answer (null = skipped). False when no held request owns this question. */
export function answerCodexQuestion(state: CodexAppServerState | undefined, toolCallId: string, answers: CodexQuestionAnswers | null): boolean {
  const settle = state?.questions?.get(toolCallId);
  settle?.(answers);
  return !!settle;
}

const scopedMethods = new Set(['turn/started', 'turn/completed', 'item/agentMessage/delta', 'item/plan/delta',
  'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta', 'thread/tokenUsage/updated',
  'item/started', 'item/completed', 'error', 'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval', 'item/tool/requestUserInput']);
const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
function assistantText(state: CodexAppServerState, itemId: unknown, content: string): StreamChunk {
  if (!content || !nonblank(itemId)) { return { type: 'text', content }; }
  const previous = state.assistantTextItem;
  let needsBoundary = !!previous && (previous.id !== itemId || previous.needsBoundary);
  let separator = '';
  // Leading newlines may arrive as separate deltas. Wait for text before
  // filling the boundary so already formatted items do not gain blank lines.
  if (needsBoundary && !/^[\r\n]+$/.test(content)) {
    const leading = content.match(/^[\r\n]*/)?.[0] || '';
    const boundaryNewlines = ((previous?.trailingLineBreaks || '') + leading).split('\n').length - 1;
    separator = '\n'.repeat(Math.max(0, 2 - boundaryNewlines));
    needsBoundary = false;
  }
  const text = separator + content;
  // Four trailing bytes retain two CRLFs even when a CR and its LF arrive
  // separately. No assistant content beyond those line breaks is retained.
  const trailingLineBreaks = ((previous?.trailingLineBreaks || '') + text).match(/[\r\n]*$/)?.[0].slice(-4) || '';
  state.assistantTextItem = { id: itemId, needsBoundary, trailingLineBreaks };
  return { type: 'text', content: text };
}
function matchesTurn(data: Record<string, unknown>, state: CodexAppServerState, turnId = state.turnId): boolean {
  const params = isRecord(data.params) ? data.params : {};
  const id = data.method === 'turn/started' || data.method === 'turn/completed'
    ? (isRecord(params.turn) ? params.turn.id : undefined) : params.turnId;
  return nonblank(turnId) && params.threadId === state.threadId && id === turnId;
}
function waitingForTurn(state: CodexAppServerState): boolean {
  return !state.turnId && [...state.requests.values()].includes('turn/start');
}
function shouldBuffer(data: Record<string, unknown>, state: CodexAppServerState): boolean {
  return typeof data.method === 'string' && scopedMethods.has(data.method) && waitingForTurn(state)
    && isRecord(data.params) && data.params.threadId === state.threadId;
}
function bufferWouldOverflow(data: Record<string, unknown>, state: CodexAppServerState): boolean {
  // A broken backend must not accumulate an unbounded pre-acknowledgement
  // stream. Fail visibly instead of dropping potentially valid output.
  return (state.pendingNotifications?.length || 0) >= 1024
    || (state.pendingNotificationBytes || 0) + JSON.stringify(data).length > 1024 * 1024;
}
function invalidRpcResult(method: string, data: Record<string, unknown>): boolean {
  if (!isRecord(data.result)) { return true; }
  const result = data.result;
  if (method === 'config/read') {
    if (!isRecord(result.config)) { return true; }
    return ['mcp_servers', 'apps'].some(key => result.config && isRecord(result.config)
      && result.config[key] !== undefined && result.config[key] !== null && !isRecord(result.config[key]));
  }
  if (method === 'thread/start' || method === 'thread/resume') { return !isRecord(result.thread) || !nonblank(result.thread.id); }
  if (method === 'turn/start') { return !isRecord(result.turn) || !nonblank(result.turn.id); }
  return false;
}

export function codexAppServerInput(state: CodexAppServerState, prompt: string): string {
  if (state.initialized && state.threadId) { return turn(state, prompt); }
  state.pendingPrompt = prompt;
  return request(state, 'initialize', { clientInfo: { name: 'mysti', title: 'Mysti', version: extensionVersion },
    // Plan collaboration mode and request_user_input are experimental API.
    capabilities: { experimentalApi: true, requestAttestation: false } });
}

export function isCodexAppServerBoundary(data: Record<string, unknown>, state?: CodexAppServerState): boolean {
  if (state && shouldBuffer(data, state) && bufferWouldOverflow(data, state)) { return true; }
  if (data.method === 'turn/completed') {
    return !state || matchesTurn(data, state);
  }
  if (data.method !== undefined || typeof data.id !== 'number') { return false; }
  if (!state) { return isRecord(data.error); }
  const pending = state.requests.get(data.id);
  if (!pending) { return false; }
  if (isRecord(data.error) || invalidRpcResult(pending, data)) { return true; }
  const result = data.result as Record<string, unknown>;
  const resultTurnId = isRecord(result.turn) ? result.turn.id : undefined;
  return pending === 'turn/start' && typeof resultTurnId === 'string'
    && !!state.pendingNotifications?.some(value => value.method === 'turn/completed' && matchesTurn(value, state, resultTurnId));
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
      state.pendingNotifications = []; state.pendingNotificationBytes = 0;
      return { type: 'error', content: `Codex ${pending} failed: ${String(data.error.message || 'Unknown app-server error')}` };
    }
    if (invalidRpcResult(pending, data)) {
      state.pendingPrompt = undefined;
      state.protocolFailed = true;
      state.pendingNotifications = []; state.pendingNotificationBytes = 0;
      return { type: 'error', content: `Codex returned an invalid ${pending} response. Update the CLI and retry.` };
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
      state.threadId = thread.id as string; state.initialized = true;
      // Collaboration mode settings need the model the thread actually runs.
      if (!state.model && nonblank(result.model)) { state.model = result.model; }
      if (!state.effort && nonblank(result.reasoningEffort)) { state.effort = result.reasoningEffort; }
      const prompt = state.pendingPrompt; state.pendingPrompt = undefined;
      if (prompt !== undefined) { send(turn(state, prompt)); }
      return { type: 'session_active', sessionId: state.threadId };
    } else if (pending === 'turn/start' && isRecord(result.turn) && typeof result.turn.id === 'string') {
      state.turnId = result.turn.id;
      const queued = state.pendingNotifications || [];
      state.pendingNotifications = []; state.pendingNotificationBytes = 0;
      const chunks: StreamChunk[] = [];
      for (const notification of queued) {
        const chunk = handleCodexAppServer(notification, state, proc, approvals);
        if (chunk) { chunks.push(chunk); }
        if (notification.method === 'turn/completed' && matchesTurn(notification, state)) { break; }
      }
      const first = chunks.shift() || null;
      (state.pendingChunks ||= []).push(...chunks);
      return first;
    }
    return null;
  }

  if (shouldBuffer(data, state)) {
    if (bufferWouldOverflow(data, state)) {
      state.pendingNotifications = []; state.pendingNotificationBytes = 0;
      state.protocolFailed = true;
      return { type: 'error', content: 'Codex sent too much output before acknowledging the turn. Update the CLI and retry.' };
    }
    (state.pendingNotifications ||= []).push(data);
    state.pendingNotificationBytes = (state.pendingNotificationBytes || 0) + JSON.stringify(data).length;
    return null;
  }

  const id = data.id;
  if (typeof id === 'string' || typeof id === 'number') {
    const respond = (result: Record<string, unknown>, target = proc) => send(json({ id, result }), target);
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      if (!matchesTurn(data, state) || !approvals) { respond({ decision: 'cancel' }); return null; }
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
      const asked = (Array.isArray(params.questions) ? params.questions : []).filter(isRecord);
      const toolCallId = questionCallId(state, id);
      // Mysti has no secret input: never show a secret question as a plain card
      // (nor keep or replay its answer). Codex continues without an answer.
      const owned = matchesTurn(data, state) && !asked.some(question => question.isSecret === true);
      // Codex's own contract: hold the request until the card answers, so the
      // turn continues with the user's answers. Skipped/cancelled = no answers.
      const settle = owned ? approvals?.hold<CodexQuestionAnswers | null>(id, (answers, target) => {
        state.questions?.delete(toolCallId);
        respond({ answers: answers === 'cancelled' || answers === null ? {} : codexAnswers(asked, answers) }, target);
      }) : undefined;
      if (settle) { (state.questions ||= new Map()).set(toolCallId, settle); } else { respond({ answers: {} }); }
      if (!owned) { return null; }
      return { type: 'ask_user_question', askUserQuestion: {
        toolCallId,
        questions: asked.map(question => ({
          header: questionHeader(question), question: String(question.question || ''), multiSelect: false,
          options: (Array.isArray(question.options) ? question.options : []).filter(isRecord).filter(option => nonblank(option.label)).map(option => ({
            label: String(option.label), description: String(option.description || ''),
          })),
        })),
      } };
    } else {
      send(json({ id, error: { code: -32601, message: 'Unsupported Mysti host request' } }));
    }
    return null;
  }
  if (scopedMethods.has(method) && !matchesTurn(data, state)) { return null; }
  if (method === 'serverRequest/resolved' && params.threadId === state.threadId) {
    // Codex resolved a held question itself (non-blocking or interrupted):
    // release it so a later card answer becomes a follow-up, not a lost reply.
    // The server ignores the now-stale empty response.
    state.questions?.get(questionCallId(state, params.requestId))?.(null);
    return null;
  }
  if (method === 'turn/started' && isRecord(params.turn) && typeof params.turn.id === 'string') {
    state.turnId = params.turn.id; return null;
  }
  if (method === 'item/agentMessage/delta' || method === 'item/plan/delta' || method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
    if (typeof params.itemId === 'string') { state.streamed.add(params.itemId); }
    if (typeof params.delta !== 'string') { return null; }
    return method === 'item/agentMessage/delta' || method === 'item/plan/delta'
      ? assistantText(state, params.itemId, params.delta) : { type: 'thinking', content: params.delta };
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
      return completed && !state.streamed.has(itemId) && typeof item.text === 'string' ? assistantText(state, itemId, item.text) : null;
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
    // The app-server reports reconnect attempts as error notifications with
    // willRetry=true. They are progress, not a failed Mysti turn: forwarding
    // them as terminal errors stops collaboration before the final auth or
    // transport result and can needlessly replay the whole prompt.
    if (params.willRetry === true) { return null; }
    return { type: 'error', content: String(params.error.message || 'Codex app-server error') };
  }
  return null;
}
