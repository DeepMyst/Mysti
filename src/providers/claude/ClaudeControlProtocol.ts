/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import type { ChildProcess } from 'child_process';
import type { Settings, StreamChunk } from '../../types';
import { isRecord } from '../../utils/valueGuards';
import { toolKind } from '../../utils/toolNames';
import { nativeToolDecision } from '../base/NativeApprovalPolicy';
import type { NativeApprovalRequests } from '../base/NativeApprovalRequests';

export interface ClaudeControlState {
  settings: Pick<Settings, 'mode' | 'accessLevel'>;
  initialized: boolean;
  pendingPrompt?: string;
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

export function isClaudeControlFailure(data: Record<string, unknown>): boolean {
  return data.type === 'control_response' && isRecord(data.response)
    && data.response.request_id === INITIALIZE_ID && data.response.subtype === 'error';
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
    // Mysti renders these native tools as question/plan cards from the stream.
    // Their answers start a scoped follow-up turn; never leave a second generic
    // permission card pending or authorize a plan-mode change implicitly.
    if (name === 'AskUserQuestion' || name === 'ExitPlanMode') { respond(false); return null; }
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
