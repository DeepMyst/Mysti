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
 * Per-panel session state for Gemini, extending base with tool call tracking.
 */
export interface GeminiSessionState extends PanelSessionState {
  activeToolCalls: Map<string, { id: string; name: string; input: Record<string, unknown> }>;
  lastUsageStats: { input_tokens: number; output_tokens: number } | null;
}

/**
 * Google Gemini CLI provider implementation
 * Supports Gemini 3 Pro, 3 Flash, 2.5 Pro, and 2.5 Flash models
 */
export class GeminiProvider extends BaseCliProvider {
  readonly id = 'google-gemini';
  readonly displayName = 'Gemini';

  readonly config: ProviderConfig = {
    name: 'google-gemini',
    displayName: 'Gemini',
    models: [
      {
        id: 'gemini-3-pro-preview',
        name: 'Gemini 3 Pro (Preview)',
        description: 'Most intelligent, best for complex multimodal tasks',
        contextWindow: 1048576
      },
      {
        id: 'gemini-3-flash-preview',
        name: 'Gemini 3 Flash (Preview)',
        description: 'Fast multimodal understanding with strong reasoning',
        contextWindow: 1048576
      },
      {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        description: 'Advanced reasoning for code, math, and STEM',
        contextWindow: 1048576
      },
      {
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        description: 'Best price-performance balance',
        contextWindow: 1048576
      },
      {
        id: 'gemini-2.5-flash-lite',
        name: 'Gemini 2.5 Flash Lite',
        description: 'Lightweight and cost-efficient for simple tasks',
        contextWindow: 1048576
      }
    ],
    defaultModel: 'gemini-2.5-flash'
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsThinking: false, // Gemini doesn't expose thinking tokens like Claude
    supportsToolUse: true,
    supportsSessions: true,
    supportsImages: false,
    supportsAutoInstall: true
  };

  protected _createSession(panelId: string): GeminiSessionState {
    return {
      panelId,
      process: null,
      sessionId: null,
      autonomousMode: false,
      persistentProcess: null,
      persistentReady: false,
      lastHealthCheck: 0,
      activeToolCalls: new Map(),
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
    return 'gemini';
  }

  protected _getConfiguredCliPath(): string {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<string>('geminiPath', 'gemini');
  }

  async getAuthConfig(): Promise<AuthConfig> {
    // Check for API key in environment
    const hasApiKey = !!process.env.GEMINI_API_KEY;

    // Check for settings file
    const settingsPath = path.join(os.homedir(), '.gemini', 'settings.json');
    const hasSettings = fs.existsSync(settingsPath);

    return {
      type: hasApiKey ? 'api-key' : 'oauth',
      isAuthenticated: hasApiKey || hasSettings,
      configPath: settingsPath
    };
  }

  async checkAuthentication(): Promise<AuthStatus> {
    // Check for GEMINI_API_KEY environment variable
    if (process.env.GEMINI_API_KEY) {
      return {
        authenticated: true,
        user: 'API Key'
      };
    }

    // Check for settings file with auth config
    const settingsPath = path.join(os.homedir(), '.gemini', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        const content = fs.readFileSync(settingsPath, 'utf-8');
        const settings = JSON.parse(content);

        // Check for auth configuration
        if (settings.auth || settings.security?.auth) {
          return {
            authenticated: true,
            user: settings.auth?.email || 'Google Account'
          };
        }
      } catch {
        // Settings file exists but couldn't parse
      }
    }

    return {
      authenticated: false,
      error: 'Not authenticated. Please run "gemini" and sign in with your Google account, or set the GEMINI_API_KEY environment variable.'
    };
  }

  getAuthCommand(): string {
    return 'gemini';
  }

  getInstallCommand(): string {
    return 'npm install -g @google/gemini-cli';
  }

  protected buildCliArgs(settings: Settings, session: PanelSessionState): string[] {
    // Note: Prompt is sent via stdin by BaseCliProvider
    // The -p flag appends to stdin, but having it without value may cause issues
    // So we omit it and just use stdin directly like Claude provider does
    const args: string[] = [
      '--output-format', 'stream-json'
    ];

    // Add model selection (custom model override or dropdown selection)
    const effectiveModel = this._getEffectiveModel(settings);
    if (effectiveModel) {
      args.push('-m', effectiveModel);
    }

    // Map Mysti modes/access levels to Gemini CLI flags
    this._addPermissionFlags(args, settings);

    // Session handling - Gemini supports --resume for session continuation
    if (session.sessionId) {
      args.push('--resume', session.sessionId);
      console.log('[Mysti] Gemini: Resuming session:', session.sessionId);
    }

    console.log('[Mysti] Gemini: Built CLI args:', args.join(' '));
    return args;
  }

  /**
   * Gemini doesn't support thinking tokens like Claude
   * Returns undefined to indicate no thinking token support
   */
  protected getThinkingTokens(_thinkingLevel: string): number | undefined {
    return undefined;
  }

  /**
   * Add permission flags based on mode and access level
   * Maps Mysti settings to Gemini CLI sandbox/yolo modes
   */
  private _addPermissionFlags(args: string[], settings: Settings): void {
    const { mode, accessLevel } = settings;

    // Plan modes and read-only = sandbox mode
    if (mode === 'quick-plan' || mode === 'detailed-plan' || accessLevel === 'read-only') {
      args.push('--sandbox');
      console.log('[Mysti] Gemini: Using sandbox mode (read-only)');
      return;
    }

    // Full access or edit-automatically = yolo mode (auto-approve all)
    if (accessLevel === 'full-access' || mode === 'edit-automatically') {
      args.push('--yolo');
      console.log('[Mysti] Gemini: Using yolo mode (auto-approve all)');
      return;
    }

    // Default: no special flags, CLI will prompt for permissions
    console.log('[Mysti] Gemini: Using default mode');
  }

  /**
   * Get the effective model, preferring provider-specific custom model over dropdown selection
   */
  private _getEffectiveModel(settings: Settings): string | undefined {
    const config = vscode.workspace.getConfiguration('mysti');
    const customModel = config.get<string>('geminiModel', '');
    if (customModel) {
      const validation = validateModelName(customModel);
      if (validation.valid) {
        console.log(`[Mysti] Gemini: Using custom model: ${customModel}`);
        return customModel;
      }
      console.warn(`[Mysti] Gemini: Invalid custom model "${customModel}": ${validation.error}`);
    }

    // Only pass settings.model if it's actually a Gemini model —
    // the global defaultModel may belong to another provider (e.g. claude-sonnet-*)
    if (settings.model) {
      const isKnownGeminiModel = this.config.models.some(m => m.id === settings.model);
      if (isKnownGeminiModel) {
        return settings.model;
      }
      console.log(`[Mysti] Gemini: Ignoring non-Gemini model "${settings.model}", using CLI default`);
    }
    return undefined;
  }

  /**
   * Parse Gemini CLI stream-json output format
   * Event types: init, message, tool_use, tool_result, error, result
   */
  protected parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    const geminiSession = session as GeminiSessionState;
    try {
      const data = JSON.parse(line);

      switch (data.type) {
        // Session initialization
        case 'init':
          if (data.session_id && !session.sessionId) {
            session.sessionId = data.session_id;
            console.log('[Mysti] Gemini: Session ID:', data.session_id);
            return { type: 'session_active', sessionId: data.session_id };
          }
          return null;

        // Streaming message content
        case 'message':
          if (data.role === 'assistant' && data.content) {
            return { type: 'text', content: data.content };
          }
          return null;

        // Tool invocation start
        case 'tool_use': {
          const toolName = data.tool_name || '';
          const params = data.parameters || {};

          // Detect ask_user-style tools and emit as ask_user_question chunk
          // Gemini CLI may use 'ask_user' or similar tool names for interactive questions
          if ((toolName === 'ask_user' || toolName === 'AskUserQuestion' || toolName === 'ask_user_question') &&
              params.questions && Array.isArray(params.questions)) {
            console.log('[Mysti] Gemini: Detected ask_user tool, converting to ask_user_question chunk');
            return {
              type: 'ask_user_question',
              askUserQuestion: {
                toolCallId: data.tool_id,
                questions: params.questions.map((q: Record<string, unknown>) => ({
                  question: String(q.question || ''),
                  header: String(q.header || '').substring(0, 12), // Enforce 12-char limit to prevent validation loops
                  options: Array.isArray(q.options) ? q.options.map((o: Record<string, unknown>) => ({
                    label: String(o.label || ''),
                    description: String(o.description || '')
                  })) : [],
                  multiSelect: Boolean(q.multiSelect || false)
                }))
              }
            };
          }

          // Track active tool call
          geminiSession.activeToolCalls.set(data.tool_id, {
            id: data.tool_id,
            name: toolName,
            input: params
          });
          return {
            type: 'tool_use',
            toolCall: {
              id: data.tool_id,
              name: toolName,
              input: params,
              status: 'running'
            }
          };
        }

        // Tool execution result
        case 'tool_result': {
          const toolInfo = geminiSession.activeToolCalls.get(data.tool_id);
          geminiSession.activeToolCalls.delete(data.tool_id);
          return {
            type: 'tool_result',
            toolCall: {
              id: data.tool_id,
              name: toolInfo?.name || '',
              input: toolInfo?.input || {},
              output: data.output || '',
              status: data.status === 'success' ? 'completed' : 'failed'
            }
          };
        }

        // Error event
        case 'error':
          return {
            type: 'error',
            content: data.message || data.error || 'Unknown error'
          };

        // Final result with stats
        case 'result':
          if (data.stats) {
            geminiSession.lastUsageStats = {
              input_tokens: data.stats.input_tokens || data.stats.total_tokens || 0,
              output_tokens: data.stats.output_tokens || 0
            };
            console.log('[Mysti] Gemini: Captured usage stats:', geminiSession.lastUsageStats);
          }
          // Don't return done here - let sendMessage handle it
          return null;

        default:
          console.log('[Mysti] Gemini: Unknown event type:', data.type, JSON.stringify(data));
          return null;
      }
    } catch {
      // If it's not JSON, only forward genuinely meaningful non-JSON output
      const trimmed = line.trim();
      if (trimmed && !this._isDiagnosticLine(trimmed)) {
        console.log('[Mysti] Gemini: Non-JSON line:', line.substring(0, 200));
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
      || /^Loaded cached credentials/i.test(line)
      || /^Full report available at:/i.test(line)
      || /^StartupProfiler/i.test(line)
      || /^Hook registry initialized/i.test(line)
      || /^\s*at\s+/.test(line);
  }

  /**
   * Get stored usage stats from the last message and clear them
   */
  getStoredUsage(panelId?: string): { input_tokens: number; output_tokens: number } | null {
    const session = this._getSession(panelId) as GeminiSessionState;
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
      const session = this._panelSessions.get(panelId) as GeminiSessionState | undefined;
      if (session) {
        session.activeToolCalls.clear();
        session.lastUsageStats = null;
      }
    }
  }

}
