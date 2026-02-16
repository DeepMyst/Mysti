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
import { BaseCliProvider, PanelSessionState } from '../base/BaseCliProvider';
import type {
  CliDiscoveryResult,
  AuthConfig,
  ProviderCapabilities,
  PersonaConfig
} from '../base/IProvider';
import type {
  Attachment,
  ContextItem,
  Settings,
  Conversation,
  StreamChunk,
  ProviderConfig,
  AgentConfiguration,
  AuthStatus,
  SlashCommandDefinition
} from '../../types';
import { validateModelName } from '../../utils/validation';
import { getEnrichedEnv } from '../../utils/platform';

/**
 * Extended per-panel session state for Claude Code provider.
 * Adds tool call accumulation and usage stats tracking per panel.
 */
export interface ClaudeSessionState extends PanelSessionState {
  activeToolCalls: Map<number, { id: string; name: string; inputJson: string }>;
  lastUsageStats: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | null;
  hasStreamedText: boolean;
  awaitingCompactSummary: boolean;
}

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
        id: 'claude-opus-4-6',
        name: 'Claude Opus 4.6',
        description: 'Latest flagship model, most capable for complex tasks',
        contextWindow: 200000
      },
      {
        id: 'claude-sonnet-4-5-20250929',
        name: 'Claude Sonnet 4.5',
        description: 'Best balance of speed and intelligence',
        contextWindow: 200000
      },
      {
        id: 'claude-opus-4-5-20251101',
        name: 'Claude Opus 4.5',
        description: 'Previous flagship, advanced reasoning and analysis',
        contextWindow: 200000
      },
      {
        id: 'claude-haiku-4-5-20251001',
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
    supportsSessions: true,
    supportsNativeCompact: true,
    // TODO: Enable after testing Claude CLI interactive mode with piped stdin.
    // The infrastructure is ready — set to true once the REPL protocol is verified.
    // supportsPersistentProcess: true,
    supportsImages: true,
    supportsFileAttachments: true,
    supportsAutoInstall: true
  };

  async discoverCli(): Promise<CliDiscoveryResult> {
    return this._discoverCliCommon();
  }

  getCliPath(): string {
    return this._getCliPathCommon();
  }

  protected _getCliCommandName(): string {
    return 'claude';
  }

  protected _getConfiguredCliPath(): string {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<string>('claudeCodePath', 'claude');
  }

  protected _getAdditionalSearchPaths(): string[] {
    const paths: string[] = [];
    const extensionCli = this._findVSCodeExtensionCli();
    if (extensionCli) {
      paths.push(extensionCli);
    }
    return paths;
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

  // ============================================================================
  // Slash command menu: Claude-specific commands
  // ============================================================================

  public override getSlashCommands(_panelId?: string): SlashCommandDefinition[] {
    const base = super.getSlashCommands(_panelId);
    return [
      ...base,
      {
        id: 'claude:compact',
        label: '/compact',
        description: 'Compact conversation context',
        section: 'commands',
        icon: 'fold',
        provider: 'claude-code',
        action: 'execute',
        isCliPassthrough: true,
        keywords: ['compact', 'compress', 'context', 'tokens'],
      },
      {
        id: 'claude:thinking',
        label: 'Thinking level',
        description: 'Adjust Claude thinking depth',
        section: 'model',
        icon: 'lightbulb',
        provider: 'claude-code',
        action: 'execute',
        keywords: ['thinking', 'reasoning', 'depth'],
      },
    ];
  }

  // ============================================================================
  // Per-panel session creation (override for Claude-specific state)
  // ============================================================================

  protected _createSession(panelId: string): ClaudeSessionState {
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
      hasStreamedText: false,
      awaitingCompactSummary: false,
    };
  }

  protected buildCliArgs(settings: Settings, session: PanelSessionState): string[] {
    // --verbose is required by Claude CLI when using --print with --output-format=stream-json
    const args: string[] = [
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
    ];

    // Map Mysti modes/access levels to Claude Code permission flags
    // This ensures proper enforcement at the CLI level
    this._addPermissionFlags(args, settings);

    // Session handling - resume existing session or start new
    if (session.sessionId) {
      args.push('--resume', session.sessionId);
      console.log('[Mysti] Claude: Continuing session:', session.sessionId);
    } else {
      args.push('--print');
      console.log('[Mysti] Claude: Starting new session');
    }

    // Add model selection (custom model override or dropdown selection)
    const effectiveModel = this._getEffectiveModel(settings);
    if (effectiveModel) {
      args.push('--model', effectiveModel);
    }

    return args;
  }

  // ============================================================================
  // Persistent Process Mode
  // ============================================================================

  /**
   * Build CLI args for persistent (interactive) mode.
   * Omits --print so the CLI stays alive as an interactive REPL.
   * Always uses --resume to maintain conversation context.
   */
  protected buildPersistentCliArgs(settings: Settings, session: PanelSessionState): string[] | null {
    const args: string[] = [
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
    ];

    this._addPermissionFlags(args, settings);

    // Always use --resume for persistent sessions so context carries over
    if (session.sessionId) {
      args.push('--resume', session.sessionId);
    }
    // No --print flag — this keeps the CLI alive in interactive mode

    const effectiveModel = this._getEffectiveModel(settings);
    if (effectiveModel) {
      args.push('--model', effectiveModel);
    }

    return args;
  }

  /**
   * Detect response boundary in Claude CLI stream-json output.
   * The `result` event marks the end of a response in interactive mode.
   */
  protected _isResponseBoundary(line: string): boolean {
    try {
      const data = JSON.parse(line.trim());
      return data.type === 'result';
    } catch {
      return false;
    }
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

  /**
   * Get the effective model, preferring provider-specific custom model over dropdown selection
   */
  private _getEffectiveModel(settings: Settings): string | undefined {
    const config = vscode.workspace.getConfiguration('mysti');
    const customModel = config.get<string>('claudeCodeModel', '');
    if (customModel) {
      const validation = validateModelName(customModel);
      if (validation.valid) {
        console.log(`[Mysti] Claude: Using custom model: ${customModel}`);
        return customModel;
      }
      console.warn(`[Mysti] Claude: Invalid custom model "${customModel}": ${validation.error}`);
    }
    return settings.model || undefined;
  }

  protected parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    const claudeSession = session as ClaudeSessionState;

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
            claudeSession.hasStreamedText = true;
            return { type: 'text', content: delta.text || '' };
          }
          if (delta.type === 'thinking_delta') {
            return { type: 'thinking', content: delta.thinking || '' };
          }
          if (delta.type === 'input_json_delta') {
            // Accumulate tool input JSON
            const activeTool = claudeSession.activeToolCalls.get(blockIndex);
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
            claudeSession.activeToolCalls.set(blockIndex, {
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
          const completedTool = claudeSession.activeToolCalls.get(blockIndex);
          if (completedTool) {
            claudeSession.activeToolCalls.delete(blockIndex);
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
          claudeSession.hasStreamedText = false;
          return null;
        }

        // Handle message_delta - capture usage stats (usage is in delta, not stop)
        if (nestedType === 'message_delta') {
          const usage = nestedEvent.usage;
          if (usage) {
            claudeSession.lastUsageStats = {
              input_tokens: usage.input_tokens || 0,
              output_tokens: usage.output_tokens || 0,
              cache_creation_input_tokens: usage.cache_creation_input_tokens,
              cache_read_input_tokens: usage.cache_read_input_tokens
            };
            console.log('[Mysti] Claude: Captured usage from message_delta:', claudeSession.lastUsageStats);
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
      // For normal messages, text was already streamed via text_delta chunks — skip to avoid duplication.
      // For CLI internal commands like /compact, no text_delta events are emitted, so emit the result text.
      if (data.type === 'result') {
        if (!claudeSession.hasStreamedText && data.result && typeof data.result === 'string') {
          return { type: 'text', content: data.result };
        }
        return null;
      }

      // Handle system events (session init, etc.)
      if (data.type === 'system') {
        if (data.subtype === 'init') {
          const sessionId = data.session_id || data.sessionId;
          if (sessionId && !session.sessionId) {
            session.sessionId = sessionId;
            console.log('[Mysti] Claude: Session ID extracted:', sessionId);
            return { type: 'session_active', sessionId };
          }
        }
        // Handle compact_boundary — emitted by CLI when /compact completes
        if (data.subtype === 'compact_boundary' && data.compact_metadata) {
          claudeSession.awaitingCompactSummary = true;
          const preTokens = data.compact_metadata.pre_tokens || 0;
          console.log(`[Mysti] Claude: Compact boundary - pre_tokens: ${preTokens}`);
          return { type: 'text', content: `Conversation compacted (was ~${Math.round(preTokens / 1000)}k tokens)` };
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

      // Handle user events
      if (data.type === 'user' && data.message?.content) {
        // Capture compaction summary — a user message with string content after compact_boundary
        if (claudeSession.awaitingCompactSummary && typeof data.message.content === 'string') {
          const content = data.message.content;
          if (content.includes('session is being continued')) {
            claudeSession.awaitingCompactSummary = false;
            // Extract just the Summary section (skip the verbose Analysis section)
            const summaryIdx = content.indexOf('Summary:');
            const summaryText = summaryIdx >= 0 ? content.substring(summaryIdx) : content;
            return { type: 'text', content: summaryText };
          }
          return null; // skip "Compacted" echo and other noise
        }
        // Handle tool_result blocks (array content)
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
  getStoredUsage(panelId?: string): { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | null {
    const session = this._getSession(panelId) as ClaudeSessionState;
    const usage = session.lastUsageStats;
    session.lastUsageStats = null;
    console.log('[Mysti] Claude: getStoredUsage returning:', usage);
    return usage;
  }

  /**
   * Prepare attachments (images and files) for Claude Code CLI.
   * Writes base64 data to temp files and sets filePath on each attachment
   * so buildPromptAsync can reference them in the prompt text.
   */
  protected async prepareAttachments(
    attachments: Attachment[] | undefined,
    _args: string[]
  ): Promise<(() => Promise<void>) | null> {
    if (!attachments || attachments.length === 0) {
      return null;
    }

    const allAttachments = attachments.filter(a => a.type === 'image' || a.type === 'file');
    if (allAttachments.length === 0) {
      return null;
    }

    // Write attachments to workspace .mysti/tmp/ so Claude Code CLI has guaranteed filesystem access
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const wsRoot = workspaceFolders?.[0]?.uri.fsPath;
    const attachmentDir = wsRoot
      ? path.join(wsRoot, '.mysti', 'tmp')
      : os.tmpdir();

    await fs.promises.mkdir(attachmentDir, { recursive: true });

    const tempFiles: string[] = [];

    for (const att of allAttachments) {
      if (att.filePath && !att.base64Data) {
        // File from disk via attach button — already has path
        console.log(`[Mysti] Claude: Attachment from disk: ${att.fileName} -> ${att.filePath}`);
      } else if (att.base64Data) {
        // Clipboard/dropped file — write to workspace temp dir
        const ext = att.fileName.split('.').pop() || (att.type === 'image' ? (att.mimeType.split('/')[1] || 'png') : 'bin');
        const tempPath = path.join(attachmentDir, `mysti-attachment-${att.id}.${ext}`);
        const buffer = Buffer.from(att.base64Data, 'base64');
        await fs.promises.writeFile(tempPath, buffer);
        tempFiles.push(tempPath);
        att.filePath = tempPath;
        console.log(`[Mysti] Claude: Wrote ${att.type} attachment to workspace: ${att.fileName} -> ${tempPath}`);
      }
    }

    // Return cleanup function if we created any temp files
    if (tempFiles.length > 0) {
      return async () => {
        for (const tempFile of tempFiles) {
          try {
            await fs.promises.unlink(tempFile);
            console.log(`[Mysti] Claude: Cleaned up temp attachment: ${tempFile}`);
          } catch {
            // Ignore cleanup errors
          }
        }
      };
    }

    return null;
  }

  /**
   * Override buildPromptAsync to append attachment file path references.
   * Claude Code CLI can read and analyze files when given file paths in the prompt.
   */
  protected async buildPromptAsync(
    content: string,
    context: ContextItem[],
    conversation: Conversation | null,
    settings: Settings,
    persona?: PersonaConfig,
    agentConfig?: AgentConfiguration,
    attachments?: Attachment[]
  ): Promise<string> {
    let prompt = await super.buildPromptAsync(content, context, conversation, settings, persona, agentConfig, attachments);

    // Prepend attachment file references so Claude sees them first and uses its Read tool
    const imageAttachments = (attachments || []).filter(a => a.type === 'image' && a.filePath);
    const fileAttachments = (attachments || []).filter(a => a.type === 'file' && a.filePath);

    if (imageAttachments.length > 0 || fileAttachments.length > 0) {
      let attachmentSection = '[Attached Files — use your Read tool to view these files]\n';

      if (imageAttachments.length > 0) {
        for (const att of imageAttachments) {
          attachmentSection += `Image "${att.fileName}": ${att.filePath}\n`;
        }
      }

      if (fileAttachments.length > 0) {
        for (const att of fileAttachments) {
          attachmentSection += `File "${att.fileName}": ${att.filePath}\n`;
        }
      }

      attachmentSection += '\n';
      prompt = attachmentSection + prompt;
    }

    return prompt;
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
        env: getEnrichedEnv(),
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

}
