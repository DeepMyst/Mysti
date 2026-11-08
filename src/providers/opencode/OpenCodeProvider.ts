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
import { showAuthenticationInput } from '../base/authenticationInput';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BaseCliProvider, type PanelSessionState } from '../base/BaseCliProvider';
import { allowsUnrestrictedNativeTools } from '../base/NativeApprovalPolicy';
import type {
  CliDiscoveryResult,
  AuthConfig,
  ProviderCapabilities, PersonaConfig, NativeApprovalHost
} from '../base/IProvider';
import type {
  Settings,
  StreamChunk,
  ProviderConfig,
  AuthStatus,
  ModelInfo, ContextItem, Conversation, AgentConfiguration, Attachment, UsageStats
} from '../../types';
import { OpenCodeRemote, remoteConnection, remoteSecretKey } from './OpenCodeRemote';
import { validateModelName } from '../../utils/validation';
import { normalizeToolName, toolKind } from '../../utils/toolNames';
import { hasUsageSignal } from '../../services/TokenAccounting';

/**
 * Per-panel session state for OpenCode, extending base with tool call tracking.
 */
export interface OpenCodeSessionState extends PanelSessionState {
  activeToolCalls: Map<string, { id: string; name: string; input: Record<string, unknown> }>;
  completedToolCalls: Set<string>;
  lastUsageStats: UsageStats | null;
  lastContextUsageStats?: UsageStats | null;
}

/**
 * `opencode models [--verbose]` output → models. An id line is a bare
 * `provider/model`; with --verbose, the JSON record after it carries
 * `limit.context`. Unparseable records keep the id without a window.
 */
export function parseOpencodeModels(raw: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  let current: ModelInfo | undefined;
  let record = '';
  const flush = () => {
    if (!current) { return; }
    try {
      const context = JSON.parse(record)?.limit?.context;
      if (typeof context === 'number' && context > 0) { current.contextWindow = context; }
    } catch { /* plain listing, or not JSON: id only */ }
    if (!models.some(m => m.id === current!.id)) { models.push(current); }
  };
  for (const line of raw.split('\n')) {
    const id = line.trim();
    if (id && !id.includes(' ') && /^[^{}[\]"]+\/\S+$/.test(id)) {
      flush();
      current = { id, name: id };
      record = '';
    } else {
      record += line + '\n';
    }
  }
  flush();
  return models;
}

/**
 * OpenCode CLI provider implementation
 * Supports multiple LLM backends via OpenCode's unified interface
 * (OpenAI, Anthropic, Gemini, Groq, AWS Bedrock, Azure OpenAI, OpenRouter)
 */
export class OpenCodeProvider extends BaseCliProvider {
  readonly id = 'opencode';
  readonly displayName = 'OpenCode';

  protected override captureDetachedToolProcesses(): boolean { return true; }

  readonly config: ProviderConfig = {
    name: 'opencode',
    displayName: 'OpenCode',
    models: [
      {
        id: 'default',
        name: 'Default Model',
        description: 'Uses your OpenCode configured default model',
        contextWindow: 200000
      }
    ],
    defaultModel: 'default'
  };

  private readonly _cliCapabilities: ProviderCapabilities = {
    supportsAskPermission: false,
    supportsReadOnly: false,
    supportsStreaming: true,
    supportsThinking: true,
    supportsToolUse: true,
    supportsSessions: true,
    // Plan 27 Phase 5: attachments are written to a temp file and referenced
    // by PATH (BaseCliProvider.prepareAttachments). This backend has file-read
    // tools, so it can open what it is given.
    supportsImages: true,
    supportsFileAttachments: true,
    supportsAutoInstall: true,
    supportsPromptEnhancement: false,
    // Plan 02 Phase 1 capability matrix
    thinkingStyle: 'complete-blocks',
    thinkingLevelEffective: false,
    planMode: 'none',
    nativeModes: { approvals: true }, // only full access runs on the CLI path; other tiers are refused
    sessionKind: 'cli-resume',
    nativeInstructionFile: 'AGENTS.md',  // loaded by the CLI itself; Mysti does not resend it
    emitsToolResults: true,
    emitsUsage: true,
    usageConvention: 'anthropic', // OpenCode normalizes backends into disjoint input/cache buckets.
    modelSelection: 'custom-only'  // provider/model free-form — no meaningful static dropdown
  };

  private readonly _remote = new OpenCodeRemote(this._extensionContext.secrets);
  private readonly _usageSteps = new WeakMap<PanelSessionState, Set<string>>();
  private _remoteHost?: NativeApprovalHost;
  private get remoteEnabled(): boolean { return !!vscode.workspace.getConfiguration('mysti').get<string>('opencodeEndpoint', '').trim(); }
  private connection() {
    const config = vscode.workspace.getConfiguration('mysti');
    return remoteConnection(config.get<string>('opencodeEndpoint', ''), config.get<string>('opencodeRemoteDirectory', ''), config.get<string>('opencodeRemoteUsername', 'opencode'));
  }
  get capabilities(): ProviderCapabilities {
    return this.remoteEnabled ? { ...this._cliCapabilities, supportsAutoInstall: false, supportsNativeApproval: true, supportsAskPermission: true,
      supportsReadOnly: true, planMode: 'detected',
      supportsImages: false, supportsFileAttachments: false, supportsSessions: false, sessionKind: 'prompt-history',
      modelSelection: 'full', thinkingStyle: 'streamed', emitsUsage: false, usageConvention: 'none' } : this._cliCapabilities;
  }
  override setNativeApprovalHost(host: NativeApprovalHost | undefined): void { super.setNativeApprovalHost(host); this._remoteHost = host; }
  get configureAuthentication(): ((signal?: AbortSignal) => Promise<AuthStatus>) | undefined {
    if (!this.remoteEnabled) { return undefined; }
    return async (signal?: AbortSignal) => {
      const cancelled = (): AuthStatus => ({ authenticated: false, error: 'Setup cancelled.' });
      if (signal?.aborted) { return cancelled(); }
      const c = this.connection();
      const password = await showAuthenticationInput({ title: 'OpenCode server password', password: true,
        prompt: 'OPENCODE_SERVER_PASSWORD for ' + c.endpoint + '. Leave empty for a server without authentication.', ignoreFocusOut: true }, signal);
      if (signal?.aborted || password === undefined) { return cancelled(); }
      if (password) { await this._extensionContext.secrets.store(remoteSecretKey(c), password); }
      else { await this._extensionContext.secrets.delete(remoteSecretKey(c)); }
      if (signal?.aborted) { return cancelled(); }
      const status = await this.checkAuthentication();
      return signal?.aborted ? cancelled() : status;
    };
  }
  override getSlashCommands(panelId?: string) { return this.remoteEnabled ? [] : super.getSlashCommands(panelId); }
  override cancelCurrentRequest(panelId?: string): void { this._remote.cancel(panelId); super.cancelCurrentRequest(panelId); }
  override dispose(): void { this._remote.cancel(); super.dispose(); }
  override async *sendMessage(content: string, context: ContextItem[], settings: Settings, conversation: Conversation | null,
    persona?: PersonaConfig, panelId?: string, providerManager?: unknown, agentConfig?: AgentConfiguration, attachments?: Attachment[],
    resolveInput?: import('../base/IProvider').ProviderInputResolver): AsyncGenerator<StreamChunk> {
    if (resolveInput && !resolveInput()) { return; }
    if (!this.remoteEnabled) {
      this._assertCliPermissionSupport(settings);
      yield* super.sendMessage(content, context, settings, conversation, persona, panelId, providerManager, agentConfig, attachments, resolveInput);
      return;
    }
    try {
      if (attachments?.length) { throw new Error('OpenCode remote mode supports text context, but not local file or image attachments.'); }
      const session = this._getSession(panelId);
      const model = this._getEffectiveModel(settings);
      yield* this._remote.send(this.connection(), session.panelId, settings,
        async () => {
          if (!resolveInput) { return this.buildPromptAsync(content, context, conversation, settings, persona, agentConfig, undefined, session.channelSystemContext); }
          const render = await this.preparePromptRenderer(conversation, settings, persona, agentConfig, undefined, session.channelSystemContext);
          return () => { const input = resolveInput(); return input ? render(input.content, input.context) : undefined; };
        }, model, this._remoteHost);
    } catch (error) { yield { type: 'error', content: error instanceof Error ? error.message : String(error) }; }
  }

  protected _createSession(panelId: string): OpenCodeSessionState {
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
      completedToolCalls: new Set(),
      lastUsageStats: null,
      lastContextUsageStats: null,
    };
  }

  async discoverCli(): Promise<CliDiscoveryResult> {
    if (this.remoteEnabled) { return { found: true, path: this.connection().endpoint }; }
    return this._discoverCliCommon();
  }

  getCliPath(): string {
    if (this.remoteEnabled) { return this.connection().endpoint; }
    return this._getCliPathCommon();
  }

  /**
   * Live model discovery (Plan 01 Phase 3) via `opencode models --verbose`:
   * each `provider/model` id (exactly the form `-m` accepts) followed by its
   * models.dev record, whose `limit.context` is the window OpenCode compacts
   * against. The plain listing dropped it, so every OpenCode model read as
   * 200k. Falls back to the plain listing for a CLI without --verbose.
   * Returns null on any failure so the registry keeps its curated/cached list.
   * Never throws.
   */
  async discoverModels(timeoutMs: number): Promise<ModelInfo[] | null> {
    if (this.remoteEnabled) { try { return (await this._remote.probe(this.connection())).models; } catch { return null; } }
    const raw = await this._runCliForDiscovery(['models', '--verbose'], timeoutMs)
      ?? await this._runCliForDiscovery(['models'], timeoutMs);
    if (!raw) { return null; }
    const models = parseOpencodeModels(raw);
    return models.length > 0 ? models : null;
  }

  protected _getCliCommandName(): string {
    return 'opencode';
  }

  protected _getConfiguredCliPath(): string {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<string>('opencodePath', 'opencode');
  }

  /**
   * Provider API keys OpenCode auto-loads from the environment. The old check
   * saw only 4 — notably NOT OPENROUTER_API_KEY (the most common OpenCode setup)
   * — so an OpenRouter-only user was wrongly reported unauthenticated.
   */
  private static readonly ENV_KEYS = [
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY',
    'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'XAI_API_KEY',
    'TOGETHER_API_KEY', 'FIREWORKS_API_KEY', 'PERPLEXITY_API_KEY', 'CEREBRAS_API_KEY', 'NVIDIA_API_KEY',
  ];

  /** ~/.local/share/opencode/auth.json (honors $XDG_DATA_HOME). */
  private _ocAuthPath(): string {
    const data = process.env.XDG_DATA_HOME?.trim();
    const dir = data ? path.join(data, 'opencode') : path.join(os.homedir(), '.local', 'share', 'opencode');
    return path.join(dir, 'auth.json');
  }

  /** Config candidates ~/.config/opencode/opencode.json[c] (honors $XDG_CONFIG_HOME). */
  private _ocConfigPaths(): string[] {
    const cfg = process.env.XDG_CONFIG_HOME?.trim();
    const dir = cfg ? path.join(cfg, 'opencode') : path.join(os.homedir(), '.config', 'opencode');
    return [path.join(dir, 'opencode.json'), path.join(dir, 'opencode.jsonc')];
  }

  private _ocEnvKey(): string | undefined {
    return OpenCodeProvider.ENV_KEYS.find(k => (process.env[k] || '').trim().length > 0);
  }

  async getAuthConfig(): Promise<AuthConfig> {
    if (this.remoteEnabled) { return { type: 'api-key', isAuthenticated: (await this.checkAuthentication()).authenticated }; }
    const envKey = this._ocEnvKey();
    const authPath = this._ocAuthPath();
    const hasAuth = fs.existsSync(authPath);
    const configPath = this._ocConfigPaths().find(p => fs.existsSync(p));

    return {
      type: envKey ? 'api-key' : 'oauth',
      isAuthenticated: !!envKey || hasAuth || !!configPath,
      configPath: hasAuth ? authPath : (configPath || this._ocConfigPaths()[0])
    };
  }

  async checkAuthentication(): Promise<AuthStatus> {
    if (this.remoteEnabled) {
      try { const status = await this._remote.probe(this.connection());
        return status.connected.length ? { authenticated: true, user: 'OpenCode server ' + status.version }
          : { authenticated: false, error: 'Server connected. Run opencode auth login on the server to connect a model provider.' };
      } catch (error) { return { authenticated: false, error: error instanceof Error ? error.message : String(error) }; }
    }
    // Any provider API key OpenCode reads from the environment.
    const envKey = this._ocEnvKey();
    if (envKey) {
      return { authenticated: true, user: envKey };
    }

    // `opencode auth login` credentials — the strong marker (don't parse/require
    // fields inside it: an unreadable-but-present file must not false-negative).
    if (fs.existsSync(this._ocAuthPath())) {
      return { authenticated: true, user: 'OpenCode Account' };
    }

    // Global config declaring a provider/model.
    for (const configPath of this._ocConfigPaths()) {
      if (!fs.existsSync(configPath)) { continue; }
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (config.provider || config.model) {
          return { authenticated: true, user: 'OpenCode Config' };
        }
      } catch {
        // Config exists but couldn't parse
      }
    }

    return {
      authenticated: false,
      error: 'Not authenticated. Run "opencode auth login" or set a provider API key (e.g., OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY).'
    };
  }

  getAuthCommand(): string {
    return this.remoteEnabled ? 'Configure the OpenCode server password in provider setup' : 'opencode auth login';
  }

  getInstallCommand(): string {
    return this.remoteEnabled ? 'https://opencode.ai/docs/server/' : 'npm i -g opencode-ai@latest';
  }

  protected buildCliArgs(settings: Settings, session: PanelSessionState): string[] {
    this._assertCliPermissionSupport(settings);
    this._resetCliTurn(session as OpenCodeSessionState);
    // OpenCode uses: opencode run --format json [--model <model>] [--session <id>] [--agent <agent>]
    // Prompt is sent via stdin
    const args: string[] = [
      'run',
      '--format', 'json',
      '--thinking'
    ];

    // Add model selection
    const effectiveModel = this._getEffectiveModel(settings);
    if (effectiveModel) {
      args.push('-m', effectiveModel);
    }

    // Only explicitly unrestricted authority is supported by this CLI transport.
    args.push('--agent', 'build');

    // Session resume
    if (session.sessionId) {
      args.push('--session', session.sessionId);
      console.log('[Mysti] OpenCode: Resuming session:', session.sessionId);
    }

    console.log('[Mysti] OpenCode: Built CLI args:', args.join(' '));
    return args;
  }

  protected getThinkingTokens(_thinkingLevel: string): number | undefined {
    // OpenCode handles thinking internally based on model capabilities
    return undefined;
  }

  private _assertCliPermissionSupport(settings: Settings): void {
    // Native Plan permits shell tools; configured agent and resumed-session
    // rules can override global permission settings. The CLI has no final
    // per-request policy channel equivalent to our remote session transport.
    if (!allowsUnrestrictedNativeTools(settings)) {
      throw new Error('OpenCode CLI cannot enforce Plan, Read Only, or approval-based modes safely. Use an OpenCode remote server with native approvals, choose another provider, or explicitly select Edit Automatically with Full Access.');
    }
  }

  /**
   * Get the effective model, preferring provider-specific custom model over dropdown selection
   */
  protected _getEffectiveModel(settings: Settings): string | undefined {
    // P2.3/P0.2b: an explicitly routed model wins over the per-provider custom-model config.
    if (settings.routedModel) { return settings.routedModel; }
    const config = vscode.workspace.getConfiguration('mysti');
    const customModel = config.get<string>('opencodeModel', '');
    if (customModel) {
      const validation = validateModelName(customModel);
      if (validation.valid) {
        console.log(`[Mysti] OpenCode: Using custom model: ${customModel}`);
        return customModel;
      }
      console.warn(`[Mysti] OpenCode: Invalid custom model "${customModel}": ${validation.error}`);
    }

    // Don't pass 'default' — let CLI use its own default
    // Only pass explicit model IDs in provider/model format
    if (settings.model && settings.model !== 'default' && settings.model.includes('/')) {
      return settings.model;
    }
    return undefined;
  }

  /**
   * Parse OpenCode CLI NDJSON output format
   * Event types: step_start, text, step_finish, message.part.updated
   */
  protected parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    const ocSession = session as OpenCodeSessionState;
    try {
      const data = JSON.parse(line);

      // Extract sessionID from any event if available
      if (data.sessionID && !session.sessionId) {
        session.sessionId = data.sessionID;
        console.log('[Mysti] OpenCode: Session ID:', data.sessionID);
      }

      // Current CLI tool_use events contain a complete native ToolPart, often
      // already terminal. Keep the older flat events and string-state parts below.
      if (data.part?.type === 'tool' && (data.type === 'tool_use' || data.type === 'tool_result'
        || (data.type === 'message.part.updated' && typeof data.part.state === 'object'))) {
        return this._nativeToolPart(data.part, ocSession);
      }

      switch (data.type) {
        // Step start — emit session_active on first event
        case 'step_start':
          ocSession.lastContextUsageStats = null;
          if (data.sessionID && !session.sessionId) {
            return { type: 'session_active', sessionId: data.sessionID };
          }
          return null;

        // Text content
        case 'text':
          if (data.part?.text) {
            return { type: 'text', content: data.part.text };
          }
          return null;

        case 'reasoning':
          return typeof data.part?.text === 'string' && data.part.text
            ? { type: 'thinking', content: data.part.text } : null;

        // Incremental part updates (thinking, tool use, text deltas)
        case 'message.part.updated': {
          const part = data.part;
          if (!part) { return null; }

          switch (part.type) {
            case 'thinking':
            case 'reasoning':
              if (part.text) {
                return { type: 'thinking', content: part.text };
              }
              return null;

            case 'text':
              if (part.text) {
                return { type: 'text', content: part.text };
              }
              return null;

            case 'tool': {
              // Normalize OpenCode's lowercase native names (bash, edit,
              // write, patch, ...) for consistent display and classification.
              // CLI notifications cannot provide native approval.
              const toolName = normalizeToolName(part.name || '');
              const toolId = part.id || `tool-${Date.now()}`;
              const state = part.state || 'running';

              if (state === 'running' || state === 'pending') {
                ocSession.activeToolCalls.set(toolId, {
                  id: toolId,
                  name: toolName,
                  input: part.input || {}
                });
                return {
                  type: 'tool_use',
                  toolCall: {
                    id: toolId,
                    name: toolName,
                    input: part.input || {},
                    status: 'running',
                    kind: toolKind(toolName)
                  }
                };
              }

              if (state === 'completed' || state === 'done') {
                const toolInfo = ocSession.activeToolCalls.get(toolId);
                ocSession.activeToolCalls.delete(toolId);
                return {
                  type: 'tool_result',
                  toolCall: {
                    id: toolId,
                    name: toolInfo?.name || toolName,
                    input: toolInfo?.input || {},
                    output: part.output || part.result || '',
                    status: 'completed'
                  }
                };
              }

              if (state === 'error' || state === 'failed') {
                const toolInfo = ocSession.activeToolCalls.get(toolId);
                ocSession.activeToolCalls.delete(toolId);
                return {
                  type: 'tool_result',
                  toolCall: {
                    id: toolId,
                    name: toolInfo?.name || toolName,
                    input: toolInfo?.input || {},
                    output: part.error || 'Tool execution failed',
                    status: 'failed'
                  }
                };
              }

              return null;
            }

            default:
              return null;
          }
        }

        // Step finish — capture usage stats
        case 'step_finish':
          if (data.part?.tokens) {
            let seen = this._usageSteps.get(session);
            if (!seen) { seen = new Set(); this._usageSteps.set(session, seen); }
            const id = typeof data.part.id === 'string' ? data.part.id : '';
            if (id && seen.has(id)) { return null; }
            if (id) { seen.add(id); }
            const tokens = data.part.tokens;
            const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
            const cacheRead = count(tokens.cache?.read);
            const cacheCreate = count(tokens.cache?.write);
            const call: UsageStats = { input_tokens: count(tokens.input), output_tokens: count(tokens.output),
              ...(cacheRead > 0 ? { cache_read_input_tokens: cacheRead } : {}),
              ...(cacheCreate > 0 ? { cache_creation_input_tokens: cacheCreate } : {}) };
            ocSession.lastContextUsageStats = hasUsageSignal(call) ? call : null;
            const totalRead = (ocSession.lastUsageStats?.cache_read_input_tokens ?? 0) + cacheRead;
            const totalCreate = (ocSession.lastUsageStats?.cache_creation_input_tokens ?? 0) + cacheCreate;
            ocSession.lastUsageStats = {
              input_tokens: (ocSession.lastUsageStats?.input_tokens ?? 0) + call.input_tokens,
              output_tokens: (ocSession.lastUsageStats?.output_tokens ?? 0) + call.output_tokens,
              ...(totalRead > 0 ? { cache_read_input_tokens: totalRead } : {}),
              ...(totalCreate > 0 ? { cache_creation_input_tokens: totalCreate } : {})
            };
            console.log('[Mysti] OpenCode: Captured usage stats:', ocSession.lastUsageStats);
          }
          // Don't return done here - let sendMessage handle it
          return null;

        // Direct tool_use/tool_result events (alternative format)
        case 'tool_use': {
          const toolName = normalizeToolName(data.tool_name || data.name || '');
          const toolId = data.tool_id || data.id || `tool-${Date.now()}`;
          const params = data.parameters || data.input || {};

          ocSession.activeToolCalls.set(toolId, {
            id: toolId,
            name: toolName,
            input: params
          });
          return {
            type: 'tool_use',
            toolCall: {
              id: toolId,
              name: toolName,
              input: params,
              status: 'running',
              kind: toolKind(toolName)
            }
          };
        }

        case 'tool_result': {
          const toolId = data.tool_id || data.id || '';
          const toolInfo = ocSession.activeToolCalls.get(toolId);
          ocSession.activeToolCalls.delete(toolId);
          return {
            type: 'tool_result',
            toolCall: {
              id: toolId,
              name: toolInfo?.name || '',
              input: toolInfo?.input || {},
              output: data.output || data.result || '',
              status: data.status === 'success' || data.status === 'completed' ? 'completed' : 'failed'
            }
          };
        }

        case 'error': {
          const errMsg = data.message || data.error || data.part?.text || 'Unknown error';
          return {
            type: 'error',
            content: typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg)
          };
        }

        default:
          console.log('[Mysti] OpenCode: Unknown event type:', data.type);
          return null;
      }
    } catch {
      // If it's not JSON, only forward meaningful non-JSON output
      const trimmed = line.trim();
      if (trimmed && !this._isDiagnosticLine(trimmed)) {
        console.log('[Mysti] OpenCode: Non-JSON line:', line.substring(0, 200));
        return { type: 'text', content: line };
      }
    }

    return null;
  }

  private _nativeToolPart(part: {
    id?: string; callID?: string; tool?: string;
    state?: { status?: string; input?: Record<string, unknown>; output?: string; error?: string };
  }, session: OpenCodeSessionState): StreamChunk | null {
    const state = part.state;
    const id = part.callID || part.id;
    if (typeof id !== 'string' || !id || !state || typeof state !== 'object' || session.completedToolCalls.has(id)) { return null; }
    const active = session.activeToolCalls.get(id);
    const name = normalizeToolName(typeof part.tool === 'string' && part.tool ? part.tool : active?.name || 'tool');
    const input = state.input && typeof state.input === 'object' && !Array.isArray(state.input) ? state.input : active?.input ?? {};
    const toolCall = { id, name, input, kind: toolKind(name) };
    if (state.status === 'running' || state.status === 'pending') {
      session.activeToolCalls.set(id, { id, name, input });
      return { type: 'tool_use', toolCall: { ...toolCall, status: 'running' } };
    }
    if (state.status !== 'completed' && state.status !== 'error') { return null; }
    session.activeToolCalls.delete(id);
    session.completedToolCalls.add(id);
    const output = state.status === 'error'
      ? (typeof state.error === 'string' ? state.error : 'Tool execution failed')
      : (typeof state.output === 'string' ? state.output : '');
    return { type: 'tool_result', content: output,
      toolCall: { ...toolCall, output, status: state.status === 'error' ? 'failed' : 'completed' } };
  }

  private _resetCliTurn(session: OpenCodeSessionState): void {
    session.activeToolCalls.clear();
    session.completedToolCalls.clear();
    session.lastUsageStats = null;
    session.lastContextUsageStats = null;
    this._usageSteps.delete(session);
  }

  protected override async *processStream(
    stderrRef: { output: string }, session: PanelSessionState, drainOnReturn = false,
  ): AsyncGenerator<StreamChunk> {
    const issuingProcess = session.process;
    const isCurrent = () => session.process === issuingProcess && !session.cancelled;
    const local: Pick<OpenCodeSessionState, 'activeToolCalls' | 'completedToolCalls' | 'lastUsageStats' | 'lastContextUsageStats'> = {
      activeToolCalls: new Map(), completedToolCalls: new Set(), lastUsageStats: null, lastContextUsageStats: null,
    };
    // A buffered line from a cancelled reader must not change its replacement's
    // usage/tools. Session IDs still become available immediately to the owner.
    const reader = new Proxy(session, {
      get: (target, key, receiver) => key === 'process' ? issuingProcess
        : Object.prototype.hasOwnProperty.call(local, key) ? Reflect.get(local, key) : Reflect.get(target, key, receiver),
      set: (target, key, value, receiver) => {
        if (Object.prototype.hasOwnProperty.call(local, key)) { return Reflect.set(local, key, value); }
        if (isCurrent()) { return Reflect.set(target, key, value, receiver); }
        return true;
      },
    });
    const announced = new Set<string>();
    try {
      for await (const chunk of super.processStream(stderrRef, reader, drainOnReturn)) {
        if (!isCurrent()) { return; }
        if (chunk.type === 'tool_use' && chunk.toolCall) { announced.add(chunk.toolCall.id); }
        if (chunk.type === 'tool_result' && chunk.toolCall && !announced.has(chunk.toolCall.id)) {
          announced.add(chunk.toolCall.id);
          // The host creates/persists cards on tool_use. Announce the actual
          // terminal status; this notification is not an approval request.
          yield { type: 'tool_use', toolCall: { ...chunk.toolCall } };
          if (!isCurrent()) { return; }
        }
        yield chunk;
        if (!isCurrent()) { return; }
      }
    } finally {
      if (isCurrent()) { Object.assign(session, local); }
      this._usageSteps.delete(reader);
    }
  }

  /**
   * Check if a non-JSON line is CLI diagnostic noise that should be suppressed
   */
  private _isDiagnosticLine(line: string): boolean {
    return /^\[STARTUP\]/i.test(line)
      || /^Recording metric/i.test(line)
      || /^Loaded cached/i.test(line)
      || /^Checking for updates/i.test(line)
      || /^Using model/i.test(line)
      || /^\s*at\s+/.test(line);
  }

  /**
   * Get stored usage stats from the last message and clear them
   */
  getStoredUsage(panelId?: string): UsageStats | null {
    const session = this._getSession(panelId) as OpenCodeSessionState;
    const usage = session.lastUsageStats;
    session.lastUsageStats = null;
    return usage;
  }

  protected override _doneChunk(panelId?: string): StreamChunk {
    const done = super._doneChunk(panelId);
    const session = this._getSession(panelId) as OpenCodeSessionState;
    const contextUsage = session.lastContextUsageStats ?? null;
    session.lastContextUsageStats = null;
    return { ...done, contextUsage };
  }

  /**
   * Clear session and reset state
   */
  clearSession(panelId?: string): void {
    super.clearSession(panelId);
    for (const session of this._panelSessions.values()) {
      if (!panelId || session.panelId === panelId) { this._resetCliTurn(session as OpenCodeSessionState); }
    }
  }
}
