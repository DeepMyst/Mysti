/** Mysti — SPDX-License-Identifier: Apache-2.0 */
import type { Settings } from '../../types';
import { shouldGateToolUse } from '../../utils/permissionClassifier';

type ApprovalSettings = Pick<Settings, 'mode' | 'accessLevel'>;

/** Native restrictions take precedence: the stream gate delegates these tiers to the provider. */
function isReadOnly(settings: ApprovalSettings): boolean {
  return settings.accessLevel === 'read-only'
    || settings.mode === 'quick-plan'
    || settings.mode === 'detailed-plan';
}

/** Resolve a blocking ACP request using the same authority policy as chat. */
export function allowsAcpToolWithoutPrompt(settings: ApprovalSettings, kind: string): boolean {
  if (kind === 'read' || kind === 'search' || kind === 'think') { return true; }
  if (isReadOnly(settings)) { return false; }

  // ACP reports semantic kinds instead of the tool names used by the shared
  // classifier. A move is an edit; unfamiliar kinds require command authority.
  const toolName = kind === 'edit' || kind === 'move' ? 'Edit'
    : kind === 'delete' ? 'Delete'
    : kind === 'fetch' ? 'WebFetch'
    : 'Bash';
  return !shouldGateToolUse(settings, toolName);
}

/** Whether a noninteractive CLI may receive an unrestricted auto-approve flag. */
export function allowsUnrestrictedNativeTools(settings: ApprovalSettings): boolean {
  if (isReadOnly(settings)) { return false; }
  // Check every side-effect class rather than treating auto-edit as autonomy.
  return ['Write', 'Edit', 'Delete', 'Bash', 'WebFetch', 'Agent', 'UnknownTool']
    .every(toolName => !shouldGateToolUse(settings, toolName));
}
