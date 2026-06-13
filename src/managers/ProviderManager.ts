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
  AgentConfiguration,
  ProviderType
} from '../types';
import { DEFAULT_PROVIDER, PROCESS_KILL_GRACE_PERIOD_MS } from '../constants';
import { killProcessTree } from '../utils/processKill';

/**
 * Minimal structural view of AgentLifecycleManager — avoids a hard import cycle
 * while letting ProviderManager report child PIDs as processes are registered.
 */
interface ProcessPidSink {
  registerProcessPid(panelId: string, pid: number): void;
}

/**
 * ProviderManager - Facade over the ProviderRegistry
 * Provides backward-compatible API while delegating to the registry
 */
export class ProviderManager {
  private _registry: ProviderRegistry;
  private _extensionContext: vscode.ExtensionContext;

  // Per-panel process tracking for isolated cancellation
  private _activePanelProcesses: Map<string, ChildProcess> = new Map();

  // Per-panel provider id (B12): cancel/suspend/resume/clearSession must route
  // to the provider that actually owns the panel's request, not the global
  // default. Recorded when a send starts; cleared when the process clears.
  private _panelProviders: Map<string, string> = new Map();

  // Optional lifecycle sink (B16): wired post-construction so registerProcess
  // can report child PIDs for idle/child-protection tracking.
  private _lifecycleSink?: ProcessPidSink;

  constructor(context: vscode.ExtensionContext) {
    this._extensionContext = context;
    this._registry = new ProviderRegistry(context);
  }

  /**
   * Wire the lifecycle manager (B16) so registerProcess can report child PIDs.
   * Called from extension.ts after both managers are constructed.
   */
  public setLifecycleSink(sink: ProcessPidSink): void {
    this._lifecycleSink = sink;
  }

  /**
   * Resolve the provider that owns a panel's active request (B12).
   * Falls back to the default provider when the panel has no recorded owner.
   */
  private _getPanelProvider(panelId?: string): ICliProvider {
    const recorded = panelId ? this._panelProviders.get(panelId) : undefined;
    return this._getActiveProvider(recorded);
  }

  /**
   * Initialize the provider manager and all providers
   */
  public async initialize(): Promise<void> {
    await this._registry.initializeAll();
  }

  /**
   * Resolved when background provider initialization settles (Plan 03
   * Phase 2: activate() fires initialize() without awaiting it). Call paths
   * that require discovery results — e.g., SetupManager.getWizardStatus —
   * await this; the message-send path does NOT (providers self-discover via
   * getCliPath() on first use).
   */
  public get whenReady(): Promise<void> {
    return this._registry.whenReady;
  }

  /**
   * Fires each provider id as its background initialize() settles,
   * for incremental consumers (e.g., per-provider availability badges).
   */
  public get onProviderReady(): vscode.Event<string> {
    return this._registry.onProviderReady;
  }

  /**
   * Get the active provider based on settings or default
   */
  private _getActiveProvider(providerId?: string): ICliProvider {
    const id = providerId || this._getDefaultProviderId();
    const provider = this._registry.get(id);

    if (!provider) {
      // Fallback to the default provider if requested provider not found
      const fallback = this._registry.get(DEFAULT_PROVIDER);
      if (fallback) {
        console.warn(`[Mysti] Provider ${id} not found, falling back to ${DEFAULT_PROVIDER}`);
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
    return config.get<string>('defaultProvider', DEFAULT_PROVIDER);
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
   * Get all registered provider ids (Plan 02 Phase 2, C2).
   * Replaces the hard-coded 11-element `allAgentIds` arrays — adding a
   * provider to the registry makes it show up here automatically.
   */
  public getAllProviderIds(): ProviderType[] {
    return this._registry.getAll().map(p => p.id as ProviderType);
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
    if (panelId && settings.provider) {
      this._panelProviders.set(panelId, settings.provider);
    }
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
    if (panelId && providerId) {
      this._panelProviders.set(panelId, providerId);
    }
    yield* provider.sendMessage(content, context, settings, conversation, persona, panelId, this);
  }

  /**
   * Register a process for a specific panel (for per-panel cancellation).
   *
   * B12: `providerId` is the id of the provider that actually spawned the
   * process. Recorded here (the spec-preferred site) as the authoritative
   * panel -> provider mapping so cancel/suspend/resume/clearSession/
   * disposePersistentProcess route to the owning provider — which may differ
   * from the global default (per-panel overrides, @-mention sub-agents).
   *
   * B16: also reports the child PID to the lifecycle sink for idle/child
   * protection tracking (previously inert — registerProcessPid had no callers).
   */
  public registerProcess(panelId: string, process: ChildProcess, providerId?: string): void {
    this._activePanelProcesses.set(panelId, process);
    if (providerId) {
      this._panelProviders.set(panelId, providerId);
    }
    if (typeof process.pid === 'number') {
      this._lifecycleSink?.registerProcessPid(panelId, process.pid);
    }
  }

  /**
   * Cancel request for a specific panel only with graceful shutdown
   */
  public cancelRequest(panelId: string): void {
    // Delegate to the panel's OWNING provider first (B12) — it handles SIGKILL
    // for suspended processes (avoids SIGCONT+SIGTERM which would give the CLI a
    // window to execute tools).
    try {
      const provider = this._getPanelProvider(panelId);
      provider.cancelCurrentRequest(panelId);
    } catch (err) {
      console.warn(`[Mysti] Provider cancel failed for panel ${panelId}:`, err);
    }
    // Backstop (B3/B4/B12): SIGKILL the tracked handle regardless, so a hung
    // process dies even if the owning provider's teardown misbehaves.
    const process = this._activePanelProcesses.get(panelId);
    if (process) {
      void killProcessTree(process, PROCESS_KILL_GRACE_PERIOD_MS, { label: `cancel ${panelId}`, initialSignal: 'SIGKILL' });
    }
    this._activePanelProcesses.delete(panelId);
    this._panelProviders.delete(panelId);
  }

  /**
   * Suspend (SIGSTOP) the CLI process for a panel to prevent tool execution.
   * Returns false on Windows or if no active process.
   */
  public suspendRequest(panelId: string): boolean {
    try {
      const provider = this._getPanelProvider(panelId);
      return provider.suspendProcess(panelId);
    } catch (err) {
      console.warn(`[Mysti] Failed to suspend request for panel ${panelId}:`, err);
      return false;
    }
  }

  /**
   * Resume (SIGCONT) a previously suspended CLI process for a panel.
   */
  public resumeRequest(panelId: string): boolean {
    try {
      const provider = this._getPanelProvider(panelId);
      return provider.resumeProcess(panelId);
    } catch (err) {
      console.warn(`[Mysti] Failed to resume request for panel ${panelId}:`, err);
      return false;
    }
  }

  /**
   * Clear process tracking for a panel (called when process completes naturally)
   */
  public clearProcess(panelId: string): void {
    this._activePanelProcesses.delete(panelId);
    this._panelProviders.delete(panelId);
  }

  /**
   * Cancel the current request on all providers (legacy - still needed for global cancel)
   */
  public cancelCurrentRequest(): void {
    for (const provider of this._registry.getAll()) {
      provider.cancelCurrentRequest();
    }
    // Also clear all tracked panel processes with graceful shutdown.
    // killProcessTree escalates SIGTERM -> SIGKILL via real liveness (B3/B4),
    // not the broken `.killed` flag, and cleans up its own escalation timer.
    for (const [panelId, process] of this._activePanelProcesses) {
      void killProcessTree(process, PROCESS_KILL_GRACE_PERIOD_MS, { label: `cancel-all ${panelId}` });
    }
    this._activePanelProcesses.clear();
    this._panelProviders.clear();
  }

  /**
   * Clear session on the default provider
   */
  public clearSession(panelId?: string): void {
    // B12: clear the session on the panel's owning provider, not the default.
    const provider = this._getPanelProvider(panelId);
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
    // B12: dispose on the panel's owning provider, not the default.
    const provider = this._getPanelProvider(panelId);
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
