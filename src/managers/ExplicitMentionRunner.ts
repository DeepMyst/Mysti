import { randomUUID } from 'crypto';
import { CollaborationManager, type CollaborationRunInput, type CollaboratorOutcome } from './CollaborationManager';
import { getProviderDisplayName } from '../providers/base/ProviderManifest';
import type { MentionPhase } from '../services/ExplicitMentionPlan';

/** Executes host-owned assignments; never asks the selected model to route them. */
export async function runExplicitMentions(
  manager: CollaborationManager,
  phases: MentionPhase[],
  input: Omit<CollaborationRunInput, 'brief' | 'collaborators'>,
  post: (message: { type: string; payload: Record<string, unknown> }) => void,
): Promise<string> {
  const outcomes: CollaboratorOutcome[] = [];
  let previous: CollaboratorOutcome[] = [];
  for (const [phaseIndex, phase] of phases.entries()) {
    if (input.isCancelled?.()) { return ''; }
    const runId = randomUUID();
    post({ type: 'collaborationStarted', payload: {
      runId, dependsOnPrevious: phase.dependsOnPrevious,
      phaseIndex, phaseCount: phases.length,
      nextAgents: phases[phaseIndex + 1]?.assignments.map(a => getProviderDisplayName(a.agentId)),
      nextDependsOnPrevious: phases[phaseIndex + 1]?.dependsOnPrevious,
      collaborators: phase.assignments.map(a => ({ agentId: a.agentId, roleId: a.roleId })),
    } });
    if (phase.dependsOnPrevious && previous.some(o => o.hasError || !o.text.trim())) {
      previous = phase.assignments.map((a, index) => ({
        collaboratorId: String(index), agentId: a.agentId,
        label: getProviderDisplayName(a.agentId), text: '', hasError: true,
        failure: 'Not run: the preceding assignment did not complete successfully.',
      }));
      outcomes.push(...previous);
      post({ type: 'collaborationError', payload: { runId, message: previous[0].failure } });
      post({ type: 'collaborationComplete', payload: { runId } });
      continue;
    }
    const gen = manager.run({
      ...input, brief: '', collaborators: phase.assignments,
      previousResults: phase.dependsOnPrevious
        ? previous.map(o => `${o.label}:\n${o.text}`).join('\n\n') : undefined,
    });
    try {
      let next = await gen.next();
      while (!next.done) {
        if (input.isCancelled?.()) { return ''; }
        post({ type: 'collaborator', payload: { ...next.value, runId } });
        next = await gen.next();
      }
      previous = next.value.outcomes;
      outcomes.push(...previous);
    } finally {
      await gen.return(undefined as never);
      if (!input.isCancelled?.()) { post({ type: 'collaborationComplete', payload: { runId } }); }
    }
  }
  // Save attributable results, not a new selected-provider answer that can
  // overwrite, impersonate, or repeat a participant's completed work.
  return outcomes.map(o => `## ${o.label}\n\n${o.hasError
    ? `Unable to complete this assignment: ${o.failure || 'provider error'}. No opinion was substituted.`
    : o.text.trim() || 'No response received.'}`).join('\n\n---\n\n');
}
