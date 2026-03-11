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

/**
 * CommitSignatureManager tracks files modified by Mysti and detects when
 * the AI agent itself executes a git commit (via tool_use). Unlike auto-appending
 * to the SCM input box, this only fires for commits Mysti initiates.
 */
export class CommitSignatureManager {
    private _context: vscode.ExtensionContext;
    private _modifiedFiles: Set<string> = new Set();

    constructor(context: vscode.ExtensionContext) {
        this._context = context;
        console.log('[Mysti] Commit signature manager initialized');
    }

    /**
     * Mark a file as modified by Mysti during the current session.
     */
    public markFileModified(filePath: string): void {
        this._modifiedFiles.add(filePath);
    }

    /**
     * Check if a tool_use chunk represents a git commit executed by Mysti.
     * Returns true if the tool ran a git commit command and Mysti had modified files.
     */
    public isAICommit(toolName: string, toolInput: Record<string, unknown>): boolean {
        if (this._modifiedFiles.size === 0) {
            return false;
        }

        const config = vscode.workspace.getConfiguration('mysti.commitSignature');
        if (!config.get<boolean>('enabled', true)) {
            return false;
        }

        // Detect bash/command tools that run git commit
        const command = (toolInput.command as string) || '';
        const isBashTool = /^(bash|command|execute|shell|terminal)/i.test(toolName);
        const isGitCommit = /\bgit\s+commit\b/i.test(command);

        return isBashTool && isGitCommit;
    }

    /**
     * Get the set of files modified by Mysti.
     */
    public getModifiedFiles(): Set<string> {
        return this._modifiedFiles;
    }

    /**
     * Clear all tracked modified files (e.g. after a commit).
     */
    public clearModifiedFiles(): void {
        this._modifiedFiles.clear();
    }

    public dispose(): void {
        this._modifiedFiles.clear();
    }
}
