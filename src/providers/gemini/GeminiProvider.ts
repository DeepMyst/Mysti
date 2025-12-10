/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://deepmyst.com
 *
 * This file is part of Mysti, licensed under the Business Source License 1.1.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: BUSL-1.1
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BaseCliProvider } from '../base/BaseCliProvider';
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

/**
 * Google Gemini CLI provider implementation
 * Supports Gemini 3 Pro, 2.5 Pro, 2.5 Flash, and 2.5 Flash-Lite models
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
        name: 'Gemini 3 Pro',
        description: 'Most intelligent, best for complex multimodal tasks',
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
        name: 'Gemini 2.5 Flash-Lite',
        description: 'Ultra fast, optimized for cost efficiency',
        contextWindow: 1048576
      }
    ],
    defaultModel: 'gemini-2.5-flash'
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsThinking: false, // Gemini doesn't expose thinking tokens like Claude
    supportsToolUse: true,
    supportsSessions: true
  };

  // Tool call state tracking
  private _activeToolCalls: Map<string, { id: string; name: string; input: Record<string, unknown> }> = new Map();

  // Usage stats from result event
  private _lastUsageStats: { input_tokens: number; output_tokens: number } | null = null;

  async discoverCli(): Promise<CliDiscoveryResult> {
    // First check configured path
    const configuredPath = this._getConfiguredPath();
    if (configuredPath !== 'gemini') {
      const found = await this._validateCliPath(configuredPath);
      if (found) {
        return { found: true, path: configuredPath };
      }
    }

    // Search common installation paths
    const searchPaths = [
      '/usr/local/bin/gemini',
      '/opt/homebrew/bin/gemini', // Apple Silicon
      path.join(os.homedir(), '.npm-global', 'bin', 'gemini'),
      path.join(os.homedir(), '.local', 'bin', 'gemini'),
      // npm global paths
      '/usr/bin/gemini',
      path.join(process.env.APPDATA || '', 'npm', 'gemini.cmd'), // Windows
    ];

    for (const searchPath of searchPaths) {
      if (await this._validateCliPath(searchPath)) {
        return { found: true, path: searchPath };
      }
    }

    // Fall back to checking if 'gemini' is in PATH
    const found = await this._validateCliPath('gemini');
    return {
      found,
      path: 'gemini',
      installCommand: 'npm install -g @google/gemini-cli'
    };
  }

  getCliPath(): string {
    return this._getConfiguredPath();
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

  protected buildCliArgs(settings: Settings, hasSession: boolean): string[] {
    // Note: Prompt is sent via stdin by BaseCliProvider
    // The -p flag appends to stdin, but having it without value may cause issues
    // So we omit it and just use stdin directly like Claude provider does
    const args: string[] = [
      '--output-format', 'stream-json'
    ];

    // Add model selection
    if (settings.model) {
      args.push('-m', settings.model);
    }

    // Map Mysti modes/access levels to Gemini CLI flags
    this._addPermissionFlags(args, settings);

    // Session handling - Gemini supports --resume for session continuation
    if (hasSession && this._currentSessionId) {
      args.push('--resume', this._currentSessionId);
      console.log('[Mysti] Gemini: Resuming session:', this._currentSessionId);
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
   * Parse Gemini CLI stream-json output format
   * Event types: init, message, tool_use, tool_result, error, result
   */
  protected parseStreamLine(line: string): StreamChunk | null {
    try {
      const data = JSON.parse(line);

      switch (data.type) {
        // Session initialization
        case 'init':
          if (data.session_id && !this._currentSessionId) {
            this._currentSessionId = data.session_id;
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
        case 'tool_use':
          // Track active tool call
          this._activeToolCalls.set(data.tool_id, {
            id: data.tool_id,
            name: data.tool_name,
            input: data.parameters || {}
          });
          return {
            type: 'tool_use',
            toolCall: {
              id: data.tool_id,
              name: data.tool_name,
              input: data.parameters || {},
              status: 'running'
            }
          };

        // Tool execution result
        case 'tool_result':
          const toolInfo = this._activeToolCalls.get(data.tool_id);
          this._activeToolCalls.delete(data.tool_id);
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

        // Error event
        case 'error':
          return {
            type: 'error',
            content: data.message || data.error || 'Unknown error'
          };

        // Final result with stats
        case 'result':
          if (data.stats) {
            this._lastUsageStats = {
              input_tokens: data.stats.input_tokens || data.stats.total_tokens || 0,
              output_tokens: data.stats.output_tokens || 0
            };
            console.log('[Mysti] Gemini: Captured usage stats:', this._lastUsageStats);
          }
          // Don't return done here - let sendMessage handle it
          return null;

        default:
          console.log('[Mysti] Gemini: Unknown event type:', data.type, JSON.stringify(data));
          return null;
      }
    } catch {
      // If it's not JSON, treat as plain text
      if (line.trim()) {
        console.log('[Mysti] Gemini: Non-JSON line:', line.substring(0, 200));
        return { type: 'text', content: line };
      }
    }

    return null;
  }

  /**
   * Get stored usage stats from the last message and clear them
   */
  getStoredUsage(): { input_tokens: number; output_tokens: number } | null {
    const usage = this._lastUsageStats;
    this._lastUsageStats = null;
    return usage;
  }

  /**
   * Clear session and reset state
   */
  clearSession(): void {
    super.clearSession();
    this._activeToolCalls.clear();
    this._lastUsageStats = null;
  }

  // Private helper methods

  private _getConfiguredPath(): string {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<string>('geminiPath', 'gemini');
  }

  private async _validateCliPath(cliPath: string): Promise<boolean> {
    try {
      // Check if the path exists and is executable
      if (cliPath.includes(path.sep)) {
        fs.accessSync(cliPath, fs.constants.X_OK);
        return true;
      }

      // For bare command names, try to execute with --version
      const { execSync } = await import('child_process');
      execSync(`${cliPath} --version`, { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}
