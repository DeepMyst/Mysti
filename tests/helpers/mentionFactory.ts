/**
 * Factory helpers for MentionRouter tests.
 */
import { MentionRouter } from '../../src/managers/MentionRouter';
import { MockProviderManager } from './mockProviderManager';
import type { Mention, MentionStreamChunk, Settings, AgentType } from '../../src/types';

/**
 * Create a MentionRouter wired to a MockProviderManager.
 */
export function createTestMentionRouter(mockPM?: MockProviderManager): {
  router: MentionRouter;
  mockPM: MockProviderManager;
} {
  const pm = mockPM || new MockProviderManager();
  const router = new MentionRouter(pm as any);
  return { router, mockPM: pm };
}

/**
 * Build an agent mention.
 */
export function agentMention(shortId: string, providerId: AgentType, startIndex = 0): Mention {
  const displayName = `@${shortId}`;
  return {
    type: 'agent',
    value: providerId,
    displayName,
    startIndex,
    endIndex: startIndex + displayName.length,
  };
}

/**
 * Build a file mention.
 */
export function fileMention(filePath: string, startIndex = 0): Mention {
  const displayName = `@${filePath.split('/').pop()}`;
  return {
    type: 'file',
    value: filePath,
    displayName,
    startIndex,
    endIndex: startIndex + displayName.length,
  };
}

/**
 * Create default settings for mention tests.
 */
export function createMentionSettings(overrides?: Partial<Settings>): Settings {
  return {
    provider: 'claude-code' as any,
    model: 'claude-default',
    mode: 'default',
    accessLevel: 'full-access',
    thinkingLevel: 'medium',
    contextMode: 'auto',
    ...overrides,
  } as Settings;
}

/**
 * Collect all chunks from a mention async generator.
 */
export async function collectMentionChunks(gen: AsyncGenerator<MentionStreamChunk>): Promise<MentionStreamChunk[]> {
  const chunks: MentionStreamChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}
