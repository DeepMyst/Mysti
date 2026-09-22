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
 *
 * OpenRouterProvider (Plan 15) — a full, user-selectable backend that runs any
 * OpenRouter model (300+) via the OpenAI-compatible API with real SSE streaming.
 *
 * This is an API provider (like the dormant ManusProvider), NOT a CLI: the CLI
 * abstractions are stubbed and `sendMessage` is fully overridden to stream from
 * `openrouter.ai`. It is a pure completion backend — there is no tool-execution
 * runtime, so `supportsToolUse` is false; the @mysti coordinator routes
 * file-editing work to agentic CLI backends and text/reasoning leaves here (on
 * FREE models by default). Auth is an OpenRouter key (shared with the
 * coordinator: `mysti.openrouter.apiKey` / `OPENROUTER_API_KEY`).
 */

import { BaseCliProvider, type PanelSessionState } from '../base/BaseCliProvider';
import type {
  CliDiscoveryResult,
  AuthConfig,
  ProviderCapabilities,
  PersonaConfig,
} from '../base/IProvider';
import type {
  Settings,
  StreamChunk,
  ProviderConfig,
  AuthStatus,
  ContextItem,
  Conversation,
  AgentConfiguration,
  InstallMethod,
  UsageStats,
  ModelInfo,
} from '../../types';
import { validateModelName } from '../../utils/validation';
import { OpenRouterClient, OPENROUTER_BASE_URL, OPENROUTER_FREE_ROUTER } from '../../services/OpenRouterClient';
import { normalizeUsage } from '../../services/TokenAccounting';
import { clampEffort } from '../../utils/effort';
import { waitForCaller } from '../../utils/abortScope';
import type { EffortLevel } from '../../types';
import * as vscode from 'vscode';

/** OpenRouter `reasoning.effort` — the solid, cross-model tier set (xhigh/max → high). */
const OPENROUTER_EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high'];

export interface OpenRouterSessionState extends PanelSessionState {
  abortController: AbortController | null;
}

export class OpenRouterProvider extends BaseCliProvider {
  readonly id = 'openrouter';
  readonly displayName = 'OpenRouter';

  readonly config: ProviderConfig = {
    name: 'openrouter',
    displayName: 'OpenRouter',
    models: [
      // A small free-leaning starter set; users can type ANY OpenRouter slug via
      // `mysti.openrouterModel` (MODEL_NAME_PATTERN accepts `owner/model:free`).
      { id: 'openrouter/free', name: 'Free (auto-routed)', description: 'Auto-routes to an available free model', contextWindow: 200000 },
      { id: 'openai/gpt-oss-120b:free', name: 'GPT-OSS 120B (free)', description: 'Open-weight MoE, tool-capable', contextWindow: 131000 },
      { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5 (paid)', description: 'Anthropic, via OpenRouter credits', contextWindow: 1000000 },
      { id: 'openai/gpt-6-astra', name: 'GPT-6 Astra (paid)', description: 'OpenAI flagship, via OpenRouter credits', contextWindow: 1050000 },
      { id: 'moonshotai/kimi-k3', name: 'Kimi K3 (paid)', description: 'Moonshot open-weight 2.8T MoE', contextWindow: 1048576 },
    ],
    // Free by default (the meta-router routes to an available free model).
    defaultModel: OPENROUTER_FREE_ROUTER,
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    // Some models stream reasoning deltas; the level setting has no effect here.
    supportsThinking: true,
    // No tool-execution runtime — OpenRouter is a completion API, not an agent.
    supportsToolUse: false,
    toolExecution: 'none',
    supportsSessions: true,
    supportsAutoInstall: false,
    supportsPromptEnhancement: false,
    thinkingStyle: 'streamed',
    thinkingLevelEffective: false,
    effortLevels: OPENROUTER_EFFORT_LEVELS,  // reasoning.effort (low/medium/high)
    effortDefault: 'medium',
    planMode: 'none',
    // Stateless: each turn re-sends the assembled prompt; no provider-side session.
    sessionKind: 'prompt-history',
    emitsToolResults: false,
    emitsUsage: true,
    usageConvention: 'auto', // Reported usage is normalized before emission, independent of model vendor.
    modelSelection: 'full',
  };

  // Protected + reassignable so a test subclass can inject a mock-fetch client.
  protected _client: OpenRouterClient = new OpenRouterClient(() => this._getApiKey() || undefined);

  protected _createSession(panelId: string): OpenRouterSessionState {
    return {
      panelId,
      process: null,
      sessionId: null,
      autonomousMode: false,
      persistentProcess: null,
      persistentReady: false,
      lastHealthCheck: 0,
      suspended: false,
      abortController: null,
    };
  }

  // --- Discovery (API-based, no CLI) ---

  async discoverCli(): Promise<CliDiscoveryResult> {
    if (this._getApiKey()) {
      return { found: true, path: 'api' };
    }
    return { found: false, path: 'api', installCommand: this.getInstallCommand() };
  }

  getCliPath(): string {
    return OPENROUTER_BASE_URL;
  }

  /**
   * Live model discovery (Plan 01 Phase 3) via OpenRouter's public catalog
   * (GET /models — no key required; the client sends one when configured).
   *
   * Scoped to the FREE tier on purpose. The full catalog is ~300 entries: too
   * many to persist per activation and far too many to pick from in a dropdown,
   * while the curated list already carries the handful of paid models worth
   * one-click access (the merge keeps them — discovery adds, it never empties).
   * Free models, by contrast, rotate constantly, which is exactly the list a
   * background refresh should be keeping current.
   *
   * Returns null on any failure so the registry keeps its curated/cached list.
   * Never throws.
   */
  async discoverModels(_timeoutMs: number): Promise<ModelInfo[] | null> {
    try {
      const free = await this._client.listFreeModels();
      const models = free
        .filter(m => typeof m.id === 'string' && m.id.length > 0)
        .map<ModelInfo>(m => ({
          id: m.id,
          name: m.name || m.id,
          description: m.supportsTools ? 'Free · tool-capable' : 'Free',
          contextWindow: m.contextLength,
        }));
      return models.length > 0 ? models : null;
    } catch {
      return null;
    }
  }

  // --- Authentication ---

  async getAuthConfig(): Promise<AuthConfig> {
    return { type: 'api-key', isAuthenticated: !!this._getApiKey() };
  }

  async checkAuthentication(): Promise<AuthStatus> {
    if (!this._getApiKey()) {
      return {
        authenticated: false,
        error: 'OpenRouter API key not configured. Set mysti.openrouter.apiKey in settings or the OPENROUTER_API_KEY environment variable.',
      };
    }
    return { authenticated: true, user: 'API Key configured' };
  }

  getAuthCommand(): string {
    return 'Enter your OpenRouter API key in VS Code settings (mysti.openrouter.apiKey) or set the OPENROUTER_API_KEY environment variable';
  }

  getInstallCommand(): string {
    return 'Get a free API key at https://openrouter.ai/keys';
  }

  getInstallMethods(): InstallMethod[] {
    return [
      { id: 'api-key', label: 'Get your OpenRouter API key', command: 'https://openrouter.ai/keys', platform: 'all', priority: 1 },
    ];
  }

  // --- Stubs (required by the abstract base; unused for an API provider) ---

  protected buildCliArgs(_settings: Settings, _session: PanelSessionState): string[] {
    return [];
  }

  protected parseStreamLine(_line: string, _session: PanelSessionState): StreamChunk | null {
    return null;
  }

  protected getThinkingTokens(_thinkingLevel: string): number | undefined {
    return undefined;
  }

  private _getApiKey(): string {
    const fromSetting = vscode.workspace.getConfiguration('mysti').get<string>('openrouter.apiKey', '').trim();
    return fromSetting || process.env.OPENROUTER_API_KEY || '';
  }

  protected _getEffectiveModel(settings: Settings): string | undefined {
    // P2.3/P0.2b: an explicitly routed model wins over the per-provider custom-model config.
    if (settings.routedModel) { return settings.routedModel; }
    const custom = vscode.workspace.getConfiguration('mysti').get<string>('openrouterModel', '').trim();
    if (custom) {
      const validation = validateModelName(custom);
      if (validation.valid) {
        return custom;
      }
      console.warn(`[Mysti] OpenRouter: ignoring invalid custom model "${custom}": ${validation.error}`);
    }
    if (settings.model && settings.model !== this.config.defaultModel) {
      return settings.model;
    }
    return undefined;
  }

  // --- Message sending (SSE streaming) ---

  async *sendMessage(
    content: string,
    context: ContextItem[],
    settings: Settings,
    conversation: Conversation | null,
    persona?: PersonaConfig,
    panelId?: string,
    _providerManager?: unknown,
    agentConfig?: AgentConfiguration,
  ): AsyncGenerator<StreamChunk> {
    const session = this._getSession(panelId) as OpenRouterSessionState;
    session.abortController?.abort();
    const controller = new AbortController();
    session.abortController = controller;
    let usage: UsageStats | undefined;
    // OpenRouter may serve a different model than requested (auto router,
    // fallbacks) and reports that model and the turn's cost itself.
    let servedModel: string | undefined;
    let costUsd: number | undefined;
    let completed = false;
    let finishReason: string | undefined;

    try {
      if (!this._getApiKey()) {
        yield {
          type: 'auth_error',
          content: 'OpenRouter API key not configured. Set mysti.openrouter.apiKey in settings or the OPENROUTER_API_KEY environment variable.',
          authCommand: this.getAuthCommand(),
          providerName: this.displayName,
        };
        return;
      }
      // Stop must not wait for prompt assembly (agent files, context, history).
      const prompt = await waitForCaller(
        () => this.buildPromptAsync(content, context, conversation, settings, persona, agentConfig),
        controller.signal,
      );
      controller.signal.throwIfAborted();
      const model = this._getEffectiveModel(settings) || this.config.defaultModel;
      const effort = clampEffort(settings.effortLevel, OPENROUTER_EFFORT_LEVELS) as
        'low' | 'medium' | 'high' | undefined;
      const stream = this._client.streamChat({
        model,
        messages: [{ role: 'user', content: prompt }],
        reasoningEffort: effort,
        signal: controller.signal,
      });

      for await (const ev of stream) {
        controller.signal.throwIfAborted();
        if (ev.error !== undefined) { throw new Error(ev.error.trim() || 'Stream error'); }
        if (ev.toolCalls?.length) { throw new Error('This chat backend cannot execute tool calls.'); }
        if (ev.text) { yield { type: 'text', content: ev.text }; }
        if (ev.reasoning) { controller.signal.throwIfAborted(); yield { type: 'thinking', content: ev.reasoning }; }
        if (ev.usage && ev.usage.inputTokens !== undefined && ev.usage.outputTokens !== undefined) {
          usage = normalizeUsage({
            input_tokens: Math.max(0, ev.usage.inputTokens - (ev.usage.cacheCreationIncluded ? ev.usage.cacheCreationTokens ?? 0 : 0)),
            output_tokens: ev.usage.outputTokens,
            ...(ev.usage.cacheReadTokens !== undefined ? { cache_read_input_tokens: ev.usage.cacheReadTokens } : {}),
            ...(ev.usage.cacheCreationTokens !== undefined ? { cache_creation_input_tokens: ev.usage.cacheCreationTokens } : {}),
          }, 'openai');
        }
        if (ev.model) { servedModel = ev.model; }
        if (ev.costUsd !== undefined) { costUsd = ev.costUsd; }
        if (ev.finishReason) { finishReason = ev.finishReason; }
        if (ev.done) { completed = true; break; }
      }
      controller.signal.throwIfAborted();
      if (!completed) { throw new Error('Stream ended before completion.'); }
      if (finishReason === 'length') { throw new Error('Response reached the output token limit before completion.'); }
      if (finishReason && finishReason !== 'stop') { throw new Error(`Response ended with ${finishReason}.`); }
      yield {
        type: 'done',
        ...(usage ? { usage } : {}),
        ...(servedModel ? { model: servedModel } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
      };
    } catch (err) {
      // Stop/replacement/disposal already owns the UI transition. Do not publish
      // stale output or an internal error from the abandoned request.
      if (!controller.signal.aborted) {
        yield { type: 'error', content: `OpenRouter: ${err instanceof Error ? err.message : String(err)}` };
      }
    } finally {
      controller.abort();
      if (session.abortController === controller) { session.abortController = null; }
    }
  }

  override cancelCurrentRequest(panelId?: string): void {
    for (const [key, state] of this._panelSessions) {
      if (panelId && key !== panelId) { continue; }
      const session = state as OpenRouterSessionState;
      session.abortController?.abort();
      session.abortController = null;
    }
  }

  override dispose(): void {
    this.cancelCurrentRequest();
    super.dispose();
  }

  override clearSession(panelId?: string): void {
    this.cancelCurrentRequest(panelId);
    super.clearSession(panelId);
  }
}
