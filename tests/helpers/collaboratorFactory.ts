/**
 * Factory helpers for CollaboratorPool tests (Plan 14).
 */
import { CollaboratorPool } from '../../src/services/CollaboratorPool';
import { MockProviderManager } from './mockProviderManager';
import type {
  CollaboratorSpec,
  CollaboratorChunk,
  CollaboratorDispatchOptions,
  Settings,
  AgentType,
  CollaboratorAccess,
} from '../../src/types';

export function createTestCollaboratorPool(mockPM?: MockProviderManager): {
  pool: CollaboratorPool;
  mockPM: MockProviderManager;
} {
  const pm = mockPM || new MockProviderManager();
  const pool = new CollaboratorPool(pm as any);
  return { pool, mockPM: pm };
}

export function collabSpec(
  collaboratorId: string,
  agentId: AgentType,
  overrides?: Partial<CollaboratorSpec>
): CollaboratorSpec {
  return {
    collaboratorId,
    agentId,
    prompt: `Task for ${collaboratorId}`,
    access: 'read-only' as CollaboratorAccess,
    label: collaboratorId,
    ...overrides,
  };
}

export function collabSettings(overrides?: Partial<Settings>): Settings {
  return {
    provider: 'claude-code' as any,
    model: 'claude-default',
    mode: 'default',
    accessLevel: 'ask-permission',
    thinkingLevel: 'medium',
    contextMode: 'auto',
    ...overrides,
  } as Settings;
}

export function collabOptions(overrides?: Partial<CollaboratorDispatchOptions>): CollaboratorDispatchOptions {
  return {
    settings: collabSettings(),
    panelId: 'panel-1',
    runId: 'run-1',
    ...overrides,
  };
}

export async function collectCollabChunks(
  gen: AsyncGenerator<CollaboratorChunk>
): Promise<CollaboratorChunk[]> {
  const chunks: CollaboratorChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}
