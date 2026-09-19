/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
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
import { createHash, randomUUID } from 'crypto';
import type { ChildProcess } from 'child_process';
import { BaseCliProvider, type PanelSessionState } from '../base/BaseCliProvider';
import { VERIFIED_NATIVE_CLI_VERSIONS } from '../base/NativeCliVersions';
import { OpenClawGateway } from './OpenClawGateway';
import { OpenClawManagedRuntime, type OpenClawManagedRuntimeHandle } from './OpenClawManagedRuntime';
import { OpenClawPolicyBroker, type OpenClawBrokerLease } from './OpenClawPolicyBroker';
import type {
  CliDiscoveryResult,
  AuthConfig,
  ProviderCapabilities,
} from '../base/IProvider';
import type {
  Settings,
  Attachment,
  StreamChunk,
  ProviderConfig,
  AuthStatus,
  ContextItem,
  Conversation,
  AgentConfiguration,
  ModelInfo,
} from '../../types';
import { readOpenClawToken } from '../../utils/platform';
import { AUTONOMOUS_PROCESS_TIMEOUT_MS, STREAM_INACTIVITY_TIMEOUT_MS } from '../../constants';
import { CliStreamInactivityError, readCliStdout } from '../base/readCliStdout';
import { toolKind } from '../../utils/toolNames';

export interface OpenClawSessionState extends PanelSessionState {
  /** Logical routing key; CLI transcript IDs are a different namespace. */
  openClawSessionKey?: string;
  activeToolCalls: Map<string, { id: string; name: string; inputJson: string }>;
  lastUsageStats: { input_tokens: number; output_tokens: number } | null;
}

interface OwnedRuntimeConfig {
  cliPath: string;
  installedRoot: string;
  workspaceDir: string;
  baseConfig: Record<string, unknown>;
  fingerprint: string;
}
interface OwnedRuntime {
  fingerprint: string;
  controller: AbortController;
  broker: OpenClawPolicyBroker;
  handle?: OpenClawManagedRuntimeHandle;
  gateway?: OpenClawGateway;
  ready: boolean;
  started: Promise<void>;
}

/**
 * Agent turns use a private, version-verified OpenClaw/Pi runtime with native
 * approval leases. The configured shared gateway is for status and channels.
 * Supported tools: read, write, edit and foreground exec.
 * Delegation, other harnesses and unguarded CLI agent execution are unsupported.
 */
export class OpenClawProvider extends BaseCliProvider {
  readonly id = 'openclaw';
  readonly displayName = 'OpenClaw';

  readonly config: ProviderConfig = {
    name: 'openclaw',
    displayName: 'OpenClaw',
    models: [
      {
        id: 'claude-opus-5',
        name: 'Claude Opus 5',
        description: 'Flagship Anthropic model via OpenClaw',
        contextWindow: 1000000,
      },
      {
        id: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        description: 'Fast and capable via OpenClaw',
        contextWindow: 1000000,
      },
      {
        id: 'gpt-6-astra',
        name: 'GPT-6 Astra',
        description: 'OpenAI flagship via OpenClaw',
        contextWindow: 1050000,
      },
    ],
    defaultModel: 'claude-opus-5',
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsThinking: true,
    supportsToolUse: true,
    toolExecution: 'native',
    supportsNativeApproval: true,
    supportsSessions: true,
    supportsAutoInstall: false,
    supportsPromptEnhancement: true,
    // Plan 02 Phase 1 capability matrix
    thinkingStyle: 'complete-blocks',
    thinkingLevelEffective: false,  // --thinking flag exists but Mysti's level setting maps 1:1 only via prompt
    planMode: 'detected',
    sessionKind: 'cli-resume',      // accepted sessionKey continuity inside the owned runtime
    emitsToolResults: true,
    emitsUsage: false,              // done.usage never supplied — footer "n/a", compaction disabled
    usageConvention: 'none',   // No cache accounting on either the CLI or the Gateway path.
    modelSelection: 'none',         // model configured via openclaw config; dropdown is a no-op (F18)
    supportsChannels: true,         // gateway channel delegation (C4)
  };

  private _gateway: OpenClawGateway;
  private readonly _transportTurns = new Map<string, AbortController>();
  private readonly _ownedRuntimes = new Map<string, OwnedRuntime>();
  private readonly _messageFiles = new Map<string, Set<string>>();

  constructor(context: vscode.ExtensionContext) {
    super(context);
    const gatewayUrl = vscode.workspace.getConfiguration('mysti').get<string>(
      'openclawGatewayUrl', 'ws://127.0.0.1:18789'
    );
    const token = readOpenClawToken();
    this._gateway = new OpenClawGateway(gatewayUrl, token);
  }

  protected _createSession(panelId: string): OpenClawSessionState {
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

  /**
   * Initialize the provider and attempt Gateway connection
   */
  async initialize(): Promise<void> {
    const useGateway = vscode.workspace.getConfiguration('mysti').get<boolean>('openclawUseGateway', true);

    if (useGateway) {
      const connected = await this._gateway.connect();
      if (connected) {
        console.log('[Mysti] OpenClaw: Gateway connected at initialization');
      } else {
        console.log('[Mysti] OpenClaw: Shared gateway unavailable; agent turns use the owned approval runtime');
      }
    } else {
      console.log('[Mysti] OpenClaw: Shared gateway disabled; agent turns use the owned approval runtime');
    }
  }

  /**
   * Dispose the provider and disconnect Gateway
   */
  dispose(): void {
    for (const turn of this._transportTurns.values()) { turn.abort(); }
    this._transportTurns.clear();
    this._gateway.disconnect();
    for (const [panelId, runtime] of this._ownedRuntimes) { this._retireRuntime(panelId, runtime); }
    // Prompt files are the user's text sitting in a shared temp dir; do not
    // leave them behind when the window closes.
    for (const panelId of this._messageFiles.keys()) {
      this._cleanupMessageFile(panelId);
    }
    super.dispose();
  }

  /** Also clear the prompt file when a panel's session is reset. */
  override disposeSession(panelId: string): void {
    this.cancelCurrentRequest(panelId);
    const runtime = this._ownedRuntimes.get(panelId);
    if (runtime) { this._retireRuntime(panelId, runtime); }
    this._cleanupMessageFile(panelId);
    super.disposeSession(panelId);
  }

  override clearSession(panelId?: string): void {
    this.cancelCurrentRequest(panelId);
    super.clearSession(panelId);
    for (const [owner, runtime] of this._ownedRuntimes) {
      if (!panelId || panelId === owner) { this._retireRuntime(owner, runtime); }
    }
    for (const session of this._panelSessions.values()) {
      if (panelId && session.panelId !== panelId) { continue; }
      const state = session as OpenClawSessionState;
      state.openClawSessionKey = `agent:main:mysti-${randomUUID()}`;
      state.lastUsageStats = null;
      state.activeToolCalls.clear();
    }
  }

  protected _openClawSessionKey(session: PanelSessionState): string {
    const state = session as OpenClawSessionState;
    return state.openClawSessionKey ??= `agent:main:mysti-${randomUUID()}`;
  }

  // --- CLI Discovery ---

  async discoverCli(): Promise<CliDiscoveryResult> {
    return this._discoverCliCommon();
  }

  getCliPath(): string {
    return this._getCliPathCommon();
  }

  /**
   * Live model discovery (Plan 01 Phase 3) via `openclaw models list --all --json`,
   * the CLI's own machine-readable model catalog (the richest source — it carries
   * context windows). Tolerant of either a top-level array or a `{ models: [...] }`
   * envelope. Returns null on any failure so the registry keeps its curated/cached
   * list. Never throws.
   */
  async discoverModels(timeoutMs: number): Promise<ModelInfo[] | null> {
    const raw = await this._runCliForDiscovery(['models', 'list', '--all', '--json'], timeoutMs);
    if (!raw) { return null; }
    try {
      const parsed = JSON.parse(raw) as unknown;
      const rows: Array<{ id?: string; key?: string; name?: string; contextWindow?: number; contextTokens?: number }> =
        Array.isArray(parsed)
          ? parsed as never[]
          : ((parsed as { models?: never[] })?.models ?? []);
      const models = rows
        .map<ModelInfo>(m => {
          const id = (m.id || m.key || '').trim();
          const ctx = typeof m.contextWindow === 'number' ? m.contextWindow
            : typeof m.contextTokens === 'number' ? m.contextTokens : undefined;
          return { id, name: m.name || id, contextWindow: ctx };
        })
        .filter(m => m.id.length > 0);
      return models.length > 0 ? models : null;
    } catch {
      return null;
    }
  }

  protected _getCliCommandName(): string {
    return 'openclaw';
  }

  protected _getConfiguredCliPath(): string {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<string>('openclawPath', 'openclaw');
  }

  // --- Authentication ---

  async getAuthConfig(): Promise<AuthConfig> {
    const home = os.homedir();
    const configPath = path.join(home, '.openclaw', 'openclaw.json');
    // `openclaw login` writes an auth-profile store (auth-profiles.json, legacy
    // auth.json) into the agent dir, NOT the ~/.openclaw/credentials/ dir the old
    // code probed (that's channel-pairing creds). Honor the state/agent-dir env
    // overrides so a relocated install isn't wrongly reported unauthenticated.
    const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.LITECLAW_STATE_DIR?.trim() || path.join(home, '.openclaw');
    const agentDir = process.env.LITECLAW_AGENT_DIR?.trim() || process.env.PI_CODING_AGENT_DIR?.trim() || path.join(stateDir, 'agents', 'main', 'agent');
    const storeHasProfiles = (p: string): boolean => {
      try {
        if (!fs.existsSync(p)) { return false; }
        const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
        const profiles = parsed?.profiles ?? parsed;
        return !!profiles && typeof profiles === 'object' && Object.keys(profiles).length > 0;
      } catch {
        return false;
      }
    };
    const hasCredStore = storeHasProfiles(path.join(agentDir, 'auth-profiles.json')) || storeHasProfiles(path.join(agentDir, 'auth.json'));
    const hasEnvAuth = !!(
      process.env.OPENCLAW_GATEWAY_TOKEN ||
      // OpenClaw is a Claude-family agent (default model claude-opus); an
      // Anthropic key / OAuth token drives its backend directly. Other providers'
      // keys (OPENAI_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY) are NOT openclaw
      // auth — they were wrongly marking openclaw authenticated whenever any
      // unrelated provider had a key in the environment, and are dropped.
      process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_OAUTH_TOKEN
    );

    return {
      type: 'cli-login',
      // Bare openclaw.json existence is NOT proof of auth: `openclaw onboard`
      // writes the config file before/without login, so an abandoned onboard
      // wrongly read as authenticated. Real auth = a populated credential store
      // (auth-profiles.json / auth.json) or a gateway token / Anthropic backend key.
      isAuthenticated: hasCredStore || hasEnvAuth,
      configPath,
    };
  }

  async checkAuthentication(): Promise<AuthStatus> {
    const auth = await this.getAuthConfig();
    if (!auth.isAuthenticated) {
      return {
        authenticated: false,
        error: 'Not authenticated. Please run "openclaw login" to sign in.',
      };
    }

    // Try to read user info from config
    try {
      if (auth.configPath && fs.existsSync(auth.configPath)) {
        const configContent = fs.readFileSync(auth.configPath, 'utf-8');
        // JSON5 is a superset of JSON; try standard JSON parse first
        // Strip single-line comments and trailing commas for basic JSON5 compat
        const cleaned = configContent
          .replace(/\/\/.*$/gm, '')
          .replace(/,(\s*[}\]])/g, '$1');
        const config = JSON.parse(cleaned);
        return {
          authenticated: true,
          user: config.email || config.user || 'Authenticated',
        };
      }
    } catch {
      // Config exists but couldn't parse — still authenticated
    }

    return { authenticated: true };
  }

  getAuthCommand(): string {
    return 'openclaw login';
  }

  getInstallCommand(): string {
    return `npm install -g openclaw@${VERIFIED_NATIVE_CLI_VERSIONS.openclaw} && openclaw onboard --install-daemon`;
  }

  getInstallMethods(): import('../../types').InstallMethod[] {
    return [
      {
        id: 'npm',
        label: 'npm (recommended)',
        command: `npm install -g openclaw@${VERIFIED_NATIVE_CLI_VERSIONS.openclaw}`,
        platform: 'all',
        priority: 1
      },
      {
        id: 'onboard',
        label: 'Full setup with daemon',
        command: `npm install -g openclaw@${VERIFIED_NATIVE_CLI_VERSIONS.openclaw} && openclaw onboard --install-daemon`,
        platform: 'all',
        priority: 2
      }
    ];
  }

  /** Materialize a request-owned prompt before spawning a CLI that reads it immediately. */
  protected override async _preparePromptBeforeSpawn(
    fullPrompt: string,
    args: string[],
    session: PanelSessionState,
    attachments?: Attachment[],
  ): Promise<() => Promise<void>> {
    const files = (attachments ?? []).filter(attachment =>
      (attachment.type === 'image' || attachment.type === 'file') && attachment.filePath);
    if (files.length) {
      fullPrompt += '\n\n# Attachments\n\nThe user attached these local files:\n'
        + files.map(attachment => `${attachment.type === 'image' ? 'Image' : 'File'} ${JSON.stringify(attachment.fileName)}: ${JSON.stringify(attachment.filePath)}`).join('\n');
    }
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mysti-openclaw-'));
    const file = path.join(directory, 'message.txt');
    const owned = this._messageFiles.get(session.panelId) ?? new Set<string>();
    this._messageFiles.set(session.panelId, owned);
    owned.add(directory);
    const cleanup = async () => {
      await fs.promises.rm(directory, { recursive: true, force: true });
      owned.delete(directory);
      if (this._messageFiles.get(session.panelId) === owned && owned.size === 0) {
        this._messageFiles.delete(session.panelId);
      }
    };
    try {
      await fs.promises.writeFile(file, fullPrompt, { encoding: 'utf8', mode: 0o600 });
      args.push('--message-file', file);
      return cleanup;
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  /** The message file is ready before spawn; OpenClaw does not consume stdin. */
  protected override async _deliverPrompt(
    proc: ChildProcess,
    _fullPrompt: string,
    _session: PanelSessionState,
  ): Promise<void> {
    proc.stdin?.end();
  }

  protected _deliverPromptForTest(
    proc: ChildProcess,
    fullPrompt: string,
    session: PanelSessionState,
  ): Promise<void> {
    return this._deliverPrompt(proc, fullPrompt, session);
  }

  /** Remove only private directories created by this provider instance. */
  private _cleanupMessageFile(panelId: string): void {
    const owned = this._messageFiles.get(panelId);
    if (!owned) { return; }
    for (const directory of owned) {
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    this._messageFiles.delete(panelId);
  }

  /** The installed agent CLI has no supported per-turn native approval bridge. */
  protected buildCliArgs(_settings: Settings, _session: PanelSessionState): string[] {
    throw new Error(`OpenClaw agent execution requires the owned native approval runtime (OpenClaw ${VERIFIED_NATIVE_CLI_VERSIONS.openclaw}, embedded Pi). Unguarded CLI fallback is disabled.`);
  }

  /**
   * OpenClaw handles thinking natively via --thinking flag
   */
  protected getThinkingTokens(_thinkingLevel: string): number | undefined {
    return undefined;
  }

  // --- Legacy stream parsing (public CLI agent execution is disabled) ---

  protected parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    const openClawSession = session as OpenClawSessionState;

    if (!line.trim()) {
      return null;
    }

    try {
      const data = JSON.parse(line.trim());

      // System/init events
      if (data.type === 'system' || data.type === 'init') {
        const sessionId = data.session_id || data.sessionId || data.agent_id;
        if (sessionId) {
          console.log('[Mysti] OpenClaw: Session init:', sessionId);
          return { type: 'session_active', sessionId };
        }
        return null;
      }

      // Text content
      if (data.type === 'text' || data.type === 'assistant' || data.type === 'content') {
        const content = data.content || data.text ||
          (data.delta && (data.delta.text || data.delta.content));
        if (content) {
          return { type: 'text', content };
        }
        return null;
      }

      // Thinking/reasoning content
      if (data.type === 'thinking' || data.type === 'reasoning') {
        const content = data.content || data.thinking || data.text;
        if (content) {
          return { type: 'thinking', content };
        }
        return null;
      }

      // Tool call events
      if (data.type === 'tool_call' || data.type === 'tool_use') {
        const toolId = data.id || data.tool_call_id || `tool_${Date.now()}`;
        const toolName = data.name || data.tool || 'unknown';
        const toolInput = data.input || data.arguments || {};

        // Detect ask_user-style tools and convert to ask_user_question chunk
        if ((toolName === 'ask_user' || toolName === 'AskUserQuestion' || toolName === 'ask_user_question') &&
            toolInput.questions && Array.isArray(toolInput.questions)) {
          console.log('[Mysti] OpenClaw: Detected ask_user tool, converting to ask_user_question chunk');
          return {
            type: 'ask_user_question',
            askUserQuestion: {
              toolCallId: toolId,
              questions: (toolInput.questions as Array<Record<string, unknown>>).map((q: Record<string, unknown>) => ({
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

        if (data.status === 'started' || data.subtype === 'started') {
          openClawSession.activeToolCalls.set(toolId, {
            id: toolId,
            name: toolName,
            inputJson: JSON.stringify(data.input || data.arguments || {}),
          });
          return {
            type: 'tool_use',
            toolCall: {
              id: toolId,
              name: toolName,
              input: data.input || data.arguments || {},
              status: 'running',
              kind: toolKind(toolName),
            },
          };
        }

        if (data.status === 'completed' || data.subtype === 'completed') {
          const active = openClawSession.activeToolCalls.get(toolId);
          openClawSession.activeToolCalls.delete(toolId);
          return {
            type: 'tool_result',
            toolCall: {
              id: toolId,
              name: active?.name || toolName,
              input: active ? JSON.parse(active.inputJson) : (data.input || {}),
              output: data.output || data.result ||
                (data.success !== undefined ? (data.success ? 'Success' : 'Failed') : ''),
              status: 'completed',
            },
          };
        }

        return null;
      }

      // Standalone tool result
      if (data.type === 'tool_result') {
        return {
          type: 'tool_result',
          toolCall: {
            id: data.tool_use_id || data.tool_id || '',
            name: data.tool_name || '',
            input: {},
            output: typeof data.content === 'string' ? data.content : JSON.stringify(data.content || ''),
            status: data.is_error ? 'failed' : 'completed',
          },
        };
      }

      // Block/chunk streaming (OpenClaw-specific)
      if (data.type === 'block' || data.type === 'chunk') {
        const content = data.content || data.text || data.data;
        if (content) {
          return { type: 'text', content };
        }
        return null;
      }

      // Usage/metrics events
      if (data.type === 'usage' || data.type === 'metrics' || data.type === 'result') {
        const usage = data.usage || data.stats || data;
        if (usage.input_tokens || usage.output_tokens) {
          openClawSession.lastUsageStats = {
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
          };
          console.log('[Mysti] OpenClaw: Usage stats:', openClawSession.lastUsageStats);
        }
        return null;
      }

      // Error events
      if (data.type === 'error') {
        return {
          type: 'error',
          content: data.error || data.message || 'Unknown OpenClaw error',
        };
      }

      // Done/complete events — swallowed: _sendViaCli/_sendViaGateway yield the
      // single authoritative done (with usage) after the stream ends
      // (Plan 02 Phase 3: exactly one done per response).
      if (data.type === 'done' || data.type === 'complete' || data.type === 'end') {
        return null;
      }

      return null;
    } catch {
      // Not JSON — treat non-empty lines as plain text
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('[') && trimmed.length > 1) {
        return { type: 'text', content: trimmed };
      }
      return null;
    }
  }

  /**
   * Legacy processStream retained for parser regression coverage:
   * 1. Try line-by-line NDJSON first (like BaseCliProvider) for real-time output
   * 2. Fall back to full-blob JSON parse if no NDJSON lines yielded content
   */
  protected async *processStream(stderrRef: { output: string }, session: PanelSessionState): AsyncGenerator<StreamChunk> {
    const proc = session.process;
    const signal = this._requestSignal(session);
    const isCurrent = () => !signal?.aborted && session.process === proc;
    let buffer = '';
    let fullOutput = '';
    let hasYieldedContent = false;

    // Stream line-by-line, accumulating full output for fallback
    try {
      for await (const chunk of readCliStdout(proc, {
        signal, isCurrent, stderr: stderrRef, label: this.displayName,
        inactivityMs: session.autonomousMode ? AUTONOMOUS_PROCESS_TIMEOUT_MS : STREAM_INACTIVITY_TIMEOUT_MS,
      })) {
        const chunkStr = chunk.toString();
        buffer += chunkStr;
        fullOutput += chunkStr;

        // Split by newlines, keep incomplete line in buffer
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!isCurrent()) { return; }
          if (!line.trim()) { continue; }
          // Only process lines that are valid standalone JSON objects —
          // fragments of a multi-line blob should be left for the full-blob fallback
          const trimmed = line.trim();
          try { JSON.parse(trimmed); } catch { continue; }
          const parsed = this.parseStreamLine(line, session);
          if (parsed) {
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

    // Process remaining buffer (only if it's valid standalone JSON)
    if (buffer.trim()) {
      try {
        JSON.parse(buffer.trim());
        const parsed = this.parseStreamLine(buffer, session);
        if (parsed) {
          hasYieldedContent = true;
          yield parsed;
        }
      } catch {
        // Not standalone JSON — will be handled by full-blob fallback
      }
    }

    // Wait for process exit
    if (!isCurrent()) { return; }
    const exitCode = await this.waitForProcess(session, proc);
    if (!isCurrent()) { return; }
    console.log('[Mysti] OpenClaw: Process exited with code:', exitCode);

    // Fallback: if no NDJSON lines yielded content, try full-blob JSON parse
    if (!hasYieldedContent && fullOutput.trim()) {
      try {
        const data = JSON.parse(fullOutput);

        // Extract text from payloads array
        if (data.payloads && Array.isArray(data.payloads)) {
          for (const payload of data.payloads) {
            if (!isCurrent()) { return; }
            if (payload.text) {
              yield { type: 'text', content: payload.text };
              hasYieldedContent = true;
            }
          }
        }

        if (!isCurrent()) { return; }
        // Extract usage stats from meta
        if (data.meta?.agentMeta?.usage) {
          const u = data.meta.agentMeta.usage;
          (session as OpenClawSessionState).lastUsageStats = {
            input_tokens: u.input || 0,
            output_tokens: u.output || 0,
          };
          console.log('[Mysti] OpenClaw: Usage stats:', (session as OpenClawSessionState).lastUsageStats);
        }

        // Extract session ID for reuse
        if (data.meta?.agentMeta?.sessionId) {
          session.sessionId = data.meta.agentMeta.sessionId;
        }
      } catch {
        // Not valid JSON — yield as plain text
        yield { type: 'text', content: fullOutput.trim() };
        hasYieldedContent = true;
      }
    }

    if (!isCurrent()) { return; }

    // Handle errors (same pattern as base class). Plan 18 (2.4 audit): these
    // used to be gated on non-empty stderr — a non-zero exit (or an empty
    // turn) with a silent stderr ended the request with NO error chunk: the
    // spinner stopped and nothing was shown. The base always surfaces it.
    if (exitCode !== 0 && exitCode !== null) {
      const msg = stderrRef.output || `${this.displayName} exited with code ${exitCode}`;
      if (this.isAuthenticationError(msg)) {
        yield { type: 'auth_error', content: msg, authCommand: this.getAuthCommand(), providerName: this.displayName };
      } else {
        yield { type: 'error', content: msg };
      }
    } else if (!hasYieldedContent) {
      const msg = stderrRef.output
        ? `No response received. stderr: ${stderrRef.output}`
        : 'No response received from CLI';
      if (stderrRef.output && this.isAuthenticationError(stderrRef.output)) {
        yield { type: 'auth_error', content: stderrRef.output, authCommand: this.getAuthCommand(), providerName: this.displayName };
      } else {
        yield { type: 'error', content: msg };
      }
    }
  }

  // --- Owned native runtime and turn lifecycle ---

  /** Resolve host settings deliberately; never copy auth profiles or modify the host config. */
  private async _readOwnedRuntimeConfig(signal: AbortSignal): Promise<OwnedRuntimeConfig> {
    const discovery = await this.discoverCli();
    if (signal.aborted) { throw new Error('OpenClaw setup cancelled.'); }
    if (!discovery.found) { throw new Error(`Install OpenClaw ${VERIFIED_NATIVE_CLI_VERSIONS.openclaw} to use the owned native approval runtime.`); }
    let cliPath: string;
    try { cliPath = await fs.promises.realpath(discovery.path); }
    catch { throw new Error(`Set the OpenClaw CLI path to the installed OpenClaw ${VERIFIED_NATIVE_CLI_VERSIONS.openclaw} openclaw.mjs entry point.`); }
    const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceDir || !path.isAbsolute(workspaceDir)) {
      throw new Error('Open a local workspace before starting the OpenClaw native approval runtime.');
    }
    const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), '.openclaw');
    const configPath = process.env.OPENCLAW_CONFIG_PATH?.trim() || path.join(stateDir, 'openclaw.json');
    let raw: string;
    try { raw = await fs.promises.readFile(configPath, { encoding: 'utf8', signal }); }
    catch { throw new Error('Cannot read OpenClaw configuration. Set OPENCLAW_CONFIG_PATH to a readable JSON config with agents.defaults.model set to provider/model and inline or environment credentials.'); }
    let baseConfig: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { throw new Error(); }
      baseConfig = parsed as Record<string, unknown>;
    } catch { throw new Error('OpenClaw native approval runtime requires a JSON object configuration; JSON5 and config includes are unsupported. Set OPENCLAW_CONFIG_PATH to an explicit JSON config.'); }
    // Hash secrets without storing or logging them in the cache identity. Environment
    // changes also require a fresh child, which captures credentials at startup.
    const fingerprint = createHash('sha256').update(JSON.stringify([cliPath, workspaceDir, raw, process.env])).digest('hex');
    return { cliPath, installedRoot: path.dirname(cliPath), workspaceDir, baseConfig, fingerprint };
  }

  private _retireRuntime(panelId: string, runtime: OwnedRuntime): void {
    if (this._ownedRuntimes.get(panelId) === runtime) { this._ownedRuntimes.delete(panelId); }
    runtime.controller.abort();
    runtime.broker.dispose();
    runtime.gateway?.disconnect();
    void runtime.handle?.dispose().catch(() => { /* disposal already revoked all execution leases */ });
  }

  private async _runtimeForTurn(session: PanelSessionState, signal: AbortSignal): Promise<OwnedRuntime> {
    const config = await this._readOwnedRuntimeConfig(signal);
    if (signal.aborted) { throw new Error('OpenClaw setup cancelled.'); }
    const cached = this._ownedRuntimes.get(session.panelId);
    if (cached?.ready && !cached.controller.signal.aborted && cached.gateway?.isConnected()
      && cached.fingerprint === config.fingerprint) { return cached; }
    if (cached) { this._retireRuntime(session.panelId, cached); }
    // A fresh private state directory has no native transcript, even if the host
    // has a persisted session marker. Reinject conversation history on this turn.
    session.sessionId = null;
    (session as OpenClawSessionState).openClawSessionKey = `agent:main:mysti-${randomUUID()}`;
    const runtime: OwnedRuntime = {
      fingerprint: config.fingerprint, controller: new AbortController(), ready: false,
      broker: new OpenClawPolicyBroker({ version: VERIFIED_NATIVE_CLI_VERSIONS.openclaw,
        targetHash: '2f8ba157e5660c32b85826eb3269a59b8add55062e31ed3d6d1528dd1017ad4b' }),
      started: Promise.resolve(),
    };
    this._ownedRuntimes.set(session.panelId, runtime);
    const abortStartup = () => { if (!runtime.ready) { this._retireRuntime(session.panelId, runtime); } };
    signal.addEventListener('abort', abortStartup, { once: true });
    runtime.started = (async () => {
      try {
        const broker = await runtime.broker.listen();
        if (runtime.controller.signal.aborted) { throw new Error('OpenClaw setup cancelled.'); }
        const handle = await OpenClawManagedRuntime.start({
          ...config, storageDir: path.join(this._extensionContext.globalStorageUri.fsPath, 'openclaw-runtimes'),
          pluginPath: path.join(this._extensionContext.extensionPath, 'resources', 'openclaw-policy'),
          preloadPath: path.join(this._extensionContext.extensionPath, 'resources', 'openclaw-policy', 'runtime-preload.mjs'),
          broker, signal: runtime.controller.signal,
        });
        runtime.handle = handle;
        if (runtime.controller.signal.aborted) { throw new Error('OpenClaw setup cancelled.'); }
        runtime.gateway = new OpenClawGateway(handle.gatewayUrl, handle.token, { ownedRuntime: true });
        if (!await runtime.gateway.connect()) { throw new Error('Cannot connect to the owned OpenClaw gateway.'); }
        await runtime.broker.waitUntilReady(runtime.controller.signal);
        if (signal.aborted || this._ownedRuntimes.get(session.panelId) !== runtime) { throw new Error('OpenClaw setup cancelled.'); }
        runtime.ready = true;
      } catch (error) {
        this._retireRuntime(session.panelId, runtime);
        throw error;
      } finally { signal.removeEventListener('abort', abortStartup); }
    })();
    await runtime.started;
    return runtime;
  }

  sendMessage(
    content: string, context: ContextItem[], settings: Settings, conversation: Conversation | null,
    persona?: import('../base/IProvider').PersonaConfig, panelId?: string, providerManager?: unknown,
    agentConfig?: AgentConfiguration, attachments?: Attachment[],
  ): AsyncGenerator<StreamChunk> {
    const turn = new AbortController();
    const stream = this._sendOwnedMessage(turn, content, context, { ...settings }, conversation,
      persona, panelId, providerManager, agentConfig, attachments?.map(attachment => ({ ...attachment })));
    // AsyncGenerator.return queues behind a pending next; abort first to wake
    // setup, a native card, or a silent gateway reader immediately.
    return {
      next: value => stream.next(value),
      return: value => { turn.abort(); return stream.return(value); },
      throw: error => { turn.abort(); return stream.throw(error); },
      [Symbol.asyncIterator]() { return this; },
    };
  }

  private async *_sendOwnedMessage(
    turn: AbortController, content: string, context: ContextItem[], settings: Settings,
    conversation: Conversation | null, persona?: import('../base/IProvider').PersonaConfig,
    panelId?: string, _providerManager?: unknown, agentConfig?: AgentConfiguration, attachments?: Attachment[],
  ): AsyncGenerator<StreamChunk> {
    if (turn.signal.aborted) { return; }
    const session = this._getSession(panelId);
    if (this._transportTurns.has(session.panelId)) { this.cancelCurrentRequest(session.panelId); }
    this._transportTurns.set(session.panelId, turn);
    session.cancelled = false;
    const isCurrent = () => !turn.signal.aborted && this._transportTurns.get(session.panelId) === turn;
    let runtime: OwnedRuntime | undefined;
    let lease: OpenClawBrokerLease | undefined;
    let doneChunk: StreamChunk | undefined;
    let errorChunk: StreamChunk | undefined;
    let completed = false;
    try {
      const handler = this._captureNativeApprovalHandler(session.panelId, turn.signal);
      runtime = await waitForSetup(this._runtimeForTurn(session, turn.signal), turn.signal);
      if (!runtime || !isCurrent()) { return; }
      const prepared = await waitForSetup(Promise.all([
        this.buildPromptAsync(content, context, this._conversationForPrompt(session, conversation),
          settings, persona, agentConfig, attachments, session.channelSystemContext),
        Promise.all((attachments ?? []).map(async attachment => {
          const data = attachment.base64Data ?? (attachment.filePath
            ? (await fs.promises.readFile(attachment.filePath, { signal: turn.signal })).toString('base64') : undefined);
          if (data === undefined) { throw new Error(`Cannot read attachment: ${attachment.fileName}`); }
          if (data.length === 0) { throw new Error(`OpenClaw Gateway does not accept empty attachments: ${attachment.fileName}`); }
          return { type: attachment.type, mimeType: attachment.mimeType, fileName: attachment.fileName, content: data };
        })),
      ]), turn.signal);
      if (!prepared || !isCurrent()) { return; }
      const sessionKey = this._openClawSessionKey(session);
      const runId = `mysti-${randomUUID()}`;
      lease = await waitForSetup(runtime.broker.openRun({ runId, sessionKey, panelId: session.panelId,
        settings, signal: turn.signal, handler, isCurrent }), turn.signal);
      if (!lease || !isCurrent() || lease.signal.aborted) { return; }
      yield { type: 'session_active', sessionId: sessionKey };
      if (!isCurrent() || lease.signal.aborted) { return; }
      const thinkingMap: Record<string, string> = { none: 'off', low: 'low', medium: 'medium', high: 'high' };
      for await (const chunk of runtime.gateway!.sendAgentMessage(prepared[0], {
        runId, sessionKey, signal: lease.signal,
        hasPending: () => lease!.hasPending, onPendingChanged: listener => lease!.onPendingChanged(listener),
        thinking: thinkingMap[settings.thinkingLevel] || 'medium', attachments: prepared[1],
        onAccepted: acceptedKey => {
          if (isCurrent() && !lease!.signal.aborted && acceptedKey === sessionKey) { session.sessionId = sessionKey; }
        },
      })) {
        if (!isCurrent() || lease.signal.aborted) { break; }
        if (chunk.type === 'done') { doneChunk ??= chunk; }
        else { yield chunk; }
      }
      if (isCurrent() && lease.signal.aborted) { throw new Error('OpenClaw native approval connection was revoked. Retry to start a verified runtime.'); }
      completed = isCurrent();
    } catch (error) {
      if (runtime && isCurrent()) { this._retireRuntime(session.panelId, runtime); }
      if (isCurrent()) { errorChunk = this.handleError(error); completed = true; }
    } finally {
      lease?.dispose();
      turn.abort();
      if (this._transportTurns.get(session.panelId) === turn) { this._transportTurns.delete(session.panelId); }
    }
    if (completed) {
      if (errorChunk) { yield errorChunk; }
      yield doneChunk ?? { type: 'done' };
    }
  }

  cancelCurrentRequest(panelId?: string): void {
    if (panelId) { this._transportTurns.get(panelId)?.abort(); }
    else { for (const turn of this._transportTurns.values()) { turn.abort(); } }
    super.cancelCurrentRequest(panelId);
  }

  // --- Utility methods ---

  getStoredUsage(panelId?: string): { input_tokens: number; output_tokens: number } | null {
    const session = this._getSession(panelId) as OpenClawSessionState;
    const usage = session.lastUsageStats;
    session.lastUsageStats = null;
    return usage;
  }

  async enhancePrompt(prompt: string): Promise<string> {
    const panelId = `openclaw-enhance-${randomUUID()}`;
    const settings: Settings = { provider: 'openclaw', model: '', mode: 'quick-plan',
      accessLevel: 'read-only', contextMode: 'auto', thinkingLevel: 'none' };
    const message = `Please enhance the following prompt to be more specific and effective for a coding assistant. Return only the enhanced prompt without explanation:\n\n${prompt}`;
    let result = '';
    try {
      for await (const chunk of this.sendMessage(message, [], settings, null, undefined, panelId)) {
        if (chunk.type === 'text') { result += chunk.content ?? ''; }
        if (chunk.type === 'error' || chunk.type === 'auth_error') { throw new Error(chunk.content || 'OpenClaw prompt enhancement failed.'); }
      }
      return result.trim() || prompt;
    } finally { this.disposeSession(panelId); }
  }

}

/** Stop waiting promptly without cancelling a connection shared by other panels. */
function waitForSetup<T>(operation: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); resolve(undefined); };
    operation.then(value => {
      signal.removeEventListener('abort', abort);
      resolve(signal.aborted ? undefined : value);
    }, error => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) { resolve(undefined); } else { reject(error); }
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); }
  });
}
