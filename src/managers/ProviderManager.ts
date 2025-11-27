import * as vscode from 'vscode';
import { ProviderRegistry } from '../providers/ProviderRegistry';
import type { ICliProvider, PersonaConfig } from '../providers/base/IProvider';
import type {
  ContextItem,
  Settings,
  Conversation,
  StreamChunk,
  ProviderConfig,
  ModelInfo
} from '../types';

/**
 * ProviderManager - Facade over the ProviderRegistry
 * Provides backward-compatible API while delegating to the registry
 */
export class ProviderManager {
  private _registry: ProviderRegistry;
  private _extensionContext: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this._extensionContext = context;
    this._registry = new ProviderRegistry(context);
  }

  /**
   * Initialize the provider manager and all providers
   */
  public async initialize(): Promise<void> {
    await this._registry.initializeAll();
  }

  /**
   * Get the active provider based on settings or default
   */
  private _getActiveProvider(providerId?: string): ICliProvider {
    const id = providerId || this._getDefaultProviderId();
    const provider = this._registry.get(id);

    if (!provider) {
      // Fallback to claude-code if requested provider not found
      const fallback = this._registry.get('claude-code');
      if (fallback) {
        console.warn(`[Mysti] Provider ${id} not found, falling back to claude-code`);
        return fallback;
      }
      throw new Error(`Provider not found: ${id}`);
    }

    return provider;
  }

  /**
   * Get the default provider ID from settings
   */
  private _getDefaultProviderId(): string {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<string>('defaultProvider', 'claude-code');
  }

  // Public API

  /**
   * Get all registered providers' configurations
   */
  public getProviders(): ProviderConfig[] {
    return this._registry.getAll().map(p => p.config);
  }

  /**
   * Get a specific provider's configuration
   */
  public getProvider(name: string): ProviderConfig | undefined {
    return this._registry.get(name)?.config;
  }

  /**
   * Get available models for a provider
   */
  public getModels(providerName: string): ModelInfo[] {
    const provider = this._registry.get(providerName);
    return provider ? provider.config.models : [];
  }

  /**
   * Get the provider registry (for advanced use cases like brainstorm)
   */
  public getRegistry(): ProviderRegistry {
    return this._registry;
  }

  /**
   * Send a message to the active provider
   */
  public async *sendMessage(
    content: string,
    context: ContextItem[],
    settings: Settings,
    conversation: Conversation | null,
    persona?: PersonaConfig
  ): AsyncGenerator<StreamChunk> {
    const provider = this._getActiveProvider(settings.provider);
    yield* provider.sendMessage(content, context, settings, conversation, persona);
  }

  /**
   * Send a message to a specific provider by ID
   * Used for brainstorm mode when querying multiple providers
   */
  public async *sendMessageToProvider(
    providerId: string,
    content: string,
    context: ContextItem[],
    settings: Settings,
    conversation: Conversation | null,
    persona?: PersonaConfig
  ): AsyncGenerator<StreamChunk> {
    const provider = this._getActiveProvider(providerId);
    yield* provider.sendMessage(content, context, settings, conversation, persona);
  }

  /**
   * Cancel the current request on all providers
   */
  public cancelCurrentRequest(): void {
    for (const provider of this._registry.getAll()) {
      provider.cancelCurrentRequest();
    }
  }

  /**
   * Clear session on the default provider
   */
  public clearSession(): void {
    const provider = this._registry.get(this._getDefaultProviderId());
    provider?.clearSession();
  }

  /**
   * Clear session on a specific provider
   */
  public clearSessionForProvider(providerId: string): void {
    const provider = this._registry.get(providerId);
    provider?.clearSession();
  }

  /**
   * Check if the default provider has an active session
   */
  public hasSession(): boolean {
    const provider = this._registry.get(this._getDefaultProviderId());
    return provider?.hasSession() ?? false;
  }

  /**
   * Get the session ID from the default provider
   */
  public getSessionId(): string | null {
    const provider = this._registry.get(this._getDefaultProviderId());
    return provider?.getSessionId() ?? null;
  }

  /**
   * Enhance a prompt using the default provider (if supported)
   */
  public async enhancePrompt(prompt: string): Promise<string> {
    const provider = this._getActiveProvider();
    if (provider.enhancePrompt) {
      return provider.enhancePrompt(prompt);
    }
    return prompt;
  }

  /**
   * Get provider status information
   */
  public async getProviderStatus(providerId: string): Promise<{
    found: boolean;
    authenticated: boolean;
    path: string;
    installCommand?: string;
  } | null> {
    return this._registry.getProviderStatus(providerId);
  }

  /**
   * Get all available (installed) providers
   */
  public async getAvailableProviders(): Promise<ProviderConfig[]> {
    const available = await this._registry.getAvailable();
    return available.map(p => p.config);
  }

  /**
   * Dispose the provider manager and all providers
   */
  public dispose(): void {
    this._registry.dispose();
  }
}
