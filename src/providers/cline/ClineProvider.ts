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
import type { PanelSessionState } from "../base/BaseCliProvider";
import { AcpNativeProvider } from "../base/AcpNativeProvider";
import type { AcpNativeLaunchContext, AcpNativeLaunch } from "../base/AcpNativeTypes";
import { prepareClineAcpLaunch } from "./ClineAcp";
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
	SlashCommandDefinition,
	ToolCall,
} from "../../types";
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
export class ClineProvider extends AcpNativeProvider {
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
		supportsNativeApproval: true,
		supportsSessions: true,
		supportsAutoInstall: true,
		supportsPromptEnhancement: false,
		// Plan 02 Phase 1 capability matrix
		thinkingStyle: 'complete-blocks',  // say:"reasoning" blocks arrive whole
		thinkingLevelEffective: false,     // ACP 3.0.61 fixes thinking off
		planMode: 'detected',
		sessionKind: 'prompt-history',     // no actual resume — history replayed into the prompt
		emitsToolResults: true,
		emitsUsage: false,                 // ACP 3.0.61 does not forward usage
		usageConvention: 'none',   // The pinned ACP adapter omits native usage events.
		modelSelection: 'full',            // session/set_model before each prompt
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
		return { type: "api-key", isAuthenticated: Boolean(process.env.CLINE_API_KEY?.trim()), configPath: "" };
	}

	async checkAuthentication(): Promise<AuthStatus> {
		return process.env.CLINE_API_KEY?.trim()
			? { authenticated: true, user: 'Cline API key (environment)' }
			: { authenticated: false, error: 'Native approvals require CLINE_API_KEY in the extension environment. Stored CLI login profiles are not imported into isolated ACP sessions.' };
	}

	getAuthCommand(): string {
		return "cline auth";
	}

	getInstallCommand(): string {
		return "npm install -g cline@3.0.61";
	}

	protected buildCliArgs(_settings: Settings, _session: PanelSessionState): string[] {
		return ["--acp", "--auto-approve", "false"];
	}

	protected _prepareAcpLaunch(context: AcpNativeLaunchContext): Promise<AcpNativeLaunch> {
		return prepareClineAcpLaunch(context, this._getEffectiveModel(context.settings));
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

	/** Prompt enhancement has no independently bounded tool-free ACP route. */

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
