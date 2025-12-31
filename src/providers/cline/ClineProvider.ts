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
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { BaseCliProvider } from "../base/BaseCliProvider";
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
} from "../../types";

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
			{
				id: "claude-sonnet-4-5-20250929",
				name: "Claude Sonnet 4.5",
				description: "Most capable model, best for complex tasks",
				contextWindow: 200000,
			},
			{
				id: "claude-opus-4-5-20251101",
				name: "Claude Opus 4.5",
				description: "Advanced reasoning and analysis",
				contextWindow: 200000,
			},
			{
				id: "claude-haiku-4-5-20251015",
				name: "Claude Haiku 4.5",
				description: "Fast and efficient for simpler tasks",
				contextWindow: 200000,
			},
		],
		defaultModel: "claude-sonnet-4-5-20250929",
	};

	readonly capabilities: ProviderCapabilities = {
		supportsStreaming: true,
		supportsThinking: true,
		supportsToolUse: true,
		supportsSessions: true,
	};

	// Tool call state tracking
	private _activeToolCalls: Map<
		number,
		{ id: string; name: string; inputJson: string }
	> = new Map();

	// Usage stats from message_delta
	private _lastUsageStats: {
		input_tokens: number;
		output_tokens: number;
		cache_creation_input_tokens?: number;
		cache_read_input_tokens?: number;
	} | null = null;

	// Track last user input to filter out echoed text from Cline
	private _lastUserInput: string = "";

	async discoverCli(): Promise<CliDiscoveryResult> {
		const extensionPath = this._findVSCodeExtensionCli();
		if (extensionPath) {
			return { found: true, path: extensionPath };
		}

		const configuredPath = this._getConfiguredPath();
		const found = await this._validateCliPath(configuredPath);

		return {
			found,
			path: configuredPath,
			installCommand: "npm install -g cline",
		};
	}

	getCliPath(): string {
		const extensionPath = this._findVSCodeExtensionCli();
		return extensionPath || this._getConfiguredPath();
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
		const auth = await this.getAuthConfig();
		if (!auth.isAuthenticated) {
			return {
				authenticated: false,
				error:
					"Not authenticated. Please configure your API key in Cline settings.",
			};
		}

		return { authenticated: true };
	}

	getAuthCommand(): string {
		return "cline auth";
	}

	getInstallCommand(): string {
		return "npm install -g cline";
	}

	protected buildCliArgs(settings: Settings, hasSession: boolean): string[] {
		const args: string[] = ["--output-format", "json", "--verbose"];

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

	// Buffer for accumulating multi-line JSON
	private _jsonBuffer: string[] = [];

	/**
	 * Parse stream line from Cline CLI output
	 * Cline outputs pretty-printed JSON (multi-line), so we need to buffer
	 */
	protected parseStreamLine(line: string): StreamChunk | null {
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
			this._jsonBuffer = [trimmed];
			return null;
		}

		// Middle/end of JSON object
		if (this._jsonBuffer.length > 0) {
			this._jsonBuffer.push(trimmed);

			// Check if we have a complete object (balanced braces)
			const fullJson = this._jsonBuffer.join("");
			const openBraces = (fullJson.match(/{/g) || []).length;
			const closeBraces = (fullJson.match(/}/g) || []).length;

			if (openBraces === closeBraces) {
				this._jsonBuffer = [];
				try {
					const data = JSON.parse(fullJson);
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

						// Handle text messages
						if (data.say === "text" && data.text) {
							// Filter out echoed user input
							const trimmedText = data.text.trim();
							if (trimmedText === this._lastUserInput) {
								console.log(
									"[Mysti] Cline: Filtered echoed user input:",
									trimmedText,
								);
								return null;
							}
							console.log(
								"[Mysti] Cline: Found text:",
								data.text.substring(0, 50),
							);
							return { type: "text", content: data.text };
						}

						// Skip all other say types (checkpoint_created, api_req_started, etc.)
						return null;
					}

					// Handle ask type (followup questions)
					if (data.type === "ask" && data.text) {
						try {
							const askData = JSON.parse(data.text);
							if (askData.question) {
								// Filter out echoed user input
								const trimmedQuestion = askData.question.trim();
								if (trimmedQuestion === this._lastUserInput) {
									console.log(
										"[Mysti] Cline: Filtered echoed user input in question:",
										trimmedQuestion,
									);
									return null;
								}
								console.log("[Mysti] Cline: Found question (ask):", askData.question);
								// Cline is waiting for user input - we need to kill the process
								// Schedule process termination after yielding the text
								setTimeout(() => {
									if (this._currentProcess && !this._currentProcess.killed) {
										console.log("[Mysti] Cline: Killing process after ask message");
										this._currentProcess.kill('SIGTERM');
									}
								}, 100);
								return { type: "text", content: askData.question };
							}
						} catch {
							return null;
						}
					}

					// Handle direct text content
					if (data.type === "text" && data.content) {
						// Filter out echoed user input
						const trimmedContent = data.content.trim();
						if (trimmedContent === this._lastUserInput) {
							console.log(
								"[Mysti] Cline: Filtered echoed user input in direct text:",
								trimmedContent,
							);
							return null;
						}
						return { type: "text", content: data.content };
					}

					// Handle thinking
					if (data.type === "thinking" && data.content) {
						return { type: "thinking", content: data.content };
					}

					// Handle tool use
					if (data.type === "tool_use" && data.toolCall) {
						return {
							type: "tool_use",
							toolCall: {
								id: data.toolCall.id || "",
								name: data.toolCall.name || "",
								input: data.toolCall.input || {},
								status: data.toolCall.status || "running",
							},
						};
					}

					// Handle tool result
					if (data.type === "tool_result" && data.toolCall) {
						return {
							type: "tool_result",
							toolCall: {
								id: data.toolCall.id || "",
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

					// Handle done - check for usage data
					if (data.type === "done" || data.type === "complete") {
						// Check if usage data is embedded in the done message
						if (data.usage || data.tokens) {
							const usage = data.usage || data.tokens;
							this._lastUsageStats = {
								input_tokens: usage.input_tokens || usage.inputTokens || 0,
								output_tokens: usage.output_tokens || usage.outputTokens || 0,
								cache_creation_input_tokens: usage.cache_creation_input_tokens || usage.cacheCreationInputTokens,
								cache_read_input_tokens: usage.cache_read_input_tokens || usage.cacheReadInputTokens,
							};
							console.log("[Mysti] Cline: Stored usage from done message:", this._lastUsageStats);
						}
						return { type: "done" };
					}

					// Handle explicit usage messages
					if (data.type === "usage" && data.tokens) {
						this._lastUsageStats = {
							input_tokens: data.tokens.input_tokens || data.tokens.inputTokens || 0,
							output_tokens: data.tokens.output_tokens || data.tokens.outputTokens || 0,
							cache_creation_input_tokens: data.tokens.cache_creation_input_tokens || data.tokens.cacheCreationInputTokens,
							cache_read_input_tokens: data.tokens.cache_read_input_tokens || data.tokens.cacheReadInputTokens,
						};
						console.log("[Mysti] Cline: Stored usage from usage message:", this._lastUsageStats);
						return null; // Usage is not streamed to UI, just stored
					}

					// Skip all other JSON state messages
					return null;
				} catch (e) {
					console.error("[Mysti] Cline: Failed to parse JSON:", e);
					this._jsonBuffer = [];
					return null;
				}
			}

			return null;
		}

		return null;
	}

	/**
	 * Get stored usage stats
	 */
	getStoredUsage(): {
		input_tokens: number;
		output_tokens: number;
		cache_creation_input_tokens?: number;
		cache_read_input_tokens?: number;
	} | null {
		const usage = this._lastUsageStats;
		this._lastUsageStats = null;
		console.log("[Mysti] Cline: getStoredUsage returning:", usage);
		return usage;
	}

	/**
	 * Override sendMessage to pass prompt as CLI argument (not stdin)
	 * NOTE: Cline manages its own conversation history, so we only send current message + context
	 */
	async *sendMessage(
		content: string,
		context: ContextItem[],
		settings: Settings,
		_conversation: Conversation | null, // Unused - Cline manages its own history
		persona?: import("../base/IProvider").PersonaConfig,
		panelId?: string,
		providerManager?: any,
		agentConfig?: any,
	): AsyncGenerator<StreamChunk> {
		const cliPath = this.getCliPath();
		const baseArgs = this.buildCliArgs(settings, this.hasSession());

		// Store user input to filter out echoed text from Cline's response
		this._lastUserInput = content.trim();

		// Build prompt WITHOUT conversation history (Cline manages its own)
		// Pass null for conversation to skip history formatting
		const fullPrompt = await this.buildPromptAsync(
			content,
			context,
			null,
			settings,
			persona,
			agentConfig,
		);

		// For Cline, pass prompt as argument, not via stdin
		const args = [...baseArgs, fullPrompt];

		try {
			const workspaceFolders = (await import("vscode")).workspace
				.workspaceFolders;
			const cwd = workspaceFolders
				? workspaceFolders[0].uri.fsPath
				: process.cwd();

			console.log("[Mysti] Cline: Starting CLI with args:", args);
			console.log("[Mysti] Cline: Working directory:", cwd);

			const { spawn } = await import("child_process");
			this._currentProcess = spawn(cliPath, args, {
				cwd,
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"], // Don't use stdin for Cline
			});

			// Register process
			if (
				panelId &&
				providerManager &&
				typeof providerManager.registerProcess === "function"
			) {
				providerManager.registerProcess(panelId, this._currentProcess);
			}

			// Process output
			yield* this.processStream("");

			// Done
			console.log("[Mysti] Cline: Stream complete, yielding done chunk");
			const storedUsage = this.getStoredUsage();
			yield storedUsage
				? { type: "done", usage: storedUsage }
				: { type: "done" };
			console.log("[Mysti] Cline: Done chunk yielded");
		} catch (error) {
			// Yield error chunk AND done to ensure loading state is cleared
			yield this.handleError(error);
			// Always yield done after error to hide loading animation
			yield { type: "done" };
		} finally {
			if (this._currentProcess && !this._currentProcess.killed) {
				this._currentProcess.removeAllListeners();
				this._currentProcess.kill("SIGTERM");
			}
			this._currentProcess = null;
			if (
				panelId &&
				providerManager &&
				typeof providerManager.clearProcess === "function"
			) {
				providerManager.clearProcess(panelId);
			}
		}
	}

	/**
	 * Enhance a prompt using Cline
	 */
	async enhancePrompt(prompt: string): Promise<string> {
		const { spawn } = await import("child_process");
		const clinePath = this.getCliPath();

		const enhancePrompt = `Please enhance the following prompt to be more specific and effective for a coding assistant. Return only the enhanced prompt without any explanation:

Original prompt: "${prompt}"

Enhanced prompt:`;

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

	private _getConfiguredPath(): string {
		const config = vscode.workspace.getConfiguration("mysti");
		return config.get<string>("clinePath", "cline");
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

	private async _validateCliPath(cliPath: string): Promise<boolean> {
		try {
			fs.accessSync(cliPath, fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	}
}
