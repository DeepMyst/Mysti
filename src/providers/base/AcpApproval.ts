/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import type { ChildProcess } from 'child_process';
import type { Settings } from '../../types';
import { isRecord } from '../../utils/valueGuards';
import { toolKind } from '../../utils/toolNames';
import type { NativeApprovalRequest } from './IProvider';
import { acpApprovalDecision } from './NativeApprovalPolicy';
import type { NativeApprovalDecision, NativeApprovalRequests } from './NativeApprovalRequests';

/** ACP permission responses always target the process that issued the request. */
export function respondToAcpApproval(options: {
  id: string | number;
  params: Record<string, unknown> | undefined;
  settings: Pick<Settings, 'mode' | 'accessLevel'>;
  process: ChildProcess | null;
  sessionId: string | null;
  trackedTools: ReadonlyMap<string, { id: string; name: string; input: Record<string, unknown> }>;
  requests: NativeApprovalRequests | undefined;
}): void {
  const { id, params, process: proc } = options;
  const rawTool = params?.toolCall ?? params?.tool_call;
  const tool = isRecord(rawTool) ? rawTool : {};
  const toolId = String(tool.toolCallId ?? tool.tool_call_id ?? `permission-${id}`);
  const tracked = options.trackedTools.get(toolId);
  const reportedKind = typeof tool.kind === 'string' ? tool.kind.toLowerCase() : '';
  const trackedName = tracked?.name.toLowerCase();
  // A permission request may contain only toolCallId; ACP updates carry the
  // rest of the tool's data. Do not lose a previously reported read/edit kind.
  const kind = reportedKind || (trackedName === 'read' ? 'read'
    : trackedName === 'grep' ? 'search'
    : trackedName === 'think' ? 'think'
    : trackedName === 'edit' ? 'edit'
    : trackedName === 'move' ? 'move'
    : trackedName === 'delete' ? 'delete'
    : trackedName === 'webfetch' ? 'fetch'
    : trackedName === 'bash' ? 'execute' : '');
  const name = kind === 'read' ? 'Read'
    : kind === 'search' ? 'Grep'
    : kind === 'think' ? 'Think'
    : kind === 'edit' || kind === 'move' ? 'Edit'
    : kind === 'delete' ? 'Delete'
    : kind === 'fetch' ? 'WebFetch'
    : kind === 'execute' ? 'Bash'
    : tracked?.name || 'UnknownTool';
  const rawInput = tool.rawInput ?? tool.raw_input;
  const input = isRecord(rawInput) ? rawInput : tracked?.input || {};
  const toolCall: NativeApprovalRequest['toolCall'] = {
    id: toolId, name, input, status: 'running', kind: toolKind(name),
  };
  const permissionOptions = Array.isArray(params?.options) ? params.options.filter(isRecord) : [];
  const pick = (wanted: readonly string[]): string | undefined => {
    for (const desired of wanted) {
      const match = permissionOptions.find(option => {
        const optionId = option.optionId ?? option.option_id;
        return typeof optionId === 'string' && optionId.length > 0
          && (option.kind !== undefined ? option.kind === desired : optionId === desired);
      });
      if (match) { return String(match.optionId ?? match.option_id); }
    }
    return undefined;
  };
  // A Mysti card approves one operation, never a persistent native grant.
  const allowed = pick(['allow_once']);
  const denied = pick(['deny', 'deny_always', 'reject_once', 'reject_always']);
  const suppliedSession = params?.sessionId ?? params?.session_id;
  const wrongSession = Boolean(options.sessionId && suppliedSession !== options.sessionId);
  const respond = (decision: NativeApprovalDecision, target: ChildProcess | null) => {
    if (wrongSession) { decision = 'cancelled'; }
    const chosen = decision === 'allow' ? allowed ?? denied : decision === 'deny' ? denied : undefined;
    const result = chosen
      ? { outcome: { outcome: 'selected', optionId: chosen } }
      : { outcome: { outcome: 'cancelled' } };
    writeApprovalResponse(target, JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  };
  const defaultDecision = allowed && !wrongSession ? acpApprovalDecision(options.settings, kind) : 'deny';
  if (options.requests) {
    options.requests.request(id, toolCall, defaultDecision, respond);
  } else {
    // Standalone parsing/diagnostics has no live turn owner to display a card.
    respond(defaultDecision === 'allow' ? 'allow' : 'deny', proc);
  }
}

function writeApprovalResponse(target: ChildProcess | null, message: string): void {
  const stdin = target?.stdin;
  if (!target || !stdin?.writable || stdin.destroyed) { return; }
  const cleanup = () => {
    stdin.removeListener('error', failed);
    stdin.removeListener('close', cleanup);
  };
  const failed = () => {
    cleanup();
    // A closed input pipe cannot complete the ACP exchange. End this captured
    // child so its reader and any other pending requests settle promptly.
    try { target.kill(); } catch { /* The child may already have exited. */ }
  };
  stdin.once('error', failed);
  stdin.once('close', cleanup);
  try {
    stdin.write(message, error => {
      // Node invokes a failed write callback before emitting `error`; keep the
      // listener through that event so an EPIPE never escapes into the host.
      if (!error) { cleanup(); }
    });
  } catch {
    failed();
  }
}
