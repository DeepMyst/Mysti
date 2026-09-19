/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import type { ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import type { Settings } from '../../types';
import type { NativeApprovalRequests } from '../base/NativeApprovalRequests';
import { classifyToolAction, isNeverGatedAction, shouldGateToolUse } from '../../utils/permissionClassifier';
import { toolKind } from '../../utils/toolNames';
import { isRecord } from '../../utils/valueGuards';
import { VERIFIED_NATIVE_CLI_VERSIONS } from '../base/NativeCliVersions';

/** Explicit tool surface: delegated/background runtimes have no turn ownership proof. */
export const CLAUDE_NATIVE_TOOLS = [
  'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit',
  'WebFetch', 'WebSearch', 'TodoWrite', 'EnterPlanMode', 'ExitPlanMode',
] as const;
export const CLAUDE_NATIVE_VERSIONS = new Set<string>([VERIFIED_NATIVE_CLI_VERSIONS['claude-code']]);
export const CLAUDE_NATIVE_POLICY = { disableAllHooks: true, permissions: { ask: ['*'] } } as const;
const SUPPORTED_TOOLS = new Set<string>(CLAUDE_NATIVE_TOOLS);
const MAX_REQUESTS = 4096;
const MAX_PENDING = 64;
const MAX_INPUT_BYTES = 1024 * 1024;

type Authority = Pick<Settings, 'mode' | 'accessLevel'>;

export function claudeApprovalDecision(settings: Authority, name: string, input: Record<string, unknown>): 'allow' | 'ask' | 'deny' {
  const canvas = name.startsWith('mcp__mysti-canvas__');
  if (!SUPPORTED_TOOLS.has(name) && !canvas) { return 'deny'; }
  if (name === 'ExitPlanMode' || name === 'EnterPlanMode') { return 'deny'; }
  if (input.run_in_background === true || input.dangerouslyDisableSandbox === true) { return 'deny'; }
  const action = classifyToolAction(name);
  const restricted = settings.accessLevel === 'read-only' || settings.mode === 'quick-plan' || settings.mode === 'detailed-plan';
  if (restricted && !isNeverGatedAction(action)) { return 'deny'; }
  return shouldGateToolUse(settings, name) ? 'ask' : 'allow';
}

/** Freeze the exact final native arguments before handing them to host observers. */
function freezeInput(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) { throw new Error('Claude permission request has no final input object.'); }
  let values = 0;
  const visit = (value: unknown, depth: number): void => {
    if (++values > 100000 || depth > 32) { throw new Error('Claude permission input exceeds its structural limit.'); }
    if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) { visit(child, depth + 1); }
      Object.freeze(value);
    }
  };
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_INPUT_BYTES) { throw new Error('Claude permission input exceeds its size limit.'); }
  visit(input, 0);
  return input;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

/** One issuing process owns the wire IDs; no response is copied to its replacement. */
export class ClaudeApprovalTransport {
  private readonly _seen = new Map<string, { fingerprint: string; settled: boolean }>();
  private _attested = false;
  private _failed = false;

  constructor(private readonly _process: ChildProcess) {}

  attest(version: unknown): void {
    if (typeof version !== 'string' || !CLAUDE_NATIVE_VERSIONS.has(version)) {
      throw new Error(`Claude Code ${String(version)} has no verified Mysti permission bridge; use Claude Code 2.1.266.`);
    }
    this._attested = true;
  }

  handle(data: Record<string, unknown>, requests: NativeApprovalRequests | undefined, settings: Authority | undefined): void {
    const id = data.request_id;
    if (!validId(id)) { throw new Error('Claude control request has an invalid request ID.'); }
    if (data.type === 'control_cancel_request') {
      const previous = this._seen.get(id);
      if (previous) { previous.settled = true; }
      else {
        if (this._seen.size >= MAX_REQUESTS) { throw new Error('Claude permission request limit reached; start a fresh process.'); }
        this._seen.set(id, { fingerprint: '', settled: true });
      }
      requests?.cancel(id);
      return;
    }
    const request = data.request;
    if (!isRecord(request) || request.subtype !== 'can_use_tool') {
      this._write({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'Mysti does not support this Claude control request.' } });
      return;
    }
    const name = request.tool_name;
    const toolId = request.tool_use_id;
    if (!validId(name) || !validId(toolId)) { throw new Error('Claude permission request has an invalid tool identity.'); }
    const input = freezeInput(request.input);
    const fingerprint = createHash('sha256').update(JSON.stringify([toolId, name, input])).digest('hex');
    const previous = this._seen.get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.settled) {
        throw new Error('Claude reused a permission request ID after its authority changed.');
      }
      return;
    }
    if (this._seen.size >= MAX_REQUESTS) { throw new Error('Claude permission request limit reached; start a fresh process.'); }
    if ([...this._seen.values()].filter(entry => !entry.settled).length >= MAX_PENDING) {
      throw new Error('Claude has too many concurrent permission requests.');
    }
    const entry = { fingerprint, settled: false };
    this._seen.set(id, entry);
    // Read permission frames omit matched_ask_rule. The packaged wildcard
    // policy is verified before submission; this field is only diagnostic.
    const decision = this._attested && !this._failed && settings && requests
      ? claudeApprovalDecision(settings, name, input) : 'deny';
    const respond = (allowed: boolean): void => {
      entry.settled = true;
      this._write({ type: 'control_response', response: { subtype: 'success', request_id: id,
        response: allowed && !this._failed
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'This action was denied or cancelled by the current Mysti turn.' },
      } });
    };
    if (!requests) { respond(false); return; }
    requests.request(id, { id: toolId, name, input, kind: toolKind(name), status: 'running' }, decision, result => respond(result === 'allow'));
  }

  fail(): void {
    this._failed = true;
  }

  private _write(frame: unknown): void {
    const stdin = this._process.stdin;
    if (!stdin?.writable || stdin.destroyed) { return; }
    try {
      stdin.write(JSON.stringify(frame) + '\n', error => {
        if (error) { this._failed = true; try { this._process.kill(); } catch { /* already closed */ } }
      });
    } catch {
      this._failed = true;
      try { this._process.kill(); } catch { /* already closed */ }
    }
  }
}
