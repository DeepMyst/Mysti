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
 * Two generations share the `kimi` binary name and the `kimi acp` transport:
 *  - Kimi Code 2.x (and its 0.x predecessors): the TypeScript rewrite, npm
 *    `@moonshot-ai/kimi-code` or the official installer (~/.kimi-code/bin).
 *    Data root ~/.kimi-code (KIMI_CODE_HOME). `--version` prints a bare semver.
 *  - kimi-cli 1.x: the Python CLI (PyPI `kimi-cli`). Data root ~/.kimi
 *    (KIMI_SHARE_DIR). `--version` prints `kimi, version 1.x.y`. 1.52.0 is the
 *    final release and a tombstone: every subcommand, `acp` included, prints a
 *    "no longer maintained" notice and exits, and bare `kimi` runs the Kimi
 *    Code installer without asking. 1.51 and earlier still speak ACP.
 * Both keep OAuth tokens in `<home>/credentials/<name>.json` and both accept
 * `session/set_model` (neither reads ANTHROPIC_MODEL, which is what Mysti
 * used to set).
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
 * ACP `agent_thought_chunk` notifications surface as thinking. A selected
 * model is applied with `session/set_model` right after `session/new`; a bare
 * id (`k3`) is matched against the aliases the agent reported (`kimi-code/k3`).
 *
 * Kimi Code 2.x applies the user's `default_permission_mode = "yolo"|"auto"`
 * and `default_plan_mode` to ACP sessions while still reporting mode
 * `default`. Witnessed on 2.0.2: an inherited yolo ran Bash with no
 * `session/request_permission`. So when the agent advertises more than one
 * mode, Mysti sends `session/set_mode {modeId:'default'}` before the first
 * prompt, which restores per-tool requests for the main agent.
 *
 * The single-shot fallback only runs `kimi --version` so the error names the
 * binary that failed; neither generation has a one-shot ACP diagnostic
 * (`acp --check` was never a real option and both reject it).
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BaseCliProvider, type PanelSessionState } from '../base/BaseCliProvider';
import { respondToAcpApproval } from '../base/AcpApproval';
import { requireUnrestrictedLegacyTransport } from '../base/NativeApprovalPolicy';
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
  ModelInfo
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
  /** Model to apply with session/set_model once the ACP session exists. */
  requestedModel: string | null;
  /** Setup requests (set_mode / set_model) still to send before the prompt. */
  pendingSetup: Array<{ method: string; params: Record<string, unknown>; failure: string }>;
  /** Id + failure text of the setup request awaiting its response. */
  setupId: number | null;
  setupFailure: string;
  /** Model ids the agent reported on session/new (2.x configOptions, 1.x models). */
  reportedModels: string[] | null;
  /** True while the single-shot diagnostic fallback (`--version`) runs. */
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
        description: 'Uses default_model from your Kimi config (or `/model`)',
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
    // Applied per session with session/set_model (see _startSessionSetup).
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
      promptId: null,
      acpSessionId: null,
      pendingPrompt: null,
      requestedModel: null,
      pendingSetup: [],
      setupId: null,
      setupFailure: '',
      reportedModels: null,
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

  /** The official 2.x installer's location, which a GUI-launched host's PATH may lack. */
  protected _getAdditionalSearchPaths(): string[] {
    const binary = process.platform === 'win32' ? 'kimi.exe' : 'kimi';
    return [path.join(os.homedir(), '.kimi-code', 'bin', binary)];
  }

  /**
   * True for the Python kimi-cli (1.x), false for Kimi Code (0.x/2.x), null
   * when discovery has not reported a version. Only the Python CLI prints
   * `kimi, version …`, and the TypeScript line skipped 1.x entirely.
   */
  private _isLegacyCli(): boolean | null {
    const raw = this.getCachedCliVersion();
    if (!raw) { return null; }
    return /\bversion\b/i.test(raw) || this._getCliMajorVersion() === 1;
  }

  /**
   * Data roots to look in, current layout first. A known version picks its
   * own; an unknown one checks both, because a user who migrated may still
   * have the other directory lying around.
   */
  private _kimiHomes(): string[] {
    const current = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
    const legacy = process.env.KIMI_SHARE_DIR || path.join(os.homedir(), '.kimi');
    const isLegacy = this._isLegacyCli();
    return isLegacy === null ? [current, legacy] : [isLegacy ? legacy : current];
  }

  /**
   * Presence-only auth probe. OAuth tokens live in `<home>/credentials/*.json`
   * (1.x and 2.x); the directory itself is created before login, so only a
   * file counts, and its contents are never read. An API key lives in
   * config.toml; the only read is a key-shaped match so an empty `api_key = ""`
   * (written for OAuth providers) is not mistaken for one. 2.x also takes a
   * model from KIMI_MODEL_NAME + KIMI_MODEL_API_KEY. Neither generation reads
   * MOONSHOT_API_KEY / KIMI_API_KEY from the shell on their own, so those are
   * not treated as sign-in.
   */
  private _detectAuth(): { kind: 'oauth' | 'api-key' | 'env'; configPath: string } | { kind: null; configPath: string } {
    const homes = this._kimiHomes();
    for (const home of homes) {
      try {
        if (fs.readdirSync(path.join(home, 'credentials')).some(name => name.endsWith('.json'))) {
          return { kind: 'oauth', configPath: path.join(home, 'config.toml') };
        }
      } catch { /* no credentials directory */ }
    }
    for (const home of homes) {
      const configPath = path.join(home, 'config.toml');
      try {
        // `api_key = "…"` or a `[providers.<name>.env]` key such as KIMI_API_KEY.
        if (/^\s*\w*api_key\s*=\s*["']?[^\s"']/im.test(fs.readFileSync(configPath, 'utf-8'))) {
          return { kind: 'api-key', configPath };
        }
      } catch { /* no config */ }
    }
    const configPath = path.join(homes[0], 'config.toml');
    if ((process.env.KIMI_MODEL_NAME || '').trim() && (process.env.KIMI_MODEL_API_KEY || '').trim()) {
      return { kind: 'env', configPath };
    }
    return { kind: null, configPath };
  }

  async getAuthConfig(): Promise<AuthConfig> {
    const auth = this._detectAuth();
    return {
      type: auth.kind === 'oauth' ? 'oauth' : 'api-key',
      isAuthenticated: auth.kind !== null,
      configPath: auth.configPath
    };
  }

  async checkAuthentication(): Promise<AuthStatus> {
    switch (this._detectAuth().kind) {
      case 'oauth': return { authenticated: true, user: 'Kimi Code' };
      case 'api-key': return { authenticated: true, user: 'Kimi Config' };
      case 'env': return { authenticated: true, user: 'Environment (KIMI_MODEL_*)' };
      default: return {
        authenticated: false,
        error: 'Not authenticated. Run "kimi login" (Kimi Code OAuth), or run "kimi" and use "/login" for a Kimi Platform API key.'
      };
    }
  }

  getAuthCommand(): string {
    // Both generations have a device-code `kimi login`. Bare `kimi` is unsafe
    // to suggest: on kimi-cli 1.52 it runs the Kimi Code installer unasked.
    return 'kimi login';
  }

  getInstallCommand(): string {
    return this._installCommandForCurrentOS('curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash');
  }

  getInstallMethods(): InstallMethod[] {
    return [
      { id: 'script', label: 'Install script (macOS/Linux)', command: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash', platform: 'darwin', priority: 1 },
      { id: 'brew', label: 'Homebrew (macOS/Linux)', command: 'brew install kimi-code', platform: 'darwin', priority: 2 },
      { id: 'script-linux', label: 'Install script (Linux/WSL2)', command: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash', platform: 'linux', priority: 1 },
      { id: 'brew-linux', label: 'Homebrew (Linux)', command: 'brew install kimi-code', platform: 'linux', priority: 2 },
      { id: 'ps1', label: 'PowerShell installer (Windows)', command: 'irm https://code.kimi.com/kimi-code/install.ps1 | iex', platform: 'win32', priority: 1 },
      { id: 'npm', label: 'npm (Node.js 22.19+)', command: 'npm install -g @moonshot-ai/kimi-code', platform: 'all', priority: 3 },
    ];
  }

  /**
   * The model aliases the agent reported for any panel's session, or null
   * before one has been created. Reported by Kimi itself (2.x configOptions /
   * 1.x models on session/new), so nothing is read from its config files.
   */
  async discoverModels(_timeoutMs: number): Promise<ModelInfo[] | null> {
    for (const session of this._panelSessions.values()) {
      const reported = (session as KimiCodeSessionState).reportedModels;
      if (reported?.length) { return reported.map(id => ({ id, name: id })); }
    }
    return null;
  }

  protected getThinkingTokens(_thinkingLevel: string): number | undefined {
    return undefined; // reasoning is governed by the Kimi model
  }

  /**
   * Custom model as a Kimi model alias (`kimi-code/k3`) or a bare id (`k3`,
   * resolved against the reported aliases). Applied with session/set_model.
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
    kimi.requestedModel = this._getEffectiveModel(settings) ?? null;
    kimi.pendingSetup = [];
    kimi.setupId = null;
    kimi.reportedModels = null;
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
   * Kimi Code (2.0.2 permissionPolicy) auto-approves in-repository Write/Edit,
   * FetchURL, Agent, AgentSwarm and Skill without an ACP request, even in the
   * `default` (manual) mode Mysti pins. The only policy ahead of those
   * auto-approvals that could force a request is a user-configured `ask`
   * rule in config.toml; there is no flag, env var or ACP parameter to set
   * one per spawn. Ordinary subagents inherit the caller's mode, but Kimi's
   * TowerSpawn workers are forced to `auto`. kimi-cli 1.x applies
   * `default_yolo` with no ACP override at all. Restricted tiers therefore
   * still fail closed.
   */
  protected async _validateNativeApprovalCli(_session: PanelSessionState, settings: Readonly<Settings>): Promise<void> {
    requireUnrestrictedLegacyTransport(settings, this.displayName);
    // kimi-cli 1.52.0 answers `kimi acp` with a deprecation notice and exits.
    const version = /(\d+)\.(\d+)\.\d+/.exec(this.getCachedCliVersion() ?? '');
    if (this._isLegacyCli() && version && Number(version[1]) === 1 && Number(version[2]) >= 52) {
      throw new Error(`The installed kimi-cli ${version[0]} is the final Python release and no longer runs (every command only prints a deprecation notice), so this turn was not started. Install Kimi Code 2.x: ${this.getInstallCommand()}`);
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
    return ['--version'];
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
          content: `Kimi Code could not start a session: ${error.message || 'authentication required'}. Run "kimi login" to sign in.`,
          authCommand: this.getAuthCommand(),
          providerName: 'Kimi Code'
        };
      }
      const sessionId = String((result.sessionId ?? result.session_id) || '');
      if (!sessionId) {
        return { type: 'error', content: 'Kimi Code ACP returned no session id.' };
      }
      kimi.acpSessionId = sessionId;
      kimi.sessionId = sessionId;
      this._queueSessionSetup(kimi, result);
      this._advanceSetup(kimi);
      // Deliberately emit NO chunk here. usedPersistent must flip only once the
      // prompt is actually answered (the boundary session_active below), so a
      // process death DURING the first prompt yields zero chunks and surfaces
      // the diagnostic fallback instead of a silent empty reply.
      return null;
    }

    if (data.id === kimi.setupId) {
      kimi.setupId = null;
      if (error) {
        // An error response is a turn boundary, so the prompt is never sent.
        kimi.pendingPrompt = null;
        kimi.pendingSetup = [];
        return { type: 'error', content: `${kimi.setupFailure}: ${error.message || 'request rejected'}. The prompt was not sent.` };
      }
      this._advanceSetup(kimi);
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

  /**
   * Decide what must run between session/new and the first prompt, from what
   * the agent reported:
   *  - more than one mode on offer (2.x: default/plan/auto/yolo) → pin
   *    `default`, so an inherited yolo/auto/plan config cannot decide for Mysti;
   *  - a selected model that is not already current → session/set_model, with
   *    a bare id resolved to the single reported alias ending in `/<id>`.
   */
  private _queueSessionSetup(kimi: KimiCodeSessionState, result: Record<string, unknown>): void {
    const sessionId = kimi.acpSessionId;
    const modes = (result.modes ?? {}) as Record<string, unknown>;
    const availableModes = Array.isArray(modes.availableModes) ? modes.availableModes : [];
    const configOptions = Array.isArray(result.configOptions) ? result.configOptions as Array<Record<string, unknown>> : [];
    const modelOption = configOptions.find(option => option?.id === 'model');
    const legacyModels = (result.models ?? {}) as Record<string, unknown>;
    const reported = modelOption && Array.isArray(modelOption.options)
      ? (modelOption.options as Array<Record<string, unknown>>).map(option => String(option?.value ?? ''))
      : Array.isArray(legacyModels.availableModels)
        ? (legacyModels.availableModels as Array<Record<string, unknown>>).map(model => String(model?.modelId ?? model?.model_id ?? ''))
        : [];
    kimi.reportedModels = reported.filter(Boolean);
    const current = String(modelOption?.currentValue ?? legacyModels.currentModelId ?? '');

    kimi.pendingSetup = [];
    if (availableModes.length > 1) {
      kimi.pendingSetup.push({
        method: 'session/set_mode',
        params: { sessionId, modeId: 'default' },
        failure: 'Kimi Code could not be switched to its ask-first default mode',
      });
    }
    const requested = kimi.requestedModel;
    if (requested) {
      const suffixed = kimi.reportedModels.filter(id => id.endsWith(`/${requested}`));
      const modelId = kimi.reportedModels.includes(requested) || suffixed.length !== 1 ? requested : suffixed[0];
      if (modelId !== current) {
        kimi.pendingSetup.push({
          method: 'session/set_model',
          params: { sessionId, modelId },
          failure: `Kimi Code could not select model "${modelId}"`
            + (kimi.reportedModels.length ? ` (it offers: ${kimi.reportedModels.join(', ')})` : ''),
        });
      }
    }
  }

  /** Send the next setup request, or the stashed prompt once setup is done. */
  private _advanceSetup(kimi: KimiCodeSessionState): void {
    const next = kimi.pendingSetup.shift();
    if (next) {
      kimi.setupId = ++kimi.rpcId;
      kimi.setupFailure = next.failure;
      this._writeToAcp(kimi, { jsonrpc: '2.0', id: kimi.setupId, method: next.method, params: next.params });
      return;
    }
    const prompt = kimi.pendingPrompt ?? '';
    kimi.pendingPrompt = null;
    if (kimi.persistentProcess?.stdin?.writable) {
      kimi.persistentProcess.stdin.write(this._promptRequest(kimi, prompt));
    }
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
        const input = (update.rawInput ?? update.raw_input ?? this._jsonContent(update.content)) as Record<string, unknown>;
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

  /**
   * Kimi Code 2.x sends no rawInput on tool_call; the arguments arrive as the
   * JSON text of the first content block (witnessed on 2.0.2).
   */
  private _jsonContent(content: unknown): Record<string, unknown> {
    const first = Array.isArray(content) ? content[0] as Record<string, unknown> | undefined : undefined;
    const text = first?.type === 'content' ? this._contentText(first.content) : '';
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
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
        + 'Mysti drives Kimi Code through "kimi acp". Sign in with "kimi login", check your '
        + 'config with "kimi doctor" (Kimi Code 2.x), update Kimi Code, then try again.\n'
        + `The CLI Mysti ran reports: ${trimmed.slice(0, 300)}`
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
        session.pendingSetup = [];
        session.setupId = null;
        session.activeToolCalls.clear();
        session.lastUsageStats = null;
      }
    }
  }
}
