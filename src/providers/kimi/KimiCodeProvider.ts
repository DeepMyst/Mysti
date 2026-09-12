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
 *
 * Kimi Code provider (MoonshotAI/kimi-code — the `kimi` CLI).
 *
 * Transport: the Agent Client Protocol (ACP) — `kimi acp` speaks JSON-RPC
 * 2.0 over stdio, purpose-built for editor integrations ("Kimi Code CLI
 * speaks the Agent Client Protocol"). Mysti drives it through the base
 * persistent-process machinery, identical in shape to the Hermes backend:
 * one `kimi acp` process per panel, a reactive handshake in parseStreamLine
 * (initialize → session/new → session/prompt), and session/update
 * notifications mapped onto Mysti StreamChunks. The prompt's JSON-RPC
 * *response* (carrying `stopReason`) is the response boundary.
 *
 * Kimi's own coding models (Kimi K2.7 Code / K3, 256K–1M context) reason, so
 * ACP `agent_thought_chunk` notifications surface as thinking. Model choice
 * is normally made inside the session (`/model`) — ACP has no per-prompt
 * model override — but a `mysti.kimiCodeModel` override is injected as the
 * `ANTHROPIC_MODEL` env var at spawn (the channel Kimi documents for its
 * Anthropic-compatible surface), best-effort.
 *
 * There is no documented stream-JSON one-shot mode, so the single-shot
 * fallback runs `kimi acp --check` and surfaces its diagnostics as an
 * actionable error instead of hanging or silently re-sending (Hermes pattern).
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BaseCliProvider, type PanelSessionState } from '../base/BaseCliProvider';
import { respondToAcpApproval } from '../base/AcpApproval';
import {
  parseAcpAvailableCommands,
  type NativeCommandSpec,
  type ReportedNativeCommands,
} from '../base/NativeCommands';
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
  InstallMethod,
  AccessLevel
} from '../../types';
import { normalizeToolName, toolKind } from '../../utils/toolNames';
import { isProcessLive, killProcessTree } from '../../utils/processKill';
import { validateModelName } from '../../utils/validation';
import { PROCESS_KILL_GRACE_PERIOD_MS } from '../../constants';

/** ACP protocol version Mysti speaks (v1 per the agentclientprotocol spec). */
const ACP_PROTOCOL_VERSION = 1;

/**
 * ACP tool-call `kind` → canonical Mysti tool name. Keys off the semantic
 * kind (not the human-readable `title`), so classification and rendering
 * stay correct.
 */
const ACP_KIND_TO_TOOL_NAME: Record<string, string> = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Delete',
  move: 'Move',
  search: 'Grep',
  execute: 'Bash',
  fetch: 'WebFetch',
  think: 'Think'
};

/**
 * Per-panel session state for Kimi Code: the ACP JSON-RPC handshake state
 * machine plus tool-call tracking.
 */
export interface KimiCodeSessionState extends PanelSessionState {
  /** Monotonic JSON-RPC request id counter (per persistent process). */
  rpcId: number;
  /** Outstanding request ids by kind, to route responses. */
  initializeId: number | null;
  sessionNewId: number | null;
  promptId: number | null;
  /** ACP server-issued session id (persists across prompts on one process). */
  acpSessionId: string | null;
  /** Prompt stashed until the handshake yields a session id. */
  pendingPrompt: string | null;
  /**
   * Access level + operation mode snapshot taken at spawn. Drives the
   * permission decision; kept fresh by forcing a respawn whenever either
   * changes (see _persistentSettingsMatch).
   */
  acpAccessLevel: AccessLevel;
  acpMode: Settings['mode'];
  /** True while the single-shot diagnostic fallback (`acp --check`) runs. */
  fallbackDiagnostics: boolean;
  /** One diagnostic error per fallback run, not one per output line. */
  fallbackErrorEmitted: boolean;
  /**
   * Commands the agent reported over ACP for this session. The list is the
   * agent's own, arrives after the handshake, and can be re-sent mid-session,
   * so it is session state rather than anything Mysti can hard-code.
   */
  availableCommands: ReportedNativeCommands;
  activeToolCalls: Map<string, { id: string; name: string; input: Record<string, unknown> }>;
  lastUsageStats: { input_tokens: number; output_tokens: number } | null;
}



export class KimiCodeProvider extends BaseCliProvider {
  readonly id = 'kimi-code';
  readonly displayName = 'Kimi Code';

  readonly config: ProviderConfig = {
    name: 'kimi-code',
    displayName: 'Kimi Code',
    models: [
      {
        id: 'default',
        name: 'Default (account model)',
        description: 'Uses the model selected in Kimi (`/model`) for your plan',
        contextWindow: 262144
      },
      {
        id: 'kimi-for-coding',
        name: 'Kimi K2.7 Code',
        description: 'Kimi K2.7 Code — the default coding model for subscription plans',
        contextWindow: 262144
      },
      {
        id: 'kimi-for-coding-highspeed',
        name: 'Kimi K2.7 Code HighSpeed',
        description: 'Faster K2.7 Code tier (Allegretto+ plans)',
        contextWindow: 262144
      },
      {
        id: 'k3',
        name: 'Kimi K3',
        description: 'Kimi K3 — higher-tier model with up to 1M context (Moderato+ plans)',
        contextWindow: 1048576
      },
      {
        id: 'kimi-k2.7-code',
        name: 'Kimi K2.7 Code (pay-per-token)',
        description: 'Pay-per-token API model id (Moonshot Open Platform)',
        contextWindow: 262144
      }
    ],
    defaultModel: 'default'
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    // Kimi's coding models reason; ACP surfaces it as agent_thought_chunk.
    supportsThinking: true,
    supportsToolUse: true,
    toolExecution: 'native',
    supportsNativeApproval: true,
    supportsSessions: true,
    supportsPersistentProcess: true,
    // Plan 27 Phase 5: attachments are written to a temp file and referenced
    // by PATH (BaseCliProvider.prepareAttachments). This backend has file-read
    // tools, so it can open what it is given.
    supportsImages: true,
    supportsAutoInstall: false,  // installed via the official script/Homebrew (wizard shows the OS command)
    supportsPromptEnhancement: false,
    thinkingStyle: 'streamed',
    thinkingLevelEffective: false, // reasoning is governed by the Kimi model, not a Mysti level
    planMode: 'detected',
    // Continuity lives in the ACP session held by the persistent process;
    // session.sessionId mirrors it so history is only re-sent after a respawn.
    sessionKind: 'cli-resume',
    emitsToolResults: true,
    emitsUsage: true,
    usageConvention: 'none',   // ACP usage carries flat input/output only.
    // ACP has no per-prompt model override; a custom model is passed via the
    // ANTHROPIC_MODEL env at spawn (best-effort) — expose it as custom-only.
    modelSelection: 'custom-only'
  };

  protected _createSession(panelId: string): KimiCodeSessionState {
    return {
      panelId,
      process: null,
      sessionId: null,
      autonomousMode: false,
      persistentProcess: null,
      persistentReady: false,
      lastHealthCheck: 0,
      suspended: false,
      rpcId: 0,
      initializeId: null,
      sessionNewId: null,
      promptId: null,
      acpSessionId: null,
      pendingPrompt: null,
      acpAccessLevel: 'ask-permission',
      acpMode: 'default',
      fallbackDiagnostics: false,
      fallbackErrorEmitted: false,
      availableCommands: null,
      activeToolCalls: new Map(),
      lastUsageStats: null,
    };
  }

  /**
   * The command list Kimi Code reported for this panel's session.
   *
   * ACP agents publish their own `/commands`, so unlike every CLI-backed
   * provider there is nothing useful to hard-code here — the list is whatever
   * arrived in the last `available_commands_update` for this panel.
   */
  public override getDynamicNativeCommands(panelId?: string): NativeCommandSpec[] {
    if (!panelId) { return []; }
    const session = this._panelSessions.get(panelId) as KimiCodeSessionState | undefined;
    return session?.availableCommands ?? [];
  }

  /** True once the agent has sent an `available_commands_update` for this panel. */
  public override hasReportedNativeCommands(panelId?: string): boolean {
    if (!panelId) { return false; }
    const session = this._panelSessions.get(panelId) as KimiCodeSessionState | undefined;
    return Array.isArray(session?.availableCommands);
  }

  async discoverCli(): Promise<CliDiscoveryResult> {
    return this._discoverCliCommon();
  }

  getCliPath(): string {
    return this._getCliPathCommon();
  }

  protected _getCliCommandName(): string {
    return 'kimi';
  }

  protected _getConfiguredCliPath(): string {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<string>('kimiCodePath', 'kimi');
  }

  /** Kimi config/home dir (~/.kimi by default, KIMI_HOME override). */
  private _kimiHome(): string {
    return process.env.KIMI_HOME || path.join(os.homedir(), '.kimi');
  }

  /**
   * Provider API keys Kimi Code honors from the environment. Kimi's own key
   * (MOONSHOT_API_KEY / KIMI_API_KEY) or the Anthropic-compatible token used
   * for its `/anthropic` surface. Bare ANTHROPIC_API_KEY is deliberately
   * EXCLUDED — it is ubiquitous and would false-positive on Anthropic users.
   */
  private static readonly _envKeys = [
    'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  ];

  private _kimiEnvKey(): string | undefined {
    return KimiCodeProvider._envKeys.find(k => (process.env[k] || '').trim().length > 0);
  }

  async getAuthConfig(): Promise<AuthConfig> {
    const home = this._kimiHome();
    // Kimi stores OAuth/session credentials under ~/.kimi after `/login`.
    const authCandidates = [
      path.join(home, 'auth.json'),
      path.join(home, 'credentials.json'),
      path.join(home, 'oauth.json'),
    ];
    const configCandidates = [
      path.join(home, 'config.toml'),
      path.join(home, 'config.json'),
      path.join(home, 'config.yaml'),
    ];
    const authFile = authCandidates.find(p => fs.existsSync(p));
    const configFile = configCandidates.find(p => fs.existsSync(p));

    return {
      type: authFile ? 'oauth' : 'api-key',
      isAuthenticated: !!this._kimiEnvKey() || !!authFile || !!configFile,
      configPath: configFile || configCandidates[0]
    };
  }

  async checkAuthentication(): Promise<AuthStatus> {
    const home = this._kimiHome();

    // OAuth session from `/login` (or `kimi login`) — Kimi Code / Moonshot.
    for (const name of ['auth.json', 'credentials.json', 'oauth.json']) {
      if (fs.existsSync(path.join(home, name))) {
        return { authenticated: true, user: 'Kimi Code' };
      }
    }

    // A saved config with an API key (Moonshot Open Platform key pasted at login).
    for (const name of ['config.toml', 'config.json', 'config.yaml']) {
      const configPath = path.join(home, name);
      if (fs.existsSync(configPath)) {
        try {
          const content = fs.readFileSync(configPath, 'utf-8');
          if (/(api[_-]?key|token)\s*[:=]\s*['"]?\S/i.test(content)) {
            return { authenticated: true, user: 'Kimi Config' };
          }
        } catch {
          // unreadable — fall through
        }
      }
    }

    // Environment-level keys Kimi honors.
    if (this._kimiEnvKey()) {
      return { authenticated: true, user: 'Environment API Key' };
    }

    return {
      authenticated: false,
      error: 'Not authenticated. Run "kimi" and use "/login" (Kimi Code OAuth or a Moonshot AI Open Platform API key), or set MOONSHOT_API_KEY.'
    };
  }

  getAuthCommand(): string {
    // The CLI authenticates with the in-session `/login` slash command; there
    // is no non-interactive `kimi login` in Kimi Code, so surface `kimi`.
    return 'kimi';
  }

  getInstallCommand(): string {
    return 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash';
  }

  getInstallMethods(): InstallMethod[] {
    return [
      { id: 'script', label: 'Install script (macOS/Linux)', command: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash', platform: 'darwin', priority: 1 },
      { id: 'brew', label: 'Homebrew (macOS/Linux)', command: 'brew install kimi-code', platform: 'darwin', priority: 2 },
      { id: 'script-linux', label: 'Install script (Linux/WSL2)', command: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash', platform: 'linux', priority: 1 },
      { id: 'brew-linux', label: 'Homebrew (Linux)', command: 'brew install kimi-code', platform: 'linux', priority: 2 },
      { id: 'ps1', label: 'PowerShell installer (Windows)', command: 'irm https://code.kimi.com/kimi-code/install.ps1 | iex', platform: 'win32', priority: 1 },
    ];
  }

  protected getThinkingTokens(_thinkingLevel: string): number | undefined {
    return undefined; // reasoning is governed by the Kimi model
  }

  /**
   * Custom model as a Kimi model id (kimi-for-coding, kimi-for-coding-highspeed,
   * k3, kimi-k2.7-code). ACP has no per-prompt model param, so this is surfaced
   * to the CLI via the ANTHROPIC_MODEL env at spawn (getExtraSpawnEnv).
   */
  protected _getEffectiveModel(settings: Settings): string | undefined {
    // P2.3/P0.2b: an explicitly routed model wins over the per-provider custom-model config.
    if (settings.routedModel) { return settings.routedModel; }
    const config = vscode.workspace.getConfiguration('mysti');
    const customModel = config.get<string>('kimiCodeModel', '');
    if (customModel) {
      const validation = validateModelName(customModel);
      if (validation.valid) {
        return customModel;
      }
      console.warn(`[Mysti] Kimi Code: Invalid custom model "${customModel}": ${validation.error}`);
    }
    if (settings.model && settings.model !== 'default') {
      return settings.model;
    }
    return undefined;
  }

  /**
   * Inject the selected model into the spawn env. `kimi acp` takes no model
   * flag; ANTHROPIC_MODEL is the documented channel for Kimi's Anthropic-
   * compatible surface. Best-effort — if unhonored, the account default is used.
   */
  protected override getExtraSpawnEnv(settings: Settings): Record<string, string> {
    const model = this._getEffectiveModel(settings);
    return model ? { ANTHROPIC_MODEL: model } : {};
  }

  // ==========================================================================
  // Persistent mode — the primary transport (`kimi acp`, JSON-RPC/stdio)
  // ==========================================================================

  protected buildPersistentCliArgs(settings: Settings, session: PanelSessionState): string[] | null {
    const kimi = session as KimiCodeSessionState;
    // Fresh process → fresh protocol state. The ACP session dies with the
    // process; clearing sessionId makes the base re-send conversation history
    // on the first prompt of the new process.
    kimi.rpcId = 0;
    kimi.initializeId = null;
    kimi.sessionNewId = null;
    kimi.promptId = null;
    kimi.acpSessionId = null;
    kimi.pendingPrompt = null;
    kimi.sessionId = null;
    kimi.acpAccessLevel = settings.accessLevel;
    kimi.acpMode = settings.mode;
    kimi.fallbackDiagnostics = false;
    kimi.activeToolCalls.clear();
    return ['acp'];
  }

  /**
   * The base compares {model, permissionMode, thinkingLevel} to decide whether
   * to reuse a persistent process — but _derivePermissionMode collapses
   * read-only and the plan modes into one value, so an accessLevel/mode change
   * under a plan mode would NOT respawn and the permission snapshot would go
   * stale. Require both to match so any change forces a fresh spawn.
   */
  protected _persistentSettingsMatch(session: PanelSessionState, settings: Settings): boolean {
    const kimi = session as KimiCodeSessionState;
    return super._persistentSettingsMatch(session, settings)
      && kimi.acpAccessLevel === settings.accessLevel
      && kimi.acpMode === settings.mode;
  }

  /**
   * First write on a fresh process starts the handshake (initialize);
   * parseStreamLine drives the rest reactively as responses arrive.
   * Subsequent prompts on a live session go straight to session/prompt.
   */
  protected _formatPersistentInput(prompt: string, session: PanelSessionState): string {
    const kimi = session as KimiCodeSessionState;
    kimi.fallbackDiagnostics = false;
    kimi.fallbackErrorEmitted = false;

    if (kimi.acpSessionId) {
      return this._promptRequest(kimi, prompt);
    }

    kimi.pendingPrompt = prompt;
    kimi.initializeId = ++kimi.rpcId;
    return JSON.stringify({
      jsonrpc: '2.0',
      id: kimi.initializeId,
      method: 'initialize',
      params: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false
        }
      }
    }) + '\n';
  }

  private _promptRequest(kimi: KimiCodeSessionState, prompt: string): string {
    kimi.promptId = ++kimi.rpcId;
    return JSON.stringify({
      jsonrpc: '2.0',
      id: kimi.promptId,
      method: 'session/prompt',
      params: {
        sessionId: kimi.acpSessionId,
        prompt: [{ type: 'text', text: prompt }]
      }
    }) + '\n';
  }

  private _writeToAcp(kimi: KimiCodeSessionState, message: Record<string, unknown>): void {
    const proc = kimi.persistentProcess;
    if (proc?.stdin?.writable) {
      proc.stdin.write(JSON.stringify(message) + '\n');
    }
  }

  /**
   * The turn ends when the session/prompt JSON-RPC *response* arrives —
   * uniquely identified by `result.stopReason`. Error responses to any of our
   * requests also end the turn. Server→client *requests* (they carry `method`)
   * never end the turn.
   */
  protected _isResponseBoundary(line: string): boolean {
    try {
      const data = JSON.parse(line.trim());
      if (data.method !== undefined || data.id === undefined || data.id === null) {
        return false;
      }
      if (data.error !== undefined) {
        return true;
      }
      return typeof data.result?.stopReason === 'string'
        || typeof data.result?.stop_reason === 'string';
    } catch {
      return false;
    }
  }

  /**
   * Cancel by DROPPING the ACP process, not by sending session/cancel — a
   * graceful cancel leaves the prompt request outstanding and its stale
   * `{stopReason:"cancelled"}` response would terminate the NEXT turn. Killing
   * the process removes the whole race class: the next turn spawns a fresh
   * `kimi acp`, re-runs buildPersistentCliArgs (clean protocol state), and
   * re-sends conversation history.
   */
  protected _interruptPersistentProcess(session: PanelSessionState): void {
    const proc = session.persistentProcess;
    if (isProcessLive(proc)) {
      void killProcessTree(proc, PROCESS_KILL_GRACE_PERIOD_MS, { label: this.displayName });
    }
    session.persistentProcess = null;
    session.persistentReady = false;
  }

  // ==========================================================================
  // Single-shot fallback — diagnostics only (see file header)
  // ==========================================================================

  protected buildCliArgs(_settings: Settings, session: PanelSessionState): string[] {
    const kimi = session as KimiCodeSessionState;
    kimi.fallbackDiagnostics = true;
    kimi.fallbackErrorEmitted = false;
    return ['acp', '--check'];
  }

  // ==========================================================================
  // Stream parsing — ACP JSON-RPC (persistent) or diagnostics (fallback)
  // ==========================================================================

  protected parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    const kimi = session as KimiCodeSessionState;

    // Fallback context: we're running `kimi acp --check` diagnostics.
    if (kimi.fallbackDiagnostics) {
      return this._parseFallbackLine(line, kimi);
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line);
    } catch {
      // stdout is reserved for JSON-RPC; anything else is stray noise
      return null;
    }

    // --- Notifications from the agent ---
    if (data.method === 'session/update') {
      return this._handleSessionUpdate(data.params as Record<string, unknown> | undefined, kimi);
    }

    // --- Server→client requests (they carry method AND id) ---
    if (typeof data.method === 'string' && data.id !== undefined && data.id !== null) {
      if (data.method === 'session/request_permission') {
        this._respondToPermissionRequest(data.id as number | string, data.params as Record<string, unknown> | undefined, kimi);
      } else {
        // We advertised no fs/terminal capabilities; unblock anything unexpected
        this._writeToAcp(kimi, {
          jsonrpc: '2.0',
          id: data.id,
          error: { code: -32601, message: `Method not supported by Mysti: ${data.method}` }
        });
      }
      return null;
    }

    // --- Responses to our requests ---
    if (data.id !== undefined && data.id !== null) {
      return this._handleRpcResponse(data, kimi);
    }

    return null;
  }

  private _handleRpcResponse(data: Record<string, unknown>, kimi: KimiCodeSessionState): StreamChunk | null {
    const error = data.error as { code?: number; message?: string } | undefined;
    const result = (data.result ?? {}) as Record<string, unknown>;

    if (data.id === kimi.initializeId) {
      kimi.initializeId = null;
      if (error) {
        return { type: 'error', content: `Kimi Code ACP initialize failed: ${error.message || 'unknown error'}` };
      }
      kimi.sessionNewId = ++kimi.rpcId;
      const workspaceFolders = vscode.workspace.workspaceFolders;
      this._writeToAcp(kimi, {
        jsonrpc: '2.0',
        id: kimi.sessionNewId,
        method: 'session/new',
        params: {
          cwd: workspaceFolders ? workspaceFolders[0].uri.fsPath : process.cwd(),
          mcpServers: []
        }
      });
      return null;
    }

    if (data.id === kimi.sessionNewId) {
      kimi.sessionNewId = null;
      if (error) {
        // No credentials is the overwhelmingly common cause
        return {
          type: 'auth_error',
          content: `Kimi Code could not start a session: ${error.message || 'authentication required'}. Run "kimi" and use "/login" to sign in.`,
          authCommand: 'kimi',
          providerName: 'Kimi Code'
        };
      }
      const sessionId = String((result.sessionId ?? result.session_id) || '');
      if (!sessionId) {
        return { type: 'error', content: 'Kimi Code ACP returned no session id.' };
      }
      kimi.acpSessionId = sessionId;
      kimi.sessionId = sessionId;
      const prompt = kimi.pendingPrompt ?? '';
      kimi.pendingPrompt = null;
      if (kimi.persistentProcess?.stdin?.writable) {
        kimi.persistentProcess.stdin.write(this._promptRequest(kimi, prompt));
      }
      // Deliberately emit NO chunk here. usedPersistent must flip only once the
      // prompt is actually answered (the boundary session_active below), so a
      // process death DURING the first prompt yields zero chunks and surfaces
      // the diagnostic fallback instead of a silent empty reply.
      return null;
    }

    if (data.id === kimi.promptId) {
      kimi.promptId = null;
      if (error) {
        return { type: 'error', content: `Kimi Code: ${error.message || 'prompt failed'}` };
      }
      const usage = (result.usage ?? {}) as Record<string, unknown>;
      const input = Number(usage.inputTokens ?? usage.input_tokens ?? 0);
      const output = Number(usage.outputTokens ?? usage.output_tokens ?? 0);
      if (input > 0 || output > 0) {
        kimi.lastUsageStats = { input_tokens: input, output_tokens: output };
      }
      const stopReason = String(result.stopReason ?? result.stop_reason ?? 'end_turn');
      if (stopReason === 'refusal') {
        return { type: 'error', content: 'Kimi Code declined to complete this request (stopReason: refusal).' };
      }
      // Guarantee ≥1 chunk per turn so the base never mistakes an empty
      // response for a dead persistent process (which would trigger the
      // single-shot fallback and re-run diagnostics over the user's turn).
      return { type: 'session_active', sessionId: kimi.acpSessionId || undefined };
    }

    return null;
  }

  private _handleSessionUpdate(params: Record<string, unknown> | undefined, kimi: KimiCodeSessionState): StreamChunk | null {
    const update = (params?.update ?? {}) as Record<string, unknown>;
    const kind = String(update.sessionUpdate ?? update.session_update ?? '');

    switch (kind) {
      case 'agent_message_chunk': {
        const text = this._contentText(update.content);
        return text ? { type: 'text', content: text } : null;
      }

      case 'agent_thought_chunk': {
        const text = this._contentText(update.content);
        return text ? { type: 'thinking', content: text } : null;
      }

      case 'tool_call': {
        const toolId = String(update.toolCallId ?? update.tool_call_id ?? `tool-${Date.now()}`);
        const acpKind = String(update.kind ?? '').toLowerCase();
        const toolName = ACP_KIND_TO_TOOL_NAME[acpKind]
          || normalizeToolName(String(update.title ?? 'tool').split(':')[0].trim())
          || 'tool';
        const input = (update.rawInput ?? update.raw_input ?? {}) as Record<string, unknown>;
        kimi.activeToolCalls.set(toolId, { id: toolId, name: toolName, input });
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

      case 'tool_call_update': {
        const toolId = String(update.toolCallId ?? update.tool_call_id ?? '');
        const status = String(update.status ?? '');
        if (status !== 'completed' && status !== 'failed') {
          return null; // in_progress / pending — the start chunk already rendered
        }
        const toolInfo = kimi.activeToolCalls.get(toolId);
        kimi.activeToolCalls.delete(toolId);
        const output = this._toolOutputText(update);
        return {
          type: 'tool_result',
          toolCall: {
            id: toolId,
            name: toolInfo?.name || 'tool',
            input: toolInfo?.input || {},
            output,
            status: status === 'completed' ? 'completed' : 'failed'
          }
        };
      }

      // The agent's own `/command` vocabulary. Stored (not rendered) so the
      // slash menu can offer exactly what THIS session supports; previously
      // this arrived and was dropped on the floor.
      case 'available_commands_update':
        kimi.availableCommands = parseAcpAvailableCommands(update);
        return null;

      // Context-window telemetry, plan entries, echoes — no Mysti rendering yet
      case 'usage_update':
      case 'plan':
      case 'user_message_chunk':
      case 'session_info_update':
        return null;

      default:
        return null;
    }
  }

  /** Route the native blocking request through its process/turn-owned approval scope. */
  private _respondToPermissionRequest(id: number | string, params: Record<string, unknown> | undefined, kimi: KimiCodeSessionState): void {
    respondToAcpApproval({
      id, params,
      settings: { mode: kimi.acpMode, accessLevel: kimi.acpAccessLevel },
      process: kimi.persistentProcess, sessionId: kimi.acpSessionId,
      trackedTools: kimi.activeToolCalls,
      requests: this._nativeApprovalRequests(kimi),
    });
  }

  /** Extract text from an ACP content block (or block array). */
  private _contentText(content: unknown): string {
    if (!content) {
      return '';
    }
    const blocks = Array.isArray(content) ? content : [content];
    return blocks
      .map(block => {
        const b = block as Record<string, unknown>;
        return b && b.type === 'text' && typeof b.text === 'string' ? b.text : '';
      })
      .join('');
  }

  private _toolOutputText(update: Record<string, unknown>): string {
    const content = update.content as unknown[] | undefined;
    if (Array.isArray(content)) {
      const text = content
        .map(item => {
          const entry = item as Record<string, unknown>;
          // ACP tool-call content wraps blocks: {type:'content', content:{type:'text',...}}
          if (entry.type === 'content') {
            return this._contentText(entry.content);
          }
          return this._contentText(entry);
        })
        .join('');
      if (text) {
        return text;
      }
    }
    const raw = update.rawOutput ?? update.raw_output;
    if (raw !== undefined && raw !== null) {
      return typeof raw === 'string' ? raw : JSON.stringify(raw);
    }
    return '';
  }

  private _parseFallbackLine(line: string, kimi: KimiCodeSessionState): StreamChunk | null {
    const trimmed = line.trim();
    if (!trimmed || kimi.fallbackErrorEmitted) {
      return null;
    }
    kimi.fallbackErrorEmitted = true;
    return {
      type: 'error',
      content: 'Kimi Code ACP transport is unavailable, so this message was not processed. '
        + 'Mysti drives Kimi Code through "kimi acp" — run "kimi acp --check" in a terminal, '
        + 'sign in with "/login", update Kimi Code, then try again.\n'
        + `First diagnostic line: ${trimmed.slice(0, 300)}`
    };
  }

  // ==========================================================================
  // Usage + lifecycle
  // ==========================================================================

  getStoredUsage(panelId?: string): { input_tokens: number; output_tokens: number } | null {
    const session = this._getSession(panelId) as KimiCodeSessionState;
    const usage = session.lastUsageStats;
    session.lastUsageStats = null;
    return usage;
  }

  clearSession(panelId?: string): void {
    // Drop the ACP process too: its session/protocol state cannot be reset on
    // a live connection without a duplicate `initialize` and id collisions.
    this.disposePersistentProcess(panelId);
    super.clearSession(panelId);
    if (panelId) {
      const session = this._panelSessions.get(panelId) as KimiCodeSessionState | undefined;
      if (session) {
        session.rpcId = 0;
        session.initializeId = null;
        session.sessionNewId = null;
        session.promptId = null;
        session.acpSessionId = null;
        session.pendingPrompt = null;
        session.activeToolCalls.clear();
        session.lastUsageStats = null;
      }
    }
  }
}
