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
  AuthStatus,
  ModelInfo
} from '../../types';
import { validateModelName } from '../../utils/validation';
import { normalizeToolName, toolKind } from '../../utils/toolNames';

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
    // Curated fallback list (bundled). Live discovery (discoverModels) refreshes
    // this from the Google Generative Language Models API when a GEMINI_API_KEY /
    // GOOGLE_API_KEY is present. Verified 2026-06.
    models: [
      {
        id: 'gemini-3.1-pro-preview',
        name: 'Gemini 3.1 Pro (Preview)',
        description: 'Most intelligent, best for complex agentic and coding tasks',
        contextWindow: 1048576
      },
      {
        id: 'gemini-3.5-flash',
        name: 'Gemini 3.5 Flash',
        description: 'Fast and capable — strong on coding and agentic workflows',
        contextWindow: 1048576
      },
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
    supportsAutoInstall: true,
    // Plan 02 Phase 1 capability matrix
    thinkingStyle: 'none',
    thinkingLevelEffective: false,
    planMode: 'detected',
    sessionKind: 'cli-resume',
    emitsToolResults: true,
    emitsUsage: true,
    modelSelection: 'full'
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
      suspended: false,
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

    // Plan modes or read-only → sandbox mode
    if (mode === 'quick-plan' || mode === 'detailed-plan' || accessLevel === 'read-only') {
      args.push('--sandbox');
      console.log('[Mysti] Gemini: Using sandbox mode (read-only)');
      return;
    }

    // More-restrictive-wins: only auto-approve when BOTH mode and access allow it
    if (mode === 'edit-automatically' && accessLevel === 'full-access') {
      args.push('--yolo');
      console.log('[Mysti] Gemini: Using yolo mode (edit-automatically + full-access)');
      return;
    }

    // default mode + full-access = yolo (no explicit edit restriction)
    if (mode === 'default' && accessLevel === 'full-access') {
      args.push('--yolo');
      console.log('[Mysti] Gemini: Using yolo mode (default + full-access)');
      return;
    }

    // All other combinations: bypass CLI permissions to prevent stdin hang.
    // The stream-level tool-use gate in ChatViewProvider handles permission prompts.
    args.push('--yolo');
    console.log(`[Mysti] Gemini: Bypassing CLI permissions (stream gate handles UI prompts) [mode=${mode}, access=${accessLevel}]`);
  }

  /**
   * Get the effective model, preferring provider-specific custom model over dropdown selection
   */
  protected _getEffectiveModel(settings: Settings): string | undefined {
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

    // Only pass settings.model if it's actually a Gemini model — the global
    // defaultModel may belong to another provider (cross-provider guard).
    // Genuine custom Gemini models go through the `geminiModel` setting above
    // (now unblocked by the relaxed validation pattern — #39); full pass-through
    // of arbitrary dropdown models is deferred to pair with per-provider model
    // memory (Plan 02 Phase 6, #33) to avoid a leaked model reaching the CLI.
    if (settings.model) {
      const isKnownGeminiModel = this.config.models.some(m => m.id === settings.model);
      if (isKnownGeminiModel) {
        return settings.model;
      }
      console.warn(`[Mysti] Gemini: Ignoring non-Gemini model "${settings.model}" (use the geminiModel setting for a custom Gemini model); using CLI default`);
    }
    return undefined;
  }

  /**
   * Live model discovery (Plan 01 Phase 3) via the official Google Generative
   * Language Models API. Only fires when a GEMINI_API_KEY / GOOGLE_API_KEY is
   * present (the Gemini CLI may instead use Google-account OAuth, in which case
   * there is no usable list endpoint and the curated list serves). Filters to
   * models that support generateContent and strips the "models/" id prefix the
   * API uses (the CLI's --model flag takes the short id). Returns null on any
   * failure so the registry keeps its curated/cached list. Never throws.
   */
  async discoverModels(timeoutMs: number): Promise<ModelInfo[] | null> {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) { return null; }
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(apiKey)}`,
        { signal: AbortSignal.timeout(timeoutMs) },
      );
      if (!response.ok) { return null; }
      const data = await response.json() as {
        models?: Array<{
          name?: string;
          displayName?: string;
          inputTokenLimit?: number;
          supportedGenerationMethods?: string[];
        }>;
      };
      const models = (data.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map<ModelInfo>(m => ({
          id: (m.name || '').replace(/^models\//, '').trim(),
          name: m.displayName || (m.name || '').replace(/^models\//, ''),
          contextWindow: typeof m.inputTokenLimit === 'number' ? m.inputTokenLimit : undefined,
        }))
        .filter(m => m.id.length > 0);
      return models.length > 0 ? models : null;
    } catch {
      return null;
    }
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

          // Normalize native Gemini tool names (write_file, replace,
          // run_shell_command, ...) to the canonical names used by the
          // permission gate and the webview renderer. The stream-level gate
          // is the sole enforcement point (the CLI runs with --yolo), so raw
          // names that the classifier doesn't recognize would otherwise be
          // gated as unknown instead of classified correctly.
          const canonicalName = normalizeToolName(toolName);

          // Track active tool call
          geminiSession.activeToolCalls.set(data.tool_id, {
            id: data.tool_id,
            name: canonicalName,
            input: params
          });
          return {
            type: 'tool_use',
            toolCall: {
              id: data.tool_id,
              name: canonicalName,
              input: params,
              status: 'running',
              kind: toolKind(canonicalName)
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
