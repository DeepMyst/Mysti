/**
 * Factory helpers for BrainstormManager tests.
 */
import { BrainstormManager } from '../../src/managers/BrainstormManager';
import { MockProviderManager } from './mockProviderManager';
import { setMockConfig } from './mockVscode';
import type { Settings, AgentType, StreamChunk, BrainstormStreamChunk, CollaborationStrategy } from '../../src/types';

// Mock extension context (minimal)
function createMockExtensionContext() {
  return {
    subscriptions: [],
    globalState: {
      get: () => undefined,
      update: () => Promise.resolve(),
      keys: () => [],
      setKeysForSync: () => {},
    },
    workspaceState: { get: () => undefined, update: () => Promise.resolve(), keys: () => [] },
    extensionPath: '/mock/extension',
    extensionUri: { fsPath: '/mock/extension', scheme: 'file', path: '/mock/extension' },
  } as any;
}

/**
 * Create a BrainstormManager wired to a MockProviderManager.
 */
export function createTestBrainstormManager(mockPM?: MockProviderManager): {
  manager: BrainstormManager;
  mockPM: MockProviderManager;
} {
  const pm = mockPM || new MockProviderManager();
  const ctx = createMockExtensionContext();
  const manager = new BrainstormManager(ctx, pm as any);
  return { manager, mockPM: pm };
}

/**
 * Configure brainstorm settings via mock vscode config.
 */
export function configureBrainstorm(options: {
  agents?: [AgentType, AgentType];
  strategy?: CollaborationStrategy;
  maxRounds?: number;
  autoConverge?: boolean;
  synthesisAgent?: AgentType;
}): void {
  if (options.agents) { setMockConfig('brainstorm.agents', options.agents); }
  if (options.strategy) { setMockConfig('brainstorm.strategy', options.strategy); }
  if (options.maxRounds !== undefined) { setMockConfig('brainstorm.maxDiscussionRounds', options.maxRounds); }
  if (options.autoConverge !== undefined) { setMockConfig('brainstorm.autoConverge', options.autoConverge); }
  if (options.synthesisAgent) { setMockConfig('brainstorm.synthesisAgent', options.synthesisAgent); }
}

/**
 * Create default settings for brainstorm tests.
 */
export function createMockSettings(overrides?: Partial<Settings>): Settings {
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
 * Helper to make text stream chunks for a provider.
 */
export function makeTextChunks(texts: string[]): StreamChunk[] {
  const chunks: StreamChunk[] = texts.map(t => ({ type: 'text', content: t }));
  chunks.push({ type: 'done', usage: { inputTokens: 100, outputTokens: 50 } });
  return chunks;
}

/**
 * Collect all chunks from a brainstorm async generator.
 */
export async function collectChunks(gen: AsyncGenerator<BrainstormStreamChunk>): Promise<BrainstormStreamChunk[]> {
  const chunks: BrainstormStreamChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}
