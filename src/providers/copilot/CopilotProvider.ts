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
import type { PanelSessionState } from '../base/BaseCliProvider';
import { AcpNativeProvider } from '../base/AcpNativeProvider';
import type { AcpNativeLaunchContext, AcpNativeLaunch } from '../base/AcpNativeTypes';
import { prepareCopilotAcpLaunch, copilotAcpArgs } from './CopilotAcp';
import type {
  CliDiscoveryResult,
  AuthConfig,
  ProviderCapabilities,
} from '../base/IProvider';
import type {
  Settings,
  StreamChunk,
  ProviderConfig,
  AuthStatus,
  ModelInfo
} from '../../types';
import { validateModelName } from '../../utils/validation';
import { toolKind } from '../../utils/toolNames';


const COPILOT_EFFORT_LEVELS: import('../../types').EffortLevel[] = ['low', 'medium', 'high', 'xhigh'];

export interface CopilotSessionState extends PanelSessionState {
  activeToolCalls: Map<string, { id: string; name: string; input: Record<string, unknown> }>;
  lastUsageStats: { input_tokens: number; output_tokens: number } | null;
}

/**
 * GitHub Copilot CLI provider implementation
 * Supports copilot-cli for AI-powered code assistance with GitHub integration
 */
export class CopilotProvider extends AcpNativeProvider {
  readonly id = 'github-copilot';
  readonly displayName = 'GitHub Copilot';

  readonly config: ProviderConfig = {
    name: 'github-copilot',
    displayName: 'GitHub Copilot',
    models: [
      {
        id: 'gpt-6-astra',
        name: 'GPT-6 Astra',
        description: 'OpenAI flagship — Copilot Pro+, Max, Business and Enterprise',
        contextWindow: 1050000,
        releasedAt: '2026-09-04'
      },
      {
        id: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        description: 'Best balance of speed and intelligence',
        contextWindow: 1000000
      },
      {
        id: 'claude-opus-5',
        name: 'Claude Opus 5',
        description: 'Anthropic flagship for complex agentic and coding work',
        contextWindow: 1000000
      },
      {
        id: 'claude-fable-5.1',
        name: 'Claude Fable 5.1',
        description: "Anthropic's most capable model",
        contextWindow: 1000000,
        releasedAt: '2026-09-01'
      },
      {
        id: 'claude-fable-5',
        name: 'Claude Fable 5',
        description: 'Previous Fable flagship',
        contextWindow: 1000000
      },
      {
        id: 'claude-opus-4.8',
        name: 'Claude Opus 4.8',
        description: 'Previous-generation Opus flagship',
        contextWindow: 1000000
      },
      {
        id: 'claude-opus-4.7',
        name: 'Claude Opus 4.7',
        description: 'Autonomous long-horizon Opus',
        contextWindow: 1000000
      },
      {
        id: 'claude-haiku-4.5',
        name: 'Claude Haiku 4.5',
        description: 'Fast and efficient for simpler tasks',
        contextWindow: 200000
      },
      {
        id: 'gemini-3.8-flash',
        name: 'Gemini 3.8 Flash',
        description: "Google's most intelligent Flash model",
        contextWindow: 1048576,
        releasedAt: '2026-09-02'
      },
      {
        id: 'gemini-3.7-flash',
        name: 'Gemini 3.7 Flash',
        description: 'Strong coding and agent workflows',
        contextWindow: 1048576
      },
      {
        id: 'gpt-5.1',
        name: 'GPT-5.1',
        description: 'Previous-generation OpenAI model',
        contextWindow: 400000
      },
      {
        id: 'gpt-4.1',
        name: 'GPT-4.1',
        description: 'Legacy model, included in all paid plans',
        contextWindow: 128000
      }
    ],
    defaultModel: 'claude-sonnet-5'
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsThinking: false,
    // The pinned ACP runtime is restricted to native read/search tools.
    supportsToolUse: true,
    toolExecution: 'native',
    supportsNativeApproval: true,
    supportsSessions: true,
    supportsAutoInstall: true,
    supportsPromptEnhancement: false,
    // Plan 02 Phase 1 capability matrix
    thinkingStyle: 'none',
    thinkingLevelEffective: false,
    effortLevels: COPILOT_EFFORT_LEVELS,  // --effort (low→xhigh)
    effortDefault: 'medium',
    planMode: 'detected',
    sessionKind: 'prompt-history',  // Fresh native ACP session per turn.
    emitsToolResults: true,         // 1.0 JSONL: tool.execution_complete carries the result
    // Copilot reports no honest token count on EITHER path: 1.0's JSONL carries
    // `session.usage_checkpoint`, which bills in nano AIU rather than tokens
    // (deliberately dropped in parseStreamLine), and 0.0.x streams plain text
    // with no usage event at all. Declaring true meant the context pie kept
    // whatever the previously-active provider had left in it.
    emitsUsage: false,
    usageConvention: 'none',   // Copilot bills in nano AIU; no token split exists to report.
    modelSelection: 'full'
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

  async discoverModels(_timeoutMs: number): Promise<ModelInfo[] | null> {
    // BYOK selects its own model. Do not execute an unisolated native --help
    // wrapper just to populate a subscription-only model catalogue.
    return null;
  }

  protected _getCliCommandName(): string {
    return 'copilot';
  }

  protected _getConfiguredCliPath(): string {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<string>('copilotPath', 'copilot');
  }

  async getAuthConfig(): Promise<AuthConfig> {
    const authenticated = !!process.env.COPILOT_PROVIDER_BASE_URL?.trim();
    return { type: 'api-key', isAuthenticated: authenticated, configPath: '' };
  }

  async checkAuthentication(): Promise<AuthStatus> {
    const auth = await this.getAuthConfig();
    return auth.isAuthenticated
      ? { authenticated: true, user: 'Copilot custom model provider' }
      : { authenticated: false, error: 'Native approvals require COPILOT_PROVIDER_BASE_URL (BYOK) in the extension environment. GitHub-token and stored-login sessions can load unobservable managed execution policy and are not supported.' };
  }

  getAuthCommand(): string {
    return 'copilot'; // Use /login command within the CLI
  }

  getInstallCommand(): string {
    return 'npm install -g @github/copilot@1.0.83';
  }

  protected buildCliArgs(settings: Settings, _session: PanelSessionState): string[] {
    return copilotAcpArgs(settings, this._getEffectiveModel(settings));
  }

  protected _prepareAcpLaunch(context: AcpNativeLaunchContext): Promise<AcpNativeLaunch> {
    return prepareCopilotAcpLaunch(context, this._getEffectiveModel(context.settings));
  }


  /**
   * Get the effective model, preferring provider-specific custom model over dropdown selection
   */
  protected _getEffectiveModel(settings: Settings): string | undefined {
    // P2.3/P0.2b: an explicitly routed model wins over the per-provider custom-model config.
    if (settings.routedModel) { return settings.routedModel; }
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
   * Copilot CLI 1.0 stream events.
   *
   * Returns `undefined` for an event this vocabulary does not cover, so the
   * caller falls through to the older shapes; `null` means "handled, nothing to
   * render". The two are NOT interchangeable here.
   */
  private _parseModernEvent(
    data: Record<string, unknown>,
    session: CopilotSessionState
  ): StreamChunk | null | undefined {
    const type = typeof data.type === 'string' ? data.type : '';
    if (!type.includes('.')) {
      return undefined;
    }
    const payload = (data.data ?? {}) as Record<string, unknown>;

    switch (type) {
      // The delta. `assistant.message` repeats the whole answer afterwards, so
      // rendering both would print it twice.
      case 'assistant.message_delta': {
        const delta = payload.deltaContent;
        return typeof delta === 'string' && delta ? { type: 'text', content: delta } : null;
      }

      case 'tool.execution_start': {
        const id = String(payload.toolCallId ?? `copilot-${Date.now()}`);
        const name = String(payload.toolName ?? 'tool');
        const input = (payload.arguments ?? {}) as Record<string, unknown>;
        session.activeToolCalls.set(id, { id, name, input });
        // This is what Mysti's permission gate intercepts. Copilot had no such
        // event before 1.0, which is why the gate could never fire for it.
        return { type: 'tool_use', toolCall: { id, name, input, status: 'running' } };
      }

      case 'tool.execution_complete': {
        const id = String(payload.toolCallId ?? '');
        const active = session.activeToolCalls.get(id);
        session.activeToolCalls.delete(id);
        const result = (payload.result ?? {}) as Record<string, unknown>;
        const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content ?? '');
        return {
          type: 'tool_result',
          toolCall: {
            id,
            name: active?.name ?? String(payload.toolName ?? 'tool'),
            input: active?.input ?? {},
            output: content,
            status: payload.success === false ? 'failed' : 'completed',
          },
        };
      }

      case 'session.usage_checkpoint': {
        // Copilot bills in "nano AIU" rather than tokens; there is no honest
        // token count to report, so nothing is stored and nothing is rendered.
        return null;
      }

      // Streamed piecemeal by assistant.tool_call_delta and delivered whole by
      // tool.execution_start — the partial JSON fragments are not renderable.
      case 'assistant.tool_call_delta':
      case 'tool.execution_partial_result':
      case 'assistant.message':
      case 'assistant.message_start':
      case 'assistant.turn_start':
      case 'assistant.turn_end':
      case 'assistant.idle':
      case 'model.call_start':
      case 'model.call_finished':
      case 'user.message':
      case 'session.tools_updated':
      case 'session.auto_mode_resolved':
      case 'session.mcp_servers_loaded':
      case 'session.mcp_server_status_changed':
      case 'session.background_tasks_changed':
        return null;

      default:
        // An unrecognised dotted event is still Copilot 1.0 telemetry, not text
        // to print at the user.
        return null;
    }
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

      // Copilot CLI 1.0 JSONL. Captured from 1.0.83:
      //   {"type":"assistant.message_delta","data":{"deltaContent":"Okay"}}
      //   {"type":"tool.execution_start","data":{"toolCallId":"call_…","toolName":"bash",
      //                                          "arguments":{"command":"ls"}}}
      //   {"type":"tool.execution_complete","data":{"toolCallId":"call_…","success":true,
      //                                             "result":{"content":"…"}}}
      //   {"type":"session.usage_checkpoint","data":{…}}
      const modern = this._parseModernEvent(data, copilotSession);
      if (modern !== undefined) {
        return modern;
      }

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
              status: 'running',
              kind: toolKind(toolNameCopilot)
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
              // NOT `|| data.stats.total_tokens`: total includes the completion,
              // so the old fallback booked output tokens as context fill.
              input_tokens: Number(data.stats.input_tokens ?? 0),
              output_tokens: Number(data.stats.output_tokens ?? 0)
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
