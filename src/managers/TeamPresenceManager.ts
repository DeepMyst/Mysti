/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';

export interface SessionActionSummary {
    filesRead: number;
    filesWritten: number;
    commandsRun: number;
    totalActions: number;
}

/**
 * Tracks Mysti's actions during the current session — files read, files written,
 * commands run. Similar to how Claude Code and Codex surface AI activity.
 * All data is local and in-memory; nothing is written to the workspace.
 */
export class TeamPresenceManager {
    private _context: vscode.ExtensionContext;
    private _filesRead: Set<string> = new Set();
    private _filesWritten: Set<string> = new Set();
    private _commandsRun: number = 0;
    private _onDidChange: vscode.EventEmitter<SessionActionSummary> = new vscode.EventEmitter<SessionActionSummary>();
    public readonly onDidChange: vscode.Event<SessionActionSummary> = this._onDidChange.event;

    constructor(context: vscode.ExtensionContext) {
        this._context = context;
        console.log('[Mysti] Session action tracker initialized');
    }

    /**
     * Record that Mysti read a file.
     */
    public trackFileRead(filePath: string): void {
        this._filesRead.add(filePath);
        this._onDidChange.fire(this.getSummary());
    }

    /**
     * Record that Mysti wrote/modified a file.
     */
    public trackFileWritten(filePath: string): void {
        this._filesWritten.add(filePath);
        this._onDidChange.fire(this.getSummary());
    }

    /**
     * Record that Mysti ran a command.
     */
    public trackCommandRun(): void {
        this._commandsRun++;
        this._onDidChange.fire(this.getSummary());
    }

    /**
     * Detect and track actions from a tool_use chunk.
     */
    public trackToolUse(toolName: string, toolInput: Record<string, unknown>): void {
        const name = toolName.toLowerCase();

        // File read tools
        if (name.includes('read') || name.includes('view') || name === 'cat') {
            const filePath = (toolInput.file_path || toolInput.path || toolInput.filePath) as string;
            if (filePath) {
                this.trackFileRead(filePath);
            }
            return;
        }

        // File write/edit tools
        if (name.includes('write') || name.includes('edit') || name.includes('create') || name.includes('patch')) {
            const filePath = (toolInput.file_path || toolInput.path || toolInput.filePath) as string;
            if (filePath) {
                this.trackFileWritten(filePath);
            }
            return;
        }

        // Command/bash tools
        if (/^(bash|command|execute|shell|terminal)/i.test(name)) {
            this.trackCommandRun();
            return;
        }
    }

    /**
     * Get the current session action summary.
     */
    public getSummary(): SessionActionSummary {
        return {
            filesRead: this._filesRead.size,
            filesWritten: this._filesWritten.size,
            commandsRun: this._commandsRun,
            totalActions: this._filesRead.size + this._filesWritten.size + this._commandsRun,
        };
    }

    /**
     * Reset counters (e.g. on new conversation).
     */
    public reset(): void {
        this._filesRead.clear();
        this._filesWritten.clear();
        this._commandsRun = 0;
        this._onDidChange.fire(this.getSummary());
    }

    public dispose(): void {
        this._onDidChange.dispose();
        this._filesRead.clear();
        this._filesWritten.clear();
        console.log('[Mysti] Session action tracker disposed');
    }
}
