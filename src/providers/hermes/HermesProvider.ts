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
 * Hermes Agent provider (NousResearch/hermes-agent).
 *
 * Transport: the Agent Client Protocol (ACP) — `hermes acp` speaks
 * JSON-RPC 2.0 over stdio, purpose-built for editor integrations. Mysti
 * drives it through the base persistent-process machinery: one
 * `hermes acp` process per panel, a reactive handshake implemented in
 * parseStreamLine (initialize → session/new → session/prompt), and
 * session/update notifications mapped onto Mysti StreamChunks. The
 * prompt's JSON-RPC *response* (carrying `stopReason`) is the response
 * boundary.
 *
 * Hermes has no stream-JSON one-shot mode (`-z`/`chat -q` print plain
 * final text and take the prompt via argv, which the single-shot path
 * cannot supply without bypassing base hardening), so the single-shot
 * fallback runs `hermes acp --check` and surfaces its diagnostics as an
 * actionable error instead of hanging or silently re-sending.
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
  InstallMethod,
  AccessLevel
} from '../../types';
import { normalizeToolName, toolKind } from '../../utils/toolNames';
import { isProcessLive, killProcessTree } from '../../utils/processKill';
import { PROCESS_KILL_GRACE_PERIOD_MS } from '../../constants';

/** ACP protocol version Mysti speaks (v1 per the agentclientprotocol spec). */
const ACP_PROTOCOL_VERSION = 1;

/**
 * ACP tool-call `kind` → canonical Mysti tool name. Keys off the semantic
 * kind (not the human-readable `title` like "terminal: npm test…"), so
 * classification and rendering stay correct.
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
 * Per-panel session state for Hermes: the ACP JSON-RPC handshake state
 * machine plus tool-call tracking.
 */
export interface HermesSessionState extends PanelSessionState {
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
  activeToolCalls: Map<string, { id: string; name: string; input: Record<string, unknown> }>;
  lastUsageStats: { input_tokens: number; output_tokens: number } | null;
}

interface AcpPermissionOption {
  optionId?: string;
  option_id?: string;
  kind?: string;
}

export class HermesProvider extends BaseCliProvider {
  readonly id = 'hermes';
  readonly displayName = 'Hermes';

  readonly config: ProviderConfig = {
    name: 'hermes',
    displayName: 'Hermes',
    models: [
      {
        id: 'default',
        name: 'Configured Model',
        description: 'Uses the model configured in Hermes (`hermes model` / `hermes setup`) — 300+ via Nous Portal, OpenRouter, OpenAI, and custom endpoints',
        contextWindow: 200000
      }
    ],
    defaultModel: 'default'
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsThinking: false,     // hermes acp does not emit thought chunks today; handled if it starts to
    supportsToolUse: true,
    supportsSessions: true,
    supportsPersistentProcess: true,
    // Plan 27 Phase 5: attachments are written to a temp file and referenced
    // by PATH (BaseCliProvider.prepareAttachments). This backend has file-read
    // tools, so it can open what it is given.
    supportsImages: true,
    supportsAutoInstall: false,  // installed via the official install script (wizard shows the OS command)
    supportsPromptEnhancement: false,
    thinkingStyle: 'none',
    thinkingLevelEffective: false,
    planMode: 'detected',
    // Continuity lives in the ACP session held by the persistent process;
    // session.sessionId mirrors it so history is only re-sent after a respawn.
    sessionKind: 'cli-resume',
    emitsToolResults: true,
    emitsUsage: true,
    // Model selection happens inside Hermes (`/model provider:model`) —
    // neither `hermes acp` nor ACP itself takes a per-prompt model override.
    modelSelection: 'none'
  };

  protected _createSession(panelId: string): HermesSessionState {
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
    return 'hermes';
  }

  protected _getConfiguredCliPath(): string {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<string>('hermesPath', 'hermes');
  }

  /**
   * Provider API keys Hermes honors from the environment. Hermes reads ~40
   * provider keys; enumerating the common ones lets a user who exported e.g. a
   * Gemini/GLM/Kimi/DeepSeek key be recognized. Deliberately EXCLUDES bare
   * GH_TOKEN/GITHUB_TOKEN — those are ubiquitous and would false-positive.
   */
  private static readonly ENV_KEYS = [
    'NOUS_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'DEEPSEEK_API_KEY', 'GLM_API_KEY',
    'ZAI_API_KEY', 'Z_AI_API_KEY', 'KIMI_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'XAI_API_KEY',
  ];

  /** Hermes home dir (~/.hermes by default, HERMES_HOME override). */
  private _hermesHome(): string {
    return process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
  }

  private _hermesEnvKey(): string | undefined {
    return HermesProvider.ENV_KEYS.find(k => (process.env[k] || '').trim().length > 0);
  }

  async getAuthConfig(): Promise<AuthConfig> {
    const home = this._hermesHome();
    const configPath = path.join(home, 'config.yaml');
    const envPath = path.join(home, '.env');
    const authPath = path.join(home, 'auth.json');

    const hasFiles = fs.existsSync(authPath) || fs.existsSync(envPath);

    return {
      type: fs.existsSync(authPath) ? 'oauth' : 'api-key',
      isAuthenticated: !!this._hermesEnvKey() || hasFiles || fs.existsSync(configPath),
      configPath: fs.existsSync(configPath) ? configPath : envPath
    };
  }

  async checkAuthentication(): Promise<AuthStatus> {
    const home = this._hermesHome();

    // Nous Portal OAuth tokens
    if (fs.existsSync(path.join(home, 'auth.json'))) {
      return { authenticated: true, user: 'Nous Portal' };
    }

    // Provider API keys stored by `hermes setup` in ~/.hermes/.env
    const envPath = path.join(home, '.env');
    if (fs.existsSync(envPath)) {
      try {
        const content = fs.readFileSync(envPath, 'utf-8');
        if (/^[A-Z0-9_]*(API_KEY|TOKEN)\s*=\s*\S/m.test(content)) {
          return { authenticated: true, user: 'Hermes Config' };
        }
      } catch {
        // unreadable — fall through
      }
    }

    // Environment-level provider keys hermes also honors
    if (this._hermesEnvKey()) {
      return { authenticated: true, user: 'Environment API Key' };
    }

    // Configured-provider fallback (aligns with getAuthConfig): `hermes setup`
    // writes config.yaml when a provider is selected; the secret may live in the
    // shell env under a provider key Mysti doesn't enumerate.
    if (fs.existsSync(path.join(home, 'config.yaml'))) {
      return { authenticated: true, user: 'Hermes Config' };
    }

    return {
      authenticated: false,
      error: 'Not authenticated. Run "hermes setup" (or "hermes setup --portal" for Nous Portal) to configure a provider and API key.'
    };
  }

  getAuthCommand(): string {
    return 'hermes setup';
  }

  getInstallCommand(): string {
    return 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash';
  }

  getInstallMethods(): InstallMethod[] {
    return [
      { id: 'script', label: 'Install script (macOS/Linux)', command: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash', platform: 'darwin', priority: 1 },
      { id: 'script-linux', label: 'Install script (Linux/WSL2)', command: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash', platform: 'linux', priority: 1 },
      { id: 'ps1', label: 'PowerShell installer (Windows)', command: "iex (irm https://hermes-agent.nousresearch.com/install.ps1)", platform: 'win32', priority: 1 },
    ];
  }

  protected getThinkingTokens(_thinkingLevel: string): number | undefined {
    return undefined; // reasoning is governed by the model configured in Hermes
  }

  // ==========================================================================
  // Persistent mode — the primary transport (`hermes acp`, JSON-RPC/stdio)
  // ==========================================================================

  protected buildPersistentCliArgs(settings: Settings, session: PanelSessionState): string[] | null {
    const hermes = session as HermesSessionState;
    // Fresh process → fresh protocol state. The ACP session dies with the
    // process; clearing sessionId makes the base re-send conversation
    // history on the first prompt of the new process.
    hermes.rpcId = 0;
    hermes.initializeId = null;
    hermes.sessionNewId = null;
    hermes.promptId = null;
    hermes.acpSessionId = null;
    hermes.pendingPrompt = null;
    hermes.sessionId = null;
    hermes.acpAccessLevel = settings.accessLevel;
    hermes.acpMode = settings.mode;
    hermes.fallbackDiagnostics = false;
    hermes.activeToolCalls.clear();
    return ['acp'];
  }

  /**
   * The base compares {model, permissionMode, thinkingLevel} to decide
   * whether to reuse a persistent process — but _derivePermissionMode
   * collapses read-only and the plan modes into one value, so an
   * accessLevel/mode change under a plan mode would NOT respawn and the
   * permission snapshot (acpAccessLevel/acpMode) would go stale. Require
   * both to match so any change forces a fresh spawn (and fresh snapshot).
   */
  protected _persistentSettingsMatch(session: PanelSessionState, settings: Settings): boolean {
    const hermes = session as HermesSessionState;
    return super._persistentSettingsMatch(session, settings)
      && hermes.acpAccessLevel === settings.accessLevel
      && hermes.acpMode === settings.mode;
  }

  /**
   * First write on a fresh process starts the handshake (initialize);
   * parseStreamLine drives the rest reactively as responses arrive.
   * Subsequent prompts on a live session go straight to session/prompt.
   */
  protected _formatPersistentInput(prompt: string, session: PanelSessionState): string {
    const hermes = session as HermesSessionState;
    hermes.fallbackDiagnostics = false;
    hermes.fallbackErrorEmitted = false;

    if (hermes.acpSessionId) {
      return this._promptRequest(hermes, prompt);
    }

    hermes.pendingPrompt = prompt;
    hermes.initializeId = ++hermes.rpcId;
    return JSON.stringify({
      jsonrpc: '2.0',
      id: hermes.initializeId,
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

  private _promptRequest(hermes: HermesSessionState, prompt: string): string {
    hermes.promptId = ++hermes.rpcId;
    return JSON.stringify({
      jsonrpc: '2.0',
      id: hermes.promptId,
      method: 'session/prompt',
      params: {
        sessionId: hermes.acpSessionId,
        prompt: [{ type: 'text', text: prompt }]
      }
    }) + '\n';
  }

  private _writeToAcp(hermes: HermesSessionState, message: Record<string, unknown>): void {
    const proc = hermes.persistentProcess;
    if (proc?.stdin?.writable) {
      proc.stdin.write(JSON.stringify(message) + '\n');
    }
  }

  /**
   * The turn ends when the session/prompt JSON-RPC *response* arrives —
   * uniquely identified by `result.stopReason` (initialize and
   * session/new results carry no stopReason). Error responses to any of
   * our requests also end the turn (parseStreamLine reports them).
   * Server→client *requests* (they carry `method`) never end the turn.
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
   * Cancel by DROPPING the ACP process, not by sending session/cancel.
   *
   * A graceful session/cancel leaves the prompt request outstanding until
   * Hermes finishes aborting, and the base immediately frees the read loop
   * (session.process = null); the next turn then reuses the same live
   * process and its stale `{stopReason:"cancelled"}` response terminates the
   * NEW turn (or is misattributed to the new promptId). The base's default
   * raw Ctrl+C byte is worse still — it corrupts the JSON-RPC line stream.
   * Killing the process removes the whole race class: the next turn spawns a
   * fresh `hermes acp`, re-runs buildPersistentCliArgs (clean protocol state),
   * and re-sends conversation history.
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
    const hermes = session as HermesSessionState;
    hermes.fallbackDiagnostics = true;
    hermes.fallbackErrorEmitted = false;
    return ['acp', '--check'];
  }

  // ==========================================================================
  // Stream parsing — ACP JSON-RPC (persistent) or diagnostics (fallback)
  // ==========================================================================

  protected parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    const hermes = session as HermesSessionState;

    // Fallback context: we're running `hermes acp --check` diagnostics.
    // Surface one actionable error, swallow the rest.
    if (hermes.fallbackDiagnostics) {
      return this._parseFallbackLine(line, hermes);
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
      return this._handleSessionUpdate(data.params as Record<string, unknown> | undefined, hermes);
    }

    // --- Server→client requests (they carry method AND id) ---
    if (typeof data.method === 'string' && data.id !== undefined && data.id !== null) {
      if (data.method === 'session/request_permission') {
        this._respondToPermissionRequest(data.id as number | string, data.params as Record<string, unknown> | undefined, hermes);
      } else {
        // We advertised no fs/terminal capabilities; unblock anything unexpected
        this._writeToAcp(hermes, {
          jsonrpc: '2.0',
          id: data.id,
          error: { code: -32601, message: `Method not supported by Mysti: ${data.method}` }
        });
      }
      return null;
    }

    // --- Responses to our requests ---
    if (data.id !== undefined && data.id !== null) {
      return this._handleRpcResponse(data, hermes);
    }

    return null;
  }

  private _handleRpcResponse(data: Record<string, unknown>, hermes: HermesSessionState): StreamChunk | null {
    const error = data.error as { code?: number; message?: string } | undefined;
    const result = (data.result ?? {}) as Record<string, unknown>;

    if (data.id === hermes.initializeId) {
      hermes.initializeId = null;
      if (error) {
        return { type: 'error', content: `Hermes ACP initialize failed: ${error.message || 'unknown error'}` };
      }
      hermes.sessionNewId = ++hermes.rpcId;
      const workspaceFolders = vscode.workspace.workspaceFolders;
      this._writeToAcp(hermes, {
        jsonrpc: '2.0',
        id: hermes.sessionNewId,
        method: 'session/new',
        params: {
          cwd: workspaceFolders ? workspaceFolders[0].uri.fsPath : process.cwd(),
          mcpServers: []
        }
      });
      return null;
    }

    if (data.id === hermes.sessionNewId) {
      hermes.sessionNewId = null;
      if (error) {
        // No provider credentials is the overwhelmingly common cause
        return {
          type: 'auth_error',
          content: `Hermes could not start a session: ${error.message || 'authentication required'}. Run "hermes setup" to configure a provider.`,
          authCommand: 'hermes setup',
          providerName: 'Hermes'
        };
      }
      const sessionId = String((result.sessionId ?? result.session_id) || '');
      if (!sessionId) {
        return { type: 'error', content: 'Hermes ACP returned no session id.' };
      }
      hermes.acpSessionId = sessionId;
      hermes.sessionId = sessionId;
      const prompt = hermes.pendingPrompt ?? '';
      hermes.pendingPrompt = null;
      if (hermes.persistentProcess?.stdin?.writable) {
        hermes.persistentProcess.stdin.write(this._promptRequest(hermes, prompt));
      }
      // Deliberately emit NO chunk here. usedPersistent must flip only once
      // the prompt is actually answered (the boundary session_active below),
      // so a process death DURING the first prompt yields zero chunks and
      // surfaces the diagnostic fallback instead of a silent empty reply.
      return null;
    }

    if (data.id === hermes.promptId) {
      hermes.promptId = null;
      if (error) {
        return { type: 'error', content: `Hermes: ${error.message || 'prompt failed'}` };
      }
      const usage = (result.usage ?? {}) as Record<string, unknown>;
      const input = Number(usage.inputTokens ?? usage.input_tokens ?? 0);
      const output = Number(usage.outputTokens ?? usage.output_tokens ?? 0);
      if (input > 0 || output > 0) {
        hermes.lastUsageStats = { input_tokens: input, output_tokens: output };
      }
      const stopReason = String(result.stopReason ?? result.stop_reason ?? 'end_turn');
      if (stopReason === 'refusal') {
        return { type: 'error', content: 'Hermes declined to complete this request (stopReason: refusal).' };
      }
      // Guarantee ≥1 chunk per turn so the base never mistakes an empty
      // response for a dead persistent process (which would trigger the
      // single-shot fallback and re-run diagnostics over the user's turn).
      return { type: 'session_active', sessionId: hermes.acpSessionId || undefined };
    }

    return null;
  }

  private _handleSessionUpdate(params: Record<string, unknown> | undefined, hermes: HermesSessionState): StreamChunk | null {
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
        // Name off the semantic `kind`, not the display `title` (which is
        // "terminal: <cmd>", "read: <path>", … and would poison classify/
        // render heuristics that key on tool NAMES).
        const acpKind = String(update.kind ?? '').toLowerCase();
        // Fallback strips the "<verb>: <args>" display form to just the verb
        // before normalizing, so tool args never reach classification.
        const toolName = ACP_KIND_TO_TOOL_NAME[acpKind]
          || normalizeToolName(String(update.title ?? 'tool').split(':')[0].trim())
          || 'tool';
        const input = (update.rawInput ?? update.raw_input ?? {}) as Record<string, unknown>;
        hermes.activeToolCalls.set(toolId, { id: toolId, name: toolName, input });
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
        const toolInfo = hermes.activeToolCalls.get(toolId);
        hermes.activeToolCalls.delete(toolId);
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

      // Context-window telemetry, plan entries, command lists, echoes —
      // no Mysti rendering yet
      case 'usage_update':
      case 'plan':
      case 'user_message_chunk':
      case 'session_info_update':
      case 'available_commands_update':
        return null;

      default:
        return null;
    }
  }

  /**
   * Answer Hermes's blocking `session/request_permission` request.
   *
   * ACP is a blocking permission protocol — Hermes waits for allow/deny
   * before executing a tool — and this response is written SYNCHRONOUSLY,
   * before the corresponding tool_use chunk can reach Mysti's async
   * stream-level gate. So the gate cannot enforce for Hermes; THIS is the
   * enforcement point, and it FAILS CLOSED: it auto-allows only when the
   * user's settings mean "don't ask me" (the same predicate Mysti uses to
   * decide whether to gate). In any mode that would otherwise prompt, and
   * whenever the decision is uncertain, it DENIES — never silently
   * auto-approves a dangerous tool a prompt-injected agent requested.
   * (Interactive per-tool approval would need an async ACP↔card bridge; a
   * denial here is recoverable — the user switches to Full access for
   * autonomous runs.)
   */
  private _respondToPermissionRequest(id: number | string, params: Record<string, unknown> | undefined, hermes: HermesSessionState): void {
    const options = (params?.options ?? []) as AcpPermissionOption[];
    const optionIdOf = (o: AcpPermissionOption) => String(o.optionId ?? o.option_id ?? '');

    // Prefer the kind carried on the permission request; fall back to the
    // tracked tool call; default to the most dangerous class (fail closed).
    const toolCall = (params?.toolCall ?? params?.tool_call) as Record<string, unknown> | undefined;
    const kind = String(toolCall?.kind ?? '').toLowerCase();
    const allow = this._acpPermissionAllows(kind, hermes);

    const ALLOW_IDS = ['allow_once', 'allow_session', 'allow_always'];
    const DENY_IDS = ['deny', 'deny_always', 'reject_once', 'reject_always'];
    const pick = (wanted: string[]): string | null => {
      for (const w of wanted) {
        const match = options.find(o => optionIdOf(o) === w || o.kind === w);
        if (match) { return optionIdOf(match); }
      }
      return null;
    };

    let chosen: string | null;
    if (allow) {
      // If we mean to allow but find no allow option, fail closed (deny).
      chosen = pick(ALLOW_IDS) ?? pick(DENY_IDS);
    } else {
      // Denying: ONLY ever select a real deny option. If none is offered, leave
      // chosen=null so the `cancelled` outcome fires — never fall back to an
      // arbitrary option (a last/only option could be an allow ⇒ fail open).
      chosen = pick(DENY_IDS);
    }

    this._writeToAcp(hermes, {
      jsonrpc: '2.0',
      id,
      result: chosen
        ? { outcome: { outcome: 'selected', optionId: chosen } }
        : { outcome: { outcome: 'cancelled' } }
    });
  }

  /**
   * Whether an ACP tool of the given semantic `kind` may auto-run under the
   * snapshotted settings. Mirrors Mysti's shouldGateToolUse predicate (but
   * inverted — "wouldn't gate" ⇒ allow): read-only kinds always run; the
   * autonomous Full-access tier runs everything; the accept-edits tier runs
   * edits/moves only; every "ask" mode denies (we can't prompt synchronously).
   * Unknown kinds fail closed.
   */
  private _acpPermissionAllows(kind: string, hermes: HermesSessionState): boolean {
    if (kind === 'read' || kind === 'search' || kind === 'think') {
      return true;
    }
    const { acpMode: mode, acpAccessLevel: access } = hermes;
    if (access === 'read-only' || mode === 'quick-plan' || mode === 'detailed-plan') {
      return false;
    }
    // Full access (autonomous) — Mysti would not gate.
    if (access === 'full-access') {
      return true;
    }
    // Accept-edits tier: edits/moves auto-apply; commands/deletes/fetch ask.
    if (mode === 'edit-automatically' && access === 'ask-permission') {
      return kind === 'edit' || kind === 'move';
    }
    // ask-before-edit / default ask-permission / unknown kind → deny.
    return false;
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

  private _parseFallbackLine(line: string, hermes: HermesSessionState): StreamChunk | null {
    const trimmed = line.trim();
    if (!trimmed || hermes.fallbackErrorEmitted) {
      return null;
    }
    hermes.fallbackErrorEmitted = true;
    return {
      type: 'error',
      content: 'Hermes ACP transport is unavailable, so this message was not processed. '
        + 'Mysti drives Hermes through "hermes acp" — run "hermes acp --check" and "hermes doctor" in a terminal, '
        + 'update with "hermes update", then try again.\n'
        + `First diagnostic line: ${trimmed.slice(0, 300)}`
    };
  }

  // ==========================================================================
  // Usage + lifecycle
  // ==========================================================================

  getStoredUsage(panelId?: string): { input_tokens: number; output_tokens: number } | null {
    const session = this._getSession(panelId) as HermesSessionState;
    const usage = session.lastUsageStats;
    session.lastUsageStats = null;
    return usage;
  }

  clearSession(panelId?: string): void {
    // Drop the ACP process too: its session/protocol state (initialized
    // connection, request-id counter, ACP session id) cannot be reset on a
    // live connection without a duplicate `initialize` and id collisions.
    // A fresh process re-handshakes cleanly on the next turn.
    this.disposePersistentProcess(panelId);
    super.clearSession(panelId);
    if (panelId) {
      const session = this._panelSessions.get(panelId) as HermesSessionState | undefined;
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
