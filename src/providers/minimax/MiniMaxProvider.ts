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
import { validateModelName } from '../../utils/validation';
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
  UsageStats,
  InstallMethod,
  SlashCommandDefinition,
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
 * VS Code SecretStorage, configured through provider setup.
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
        contextWindow: 204800,
      },
      {
        id: 'MiniMax-M2.7-highspeed',
        name: 'MiniMax-M2.7-highspeed',
        description: 'Same performance, faster and more agile.',
        contextWindow: 204800,
      },
    ],
    defaultModel: 'MiniMax-M2.7',
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsThinking: true,
    supportsToolUse: false,
    supportsSessions: false,
    supportsImages: false,
    supportsAutoInstall: false,
    supportsPromptEnhancement: false,
    thinkingStyle: 'streamed', thinkingLevelEffective: false,
    planMode: 'none', sessionKind: 'none', emitsToolResults: false,
    emitsUsage: true, usageConvention: 'auto', modelSelection: 'full',
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

  private _getBaseUrl(): string {
    const configured = vscode.workspace.getConfiguration('mysti').get<string>('minimaxBaseUrl', 'https://api.minimax.io/v1');
    const url = new URL(configured);
    if (url.protocol !== 'https:' || !['api.minimax.io', 'api.minimaxi.com'].includes(url.hostname)
        || url.port || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, '') !== '/v1') {
      throw new Error('MiniMax endpoint must be https://api.minimax.io/v1 or https://api.minimaxi.com/v1.');
    }
    return url.href.replace(/\/$/, '');
  }

  private async _getApiKey(): Promise<string> {
    return (await this._extensionContext.secrets.get('mysti.minimax.apiKey'))?.trim() || process.env.MINIMAX_API_KEY?.trim() || '';
  }

  async configureAuthentication(): Promise<AuthStatus> {
    const key = await vscode.window.showInputBox({
      title: 'MiniMax API key', prompt: 'Enter your MiniMax API key. It is stored in VS Code SecretStorage.',
      password: true, ignoreFocusOut: true,
      validateInput: value => value.trim() ? undefined : 'Enter an API key.',
    });
    if (key === undefined) { return { authenticated: false, error: 'Authentication cancelled.' }; }
    if (!key.trim()) { return { authenticated: false, error: 'Enter an API key.' }; }
    await this._extensionContext.secrets.store('mysti.minimax.apiKey', key.trim());
    return this.checkAuthentication();
  }

  // The API adapter is always available. Missing credentials are an auth state,
  // never a missing CLI or a reason to offer an installer.
  async discoverCli(): Promise<CliDiscoveryResult> { return { found: true, path: 'api' }; }
  getCliPath(): string { return this._getBaseUrl(); }
  async getAuthConfig(): Promise<AuthConfig> { return { type: 'api-key', isAuthenticated: !!(await this._getApiKey()) }; }
  async checkAuthentication(): Promise<AuthStatus> {
    return (await this._getApiKey())
      ? { authenticated: true, user: 'API key configured (validated when used)' }
      : { authenticated: false, error: 'Configure a MiniMax API key in provider setup or set MINIMAX_API_KEY.' };
  }
  getAuthCommand(): string { return 'Configure your MiniMax API key in provider setup'; }
  getInstallCommand(): string { return 'https://platform.minimax.io'; }
  getInstallMethods(): InstallMethod[] { return []; }
  getSlashCommands(): SlashCommandDefinition[] { return []; }
  protected buildCliArgs(_settings: Settings, _session: PanelSessionState): string[] { return []; }
  protected parseStreamLine(_line: string, _session: PanelSessionState): StreamChunk | null { return null; }
  protected getThinkingTokens(_thinkingLevel: string): number | undefined { return undefined; }

  async *sendMessage(
    content: string, context: ContextItem[], settings: Settings, conversation: Conversation | null,
    persona?: PersonaConfig, panelId?: string, _providerManager?: unknown,
    agentConfig?: AgentConfiguration, attachments?: Attachment[],
  ): AsyncGenerator<StreamChunk> {
    const session = this._getSession(panelId) as MiniMaxSessionState;
    session.abortController?.abort();
    const controller = new AbortController();
    session.abortController = controller;
    session.lastUsageStats = null;
    const config = vscode.workspace.getConfiguration('mysti');
    const configuredTimeout = config.get<number>('minimaxRequestTimeout', 120000);
    const timeout = Number.isFinite(configuredTimeout) ? Math.max(1000, Math.min(3600000, configuredTimeout)) : 120000;
    const timer = setTimeout(() => controller.abort(), timeout);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let apiKey = '';
    try {
      apiKey = await this._getApiKey();
      controller.signal.throwIfAborted();
      if (!apiKey) {
        yield { type: 'auth_error', content: 'MiniMax API key is not configured.', authCommand: this.getAuthCommand(), providerName: this.displayName };
        return;
      }
      const model = settings.routedModel || config.get<string>('minimaxModel', '').trim() || settings.model || this.config.defaultModel;
      if (!validateModelName(model).valid) { throw new Error('Invalid MiniMax model name.'); }
      const fullPrompt = await this.buildPromptAsync(content, context, conversation, settings, persona, agentConfig, attachments, session.channelSystemContext);
      controller.signal.throwIfAborted();
      const temperature = config.get<number>('minimaxTemperature', 1);
      const maxTokens = config.get<number>('minimaxMaxTokens', 0);
      const body: Record<string, unknown> = {
        model, messages: [{ role: 'user', content: fullPrompt }], stream: true,
        temperature: Number.isFinite(temperature) ? Math.max(0, Math.min(2, temperature)) : 1,
        stream_options: { include_usage: true }, reasoning_split: true,
      };
      if (Number.isFinite(maxTokens) && maxTokens > 0) { body.max_completion_tokens = Math.floor(maxTokens); }
      const response = await fetch(`${this._getBaseUrl()}/chat/completions`, {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body), signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        yield { type: 'auth_error', content: 'MiniMax rejected the API key. Check the key and account access.', authCommand: this.getAuthCommand(), providerName: this.displayName };
        return;
      }
      if (!response.ok) { throw new Error(`MiniMax request failed (${response.status}). Check model access, quota and endpoint settings.`); }
      if (!response.body) { throw new Error('MiniMax returned no response stream.'); }
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      let sawText = false;
      let sawFinish = false;
      let usage: UsageStats | undefined;
      // SSE records may be split anywhere, including inside a UTF-8 character.
      // Keep usage-only frames (choices can be empty) and the final unterminated line.
      while (!finished) {
        controller.signal.throwIfAborted();
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        if (done && buffer) { buffer += '\n'; }
        if (buffer.length > 4 * 1024 * 1024) { throw new Error('MiniMax stream frame exceeded the size limit.'); }
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith('data:')) { continue; }
          const data = line.slice(5).trim();
          if (data === '[DONE]') { finished = true; break; }
          if (!data) { continue; }
          const chunk = JSON.parse(data) as {
            error?: unknown; base_resp?: { status_code?: number };
            choices?: Array<{ delta?: { content?: string; reasoning_content?: string }; finish_reason?: string }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          if (chunk.error || chunk.base_resp?.status_code) { throw new Error('MiniMax reported a streaming API error.'); }
          if (chunk.usage) {
            const input = chunk.usage.prompt_tokens, output = chunk.usage.completion_tokens;
            if (typeof input === 'number' && Number.isFinite(input) && input >= 0 && typeof output === 'number' && Number.isFinite(output) && output >= 0) {
              usage = { input_tokens: input, output_tokens: output };
            }
          }
          const choice = chunk.choices?.[0];
          if (choice?.finish_reason) { sawFinish = true; }
          if (typeof choice?.delta?.reasoning_content === 'string') { yield { type: 'thinking', content: choice.delta.reasoning_content }; }
          if (typeof choice?.delta?.content === 'string' && choice.delta.content) { sawText = true; yield { type: 'text', content: choice.delta.content }; }
        }
        if (done) { break; }
      }
      if (!finished && !sawFinish) { throw new Error('MiniMax stream ended before completion. Please retry.'); }
      if (!sawText) { throw new Error('MiniMax returned no answer. Check the model and output token limit.'); }
      if (session.abortController === controller) { session.lastUsageStats = usage ?? null; }
      yield { type: 'done', ...(usage ? { usage } : {}), contextWindow: this.config.models.find(m => m.id === model)?.contextWindow };
    } catch (error) {
      const message = controller.signal.aborted ? 'MiniMax request cancelled or timed out.'
        : error instanceof Error ? error.message : 'MiniMax request failed.';
      yield { type: 'error', content: apiKey ? message.split(apiKey).join('[REDACTED]') : message };
    } finally {
      clearTimeout(timer);
      controller.abort();
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      if (session.abortController === controller) { session.abortController = null; }
    }
  }

  cancelCurrentRequest(panelId?: string): void {
    const sessions = panelId ? [this._panelSessions.get(panelId)] : [...this._panelSessions.values()];
    for (const session of sessions) { (session as MiniMaxSessionState | undefined)?.abortController?.abort(); }
    super.cancelCurrentRequest(panelId);
  }
  clearSession(panelId?: string): void {
    this.cancelCurrentRequest(panelId);
    const sessions = panelId ? [this._panelSessions.get(panelId)] : [...this._panelSessions.values()];
    for (const session of sessions) { if (session) { (session as MiniMaxSessionState).lastUsageStats = null; } }
    super.clearSession(panelId);
  }
  getStoredUsage(panelId?: string): UsageStats | null {
    const session = this._getSession(panelId) as MiniMaxSessionState;
    const usage = session.lastUsageStats;
    session.lastUsageStats = null;
    return usage;
  }
  dispose(): void { this.cancelCurrentRequest(); super.dispose(); }
}
