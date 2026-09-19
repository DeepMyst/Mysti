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
import * as path from 'path';
import * as os from 'os';
import type { ChildProcess } from 'child_process';
import { BaseCliProvider, PanelSessionState } from '../base/BaseCliProvider';
import type {
  CliDiscoveryResult,
  AuthConfig,
  ProviderCapabilities,
  PersonaConfig
} from '../base/IProvider';
import type {
  Attachment,
  ContextItem,
  Settings,
  Conversation,
  StreamChunk,
  ProviderConfig,
  AgentConfiguration,
  AuthStatus,
  SlashCommandDefinition,
  ModelInfo
} from '../../types';
import {
  parseClaudeInitCommands,
  type NativeCommandSpec,
  type ReportedNativeCommands,
} from '../base/NativeCommands';
import { validateModelName } from '../../utils/validation';
import { getEnrichedEnv, probeCliVersion } from '../../utils/platform';
import { toolKind } from '../../utils/toolNames';
import { clampEffort } from '../../utils/effort';
import { killProcessTree, isProcessLive } from '../../utils/processKill';
import { PROCESS_KILL_GRACE_PERIOD_MS } from '../../constants';
import { ClaudeApprovalTransport, CLAUDE_NATIVE_TOOLS, CLAUDE_NATIVE_VERSIONS, CLAUDE_NATIVE_POLICY } from './ClaudeApproval';
import { VERIFIED_NATIVE_CLI_VERSIONS } from '../base/NativeCliVersions';

/**
 * Extended per-panel session state for Claude Code provider.
 * Adds tool call accumulation and usage stats tracking per panel.
 */
export interface ClaudeSessionState extends PanelSessionState {
  activeToolCalls: Map<number, { id: string; name: string; inputJson: string }>;
  lastUsageStats: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | null;
  hasStreamedText: boolean;
  awaitingCompactSummary: boolean;
  /**
   * Overflow queue for lines that decode to MORE than one chunk (e.g. a `user`
   * message carrying multiple parallel tool_result blocks). parseStreamLine
   * returns the first chunk and queues the rest here; the processStream /
   * _sendViaPersistentProcess overrides drain the queue immediately after each
   * yielded chunk (and once more at end-of-stream) so nothing is dropped.
   * Optional so pre-existing session fixtures stay type-valid.
   */
  pendingChunks?: StreamChunk[];
  /**
   * The command list the CLI reported for THIS session in its `system`/`init`
   * event. `null` until that event arrives — an empty array would mean "this
   * session genuinely has no commands", which is a different claim.
   *
   * This is the only accurate source for Claude Code: the set depends on the
   * installed version, the enabled plugins, the bundled skills (which are
   * compiled into the binary and cannot be found on disk) and MCP prompts.
   */
  reportedCommands?: ReportedNativeCommands;
}

/**
 * Claude Code CLI provider implementation
 */
export class ClaudeCodeProvider extends BaseCliProvider {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';
  private readonly _approvalTransports = new WeakMap<ChildProcess, ClaudeApprovalTransport>();
  private _verifiedCli: { path: string; identity: string; pending: Promise<void> } | undefined;

  readonly config: ProviderConfig = {
    name: 'claude-code',
    displayName: 'Claude Code',
    // Curated fallback list (bundled). Live discovery (discoverModels) refreshes
    // this from the Anthropic Models API when an ANTHROPIC_API_KEY is present;
    // otherwise the evergreen aliases (opus/sonnet/haiku) keep the UX current
    // across model releases without an extension update. Verified 2026-06.
    models: [
      {
        id: 'claude-fable-5-1',
        name: 'Claude Fable 5.1',
        description: "Anthropic's most capable model — demanding reasoning, long-horizon agents, coding",
        contextWindow: 1000000,
        releasedAt: '2026-09-01'
      },
      {
        id: 'claude-fable-5',
        name: 'Claude Fable 5',
        description: 'Previous Fable flagship for the most demanding reasoning and agentic work',
        contextWindow: 1000000
      },
      {
        id: 'claude-opus-5',
        name: 'Claude Opus 5',
        description: 'Flagship Opus — adaptive thinking on by default, best for complex coding',
        contextWindow: 1000000
      },
      {
        id: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        description: 'Best balance of speed, intelligence and cost — the default',
        contextWindow: 1000000
      },
      {
        id: 'claude-opus-4-8',
        name: 'Claude Opus 4.8',
        description: 'Previous flagship Opus for complex agentic and coding tasks',
        contextWindow: 1000000
      },
      {
        // Claude Code CLI's bracket-suffix notation for the 1M-context variant (issue #32).
        // Reaches the CLI argv intact on every spawn path (the shell:true gate permits
        // brackets — they are glob chars, not injection vectors).
        id: 'claude-opus-4-8[1m]',
        name: 'Claude Opus 4.8 (1M)',
        description: 'Opus 4.8 with a 1-million-token context window',
        contextWindow: 1000000
      },
      {
        id: 'claude-opus-4-7',
        name: 'Claude Opus 4.7',
        description: 'Previous-generation Opus, highly autonomous for long-horizon work',
        contextWindow: 1000000
      },
      {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        description: 'Previous-generation Sonnet',
        contextWindow: 1000000
      },
      {
        id: 'claude-opus-4-6',
        name: 'Claude Opus 4.6',
        description: 'Older Opus flagship, advanced reasoning and analysis',
        contextWindow: 1000000
      },
      {
        id: 'claude-opus-4-6[1m]',
        name: 'Claude Opus 4.6 (1M)',
        description: 'Opus 4.6 with a 1-million-token context window',
        contextWindow: 1000000
      },
      {
        id: 'claude-opus-4-5-20251101',
        name: 'Claude Opus 4.5',
        description: 'Legacy Opus model',
        contextWindow: 200000
      },
      {
        id: 'claude-sonnet-4-5-20250929',
        name: 'Claude Sonnet 4.5',
        description: 'Legacy Sonnet model',
        contextWindow: 200000
      },
      {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        description: 'Fast and efficient for simpler tasks',
        contextWindow: 200000
      },
      // Evergreen aliases: the Claude Code CLI resolves these to the current
      // latest model of each tier, so they keep working across model releases
      // without an extension update.
      {
        id: 'opus',
        name: 'Opus (latest)',
        description: 'Always the latest Opus model the CLI supports',
        contextWindow: 200000
      },
      {
        id: 'sonnet',
        name: 'Sonnet (latest)',
        description: 'Always the latest Sonnet model the CLI supports',
        contextWindow: 200000
      },
      {
        id: 'haiku',
        name: 'Haiku (latest)',
        description: 'Always the latest Haiku model the CLI supports',
        contextWindow: 200000
      }
    ],
    defaultModel: 'claude-sonnet-5'
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsThinking: true,
    supportsToolUse: true,
    toolExecution: 'native',
    supportsNativeApproval: true,
    supportsSessions: true,
    supportsNativeCompact: true,
    supportsPersistentProcess: true,
    supportsImages: true,
    supportsFileAttachments: true,
    supportsAutoInstall: true,
    supportsPromptEnhancement: true,
    // Plan 02 Phase 1 capability matrix
    thinkingStyle: 'streamed',     // incremental thinking deltas
    thinkingLevelEffective: true,  // levels map to real token budgets (getThinkingTokens)
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],  // native --effort; CLI clamps per model
    effortDefault: 'high',
    planMode: 'native',            // sole emitter of exit_plan_mode
    sessionKind: 'cli-resume',     // --resume with CLI-issued session IDs
    emitsToolResults: true,
    emitsUsage: true,
    usageConvention: 'anthropic',   // Claude Code emits Anthropic message_delta usage: the three buckets are disjoint.
    modelSelection: 'full'
  };

  async discoverCli(): Promise<CliDiscoveryResult> {
    return this._discoverCliCommon();
  }

  getCliPath(): string {
    return this._getCliPathCommon();
  }

  protected _getCliCommandName(): string {
    return 'claude';
  }

  protected _getConfiguredCliPath(): string {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<string>('claudeCodePath', 'claude');
  }

  protected _getAdditionalSearchPaths(): string[] {
    const paths: string[] = [];
    const extensionCli = this._findVSCodeExtensionCli();
    if (extensionCli) {
      paths.push(extensionCli);
    }
    return paths;
  }

  async getAuthConfig(): Promise<AuthConfig> {
    // Claude Code v2.x stores the signed-in account in ~/.claude.json (the
    // `oauthAccount` object) plus the OS keychain; the file itself exists even
    // before login (numStartups etc.), so EXISTENCE is not enough — we look for
    // the account marker. Older installs used ~/.claude/config.json. API-key
    // users authenticate via env vars. Accept any of these.
    const homeConfig = path.join(os.homedir(), '.claude.json');            // v2.x
    const legacyConfig = path.join(os.homedir(), '.claude', 'config.json'); // legacy

    if (this._hasClaudeAccount(homeConfig)) {
      return { type: 'cli-login', isAuthenticated: true, configPath: homeConfig };
    }
    if (fs.existsSync(legacyConfig)) {
      return { type: 'cli-login', isAuthenticated: true, configPath: legacyConfig };
    }
    if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      return { type: 'cli-login', isAuthenticated: true, configPath: homeConfig };
    }
    return { type: 'cli-login', isAuthenticated: false, configPath: homeConfig };
  }

  /** True when ~/.claude.json carries a signed-in account marker (v2.x). */
  private _hasClaudeAccount(homeConfig: string): boolean {
    try {
      if (!fs.existsSync(homeConfig)) { return false; }
      const j = JSON.parse(fs.readFileSync(homeConfig, 'utf-8')) as {
        oauthAccount?: { emailAddress?: string; accountUuid?: string };
      };
      return !!(j.oauthAccount && (j.oauthAccount.emailAddress || j.oauthAccount.accountUuid));
    } catch {
      return false;
    }
  }

  async checkAuthentication(): Promise<AuthStatus> {
    const auth = await this.getAuthConfig();
    if (!auth.isAuthenticated) {
      return {
        authenticated: false,
        error: 'Not authenticated. Please run "claude" and sign in (or "claude /login").'
      };
    }

    // Try to surface the signed-in email/user for display.
    try {
      if (auth.configPath && fs.existsSync(auth.configPath)) {
        const config = JSON.parse(fs.readFileSync(auth.configPath, 'utf-8')) as {
          oauthAccount?: { emailAddress?: string; displayName?: string };
          email?: string; user?: string;
        };
        const user = config.oauthAccount?.emailAddress || config.oauthAccount?.displayName
          || config.email || config.user || 'Authenticated';
        return { authenticated: true, user };
      }
    } catch {
      // Config exists but couldn't parse - still authenticated
    }

    return { authenticated: true };
  }

  getAuthCommand(): string {
    return 'claude auth login';
  }

  getInstallCommand(): string {
    return `npm install -g @anthropic-ai/claude-code@${VERIFIED_NATIVE_CLI_VERSIONS['claude-code']}`;
  }

  // ============================================================================
  // Slash command menu: Claude-specific commands
  // ============================================================================

  public override getSlashCommands(_panelId?: string): SlashCommandDefinition[] {
    const base = super.getSlashCommands(_panelId);
    return [
      ...base,
      // `/compact` used to be declared here and was DEAD: it posted
      // `sendCliPassthrough`, a message no webview handler receives. Claude's
      // real `/compact` now lives in the provider-native section
      // (NATIVE_COMMANDS['claude-code']) as a verified pass-through.
      {
        id: 'claude:thinking',
        label: 'Thinking level',
        description: 'Adjust Claude thinking depth',
        section: 'model',
        icon: 'lightbulb',
        provider: 'claude-code',
        action: 'execute',
        keywords: ['thinking', 'reasoning', 'depth'],
      },
    ];
  }

  /**
   * What the CLI said it has, for this panel.
   *
   * `null` before the panel's first turn, so the menu falls back to the curated
   * catalog rather than showing nothing.
   */
  public override getDynamicNativeCommands(panelId?: string): NativeCommandSpec[] {
    if (!panelId) { return []; }
    const session = this._panelSessions.get(panelId) as ClaudeSessionState | undefined;
    return session?.reportedCommands ?? [];
  }

  /** True once the CLI has reported — the caller then trusts it over the catalog. */
  public override hasReportedNativeCommands(panelId?: string): boolean {
    if (!panelId) { return false; }
    const session = this._panelSessions.get(panelId) as ClaudeSessionState | undefined;
    return Array.isArray(session?.reportedCommands);
  }

  // ============================================================================
  // Per-panel session creation (override for Claude-specific state)
  // ============================================================================

  protected _createSession(panelId: string): ClaudeSessionState {
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
      hasStreamedText: false,
      awaitingCompactSummary: false,
      pendingChunks: [],
      reportedCommands: null,
    };
  }

  protected buildCliArgs(settings: Settings, session: PanelSessionState): string[] {
    // --verbose is required by Claude CLI when using --print with --output-format=stream-json
    const args: string[] = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
    ];

    // Map Mysti modes/access levels to Claude Code permission flags
    // This ensures proper enforcement at the CLI level
    this._addPermissionFlags(args, settings);

    // Always use --print for single-shot (non-interactive) mode.
    // The structured stdin pipe remains open for native permission responses.
    args.push('--print');

    // Session handling - resume existing session or start new
    if (session.sessionId) {
      args.push('--resume', session.sessionId);
      console.log('[Mysti] Claude: Continuing session:', session.sessionId);
    } else {
      console.log('[Mysti] Claude: Starting new session');
    }

    // Add model selection (custom model override or dropdown selection)
    const effectiveModel = this._getEffectiveModel(settings);
    if (effectiveModel) {
      args.push('--model', effectiveModel);
    }

    // Reasoning effort (Claude Code parity). Clamp to the declared tiers so a
    // hand-edited/invalid defaultEffortLevel in settings.json degrades to a
    // supported tier instead of hard-failing the CLI spawn (Plan 18 4.4 —
    // Codex already clamps). Valid tiers pass through unchanged; the CLI still
    // clamps per-model on its side.
    const effort = clampEffort(settings.effortLevel, this.capabilities.effortLevels);
    if (effort) {
      args.push('--effort', effort);
    }

    // Inject channel system context as real system instructions (not user message)
    if (session.channelSystemContext) {
      args.push('--append-system-prompt', session.channelSystemContext);
      console.log('[Mysti] Claude: Appending channel context to system prompt');
    }

    // Plan 05 — register the in-extension mysti-canvas MCP server (canvas-linked sessions).
    if (session.canvasMcpConfigPath) {
      args.push('--mcp-config', session.canvasMcpConfigPath);
    }

    return args;
  }

  // ============================================================================
  // Persistent Process Mode
  // ============================================================================

  /**
   * Build CLI args for persistent (interactive) mode.
   * Uses --input-format stream-json so the CLI accepts structured JSON on stdin
   * (unlike plain interactive REPL mode which doesn't work with piped stdin).
   * The process stays alive and accepts new messages as JSON lines on stdin.
   */
  protected buildPersistentCliArgs(settings: Settings, session: PanelSessionState): string[] | null {
    const args: string[] = [
      '--print',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
    ];

    this._addPermissionFlags(args, settings);

    // Use --resume to continue an existing session
    if (session.sessionId) {
      args.push('--resume', session.sessionId);
    }

    const effectiveModel = this._getEffectiveModel(settings);
    if (effectiveModel) {
      args.push('--model', effectiveModel);
    }

    // Reasoning effort (Claude Code parity). Clamped like the single-shot path
    // so an invalid settings.json value degrades instead of erroring (Plan 18 4.4).
    const effort = clampEffort(settings.effortLevel, this.capabilities.effortLevels);
    if (effort) {
      args.push('--effort', effort);
    }

    // Inject system context at spawn time (only way to set system prompt for persistent process)
    if (session.channelSystemContext) {
      args.push('--append-system-prompt', session.channelSystemContext);
    }

    // Plan 05 — register the in-extension mysti-canvas MCP server (canvas-linked sessions).
    if (session.canvasMcpConfigPath) {
      args.push('--mcp-config', session.canvasMcpConfigPath);
    }

    return args;
  }

  /**
   * Format a prompt for the persistent process using --input-format stream-json.
   * Claude CLI expects JSON messages on stdin:
   * {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
   */
  protected _formatPersistentInput(prompt: string, _session: PanelSessionState): string {
    const message = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: prompt }]
      }
    };
    return JSON.stringify(message) + '\n';
  }

  protected override async _deliverPrompt(proc: ChildProcess, prompt: string, session: PanelSessionState): Promise<void> {
    // The native permission response channel must stay open through the result.
    if (!proc.stdin?.writable) { throw new Error('Claude permission input channel is unavailable.'); }
    proc.stdin.write(this._formatPersistentInput(prompt, session));
  }

  protected override async _validateNativeApprovalCli(_session: PanelSessionState, _settings: Settings): Promise<void> {
    await this._verifyNativePermissionPolicy();
    const cliPath = this.getCliPath();
    const stat = await fs.promises.stat(cliPath);
    const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (this._verifiedCli?.path !== cliPath || this._verifiedCli.identity !== identity) {
      const pending = (async () => {
        const version = (await probeCliVersion(cliPath))?.match(/^([0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)/)?.[1];
        if (!version || !CLAUDE_NATIVE_VERSIONS.has(version)) {
          throw new Error(`Claude Code ${version || 'unknown'} has no verified Mysti permission bridge. Select Claude Code 2.1.266 in mysti.claudeCodePath.`);
        }
      })();
      this._verifiedCli = { path: cliPath, identity, pending };
    }
    await this._verifiedCli.pending;
  }

  private async _verifyNativePermissionPolicy(): Promise<void> {
    const policyPath = path.join(this._extensionContext.extensionPath, 'resources', 'claude-policy', 'settings.json');
    const policy = JSON.parse(await fs.promises.readFile(policyPath, 'utf8'));
    if (JSON.stringify(policy) !== JSON.stringify(CLAUDE_NATIVE_POLICY)) {
      throw new Error('Claude native permission policy is missing or changed; reinstall this Mysti extension.');
    }
  }

  /**
   * Cancel the in-flight turn on the persistent `--input-format stream-json`
   * process.
   *
   * The base class used to write a raw ETX byte (`\x03`) into stdin. For this
   * provider stdin is an NDJSON pipe, not a terminal: the byte is not an
   * interrupt, it lands inside the current JSON line and the NEXT
   * `{"type":"user",...}` message Mysti writes is unparseable — so Stop
   * silently bricked the session instead of cancelling the turn.
   *
   * Pending native approvals are revoked by the base turn owner first. SIGINT
   * lets the native CLI flush its session; process-tree SIGKILL escalation
   * provides the cleanup backstop. The next turn resumes the saved session
   * with a fresh process and freshly captured host authority.
   */
  protected _interruptPersistentProcess(session: PanelSessionState): void {
    const proc = session.persistentProcess;
    if (isProcessLive(proc)) {
      console.log(`[Mysti] Claude: SIGINT to end the turn on the persistent process for panel: ${session.panelId}`);
      void killProcessTree(proc, PROCESS_KILL_GRACE_PERIOD_MS, {
        label: this.displayName,
        initialSignal: 'SIGINT',
      });
    }
    session.persistentProcess = null;
    session.persistentReady = false;
  }

  /**
   * Detect response boundary in Claude CLI stream-json output.
   * The `result` event marks the end of a response in interactive mode.
   */
  protected _isResponseBoundary(line: string): boolean {
    try {
      const data = JSON.parse(line.trim());
      return data.type === 'result';
    } catch {
      return false;
    }
  }

  /**
   * Get thinking tokens based on thinking level
   */
  protected getThinkingTokens(thinkingLevel: string): number | undefined {
    const tokenMap: Record<string, number> = {
      'none': 0,
      'low': 4000,
      'medium': 8000,
      'high': 16000
    };
    return tokenMap[thinkingLevel];
  }

  /**
   * Retain the legacy wait-ceiling setting for configuration compatibility.
   * Native background tasks remain disabled until their ownership is verified.
   */
  protected override getExtraSpawnEnv(_settings: Settings): Record<string, string> {
    const ceiling = vscode.workspace.getConfiguration('mysti').get<number>('claude.backgroundWaitCeilingMs', 600000);
    const safe = Number.isFinite(ceiling) && ceiling >= 0 ? Math.floor(ceiling) : 600000;
    return { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(safe), CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' };
  }

  /**
   * Add permission flags based on mode and access level
   * Maps Mysti settings to Claude Code CLI permission modes
   */
  private _addPermissionFlags(args: string[], settings: Settings): void {
    const { mode, accessLevel } = settings;
    const restricted = mode === 'quick-plan' || mode === 'detailed-plan' || accessLevel === 'read-only';
    args.push('--permission-mode', restricted ? 'plan' : 'manual',
      '--permission-prompt-tool', 'stdio', '--permission-prompts', 'host',
      '--settings', path.join(this._extensionContext.extensionPath, 'resources', 'claude-policy', 'settings.json'),
      '--setting-sources=', '--strict-mcp-config', '--disable-slash-commands', '--no-chrome',
      '--tools', (restricted ? ['Read', 'Glob', 'Grep'] : CLAUDE_NATIVE_TOOLS).join(','));
  }

  /**
   * Get the effective model, preferring provider-specific custom model over dropdown selection
   */
  protected _getEffectiveModel(settings: Settings): string | undefined {
    // P2.3/P0.2b: an explicitly routed model wins over the per-provider custom-model config.
    if (settings.routedModel) { return settings.routedModel; }
    const config = vscode.workspace.getConfiguration('mysti');
    const customModel = config.get<string>('claudeCodeModel', '');
    if (customModel) {
      const validation = validateModelName(customModel);
      if (validation.valid) {
        console.log(`[Mysti] Claude: Using custom model: ${customModel}`);
        return customModel;
      }
      console.warn(`[Mysti] Claude: Invalid custom model "${customModel}": ${validation.error}`);
    }
    if (settings.model) {
      // Bracketed 1M-context ids (e.g. claude-opus-4-6[1m]) reach the CLI argv
      // intact on every spawn path: the default (array-args) spawn applies no
      // shell interpretation, and the shell:true gate now permits brackets
      // (they are glob chars, not injection vectors). No sanitization needed.
      return settings.model;
    }
    return undefined;
  }

  /**
   * Live model discovery (Plan 01 Phase 3) via the official Anthropic Models API.
   *
   * The Claude Code CLI has no `list models` subcommand and normally authenticates
   * with a Claude.ai subscription (no API key), so this only fires when an
   * ANTHROPIC_API_KEY is present in the environment — otherwise it returns null
   * and the curated list + evergreen aliases (opus/sonnet/haiku) carry the UX.
   * Returns null on any failure so the registry keeps its curated/cached list.
   * Never throws.
   */
  async discoverModels(timeoutMs: number): Promise<ModelInfo[] | null> {
    const env = getEnrichedEnv();
    const apiKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { return null; }
    try {
      const response = await fetch('https://api.anthropic.com/v1/models?limit=100', {
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      });
      if (!response.ok) { return null; }
      const data = await response.json() as {
        data?: Array<{ id?: string; display_name?: string; max_input_tokens?: number }>;
      };
      const models = (data.data || [])
        .map<ModelInfo>(m => ({
          id: (m.id || '').trim(),
          name: m.display_name || m.id || '',
          contextWindow: typeof m.max_input_tokens === 'number' ? m.max_input_tokens : undefined,
        }))
        .filter(m => m.id.length > 0);
      return models.length > 0 ? models : null;
    } catch {
      return null;
    }
  }

  protected parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    const claudeSession = session as ClaudeSessionState;

    try {
      const data = JSON.parse(line);

      const proc = session.process;
      if (proc && (data.type === 'control_request' || data.type === 'control_cancel_request'
        || (data.type === 'system' && data.subtype === 'init'))) {
        let transport = this._approvalTransports.get(proc);
        if (!transport) {
          transport = new ClaudeApprovalTransport(proc);
          this._approvalTransports.set(proc, transport);
        }
        try {
          if (data.type === 'system') { transport.attest(data.claude_code_version); }
          else { transport.handle(data, this._nativeApprovalRequests(session), this._requestSettings(session)); return null; }
        } catch (error) {
          transport.fail();
          this._nativeApprovalRequests(session)?.dispose();
          void killProcessTree(proc, PROCESS_KILL_GRACE_PERIOD_MS, { label: this.displayName, initialSignal: 'SIGKILL' });
          return { type: 'error', content: error instanceof Error ? error.message : 'Claude permission protocol failed.' };
        }
      }

      // Handle stream_event wrapper
      if (data.type === 'stream_event') {
        const nestedEvent = data.event || {};
        const nestedType = nestedEvent.type || '';
        const blockIndex = nestedEvent.index ?? -1;

        // Handle content_block_delta - the main streaming content
        if (nestedType === 'content_block_delta') {
          const delta = nestedEvent.delta || {};
          if (delta.type === 'text_delta') {
            claudeSession.hasStreamedText = true;
            return { type: 'text', content: delta.text || '' };
          }
          if (delta.type === 'thinking_delta') {
            return { type: 'thinking', content: delta.thinking || '' };
          }
          if (delta.type === 'input_json_delta') {
            // Accumulate tool input JSON
            const activeTool = claudeSession.activeToolCalls.get(blockIndex);
            if (activeTool) {
              activeTool.inputJson += delta.partial_json || '';
            }
            return null;
          }
        }

        // Handle content_block_start - beginning of a content block
        if (nestedType === 'content_block_start') {
          const contentBlock = nestedEvent.content_block || {};
          if (contentBlock.type === 'tool_use') {
            // Store tool call info for accumulation
            claudeSession.activeToolCalls.set(blockIndex, {
              id: contentBlock.id || '',
              name: contentBlock.name || '',
              inputJson: ''
            });
            // For AskUserQuestion, don't emit immediate tool_use - wait for full input
            if (contentBlock.name === 'AskUserQuestion') {
              console.log('[Mysti] Claude: AskUserQuestion tool started, waiting for input');
              return null;
            }
            // Return tool_use immediately with running status for other tools
            return {
              type: 'tool_use',
              toolCall: {
                id: contentBlock.id || '',
                name: contentBlock.name || '',
                input: {},
                status: 'running',
                kind: toolKind(contentBlock.name || '')
              }
            };
          }
          if (contentBlock.type === 'thinking') {
            return { type: 'thinking', content: '' };
          }
        }

        // Handle content_block_stop - end of a content block
        if (nestedType === 'content_block_stop') {
          const completedTool = claudeSession.activeToolCalls.get(blockIndex);
          if (completedTool) {
            claudeSession.activeToolCalls.delete(blockIndex);
            // Parse the accumulated JSON
            let parsedInput: Record<string, unknown> = {};
            try {
              if (completedTool.inputJson) {
                parsedInput = JSON.parse(completedTool.inputJson);
              }
            } catch {
              console.log('[Mysti] Claude: Failed to parse tool input JSON:', completedTool.inputJson);
            }

            // Check if this is AskUserQuestion tool - emit special chunk type
            if (completedTool.name === 'AskUserQuestion' && parsedInput.questions) {
              console.log('[Mysti] Claude: AskUserQuestion completed with', (parsedInput.questions as unknown[]).length, 'questions');
              return {
                type: 'ask_user_question',
                askUserQuestion: {
                  toolCallId: completedTool.id,
                  questions: parsedInput.questions as import('../../types').AskUserQuestionItem[]
                }
              };
            }

            // Check if this is ExitPlanMode tool - emit special chunk type with plan path
            if (completedTool.name === 'ExitPlanMode') {
              // Extract plan file path from input, ensuring it's a string or null
              const rawPath = parsedInput.plan_file_path || parsedInput.planFilePath;
              // A streamed notification has no authority to make the host
              // read a model-selected file. Live turns review streamed plan
              // text; standalone transcript parsing retains historical paths.
              const planFilePath: string | null = !proc && typeof rawPath === 'string' ? rawPath : null;
              console.log('[Mysti] Claude: ExitPlanMode tool called, plan file:', planFilePath);
              return {
                type: 'exit_plan_mode',
                planFilePath
              };
            }

            return {
              type: 'tool_use',
              toolCall: {
                id: completedTool.id,
                name: completedTool.name,
                input: parsedInput,
                status: 'running',
                kind: toolKind(completedTool.name)
              }
            };
          }
          return null;
        }

        // Handle message lifecycle events
        if (nestedType === 'message_start') {
          claudeSession.hasStreamedText = false;
          return null;
        }

        // Handle message_delta - capture usage stats (usage is in delta, not stop)
        if (nestedType === 'message_delta') {
          const usage = nestedEvent.usage;
          if (usage) {
            claudeSession.lastUsageStats = {
              input_tokens: usage.input_tokens || 0,
              output_tokens: usage.output_tokens || 0,
              cache_creation_input_tokens: usage.cache_creation_input_tokens,
              cache_read_input_tokens: usage.cache_read_input_tokens
            };
            console.log('[Mysti] Claude: Captured usage from message_delta:', claudeSession.lastUsageStats);
          }
          return null;
        }

        // Handle message_stop - signal end of message
        // Usage is already cached from message_delta, will be retrieved by getStoredUsage()
        if (nestedType === 'message_stop') {
          return null; // Don't return done here - let sendMessage handle it
        }

        return null;
      }

      // Handle direct result event (final message)
      // For normal messages, text was already streamed via text_delta chunks — skip to avoid duplication.
      // For CLI internal commands like /compact, no text_delta events are emitted, so emit the result text.
      if (data.type === 'result') {
        if (proc && session.persistentProcess !== proc) { proc.stdin?.end(); }
        if (!claudeSession.hasStreamedText && data.result && typeof data.result === 'string') {
          return { type: 'text', content: data.result };
        }
        return null;
      }

      // Handle system events (session init, etc.)
      if (data.type === 'system') {
        if (data.subtype === 'init') {
          // The CLI tells us exactly which `/commands` this session has —
          // built-ins, bundled skills (`/design` and friends, which live inside
          // the binary and appear in NO directory), plugin commands and MCP
          // prompts. Mysti used to read `session_id` off this event and drop
          // the rest, which is why the slash menu could only ever show a
          // hard-coded guess that went stale with every CLI release.
          const reported = parseClaudeInitCommands(data.slash_commands, data.skills);
          if (reported) {
            claudeSession.reportedCommands = reported;
            console.log(`[Mysti] Claude: ${reported.length} native command(s) reported by the CLI`);
          }
          const sessionId = data.session_id || data.sessionId;
          if (sessionId && !session.sessionId) {
            session.sessionId = sessionId;
            console.log('[Mysti] Claude: Session ID extracted:', sessionId);
            return { type: 'session_active', sessionId };
          }
        }
        // Handle compact_boundary — emitted by CLI when /compact completes
        if (data.subtype === 'compact_boundary' && data.compact_metadata) {
          claudeSession.awaitingCompactSummary = true;
          const preTokens = data.compact_metadata.pre_tokens || 0;
          console.log(`[Mysti] Claude: Compact boundary - pre_tokens: ${preTokens}`);
          return { type: 'text', content: `Conversation compacted (was ~${Math.round(preTokens / 1000)}k tokens)` };
        }
        return null;
      }

      // Handle assistant complete message.
      // IMPORTANT: Do NOT emit tool_use from the 'assistant' event. The 'assistant' event
      // contains the full message (including tool_use with input) and arrives BEFORE
      // content_block_stop in the stream. content_block_stop already emits the authoritative
      // tool_use chunk from accumulated input_json_delta data. Emitting here too would
      // cause double-gating in the permission gate (two SIGSTOP/SIGCONT cycles per tool),
      // leading to "No response received from CLI" errors.
      if (data.type === 'assistant') {
        return null;
      }

      // Handle error events
      if (data.type === 'error') {
        return {
          type: 'error',
          content: data.error?.message || data.message || 'Unknown error'
        };
      }

      // Handle user events
      if (data.type === 'user' && data.message?.content) {
        // Capture compaction summary — a user message with string content after compact_boundary
        if (claudeSession.awaitingCompactSummary && typeof data.message.content === 'string') {
          const content = data.message.content;
          if (content.includes('session is being continued')) {
            claudeSession.awaitingCompactSummary = false;
            // Extract just the Summary section (skip the verbose Analysis section)
            const summaryIdx = content.indexOf('Summary:');
            const summaryText = summaryIdx >= 0 ? content.substring(summaryIdx) : content;
            return { type: 'text', content: summaryText };
          }
          return null; // skip "Compacted" echo and other noise
        }
        // Handle tool_result blocks (array content). A single `user` message can
        // carry MULTIPLE tool_result blocks (parallel tool calls) — returning
        // only the first silently dropped the siblings (Plan 18 4.5). Since
        // parseStreamLine returns exactly one chunk per call, the first result
        // is returned and the rest are queued on the session; the
        // processStream/_sendViaPersistentProcess wrappers drain the queue
        // right after each yielded chunk and again at end-of-stream.
        if (Array.isArray(data.message.content)) {
          const results: StreamChunk[] = [];
          for (const block of data.message.content) {
            if (block.type === 'tool_result') {
              results.push({
                type: 'tool_result',
                toolCall: {
                  id: block.tool_use_id || '',
                  name: '',
                  input: {},
                  output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
                  status: block.is_error ? 'failed' : 'completed'
                }
              });
            }
          }
          if (results.length > 0) {
            if (results.length > 1) {
              (claudeSession.pendingChunks ??= []).push(...results.slice(1));
            }
            return results[0];
          }
        }
      }

      // Handle direct tool_result events
      if (data.type === 'tool_result') {
        return {
          type: 'tool_result',
          toolCall: {
            id: data.tool_use_id || data.tool_id || '',
            name: data.tool_name || '',
            input: {},
            output: typeof data.content === 'string' ? data.content : JSON.stringify(data.content || ''),
            status: data.is_error ? 'failed' : 'completed'
          }
        };
      }

    } catch {
      // If it's not JSON, treat as plain text
      if (line.trim()) {
        return { type: 'text', content: line };
      }
    }

    return null;
  }

  /**
   * Drain chunks queued by parseStreamLine for lines that decoded to more than
   * one chunk (parallel tool_results — Plan 18 4.5).
   */
  private *_drainPendingChunks(session: ClaudeSessionState): Generator<StreamChunk> {
    const pending = session.pendingChunks;
    if (!pending) { return; }
    while (pending.length > 0) {
      yield pending.shift()!;
    }
  }

  /**
   * Single-shot stream wrapper: emit queued sibling chunks immediately after
   * each base-yielded chunk, and flush once more after the stream ends so
   * queued chunks are emitted even when no further lines arrive (Plan 18 4.5).
   */
  protected async *processStream(stderrRef: { output: string }, session: PanelSessionState): AsyncGenerator<StreamChunk> {
    const claudeSession = session as ClaudeSessionState;
    claudeSession.pendingChunks = []; // drop any stale leftovers from a cancelled run
    for await (const chunk of super.processStream(stderrRef, session)) {
      yield chunk;
      yield* this._drainPendingChunks(claudeSession);
    }
    yield* this._drainPendingChunks(claudeSession);
  }

  /**
   * Persistent-process stream wrapper — same pending-chunk drain contract as
   * the single-shot processStream override above (Plan 18 4.5).
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
    const claudeSession = session as ClaudeSessionState;
    claudeSession.pendingChunks = []; // drop any stale leftovers from a cancelled run
    for await (const chunk of super._sendViaPersistentProcess(
      content, context, settings, conversation, session, persona, agentConfig, attachments,
    )) {
      yield chunk;
      yield* this._drainPendingChunks(claudeSession);
    }
    yield* this._drainPendingChunks(claudeSession);
  }

  /**
   * Get stored usage stats from the last message and clear them
   * Called by sendMessage after stream processing to include in final done chunk
   */
  getStoredUsage(panelId?: string): { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | null {
    const session = this._getSession(panelId) as ClaudeSessionState;
    const usage = session.lastUsageStats;
    session.lastUsageStats = null;
    console.log('[Mysti] Claude: getStoredUsage returning:', usage);
    return usage;
  }

  /**
   * Override buildPromptAsync to append attachment file path references.
   * Claude Code CLI can read and analyze files when given file paths in the prompt.
   */
  protected async buildPromptAsync(
    content: string,
    context: ContextItem[],
    conversation: Conversation | null,
    settings: Settings,
    persona?: PersonaConfig,
    agentConfig?: AgentConfiguration,
    attachments?: Attachment[],
    _systemContext?: string
  ): Promise<string> {
    // Skip systemContext for Claude — it's injected as real system instructions via --append-system-prompt in buildCliArgs()
    let prompt = await super.buildPromptAsync(content, context, conversation, settings, persona, agentConfig, attachments, undefined);

    // Prepend attachment file references so Claude sees them first and uses its Read tool
    const imageAttachments = (attachments || []).filter(a => a.type === 'image' && a.filePath);
    const fileAttachments = (attachments || []).filter(a => a.type === 'file' && a.filePath);

    if (imageAttachments.length > 0 || fileAttachments.length > 0) {
      let attachmentSection = '[Attached Files — use your Read tool to view these files]\n';

      if (imageAttachments.length > 0) {
        for (const att of imageAttachments) {
          attachmentSection += `Image "${att.fileName}": ${att.filePath}\n`;
        }
      }

      if (fileAttachments.length > 0) {
        for (const att of fileAttachments) {
          attachmentSection += `File "${att.fileName}": ${att.filePath}\n`;
        }
      }

      attachmentSection += '\n';
      prompt = attachmentSection + prompt;
    }

    return prompt;
  }

  /**
   * Enhance a prompt using Claude
   */
  async enhancePrompt(prompt: string): Promise<string> {
    try { await this._verifyNativePermissionPolicy(); } catch { return prompt; }
    const { spawn } = await import('child_process');
    const claudePath = this.getCliPath();

    const enhancePrompt = `Please enhance the following prompt to be more specific and effective for a coding assistant. Return only the enhanced prompt without any explanation:

Original prompt: "${prompt}"

Enhanced prompt:`;

    return new Promise((resolve) => {
      // Enhancement has no panel approval owner. Native tools, hooks, skills,
      // and implicitly configured MCP servers therefore remain unavailable.
      const args = ['--print', '--output-format', 'text', '--tools=', '--permission-mode', 'dontAsk',
        '--settings', path.join(this._extensionContext.extensionPath, 'resources', 'claude-policy', 'settings.json'),
        '--setting-sources=', '--strict-mcp-config', '--disable-slash-commands', '--no-chrome'];

      const config = vscode.workspace.getConfiguration('mysti');
      const useShell = config.get<boolean>('useShellForCli', false);
      const proc = spawn(claudePath, args, {
        env: getEnrichedEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: useShell
      });

      let output = '';

      if (proc.stdin) {
        proc.stdin.write(enhancePrompt);
        proc.stdin.end();
      }

      proc.stdout?.on('data', (data) => {
        output += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0 && output.trim()) {
          resolve(output.trim());
        } else {
          resolve(prompt);
        }
      });

      proc.on('error', () => {
        resolve(prompt);
      });
    });
  }

  // Private helper methods

  private _findVSCodeExtensionCli(): string | null {
    const homeDir = os.homedir();
    const extensionsDir = path.join(homeDir, '.vscode', 'extensions');

    try {
      if (fs.existsSync(extensionsDir)) {
        const entries = fs.readdirSync(extensionsDir);
        const claudeExtensions = entries
          .filter(e => e.startsWith('anthropic.claude-code-'))
          .sort()
          .reverse();

        for (const ext of claudeExtensions) {
          const binaryPath = path.join(extensionsDir, ext, 'resources', 'native-binary', 'claude');
          if (fs.existsSync(binaryPath)) {
            console.log('[Mysti] Claude: Found CLI in VSCode extension:', binaryPath);
            return binaryPath;
          }
        }
      }
    } catch (error) {
      console.error('[Mysti] Claude: Error searching for CLI:', error);
    }

    return null;
  }

}
