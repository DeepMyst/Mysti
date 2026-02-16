/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Business Source License 1.1.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: BUSL-1.1
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
  }

  /**
   * Set the agent context manager for dynamic agent loading
   * If not set, falls back to static DEVELOPER_PERSONAS/DEVELOPER_SKILLS
   */
  public setAgentContextManager(manager: AgentContextManager): void {
    this._agentContextManager = manager;
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
      console.log(`[Mysti] ${this.displayName}: Cancelling request for panel: ${session.panelId}`);
      session.process.kill('SIGTERM');
      session.process = null;
    }
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
    const env = getEnrichedEnv(
      thinkingTokens && thinkingTokens > 0
        ? { MAX_THINKING_TOKENS: String(thinkingTokens) }
        : undefined
    );

    console.log(`[Mysti] ${this.displayName}: Spawning persistent process for panel: ${session.panelId}`);

    session.persistentProcess = spawn(cliPath, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

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

    session.persistentReady = true;
    session.lastHealthCheck = Date.now();
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
    const proc = await this._getOrSpawnPersistentProcess(session, settings);
    if (!proc || !proc.stdin?.writable || !proc.stdout) {
      return; // Caller will fall back to single-shot
    }

    // Point the per-request process ref at the persistent process
    // so that cancellation (which nulls session.process) signals our loop to stop
    session.process = proc;

    const fullPrompt = await this.buildPromptAsync(
      content, context, conversation, settings, persona, agentConfig, attachments,
    );

    // Send prompt followed by newline delimiter
    proc.stdin.write(fullPrompt + '\n');

    // Stream chunks from stdout until we hit a response boundary
    let buffer = '';
    let hasYieldedContent = false;

    for await (const chunk of proc.stdout) {
      // If session.process was nulled (cancellation), stop reading
      if (session.process !== proc) {
        break;
      }

      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) { continue; }

        // Check for response boundary before parsing
        if (this._isResponseBoundary(line)) {
          // Parse the boundary line too (may contain final data like usage stats)
          const parsed = this.parseStreamLine(line, session);
          if (parsed) {
            hasYieldedContent = true;
            yield parsed;
          }
          // Detach per-request ref (keep persistent process alive)
          session.process = null;
          session.lastHealthCheck = Date.now();
          return;
        }

        const parsed = this.parseStreamLine(line, session);
        if (parsed) {
          hasYieldedContent = true;
          yield parsed;
        }
      }
    }

    // If we exited the loop without hitting a boundary, the process likely died
    if (!hasYieldedContent) {
      yield { type: 'error', content: 'Persistent process ended unexpectedly' };
    }

    // Clean up — process is dead
    session.process = null;
    session.persistentProcess = null;
    session.persistentReady = false;
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

    // Build environment with enriched PATH and thinking tokens
    const thinkingTokens = this.getThinkingTokens(settings.thinkingLevel);
    const env = getEnrichedEnv(
      thinkingTokens && thinkingTokens > 0
        ? { MAX_THINKING_TOKENS: String(thinkingTokens) }
        : undefined
    );
    console.log(`[Mysti] ${this.displayName}: Spawning CLI process for panel ${panelId || 'default'}...`);
    // Check if we should use shell for spawning
    const useShell = vscode.workspace.getConfiguration('mysti').get<boolean>('useShellForCli', false);
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
      const fullPrompt = await this.buildPromptAsync(content, context, conversation, settings, persona, agentConfig, attachments);

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

          session.process.kill('SIGTERM');

          const processToKill = session.process;
          setTimeout(() => {
            if (processToKill && !processToKill.killed) {
              console.warn(`[Mysti] ${this.displayName}: Force killing leaked process`);
              processToKill.kill('SIGKILL');
            }
          }, PROCESS_KILL_GRACE_PERIOD_MS);
        } catch (e) {
          console.error(`[Mysti] ${this.displayName}: Error cleaning up process:`, e);
        }
      }

      session.process = null;

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

    console.log(`[Mysti] ${this.displayName}: Stream ended, waiting for process to exit...`);
    const exitCode = await this.waitForProcess(session);
    console.log(`[Mysti] ${this.displayName}: Process exited with code:`, exitCode);

    if (exitCode !== 0 && exitCode !== null) {
      const errorMsg = this._cleanStderr(stderrRef.output) || `${this.displayName} exited with code ${exitCode}`;
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
      const errorMsg = this._cleanStderr(stderrRef.output) || 'No response received from CLI';
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
    _attachments?: Attachment[]
  ): Promise<string> {
    if (content.trim().startsWith('/')) {
      return content.trim();
    }

    let fullPrompt = '';

    const agentInstructions = await this.buildAgentInstructionsAsync(agentConfig);
    if (agentInstructions) {
      fullPrompt += agentInstructions + '\n\n';
    } else if (persona) {
      const personaPrompt = this.getPersonaPrompt(persona);
      if (personaPrompt) {
        fullPrompt += personaPrompt + '\n\n';
      }
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

    if (settings.mode === 'quick-plan') {
      fullPrompt += '\n\n[Planning Mode] Create ONE concise implementation plan. Focus on the most practical approach without exploring multiple alternatives. Be brief and actionable.';
    }

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
    agentConfig?: AgentConfiguration
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

    if (context.length > 0) {
      fullPrompt += this.formatContext(context);
      fullPrompt += '\n\n';
    }

    if (conversation && conversation.messages.length > 0) {
      fullPrompt += this.formatConversationHistory(conversation);
      fullPrompt += '\n\n';
    }

    fullPrompt += content;

    if (settings.mode === 'quick-plan') {
      fullPrompt += '\n\n[Planning Mode] Create ONE concise implementation plan. Focus on the most practical approach without exploring multiple alternatives. Be brief and actionable.';
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
      /GEMINI_API_KEY/,
      /GOOGLE_GENAI_USE_VERTEXAI/,
      /auth setup failed/i,
      /could not open a new TTY/i,
    ];
    return authPatterns.some(pattern => pattern.test(stderr));
  }

  protected handleError(error: unknown): StreamChunk {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Mysti] ${this.displayName}: Error:`, errorMessage);
    return { type: 'error', content: errorMessage };
  }
}
