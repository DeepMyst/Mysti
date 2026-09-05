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
  ProviderCapabilities,
  PersonaConfig
} from '../base/IProvider';
import type {
  Settings,
  StreamChunk,
  ProviderConfig,
  ContextItem,
  Conversation,
  AuthStatus,
  SlashCommandDefinition
} from '../../types';
import { validateModelName, validateProfileName } from '../../utils/validation';
import { getEnrichedEnv } from '../../utils/platform';
import { toolKind } from '../../utils/toolNames';
import { clampEffort } from '../../utils/effort';
import type { EffortLevel } from '../../types';

/** Codex `model_reasoning_effort` supports low→xhigh (no `max`; clamp down). */
const CODEX_EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh'];

/**
 * Per-panel session state for Codex, extending base with tool call tracking.
 */
export interface CodexSessionState extends PanelSessionState {
  activeToolCalls: Map<string, { id: string; name: string; inputJson: string; status: 'running' | 'completed' | 'failed' }>;
  completedToolCalls: Set<string>;
  lastUsageStats: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number } | null;
  /** Rolling tail of the current run's stderr, surfaced in a non-zero-exit error. */
  stderrTail: string;
}

/**
 * OpenAI Codex CLI provider implementation
 * Requires ChatGPT Plus/Pro subscription or API key for authentication
 *
 * Uses `codex exec --json` for non-interactive streaming output
 *
 * @see https://github.com/openai/codex
 * @see https://developers.openai.com/codex/cli/
 */
export class CodexProvider extends BaseCliProvider {
  readonly id = 'openai-codex';
  readonly displayName = 'OpenAI Codex';

  // NOTE: all mutable stream state (active/completed tool calls, usage stats)
  // lives on CodexSessionState — per-panel, never on the provider singleton.

  readonly config: ProviderConfig = {
    name: 'openai-codex',
    displayName: 'OpenAI Codex',
    models: [
      {
        id: 'gpt-5.4-codex',
        name: 'GPT-5.4 Codex',
        description: 'Latest coding model, best for code generation',
        contextWindow: 400000
      },
      {
        id: 'gpt-5.3-codex',
        name: 'GPT-5.3 Codex',
        description: 'Previous gen coding model',
        contextWindow: 400000
      },
      {
        id: 'gpt-5.2-codex',
        name: 'GPT-5.2 Codex',
        description: 'Stable coding model, excellent for code tasks',
        contextWindow: 400000
      },
      {
        id: 'gpt-5.2',
        name: 'GPT-5.2',
        description: 'General purpose model for professional tasks',
        contextWindow: 1000000
      },
      {
        id: 'gpt-5.2-thinking',
        name: 'GPT-5.2 Thinking',
        description: 'Better at coding and planning',
        contextWindow: 1000000
      },
      {
        id: 'gpt-5.2-instant',
        name: 'GPT-5.2 Instant',
        description: 'Faster for writing and information seeking',
        contextWindow: 1000000
      },
      {
        id: 'gpt-5.1-codex-max',
        name: 'GPT-5.1 Codex Max',
        description: 'Previous gen flagship, supports context compaction',
        contextWindow: 1000000
      },
      {
        id: 'gpt-5.1-codex',
        name: 'GPT-5.1 Codex',
        description: 'Previous generation coding model',
        contextWindow: 1000000
      },
      {
        id: 'o3',
        name: 'o3',
        description: 'Advanced reasoning model',
        contextWindow: 200000
      },
      {
        id: 'o4-mini',
        name: 'o4-mini',
        description: 'Fast and efficient for simpler tasks',
        contextWindow: 200000
      }
    ],
    defaultModel: 'gpt-5.4-codex'
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsThinking: true, // Codex has 'reasoning' events
    supportsToolUse: true,
    supportsSessions: true,  // Can resume sessions with `codex exec resume`
    supportsImages: false,
    supportsAutoInstall: true,
    supportsPromptEnhancement: false,
    // Plan 02 Phase 1 capability matrix
    thinkingStyle: 'complete-blocks',  // whole 'reasoning' blocks per event
    thinkingLevelEffective: false,     // getThinkingTokens returns undefined
    effortLevels: CODEX_EFFORT_LEVELS, // model_reasoning_effort (low→xhigh)
    effortDefault: 'medium',
    planMode: 'detected',
    sessionKind: 'prompt-history',     // no actual resume today (F15) — history replayed into the prompt
    emitsToolResults: true,
    emitsUsage: true,
    modelSelection: 'full'
  };

  // ============================================================================
  // Slash command menu: Codex-specific commands
  // ============================================================================

  public override getSlashCommands(_panelId?: string): SlashCommandDefinition[] {
    const base = super.getSlashCommands(_panelId);
    return [
      ...base,
      {
        id: 'codex:profile',
        label: 'Switch profile',
        description: 'Change Codex CLI profile',
        section: 'customize',
        icon: 'account',
        provider: 'openai-codex',
        action: 'execute',
        keywords: ['profile', 'config', 'codex'],
      },
    ];
  }

  protected _createSession(panelId: string): CodexSessionState {
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
      stderrTail: '',
    };
  }

  async discoverCli(): Promise<CliDiscoveryResult> {
    return this._discoverCliCommon();
  }

  getCliPath(): string {
    return this._getCliPathCommon();
  }

  protected _getCliCommandName(): string {
    return 'codex';
  }

  protected _getConfiguredCliPath(): string {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<string>('codexPath', 'codex');
  }

  protected _getAdditionalSearchPaths(): string[] {
    if (process.platform === 'darwin') {
      // Use the CLI binary bundled inside the app, NOT the Electron launcher at Contents/MacOS/codex
      return ['/Applications/Codex.app/Contents/Resources/codex'];
    }
    return [];
  }

  async getAuthConfig(): Promise<AuthConfig> {
    // Codex OAuth (ChatGPT login) is stored in ~/.codex/auth.json. ~/.codex/config.toml
    // is only the settings file: it can exist without ever logging in and it SURVIVES
    // `codex logout` (which removes auth.json but not config.toml). So config.toml
    // existence is NOT proof of auth — the only positive markers are auth.json and
    // OPENAI_API_KEY. config.toml is still exposed as configPath purely for the
    // email/user label lookup in checkAuthentication() when auth.json is absent.
    const authJson = path.join(os.homedir(), '.codex', 'auth.json');
    const configToml = path.join(os.homedir(), '.codex', 'config.toml');
    const hasAuth = fs.existsSync(authJson);
    return {
      type: 'oauth', // ChatGPT account login
      isAuthenticated: hasAuth || !!process.env.OPENAI_API_KEY,
      configPath: hasAuth ? authJson : configToml
    };
  }

  /**
   * Get stored usage stats from turn.completed and clear them
   */
  getStoredUsage(panelId?: string): { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number } | null {
    const session = this._getSession(panelId) as CodexSessionState;
    const usage = session.lastUsageStats;
    session.lastUsageStats = null;
    return usage;
  }

  async checkAuthentication(): Promise<AuthStatus> {
    const auth = await this.getAuthConfig();
    if (!auth.isAuthenticated) {
      // Check if OPENAI_API_KEY env var is set as alternative
      if (process.env.OPENAI_API_KEY) {
        return {
          authenticated: true,
          user: 'API Key'
        };
      }
      return {
        authenticated: false,
        error: 'Not authenticated. Please run "codex auth login" to sign in with your ChatGPT account, or set OPENAI_API_KEY environment variable.'
      };
    }

    // Try to get user info from config
    try {
      if (auth.configPath && fs.existsSync(auth.configPath)) {
        const configContent = fs.readFileSync(auth.configPath, 'utf-8');
        // TOML parsing - look for email or user field
        const emailMatch = configContent.match(/email\s*=\s*["']?([^"'\n]+)["']?/);
        const userMatch = configContent.match(/user\s*=\s*["']?([^"'\n]+)["']?/);
        return {
          authenticated: true,
          user: emailMatch?.[1] || userMatch?.[1] || 'Authenticated'
        };
      }
    } catch {
      // Config exists but couldn't parse - still authenticated
    }

    return { authenticated: true };
  }

  getAuthCommand(): string {
    return 'codex auth login';
  }

  getInstallCommand(): string {
    return 'npm install -g @openai/codex';
  }

  /**
   * Override clearSession to also clear tool state
   */
  clearSession(panelId?: string): void {
    super.clearSession(panelId);
    if (panelId) {
      const session = this._panelSessions.get(panelId) as CodexSessionState | undefined;
      if (session) {
        session.activeToolCalls.clear();
        session.completedToolCalls.clear();
      }
    }
  }

  /**
   * Override buildPrompt to skip mode instructions
   * Codex's --sandbox flags handle access control at CLI level,
   * so we don't need prompt-level mode instructions that cause
   * verbose planning responses for simple messages
   */
  protected buildPrompt(
    content: string,
    context: ContextItem[],
    conversation: Conversation | null,
    _settings: Settings,
    persona?: PersonaConfig
  ): string {
    // Slash commands should be sent raw to the CLI without any modifications
    // They are native CLI commands like /init, /compact, /help, etc.
    if (content.trim().startsWith('/')) {
      return content.trim();
    }

    let fullPrompt = '';

    // Add persona instructions if provided (for brainstorm mode)
    if (persona) {
      const personaPrompt = this.getPersonaPrompt(persona);
      if (personaPrompt) {
        fullPrompt += personaPrompt + '\n\n';
      }
    }

    // Add context if present
    if (context.length > 0) {
      fullPrompt += this.formatContext(context);
      fullPrompt += '\n\n';
    }

    // Add conversation history
    if (conversation && conversation.messages.length > 0) {
      fullPrompt += this.formatConversationHistory(conversation);
      fullPrompt += '\n\n';
    }

    // Add the current message - NO mode instructions appended
    fullPrompt += content;

    return fullPrompt;
  }

  // Plan 18 (Wave 3 / providers H1): the bespoke sendMessage override is GONE.
  // It re-implemented the spawn loop and silently missed the base-path
  // hardening: Windows auto-shell (.cmd shims -> spawn EINVAL), the shell-mode
  // arg injection gate + bracket quoting, the early spawn 'error' listener,
  // kill-in-finally for abandoned generators, attachment lifecycle, and the
  // three-tier agentConfig (personas/skills never reached Codex). The base
  // _sendSingleShot now drives codex exec: buildCliArgs supplies the args
  // (with the stdin marker), buildPromptAsync folds in channel context the
  // same way as every other base-path provider (the old native
  // `-c developer_instructions=` injection was ALSO the unquoted shell-mode
  // injection vector), and parseStreamLine handles the JSONL events.
  // Behavioral delta (accepted): the base surfaces a non-zero exit as an
  // error chunk even after answer text was produced, where the old
  // _processCodexStream stayed silent.

  /**
   * Build Codex-specific CLI arguments
   *
   * Key flags from codex exec --help:
   * - --sandbox, -s: read-only | workspace-write | danger-full-access
   * - --full-auto: workspace-write sandbox with auto-approve on request
   * - --dangerously-bypass-approvals-and-sandbox: skip all confirmations (DANGEROUS)
   * - --json: output JSONL events to stdout
   * - --model, -m: override configured model
   * - --skip-git-repo-check: allow running outside git repo
   */
  private _buildCodexArgs(settings: Settings): string[] {
    const args: string[] = ['exec'];

    // Always use JSON mode for structured streaming output
    args.push('--json');

    // Map Mysti settings to Codex sandbox flags
    // Priority: mode restrictions first, then access level
    this._addSandboxFlags(args, settings);

    // Add profile if configured
    const profile = this._getProfile();
    if (profile) {
      args.push('--profile', profile);
    }

    // Add model selection (custom model override or dropdown selection)
    const effectiveModel = this._getEffectiveModel(settings);
    if (effectiveModel) {
      args.push('--model', effectiveModel);
    }

    // Reasoning effort → model_reasoning_effort config override. Codex tops out
    // at xhigh (max clamps down). The quotes are part of the TOML value the
    // `-c` parser reads (no shell involved — the literal chars reach codex).
    const effort = clampEffort(settings.effortLevel, CODEX_EFFORT_LEVELS);
    if (effort) {
      args.push('-c', `model_reasoning_effort="${effort}"`);
    }

    // Skip git repo check - useful if workspace isn't a git repo
    args.push('--skip-git-repo-check');

    return args;
  }

  /**
   * Get thinking tokens based on thinking level
   * Codex doesn't use MAX_THINKING_TOKENS - reasoning is controlled by config
   */
  protected getThinkingTokens(_thinkingLevel: string): number | undefined {
    // Codex doesn't use MAX_THINKING_TOKENS env var
    // Reasoning is controlled by model_reasoning_effort in config.toml
    return undefined;
  }

  /**
   * Add sandbox flags based on mode and access level
   * Maps Mysti settings to Codex CLI sandbox modes
   */
  private _addSandboxFlags(args: string[], settings: Settings): void {
    const { mode, accessLevel } = settings;

    // Plan modes → always read-only regardless of access level
    if (mode === 'quick-plan' || mode === 'detailed-plan') {
      args.push('--sandbox', 'read-only');
      console.log(`[Mysti] Codex: Using read-only sandbox (${mode})`);
      return;
    }

    // Read-only access level → read-only sandbox regardless of operation mode
    if (accessLevel === 'read-only') {
      args.push('--sandbox', 'read-only');
      console.log('[Mysti] Codex: Using read-only sandbox (read-only access level)');
      return;
    }

    // More-restrictive-wins: only bypass when BOTH mode and access allow it
    // edit-automatically + full-access = bypass all approvals and sandboxing
    if (mode === 'edit-automatically' && accessLevel === 'full-access') {
      args.push('--dangerously-bypass-approvals-and-sandbox');
      console.log('[Mysti] Codex: Bypassing all approvals and sandbox (edit-automatically + full-access)');
      return;
    }

    // default mode + full-access = full-auto (no explicit edit restriction)
    if (mode === 'default' && accessLevel === 'full-access') {
      args.push('--full-auto');
      console.log('[Mysti] Codex: Using full-auto mode (default + full-access)');
      return;
    }

    // All other combinations: bypass CLI permissions to prevent stdin hang.
    // The stream-level tool-use gate in ChatViewProvider handles permission prompts.
    args.push('--full-auto');
    console.log(`[Mysti] Codex: Bypassing CLI permissions (stream gate handles UI prompts) [mode=${mode}, access=${accessLevel}]`);
  }

  /**
   * Parse a Codex JSONL event line
   */
  private _parseCodexEvent(line: string, session: CodexSessionState): StreamChunk | null {
    try {
      const event = JSON.parse(line);

      // Handle different Codex event types
      switch (event.type) {
        // Thread/session events
        case 'thread.started':
          if (event.thread_id) {
            session.sessionId = event.thread_id;
            return { type: 'session_active', sessionId: event.thread_id };
          }
          return null;

        case 'turn.completed': {
          // Turn completed - store usage stats for retrieval by getStoredUsage()
          const usage = event.usage || event.turn?.usage;
          if (usage) {
            session.lastUsageStats = {
              input_tokens: usage.input_tokens || usage.prompt_tokens || 0,
              output_tokens: usage.output_tokens || usage.completion_tokens || 0,
              // Codex uses cached_input_tokens, map to cache_read_input_tokens
              cache_read_input_tokens: usage.cached_input_tokens
            };
          }
          return null; // Don't return done here - let sendMessage handle it
        }

        case 'turn.failed': {
          // event.error may be a raw object ({ message, ... }) — stringify
          // safely so the webview never renders "[object Object]" (Plan 18 4.6a).
          const rawError: unknown = event.error;
          let content: string;
          if (typeof rawError === 'string' && rawError) {
            content = rawError;
          } else if (rawError && typeof rawError === 'object'
              && typeof (rawError as { message?: unknown }).message === 'string'
              && (rawError as { message: string }).message) {
            content = (rawError as { message: string }).message;
          } else if (rawError !== undefined && rawError !== null && rawError !== '') {
            try {
              content = JSON.stringify(rawError);
            } catch {
              content = 'Turn failed';
            }
          } else {
            content = 'Turn failed';
          }
          return { type: 'error', content };
        }

        // Item events - these contain the actual content
        case 'item.started':
        case 'item.updated':
        case 'item.completed':
          // All item events go through the same parser
          // - item.started: emits tool_use with status 'running'
          // - item.updated: emits deltas for streaming content
          // - item.completed: emits tool_result with status 'completed'
          return this._parseCodexItem(event, session);

        // Direct error event
        case 'error':
          return { type: 'error', content: event.message || event.error || 'Unknown error' };

        default:
          // Try to extract content from unknown event types.
          // Plan 02 Phase 3: never reclassify plain agent text as thinking —
          // only reasoning items (handled in _parseCodexItem) yield thinking
          // chunks. Bold ("**…**") agent text is legitimate markdown body.
          if (event.content || event.text || event.message) {
            const content = event.content || event.text || event.message;
            return { type: 'text', content };
          }
          return null;
      }
    } catch {
      // If it's not JSON, treat as plain text output (never thinking — see above)
      if (line.trim()) {
        return { type: 'text', content: line };
      }
    }

    return null;
  }

  /**
   * Parse a Codex item event into a StreamChunk
   * Improved to handle delta updates for streaming and proper tool state tracking
   */
  /* eslint-disable @typescript-eslint/no-explicit-any -- Codex emits deeply nested dynamic JSON */
  private _parseCodexItem(event: Record<string, any>, session: CodexSessionState): StreamChunk | null {
    const item = (event.item || event) as Record<string, any>;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const itemType = item.type || item.item_type;
    const eventType = event.type; // 'item.updated' vs 'item.completed'

    console.log('[Mysti] Codex item event:', JSON.stringify({ eventType, itemType, item: item }));

    switch (itemType) {
      case 'agent_message':
      case 'message': {
        // Codex sends full text in item.text, not streaming deltas
        const text = item.text || item.content || item.message || '';
        if (text) {
          return { type: 'text', content: text };
        }
        return null;
      }

      case 'reasoning':
      case 'thinking': {
        // Codex sends reasoning as item.text, not streaming deltas
        let thinking = item.text || item.content || item.reasoning || '';
        console.log('[Mysti] Codex thinking raw:', JSON.stringify(thinking));
        if (thinking) {
          // Clean up thinking: remove ** from beginning and end, add newline
          thinking = thinking.replace(/^\*\*/, '').replace(/\*\*$/, '').trim() + '\n';
          console.log('[Mysti] Codex thinking cleaned:', JSON.stringify(thinking));
          return { type: 'thinking', content: thinking };
        }
        return null;
      }

      case 'command_execution':
      case 'shell': {
        // Shell command handling - Codex uses 'command' and 'aggregated_output'
        const toolId = item.id || `tool-${Date.now()}`;

        // DEDUPLICATION: Skip if this tool has already completed
        if (session.completedToolCalls.has(toolId)) {
          return null;
        }

        // Normalize to 'Bash' to match Claude's tool naming
        const toolName = 'Bash';

        // Codex uses 'command' field for the shell command
        const input: Record<string, unknown> = {
          command: item.command || ''
        };

        // Codex uses exit_code and status for completion detection.
        // A completion WITHOUT an exit_code (null/undefined) is success-unknown,
        // NOT a failure — only status:'failed' or an explicit non-zero exit code
        // marks failure (Plan 18 4.6b: `undefined !== null && undefined !== 0`
        // used to flag exit-code-less item.completed events as failed).
        const hasExitCode = item.exit_code !== null && item.exit_code !== undefined;
        const isCompleted = eventType === 'item.completed' ||
                           item.status === 'completed' ||
                           hasExitCode;
        const isFailed = item.status === 'failed' || (hasExitCode && item.exit_code !== 0);

        if (isCompleted) {
          // Mark as completed to prevent duplicate tool_result emissions
          session.completedToolCalls.add(toolId);
          session.activeToolCalls.delete(toolId);
          return {
            type: 'tool_result',
            toolCall: {
              id: toolId,
              name: toolName,
              input,
              output: item.aggregated_output || item.error || '',  // Codex uses aggregated_output
              status: isFailed ? 'failed' : 'completed'
            }
          };
        } else {
          // Only emit tool_use if not already active (prevent duplicate running events)
          if (session.activeToolCalls.has(toolId)) {
            return null;
          }
          session.activeToolCalls.set(toolId, {
            id: toolId,
            name: toolName,
            inputJson: JSON.stringify(input),
            status: 'running'
          });
          return {
            type: 'tool_use',
            toolCall: {
              id: toolId,
              name: toolName,
              input,
              status: 'running',
              kind: toolKind(toolName)
            }
          };
        }
      }

      case 'mcp_tool_call':
      case 'tool_call':
      case 'function_call': {
        // Generic tool call handling (MCP tools, function calls)
        const toolId = item.id || item.call_id || `tool-${Date.now()}`;

        // DEDUPLICATION: Skip if this tool has already completed
        if (session.completedToolCalls.has(toolId)) {
          return null;
        }

        const toolName = item.name || item.tool || item.function?.name || 'tool';
        const input = item.arguments || item.input || item.function?.arguments || {};

        // Detect ask_user-style tools and convert to ask_user_question chunk
        if ((toolName === 'ask_user' || toolName === 'AskUserQuestion' || toolName === 'ask_user_question') &&
            input.questions && Array.isArray(input.questions)) {
          console.log('[Mysti] Codex: Detected ask_user tool, converting to ask_user_question chunk');
          return {
            type: 'ask_user_question',
            askUserQuestion: {
              toolCallId: toolId,
              questions: (input.questions as Array<Record<string, unknown>>).map((q) => ({
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

        // Determine if this is a completion event
        const isCompleted = eventType === 'item.completed' ||
                           item.status === 'completed' ||
                           item.output !== undefined ||
                           item.result !== undefined;
        const isFailed = item.status === 'failed' || item.error;

        if (isCompleted || isFailed) {
          // Mark as completed to prevent duplicate tool_result emissions
          session.completedToolCalls.add(toolId);
          session.activeToolCalls.delete(toolId);
          return {
            type: 'tool_result',
            toolCall: {
              id: toolId,
              name: toolName,
              input,
              output: item.output || item.result || item.error,
              status: isFailed ? 'failed' : 'completed'
            }
          };
        } else {
          // Only emit tool_use if not already active (prevent duplicate running events)
          if (session.activeToolCalls.has(toolId)) {
            return null;
          }
          session.activeToolCalls.set(toolId, {
            id: toolId,
            name: toolName,
            inputJson: JSON.stringify(input),
            status: 'running'
          });
          return {
            type: 'tool_use',
            toolCall: {
              id: toolId,
              name: toolName,
              input,
              status: 'running',
              kind: toolKind(toolName)
            }
          };
        }
      }

      case 'file_change':
      case 'file_edit':
      case 'write':
      case 'edit': {
        // File modification with structured format for edit report cards
        const fileId = item.id || `file-${Date.now()}`;

        // DEDUPLICATION: Skip if this file operation has already completed
        if (session.completedToolCalls.has(fileId)) {
          return null;
        }

        const filePath = item.file_path || item.path || item.file || '';

        // Determine tool name based on operation type
        const toolName = (itemType === 'write' || item.operation === 'create') ? 'Write' : 'Edit';

        // Build structured input for edit report cards
        const input: Record<string, unknown> = {
          file_path: filePath
        };

        // For edits, include old/new strings for diff display
        if (toolName === 'Edit') {
          input.old_string = item.old_content || item.original || '';
          input.new_string = item.new_content || item.replacement || item.content || '';
        } else {
          // For writes, include full content
          input.content = item.content || item.new_content || '';
        }

        // Determine if this is a completion event
        const isCompleted = eventType === 'item.completed' || item.status === 'completed';
        const isFailed = item.status === 'failed' || item.error;

        if (isCompleted || isFailed) {
          // Mark as completed to prevent duplicates
          session.completedToolCalls.add(fileId);
          return {
            type: 'tool_result',
            toolCall: {
              id: fileId,
              name: toolName,
              input,
              output: isFailed ? (item.error || 'File operation failed') : 'File updated successfully',
              status: isFailed ? 'failed' : 'completed'
            }
          };
        } else {
          // Only emit tool_use if not already active
          if (session.activeToolCalls.has(fileId)) {
            return null;
          }
          session.activeToolCalls.set(fileId, {
            id: fileId,
            name: toolName,
            inputJson: JSON.stringify(input),
            status: 'running'
          });
          return {
            type: 'tool_use',
            toolCall: {
              id: fileId,
              name: toolName,
              input,
              status: 'running',
              kind: toolKind(toolName)
            }
          };
        }
      }

      case 'web_search': {
        // Web search with proper status tracking
        const searchId = item.id || `search-${Date.now()}`;

        // DEDUPLICATION: Skip if this search has already completed
        if (session.completedToolCalls.has(searchId)) {
          return null;
        }

        const searchInput = { query: item.query || item.content };

        // Determine if this is a completion event
        const isCompleted = eventType === 'item.completed' || item.status === 'completed' || item.results;
        const isFailed = item.status === 'failed' || item.error;

        if (isCompleted || isFailed) {
          // Mark as completed to prevent duplicates
          session.completedToolCalls.add(searchId);
          return {
            type: 'tool_result',
            toolCall: {
              id: searchId,
              name: 'web_search',
              input: searchInput,
              output: item.results ? JSON.stringify(item.results, null, 2) : item.error,
              status: isFailed ? 'failed' : 'completed'
            }
          };
        } else {
          // Only emit tool_use if not already active
          if (session.activeToolCalls.has(searchId)) {
            return null;
          }
          session.activeToolCalls.set(searchId, {
            id: searchId,
            name: 'web_search',
            inputJson: JSON.stringify(searchInput),
            status: 'running'
          });
          return {
            type: 'tool_use',
            toolCall: {
              id: searchId,
              name: 'web_search',
              input: searchInput,
              status: 'running',
              kind: toolKind('web_search')
            }
          };
        }
      }

      case 'todo_list': {
        // Task tracking - emit as text for now
        if (item.todos && Array.isArray(item.todos)) {
          const todoText = item.todos.map((t: Record<string, unknown>) =>
            `- [${t.status === 'completed' ? 'x' : ' '}] ${t.content}`
          ).join('\n');
          return { type: 'text', content: `\n**Tasks:**\n${todoText}\n` };
        }
        return null;
      }

      default: {
        // Check if this is reasoning/thinking content in a different structure.
        // Plan 02 Phase 3: ONLY explicit reasoning items/fields become thinking
        // chunks. The old "**…**"-wrapped-text heuristic misclassified bold
        // markdown in plain agent text as thinking — removed.
        if (item.reasoning) {
          let thinking = item.reasoning;
          thinking = thinking.replace(/^\*\*/, '').replace(/\*\*$/, '').trim() + '\n';
          return { type: 'thinking', content: thinking };
        }

        // Try to extract text content from unknown item types
        // Check delta first for streaming
        if (item.delta?.content) {
          return { type: 'text', content: item.delta.content };
        }
        const content = item.content || item.text || item.message;
        if (content && typeof content === 'string') {
          return { type: 'text', content };
        }
        return null;
      }
    }
  }

  /**
   * Get the effective model, preferring provider-specific custom model over dropdown selection
   */
  protected _getEffectiveModel(settings: Settings): string | undefined {
    // P2.3/P0.2b: an explicitly routed model wins over the per-provider custom-model config.
    if (settings.routedModel) { return settings.routedModel; }
    const config = vscode.workspace.getConfiguration('mysti');
    const customModel = config.get<string>('codexModel', '');
    if (customModel) {
      const validation = validateModelName(customModel);
      if (validation.valid) {
        console.log(`[Mysti] Codex: Using custom model: ${customModel}`);
        return customModel;
      }
      console.warn(`[Mysti] Codex: Invalid custom model "${customModel}": ${validation.error}`);
    }
    // Fall back to dropdown selection, but only if it's a Codex model — the
    // global defaultModel may belong to another provider (cross-provider guard).
    // Genuine custom Codex models go through the `codexModel` setting above
    // (now unblocked by the relaxed validation pattern — #39). Full pass-through
    // of arbitrary dropdown models is deferred to pair with the per-provider
    // model memory (Plan 02 Phase 6, #33) so a leaked cross-provider model
    // can't reach the CLI and hard-fail.
    if (settings.model) {
      const validCodexModels = this.config.models.map(m => m.id);
      if (validCodexModels.includes(settings.model)) {
        // Built-in: preserve the "default model ⇒ omit --model flag" special case
        return settings.model !== this.config.defaultModel ? settings.model : undefined;
      }
      console.warn(`[Mysti] Codex: Ignoring non-Codex model "${settings.model}" (use the codexModel setting for a custom Codex model); using CLI default.`);
    }
    return undefined;
  }

  /**
   * Get the Codex profile from settings
   */
  private _getProfile(): string | undefined {
    const config = vscode.workspace.getConfiguration('mysti');
    const profile = config.get<string>('codexProfile', '');
    if (profile) {
      const validation = validateProfileName(profile);
      if (validation.valid) {
        console.log(`[Mysti] Codex: Using profile: ${profile}`);
        return profile;
      }
      console.warn(`[Mysti] Codex: Invalid profile "${profile}": ${validation.error}`);
    }
    return undefined;
  }

  // These methods are required by abstract base but we override sendMessage
  protected buildCliArgs(settings: Settings, _session: PanelSessionState): string[] {
    // Plan 18 (Wave 3): the base single-shot path sends the prompt via stdin;
    // `-` tells `codex exec` to read it from there (this used to live in the
    // deleted sendMessage override).
    return [...this._buildCodexArgs(settings), '-'];
  }

  protected parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    return this._parseCodexEvent(line, session as CodexSessionState);
  }

}
