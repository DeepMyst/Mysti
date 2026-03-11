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
} from '../../types';

/**
 * Per-panel session state for LocalAI HTTP provider
 */
export interface LocalAISessionState extends PanelSessionState {
  abortController: AbortController | null;
  lastUsageStats: { input_tokens: number; output_tokens: number } | null;
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
    supportsThinking: false,
    supportsToolUse: true,
    supportsSessions: false,
    supportsImages: false,
    supportsAutoInstall: false
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

  private _getEndpoint(): string {
    return vscode.workspace.getConfiguration('mysti').get<string>('localaiEndpoint', 'http://localhost:8080');
  }

  private _getApiKey(): string {
    return vscode.workspace.getConfiguration('mysti').get<string>('localaiApiKey', '');
  }

  async discoverCli(): Promise<CliDiscoveryResult> {
    const endpoint = this._getEndpoint();
    try {
      const headers: Record<string, string> = {};
      const apiKey = this._getApiKey();
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
      const response = await fetch(`${endpoint}/v1/models`, { signal: AbortSignal.timeout(3000), headers });
      if (response.ok) {
        return { found: true, path: endpoint };
      }
    } catch {
      // Server not reachable
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
      const response = await fetch(`${endpoint}/v1/models`, { signal: AbortSignal.timeout(3000), headers });
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
    return 'curl https://localai.io/install.sh | sh';
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
    const model = config.get<string>('localaiModel', '') || this.config.defaultModel;
    const temperature = config.get<number>('localaiTemperature', 0.7);
    const maxTokens = config.get<number>('localaiMaxTokens', 0);
    const apiKey = this._getApiKey();
    const timeout = config.get<number>('localaiRequestTimeout', 120000);

    // Set up cancellation
    session.abortController = new AbortController();
    const timeoutId = setTimeout(() => session.abortController?.abort(), timeout);

    try {
      // Build prompt using inherited method
      const fullPrompt = await this.buildPromptAsync(
        content, context, conversation, settings, persona, agentConfig, attachments,
      );

      // Build OpenAI-compatible request body
      const body: Record<string, unknown> = {
        model,
        messages: [{ role: 'user', content: fullPrompt }],
        stream: true,
        temperature,
      };
      if (maxTokens > 0) {
        body.max_tokens = maxTokens;
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
        signal: session.abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        yield { type: 'error', content: `LocalAI error (${response.status}): ${errorText || response.statusText}` };
        yield { type: 'done' };
        return;
      }

      if (!response.body) {
        yield { type: 'error', content: 'LocalAI returned no response body' };
        yield { type: 'done' };
        return;
      }

      // Read SSE stream (OpenAI format: "data: {...}\n\n")
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let totalOutputTokens = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) { break; }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) { continue; }

          // SSE format: "data: {...}" or "data: [DONE]"
          if (!trimmed.startsWith('data: ')) { continue; }

          const data = trimmed.slice(6); // Remove "data: " prefix

          if (data === '[DONE]') {
            continue;
          }

          try {
            const chunk = JSON.parse(data);
            const choice = chunk.choices?.[0];
            if (!choice) { continue; }

            const delta = choice.delta;

            // Handle text content
            if (delta?.content) {
              totalOutputTokens++;
              yield { type: 'text', content: delta.content };
            }

            // Handle tool calls
            if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
              for (const toolCall of delta.tool_calls) {
                const fn = toolCall.function;
                if (fn?.name) {
                  yield {
                    type: 'tool_use',
                    toolCall: {
                      id: toolCall.id || `localai-tool-${Date.now()}`,
                      name: fn.name,
                      input: fn.arguments ? JSON.parse(fn.arguments) : {},
                      status: 'running',
                    }
                  };
                }
              }
            }

            // Capture usage from the final chunk if available
            if (chunk.usage) {
              session.lastUsageStats = {
                input_tokens: chunk.usage.prompt_tokens || 0,
                output_tokens: chunk.usage.completion_tokens || 0,
              };
            }
          } catch (parseErr) {
            console.log('[Mysti] LocalAI: Failed to parse SSE data:', data.substring(0, 200));
          }
        }
      }

      // Use captured usage or estimate from token count
      const usage = session.lastUsageStats || { input_tokens: 0, output_tokens: totalOutputTokens };
      session.lastUsageStats = null;
      yield { type: 'done', usage };

    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        yield { type: 'error', content: 'Request cancelled or timed out' };
      } else {
        yield this.handleError(error);
      }
      yield { type: 'done' };
    } finally {
      clearTimeout(timeoutId);
      session.abortController = null;
    }
  }

  // --- Cancellation ---

  cancelCurrentRequest(panelId?: string): void {
    if (panelId) {
      const session = this._panelSessions.get(panelId) as LocalAISessionState | undefined;
      if (session?.abortController) {
        console.log('[Mysti] LocalAI: Cancelling request for panel:', panelId);
        session.abortController.abort();
        session.abortController = null;
      }
    }
    super.cancelCurrentRequest(panelId);
  }

  getStoredUsage(panelId?: string): { input_tokens: number; output_tokens: number } | null {
    const session = this._getSession(panelId) as LocalAISessionState;
    const usage = session.lastUsageStats;
    session.lastUsageStats = null;
    return usage;
  }

  clearSession(panelId?: string): void {
    super.clearSession(panelId);
    if (panelId) {
      const session = this._panelSessions.get(panelId) as LocalAISessionState | undefined;
      if (session) {
        session.lastUsageStats = null;
        if (session.abortController) {
          session.abortController.abort();
          session.abortController = null;
        }
      }
    }
  }
}
