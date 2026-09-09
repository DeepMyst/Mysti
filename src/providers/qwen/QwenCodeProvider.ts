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
 * qwen-code's default OpenAI-compatible endpoint (DashScope compatible-mode),
 * used for model discovery when the user has not set OPENAI_BASE_URL.
 */
const QWEN_DEFAULT_OPENAI_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

/**
 * Per-panel session state for Qwen Code provider.
 * Mirrors ClaudeSessionState since both CLIs use the same streaming protocol.
 */
export interface QwenSessionState extends PanelSessionState {
  activeToolCalls: Map<number, { id: string; name: string; inputJson: string }>;
  lastUsageStats: { input_tokens: number; output_tokens: number } | null;
  hasStreamedText: boolean;
}

/**
 * Qwen Code CLI provider implementation
 *
 * Qwen Code uses the same streaming protocol as Claude Code (Anthropic stream-json format).
 * CLI: qwen -p "prompt" --output-format stream-json --include-partial-messages --verbose
 */
export class QwenCodeProvider extends BaseCliProvider {
  readonly id = 'qwen-code';
  readonly displayName = 'Qwen Code';

  readonly config: ProviderConfig = {
    name: 'qwen-code',
    displayName: 'Qwen Code',
    models: [
      {
        id: 'qwen3-coder',
        name: 'Qwen3 Coder',
        description: 'Primary Qwen coding model',
        contextWindow: 131072
      },
      {
        id: 'qwen3-coder-plus',
        name: 'Qwen3 Coder Plus',
        description: 'Enhanced Qwen coding model',
        contextWindow: 131072
      },
      {
        id: 'qwen3-coder-next',
        name: 'Qwen3 Coder Next',
        description: 'Hybrid-attention MoE tuned for coding agents and local development',
        contextWindow: 262144
      }
    ],
    defaultModel: 'qwen3-coder'
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsThinking: true,
    supportsToolUse: true,
    supportsSessions: true,
    // Plan 27 Phase 5: attachments are written to a temp file and referenced
    // by PATH (BaseCliProvider.prepareAttachments). This backend has file-read
    // tools, so it can open what it is given.
    supportsImages: true,
    supportsAutoInstall: true,
    supportsPromptEnhancement: false,
    // Plan 02 Phase 1 capability matrix
    thinkingStyle: 'complete-blocks',
    thinkingLevelEffective: false,
    planMode: 'detected',
    // F8 caveat: `--continue` resumes the globally-latest session (cross-panel
    // bleed) — value stays 'cli-resume' until Plan 00 Batch 1.3 fixes it.
    sessionKind: 'cli-resume',
    emitsToolResults: true,
    emitsUsage: true,
    usageConvention: 'none',   // Qwen's message_delta usage carries no cache fields.
    modelSelection: 'full'
  };

  // --- Discovery ---

  async discoverCli(): Promise<CliDiscoveryResult> {
    return this._discoverCliCommon();
  }

  getCliPath(): string {
    return this._getCliPathCommon();
  }

  /**
   * Live model discovery (Plan 01 Phase 3). Qwen Code has no `list models`
   * subcommand, but it drives an OpenAI-COMPATIBLE endpoint (`--openai-base-url`
   * / `--openai-api-key`), so the standard `GET {baseUrl}/models` is the list the
   * `-m` flag will accept.
   *
   * A key is only ever sent to the endpoint it was configured FOR:
   *   - OPENAI_BASE_URL set  -> probe it with OPENAI_API_KEY (the user paired
   *     these two themselves for qwen-code);
   *   - otherwise            -> probe DashScope's compatible-mode endpoint, and
   *     ONLY with a DashScope/Qwen key.
   * Never OPENAI_API_KEY against DashScope: that variable is very commonly set
   * for a different provider entirely, and shipping it to Alibaba would leak a
   * third party's credential. No usable pair (e.g. the common Qwen-account OAuth
   * login) simply returns null and the curated list serves.
   *
   * Returns null on any failure so the registry keeps its curated/cached list.
   * Never throws.
   */
  async discoverModels(timeoutMs: number): Promise<ModelInfo[] | null> {
    const target = this._openAiCompatibleTarget();
    if (!target) { return null; }
    try {
      const response = await fetch(`${target.baseUrl}/models`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${target.apiKey}`, Accept: 'application/json' },
      });
      if (!response.ok) { return null; }
      const data = await response.json() as { data?: Array<{ id?: string }> };
      const seen = new Set<string>();
      const models: ModelInfo[] = [];
      for (const entry of data.data || []) {
        const id = (entry?.id || '').trim();
        if (!id || seen.has(id)) { continue; }
        seen.add(id);
        models.push({ id, name: id });
      }
      return models.length > 0 ? models : null;
    } catch {
      return null;
    }
  }

  /**
   * The (baseUrl, apiKey) pair to probe for models, or undefined when there is no
   * safely-pairable one. See discoverModels for why the pairing is strict.
   */
  private _openAiCompatibleTarget(): { baseUrl: string; apiKey: string } | undefined {
    const explicitBase = (process.env.OPENAI_BASE_URL || '').trim();
    if (explicitBase) {
      const openAiKey = (process.env.OPENAI_API_KEY || '').trim();
      if (!openAiKey || !/^https?:\/\//i.test(explicitBase)) { return undefined; }
      return { baseUrl: explicitBase.replace(/\/+$/, ''), apiKey: openAiKey };
    }
    // No explicit endpoint: qwen-code's default OpenAI-compatible target is
    // DashScope, so only a DashScope/Qwen key may be used here.
    const dashscopeKey = (process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || '').trim();
    if (!dashscopeKey) { return undefined; }
    return { baseUrl: QWEN_DEFAULT_OPENAI_BASE_URL, apiKey: dashscopeKey };
  }

  protected _getCliCommandName(): string {
    return 'qwen';
  }

  protected _getConfiguredCliPath(): string {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<string>('qwenCodePath', 'qwen');
  }

  // --- Authentication ---

  async getAuthConfig(): Promise<AuthConfig> {
    // Qwen Code is a Gemini-CLI fork: OAuth login (/auth) writes
    // ~/.qwen/oauth_creds.json; settings.json is only the config file and is
    // written on first launch even without auth, so its mere existence is NOT
    // proof of login (dropped as an auth marker). Recognize the real OAuth
    // token file plus qwen-code's own env keys. ANTHROPIC_API_KEY /
    // GEMINI_API_KEY are other providers' keys, not qwen-code auth — removed.
    const configPath = path.join(os.homedir(), '.qwen', 'settings.json');
    const oauthPath = path.join(os.homedir(), '.qwen', 'oauth_creds.json');
    const hasApiKey = !!(
      process.env.QWEN_API_KEY ||
      process.env.DASHSCOPE_API_KEY ||
      process.env.OPENAI_API_KEY // qwen-code's OpenAI-compatible endpoint path
    );
    return {
      type: hasApiKey ? 'api-key' : 'oauth',
      isAuthenticated: hasApiKey || fs.existsSync(oauthPath),
      configPath
    };
  }

  async checkAuthentication(): Promise<AuthStatus> {
    // Only qwen-code's own auth env keys count. ANTHROPIC_API_KEY /
    // GEMINI_API_KEY belong to other providers and are not qwen-code auth.
    if (process.env.QWEN_API_KEY) {
      return { authenticated: true, user: 'Qwen API Key' };
    }
    if (process.env.DASHSCOPE_API_KEY) {
      return { authenticated: true, user: 'DashScope API Key' };
    }
    if (process.env.OPENAI_API_KEY) {
      // qwen-code supports an OpenAI-compatible endpoint — a real auth path.
      return { authenticated: true, user: 'OpenAI API Key' };
    }

    // OAuth login (Qwen account) writes oauth_creds.json.
    if (fs.existsSync(path.join(os.homedir(), '.qwen', 'oauth_creds.json'))) {
      return { authenticated: true, user: 'Qwen Account' };
    }

    // settings.json is created on first launch even without auth, so its mere
    // existence is NOT proof of login. Only a real provider/model marker
    // (written when the user actually configures a provider) counts; otherwise
    // fall through to not-authenticated.
    const configPath = path.join(os.homedir(), '.qwen', 'settings.json');
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(content);
        if (config.modelProviders || config.model) {
          return { authenticated: true, user: 'Qwen Config' };
        }
      } catch {
        // Config exists but couldn't parse — treat as not authenticated
      }
    }

    return {
      authenticated: false,
      error: 'Not authenticated. Run "qwen" and type "/auth" to sign in, or set a provider API key (e.g., QWEN_API_KEY).'
    };
  }

  getAuthCommand(): string {
    return 'qwen';
  }

  getInstallCommand(): string {
    return 'npm install -g @qwen-code/qwen-code@latest';
  }

  // --- Session ---

  protected _createSession(panelId: string): QwenSessionState {
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
      hasStreamedText: false,
    };
  }

  // --- CLI Args ---

  protected buildCliArgs(settings: Settings, session: PanelSessionState): string[] {
    const args: string[] = [
      '--output-format', 'stream-json',
      '--include-partial-messages',
    ];

    // Map Mysti modes to Qwen approval modes
    this._addApprovalMode(args, settings);

    // Prompt is sent via stdin by BaseCliProvider.sendMessage()
    // No -p flag needed — Qwen reads from stdin by default

    // Session resume — pass the per-panel session ID explicitly.
    // Bare --continue resumes the *globally most recent* session for the
    // project, which bleeds conversations across panels (and across any
    // terminal `qwen` run in the same repo). When no session ID has been
    // captured yet, start a fresh session (no flag).
    if (session.sessionId) {
      args.push('--resume', session.sessionId);
      console.log('[Mysti] Qwen: Resuming session:', session.sessionId);
    } else {
      console.log('[Mysti] Qwen: Starting new session');
    }

    // Model selection
    const effectiveModel = this._getEffectiveModel(settings);
    if (effectiveModel) {
      args.push('--model', effectiveModel);
    }

    console.log('[Mysti] Qwen: Built CLI args:', args.join(' '));
    return args;
  }

  protected getThinkingTokens(thinkingLevel: string): number | undefined {
    const tokenMap: Record<string, number> = {
      'none': 0,
      'low': 4000,
      'medium': 8000,
      'high': 16000
    };
    return tokenMap[thinkingLevel];
  }

  private _addApprovalMode(args: string[], settings: Settings): void {
    const { mode, accessLevel } = settings;

    if (mode === 'quick-plan' || mode === 'detailed-plan' || accessLevel === 'read-only') {
      args.push('--approval-mode', 'plan');
      console.log(`[Mysti] Qwen: Using plan approval mode [mode=${mode}, access=${accessLevel}]`);
      return;
    }

    // For full-access + edit-automatically, use yolo mode
    if (accessLevel === 'full-access' && mode === 'edit-automatically') {
      args.push('--approval-mode', 'yolo');
      console.log('[Mysti] Qwen: Using yolo approval mode');
      return;
    }

    // Default: auto-edit (auto-approve edits, ask for commands)
    args.push('--approval-mode', 'auto-edit');
    console.log(`[Mysti] Qwen: Using auto-edit approval mode [mode=${mode}, access=${accessLevel}]`);
  }

  protected _getEffectiveModel(settings: Settings): string | undefined {
    // P2.3/P0.2b: an explicitly routed model wins over the per-provider custom-model config.
    if (settings.routedModel) { return settings.routedModel; }
    const config = vscode.workspace.getConfiguration('mysti');
    const customModel = config.get<string>('qwenCodeModel', '');
    if (customModel) {
      const validation = validateModelName(customModel);
      if (validation.valid) {
        console.log(`[Mysti] Qwen: Using custom model: ${customModel}`);
        return customModel;
      }
      console.warn(`[Mysti] Qwen: Invalid custom model "${customModel}": ${validation.error}`);
    }
    return settings.model || undefined;
  }

  // --- Stream Parsing (same protocol as Claude Code) ---

  protected parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    const qwenSession = session as QwenSessionState;

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
            qwenSession.hasStreamedText = true;
            return { type: 'text', content: delta.text || '' };
          }
          if (delta.type === 'thinking_delta') {
            return { type: 'thinking', content: delta.thinking || '' };
          }
          if (delta.type === 'input_json_delta') {
            const activeTool = qwenSession.activeToolCalls.get(blockIndex);
            if (activeTool) {
              activeTool.inputJson += delta.partial_json || '';
            }
            return null;
          }
        }

        // Handle content_block_start
        if (nestedType === 'content_block_start') {
          const contentBlock = nestedEvent.content_block || {};
          if (contentBlock.type === 'tool_use') {
            // Normalize native tool names (qwen-code is a gemini-cli fork:
            // write_file, replace, run_shell_command, ...) so the permission
            // gate classifies them correctly.
            const canonicalName = normalizeToolName(contentBlock.name || '');
            qwenSession.activeToolCalls.set(blockIndex, {
              id: contentBlock.id || '',
              name: canonicalName,
              inputJson: ''
            });
            return {
              type: 'tool_use',
              toolCall: {
                id: contentBlock.id || '',
                name: canonicalName,
                input: {},
                status: 'running',
                kind: toolKind(canonicalName)
              }
            };
          }
          if (contentBlock.type === 'thinking') {
            return { type: 'thinking', content: '' };
          }
        }

        // Handle content_block_stop
        if (nestedType === 'content_block_stop') {
          const completedTool = qwenSession.activeToolCalls.get(blockIndex);
          if (completedTool) {
            qwenSession.activeToolCalls.delete(blockIndex);
            let parsedInput: Record<string, unknown> = {};
            try {
              if (completedTool.inputJson) {
                parsedInput = JSON.parse(completedTool.inputJson);
              }
            } catch {
              console.log('[Mysti] Qwen: Failed to parse tool input JSON:', completedTool.inputJson);
            }
            return {
              type: 'tool_use',
              toolCall: {
                id: completedTool.id,
                name: completedTool.name,
                input: parsedInput,
                status: 'running',
                kind: toolKind(completedTool.name)
              }
            };
          }
          return null;
        }

        // Handle message lifecycle events
        if (nestedType === 'message_start') {
          qwenSession.hasStreamedText = false;
          return null;
        }

        if (nestedType === 'message_delta') {
          const usage = nestedEvent.usage;
          if (usage) {
            qwenSession.lastUsageStats = {
              input_tokens: usage.input_tokens || 0,
              output_tokens: usage.output_tokens || 0,
            };
            console.log('[Mysti] Qwen: Captured usage from message_delta:', qwenSession.lastUsageStats);
          }
          return null;
        }

        if (nestedType === 'message_stop') {
          return null;
        }

        return null;
      }

      // Handle direct result event
      if (data.type === 'result') {
        if (data.is_error && data.error?.message) {
          const errMsg: string = data.error.message;
          // Detect auth errors and surface the auth UI
          if (/no auth type|not authenticated|auth.*required|please.*configure.*auth/i.test(errMsg)) {
            return {
              type: 'auth_error',
              content: errMsg,
              authCommand: this.getAuthCommand(),
              providerName: this.displayName
            };
          }
          return { type: 'error', content: errMsg };
        }
        if (!qwenSession.hasStreamedText && data.result && typeof data.result === 'string') {
          return { type: 'text', content: data.result };
        }
        // Extract session ID from result if available
        if (data.session_id && !session.sessionId) {
          session.sessionId = data.session_id;
          console.log('[Mysti] Qwen: Session ID from result:', data.session_id);
        }
        return null;
      }

      // Handle system events (session init)
      if (data.type === 'system') {
        if (data.subtype === 'init') {
          const sessionId = data.session_id || data.sessionId;
          if (sessionId && !session.sessionId) {
            session.sessionId = sessionId;
            console.log('[Mysti] Qwen: Session ID extracted:', sessionId);
            return { type: 'session_active', sessionId };
          }
        }
        return null;
      }

      // Assistant complete-message events are intentionally NOT re-emitted as
      // tool_use (Plan 02 Phase 3, research F16): every tool block already
      // streams through content_block_start/stop above. The old branch only
      // returned the FIRST tool block (dropping multi-tool turns) and
      // double-emitted tool_use chunks, which double-fired the permission gate.
      if (data.type === 'assistant') {
        return null;
      }

      // Handle error events
      if (data.type === 'error') {
        return {
          type: 'error',
          content: data.error?.message || data.message || 'Unknown error'
        };
      }

      // Handle user events with tool_result blocks
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
            name: normalizeToolName(data.tool_name || ''),
            input: {},
            output: typeof data.content === 'string' ? data.content : JSON.stringify(data.content || ''),
            status: data.is_error ? 'failed' : 'completed'
          }
        };
      }

    } catch {
      if (line.trim()) {
        return { type: 'text', content: line };
      }
    }

    return null;
  }

  // --- Usage Stats ---

  getStoredUsage(panelId?: string): { input_tokens: number; output_tokens: number } | null {
    const session = this._getSession(panelId) as QwenSessionState;
    const usage = session.lastUsageStats;
    session.lastUsageStats = null;
    return usage;
  }

  clearSession(panelId?: string): void {
    super.clearSession(panelId);
    if (panelId) {
      const session = this._panelSessions.get(panelId) as QwenSessionState | undefined;
      if (session) {
        session.activeToolCalls.clear();
        session.lastUsageStats = null;
        session.hasStreamedText = false;
      }
    }
  }
}
