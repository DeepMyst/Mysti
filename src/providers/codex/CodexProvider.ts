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
  AgentConfiguration,
  Attachment,
  StreamChunk,
  ProviderConfig,
  ContextItem,
  Conversation,
  AuthStatus
} from '../../types';
import { validateModelName, validateProfileName } from '../../utils/validation';
import { getEnrichedEnv } from '../../utils/platform';
import { toolKind } from '../../utils/toolNames';
import { CodexAppServer, CODEX_APP_SERVER_VERSION } from './CodexAppServer';
import { captureCodexNativeConfig, assertCodexServerConfigSafe, CODEX_NATIVE_CONFIG_OVERRIDES } from './CodexNativeConfig';
import { killProcessTree } from '../../utils/processKill';
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
 * Uses the pinned app-server protocol for native command and patch approvals
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
        // Available in the bundled native picker since 0.153.4. Account model
        // availability still governs use; this fallback is not an entitlement.
        id: 'gpt-6-astra',
        name: 'GPT-6 Astra',
        description: 'Flagship reasoning and coding model; availability depends on your account',
        contextWindow: 1050000,
        releasedAt: '2026-09-03'
      },
      {
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        description: 'Flagship for complex coding, computer use, research and cybersecurity',
        contextWindow: 1100000
      },
      {
        id: 'gpt-5.6-terra',
        name: 'GPT-5.6 Terra',
        description: 'Balanced everyday work — the successor to GPT-5.4',
        contextWindow: 1100000
      },
      {
        id: 'gpt-5.6-luna',
        name: 'GPT-5.6 Luna',
        description: 'Fastest and most affordable — the successor to GPT-5.4 mini',
        contextWindow: 1100000
      },
      // This entry has no published context window. Leaving it undefined
      // falls back to 200k, which only makes compaction fire EARLIER than
      // needed — the safe direction. Overstating a window instead overflows the
      // model and hard-fails the turn, so never guess upward here.
      {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        description: 'Previous flagship; ChatGPT sign-in support ends October 14, 2026'
      }
    ],
    defaultModel: 'gpt-5.6-sol'
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsThinking: true, // Codex has 'reasoning' events
    supportsToolUse: true,
    toolExecution: 'native',
    supportsSessions: true,  // Fresh native threads preserve conversation through prompt history
    // Plan 27 Phase 5: attachments are written to a temp file and referenced
    // by PATH (BaseCliProvider.prepareAttachments). This backend has file-read
    // tools, so it can open what it is given.
    supportsImages: true,
    supportsAutoInstall: true,
    supportsPromptEnhancement: false,
    supportsNativeApproval: true,
    // Plan 02 Phase 1 capability matrix
    thinkingStyle: 'complete-blocks',  // whole 'reasoning' blocks per event
    thinkingLevelEffective: false,     // getThinkingTokens returns undefined
    effortLevels: CODEX_EFFORT_LEVELS, // model_reasoning_effort (low→xhigh)
    effortDefault: 'medium',
    planMode: 'detected',
    sessionKind: 'prompt-history',     // no actual resume today (F15) — history replayed into the prompt
    emitsToolResults: true,
    emitsUsage: true,
    usageConvention: 'openai',   // Codex reports cached_input_tokens as a SUBSET of input_tokens (OpenAI convention).
    modelSelection: 'full'
  };

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
        error: 'Not authenticated. Please run "codex login" to sign in with your ChatGPT account, or set OPENAI_API_KEY environment variable.'
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
    return 'codex login';
  }

  getInstallCommand(): string {
    return `npm install -g @openai/codex@${CODEX_APP_SERVER_VERSION}`;
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
   * The captured native sandbox and approval policy enforce access control,
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

  /** Native app-server is the only public execution transport. */
  protected async *_sendNativeTurn(
    content: string, context: ContextItem[], settings: Settings,
    conversation: Conversation | null, baseSession: PanelSessionState,
    persona?: PersonaConfig, agentConfig?: AgentConfiguration, attachments?: Attachment[],
  ): AsyncGenerator<StreamChunk> {
    const session = baseSession as CodexSessionState;
    const snapshot = { ...(this._requestSettings(session) ?? settings) };
    const signal = this._requestSignal(session);
    if (!signal || signal.aborted) { return; }
    session.activeToolCalls.clear(); session.completedToolCalls.clear(); session.lastUsageStats = null;
    const cliPath = this.getCliPath();
    const args = this.buildCliArgs(snapshot, session);
    const model = this._getEffectiveModel(snapshot);
    const effort = clampEffort(snapshot.effortLevel, CODEX_EFFORT_LEVELS);
    const handler = this._requestNativeHandler(session);
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const env = getEnrichedEnv();
    let cleanup: (() => Promise<void>) | null = null;
    let client: CodexAppServer | undefined;
    let processHandle: ReturnType<typeof this._spawnCliProcess> | undefined;
    let killing: Promise<void> | undefined;
    const terminate = () => {
      if (processHandle && !killing) {
        killing = killProcessTree(processHandle, 250, { label: 'Codex native app-server' });
      }
    };
    try {
      const nativeConfig = await captureCodexNativeConfig(cwd, env);
      if (!this._isCurrentRequest(session, signal)) { return; }
      cleanup = await this.prepareAttachments(attachments, args);
      if (!this._isCurrentRequest(session, signal)) { return; }
      const prompt = await this.buildPromptAsync(
        content, context, this._conversationForPrompt(session, conversation), snapshot,
        persona, agentConfig, attachments, session.channelSystemContext,
      );
      if (!this._isCurrentRequest(session, signal)) { return; }
      processHandle = this._spawnCliProcess(args, cwd, env, cliPath);
      session.process = processHandle;
      client = new CodexAppServer({
        process: processHandle, panelId: session.panelId, signal, handler, settings: snapshot,
        isCurrent: () => this._isCurrentRequest(session, signal) && session.process === processHandle,
        terminate,
      });
      let stderr = '';
      processHandle.stderr?.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4000); });
      await client.initialize();
      await client.verifyConfiguration(assertCodexServerConfigSafe, cwd);
      await client.startThread({
        cwd, ...(model ? { model } : {}), ephemeral: true,
        approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: 'read-only',
        environments: [], dynamicTools: [], selectedCapabilityRoots: [],
      });
      if (!this._isCurrentRequest(session, signal)) { return; }
      await client.verifyConfiguration(assertCodexServerConfigSafe, cwd);
      await nativeConfig.assertUnchanged();
      if (!this._isCurrentRequest(session, signal)) { return; }
      session.sessionId = client.threadId ?? null;
      await client.startTurn({
        input: [
          { type: 'text', text: prompt, text_elements: [] },
          ...(attachments ?? []).filter(attachment => attachment.type === 'image' && attachment.filePath).map(attachment => ({ type: 'localImage', path: attachment.filePath })),
        ],
        cwd, ...(model ? { model } : {}), ...(effort ? { effort } : {}),
        approvalPolicy: 'untrusted', approvalsReviewer: 'user',
        sandboxPolicy: { type: 'readOnly', networkAccess: false }, environments: [],
      });
      for await (const chunk of client.stream()) {
        if (!this._isCurrentRequest(session, signal)) { break; }
        if (chunk.type === 'error' && stderr) { chunk.content += ` ${stderr}`; }
        yield chunk;
      }
      if (client.usage && this._isCurrentRequest(session, signal)) { session.lastUsageStats = client.usage; }
    } finally {
      client?.dispose(); terminate();
      if (killing) { await killing; }
      if (session.process === processHandle) { session.process = null; }
      await cleanup?.();
    }
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

  protected buildCliArgs(settings: Settings, _session: PanelSessionState): string[] {
    const args = ['app-server', '--listen', 'stdio://', ...CODEX_NATIVE_CONFIG_OVERRIDES.flatMap(value => ['-c', value])];
    const profile = this._getProfile();
    if (profile) { throw new Error('Codex native approvals do not support named CLI profiles. Clear the Mysti Codex profile setting before starting this turn.'); }
    const effort = clampEffort(settings.effortLevel, CODEX_EFFORT_LEVELS);
    if (effort) { args.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`); }
    return args;
  }

  protected parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    return this._parseCodexEvent(line, session as CodexSessionState);
  }

}
