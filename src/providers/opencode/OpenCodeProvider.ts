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
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BaseCliProvider, type PanelSessionState } from '../base/BaseCliProvider';
import type {
  CliDiscoveryResult,
  AuthConfig,
  ProviderCapabilities
} from '../base/IProvider';
import type {
  Settings,
  StreamChunk,
  ProviderConfig,
  AuthStatus
} from '../../types';
import { validateModelName } from '../../utils/validation';

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
 * Supports multiple LLM backends via OpenCode's unified interface
 * (OpenAI, Anthropic, Gemini, Groq, AWS Bedrock, Azure OpenAI, OpenRouter)
 */
export class OpenCodeProvider extends BaseCliProvider {
  readonly id = 'opencode';
  readonly displayName = 'OpenCode';

  readonly config: ProviderConfig = {
    name: 'opencode',
    displayName: 'OpenCode',
    models: [
      {
        id: 'default',
        name: 'Default Model',
        description: 'Uses your OpenCode configured default model',
        contextWindow: 200000
      }
    ],
    defaultModel: 'default'
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsThinking: true,
    supportsToolUse: true,
    supportsSessions: true,
    supportsImages: false,
    supportsAutoInstall: true
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

  protected _getCliCommandName(): string {
    return 'opencode';
  }

  protected _getConfiguredCliPath(): string {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<string>('opencodePath', 'opencode');
  }

  async getAuthConfig(): Promise<AuthConfig> {
    // OpenCode supports multiple provider API keys
    const hasAnyApiKey = !!(
      process.env.ANTHROPIC_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.GROQ_API_KEY
    );

    // Check for OpenCode auth config
    const authPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
    const hasAuth = fs.existsSync(authPath);

    // Check for global config
    const configPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
    const hasConfig = fs.existsSync(configPath);

    return {
      type: hasAnyApiKey ? 'api-key' : 'oauth',
      isAuthenticated: hasAnyApiKey || hasAuth || hasConfig,
      configPath: hasAuth ? authPath : configPath
    };
  }

  async checkAuthentication(): Promise<AuthStatus> {
    // Check for any provider API key
    if (process.env.ANTHROPIC_API_KEY) {
      return { authenticated: true, user: 'Anthropic API Key' };
    }
    if (process.env.OPENAI_API_KEY) {
      return { authenticated: true, user: 'OpenAI API Key' };
    }
    if (process.env.GEMINI_API_KEY) {
      return { authenticated: true, user: 'Gemini API Key' };
    }
    if (process.env.GROQ_API_KEY) {
      return { authenticated: true, user: 'Groq API Key' };
    }

    // Check for OpenCode auth file
    const authPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
    if (fs.existsSync(authPath)) {
      return { authenticated: true, user: 'OpenCode Account' };
    }

    // Check for global config with provider settings
    const configPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(content);
        if (config.provider || config.model) {
          return { authenticated: true, user: 'OpenCode Config' };
        }
      } catch {
        // Config exists but couldn't parse
      }
    }

    return {
      authenticated: false,
      error: 'Not authenticated. Run "opencode auth login" or set a provider API key (e.g., ANTHROPIC_API_KEY, OPENAI_API_KEY).'
    };
  }

  getAuthCommand(): string {
    return 'opencode auth login';
  }

  getInstallCommand(): string {
    return 'npm i -g opencode-ai@latest';
  }

  protected buildCliArgs(settings: Settings, session: PanelSessionState): string[] {
    // OpenCode uses: opencode run --format json [--model <model>] [--session <id>] [--agent <agent>]
    // Prompt is sent via stdin
    const args: string[] = [
      'run',
      '--format', 'json',
      '--thinking'
    ];

    // Add model selection
    const effectiveModel = this._getEffectiveModel(settings);
    if (effectiveModel) {
      args.push('-m', effectiveModel);
    }

    // Map Mysti modes to OpenCode agents
    this._addModeFlags(args, settings);

    // Session resume
    if (session.sessionId) {
      args.push('--session', session.sessionId);
      console.log('[Mysti] OpenCode: Resuming session:', session.sessionId);
    }

    console.log('[Mysti] OpenCode: Built CLI args:', args.join(' '));
    return args;
  }

  protected getThinkingTokens(_thinkingLevel: string): number | undefined {
    // OpenCode handles thinking internally based on model capabilities
    return undefined;
  }

  /**
   * Map Mysti operation modes to OpenCode agent modes
   */
  private _addModeFlags(args: string[], settings: Settings): void {
    const { mode, accessLevel } = settings;

    // Plan modes or read-only → use plan agent (read-only analysis)
    if (mode === 'quick-plan' || mode === 'detailed-plan' || accessLevel === 'read-only') {
      args.push('--agent', 'plan');
      console.log('[Mysti] OpenCode: Using plan agent (read-only)');
      return;
    }

    // Default: use build agent (full access)
    args.push('--agent', 'build');
    console.log(`[Mysti] OpenCode: Using build agent [mode=${mode}, access=${accessLevel}]`);
  }

  /**
   * Get the effective model, preferring provider-specific custom model over dropdown selection
   */
  private _getEffectiveModel(settings: Settings): string | undefined {
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
              const toolName = part.name || '';
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
                    status: 'running'
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
          const toolName = data.tool_name || data.name || '';
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
              status: 'running'
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
