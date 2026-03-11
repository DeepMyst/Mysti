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
import * as nodePath from 'path';
import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import type {
  ICliProvider,
  CliDiscoveryResult,
  AuthConfig,
  ProviderCapabilities,
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
  ProviderType
} from '../../types';
import type { AgentContextManager } from '../../managers/AgentContextManager';
import { PROCESS_TIMEOUT_MS, PROCESS_KILL_GRACE_PERIOD_MS, AUTONOMOUS_PROCESS_TIMEOUT_MS } from '../../constants';
import { getCommonSearchPaths, validateCliPath, checkCommandExists, getEnrichedEnv } from '../../utils/platform';
import type { CliSearchConfig } from '../../utils/platform';

/**
 * Minimal interface for the provider manager's process-tracking methods.
 * Used to avoid casting providerManager to `any` in sendMessage().
 */
export interface ProcessTracker {
  registerProcess(panelId: string, process: ChildProcess): void;
  clearProcess(panelId: string): void;
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
  /** True when the process has been suspended via SIGSTOP */
  suspended: boolean;
  /** Settings snapshot used when spawning the persistent process (for change detection) */
  persistentSettings?: {
    model: string | undefined;
    permissionMode: string;
    thinkingLevel: string;
  };
  /** Buffered stdout data received during persistent process initialization */
  _initBuffer?: string;
}

/**
 * Abstract base class for CLI-based AI providers
 * Implements common functionality shared across providers
 */
export abstract class BaseCliProvider implements ICliProvider {
  protected _extensionContext: vscode.ExtensionContext;
  protected _panelSessions: Map<string, PanelSessionState> = new Map();
  protected _agentContextManager: AgentContextManager | null = null;
  protected _cachedCliPath: string | null = null;

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
      if (session.process && !session.process.killed) {
        session.process.kill('SIGTERM');
      }
      if (session.persistentProcess && !session.persistentProcess.killed) {
        session.persistentProcess.kill('SIGTERM');
        session.persistentProcess = null;
        session.persistentReady = false;
      }
    }
    this._panelSessions.clear();
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
   * Cancel the active request for a single session.
   * For persistent processes, sends an interrupt instead of killing.
   */
  private _cancelSessionRequest(session: PanelSessionState): void {
    // If using persistent process, send interrupt (Ctrl+C) instead of killing
    if (session.persistentProcess && !session.persistentProcess.killed) {
      console.log(`[Mysti] ${this.displayName}: Interrupting persistent process for panel: ${session.panelId}`);
      this._interruptPersistentProcess(session);
      // Also null out the per-request process ref so the streaming generator exits
      session.process = null;
      return;
    }
    // Single-shot: kill the process
    if (session.process && !session.process.killed) {
      if (session.suspended) {
        // Process is frozen by SIGSTOP. Use SIGKILL directly — it is delivered
        // to stopped processes on macOS/Linux without needing SIGCONT first.
        // Sending SIGCONT+SIGTERM would resume the process and give the CLI a
        // window to execute the pending tool before SIGTERM arrives.
        console.log(`[Mysti] ${this.displayName}: Killing suspended process (SIGKILL) for panel: ${session.panelId}`);
        session.process.kill('SIGKILL');
        session.suspended = false;
      } else {
        console.log(`[Mysti] ${this.displayName}: Cancelling request for panel: ${session.panelId}`);
        session.process.kill('SIGTERM');
      }
      session.process = null;
    }
  }

  // ============================================================================
  // Process Suspension (SIGSTOP/SIGCONT)
  // ============================================================================

  /**
   * Suspend (freeze) the CLI process for a panel using SIGSTOP.
   * This prevents the process from executing any further instructions,
   * including tool execution that was about to begin.
   * Returns false on Windows where SIGSTOP is not supported.
   */
  public suspendProcess(panelId?: string): boolean {
    if (process.platform === 'win32') {
      return false;
    }
    const session = this._getSession(panelId);
    const proc = session.process;
    if (proc && !proc.killed && proc.exitCode === null) {
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
    if (proc && !proc.killed && session.suspended) {
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
   * Send interrupt signal (Ctrl+C) to a persistent process to cancel the
   * current request without terminating the process.
   * Subclasses can override for provider-specific interrupt handling.
   */
  protected _interruptPersistentProcess(session: PanelSessionState): void {
    if (session.persistentProcess?.stdin?.writable) {
      // Send ETX (Ctrl+C) which CLIs interpret as interrupt
      session.persistentProcess.stdin.write('\x03');
    }
  }

  /**
   * Build CLI arguments for persistent (interactive) mode.
   * Subclasses override to remove single-shot flags (e.g., --print).
   * Returns null if this provider doesn't support persistent mode.
   */
  protected buildPersistentCliArgs(_settings: Settings, _session: PanelSessionState): string[] | null {
    return null;
  }

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
    session: PanelSessionState
  ): AsyncGenerator<StreamChunk> {
    // Consume any data buffered during initialization
    let buffer = session._initBuffer || '';
    session._initBuffer = undefined;

    const chunks: StreamChunk[] = [];
    let waitResolve: (() => void) | null = null;
    let done = false;
    let firstChunkTime: number | null = null;
    let firstContentTime: number | null = null;
    const streamStartTime = Date.now();

    const onData = (data: Buffer) => {
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
      proc.stdout?.removeListener('data', onData);
      if (waitResolve) { waitResolve(); }
    };

    proc.stdout?.on('data', onData);
    proc.on('close', onClose);

    try {
      while (!done) {
        // Check for cancellation
        if (session.process !== proc) {
          break;
        }
        // Yield any queued chunks
        while (chunks.length > 0) {
          yield chunks.shift()!;
        }
        if (done) { break; }
        // Wait for more data
        await new Promise<void>(r => { waitResolve = r; });
        waitResolve = null;
      }
      // Yield remaining chunks
      while (chunks.length > 0) {
        yield chunks.shift()!;
      }
    } finally {
      proc.stdout?.removeListener('data', onData);
      proc.removeListener('close', onClose);
    }
  }

  /**
   * Check if the persistent process is alive and responsive.
   */
  protected _isPersistentProcessHealthy(session: PanelSessionState): boolean {
    return session.persistentProcess !== null
      && !session.persistentProcess.killed
      && session.persistentProcess.exitCode === null;
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

    const cliPath = this.getCliPath();
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const cwd = workspaceFolders ? workspaceFolders[0].uri.fsPath : process.cwd();

    const thinkingTokens = this.getThinkingTokens(settings.thinkingLevel);
    const extraEnv: Record<string, string> = {};
    if (thinkingTokens && thinkingTokens > 0) {
      extraEnv.MAX_THINKING_TOKENS = String(thinkingTokens);
    }
    const env = getEnrichedEnv(Object.keys(extraEnv).length > 0 ? extraEnv : undefined);

    console.log(`[Mysti] ${this.displayName}: Spawning persistent process for panel: ${session.panelId}`);

    // Apply shell mode for persistent spawn (needed for Windows .cmd wrappers)
    const useShell = process.platform === 'win32' || vscode.workspace.getConfiguration('mysti').get<boolean>('useShellForCli', false);
    const persistentSpawnOpts: SpawnOptions = { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] };
    if (useShell) {
      persistentSpawnOpts.shell = true;
    }

    session.persistentProcess = spawn(cliPath, args, persistentSpawnOpts);

    // Log stderr but don't treat it as fatal
    if (session.persistentProcess.stderr) {
      session.persistentProcess.stderr.on('data', (data: Buffer) => {
        console.log(`[Mysti] ${this.displayName} persistent stderr:`, data.toString());
      });
    }

    // Monitor for unexpected exit
    session.persistentProcess.on('exit', (code) => {
      console.log(`[Mysti] ${this.displayName}: Persistent process exited (code: ${code}) for panel: ${session.panelId}`);
      session.persistentProcess = null;
      session.persistentReady = false;
    });

    // Handle spawn errors (e.g., ENOENT/EINVAL on Windows)
    session.persistentProcess.on('error', (err) => {
      console.error(`[Mysti] ${this.displayName}: Persistent process spawn error for panel ${session.panelId}:`, err);
      session.persistentProcess = null;
      session.persistentReady = false;
    });

    // The CLI with --input-format stream-json produces NO stdout until it receives
    // a message on stdin. Don't wait for init — just mark as ready immediately.
    // The process is usable as soon as spawn() returns (stdin is buffered by the OS).
    session.persistentReady = true;
    session.lastHealthCheck = Date.now();

    // Store settings snapshot so we can detect changes later
    if (!session.persistentSettings) {
      session.persistentSettings = {
        model: settings.model || undefined,
        permissionMode: this._derivePermissionMode(settings),
        thinkingLevel: settings.thinkingLevel || 'none',
      };
    }

    console.log(`[Mysti] ${this.displayName}: Persistent process ready for panel: ${session.panelId}`);

    return session.persistentProcess;
  }

  /**
   * Send a message via a persistent process and yield chunks until the response boundary.
   * Falls back to null (caller should use single-shot) on any failure.
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
    if (!proc || !proc.stdin?.writable || !proc.stdout) {
      console.log(`[Mysti] ${this.displayName}: Persistent process unavailable (proc=${!!proc}, stdin=${!!proc?.stdin?.writable}, stdout=${!!proc?.stdout}), falling back to single-shot`);
      return; // Caller will fall back to single-shot
    }

    console.log(`[Mysti] ${this.displayName}: ⏱️ Persistent process acquired in ${_ptSpawn}ms for panel ${session.panelId} (pid: ${proc.pid})`);

    // Point the per-request process ref at the persistent process
    // so that cancellation (which nulls session.process) signals our loop to stop
    session.process = proc;

    // Persistent process always has a session — skip conversation history
    const effectiveConversation = session.sessionId ? null : conversation;
    const _ptPrompt0 = Date.now();
    const fullPrompt = await this.buildPromptAsync(
      content, context, effectiveConversation, settings, persona, agentConfig, attachments, session.channelSystemContext,
    );
    const _ptPrompt = Date.now() - _ptPrompt0;

    // Format and send prompt — subclasses can override for structured input (e.g., JSON)
    const formattedInput = this._formatPersistentInput(fullPrompt, session);
    proc.stdin.write(formattedInput);

    console.log(`[Mysti] ${this.displayName}: ⏱️ PERSISTENT TIMING: acquire=${_ptSpawn}ms, prompt=${_ptPrompt}ms (${formattedInput.length} chars, ~${Math.round(fullPrompt.length / 4)} tokens), session=${session.sessionId ? 'resumed' : 'new'}`);
    console.log(`[Mysti] ${this.displayName}: ⏱️ Prompt written to stdin, waiting for response...`);

    // Read stdout using event listeners (NOT `for await` which destroys the stream on return)
    yield* this._readUntilBoundary(proc, session);
  }

  /**
   * Gracefully shut down the persistent process for a panel.
   */
  disposePersistentProcess(panelId?: string): void {
    const key = panelId || 'default';
    const session = this._panelSessions.get(key);
    if (session?.persistentProcess && !session.persistentProcess.killed) {
      console.log(`[Mysti] ${this.displayName}: Disposing persistent process for panel: ${key}`);
      session.persistentProcess.kill('SIGTERM');
      const proc = session.persistentProcess;
      setTimeout(() => {
        if (proc && !proc.killed) {
          proc.kill('SIGKILL');
        }
      }, PROCESS_KILL_GRACE_PERIOD_MS);
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
   * Check if the current settings match the persistent process's spawn settings.
   */
  protected _persistentSettingsMatch(session: PanelSessionState, settings: Settings): boolean {
    if (!session.persistentSettings) { return false; }
    const ps = session.persistentSettings;
    return ps.model === (settings.model || undefined)
      && ps.permissionMode === this._derivePermissionMode(settings)
      && ps.thinkingLevel === (settings.thinkingLevel || 'none');
  }

  /**
   * Eagerly spawn a persistent process for a panel.
   * Called by ChatViewProvider when the user selects a provider or changes spawn-affecting settings.
   */
  public async preSpawnPersistentProcess(panelId: string, settings: Settings): Promise<void> {
    if (!this.capabilities.supportsPersistentProcess) { return; }

    const session = this._getSession(panelId);

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

    // Store settings snapshot before spawning
    session.persistentSettings = {
      model: settings.model || undefined,
      permissionMode: this._derivePermissionMode(settings),
      thinkingLevel: settings.thinkingLevel || 'none',
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

  protected async _discoverCliCommon(): Promise<CliDiscoveryResult> {
    const commandName = this._getCliCommandName();
    const configuredPath = this._getConfiguredCliPath();

    const searchConfig: CliSearchConfig = {
      commandName,
      configuredPath: configuredPath !== commandName ? configuredPath : undefined,
      windowsCmd: `${commandName}.cmd`,
      additionalPaths: this._getAdditionalSearchPaths(),
    };

    const paths = getCommonSearchPaths(searchConfig);

    for (const searchPath of paths) {
      if (await validateCliPath(searchPath)) {
        console.log(`[Mysti] ${this.displayName}: Found CLI at: ${searchPath}`);
        return { found: true, path: searchPath };
      }
    }

    if (await checkCommandExists(commandName)) {
      console.log(`[Mysti] ${this.displayName}: Found CLI via PATH`);
      return { found: true, path: commandName };
    }

    return {
      found: false,
      path: commandName,
      installCommand: this.getInstallCommand()
    };
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
   * Tries persistent process mode first (if supported), falls back to single-shot spawn.
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
    const session = this._getSession(panelId);
    session.autonomousMode = settings.autonomousMode === true;

    // --- Try persistent process mode ---
    console.log(`[Mysti] ${this.displayName}: sendMessage - supportsPersistentProcess=${this.capabilities.supportsPersistentProcess}, existingProcess=${!!session.persistentProcess}, ready=${session.persistentReady}`);
    if (this.capabilities.supportsPersistentProcess) {
      let usedPersistent = false;
      try {
        let chunkCount = 0;
        for await (const chunk of this._sendViaPersistentProcess(
          content, context, settings, conversation, session, persona, agentConfig, attachments,
        )) {
          chunkCount++;
          yield chunk;
        }
        usedPersistent = chunkCount > 0;
      } catch (err) {
        console.warn(`[Mysti] ${this.displayName}: Persistent mode failed, falling back to single-shot:`, err);
        // Kill the broken persistent process so it's not reused
        if (session.persistentProcess && !session.persistentProcess.killed) {
          session.persistentProcess.kill('SIGTERM');
        }
        session.persistentProcess = null;
        session.persistentReady = false;
      }

      if (usedPersistent) {
        const totalTime = Date.now() - startTime;
        console.log(`[Mysti] ${this.displayName}: ✅ Persistent request completed in ${totalTime}ms`);
        const storedUsage = this.getStoredUsage(panelId);
        yield storedUsage ? { type: 'done', usage: storedUsage } : { type: 'done' };
        return;
      }
      // Fall through to single-shot below
      console.log(`[Mysti] ${this.displayName}: Falling back to single-shot mode`);
    }

    // --- Single-shot spawn (original behavior) ---
    yield* this._sendSingleShot(
      content, context, settings, conversation, session, panelId,
      providerManager, persona, agentConfig, attachments, startTime,
    );
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
    const cliPath = this.getCliPath();
    const args = this.buildCliArgs(settings, session);

    // Prepare attachments (subclasses can override to write temp files, add CLI flags, etc.)
    const attachmentCleanup = await this.prepareAttachments(attachments, args);

    // Get workspace folder for CWD
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const cwd = workspaceFolders ? workspaceFolders[0].uri.fsPath : process.cwd();

    // Build environment with enriched PATH, thinking tokens, and permission port
    const thinkingTokens = this.getThinkingTokens(settings.thinkingLevel);
    const spawnExtraEnv: Record<string, string> = {};
    if (thinkingTokens && thinkingTokens > 0) {
      spawnExtraEnv.MAX_THINKING_TOKENS = String(thinkingTokens);
    }
    const env = getEnrichedEnv(Object.keys(spawnExtraEnv).length > 0 ? spawnExtraEnv : undefined);
    console.log(`[Mysti] ${this.displayName}: Spawning CLI process for panel ${panelId || 'default'}...`);
    console.log(`[Mysti] ${this.displayName}: CLI args: ${args.map(a => a.length > 100 ? a.slice(0, 100) + '...[' + a.length + ' chars]' : a).join(' ')}`);
    // Check if we should use shell for spawning (auto-enable on Windows for .cmd wrapper support)
    const useShell = process.platform === 'win32' || vscode.workspace.getConfiguration('mysti').get<boolean>('useShellForCli', false);
    const spawnOpts: SpawnOptions = { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] };
    if (useShell) {
      spawnOpts.shell = true;
      for (const arg of args) {
        if (/[;&|`$(){}[\]<>!"'\\#~*?\n\r]/.test(arg)) {
          console.error(`[Mysti] Rejecting unsafe CLI argument in shell mode`);
          throw new Error('Invalid argument detected in shell mode');
        }
      }
    }

    session.process = spawn(cliPath, args, spawnOpts);

    // Attach early error handler to catch async spawn errors (e.g., ENOENT/EINVAL on Windows)
    let earlySpawnError: Error | null = null;
    session.process.on('error', (err) => {
      earlySpawnError = err;
      console.error(`[Mysti] ${this.displayName}: Spawn error:`, err);
    });

    const spawnTime = Date.now() - startTime;
    console.log(`[Mysti] ${this.displayName}: CLI spawned in ${spawnTime}ms, building prompt...`);

    // Register process with ProviderManager for per-panel cancellation
    if (panelId && providerManager && typeof (providerManager as ProcessTracker).registerProcess === 'function') {
      (providerManager as ProcessTracker).registerProcess(panelId, session.process);
    }

    // Set up stderr handler early to capture initialization errors
    const stderrRef = { output: '' };
    const stderrHandler = (data: Buffer) => {
      const text = data.toString();
      stderrRef.output += text;
      console.log(`[Mysti] ${this.displayName} stderr:`, text);
    };

    if (session.process.stderr) {
      session.process.stderr.on('data', stderrHandler);
    }

    try {
      // Build prompt AFTER spawning (parallelizes CLI startup with prompt building)
      // When resuming a session (sessionId exists), the CLI already has the full
      // conversation context — don't re-send history in the prompt (avoids doubling input tokens).
      const effectiveConversation = session.sessionId ? null : conversation;
      const fullPrompt = await this.buildPromptAsync(content, context, effectiveConversation, settings, persona, agentConfig, attachments, session.channelSystemContext);

      // Check if spawn failed during prompt building (async error on Windows)
      if (earlySpawnError) {
        throw earlySpawnError;
      }

      const promptTime = Date.now() - startTime - spawnTime;
      console.log(`[Mysti] ${this.displayName}: Prompt built in ${promptTime}ms (total: ${Date.now() - startTime}ms)`);

      // Send prompt via stdin
      if (session.process.stdin) {
        session.process.stdin.write(fullPrompt);
        session.process.stdin.end();
        const promptSentTime = Date.now() - startTime;
        console.log(`[Mysti] ${this.displayName}: Prompt sent to CLI stdin in ${promptSentTime}ms`);
      }

      console.log(`[Mysti] ${this.displayName}: ⏱️ TIMING BREAKDOWN:`);
      console.log(`  - CLI spawn: ${spawnTime}ms`);
      console.log(`  - Prompt build: ${promptTime}ms`);
      console.log(`  - Prompt size: ${fullPrompt.length} chars (~${Math.round(fullPrompt.length / 4)} tokens)`);
      console.log(`  - Session resumed: ${session.sessionId ? 'yes (' + session.sessionId + ')' : 'no (new session)'}`);
      console.log(`  - Total setup: ${Date.now() - startTime}ms`);
      console.log(`  - Waiting for first response...`);

      // Process stream output
      yield* this.processStream(stderrRef, session);

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
      yield this.handleError(error);
    } finally {
      if (session.process && !session.process.killed) {
        try {
          if (session.process.stderr) {
            session.process.stderr.removeListener('data', stderrHandler);
          }

          if (session.suspended) {
            // Process is frozen — SIGKILL is delivered to stopped processes
            // without needing SIGCONT (avoids tool execution window)
            session.process.kill('SIGKILL');
            session.suspended = false;
          } else {
            session.process.kill('SIGTERM');
            const processToKill = session.process;
            setTimeout(() => {
              if (processToKill && !processToKill.killed) {
                console.log(`[Mysti] ${this.displayName}: Force killing leaked process`);
                processToKill.kill('SIGKILL');
              }
            }, PROCESS_KILL_GRACE_PERIOD_MS);
          }
        } catch (e) {
          console.error(`[Mysti] ${this.displayName}: Error cleaning up process:`, e);
        }
      }

      session.process = null;
      session.suspended = false;

      if (attachmentCleanup) {
        await attachmentCleanup();
      }

      if (panelId && providerManager && typeof (providerManager as ProcessTracker).clearProcess === 'function') {
        (providerManager as ProcessTracker).clearProcess(panelId);
      }
    }
  }

  /**
   * Process the CLI output stream
   */
  protected async *processStream(stderrRef: { output: string }, session: PanelSessionState): AsyncGenerator<StreamChunk> {
    let buffer = '';
    let hasYieldedContent = false;
    let firstChunkTime: number | null = null;
    let firstContentTime: number | null = null;
    const streamStartTime = Date.now();

    if (session.process?.stdout) {
      for await (const chunk of session.process.stdout) {
        if (firstChunkTime === null) {
          firstChunkTime = Date.now();
          console.log(`[Mysti] ${this.displayName}: First stdout data received in ${firstChunkTime - streamStartTime}ms`);
        }

        const chunkStr = chunk.toString();
        buffer += chunkStr;

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
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
      }
    }

    if (buffer.trim()) {
      const parsed = this.parseStreamLine(buffer, session);
      if (parsed) {
        hasYieldedContent = true;
        yield parsed;
      }
    }

    console.log(`[Mysti] ${this.displayName}: Stream ended (hasYieldedContent=${hasYieldedContent}, firstChunkTime=${firstChunkTime}), waiting for process to exit...`);
    const exitCode = await this.waitForProcess(session);
    console.log(`[Mysti] ${this.displayName}: Process exited with code:`, exitCode);

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
        yield { type: 'error', content: errorMsg };
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
        yield { type: 'error', content: errorMsg };
      }
    }
  }

  /**
   * Wait for a process to complete with timeout protection
   */
  protected async waitForProcess(session: PanelSessionState): Promise<number | null> {
    return new Promise<number | null>((resolve, reject) => {
      if (!session.process) {
        resolve(null);
        return;
      }

      if (session.process.exitCode !== null) {
        resolve(session.process.exitCode);
        return;
      }

      const timeoutMs = session.autonomousMode ? AUTONOMOUS_PROCESS_TIMEOUT_MS : PROCESS_TIMEOUT_MS;
      const timeout = setTimeout(() => {
        console.error(`[Mysti] ${this.displayName}: Process timeout after ${timeoutMs / 1000}s`);
        if (session.process && !session.process.killed) {
          session.process.kill('SIGTERM');

          const processToKill = session.process;
          setTimeout(() => {
            if (processToKill && !processToKill.killed) {
              console.warn(`[Mysti] ${this.displayName}: Force killing process after grace period`);
              processToKill.kill('SIGKILL');
            }
          }, PROCESS_KILL_GRACE_PERIOD_MS);
        }
        reject(new Error('Process timeout'));
      }, timeoutMs);

      session.process.on('close', (code) => {
        clearTimeout(timeout);
        console.log(`[Mysti] ${this.displayName}: Process closed with code:`, code);
        resolve(code);
      });

      session.process.on('error', (err) => {
        clearTimeout(timeout);
        console.error(`[Mysti] ${this.displayName}: Process error:`, err);
        reject(err);
      });
    });
  }

  /**
   * Build agent instructions from persona + skills configuration
   */
  protected async buildAgentInstructionsAsync(agentConfig?: AgentConfiguration): Promise<string> {
    if (!agentConfig || (!agentConfig.personaId && agentConfig.enabledSkills.length === 0)) {
      return '';
    }

    if (this._agentContextManager) {
      try {
        const promptContext = await this._agentContextManager.buildPromptContext(agentConfig);
        if (promptContext.systemPrompt) {
          for (const warning of promptContext.warnings) {
            console.warn(`[Mysti] ${this.displayName}: ${warning}`);
          }
          console.log(`[Mysti] ${this.displayName}: Agent context built with ~${promptContext.estimatedTokens} tokens`);
          return promptContext.systemPrompt;
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

    if (agentConfig.personaId) {
      const persona = DEVELOPER_PERSONAS[agentConfig.personaId];
      if (persona) {
        parts.push(`[Persona: ${persona.name}]\n${persona.keyCharacteristics}`);
      }
    }

    if (agentConfig.enabledSkills.length > 0) {
      const skillInstructions = agentConfig.enabledSkills
        .map(skillId => DEVELOPER_SKILLS[skillId]?.instructions)
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
    _attachments: Attachment[] | undefined,
    _args: string[]
  ): Promise<(() => Promise<void>) | null> {
    return null;
  }

  protected formatContext(context: ContextItem[]): string {
    let formatted = '# Context Files\n\n';

    for (const item of context) {
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
