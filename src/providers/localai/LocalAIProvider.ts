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
import { readServerSentData } from '../../utils/httpStream';
import { ToolCallAccumulator, parseToolArgsChecked } from '../../utils/toolCallAccumulator';
import { BaseCliProvider, type PanelSessionState } from '../base/BaseCliProvider';
import { toolKind } from '../../utils/toolNames';
import { clampEffort } from '../../utils/effort';
import type { EffortLevel } from '../../types';

/** LocalAI `reasoning_effort` supports low/medium/high (no xhigh/max; clamp down). */
const LOCALAI_EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high'];
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
 * Per-panel session state for LocalAI HTTP provider
 */
export interface LocalAISessionState extends PanelSessionState {
  abortController: AbortController | null;
  lastUsageStats: { input_tokens: number; output_tokens: number } | null;
}

const DEFAULT_LOCALAI_ENDPOINT = 'http://localhost:8080';

/** Timeout for discovery/auth probes — local endpoint, so 1s is plenty. */
const DISCOVERY_PROBE_TIMEOUT_MS = 1000;

/**
 * Module-level TTL for skipping background-init probes after a failed probe of
 * the DEFAULT endpoint. Survives provider re-construction within the process.
 */
const DISCOVERY_FAILURE_TTL_MS = 5 * 60 * 1000;
let _lastDefaultEndpointFailureAt = 0;

/** Reset the module-level discovery failure timestamp (for tests). */
export function resetLocalAIDiscoveryCache(): void {
  _lastDefaultEndpointFailureAt = 0;
}

/**
 * LocalAI provider implementation using OpenAI-compatible HTTP API
 *
 * LocalAI is a self-hosted, local-first alternative to OpenAI that runs on consumer hardware.
 * It exposes an OpenAI-compatible API at /v1/chat/completions with SSE streaming.
 *
 * API: POST /v1/chat/completions (OpenAI-compatible)
 * Models: GET /v1/models
 */
export class LocalAIProvider extends BaseCliProvider {
  readonly id = 'localai';
  readonly displayName = 'LocalAI';

  readonly config: ProviderConfig = {
    name: 'localai',
    displayName: 'LocalAI',
    models: [
      {
        id: 'gpt-4',
        name: 'GPT-4 (LocalAI)',
        description: 'LocalAI model configured as gpt-4',
        contextWindow: 128000
      },
      {
        id: 'ggml-gpt4all-j',
        name: 'GPT4All-J',
        description: 'Open-source GPT4All model',
        contextWindow: 8192
      },
      {
        id: 'luna-ai-llama2',
        name: 'Luna AI Llama2',
        description: 'Llama2-based conversational model',
        contextWindow: 4096
      }
    ],
    defaultModel: 'gpt-4'
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsThinking: true,
    supportsToolUse: true,
    toolExecution: 'proposal-only',
    supportsSessions: true,
    supportsImages: false,
    supportsAutoInstall: false,
    supportsPromptEnhancement: false,
    // Plan 02 Phase 1 capability matrix
    thinkingStyle: 'streamed',
    thinkingLevelEffective: false,
    effortLevels: LOCALAI_EFFORT_LEVELS,  // reasoning_effort (low/medium/high)
    effortDefault: 'medium',
    planMode: 'detected',
    sessionKind: 'prompt-history', // Conversation replayed in each HTTP request.
    emitsToolResults: false,       // tool_use emitted, tool_result never — webview auto-resolves cards
    emitsUsage: true,
    usageConvention: 'auto',   // OpenAI-compatible server fronting arbitrary local models.
    modelSelection: 'custom-only'  // models live on the user's LocalAI server
  };

  protected _createSession(panelId: string): LocalAISessionState {
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
    return vscode.workspace.getConfiguration('mysti').get<string>('localaiEndpoint', DEFAULT_LOCALAI_ENDPOINT);
  }

  private _getApiKey(): string {
    return vscode.workspace.getConfiguration('mysti').get<string>('localaiApiKey', '');
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
   * Probe the LocalAI HTTP endpoint.
   *
   * During background init only: when the configured endpoint is the default
   * and a previous probe failed within the TTL, skip the network I/O and
   * report not-running. The real probe is deferred to first actual use and
   * the setup wizard (both call discoverCli() outside initialize(), so they
   * never hit the skip). Pass `force` to bypass the skip explicitly.
   */
  async discoverCli(force = false): Promise<CliDiscoveryResult> {
    const endpoint = this._getEndpoint();
    const isDefaultEndpoint = endpoint === DEFAULT_LOCALAI_ENDPOINT;

    if (!force && this._initializing && isDefaultEndpoint &&
        Date.now() - _lastDefaultEndpointFailureAt < DISCOVERY_FAILURE_TTL_MS) {
      console.log('[Mysti] LocalAI: Skipping init probe (recent failure within TTL)');
      return {
        found: false,
        path: endpoint,
        installCommand: this.getInstallCommand(),
      };
    }

    try {
      const headers: Record<string, string> = {};
      const apiKey = this._getApiKey();
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
      const response = await fetch(`${endpoint}/v1/models`, { signal: AbortSignal.timeout(DISCOVERY_PROBE_TIMEOUT_MS), headers });
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
   * Live model discovery (Plan 01 Phase 3): GET /v1/models (OpenAI-compatible)
   * lists the models the LocalAI server exposes. Returns null on any failure so
   * the registry keeps its curated/cached list. Never throws.
   */
  async discoverModels(timeoutMs: number): Promise<ModelInfo[] | null> {
    const endpoint = this._getEndpoint();
    try {
      const headers: Record<string, string> = {};
      const apiKey = this._getApiKey();
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
      const response = await fetch(`${endpoint}/v1/models`, { signal: AbortSignal.timeout(timeoutMs), headers });
      if (!response.ok) { return null; }
      const data = await response.json() as { data?: Array<{ id?: string }> };
      const models = (data.data || [])
        .map(m => (m.id || '').trim())
        .filter(id => id.length > 0)
        .map<ModelInfo>(id => ({ id, name: id }));
      return models.length > 0 ? models : null;
    } catch {
      return null;
    }
  }

  // --- Authentication ---

  async getAuthConfig(): Promise<AuthConfig> {
    return {
      type: 'none' as 'api-key',
      isAuthenticated: true,
    };
  }

  async checkAuthentication(): Promise<AuthStatus> {
    const endpoint = this._getEndpoint();
    try {
      const headers: Record<string, string> = {};
      const apiKey = this._getApiKey();
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
      const response = await fetch(`${endpoint}/v1/models`, { signal: AbortSignal.timeout(DISCOVERY_PROBE_TIMEOUT_MS), headers });
      if (response.ok) {
        return { authenticated: true, user: 'LocalAI (local)' };
      }
      if (response.status === 401 || response.status === 403) {
        return { authenticated: false, error: 'LocalAI authentication failed. Check mysti.localaiApiKey setting.' };
      }
      return { authenticated: false, error: `LocalAI responded with status ${response.status}. Is it running?` };
    } catch {
      return { authenticated: false, error: `Cannot reach LocalAI at ${endpoint}. Start with "local-ai run".` };
    }
  }

  getAuthCommand(): string {
    return 'local-ai run';
  }

  getInstallCommand(): string {
    // NOTE: the old `curl https://localai.io/install.sh | sh` was a 404 on every
    // OS (no such script exists). Docker is LocalAI's primary supported install
    // and works on all platforms; per-OS alternatives live in getInstallMethods().
    return this._installCommandForCurrentOS('docker run -p 8080:8080 --name local-ai -ti localai/localai:latest');
  }

  getInstallMethods(): import('../../types').InstallMethod[] {
    return [
      // Docker — the officially recommended, cross-platform path
      {
        id: 'docker',
        label: 'Docker (recommended, all platforms)',
        command: 'docker run -p 8080:8080 --name local-ai -ti localai/localai:latest',
        platform: 'all',
        priority: 1,
      },
      // macOS / Linux — prebuilt binary one-liner
      {
        id: 'binary-darwin',
        label: 'Prebuilt binary (macOS)',
        command: 'curl -Lo local-ai "https://github.com/mudler/LocalAI/releases/latest/download/local-ai-$(uname -s)-$(uname -m)" && chmod +x local-ai && ./local-ai',
        platform: 'darwin',
        priority: 2,
      },
      {
        id: 'binary-linux',
        label: 'Prebuilt binary (Linux)',
        command: 'curl -Lo local-ai "https://github.com/mudler/LocalAI/releases/latest/download/local-ai-$(uname -s)-$(uname -m)" && chmod +x local-ai && ./local-ai',
        platform: 'linux',
        priority: 2,
      },
      // Windows — Docker Desktop only (no native binary); WSL is the other option
      {
        id: 'releases',
        label: 'LocalAI releases (Windows: use Docker Desktop or WSL)',
        command: 'https://github.com/mudler/LocalAI/releases/latest',
        platform: 'win32',
        priority: 2,
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

  // --- Message Sending (OpenAI-compatible HTTP API with SSE streaming) ---

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
    const session = this._getSession(panelId) as LocalAISessionState;
    const config = vscode.workspace.getConfiguration('mysti');

    // Read configurable settings
    const endpoint = this._getEndpoint();
    // Model precedence: effective/routed model FIRST (so the Mysti coordinator's
    // tier-routing / routedModel is honored, not silently dropped), then the
    // user-configured provider model, then the provider default.
    const model = this._getEffectiveModel(settings) || config.get<string>('localaiModel', '') || this.config.defaultModel;
    const temperature = config.get<number>('localaiTemperature', 0.7);
    const maxTokens = config.get<number>('localaiMaxTokens', 0);
    const apiKey = this._getApiKey();
    const timeout = config.get<number>('localaiRequestTimeout', 120000);

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

      // Build OpenAI-compatible request body
      const body: Record<string, unknown> = {
        model,
        messages: [{ role: 'user', content: fullPrompt }],
        stream: true,
        stream_options: { include_usage: true },
        temperature,
      };
      if (maxTokens > 0) {
        body.max_tokens = maxTokens;
      }
      // Reasoning effort → `reasoning_effort` (LocalAI tops out at high; xhigh/max clamp down).
      const localaiEffort = clampEffort(settings.effortLevel, LOCALAI_EFFORT_LEVELS);
      if (localaiEffort) {
        body.reasoning_effort = localaiEffort;
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      console.log(`[Mysti] LocalAI: Sending request to ${endpoint}/v1/chat/completions with model ${model}`);

      const response = await fetch(`${endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      controller.signal.throwIfAborted();
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        controller.signal.throwIfAborted();
        yield { type: 'error', content: `LocalAI error (${response.status}): ${errorText || response.statusText}` };
        yield { type: 'done' };
        return;
      }

      if (!response.body) {
        yield { type: 'error', content: 'LocalAI returned no response body' };
        yield { type: 'done' };
        return;
      }

      let usage: LocalAISessionState['lastUsageStats'] = null;
      let totalOutputTokens = 0;
      let completed = false;
      const toolCalls = new ToolCallAccumulator();
      const toolIds = new Map<number, string>();
      const turnId = randomUUID();
      for await (const data of readServerSentData(response.body, controller.signal)) {
        if (data.trim() === '[DONE]') { completed = true; break; }
        let chunk;
        try { chunk = JSON.parse(data); }
        catch { throw new Error('LocalAI returned malformed SSE data'); }
        if (chunk.error) {
          throw new Error(typeof chunk.error === 'string' ? chunk.error : chunk.error.message || 'LocalAI stream error');
        }
        // Usage-only chunks deliberately have an empty choices array.
        if (chunk.usage) {
          usage = { input_tokens: chunk.usage.prompt_tokens || 0, output_tokens: chunk.usage.completion_tokens || 0 };
        }
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (typeof delta?.content === 'string' && delta.content) {
          totalOutputTokens++;
          controller.signal.throwIfAborted();
          yield { type: 'text', content: delta.content };
        }
        if (typeof delta?.reasoning === 'string' && delta.reasoning) {
          controller.signal.throwIfAborted();
          yield { type: 'thinking', content: delta.reasoning };
        }
        if (Array.isArray(delta?.tool_calls)) {
          for (const call of delta.tool_calls) {
            const index = typeof call.index === 'number' ? call.index : 0;
            if (typeof call.id === 'string' && call.id) { toolIds.set(index, call.id); }
            else if (!toolIds.has(index)) { toolIds.set(index, `localai-tool-${turnId}-${index}`); }
            toolCalls.add([{ ...call, id: toolIds.get(index) }]);
          }
        }
        if (typeof choice?.finish_reason === 'string' && choice.finish_reason) { completed = true; }
      }
      controller.signal.throwIfAborted();
      if (!completed) { throw new Error('LocalAI stream ended before completion'); }
      // OpenAI-style arguments arrive in fragments. Emit each complete proposal
      // once at the response boundary; never invent a tool execution result.
      for (const call of toolCalls.finalize()) {
        const parsed = parseToolArgsChecked(call.arguments);
        if (parsed.status !== 'ok' && parsed.status !== 'empty') {
          throw new Error(`LocalAI returned ${parsed.status} arguments for tool ${call.name}`);
        }
        controller.signal.throwIfAborted();
        yield {
          type: 'tool_use',
          toolCall: { id: call.id, name: call.name, input: parsed.args, status: 'running', kind: toolKind(call.name) },
        };
      }
      controller.signal.throwIfAborted();
      // Delta counts are only an estimate, never measured usage.
      yield { type: 'done', usage: usage || { input_tokens: 0, output_tokens: totalOutputTokens, estimated: true } };

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
      const session = state as LocalAISessionState;
      session.abortController?.abort();
      session.abortController = null;
    }
    super.cancelCurrentRequest(panelId);
  }

  dispose(): void {
    this.cancelCurrentRequest();
    super.dispose();
  }

  getStoredUsage(panelId?: string): { input_tokens: number; output_tokens: number } | null {
    const session = this._getSession(panelId) as LocalAISessionState;
    const usage = session.lastUsageStats;
    session.lastUsageStats = null;
    return usage;
  }

  clearSession(panelId?: string): void {
    this.cancelCurrentRequest(panelId);
    for (const [key, state] of this._panelSessions) {
      if (!panelId || key === panelId) { (state as LocalAISessionState).lastUsageStats = null; }
    }
    super.clearSession(panelId);
  }
}
