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
 * Claude Code CLI provider implementation
 */
export class ClaudeCodeProvider extends BaseCliProvider {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';

  readonly config: ProviderConfig = {
    name: 'claude-code',
    displayName: 'Claude Code',
    models: [
      {
        id: 'claude-sonnet-4-5-20250929',
        name: 'Claude Sonnet 4.5',
        description: 'Most capable model, best for complex tasks',
        contextWindow: 200000
      },
      {
        id: 'claude-opus-4-5-20251101',
        name: 'Claude Opus 4.5',
        description: 'Advanced reasoning and analysis',
        contextWindow: 200000
      },
      {
        id: 'claude-haiku-4-5-20251015',
        name: 'Claude Haiku 4.5',
        description: 'Fast and efficient for simpler tasks',
        contextWindow: 200000
      }
    ],
    defaultModel: 'claude-sonnet-4-5-20250929'
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsThinking: true,
    supportsToolUse: true,
    supportsSessions: true
  };

  // Tool call state tracking (Claude-specific)
  private _activeToolCalls: Map<number, { id: string; name: string; inputJson: string }> = new Map();

  // Usage stats from message_delta (message_stop doesn't include usage)
  private _lastUsageStats: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | null = null;

  async discoverCli(): Promise<CliDiscoveryResult> {
    const paths = this._getSearchPaths();

    for (const searchPath of paths) {
      if (await this._validateCliPath(searchPath)) {
        console.log(`[Mysti] Claude: Found CLI at: ${searchPath}`);
        return { found: true, path: searchPath };
      }
    }

    // Final fallback: check if 'claude' is in PATH via which/where
    if (await this._checkCommandExists('claude')) {
      console.log('[Mysti] Claude: Found CLI via PATH');
      return { found: true, path: 'claude' };
    }

    return {
      found: false,
      path: 'claude',
      installCommand: 'Install the Claude Code VSCode extension or run: npm install -g @anthropic-ai/claude-code'
    };
  }

  getCliPath(): string {
    // First check if user has configured a custom path
    const config = vscode.workspace.getConfiguration('mysti');
    const configuredPath = config.get<string>('claudeCodePath', 'claude');

    // If user specified a non-default path, use it
    if (configuredPath !== 'claude') {
      return configuredPath;
    }

    // Otherwise, search known installation paths
    const paths = this._getSearchPaths();
    for (const searchPath of paths) {
      try {
        // Only check absolute paths with fs.accessSync
        if (searchPath.includes(path.sep) || searchPath.startsWith('/')) {
          fs.accessSync(searchPath, fs.constants.X_OK);
          console.log(`[Mysti] Claude: Using CLI at: ${searchPath}`);
          return searchPath;
        }
      } catch {
        // Continue to next path
      }
    }

    // Fallback to default (will rely on PATH)
    return configuredPath;
  }

  async getAuthConfig(): Promise<AuthConfig> {
    const configPath = path.join(os.homedir(), '.claude', 'config.json');
    return {
      type: 'cli-login',
      isAuthenticated: fs.existsSync(configPath),
      configPath
    };
  }

  async checkAuthentication(): Promise<AuthStatus> {
    const auth = await this.getAuthConfig();
    if (!auth.isAuthenticated) {
      return {
        authenticated: false,
        error: 'Not authenticated. Please run "claude auth login" to sign in.'
      };
    }

    // Try to get user info from config
    try {
      if (auth.configPath && fs.existsSync(auth.configPath)) {
        const configContent = fs.readFileSync(auth.configPath, 'utf-8');
        const config = JSON.parse(configContent);
        return {
          authenticated: true,
          user: config.email || config.user || 'Authenticated'
        };
      }
    } catch {
      // Config exists but couldn't parse - still authenticated
    }

    return { authenticated: true };
  }

  getAuthCommand(): string {
    return 'claude auth login';
  }

  getInstallCommand(): string {
    return 'npm install -g @anthropic-ai/claude-code';
  }

  protected buildCliArgs(settings: Settings, hasSession: boolean): string[] {
    const args: string[] = [
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
    ];

    // Map Mysti modes/access levels to Claude Code permission flags
    // This ensures proper enforcement at the CLI level
    this._addPermissionFlags(args, settings);

    // Session handling
    if (hasSession && this._currentSessionId) {
      args.push('--resume', this._currentSessionId);
      console.log('[Mysti] Claude: Resuming session:', this._currentSessionId);
    } else {
      args.push('--print');
      console.log('[Mysti] Claude: Starting new session');
    }

    // Add model selection
    if (settings.model) {
      args.push('--model', settings.model);
    }

    return args;
  }

  /**
   * Get thinking tokens based on thinking level
   */
  protected getThinkingTokens(thinkingLevel: string): number | undefined {
    const tokenMap: Record<string, number> = {
      'none': 0,
      'low': 4000,
      'medium': 8000,
      'high': 16000
    };
    return tokenMap[thinkingLevel];
  }

  /**
   * Add permission flags based on mode and access level
   * Maps Mysti settings to Claude Code CLI permission modes
   */
  private _addPermissionFlags(args: string[], settings: Settings): void {
    const { mode, accessLevel } = settings;

    // Quick Plan - read-only, Mysti adds quick plan instruction via prompt
    if (mode === 'quick-plan') {
      args.push('--permission-mode', 'plan');
      console.log('[Mysti] Claude: Using quick plan mode (read-only)');
      return;
    }

    // Detailed Plan - read-only, uses CLI's native multi-plan behavior
    if (mode === 'detailed-plan') {
      args.push('--permission-mode', 'plan');
      console.log('[Mysti] Claude: Using detailed plan mode (read-only)');
      return;
    }

    // Read-only access level enforces plan mode regardless of operation mode
    if (accessLevel === 'read-only') {
      args.push('--permission-mode', 'plan');
      console.log('[Mysti] Claude: Using plan mode (read-only access level)');
      return;
    }

    // edit-automatically + full-access = bypass all permissions
    if (mode === 'edit-automatically' && accessLevel === 'full-access') {
      args.push('--dangerously-skip-permissions');
      args.push('--permission-mode', 'bypassPermissions');
      console.log('[Mysti] Claude: Bypassing all permissions (edit-automatically + full-access)');
      return;
    }

    // edit-automatically + ask-permission = bypass permissions (auto-approve)
    if (mode === 'edit-automatically' && accessLevel === 'ask-permission') {
      args.push('--permission-mode', 'bypassPermissions');
      console.log('[Mysti] Claude: Using bypass mode (edit-automatically + ask-permission)');
      return;
    }

    // ask-before-edit + full-access = bypass permissions
    if (mode === 'ask-before-edit' && accessLevel === 'full-access') {
      args.push('--permission-mode', 'bypassPermissions');
      console.log('[Mysti] Claude: Using bypass mode (ask-before-edit + full-access)');
      return;
    }

    // ask-before-edit + ask-permission = default mode (CLI prompts for permissions)
    if (mode === 'ask-before-edit' && accessLevel === 'ask-permission') {
      args.push('--permission-mode', 'default');
      console.log('[Mysti] Claude: Using default mode (CLI will prompt for permissions)');
      return;
    }

    // Default mode or fallback - normal operation
    args.push('--permission-mode', 'default');
    console.log('[Mysti] Claude: Using default mode');
  }

  protected parseStreamLine(line: string): StreamChunk | null {
    try {
      const data = JSON.parse(line);

      // Handle stream_event wrapper
      if (data.type === 'stream_event') {
        const nestedEvent = data.event || {};
        const nestedType = nestedEvent.type || '';
        const blockIndex = nestedEvent.index ?? -1;

        // Handle content_block_delta - the main streaming content
        if (nestedType === 'content_block_delta') {
          const delta = nestedEvent.delta || {};
          if (delta.type === 'text_delta') {
            return { type: 'text', content: delta.text || '' };
          }
          if (delta.type === 'thinking_delta') {
            return { type: 'thinking', content: delta.thinking || '' };
          }
          if (delta.type === 'input_json_delta') {
            // Accumulate tool input JSON
            const activeTool = this._activeToolCalls.get(blockIndex);
            if (activeTool) {
              activeTool.inputJson += delta.partial_json || '';
            }
            return null;
          }
        }

        // Handle content_block_start - beginning of a content block
        if (nestedType === 'content_block_start') {
          const contentBlock = nestedEvent.content_block || {};
          if (contentBlock.type === 'tool_use') {
            // Store tool call info for accumulation
            this._activeToolCalls.set(blockIndex, {
              id: contentBlock.id || '',
              name: contentBlock.name || '',
              inputJson: ''
            });
            // For AskUserQuestion, don't emit immediate tool_use - wait for full input
            if (contentBlock.name === 'AskUserQuestion') {
              console.log('[Mysti] Claude: AskUserQuestion tool started, waiting for input');
              return null;
            }
            // Return tool_use immediately with running status for other tools
            return {
              type: 'tool_use',
              toolCall: {
                id: contentBlock.id || '',
                name: contentBlock.name || '',
                input: {},
                status: 'running'
              }
            };
          }
          if (contentBlock.type === 'thinking') {
            return { type: 'thinking', content: '' };
          }
        }

        // Handle content_block_stop - end of a content block
        if (nestedType === 'content_block_stop') {
          const completedTool = this._activeToolCalls.get(blockIndex);
          if (completedTool) {
            this._activeToolCalls.delete(blockIndex);
            // Parse the accumulated JSON
            let parsedInput: Record<string, unknown> = {};
            try {
              if (completedTool.inputJson) {
                parsedInput = JSON.parse(completedTool.inputJson);
              }
            } catch {
              console.log('[Mysti] Claude: Failed to parse tool input JSON:', completedTool.inputJson);
            }

            // Check if this is AskUserQuestion tool - emit special chunk type
            if (completedTool.name === 'AskUserQuestion' && parsedInput.questions) {
              console.log('[Mysti] Claude: AskUserQuestion completed with', (parsedInput.questions as unknown[]).length, 'questions');
              return {
                type: 'ask_user_question',
                askUserQuestion: {
                  toolCallId: completedTool.id,
                  questions: parsedInput.questions as import('../../types').AskUserQuestionItem[]
                }
              };
            }

            // Check if this is ExitPlanMode tool - emit special chunk type with plan path
            if (completedTool.name === 'ExitPlanMode') {
              // Extract plan file path from input, ensuring it's a string or null
              const rawPath = parsedInput.plan_file_path || parsedInput.planFilePath;
              const planFilePath: string | null = typeof rawPath === 'string' ? rawPath : null;
              console.log('[Mysti] Claude: ExitPlanMode tool called, plan file:', planFilePath);
              return {
                type: 'exit_plan_mode',
                planFilePath
              };
            }

            return {
              type: 'tool_use',
              toolCall: {
                id: completedTool.id,
                name: completedTool.name,
                input: parsedInput,
                status: 'running'
              }
            };
          }
          return null;
        }

        // Handle message lifecycle events
        if (nestedType === 'message_start') {
          return null;
        }

        // Handle message_delta - capture usage stats (usage is in delta, not stop)
        if (nestedType === 'message_delta') {
          const usage = nestedEvent.usage;
          if (usage) {
            this._lastUsageStats = {
              input_tokens: usage.input_tokens || 0,
              output_tokens: usage.output_tokens || 0,
              cache_creation_input_tokens: usage.cache_creation_input_tokens,
              cache_read_input_tokens: usage.cache_read_input_tokens
            };
            console.log('[Mysti] Claude: Captured usage from message_delta:', this._lastUsageStats);
          }
          return null;
        }

        // Handle message_stop - signal end of message
        // Usage is already cached from message_delta, will be retrieved by getStoredUsage()
        if (nestedType === 'message_stop') {
          return null; // Don't return done here - let sendMessage handle it
        }

        return null;
      }

      // Handle direct result event (final message)
      // This contains the complete response which was already streamed via text_delta chunks
      // We should NOT emit this as text, or it will duplicate the content
      if (data.type === 'result') {
        // Check for permission denials - CLI auto-denied operations in non-interactive mode
        if (data.permission_denials && data.permission_denials.length > 0) {
          console.log('[Mysti] Claude: Permission denials detected:', data.permission_denials.length);
          return {
            type: 'permission_denied',
            permissionDenials: data.permission_denials.map((denial: { tool_name: string; tool_use_id: string; tool_input: Record<string, unknown> }) => ({
              toolName: denial.tool_name,
              toolUseId: denial.tool_use_id,
              toolInput: denial.tool_input
            }))
          };
        }
        // Just ignore - content was already streamed
        return null;
      }

      // Handle system events (session init, etc.)
      if (data.type === 'system') {
        if (data.subtype === 'init') {
          const sessionId = data.session_id || data.sessionId;
          if (sessionId && !this._currentSessionId) {
            this._currentSessionId = sessionId;
            console.log('[Mysti] Claude: Session ID extracted:', sessionId);
            return { type: 'session_active', sessionId };
          }
        }
        return null;
      }

      // Handle assistant complete message - extract tool results
      if (data.type === 'assistant') {
        if (data.message?.content) {
          for (const block of data.message.content) {
            if (block.type === 'tool_use') {
              return {
                type: 'tool_use',
                toolCall: {
                  id: block.id || '',
                  name: block.name || '',
                  input: block.input || {},
                  status: 'running'
                }
              };
            }
          }
        }
        return null;
      }

      // Handle error events
      if (data.type === 'error') {
        return {
          type: 'error',
          content: data.error?.message || data.message || 'Unknown error'
        };
      }

      // Handle tool_result events (user message containing tool results)
      if (data.type === 'user' && data.message?.content) {
        for (const block of data.message.content) {
          if (block.type === 'tool_result') {
            return {
              type: 'tool_result',
              toolCall: {
                id: block.tool_use_id || '',
                name: '',
                input: {},
                output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
                status: block.is_error ? 'failed' : 'completed'
              }
            };
          }
        }
      }

      // Handle direct tool_result events
      if (data.type === 'tool_result') {
        return {
          type: 'tool_result',
          toolCall: {
            id: data.tool_use_id || data.tool_id || '',
            name: data.tool_name || '',
            input: {},
            output: typeof data.content === 'string' ? data.content : JSON.stringify(data.content || ''),
            status: data.is_error ? 'failed' : 'completed'
          }
        };
      }

    } catch {
      // If it's not JSON, treat as plain text
      if (line.trim()) {
        return { type: 'text', content: line };
      }
    }

    return null;
  }

  /**
   * Get stored usage stats from the last message and clear them
   * Called by sendMessage after stream processing to include in final done chunk
   */
  getStoredUsage(): { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | null {
    const usage = this._lastUsageStats;
    this._lastUsageStats = null;
    console.log('[Mysti] Claude: getStoredUsage returning:', usage);
    return usage;
  }

  /**
   * Enhance a prompt using Claude
   */
  async enhancePrompt(prompt: string): Promise<string> {
    const { spawn } = await import('child_process');
    const claudePath = this.getCliPath();

    const enhancePrompt = `Please enhance the following prompt to be more specific and effective for a coding assistant. Return only the enhanced prompt without any explanation:

Original prompt: "${prompt}"

Enhanced prompt:`;

    return new Promise((resolve) => {
      const args = ['--print', '--output-format', 'text'];

      const config = vscode.workspace.getConfiguration('mysti');
      const useShell = config.get<boolean>('useShellForCli', false);
      const proc = spawn(claudePath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: useShell
      });

      let output = '';

      if (proc.stdin) {
        proc.stdin.write(enhancePrompt);
        proc.stdin.end();
      }

      proc.stdout?.on('data', (data) => {
        output += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0 && output.trim()) {
          resolve(output.trim());
        } else {
          resolve(prompt);
        }
      });

      proc.on('error', () => {
        resolve(prompt);
      });
    });
  }

  // Private helper methods

  private _getConfiguredPath(): string {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<string>('claudeCodePath', 'claude');
  }

  private _getSearchPaths(): string[] {
    const paths: string[] = [];
    const homeDir = os.homedir();

    // 1. User-configured path first (if not default 'claude')
    const config = vscode.workspace.getConfiguration('mysti');
    const configuredPath = config.get<string>('claudeCodePath');
    if (configuredPath && configuredPath !== 'claude') {
      paths.push(configuredPath);
    }

    // 2. VSCode extension bundle (highest priority after configured)
    const extensionCli = this._findVSCodeExtensionCli();
    if (extensionCli) {
      paths.push(extensionCli);
    }

    // 3. Standard installation locations (platform-specific)
    if (process.platform === 'win32') {
      // Windows paths
      const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
      paths.push(path.join(appData, 'npm', 'claude.cmd'));
      paths.push(path.join(appData, 'npm', 'claude'));
    } else {
      // macOS and Linux
      paths.push('/usr/local/bin/claude');        // Homebrew Intel, standard Unix
      paths.push('/opt/homebrew/bin/claude');     // Homebrew Apple Silicon
      paths.push('/usr/bin/claude');              // System install
      paths.push(path.join(homeDir, '.npm-global', 'bin', 'claude'));  // npm config prefix
      paths.push(path.join(homeDir, '.local', 'bin', 'claude'));       // pip-style user install
      paths.push(path.join(homeDir, 'node_modules', '.bin', 'claude')); // Local npm install

      // NVM-managed installations
      const nvmDir = process.env.NVM_DIR || path.join(homeDir, '.nvm');
      if (fs.existsSync(nvmDir)) {
        // Check for current symlink first (most common)
        const nvmCurrent = path.join(nvmDir, 'current', 'bin', 'claude');
        paths.push(nvmCurrent);

        // Also check versions directory for installed Node versions
        const versionsDir = path.join(nvmDir, 'versions', 'node');
        if (fs.existsSync(versionsDir)) {
          try {
            const versions = fs.readdirSync(versionsDir)
              .filter(v => v.startsWith('v'))
              .sort()
              .reverse(); // Latest first
            for (const version of versions) {
              paths.push(path.join(versionsDir, version, 'bin', 'claude'));
            }
          } catch {
            // Ignore errors reading NVM versions
          }
        }
      }
    }

    // 4. Bare command fallback (relies on PATH)
    paths.push('claude');

    return paths;
  }

  private _findVSCodeExtensionCli(): string | null {
    const homeDir = os.homedir();
    const extensionsDir = path.join(homeDir, '.vscode', 'extensions');

    try {
      if (fs.existsSync(extensionsDir)) {
        const entries = fs.readdirSync(extensionsDir);
        const claudeExtensions = entries
          .filter(e => e.startsWith('anthropic.claude-code-'))
          .sort()
          .reverse();

        for (const ext of claudeExtensions) {
          const binaryPath = path.join(extensionsDir, ext, 'resources', 'native-binary', 'claude');
          if (fs.existsSync(binaryPath)) {
            console.log('[Mysti] Claude: Found CLI in VSCode extension:', binaryPath);
            return binaryPath;
          }
        }
      }
    } catch (error) {
      console.error('[Mysti] Claude: Error searching for CLI:', error);
    }

    return null;
  }

  private async _validateCliPath(cliPath: string): Promise<boolean> {
    try {
      // For absolute/relative paths, check file exists and is executable
      if (cliPath.includes(path.sep) || cliPath.startsWith('/')) {
        fs.accessSync(cliPath, fs.constants.X_OK);
        return true;
      }

      // For bare commands like 'claude', use which/where
      if (cliPath === 'claude') {
        return this._checkCommandExists('claude');
      }

      return false;
    } catch {
      return false;
    }
  }

  private async _checkCommandExists(command: string): Promise<boolean> {
    const { spawn } = await import('child_process');
    const checkCmd = process.platform === 'win32' ? 'where' : 'which';

    return new Promise((resolve) => {
      const proc = spawn(checkCmd, [command], { stdio: ['ignore', 'pipe', 'ignore'] });
      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
  }
}
