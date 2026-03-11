/**
 * Mock ProviderManager for testing BrainstormManager and MentionRouter
 * without spawning real CLI processes.
 */
import type { StreamChunk, ContextItem, Settings, Conversation, ProviderConfig, AgentType } from '../../src/types';
import type { PersonaConfig } from '../../src/providers/base/IProvider';

export interface MockStreamOptions {
  /** Delay (ms) between each chunk yield */
  delayMs?: number;
  /** If true, the stream will hang after yielding all chunks (never completes) */
  hang?: boolean;
  /** If set, throw this error after yielding chunks */
  throwAfter?: Error;
}

/**
 * Create an AsyncGenerator that yields the given chunks with optional delays.
 */
export async function* createMockStream(
  chunks: StreamChunk[],
  options: MockStreamOptions = {}
): AsyncGenerator<StreamChunk> {
  for (const chunk of chunks) {
    if (options.delayMs) {
      await new Promise(resolve => setTimeout(resolve, options.delayMs));
    }
    yield chunk;
  }
  if (options.throwAfter) {
    throw options.throwAfter;
  }
  if (options.hang) {
    // Never resolve — simulates a hung process
    await new Promise<void>(() => {});
  }
}

export type StreamFactory = (
  providerId: string,
  content: string,
  context: ContextItem[],
  settings: Settings,
  conversation: Conversation | null,
  persona?: PersonaConfig,
  panelId?: string
) => AsyncGenerator<StreamChunk>;

export interface ProviderStatusConfig {
  found: boolean;
  authenticated: boolean;
  path: string;
  installCommand?: string;
}

/**
 * MockProviderManager — drop-in replacement for ProviderManager in tests.
 */
export class MockProviderManager {
  /** Configure per-provider stream factories */
  public streamFactories: Map<string, StreamFactory> = new Map();

  /** Default stream factory used when no provider-specific one is set */
  public defaultStreamFactory: StreamFactory | null = null;

  /** Per-provider status overrides */
  public providerStatuses: Map<string, ProviderStatusConfig> = new Map();

  /** Available providers list */
  public availableProviders: ProviderConfig[] = [];

  /** Track cancelRequest calls for assertions */
  public cancelledPanelIds: string[] = [];

  /** Default model names per provider */
  public defaultModels: Map<string, string> = new Map();

  /** Context window sizes */
  public contextWindows: Map<string, number> = new Map();

  // ProviderManager interface methods

  async *sendMessageToProvider(
    providerId: string,
    content: string,
    context: ContextItem[],
    settings: Settings,
    conversation: Conversation | null,
    persona?: PersonaConfig,
    panelId?: string
  ): AsyncGenerator<StreamChunk> {
    const factory = this.streamFactories.get(providerId) || this.defaultStreamFactory;
    if (!factory) {
      throw new Error(`No stream factory configured for provider: ${providerId}`);
    }
    yield* factory(providerId, content, context, settings, conversation, persona, panelId);
  }

  cancelRequest(panelId: string): void {
    this.cancelledPanelIds.push(panelId);
  }

  async getProviderStatus(providerId: string): Promise<ProviderStatusConfig | null> {
    return this.providerStatuses.get(providerId) || null;
  }

  async getAvailableProviders(): Promise<ProviderConfig[]> {
    return this.availableProviders;
  }

  getProviderDefaultModel(providerId: string): string {
    return this.defaultModels.get(providerId) || `${providerId}-default-model`;
  }

  getModelContextWindow(_providerId: string, _model: string): number {
    return this.contextWindows.get(_providerId) || 200000;
  }

  // Convenience helpers

  /** Set up a provider that returns fixed chunks */
  setProviderChunks(providerId: string, chunks: StreamChunk[], options?: MockStreamOptions): void {
    this.streamFactories.set(providerId, () => createMockStream(chunks, options));
  }

  /** Set up a provider that is available and authenticated */
  setProviderAvailable(providerId: string, displayName?: string): void {
    this.providerStatuses.set(providerId, {
      found: true, authenticated: true, path: `/usr/bin/${providerId}`
    });
    // Add to available providers if not already there
    if (!this.availableProviders.find(p => p.name === providerId)) {
      this.availableProviders.push({
        name: providerId,
        displayName: displayName || providerId,
        description: `Mock ${providerId}`,
      } as ProviderConfig);
    }
  }

  /** Set up a provider that is installed but NOT authenticated */
  setProviderUnauthenticated(providerId: string): void {
    this.providerStatuses.set(providerId, {
      found: true, authenticated: false, path: `/usr/bin/${providerId}`
    });
  }

  /** Set up a provider that is NOT installed */
  setProviderNotInstalled(providerId: string, installCommand?: string): void {
    this.providerStatuses.set(providerId, {
      found: false, authenticated: false, path: '', installCommand
    });
  }

  /** Reset all state */
  reset(): void {
    this.streamFactories.clear();
    this.defaultStreamFactory = null;
    this.providerStatuses.clear();
    this.availableProviders = [];
    this.cancelledPanelIds = [];
    this.defaultModels.clear();
    this.contextWindows.clear();
  }

  // Stubs for methods that may be called but aren't relevant to tests
  registerProcess(): void {}
  suspendRequest(): boolean { return false; }
  resumeRequest(): boolean { return false; }
  dispose(): void {}
  disposePersistentProcess(): void {}
  setAgentContextManager(): void {}
}
