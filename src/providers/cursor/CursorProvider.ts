/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: MostlyK <bruvistrue93@gmail.com>
 *
 * This file is part of Mysti, licensed under the Business Source License 1.1.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: BUSL-1.1
 */

import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { BaseCliProvider, type PanelSessionState, type ProcessTracker } from "../base/BaseCliProvider";
import { validateModelName } from "../../utils/validation";
import { getEnrichedEnv } from "../../utils/platform";
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
	AgentConfiguration,
} from "../../types";

export interface CursorSessionState extends PanelSessionState {
	activeToolCalls: Map<string, { id: string; name: string; inputJson: string }>;
	lastUsageStats: { input_tokens: number; output_tokens: number } | null;
	/** Chars emitted for the current assistant turn via streaming. Used to skip the
	 *  final complete `assistant` event that duplicates already-streamed text. */
	streamedTextLength: number;
}

/**
 * Cursor CLI provider implementation
 *
 * Cursor is an AI-powered code editor with a headless CLI mode (`agent`).
 * This provider integrates Cursor's headless agent into the Mysti multi-agent framework.
 *
 * CLI docs: https://cursor.com/docs/cli/headless
 * Install: curl https://cursor.com/install -fsS | bash
 * Auth: `agent login` (browser-based, recommended) or CURSOR_API_KEY environment variable
 */
export class CursorProvider extends BaseCliProvider {
	readonly id = "cursor";
	readonly displayName = "Cursor";

	readonly config: ProviderConfig = {
		name: "cursor",
		displayName: "Cursor",
		models: [
			{
				id: "auto",
				name: "Auto (Recommended)",
				description: "Cursor picks the best model for each task. Works on all plans.",
				contextWindow: 200000,
			},
			{
				id: "sonnet-4",
				name: "Claude Sonnet 4",
				description: "Fast, high-quality coding model (paid plan required)",
				contextWindow: 200000,
			},
			{
				id: "sonnet-4-thinking",
				name: "Claude Sonnet 4 Thinking",
				description: "Extended thinking for complex reasoning (paid plan required)",
				contextWindow: 200000,
			},
			{
				id: "gpt-5",
				name: "GPT-5",
				description: "OpenAI's latest flagship model (paid plan required)",
				contextWindow: 200000,
			},
			{
				id: "o3",
				name: "OpenAI o3",
				description: "OpenAI reasoning model (paid plan required)",
				contextWindow: 200000,
			},
			{
				id: "gemini-2.5-pro",
				name: "Gemini 2.5 Pro",
				description: "Google's latest model with 1M context (paid plan required)",
				contextWindow: 1000000,
			},
		],
		defaultModel: "auto",
	};

	readonly capabilities: ProviderCapabilities = {
		supportsStreaming: true,
		supportsThinking: false,
		supportsToolUse: true,
		supportsSessions: false,
		supportsAutoInstall: false,
	};

	protected _createSession(panelId: string): CursorSessionState {
		return {
			panelId,
			process: null,
			sessionId: null,
			autonomousMode: false,
			persistentProcess: null,
			persistentReady: false,
			lastHealthCheck: 0,
			activeToolCalls: new Map(),
			lastUsageStats: null,
			streamedTextLength: 0,
		};
	}

	async discoverCli(): Promise<CliDiscoveryResult> {
		const result = await this._discoverCliCommon();
		if (result.found) {
			return result;
		}
		// Fallback: try 'cursor-agent' (legacy symlink name from installer)
		const { checkCommandExists } = await import('../../utils/platform');
		if (await checkCommandExists('cursor-agent')) {
			console.log('[Mysti] Cursor: Found CLI via PATH as cursor-agent');
			return { found: true, path: 'cursor-agent' };
		}
		return result;
	}

	getCliPath(): string {
		return this._getCliPathCommon();
	}

	protected _getCliCommandName(): string {
		return 'agent';
	}

	protected _getConfiguredCliPath(): string {
		const config = vscode.workspace.getConfiguration("mysti");
		return config.get<string>("cursorPath", "agent");
	}

	protected _getAdditionalSearchPaths(): string[] {
		const homeDir = os.homedir();
		const paths = [
			// Primary install location (curl installer symlinks)
			path.join(homeDir, '.local', 'bin', 'agent'),
			path.join(homeDir, '.local', 'bin', 'cursor-agent'),
			// Legacy/alternative locations
			path.join(homeDir, '.cursor', 'bin', 'agent'),
		];
		if (process.platform === 'darwin') {
			paths.push(path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'bin', 'agent'));
		} else if (process.platform === 'win32') {
			paths.push(path.join(homeDir, 'AppData', 'Local', 'Programs', 'cursor', 'agent.exe'));
		}
		return paths;
	}

	async getAuthConfig(): Promise<AuthConfig> {
		const apiKey = this._resolveApiKey();
		if (apiKey) {
			return {
				type: "api-key",
				isAuthenticated: true,
				configPath: "",
			};
		}

		// Check CLI login status for browser-based auth
		const cliStatus = await this._checkCliLoginStatus();
		return {
			type: cliStatus.loggedIn ? "cli-login" : "api-key",
			isAuthenticated: cliStatus.loggedIn,
			configPath: "",
		};
	}

	async checkAuthentication(): Promise<AuthStatus> {
		// Fast path: check API key (no process spawn needed)
		const apiKey = this._resolveApiKey();
		if (apiKey) {
			return { authenticated: true, user: "API Key" };
		}

		// Slow path: check if user logged in via `agent login`
		const cliStatus = await this._checkCliLoginStatus();
		if (cliStatus.loggedIn) {
			return {
				authenticated: true,
				user: cliStatus.user || "Cursor Account",
			};
		}

		return {
			authenticated: false,
			error:
				'Not authenticated. Run "agent login" to sign in with your Cursor account, or set CURSOR_API_KEY in VS Code settings (mysti.cursorApiKey).',
		};
	}

	getAuthCommand(): string {
		return "agent login";
	}

	getInstallCommand(): string {
		return "curl https://cursor.com/install -fsS | bash";
	}

	getInstallMethods(): import('../../types').InstallMethod[] {
		return [
			{
				id: 'curl',
				label: 'Direct install (recommended)',
				command: 'curl https://cursor.com/install -fsS | bash',
				platform: 'all',
				priority: 1
			}
		];
	}

	protected buildCliArgs(settings: Settings, _session: PanelSessionState): string[] {
		const args: string[] = [
			"--output-format",
			"stream-json",
			"--print",
			"--stream-partial-output",
		];

		// Model selection
		const effectiveModel = this._getEffectiveModel(settings);
		if (effectiveModel) {
			args.push("--model", effectiveModel);
			console.log("[Mysti] Cursor: Using model:", effectiveModel);
		}

		const { mode, accessLevel } = settings;

		// --force enables direct file modifications without confirmation
		// Only add when the user has granted full edit + full access permissions
		if (mode === "edit-automatically" && accessLevel === "full-access") {
			args.push("--force");
			console.log("[Mysti] Cursor: Using --force (auto-approve file changes)");
		} else if (
			mode === "quick-plan" ||
			mode === "detailed-plan" ||
			accessLevel === "read-only"
		) {
			console.log("[Mysti] Cursor: Read-only mode (no --force)");
		} else {
			console.log("[Mysti] Cursor: Default mode (no --force)");
		}

		return args;
	}

	/**
	 * Cursor CLI does not support thinking tokens
	 */
	protected getThinkingTokens(_thinkingLevel: string): number | undefined {
		return undefined;
	}

	/**
	 * Map Cursor tool type names to Claude-compatible names.
	 * The webview's formatToolSummary() expects these standard names.
	 */
	private static readonly TOOL_TYPE_MAP: Record<string, string> = {
		shellToolCall: "bash",
		readToolCall: "read",
		writeToolCall: "write",
		editToolCall: "edit",
		grepToolCall: "grep",
		globToolCall: "glob",
		lsToolCall: "ls",
		todoToolCall: "todowrite",
		updateTodosToolCall: "todowrite",
		deleteToolCall: "delete",
	};

	/**
	 * Parse stream-json output from Cursor CLI
	 *
	 * Event types (per https://cursor.com/docs/cli/reference/output-format):
	 * - system (init): Model identification, session_id
	 * - assistant: Text in message.content[].text
	 * - tool_call (started/completed): Tool ops with nested type key
	 *     e.g. { type: "tool_call", call_id, tool_call: { readToolCall: { args, result } } }
	 * - result: Completion metrics (duration_ms, is_error)
	 * - user: Echo of user prompt (skipped)
	 */
	protected parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null {
		const cursorSession = session as CursorSessionState;

		if (!line.trim()) {
			return null;
		}

		try {
			const data = JSON.parse(line.trim());

			// System init event — extract model info
			if (data.type === "system") {
				if (data.subtype === "init" || data.model) {
					const sessionInfo = data.model || data.session_id || "cursor";
					console.log("[Mysti] Cursor: System init, model:", sessionInfo);
					if (data.session_id) {
						return { type: "session_active", sessionId: data.session_id };
					}
				}
				return null;
			}

			// Assistant text — with --stream-partial-output, Cursor emits CUMULATIVE
			// assistant events: each contains ALL text generated so far, not just
			// the new delta. We track how many chars we've already sent to the
			// webview and only emit the new suffix each time.
			if (data.type === "assistant") {
				let text = "";

				// Extract text from message.content[] (primary Cursor format)
				if (data.message?.content && Array.isArray(data.message.content)) {
					text = data.message.content
						.filter((c: { type: string }) => c.type === "text")
						.map((c: { text: string }) => c.text)
						.join("");
				}

				// Fallback: flat/delta fields
				if (!text) {
					text =
						data.content ||
						data.text ||
						(data.delta && data.delta.text) ||
						(data.delta && data.delta.content) ||
						"";
				}

				if (!text) {
					return null;
				}

				// Cumulative dedup: only emit chars beyond what we've already sent
				if (text.length <= cursorSession.streamedTextLength) {
					return null;
				}

				const newText = text.substring(cursorSession.streamedTextLength);
				cursorSession.streamedTextLength = text.length;
				return { type: "text", content: newText };
			}

			// Tool call events — Cursor CLI format (per official docs):
			// { "type": "tool_call", "subtype": "started"|"completed",
			//   "call_id": "id", "tool_call": { "readToolCall": { "args": {...} } } }
			// The specific tool type is a nested key inside data.tool_call, NOT data.type.
			if (data.type === "tool_call" && data.tool_call) {
				// Tool calls mark a new assistant turn — reset streaming dedup
				cursorSession.streamedTextLength = 0;
				const toolId = data.call_id || `tool_${Date.now()}`;

				// Find the actual tool type key inside data.tool_call
				// e.g. { "readToolCall": { "args": {...} } } → "readToolCall"
				const toolTypeKey = Object.keys(data.tool_call).find(
					(k) => k.endsWith("ToolCall") || k === "function",
				);
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const toolData = toolTypeKey ? (data.tool_call as any)[toolTypeKey] : null;

				// Map to Claude-compatible tool name for the webview
				let toolName: string;
				if (toolTypeKey === "function") {
					toolName = toolData?.name || "tool";
				} else if (toolTypeKey) {
					toolName =
						CursorProvider.TOOL_TYPE_MAP[toolTypeKey] ||
						toolTypeKey.replace(/ToolCall$/, "").toLowerCase();
				} else {
					toolName = "tool";
				}

				// Extract input from .args (Cursor format) or function arguments
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				let input: Record<string, any> = {};
				if (toolTypeKey === "function" && toolData?.arguments) {
					try {
						input = JSON.parse(toolData.arguments);
					} catch {
						input = {};
					}
				} else if (toolData?.args) {
					input = { ...toolData.args };
					// Normalize glob fields for webview's formatToolSummary
					// Cursor uses globPattern/targetDirectory, webview expects pattern/path
					if ("globPattern" in input) {
						input.pattern = input.globPattern;
						delete input.globPattern;
					}
					if ("targetDirectory" in input) {
						input.path = input.targetDirectory;
						delete input.targetDirectory;
					}
				}

				// Detect ask_user-style tools and convert to ask_user_question chunk
				if ((toolName === 'ask_user' || toolName === 'AskUserQuestion' || toolName === 'ask_user_question') &&
					input.questions && Array.isArray(input.questions)) {
					console.log('[Mysti] Cursor: Detected ask_user tool, converting to ask_user_question chunk');
					return {
						type: 'ask_user_question',
						askUserQuestion: {
							toolCallId: toolId,
							questions: (input.questions as Array<Record<string, unknown>>).map((q: Record<string, unknown>) => ({
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

				if (data.subtype === "started") {
					cursorSession.activeToolCalls.set(toolId, {
						id: toolId,
						name: toolName,
						inputJson: JSON.stringify(input),
					});

					return {
						type: "tool_use",
						toolCall: {
							id: toolId,
							name: toolName,
							input,
							status: "running",
						},
					};
				}

				if (data.subtype === "completed") {
					const active = cursorSession.activeToolCalls.get(toolId);
					cursorSession.activeToolCalls.delete(toolId);

					// Extract output from result.success or result.rejected
					let output = "";
					if (toolData?.result?.success !== undefined) {
						output =
							typeof toolData.result.success === "string"
								? toolData.result.success
								: JSON.stringify(toolData.result.success, null, 2);
					} else if (toolData?.result?.rejected) {
						output =
							typeof toolData.result.rejected === "string"
								? toolData.result.rejected
								: JSON.stringify(toolData.result.rejected, null, 2);
					}

					return {
						type: "tool_result",
						toolCall: {
							id: toolId,
							name: active?.name || toolName,
							input: active ? JSON.parse(active.inputJson) : input,
							output,
							status: "completed",
						},
					};
				}

				return null;
			}

			// Result event — completion metrics
			if (data.type === "result") {
				cursorSession.streamedTextLength = 0;
				if (data.duration_ms || data.stats) {
					const stats = data.stats || {};
					cursorSession.lastUsageStats = {
						input_tokens: stats.input_tokens || 0,
						output_tokens: stats.output_tokens || 0,
					};
					console.log(
						"[Mysti] Cursor: Result metrics, duration:",
						data.duration_ms,
						"ms",
					);
				}
				return null;
			}

			// Error events
			if (data.type === "error") {
				return {
					type: "error",
					content: data.error || data.message || "Unknown Cursor error",
				};
			}

			// Done/complete events
			if (data.type === "done" || data.type === "complete") {
				cursorSession.streamedTextLength = 0;
				return { type: "done" };
			}

			// User echo events (Cursor echoes the prompt back) — skip
			if (data.type === "user") {
				return null;
			}

			// Log unrecognized event types for debugging
			console.log("[Mysti] Cursor: Unrecognized event type:", data.type, JSON.stringify(data).slice(0, 200));
			return null;
		} catch {
			// Not JSON — treat non-empty lines as plain text
			const trimmed = line.trim();
			if (trimmed && !trimmed.startsWith("[") && trimmed.length > 1) {
				return { type: "text", content: trimmed };
			}
			return null;
		}
	}

	/**
	 * Get stored usage stats
	 */
	getStoredUsage(panelId?: string): {
		input_tokens: number;
		output_tokens: number;
	} | null {
		const session = this._getSession(panelId) as CursorSessionState;
		const usage = session.lastUsageStats;
		session.lastUsageStats = null;
		return usage;
	}

	/**
	 * Override sendMessage to pass prompt via -p flag (not stdin)
	 * Cursor CLI uses: agent -p "prompt" [flags]
	 */
	async *sendMessage(
		content: string,
		context: ContextItem[],
		settings: Settings,
		_conversation: Conversation | null,
		persona?: import("../base/IProvider").PersonaConfig,
		panelId?: string,
		providerManager?: unknown,
		agentConfig?: AgentConfiguration,
	): AsyncGenerator<StreamChunk> {
		const session = this._getSession(panelId) as CursorSessionState;
		const cliPath = this.getCliPath();
		const baseArgs = this.buildCliArgs(settings, session);

		// Build prompt (without conversation history — Cursor manages its own context)
		const fullPrompt = await this.buildPromptAsync(
			content,
			context,
			null,
			settings,
			persona,
			agentConfig,
		);

		// Pass prompt via -p flag
		const args = [...baseArgs, "-p", fullPrompt];

		// Declare outside try so finally block can access for cleanup
		const stderrRef = { output: "" };
		const stderrHandler = (data: Buffer) => {
			const text = data.toString();
			stderrRef.output += text;
			console.log("[Mysti] Cursor stderr:", text);
		};

		try {
			const workspaceFolders = (await import("vscode")).workspace
				.workspaceFolders;
			const cwd = workspaceFolders
				? workspaceFolders[0].uri.fsPath
				: process.cwd();

			console.log("[Mysti] Cursor: Starting CLI at:", cliPath);
			console.log("[Mysti] Cursor: Working directory:", cwd);

			const { spawn } = await import("child_process");
			const envExtra: Record<string, string | undefined> = {};
			const resolvedKey = this._resolveApiKey();
			if (resolvedKey) {
				envExtra.CURSOR_API_KEY = resolvedKey;
				args.push("--api-key", resolvedKey);
			}

			session.process = spawn(cliPath, args, {
				cwd,
				env: getEnrichedEnv(envExtra),
				stdio: ["ignore", "pipe", "pipe"],
			});

			// Register process for per-panel cancellation
			if (
				panelId &&
				providerManager &&
				typeof (providerManager as ProcessTracker).registerProcess === "function"
			) {
				(providerManager as ProcessTracker).registerProcess(panelId, session.process);
			}

			// Capture stderr for error reporting
			if (session.process.stderr) {
				session.process.stderr.on("data", stderrHandler);
			}

			// Emit session_active so the webview shows the session indicator
			if (!session.sessionId) {
				session.sessionId = `cursor-${panelId || 'default'}-${Date.now()}`;
			}
			yield { type: 'session_active' as const, sessionId: session.sessionId };

			// Process streaming output
			yield* this.processStream(stderrRef, session);

			// Yield done with usage stats
			const storedUsage = this.getStoredUsage(panelId);
			yield storedUsage
				? { type: "done", usage: storedUsage }
				: { type: "done" };
			console.log("[Mysti] Cursor: Stream complete");
		} catch (error) {
			yield this.handleError(error);
			yield { type: "done" };
		} finally {
			if (session.process && !session.process.killed) {
				if (session.process.stderr) {
					session.process.stderr.removeListener("data", stderrHandler);
				}
				session.process.kill("SIGTERM");
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
	 * Enhance a prompt using Cursor CLI
	 */
	async enhancePrompt(prompt: string): Promise<string> {
		const { spawn } = await import("child_process");
		const agentPath = this.getCliPath();

		const enhancePrompt = `Please enhance the following prompt to be more specific and effective for a coding assistant. Return only the enhanced prompt without any explanation:\n\nOriginal prompt: "${prompt}"\n\nEnhanced prompt:`;

		return new Promise((resolve) => {
			const envExtra: Record<string, string | undefined> = {};
			const resolvedKey = this._resolveApiKey();
			if (resolvedKey) {
				envExtra.CURSOR_API_KEY = resolvedKey;
			}

			const cliArgs = ["--output-format", "text", "--print", "-p", enhancePrompt];
			if (resolvedKey) {
				cliArgs.push("--api-key", resolvedKey);
			}

			const proc = spawn(
				agentPath,
				cliArgs,
				{
					stdio: ["ignore", "pipe", "pipe"],
					env: getEnrichedEnv(envExtra),
				},
			);

			let output = "";

			proc.stdout?.on("data", (data: Buffer) => {
				output += data.toString();
			});

			proc.on("close", (code: number | null) => {
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

	// Private helpers

	/**
	 * Resolve the API key from VS Code settings or environment variable.
	 * Settings take precedence over env var since env vars are unreliable in VS Code.
	 */
	private _resolveApiKey(): string | undefined {
		const config = vscode.workspace.getConfiguration("mysti");
		const settingsKey = config.get<string>("cursorApiKey", "");
		if (settingsKey) {
			return settingsKey;
		}
		return process.env.CURSOR_API_KEY || undefined;
	}

	/**
	 * Check if the user is logged in via `agent login` (browser-based auth).
	 * Spawns `agent status` and inspects the output.
	 */
	private async _checkCliLoginStatus(): Promise<{ loggedIn: boolean; user?: string }> {
		try {
			const cliPath = this.getCliPath();
			const { execFile } = await import("child_process");
			const { promisify } = await import("util");
			const execFileAsync = promisify(execFile);

			const { stdout } = await execFileAsync(cliPath, ["status"], {
				timeout: 5000,
				env: getEnrichedEnv(),
			});

			const output = stdout.trim().toLowerCase();
			if (
				output.includes("logged in") ||
				output.includes("authenticated") ||
				output.includes("signed in")
			) {
				const emailMatch = stdout.match(/[\w.-]+@[\w.-]+\.\w+/);
				return { loggedIn: true, user: emailMatch?.[0] || "Cursor Account" };
			}

			return { loggedIn: false };
		} catch {
			console.log("[Mysti] Cursor: agent status check failed, assuming not logged in via CLI");
			return { loggedIn: false };
		}
	}

	private _getEffectiveModel(settings: Settings): string | undefined {
		const config = vscode.workspace.getConfiguration("mysti");
		const customModel = config.get<string>("cursorModel", "");
		if (customModel) {
			const validation = validateModelName(customModel);
			if (validation.valid) {
				return customModel;
			}
			console.warn(
				`[Mysti] Cursor: Invalid custom model "${customModel}": ${validation.error}`,
			);
		}
		// Use dropdown selection, default to 'auto'
		if (settings.model) {
			return settings.model;
		}
		return "auto";
	}

}
