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
import { spawn } from 'child_process';
import { BaseCliProvider, type PanelSessionState, type ProcessTracker } from '../base/BaseCliProvider';
import { allowsUnrestrictedNativeTools } from '../base/NativeApprovalPolicy';
import type {
  CliDiscoveryResult,
  AuthConfig,
  ProviderCapabilities,
  PersonaConfig
} from '../base/IProvider';
import type {
  Settings,
  StreamChunk,
  ProviderConfig,
  AuthStatus,
  ContextItem,
  Conversation,
  AgentConfiguration,
  ModelInfo
} from '../../types';
import { validateModelName } from '../../utils/validation';
import { getEnrichedEnv } from '../../utils/platform';
import { toolKind } from '../../utils/toolNames';
import { PROCESS_KILL_GRACE_PERIOD_MS } from '../../constants';
import { killProcessTree, isProcessLive } from '../../utils/processKill';
import { clampEffort } from '../../utils/effort';
import type { EffortLevel } from '../../types';

/** Copilot CLI `--effort` supports low→xhigh (no `max`; clamp down). */
const COPILOT_EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh'];

export interface CopilotSessionState extends PanelSessionState {
  activeToolCalls: Map<string, { id: string; name: string; input: Record<string, unknown> }>;
  lastUsageStats: { input_tokens: number; output_tokens: number } | null;
}

/**
 * GitHub Copilot CLI provider implementation
 * Supports copilot-cli for AI-powered code assistance with GitHub integration
 */
export class CopilotProvider extends BaseCliProvider {
  readonly id = 'github-copilot';
  readonly displayName = 'GitHub Copilot';

  readonly config: ProviderConfig = {
    name: 'github-copilot',
    displayName: 'GitHub Copilot',
    models: [
      {
        id: 'gpt-6-astra',
        name: 'GPT-6 Astra',
        description: 'OpenAI flagship — Copilot Pro+, Max, Business and Enterprise',
        contextWindow: 1050000,
        releasedAt: '2026-09-04'
      },
      {
        id: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        description: 'Best balance of speed and intelligence',
        contextWindow: 1000000
      },
      {
        id: 'claude-opus-5',
        name: 'Claude Opus 5',
        description: 'Anthropic flagship for complex agentic and coding work',
        contextWindow: 1000000
      },
      {
        id: 'claude-fable-5.1',
        name: 'Claude Fable 5.1',
        description: "Anthropic's most capable model",
        contextWindow: 1000000,
        releasedAt: '2026-09-01'
      },
      {
        id: 'claude-fable-5',
        name: 'Claude Fable 5',
        description: 'Previous Fable flagship',
        contextWindow: 1000000
      },
      {
        id: 'claude-opus-4.8',
        name: 'Claude Opus 4.8',
        description: 'Previous-generation Opus flagship',
        contextWindow: 1000000
      },
      {
        id: 'claude-opus-4.7',
        name: 'Claude Opus 4.7',
        description: 'Autonomous long-horizon Opus',
        contextWindow: 1000000
      },
      {
        id: 'claude-haiku-4.5',
        name: 'Claude Haiku 4.5',
        description: 'Fast and efficient for simpler tasks',
        contextWindow: 200000
      },
      {
        id: 'gemini-3.8-flash',
        name: 'Gemini 3.8 Flash',
        description: "Google's most intelligent Flash model",
        contextWindow: 1048576,
        releasedAt: '2026-09-02'
      },
      {
        id: 'gemini-3.7-flash',
        name: 'Gemini 3.7 Flash',
        description: 'Strong coding and agent workflows',
        contextWindow: 1048576
      },
      {
        id: 'gpt-5.1',
        name: 'GPT-5.1',
        description: 'Previous-generation OpenAI model',
        contextWindow: 400000
      },
      {
        id: 'gpt-4.1',
        name: 'GPT-4.1',
        description: 'Legacy model, included in all paid plans',
        contextWindow: 128000
      }
    ],
    defaultModel: 'claude-sonnet-5'
  };

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsThinking: false,
    // Flag/reality alignment (Plan 02 Phase 1): the Copilot CLI emits plain
    // text — no tool events ever fire, so no tool cards / permission gating.
    // True since Copilot CLI 1.0, whose `--output-format json` carries
    // tool.execution_start / tool.execution_complete. On 0.0.x the stream is
    // plain text and no tool_use chunk is ever produced, so this flag simply
    // describes a capability that stream cannot exercise.
    supportsToolUse: true,
    supportsSessions: true,
    supportsAutoInstall: true,
    supportsPromptEnhancement: false,
    // Plan 02 Phase 1 capability matrix
    thinkingStyle: 'none',
    thinkingLevelEffective: false,
    effortLevels: COPILOT_EFFORT_LEVELS,  // --effort (low→xhigh)
    effortDefault: 'medium',
    planMode: 'detected',
    sessionKind: 'prompt-history',  // fabricated --resume IDs (F4/B5) — honest value until Plan 00 Batch 2.4 lands
    emitsToolResults: true,         // 1.0 JSONL: tool.execution_complete carries the result
    // Copilot reports no honest token count on EITHER path: 1.0's JSONL carries
    // `session.usage_checkpoint`, which bills in nano AIU rather than tokens
    // (deliberately dropped in parseStreamLine), and 0.0.x streams plain text
    // with no usage event at all. Declaring true meant the context pie kept
    // whatever the previously-active provider had left in it.
    emitsUsage: false,
    usageConvention: 'none',   // Copilot bills in nano AIU; no token split exists to report.
    modelSelection: 'full'
  };

  protected _createSession(panelId: string): CopilotSessionState {
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

  async discoverCli(): Promise<CliDiscoveryResult> {
    return this._discoverCliCommon();
  }

  getCliPath(): string {
    return this._getCliPathCommon();
  }

  /**
   * Live model discovery (Plan 01 Phase 3). The Copilot CLI has no `list models`
   * subcommand, but `--model` is a CLOSED enum and its choices are printed in
   * `copilot --help`:
   *
   *   --model <model>   Set the AI model to use (choices:
   *                     "claude-sonnet-4.5", "claude-haiku-4.5", ..., "gpt-4.1")
   *
   * So the installed CLI is itself the authority on what it will accept — which
   * is the whole point of refreshing automatically: GitHub rotates this set, and
   * a bundled list goes stale the moment they do.
   *
   * The help text hard-wraps, so the output is whitespace-collapsed before
   * matching and only the quoted ids inside the choices parenthesis are taken.
   * Returns null on any failure (CLI absent, help text reworded, no choices
   * found) so the registry keeps its curated/cached list. Never throws.
   */
  async discoverModels(timeoutMs: number): Promise<ModelInfo[] | null> {
    const raw = await this._runCliForDiscovery(['--help'], timeoutMs);
    if (!raw) { return null; }

    // Collapse the hard-wrapped help block onto one line before matching.
    const flat = raw.replace(/\s+/g, ' ');
    const choices = /--model\b[^(]*\(choices:([^)]*)\)/.exec(flat);
    if (!choices) { return null; }

    const seen = new Set<string>();
    const models: ModelInfo[] = [];
    for (const match of choices[1].matchAll(/"([^"]+)"/g)) {
      const id = match[1].trim();
      if (!id || seen.has(id)) { continue; }
      seen.add(id);
      models.push({ id, name: id });
    }
    return models.length > 0 ? models : null;
  }

  protected _getCliCommandName(): string {
    return 'copilot';
  }

  protected _getConfiguredCliPath(): string {
    const config = vscode.workspace.getConfiguration('mysti');
    return config.get<string>('copilotPath', 'copilot');
  }

  /** Copilot CLI home (honors COPILOT_HOME; default ~/.copilot). */
  private _copilotHome(): string {
    return process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
  }

  /**
   * Persisted login identity for the `@github/copilot` CLI. The token lives in
   * the OS keychain; `/login` writes the signed-in identity into
   * ~/.copilot/config.json (`logged_in_users` / `last_logged_in_user`). The old
   * check looked at ~/.config/github-copilot — the OLD editor-plugin path, which
   * is absent for the agentic CLI, so a signed-in user was wrongly blocked.
   * Reads a non-empty identity marker (not mere file existence, which is created
   * pre-login with only banner/theme keys → would false-positive).
   */
  private _copilotLoginState(): { loggedIn: boolean; login?: string } {
    const home = this._copilotHome();
    for (const name of ['config.json', 'settings.json']) {
      const file = path.join(home, name);
      if (!fs.existsSync(file)) { continue; }
      try {
        const d = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
          logged_in_users?: Array<{ host?: string; login?: string }>;
          last_logged_in_user?: { host?: string; login?: string };
        };
        const users = Array.isArray(d.logged_in_users) ? d.logged_in_users : [];
        if (users.length > 0 || d.last_logged_in_user?.login) {
          return { loggedIn: true, login: d.last_logged_in_user?.login || users[0]?.login };
        }
      } catch {
        return { loggedIn: true }; // present but unreadable → lean authenticated (avoid false-negative)
      }
    }
    return { loggedIn: false };
  }

  async getAuthConfig(): Promise<AuthConfig> {
    // Check for GH_TOKEN or GITHUB_TOKEN environment variables (per official docs)
    const hasToken = !!(process.env.GH_TOKEN || process.env.GITHUB_TOKEN);
    const configPath = path.join(this._copilotHome(), 'config.json');
    const login = this._copilotLoginState();

    return {
      type: hasToken ? 'api-key' : 'oauth',
      isAuthenticated: hasToken || login.loggedIn,
      configPath
    };
  }

  async checkAuthentication(): Promise<AuthStatus> {
    // Check for GH_TOKEN or GITHUB_TOKEN environment variables (per official docs)
    if (process.env.GH_TOKEN) {
      return {
        authenticated: true,
        user: 'GitHub Token (GH_TOKEN)'
      };
    }

    if (process.env.GITHUB_TOKEN) {
      return {
        authenticated: true,
        user: 'GitHub Token (GITHUB_TOKEN)'
      };
    }

    // Signed-in via `copilot /login` (identity in ~/.copilot/config.json).
    const login = this._copilotLoginState();
    if (login.loggedIn) {
      return {
        authenticated: true,
        user: login.login ? `GitHub (${login.login})` : 'GitHub Account'
      };
    }

    return {
      authenticated: false,
      error: 'Not authenticated. Run "copilot" and use the /login command, or set GH_TOKEN/GITHUB_TOKEN environment variable.'
    };
  }

  getAuthCommand(): string {
    return 'copilot'; // Use /login command within the CLI
  }

  getInstallCommand(): string {
    return 'npm install -g @github/copilot';
  }

  /**
   * Override sendMessage to use -p flag instead of stdin
   * Copilot CLI uses -p "prompt" for programmatic (non-interactive) mode
   */
  async *sendMessage(
    content: string,
    context: ContextItem[],
    settings: Settings,
    conversation: Conversation | null,
    persona?: PersonaConfig,
    panelId?: string,
    providerManager?: unknown,
    agentConfig?: AgentConfiguration
  ): AsyncGenerator<StreamChunk> {
    const session = this._getSession(panelId) as CopilotSessionState;
    const startTime = Date.now();

    // Plan 18 (2.4 audit): the entire setup — prompt build and spawn — runs
    // INSIDE the try. Previously a synchronous spawn failure (Windows EINVAL
    // on a .cmd shim, Node >= 18.20) escaped the generator with no
    // handleError, no finally, and no cleanup: the provider was hard-broken
    // for every default npm Windows install.
    const stderrRef = { output: '' };
    // Declared outside the try — the finally detaches it during cleanup.
    const stderrHandler = (data: Buffer) => {
      const text = data.toString();
      stderrRef.output += text;
      console.log(`[Mysti] Copilot stderr:`, text);
    };
    try {
      const cliPath = this.getCliPath();

      // Get workspace folder for CWD
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const cwd = workspaceFolders ? workspaceFolders[0].uri.fsPath : process.cwd();

      // Build prompt first (needed for -p flag)
      const fullPrompt = await this.buildPromptAsync(
        content, context, conversation, settings, persona, agentConfig,
        undefined, session.channelSystemContext,
      );
      const promptTime = Date.now() - startTime;
      console.log(`[Mysti] Copilot: Prompt built in ${promptTime}ms`);

      // Build args with prompt using -p flag
      const args = this.buildCliArgs(settings, session);
      args.push('-p', fullPrompt);

      console.log(`[Mysti] Copilot: Spawning CLI with -p flag...`);

      session.process = spawn(cliPath, args, {
        cwd,
        env: getEnrichedEnv(),
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Plan 18 (2.4 audit): early error listener — an async spawn failure
      // (ENOENT on a stale path) otherwise emits an unhandled 'error' event
      // in the window before waitForProcess attaches its own listener.
      session.process.on('error', (err) => {
        console.error(`[Mysti] Copilot: Spawn error:`, err);
        stderrRef.output += `\nspawn error: ${err.message}`;
      });

      const spawnTime = Date.now() - startTime;
      console.log(`[Mysti] Copilot: CLI spawned in ${spawnTime}ms`);

      // Register process with ProviderManager for per-panel cancellation
      if (panelId && providerManager && typeof (providerManager as ProcessTracker).registerProcess === 'function') {
        (providerManager as ProcessTracker).registerProcess(panelId, session.process, this.id);
      }

      if (session.process.stderr) {
        session.process.stderr.on('data', stderrHandler);
      }
      console.log(`[Mysti] Copilot: ⏱️ TIMING BREAKDOWN:`);
      console.log(`  - Prompt build: ${promptTime}ms`);
      console.log(`  - CLI spawn: ${spawnTime - promptTime}ms`);
      console.log(`  - Total setup: ${spawnTime}ms`);
      console.log(`  - Waiting for first response...`);

      // Emit session_active so the webview shows the session indicator
      // Copilot CLI outputs plain text so its JSON init handler never fires
      if (!session.sessionId) {
        session.sessionId = `copilot-${panelId || 'default'}-${Date.now()}`;
      }
      yield { type: 'session_active' as const, sessionId: session.sessionId };

      // Process stream output (stderrRef is mutable, so processStream sees full stderr)
      yield* this.processStream(stderrRef, session);

      // Additional auth error check after stream processing
      if (stderrRef.output && this.isAuthenticationError(stderrRef.output)) {
        console.log(`[Mysti] Copilot: Auth error detected in stderr:`, stderrRef.output);
        yield {
          type: 'auth_error',
          content: stderrRef.output,
          authCommand: this.getAuthCommand(),
          providerName: this.displayName
        };
        return; // Don't yield done after auth error
      }

      // Yield final done with any stored usage
      const totalTime = Date.now() - startTime;
      console.log(`[Mysti] Copilot: ✅ Request completed in ${totalTime}ms`);

      const storedUsage = this.getStoredUsage(panelId);
      yield storedUsage ? { type: 'done', usage: storedUsage } : { type: 'done' };
    } catch (error) {
      yield this.handleError(error);
    } finally {
      // Clean up process — liveness-gated (not `.killed`): a SIGTERM'd-but-alive
      // CLI must still be escalated to SIGKILL, which the old `!killed` guard skipped.
      if (isProcessLive(session.process)) {
        try {
          // Remove only our stderr handler — don't strip waitForProcess listeners
          if (session.process!.stderr) {
            session.process!.stderr.removeListener('data', stderrHandler);
          }
          // SIGTERM with reliable SIGKILL escalation (timer cleared on exit).
          void killProcessTree(session.process, PROCESS_KILL_GRACE_PERIOD_MS, { label: this.displayName });
        } catch (e) {
          console.error(`[Mysti] Copilot: Error cleaning up process:`, e);
        }
      }

      session.process = null;

      // Clear process tracking
      if (panelId && providerManager && typeof (providerManager as ProcessTracker).clearProcess === 'function') {
        (providerManager as ProcessTracker).clearProcess(panelId);
      }
    }
  }

  /**
   * True when the installed Copilot CLI emits the structured JSON stream.
   *
   * Added in 1.0; the 0.0.x line has no `--output-format` at all and passing it
   * aborts the run. When the version could not be probed, assume the CURRENT
   * CLI — 0.0.x predates the 1.0 release by a long way, and guessing old would
   * leave every current install on the plain-text path with no permission gate.
   */
  private _supportsJsonOutput(): boolean {
    const major = this._getCliMajorVersion();
    return major === null || major >= 1;
  }

  protected buildCliArgs(settings: Settings, session: PanelSessionState): string[] {
    // Note: Copilot CLI uses -p flag for prompt (set in sendMessage override).
    //
    // Copilot CLI 1.0 added `--output-format json` (JSONL, one object per line)
    // — the 0.0.x line had none, which is why this provider used to scrape
    // plain text. The structured stream is what finally gives Mysti tool
    // events, and therefore a working permission gate; see _addPermissionFlags.
    const args: string[] = [];
    if (this._supportsJsonOutput()) {
      args.push('--output-format', 'json');
    }

    // Add model selection (custom model override or dropdown selection)
    const effectiveModel = this._getEffectiveModel(settings);
    if (effectiveModel) {
      args.push('--model', effectiveModel);
    }

    // Reasoning effort → --effort (Copilot tops out at xhigh; max clamps down).
    const effort = clampEffort(settings.effortLevel, COPILOT_EFFORT_LEVELS);
    if (effort) {
      args.push('--effort', effort);
    }

    // Map Mysti modes/access levels to Copilot CLI flags
    this._addPermissionFlags(args, settings);

    // Session handling - Copilot supports --resume
    if (session.sessionId) {
      args.push('--resume', session.sessionId);
      console.log('[Mysti] Copilot: Resuming session:', session.sessionId);
    }

    console.log('[Mysti] Copilot: Built CLI args:', args.join(' '));
    return args;
  }

  /**
   * Get the effective model, preferring provider-specific custom model over dropdown selection
   */
  protected _getEffectiveModel(settings: Settings): string | undefined {
    // P2.3/P0.2b: an explicitly routed model wins over the per-provider custom-model config.
    if (settings.routedModel) { return settings.routedModel; }
    const config = vscode.workspace.getConfiguration('mysti');
    const customModel = config.get<string>('copilotModel', '');
    if (customModel) {
      const validation = validateModelName(customModel);
      if (validation.valid) {
        console.log(`[Mysti] Copilot: Using custom model: ${customModel}`);
        return customModel;
      }
      console.warn(`[Mysti] Copilot: Invalid custom model "${customModel}": ${validation.error}`);
    }
    return settings.model || undefined;
  }

  /**
   * Copilot may not support thinking tokens
   * Returns undefined to indicate no thinking token support
   */
  protected getThinkingTokens(_thinkingLevel: string): number | undefined {
    return undefined;
  }

  /**
   * Add permission flags based on mode and access level
   * Per official docs:
   * - --allow-all-tools: allows any tool without approval
   * - --deny-tool 'shell': denies shell commands
   * - --deny-tool 'write': denies file modification tools
   */
  private _addPermissionFlags(args: string[], settings: Settings): void {
    const { mode, accessLevel } = settings;

    // Plan modes or read-only → deny shell and write tools
    if (mode === 'quick-plan' || mode === 'detailed-plan' || accessLevel === 'read-only') {
      args.push('--deny-tool', 'shell');
      args.push('--deny-tool', 'write');
      console.log('[Mysti] Copilot: Using read-only mode (deny shell and write)');
      return;
    }

    // Fully autonomous policy is independent of stream format. Auto-edit is
    // not full autonomy: commands/deletes/network still require approval.
    const gateIntentionallyOff = allowsUnrestrictedNativeTools(settings);

    if (gateIntentionallyOff) {
      args.push('--allow-all-tools');
      console.log(`[Mysti] Copilot: Using auto-approve mode [mode=${mode}, access=${accessLevel}]`);
      return;
    }

    // Ask-tier combinations (ask-before-edit mode, or ask-permission access).
    //
    // Copilot 1.0+ retains the stream-event pause path. These notifications
    // carry no blocking native permission response; a pause cannot guarantee
    // that the tool has not already executed. Native approval needs an ACP
    // request/response bridge before this path can provide that guarantee.
    if (this._supportsJsonOutput()) {
      args.push('--allow-all-tools');
      console.log(`[Mysti] Copilot: Ask-tier gated by Mysti's stream gate [mode=${mode}, access=${accessLevel}]`);
      return;
    }

    // Copilot 0.0.x emits plain text with no tool events, so there is nothing
    // to gate on and no way to prompt. Fail closed rather than silently running
    // shell commands and file writes under --allow-all-tools.
    args.push('--deny-tool', 'shell');
    args.push('--deny-tool', 'write');
    console.log(`[Mysti] Copilot: Ask-tier permissions cannot be prompted on this CLI (plain-text output) — denying shell/write tools (fail closed) [mode=${mode}, access=${accessLevel}]`);
  }

  /**
   * Copilot CLI 1.0 stream events.
   *
   * Returns `undefined` for an event this vocabulary does not cover, so the
   * caller falls through to the older shapes; `null` means "handled, nothing to
   * render". The two are NOT interchangeable here.
   */
  private _parseModernEvent(
    data: Record<string, unknown>,
    session: CopilotSessionState
  ): StreamChunk | null | undefined {
    const type = typeof data.type === 'string' ? data.type : '';
    if (!type.includes('.')) {
      return undefined;
    }
    const payload = (data.data ?? {}) as Record<string, unknown>;

    switch (type) {
      // The delta. `assistant.message` repeats the whole answer afterwards, so
      // rendering both would print it twice.
      case 'assistant.message_delta': {
        const delta = payload.deltaContent;
        return typeof delta === 'string' && delta ? { type: 'text', content: delta } : null;
      }

      case 'tool.execution_start': {
        const id = String(payload.toolCallId ?? `copilot-${Date.now()}`);
        const name = String(payload.toolName ?? 'tool');
        const input = (payload.arguments ?? {}) as Record<string, unknown>;
        session.activeToolCalls.set(id, { id, name, input });
        // This is what Mysti's permission gate intercepts. Copilot had no such
        // event before 1.0, which is why the gate could never fire for it.
        return { type: 'tool_use', toolCall: { id, name, input, status: 'running' } };
      }

      case 'tool.execution_complete': {
        const id = String(payload.toolCallId ?? '');
        const active = session.activeToolCalls.get(id);
        session.activeToolCalls.delete(id);
        const result = (payload.result ?? {}) as Record<string, unknown>;
        const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content ?? '');
        return {
          type: 'tool_result',
          toolCall: {
            id,
            name: active?.name ?? String(payload.toolName ?? 'tool'),
            input: active?.input ?? {},
            output: content,
            status: payload.success === false ? 'failed' : 'completed',
          },
        };
      }

      case 'session.usage_checkpoint': {
        // Copilot bills in "nano AIU" rather than tokens; there is no honest
        // token count to report, so nothing is stored and nothing is rendered.
        return null;
      }

      // Streamed piecemeal by assistant.tool_call_delta and delivered whole by
      // tool.execution_start — the partial JSON fragments are not renderable.
      case 'assistant.tool_call_delta':
      case 'tool.execution_partial_result':
      case 'assistant.message':
      case 'assistant.message_start':
      case 'assistant.turn_start':
      case 'assistant.turn_end':
      case 'assistant.idle':
      case 'model.call_start':
      case 'model.call_finished':
      case 'user.message':
      case 'session.tools_updated':
      case 'session.auto_mode_resolved':
      case 'session.mcp_servers_loaded':
      case 'session.mcp_server_status_changed':
      case 'session.background_tasks_changed':
        return null;

      default:
        // An unrecognised dotted event is still Copilot 1.0 telemetry, not text
        // to print at the user.
        return null;
    }
  }

  /**
   * Parse Copilot CLI output
   * The CLI outputs plain text, not JSON streaming format
   * This parses line-by-line text output from the CLI and converts
   * terminal UI elements to proper markdown formatting
   */
  protected parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
    const copilotSession = session as CopilotSessionState;

    // Skip empty lines
    if (!line.trim()) {
      return null;
    }

    // Try to parse as JSON first (in case Copilot CLI adds JSON support in future)
    try {
      const data = JSON.parse(line);

      // Copilot CLI 1.0 JSONL. Captured from 1.0.83:
      //   {"type":"assistant.message_delta","data":{"deltaContent":"Okay"}}
      //   {"type":"tool.execution_start","data":{"toolCallId":"call_…","toolName":"bash",
      //                                          "arguments":{"command":"ls"}}}
      //   {"type":"tool.execution_complete","data":{"toolCallId":"call_…","success":true,
      //                                             "result":{"content":"…"}}}
      //   {"type":"session.usage_checkpoint","data":{…}}
      const modern = this._parseModernEvent(data, copilotSession);
      if (modern !== undefined) {
        return modern;
      }

      // Handle JSON events if they exist
      switch (data.type) {
        case 'init':
          if (data.session_id && !session.sessionId) {
            session.sessionId = data.session_id;
            console.log('[Mysti] Copilot: Session ID:', data.session_id);
            return { type: 'session_active', sessionId: data.session_id };
          }
          return null;

        case 'message':
          if (data.role === 'assistant' && data.content) {
            return { type: 'text', content: data.content };
          }
          return null;

        case 'tool_use': {
          const toolNameCopilot = data.tool_name || '';
          const paramsCopilot = data.parameters || {};

          // Detect ask_user-style tools and convert to ask_user_question chunk
          if ((toolNameCopilot === 'ask_user' || toolNameCopilot === 'AskUserQuestion' || toolNameCopilot === 'ask_user_question') &&
              paramsCopilot.questions && Array.isArray(paramsCopilot.questions)) {
            console.log('[Mysti] Copilot: Detected ask_user tool, converting to ask_user_question chunk');
            return {
              type: 'ask_user_question',
              askUserQuestion: {
                toolCallId: data.tool_id,
                questions: (paramsCopilot.questions as Array<Record<string, unknown>>).map((q: Record<string, unknown>) => ({
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

          copilotSession.activeToolCalls.set(data.tool_id, {
            id: data.tool_id,
            name: toolNameCopilot,
            input: paramsCopilot
          });
          return {
            type: 'tool_use',
            toolCall: {
              id: data.tool_id,
              name: toolNameCopilot,
              input: paramsCopilot,
              status: 'running',
              kind: toolKind(toolNameCopilot)
            }
          };
        }

        case 'tool_result': {
          const toolInfo = copilotSession.activeToolCalls.get(data.tool_id);
          copilotSession.activeToolCalls.delete(data.tool_id);
          return {
            type: 'tool_result',
            toolCall: {
              id: data.tool_id,
              name: toolInfo?.name || '',
              input: toolInfo?.input || {},
              output: data.output || '',
              status: data.status === 'success' ? 'completed' : 'failed'
            }
          };
        }

        case 'error':
          return {
            type: 'error',
            content: data.message || data.error || 'Unknown error'
          };

        case 'result':
          if (data.stats) {
            copilotSession.lastUsageStats = {
              // NOT `|| data.stats.total_tokens`: total includes the completion,
              // so the old fallback booked output tokens as context fill.
              input_tokens: Number(data.stats.input_tokens ?? 0),
              output_tokens: Number(data.stats.output_tokens ?? 0)
            };
            console.log('[Mysti] Copilot: Captured usage stats:', copilotSession.lastUsageStats);
          }
          return null;

        default:
          // Unknown JSON type, log and return as text
          console.log('[Mysti] Copilot: Unknown JSON event:', data.type);
          return { type: 'text', content: line };
      }
    } catch {
      // Not JSON - this is the expected case for Copilot CLI plain text output
      // Format terminal UI elements to markdown
      const formattedContent = this._formatTerminalOutput(line);
      return { type: 'text', content: formattedContent };
    }
  }

  /**
   * Convert Copilot CLI terminal-style output to proper markdown
   * Handles patterns like:
   * - "✓ Tool description" → Tool completed marker
   * - "$ command" → Shell command
   * - "└ result" → Result summary
   */
  private _formatTerminalOutput(line: string): string {
    const trimmed = line.trim();

    // Tool completion: "✓ Description" → Keep as is (already looks nice)
    if (trimmed.startsWith('✓')) {
      return '\n' + line + '\n';
    }

    // Shell command preview: "$ command" → Format as inline code
    if (trimmed.startsWith('$')) {
      return '\n`' + trimmed + '`\n';
    }

    // Result summary: "└ result" → Format with indentation
    if (trimmed.startsWith('└') || trimmed.startsWith('   └')) {
      return '  ' + line + '\n';
    }

    // Regular content - add newline for paragraph separation
    return line + '\n';
  }

  /**
   * Get stored usage stats from the last message and clear them
   */
  getStoredUsage(panelId?: string): { input_tokens: number; output_tokens: number } | null {
    const session = this._getSession(panelId) as CopilotSessionState;
    const usage = session.lastUsageStats;
    session.lastUsageStats = null;
    return usage;
  }

  /**
   * Clear session and reset state
   */
  clearSession(panelId?: string): void {
    super.clearSession(panelId);
    if (panelId) {
      const session = this._panelSessions.get(panelId) as CopilotSessionState | undefined;
      if (session) {
        session.activeToolCalls.clear();
        session.lastUsageStats = null;
      }
    }
  }

}
