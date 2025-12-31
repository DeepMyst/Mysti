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

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

/**
 * Centralized logger for the Mysti extension.
 * Uses VSCode OutputChannel for proper log management.
 */
class LoggerImpl {
	private _outputChannel: vscode.OutputChannel | null = null;
	private _logLevel: LogLevel = 'info';
	private _initialized = false;

	/**
	 * Initialize the logger with VSCode context.
	 * Should be called once during extension activation.
	 */
	initialize(): void {
		if (this._initialized) {
			return;
		}

		this._outputChannel = vscode.window.createOutputChannel('Mysti');

		// Read log level from settings
		const config = vscode.workspace.getConfiguration('mysti');
		this._logLevel = config.get<LogLevel>('logLevel', 'info');

		// Listen for configuration changes
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('mysti.logLevel')) {
				const newConfig = vscode.workspace.getConfiguration('mysti');
				this._logLevel = newConfig.get<LogLevel>('logLevel', 'info');
			}
		});

		this._initialized = true;
	}

	/**
	 * Log a debug message.
	 */
	debug(message: string, ...args: unknown[]): void {
		this._log('debug', message, args);
	}

	/**
	 * Log an info message.
	 */
	info(message: string, ...args: unknown[]): void {
		this._log('info', message, args);
	}

	/**
	 * Log a warning message.
	 */
	warn(message: string, ...args: unknown[]): void {
		this._log('warn', message, args);
	}

	/**
	 * Log an error message.
	 */
	error(message: string, ...args: unknown[]): void {
		this._log('error', message, args);
	}

	/**
	 * Show the output channel in the editor.
	 */
	show(): void {
		this._outputChannel?.show();
	}

	/**
	 * Dispose the logger and release resources.
	 */
	dispose(): void {
		this._outputChannel?.dispose();
		this._outputChannel = null;
		this._initialized = false;
	}

	private _shouldLog(level: LogLevel): boolean {
		return LOG_LEVELS[level] >= LOG_LEVELS[this._logLevel];
	}

	private _log(level: LogLevel, message: string, args: unknown[]): void {
		if (!this._shouldLog(level)) {
			return;
		}

		const timestamp = new Date().toISOString();
		const prefix = `[${timestamp}] [${level.toUpperCase()}] [Mysti]`;

		let formattedMessage = `${prefix} ${message}`;

		if (args.length > 0) {
			const argsString = args
				.map((arg) => {
					if (arg instanceof Error) {
						return arg.stack || arg.message;
					}
					if (typeof arg === 'object') {
						try {
							return JSON.stringify(arg);
						} catch {
							return String(arg);
						}
					}
					return String(arg);
				})
				.join(' ');
			formattedMessage += ` ${argsString}`;
		}

		// Write to OutputChannel
		this._outputChannel?.appendLine(formattedMessage);

		// Also write to console for development (can be removed in production)
		if (process.env.NODE_ENV === 'development') {
			switch (level) {
				case 'debug':
				case 'info':
					console.log(formattedMessage);
					break;
				case 'warn':
					console.warn(formattedMessage);
					break;
				case 'error':
					console.error(formattedMessage);
					break;
			}
		}
	}
}

// Singleton instance
export const Logger = new LoggerImpl();
