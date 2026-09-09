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
import { spawn } from "child_process";
import { BaseCliProvider, type PanelSessionState, type ProcessTracker } from "../base/BaseCliProvider";
import type {
	CliDiscoveryResult,
	AuthConfig,
	ProviderCapabilities,
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
	ToolCall,
} from "../../types";
import { PROCESS_KILL_GRACE_PERIOD_MS } from "../../constants";
import { killProcessTree, isProcessLive } from "../../utils/processKill";
import { getEnrichedEnv } from "../../utils/platform";
import { toolKind } from "../../utils/toolNames";
import { isRecord } from "../../utils/valueGuards";

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
	lastUsageStats: {
		input_tokens: number;
		output_tokens: number;
		cache_creation_input_tokens?: number;
		cache_read_input_tokens?: number;
	} | null;
	lastUserInput: string;
	askReceived: boolean;
	jsonBuffer: string[];
	clineruleBackup: string | null;
	clineruleWritten: boolean;
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

	readonly config: ProviderConfig = {
		name: "cline",
		displayName: "Cline",
		models: [
			// Popular models (via OpenRouter)
			{
				id: "anthropic/claude-sonnet-4-5-20250929",
				name: "Claude Sonnet 4.5",
				description: "Best balance of speed, cost, and quality",
				contextWindow: 200000,
			},
			{
				id: "anthropic/claude-opus-4-6",
				name: "Claude Opus 4.6",
				description: "Most intelligent model for agents and coding",
				contextWindow: 200000,
			},
			{
				id: "deepseek/deepseek-chat",
				name: "DeepSeek V3",
				description: "Strong open-source coding model",
				contextWindow: 128000,
			},
			{
				id: "deepseek/deepseek-r1",
				name: "DeepSeek R1",
				description: "Reasoning-focused open-source model",
				contextWindow: 128000,
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
				contextWindow: 256000,
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

	readonly capabilities: ProviderCapabilities = {
		supportsStreaming: true,
		supportsThinking: true,
		supportsToolUse: true,
		supportsSessions: true,
		supportsAutoInstall: true,
		supportsPromptEnhancement: true,
		// Plan 02 Phase 1 capability matrix
		thinkingStyle: 'complete-blocks',  // say:"reasoning" blocks arrive whole
		thinkingLevelEffective: true,      // levels map to real CLI behavior
		planMode: 'detected',
		sessionKind: 'prompt-history',     // no actual resume — history replayed into the prompt
		emitsToolResults: true,
		emitsUsage: true,
		usageConvention: 'auto',   // Cline fronts whichever vendor the user configured and passes that vendor's own numbers straight through.
		modelSelection: 'none',            // model configured via cline CLI config; dropdown is a no-op (F18)
	};

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
			clineruleBackup: null,
			clineruleWritten: false,
		};
	}

	/**
	 * Override clearSession to clear all Cline-specific state
	 */
	clearSession(panelId?: string): void {
		super.clearSession(panelId);

		if (panelId) {
			const session = this._panelSessions.get(panelId) as ClineSessionState | undefined;
			if (session) {
				session.activeToolCalls.clear();
				session.completedToolCalls.clear();
				session.lastUsageStats = null;
				session.lastUserInput = "";
				session.askReceived = false;
				session.jsonBuffer = [];
				session.clineruleBackup = null;
				session.clineruleWritten = false;
			}
		} else {
			for (const session of this._panelSessions.values()) {
				const clineSession = session as ClineSessionState;
				clineSession.activeToolCalls.clear();
				clineSession.completedToolCalls.clear();
				clineSession.lastUsageStats = null;
				clineSession.lastUserInput = "";
				clineSession.askReceived = false;
				clineSession.jsonBuffer = [];
				clineSession.clineruleBackup = null;
				clineSession.clineruleWritten = false;
			}
		}
	}

	async discoverCli(): Promise<CliDiscoveryResult> {
		return this._discoverCliCommon();
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

		// Map Mysti modes to Cline modes.
		// Cline uses 'plan' (read-only) or 'act' (can make changes).
		const { mode, accessLevel } = settings;
		const planMode =
			mode === "quick-plan" ||
			mode === "detailed-plan" ||
			accessLevel === "read-only";

		if (planMode) {
			args.push(...(legacy ? ["--mode", "plan"] : ["--plan"]));
			console.log("[Mysti] Cline: Using plan mode (read-only)");
		} else if (legacy) {
			// 2.x+ has no act flag — act IS the default.
			args.push("--mode", "act");
			console.log("[Mysti] Cline: Using act mode");
		}

		// Auto-approve tools so the CLI never blocks on its own stdin prompt; the
		// stream-level tool-use gate in ChatViewProvider is what actually asks the
		// user. In act mode only — plan mode changes nothing to approve.
		if (!planMode) {
			args.push(...(legacy ? ["--yolo"] : ["--auto-approve", "true"]));
			console.log(
				`[Mysti] Cline: auto-approving tools (stream gate handles UI prompts) [mode=${mode}, access=${accessLevel}]`,
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
	 *
	 * `text` is the DELTA and `accumulated` is the running total; emitting both
	 * would double every character.
	 */
	private _handleModernEvent(data: Record<string, unknown>, session: ClineSessionState): StreamChunk | null {
		if (data.type === "run_result") {
			if (isRecord(data.usage)) {
				session.lastUsageStats = this._parseUsage(data.usage);
			}
			const finishReason = data.finishReason;
			if (finishReason && finishReason !== "completed") {
				return { type: "error", content: `Cline stopped: ${String(finishReason)}` };
			}
			return null;
		}

		// Lifecycle only — nothing to render.
		if (data.type === "hook_event") {
			return null;
		}

		const event = isRecord(data.event) ? data.event : {};
		switch (event.type) {
			case "content_start":
			case "content_delta": {
				// The delta, never `accumulated` — see the note above.
				const text = typeof event.text === "string" ? event.text : "";
				if (!text) {
					return null;
				}
				return event.contentType === "thinking"
					? { type: "thinking", content: text }
					: { type: "text", content: text };
			}

			case "usage": {
				session.lastUsageStats = this._parseUsage(event);
				return null;
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
				let input: Record<string, unknown> = {};
				try {
					input = active ? JSON.parse(active.inputJson) as Record<string, unknown> : {};
				} catch {
					input = {};
				}
				return {
					type: "tool_result",
					toolCall: {
						id,
						name: active?.name ?? "tool",
						input,
						output,
						status: event.isError || event.error ? "failed" : "completed",
					},
				};
			}

			case "error": {
				const message = String(event.message ?? event.text ?? "Cline reported an error");
				return { type: "error", content: message };
			}

			// `done` carries the full accumulated text, which has already been
			// streamed delta by delta; re-emitting it would duplicate the answer.
			case "done":
			case "iteration_start":
			case "iteration_end":
			case "content_end":
				return null;

			default:
				return null;
		}
	}

	private _handleParsedMessage(data: unknown, session: ClineSessionState): StreamChunk | null {
		if (!isRecord(data)) { return null; }
		console.log("[Mysti] Cline: Parsed JSON type:", data.type, "say:", data.say);

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
				console.log(
					"[Mysti] Cline: Found thinking:",
					data.reasoning.substring(0, 50),
				);
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
				console.log("[Mysti] Cline: Got completion_result:", data.text.substring(0, 100));
				return { type: "text", content: data.text };
			}

			// Surface error messages from Cline
			if (data.say === "error" && typeof data.text === "string" && data.text) {
				console.log("[Mysti] Cline: Error from say message:", data.text.substring(0, 100));
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
							console.log("[Mysti] Cline: Streaming failed:", failData.message);
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
					console.log("[Mysti] Cline: API request failed:", askData.message);
					session.askReceived = true;
					return { type: "error", content: askData.message + modelInfo };
				}

				if (typeof askData.question === "string" && askData.question) {
					// Filter out echoed user input
					if (askData.question.trim() === session.lastUserInput) {
						return null;
					}
					console.log("[Mysti] Cline: Found question (ask):", askData.question);
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

	/**
	 * Get stored usage stats for a specific panel session
	 */
	getStoredUsage(panelId?: string): {
		input_tokens: number;
		output_tokens: number;
		cache_creation_input_tokens?: number;
		cache_read_input_tokens?: number;
	} | null {
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
	): AsyncGenerator<StreamChunk> {
		const session = this._getSession(panelId) as ClineSessionState;

		// Reset per-message state from any previous interrupted message
		session.jsonBuffer = [];
		session.askReceived = false;

		const cliPath = this.getCliPath();
		const baseArgs = this.buildCliArgs(settings, session);

		// Store user input to filter out echoed text from Cline's response
		session.lastUserInput = content.trim();

		// Build system instructions separately — these go into .clinerules so Cline
		// injects them as real system prompt, not visible user message text.
		const agentInstructions = await this.buildAgentInstructionsAsync(agentConfig);
		const systemParts: string[] = [];
		if (agentInstructions) {
			systemParts.push(agentInstructions);
		} else if (persona) {
			const personaPrompt = this.getPersonaPrompt(persona);
			if (personaPrompt) {
				systemParts.push(personaPrompt);
			}
		}
		if (session.channelSystemContext) {
			systemParts.push(session.channelSystemContext);
		}
		const systemInstructions = systemParts.join('\n\n');

		// Build user prompt WITHOUT agent config or system context (moved to .clinerules)
		// Include conversation history since each Cline CLI invocation is a
		// fresh process with no memory of prior turns
		const fullPrompt = await this.buildPromptAsync(
			content,
			context,
			conversation,
			settings,
			undefined, // persona — handled in .clinerules above
			undefined, // agentConfig — handled in .clinerules above
			undefined, // attachments
			undefined, // systemContext — handled in .clinerules above
		);

		console.log(`[Mysti] Cline: Prompt length: ${fullPrompt.length} chars, preview: ${fullPrompt.substring(0, 200)}...`);

		// Pass prompt as CLI argument unless it exceeds OS limits (~256KB on macOS)
		const MAX_ARG_LENGTH = 200_000;
		// Cline 2.x+ has NO working stdin path. It advertises one — the error says
		// "requires a prompt argument or piped stdin" — but 3.0.61 rejects a pipe
		// AND a file redirect, and the `-` sentinel 1.x used is now parsed as a
		// command ("Unknown command or unquoted prompt: -"). The positional
		// argument is the only route that works, so long prompts cannot fall back
		// to stdin the way they could on 1.x.
		const legacyCli = (this._getCliMajorVersion() ?? 2) < 2;
		const useStdin = legacyCli && fullPrompt.length > MAX_ARG_LENGTH;
		const args = useStdin ? [...baseArgs, "-"] : [...baseArgs, fullPrompt];

		if (useStdin) {
			console.log(`[Mysti] Cline: Prompt too long for CLI arg (${fullPrompt.length} chars), using stdin`);
		} else if (fullPrompt.length > MAX_ARG_LENGTH) {
			// Beyond this the spawn fails with E2BIG, which surfaces as an opaque
			// "process exited" — say what actually happened instead.
			console.warn(`[Mysti] Cline: Prompt is ${fullPrompt.length} chars and this CLI has no stdin path`);
			yield {
				type: "error",
				content:
					`This request is too large for the Cline CLI (${Math.round(fullPrompt.length / 1000)}k characters). `
					+ `Cline 2.0 and later accept a prompt only as a command-line argument, with no stdin fallback. `
					+ `Start a new conversation or reduce the attached context.`,
			};
			return;
		}

		// Declare outside try so finally block can access for cleanup
		const stderrRef = { output: "" };
		const stderrHandler = (data: Buffer) => {
			const text = data.toString();
			stderrRef.output += text;
			console.log("[Mysti] Cline stderr:", text);
		};

		// Resolve workspace root early so we can write .clinerules and clean up in finally
		const workspaceFolders = vscode.workspace.workspaceFolders;
		const cwd = workspaceFolders
			? workspaceFolders[0].uri.fsPath
			: process.cwd();

		// Write system instructions to .clinerules so Cline injects them
		// as proper system prompt (not part of user message)
		if (systemInstructions) {
			this._writeClinerules(cwd, systemInstructions, session);
		}

		try {
			console.log("[Mysti] Cline: Starting CLI");
			console.log("[Mysti] Cline: Working directory:", cwd);

			// SECURITY: Never use shell mode for Cline -- the user prompt is passed
			// as a CLI argument which is fundamentally incompatible with shell: true
			session.process = spawn(cliPath, args, {
				cwd,
				env: getEnrichedEnv(),
				stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"],
				shell: false,
			});

			// Plan 18 (2.4 audit): early error listener — an async spawn failure
			// otherwise emits an unhandled 'error' event before waitForProcess
			// attaches its own listener.
			session.process.on("error", (err) => {
				console.error("[Mysti] Cline: Spawn error:", err);
				stderrRef.output += `\nspawn error: ${err.message}`;
			});

			// Send prompt via stdin for large prompts
			if (useStdin && session.process.stdin) {
				session.process.stdin.write(fullPrompt);
				session.process.stdin.end();
			}

			// Register process
			if (
				panelId &&
				providerManager &&
				typeof (providerManager as ProcessTracker).registerProcess === "function"
			) {
				(providerManager as ProcessTracker).registerProcess(panelId, session.process, this.id);
			}

			// Capture stderr for error reporting and auth error detection
			if (session.process.stderr) {
				session.process.stderr.on("data", stderrHandler);
			}

			// Emit session_active so the webview shows the session indicator
			if (!session.sessionId) {
				session.sessionId = `cline-${panelId || 'default'}-${Date.now()}`;
			}
			yield { type: 'session_active' as const, sessionId: session.sessionId };

			// Process output
			yield* this.processStream(stderrRef, session);

			// If Cline sent an "ask" message, terminate the process gracefully
			if (session.askReceived && isProcessLive(session.process)) {
				console.log("[Mysti] Cline: Killing process after ask message");
				void killProcessTree(session.process, PROCESS_KILL_GRACE_PERIOD_MS, { label: this.displayName });
			}

			// Yield single authoritative done chunk
			const storedUsage = this.getStoredUsage(panelId);
			yield storedUsage
				? { type: "done", usage: storedUsage }
				: { type: "done" };
		} catch (error) {
			yield this.handleError(error);
			yield { type: "done" };
		} finally {
			// Restore original .clinerules (or remove temp one)
			this._restoreClinerules(cwd, session);

			// Liveness-gated (not `.killed`): a SIGTERM'd-but-alive CLI must still be
			// escalated to SIGKILL, which the old `!killed` guard skipped.
			if (isProcessLive(session.process)) {
				try {
					// Remove only our stderr handler -- don't strip waitForProcess listeners
					if (session.process!.stderr) {
						session.process!.stderr.removeListener("data", stderrHandler);
					}
					// SIGTERM with reliable SIGKILL escalation (timer cleared on exit).
					void killProcessTree(session.process, PROCESS_KILL_GRACE_PERIOD_MS, { label: this.displayName });
				} catch (e) {
					console.error("[Mysti] Cline: Error cleaning up process:", e);
				}
			}
			session.process = null;
			if (
				panelId &&
				providerManager &&
				typeof (providerManager as ProcessTracker).clearProcess === "function"
			) {
				(providerManager as ProcessTracker).clearProcess(panelId);
			}
		}
	}

	/**
	 * Enhance a prompt using Cline
	 */
	async enhancePrompt(prompt: string): Promise<string> {
		const clinePath = this.getCliPath();

		const enhancePrompt = `Please enhance the following prompt to be more specific and effective for a coding assistant. Return only the enhanced prompt without any explanation:\n\nOriginal prompt: "${prompt}"\n\nEnhanced prompt:`;

		return new Promise((resolve) => {
			const args = ["--print", "--output-format", "text"];  // enhancePrompt uses text output, not --json

			const proc = spawn(clinePath, args, {
				stdio: ["pipe", "pipe", "pipe"],
			});

			let output = "";

			if (proc.stdin) {
				proc.stdin.write(enhancePrompt);
				proc.stdin.end();
			}

			proc.stdout?.on("data", (data) => {
				output += data.toString();
			});

			proc.on("close", (code) => {
				if (code === 0 && output.trim()) {
					resolve(output.trim());
				} else {
					resolve(prompt);
				}
			});

			proc.on("error", () => {
				resolve(prompt);
			});
		});
	}

	// Private helper methods

	/**
	 * Write system instructions to a .clinerules file in the workspace root.
	 * Cline CLI auto-discovers this file and injects its content into the
	 * system prompt slot of API requests (not the user message).
	 * Backs up any existing .clinerules content on the session for later restore.
	 */
	private _writeClinerules(cwd: string, instructions: string, session: ClineSessionState): void {
		const rulesPath = path.join(cwd, '.clinerules');
		try {
			if (fs.existsSync(rulesPath)) {
				session.clineruleBackup = fs.readFileSync(rulesPath, 'utf-8');
				console.log('[Mysti] Cline: Backed up existing .clinerules');
			} else {
				session.clineruleBackup = null;
			}
			fs.writeFileSync(rulesPath, instructions, 'utf-8');
			session.clineruleWritten = true;
			console.log(`[Mysti] Cline: Wrote .clinerules (${instructions.length} chars)`);
		} catch (error) {
			console.warn('[Mysti] Cline: Failed to write .clinerules:', error);
			session.clineruleWritten = false;
		}
	}

	/**
	 * Restore the original .clinerules file (or delete the temp one).
	 */
	private _restoreClinerules(cwd: string, session: ClineSessionState): void {
		if (!session.clineruleWritten) {
			return;
		}
		const rulesPath = path.join(cwd, '.clinerules');
		try {
			if (session.clineruleBackup !== null) {
				fs.writeFileSync(rulesPath, session.clineruleBackup, 'utf-8');
				console.log('[Mysti] Cline: Restored original .clinerules');
			} else {
				if (fs.existsSync(rulesPath)) {
					fs.unlinkSync(rulesPath);
					console.log('[Mysti] Cline: Removed temp .clinerules');
				}
			}
		} catch (error) {
			console.warn('[Mysti] Cline: Failed to restore .clinerules:', error);
		}
		session.clineruleBackup = null;
		session.clineruleWritten = false;
	}

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
