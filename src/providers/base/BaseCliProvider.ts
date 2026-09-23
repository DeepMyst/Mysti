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
import * as os from 'os';
import * as nodePath from 'path';
import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import type {
  ICliProvider,
  CliDiscoveryResult,
  AuthConfig,
  ProviderCapabilities,
  NativeApprovalHandler,
  NativeApprovalHost,
  PersonaConfig,
  PersonaType
} from './IProvider';
import { PERSONA_PROMPTS, DEVELOPER_PERSONAS, DEVELOPER_SKILLS } from './IProvider';
import type {
  ContextItem,
  Attachment,
  Settings,
  Conversation,
  StreamChunk,
  ProviderConfig,
  AgentConfiguration,
  AuthStatus,
  SlashCommandDefinition,
  ProviderType,
  DeveloperPersona,
  Skill
} from '../../types';
import type { NativeCommandSpec } from './NativeCommands';
import { prepareCliAttachments } from './prepareCliAttachments';
import type { AgentContextManager } from '../../managers/AgentContextManager';
import { PROCESS_TIMEOUT_MS, PROCESS_KILL_GRACE_PERIOD_MS, AUTONOMOUS_PROCESS_TIMEOUT_MS, STREAM_INACTIVITY_TIMEOUT_MS } from '../../constants';
import { getCommonSearchPaths, getPriorityCliPaths, resolveCommandOnPath, probeCliVersion, validateCliPath, checkCommandExists, getEnrichedEnv, filterInstallMethodsForOS } from '../../utils/platform';
import { killProcessTree, isProcessLive } from '../../utils/processKill';
import { NativeApprovalRequests } from './NativeApprovalRequests';
import { CliStreamInactivityError, readCliStdout } from './readCliStdout';

/**
 * How much of a persistent process's stderr to keep for crash reporting.
 * Enough for a stack tail or an OOM message; small enough that a chatty CLI
 * cannot grow the session state without bound.
 */
const PERSISTENT_STDERR_TAIL_CHARS = 2000;

/**
 * Characters that make a shell argument a genuine injection vector. Refused in
 * EVERY argument before a `shell: true` spawn. Node applies no quoting of its
 * own on that path — on Windows `shell: true` sets `windowsVerbatimArguments`,
 * so "No quoting or escaping of arguments is done"
 * (https://nodejs.org/api/child_process.html) — which makes this screen, plus
 * the quoting below, the only thing between an argument and the shell.
 *
 * Square brackets are NOT here: some model ids use them (claude-opus-4-6[1m]);
 * they are glob characters, not injection vectors, and _quoteShellArgsForBrackets
 * makes them literal on POSIX.
 */
const SHELL_INJECTION_CHARS = /[;&|`$(){}<>!"'\\#~*?\n\r]/;

/**
 * A win32 absolute filesystem path: a drive root (`C:`) or a UNC root
 * (`\\server`), then one or more `\`-separated segments.
 *
 * This exists because `\` is a directory separator on Windows and the injection
 * screen above rejects it, so ANY path-valued argument — `--mcp-config
 * C:\Users\me\AppData\Local\Temp\mysti-canvas-x.json` for a canvas-linked
 * session, an attachment temp file — made every send throw on Windows.
 *
 * It is an exemption from exactly two characters of the screen and nothing else:
 *   - `\`  — the whole point; in cmd.exe `\` is not an escape character, and the
 *            value is double-quoted below so it is not one in a POSIX shell either.
 *   - `~`  — rejected by the screen for POSIX tilde expansion, which cmd.exe does
 *            not perform; real Windows paths contain it as 8.3 short names
 *            (`C:\Users\ADMINI~1\...`). Inside double quotes even a POSIX shell
 *            leaves it literal.
 * Everything else the screen rejects is still rejected here, and the class adds
 * four more rejections on top of it:
 *   - `%` and `^` — cmd.exe variable expansion and escape, which the POSIX-shaped
 *                   screen does not cover.
 *   - `/` and `:`  — separators/illegal in Windows filenames; excluded so this
 *                   cannot match anything but a plain local path.
 * A space IS permitted (`C:\Users\John Doe\...` is an ordinary path) because the
 * value is quoted; without quoting Node would split it into two arguments.
 */
const WIN32_PATH_SEGMENT = String.raw`[^\\/:*?"<>|;&\x60$(){}!'#%^\r\n\t]+`;
const WIN32_PATH_ARG = new RegExp(
  `^(?:[A-Za-z]:|\\\\\\\\${WIN32_PATH_SEGMENT})(?:\\\\${WIN32_PATH_SEGMENT})+\\\\?$`,
);
import { looksLikeOsExecutionBlock, assessExecutable, describeOsExecutionBlock } from '../../utils/gatekeeper';
import type { CliSearchConfig } from '../../utils/platform';

/**
 * Minimal interface for the provider manager's process-tracking methods.
 * Used to avoid casting providerManager to `any` in sendMessage().
 */
export interface ProcessTracker {
  /**
   * Record the running CLI process for a panel. `providerId` (B12) lets the
   * ProviderManager route panel-scoped operations (cancel/suspend/resume/etc.)
   * back to the provider that actually owns the process, not the global default.
   */
  registerProcess(panelId: string, process: ChildProcess, providerId?: string): void;
  clearProcess(panelId: string, expectedProcess?: ChildProcess): void;
}

/**
 * Per-panel session state for isolated concurrent chats.
 * Each panel gets its own process, session ID, and mutable state.
 * Subclasses can extend this to add provider-specific per-panel state.
 */
export interface PanelSessionState {
  panelId: string;
  process: ChildProcess | null;
  sessionId: string | null;
  autonomousMode: boolean;
  /** Long-lived process kept alive between messages (persistent mode) */
  persistentProcess: ChildProcess | null;
  /** True when the persistent process has initialized and is ready for input */
  persistentReady: boolean;
  /** Timestamp of last successful health check */
  lastHealthCheck: number;
  /** Channel context to inject as system instructions (set before each message) */
  channelSystemContext?: string;
  /**
   * Plan 05 — path to a per-session MCP config registering the in-extension
   * `mysti-canvas` HTTP server, appended as `--mcp-config` for canvas-linked
   * sessions (Claude Code). Cleared on unlink/dispose.
   */
  canvasMcpConfigPath?: string;
  /**
   * Bumped on every canvas MCP link/unlink. The config FILE name is stable per
   * panel while its bearer rotates per turn, so the path alone cannot tell a
   * warm process that its credential is stale.
   */
  canvasMcpRevision?: number;
  /** The {@link canvasMcpRevision} the live persistent process was spawned with. */
  persistentCanvasMcpRevision?: number;
  /** True when the process has been suspended via SIGSTOP */
  suspended: boolean;
  /**
   * True once the current request has been cancelled by the user (B4). Checked
   * before the persistent→single-shot fallback re-sends the prompt, and reset at
   * the start of each sendMessage().
   */
  cancelled?: boolean;
  /** Settings snapshot used when spawning the persistent process (for change detection) */
  persistentSettings?: {
    model: string | undefined;
    permissionMode: string;
    thinkingLevel: string;
    /** Plan 18 (4.1): --effort is baked into spawn args — a mid-session change
     * must respawn, same bug class as the issue-#39 custom-model fix. */
    effortLevel: string;
  };
  /** Buffered stdout data received during persistent process initialization */
  _initBuffer?: string;
  /**
   * Rolling tail of the persistent process's stderr, kept so a mid-stream crash
   * can be reported with the backend's own last words instead of a bare code.
   * Reset each time a persistent process is spawned.
   */
  _persistentStderr?: string;
}

/**
 * Abstract base class for CLI-based AI providers
 * Implements common functionality shared across providers
 */
export abstract class BaseCliProvider implements ICliProvider {
  protected _extensionContext: vscode.ExtensionContext;
  protected _panelSessions: Map<string, PanelSessionState> = new Map();
  /** A turn owns cancellation and submission even after its panel starts another turn. */
  private readonly _requests = new WeakMap<PanelSessionState, {
    controller: AbortController;
    submitted: boolean;
    settings: Readonly<Settings>;
    nativeHandler?: NativeApprovalHandler;
    nativeApprovals?: NativeApprovalRequests;
  }>();
  /** Eager CLI validation cannot replace a newer warmup or a submitted turn. */
  private readonly _warmups = new WeakMap<PanelSessionState, object>();
  private _nativeApprovalHost?: NativeApprovalHost;

  public setNativeApprovalHost(host: NativeApprovalHost | undefined): void {
    this._nativeApprovalHost = host;
  }

  /** Capture once before asynchronous setup; a later host registration cannot acquire this turn. */
  protected _captureNativeApprovalHandler(panelId: string, signal: AbortSignal): NativeApprovalHandler | undefined {
    return this._nativeApprovalHost?.handlerForPanel(panelId, signal);
  }

  protected _nativeApprovalRequests(session: PanelSessionState): NativeApprovalRequests | undefined {
    return this._requests.get(session)?.nativeApprovals;
  }

  protected _requestSettings(session: PanelSessionState): Readonly<Settings> | undefined {
    return this._requests.get(session)?.settings;
  }

  protected _requestNativeHandler(session: PanelSessionState): NativeApprovalHandler | undefined {
    return this._requests.get(session)?.nativeHandler;
  }

  protected _isCurrentRequest(session: PanelSessionState, signal: AbortSignal): boolean {
    return !signal.aborted && !session.cancelled && this._requests.get(session)?.controller.signal === signal;
  }

  /** Bind native decisions before a prompt can start work on this captured child. */
  protected _createNativeApprovalRequests(
    session: PanelSessionState, proc: ChildProcess, isCurrent?: () => boolean,
  ): NativeApprovalRequests | undefined {
    const request = this._requests.get(session);
    if (!request || !this.capabilities.supportsNativeApproval) { return undefined; }
    request.nativeApprovals?.dispose();
    return request.nativeApprovals = new NativeApprovalRequests({
      providerId: this.id, panelId: session.panelId, process: proc,
      signal: request.controller.signal, handler: request.nativeHandler,
      isCurrent: () => this._isCurrentRequest(session, request.controller.signal)
        && session.process === proc && (!isCurrent || isCurrent()),
    });
  }
  protected _agentContextManager: AgentContextManager | null = null;
  protected _cachedCliPath: string | null = null;
  /**
   * Raw `--version` output of the discovered CLI, or null before discovery.
   *
   * Nothing populated `CliDiscoveryResult.version` before this — not one
   * provider — so `CliStatus.version` was always undefined and
   * `CliUpdateService.getUpdates()` skipped every provider for want of an
   * installed version to compare. The whole update-notification feature was
   * silently inert.
   */
  protected _cachedCliVersion: string | null = null;

  // Identity - must be implemented by subclasses
  abstract readonly id: string;
  abstract readonly displayName: string;
  abstract readonly config: ProviderConfig;
  abstract readonly capabilities: ProviderCapabilities;

  constructor(context: vscode.ExtensionContext) {
    this._extensionContext = context;

    // Invalidate cached CLI path when provider path settings change
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('mysti')) {
          this._cachedCliPath = null;
          this._cachedCliVersion = null;
        }
      })
    );
  }

  /**
   * Set the agent context manager for dynamic agent loading
   * If not set, falls back to static DEVELOPER_PERSONAS/DEVELOPER_SKILLS
   */
  public setAgentContextManager(manager: AgentContextManager): void {
    this._agentContextManager = manager;
  }

  /**
   * Set channel system context on a panel session.
   * Called by ProviderManager before sendMessage() so buildPromptAsync() can read it.
   */
  public setChannelSystemContext(panelId: string, context: string): void {
    const session = this._getSession(panelId);
    session.channelSystemContext = context;
  }

  /**
   * Register (or clear, with null) the per-session `mysti-canvas` MCP config for
   * a panel. Read by buildCliArgs (Claude Code appends `--mcp-config`). Plan 05.
   */
  public setCanvasMcpConfig(panelId: string, configPath: string | null): void {
    // Clearing never creates a session, and clearing nothing is not a change.
    const session = configPath === null ? this._panelSessions.get(panelId) : this._getSession(panelId);
    if (!session || (configPath === null && session.canvasMcpConfigPath === undefined)) { return; }
    session.canvasMcpConfigPath = configPath ?? undefined;
    session.canvasMcpRevision = (session.canvasMcpRevision ?? 0) + 1;
  }

  // Abstract methods - must be implemented by subclasses
  abstract discoverCli(): Promise<CliDiscoveryResult>;
  abstract getCliPath(): string;
  abstract getAuthConfig(): Promise<AuthConfig>;
  abstract checkAuthentication(): Promise<AuthStatus>;
  abstract getAuthCommand(): string;
  abstract getInstallCommand(): string;

  /**
   * Build CLI arguments for the provider
   */
  protected abstract buildCliArgs(settings: Settings, session: PanelSessionState): string[];

  /**
   * Parse a single line of stream output
   * @param line Raw line from CLI output
   * @param session Per-panel session state for accessing provider-specific mutable state
   */
  protected abstract parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null;

  /**
   * Get thinking tokens based on thinking level
   */
  protected abstract getThinkingTokens(thinkingLevel: string): number | undefined;

  /**
   * Provider-specific environment variables merged into the spawn env (both the
   * single-shot and persistent processes). Default: none. Overridden e.g. by
   * Claude Code to keep the `-p` process waiting for background subagents/
   * workflows to finish before exiting (CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).
   */
  protected getExtraSpawnEnv(_settings: Settings): Record<string, string> {
    return {};
  }

  // ============================================================================
  // Per-panel session management
  // ============================================================================

  /**
   * Get or create session state for a panel.
   * Uses 'default' key when panelId is not provided (backward compatibility).
   * Subclasses can override _createSession to return extended session state types.
   */
  protected _getSession(panelId?: string): PanelSessionState {
    const key = panelId || 'default';
    let session = this._panelSessions.get(key);
    if (!session) {
      session = this._createSession(key);
      this._panelSessions.set(key, session);
    }
    return session;
  }

  /**
   * Create a new session state object.
   * Subclasses override this to add provider-specific fields.
   */
  protected _createSession(panelId: string): PanelSessionState {
    return {
      panelId,
      process: null,
      sessionId: null,
      autonomousMode: false,
      persistentProcess: null,
      persistentReady: false,
      lastHealthCheck: 0,
      suspended: false,
    };
  }

  // Common implementations

  async initialize(): Promise<void> {
    const discovery = await this.discoverCli();
    if (!discovery.found) {
      console.warn(`[Mysti] ${this.displayName} CLI not found at ${discovery.path}`);
    } else {
      console.log(`[Mysti] ${this.displayName} CLI found at ${discovery.path}`);
    }
  }

  dispose(): void {
    for (const session of this._panelSessions.values()) {
      this._requests.get(session)?.controller.abort();
      session.cancelled = true;
      // Liveness-gated (not `.killed`-gated) graceful kill with SIGKILL escalation.
      if (isProcessLive(session.process)) {
        void killProcessTree(session.process, PROCESS_KILL_GRACE_PERIOD_MS, { label: this.displayName });
      }
      if (isProcessLive(session.persistentProcess)) {
        void killProcessTree(session.persistentProcess, PROCESS_KILL_GRACE_PERIOD_MS, { label: this.displayName });
      }
      session.persistentProcess = null;
      session.persistentReady = false;
      session.process = null;
    }
    this._panelSessions.clear();
  }

  /**
   * Provider-native commands this backend reports at RUNTIME.
   *
   * Empty for every CLI whose command vocabulary is fixed — those are declared
   * once in NATIVE_COMMANDS. Only backends that are TOLD their commands by the
   * agent they drive (the ACP providers, via `available_commands_update`)
   * override this, because for them no static table can be correct.
   */
  public getDynamicNativeCommands(_panelId?: string): NativeCommandSpec[] {
    return [];
  }

  /**
   * True once this backend has told Mysti what commands it has, for this panel.
   *
   * When true, that report is AUTHORITATIVE and the curated catalog is filtered
   * down to it — which is what stops a hard-coded entry surviving a CLI release
   * that removed the command. False (the default) means the catalog stands on
   * its own, which is also the state before a panel's first turn.
   */
  public hasReportedNativeCommands(_panelId?: string): boolean {
    return false;
  }

  /**
   * Return provider-specific slash commands for the menu.
   * Override in subclasses to add custom commands.
   */
  public getSlashCommands(_panelId?: string): SlashCommandDefinition[] {
    return [
      {
        id: `${this.id}:terminal`,
        label: `Open ${this.displayName} in Terminal`,
        description: `Open ${this.displayName} CLI in integrated terminal`,
        section: 'customize',
        icon: 'terminal',
        provider: this.id as ProviderType,
        action: 'execute',
        keywords: ['terminal', 'cli', 'shell'],
      }
    ];
  }

  /**
   * review[24]: fully EVICT a panel's session record (not just null its id).
   * Delegation child panels use a unique `${panelId}-collab-${runId}-…` key per
   * run; clearSession only nulled `sessionId`, so those dead records accumulated
   * in `_panelSessions` forever in a long-lived window. Kills any live process
   * first, then removes the map entry. Called from CollaboratorPool.disposeRun.
   */
  disposeSession(panelId: string): void {
    if (typeof this.disposePersistentProcess === 'function') {
      try { this.disposePersistentProcess(panelId); } catch { /* best-effort */ }
    }
    try { this.cancelCurrentRequest(panelId); } catch { /* best-effort */ }
    this._panelSessions.delete(panelId);
  }

  clearSession(panelId?: string): void {
    if (panelId) {
      const session = this._panelSessions.get(panelId);
      if (session) {
        console.log(`[Mysti] ${this.displayName}: Clearing session for panel ${panelId}:`, session.sessionId);
        session.sessionId = null;
      }
    } else {
      for (const session of this._panelSessions.values()) {
        session.sessionId = null;
      }
      console.log(`[Mysti] ${this.displayName}: Clearing all sessions`);
    }
  }

  hasSession(panelId?: string): boolean {
    if (panelId) {
      const session = this._panelSessions.get(panelId);
      return session?.sessionId !== null && session?.sessionId !== undefined;
    }
    for (const session of this._panelSessions.values()) {
      if (session.sessionId) { return true; }
    }
    return false;
  }

  getSessionId(panelId?: string): string | null {
    if (panelId) {
      return this._panelSessions.get(panelId)?.sessionId ?? null;
    }
    for (const session of this._panelSessions.values()) {
      if (session.sessionId) { return session.sessionId; }
    }
    return null;
  }

  cancelCurrentRequest(panelId?: string): void {
    if (panelId) {
      const session = this._panelSessions.get(panelId);
      if (session) {
        this._cancelSessionRequest(session);
      }
    } else {
      for (const session of this._panelSessions.values()) {
        this._cancelSessionRequest(session);
      }
    }
  }

  /**
   * True when the aborted request itself tears down its process within a
   * bound (see AcpNativeLaunch.cancelGraceMs); Stop then leaves the kill to it.
   */
  protected _ownsCancellation(_session: PanelSessionState): boolean {
    return false;
  }

  /**
   * Cancel the active request for a single session.
   * For persistent processes, sends an interrupt instead of killing.
   */
  private _cancelSessionRequest(session: PanelSessionState): void {
    this._warmups.delete(session);
    // Mark this session as user-cancelled so any in-flight sendMessage() does NOT
    // re-send the prompt via the single-shot fallback (bug B4).
    session.cancelled = true;
    this._requests.get(session)?.controller.abort();
    // A SIGSTOP-suspended process (paused by the legacy stream gate)
    // must be SIGKILLed, NOT interrupted: writing \x03 to a stopped process's
    // stdin is never read, so a persistent process denied at the gate would stay
    // alive-but-frozen and hang the NEXT delegation that reuses its panel/session
    // (P0 review [12]). SIGKILL reaches a stopped process without SIGCONT (so the
    // CLI never gets a window to run the denied tool); the on-disk CLI session
    // survives, so the next delegation respawns and still --resumes.
    if (session.suspended) {
      const frozen = isProcessLive(session.persistentProcess) ? session.persistentProcess : session.process;
      if (isProcessLive(frozen)) {
        console.log(`[Mysti] ${this.displayName}: Killing SUSPENDED process (SIGKILL) for panel: ${session.panelId}`);
        void killProcessTree(frozen, PROCESS_KILL_GRACE_PERIOD_MS, { label: this.displayName, initialSignal: 'SIGKILL' });
      }
      session.persistentProcess = null;
      session.persistentReady = false;
      session.process = null;
      session.suspended = false;
      return;
    }
    // If using persistent process, send interrupt (Ctrl+C) instead of killing
    if (isProcessLive(session.persistentProcess)) {
      console.log(`[Mysti] ${this.displayName}: Interrupting persistent process for panel: ${session.panelId}`);
      this._interruptPersistentProcess(session);
      // Also null out the per-request process ref so the streaming generator exits
      session.process = null;
      return;
    }
    // Single-shot: kill the process. (The suspended case is handled by the
    // early-return block above — both persistent and single-shot — so it is no
    // longer re-checked here.)
    if (isProcessLive(session.process) && !this._ownsCancellation(session)) {
      console.log(`[Mysti] ${this.displayName}: Cancelling request for panel: ${session.panelId}`);
      void killProcessTree(session.process, PROCESS_KILL_GRACE_PERIOD_MS, { label: this.displayName });
      session.process = null;
    }
  }

  // ============================================================================
  // Process Suspension (SIGSTOP/SIGCONT)
  // ============================================================================

  /**
   * Suspend (freeze) the CLI process for a panel using SIGSTOP.
   * Only the owned process is paused; its tool children may already be running.
   * Native approval is enforced through the request/response callback instead.
   * Returns false on Windows where SIGSTOP is not supported.
   */
  public suspendProcess(panelId?: string): boolean {
    if (process.platform === 'win32') {
      return false;
    }
    const session = this._getSession(panelId);
    const proc = session.process;
    if (proc && isProcessLive(proc)) {
      try {
        const sent = proc.kill('SIGSTOP');
        if (sent) {
          session.suspended = true;
          console.log(`[Mysti] ${this.displayName}: Process suspended (SIGSTOP) for panel: ${session.panelId}`);
          return true;
        }
        console.warn(`[Mysti] ${this.displayName}: SIGSTOP failed (kill returned false) for panel: ${session.panelId}`);
      } catch (err) {
        console.warn(`[Mysti] ${this.displayName}: SIGSTOP error for panel: ${session.panelId}:`, err);
      }
    }
    return false;
  }

  /**
   * Resume a previously suspended CLI process using SIGCONT.
   * The process continues execution from where it was frozen.
   */
  public resumeProcess(panelId?: string): boolean {
    const session = this._getSession(panelId);
    const proc = session.process;
    if (proc && isProcessLive(proc) && session.suspended) {
      try {
        proc.kill('SIGCONT');
        session.suspended = false;
        console.log(`[Mysti] ${this.displayName}: Process resumed (SIGCONT) for panel: ${session.panelId}`);
        return true;
      } catch (err) {
        console.warn(`[Mysti] ${this.displayName}: SIGCONT error for panel: ${session.panelId}:`, err);
        session.suspended = false;
      }
    }
    return false;
  }

  // ============================================================================
  // Persistent Process Lifecycle
  // ============================================================================

  /**
   * Cancel the in-flight request on a persistent process.
   *
   * This used to write a raw ETX byte (`\x03`) into the child's stdin on the
   * assumption that a CLI reads it as Ctrl+C. That is only true for a process
   * attached to a TTY in cooked mode. Every persistent backend Mysti drives
   * speaks a STRUCTURED stdin protocol over a pipe — Claude Code's
   * `--input-format stream-json` (NDJSON), Hermes/Kimi's ACP (JSON-RPC over
   * stdio) — where the byte is not an interrupt at all: it is one more
   * character in the current line, and it makes the NEXT message on that pipe
   * unparseable. Hermes and Kimi each had to override this for exactly that
   * reason.
   *
   * The default therefore never writes to stdin. It tears the process down
   * (liveness-gated SIGTERM with SIGKILL escalation) and evicts it, so the next
   * turn respawns a process with clean protocol state and re-establishes the
   * session through the provider's normal args. Overriding subclasses may do
   * something cheaper if — and only if — their protocol defines a cancel
   * message.
   */
  protected _interruptPersistentProcess(session: PanelSessionState): void {
    console.log(`[Mysti] ${this.displayName}: No protocol-level cancel — tearing down the persistent process for panel: ${session.panelId}`);
    const proc = session.persistentProcess;
    if (isProcessLive(proc)) {
      void killProcessTree(proc, PROCESS_KILL_GRACE_PERIOD_MS, { label: this.displayName });
    }
    session.persistentProcess = null;
    session.persistentReady = false;
  }

  /**
   * Build CLI arguments for persistent (interactive) mode.
   * Subclasses override to remove single-shot flags (e.g., --print).
   * Returns null if this provider doesn't support persistent mode.
   */
  protected buildPersistentCliArgs(_settings: Settings, _session: PanelSessionState): string[] | null {
    return null;
  }

  /** A native protocol owns its complete turn; failures never fall back to CLI execution. */
  protected _sendNativeTurn?(
    content: string, context: ContextItem[], settings: Settings, conversation: Conversation | null,
    session: PanelSessionState, persona?: PersonaConfig, agentConfig?: AgentConfiguration,
    attachments?: Attachment[],
  ): AsyncGenerator<StreamChunk>;

  /** Verify the supported native protocol before eager startup or submitting a turn. */
  protected _validateNativeApprovalCli?(session: PanelSessionState, settings: Readonly<Settings>): Promise<void>;

  /**
   * Detect whether a parsed stream line marks the end of a response.
   * Subclasses override to define their response boundary (e.g., `result` event).
   */
  protected _isResponseBoundary(_line: string): boolean {
    return false;
  }

  /**
   * Format a prompt string for sending to a persistent process via stdin.
   * Default: sends plain text followed by newline.
   * Subclasses override for structured input (e.g., JSON for --input-format stream-json).
   */
  protected _formatPersistentInput(prompt: string, _session: PanelSessionState): string {
    return prompt + '\n';
  }

  /**
   * Read stdout from a persistent process using event listeners (not `for await`).
   * `for await` on a readable stream destroys it on return/break, making the
   * persistent process unusable after the first message. This method uses
   * removable `data` listeners so stdout survives across multiple messages.
   */
  private async *_readUntilBoundary(
    proc: ChildProcess,
    session: PanelSessionState,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    // Consume any data buffered during initialization
    let buffer = session._initBuffer || '';
    session._initBuffer = undefined;

    const chunks: StreamChunk[] = [];
    let waitResolve: (() => void) | null = null;
    const nativeApprovals = this._nativeApprovalRequests(session);
    const releaseApprovalListener = nativeApprovals?.onPendingChanged(() => { waitResolve?.(); });
    let done = false;
    let firstChunkTime: number | null = null;
    let firstContentTime: number | null = null;
    const streamStartTime = Date.now();
    // D-5: a persistent backend that dies mid-turn closes stdout WITHOUT ever
    // emitting a response boundary. sendMessage's terminal chunk is an
    // unconditional `done`, so a crashed / OOM-killed / non-zero exit rendered
    // in the UI as a successful, complete answer. Track both facts so the
    // failure can be surfaced as an `error` chunk instead.
    let sawBoundary = false;
    let uncleanExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let emittedTerminalError = false;
    let processError: Error | undefined;

    const onData = (data: Buffer) => {
      if (signal?.aborted || session.process !== proc) { return; }
      if (firstChunkTime === null) {
        firstChunkTime = Date.now();
        console.log(`[Mysti] ${this.displayName}: First stdout data received in ${firstChunkTime - streamStartTime}ms`);
      }

      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) { continue; }

        if (this._isResponseBoundary(line)) {
          const parsed = this.parseStreamLine(line, session);
          if (parsed) { chunks.push(parsed); }
          sawBoundary = true;
          done = true;
          session.process = null;
          session.lastHealthCheck = Date.now();
          proc.stdout?.removeListener('data', onData);
          if (waitResolve) { waitResolve(); }
          return;
        }

        const parsed = this.parseStreamLine(line, session);
        if (parsed) {
          if (firstContentTime === null && (parsed.type === 'text' || parsed.type === 'thinking')) {
            firstContentTime = Date.now();
            console.log(`[Mysti] ${this.displayName}: First content chunk in ${firstContentTime - streamStartTime}ms (type: ${parsed.type})`);
          }
          chunks.push(parsed);
        }
      }
      if (waitResolve) { waitResolve(); }
    };

    const onClose = () => {
      done = true;
      // The process exited. If it did so before completing the response, record
      // how it died — a non-zero code or a signal is a crash, not an answer.
      if (!sawBoundary) {
        uncleanExit = { code: proc.exitCode, signal: proc.signalCode };
      }
      proc.stdout?.removeListener('data', onData);
      if (waitResolve) { waitResolve(); }
    };
    const onAbort = () => {
      done = true;
      chunks.length = 0;
      proc.stdout?.removeListener('data', onData);
      if (waitResolve) { waitResolve(); }
    };
    const onError = (error: Error) => {
      processError = error;
      done = true;
      if (waitResolve) { waitResolve(); }
    };

    proc.stdout?.on('data', onData);
    proc.on('close', onClose);
    proc.on('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      if (signal?.aborted) { return; }
      while (!done) {
        // Check for cancellation
        if (signal?.aborted || session.process !== proc) {
          break;
        }
        // Yield any queued chunks
        while (chunks.length > 0) {
          if (signal?.aborted) { return; }
          yield chunks.shift()!;
        }
        if (done) { break; }
        // Wait for more data — BOUNDED (Plan 18 4.2, W4 review): the
        // single-shot watchdog didn't cover this path, so a persistent CLI
        // (Claude's default mode, Hermes, Kimi) wedged with stdout open
        // parked here forever. Same generous inactivity bound; on timeout the
        // wedged process is killed and evicted so the next turn respawns.
        const parkInactivityMs = session.autonomousMode ? AUTONOMOUS_PROCESS_TIMEOUT_MS : STREAM_INACTIVITY_TIMEOUT_MS;
        let parkTimer: ReturnType<typeof setTimeout> | undefined;
        const parked = new Promise<void>(r => { waitResolve = r; });
        // A native permission request is intentionally waiting for its owner.
        // Resume the inactivity clock only after it resolves or is cancelled.
        if (nativeApprovals?.hasPending) {
          await parked;
          waitResolve = null;
          continue;
        }
        const parkTimeout = new Promise<'timeout'>(resolve => {
          parkTimer = setTimeout(() => resolve('timeout'), parkInactivityMs);
        });
        const winner = await Promise.race([parked, parkTimeout]);
        clearTimeout(parkTimer);
        waitResolve = null;
        if (winner === 'timeout' && !done && session.process === proc) {
          console.error(`[Mysti] ${this.displayName}: persistent process silent for ${Math.round(parkInactivityMs / 60000)}min — killing wedged process`);
          void killProcessTree(proc, PROCESS_KILL_GRACE_PERIOD_MS, { label: `${this.displayName} persistent-inactivity` });
          if (session.persistentProcess === proc) {
            session.persistentProcess = null;
            session.persistentReady = false;
          }
          emittedTerminalError = true;
          yield {
            type: 'error',
            content: `${this.displayName} produced no output for ${Math.round(parkInactivityMs / 60000)} minutes — the request timed out and the process was terminated (a fresh one will spawn on the next message).`,
          };
          break;
        }
      }
      // Yield remaining chunks
      while (chunks.length > 0) {
        if (signal?.aborted) { return; }
        yield chunks.shift()!;
      }
      if (signal?.aborted) { return; }
      if (processError) { throw processError; }

      // D-5: the backend died mid-response. Report it instead of letting
      // sendMessage's unconditional `done` present a truncated answer as a
      // complete one. A user-initiated Stop is not a crash (cancelCurrentRequest
      // kills the process on purpose), and the inactivity watchdog above has
      // already emitted its own terminal error — neither is reported twice.
      // Scope: a CLEAN exit 0 with no boundary is deliberately left alone here,
      // so this only fires on a genuinely abnormal death.
      const exited = uncleanExit as { code: number | null; signal: NodeJS.Signals | null } | null;
      if (exited && !emittedTerminalError && !session.cancelled) {
        const abnormal = (exited.code !== null && exited.code !== 0) || exited.signal !== null;
        if (abnormal) {
          if (session.persistentProcess === proc) {
            session.persistentProcess = null;
            session.persistentReady = false;
          }
          const how = exited.signal
            ? `was terminated by ${exited.signal}`
            : `exited with code ${exited.code}`;
          const tail = this._cleanStderr(session._persistentStderr || '');
          console.error(`[Mysti] ${this.displayName}: persistent process ${how} mid-response (stderr tail: ${(session._persistentStderr || '').slice(-500)})`);
          yield {
            type: 'error',
            content: `${this.displayName} ${how} while streaming its response — the answer above is incomplete.${tail ? ` ${tail}` : ''} A fresh process will spawn on the next message.`,
          };
        }
      }
    } finally {
      proc.stdout?.removeListener('data', onData);
      proc.removeListener('close', onClose);
      proc.removeListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      releaseApprovalListener?.();
    }
  }

  /**
   * Check if the persistent process is alive and responsive.
   */
  protected _isPersistentProcessHealthy(session: PanelSessionState): boolean {
    // A SIGSTOP-suspended process is alive but FROZEN — handing it out would
    // hang the next request on its stdin (review [12] defense-in-depth).
    if (session.suspended) { return false; }
    // Liveness via exitCode/signalCode (not `.killed`, which only means a signal
    // was delivered) — a signalled-but-not-yet-exited process is not healthy.
    return isProcessLive(session.persistentProcess);
  }

  /**
   * Get or spawn a persistent process for a panel.
   * Returns the persistent process or null if persistent mode isn't supported/available.
   */
  protected async _getOrSpawnPersistentProcess(
    session: PanelSessionState,
    settings: Settings,
  ): Promise<ChildProcess | null> {
    // Return existing healthy process
    if (session.persistentProcess && this._isPersistentProcessHealthy(session)) {
      session.lastHealthCheck = Date.now();
      return session.persistentProcess;
    }

    // Clean up dead process
    if (session.persistentProcess) {
      console.log(`[Mysti] ${this.displayName}: Persistent process dead, cleaning up for panel: ${session.panelId}`);
      session.persistentProcess = null;
      session.persistentReady = false;
    }

    // Build persistent args — null means not supported
    const args = this.buildPersistentCliArgs(settings, session);
    if (!args) {
      return null;
    }
    session.persistentCanvasMcpRevision = session.canvasMcpRevision;

    const cliPath = this.getCliPath();
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const cwd = workspaceFolders ? workspaceFolders[0].uri.fsPath : process.cwd();

    const thinkingTokens = this.getThinkingTokens(settings.thinkingLevel);
    const extraEnv: Record<string, string> = { ...this.getExtraSpawnEnv(settings) };
    if (thinkingTokens && thinkingTokens > 0) {
      extraEnv.MAX_THINKING_TOKENS = String(thinkingTokens);
    }
    const env = getEnrichedEnv(Object.keys(extraEnv).length > 0 ? extraEnv : undefined);

    console.log(`[Mysti] ${this.displayName}: Spawning persistent process for panel: ${session.panelId}`);

    const proc = this._spawnCliProcess(args, cwd, env, cliPath);
    session.persistentProcess = proc;

    // Log stderr but don't treat it as fatal. A bounded tail is retained so
    // that if this process dies mid-stream, _readUntilBoundary can quote its
    // last words rather than reporting a bare exit code.
    session._persistentStderr = '';
    if (proc.stderr) {
      proc.stderr.on('data', (data: Buffer) => {
        if (session.persistentProcess !== proc) { return; }
        const text = data.toString();
        session._persistentStderr = ((session._persistentStderr || '') + text).slice(-PERSISTENT_STDERR_TAIL_CHARS);
        console.log(`[Mysti] ${this.displayName} persistent stderr:`, text);
      });
    }

    // Monitor for unexpected exit
    proc.on('exit', (code) => {
      console.log(`[Mysti] ${this.displayName}: Persistent process exited (code: ${code}) for panel: ${session.panelId}`);
      if (session.persistentProcess === proc) {
        session.persistentProcess = null;
        session.persistentReady = false;
      }
    });

    // Handle spawn and stdin transport errors (e.g., ENOENT/EPIPE).
    proc.on('error', (err) => {
      console.error(`[Mysti] ${this.displayName}: Persistent process error for panel ${session.panelId}:`, err);
      if (session.persistentProcess === proc) {
        session.persistentProcess = null;
        session.persistentReady = false;
      }
    });

    this._guardProcessInput(proc);

    // The CLI with --input-format stream-json produces NO stdout until it receives
    // a message on stdin. Don't wait for init — just mark as ready immediately.
    // The process is usable as soon as spawn() returns (stdin is buffered by the OS).
    session.persistentReady = true;
    session.lastHealthCheck = Date.now();

    // Store settings snapshot so we can detect changes later.
    // Use the EFFECTIVE model (which honors per-provider custom-model overrides
    // like mysti.claudeCodeModel), not the raw dropdown value — otherwise a
    // custom model set while a persistent process is already running would never
    // trigger a respawn and would be silently ignored (issue #39).
    if (!session.persistentSettings) {
      session.persistentSettings = {
        model: this._getEffectiveModel(settings),
        permissionMode: this._derivePermissionMode(settings),
        thinkingLevel: settings.thinkingLevel || 'none',
        effortLevel: settings.effortLevel || '',
      };
    }

    console.log(`[Mysti] ${this.displayName}: Persistent process ready for panel: ${session.panelId}`);

    return session.persistentProcess;
  }

  /**
   * The conversation history to fold into this turn's prompt.
   *
   * History is suppressed ONLY for providers that genuinely resume a CLI-owned
   * session (`capabilities.sessionKind === 'cli-resume'`): those CLIs already
   * hold the transcript, so re-sending it doubles input tokens every turn.
   *
   * It is NOT suppressed merely because `session.sessionId` is truthy. A
   * `prompt-history` provider replays history in the prompt by definition, and
   * some of them still record an id: Codex stores the `thread_id` from
   * `thread.started` while its argv (`codex exec --json ... -`) carries no
   * resume flag at all, so gating on the id alone left every Codex turn after
   * the first with neither history nor resume — context-blind.
   */
  protected _conversationForPrompt(
    session: PanelSessionState,
    conversation: Conversation | null,
  ): Conversation | null {
    if (this.capabilities.sessionKind === 'cli-resume' && session.sessionId) {
      return null;
    }
    return conversation;
  }

  /**
   * Send a message via a persistent process and yield chunks until the response boundary.
   * Setup may fall back to single-shot; submitted prompts are never replayed.
   */
  protected async *_sendViaPersistentProcess(
    content: string,
    context: ContextItem[],
    settings: Settings,
    conversation: Conversation | null,
    session: PanelSessionState,
    persona?: PersonaConfig,
    agentConfig?: AgentConfiguration,
    attachments?: Attachment[],
  ): AsyncGenerator<StreamChunk> {
    const _pt0 = Date.now();
    const request = this._requests.get(session);
    // Check if settings changed since spawn — if so, kill and respawn
    if (session.persistentProcess && !this._persistentSettingsMatch(session, settings)) {
      console.log(`[Mysti] ${this.displayName}: Settings changed since persistent spawn, respawning`);
      console.log(`[Mysti] ${this.displayName}: Persistent settings:`, JSON.stringify(session.persistentSettings));
      console.log(`[Mysti] ${this.displayName}: Current settings: model=${settings.model}, mode=${settings.mode}, access=${settings.accessLevel}, thinking=${settings.thinkingLevel}`);
      this.disposePersistentProcess(session.panelId);
      // Don't return — fall through to spawn a new persistent process below
    }

    const proc = await this._getOrSpawnPersistentProcess(session, settings);
    const _ptSpawn = Date.now() - _pt0;
    if (request?.controller.signal.aborted || session.cancelled) { return; }
    if (!proc || !proc.stdin?.writable || !proc.stdout) {
      console.log(`[Mysti] ${this.displayName}: Persistent process unavailable (proc=${!!proc}, stdin=${!!proc?.stdin?.writable}, stdout=${!!proc?.stdout}), falling back to single-shot`);
      return; // Caller will fall back to single-shot
    }
    if (session.persistentProcess !== proc) { return; }

    console.log(`[Mysti] ${this.displayName}: ⏱️ Persistent process acquired in ${_ptSpawn}ms for panel ${session.panelId} (pid: ${proc.pid})`);

    // Point the per-request process ref at the persistent process
    // so that cancellation (which nulls session.process) signals our loop to stop
    session.process = proc;
    let attachmentCleanup: (() => Promise<void>) | null = null;
    const isCurrent = () => !request?.controller.signal.aborted
      && !session.cancelled && session.process === proc && session.persistentProcess === proc;
    this._createNativeApprovalRequests(session, proc, isCurrent);
    try {
      attachmentCleanup = await this.prepareAttachments(attachments, []);
      if (!isCurrent()) { return; }

      // Only a CLI-owned resumed session already contains its conversation history.
      const effectiveConversation = this._conversationForPrompt(session, conversation);
      const _ptPrompt0 = Date.now();
      const fullPrompt = await this.buildPromptAsync(
        content, context, effectiveConversation, settings, persona, agentConfig, attachments, session.channelSystemContext,
      );
      const _ptPrompt = Date.now() - _ptPrompt0;
      if (!isCurrent()) { return; }

      const formattedInput = this._formatPersistentInput(fullPrompt, session);
      // After submitting, a transport failure cannot prove the CLI did no work.
      // A fallback would risk executing the same prompt a second time.
      if (request) { request.submitted = true; }
      proc.stdin.write(formattedInput);

      console.log(`[Mysti] ${this.displayName}: ⏱️ PERSISTENT TIMING: acquire=${_ptSpawn}ms, prompt=${_ptPrompt}ms (${formattedInput.length} chars, ~${Math.round(fullPrompt.length / 4)} tokens), session=${session.sessionId ? 'resumed' : 'new'}`);
      console.log(`[Mysti] ${this.displayName}: ⏱️ Prompt written to stdin, waiting for response...`);
      yield* this._readUntilBoundary(proc, session, request?.controller.signal);
    } finally {
      request?.nativeApprovals?.dispose();
      // Only a response boundary releases session.process without ending the
      // persistent child. A consumer break or setup failure must stop that turn.
      if (session.process === proc) {
        if (session.suspended) {
          void killProcessTree(proc, PROCESS_KILL_GRACE_PERIOD_MS, {
            label: this.displayName, initialSignal: 'SIGKILL',
          });
          if (session.persistentProcess === proc) {
            session.persistentProcess = null;
            session.persistentReady = false;
          }
        } else if (session.persistentProcess === proc) {
          this._interruptPersistentProcess(session);
        } else if (isProcessLive(proc)) {
          void killProcessTree(proc, PROCESS_KILL_GRACE_PERIOD_MS, { label: this.displayName });
        }
        session.process = null;
        session.suspended = false;
      }
      if (attachmentCleanup) { await attachmentCleanup(); }
    }
  }

  /**
   * Gracefully shut down the persistent process for a panel.
   */
  disposePersistentProcess(panelId?: string): void {
    const key = panelId || 'default';
    const session = this._panelSessions.get(key);
    if (session) { this._warmups.delete(session); }
    if (session) { this._requests.get(session)?.nativeApprovals?.dispose(); }
    if (session && isProcessLive(session.persistentProcess)) {
      console.log(`[Mysti] ${this.displayName}: Disposing persistent process for panel: ${key}`);
      // SIGTERM with reliable SIGKILL escalation (liveness-gated, timer cleared on exit).
      void killProcessTree(session.persistentProcess, PROCESS_KILL_GRACE_PERIOD_MS, { label: this.displayName });
      session.persistentProcess = null;
      session.persistentReady = false;
    }
  }

  /**
   * Derive the permission mode string from settings (used for spawn-settings comparison).
   */
  private _derivePermissionMode(settings: Settings): string {
    const { mode, accessLevel } = settings;
    if (mode === 'quick-plan' || mode === 'detailed-plan' || accessLevel === 'read-only') {
      return 'plan';
    }
    if (accessLevel === 'full-access' && mode === 'edit-automatically') {
      return 'yolo';
    }
    return 'auto-edit';
  }

  /**
   * The model that will actually be passed to the CLI for this request.
   *
   * Base default is the dropdown selection (`settings.model`). Providers that
   * support a per-provider custom-model override (e.g. `mysti.claudeCodeModel`)
   * OVERRIDE this to return that override first. It is used both when building
   * CLI args and when snapshotting/comparing persistent-process settings, so the
   * two never drift — a custom model set mid-session correctly triggers a
   * persistent-process respawn instead of being silently ignored (issue #39).
   */
  protected _getEffectiveModel(settings: Settings): string | undefined {
    // P2.3/P0.2b: an explicitly routed model wins over the per-provider custom-model config.
    if (settings.routedModel) { return settings.routedModel; }
    return settings.model || undefined;
  }

  /**
   * Public view of `_getEffectiveModel` (see ICliProvider) — every subclass's
   * override is picked up automatically, so attribution can name the model a
   * turn actually ran without each provider having to publish it separately.
   */
  public getEffectiveModelForSettings(settings: Settings): string | undefined {
    return this._getEffectiveModel(settings);
  }

  /**
   * Run the provider's CLI with the given args and capture stdout, for live
   * model discovery (Plan 01 Phase 3). Best-effort: returns the captured stdout
   * on a clean (exit 0) run, or null on spawn error / non-zero exit / timeout.
   * Never throws — the registry falls back to the curated list on null.
   */
  protected async _runCliForDiscovery(args: string[], timeoutMs: number): Promise<string | null> {
    let cliPath: string;
    try {
      cliPath = this.getCliPath();
    } catch {
      return null;
    }
    if (!cliPath) { return null; }

    return new Promise<string | null>((resolve) => {
      let settled = false;
      let stdout = '';
      let proc: ChildProcess;
      const finish = (value: string | null) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        try { proc?.kill('SIGKILL'); } catch { /* already gone */ }
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      try {
        proc = spawn(cliPath, args, { env: getEnrichedEnv(), windowsHide: true });
      } catch {
        finish(null);
        return;
      }
      proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.on('error', () => finish(null));
      proc.on('close', (code) => finish(code === 0 ? stdout : null));
    });
  }

  /**
   * Check if the current settings match the persistent process's spawn settings.
   */
  protected _persistentSettingsMatch(session: PanelSessionState, settings: Settings): boolean {
    if (!session.persistentSettings) { return false; }
    const ps = session.persistentSettings;
    // Compare the EFFECTIVE model (honors per-provider custom-model overrides),
    // not the raw dropdown value — so changing mysti.<provider>Model respawns.
    // Plan 18 (4.1): effort is only spawn-relevant for providers that consume
    // it (declared effortLevels). Comparing it unconditionally would let a
    // global effort flip destroy e.g. a live Hermes ACP session that ignores
    // effort entirely.
    const effortRelevant = (this.capabilities.effortLevels?.length ?? 0) > 0;
    return ps.model === this._getEffectiveModel(settings)
      && ps.permissionMode === this._derivePermissionMode(settings)
      && ps.thinkingLevel === (settings.thinkingLevel || 'none')
      && (!effortRelevant || ps.effortLevel === (settings.effortLevel || ''));
  }

  /**
   * Eagerly spawn a persistent process for a panel.
   * Called by ChatViewProvider when the user selects a provider or changes spawn-affecting settings.
   */
  public async preSpawnPersistentProcess(panelId: string, settings: Settings): Promise<void> {
    if (!this.capabilities.supportsPersistentProcess) { return; }

    const session = this._getSession(panelId);
    if (this._requests.has(session)) { return; }
    const warmup = {};
    this._warmups.set(session, warmup);
    const isCurrent = () => this._warmups.get(session) === warmup
      && this._panelSessions.get(session.panelId) === session && !this._requests.has(session);
    settings = Object.freeze({ ...settings });
    if (this._validateNativeApprovalCli) {
      try { await this._validateNativeApprovalCli(session, settings); }
      catch (error) {
        if (isCurrent()) { this._warmups.delete(session); throw error; }
        return;
      }
    }
    if (!isCurrent()) { return; }
    this._warmups.delete(session);

    // If existing process matches current settings, keep it
    if (session.persistentProcess && this._isPersistentProcessHealthy(session)) {
      if (this._persistentSettingsMatch(session, settings)) {
        console.log(`[Mysti] ${this.displayName}: Persistent process already running with matching settings for panel: ${panelId}`);
        return;
      }
      // Settings changed — kill and respawn
      console.log(`[Mysti] ${this.displayName}: Settings changed, respawning persistent process for panel: ${panelId}`);
      this.disposePersistentProcess(panelId);
    }

    // Store settings snapshot before spawning (effective model, see above)
    session.persistentSettings = {
      model: this._getEffectiveModel(settings),
      permissionMode: this._derivePermissionMode(settings),
      thinkingLevel: settings.thinkingLevel || 'none',
      effortLevel: settings.effortLevel || '',
    };

    await this._getOrSpawnPersistentProcess(session, settings);
  }

  // ============================================================================
  // Shared CLI Discovery
  // ============================================================================

  protected _getCliCommandName(): string {
    return this.id.split('-')[0];
  }

  protected _getConfiguredCliPath(): string {
    return this._getCliCommandName();
  }

  protected _getAdditionalSearchPaths(): string[] {
    return [];
  }

  /**
   * Pick the best install command for the CURRENT OS from this provider's
   * getInstallMethods() (filtered to the platform, lowest priority first).
   * Providers whose install command differs per OS (curl|bash vs PowerShell vs
   * an .exe download) override getInstallCommand() to call this, so the wizard,
   * the manual-fallback hint, and the install modal all show an OS-correct
   * command instead of a Unix-only one. Falls back to the supplied default when
   * no method matches (e.g. the provider declares none for this OS).
   */
  protected _installCommandForCurrentOS(fallback: string): string {
    // getInstallMethods is an optional ICliProvider method — reference it through
    // the interface type so it's visible even though the base class doesn't declare it.
    const methods = (this as ICliProvider).getInstallMethods?.() ?? [];
    const best = filterInstallMethodsForOS(methods)[0];
    return best?.command || fallback;
  }

  protected async _discoverCliCommon(): Promise<CliDiscoveryResult> {
    const commandName = this._getCliCommandName();
    const configuredPath = this._getConfiguredCliPath();

    const searchConfig: CliSearchConfig = {
      commandName,
      configuredPath: configuredPath !== commandName ? configuredPath : undefined,
      windowsCmd: `${commandName}.cmd`,
      additionalPaths: this._getAdditionalSearchPaths(),
    };

    // 1. Paths that outrank PATH: an explicitly configured one, and any
    //    provider-declared location (the CLI bundled inside Codex.app, say).
    for (const searchPath of getPriorityCliPaths(searchConfig)) {
      if (await validateCliPath(searchPath)) {
        console.log(`[Mysti] ${this.displayName}: Found CLI at: ${searchPath}`);
        return await this._rememberCliPath(searchPath);
      }
    }

    // 2. Whatever the user's shell resolves — the binary they actually run.
    //
    //    This used to come LAST, after a list of hard-coded guesses headed by
    //    /usr/local/bin, and the two disagree the moment a CLI is installed
    //    anywhere else. On a machine with Claude Code updated into
    //    ~/.local/bin (where its own installer puts it) and a stale npm copy
    //    left behind in /usr/local/bin, Mysti ran the stale one: `claude` in a
    //    terminal was 2.1.263 reporting 53 commands, while Mysti drove 2.0.71
    //    reporting 8 — no /design, no skills, and a version the user had
    //    already upgraded away from. PATH is the user's stated preference, so
    //    it wins over every guess below.
    const onPath = await resolveCommandOnPath(commandName);
    if (onPath && await validateCliPath(onPath)) {
      console.log(`[Mysti] ${this.displayName}: Found CLI via PATH: ${onPath}`);
      return await this._rememberCliPath(onPath);
    }

    // 3. Hard-coded locations. Still needed: a VS Code launched from Finder
    //    inherits a minimal PATH, so `which` can legitimately find nothing.
    for (const searchPath of getCommonSearchPaths(searchConfig)) {
      if (await validateCliPath(searchPath)) {
        console.log(`[Mysti] ${this.displayName}: Found CLI at: ${searchPath}`);
        return await this._rememberCliPath(searchPath);
      }
    }

    if (await checkCommandExists(commandName)) {
      console.log(`[Mysti] ${this.displayName}: Found CLI via PATH`);
      return await this._rememberCliPath(commandName);
    }

    return {
      found: false,
      path: commandName,
      installCommand: this.getInstallCommand()
    };
  }

  /**
   * Record what discovery resolved, so the SPAWN uses that same binary.
   *
   * `getCliPath()` is synchronous — it cannot run `which` — and used to walk
   * the hard-coded list on its own. That let discovery and execution disagree:
   * discovery could resolve ~/.local/bin/claude while every spawn ran the stale
   * /usr/local/bin/claude sitting earlier in the guess list. Seeding the cache
   * here makes "the CLI we found" and "the CLI we run" the same statement.
   */
  private async _rememberCliPath(cliPath: string): Promise<CliDiscoveryResult> {
    this._cachedCliPath = cliPath;
    // Ask the CLI its version while we have it resolved. This is what finally
    // fills CliDiscoveryResult.version — see the field comment above.
    const version = await this._probeCliVersion(cliPath);
    this._cachedCliVersion = version ?? null;
    return { found: true, path: cliPath, version };
  }

  /** Native approval adapters can inspect metadata without executing startup code. */
  protected _probeCliVersion(cliPath: string): Promise<string | undefined> {
    return probeCliVersion(cliPath);
  }

  /**
   * `--version` of the discovered CLI, once discovery has run.
   *
   * Providers whose invocation differs across CLI major versions branch on
   * this; it is deliberately the RAW string, because each CLI decorates it
   * differently and only the caller knows what it needs out of it.
   */
  public getCachedCliVersion(): string | null {
    return this._cachedCliVersion;
  }

  /** Major version number of the discovered CLI, or null when unknown. */
  protected _getCliMajorVersion(): number | null {
    const match = /(\d{1,6})\.(\d{1,6})\.(\d{1,6})/.exec(this._cachedCliVersion ?? '');
    return match ? Number(match[1]) : null;
  }

  /** Input-pipe errors must settle the owning process even after its turn reader exits. */
  protected _guardProcessInput(proc: ChildProcess): void {
    const onError = (error: Error) => {
      proc.emit('error', error);
      void killProcessTree(proc, PROCESS_KILL_GRACE_PERIOD_MS, { label: this.displayName });
    };
    proc.stdin?.on('error', onError);
    proc.once('close', () => { proc.stdin?.removeListener('error', onError); });
  }

  /**
   * Deliver the built prompt to a freshly spawned CLI.
   *
   * stdin by default, which is what nearly every backend reads. Overridden by
   * providers whose CLI does not accept one — OpenClaw's `agent` subcommand
   * requires `--message`/`--message-file` and ignores a pipe entirely.
   */
  protected async _deliverPrompt(
    proc: ChildProcess,
    fullPrompt: string,
    _session: PanelSessionState
  ): Promise<void> {
    if (proc.stdin) {
      proc.stdin.write(fullPrompt);
      proc.stdin.end();
    }
  }

  /** File-based CLIs prepare their prompt before the child can try to read it. */
  protected _preparePromptBeforeSpawn?(
    fullPrompt: string,
    args: string[],
    session: PanelSessionState,
    attachments?: Attachment[],
  ): Promise<() => Promise<void>>;

  protected _requestSignal(session: PanelSessionState): AbortSignal | undefined {
    return this._requests.get(session)?.controller.signal;
  }

  protected _getCliPathCommon(): string {
    if (this._cachedCliPath) {
      return this._cachedCliPath;
    }

    const commandName = this._getCliCommandName();
    const configuredPath = this._getConfiguredCliPath();

    if (configuredPath !== commandName) {
      this._cachedCliPath = configuredPath;
      return configuredPath;
    }

    const searchConfig: CliSearchConfig = {
      commandName,
      additionalPaths: this._getAdditionalSearchPaths(),
    };

    const paths = getCommonSearchPaths(searchConfig);

    for (const searchPath of paths) {
      try {
        if (searchPath.includes(nodePath.sep) || searchPath.startsWith('/')) {
          fs.accessSync(searchPath, fs.constants.X_OK);
          console.log(`[Mysti] ${this.displayName}: Using CLI at: ${searchPath}`);
          this._cachedCliPath = searchPath;
          return searchPath;
        }
      } catch {
        // Continue to next path
      }
    }

    this._cachedCliPath = configuredPath;
    return configuredPath;
  }

  /**
   * Get stored usage stats from parsing (if any)
   * Override in subclasses to provide usage from parsed stream events
   */
  getStoredUsage(_panelId?: string): { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | null {
    return null;
  }

  /**
   * Send a message to the AI provider.
   * Uses an explicit native transport when supplied; otherwise tries persistent
   * mode and permits a single-shot fallback only before submission.
   * A caller abandoning a pending next() must cancelCurrentRequest first;
   * async-generator return() alone queues behind an outstanding transport read.
   */
  async *sendMessage(
    content: string,
    context: ContextItem[],
    settings: Settings,
    conversation: Conversation | null,
    persona?: PersonaConfig,
    panelId?: string,
    providerManager?: unknown,
    agentConfig?: AgentConfiguration,
    attachments?: Attachment[]
  ): AsyncGenerator<StreamChunk> {
    const startTime = Date.now();
    // The caller may reuse or mutate settings while discovery/prompt preparation awaits.
    settings = Object.freeze({ ...settings });
    // Attachment preparation mutates filePath. Each turn owns its records even
    // when a caller reuses the same attachment array in concurrent panels.
    attachments = attachments?.map(attachment => ({ ...attachment }));
    const session = this._getSession(panelId);
    this._warmups.delete(session);
    if (this._requests.has(session)) { this._cancelSessionRequest(session); }
    session.autonomousMode = settings.autonomousMode === true;
    session.cancelled = false;
    const controller = new AbortController();
    const request = {
      controller, submitted: false, settings,
      nativeHandler: this._captureNativeApprovalHandler(session.panelId, controller.signal),
    };
    this._requests.set(session, request);

    try {
      if (this._validateNativeApprovalCli) {
        try { await this._validateNativeApprovalCli(session, settings); } catch (error) {
          if (this._isCurrentRequest(session, controller.signal)) {
            yield this.handleError(error);
            yield { type: 'done' };
          }
          return;
        }
        if (!this._isCurrentRequest(session, controller.signal)) { return; }
      }
      if (this._sendNativeTurn) {
        try {
          for await (const chunk of this._sendNativeTurn(content, context, settings, conversation, session, persona, agentConfig, attachments)) {
            if (!this._isCurrentRequest(session, controller.signal)) { break; }
            yield chunk;
          }
        } catch (error) {
          if (this._isCurrentRequest(session, controller.signal)) { yield this.handleError(error); }
        }
        if (this._requests.get(session) === request) {
          this._nativeApprovalRequests(session)?.dispose();
          const usage = this.getStoredUsage(panelId);
          yield usage ? { type: 'done', usage } : { type: 'done' };
        }
        return;
      }
      if (this.capabilities.supportsPersistentProcess) {
        let usedPersistent = false;
        try {
          for await (const chunk of this._sendViaPersistentProcess(
            content, context, settings, conversation, session, persona, agentConfig, attachments,
          )) {
            if (request.controller.signal.aborted) { break; }
            usedPersistent = true;
            yield chunk;
          }
        } catch (err) {
          if (!request.controller.signal.aborted) {
            if (request.submitted || usedPersistent) {
              yield this.handleError(err);
            } else {
              console.warn(`[Mysti] ${this.displayName}: Persistent setup failed, falling back to single-shot:`, err);
            }
          }
        }
        if (request.controller.signal.aborted || session.cancelled) {
          yield { type: 'done' };
          return;
        }
        if (request.submitted || usedPersistent) {
          const totalTime = Date.now() - startTime;
          console.log(`[Mysti] ${this.displayName}: Persistent request ended in ${totalTime}ms`);
          const storedUsage = this.getStoredUsage(panelId);
          yield storedUsage ? { type: 'done', usage: storedUsage } : { type: 'done' };
          return;
        }
      }

      yield* this._sendSingleShot(
        content, context, settings, conversation, session, panelId,
        providerManager, persona, agentConfig, attachments, startTime,
      );
    } finally {
      request.controller.abort();
      if (this._requests.get(session) === request) { this._requests.delete(session); }
    }
  }

  /** Shared spawning rules for CLI and native-protocol transports. */
  protected _spawnCliProcess(
    args: string[], cwd: string, env: NodeJS.ProcessEnv, cliPath = this.getCliPath(),
  ): ChildProcess {
    const useShell = process.platform === 'win32'
      || vscode.workspace.getConfiguration('mysti').get<boolean>('useShellForCli', false);
    const options: SpawnOptions = { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] };
    let spawnArgs = args;
    if (useShell) {
      options.shell = true;
      for (const arg of args) {
        if (this._isUnsafeShellArg(arg)) {
          console.error('[Mysti] Rejecting unsafe CLI argument in shell mode');
          throw new Error('Invalid argument detected in shell mode');
        }
      }
      // Node joins shell-mode array arguments without escaping; preserve the
      // existing POSIX bracket and Windows path quoting after injection checks.
      spawnArgs = this._quoteShellArgsForBrackets(args);
    }
    return spawn(cliPath, spawnArgs, options);
  }

  /**
   * Glob-safety helper (Plan 01 R1). When spawning with shell:true on a POSIX
   * shell, single-quote any arg containing [ or ] so glob metacharacters are
   * treated literally (model ids like "claude-opus-4-6[1m]" must not expand
   * against the cwd). Already-validated args contain no single quotes (the
   * shell-mode safety gate refuses them), so plain single-quote wrapping is
   * sufficient. Windows (cmd.exe) does not glob [ ], so args are returned
   * unchanged there — quoting would corrupt the .cmd shim invocation.
   */
  protected _quoteShellArgsForBrackets(args: string[]): string[] {
    if (process.platform === 'win32') {
      // cmd.exe: `[` and `]` do not glob, and `'` is not a quote character — so
      // the POSIX single-quoting below would be passed through literally and
      // break the .cmd shim invocation. What DOES need quoting here is a
      // filesystem path: Node does no escaping on this path
      // (windowsVerbatimArguments), so an unquoted `C:\Users\John Doe\x.json`
      // would split into two arguments. Double quotes are cmd.exe's quoting and
      // `\` is not an escape inside them; `"` is refused by the injection
      // screen, so a quoted path cannot break out.
      return args.map(arg => (this._isWin32PathArg(arg) ? `"${arg}"` : arg));
    }
    return args.map(arg => (arg.includes('[') || arg.includes(']')) ? `'${arg}'` : arg);
  }

  /**
   * True when `arg` is a plain win32 filesystem path (see {@link WIN32_PATH_ARG}).
   * win32-only by construction: a POSIX shell never reaches this exemption.
   */
  protected _isWin32PathArg(arg: string): boolean {
    return process.platform === 'win32' && WIN32_PATH_ARG.test(arg);
  }

  /**
   * The `shell: true` argument screen. Refuses genuine shell-injection vectors,
   * with one shape-based exemption for win32 filesystem paths (which are then
   * double-quoted by {@link _quoteShellArgsForBrackets}).
   */
  protected _isUnsafeShellArg(arg: string): boolean {
    if (this._isWin32PathArg(arg)) { return false; }
    return SHELL_INJECTION_CHARS.test(arg);
  }

  /**
   * Original single-shot spawn behavior: spawn CLI, send prompt, stream response, kill process.
   */
  private async *_sendSingleShot(
    content: string,
    context: ContextItem[],
    settings: Settings,
    conversation: Conversation | null,
    session: PanelSessionState,
    panelId: string | undefined,
    providerManager: unknown | undefined,
    persona: PersonaConfig | undefined,
    agentConfig: AgentConfiguration | undefined,
    attachments: Attachment[] | undefined,
    startTime: number,
  ): AsyncGenerator<StreamChunk> {
    const request = this._requests.get(session);
    if (!request || request.controller.signal.aborted) { return; }
    let proc: ChildProcess | null = null;
    const isCurrent = () => !request.controller.signal.aborted && this._requests.get(session) === request
      && (proc === null || session.process === proc);
    let attachmentCleanup: (() => Promise<void>) | null = null;
    let promptCleanup: (() => Promise<void>) | null = null;
    let preparedPrompt: string | undefined;
    const stderrRef = { output: '' };
    const stderrHandler = (data: Buffer) => {
      const text = data.toString();
      stderrRef.output += text;
      console.log(`[Mysti] ${this.displayName} stderr:`, text);
    };

    try {
      const cliPath = this.getCliPath();
      const args = this.buildCliArgs(settings, session);

      // Prepare attachments (subclasses can override to write temp files, add CLI flags, etc.)
      attachmentCleanup = await this.prepareAttachments(attachments, args);
      if (!isCurrent()) { return; }
      if (this._preparePromptBeforeSpawn) {
        preparedPrompt = await this.buildPromptAsync(
          content, context, this._conversationForPrompt(session, conversation), settings,
          persona, agentConfig, attachments, session.channelSystemContext,
        );
        if (!isCurrent()) { return; }
        promptCleanup = await this._preparePromptBeforeSpawn(preparedPrompt, args, session, attachments);
        if (!isCurrent()) { return; }
      }

      // Get workspace folder for CWD
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const cwd = workspaceFolders ? workspaceFolders[0].uri.fsPath : process.cwd();

      // Build environment with enriched PATH, thinking tokens, and permission port
      const thinkingTokens = this.getThinkingTokens(settings.thinkingLevel);
      const spawnExtraEnv: Record<string, string> = { ...this.getExtraSpawnEnv(settings) };
      if (thinkingTokens && thinkingTokens > 0) {
        spawnExtraEnv.MAX_THINKING_TOKENS = String(thinkingTokens);
      }
      const env = getEnrichedEnv(Object.keys(spawnExtraEnv).length > 0 ? spawnExtraEnv : undefined);
      console.log(`[Mysti] ${this.displayName}: Spawning CLI process for panel ${panelId || 'default'}...`);
      console.log(`[Mysti] ${this.displayName}: CLI args: ${args.map(a => a.length > 100 ? a.slice(0, 100) + '...[' + a.length + ' chars]' : a).join(' ')}`);
      proc = this._spawnCliProcess(args, cwd, env, cliPath);
      session.process = proc;
      this._createNativeApprovalRequests(session, proc, isCurrent);

      // Attach early error handler to catch async spawn errors (e.g., ENOENT/EINVAL on Windows)
      let earlySpawnError: Error | null = null;
      proc.on('error', (err) => {
        earlySpawnError = err;
        console.error(`[Mysti] ${this.displayName}: Spawn error:`, err);
      });
      this._guardProcessInput(proc);

      const spawnTime = Date.now() - startTime;
      console.log(`[Mysti] ${this.displayName}: CLI spawned in ${spawnTime}ms, building prompt...`);

      // Register process with ProviderManager for per-panel cancellation
      if (panelId && providerManager && typeof (providerManager as ProcessTracker).registerProcess === 'function') {
        (providerManager as ProcessTracker).registerProcess(panelId, proc, this.id);
      }

      // Set up stderr handler early to capture initialization errors.
      proc.stderr?.on('data', stderrHandler);

      // Build prompt AFTER spawning (parallelizes CLI startup with prompt building)
      // When the CLI itself resumes the session it already has the full
      // conversation context — don't re-send history in the prompt (avoids
      // doubling input tokens). See _conversationForPrompt for why a truthy
      // sessionId alone is NOT that condition.
      const effectiveConversation = this._conversationForPrompt(session, conversation);
      const fullPrompt = preparedPrompt ?? await this.buildPromptAsync(content, context, effectiveConversation, settings, persona, agentConfig, attachments, session.channelSystemContext);

      // Async preparation may finish after Stop or a replacement turn.
      if (!isCurrent()) { return; }

      // Check if spawn failed during prompt building (async error on Windows)
      if (earlySpawnError) {
        throw earlySpawnError;
      }

      const promptTime = Date.now() - startTime - spawnTime;
      console.log(`[Mysti] ${this.displayName}: Prompt built in ${promptTime}ms (total: ${Date.now() - startTime}ms)`);

      // Hand the prompt to the CLI (stdin by default — see _deliverPrompt).
      await this._deliverPrompt(proc, fullPrompt, session);
      if (!isCurrent()) { return; }
      if (earlySpawnError) { throw earlySpawnError; }
      const promptSentTime = Date.now() - startTime;
      console.log(`[Mysti] ${this.displayName}: Prompt delivered in ${promptSentTime}ms`);

      console.log(`[Mysti] ${this.displayName}: ⏱️ TIMING BREAKDOWN:`);
      console.log(`  - CLI spawn: ${spawnTime}ms`);
      console.log(`  - Prompt build: ${promptTime}ms`);
      console.log(`  - Prompt size: ${fullPrompt.length} chars (~${Math.round(fullPrompt.length / 4)} tokens)`);
      console.log(`  - Session resumed: ${session.sessionId ? 'yes (' + session.sessionId + ')' : 'no (new session)'}`);
      console.log(`  - Total setup: ${Date.now() - startTime}ms`);
      console.log(`  - Waiting for first response...`);

      // Process stream output
      for await (const chunk of this.processStream(stderrRef, session)) {
        if (!isCurrent()) { return; }
        yield chunk;
        if (!isCurrent()) { return; }
      }
      if (!isCurrent()) { return; }

      // Yield final done with any stored usage from stream parsing
      const totalTime = Date.now() - startTime;
      console.log(`[Mysti] ${this.displayName}: ✅ Request completed in ${totalTime}ms`);

      if (promptTime > 500) {
        console.warn(`[Mysti] ${this.displayName}: ⚠️ Slow prompt building (${promptTime}ms) - consider optimizing agent context loading`);
      }
      if (spawnTime > 100) {
        console.warn(`[Mysti] ${this.displayName}: ⚠️ Slow CLI spawn (${spawnTime}ms) - CLI binary may need optimization`);
      }

      const storedUsage = this.getStoredUsage(panelId);
      yield storedUsage ? { type: 'done', usage: storedUsage } : { type: 'done' };
    } catch (error) {
      if (!isCurrent()) { return; }
      // A spawn-time refusal (EACCES/EPERM on a Gatekeeper-blocked binary)
      // lands here rather than in processStream, so it gets the same upgrade
      // from an opaque errno to an actionable explanation.
      const chunk = this.handleError(error);
      if (chunk.type === 'error' && chunk.content) {
        chunk.content = await this._explainOsExecutionBlock(chunk.content, {
          exitCode: null,
          signal: null,
          stderr: `${chunk.content}\n${stderrRef.output}`,
          hasOutput: false
        });
      }
      if (isCurrent()) { yield chunk; }
    } finally {
      // A late completion owns only its captured process, never a replacement.
      request.nativeApprovals?.dispose();
      proc?.stderr?.removeListener('data', stderrHandler);
      if (isProcessLive(proc)) {
        try {
          // Suspended processes get SIGKILL without opening a tool-execution
          // window. Otherwise retain graceful SIGTERM followed by SIGKILL.
          void killProcessTree(proc, PROCESS_KILL_GRACE_PERIOD_MS, {
            label: this.displayName,
            initialSignal: session.process === proc && session.suspended ? 'SIGKILL' : 'SIGTERM',
          });
        } catch (e) {
          console.error(`[Mysti] ${this.displayName}: Error cleaning up process:`, e);
        }
      }

      if (session.process === proc) {
        session.process = null;
        session.suspended = false;
      }
      if (proc && panelId && providerManager && typeof (providerManager as ProcessTracker).clearProcess === 'function') {
        (providerManager as ProcessTracker).clearProcess(panelId, proc);
      }
      try {
        if (promptCleanup) { await promptCleanup(); }
      } finally {
        if (attachmentCleanup) { await attachmentCleanup(); }
      }
    }
  }

  /**
   * Process the CLI output stream
   */
  protected async *processStream(stderrRef: { output: string }, session: PanelSessionState): AsyncGenerator<StreamChunk> {
    const proc = session.process;
    const signal = this._requests.get(session)?.controller.signal;
    const isCurrent = () => !signal?.aborted && session.process === proc;
    let buffer = '';
    let hasYieldedContent = false;
    let firstChunkTime: number | null = null;
    let firstContentTime: number | null = null;
    const streamStartTime = Date.now();

    try {
      for await (const chunk of readCliStdout(proc, {
        signal, isCurrent, stderr: stderrRef, label: this.displayName,
        approvals: this._nativeApprovalRequests(session),
        inactivityMs: session.autonomousMode ? AUTONOMOUS_PROCESS_TIMEOUT_MS : STREAM_INACTIVITY_TIMEOUT_MS,
      })) {
        if (firstChunkTime === null) {
          firstChunkTime = Date.now();
          console.log(`[Mysti] ${this.displayName}: First stdout data received in ${firstChunkTime - streamStartTime}ms`);
        }
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!isCurrent()) { return; }
          if (!line.trim()) { continue; }
          const parsed = this.parseStreamLine(line, session);
          if (parsed) {
            if (firstContentTime === null && (parsed.type === 'text' || parsed.type === 'thinking')) {
              firstContentTime = Date.now();
              console.log(`[Mysti] ${this.displayName}: First content chunk in ${firstContentTime - streamStartTime}ms (type: ${parsed.type})`);
            }
            hasYieldedContent = true;
            yield parsed;
          }
        }
      }
    } catch (error) {
      if (!isCurrent()) { return; }
      if (!(error instanceof CliStreamInactivityError)) { throw error; }
      yield { type: 'error', content: error.message };
      return;
    }
    if (!isCurrent()) { return; }

    if (buffer.trim()) {
      const parsed = this.parseStreamLine(buffer, session);
      if (parsed) {
        hasYieldedContent = true;
        yield parsed;
      }
    }

    console.log(`[Mysti] ${this.displayName}: Stream ended (hasYieldedContent=${hasYieldedContent}, firstChunkTime=${firstChunkTime}), waiting for process to exit...`);
    const exitCode = await this.waitForProcess(session, proc);
    if (!isCurrent()) { return; }
    console.log(`[Mysti] ${this.displayName}: Process exited with code:`, exitCode);

    // Node clears `session.process` in the caller's finally block, so capture
    // the signal alongside the code while the handle is still around.
    const exitSignal = proc?.signalCode ?? null;

    if (exitCode !== 0 && exitCode !== null) {
      const rawStderr = stderrRef.output;
      const errorMsg = this._cleanStderr(rawStderr) || `${this.displayName} exited with code ${exitCode}`;
      console.error(`[Mysti] ${this.displayName}: Non-zero exit (${exitCode}), stderr (${rawStderr.length} chars): ${rawStderr.slice(0, 500)}`);
      if (this.isAuthenticationError(errorMsg)) {
        yield {
          type: 'auth_error',
          content: errorMsg,
          authCommand: this.getAuthCommand(),
          providerName: this.displayName
        };
      } else {
        yield {
          type: 'error',
          content: await this._explainOsExecutionBlock(errorMsg, {
            exitCode,
            signal: exitSignal,
            stderr: rawStderr,
            hasOutput: hasYieldedContent
          })
        };
      }
    } else if (!hasYieldedContent) {
      const rawStderr = stderrRef.output;
      const errorMsg = this._cleanStderr(rawStderr) || 'No response received from CLI';
      console.error(`[Mysti] ${this.displayName}: No content yielded! exitCode=${exitCode}, firstChunkTime=${firstChunkTime}, stderr (${rawStderr.length} chars): ${rawStderr.slice(0, 500)}`);
      if (this.isAuthenticationError(errorMsg)) {
        yield {
          type: 'auth_error',
          content: errorMsg,
          authCommand: this.getAuthCommand(),
          providerName: this.displayName
        };
      } else {
        yield {
          type: 'error',
          content: await this._explainOsExecutionBlock(errorMsg, {
            exitCode,
            signal: exitSignal,
            stderr: rawStderr,
            hasOutput: false
          })
        };
      }
    }
  }

  /**
   * Upgrade an opaque CLI failure into an actionable one when macOS refused to
   * execute the binary.
   *
   * A Gatekeeper block SIGKILLs the process before the CLI runs, so all Mysti
   * ever saw was "exited with code 1" or "No response received from CLI" —
   * while macOS separately showed the user a "Malware Blocked" dialog that
   * reads as if Mysti did something wrong. The common real cause is a revoked
   * vendor signing certificate (see src/utils/gatekeeper.ts), which a CLI
   * reinstall fixes.
   *
   * Returns `fallbackMessage` unchanged unless `spctl` actually confirms a
   * block, so a normal CLI error is never mislabelled as a signing problem.
   */
  protected async _explainOsExecutionBlock(
    fallbackMessage: string,
    signals: { exitCode: number | null; signal: NodeJS.Signals | null; stderr: string; hasOutput: boolean }
  ): Promise<string> {
    if (!looksLikeOsExecutionBlock(signals)) { return fallbackMessage; }

    let cliPath: string;
    try {
      cliPath = this.getCliPath();
    } catch {
      return fallbackMessage;
    }
    if (!cliPath) { return fallbackMessage; }

    try {
      const block = await assessExecutable(cliPath);
      if (!block) { return fallbackMessage; }
      console.error(`[Mysti] ${this.displayName}: binary blocked by macOS (${block.reason}): ${block.binaryPath}`);
      return describeOsExecutionBlock(this.displayName, block, this.getInstallCommand());
    } catch (error) {
      console.error(`[Mysti] ${this.displayName}: Gatekeeper assessment failed:`, error);
      return fallbackMessage;
    }
  }

  /**
   * Wait for a process to complete with timeout protection
   */
  protected async waitForProcess(
    session: PanelSessionState,
    proc: ChildProcess | null = session.process,
  ): Promise<number | null> {
    const signal = this._requests.get(session)?.controller.signal;
    if (!proc || signal?.aborted) { return null; }
    if (proc.exitCode !== null || (proc.signalCode !== null && proc.signalCode !== undefined)) { return proc.exitCode; }

    return new Promise<number | null>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        proc.removeListener('close', onClose);
        proc.removeListener('error', onError);
        signal?.removeEventListener('abort', onAbort);
      };
      const onClose = (code: number | null) => { cleanup(); resolve(code); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onAbort = () => { cleanup(); resolve(null); };
      const timeoutMs = session.autonomousMode ? AUTONOMOUS_PROCESS_TIMEOUT_MS : PROCESS_TIMEOUT_MS;
      const timeout = setTimeout(() => {
        cleanup();
        console.error(`[Mysti] ${this.displayName}: Process timeout after ${timeoutMs / 1000}s`);
        if (isProcessLive(proc)) {
          void killProcessTree(proc, PROCESS_KILL_GRACE_PERIOD_MS, { label: this.displayName });
        }
        reject(new Error('Process timeout'));
      }, timeoutMs);
      proc.on('close', onClose);
      proc.on('error', onError);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Build agent instructions from persona + skills configuration
   */
  protected async buildAgentInstructionsAsync(agentConfig?: AgentConfiguration): Promise<string> {
    if (!agentConfig || (!agentConfig.personaId && agentConfig.enabledSkills.length === 0 && !agentConfig.roleId)) {
      return '';
    }

    if (this._agentContextManager) {
      try {
        const promptContext = await this._agentContextManager.buildPromptContext(agentConfig);
        // Plan 20 Phase 0: instructions now arrive in two tiers. Verified
        // bundled content first, then non-verified definitions as a delimited
        // reference block — order matters, the untrusted block must never
        // prefix the trusted one. Either tier alone is a valid result: a
        // selection of only user/workspace agents yields an empty
        // `systemPrompt`, and falling through to the legacy static tables there
        // would silently drop the user's own persona.
        if (promptContext.systemPrompt || promptContext.untrustedBlock) {
          for (const warning of promptContext.warnings) {
            console.warn(`[Mysti] ${this.displayName}: ${warning}`);
          }
          console.log(`[Mysti] ${this.displayName}: Agent context built with ~${promptContext.estimatedTokens} tokens`);
          return promptContext.systemPrompt + promptContext.untrustedBlock;
        }
      } catch (error) {
        console.warn(`[Mysti] ${this.displayName}: AgentContextManager failed, using fallback:`, error);
      }
    }

    return this.buildAgentInstructionsSync(agentConfig);
  }

  protected buildAgentInstructionsSync(agentConfig?: AgentConfiguration): string {
    if (!agentConfig || (!agentConfig.personaId && agentConfig.enabledSkills.length === 0)) {
      return '';
    }

    const parts: string[] = [];

    // Legacy static tables only know the built-in ids; custom (user/
    // workspace/imported) agents resolve through AgentContextManager on
    // the async path and are simply skipped here.
    if (agentConfig.personaId) {
      const persona = (DEVELOPER_PERSONAS as Record<string, DeveloperPersona>)[agentConfig.personaId];
      if (persona) {
        parts.push(`[Persona: ${persona.name}]\n${persona.keyCharacteristics}`);
      }
    }

    if (agentConfig.enabledSkills.length > 0) {
      const skillInstructions = agentConfig.enabledSkills
        .map(skillId => (DEVELOPER_SKILLS as Record<string, Skill>)[skillId]?.instructions)
        .filter(Boolean)
        .join(' ');
      if (skillInstructions) {
        parts.push(`[Active Skills]\n${skillInstructions}`);
      }
    }

    return parts.join('\n\n');
  }

  /**
   * @deprecated Use buildAgentInstructionsAsync instead
   */
  protected buildAgentInstructions(agentConfig?: AgentConfiguration): string {
    return this.buildAgentInstructionsSync(agentConfig);
  }

  /**
   * Build the full prompt with context, history, persona, and agent config
   */
  protected async buildPromptAsync(
    content: string,
    context: ContextItem[],
    conversation: Conversation | null,
    settings: Settings,
    persona?: PersonaConfig,
    agentConfig?: AgentConfiguration,
    _attachments?: Attachment[],
    systemContext?: string
  ): Promise<string> {
    if (content.trim().startsWith('/')) {
      return content.trim();
    }

    let fullPrompt = '';

    const _bpa0 = Date.now();
    const agentInstructions = await this.buildAgentInstructionsAsync(agentConfig);
    const _bpaAgent = Date.now() - _bpa0;
    if (_bpaAgent > 10) {
      console.log(`[Mysti] ${this.displayName}: ⏱️ buildAgentInstructions took ${_bpaAgent}ms`);
    }
    if (agentInstructions) {
      fullPrompt += agentInstructions + '\n\n';
    } else if (persona) {
      const personaPrompt = this.getPersonaPrompt(persona);
      if (personaPrompt) {
        fullPrompt += personaPrompt + '\n\n';
      }
    }

    // System context (e.g., OpenClaw channel capabilities) — injected after agent instructions
    if (systemContext) {
      fullPrompt += systemContext + '\n\n';
    }

    if (context.length > 0) {
      fullPrompt += this.formatContext(context);
      fullPrompt += '\n\n';
    }

    if (conversation && conversation.messages.length > 0) {
      fullPrompt += this.formatConversationHistory(conversation);
      fullPrompt += '\n\n';
    }

    fullPrompt += content;

    // Inject mode instructions as defense-in-depth (prompt-level + CLI flags)
    if (settings.mode === 'quick-plan') {
      fullPrompt += '\n\n[Planning Mode] Create ONE concise implementation plan. Focus on the most practical approach without exploring multiple alternatives. Be brief and actionable.';
    } else if (settings.mode && settings.mode !== 'default') {
      const modeKey = settings.mode === 'detailed-plan' ? 'plan' : settings.mode;
      fullPrompt = this.addModeInstructions(fullPrompt, modeKey);
    }

    console.log(`[Mysti] ${this.displayName}: ⏱️ buildPromptAsync total: ${Date.now() - _bpa0}ms (agent=${_bpaAgent}ms, context=${context.length} items, history=${conversation?.messages.length || 0} msgs, systemCtx=${systemContext ? systemContext.length + ' chars' : 'none'})`);
    return fullPrompt;
  }

  /**
   * @deprecated Use buildPromptAsync instead
   */
  protected buildPrompt(
    content: string,
    context: ContextItem[],
    conversation: Conversation | null,
    settings: Settings,
    persona?: PersonaConfig,
    agentConfig?: AgentConfiguration,
    systemContext?: string
  ): string {
    if (content.trim().startsWith('/')) {
      return content.trim();
    }

    let fullPrompt = '';

    const agentInstructions = this.buildAgentInstructionsSync(agentConfig);
    if (agentInstructions) {
      fullPrompt += agentInstructions + '\n\n';
    } else if (persona) {
      const personaPrompt = this.getPersonaPrompt(persona);
      if (personaPrompt) {
        fullPrompt += personaPrompt + '\n\n';
      }
    }

    // System context (e.g., OpenClaw channel capabilities) — injected after agent instructions
    if (systemContext) {
      fullPrompt += systemContext + '\n\n';
    }

    if (context.length > 0) {
      fullPrompt += this.formatContext(context);
      fullPrompt += '\n\n';
    }

    if (conversation && conversation.messages.length > 0) {
      fullPrompt += this.formatConversationHistory(conversation);
      fullPrompt += '\n\n';
    }

    fullPrompt += content;

    // Inject mode instructions as defense-in-depth (prompt-level + CLI flags)
    if (settings.mode === 'quick-plan') {
      fullPrompt += '\n\n[Planning Mode] Create ONE concise implementation plan. Focus on the most practical approach without exploring multiple alternatives. Be brief and actionable.';
    } else if (settings.mode && settings.mode !== 'default') {
      const modeKey = settings.mode === 'detailed-plan' ? 'plan' : settings.mode;
      fullPrompt = this.addModeInstructions(fullPrompt, modeKey);
    }

    return fullPrompt;
  }

  protected getPersonaPrompt(persona: PersonaConfig): string {
    if (persona.type === 'custom' && persona.customPrompt) {
      return `[Custom Persona] ${persona.customPrompt}`;
    }
    return PERSONA_PROMPTS[persona.type as Exclude<PersonaType, 'custom'>] || '';
  }

  protected async prepareAttachments(
    attachments: Attachment[] | undefined,
    _args: string[]
  ): Promise<(() => Promise<void>) | null> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const directory = workspaceRoot ? nodePath.join(workspaceRoot, '.mysti', 'tmp') : os.tmpdir();
    return prepareCliAttachments(attachments, directory);
  }

  protected formatContext(context: ContextItem[]): string {
    // Plan 07: deactivated items stay in the panel but are excluded here.
    const active = context.filter((item) => item.enabled !== false);
    if (active.length === 0) {
      return '';
    }

    let formatted = '# Context Files\n\n';

    for (const item of active) {
      if (item.type === 'file') {
        formatted += `## ${item.path}\n`;
        formatted += `\`\`\`${item.language || ''}\n${item.content}\n\`\`\`\n\n`;
      } else if (item.type === 'selection') {
        formatted += `## Selection from ${item.path} (lines ${item.startLine}-${item.endLine})\n`;
        formatted += `\`\`\`${item.language || ''}\n${item.content}\n\`\`\`\n\n`;
      }
    }

    return formatted;
  }

  protected formatConversationHistory(conversation: Conversation): string {
    if (conversation.messages.length === 0) {
      return '';
    }

    let formatted = 'The following is the conversation history for context only. Do not repeat or echo these messages in your response:\n\n';

    for (const message of conversation.messages.slice(-10)) {
      const role = message.role === 'user' ? 'User' : 'Assistant';
      formatted += `${role}: ${message.content}\n`;
    }

    formatted += '\n--- End of conversation history ---\n\n';
    return formatted;
  }

  protected addModeInstructions(prompt: string, mode: string): string {
    const modeInstructions: Record<string, string> = {
      'ask-before-edit': '\n\n[Mode: Ask before making any edits. Explain what changes you want to make and wait for approval before modifying any files.]',
      'edit-automatically': '\n\n[Mode: You may edit files directly without asking for permission.]',
      'plan': '\n\n[Mode: Planning mode. Create a detailed plan for the task without making any actual changes. Break down the work into steps.]'
    };

    return prompt + (modeInstructions[mode] || '');
  }

  private _cleanStderr(stderr: string): string {
    return stderr
      .split('\n')
      .filter(line => {
        const trimmed = line.trim();
        if (/^\[STARTUP\]/i.test(trimmed)) { return false; }
        if (/^Recording metric/i.test(trimmed)) { return false; }
        if (/^Loaded cached credentials/i.test(trimmed)) { return false; }
        if (/^Full report available at:/i.test(trimmed)) { return false; }
        if (/^Hook registry initialized/i.test(trimmed)) { return false; }
        if (/^\s*at\s+/.test(trimmed)) { return false; }
        return true;
      })
      .join('\n')
      .trim();
  }

  protected isAuthenticationError(stderr: string): boolean {
    const authPatterns = [
      /not authenticated/i,
      /authentication.*failed/i,
      /no authentication/i,
      /invalid.*token/i,
      /expired.*token/i,
      /unauthorized/i,
      /auth.*required/i,
      /please.*login/i,
      /please.*sign in/i,
      /api.?key.*invalid/i,
      /access.*denied/i,
      /set an auth method/i,
      /no auth type/i,
      /configure.*auth.*type/i,
      /GEMINI_API_KEY/,
      /GOOGLE_GENAI_USE_VERTEXAI/,
      /auth setup failed/i,
      /could not open a new TTY/i,
    ];
    return authPatterns.some(pattern => pattern.test(stderr));
  }

  protected handleError(error: unknown): StreamChunk {
    const errorMessage = error instanceof Error
      ? error.message
      : (typeof error === 'string' ? error : JSON.stringify(error) || 'Unknown error');
    console.error(`[Mysti] ${this.displayName}: Error:`, errorMessage);
    return { type: 'error', content: errorMessage };
  }
}
