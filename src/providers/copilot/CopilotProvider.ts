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
import { spawn } from 'child_process';
import { BaseCliProvider } from '../base/BaseCliProvider';
import type {
  CliDiscoveryResult,
  AuthConfig,
  ProviderCapabilities,
  PersonaConfig
} from '../base/IProvider';
import type {
  Settings,
  StreamChunk,
  ProviderConfig,
  AuthStatus,
  ContextItem,
  Conversation,
  AgentConfiguration
} from '../../types';
import { PROCESS_TIMEOUT_MS, PROCESS_KILL_GRACE_PERIOD_MS } from '../../constants';

/**
 * GitHub Copilot CLI provider implementation
 * Supports copilot-cli for AI-powered code assistance with GitHub integration
 */
export class CopilotProvider extends BaseCliProvider {
  readonly id = 'github-copilot';
  readonly displayName = 'GitHub Copilot';

  readonly config: ProviderConfig = {
    name: 'github-copilot',
    displayName: 'GitHub Copilot',
    models: [
      // Anthropic Models
      {
        id: 'claude-sonnet-4.5',
        name: 'Claude Sonnet 4.5',
        description: 'Default - best balance of speed and intelligence',
        contextWindow: 200000
      },
      {
        id: 'claude-opus-4.5',
        name: 'Claude Opus 4.5',
        description: 'Most capable Anthropic model for complex tasks',
        contextWindow: 200000
      },
      {
        id: 'claude-sonnet-4',
        name: 'Claude Sonnet 4',
        description: 'Previous Claude Sonnet model',
        contextWindow: 200000
      },
      {
        id: 'claude-opus-4.1',
        name: 'Claude Opus 4.1',
        description: 'Previous Claude Opus model',
        contextWindow: 200000
      },
      {
        id: 'claude-haiku-4.5',
        name: 'Claude Haiku 4.5',
        description: 'Fast and lightweight for quick tasks',
        contextWindow: 200000
      },
      // OpenAI Models
      {
        id: 'gpt-5.2',
        name: 'GPT-5.2',
        description: 'Latest OpenAI model (preview)',
        contextWindow: 128000
      },
      {
        id: 'gpt-5.1-codex-max',
        name: 'GPT-5.1 Codex Max',
        description: 'OpenAI flagship coding model',
        contextWindow: 128000
      },
      {
        id: 'gpt-5.1-codex',
        name: 'GPT-5.1 Codex',
        description: 'OpenAI optimized for code generation',
        contextWindow: 128000
      },
      {
        id: 'gpt-5.1-codex-mini',
        name: 'GPT-5.1 Codex Mini',
        description: 'Lightweight OpenAI coding model',
        contextWindow: 128000
      },
      {
        id: 'gpt-5.1',
        name: 'GPT-5.1',
        description: 'OpenAI general purpose model',
        contextWindow: 128000
      },
      {
        id: 'gpt-5',
        name: 'GPT-5',
        description: 'OpenAI GPT-5 model',
        contextWindow: 128000
      },
      // Google Models
      {
        id: 'gemini-3-pro',
        name: 'Gemini 3 Pro',
        description: 'Google advanced reasoning model',
        contextWindow: 1000000
      },
      {
        id: 'gemini-3-flash',
        name: 'Gemini 3 Flash',
        description: 'Google fast multimodal model',
        contextWindow: 1000000
      },
      {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        description: 'Google previous generation model',
        contextWindow: 1000000
      }
    ],
    defaultModel: 'claude-sonnet-4.5'
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsThinking: false,
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
    if (configuredPath !== 'copilot') {
      const found = await this._validateCliPath(configuredPath);
      if (found) {
        return { found: true, path: configuredPath };
      }
    }

    // Search common installation paths
    const searchPaths = [
      '/usr/local/bin/copilot',
      '/opt/homebrew/bin/copilot', // Apple Silicon
      path.join(os.homedir(), '.npm-global', 'bin', 'copilot'),
      path.join(os.homedir(), '.local', 'bin', 'copilot'),
      // npm global paths
      '/usr/bin/copilot',
      path.join(process.env.APPDATA || '', 'npm', 'copilot.cmd'), // Windows
    ];

    for (const searchPath of searchPaths) {
      if (await this._validateCliPath(searchPath)) {
        return { found: true, path: searchPath };
      }
    }

    // Fall back to checking if 'copilot' is in PATH
    const found = await this._validateCliPath('copilot');
    return {
      found,
      path: 'copilot',
      installCommand: 'npm install -g @github/copilot'
    };
  }

  getCliPath(): string {
    return this._getConfiguredPath();
  }

  async getAuthConfig(): Promise<AuthConfig> {
    // Check for GH_TOKEN or GITHUB_TOKEN environment variables (per official docs)
    const hasToken = !!(process.env.GH_TOKEN || process.env.GITHUB_TOKEN);

    // Check for copilot config directory
    const configPath = path.join(os.homedir(), '.config', 'github-copilot');
    const hasConfig = fs.existsSync(configPath);

    return {
      type: hasToken ? 'api-key' : 'oauth',
      isAuthenticated: hasToken || hasConfig,
      configPath
    };
  }

  async checkAuthentication(): Promise<AuthStatus> {
    // Check for GH_TOKEN or GITHUB_TOKEN environment variables (per official docs)
    if (process.env.GH_TOKEN) {
      return {
        authenticated: true,
        user: 'GitHub Token (GH_TOKEN)'
      };
    }

    if (process.env.GITHUB_TOKEN) {
      return {
        authenticated: true,
        user: 'GitHub Token (GITHUB_TOKEN)'
      };
    }

    // Check for copilot config (created after /login in the CLI)
    const configPath = path.join(os.homedir(), '.config', 'github-copilot');
    if (fs.existsSync(configPath)) {
      return {
        authenticated: true,
        user: 'GitHub Account'
      };
    }

    return {
      authenticated: false,
      error: 'Not authenticated. Run "copilot" and use the /login command, or set GH_TOKEN/GITHUB_TOKEN environment variable.'
    };
  }

  getAuthCommand(): string {
    return 'copilot'; // Use /login command within the CLI
  }

  getInstallCommand(): string {
    return 'npm install -g @github/copilot';
  }

  /**
   * Override sendMessage to use -p flag instead of stdin
   * Copilot CLI uses -p "prompt" for programmatic (non-interactive) mode
   */
  async *sendMessage(
    content: string,
    context: ContextItem[],
    settings: Settings,
    conversation: Conversation | null,
    persona?: PersonaConfig,
    panelId?: string,
    providerManager?: unknown,
    agentConfig?: AgentConfiguration
  ): AsyncGenerator<StreamChunk> {
    const startTime = Date.now();
    const cliPath = this.getCliPath();

    // Get workspace folder for CWD
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const cwd = workspaceFolders ? workspaceFolders[0].uri.fsPath : process.cwd();

    // Build prompt first (needed for -p flag)
    const fullPrompt = await this.buildPromptAsync(content, context, conversation, settings, persona, agentConfig);
    const promptTime = Date.now() - startTime;
    console.log(`[Mysti] Copilot: Prompt built in ${promptTime}ms`);

    // Build args with prompt using -p flag
    const args = this.buildCliArgs(settings, this.hasSession());
    args.push('-p', fullPrompt);

    console.log(`[Mysti] Copilot: Spawning CLI with -p flag...`);

    this._currentProcess = spawn(cliPath, args, {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const spawnTime = Date.now() - startTime;
    console.log(`[Mysti] Copilot: CLI spawned in ${spawnTime}ms`);

    // Register process with ProviderManager for per-panel cancellation
    if (panelId && providerManager && typeof (providerManager as any).registerProcess === 'function') {
      (providerManager as any).registerProcess(panelId, this._currentProcess);
    }

    // Set up stderr handler
    let stderrOutput = '';
    const stderrHandler = (data: Buffer) => {
      const text = data.toString();
      stderrOutput += text;
      console.log(`[Mysti] Copilot stderr:`, text);
    };

    if (this._currentProcess.stderr) {
      this._currentProcess.stderr.on('data', stderrHandler);
    }

    try {
      console.log(`[Mysti] Copilot: ⏱️ TIMING BREAKDOWN:`);
      console.log(`  - Prompt build: ${promptTime}ms`);
      console.log(`  - CLI spawn: ${spawnTime - promptTime}ms`);
      console.log(`  - Total setup: ${spawnTime}ms`);
      console.log(`  - Waiting for first response...`);

      // Process stream output
      // Note: stderrOutput is captured asynchronously, so we check for auth errors after stream completes
      yield* this.processStream(stderrOutput);

      // Check for auth errors after stream processing (stderrOutput now has full content)
      if (stderrOutput && this.isAuthenticationError(stderrOutput)) {
        console.log(`[Mysti] Copilot: Auth error detected in stderr:`, stderrOutput);
        yield {
          type: 'auth_error',
          content: stderrOutput,
          authCommand: this.getAuthCommand(),
          providerName: this.displayName
        };
        return; // Don't yield done after auth error
      }

      // Yield final done with any stored usage
      const totalTime = Date.now() - startTime;
      console.log(`[Mysti] Copilot: ✅ Request completed in ${totalTime}ms`);

      const storedUsage = this.getStoredUsage();
      yield storedUsage ? { type: 'done', usage: storedUsage } : { type: 'done' };
    } catch (error) {
      yield this.handleError(error);
    } finally {
      // Clean up process
      if (this._currentProcess && !this._currentProcess.killed) {
        try {
          this._currentProcess.removeAllListeners();
          this._currentProcess.kill('SIGTERM');

          const processToKill = this._currentProcess;
          setTimeout(() => {
            if (processToKill && !processToKill.killed) {
              console.warn(`[Mysti] Copilot: Force killing leaked process`);
              processToKill.kill('SIGKILL');
            }
          }, PROCESS_KILL_GRACE_PERIOD_MS);
        } catch (e) {
          console.error(`[Mysti] Copilot: Error cleaning up process:`, e);
        }
      }

      this._currentProcess = null;

      // Clear process tracking
      if (panelId && providerManager && typeof (providerManager as any).clearProcess === 'function') {
        (providerManager as any).clearProcess(panelId);
      }
    }
  }

  protected buildCliArgs(settings: Settings, hasSession: boolean): string[] {
    // Note: Copilot CLI uses -p flag for prompt (set in sendMessage override)
    // No --output-format flag exists - CLI outputs plain text
    const args: string[] = [];

    // Note: Model selection in Copilot CLI is via /model slash command, not CLI flag
    // We cannot set model via CLI args

    // Map Mysti modes/access levels to Copilot CLI flags
    this._addPermissionFlags(args, settings);

    // Session handling - Copilot supports --resume
    if (hasSession && this._currentSessionId) {
      args.push('--resume', this._currentSessionId);
      console.log('[Mysti] Copilot: Resuming session:', this._currentSessionId);
    }

    console.log('[Mysti] Copilot: Built CLI args:', args.join(' '));
    return args;
  }

  /**
   * Copilot may not support thinking tokens
   * Returns undefined to indicate no thinking token support
   */
  protected getThinkingTokens(_thinkingLevel: string): number | undefined {
    return undefined;
  }

  /**
   * Add permission flags based on mode and access level
   * Per official docs:
   * - --allow-all-tools: allows any tool without approval
   * - --deny-tool 'shell': denies shell commands
   * - --deny-tool 'write': denies file modification tools
   */
  private _addPermissionFlags(args: string[], settings: Settings): void {
    const { mode, accessLevel } = settings;

    // Plan modes and read-only = deny shell and write tools
    if (mode === 'quick-plan' || mode === 'detailed-plan' || accessLevel === 'read-only') {
      args.push('--deny-tool', 'shell');
      args.push('--deny-tool', 'write');
      console.log('[Mysti] Copilot: Using read-only mode (deny shell and write)');
      return;
    }

    // Full access or edit-automatically = allow all tools
    if (accessLevel === 'full-access' || mode === 'edit-automatically') {
      args.push('--allow-all-tools');
      console.log('[Mysti] Copilot: Using auto-approve mode (allow all tools)');
      return;
    }

    // Default: no special flags, CLI will prompt for permissions
    console.log('[Mysti] Copilot: Using default mode (interactive permissions)');
  }

  /**
   * Parse Copilot CLI output
   * The CLI outputs plain text, not JSON streaming format
   * This parses line-by-line text output from the CLI and converts
   * terminal UI elements to proper markdown formatting
   */
  protected parseStreamLine(line: string): StreamChunk | null {
    // Skip empty lines
    if (!line.trim()) {
      return null;
    }

    // Try to parse as JSON first (in case Copilot CLI adds JSON support in future)
    try {
      const data = JSON.parse(line);

      // Handle JSON events if they exist
      switch (data.type) {
        case 'init':
          if (data.session_id && !this._currentSessionId) {
            this._currentSessionId = data.session_id;
            console.log('[Mysti] Copilot: Session ID:', data.session_id);
            return { type: 'session_active', sessionId: data.session_id };
          }
          return null;

        case 'message':
          if (data.role === 'assistant' && data.content) {
            return { type: 'text', content: data.content };
          }
          return null;

        case 'tool_use':
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

        case 'error':
          return {
            type: 'error',
            content: data.message || data.error || 'Unknown error'
          };

        case 'result':
          if (data.stats) {
            this._lastUsageStats = {
              input_tokens: data.stats.input_tokens || data.stats.total_tokens || 0,
              output_tokens: data.stats.output_tokens || 0
            };
            console.log('[Mysti] Copilot: Captured usage stats:', this._lastUsageStats);
          }
          return null;

        default:
          // Unknown JSON type, log and return as text
          console.log('[Mysti] Copilot: Unknown JSON event:', data.type);
          return { type: 'text', content: line };
      }
    } catch {
      // Not JSON - this is the expected case for Copilot CLI plain text output
      // Format terminal UI elements to markdown
      const formattedContent = this._formatTerminalOutput(line);
      return { type: 'text', content: formattedContent };
    }
  }

  /**
   * Convert Copilot CLI terminal-style output to proper markdown
   * Handles patterns like:
   * - "✓ Tool description" → Tool completed marker
   * - "$ command" → Shell command
   * - "└ result" → Result summary
   */
  private _formatTerminalOutput(line: string): string {
    const trimmed = line.trim();

    // Tool completion: "✓ Description" → Keep as is (already looks nice)
    if (trimmed.startsWith('✓')) {
      return '\n' + line + '\n';
    }

    // Shell command preview: "$ command" → Format as inline code
    if (trimmed.startsWith('$')) {
      return '\n`' + trimmed + '`\n';
    }

    // Result summary: "└ result" → Format with indentation
    if (trimmed.startsWith('└') || trimmed.startsWith('   └')) {
      return '  ' + line + '\n';
    }

    // Regular content - add newline for paragraph separation
    return line + '\n';
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
    return config.get<string>('copilotPath', 'copilot');
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
