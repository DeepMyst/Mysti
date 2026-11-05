import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMockConfig } from '../helpers/mockVscode';
import { createTestCollaboratorPool, collabSpec, collabOptions, collectCollabChunks } from '../helpers/collaboratorFactory';
import type { StreamChunk } from '../../src/types';

beforeEach(clearMockConfig);
describe('PC-12 collaborator proposal evidence', () => {
  for (const provider of ['ollama', 'localai'] as const) {
    it.each([false, true])(`${provider} can propose a write without an execution gate (follow-up: %s)`, async followUp => {
      const { pool, mockPM } = createTestCollaboratorPool();
      mockPM.setProviderAvailable(provider);
      let capabilities = { toolCallsAreProposals: true };
      (mockPM as any).getProviderInstance = () => ({ capabilities });
      const suspend = (mockPM as any).suspendRequest = vi.fn(() => true);
      const gate = vi.fn(async () => false);
      let calls = 0;
      mockPM.streamFactories.set(provider, async function* () {
        if (followUp && calls++ === 0) {
          yield { type: 'ask_user_question', askUserQuestion: { questions: [{ question: 'Which predicate?', header: 'Predicate', options: [], multiSelect: false }] } } as StreamChunk;
          return;
        }
        // Even inconsistent tool-shaped claims from this transport are not
        // evidence that the host or another process executed anything.
        yield { type: 'tool_use', toolCall: { id: 'proposal', name: 'Edit', input: { file_path: '/owned/fixture.ts', old_string: 'x', new_string: 'y' }, status: 'completed' } } as StreamChunk;
        capabilities = { toolCallsAreProposals: false };
        yield { type: 'tool_result', toolCall: { id: 'proposal', name: 'Edit', input: {}, status: 'completed', output: 'Unsupported execution claim' } } as StreamChunk;
        yield { type: 'text', content: 'Propose a strict open-only filter; I have not edited it.' } as StreamChunk;
        yield { type: 'done' } as StreamChunk;
      });
      const chunks = await collectCollabChunks(pool.dispatch([collabSpec('review', provider)], collabOptions({ onGate: gate, onQuestion: async () => ({ answers: { Predicate: 'Open only' } }) })));
      expect(chunks.some(c => c.type === 'collab_tool_denied')).toBe(false);
      expect(gate).not.toHaveBeenCalled(); expect(suspend).not.toHaveBeenCalled();
      expect(chunks.find(c => c.type === 'collab_tool_use')?.toolCall).toMatchObject({ status: 'proposed', proposalOnly: true });
      expect(chunks.some(c => c.type === 'collab_tool_result')).toBe(false);
      expect(chunks.find(c => c.type === 'collab_complete')).toMatchObject({ hasError: false, responseText: expect.stringContaining('strict open-only') });
    });
  }
});
