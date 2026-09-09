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
  ProviderType,
  PromptEnhancedPayload
} from '../types';
import { DEFAULT_PROVIDER, DEFAULT_FALLBACK_MODEL, PROCESS_KILL_GRACE_PERIOD_MS } from '../constants';
import { killProcessTree } from '../utils/processKill';

/**
 * Minimal structural view of ModelRegistryService (Plan 01). ProviderManager
 * delegates getModels/getProviderDefaultModel/getModelContextWindow to the
 * registry when injected, falling back to the per-provider config.models
 * otherwise. Declared structurally to avoid an import cycle (extension.ts wires
 * the concrete registry via setModelRegistry after both are constructed).
 */
interface ModelRegistrySink {
  getModels(providerId: string): { models: ModelInfo[] };
  getDefaultModel(providerId: string): string;
  getContextWindow(providerId: string, modelId: string): number | undefined;
}

/**
 * Minimal structural view of AgentLifecycleManager — avoids a hard import cycle
 * while letting ProviderManager report child PIDs as processes are registered.
 */
interface ProcessPidSink {
  registerProcessPid(panelId: string, pid: number): void;
}

/**
 * Thrown by `ProviderManager.enhancePrompt` when neither the active provider
 * nor any installed backend implements prompt enhancement. Typed (rather than
 * a silent pass-through of the original prompt) so the webview can disable the
 * affordance and say why instead of reporting a fake success.
 */
export class PromptEnhancementUnsupportedError extends Error {
  constructor(public readonly activeProviderName: string) {
    super(
      `${activeProviderName} does not support prompt enhancement, and no other installed backend does either.`
    );
    this.name = 'PromptEnhancementUnsupportedError';
  }
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

  // Optional model registry (Plan 01): when injected, getModels /
  // getProviderDefaultModel / getModelContextWindow delegate to it so the
  // dynamic registry is the single source of truth. Absent => legacy
  // config.models fallback (preserves byte-identical Phase 1 behavior).
  private _modelRegistry?: ModelRegistrySink;

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
   * Wire the model registry (Plan 01). Called from extension.ts after both the
   * ProviderManager and the ModelRegistryService are constructed (setter
   * injection avoids a construction-order/import cycle). Once set, the three
   * model-query methods read through the registry's merged view.
   */
  public setModelRegistry(registry: ModelRegistrySink): void {
    this._modelRegistry = registry;
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
    // Plan 25: when the user's selected agent IS a real backend, that is the
    // backend these provider-level helpers should run on (prompt enhancement,
    // etc.) — otherwise picking Cursor in the menu would still enhance on
    // `defaultProvider`. A pseudo-agent selection (`mysti`/`brainstorm`) has no
    // registry entry, so it is skipped here and `defaultProvider` answers.
    const selectedAgent = config.get<string>('defaultAgent', '');
    if (selectedAgent && this._registry.get(selectedAgent)) {
      return selectedAgent;
    }
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
   * Plan 05 — register (or clear) the per-session `mysti-canvas` MCP config for a
   * panel so a canvas-linked CLI session spawns with `--mcp-config`. Must run
   * before sendMessage() so buildCliArgs reads it.
   */
  public setCanvasMcpConfig(panelId: string, configPath: string | null, providerId?: string): void {
    const provider = this._getActiveProvider(providerId);
    if (provider && 'setCanvasMcpConfig' in provider) {
      (provider as BaseCliProvider).setCanvasMcpConfig(panelId, configPath);
    }
  }

  /**
   * Get available models for a provider.
   * Plan 01: delegate to the model registry's merged view (curated + discovered
   * + custom) when injected; fall back to the bundled config.models otherwise.
   */
  public getModels(providerName: string): ModelInfo[] {
    if (this._modelRegistry) {
      return this._modelRegistry.getModels(providerName).models;
    }
    const provider = this._registry.get(providerName);
    return provider ? provider.config.models : [];
  }

  /**
   * Get the default model for a specific provider
   * Used in brainstorm mode to ensure each provider uses its own compatible model
   */
  public getProviderDefaultModel(providerId: string): string {
    if (this._modelRegistry) {
      return this._modelRegistry.getDefaultModel(providerId);
    }
    const provider = this._registry.get(providerId);
    if (provider) {
      return provider.config.defaultModel;
    }
    // Fallback to global default. The declared key is `mysti.defaultModel` —
    // this read used to be `'model'`, which package.json does not declare, so
    // `get` always missed and the user's configured model was never honoured
    // here (every caller silently got DEFAULT_FALLBACK_MODEL instead).
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<string>('defaultModel', '') || DEFAULT_FALLBACK_MODEL;
  }

  /**
   * Get the context window size for a specific model
   * Used for displaying context usage in the UI
   */
  public getModelContextWindow(providerId: string, modelId: string): number {
    if (this._modelRegistry) {
      const ctx = this._modelRegistry.getContextWindow(providerId, modelId);
      if (typeof ctx === 'number') {
        return ctx;
      }
      // registry knows the provider but not this model's window — fall through
      // to the 200k default below.
      return 200000;
    }
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
  public clearProcess(panelId: string, expectedProcess?: ChildProcess): void {
    if (expectedProcess && this._activePanelProcesses.get(panelId) !== expectedProcess) { return; }
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
   * Dispose a persistent process for a panel on a SPECIFIC provider, bypassing
   * the panel→provider map (which is cleared when a request completes). Used to
   * reclaim delegation-child sessions at end-of-run (Plan 17 review [13]).
   */
  public disposePersistentProcessForProvider(providerId: string, panelId: string): void {
    const provider = this._registry.get(providerId);
    // review[24]: both callers are delegation CHILD panels (unique per run), so
    // fully EVICT the session record rather than only nulling its id — otherwise
    // dead child sessions accumulate unbounded in a long-lived window. Falls back
    // to the old process-dispose + clearSession for providers without disposeSession.
    if (provider && typeof (provider as { disposeSession?: unknown }).disposeSession === 'function') {
      (provider as unknown as { disposeSession(panelId: string): void }).disposeSession(panelId);
      return;
    }
    if (provider && 'disposePersistentProcess' in provider) {
      (provider as { disposePersistentProcess(panelId?: string): void }).disposePersistentProcess(panelId);
    }
    provider?.clearSession(panelId);
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
   * Enhance a prompt, falling back to another INSTALLED backend when the
   * active provider cannot do it itself.
   *
   * Only 4 of the 16 backends implement `enhancePrompt()`. This used to end in
   * a bare `return prompt`, so with any of the other 12 active the webview got
   * back byte-identical text, cleared its spinner and looked broken. Now the
   * caller always learns which backend ran (`enhancedById`), whether that was
   * a fallback, and whether the text actually changed — and gets a typed throw
   * when nothing installed can do the job at all.
   *
   * The fallback re-routes the user's prompt text to a DIFFERENT local CLI than
   * the one they selected, so it is reported to the UI rather than done
   * silently; the webview attributes the result to `enhancedBy`.
   */
  public async enhancePrompt(prompt: string): Promise<PromptEnhancedPayload> {
    const active = this._getActiveProvider();

    if (typeof active.enhancePrompt === 'function') {
      const enhanced = await active.enhancePrompt(prompt);
      return this._buildEnhancementResult(prompt, enhanced, active, false);
    }

    const fallback = await this._findEnhancementFallback(active.id);
    if (!fallback) {
      throw new PromptEnhancementUnsupportedError(active.displayName);
    }

    console.log(`[Mysti] Prompt enhancement: ${active.displayName} cannot enhance — falling back to ${fallback.displayName}`);
    const enhanced = await fallback.enhancePrompt!(prompt);
    return this._buildEnhancementResult(prompt, enhanced, fallback, true);
  }

  /**
   * First registered provider that both declares the capability and has its
   * CLI on disk. Registry order (not a hardcoded preference list) decides the
   * winner so no provider-name literal is introduced here.
   */
  private async _findEnhancementFallback(excludeId: string): Promise<ICliProvider | undefined> {
    for (const provider of this._registry.getAll()) {
      if (provider.id === excludeId) { continue; }
      if (!provider.capabilities.supportsPromptEnhancement) { continue; }
      if (typeof provider.enhancePrompt !== 'function') { continue; }
      try {
        const discovery = await provider.discoverCli();
        if (discovery.found) { return provider; }
      } catch (error) {
        console.error(`[Mysti] Prompt enhancement: discovery failed for ${provider.id}:`, error);
      }
    }
    return undefined;
  }

  private _buildEnhancementResult(
    original: string,
    enhanced: string,
    provider: ICliProvider,
    fallback: boolean
  ): PromptEnhancedPayload {
    // Every implementation resolves the ORIGINAL prompt on CLI failure, so an
    // unchanged string means "nothing happened", not "success".
    const changed = enhanced.trim() !== original.trim() && enhanced.trim().length > 0;
    return {
      prompt: changed ? enhanced : original,
      enhancedBy: provider.displayName,
      enhancedById: provider.id,
      fallback,
      changed
    };
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
