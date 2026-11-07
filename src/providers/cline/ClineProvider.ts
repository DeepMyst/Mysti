/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * Portions copyright (c) 2025 MostlyK
 *
 * Author: MostlyK <bruvistrue93@gmail.com>
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn, type ChildProcess } from "child_process";
import { BaseCliProvider, type PanelSessionState, type ProcessTracker } from "../base/BaseCliProvider";
import { assertNonInteractivePermissionSupport } from "../base/NativeApprovalPolicy";
import type {
	CliDiscoveryResult,
	AuthConfig,
	ProviderCapabilities,
	ProviderInputResolver,
} from "../base/IProvider";
import type {
	Settings,
	StreamChunk,
	ProviderConfig,
	AuthStatus,
	ContextItem,
	Conversation,
	SlashCommandDefinition,
	AgentConfiguration,
	Attachment,
	ToolCall,
	UsageStats,
} from "../../types";
import { PROCESS_KILL_GRACE_PERIOD_MS } from "../../constants";
import { killProcessTree, isProcessLive, markOwnedProcessGroup } from "../../utils/processKill";
import { getEnrichedEnv } from "../../utils/platform";
import { toolKind } from "../../utils/toolNames";
import { isRecord } from "../../utils/valueGuards";
import { validateModelName } from "../../utils/validation";
import { addUsage, hasUsageSignal, normalizeUsage } from "../../services/TokenAccounting";

function toolStatus(value: unknown, fallback: ToolCall['status']): ToolCall['status'] {
	return value === "pending" || value === "running" || value === "completed" || value === "failed"
		? value : fallback;
}

/**
 * Extended per-panel session state for Cline-specific fields.
 */
interface ClineSessionState extends PanelSessionState {
	activeToolCalls: Map<string, { id: string; name: string; inputJson: string }>;
	completedToolCalls: Set<string>;
	lastUsageStats: UsageStats | null;
	/** Modern totals and latest-call context are different measurements. */
	lastContextUsageStats?: UsageStats | null;
	/** done and run_result can repeat the same terminal failure. */
	terminalFailureReported?: boolean;
	lastUserInput: string;
	askReceived: boolean;
	jsonBuffer: string[];
}

/**
 * Cline CLI provider implementation
 *
 * Cline is an AI coding assistant that can use the CLI and editor.
 * This provider integrates Cline into the Mysti multi-agent framework.
 *
 * Note: Cline is primarily distributed as a VSCode extension. The CLI path
 * should point to the Cline extension's binary or a standalone installation.
 */
export class ClineProvider extends BaseCliProvider {
	readonly id = "cline";
	readonly displayName = "Cline";
	private readonly _clineRequests = new Map<string, AbortController>();
	private readonly _timedOutProcesses = new WeakSet<ChildProcess>();

	readonly config: ProviderConfig = {
		name: "cline",
		displayName: "Cline",
		models: [
			// Popular models (via OpenRouter). Ids and windows checked against
			// OpenRouter's live /api/v1/models (2026-09-25), which Cline's bundled
			// catalog mirrors; Cline sizes a turn as maxInputTokens ?? contextWindow.
			{
				id: "anthropic/claude-sonnet-4.5",
				name: "Claude Sonnet 4.5",
				description: "Best balance of speed, cost, and quality",
				contextWindow: 1000000,
			},
			{
				id: "anthropic/claude-opus-4.6",
				name: "Claude Opus 4.6",
				description: "Most intelligent model for agents and coding",
				contextWindow: 1000000,
			},
			{
				id: "deepseek/deepseek-chat",
				name: "DeepSeek V3",
				description: "Strong open-source coding model",
				contextWindow: 163840,
			},
			{
				id: "deepseek/deepseek-r1",
				name: "DeepSeek R1",
				description: "Reasoning-focused open-source model",
				contextWindow: 64000,
			},
			{
				id: "kwaipilot/kat-coder-pro",
				name: "KAT Coder Pro",
				description: "KwaiKAT's advanced agentic coding model",
				contextWindow: 256000,
			},
			{
				id: "minimax/minimax-m2.5",
				name: "MiniMax M2.5",
				description: "Great coding capability and subagent use",
				contextWindow: 204800,
			},
			{
				id: "qwen/qwen3-coder",
				name: "Qwen3 Coder",
				description: "Qwen's specialized coding model (480B A35B)",
				contextWindow: 262144,
			},
			{
				id: "mistralai/codestral-2508",
				name: "Codestral",
				description: "Mistral's specialized coding model",
				contextWindow: 256000,
			},
			{
				id: "arcee-ai/trinity-large-preview",
				name: "Trinity Large",
				description: "Arcee AI's model optimized for agent harnesses",
				contextWindow: 128000,
			},
		],
		defaultModel: "deepseek/deepseek-chat",
	};

	get capabilities(): ProviderCapabilities {
		const legacy = (this._getCliMajorVersion() ?? 2) < 2;
		return {
			supportsAskPermission: false,
			supportsReadOnly: legacy,
			supportsStreaming: true,
			supportsThinking: true,
			supportsToolUse: true,
			supportsSessions: true,
			supportsAutoInstall: true,
			// No qualified tool-free enhancement transport: the ordinary CLI starts
			// an agent, and the former legacy text flags fail on modern Cline.
			supportsPromptEnhancement: false,
			// Plan 02 Phase 1 capability matrix
			thinkingStyle: 'complete-blocks',  // say:"reasoning" blocks arrive whole
			thinkingLevelEffective: false,     // reasoning is emitted, but this adapter sends no level/budget control
			planMode: legacy ? 'detected' : 'none',
			// Modern Cline runs only in full access (--auto-approve); other tiers are refused.
			...(legacy ? {} : { nativeModes: { approvals: true } }),
			sessionKind: 'prompt-history',     // no actual resume — history replayed into the prompt
			emitsToolResults: true,
			emitsUsage: true,
			// Legacy usage follows the vendor; modern Cline is normalized at parsing.
			usageConvention: 'auto',
			// Match the argument builder: 1.x has no model override; modern Cline
			// accepts IDs for the account's configured backend, not a universal catalog.
			modelSelection: (this._getCliMajorVersion() ?? 2) < 2 ? 'none' : 'custom-only',
		};
	}

	// ============================================================================
	// Slash command menu: Cline-specific commands
	// ============================================================================

	public override getSlashCommands(_panelId?: string): SlashCommandDefinition[] {
		// Plan/act used to be declared here as well as in the provider-native
		// catalog, which put two differently-labelled rows in the menu doing the
		// same thing. NATIVE_COMMANDS['cline'] owns `/plan-act` and routes it to
		// the `cline:plan-act` handler this file's toggle always used.
		return super.getSlashCommands(_panelId);
	}

	/**
	 * Create a new Cline session with provider-specific fields.
	 */
	protected _createSession(panelId: string): ClineSessionState {
		return {
			...super._createSession(panelId),
			activeToolCalls: new Map(),
			completedToolCalls: new Set(),
			lastUsageStats: null,
			lastUserInput: "",
			askReceived: false,
			jsonBuffer: [],
		};
	}

	/**
	 * Override clearSession to clear all Cline-specific state
	 */
	clearSession(panelId?: string): void {
		this._abortClineRequests(panelId);
		super.clearSession(panelId);

		if (panelId) {
			const session = this._panelSessions.get(panelId) as ClineSessionState | undefined;
			if (session) {
				session.activeToolCalls.clear();
				session.completedToolCalls.clear();
				session.lastUsageStats = null;
				session.lastContextUsageStats = undefined;
				session.terminalFailureReported = false;
				session.lastUserInput = "";
				session.askReceived = false;
				session.jsonBuffer = [];
			}
		} else {
			for (const session of this._panelSessions.values()) {
				const clineSession = session as ClineSessionState;
				clineSession.activeToolCalls.clear();
				clineSession.completedToolCalls.clear();
				clineSession.lastUsageStats = null;
				clineSession.lastContextUsageStats = undefined;
				clineSession.terminalFailureReported = false;
				clineSession.lastUserInput = "";
				clineSession.askReceived = false;
				clineSession.jsonBuffer = [];
			}
		}
	}

	private _abortClineRequests(panelId?: string): void {
		if (panelId) { this._clineRequests.get(panelId)?.abort(); }
		else { for (const controller of this._clineRequests.values()) { controller.abort(); } }
	}

	protected override _prepareTimeoutCleanup(proc: ChildProcess, session: PanelSessionState): 'SIGTERM' | null {
		const alreadyStarted = session.cancelled || this._timedOutProcesses.has(proc);
		this._timedOutProcesses.add(proc);
		// Timeout still emits error/done. Only transfer process cleanup so Stop,
		// replacement, an earlier ask and finally cannot send another TERM.
		if (session.process === proc) { session.process = null; }
		return alreadyStarted ? null : 'SIGTERM';
	}

	override cancelCurrentRequest(panelId?: string): void {
		this._abortClineRequests(panelId);
		super.cancelCurrentRequest(panelId);
	}

	override dispose(): void {
		this._abortClineRequests();
		super.dispose();
	}

	async discoverCli(): Promise<CliDiscoveryResult> {
		return this._discoverCliCommon();
	}

	// Modern Cline checks for updates even before parsing --version, then can
	// launch a detached global package update on exit. Keep managed invocations
	// stable without changing the user's native settings or explicit update flow.
	protected override getExtraProbeEnv(): Record<string, string> {
		return { CLINE_NO_AUTO_UPDATE: '1' };
	}

	protected override getExtraSpawnEnv(_settings: Settings): Record<string, string> {
		return { CLINE_NO_AUTO_UPDATE: '1' };
	}

	getCliPath(): string {
		return this._getCliPathCommon();
	}

	protected _getCliCommandName(): string {
		return 'cline';
	}

	protected _getConfiguredCliPath(): string {
		const config = vscode.workspace.getConfiguration("mysti");
		return config.get<string>("clinePath", "cline");
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
		const config = vscode.workspace.getConfiguration("cline");
		const apiKey = config.get<string>("apiKey", "");

		return {
			type: "api-key",
			isAuthenticated: !!apiKey,
			configPath: "", // Cline stores keys in VSCode settings
		};
	}

	async checkAuthentication(): Promise<AuthStatus> {
		// `cline auth` persists credentials into the data dir (default ~/.cline/data,
		// relocatable via CLINE_DATA_DIR): secrets.json (API keys / OAuth tokens) and
		// settings/providers.json (per-provider apiKey + OAuth tokenSource). The old
		// check keyed on mere data-dir EXISTENCE, which is created on first run before
		// any login (false-positive) and ignored CLINE_DATA_DIR (false-negative on a
		// relocated dir). Check the real creds instead.
		const dataDir = (process.env.CLINE_DATA_DIR || '').trim() || path.join(os.homedir(), '.cline', 'data');

		// 1) secrets.json — API keys / OAuth tokens (openRouterApiKey, clineAccountId, …)
		try {
			const p = path.join(dataDir, 'secrets.json');
			if (fs.existsSync(p)) {
				const raw = fs.readFileSync(p, 'utf-8').trim();
				if (raw && raw !== '{}') {
					const s = JSON.parse(raw) as Record<string, unknown>;
					if (Object.values(s).some(v => typeof v === 'string' && v.length > 0)) {
						return { authenticated: true, user: 'Cline CLI' };
					}
				}
			}
		} catch { /* fall through */ }

		// 2) settings/providers.json — a provider with an apiKey OR an OAuth tokenSource
		try {
			const p = path.join(dataDir, 'settings', 'providers.json');
			if (fs.existsSync(p)) {
				const raw = fs.readFileSync(p, 'utf-8').trim();
				if (raw) {
					const providers = (JSON.parse(raw) as { providers?: Record<string, { settings?: { apiKey?: string }; tokenSource?: unknown }> }).providers ?? {};
					const ok = Object.values(providers).some(pr => {
						const key = pr?.settings?.apiKey;
						return (typeof key === 'string' && key.length > 0) || !!pr?.tokenSource;
					});
					if (ok) { return { authenticated: true, user: 'Cline CLI' }; }
				}
			}
		} catch { /* fall through */ }

		// 3) env-var auth (Cline standalone mode reads provider keys from the env)
		if (['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'CLINE_API_KEY']
			.some(k => (process.env[k] || '').trim().length > 0)) {
			return { authenticated: true, user: 'Cline CLI (env)' };
		}

		// 4) Fallback: the Cline VSCode extension's apiKey setting
		const auth = await this.getAuthConfig();
		if (auth.isAuthenticated) {
			return { authenticated: true };
		}

		return {
			authenticated: false,
			error: 'Not authenticated. Run "cline auth" in your terminal to configure a provider.'
		};
	}

	getAuthCommand(): string {
		return "cline auth";
	}

	getInstallCommand(): string {
		return "npm install -g cline";
	}

	protected buildCliArgs(settings: Settings, _session: PanelSessionState): string[] {
		// Cline 2.0 renamed every flag Mysti used. On 3.0.61 the old invocation
		// dies immediately with `error: unknown option '--output-format'`, so the
		// provider was completely non-functional against a current CLI:
		//
		//   1.x                      2.x+
		//   --output-format json     --json
		//   --mode plan | --mode act -p/--plan   (act is the default)
		//   --yolo                   --auto-approve <boolean>
		//
		// The major version comes from the `--version` probe discovery now runs.
		// When it is unknown, assume the CURRENT CLI — an unknown version is far
		// more likely to be a new release this table has not seen than a 1.x from
		// before the rename.
		const major = this._getCliMajorVersion();
		const legacy = major !== null && major < 2;

		const args: string[] = legacy ? ["--output-format", "json"] : ["--json"];

		// Do NOT connect to the VSCode Cline extension's Core instance.
		// Its auth config is separate from CLI auth (configured via "cline auth").
		// Let the CLI start its own Core so it uses the CLI-configured provider/key.

		// Only add --verbose when debug mode is explicitly enabled
		if (
			vscode.workspace.getConfiguration("mysti").get<boolean>("debugVerbose", false)
		) {
			args.push("--verbose");
		}

		// Preserve legacy mode mapping. Modern headless CLI approval is not a
		// usable read-only boundary: hub rejects noninteractive approval, while
		// the local desktop callback lacks its session ID until the turn ends.
		const { mode, accessLevel } = settings;
		assertNonInteractivePermissionSupport(this.displayName, settings);
		const planMode =
			mode === "quick-plan" ||
			mode === "detailed-plan" ||
			accessLevel === "read-only";
		if (planMode && !legacy) {
			const version = /\d{1,6}\.\d{1,6}\.\d{1,6}/.exec(this._cachedCliVersion ?? '')?.[0];
			throw new Error(`Cline${version ? ` ${version}` : ''} cannot use Plan or Read Only safely through this CLI connection. Choose another provider for this mode.`);
		}

		if (planMode) {
			args.push("--mode", "plan");
			console.log("[Mysti] Cline: Using plan mode (read-only)");
		} else if (legacy) {
			// 2.x+ has no act flag — act IS the default.
			args.push("--mode", "act");
			console.log("[Mysti] Cline: Using act mode");
		}

		// Auto-approval is reserved for explicitly unrestricted authority. The
		// CLI's tool notifications provide no blocking native approval response.
		if (!planMode) {
			args.push(...(legacy ? ["--yolo"] : ["--auto-approve", "true"]));
			console.log(
				`[Mysti] Cline: explicitly unrestricted tools [mode=${mode}, access=${accessLevel}]`,
			);
		}

		// 2.x+ gained a real per-session model flag; 1.x had none (-m was the short
		// form of --mode), so the model stayed a global `cline auth` setting there.
		if (!legacy) {
			const effectiveModel = this._getEffectiveModel(settings);
			if (effectiveModel) {
				args.push("--model", effectiveModel);
			}
		}

		return args;
	}

	protected override _getEffectiveModel(settings: Settings): string | undefined {
		const major = this._getCliMajorVersion();
		// Cline 1.x has no per-request model flag. Do not claim the configured
		// or routed selection is used by that older CLI.
		if (major !== null && major < 2) { return undefined; }
		if (settings.routedModel) { return settings.routedModel; }
		const custom = vscode.workspace.getConfiguration("mysti").get<string>("clineModel", "");
		if (custom && validateModelName(custom).valid) { return custom; }
		return settings.model || undefined;
	}

	/**
	 * Get thinking tokens based on thinking level
	 */
	protected getThinkingTokens(thinkingLevel: string): number | undefined {
		const tokenMap: Record<string, number> = {
			none: 0,
			low: 4000,
			medium: 8000,
			high: 16000,
		};
		return tokenMap[thinkingLevel];
	}

	/**
	 * Parse stream line from Cline CLI output
	 * Cline outputs pretty-printed JSON (multi-line), so we need to buffer
	 */
	protected parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
		const clineSession = session as ClineSessionState;

		if (!line.trim()) {
			return null;
		}

		const trimmed = line.trim();

		// Skip startup noise
		if (
			trimmed.startsWith("[DEBUG]") ||
			trimmed.startsWith("[updater]") ||
			trimmed.startsWith("Starting new Cline") ||
			trimmed.startsWith("Starting cline-") ||
			trimmed.startsWith("Logging cline-") ||
			trimmed.startsWith("Looking for cline-") ||
			trimmed.startsWith("Executable path:") ||
			trimmed.startsWith("Bin directory:") ||
			trimmed.startsWith("Install directory:") ||
			trimmed.startsWith("Using production mode") ||
			trimmed.startsWith("Using system node") ||
			trimmed.startsWith("NODE_PATH set to:") ||
			trimmed.startsWith("Started cline-") ||
			trimmed.startsWith("Waiting for services") ||
			trimmed.startsWith("Services started") ||
			trimmed.startsWith("Started instance at") ||
			trimmed.startsWith("Mode set to:") ||
			trimmed.startsWith("Task created") ||
			trimmed.startsWith("Using instance:") ||
			trimmed.startsWith("Press Ctrl+C") ||
			trimmed.startsWith("Conversation history") ||
			trimmed === "**" ||
			(trimmed.includes("ports") && trimmed.includes("core"))
		) {
			return null;
		}

		// Start of JSON object
		if (trimmed.startsWith("{")) {
			clineSession.jsonBuffer = [trimmed];
			// Check if this single line is a complete JSON object
			if (this._isJsonComplete(trimmed)) {
				try {
					const data = JSON.parse(trimmed);
					clineSession.jsonBuffer = [];
					return this._handleParsedMessage(data, clineSession);
				} catch {
					// Not valid JSON despite balanced braces, continue buffering
					return null;
				}
			}
			return null;
		}

		// Middle/end of JSON object
		if (clineSession.jsonBuffer.length > 0) {
			clineSession.jsonBuffer.push(trimmed);

			const fullJson = clineSession.jsonBuffer.join("");

			// Use brace-depth tracking to detect complete JSON objects
			if (!this._isJsonComplete(fullJson)) {
				return null;
			}

			try {
				const data = JSON.parse(fullJson);
				clineSession.jsonBuffer = [];
				return this._handleParsedMessage(data, clineSession);
			} catch {
				// JSON not yet complete despite balanced braces, continue buffering
				return null;
			}
		}

		return null;
	}

	/**
	 * Check if a JSON string has balanced braces (outside of string literals).
	 * Returns true when brace depth returns to zero.
	 */
	private _isJsonComplete(json: string): boolean {
		let depth = 0;
		let inString = false;
		let escape = false;

		for (const ch of json) {
			if (escape) {
				escape = false;
				continue;
			}
			if (ch === '\\' && inString) {
				escape = true;
				continue;
			}
			if (ch === '"') {
				inString = !inString;
				continue;
			}
			if (!inString) {
				if (ch === '{') { depth++; }
				else if (ch === '}') { depth--; }
			}
		}

		return depth === 0 && json.includes('{');
	}

	/**
	 * Cline 2.x+ stream events.
	 *
	 * Captured from 3.0.61:
	 *   {"type":"hook_event","hookEventName":"agent_start",...}
	 *   {"type":"agent_event","event":{"type":"content_start","contentType":"text",
	 *                                  "text":"Hi","accumulated":"Hi"}}
	 *   {"type":"agent_event","event":{"type":"usage","inputTokens":…}}
	 *   {"type":"agent_event","event":{"type":"done","reason":"completed",…}}
	 *   {"type":"run_result","finishReason":"completed","usage":{…},"text":"…"}
	 * Installed 3.0.61 also emits content_start/content_end with contentType
	 * "tool", and content_start with contentType "reasoning" and a reasoning
	 * delta. Tool and reasoning payloads must not be treated as answer text.
	 *
	 * `text` is the DELTA and `accumulated` is the running total; emitting both
	 * would double every character.
	 */
	private _handleModernEvent(data: Record<string, unknown>, session: ClineSessionState): StreamChunk | null {
		if (session.lastContextUsageStats === undefined) { session.lastContextUsageStats = null; }
		if (data.type === "run_result") {
			if (isRecord(data.usage)) {
				session.lastUsageStats = this._parseModernUsage(data.usage);
			}
			return this._modernTerminalFailure(data.finishReason, data.text, session);
		}

		// Lifecycle only — nothing to render.
		if (data.type === "hook_event") {
			return null;
		}

		const event = isRecord(data.event) ? data.event : {};
		// Current Cline wraps tool lifecycle events in the content vocabulary.
		// Normalize the envelope while retaining the same per-session tool IDs
		// and inputs used by older tool_start/tool_end streams.
		const eventType = event.contentType === "tool"
			? event.type === "content_start" ? "tool_start"
				: event.type === "content_end" ? "tool_end" : event.type
			: event.type;
		switch (eventType) {
			case "content_start":
			case "content_delta": {
				// The delta, never `accumulated` — see the note above.
				if (event.contentType === "reasoning" && event.redacted === true) { return null; }
				if (event.contentType && !["text", "thinking", "reasoning"].includes(String(event.contentType))) {
					return null;
				}
				const delta = event.contentType === "reasoning" ? event.reasoning : event.text;
				const text = typeof delta === "string" ? delta : "";
				if (!text) {
					return null;
				}
				return event.contentType === "thinking" || event.contentType === "reasoning"
					? { type: "thinking", content: text }
					: { type: "text", content: text };
			}

			case "usage": {
				const call = this._parseModernUsage(event, true);
				session.lastContextUsageStats = hasUsageSignal(call) ? call : null;
				const previous = session.lastUsageStats;
				session.lastUsageStats = previous ? addUsage(previous, call) : { ...call };
				if (typeof event.totalCost === 'number' && Number.isFinite(event.totalCost) && event.totalCost >= 0) {
					session.lastUsageStats.reportedCostUsd = event.totalCost;
				} else if (previous?.reportedCostUsd !== undefined && call.reportedCostUsd !== undefined) {
					session.lastUsageStats.reportedCostUsd = previous.reportedCostUsd + call.reportedCostUsd;
				}
				return null;
			}

			case "done": {
				// Successful text repeats the answer, but error text is the native
				// diagnostic (for example, an invalid model ID).
				if (isRecord(event.usage)) { session.lastUsageStats = this._parseModernUsage(event.usage); }
				return this._modernTerminalFailure(event.reason, event.text, session);
			}

			case "tool_call":
			case "tool_start": {
				const id = String(event.toolCallId ?? event.id ?? `cline-${Date.now()}`);
				const name = String(event.toolName ?? event.name ?? "tool");
				const rawInput = event.input ?? event.args;
				const input = isRecord(rawInput) ? rawInput : {};
				session.activeToolCalls.set(id, { id, name, inputJson: JSON.stringify(input) });
				return { type: "tool_use", toolCall: { id, name, input, status: "running" } };
			}

			case "tool_result":
			case "tool_end": {
				const id = String(event.toolCallId ?? event.id ?? "");
				const active = session.activeToolCalls.get(id);
				session.activeToolCalls.delete(id);
				const output = typeof event.output === "string" ? event.output : JSON.stringify(event.output ?? "");
				let input: Record<string, unknown>;
				try {
					input = active ? JSON.parse(active.inputJson) as Record<string, unknown> : {};
				} catch {
					input = {};
				}
				return {
					type: "tool_result",
					toolCall: {
						id,
						name: active?.name ?? String(event.toolName ?? event.name ?? "tool"),
						input,
						output,
						status: event.isError || event.error ? "failed" : "completed",
					},
				};
			}

			case "error": {
				const nativeError = typeof event.error === "string" ? event.error
					: isRecord(event.error) && typeof event.error.message === "string" ? event.error.message : undefined;
				const message = String(event.message ?? event.text ?? nativeError ?? "Cline reported an error");
				return { type: "error", content: message };
			}

			case "iteration_start":
				session.lastContextUsageStats = null;
				return null;
			case "iteration_end":
			case "content_end":
				return null;

			default:
				return null;
		}
	}

	private _modernTerminalFailure(reason: unknown, text: unknown, session: ClineSessionState): StreamChunk | null {
		if (!reason || reason === "completed" || session.terminalFailureReported) { return null; }
		session.terminalFailureReported = true;
		// Other stop reasons can carry a partial answer summary, not a diagnostic.
		const content = reason === "error" && typeof text === "string" && text.trim()
			? text : `Cline stopped: ${String(reason)}`;
		// Shared processStream normalization retains issuing-process credential
		// redaction and authentication classification before this reaches the UI.
		return { type: "error", content };
	}

	private _handleParsedMessage(data: unknown, session: ClineSessionState): StreamChunk | null {
		if (!isRecord(data)) { return null; }
		// Cline 2.0 replaced the whole event vocabulary. Both shapes are handled
		// because the format is self-describing — `type:"say"` is 1.x, the
		// envelope below is 2.x+ — so a user on either CLI works without Mysti
		// having to get a version check right at parse time.
		if (
			data.type === "agent_event" ||
			data.type === "run_result" ||
			data.type === "hook_event"
		) {
			return this._handleModernEvent(data, session);
		}

		// Handle Cline's "say" message format
		if (data.type === "say") {
			// Handle thinking/reasoning messages
			if (data.say === "reasoning" && typeof data.reasoning === "string" && data.reasoning) {
				return { type: "thinking", content: data.reasoning };
			}

			// Handle text messages -- Cline streams the model's reasoning as say:"text"
			// events. The actual user-facing answer arrives as say:"completion_result".
			// Show reasoning as thinking so Mysti only displays the clean answer.
			if (data.say === "text" && typeof data.text === "string" && data.text) {
				// Filter out echoed user input
				if (data.text.trim() === session.lastUserInput) {
					return null;
				}
				return { type: "thinking", content: data.text };
			}

			// Handle completion_result (Cline's final clean answer)
			if (data.say === "completion_result" && typeof data.text === "string" && data.text) {
				return { type: "text", content: data.text };
			}

			// Surface error messages from Cline
			if (data.say === "error" && typeof data.text === "string" && data.text) {
				return { type: "error", content: data.text };
			}

			// Detect streaming failures embedded in api_req_started events
			if (data.say === "api_req_started" && typeof data.text === "string" && data.text) {
				try {
					const reqData: unknown = JSON.parse(data.text);
					if (isRecord(reqData) && reqData.streamingFailedMessage) {
						const failData: unknown = typeof reqData.streamingFailedMessage === 'string'
							? JSON.parse(reqData.streamingFailedMessage)
							: reqData.streamingFailedMessage;
						if (isRecord(failData) && typeof failData.message === "string" && failData.message) {
							const modelInfo = failData.modelId ? ` (model: ${failData.modelId})` : '';
							return { type: "error", content: failData.message + modelInfo };
						}
					}
				} catch {
					// Not parseable, ignore
				}
			}

			// Skip all other say types (checkpoint_created, error_retry, etc.)
			return null;
		}

		if (data.type === "ask" && data.ask === "completion_result") {
			// Cline asks user to accept/reject -- treat as end of response
			session.askReceived = true;
			return null;
		}

		// Handle ask type (followup questions, API errors)
		if (data.type === "ask" && typeof data.text === "string" && data.text) {
			try {
				const askData: unknown = JSON.parse(data.text);
				if (!isRecord(askData)) { return null; }

				// Handle API request failures (e.g. missing API key, model errors)
				if (data.ask === "api_req_failed" && typeof askData.message === "string" && askData.message) {
					const modelInfo = askData.modelId ? ` (model: ${askData.modelId})` : '';
					session.askReceived = true;
					return { type: "error", content: askData.message + modelInfo };
				}

				if (typeof askData.question === "string" && askData.question) {
					// Filter out echoed user input
					if (askData.question.trim() === session.lastUserInput) {
						return null;
					}
					// Signal that Cline is waiting for user input;
					// sendMessage will handle process termination
					session.askReceived = true;
					// Convert to structured ask_user_question chunk
					return {
						type: 'ask_user_question',
						askUserQuestion: {
							toolCallId: `cline-ask-${Date.now()}`,
							questions: [{
								question: String(askData.question),
								header: 'Question',
								options: Array.isArray(askData.options) ? askData.options
									.filter((o: unknown) => typeof o === "string" || (isRecord(o) && typeof o.label === "string"))
									.map((o: unknown) => ({
										label: typeof o === "string" ? o : String(isRecord(o) ? o.label : ''),
										description: isRecord(o) && typeof o.description === "string" ? o.description : '',
									})) : [
									{ label: 'Yes', description: 'Accept' },
									{ label: 'No', description: 'Decline' }
								],
								multiSelect: false
							}]
						}
					};
				}
			} catch {
				// Non-JSON ask text -- check for known ask types
				if (data.ask === "api_req_failed") {
					session.askReceived = true;
					return { type: "error", content: data.text };
				}
				return null;
			}
		}

		// Handle direct text content
		if (data.type === "text" && typeof data.content === "string" && data.content) {
			if (data.content.trim() === session.lastUserInput) {
				return null;
			}
			return { type: "text", content: data.content };
		}

		// Handle thinking
		if (data.type === "thinking" && typeof data.content === "string" && data.content) {
			return { type: "thinking", content: data.content };
		}

		// Handle tool use (with deduplication)
		if (data.type === "tool_use" && isRecord(data.toolCall)) {
			const toolId = typeof data.toolCall.id === "string" ? data.toolCall.id : "";
			const name = typeof data.toolCall.name === "string" ? data.toolCall.name : "";
			const input = isRecord(data.toolCall.input) ? data.toolCall.input : {};
			if (session.completedToolCalls.has(toolId)) {
				return null;
			}
			session.activeToolCalls.set(toolId, {
				id: toolId,
				name,
				inputJson: JSON.stringify(input),
			});
			return {
				type: "tool_use",
				toolCall: {
					id: toolId,
					name,
					input,
					status: toolStatus(data.toolCall.status, "running"),
					kind: toolKind(name),
				},
			};
		}

		// Handle tool result (with deduplication)
		if (data.type === "tool_result" && isRecord(data.toolCall)) {
			const toolId = typeof data.toolCall.id === "string" ? data.toolCall.id : "";
			if (session.completedToolCalls.has(toolId)) {
				return null;
			}
			session.completedToolCalls.add(toolId);
			session.activeToolCalls.delete(toolId);
			return {
				type: "tool_result",
				toolCall: {
					id: toolId,
					name: typeof data.toolCall.name === "string" ? data.toolCall.name : "",
					input: {},
					output: typeof data.toolCall.output === "string" ? data.toolCall.output : "",
					status: toolStatus(data.toolCall.status, "completed"),
				},
			};
		}

		// Handle errors
		if (data.type === "error") {
			return {
				type: "error",
				content: typeof data.error === "string" && data.error ? data.error
					: typeof data.message === "string" && data.message ? data.message : "Unknown error",
			};
		}

		// Handle done - store usage data but don't yield done
		// (sendMessage will emit the single authoritative done event)
		if (data.type === "done" || data.type === "complete") {
			const usage = data.usage || data.tokens;
			if (isRecord(usage)) {
				session.lastUsageStats = this._parseUsage(usage);
			}
			return null;
		}

		// Handle explicit usage messages
		if (data.type === "usage" && isRecord(data.tokens)) {
			session.lastUsageStats = this._parseUsage(data.tokens);
			return null;
		}

		// Skip all other JSON state messages
		return null;
	}

	private _parseUsage(usage: Record<string, unknown>): NonNullable<ClineSessionState['lastUsageStats']> {
		const number = (value: unknown): number | undefined =>
			typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
		return {
			input_tokens: number(usage.input_tokens) ?? number(usage.inputTokens) ?? 0,
			output_tokens: number(usage.output_tokens) ?? number(usage.outputTokens) ?? 0,
			cache_creation_input_tokens: number(usage.cache_creation_input_tokens) ?? number(usage.cacheCreationInputTokens),
			cache_read_input_tokens: number(usage.cache_read_input_tokens) ?? number(usage.cacheReadInputTokens),
		};
	}

	private _parseModernUsage(usage: Record<string, unknown>, perCall = false): UsageStats {
		const number = (value: unknown): number | undefined =>
			typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
		const input = number(usage.inputTokens ?? usage.input_tokens);
		const read = number(usage.cacheReadTokens ?? usage.cacheReadInputTokens ?? usage.cache_read_input_tokens ?? 0);
		const write = number(usage.cacheWriteTokens ?? usage.cacheCreationInputTokens ?? usage.cache_creation_input_tokens ?? 0);
		const validPrompt = input !== undefined && read !== undefined && write !== undefined && read + write <= input;
		// A zero incremental cost is omitted by the native translator. Its
		// cumulative totalCost must never become that call's incremental charge.
		const cost = perCall ? number(usage.cost) : number(usage.totalCost) ?? number(usage.cost);
		// Installed @cline/core normalizes inputTokens to the ENTIRE prompt,
		// including both cache buckets, regardless of the selected model vendor.
		// Convert here, once. Legacy wire records still use _parseUsage above.
		return normalizeUsage({
			input_tokens: validPrompt ? input - read - write : 0,
			output_tokens: number(usage.outputTokens ?? usage.output_tokens) ?? 0,
			...(validPrompt && read > 0 ? { cache_read_input_tokens: read } : {}),
			...(validPrompt && write > 0 ? { cache_creation_input_tokens: write } : {}),
			...(cost !== undefined ? { reportedCostUsd: cost } : {}),
		}, 'anthropic');
	}

	/**
	 * Get stored usage stats for a specific panel session
	 */
	getStoredUsage(panelId?: string): UsageStats | null {
		const session = this._getSession(panelId) as ClineSessionState;
		const usage = session.lastUsageStats;
		session.lastUsageStats = null;
		console.log("[Mysti] Cline: getStoredUsage returning:", usage);
		return usage;
	}

	/**
	 * Override sendMessage to pass prompt as CLI argument (not stdin).
	 * Each Cline CLI invocation is a fresh process, so conversation history
	 * is included in the prompt via buildPromptAsync.
	 */
	async *sendMessage(
		content: string,
		context: ContextItem[],
		settings: Settings,
		conversation: Conversation | null,
		persona?: import("../base/IProvider").PersonaConfig,
		panelId?: string,
		providerManager?: unknown,
		agentConfig?: AgentConfiguration,
		_attachments?: Attachment[],
		resolveInput?: ProviderInputResolver,
	): AsyncGenerator<StreamChunk> {
		if (resolveInput) {
			const input = resolveInput();
			if (!input) { return; }
			({ content, context } = input);
		}
		const previous = this._getSession(panelId);
		// Validate authority before replacing a running request or building context.
		const cliPath = this.getCliPath();
		const baseArgs = this.buildCliArgs(settings, previous);
		const key = previous.panelId;
		this.cancelCurrentRequest(key);

		// A late stream or finally block must never touch its replacement's parser,
		// usage, process or cancellation state. Cline starts a fresh native process
		// per turn, so only the panel's context and display session ID carry forward.
		const session = this._createSession(key);
		session.channelSystemContext = previous.channelSystemContext;
		session.sessionId = previous.sessionId;
		session.autonomousMode = settings.autonomousMode === true;
		session.lastUserInput = content.trim();
		this._panelSessions.set(key, session);
		const controller = new AbortController();
		this._clineRequests.set(key, controller);
		const isCurrent = () => !controller.signal.aborted && this._clineRequests.get(key) === controller;
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
		let proc: ChildProcess | undefined;
		let cleanupStarted = false;
		const stderrRef = { output: "" };
		const stderrHandler = (data: Buffer) => {
			// Redact the complete diagnostic in Base, where split credentials can be
			// recognized. Never log raw fragments at the adapter boundary.
			stderrRef.output += data.toString();
		};

		try {
			// Mysti persona/agent/channel instructions are request context, using the
			// same prompt builder as other CLI adapters. Cline retains its own native
			// system/tool/mode prompt and automatically loaded project rules. Never
			// replace .clinerules or use --system, which replaces Cline's native prompt.
			const render = resolveInput ? await this.preparePromptRenderer(
				conversation, settings, persona, agentConfig, undefined, session.channelSystemContext,
			) : undefined;
			let fullPrompt = render ? '' : await this.buildPromptAsync(
				content, context, conversation, settings, persona, agentConfig,
				undefined, session.channelSystemContext,
			);
			if (!isCurrent()) { return; }
			if (resolveInput && render) {
				const input = resolveInput();
				if (!input) { controller.abort(); return; }
				fullPrompt = render(input.content, input.context);
				session.lastUserInput = input.content.trim();
			}
			if (!isCurrent()) { return; }
			console.log(`[Mysti] Cline: Prompt length: ${fullPrompt.length} chars`);

			// Modern Cline's working headless transport takes a positional prompt.
			// Legacy 1.x can use stdin when it would exceed the argument limit.
			const MAX_ARG_LENGTH = 200_000;
			const legacyCli = (this._getCliMajorVersion() ?? 2) < 2;
			const useStdin = legacyCli && fullPrompt.length > MAX_ARG_LENGTH;
			if (!legacyCli && fullPrompt.length > MAX_ARG_LENGTH) {
				yield {
					type: "error",
					content: `This request is too large for the Cline CLI (${Math.round(fullPrompt.length / 1000)}k characters). `
						+ 'Cline 2.0 and later accept a prompt only as a command-line argument, with no stdin fallback. '
						+ 'Start a new conversation or reduce the attached context.',
				};
				return;
			}
			const args = useStdin ? [...baseArgs, "-"] : [...baseArgs, fullPrompt];
			const env = getEnrichedEnv(this.getExtraSpawnEnv(settings));
			// The prompt is an argument: shell mode would interpret user content.
			proc = spawn(cliPath, args, {
				cwd, env, stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"], shell: false,
				...(process.platform !== 'win32' ? { detached: true } : {}),
			});
			// Own the POSIX group so Stop/finally also clean ordinary descendants
			// after their launcher exits, matching the shared single-shot path.
			markOwnedProcessGroup(proc);
			this._captureProcessAuthentication(proc, env);
			session.process = proc;
			proc.on("error", (error) => {
				const diagnostic = this._redactProcessError(error.message, proc);
				console.error("[Mysti] Cline: Spawn error:", diagnostic);
				stderrRef.output += `\nspawn error: ${diagnostic}`;
			});
			proc.stderr?.on("data", stderrHandler);

			if (panelId && providerManager && typeof (providerManager as ProcessTracker).registerProcess === "function") {
				(providerManager as ProcessTracker).registerProcess(panelId, proc, this.id);
			}
			if (useStdin && proc.stdin) {
				proc.stdin.write(fullPrompt);
				proc.stdin.end();
			}
			if (!session.sessionId) { session.sessionId = `cline-${key}-${Date.now()}`; }
			yield { type: 'session_active', sessionId: session.sessionId };
			if (!isCurrent()) { return; }

			for await (const chunk of this.processStream(stderrRef, session, true)) {
				if (!isCurrent()) { return; }
				yield chunk;
				if (!isCurrent()) { return; }
			}
			if (!isCurrent()) { return; }
			if (session.askReceived && proc && !this._timedOutProcesses.has(proc) && isProcessLive(proc)) {
				cleanupStarted = true;
				// Transfer cleanup to the captured handle before yielding done: a
				// replacement or Stop during that yield must not signal it again.
				if (session.process === proc) { session.process = null; }
				void killProcessTree(proc, PROCESS_KILL_GRACE_PERIOD_MS, { label: this.displayName });
			}
			const storedUsage = this.getStoredUsage(panelId);
			const contextUsage = session.lastContextUsageStats;
			session.lastContextUsageStats = undefined;
			yield { type: 'done', ...(storedUsage ? { usage: storedUsage } : {}),
				...(contextUsage !== undefined ? { contextUsage } : {}) };
		} catch (error) {
			if (isCurrent()) {
				yield this.handleError(error, proc);
				if (isCurrent()) { yield { type: 'done' }; }
			}
		} finally {
			proc?.stderr?.removeListener("data", stderrHandler);
			if (proc) {
				// Native Cline hard-exits on a second termination signal. Observe
				// cleanup already started for this captured session without cutting
				// off its abort acknowledgment; hung owned groups still escalate.
				void killProcessTree(proc, PROCESS_KILL_GRACE_PERIOD_MS, {
					label: this.displayName, initialSignal: session.cancelled || cleanupStarted || this._timedOutProcesses.has(proc) ? null : 'SIGTERM',
				});
			}
			if (session.process === proc) { session.process = null; }
			if (proc && panelId && providerManager && typeof (providerManager as ProcessTracker).clearProcess === "function") {
				(providerManager as ProcessTracker).clearProcess(panelId, proc);
			}
			controller.abort();
			if (this._clineRequests.get(key) === controller) { this._clineRequests.delete(key); }
		}
	}

	// Private helper methods

	private _findVSCodeExtensionCli(): string | null {
		const homeDir = os.homedir();
		const extensionsDir = path.join(homeDir, ".vscode", "extensions");

		try {
			if (fs.existsSync(extensionsDir)) {
				const entries = fs.readdirSync(extensionsDir);
				const clineExtensions = entries
					.filter((e) => e.startsWith("saoudrizwan.claude-dev-"))
					.sort()
					.reverse();

				for (const ext of clineExtensions) {
					// Check for various possible binary locations
					const possiblePaths = [
						path.join(extensionsDir, ext, "dist", "cline.js"),
						path.join(extensionsDir, ext, "resources", "cline"),
						path.join(extensionsDir, ext, "cline"),
					];

					for (const binaryPath of possiblePaths) {
						if (fs.existsSync(binaryPath)) {
							console.log("[Mysti] Cline: Found CLI at:", binaryPath);
							return binaryPath;
						}
					}
				}
			}
		} catch (error) {
			console.error("[Mysti] Cline: Error searching for CLI:", error);
		}

		return null;
	}

}
