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
import { BaseCliProvider, type PanelSessionState } from '../base/BaseCliProvider';
import { toolKind } from '../../utils/toolNames';
import { clampEffort, EFFORT_ORDER } from '../../utils/effort';
import { createAbortScope } from '../../utils/abortScope';
import type { EffortLevel } from '../../types';

/** Effort intent is resolved against the selected model's actual thinking controls. */
const OLLAMA_EFFORT_LEVELS: EffortLevel[] = [...EFFORT_ORDER];
import type {
  CliDiscoveryResult,
  AuthConfig,
  ProviderCapabilities,
  PersonaConfig,
  ProviderInputResolver,
} from '../base/IProvider';
import type {
  Settings,
  StreamChunk,
  ProviderConfig,
  AuthStatus,
  ContextItem,
  Conversation,
  AgentConfiguration,
  Attachment,
  ModelInfo,
} from '../../types';

/**
 * Per-panel session state for Ollama HTTP provider
 */
export interface OllamaSessionState extends PanelSessionState {
  abortController: AbortController | null;
  lastUsageStats: { input_tokens: number; output_tokens: number } | null;
}

const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434';

/** Timeout for discovery/auth probes — local endpoint, so 1s is plenty. */
const DISCOVERY_PROBE_TIMEOUT_MS = 1000;

/**
 * Module-level TTL for skipping background-init probes after a failed probe of
 * the DEFAULT endpoint. Survives provider re-construction within the process.
 */
const DISCOVERY_FAILURE_TTL_MS = 5 * 60 * 1000;
let _lastDefaultEndpointFailureAt = 0;

/** Reset the module-level discovery failure timestamp (for tests). */
export function resetOllamaDiscoveryCache(): void {
  _lastDefaultEndpointFailureAt = 0;
}

/**
 * Ollama provider implementation using HTTP API
 *
 * Unlike CLI-based providers, Ollama runs as a local HTTP server.
 * This provider makes direct HTTP requests to the Ollama API for streaming chat completions.
 *
 * API: POST /api/chat with NDJSON streaming
 * Models: GET /api/tags to list locally available models
 */
export class OllamaProvider extends BaseCliProvider {
  readonly id = 'ollama';
  readonly displayName = 'Ollama';

  readonly config: ProviderConfig = {
    name: 'ollama',
    displayName: 'Ollama',
    // Trained maxima (ollama.com/library), used only before the first turn:
    // Ollama runs at the num_ctx it loaded, which each turn reports via
    // /api/ps (see _loadedContextLength) — 4k on a <24 GiB machine by default.
    models: [
      {
        id: 'qwen3-coder',
        name: 'Qwen3 Coder',
        description: 'Strongest local coding model most machines can run (30B MoE at Q4)',
        contextWindow: 262144
      },
      {
        id: 'deepseek-r1',
        name: 'DeepSeek R1',
        description: 'Open reasoning model',
        contextWindow: 128000
      },
      {
        id: 'llama3.2',
        name: 'Llama 3.2',
        description: 'Meta open-source model, good general purpose',
        contextWindow: 128000
      },
      {
        id: 'deepseek-coder-v2',
        name: 'DeepSeek Coder V2',
        description: 'Strong code generation and understanding',
        contextWindow: 163840
      },
      {
        id: 'qwen2.5-coder',
        name: 'Qwen 2.5 Coder',
        description: 'Alibaba code model with strong performance',
        contextWindow: 32768
      },
      {
        id: 'mistral',
        name: 'Mistral',
        description: 'Efficient open-source model by Mistral AI',
        contextWindow: 32768
      }
    ],
    defaultModel: 'qwen3-coder'
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsThinking: false,
    supportsToolUse: true,
    toolCallsAreProposals: true,
    supportsSessions: false,
    // Flag/reality alignment (Plan 02 Phase 1): attachments are dropped
    // before the request (Plan 00 Batch 3.5 owns wiring real image support).
    supportsImages: false,
    supportsAutoInstall: false,
    supportsPromptEnhancement: false,
    // Plan 02 Phase 1 capability matrix
    thinkingStyle: 'none',
    thinkingLevelEffective: false,
    effortLevels: OLLAMA_EFFORT_LEVELS,
    effortDefault: 'medium',
    planMode: 'detected',
    sessionKind: 'none',           // stateless HTTP requests
    emitsToolResults: false,       // tool_use emitted, tool_result never — webview auto-resolves cards
    emitsUsage: true,
    usageConvention: 'none',   // prompt_eval_count/eval_count are flat counts.
    modelSelection: 'custom-only'  // models live on the user's Ollama server
  };

  protected _createSession(panelId: string): OllamaSessionState {
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
      lastUsageStats: null,
    };
  }

  // --- Discovery (HTTP endpoint check) ---

  /** True while background init is running (set by initialize()) — gates the TTL probe skip. */
  private _initializing = false;

  private _getEndpoint(): string {
    return vscode.workspace.getConfiguration('mysti').get<string>('ollamaEndpoint', DEFAULT_OLLAMA_ENDPOINT);
  }

  async initialize(): Promise<void> {
    this._initializing = true;
    try {
      await super.initialize();
    } finally {
      this._initializing = false;
    }
  }

  /**
   * Probe the Ollama HTTP endpoint.
   *
   * During background init only: when the configured endpoint is the default
   * and a previous probe failed within the TTL, skip the network I/O and
   * report not-running. The real probe is deferred to first actual use and
   * the setup wizard (both call discoverCli() outside initialize(), so they
   * never hit the skip). Pass `force` to bypass the skip explicitly.
   */
  async discoverCli(force = false): Promise<CliDiscoveryResult> {
    const endpoint = this._getEndpoint();
    const isDefaultEndpoint = endpoint === DEFAULT_OLLAMA_ENDPOINT;

    if (!force && this._initializing && isDefaultEndpoint &&
        Date.now() - _lastDefaultEndpointFailureAt < DISCOVERY_FAILURE_TTL_MS) {
      console.log('[Mysti] Ollama: Skipping init probe (recent failure within TTL)');
      return {
        found: false,
        path: endpoint,
        installCommand: this.getInstallCommand(),
      };
    }

    try {
      const response = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(DISCOVERY_PROBE_TIMEOUT_MS) });
      if (response.ok) {
        if (isDefaultEndpoint) {
          _lastDefaultEndpointFailureAt = 0;
        }
        return { found: true, path: endpoint };
      }
    } catch {
      // Server not reachable
    }
    if (isDefaultEndpoint) {
      _lastDefaultEndpointFailureAt = Date.now();
    }
    return {
      found: false,
      path: endpoint,
      installCommand: this.getInstallCommand(),
    };
  }

  getCliPath(): string {
    return this._getEndpoint();
  }

  /** Resolve advisory effort without sending controls the selected model cannot honor. */
  private async _thinkingControl(
    endpoint: string, model: string, effort: EffortLevel, requestSignal: AbortSignal,
  ): Promise<string | boolean | undefined> {
    const scope = createAbortScope([requestSignal], DISCOVERY_PROBE_TIMEOUT_MS);
    try {
      requestSignal.throwIfAborted();
      const response = await fetch(`${endpoint}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: scope.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return undefined;
      }
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) { return undefined; }
      const { thinking, capabilities } = data as Record<string, unknown>;
      if (thinking === undefined || thinking === null) {
        // Older servers advertise boolean support without named-level metadata.
        return Array.isArray(capabilities)
          && capabilities.every(value => typeof value === 'string')
          && capabilities.includes('thinking') ? true : undefined;
      }
      if (typeof thinking !== 'object' || Array.isArray(thinking)) { return undefined; }
      const descriptor = thinking as Record<string, unknown>;
      const values = descriptor.values;
      if (!Array.isArray(values) || values.length === 0
        || !values.every(value => typeof value === 'boolean'
          || (typeof value === 'string' && value.length > 0))
        || new Set(values).size !== values.length
        || !values.includes(descriptor.default)) {
        return undefined;
      }
      const named = clampEffort(effort, EFFORT_ORDER.filter(level => values.includes(level)));
      if (named) { return named; }
      if (values.includes(true)) { return true; }
      // Custom level names have no shared ordering; preserve the declared default.
      return typeof descriptor.default === 'string' ? descriptor.default : undefined;
    } catch {
      // Unknown controls leave the model default intact. The caller separately
      // checks request cancellation before dispatching any chat.
      return undefined;
    } finally {
      scope.dispose();
    }
  }

  /**
   * The window Ollama actually loaded `model` with: `/api/ps` `context_length`,
   * the runtime num_ctx after its VRAM-tier default (4k / 32k / 256k), the
   * model's trained cap and any out-of-memory reduction. The trained maximum
   * the catalog lists is up to 64x too big — and Ollama silently cuts the
   * middle out of an over-long prompt, so fill never reached the threshold.
   */
  private async _loadedContextLength(endpoint: string, model: string, requestSignal: AbortSignal): Promise<number | undefined> {
    const scope = createAbortScope([requestSignal], DISCOVERY_PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(`${endpoint}/api/ps`, { signal: scope.signal });
      if (!response.ok) { return undefined; }
      const data = await response.json() as { models?: Array<{ name?: string; model?: string; context_length?: number }> };
      const bare = (id?: string) => id?.replace(/:latest$/, '');
      const loaded = data.models?.find(m => bare(m.name) === bare(model) || bare(m.model) === bare(model));
      return typeof loaded?.context_length === 'number' && loaded.context_length > 0 ? loaded.context_length : undefined;
    } catch {
      return undefined;
    } finally {
      scope.dispose();
    }
  }

  /**
   * Live model discovery (Plan 01 Phase 3): GET /api/tags lists the models
   * actually pulled on the local Ollama server. Returns null on any failure so
   * the registry keeps its curated/cached list. Never throws.
   */
  async discoverModels(timeoutMs: number): Promise<ModelInfo[] | null> {
    const endpoint = this._getEndpoint();
    try {
      const response = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) { return null; }
      const data = await response.json() as { models?: Array<{ name?: string; model?: string }> };
      const models = (data.models || [])
        .map(m => (m.name || m.model || '').trim())
        .filter(id => id.length > 0)
        .map<ModelInfo>(id => ({ id, name: id }));
      return models.length > 0 ? models : null;
    } catch {
      return null;
    }
  }

  // --- Authentication (local, no auth needed) ---

  async getAuthConfig(): Promise<AuthConfig> {
    return {
      type: 'none' as 'api-key',
      isAuthenticated: true,
    };
  }

  async checkAuthentication(): Promise<AuthStatus> {
    const endpoint = this._getEndpoint();
    try {
      const response = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(DISCOVERY_PROBE_TIMEOUT_MS) });
      if (response.ok) {
        return { authenticated: true, user: 'Ollama (local)' };
      }
      return { authenticated: false, error: `Ollama server responded with status ${response.status}. Is it running?` };
    } catch {
      return { authenticated: false, error: `Cannot reach Ollama at ${endpoint}. Start with "ollama serve".` };
    }
  }

  getAuthCommand(): string {
    return 'ollama serve';
  }

  getInstallCommand(): string {
    // OS-correct: Linux uses the install script, macOS uses Homebrew, Windows
    // uses the OllamaSetup.exe installer (download URL). Derived from the
    // per-OS getInstallMethods() below so the wizard never shows a Unix-only
    // `brew install` on Windows.
    return this._installCommandForCurrentOS('curl -fsSL https://ollama.com/install.sh | sh');
  }

  getInstallMethods(): import('../../types').InstallMethod[] {
    return [
      // Linux — official install script
      {
        id: 'curl',
        label: 'Install script (Linux)',
        command: 'curl -fsSL https://ollama.com/install.sh | sh',
        platform: 'linux',
        priority: 1,
      },
      // macOS — Homebrew formula (CLI) or the official .dmg
      {
        id: 'brew',
        label: 'Homebrew (macOS)',
        command: 'brew install ollama',
        platform: 'darwin',
        priority: 1,
      },
      {
        id: 'dmg',
        label: 'Download Ollama for macOS',
        command: 'https://ollama.com/download/mac',
        platform: 'darwin',
        priority: 2,
      },
      // Windows — official installer (download + run)
      {
        id: 'exe',
        label: 'Download OllamaSetup.exe (Windows)',
        command: 'https://ollama.com/download/OllamaSetup.exe',
        platform: 'win32',
        priority: 1,
      },
    ];
  }

  // --- Stub methods (not used for HTTP provider) ---

  protected buildCliArgs(_settings: Settings, _session: PanelSessionState): string[] {
    return [];
  }

  protected parseStreamLine(_line: string, _session: PanelSessionState): StreamChunk | null {
    return null;
  }

  protected getThinkingTokens(_thinkingLevel: string): number | undefined {
    return undefined;
  }

  protected override _getEffectiveModel(settings: Settings): string {
    // Keep the existing picker-first policy in one place for wire requests
    // and host attribution, including the configured fallback.
    return settings.routedModel || settings.model
      || vscode.workspace.getConfiguration('mysti').get<string>('ollamaModel', '') || this.config.defaultModel;
  }

  // --- Message Sending (HTTP API with NDJSON streaming) ---

  async *sendMessage(
    content: string,
    context: ContextItem[],
    settings: Settings,
    conversation: Conversation | null,
    persona?: PersonaConfig,
    panelId?: string,
    _providerManager?: unknown,
    agentConfig?: AgentConfiguration,
    attachments?: Attachment[],
    resolveInput?: ProviderInputResolver,
  ): AsyncGenerator<StreamChunk> {
    if (resolveInput && !resolveInput()) { return; }
    const session = this._getSession(panelId) as OllamaSessionState;
    const config = vscode.workspace.getConfiguration('mysti');

    // Read configurable settings
    const endpoint = this._getEndpoint();
    // Model precedence: effective/routed model FIRST (so the Mysti coordinator's
    // tier-routing / routedModel is honored, not silently dropped), then the
    // user-configured provider model, then the provider default.
    const model = this._getEffectiveModel(settings);
    const temperature = config.get<number>('ollamaTemperature', 0.7);
    const contextLength = config.get<number>('ollamaContextLength', 0);
    const keepAlive = config.get<string>('ollamaKeepAlive', '5m');
    const timeout = config.get<number>('ollamaRequestTimeout', 120000);

    // Set up cancellation
    const requestController = new AbortController();
    session.abortController = requestController;
    let requestUsage: OllamaSessionState['lastUsageStats'] = null;
    session.lastUsageStats = null;
    const timeoutId = setTimeout(() => requestController.abort(), timeout);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let dispatched = false;

    try {
      const render = resolveInput ? await this.preparePromptRenderer(
        conversation, settings, persona, agentConfig, attachments,
      ) : undefined;
      const fullPrompt = render ? '' : await this.buildPromptAsync(
        content, context, conversation, settings, persona, agentConfig, attachments,
      );
      requestController.signal.throwIfAborted();

      // Build request body
      const body: Record<string, unknown> = {
        model,
        messages: [{ role: 'user', content: fullPrompt }],
        stream: true,
        keep_alive: keepAlive,
        options: { temperature } as Record<string, unknown>,
      };
      if (contextLength > 0) {
        (body.options as Record<string, unknown>).num_ctx = contextLength;
      }
      if (settings.effortLevel) {
        const think = await this._thinkingControl(endpoint, model, settings.effortLevel, requestController.signal);
        if (think !== undefined) { body.think = think; }
      }
      if (resolveInput && render) {
        if (requestController.signal.aborted || session.abortController !== requestController) { return; }
        const input = resolveInput();
        if (!input || requestController.signal.aborted || session.abortController !== requestController) { return; }
        body.messages = [{ role: 'user', content: render(input.content, input.context) }];
      }
      requestController.signal.throwIfAborted();

      console.log(`[Mysti] Ollama: Sending request to ${endpoint}/api/chat with model ${model}`);

      dispatched = true;
      const response = await fetch(`${endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: requestController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        yield { type: 'error', content: `Ollama error (${response.status}): ${errorText || response.statusText}` };
        yield { type: 'done' };
        return;
      }

      if (!response.body) {
        yield { type: 'error', content: 'Ollama returned no response body' };
        yield { type: 'done' };
        return;
      }

      // Read NDJSON stream
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sawTerminal = false;

      while (true) {
        requestController.signal.throwIfAborted();
        const { done, value } = await reader.read();
        requestController.signal.throwIfAborted();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;
        // Some transports end immediately after the final JSON object. Flush
        // decoder state and process that tail before classifying completion.
        if (done && buffer.trim()) { lines.push(buffer); buffer = ''; }

        for (const line of lines) {
          // Stop can arrive at a yield while later records are already buffered.
          requestController.signal.throwIfAborted();
          if (!line.trim()) { continue; }

          try {
            const chunk = JSON.parse(line);
            if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) {
              throw new Error('Ollama returned invalid streaming data; the answer may be incomplete.');
            }
            // Once streaming starts, Ollama reports generation failures inside
            // the NDJSON body while retaining the original HTTP status.
            if (typeof chunk.error === 'string') {
              throw new Error(`Ollama error: ${chunk.error || 'Generation failed'}`);
            }

            // Handle tool calls.
            // Tool-card resolution strategy (Plan 02 Phase 3): Ollama never
            // executes tools, so no tool_result is EVER emitted — and we must
            // NOT fabricate one. The manifest declares emitsToolResults: false
            // and every request remains an unexecuted proposal.
            if (chunk.message?.tool_calls && Array.isArray(chunk.message.tool_calls)) {
              for (const toolCall of chunk.message.tool_calls) {
                requestController.signal.throwIfAborted();
                const fn = toolCall.function;
                if (fn) {
                  yield {
                    type: 'tool_use',
                    toolCall: {
                      id: `ollama-tool-${Date.now()}`,
                      name: fn.name || '',
                      input: fn.arguments || {},
                      status: 'proposed',
                      proposalOnly: true,
                      kind: toolKind(fn.name || ''),
                    }
                  };
                }
              }
            }

            // A record may contain both proposals and text, including its
            // terminal usage. Stop can arrive at the final proposal yield.
            requestController.signal.throwIfAborted();
            // Handle text content
            if (chunk.message?.content) {
              yield { type: 'text', content: chunk.message.content };
            }
            requestController.signal.throwIfAborted();

            // Handle completion
            if (chunk.done === true) {
              sawTerminal = true;
              requestUsage = {
                input_tokens: chunk.prompt_eval_count || 0,
                output_tokens: chunk.eval_count || 0,
              };
              // Keep the legacy accessor scoped to the current request. The
              // terminal chunk uses this invocation's own usage below.
              if (session.abortController === requestController) {
                session.lastUsageStats = requestUsage;
              }
              console.log('[Mysti] Ollama: Stream complete, usage:', requestUsage);
            }
          } catch (parseErr) {
            // Cancellation inside a parsed record is not malformed NDJSON.
            requestController.signal.throwIfAborted();
            if (parseErr instanceof SyntaxError) {
              throw new Error('Ollama returned malformed streaming data; the answer may be incomplete.', { cause: parseErr });
            }
            throw parseErr;
          }
        }
        if (done) { break; }
      }

      requestController.signal.throwIfAborted();
      if (!sawTerminal) {
        throw new Error('Ollama response ended before completion; the answer may be incomplete.');
      }
      const storedUsage = requestUsage;
      if (session.lastUsageStats === requestUsage) {
        session.lastUsageStats = null;
      }
      const contextWindow = await this._loadedContextLength(endpoint, model, requestController.signal)
        ?? (contextLength > 0 ? contextLength : undefined);
      requestController.signal.throwIfAborted();
      yield { type: 'done', ...(storedUsage ? { usage: storedUsage } : {}), ...(contextWindow ? { contextWindow } : {}) };

    } catch (error) {
      if (resolveInput && !dispatched && (requestController.signal.aborted || session.abortController !== requestController)) { return; }
      if (error instanceof Error && error.name === 'AbortError') {
        yield { type: 'error', content: 'Request cancelled or timed out' };
      } else {
        yield this.handleError(error);
      }
      yield { type: 'done' };
    } finally {
      clearTimeout(timeoutId);
      if (session.lastUsageStats === requestUsage) {
        session.lastUsageStats = null;
      }
      // Plan 18 (2.4 audit): ABORT on the way out — a consumer that abandons
      // this generator (Stop, new message, collaborator teardown) otherwise
      // leaks the connection and the local model keeps generating (GPU burn)
      // to completion. Aborting an already-finished request is a no-op.
      requestController.abort();
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      if (session.abortController === requestController) {
        session.abortController = null;
      }
    }
  }

  // --- Cancellation ---

  cancelCurrentRequest(panelId?: string): void {
    const sessions = panelId ? [this._panelSessions.get(panelId)] : [...this._panelSessions.values()];
    for (const state of sessions) {
      const session = state as OllamaSessionState | undefined;
      if (session?.abortController) {
        console.log('[Mysti] Ollama: Cancelling request for panel:', session.panelId);
        session.abortController.abort();
        session.abortController = null;
      }
    }
    super.cancelCurrentRequest(panelId);
  }

  /**
   * Get stored usage stats
   */
  getStoredUsage(panelId?: string): { input_tokens: number; output_tokens: number } | null {
    const session = this._getSession(panelId) as OllamaSessionState;
    const usage = session.lastUsageStats;
    session.lastUsageStats = null;
    return usage;
  }

  clearSession(panelId?: string): void {
    this.cancelCurrentRequest(panelId);
    super.clearSession(panelId);
    const sessions = panelId ? [this._panelSessions.get(panelId)] : [...this._panelSessions.values()];
    for (const state of sessions) {
      const session = state as OllamaSessionState | undefined;
      if (session) {
        session.lastUsageStats = null;
      }
    }
  }

  dispose(): void {
    this.cancelCurrentRequest();
    super.dispose();
  }
}
