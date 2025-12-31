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

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Find the Claude CLI path by checking:
 * 1. User-configured path in settings
 * 2. VSCode extension bundle (anthropic.claude-code-*)
 * 3. Default 'claude' command (fallback)
 *
 * @returns The path to the Claude CLI executable
 */
export function findClaudeCliPath(): string {
	const config = vscode.workspace.getConfiguration('mysti');
	const configuredPath = config.get<string>('claudeCodePath', 'claude');

	// If user has configured a custom path, use it
	if (configuredPath !== 'claude') {
		return configuredPath;
	}

	const homeDir = os.homedir();
	const extensionsDir = path.join(homeDir, '.vscode', 'extensions');

	try {
		if (fs.existsSync(extensionsDir)) {
			const entries = fs.readdirSync(extensionsDir);
			const claudeExtensions = entries
				.filter((e) => e.startsWith('anthropic.claude-code-'))
				.sort()
				.reverse(); // Get latest version first

			for (const ext of claudeExtensions) {
				const binaryPath = path.join(extensionsDir, ext, 'resources', 'native-binary', 'claude');
				if (fs.existsSync(binaryPath)) {
					return binaryPath;
				}
			}
		}
	} catch {
		// Silently continue to fallback - error will be logged by caller if CLI fails
	}

	return configuredPath;
}

/**
 * Check if a CLI executable exists at the given path.
 *
 * @param cliPath - The path to check
 * @returns true if the CLI exists and is accessible
 */
export function cliExists(cliPath: string): boolean {
	try {
		fs.accessSync(cliPath, fs.constants.X_OK);
		return true;
	} catch {
		// For simple command names (like 'claude'), we can't check existence
		// without running which/where, so assume it might exist
		return !path.isAbsolute(cliPath);
	}
}
