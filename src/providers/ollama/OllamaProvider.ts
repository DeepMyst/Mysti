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
import { randomUUID } from 'node:crypto';
import { readHttpLines } from '../../utils/httpStream';
import { BaseCliProvider, type PanelSessionState } from '../base/BaseCliProvider';
import { toolKind } from '../../utils/toolNames';
import { clampEffort } from '../../utils/effort';
import type { EffortLevel } from '../../types';

/** Ollama `think` graded strings — reasoning models accept low/medium/high/max (no xhigh). */
const OLLAMA_EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'max'];
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
        contextWindow: 128000
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
    supportsThinking: true,
    supportsToolUse: true,
    toolExecution: 'proposal-only',
    supportsSessions: true,
    // Flag/reality alignment (Plan 02 Phase 1): attachments are dropped
    // before the request (Plan 00 Batch 3.5 owns wiring real image support).
    supportsImages: false,
    supportsAutoInstall: false,
    supportsPromptEnhancement: false,
    // Plan 02 Phase 1 capability matrix
    thinkingStyle: 'streamed',
    thinkingLevelEffective: false,
    effortLevels: OLLAMA_EFFORT_LEVELS,  // `think` graded strings (reasoning models)
    effortDefault: 'medium',
    planMode: 'detected',
    sessionKind: 'prompt-history', // Conversation replayed in each HTTP request.
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
  ): AsyncGenerator<StreamChunk> {
    const session = this._getSession(panelId) as OllamaSessionState;
    const config = vscode.workspace.getConfiguration('mysti');

    // Read configurable settings
    const endpoint = this._getEndpoint();
    // Model precedence: effective/routed model FIRST (so the Mysti coordinator's
    // tier-routing / routedModel is honored, not silently dropped), then the
    // user-configured provider model, then the provider default.
    const model = this._getEffectiveModel(settings) || config.get<string>('ollamaModel', '') || this.config.defaultModel;
    const temperature = config.get<number>('ollamaTemperature', 0.7);
    const contextLength = config.get<number>('ollamaContextLength', 0);
    const keepAlive = config.get<string>('ollamaKeepAlive', '5m');
    const timeout = config.get<number>('ollamaRequestTimeout', 120000);

    // Capture this turn's controller: an older timeout/finally cannot cancel its replacement.
    session.abortController?.abort();
    const controller = new AbortController();
    session.abortController = controller;
    session.cancelled = false;
    session.lastUsageStats = null;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      // Build prompt using inherited method
      const fullPrompt = await this.buildPromptAsync(
        content, context, conversation, settings, persona, agentConfig, attachments,
      );
      controller.signal.throwIfAborted();

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
      // GPT-OSS only accepts low/medium/high; other supported models also accept max.
      // https://docs.ollama.com/capabilities/thinking
      const effortLevels = /^(?:library\/)?gpt-oss(?::|$)/i.test(model)
        ? OLLAMA_EFFORT_LEVELS.filter(level => level !== 'max') : OLLAMA_EFFORT_LEVELS;
      const ollamaEffort = clampEffort(settings.effortLevel, effortLevels);
      if (ollamaEffort) {
        body.think = ollamaEffort;
      }

      console.log(`[Mysti] Ollama: Sending request to ${endpoint}/api/chat with model ${model}`);

      const response = await fetch(`${endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      controller.signal.throwIfAborted();
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        controller.signal.throwIfAborted();
        yield { type: 'error', content: `Ollama error (${response.status}): ${errorText || response.statusText}` };
        yield { type: 'done' };
        return;
      }

      if (!response.body) {
        yield { type: 'error', content: 'Ollama returned no response body' };
        yield { type: 'done' };
        return;
      }

      let usage: OllamaSessionState['lastUsageStats'] = null;
      let completed = false;
      for await (const line of readHttpLines(response.body, controller.signal)) {
        if (!line.trim()) { continue; }
        let chunk;
        try { chunk = JSON.parse(line); }
        catch { throw new Error('Ollama returned malformed NDJSON data'); }
        if (chunk.error) {
          throw new Error(typeof chunk.error === 'string' ? chunk.error : chunk.error.message || 'Ollama stream error');
        }
        // Tool calls are proposals, never evidence of execution. Each proposal
        // receives a distinct ID even when several arrive in the same frame.
        if (Array.isArray(chunk.message?.tool_calls)) {
          for (const toolCall of chunk.message.tool_calls) {
            const fn = toolCall.function;
            if (typeof fn?.name !== 'string' || !fn.name) { continue; }
            const input = fn.arguments ?? {};
            if (!input || typeof input !== 'object' || Array.isArray(input)) {
              throw new Error(`Ollama returned invalid arguments for tool ${fn.name}`);
            }
            controller.signal.throwIfAborted();
            yield {
              type: 'tool_use',
              toolCall: {
                id: `ollama-tool-${randomUUID()}`, name: fn.name,
                input, status: 'running', kind: toolKind(fn.name),
              },
            };
          }
        }
        if (typeof chunk.message?.thinking === 'string' && chunk.message.thinking) {
          controller.signal.throwIfAborted();
          yield { type: 'thinking', content: chunk.message.thinking };
        }
        if (typeof chunk.message?.content === 'string' && chunk.message.content) {
          controller.signal.throwIfAborted();
          yield { type: 'text', content: chunk.message.content };
        }
        if (chunk.done === true) {
          usage = { input_tokens: chunk.prompt_eval_count || 0, output_tokens: chunk.eval_count || 0 };
          completed = true;
          break;
        }
      }
      controller.signal.throwIfAborted();
      if (!completed) { throw new Error('Ollama stream ended before completion'); }
      yield usage ? { type: 'done', usage } : { type: 'done' };

    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        yield { type: 'error', content: 'Request cancelled or timed out' };
      } else {
        yield this.handleError(error);
      }
      yield { type: 'done' };
    } finally {
      clearTimeout(timeoutId);
      controller.abort();
      if (session.abortController === controller) { session.abortController = null; }
    }
  }

  // --- Cancellation ---

  cancelCurrentRequest(panelId?: string): void {
    for (const [key, state] of this._panelSessions) {
      if (panelId && key !== panelId) { continue; }
      const session = state as OllamaSessionState;
      session.abortController?.abort();
      session.abortController = null;
    }
    super.cancelCurrentRequest(panelId);
  }

  dispose(): void {
    this.cancelCurrentRequest();
    super.dispose();
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
    for (const [key, state] of this._panelSessions) {
      if (!panelId || key === panelId) { (state as OllamaSessionState).lastUsageStats = null; }
    }
    super.clearSession(panelId);
  }
}
