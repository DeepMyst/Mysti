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
import { BaseCliProvider, type PanelSessionState, type ProcessTracker } from '../base/BaseCliProvider';
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
import { validateModelName } from '../../utils/validation';
import { getEnrichedEnv } from '../../utils/platform';
import { PROCESS_KILL_GRACE_PERIOD_MS } from '../../constants';

export interface CopilotSessionState extends PanelSessionState {
  activeToolCalls: Map<string, { id: string; name: string; input: Record<string, unknown> }>;
  lastUsageStats: { input_tokens: number; output_tokens: number } | null;
}

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
        description: 'Best balance of speed and intelligence',
        contextWindow: 200000
      },
      {
        id: 'claude-opus-4.5',
        name: 'Claude Opus 4.5',
        description: 'Flagship Anthropic model for complex tasks',
        contextWindow: 200000
      },
      {
        id: 'claude-sonnet-4',
        name: 'Claude Sonnet 4',
        description: 'Previous Claude Sonnet model',
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
        description: 'OpenAI general purpose model',
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
      {
        id: 'gpt-5-mini',
        name: 'GPT-5 Mini',
        description: 'Lightweight OpenAI model',
        contextWindow: 128000
      },
      {
        id: 'gpt-4.1',
        name: 'GPT-4.1',
        description: 'OpenAI GPT-4.1 model',
        contextWindow: 128000
      },
      // Google Models
      {
        id: 'gemini-3-pro-preview',
        name: 'Gemini 3 Pro Preview',
        description: 'Google advanced reasoning model',
        contextWindow: 1000000
      }
    ],
    defaultModel: 'claude-sonnet-4.5'
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsThinking: false,
    supportsToolUse: true,
    supportsSessions: true,
    supportsAutoInstall: true
  };

  protected _createSession(panelId: string): CopilotSessionState {
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
    return 'copilot';
  }

  protected _getConfiguredCliPath(): string {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<string>('copilotPath', 'copilot');
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
    const session = this._getSession(panelId) as CopilotSessionState;
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
    const args = this.buildCliArgs(settings, session);
    args.push('-p', fullPrompt);

    console.log(`[Mysti] Copilot: Spawning CLI with -p flag...`);

    session.process = spawn(cliPath, args, {
      cwd,
      env: getEnrichedEnv(),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const spawnTime = Date.now() - startTime;
    console.log(`[Mysti] Copilot: CLI spawned in ${spawnTime}ms`);

    // Register process with ProviderManager for per-panel cancellation
    if (panelId && providerManager && typeof (providerManager as ProcessTracker).registerProcess === 'function') {
      (providerManager as ProcessTracker).registerProcess(panelId, session.process);
    }

    // Set up stderr handler
    // Use a mutable object so processStream always sees the latest stderr content
    const stderrRef = { output: '' };
    const stderrHandler = (data: Buffer) => {
      const text = data.toString();
      stderrRef.output += text;
      console.log(`[Mysti] Copilot stderr:`, text);
    };

    if (session.process.stderr) {
      session.process.stderr.on('data', stderrHandler);
    }

    try {
      console.log(`[Mysti] Copilot: ⏱️ TIMING BREAKDOWN:`);
      console.log(`  - Prompt build: ${promptTime}ms`);
      console.log(`  - CLI spawn: ${spawnTime - promptTime}ms`);
      console.log(`  - Total setup: ${spawnTime}ms`);
      console.log(`  - Waiting for first response...`);

      // Emit session_active so the webview shows the session indicator
      // Copilot CLI outputs plain text so its JSON init handler never fires
      if (!session.sessionId) {
        session.sessionId = `copilot-${panelId || 'default'}-${Date.now()}`;
      }
      yield { type: 'session_active' as const, sessionId: session.sessionId };

      // Process stream output (stderrRef is mutable, so processStream sees full stderr)
      yield* this.processStream(stderrRef, session);

      // Additional auth error check after stream processing
      if (stderrRef.output && this.isAuthenticationError(stderrRef.output)) {
        console.log(`[Mysti] Copilot: Auth error detected in stderr:`, stderrRef.output);
        yield {
          type: 'auth_error',
          content: stderrRef.output,
          authCommand: this.getAuthCommand(),
          providerName: this.displayName
        };
        return; // Don't yield done after auth error
      }

      // Yield final done with any stored usage
      const totalTime = Date.now() - startTime;
      console.log(`[Mysti] Copilot: ✅ Request completed in ${totalTime}ms`);

      const storedUsage = this.getStoredUsage(panelId);
      yield storedUsage ? { type: 'done', usage: storedUsage } : { type: 'done' };
    } catch (error) {
      yield this.handleError(error);
    } finally {
      // Clean up process
      if (session.process && !session.process.killed) {
        try {
          // Remove only our stderr handler — don't strip waitForProcess listeners
          if (session.process.stderr) {
            session.process.stderr.removeListener('data', stderrHandler);
          }
          session.process.kill('SIGTERM');

          const processToKill = session.process;
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

      session.process = null;

      // Clear process tracking
      if (panelId && providerManager && typeof (providerManager as ProcessTracker).clearProcess === 'function') {
        (providerManager as ProcessTracker).clearProcess(panelId);
      }
    }
  }

  protected buildCliArgs(settings: Settings, session: PanelSessionState): string[] {
    // Note: Copilot CLI uses -p flag for prompt (set in sendMessage override)
    // No --output-format flag exists - CLI outputs plain text
    const args: string[] = [];

    // Add model selection (custom model override or dropdown selection)
    const effectiveModel = this._getEffectiveModel(settings);
    if (effectiveModel) {
      args.push('--model', effectiveModel);
    }

    // Map Mysti modes/access levels to Copilot CLI flags
    this._addPermissionFlags(args, settings);

    // Session handling - Copilot supports --resume
    if (session.sessionId) {
      args.push('--resume', session.sessionId);
      console.log('[Mysti] Copilot: Resuming session:', session.sessionId);
    }

    console.log('[Mysti] Copilot: Built CLI args:', args.join(' '));
    return args;
  }

  /**
   * Get the effective model, preferring provider-specific custom model over dropdown selection
   */
  private _getEffectiveModel(settings: Settings): string | undefined {
    const config = vscode.workspace.getConfiguration('mysti');
    const customModel = config.get<string>('copilotModel', '');
    if (customModel) {
      const validation = validateModelName(customModel);
      if (validation.valid) {
        console.log(`[Mysti] Copilot: Using custom model: ${customModel}`);
        return customModel;
      }
      console.warn(`[Mysti] Copilot: Invalid custom model "${customModel}": ${validation.error}`);
    }
    return settings.model || undefined;
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
  protected parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    const copilotSession = session as CopilotSessionState;

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
          if (data.session_id && !session.sessionId) {
            session.sessionId = data.session_id;
            console.log('[Mysti] Copilot: Session ID:', data.session_id);
            return { type: 'session_active', sessionId: data.session_id };
          }
          return null;

        case 'message':
          if (data.role === 'assistant' && data.content) {
            return { type: 'text', content: data.content };
          }
          return null;

        case 'tool_use': {
          const toolNameCopilot = data.tool_name || '';
          const paramsCopilot = data.parameters || {};

          // Detect ask_user-style tools and convert to ask_user_question chunk
          if ((toolNameCopilot === 'ask_user' || toolNameCopilot === 'AskUserQuestion' || toolNameCopilot === 'ask_user_question') &&
              paramsCopilot.questions && Array.isArray(paramsCopilot.questions)) {
            console.log('[Mysti] Copilot: Detected ask_user tool, converting to ask_user_question chunk');
            return {
              type: 'ask_user_question',
              askUserQuestion: {
                toolCallId: data.tool_id,
                questions: (paramsCopilot.questions as Array<Record<string, unknown>>).map((q: Record<string, unknown>) => ({
                  question: String(q.question || ''),
                  header: String(q.header || '').substring(0, 12),
                  options: Array.isArray(q.options) ? q.options.map((o: Record<string, unknown>) => ({
                    label: String(o.label || ''),
                    description: String(o.description || '')
                  })) : [],
                  multiSelect: Boolean(q.multiSelect)
                }))
              }
            };
          }

          copilotSession.activeToolCalls.set(data.tool_id, {
            id: data.tool_id,
            name: toolNameCopilot,
            input: paramsCopilot
          });
          return {
            type: 'tool_use',
            toolCall: {
              id: data.tool_id,
              name: toolNameCopilot,
              input: paramsCopilot,
              status: 'running'
            }
          };
        }

        case 'tool_result': {
          const toolInfo = copilotSession.activeToolCalls.get(data.tool_id);
          copilotSession.activeToolCalls.delete(data.tool_id);
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

        case 'error':
          return {
            type: 'error',
            content: data.message || data.error || 'Unknown error'
          };

        case 'result':
          if (data.stats) {
            copilotSession.lastUsageStats = {
              input_tokens: data.stats.input_tokens || data.stats.total_tokens || 0,
              output_tokens: data.stats.output_tokens || 0
            };
            console.log('[Mysti] Copilot: Captured usage stats:', copilotSession.lastUsageStats);
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
  getStoredUsage(panelId?: string): { input_tokens: number; output_tokens: number } | null {
    const session = this._getSession(panelId) as CopilotSessionState;
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
      const session = this._panelSessions.get(panelId) as CopilotSessionState | undefined;
      if (session) {
        session.activeToolCalls.clear();
        session.lastUsageStats = null;
      }
    }
  }

}
