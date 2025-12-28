/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://deepmyst.com
 *
 * This file is part of Mysti, licensed under the Business Source License 1.1.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: BUSL-1.1
 */

/**
 * MCP Permission Server
 *
 * This server acts as an intermediary between Claude Code CLI and the VSCode extension
 * for handling permission requests when using --permission-prompt-tool.
 *
 * Communication Flow:
 * Claude CLI --stdin/stdout--> MCP Server --HTTP--> VSCode Extension --postMessage--> Webview UI
 *
 * The MCP server is spawned by Claude CLI when permissions are needed. It reads permission
 * requests from stdin, makes HTTP requests to the extension's permission endpoint, and
 * writes permission responses back to stdout for Claude CLI to consume.
 */

import * as readline from 'readline';
import * as http from 'http';

interface PermissionRequest {
	id: string;
	tool_name: string;
	input: Record<string, unknown>;
}

interface PermissionResponse {
	behavior: 'allow' | 'deny';
	message?: string;
	updatedInput?: Record<string, unknown>;
}

interface ExtensionPermissionRequest {
	requestId: string;
	toolName: string;
	toolInput: Record<string, unknown>;
}

interface ExtensionPermissionResponse {
	approved: boolean;
}

class PermissionServer {
	private extensionPort: number;

	constructor() {
		// Extension port is passed via environment variable
		this.extensionPort = parseInt(process.env.MYSTI_PERMISSION_PORT || '0', 10);

		if (!this.extensionPort) {
			console.error('[MCP Server] ERROR: MYSTI_PERMISSION_PORT not set');
			process.exit(1);
		}

		console.error(`[MCP Server] Starting permission server, extension port: ${this.extensionPort}`);
		this.setupStdioListener();
	}

	/**
	 * Listen for permission requests from Claude CLI via stdin
	 */
	private setupStdioListener(): void {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: false
		});

		rl.on('line', (line: string) => {
			try {
				const request = JSON.parse(line) as PermissionRequest;
				console.error('[MCP Server] Received permission request:', request);
				this.handlePermissionRequest(request);
			} catch (error) {
				console.error('[MCP Server] Failed to parse permission request:', error);
			}
		});

		rl.on('close', () => {
			console.error('[MCP Server] Stdin closed, exiting');
			process.exit(0);
		});
	}

	/**
	 * Handle permission request from Claude CLI
	 * Make HTTP request to extension and wait for response
	 */
	private async handlePermissionRequest(request: PermissionRequest): Promise<void> {
		const { id, tool_name, input } = request;

		try {
			// Make HTTP POST request to extension
			const approved = await this.requestPermissionFromExtension({
				requestId: id,
				toolName: tool_name,
				toolInput: input
			});

			// Send response back to Claude CLI via stdout
			const response: PermissionResponse = approved
				? { behavior: 'allow', updatedInput: {} }
				: { behavior: 'deny', message: 'User denied permission' };

			const responseJson = JSON.stringify(response);
			console.log(responseJson);
			console.error('[MCP Server] Sent permission response:', responseJson);
		} catch (error) {
			console.error('[MCP Server] Error requesting permission:', error);
			// Deny on error
			const response: PermissionResponse = {
				behavior: 'deny',
				message: 'Permission request failed'
			};
			console.log(JSON.stringify(response));
		}
	}

	/**
	 * Make HTTP request to extension's permission endpoint
	 */
	private requestPermissionFromExtension(request: ExtensionPermissionRequest): Promise<boolean> {
		return new Promise((resolve, reject) => {
			const postData = JSON.stringify(request);

			const options: http.RequestOptions = {
				hostname: 'localhost',
				port: this.extensionPort,
				path: '/permission',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(postData)
				},
				timeout: 30000 // 30 second timeout
			};

			const req = http.request(options, (res) => {
				let data = '';

				res.on('data', (chunk) => {
					data += chunk;
				});

				res.on('end', () => {
					try {
						const response = JSON.parse(data) as ExtensionPermissionResponse;
						console.error('[MCP Server] Extension response:', response);
						resolve(response.approved);
					} catch (error) {
						console.error('[MCP Server] Failed to parse extension response:', error);
						reject(error);
					}
				});
			});

			req.on('error', (error) => {
				console.error('[MCP Server] HTTP request error:', error);
				reject(error);
			});

			req.on('timeout', () => {
				console.error('[MCP Server] Request timeout');
				req.destroy();
				reject(new Error('Permission request timeout'));
			});

			req.write(postData);
			req.end();
		});
	}
}

// Start the server
new PermissionServer();
