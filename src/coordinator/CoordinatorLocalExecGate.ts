import type { PermissionActionType, PermissionDetails, PermissionRiskLevel } from '../types';
import type { LocalExecGateInfo } from '../services/MystiLocalExec';

export interface CoordinatorPermissionRequest {
  action: PermissionActionType;
  title: string;
  description: string;
  details: PermissionDetails;
  forceInteractive?: boolean;
}

export interface CoordinatorLocalExecGatePorts {
  classifyAction(kind: string): PermissionActionType;
  classifyRisk(action: PermissionActionType): PermissionRiskLevel;
  shouldGate(kind: string): boolean;
  toolDetails(tool: { name: string; input?: unknown }): { toolName: string; toolInput?: Record<string, unknown> };
  request(request: CoordinatorPermissionRequest): Promise<boolean>;
  confirmRemoteEffect(command: string): Promise<boolean>;
}

/**
 * Local execution's approval policy, independent of panels and VS Code.
 * The host binds request/confirm to the owning run. A budget reservation never
 * bypasses this gate; remote effects always use the separate modal approval.
 */
export class CoordinatorLocalExecGate {
  constructor(
    private readonly _modelPinned: boolean,
    private readonly _ports: CoordinatorLocalExecGatePorts,
  ) {}

  async check(info: LocalExecGateInfo): Promise<boolean> {
    const action = this._ports.classifyAction(info.kind);
    const riskLevel = this._ports.classifyRisk(action);
    const modeGates = this._ports.shouldGate(info.kind);
    if (info.kind === 'bash') {
      if (info.remoteEffect) { return this._ports.confirmRemoteEffect(info.command || ''); }
      // Each condition is necessary: safe compounds and unsandboxed commands
      // still require an interactive card, even with full access/autonomy.
      const mayAutoRun = !modeGates && this._modelPinned && !!info.safe && !info.compound && !!info.sandboxed;
      if (mayAutoRun) { return true; }
      const netDesc = info.network ? 'NETWORK ENABLED (can reach the internet)' : 'no network';
      return this._ports.request({
        action: 'bash-command',
        title: 'Mysti wants to run a command',
        description: info.sandboxed
          ? `Mysti (coordinator) will run this command in a sandbox (${netDesc}, writes limited to the workspace):`
          : 'Mysti (coordinator) will run this UNSANDBOXED read-only command (no OS sandbox on this platform):',
        details: { command: info.command, workingDirectory: '.', riskLevel },
        forceInteractive: true,
      });
    }
    if (!modeGates) { return true; }
    if (info.kind === 'patch') {
      return this._ports.request({
        action: 'multi-file-edit',
        title: 'Mysti wants to apply a multi-file patch',
        description: `Mysti (coordinator) will change ${info.files?.length ?? 0} file(s): ${(info.files || []).slice(0, 8).join(', ')}${(info.files?.length || 0) > 8 ? '…' : ''}`,
        details: { files: (info.files || []).map(path => ({ path, action: 'edit' as const })), linesAdded: info.linesAdded, linesRemoved: info.linesRemoved, riskLevel },
      });
    }
    const verb = info.kind === 'write' ? (info.exists ? 'overwrite' : 'create') : 'edit';
    // Keep the actual bytes in the same size-capped shape as CLI tool cards.
    const toolCall = info.kind === 'write'
      ? { name: 'Write', input: { file_path: info.relPath, content: info.content } }
      : { name: 'Edit', input: { file_path: info.relPath, old_string: info.oldString, new_string: info.newString, ...(info.replaceAll ? { replace_all: true } : {}) } };
    return this._ports.request({
      action,
      title: `Mysti wants to ${verb} a file`,
      description: `Mysti (coordinator) will ${verb} ${info.relPath}`,
      details: {
        filePath: info.relPath, fileName: (info.relPath || '').split('/').pop(),
        linesAdded: info.linesAdded, linesRemoved: info.linesRemoved, riskLevel,
        ...this._ports.toolDetails(toolCall),
      },
    });
  }
}
