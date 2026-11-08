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
 * (initialize → session/new → optional model selection → session/prompt), and session/update
 * notifications mapped onto Mysti StreamChunks. The prompt's JSON-RPC
 * *response* (carrying `stopReason`) is the response boundary.
 *
 * Kimi's own coding models (Kimi K2.7 Code / K3, 256K–1M context) reason, so
 * ACP `agent_thought_chunk` notifications surface as thinking. Model choice
 * is confirmed through ACP session configuration before the first prompt.
 * Without an explicit selection, the native account model is used. Reported
 * model identity comes from the session, including later configuration updates.
 *
 * Requests require ACP. Startup failures retain their cause, and an exit
 * before the prompt response is incomplete even with code 0. Diagnostic
 * `acp --check` output never replaces a failed request or replays its prompt.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BaseCliProvider, type PanelSessionState } from '../base/BaseCliProvider';
import { respondToAcpApproval } from '../base/AcpApproval';
import { allowsUnrestrictedNativeTools } from '../base/NativeApprovalPolicy';
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
  AccessLevel,
  AskUserQuestionItem
} from '../../types';
import type { ChildProcess } from 'child_process';
import { normalizeAskUserQuestions } from '../../utils/askUserQuestions';
import { isRecord } from '../../utils/valueGuards';
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
  modelSetId: number | null;
  promptId: number | null;
  /** Explicit selection captured when this process starts. */
  requestedModel?: string;
  /** Last valid model identity reported by this native session. */
  confirmedModel?: string;
  /** ACP server-issued session id (persists across prompts on one process). */
  acpSessionId: string | null;
  /** Prompt stashed until session creation and any explicit model selection complete. */
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
  /** ACP `usage_update.size` — the window the agent reports working in, until taken. */
  reportedContextWindow?: number;
  activeToolCalls: Map<string, { id: string; name: string; input: Record<string, unknown> }>;
  lastUsageStats: { input_tokens: number; output_tokens: number } | null;
  /** AskUserQuestion requests held for Mysti's card, by the card's toolCallId. */
  questions?: Map<string, (answers: QuestionAnswers | null) => void>;
}

/** Card answers keyed by header (Q1… when empty); option labels, string[] for multi-select. */
type QuestionAnswers = Record<string, string | string[]>;

/** A native question Mysti can show, and how to encode the user's reply for Kimi. */
interface NativeQuestion {
  toolCallId: unknown;
  questions: unknown[];
  reply(answers: QuestionAnswers | null | 'cancelled', questions: AskUserQuestionItem[]): Record<string, unknown>;
}

/** The labels chosen for one question; autonomous answers may key by the bare header. */
function chosenLabels(answers: QuestionAnswers, question: AskUserQuestionItem, index: number): string[] {
  const value = answers[question.header || `Q${index + 1}`] ?? answers[question.header] ?? answers[question.question];
  return value === undefined ? [] : [value].flat();
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
    // The callback bridge exists, but native saved allows can skip it.
    supportsNativeApproval: true,
    supportsAskPermission: false,
    supportsReadOnly: false,
    supportsSessions: true,
    supportsPersistentProcess: true,
    // Plan 27 Phase 5: attachments are written to a temp file and referenced
    // by PATH (BaseCliProvider.prepareAttachments). This backend has file-read
    // tools, so it can open what it is given.
    supportsImages: true,
    supportsFileAttachments: true,
    supportsAutoInstall: false,  // installed via the official script/Homebrew (wizard shows the OS command)
    supportsPromptEnhancement: false,
    thinkingStyle: 'streamed',
    thinkingLevelEffective: false, // reasoning is governed by the Kimi model, not a Mysti level
    planMode: 'none',
    nativeModes: { approvals: true }, // only full access runs; other tiers are refused
    // Continuity lives in the ACP session held by the persistent process;
    // session.sessionId mirrors it so history is only re-sent after a respawn.
    sessionKind: 'cli-resume',
    emitsToolResults: true,
    emitsUsage: true,
    usageConvention: 'none',   // ACP usage carries flat input/output only.
    // Explicit selections must be confirmed by the ACP session before dispatch.
    modelSelection: 'full'
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
      modelSetId: null,
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

  protected override getAuthenticationEnvironmentKeys(): readonly string[] {
    return [...KimiCodeProvider._envKeys, 'KIMI_HOME'];
  }

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

  /** Select a native model ID for the ACP session configuration handshake. */
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

  // ==========================================================================
  // Persistent mode — the primary transport (`kimi acp`, JSON-RPC/stdio)
  // ==========================================================================

  override async *sendMessage(...args: Parameters<BaseCliProvider['sendMessage']>): AsyncGenerator<StreamChunk> {
    this._assertAcpPermissionSupport(args[2]);
    yield* super.sendMessage(...args);
  }

  override async preSpawnPersistentProcess(panelId: string, settings: Settings): Promise<void> {
    // Warming is advisory; unsupported authority must not create, replace or
    // reconfigure an existing panel process before the user sends a request.
    if (!allowsUnrestrictedNativeTools(settings)) { return; }
    await super.preSpawnPersistentProcess(panelId, settings);
  }

  private _assertAcpPermissionSupport(settings: Settings): void {
    // Kimi can execute saved native allows without an ACP approval request.
    // Its Plan guard does not deny every command or delegated tool either.
    if (!allowsUnrestrictedNativeTools(settings)) {
      throw new Error('Kimi Code ACP cannot enforce Plan, Read Only, or approval-based modes safely. Use another agent with native approvals, or explicitly select Edit Automatically with Full Access.');
    }
  }

  protected override requiresPersistentTransport(): boolean { return true; }

  protected buildPersistentCliArgs(settings: Settings, session: PanelSessionState): string[] | null {
    this._assertAcpPermissionSupport(settings);
    const kimi = session as KimiCodeSessionState;
    // Fresh process → fresh protocol state. The ACP session dies with the
    // process; clearing sessionId makes the base re-send conversation history
    // on the first prompt of the new process.
    kimi.rpcId = 0;
    kimi.initializeId = null;
    kimi.sessionNewId = null;
    kimi.modelSetId = null;
    kimi.promptId = null;
    kimi.requestedModel = this._getEffectiveModel(settings);
    kimi.confirmedModel = undefined;
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
          terminal: false,
          // Kimi then asks AskUserQuestion through `elicitation/create` with
          // every question; without it, request_permission carries only the first.
          elicitation: { form: {} }
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

  private _writeToAcp(kimi: KimiCodeSessionState, message: Record<string, unknown>, proc: ChildProcess | null = kimi.persistentProcess): void {
    if (proc?.stdin?.writable) {
      proc.stdin.write(JSON.stringify(message) + '\n');
    }
  }

  /**
   * A reply to the outstanding prompt ends the turn; the parser validates
   * its stop reason before accepting it. Malformed session creation also
   * ends the turn with an error instead of leaving the request waiting.
   * Errors to outstanding handshake or prompt requests also end the turn.
   * Stale/unknown IDs must not end a newer turn before its parser runs.
   * Server→client *requests* (they carry `method`) never end the turn.
   */
  protected _isResponseBoundary(line: string, session?: PanelSessionState): boolean {
    if (!session) { return false; }
    const kimi = session as KimiCodeSessionState;
    try {
      const data = JSON.parse(line.trim());
      if (data.method !== undefined || data.id === undefined || data.id === null) {
        return false;
      }
      const matches = (id: number | null) => id !== null && data.id === id;
      if (data.error) {
        return matches(kimi.initializeId) || matches(kimi.sessionNewId)
          || matches(kimi.modelSetId) || matches(kimi.promptId);
      }
      if (matches(kimi.modelSetId)) { return !this._modelSelectionConfirmed(data.result, kimi); }
      if (matches(kimi.promptId)) { return true; }
      return matches(kimi.sessionNewId)
        && !this._nonEmptyRpcString(data.result?.sessionId ?? data.result?.session_id);
    } catch {
      return false;
    }
  }

  private _nonEmptyRpcString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
  }

  private _reportedModel(configOptions: unknown): string | undefined {
    if (!Array.isArray(configOptions)) { return undefined; }
    const models = configOptions.filter(option => option && typeof option === 'object' && option.id === 'model');
    if (models.length !== 1 || models[0].type !== 'select') { return undefined; }
    const value: unknown = models[0].currentValue;
    return typeof value === 'string' && value === value.trim() && validateModelName(value).valid ? value : undefined;
  }

  private _modelSelectionConfirmed(result: unknown, kimi: KimiCodeSessionState): boolean {
    return !!kimi.requestedModel && !!result && typeof result === 'object'
      && this._reportedModel((result as Record<string, unknown>).configOptions) === kimi.requestedModel;
  }

  private _releasePendingPrompt(kimi: KimiCodeSessionState): void {
    const prompt = kimi.pendingPrompt;
    kimi.pendingPrompt = null;
    if (prompt !== null && kimi.persistentProcess?.stdin?.writable) {
      kimi.persistentProcess.stdin.write(this._promptRequest(kimi, prompt));
    }
  }

  private _modelSelectionFailed(kimi: KimiCodeSessionState, reason: string): StreamChunk {
    kimi.modelSetId = null;
    kimi.pendingPrompt = null;
    kimi.confirmedModel = undefined;
    this._interruptPersistentProcess(kimi);
    return { type: 'error', content: `Kimi Code model selection failed: ${reason}. The connection was reset; retry the request.` };
  }

  private _withReportedModel(chunk: StreamChunk | null, kimi: KimiCodeSessionState): StreamChunk | null {
    return chunk && kimi.confirmedModel ? { ...chunk, reportedModel: kimi.confirmedModel } : chunk;
  }

  private _malformedRpcResponse(kimi: KimiCodeSessionState, field: string): StreamChunk {
    // The invalid reply consumed an outstanding request, so this connection
    // cannot provide a usable session/turn. Evict its captured child; the next
    // explicit request starts a fresh ACP handshake.
    this._interruptPersistentProcess(kimi);
    return { type: 'error', content: `Kimi Code ACP returned a missing or invalid ${field}. The connection was reset; retry the request.` };
  }

  /**
   * Cancel by DROPPING the ACP process. A graceful session/cancel leaves
   * output outstanding while the base frees the reader. Correlated reply IDs
   * cannot prevent late session/update notifications from entering a later
   * turn on the same connection. Dropping it makes the next turn spawn a fresh
   * `kimi acp`, reset protocol state, and re-send conversation history.
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
  // Diagnostic argument/parser support — never a request fallback
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
      return this._withReportedModel(this._handleSessionUpdate(data.params as Record<string, unknown> | undefined, kimi), kimi);
    }

    // --- Server→client requests (they carry method AND id) ---
    if (typeof data.method === 'string' && data.id !== undefined && data.id !== null) {
      const id = data.id as number | string;
      const params = isRecord(data.params) ? data.params : undefined;
      if (data.method === 'elicitation/create') {
        // Unshowable forms get an error: Kimi then retries the same question
        // through request_permission, which the branch below also holds.
        return this._holdQuestion(kimi, id, params, this._elicitationQuestion(params),
          { error: { code: -32602, message: 'Mysti cannot present this form' } });
      }
      const question = data.method === 'session/request_permission' ? this._permissionQuestion(params) : undefined;
      if (question) {
        return this._holdQuestion(kimi, id, params, question, { result: question.reply('cancelled', []) });
      }
      if (data.method === 'session/request_permission') {
        this._respondToPermissionRequest(id, params, kimi);
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
      return this._withReportedModel(this._handleRpcResponse(data, kimi), kimi);
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
      const sessionId = this._nonEmptyRpcString(result.sessionId ?? result.session_id);
      if (!sessionId) {
        return this._malformedRpcResponse(kimi, 'session ID');
      }
      kimi.acpSessionId = sessionId;
      kimi.sessionId = sessionId;
      if (kimi.requestedModel) {
        kimi.modelSetId = ++kimi.rpcId;
        this._writeToAcp(kimi, {
          jsonrpc: '2.0', id: kimi.modelSetId, method: 'session/set_config_option',
          params: { sessionId, configId: 'model', value: kimi.requestedModel }
        });
        return null;
      }
      kimi.confirmedModel = this._reportedModel(result.configOptions);
      this._releasePendingPrompt(kimi);
      // Session creation is not a completed response. Wait for the prompt's
      // correlated terminal; the required transport reports an earlier exit
      // as incomplete, including an empty response or a clean process exit.
      return kimi.confirmedModel ? { type: 'model_info', reportedModel: kimi.confirmedModel } : null;
    }

    if (data.id === kimi.modelSetId) {
      if (error) { return this._modelSelectionFailed(kimi, error.message || 'the requested model was rejected'); }
      if (!this._modelSelectionConfirmed(result, kimi)) {
        return this._modelSelectionFailed(kimi, 'the native session did not confirm the requested model');
      }
      kimi.modelSetId = null;
      kimi.confirmedModel = this._reportedModel(result.configOptions);
      this._releasePendingPrompt(kimi);
      return { type: 'model_info', reportedModel: kimi.confirmedModel };
    }

    if (data.id === kimi.promptId) {
      kimi.promptId = null;
      if (error) {
        return { type: 'error', content: `Kimi Code: ${error.message || 'prompt failed'}` };
      }
      const stopReason = this._nonEmptyRpcString(result.stopReason ?? result.stop_reason);
      if (!stopReason) { return this._malformedRpcResponse(kimi, 'stop reason'); }
      const usage = (result.usage ?? {}) as Record<string, unknown>;
      const input = Number(usage.inputTokens ?? usage.input_tokens ?? 0);
      const output = Number(usage.outputTokens ?? usage.output_tokens ?? 0);
      if (input > 0 || output > 0) {
        kimi.lastUsageStats = { input_tokens: input, output_tokens: output };
      }
      if (stopReason === 'refusal') {
        return { type: 'error', content: 'Kimi Code declined to complete this request (stopReason: refusal).' };
      }
      // A valid prompt terminal may complete without generated text. Preserve
      // its session activation without inventing an assistant message.
      return { type: 'session_active', sessionId: kimi.acpSessionId || undefined };
    }

    return null;
  }

  private _handleSessionUpdate(params: Record<string, unknown> | undefined, kimi: KimiCodeSessionState): StreamChunk | null {
    const update = (params?.update ?? {}) as Record<string, unknown>;
    const kind = String(update.sessionUpdate ?? update.session_update ?? '');

    switch (kind) {
      case 'config_option_update': {
        // Native updates can precede the setter ACK. Only its correlated reply
        // may confirm selection and release the pending prompt.
        if (!kimi.acpSessionId || params?.sessionId !== kimi.acpSessionId || kimi.modelSetId !== null) { return null; }
        const model = this._reportedModel(update.configOptions);
        if (!model) { return null; }
        kimi.confirmedModel = model;
        return { type: 'model_info', reportedModel: model };
      }

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

      // The agent's own context window — authoritative over any catalog
      // (the model is configured in its own config, outside Mysti).
      case 'usage_update':
        if (typeof update.size === 'number' && update.size > 0) { kimi.reportedContextWindow = update.size; }
        return null;

      // Plan entries, echoes — no Mysti rendering yet
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

  /**
   * Hold Kimi's AskUserQuestion for Mysti's card; the user's answer settles
   * it so Kimi continues the same turn. A question is never auto-answered:
   * one that cannot be shown or held gets `unusable`, and the turn or process
   * ending cancels it.
   */
  private _holdQuestion(
    kimi: KimiCodeSessionState, id: number | string, params: Record<string, unknown> | undefined,
    ask: NativeQuestion | undefined, unusable: Record<string, unknown>,
  ): StreamChunk | null {
    const questions = ask && normalizeAskUserQuestions(ask.questions);
    const toolCallId = typeof ask?.toolCallId === 'string' && ask.toolCallId.trim() ? ask.toolCallId : `kimi-question-${id}`;
    const held = (kimi.questions ??= new Map());
    const settle = ask && questions && params?.sessionId === kimi.acpSessionId && !held.has(toolCallId)
      ? this._nativeApprovalRequests(kimi)?.hold<QuestionAnswers | null>(id, (answers, target) => {
        held.delete(toolCallId);
        this._writeToAcp(kimi, { jsonrpc: '2.0', id, result: ask.reply(answers, questions) }, target);
      })
      : undefined;
    if (!settle || !questions) {
      this._writeToAcp(kimi, { jsonrpc: '2.0', id, ...unusable });
      return null;
    }
    held.set(toolCallId, settle);
    return { type: 'ask_user_question', askUserQuestion: { toolCallId, questions } };
  }

  /**
   * Kimi's form for AskUserQuestion: one field per question (q0, q1…),
   * single-select `oneOf`, multi-select an array of `anyOf`. Each title is
   * the header, or the question text when it has none; the message joins
   * the question texts with newlines.
   */
  private _elicitationQuestion(params: Record<string, unknown> | undefined): NativeQuestion | undefined {
    const schema = isRecord(params?.requestedSchema) ? params.requestedSchema : undefined;
    const fields = isRecord(schema?.properties) ? schema.properties : undefined;
    if (params?.mode !== 'form' || !fields) { return undefined; }
    const keys = Object.keys(fields);
    const message = typeof params.message === 'string' ? params.message : '';
    const lines = keys.length === 1 ? [message] : message.split('\n');
    return {
      toolCallId: params.toolCallId,
      // Any unrecognised field invalidates the whole card (normalizeAskUserQuestions).
      questions: keys.map((key, index) => {
        const field = isRecord(fields[key]) ? fields[key] : {};
        const multiSelect = field.type === 'array';
        const choices = multiSelect ? (isRecord(field.items) ? field.items.anyOf : undefined) : field.oneOf;
        if (!Array.isArray(choices)) { return undefined; }
        const title = typeof field.title === 'string' ? field.title : '';
        const text = (lines.length === keys.length ? lines[index].trim() : '') || title;
        const body = typeof field.description === 'string' && field.description.trim() ? `\n\n${field.description}` : '';
        return {
          question: text + body, header: title === text ? '' : title, multiSelect,
          options: choices.map(choice => isRecord(choice) ? { label: choice.const, description: choice.description } : choice),
        };
      }),
      reply: (answers, questions) => answers === 'cancelled' ? { action: 'cancel' }
        : answers === null ? { action: 'decline' }
        : { action: 'accept', content: Object.fromEntries(keys.flatMap((key, index) => {
          const labels = chosenLabels(answers, questions[index], index);
          return labels.length ? [[key, questions[index].multiSelect ? labels : labels[0]]] : [];
        })) },
    };
  }

  /**
   * Kimi's AskUserQuestion fallback over request_permission: titled
   * "AskUserQuestion", the first question's text as content, one `q0_opt_N`
   * option per answer plus `q0_skip`. An approval of the AskUserQuestion tool
   * itself uses approval option IDs and stays on the approval path.
   */
  private _permissionQuestion(params: Record<string, unknown> | undefined): NativeQuestion | undefined {
    const tool = isRecord(params?.toolCall) ? params.toolCall : {};
    const options = Array.isArray(params?.options) ? params.options.filter(isRecord) : [];
    const ids = options.map(option => String(option.optionId));
    const answerable = options.filter(option => /^q0_opt_\d+$/.test(String(option.optionId)));
    if (tool.title !== 'AskUserQuestion' || !answerable.length || !ids.every(id => /^q0_(opt_\d+|skip)$/.test(id))) { return undefined; }
    return {
      toolCallId: tool.toolCallId,
      questions: [{ question: this._toolOutputText({ content: tool.content }), options: answerable.map(option => ({ label: option.name })) }],
      reply: (answers, [question]) => {
        // Kimi accepts only its own options, so free text is a dismissal too.
        const label = answers && answers !== 'cancelled' ? chosenLabels(answers, question, 0)[0] : undefined;
        const chosen = answers === 'cancelled' ? undefined
          : answerable.find(option => option.name === label)?.optionId ?? (ids.includes('q0_skip') ? 'q0_skip' : undefined);
        return { outcome: chosen ? { outcome: 'selected', optionId: chosen } : { outcome: 'cancelled' } };
      },
    };
  }

  /** Nobody will show this question (Brainstorm, background runs): dismiss it, never auto-answer. */
  protected override releaseNativeQuestion(session: PanelSessionState, toolCallId: string): void {
    (session as KimiCodeSessionState).questions?.get(toolCallId)?.(null);
  }

  /** Answer a question this panel's turn holds (null = skipped). False when none owns it. */
  public answerNativeQuestion(panelId: string, toolCallId: string, answers: QuestionAnswers | null): boolean {
    const settle = (this._panelSessions.get(panelId) as KimiCodeSessionState | undefined)?.questions?.get(toolCallId);
    settle?.(answers);
    return !!settle;
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

  protected override takeReportedContextWindow(panelId?: string): number | undefined {
    const session = this._getSession(panelId) as KimiCodeSessionState;
    const window = session.reportedContextWindow;
    session.reportedContextWindow = undefined;
    return window;
  }

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
