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

import * as path from 'path';

/**
 * Shell metacharacters that could be used for command injection
 */
const SHELL_METACHARACTERS = /[;&|`$(){}<>\\'"!\n\r]/;

/**
 * Validates a CLI path to ensure it doesn't contain shell metacharacters
 * or path traversal attempts.
 *
 * @param cliPath - The CLI path to validate
 * @returns true if the path is safe, false otherwise
 */
export function validateCliPath(cliPath: string): boolean {
	if (!cliPath || typeof cliPath !== 'string') {
		return false;
	}

	// Check for shell metacharacters
	if (SHELL_METACHARACTERS.test(cliPath)) {
		return false;
	}

	// Check for path traversal
	const normalized = path.normalize(cliPath);
	if (normalized.includes('..')) {
		return false;
	}

	// Must be either an absolute path or a simple command name
	const isAbsolutePath = path.isAbsolute(cliPath);
	const isSimpleCommand = /^[a-zA-Z0-9_-]+$/.test(cliPath);

	return isAbsolutePath || isSimpleCommand;
}

/**
 * Sanitizes a CLI path by normalizing it and checking for traversal attempts.
 *
 * @param cliPath - The CLI path to sanitize
 * @returns The sanitized path
 * @throws Error if the path contains directory traversal
 */
export function sanitizeCliPath(cliPath: string): string {
	if (!cliPath || typeof cliPath !== 'string') {
		throw new Error('Invalid CLI path: empty or not a string');
	}

	const normalized = path.normalize(cliPath);

	// Check for directory traversal after normalization
	if (normalized.includes('..')) {
		throw new Error('Invalid CLI path: directory traversal detected');
	}

	return normalized;
}

/**
 * Validates that a file path is within expected boundaries.
 * Used for config file reads to prevent reading arbitrary files.
 *
 * @param filePath - The file path to validate
 * @param expectedDir - The expected parent directory
 * @returns true if the path is within the expected directory
 */
export function validatePathWithinDirectory(filePath: string, expectedDir: string): boolean {
	if (!filePath || !expectedDir) {
		return false;
	}

	const resolvedPath = path.resolve(filePath);
	const resolvedDir = path.resolve(expectedDir);

	return resolvedPath.startsWith(resolvedDir + path.sep) || resolvedPath === resolvedDir;
}

/**
 * List of allowed npm install commands for CLI setup.
 * Only these specific commands are allowed to be executed.
 */
export const ALLOWED_INSTALL_COMMANDS = [
	/^npm install -g @anthropic-ai\/claude-code(@[\d.]+)?$/,
	/^npm install -g @google\/gemini-cli(@[\d.]+)?$/,
	/^npm install -g @github\/copilot(@[\d.]+)?$/,
	/^npm install -g @openai\/codex(@[\d.]+)?$/,
];

/**
 * Validates that a command is in the allowlist.
 *
 * @param command - The command to validate
 * @returns true if the command is allowed
 */
export function isAllowedCommand(command: string): boolean {
	if (!command || typeof command !== 'string') {
		return false;
	}

	return ALLOWED_INSTALL_COMMANDS.some((pattern) => pattern.test(command.trim()));
}
