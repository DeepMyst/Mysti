/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
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
 * Per-panel session state for MiniMax HTTP provider
 */
export interface MiniMaxSessionState extends PanelSessionState {
  abortController: AbortController | null;
  lastUsageStats: { input_tokens: number; output_tokens: number } | null;
}

/**
 * MiniMax provider implementation using OpenAI-compatible HTTP API
 *
 * MiniMax exposes an OpenAI-compatible API at /v1/chat/completions with SSE streaming.
 * API key is configured via the MINIMAX_API_KEY environment variable or the
 * mysti.minimaxApiKey setting.
 *
 * API: POST /v1/chat/completions (OpenAI-compatible)
 * Docs: https://platform.minimax.io/docs/api-reference/text-openai-api
 */
export class MiniMaxProvider extends BaseCliProvider {
  readonly id = 'minimax';
  readonly displayName = 'MiniMax';

  readonly config: ProviderConfig = {
    name: 'minimax',
    displayName: 'MiniMax',
    models: [
      {
        id: 'MiniMax-M2.7',
        name: 'MiniMax-M2.7',
        description: 'Peak Performance. Ultimate Value. Master the Complex.',
        contextWindow: 1000000,
      },
      {
        id: 'MiniMax-M2.7-highspeed',
        name: 'MiniMax-M2.7-highspeed',
        description: 'Same performance, faster and more agile.',
        contextWindow: 1000000,
      },
    ],
    defaultModel: 'MiniMax-M2.7',
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsThinking: false,
    supportsToolUse: false,
    supportsSessions: false,
    supportsImages: false,
    supportsAutoInstall: false,
  };

  protected _createSession(panelId: string): MiniMaxSessionState {
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

  // --- Configuration helpers ---

  private _getBaseUrl(): string {
    return vscode.workspace.getConfiguration('mysti').get<string>(
      'minimaxBaseUrl',
      'https://api.minimax.io/v1',
    );
  }

  private _getApiKey(): string {
    return (
      vscode.workspace.getConfiguration('mysti').get<string>('minimaxApiKey', '') ||
      process.env.MINIMAX_API_KEY ||
      ''
    );
  }

  // --- Discovery (API key presence check) ---

  async discoverCli(): Promise<CliDiscoveryResult> {
    const apiKey = this._getApiKey();
    if (apiKey) {
      return { found: true, path: this._getBaseUrl() };
    }
    return {
      found: false,
      path: this._getBaseUrl(),
      installCommand: this.getInstallCommand(),
    };
  }

  getCliPath(): string {
    return this._getBaseUrl();
  }

  // --- Authentication ---

  async getAuthConfig(): Promise<AuthConfig> {
    return {
      type: 'api-key',
      isAuthenticated: !!this._getApiKey(),
    };
  }

  async checkAuthentication(): Promise<AuthStatus> {
    const apiKey = this._getApiKey();
    if (!apiKey) {
      return {
        authenticated: false,
        error: 'MiniMax API key not set. Configure mysti.minimaxApiKey or set the MINIMAX_API_KEY environment variable.',
      };
    }
    return { authenticated: true, user: 'MiniMax API' };
  }

  getAuthCommand(): string {
    return 'Set MINIMAX_API_KEY environment variable or configure mysti.minimaxApiKey setting';
  }

  getInstallCommand(): string {
    return 'Get your API key at https://platform.minimax.io and set mysti.minimaxApiKey';
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
    const session = this._getSession(panelId) as MiniMaxSessionState;
    const config = vscode.workspace.getConfiguration('mysti');

    const baseUrl = this._getBaseUrl();
    const apiKey = this._getApiKey();
    const model = config.get<string>('minimaxModel', '') || this.config.defaultModel;
    // MiniMax temperature range is (0.0, 1.0] — default 1.0, must not be 0
    const temperature = Math.max(0.01, Math.min(1.0, config.get<number>('minimaxTemperature', 1.0)));
    const maxTokens = config.get<number>('minimaxMaxTokens', 0);
    const timeout = config.get<number>('minimaxRequestTimeout', 120000);

    if (!apiKey) {
      yield { type: 'error', content: 'MiniMax API key not configured. Set mysti.minimaxApiKey or MINIMAX_API_KEY.' };
      yield { type: 'done' };
      return;
    }

    session.abortController = new AbortController();
    const timeoutId = setTimeout(() => session.abortController?.abort(), timeout);

    try {
      const fullPrompt = await this.buildPromptAsync(
        content, context, conversation, settings, persona, agentConfig, attachments,
      );

      const body: Record<string, unknown> = {
        model,
        messages: [{ role: 'user', content: fullPrompt }],
        stream: true,
        temperature,
      };
      if (maxTokens > 0) {
        body.max_tokens = maxTokens;
      }

      console.log(`[Mysti] MiniMax: Sending request to ${baseUrl}/chat/completions with model ${model}`);

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: session.abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        yield { type: 'error', content: `MiniMax error (${response.status}): ${errorText || response.statusText}` };
        yield { type: 'done' };
        return;
      }

      if (!response.body) {
        yield { type: 'error', content: 'MiniMax returned no response body' };
        yield { type: 'done' };
        return;
      }

      // Parse SSE stream (OpenAI format: "data: {...}\n\n")
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
          if (!trimmed || !trimmed.startsWith('data: ')) { continue; }

          const data = trimmed.slice(6);
          if (data === '[DONE]') { continue; }

          try {
            const chunk = JSON.parse(data);
            const choice = chunk.choices?.[0];
            if (!choice) { continue; }

            const delta = choice.delta;

            if (delta?.content) {
              totalOutputTokens++;
              yield { type: 'text', content: delta.content };
            }

            if (chunk.usage) {
              session.lastUsageStats = {
                input_tokens: chunk.usage.prompt_tokens || 0,
                output_tokens: chunk.usage.completion_tokens || 0,
              };
            }
          } catch {
            console.log('[Mysti] MiniMax: Failed to parse SSE data:', data.substring(0, 200));
          }
        }
      }

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
      const session = this._panelSessions.get(panelId) as MiniMaxSessionState | undefined;
      if (session?.abortController) {
        console.log('[Mysti] MiniMax: Cancelling request for panel:', panelId);
        session.abortController.abort();
        session.abortController = null;
      }
    }
    super.cancelCurrentRequest(panelId);
  }

  getStoredUsage(panelId?: string): { input_tokens: number; output_tokens: number } | null {
    const session = this._getSession(panelId) as MiniMaxSessionState;
    const usage = session.lastUsageStats;
    session.lastUsageStats = null;
    return usage;
  }

  clearSession(panelId?: string): void {
    super.clearSession(panelId);
    if (panelId) {
      const session = this._panelSessions.get(panelId) as MiniMaxSessionState | undefined;
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
