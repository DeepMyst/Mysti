/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import JSON5 from 'json5';
import type { ChildProcess } from 'child_process';
import { gatewayDeviceSigner } from './OpenClawDeviceIdentity';
import * as vscode from 'vscode';
import { allowsUnrestrictedNativeTools } from '../base/NativeApprovalPolicy';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { StringDecoder } from 'string_decoder';
import { BaseCliProvider, type PanelSessionState, type ProcessTracker } from '../base/BaseCliProvider';
import { OpenClawGateway } from './OpenClawGateway';
import { readOpenClawAgentAuthStore, readOpenClawDiagnosticProfiles } from './OpenClawAuthStore';
import { resolveOpenClawStoreFormat } from './OpenClawStoreFormat';
import { openClawBackendRedactor } from './OpenClawBackendDiagnostics';
import { hasOpenClawLocalCredentials } from './OpenClawLocalAuth';
import { readOpenClawRunMetadata, type OpenClawRunMetadata } from './OpenClawRunMetadata';
import { normalizeUsage } from '../../services/TokenAccounting';
import type {
  CliDiscoveryResult,
  AuthConfig,
  ProviderCapabilities,
  ProviderInputResolver,
} from '../base/IProvider';
import type {
  Settings,
  StreamChunk,
  ProviderConfig,
  AuthStatus,
  ContextItem,
  Conversation,
  AgentConfiguration,
  ModelInfo,
  Attachment,
  UsageStats,
} from '../../types';
import { getEnrichedEnv, readOpenClawToken, resolveOpenClawPaths } from '../../utils/platform';
import { killProcessTree, isProcessLive, markOwnedProcessGroup } from '../../utils/processKill';
import { AUTONOMOUS_PROCESS_TIMEOUT_MS, PROCESS_KILL_GRACE_PERIOD_MS, STREAM_INACTIVITY_TIMEOUT_MS } from '../../constants';
import { toolKind } from '../../utils/toolNames';
import { applyStreamText } from '../../utils/streamText';

const ENHANCEMENT_TIMEOUT_MS = 120_000;
const ENHANCEMENT_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Only a successful text-inference envelope can replace the user's draft. */
function enhancementText(output: string): string | undefined {
  try {
    const value = JSON.parse(output);
    if (value?.ok !== true || value.capability !== 'model.run' || value.transport !== 'local' || !Array.isArray(value.outputs)) {
      return undefined;
    }
    return value.outputs.map((item: unknown) => {
      const text = (item as { text?: unknown } | null)?.text;
      return typeof text === 'string' ? text : '';
    }).filter((text: string) => text.trim()).join('\n').trim() || undefined;
  } catch { return undefined; }
}

export interface OpenClawSessionState extends PanelSessionState {
  activeToolCalls: Map<string, { id: string; name: string; inputJson: string }>;
  lastUsageStats: UsageStats | null;
  lastContextUsageStats?: UsageStats | null;
  reportedModel?: string;
  /**
   * `meta.agentMeta.contextTokens` — the window OpenClaw resolved for the model
   * it ran (its own configured default: Mysti passes no model), until taken.
   */
  reportedContextWindow?: number;
}

/**
 * OpenClaw provider implementation with dual transport
 *
 * Primary: Gateway WebSocket at ws://127.0.0.1:18789 for real-time streaming
 * Fallback: CLI spawn via `openclaw agent --message-file <owned file> --json --local`
 *
 * Install: npm install -g openclaw@latest && openclaw onboard --install-daemon
 * Auth: openclaw onboard
 * Config: ~/.openclaw/openclaw.json
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
    supportsAskPermission: false,
    supportsReadOnly: false,
    supportsStreaming: true,
    supportsThinking: true,
    supportsToolUse: true,
    supportsSessions: true,
    supportsAutoInstall: false,
    supportsPromptEnhancement: true,
    // Plan 02 Phase 1 capability matrix
    thinkingStyle: 'complete-blocks',
    thinkingLevelEffective: false,  // --thinking flag exists but Mysti's level setting maps 1:1 only via prompt
    planMode: 'detected',
    nativeModes: { approvals: true }, // only full access runs; other tiers are refused
    sessionKind: 'cli-resume',      // gateway sessionKey continuity (key is locally generated — Plan 02 Phase 5 caveat)
    emitsToolResults: true,
    emitsUsage: true,               // native agentMeta: run totals and separate latest-call context
    emitsTextRevisions: true,
    usageConvention: 'anthropic',   // OpenClaw normalizes all models into disjoint input/cache buckets.
    modelSelection: 'none',         // model configured via openclaw config; dropdown is a no-op (F18)
    supportsChannels: true,         // gateway channel delegation (C4)
  };

  private _gateway: OpenClawGateway;
  private readonly _requestControllers = new Map<string, AbortController>();
  private readonly _enhancementControllers = new Set<AbortController>();
  private _disposed = false;
  /** Exact directories owned by this instance, associated only for panel disposal. */
  private readonly _messageDirectories = new Map<string, string>();
  private readonly _backendErrorRedactors = new WeakMap<ChildProcess, (text: string) => string>();

  constructor(context: vscode.ExtensionContext) {
    super(context);
    const gatewayUrl = vscode.workspace.getConfiguration('mysti').get<string>(
      'openclawGatewayUrl', 'ws://127.0.0.1:18789'
    );
    this._gateway = new OpenClawGateway(gatewayUrl, undefined, gatewayDeviceSigner(context.secrets), readOpenClawToken,
      () => this._captureBackendDiagnostics(process.cwd(), process.env));
  }

  protected _captureBackendDiagnostics(cwd: string, env: NodeJS.ProcessEnv): (text: string) => string {
    let config: unknown;
    try { config = JSON5.parse(fs.readFileSync(resolveOpenClawPaths(cwd).configPath, 'utf-8')); } catch { /* Keep environment redaction when config is unavailable. */ }
    return openClawBackendRedactor(config, env);
  }

  protected async _captureRequestDiagnostics(cwd: string, env: NodeJS.ProcessEnv): Promise<(text: string) => string> {
    const issuingEnv = { ...env };
    const { configPath, agentDir, stateDir } = resolveOpenClawPaths(cwd);
    let config: unknown;
    try { config = JSON5.parse(fs.readFileSync(configPath, 'utf-8')); } catch { /* Stored/env credentials can still be protected. */ }
    const profiles = await readOpenClawDiagnosticProfiles(agentDir, path.join(stateDir, 'agents', 'main', 'agent'));
    return openClawBackendRedactor(config, issuingEnv, profiles);
  }

  protected override isAuthenticationError(message: string): boolean {
    return super.isAuthenticationError(message)
      || message.split(/\r?\n/).some(line => /^\s*(?:Error:\s*)?FailoverError:\s*401\b/i.test(line)
        || (/^\s*(?:Error:\s*)?FallbackSummaryError:\s*All models failed \(\d+\):/i.test(line)
          && /\bProvider \S+ has (auth|auth_permanent) issue \(skipping all models\) \(\1\)(?:$| \| )/i.test(line)));
  }

  protected override _redactProcessError(text: string, proc?: ChildProcess): string {
    const redact = proc ? this._backendErrorRedactors.get(proc) : undefined;
    return super._redactProcessError(redact ? redact(text) : text, proc);
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
        console.log('[Mysti] OpenClaw: Gateway not available, will use CLI fallback');
      }
    } else {
      console.log('[Mysti] OpenClaw: Gateway disabled by setting, using CLI only');
    }
  }

  /**
   * Dispose the provider and disconnect Gateway
   */
  dispose(): void {
    this._disposed = true;
    for (const controller of this._requestControllers.values()) { controller.abort(); }
    this._requestControllers.clear();
    for (const controller of this._enhancementControllers) { controller.abort(); }
    this._gateway.disconnect();
    for (const directory of this._messageDirectories.keys()) {
      this._cleanupMessageDirectory(directory);
    }
    super.dispose();
  }

  override disposeSession(panelId: string): void {
    for (const [directory, ownerPanel] of this._messageDirectories) {
      if (ownerPanel === panelId) { this._cleanupMessageDirectory(directory); }
    }
    super.disposeSession(panelId);
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

  private _getCliCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  }

  async getAuthConfig(): Promise<AuthConfig> {
    const useGateway = vscode.workspace.getConfiguration('mysti').get<boolean>('openclawUseGateway', true);
    const hasGatewayAuth = useGateway && (this._gateway.isConnected() || !!readOpenClawToken());
    // The gateway client loads config in the extension host. Local execution
    // resolves relative paths from the same workspace cwd as the spawned CLI.
    const { configPath, agentDir, stateDir } = resolveOpenClawPaths(hasGatewayAuth ? process.cwd() : this._getCliCwd());
    // Follow the selected CLI's store format, including inherited main profiles.
    // A current CLI ignores retired JSON even when no database exists yet.
    const store = hasGatewayAuth ? { profiles: {}, order: {} } : await readOpenClawAgentAuthStore(
      agentDir, path.join(stateDir, 'agents', 'main', 'agent'),
      resolveOpenClawStoreFormat(this.getCliPath(), this.getCachedCliVersion(), this._getCliCwd()),
    );
    let config: unknown;
    try { config = JSON5.parse(fs.readFileSync(configPath, 'utf-8')); } catch { /* Generic core readiness remains available. */ }
    const hasLocalAuth = !hasGatewayAuth && hasOpenClawLocalCredentials(config, store);

    return {
      type: 'cli-login',
      // Bare openclaw.json existence is NOT proof of auth: `openclaw onboard`
      // writes the config file before/without login, so an abandoned onboard
      // wrongly read as authenticated. This offline readiness hint requires
      // credential material, a supported secret reference or a complete native
      // local no-auth configuration, not just account metadata.
      // Actual gateway/backend authentication is checked by OpenClaw at runtime.
      isAuthenticated: hasLocalAuth || hasGatewayAuth,
      configPath,
    };
  }

  async checkAuthentication(): Promise<AuthStatus> {
    const auth = await this.getAuthConfig();
    if (!auth.isAuthenticated) {
      return {
        authenticated: false,
        error: 'Not authenticated. Please run "openclaw onboard" to sign in.',
      };
    }

    // Try to read user info from config
    try {
      if (auth.configPath && fs.existsSync(auth.configPath)) {
        const configContent = fs.readFileSync(auth.configPath, 'utf-8');
        const config = JSON5.parse(configContent);
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
    return 'openclaw onboard';
  }

  getInstallCommand(): string {
    return 'npm install -g openclaw@latest && openclaw onboard --install-daemon';
  }

  getInstallMethods(): import('../../types').InstallMethod[] {
    return [
      {
        id: 'npm',
        label: 'npm (recommended)',
        command: 'npm install -g openclaw@latest',
        platform: 'all',
        priority: 1
      },
      {
        id: 'onboard',
        label: 'Full setup with daemon',
        command: 'npm install -g openclaw@latest && openclaw onboard --install-daemon',
        platform: 'all',
        priority: 2
      }
    ];
  }

  /** Prepare the only CLI prompt carrier before the child can read it. */
  private _prepareMessageFile(fullPrompt: string, panelId: string): { directory: string; file: string } {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-openclaw-'));
    this._messageDirectories.set(directory, panelId);
    const file = path.join(directory, 'message.txt');
    try {
      fs.writeFileSync(file, fullPrompt, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return { directory, file };
    } catch (error) {
      this._cleanupMessageDirectory(directory);
      throw error;
    }
  }

  /** Only remove this request's private directory, never another turn's file. */
  private _cleanupMessageDirectory(directory: string): void {
    if (!this._messageDirectories.has(directory)) { return; }
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      this._messageDirectories.delete(directory);
    } catch {
      // Best effort, without replacing the request's original result/error.
    }
  }

  // --- CLI Args (for fallback mode) ---

  protected buildCliArgs(settings: Settings, _session: PanelSessionState): string[] {
    const args: string[] = ['agent', '--json'];

    // The request adds --message-file after preparing its private prompt file.
    // Keep prompt text out of argv and avoid a post-spawn file-read race.

    // It also requires a session selector — "Pass --to <E.164>, --session-key,
    // --session-id, or --agent to choose a session". The panel id IS Mysti's
    // session boundary, so it maps onto --session-key directly and each panel
    // keeps its own OpenClaw session.
    args.push('--session-key', `mysti-${_session.panelId}`);

    // Map thinking levels: Mysti none/low/medium/high -> OpenClaw off/low/medium/high
    const thinkingMap: Record<string, string> = {
      'none': 'off',
      'low': 'low',
      'medium': 'medium',
      'high': 'high',
    };
    const thinkingLevel = thinkingMap[settings.thinkingLevel] || 'medium';
    args.push('--thinking', thinkingLevel);

    // Local mode (no gateway needed for CLI fallback)
    args.push('--local');

    // Add permission flags based on mode and access level
    // The CLI has no --sandbox or --yolo flags. sendMessage rejects modes
    // whose permissions this transport cannot enforce.

    return args;
  }

  /**
   * OpenClaw handles thinking natively via --thinking flag
   */
  protected getThinkingTokens(_thinkingLevel: string): number | undefined {
    return undefined;
  }

  // --- Stream Parsing (for CLI fallback) ---

  protected parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    return this._parseCliStreamLine(line, session, session.process ?? undefined);
  }

  private _parseCliStreamLine(line: string, session: PanelSessionState, issuingProcess?: ChildProcess): StreamChunk | null {
    // Stop clears session.process while the old stdout can still drain. The
    // streaming caller retains its issuing handle for diagnostic redaction.
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
          console.log('[Mysti] OpenClaw: Session init:', this._redactProcessError(String(sessionId), issuingProcess));
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

        if (data.status === 'completed' || data.subtype === 'completed' || data.status === 'failed' || data.subtype === 'failed') {
          const active = openClawSession.activeToolCalls.get(toolId);
          openClawSession.activeToolCalls.delete(toolId);
          const failed = data.is_error === true || data.success === false || data.status === 'failed' || data.subtype === 'failed';
          const output = data.output ?? data.result ?? data.error ?? (failed ? 'Failed' : data.success === true ? 'Success' : '');
          return {
            type: 'tool_result',
            toolCall: {
              id: toolId,
              name: active?.name || toolName,
              input: active ? JSON.parse(active.inputJson) : (data.input || {}),
              output: failed ? this._redactProcessError(typeof output === 'string' ? output : JSON.stringify(output), issuingProcess) : output,
              status: failed ? 'failed' : 'completed',
            },
          };
        }

        return null;
      }

      // Standalone tool result
      if (data.type === 'tool_result') {
        const toolId = data.tool_use_id || data.tool_id || data.tool_call_id || data.id || '';
        const active = openClawSession.activeToolCalls.get(toolId);
        openClawSession.activeToolCalls.delete(toolId);
        const failed = data.is_error === true || data.success === false || data.status === 'failed';
        const output = typeof data.content === 'string' ? data.content : JSON.stringify(data.content ?? '');
        return {
          type: 'tool_result',
          toolCall: {
            id: toolId,
            name: active?.name || data.tool_name || '',
            input: active ? JSON.parse(active.inputJson) : (data.input || data.arguments || {}),
            output: failed ? this._redactProcessError(output, issuingProcess) : output,
            status: failed ? 'failed' : 'completed',
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
        if ([usage.input_tokens, usage.output_tokens].every(value => value === undefined || (Number.isSafeInteger(value) && value >= 0))
          && (usage.input_tokens || usage.output_tokens)) {
          openClawSession.lastUsageStats = normalizeUsage({
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
          }, 'none');
          openClawSession.lastContextUsageStats = null;
        }
        return null;
      }

      // Error events
      if (data.type === 'error') {
        return this.handleError(data.error || data.message || 'Unknown OpenClaw error', issuingProcess);
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

  private _applyRunMetadata(session: OpenClawSessionState, metadata: OpenClawRunMetadata): void {
    session.lastUsageStats = metadata.usage ?? null;
    session.lastContextUsageStats = metadata.contextUsage;
    session.reportedContextWindow = metadata.contextWindow;
    session.reportedModel = metadata.reportedModel;
  }

  /** Native CLI output can contain several payloads and metadata in one envelope. */
  private _parseNativeResult(data: unknown, session: OpenClawSessionState, issuingProcess?: ChildProcess, streamedText = false): StreamChunk[] | undefined {
    if (!data || typeof data !== 'object' || Array.isArray(data)) { return undefined; }
    const result = data as { payloads?: unknown; status?: unknown; meta?: {
      agentMeta?: { sessionId?: unknown }; error?: unknown; aborted?: unknown;
    } };
    const metadata = readOpenClawRunMetadata(data);
    if (!metadata && !Array.isArray(result.payloads)) { return undefined; }
    const chunks: StreamChunk[] = [];
    if (metadata) {
      this._applyRunMetadata(session, metadata);
      if (metadata.reportedModel) { chunks.push({ type: 'model_info', reportedModel: metadata.reportedModel }); }
    }
    const sessionId = result.meta?.agentMeta?.sessionId;
    if (typeof sessionId === 'string' && sessionId.trim()) { session.sessionId = sessionId; }
    const payloads: Array<{ text?: unknown; isError?: unknown } | null> = Array.isArray(result.payloads) ? result.payloads : [];
    const errorPayload = payloads.find(item => item?.isError === true);
    if (!streamedText) {
      for (const item of payloads) {
        if (item?.isError !== true && typeof item?.text === 'string' && item.text) { chunks.push({ type: 'text', content: item.text }); }
      }
    }
    if (errorPayload || result.meta?.error || result.meta?.aborted === true || result.status === 'error' || result.status === 'timeout') {
      chunks.push(this.handleError(errorPayload?.text || result.meta?.error || 'OpenClaw request failed or was aborted', issuingProcess));
    }
    return chunks;
  }

  /**
   * Override processStream for CLI fallback — uses hybrid streaming:
   * 1. Try line-by-line NDJSON first (like BaseCliProvider) for real-time output
   * 2. Fall back to full-blob JSON parse if no NDJSON lines yielded content
   */
  protected async *processStream(stderrRef: { output: string }, session: PanelSessionState): AsyncGenerator<StreamChunk> {
    const issuingProcess = session.process ?? undefined;
    const inactivityMs = session.autonomousMode ? AUTONOMOUS_PROCESS_TIMEOUT_MS : STREAM_INACTIVITY_TIMEOUT_MS;
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let fullOutput = '';
    let hasYieldedContent = false;
    let hasYieldedError = false;
    let hasYieldedText = false;
    let parsedNativeResult = false;
    let stdoutDiagnostic = '';
    const parse = (line: string): StreamChunk[] => {
      let data: unknown;
      try { data = JSON.parse(line); } catch { return []; }
      const native = this._parseNativeResult(data, session as OpenClawSessionState, issuingProcess, hasYieldedText);
      if (native) { parsedNativeResult = true; return native; }
      const chunk = this._parseCliStreamLine(line, session, issuingProcess);
      return chunk ? [chunk] : [];
    };
    const recordChunk = (chunk: StreamChunk) => {
      hasYieldedContent ||= chunk.type !== 'model_info' && chunk.type !== 'session_active';
      hasYieldedText ||= chunk.type === 'text';
      hasYieldedError ||= chunk.type === 'error' || chunk.type === 'auth_error';
    };

    // Keep the hybrid parser on the shared stdout/stderr inactivity clock.
    let timedOut = false;
    for await (const event of this._readCliStdout(stderrRef, session)) {
      if (event.type === 'timeout') { timedOut = true; break; }
      const chunk = event.value;
      const chunkStr = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      buffer += chunkStr;
      fullOutput += chunkStr;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) { continue; }
        // Pretty-printed native JSON is handled by the full-blob fallback.
        for (const parsed of parse(line)) {
          recordChunk(parsed);
          yield parsed;
        }
      }
    }

    const remainingText = decoder.end();
    buffer += remainingText;
    fullOutput += remainingText;

    // Process remaining buffer (only if it's valid standalone JSON)
    if (buffer.trim()) {
      try {
        JSON.parse(buffer.trim());
        for (const parsed of parse(buffer)) {
          recordChunk(parsed);
          yield parsed;
        }
      } catch {
        // Not standalone JSON — will be handled by full-blob fallback
      }
    }

    // Wait for process exit
    const exitCode = timedOut ? null : await this.waitForProcess(session);
    if (!timedOut) { console.log('[Mysti] OpenClaw: Process exited with code:', exitCode); }
    // A credential may cross stderr chunks or change while the child runs.
    // Only report the complete diagnostic using the issuing child's snapshot.
    const stderr = this._redactProcessError(stderrRef.output, issuingProcess);
    if (stderr.trim()) { console.log('[Mysti] OpenClaw stderr:', stderr); }

    // Fallback: if no NDJSON lines yielded content, try full-blob JSON parse
    if (!hasYieldedContent && !parsedNativeResult && fullOutput.trim()) {
      try {
        const data = JSON.parse(fullOutput);

        for (const parsed of this._parseNativeResult(data, session as OpenClawSessionState, issuingProcess) ?? []) {
          recordChunk(parsed);
          yield parsed;
        }
      } catch {
        if (timedOut || (exitCode !== 0 && exitCode !== null)) {
          // A failed command's unstructured stdout is a diagnostic, not an
          // assistant reply. It needs the same credential filtering as stderr.
          stdoutDiagnostic = fullOutput.trim();
        } else {
          yield { type: 'text', content: fullOutput.trim() };
          hasYieldedContent = true;
        }
      }
    }

    if (timedOut) {
      if (!hasYieldedError) {
        yield this.handleError(`${this.displayName} produced no output for ${Math.round(inactivityMs / 60000)} minutes — the request timed out.`, issuingProcess);
      }
      return;
    }

    // Handle errors (same pattern as base class). Plan 18 (2.4 audit): these
    // used to be gated on non-empty stderr — a non-zero exit (or an empty
    // turn) with a silent stderr ended the request with NO error chunk: the
    // spinner stopped and nothing was shown. The base always surfaces it.
    if (exitCode !== 0 && exitCode !== null) {
      if (!hasYieldedError) {
        // Native stderr can contain only routine progress when its worker dies.
        // Keep the actual exit reason visible, with diagnostics on their own
        // line so native authentication wrappers remain recognizable.
        const detail = stderr || stdoutDiagnostic;
        yield this.handleError(`${this.displayName} exited with code ${exitCode}.${detail ? `\n${detail}` : ''}`, issuingProcess);
      }
    } else if (!hasYieldedContent) {
      const msg = stderr
        ? `No response received. stderr: ${stderr}`
        : 'No response received from CLI';
      yield this.handleError(stderr && this.isAuthenticationError(stderr) ? stderr : msg, issuingProcess);
    }
  }

  // --- Message Sending (dual transport) ---

  async *sendMessage(
    content: string,
    context: ContextItem[],
    settings: Settings,
    _conversation: Conversation | null,
    persona?: import('../base/IProvider').PersonaConfig,
    panelId?: string,
    providerManager?: unknown,
    agentConfig?: AgentConfiguration,
    _attachments?: Attachment[],
    resolveInput?: ProviderInputResolver,
  ): AsyncGenerator<StreamChunk> {
    if (resolveInput && !resolveInput()) { return; }
    if (!allowsUnrestrictedNativeTools(settings)) {
      yield { type: 'error', content: 'OpenClaw cannot enforce Mysti approval or read-only modes. Use another provider, or explicitly select Edit Automatically with Full Access to use OpenClaw’s configured tool policy.' };
      yield { type: 'done' };
      return;
    }
    if (this._disposed) { return; }
    const previous = this._getSession(panelId);
    const key = previous.panelId;
    if (this._requestControllers.has(key)) { this.cancelCurrentRequest(key); }
    // Parser state and process ownership belong to this turn. Carry only the
    // native conversation selector and panel-provided context into its successor.
    const session = this._createSession(key);
    session.sessionId = previous.sessionId;
    session.channelSystemContext = previous.channelSystemContext;
    session.autonomousMode = previous.autonomousMode;
    this._panelSessions.set(key, session);
    const controller = new AbortController();
    this._requestControllers.set(key, controller);
    const isCurrent = () => !this._disposed && !controller.signal.aborted && !session.cancelled
      && this._requestControllers.get(key) === controller && this._panelSessions.get(key) === session;

    try {
      const useGateway = vscode.workspace.getConfiguration('mysti').get<boolean>('openclawUseGateway', true);
      if (useGateway && this._gateway.isConnected()) {
        console.log('[Mysti] OpenClaw: Using Gateway');
        yield* this._sendViaGateway(content, context, settings, session, isCurrent, persona, panelId, agentConfig, resolveInput);
        return;
      }
      if (useGateway) {
        const reconnected = await this._gateway.connect();
        if (!isCurrent()) { return; }
        if (reconnected) {
          console.log('[Mysti] OpenClaw: Gateway reconnected, using Gateway');
          yield* this._sendViaGateway(content, context, settings, session, isCurrent, persona, panelId, agentConfig, resolveInput);
          return;
        }
      }
      if (!isCurrent()) { return; }
      console.log('[Mysti] OpenClaw: Using CLI fallback');
      yield* this._sendViaCli(content, context, settings, session, isCurrent, persona, panelId, providerManager, agentConfig, resolveInput);
    } catch (error) {
      if (isCurrent()) { throw error; }
    } finally {
      controller.abort();
      if (this._requestControllers.get(key) === controller) { this._requestControllers.delete(key); }
    }
  }

  /**
   * Send message via Gateway WebSocket
   */
  private async *_sendViaGateway(
    content: string,
    context: ContextItem[],
    settings: Settings,
    session: OpenClawSessionState,
    isCurrent: () => boolean,
    persona?: import('../base/IProvider').PersonaConfig,
    panelId?: string,
    agentConfig?: AgentConfiguration,
    resolveInput?: ProviderInputResolver,
  ): AsyncGenerator<StreamChunk> {
    const render = resolveInput ? await this.preparePromptRenderer(null, settings, persona, agentConfig, undefined, session.channelSystemContext) : undefined;
    const staticPrompt = render ? undefined : await this.buildPromptAsync(
      content, context, null, settings, persona, agentConfig,
      undefined, session.channelSystemContext,
    );

    if (!isCurrent()) { return; }

    // Map settings to Gateway options
    const thinkingMap: Record<string, string> = {
      'none': 'off', 'low': 'low', 'medium': 'medium', 'high': 'high',
    };

    const redactStored = await this._captureRequestDiagnostics(process.cwd(), process.env);
    if (!isCurrent()) { return; }
    const redactGateway = this._gateway.captureDiagnosticRedactor();
    const redact = (value: unknown) => redactStored(redactGateway(value));
    try {
      // Emit session_active so the webview shows the session indicator
      // The Gateway WebSocket doesn't emit system/init events like the CLI does
      if (!session.sessionId) {
        session.sessionId = `openclaw-gw-${panelId || 'default'}-${Date.now()}`;
      }
      yield { type: 'session_active' as const, sessionId: session.sessionId, textRevisions: true };

      if (!isCurrent()) { return; }
      const input = resolveInput?.();
      if (resolveInput && !input) { return; }
      const fullPrompt = render && input ? render(input.content, input.context) : staticPrompt!;
      if (!isCurrent()) { return; }
      for await (const chunk of this._gateway.sendAgentMessage(fullPrompt, {
        thinking: thinkingMap[settings.thinkingLevel] || 'medium',
        sessionKey: session.sessionId || `mysti-${panelId || 'default'}`,
        onRunMetadata: metadata => { if (isCurrent()) { this._applyRunMetadata(session, metadata); } },
        diagnosticRedactor: redactStored,
      })) {
        if (!isCurrent()) { return; }
        yield chunk.type === 'error' ? this.handleError(redact(chunk.content)) : chunk;
        if (!isCurrent()) { return; }
      }
      if (!isCurrent()) { return; }

      // Yield done with usage stats (and the window OpenClaw reported)
      yield this._doneChunk(panelId);
      console.log('[Mysti] OpenClaw: Gateway stream complete');
    } catch (error) {
      if (!isCurrent()) { return; }
      yield this.handleError(redact(error));
      if (isCurrent()) { yield { type: 'done' }; }
    }
  }

  /**
   * Send message via CLI fallback (spawn process)
   */
  private async *_sendViaCli(
    content: string,
    context: ContextItem[],
    settings: Settings,
    session: OpenClawSessionState,
    isCurrent: () => boolean,
    persona?: import('../base/IProvider').PersonaConfig,
    panelId?: string,
    providerManager?: unknown,
    agentConfig?: AgentConfiguration,
    resolveInput?: ProviderInputResolver,
  ): AsyncGenerator<StreamChunk> {
    const cliPath = this.getCliPath();
    const baseArgs = this.buildCliArgs(settings, session);

    const render = resolveInput ? await this.preparePromptRenderer(null, settings, persona, agentConfig, undefined, session.channelSystemContext) : undefined;
    const staticPrompt = render ? undefined : await this.buildPromptAsync(
      content, context, null, settings, persona, agentConfig,
      undefined, session.channelSystemContext,
    );

    if (!isCurrent()) { return; }

    // Session identifier — reuse existing session or derive from panelId
    const sessionId = session.sessionId || panelId || `mysti-${Date.now()}`;
    let proc: ChildProcess | undefined;
    let messageFile: { directory: string; file: string } | undefined;

    // Declare outside try so finally block can access for cleanup
    const stderrRef = { output: '' };
    const stderrHandler = (data: string) => {
      stderrRef.output += data;
    };

    try {
      const cwd = this._getCliCwd();

      const { spawn } = await import('child_process');
      if (!isCurrent()) { return; }
      const env = getEnrichedEnv();
      const redactBackend = await this._captureRequestDiagnostics(cwd, env);
      if (!isCurrent()) { return; }
      const input = resolveInput?.();
      if (resolveInput && !input) { return; }
      const fullPrompt = render && input ? render(input.content, input.context) : staticPrompt!;
      if (!isCurrent()) { return; }
      messageFile = this._prepareMessageFile(fullPrompt, session.panelId);
      const args = [...baseArgs, '--session-id', sessionId, '--message-file', messageFile.file];
      proc = spawn(cliPath, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this._backendErrorRedactors.set(proc, redactBackend);
      this._captureProcessAuthentication(proc, env);
      console.log('[Mysti] OpenClaw: Starting CLI at:', this._redactProcessError(cliPath, proc));
      console.log('[Mysti] OpenClaw: Working directory:', this._redactProcessError(cwd, proc));

      session.process = proc;

      // Plan 18 (2.4 audit): early error listener — an async spawn failure
      // otherwise emits an unhandled 'error' event before waitForProcess
      // attaches its own listener.
      proc.on('error', (err) => {
        // Raw Node errors also carry spawnargs. Keep diagnostics to the safe
        // message, without publishing arguments or an issuing credential.
        const message = this._redactProcessError(err.message, proc);
        console.error('[Mysti] OpenClaw: Spawn error:', message);
        stderrRef.output += `\nspawn error: ${message}`;
      });

      // Register process for per-panel cancellation
      if (panelId && providerManager && typeof (providerManager as ProcessTracker).registerProcess === 'function') {
        (providerManager as ProcessTracker).registerProcess(panelId, proc, this.id);
      }

      // Capture stderr for error reporting
      if (proc.stderr) {
        proc.stderr.setEncoding('utf8');
        proc.stderr.on('data', stderrHandler);
      }

      // Process streaming output
      for await (const chunk of this.processStream(stderrRef, session)) {
        if (!isCurrent()) { return; }
        yield chunk;
        if (!isCurrent()) { return; }
      }
      if (!isCurrent()) { return; }

      // Yield done with usage stats (and the window OpenClaw reported)
      yield this._doneChunk(panelId);
      console.log('[Mysti] OpenClaw: CLI stream complete');
    } catch (error) {
      if (!isCurrent()) { return; }
      yield this.handleError(error, proc);
      if (isCurrent()) { yield { type: 'done' }; }
    } finally {
      if (messageFile) {
        this._cleanupMessageDirectory(messageFile.directory);
      }
      proc?.stderr?.removeListener('data', stderrHandler);
      if (proc && isProcessLive(proc)) {
        // Stop already requested cleanup; preserve that grace instead of
        // signalling again, while retaining the existing escalation observer.
        void killProcessTree(proc, PROCESS_KILL_GRACE_PERIOD_MS, {
          label: this.displayName, initialSignal: session.cancelled ? null : 'SIGTERM',
        });
      }
      if (session.process === proc) { session.process = null; }
      if (proc && panelId && providerManager && typeof (providerManager as ProcessTracker).clearProcess === 'function') {
        (providerManager as ProcessTracker).clearProcess(panelId, proc);
      }
    }
  }

  /**
   * Cancel current request (Gateway or CLI)
   */
  cancelCurrentRequest(panelId?: string): void {
    if (panelId) { this._requestControllers.get(panelId)?.abort(); }
    else { for (const controller of this._requestControllers.values()) { controller.abort(); } }
    // Cancel Gateway run
    if (panelId) {
      const sessionKey = this._panelSessions.get(panelId)?.sessionId;
      if (sessionKey) { void this._gateway.cancelAgent(sessionKey); }
    } else { void this._gateway.cancelAgent(); }
    // Cancel CLI process via base class
    super.cancelCurrentRequest(panelId);
  }

  // --- Utility methods ---

  protected override takeReportedContextWindow(panelId?: string): number | undefined {
    const session = this._getSession(panelId) as OpenClawSessionState;
    const window = session.reportedContextWindow;
    session.reportedContextWindow = undefined;
    return window;
  }

  protected override _doneChunk(panelId?: string): StreamChunk {
    const session = this._getSession(panelId) as OpenClawSessionState;
    const contextUsage = session.lastContextUsageStats ?? null;
    const reportedModel = session.reportedModel;
    session.lastContextUsageStats = null;
    session.reportedModel = undefined;
    return { ...super._doneChunk(panelId), contextUsage, ...(reportedModel ? { reportedModel } : {}) };
  }

  getStoredUsage(panelId?: string): UsageStats | null {
    const session = this._getSession(panelId) as OpenClawSessionState;
    const usage = session.lastUsageStats;
    session.lastUsageStats = null;
    return usage;
  }

  async enhancePrompt(prompt: string): Promise<string> {
    if (this._disposed || !prompt.trim()) { return prompt; }
    const controller = new AbortController();
    this._enhancementControllers.add(controller);
    const deadline = setTimeout(() => controller.abort(), ENHANCEMENT_TIMEOUT_MS);
    const message = `Please enhance the following prompt to be more specific and effective for a coding assistant. Return only the enhanced prompt without any explanation:\n\nOriginal prompt: "${prompt}"\n\nEnhanced prompt:`;
    try {
      const useGateway = vscode.workspace.getConfiguration('mysti').get<boolean>('openclawUseGateway', true);
      if (useGateway && this._gateway.isConnected()) {
        const sessionKey = `mysti-enhance-${randomUUID()}`;
        const cancel = () => { void this._gateway.cancelAgent(sessionKey); };
        controller.signal.addEventListener('abort', cancel, { once: true });
        try {
          let result = '', bytes = 0;
          for await (const chunk of this._gateway.sendAgentMessage(message, { thinking: 'off', sessionKey, textOnly: true })) {
            if (controller.signal.aborted) { return prompt; }
            if (chunk.type === 'error' || chunk.type === 'auth_error' || chunk.type === 'tool_use' || chunk.type === 'tool_result') { return prompt; }
            if (chunk.type === 'text' && typeof chunk.content === 'string') {
              bytes += Buffer.byteLength(chunk.content);
              if (bytes > ENHANCEMENT_MAX_OUTPUT_BYTES) { controller.abort(); return prompt; }
              result = applyStreamText(result, chunk);
            }
          }
          return controller.signal.aborted ? prompt : result.trim() || prompt;
        } finally {
          controller.signal.removeEventListener('abort', cancel);
        }
      }
      return await this._enhanceViaCli(prompt, message, controller.signal);
    } catch {
      // Unsupported text-only options, failed auth or interrupted output must
      // leave the draft intact. Never retry through a tool-enabled agent run.
      return prompt;
    } finally {
      clearTimeout(deadline);
      this._enhancementControllers.delete(controller);
    }
  }

  private async _enhanceViaCli(prompt: string, message: string, signal: AbortSignal): Promise<string> {
    const { spawn } = await import('child_process');
    if (signal.aborted || this._disposed) { return prompt; }
    return new Promise((resolve) => {
      // This command calls OpenClaw's simple-completion transport without an
      // agent session or tools. Its CLI accepts prompt text only via --prompt.
      const proc = spawn(this.getCliPath(), ['infer', 'model', 'run', '--prompt', message, '--json', '--local', '--thinking', 'off'], {
        cwd: this._getCliCwd(),
        env: getEnrichedEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      markOwnedProcessGroup(proc);
      let output = '', bytes = 0, failed = false, stopping = false;
      const stop = () => {
        failed = true;
        if (stopping) { return; }
        stopping = true;
        void killProcessTree(proc, PROCESS_KILL_GRACE_PERIOD_MS, { label: 'OpenClaw prompt enhancement' });
      };
      signal.addEventListener('abort', stop, { once: true });
      proc.on('close', (code: number | null) => {
        signal.removeEventListener('abort', stop);
        resolve(code === 0 && !failed && !signal.aborted ? enhancementText(output) || prompt : prompt);
      });
      proc.on('error', () => { failed = true; });
      // Decode across byte boundaries, then parse only after successful exit.
      proc.stdout?.setEncoding('utf8');
      proc.stdout?.on('data', (data: string) => {
        if (failed) { return; }
        bytes += Buffer.byteLength(data);
        if (bytes > ENHANCEMENT_MAX_OUTPUT_BYTES) { stop(); return; }
        output += data;
      });
      proc.stdout?.on('error', stop);
      proc.stderr?.on('error', stop);
      proc.stderr?.resume();
      if (signal.aborted) { stop(); }
    });
  }

}
