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
 * Per-panel session state for Ollama HTTP provider
 */
export interface OllamaSessionState extends PanelSessionState {
  abortController: AbortController | null;
  lastUsageStats: { input_tokens: number; output_tokens: number } | null;
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
        id: 'llama3.2',
        name: 'Llama 3.2',
        description: 'Meta open-source model, good general purpose',
        contextWindow: 128000
      },
      {
        id: 'codellama',
        name: 'Code Llama',
        description: 'Meta code-specialized model',
        contextWindow: 16384
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
    defaultModel: 'llama3.2'
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsThinking: false,
    supportsToolUse: true,
    supportsSessions: false,
    supportsImages: true,
    supportsAutoInstall: false
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

  private _getEndpoint(): string {
    return vscode.workspace.getConfiguration('mysti').get<string>('ollamaEndpoint', 'http://localhost:11434');
  }

  async discoverCli(): Promise<CliDiscoveryResult> {
    const endpoint = this._getEndpoint();
    try {
      const response = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(3000) });
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
      const response = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(3000) });
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
    return 'brew install ollama';
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
    const model = config.get<string>('ollamaModel', '') || this.config.defaultModel;
    const temperature = config.get<number>('ollamaTemperature', 0.7);
    const contextLength = config.get<number>('ollamaContextLength', 0);
    const keepAlive = config.get<string>('ollamaKeepAlive', '5m');
    const timeout = config.get<number>('ollamaRequestTimeout', 120000);

    // Set up cancellation
    session.abortController = new AbortController();
    const timeoutId = setTimeout(() => session.abortController?.abort(), timeout);

    try {
      // Build prompt using inherited method
      const fullPrompt = await this.buildPromptAsync(
        content, context, conversation, settings, persona, agentConfig, attachments,
      );

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

      console.log(`[Mysti] Ollama: Sending request to ${endpoint}/api/chat with model ${model}`);

      const response = await fetch(`${endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: session.abortController.signal,
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
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) { break; }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.trim()) { continue; }

          try {
            const chunk = JSON.parse(line);

            // Handle tool calls
            if (chunk.message?.tool_calls && Array.isArray(chunk.message.tool_calls)) {
              for (const toolCall of chunk.message.tool_calls) {
                const fn = toolCall.function;
                if (fn) {
                  yield {
                    type: 'tool_use',
                    toolCall: {
                      id: `ollama-tool-${Date.now()}`,
                      name: fn.name || '',
                      input: fn.arguments || {},
                      status: 'running',
                    }
                  };
                }
              }
              continue;
            }

            // Handle text content
            if (chunk.message?.content) {
              yield { type: 'text', content: chunk.message.content };
            }

            // Handle completion
            if (chunk.done === true) {
              session.lastUsageStats = {
                input_tokens: chunk.prompt_eval_count || 0,
                output_tokens: chunk.eval_count || 0,
              };
              console.log('[Mysti] Ollama: Stream complete, usage:', session.lastUsageStats);
            }
          } catch (parseErr) {
            console.log('[Mysti] Ollama: Failed to parse NDJSON line:', line.substring(0, 200));
          }
        }
      }

      const storedUsage = session.lastUsageStats;
      session.lastUsageStats = null;
      yield storedUsage ? { type: 'done', usage: storedUsage } : { type: 'done' };

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
      const session = this._panelSessions.get(panelId) as OllamaSessionState | undefined;
      if (session?.abortController) {
        console.log('[Mysti] Ollama: Cancelling request for panel:', panelId);
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
    super.clearSession(panelId);
    if (panelId) {
      const session = this._panelSessions.get(panelId) as OllamaSessionState | undefined;
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
