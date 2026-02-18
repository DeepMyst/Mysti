/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { ChildProcess } from 'child_process';
import { ProviderRegistry } from '../providers/ProviderRegistry';
import type { ICliProvider, PersonaConfig } from '../providers/base/IProvider';
import type { BaseCliProvider } from '../providers/base/BaseCliProvider';
import type { AgentContextManager } from './AgentContextManager';
import type {
  ContextItem,
  Attachment,
  Settings,
  Conversation,
  StreamChunk,
  ProviderConfig,
  ModelInfo,
  AgentConfiguration
} from '../types';
import { PROCESS_KILL_GRACE_PERIOD_MS } from '../constants';

/**
 * ProviderManager - Facade over the ProviderRegistry
 * Provides backward-compatible API while delegating to the registry
 */
export class ProviderManager {
  private _registry: ProviderRegistry;
  private _extensionContext: vscode.ExtensionContext;

  // Per-panel process tracking for isolated cancellation
  private _activePanelProcesses: Map<string, ChildProcess> = new Map();

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
   * Get the actual provider instance (for setup/auth operations)
   */
  public getProviderInstance(name: string): ICliProvider | undefined {
    return this._registry.get(name);
  }

  /**
   * Get all provider instances
   */
  public getAllProviders(): ICliProvider[] {
    return this._registry.getAll();
  }

  /**
   * Set the AgentContextManager on all providers
   * This enables three-tier agent loading from markdown files
   */
  public setAgentContextManager(manager: AgentContextManager): void {
    for (const provider of this._registry.getAll()) {
      // Check if provider has setAgentContextManager method (BaseCliProvider)
      if ('setAgentContextManager' in provider && typeof (provider as BaseCliProvider).setAgentContextManager === 'function') {
        (provider as BaseCliProvider).setAgentContextManager(manager);
      }
    }
    console.log('[Mysti] AgentContextManager connected to all providers');
  }

  /**
   * Set channel system context on a provider's session for injection into the prompt.
   * Must be called before sendMessage() so buildPromptAsync() reads it.
   * Uses the explicit providerId to avoid routing to the wrong provider instance.
   */
  public setChannelSystemContext(panelId: string, context: string, providerId?: string): void {
    const provider = this._getActiveProvider(providerId);
    if (provider && 'setChannelSystemContext' in provider) {
      (provider as BaseCliProvider).setChannelSystemContext(panelId, context);
    }
  }

  /**
   * Get available models for a provider
   */
  public getModels(providerName: string): ModelInfo[] {
    const provider = this._registry.get(providerName);
    return provider ? provider.config.models : [];
  }

  /**
   * Get the default model for a specific provider
   * Used in brainstorm mode to ensure each provider uses its own compatible model
   */
  public getProviderDefaultModel(providerId: string): string {
    const provider = this._registry.get(providerId);
    if (provider) {
      return provider.config.defaultModel;
    }
    // Fallback to global default
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<string>('model', 'claude-sonnet-4-5-20250929');
  }

  /**
   * Get the context window size for a specific model
   * Used for displaying context usage in the UI
   */
  public getModelContextWindow(providerId: string, modelId: string): number {
    const provider = this._registry.get(providerId);
    if (provider) {
      const model = provider.config.models.find(m => m.id === modelId);
      if (model?.contextWindow) {
        return model.contextWindow;
      }
    }
    // Default to 200k tokens
    return 200000;
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
    persona?: PersonaConfig,
    panelId?: string,
    agentConfig?: AgentConfiguration,
    attachments?: Attachment[]
  ): AsyncGenerator<StreamChunk> {
    const provider = this._getActiveProvider(settings.provider);
    yield* provider.sendMessage(content, context, settings, conversation, persona, panelId, this, agentConfig, attachments);
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
    persona?: PersonaConfig,
    panelId?: string
  ): AsyncGenerator<StreamChunk> {
    const provider = this._getActiveProvider(providerId);
    yield* provider.sendMessage(content, context, settings, conversation, persona, panelId, this);
  }

  /**
   * Register a process for a specific panel (for per-panel cancellation)
   */
  public registerProcess(panelId: string, process: ChildProcess): void {
    this._activePanelProcesses.set(panelId, process);
  }

  /**
   * Cancel request for a specific panel only with graceful shutdown
   */
  public cancelRequest(panelId: string): void {
    const process = this._activePanelProcesses.get(panelId);
    if (process && !process.killed) {
      console.log(`[Mysti] Cancelling request for panel: ${panelId}`);

      // Try graceful termination first
      process.kill('SIGTERM');

      // Schedule force kill if process doesn't terminate gracefully
      setTimeout(() => {
        if (process && !process.killed) {
          console.warn(`[Mysti] Force killing process for panel: ${panelId}`);
          process.kill('SIGKILL');
        }
      }, PROCESS_KILL_GRACE_PERIOD_MS);

      this._activePanelProcesses.delete(panelId);
    }
  }

  /**
   * Clear process tracking for a panel (called when process completes naturally)
   */
  public clearProcess(panelId: string): void {
    this._activePanelProcesses.delete(panelId);
  }

  /**
   * Cancel the current request on all providers (legacy - still needed for global cancel)
   */
  public cancelCurrentRequest(): void {
    for (const provider of this._registry.getAll()) {
      provider.cancelCurrentRequest();
    }
    // Also clear all tracked panel processes with graceful shutdown
    for (const [panelId, process] of this._activePanelProcesses) {
      if (process && !process.killed) {
        process.kill('SIGTERM');

        // Schedule force kill if needed
        setTimeout(() => {
          if (process && !process.killed) {
            console.warn(`[Mysti] Force killing process for panel: ${panelId}`);
            process.kill('SIGKILL');
          }
        }, PROCESS_KILL_GRACE_PERIOD_MS);
      }
    }
    this._activePanelProcesses.clear();
  }

  /**
   * Clear session on the default provider
   */
  public clearSession(panelId?: string): void {
    const provider = this._registry.get(this._getDefaultProviderId());
    provider?.clearSession(panelId);
  }

  /**
   * Clear session on a specific provider
   */
  public clearSessionForProvider(providerId: string, panelId?: string): void {
    const provider = this._registry.get(providerId);
    provider?.clearSession(panelId);
  }

  /**
   * Dispose persistent process for a panel on the default provider.
   */
  public disposePersistentProcess(panelId?: string): void {
    const provider = this._registry.get(this._getDefaultProviderId());
    if (provider && 'disposePersistentProcess' in provider) {
      (provider as { disposePersistentProcess(panelId?: string): void }).disposePersistentProcess(panelId);
    }
  }

  /**
   * Check if the default provider has an active session
   */
  public hasSession(panelId?: string): boolean {
    const provider = this._registry.get(this._getDefaultProviderId());
    return provider?.hasSession(panelId) ?? false;
  }

  /**
   * Get the session ID from the default provider
   */
  public getSessionId(panelId?: string): string | null {
    const provider = this._registry.get(this._getDefaultProviderId());
    return provider?.getSessionId(panelId) ?? null;
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
