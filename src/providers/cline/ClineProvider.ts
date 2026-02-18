/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
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
} from "../../types";
import { PROCESS_KILL_GRACE_PERIOD_MS } from "../../constants";
import { getEnrichedEnv } from "../../utils/platform";

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
	};

	// ============================================================================
	// Slash command menu: Cline-specific commands
	// ============================================================================

	public override getSlashCommands(_panelId?: string): SlashCommandDefinition[] {
		const base = super.getSlashCommands(_panelId);
		return [
			...base,
			{
				id: "cline:plan-act",
				label: "Toggle plan/act mode",
				description: "Switch between plan and act modes",
				section: "customize",
				icon: "map",
				provider: "cline",
				action: "execute",
				keywords: ["plan", "act", "mode", "cline"],
			},
		];
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
		// Check if Cline data directory exists -- proves user has run cline auth before.
		// Auth config lives in the Cline core gRPC service which may not be running,
		// so we check for the data dir as a proxy. Runtime errors handle actual failures.
		const clineDataDir = path.join(os.homedir(), '.cline', 'data');
		if (fs.existsSync(clineDataDir)) {
			return { authenticated: true, user: 'Cline CLI' };
		}

		// Fallback: check VSCode extension API key setting
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
		const args: string[] = ["--output-format", "json"];

		// Do NOT connect to the VSCode Cline extension's Core instance.
		// Its auth config is separate from CLI auth (configured via "cline auth").
		// Let the CLI start its own Core so it uses the CLI-configured provider/key.

		// Only add --verbose when debug mode is explicitly enabled
		if (
			vscode.workspace.getConfiguration("mysti").get<boolean>("debugVerbose", false)
		) {
			args.push("--verbose");
		}

		// Map Mysti modes to Cline modes
		// Cline uses 'plan' (read-only) or 'act' (can make changes)
		const { mode, accessLevel } = settings;

		// Determine if we should use act or plan mode
		if (
			mode === "quick-plan" ||
			mode === "detailed-plan" ||
			accessLevel === "read-only"
		) {
			args.push("--mode", "plan");
			console.log("[Mysti] Cline: Using plan mode (read-only)");
		} else {
			args.push("--mode", "act");
			console.log("[Mysti] Cline: Using act mode");
		}

		// Add --yolo for full-access/edit-automatically to reduce prompts
		if (mode === "edit-automatically" && accessLevel === "full-access") {
			args.push("--yolo");
			console.log("[Mysti] Cline: Using yolo mode (auto-approve)");
		}

		// Note: Cline CLI has no per-request model flag.
		// The model is configured globally via "cline auth".
		// The Mysti model dropdown for Cline is informational only.

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
	 * Handle a fully parsed JSON message from Cline CLI
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private _handleParsedMessage(data: Record<string, any>, session: ClineSessionState): StreamChunk | null {
		console.log("[Mysti] Cline: Parsed JSON type:", data.type, "say:", data.say);

		// Handle Cline's "say" message format
		if (data.type === "say") {
			// Handle thinking/reasoning messages
			if (data.say === "reasoning" && data.reasoning) {
				console.log(
					"[Mysti] Cline: Found thinking:",
					data.reasoning.substring(0, 50),
				);
				return { type: "thinking", content: data.reasoning };
			}

			// Handle text messages -- Cline streams the model's reasoning as say:"text"
			// events. The actual user-facing answer arrives as say:"completion_result".
			// Show reasoning as thinking so Mysti only displays the clean answer.
			if (data.say === "text" && data.text) {
				// Filter out echoed user input
				if (data.text.trim() === session.lastUserInput) {
					return null;
				}
				return { type: "thinking", content: data.text };
			}

			// Handle completion_result (Cline's final clean answer)
			if (data.say === "completion_result" && data.text) {
				console.log("[Mysti] Cline: Got completion_result:", data.text.substring(0, 100));
				return { type: "text", content: data.text };
			}

			// Surface error messages from Cline
			if (data.say === "error" && data.text) {
				console.log("[Mysti] Cline: Error from say message:", data.text.substring(0, 100));
				return { type: "error", content: data.text };
			}

			// Detect streaming failures embedded in api_req_started events
			if (data.say === "api_req_started" && data.text) {
				try {
					const reqData = JSON.parse(data.text);
					if (reqData.streamingFailedMessage) {
						const failData = typeof reqData.streamingFailedMessage === 'string'
							? JSON.parse(reqData.streamingFailedMessage)
							: reqData.streamingFailedMessage;
						if (failData.message) {
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
		if (data.type === "ask" && data.text) {
			try {
				const askData = JSON.parse(data.text);

				// Handle API request failures (e.g. missing API key, model errors)
				if (data.ask === "api_req_failed" && askData.message) {
					const modelInfo = askData.modelId ? ` (model: ${askData.modelId})` : '';
					console.log("[Mysti] Cline: API request failed:", askData.message);
					session.askReceived = true;
					return { type: "error", content: askData.message + modelInfo };
				}

				if (askData.question) {
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
								options: Array.isArray(askData.options) ? askData.options.map((o: Record<string, unknown>) => ({
									label: String(o.label || o),
									description: String(o.description || '')
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
		if (data.type === "text" && data.content) {
			if (data.content.trim() === session.lastUserInput) {
				return null;
			}
			return { type: "text", content: data.content };
		}

		// Handle thinking
		if (data.type === "thinking" && data.content) {
			return { type: "thinking", content: data.content };
		}

		// Handle tool use (with deduplication)
		if (data.type === "tool_use" && data.toolCall) {
			const toolId = data.toolCall.id || "";
			if (session.completedToolCalls.has(toolId)) {
				return null;
			}
			session.activeToolCalls.set(toolId, {
				id: toolId,
				name: data.toolCall.name || "",
				inputJson: JSON.stringify(data.toolCall.input || {}),
			});
			return {
				type: "tool_use",
				toolCall: {
					id: toolId,
					name: data.toolCall.name || "",
					input: data.toolCall.input || {},
					status: data.toolCall.status || "running",
				},
			};
		}

		// Handle tool result (with deduplication)
		if (data.type === "tool_result" && data.toolCall) {
			const toolId = data.toolCall.id || "";
			if (session.completedToolCalls.has(toolId)) {
				return null;
			}
			session.completedToolCalls.add(toolId);
			session.activeToolCalls.delete(toolId);
			return {
				type: "tool_result",
				toolCall: {
					id: toolId,
					name: data.toolCall.name || "",
					input: {},
					output: data.toolCall.output || "",
					status: data.toolCall.status || "completed",
				},
			};
		}

		// Handle errors
		if (data.type === "error") {
			return {
				type: "error",
				content: data.error || data.message || "Unknown error",
			};
		}

		// Handle done - store usage data but don't yield done
		// (sendMessage will emit the single authoritative done event)
		if (data.type === "done" || data.type === "complete") {
			if (data.usage || data.tokens) {
				const usage = data.usage || data.tokens;
				session.lastUsageStats = {
					input_tokens: usage.input_tokens || usage.inputTokens || 0,
					output_tokens: usage.output_tokens || usage.outputTokens || 0,
					cache_creation_input_tokens: usage.cache_creation_input_tokens || usage.cacheCreationInputTokens,
					cache_read_input_tokens: usage.cache_read_input_tokens || usage.cacheReadInputTokens,
				};
			}
			return null;
		}

		// Handle explicit usage messages
		if (data.type === "usage" && data.tokens) {
			session.lastUsageStats = {
				input_tokens: data.tokens.input_tokens || data.tokens.inputTokens || 0,
				output_tokens: data.tokens.output_tokens || data.tokens.outputTokens || 0,
				cache_creation_input_tokens: data.tokens.cache_creation_input_tokens || data.tokens.cacheCreationInputTokens,
				cache_read_input_tokens: data.tokens.cache_read_input_tokens || data.tokens.cacheReadInputTokens,
			};
			return null;
		}

		// Skip all other JSON state messages
		return null;
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

		// Include conversation history since each Cline CLI invocation is a
		// fresh process with no memory of prior turns
		const fullPrompt = await this.buildPromptAsync(
			content,
			context,
			conversation,
			settings,
			persona,
			agentConfig,
			undefined,
			session.channelSystemContext,
		);

		console.log(`[Mysti] Cline: Prompt length: ${fullPrompt.length} chars, preview: ${fullPrompt.substring(0, 200)}...`);

		// Pass prompt as CLI argument unless it exceeds OS limits (~256KB on macOS)
		const MAX_ARG_LENGTH = 200_000;
		const useStdin = fullPrompt.length > MAX_ARG_LENGTH;
		const args = useStdin ? [...baseArgs, "-"] : [...baseArgs, fullPrompt];

		if (useStdin) {
			console.log(`[Mysti] Cline: Prompt too long for CLI arg (${fullPrompt.length} chars), using stdin`);
		}

		// Declare outside try so finally block can access for cleanup
		const stderrRef = { output: "" };
		const stderrHandler = (data: Buffer) => {
			const text = data.toString();
			stderrRef.output += text;
			console.log("[Mysti] Cline stderr:", text);
		};

		try {
			const workspaceFolders = vscode.workspace.workspaceFolders;
			const cwd = workspaceFolders
				? workspaceFolders[0].uri.fsPath
				: process.cwd();

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
				(providerManager as ProcessTracker).registerProcess(panelId, session.process);
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
			if (session.askReceived && session.process && !session.process.killed) {
				console.log("[Mysti] Cline: Killing process after ask message");
				session.process.kill("SIGTERM");
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
			if (session.process && !session.process.killed) {
				try {
					// Remove only our stderr handler -- don't strip waitForProcess listeners
					if (session.process.stderr) {
						session.process.stderr.removeListener("data", stderrHandler);
					}
					session.process.kill("SIGTERM");

					// Schedule force kill if SIGTERM doesn't work
					const processToKill = session.process;
					setTimeout(() => {
						if (processToKill && !processToKill.killed) {
							console.warn("[Mysti] Cline: Force killing leaked process");
							processToKill.kill("SIGKILL");
						}
					}, PROCESS_KILL_GRACE_PERIOD_MS);
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
			const args = ["--print", "--output-format", "text"];

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
