/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * This file is part of Mysti, licensed under the Business Source License 1.1.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: BUSL-1.1
 */

import * as vscode from 'vscode';
import * as https from 'https';
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
} from '../../types';
import { MANUS_API_BASE_URL, MANUS_POLL_INTERVAL_MS } from '../../constants';
import { validateModelName } from '../../utils/validation';

export interface ManusSessionState extends PanelSessionState {
  abortController: AbortController | null;
  currentTaskId: string | null;
}

/**
 * Manus provider implementation using HTTP API
 *
 * Unlike other providers that spawn CLI processes, Manus uses an async HTTP API:
 * 1. POST /v1/responses to create a task
 * 2. GET /v1/responses/{id} to poll status (running → completed/error)
 * 3. DELETE /v1/responses/{id} to cancel
 *
 * Auth: API key via custom API_KEY header
 * Docs: https://open.manus.ai/docs/openai-compatibility/index
 */
// TODO: Manus provider is disabled — fix API key detection and HTTP polling before re-enabling
export class ManusProvider extends BaseCliProvider {
  readonly id = 'manus';
  readonly displayName = 'Manus';

  readonly config: ProviderConfig = {
    name: 'manus',
    displayName: 'Manus',
    models: [
      {
        id: 'manus-1.6-max',
        name: 'Manus 1.6 Max',
        description: 'Most capable Manus model',
        contextWindow: 128000,
      },
      {
        id: 'manus-1.6',
        name: 'Manus 1.6',
        description: 'Balanced Manus model',
        contextWindow: 128000,
      },
      {
        id: 'manus-1.6-lite',
        name: 'Manus 1.6 Lite',
        description: 'Fast and lightweight Manus model',
        contextWindow: 128000,
      },
    ],
    defaultModel: 'manus-1.6',
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: false,
    supportsThinking: false,
    supportsToolUse: false,
    supportsSessions: true,
    supportsAutoInstall: false,
  };

  protected _createSession(panelId: string): ManusSessionState {
    return {
      panelId,
      process: null,
      sessionId: null,
      autonomousMode: false,
      persistentProcess: null,
      persistentReady: false,
      lastHealthCheck: 0,
      abortController: null,
      currentTaskId: null,
    };
  }

  // --- CLI Discovery (API-based, no CLI) ---

  async discoverCli(): Promise<CliDiscoveryResult> {
    const apiKey = this._getApiKey();
    if (apiKey) {
      return { found: true, path: 'api' };
    }
    return {
      found: false,
      path: 'api',
      installCommand: this.getInstallCommand(),
    };
  }

  getCliPath(): string {
    return MANUS_API_BASE_URL;
  }

  // --- Authentication ---

  async getAuthConfig(): Promise<AuthConfig> {
    const apiKey = this._getApiKey();
    return {
      type: 'api-key',
      isAuthenticated: !!apiKey,
    };
  }

  async checkAuthentication(): Promise<AuthStatus> {
    const apiKey = this._getApiKey();
    if (!apiKey) {
      return {
        authenticated: false,
        error: 'Manus API key not configured. Set mysti.manusApiKey in settings or MANUS_API_KEY environment variable.',
      };
    }
    return { authenticated: true, user: 'API Key configured' };
  }

  getAuthCommand(): string {
    return 'Enter your Manus API key in VS Code settings (mysti.manusApiKey) or set MANUS_API_KEY environment variable';
  }

  getInstallCommand(): string {
    return 'Visit https://manus.im to sign up and get your API key';
  }

  getInstallMethods(): import('../../types').InstallMethod[] {
    return [
      {
        id: 'api-key',
        label: 'Get your API key from Manus',
        command: 'https://manus.im/settings',
        platform: 'all',
        priority: 1,
      },
    ];
  }

  // --- Stub methods (required by abstract class, not used for API provider) ---

  protected buildCliArgs(_settings: Settings, _session: PanelSessionState): string[] {
    return [];
  }

  protected parseStreamLine(_line: string, _session: PanelSessionState): StreamChunk | null {
    return null;
  }

  protected getThinkingTokens(_thinkingLevel: string): number | undefined {
    return undefined;
  }

  // --- Message Sending (HTTP API) ---

  async *sendMessage(
    content: string,
    context: ContextItem[],
    settings: Settings,
    conversation: Conversation | null,
    persona?: PersonaConfig,
    panelId?: string,
    providerManager?: unknown,
    agentConfig?: AgentConfiguration,
  ): AsyncGenerator<StreamChunk> {
    const apiKey = this._getApiKey();
    if (!apiKey) {
      yield {
        type: 'auth_error',
        content: 'Manus API key not configured. Please set mysti.manusApiKey in VS Code settings or set the MANUS_API_KEY environment variable.',
        authCommand: this.getAuthCommand(),
        providerName: this.displayName,
      };
      return;
    }

    const session = this._getSession(panelId) as ManusSessionState;

    // Build prompt using inherited method
    const fullPrompt = await this.buildPromptAsync(
      content, context, conversation, settings, persona, agentConfig,
    );

    // Determine model
    const model = this._getEffectiveModel(settings) || this.config.defaultModel;

    // Set up cancellation
    session.abortController = new AbortController();

    try {
      // Create task
      console.log(`[Mysti] Manus: Creating task with model ${model}`);
      const createBody: Record<string, unknown> = {
        model,
        input: fullPrompt,
        task_mode: 'agent',
      };

      // Multi-turn support
      if (session.sessionId) {
        createBody.previous_response_id = session.sessionId;
      }

      const createResponse = await this._apiRequest('POST', '/v1/responses', createBody, apiKey, session.abortController);

      if (!createResponse.id) {
        const err = createResponse.error as Record<string, unknown> | undefined;
        yield { type: 'error', content: (err?.message as string) || 'Failed to create Manus task' };
        yield { type: 'done' };
        return;
      }

      const taskId = createResponse.id as string;
      session.currentTaskId = taskId;
      console.log(`[Mysti] Manus: Task created: ${taskId}`);

      // Yield thinking indicator while polling
      yield { type: 'thinking', content: 'Manus is working on your request...' };

      // Poll for completion
      let completed = false;
      while (!completed) {
        // Check for cancellation
        if (session.abortController?.signal.aborted) {
          console.log('[Mysti] Manus: Request cancelled');
          yield { type: 'error', content: 'Request cancelled' };
          break;
        }

        // Wait before polling
        await this._delay(MANUS_POLL_INTERVAL_MS, session.abortController);

        // Check again after delay
        if (session.abortController?.signal.aborted) {
          break;
        }

        const statusResponse = await this._apiRequest('GET', `/v1/responses/${taskId}`, null, apiKey, session.abortController);

        const status = statusResponse.status;
        console.log(`[Mysti] Manus: Task ${taskId} status: ${status}`);

        if (status === 'completed') {
          completed = true;

          // Parse output
          const text = this._extractOutputText(statusResponse);
          if (text) {
            yield { type: 'text', content: text };
          } else {
            yield { type: 'text', content: '(Manus completed the task but returned no text output)' };
          }

          // Store response ID for multi-turn
          session.sessionId = taskId;

        } else if (status === 'error' || status === 'failed') {
          completed = true;
          const errObj = statusResponse.error as Record<string, unknown> | string | undefined;
          const errorMsg = (typeof errObj === 'object' && errObj !== null ? errObj.message as string : errObj) || 'Manus task failed';
          yield { type: 'error', content: typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg) };

        } else if (status !== 'running' && status !== 'pending' && status !== 'queued') {
          // Unknown status
          console.warn(`[Mysti] Manus: Unknown task status: ${status}`);
        }
      }

      yield { type: 'done' };

    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        yield { type: 'error', content: 'Request cancelled' };
      } else {
        yield this.handleError(error);
      }
      yield { type: 'done' };
    } finally {
      session.abortController = null;
      session.currentTaskId = null;
    }
  }

  // --- Cancellation ---

  cancelCurrentRequest(panelId?: string): void {
    if (panelId) {
      const session = this._panelSessions.get(panelId) as ManusSessionState | undefined;
      if (session) {
        if (session.abortController) {
          console.log('[Mysti] Manus: Cancelling request for panel:', panelId);
          session.abortController.abort();
        }
        if (session.currentTaskId) {
          const apiKey = this._getApiKey();
          if (apiKey) {
            this._apiRequest('DELETE', `/v1/responses/${session.currentTaskId}`, null, apiKey)
              .catch(err => console.log('[Mysti] Manus: Error cancelling task:', err));
          }
          session.currentTaskId = null;
        }
      }
    } else {
      // Cancel all panels
      for (const [, session] of this._panelSessions) {
        const manusSession = session as ManusSessionState;
        if (manusSession.abortController) {
          manusSession.abortController.abort();
        }
        if (manusSession.currentTaskId) {
          const apiKey = this._getApiKey();
          if (apiKey) {
            this._apiRequest('DELETE', `/v1/responses/${manusSession.currentTaskId}`, null, apiKey)
              .catch(err => console.log('[Mysti] Manus: Error cancelling task:', err));
          }
          manusSession.currentTaskId = null;
        }
      }
    }
  }

  dispose(): void {
    this.cancelCurrentRequest();
  }

  // --- Private Helpers ---

  private _getApiKey(): string {
    const config = vscode.workspace.getConfiguration('mysti');
    const settingsKey = config.get<string>('manusApiKey', '');
    if (settingsKey) {
      return settingsKey;
    }
    return process.env.MANUS_API_KEY || '';
  }

  private _getEffectiveModel(settings: Settings): string | undefined {
    const config = vscode.workspace.getConfiguration('mysti');
    const customModel = config.get<string>('manusModel', '');
    if (customModel) {
      const validation = validateModelName(customModel);
      if (validation.valid) {
        console.log(`[Mysti] Manus: Using custom model: ${customModel}`);
        return customModel;
      }
      console.warn(`[Mysti] Manus: Invalid custom model "${customModel}": ${validation.error}`);
    }

    if (settings.model && settings.model !== this.config.defaultModel) {
      return settings.model;
    }

    return undefined;
  }

  /**
   * Extract text content from Manus API response output
   */
  private _extractOutputText(response: Record<string, unknown>): string {
    const output = response.output as Array<Record<string, unknown>> | undefined;
    if (!output || !Array.isArray(output)) {
      return '';
    }

    const textParts: string[] = [];
    for (const item of output) {
      if (item.type === 'message') {
        const content = item.content as Array<Record<string, unknown>> | undefined;
        if (content && Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'output_text' && typeof block.text === 'string') {
              textParts.push(block.text);
            }
          }
        }
      }
    }

    return textParts.join('\n');
  }

  /**
   * Make an HTTP request to the Manus API
   */
  private _apiRequest(
    method: string,
    path: string,
    body: Record<string, unknown> | null,
    apiKey: string,
    abortController?: AbortController | null,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, MANUS_API_BASE_URL);
      const bodyStr = body ? JSON.stringify(body) : null;

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer placeholder',
          'API_KEY': apiKey,
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode && res.statusCode >= 400) {
              console.error(`[Mysti] Manus: API error ${res.statusCode}:`, data);
              resolve({
                error: { message: parsed.error?.message || parsed.message || `HTTP ${res.statusCode}` },
                status: 'error',
              });
            } else {
              resolve(parsed);
            }
          } catch {
            console.error('[Mysti] Manus: Failed to parse API response:', data);
            resolve({ error: { message: 'Invalid API response' }, status: 'error' });
          }
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      // Wire up abort controller
      if (abortController) {
        const signal = abortController.signal;
        if (signal.aborted) {
          req.destroy();
          reject(new DOMException('The operation was aborted', 'AbortError'));
          return;
        }
        signal.addEventListener('abort', () => {
          req.destroy();
          reject(new DOMException('The operation was aborted', 'AbortError'));
        }, { once: true });
      }

      if (bodyStr) {
        req.write(bodyStr);
      }
      req.end();
    });
  }

  /**
   * Promise-based delay with abort support
   */
  private _delay(ms: number, abortController?: AbortController | null): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      if (abortController) {
        const signal = abortController.signal;
        if (signal.aborted) {
          clearTimeout(timer);
          reject(new DOMException('The operation was aborted', 'AbortError'));
          return;
        }
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('The operation was aborted', 'AbortError'));
        }, { once: true });
      }
    });
  }
}
