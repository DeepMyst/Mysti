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
import type { ChildProcess } from "child_process";
import { assertNonInteractivePermissionSupport } from "../base/NativeApprovalPolicy";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BaseCliProvider, type PanelSessionState, type ProcessTracker } from "../base/BaseCliProvider";
import { validateModelName } from "../../utils/validation";
import { normalizeToolName, toolKind } from "../../utils/toolNames";
import { getEnrichedEnv } from "../../utils/platform";
import { killProcessTree, isProcessLive } from "../../utils/processKill";
import { PROCESS_KILL_GRACE_PERIOD_MS } from "../../constants";
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
	AgentConfiguration,
	Attachment,
	ModelInfo,
} from "../../types";

export interface CursorSessionState extends PanelSessionState {
	activeToolCalls: Map<string, { id: string; name: string; inputJson: string }>;
	lastUsageStats: { input_tokens: number; output_tokens: number } | null;
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
				id: "gpt-5.4",
				name: "GPT-5.4",
				description: "OpenAI's latest flagship model (paid plan required)",
				contextWindow: 200000,
			},
			{
				id: "gpt-5",
				name: "GPT-5",
				description: "OpenAI GPT-5 model (paid plan required)",
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
		supportsAskPermission: false,
		supportsStreaming: true,
		supportsThinking: true,  // stream-json: thinking delta/completed events
		supportsToolUse: true,
		supportsSessions: false,
		supportsAutoInstall: false,
		supportsPromptEnhancement: true,
		// Plan 02 Phase 1 capability matrix
		thinkingStyle: 'streamed',
		thinkingLevelEffective: false,
		planMode: 'detected',
		nativeModes: { plan: true, approvals: true }, // --mode plan plans natively; Read Only text kept: headless auto-approves switch_mode
		// Mysti replays recent messages into each prompt; session IDs are local, not --resume.
		sessionKind: 'prompt-history',
		emitsToolResults: true,
		emitsUsage: true,
		usageConvention: 'none',   // cursor-agent reports flat input/output only.
		modelSelection: 'full',
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
			suspended: false,
			activeToolCalls: new Map(),
			lastUsageStats: null,
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

	/**
	 * Live model discovery (Plan 01 Phase 3) via `cursor-agent models`, which lists
	 * the models available to the signed-in account. Output is ANSI-laced text, one
	 * model per line; we strip ANSI, then keep only slug-like tokens (no spaces) so
	 * header / "Loading…" / "No models" lines are dropped. A logged-out account
	 * yields no slugs → null → curated fallback. Returns null on any failure; never
	 * throws.
	 */
	async discoverModels(timeoutMs: number): Promise<ModelInfo[] | null> {
		const raw = await this._runCliForDiscovery(["models"], timeoutMs);
		if (!raw) { return null; }
		// eslint-disable-next-line no-control-regex
		const ansi = /\x1b\[[0-9;]*m/g;
		const slug = /^[a-zA-Z0-9][a-zA-Z0-9._\-:/[\]]*$/;
		const seen = new Set<string>();
		const models: ModelInfo[] = [];
		for (const line of raw.split("\n")) {
			const id = line.replace(ansi, "").replace(/^[\s•*-]+/, "").trim();
			if (!id || seen.has(id) || !slug.test(id)) { continue; }
			seen.add(id);
			models.push({ id, name: id });
		}
		return models.length > 0 ? models : null;
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

	/**
	 * Durable offline login marker: `agent login` writes an `authInfo` block
	 * ({ email, userId, authId }) into ~/.cursor/cli-config.json (the bearer token
	 * itself is in the OS keychain). Reading this avoids a false-negative when the
	 * network `agent status` spawn is slow (5s timeout) or changes its wording.
	 * A missing/unparseable file is NOT a negative signal — fall through to the
	 * status probe.
	 */
	private _readConfigAuthInfo(): { loggedIn: boolean; user?: string } {
		try {
			const cfgPath = path.join(os.homedir(), ".cursor", "cli-config.json");
			if (!fs.existsSync(cfgPath)) {
				return { loggedIn: false };
			}
			const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as {
				authInfo?: { email?: string; userId?: number | string; authId?: string };
			};
			const info = cfg.authInfo;
			if (info && (info.email || info.userId || info.authId)) {
				return { loggedIn: true, user: info.email || "Cursor Account" };
			}
			return { loggedIn: false };
		} catch {
			return { loggedIn: false };
		}
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

		// Offline: signed-in via `agent login` (authInfo in cli-config.json).
		const cfgAuth = this._readConfigAuthInfo();
		if (cfgAuth.loggedIn) {
			return { type: "cli-login", isAuthenticated: true, configPath: path.join(os.homedir(), ".cursor", "cli-config.json") };
		}

		// Fallback: network CLI login status (covers keychain-only edge).
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

		// Fast offline path: signed-in marker in cli-config.json (no spawn).
		const cfgAuth = this._readConfigAuthInfo();
		if (cfgAuth.loggedIn) {
			return { authenticated: true, user: cfgAuth.user || "Cursor Account" };
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
		// OS-correct: macOS/Linux use the bash installer, Windows uses the native
		// PowerShell installer (the bash one-liner can't run in cmd/PowerShell).
		return this._installCommandForCurrentOS("curl https://cursor.com/install -fsS | bash");
	}

	getInstallMethods(): import('../../types').InstallMethod[] {
		return [
			{
				id: 'curl-darwin',
				label: 'Direct install (macOS)',
				command: 'curl https://cursor.com/install -fsS | bash',
				platform: 'darwin',
				priority: 1
			},
			{
				id: 'curl-linux',
				label: 'Direct install (Linux)',
				command: 'curl https://cursor.com/install -fsS | bash',
				platform: 'linux',
				priority: 1
			},
			{
				id: 'powershell',
				label: 'Direct install (Windows PowerShell)',
				command: "irm 'https://cursor.com/install?win32=true' | iex",
				platform: 'win32',
				priority: 1
			}
		];
	}

	protected buildCliArgs(settings: Settings, _session: PanelSessionState): string[] {
		const args: string[] = [
			"--output-format",
			"stream-json",
			"--print",
		];

		// stream-json emits complete text blocks at tool/retry/query/final boundaries.
		// Partial output also emits untagged duplicate summaries, so keep block output
		// unambiguous. Text not yet flushed by the CLI is unavailable on interruption.

		// Model selection
		const effectiveModel = this._getEffectiveModel(settings);
		if (effectiveModel) {
			args.push("--model", effectiveModel);
			console.log("[Mysti] Cursor: Using model:", effectiveModel);
		}

		const { mode, accessLevel } = settings;
		assertNonInteractivePermissionSupport(this.displayName, settings);

		// --force enables direct file modifications without confirmation
		// More-restrictive-wins: only auto-approve when BOTH mode and access allow it
		if (
			mode === "quick-plan" ||
			mode === "detailed-plan" ||
			accessLevel === "read-only"
		) {
			args.push("--mode", "plan");
			console.log("[Mysti] Cursor: Explicit read-only plan mode");
		} else if (mode === "edit-automatically" && accessLevel === "full-access") {
			args.push("--force");
			console.log("[Mysti] Cursor: Using --force (edit-automatically + full-access)");
		} else if (mode === "default" && accessLevel === "full-access") {
			args.push("--force");
			console.log("[Mysti] Cursor: Using --force (default + full-access)");
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
	 * Map Cursor tool type names to canonical Claude-compatible names.
	 * The webview's formatToolSummary() and action classifier expect these
	 * canonical names. Notification events cannot hold native execution.
	 */
	private static readonly TOOL_TYPE_MAP: Record<string, string> = {
		shellToolCall: "Bash",
		readToolCall: "Read",
		writeToolCall: "Write",
		editToolCall: "Edit",
		grepToolCall: "Grep",
		globToolCall: "Glob",
		lsToolCall: "LS",
		todoToolCall: "TodoWrite",
		updateTodosToolCall: "TodoWrite",
		deleteToolCall: "Delete",
	};

	// Protobuf result alternatives, normalized for camelCase and snake_case JSON.
	// Metadata alongside the result (for example sandboxPolicy) is not an outcome.
	private static readonly TOOL_FAILURE_RESULTS = new Set([
		"error", "failure", "timeout", "rejected", "spawnerror",
		"permissiondenied", "filenotfound", "invalidfile", "readpermissiondenied",
		"writepermissiondenied", "notfile", "filebusy", "nospace", "notfound",
	]);

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

			// Each assistant event is one completed stream-json text block. Equal
			// blocks across separate boundaries are legitimate and must both render.
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

				return { type: "text", content: text };
			}

			// Tool call events — Cursor CLI format (per official docs):
			// { "type": "tool_call", "subtype": "started"|"completed",
			//   "call_id": "id", "tool_call": { "readToolCall": { "args": {...} } } }
			// The specific tool type is a nested key inside data.tool_call, NOT data.type.
			if (data.type === "tool_call" && data.tool_call) {
				const toolId = data.call_id || `tool_${Date.now()}`;

				// Find the actual tool type key inside data.tool_call
				// e.g. { "readToolCall": { "args": {...} } } → "readToolCall"
				const toolTypeKey = Object.keys(data.tool_call).find(
					(k) => k.endsWith("ToolCall") || k === "function",
				);
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const toolData = toolTypeKey ? (data.tool_call as any)[toolTypeKey] : null;

				// Map to canonical tool name for the webview and permission gate
				let toolName: string;
				if (toolTypeKey === "function") {
					toolName = normalizeToolName(toolData?.name || "tool");
				} else if (toolTypeKey) {
					toolName =
						CursorProvider.TOOL_TYPE_MAP[toolTypeKey] ||
						normalizeToolName(toolTypeKey.replace(/ToolCall$/, "").toLowerCase());
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
							kind: toolKind(toolName),
						},
					};
				}

				if (data.subtype === "completed") {
					const active = cursorSession.activeToolCalls.get(toolId);
					cursorSession.activeToolCalls.delete(toolId);

					// Preserve the selected result variant, including failures that
					// carry only a path. Its key supplies the otherwise missing reason.
					let output = "";
					let failed = false;
					if (toolData?.result?.success !== undefined) {
						output =
							typeof toolData.result.success === "string"
								? toolData.result.success
								: JSON.stringify(toolData.result.success, null, 2);
					} else if (toolData?.result && typeof toolData.result === "object") {
						const failure = Object.entries(toolData.result).find(([key, value]) =>
							value != null && CursorProvider.TOOL_FAILURE_RESULTS.has(key.replace(/_/g, "").toLowerCase()));
						if (failure) {
							failed = true;
							const [key, detail] = failure;
							output = key === "rejected"
								? (typeof detail === "string" ? detail : JSON.stringify(detail, null, 2))
								: JSON.stringify({ [key]: detail }, null, 2);
							output = this._redactProcessError(output, cursorSession.process ?? undefined);
						}
					}

					return {
						type: "tool_result",
						toolCall: {
							id: toolId,
							name: active?.name || toolName,
							input: active ? JSON.parse(active.inputJson) : input,
							output,
							status: failed ? "failed" : "completed",
						},
					};
				}

				return null;
			}

			// Result event — completion metrics
			if (data.type === "result") {
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

			// Reasoning streams as deltas; "completed" only closes the block.
			if (data.type === "thinking") {
				return data.subtype === "delta" && typeof data.text === "string" && data.text
					? { type: "thinking", content: data.text }
					: null;
			}

			// Done/complete events do NOT emit a parser-level
			// done: sendMessage() yields the single authoritative done (with usage)
			// after the stream ends (Plan 02 Phase 3: exactly one done per response).
			if (data.type === "done" || data.type === "complete") {
				return null;
			}

			// User echo events (Cursor echoes the prompt back) — skip
			if (data.type === "user") {
				return null;
			}

			// Log unrecognized event types for debugging
			console.log("[Mysti] Cursor: Unrecognized event type:",
				this._redactProcessError(String(data.type), cursorSession.process ?? undefined));
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
		const previous = this._getSession(panelId) as CursorSessionState;
		const cliPath = this.getCliPath();
		// Validate permission flags before replacing the predecessor.
		const baseArgs = this.buildCliArgs(settings, previous);
		this.cancelCurrentRequest(previous.panelId);
		const session = this._createSession(previous.panelId);
		session.channelSystemContext = previous.channelSystemContext;
		session.sessionId = previous.sessionId;
		session.autonomousMode = settings.autonomousMode === true;
		this._panelSessions.set(session.panelId, session);
		const isCurrent = () => !session.cancelled && this._panelSessions.get(session.panelId) === session;
		let ownedProcess: ChildProcess | undefined;
		const stderrRef = { output: "" };
		const stderrHandler = (data: Buffer) => {
			// A credential can span chunks. Shared stream handling logs only the
			// complete diagnostic after redacting the issuing child's secrets.
			stderrRef.output += data.toString();
		};

		try {
			// Each -p run is a new Cursor chat, so Mysti replays the conversation
			// (prompt-history). Complete instructions and imports before resolving
			// the transient input used in the final argv.
			const render = resolveInput ? await this.preparePromptRenderer(
				conversation, settings, persona, agentConfig, undefined, session.channelSystemContext,
			) : undefined;
			let fullPrompt = render ? '' : await this.buildPromptAsync(
				content, context, conversation, settings, persona, agentConfig, undefined, session.channelSystemContext,
			);
			if (!isCurrent()) { return; }
			const workspaceFolders = (await import("vscode")).workspace.workspaceFolders;
			const cwd = workspaceFolders ? workspaceFolders[0].uri.fsPath : process.cwd();
			const { spawn } = await import("child_process");
			if (!isCurrent()) { return; }
			const envExtra: Record<string, string | undefined> = {};
			const resolvedKey = this._resolveApiKey();
			if (resolvedKey) {
				// Credentials remain in the environment, never prompt argv.
				envExtra.CURSOR_API_KEY = resolvedKey;
			}
			if (resolveInput && render) {
				const input = resolveInput();
				if (!input) { session.cancelled = true; return; }
				fullPrompt = render(input.content, input.context);
			}
			if (!isCurrent()) { return; }
			const args = [...baseArgs, "-p", fullPrompt];
			const env = getEnrichedEnv(envExtra);
			ownedProcess = spawn(cliPath, args, {
				cwd, env, stdio: ["ignore", "pipe", "pipe"],
			});
			this._captureProcessAuthentication(ownedProcess, env);
			console.log("[Mysti] Cursor: Starting CLI at:", this._redactProcessError(cliPath, ownedProcess));
			console.log("[Mysti] Cursor: Working directory:", this._redactProcessError(cwd, ownedProcess));
			session.process = ownedProcess;
			ownedProcess.on("error", (err) => {
				// Node's Error object includes spawnargs, including the full prompt.
				const message = this._redactProcessError(err.message, ownedProcess);
				console.error("[Mysti] Cursor: Spawn error:", message);
				stderrRef.output += `\nspawn error: ${message}`;
			});
			if (panelId && providerManager && typeof (providerManager as ProcessTracker).registerProcess === "function") {
				(providerManager as ProcessTracker).registerProcess(panelId, ownedProcess, this.id);
			}
			ownedProcess.stderr?.on("data", stderrHandler);
			if (!session.sessionId) { session.sessionId = `cursor-${panelId || 'default'}-${Date.now()}`; }
			yield { type: 'session_active' as const, sessionId: session.sessionId };
			if (!isCurrent()) { return; }
			for await (const chunk of this.processStream(stderrRef, session)) {
				if (!isCurrent()) { return; }
				yield chunk;
				if (!isCurrent()) { return; }
			}
			if (!isCurrent()) { return; }
			const storedUsage = this.getStoredUsage(panelId);
			yield storedUsage ? { type: "done", usage: storedUsage } : { type: "done" };
			console.log("[Mysti] Cursor: Stream complete");
		} catch (error) {
			if (isCurrent()) {
				yield this.handleError(error, ownedProcess);
				if (isCurrent()) { yield { type: "done" }; }
			}
		} finally {
			// A delayed old request owns only its captured child, never the
			// successor now stored in the panel's current session.
			ownedProcess?.stderr?.removeListener("data", stderrHandler);
			if (isProcessLive(ownedProcess)) {
				void killProcessTree(ownedProcess, PROCESS_KILL_GRACE_PERIOD_MS, { label: this.displayName });
			}
			if (session.process === ownedProcess) { session.process = null; }
			if (ownedProcess && panelId && providerManager && typeof (providerManager as ProcessTracker).clearProcess === "function") {
				(providerManager as ProcessTracker).clearProcess(panelId, ownedProcess);
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

	protected _getEffectiveModel(settings: Settings): string | undefined {
    // P2.3/P0.2b: an explicitly routed model wins over the per-provider custom-model config.
    if (settings.routedModel) { return settings.routedModel; }
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
