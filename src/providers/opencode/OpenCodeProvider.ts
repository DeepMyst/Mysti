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
import type { PanelSessionState } from '../base/BaseCliProvider';
import { AcpNativeProvider } from '../base/AcpNativeProvider';
import type { AcpNativeLaunch, AcpNativeLaunchContext } from '../base/AcpNativeTypes';
import { OPENCODE_ACP_VERSION, OPENCODE_ENV_AUTH, prepareOpenCodeNativeLaunch } from './OpenCodeNative';
import type {
  CliDiscoveryResult,
  AuthConfig,
  ProviderCapabilities
} from '../base/IProvider';
import type {
  Settings,
  StreamChunk,
  ProviderConfig,
  AuthStatus,
  ModelInfo
} from '../../types';
import { validateModelName } from '../../utils/validation';
import { normalizeToolName, toolKind } from '../../utils/toolNames';

/**
 * Per-panel session state for OpenCode, extending base with tool call tracking.
 */
export interface OpenCodeSessionState extends PanelSessionState {
  activeToolCalls: Map<string, { id: string; name: string; input: Record<string, unknown> }>;
  completedToolCalls: Set<string>;
  lastUsageStats: { input_tokens: number; output_tokens: number } | null;
}

/**
 * OpenCode CLI provider implementation
 * Uses supported API-key backends through an isolated OpenCode ACP runtime.
 */
export class OpenCodeProvider extends AcpNativeProvider {
  readonly id = 'opencode';
  readonly displayName = 'OpenCode';

  readonly config: ProviderConfig = {
    name: 'opencode',
    displayName: 'OpenCode',
    models: [
      {
        id: 'default',
        name: 'Configure provider/model',
        description: 'Set an explicit provider/model ID in Mysti’s OpenCode model setting',
        contextWindow: 200000
      }
    ],
    defaultModel: 'default'
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsThinking: true,
    supportsToolUse: true,
    supportsNativeApproval: true,
    supportsSessions: true,
    // ACP 1.18.29 consumes native image and embedded-context blocks.
    supportsImages: true,
    supportsAutoInstall: true,
    supportsPromptEnhancement: false,
    // Plan 02 Phase 1 capability matrix
    thinkingStyle: 'complete-blocks',
    thinkingLevelEffective: false,
    planMode: 'native',
    sessionKind: 'prompt-history',
    emitsToolResults: true,
    emitsUsage: true,
    usageConvention: 'none',   // ACP prompt response reports flat input/output.
    modelSelection: 'custom-only'  // provider/model free-form — no meaningful static dropdown
  };

  protected _createSession(panelId: string): OpenCodeSessionState {
    return {
      panelId,
      process: null,
      sessionId: null,
      autonomousMode: false,
      persistentProcess: null,
      persistentReady: false,
      lastHealthCheck: 0,
      suspended: false,
      activeToolCalls: new Map(),
      completedToolCalls: new Set(),
      lastUsageStats: null,
    };
  }

  async discoverCli(): Promise<CliDiscoveryResult> {
    return this._discoverCliCommon();
  }

  getCliPath(): string {
    return this._getCliPathCommon();
  }

  /** Saved native configuration is excluded from the approval-controlled
   * runtime. Explicit model IDs are validated by the isolated ACP session. */
  async discoverModels(_timeoutMs: number): Promise<ModelInfo[] | null> {
    return null;
  }

  protected _getCliCommandName(): string {
    return 'opencode';
  }

  protected _getConfiguredCliPath(): string {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<string>('opencodePath', 'opencode');
  }

  private _ocEnvKey(): string | undefined {
    return Object.values(OPENCODE_ENV_AUTH).flat().find(key => process.env[key]?.trim());
  }

  async getAuthConfig(): Promise<AuthConfig> {
    return { type: 'api-key', isAuthenticated: !!this._ocEnvKey() };
  }

  async checkAuthentication(): Promise<AuthStatus> {
    const envKey = this._ocEnvKey();
    return envKey ? { authenticated: true, user: envKey } : {
      authenticated: false,
      error: 'OpenCode native approvals use an isolated runtime. Set the selected provider API key (for example ANTHROPIC_API_KEY or OPENAI_API_KEY) in the extension environment and an explicit provider/model ID in Mysti. Native OpenCode login stores are not used.',
    };
  }

  getAuthCommand(): string {
    return 'echo Set your provider API key in the VS Code environment and restart VS Code. Select an explicit provider/model ID in Mysti.';
  }

  getInstallCommand(): string {
    return `npm i -g opencode-ai@${OPENCODE_ACP_VERSION}`;
  }

  protected buildCliArgs(_settings: Settings, _session: PanelSessionState): string[] {
    return ['acp', '--pure', '--hostname', '127.0.0.1', '--port', '0'];
  }

  protected async _prepareAcpLaunch(context: AcpNativeLaunchContext): Promise<AcpNativeLaunch> {
    return prepareOpenCodeNativeLaunch(context, this._getEffectiveModel(context.settings));
  }

  protected getThinkingTokens(_thinkingLevel: string): number | undefined {
    return undefined;
  }

  /**
   * Get the effective model, preferring provider-specific custom model over dropdown selection
   */
  protected _getEffectiveModel(settings: Readonly<Settings>): string | undefined {
    // P2.3/P0.2b: an explicitly routed model wins over the per-provider custom-model config.
    if (settings.routedModel) { return settings.routedModel; }
    const config = vscode.workspace.getConfiguration('mysti');
    const customModel = config.get<string>('opencodeModel', '');
    if (customModel) {
      const validation = validateModelName(customModel);
      if (validation.valid) {
        console.log(`[Mysti] OpenCode: Using custom model: ${customModel}`);
        return customModel;
      }
      console.warn(`[Mysti] OpenCode: Invalid custom model "${customModel}": ${validation.error}`);
    }

    // Don't pass 'default' — let CLI use its own default
    // Only pass explicit model IDs in provider/model format
    if (settings.model && settings.model !== 'default' && settings.model.includes('/')) {
      return settings.model;
    }
    return undefined;
  }

  /**
   * Parse OpenCode CLI NDJSON output format
   * Event types: step_start, text, step_finish, message.part.updated
   */
  protected parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    const ocSession = session as OpenCodeSessionState;
    try {
      const data = JSON.parse(line);

      // Extract sessionID from any event if available
      if (data.sessionID && !session.sessionId) {
        session.sessionId = data.sessionID;
        console.log('[Mysti] OpenCode: Session ID:', data.sessionID);
      }

      switch (data.type) {
        // Step start — emit session_active on first event
        case 'step_start':
          if (data.sessionID && !session.sessionId) {
            return { type: 'session_active', sessionId: data.sessionID };
          }
          return null;

        // Text content
        case 'text':
          if (data.part?.text) {
            return { type: 'text', content: data.part.text };
          }
          return null;

        // Incremental part updates (thinking, tool use, text deltas)
        case 'message.part.updated': {
          const part = data.part;
          if (!part) { return null; }

          switch (part.type) {
            case 'thinking':
            case 'reasoning':
              if (part.text) {
                return { type: 'thinking', content: part.text };
              }
              return null;

            case 'text':
              if (part.text) {
                return { type: 'text', content: part.text };
              }
              return null;

            case 'tool': {
              // Historical NDJSON parsing remains display-only. Public turns
              // execute through the blocking ACP permission transport.
              const toolName = normalizeToolName(part.name || '');
              const toolId = part.id || `tool-${Date.now()}`;
              const state = part.state || 'running';

              if (state === 'running' || state === 'pending') {
                ocSession.activeToolCalls.set(toolId, {
                  id: toolId,
                  name: toolName,
                  input: part.input || {}
                });
                return {
                  type: 'tool_use',
                  toolCall: {
                    id: toolId,
                    name: toolName,
                    input: part.input || {},
                    status: 'running',
                    kind: toolKind(toolName)
                  }
                };
              }

              if (state === 'completed' || state === 'done') {
                const toolInfo = ocSession.activeToolCalls.get(toolId);
                ocSession.activeToolCalls.delete(toolId);
                return {
                  type: 'tool_result',
                  toolCall: {
                    id: toolId,
                    name: toolInfo?.name || toolName,
                    input: toolInfo?.input || {},
                    output: part.output || part.result || '',
                    status: 'completed'
                  }
                };
              }

              if (state === 'error' || state === 'failed') {
                const toolInfo = ocSession.activeToolCalls.get(toolId);
                ocSession.activeToolCalls.delete(toolId);
                return {
                  type: 'tool_result',
                  toolCall: {
                    id: toolId,
                    name: toolInfo?.name || toolName,
                    input: toolInfo?.input || {},
                    output: part.error || 'Tool execution failed',
                    status: 'failed'
                  }
                };
              }

              return null;
            }

            default:
              return null;
          }
        }

        // Step finish — capture usage stats
        case 'step_finish':
          if (data.part?.tokens) {
            const tokens = data.part.tokens;
            ocSession.lastUsageStats = {
              input_tokens: tokens.input || 0,
              output_tokens: tokens.output || 0
            };
            console.log('[Mysti] OpenCode: Captured usage stats:', ocSession.lastUsageStats);
          }
          // Don't return done here - let sendMessage handle it
          return null;

        // Direct tool_use/tool_result events (alternative format)
        case 'tool_use': {
          const toolName = normalizeToolName(data.tool_name || data.name || '');
          const toolId = data.tool_id || data.id || `tool-${Date.now()}`;
          const params = data.parameters || data.input || {};

          ocSession.activeToolCalls.set(toolId, {
            id: toolId,
            name: toolName,
            input: params
          });
          return {
            type: 'tool_use',
            toolCall: {
              id: toolId,
              name: toolName,
              input: params,
              status: 'running',
              kind: toolKind(toolName)
            }
          };
        }

        case 'tool_result': {
          const toolId = data.tool_id || data.id || '';
          const toolInfo = ocSession.activeToolCalls.get(toolId);
          ocSession.activeToolCalls.delete(toolId);
          return {
            type: 'tool_result',
            toolCall: {
              id: toolId,
              name: toolInfo?.name || '',
              input: toolInfo?.input || {},
              output: data.output || data.result || '',
              status: data.status === 'success' || data.status === 'completed' ? 'completed' : 'failed'
            }
          };
        }

        case 'error': {
          const errMsg = data.message || data.error || data.part?.text || 'Unknown error';
          return {
            type: 'error',
            content: typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg)
          };
        }

        default:
          console.log('[Mysti] OpenCode: Unknown event type:', data.type);
          return null;
      }
    } catch {
      // If it's not JSON, only forward meaningful non-JSON output
      const trimmed = line.trim();
      if (trimmed && !this._isDiagnosticLine(trimmed)) {
        console.log('[Mysti] OpenCode: Non-JSON line:', line.substring(0, 200));
        return { type: 'text', content: line };
      }
    }

    return null;
  }

  /**
   * Check if a non-JSON line is CLI diagnostic noise that should be suppressed
   */
  private _isDiagnosticLine(line: string): boolean {
    return /^\[STARTUP\]/i.test(line)
      || /^Recording metric/i.test(line)
      || /^Loaded cached/i.test(line)
      || /^Checking for updates/i.test(line)
      || /^Using model/i.test(line)
      || /^\s*at\s+/.test(line);
  }

  /**
   * Get stored usage stats from the last message and clear them
   */
  getStoredUsage(panelId?: string): { input_tokens: number; output_tokens: number } | null {
    const session = this._getSession(panelId) as OpenCodeSessionState;
    const usage = session.lastUsageStats;
    session.lastUsageStats = null;
    return usage;
  }

  /**
   * Clear session and reset state
   */
  clearSession(panelId?: string): void {
    super.clearSession(panelId);
    if (panelId) {
      const session = this._panelSessions.get(panelId) as OpenCodeSessionState | undefined;
      if (session) {
        session.activeToolCalls.clear();
        session.completedToolCalls.clear();
        session.lastUsageStats = null;
      }
    }
  }
}
