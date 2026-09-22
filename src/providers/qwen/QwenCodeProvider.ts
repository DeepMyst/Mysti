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
import type { PanelSessionState } from '../base/BaseCliProvider';
import { AcpNativeProvider } from '../base/AcpNativeProvider';
import type { AcpNativeLaunch, AcpNativeLaunchContext } from '../base/AcpNativeTypes';
import { QWEN_ACP_VERSION, QWEN_ACP_VERSIONS, QWEN_ACP_TOOLS, QWEN_ACP_EXCLUDED_TOOLS, decodeQwenPermission } from './QwenNativeApproval';
import { captureNativeFamilyConfig, nativeFamilyEnvironment } from './QwenNativeConfig';
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
export class QwenCodeProvider extends AcpNativeProvider {
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
    toolExecution: 'native',
    supportsNativeApproval: true,
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
    sessionKind: 'prompt-history',
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
    return `npm install -g @qwen-code/qwen-code@${QWEN_ACP_VERSION}`;
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

  protected buildCliArgs(settings: Settings, _session: PanelSessionState): string[] {
    // All grants are decided by Mysti after a blocking native request. Native
    // automatic/bare modes discard the explicit force-ask policy and are unsafe.
    const args = ['--acp', '--approval-mode', 'default', '--no-safe-mode', '--no-sandbox',
      '--no-chat-recording', '--core-tools', QWEN_ACP_TOOLS.join(','),
      '--exclude-tools', QWEN_ACP_EXCLUDED_TOOLS.join(','),
      '--allowed-mcp-server-names', '__mysti_no_mcp__', '--extensions', '__mysti_no_extensions__'];
    if (settings.accessLevel === 'read-only' || settings.mode === 'quick-plan' || settings.mode === 'detailed-plan') {
      args.push('--exclude-tools', 'edit,notebook_edit,run_shell_command');
    }
    const model = this._getEffectiveModel(settings);
    if (model) { args.push('--model', model); }
    return args;
  }

  protected override async _prepareAcpLaunch(context: AcpNativeLaunchContext): Promise<AcpNativeLaunch> {
    const args = this.buildCliArgs(context.settings, context.session);
    const nativeEnv = nativeFamilyEnvironment(context.env);
    // Pin the native home before the bootstrap can redirect it through a user
    // .env file. Match the wrapper's tilde/relative-path resolution exactly.
    const configuredHome = nativeEnv.QWEN_HOME?.trim();
    nativeEnv.QWEN_HOME = !configuredHome ? path.join(os.homedir(), '.qwen')
      : configuredHome === '~' ? os.homedir()
        : configuredHome.startsWith('~/') || configuredHome.startsWith('~\\')
          ? path.join(os.homedir(), configuredHome.slice(2)) : path.resolve(context.cwd, configuredHome);
    const policyFile = path.join(this._extensionContext.extensionPath, 'resources', 'qwen-policy', 'settings.json');
    const inheritedSystemSettingsPaths = [nativeEnv.QWEN_CODE_SYSTEM_SETTINGS_PATH, nativeEnv.QWEN_CODE_SYSTEM_DEFAULTS_PATH]
      .filter((file): file is string => Boolean(file));
    const env: NodeJS.ProcessEnv = { ...nativeEnv, QWEN_CODE_SYSTEM_SETTINGS_PATH: policyFile,
      QWEN_CODE_SYSTEM_DEFAULTS_PATH: policyFile, QWEN_CODE_SIMPLE: '0', QWEN_CODE_SAFE_MODE: '0',
      QWEN_CODE_NO_RELAUNCH: '1' };
    const capture = await captureNativeFamilyConfig({ ...context, env, flavor: 'qwen', versions: QWEN_ACP_VERSIONS,
      policyFiles: [policyFile], inheritedSystemSettingsPaths });
    // The attested identity must be the installed release; never skip the check.
    if (!capture.version) { throw new Error('Qwen Code native approval setup refused: the installed release could not be identified.'); }
    // cli-entry.js otherwise prefers a mutable managed installation before
    // importing the verified npm payload. A null pin disables that lookup.
    env.QWEN_CODE_MANAGED_NPM_PIN = JSON.stringify({ bootstrap: capture.cliPath, version: null, updateRoot: path.dirname(capture.cliPath) });
    let inputTokens = 0; let outputTokens = 0;
    return {
      cliPath: capture.cliPath, args, env,
      expectedAgentInfo: { name: 'qwen-code', version: capture.version },
      mode: 'default', images: true,
      // 0.23.0 treats MethodNotFound as a permanently unavailable optional
      // mid-turn queue and continues its ordinary current prompt.
      nonFatalUnsupportedRequests: ['craft/drainMidTurnQueue'],
      validateNotification: (method, params) => {
        if (method === 'qwen/notify/session/mode-update' && (params.v !== 1 || params.currentModeId !== 'default')) {
          throw new Error('Qwen changed the captured native approval mode.');
        }
      },
      validateUpdate: update => {
        if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
          for (const option of update.configOptions) {
            if (option?.category === 'mode' && option.currentValue !== 'default') { throw new Error('Qwen changed the captured native approval mode.'); }
          }
        }
      },
      decodePermission: params => decodeQwenPermission(params, context.cwd),
      decodeUsage: value => {
        const meta = value._meta;
        const usage = meta && typeof meta === 'object' && 'usage' in meta ? meta.usage : undefined;
        if (!usage || typeof usage !== 'object' || !('inputTokens' in usage) || !('outputTokens' in usage)
          || !Number.isSafeInteger(usage.inputTokens) || !Number.isSafeInteger(usage.outputTokens)
          || Number(usage.inputTokens) < 0 || Number(usage.outputTokens) < 0) { return undefined; }
        inputTokens += Number(usage.inputTokens); outputTokens += Number(usage.outputTokens);
        return { input_tokens: inputTokens, output_tokens: outputTokens };
      },
      assertUnchanged: capture.assertUnchanged,
    };
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
