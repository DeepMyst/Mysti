/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import type { ChildProcess } from 'child_process';
import type { Settings, StreamChunk } from '../../types';
import { isRecord } from '../../utils/valueGuards';
import { toolKind } from '../../utils/toolNames';
import { nativeToolDecision } from '../base/NativeApprovalPolicy';
import type { NativeApprovalRequests } from '../base/NativeApprovalRequests';

/** Answers keyed as the question card keys them: header (or Q1…), question text or index. */
export type ClaudeQuestionAnswers = Record<string, string | string[]>;

export interface ClaudeControlState {
  settings: Pick<Settings, 'mode' | 'accessLevel'>;
  initialized: boolean;
  pendingPrompt?: string;
  /** Native AskUserQuestion requests by tool_use_id: held for the card, or answered early. */
  questions?: Map<string, { settle?: (answers: ClaudeQuestionAnswers | null) => void; early?: ClaudeQuestionAnswers | null }>;
}

const SKIPPED_QUESTION = 'The user skipped this question. Continue without this information or make a reasonable, stated assumption.';

/** Claude Code expects answers keyed by the question text; multi-select joins with ", ". */
function nativeAnswers(questions: unknown[], answers: ClaudeQuestionAnswers): Record<string, string> {
  return Object.fromEntries(questions.flatMap((item, index) => {
    const question = isRecord(item) && typeof item.question === 'string' ? item.question : undefined;
    const header = isRecord(item) && typeof item.header === 'string' && item.header ? item.header : `Q${index + 1}`;
    const value = question === undefined ? undefined : answers[header] ?? answers[question] ?? answers[String(index)];
    return value === undefined ? [] : [[question!, Array.isArray(value) ? value.join(', ') : value]];
  }));
}

/** Expect a native answer for a question Claude just asked (its can_use_tool follows). */
export function expectClaudeQuestion(state: ClaudeControlState | undefined, toolUseId: string): void {
  if (state?.initialized) { (state.questions ??= new Map()).set(toolUseId, {}); }
}

/** Deliver the user's answer (null = skipped). False when no native request owns this question. */
export function answerClaudeQuestion(state: ClaudeControlState | undefined, toolUseId: string, answers: ClaudeQuestionAnswers | null): boolean {
  const entry = state?.questions?.get(toolUseId);
  if (!entry) { return false; }
  if (entry.settle) { entry.settle(answers); } else { entry.early = answers; }
  return true;
}

const INITIALIZE_ID = 'mysti-initialize';
const HOOK_ID = 'mysti-pre-tool';

export function claudeUserMessage(prompt: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n';
}

export function initializeClaudeControl(state: ClaudeControlState, prompt: string): string {
  if (state.initialized) { return claudeUserMessage(prompt); }
  state.pendingPrompt = prompt;
  // A PreToolUse hook runs even when local allow rules would otherwise skip
  // can_use_tool. Return "ask" immediately, then hold the native permission
  // request (not the hook timeout) until the owning Mysti card resolves.
  return JSON.stringify({ type: 'control_request', request_id: INITIALIZE_ID, request: {
    subtype: 'initialize', hooks: { PreToolUse: [{ hookCallbackIds: [HOOK_ID] }] },
  } }) + '\n';
}

export function isClaudeControlFailure(data: Record<string, unknown>, state?: ClaudeControlState): boolean {
  // Only the outstanding initialization owns this response. A repeated frame
  // after success must not terminate a later turn on the same process.
  return !!state && !state.initialized && state.pendingPrompt !== undefined
    && data.type === 'control_response' && isRecord(data.response)
    && data.response.request_id === INITIALIZE_ID && data.response.subtype !== 'success';
}

/** Handles only SDK control frames; ordinary streaming stays in the provider. */
export function handleClaudeControl(
  data: Record<string, unknown>, state: ClaudeControlState | undefined,
  proc: ChildProcess | null, requests: NativeApprovalRequests | undefined,
): StreamChunk | null {
  const write = (message: Record<string, unknown>, target = proc) => {
    if (target?.stdin?.writable && !target.stdin.destroyed) { target.stdin.write(JSON.stringify(message) + '\n'); }
  };
  if (data.type === 'control_response') {
    const response = isRecord(data.response) ? data.response : {};
    if (response.request_id !== INITIALIZE_ID || !state || state.initialized) { return null; }
    if (response.subtype !== 'success') {
      state.pendingPrompt = undefined;
      return { type: 'error', content: 'Claude could not initialize native approvals. Update Claude Code and retry.' };
    }
    state.initialized = true;
    if (state.pendingPrompt !== undefined && proc?.stdin?.writable) {
      proc.stdin.write(claudeUserMessage(state.pendingPrompt));
      state.pendingPrompt = undefined;
    }
    return null;
  }
  if (data.type !== 'control_request' || typeof data.request_id !== 'string') { return null; }
  const request = isRecord(data.request) ? data.request : {};
  const reply = (response: Record<string, unknown>, target = proc) => write({ type: 'control_response', response: {
    subtype: 'success', request_id: data.request_id, response,
  } }, target);
  if (request.subtype === 'hook_callback') {
    const input = isRecord(request.input) ? request.input : {};
    const valid = state?.initialized && request.callback_id === HOOK_ID && input.hook_event_name === 'PreToolUse';
    const name = typeof input.tool_name === 'string' ? input.tool_name : 'UnknownTool';
    const deny = !valid || nativeToolDecision(state!.settings, name) === 'deny';
    reply({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: deny ? 'deny' : 'ask',
      permissionDecisionReason: deny ? 'Mysti read-only policy or unavailable approval owner.' : 'Mysti must review this tool call.',
    } });
    return null;
  }
  if (request.subtype === 'can_use_tool') {
    const name = typeof request.tool_name === 'string' ? request.tool_name : 'UnknownTool';
    const input = isRecord(request.input) ? request.input : {};
    const respond = (allowed: boolean, target = proc) => reply(allowed
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: 'Mysti denied or cancelled this operation.' }, target);
    // Claude Code's SDK contract for questions: hold this request while the
    // user answers the card, then allow with updatedInput.answers so Claude
    // continues the SAME turn. The inactivity clock pauses while it is held.
    const toolUseId = typeof request.tool_use_id === 'string' ? request.tool_use_id : '';
    const asked = name === 'AskUserQuestion' && Array.isArray(input.questions) ? input.questions : undefined;
    const entry = asked && toolUseId ? state?.questions?.get(toolUseId) : undefined;
    if (entry && requests) {
      const settle = requests.hold<ClaudeQuestionAnswers | null>(data.request_id, (answers, target) => {
        state!.questions!.delete(toolUseId);
        if (answers === 'cancelled' || answers === null) {
          reply({ behavior: 'deny', message: answers === null ? SKIPPED_QUESTION : 'The question was cancelled before the user answered.' }, target);
        } else {
          reply({ behavior: 'allow', updatedInput: { ...input, answers: nativeAnswers(asked!, answers) } }, target);
        }
      });
      if (settle) {
        if ('early' in entry) { settle(entry.early ?? null); } else { entry.settle = settle; }
        return null;
      }
    }
    // Fallback (no card owner): render the card from the stream and continue
    // in a scoped follow-up turn. Plans keep this handoff: never authorize a
    // plan-mode change implicitly or leave a second generic permission card.
    if (name === 'AskUserQuestion' || name === 'ExitPlanMode') {
      reply({ behavior: 'deny', message: name === 'AskUserQuestion'
        ? 'Mysti is presenting a pending question to the user. Their answer will arrive in a scoped follow-up message. End this turn and wait for that answer; do not infer an answer or describe this handoff as a refusal or cancellation.'
        : 'Mysti is presenting a pending plan for user review. Their decision and any execution instructions will arrive in a scoped follow-up message. Keep the current permission mode, end this turn, and wait; do not execute the plan or describe this handoff as a rejection.' });
      return null;
    }
    if (!state?.initialized || !requests) { respond(false); return null; }
    requests.request(data.request_id, {
      id: typeof request.tool_use_id === 'string' ? request.tool_use_id : data.request_id,
      name, input, kind: toolKind(name), status: 'running',
    }, nativeToolDecision(state.settings, name), (decision, target) => respond(decision === 'allow', target));
    return null;
  }
  // Unknown requests must not be mistaken for successful authorization.
  write({ type: 'control_response', response: { subtype: 'error', request_id: data.request_id,
    error: 'Unsupported Claude control request.',
  } });
  return null;
}
