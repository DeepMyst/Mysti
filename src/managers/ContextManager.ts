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
import type { ContextItem } from '../types';

export class ContextManager {
  private _context: ContextItem[] = [];
  private _autoContext: boolean = true;
  private _extensionContext: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this._extensionContext = context;
    this._autoContext = vscode.workspace.getConfiguration('mysti').get('autoContext', true);
  }

  public getContext(): ContextItem[] {
    return [...this._context];
  }

  public isAutoContextEnabled(): boolean {
    return this._autoContext;
  }

  public setAutoContext(enabled: boolean) {
    this._autoContext = enabled;
  }

  public async addFileToContext(filePath: string): Promise<ContextItem | null> {
    // Security: Normalize and resolve path to prevent traversal attacks
    const resolvedPath = path.resolve(filePath);

    // Security: Validate path is within workspace boundaries
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      const isInWorkspace = workspaceFolders.some((folder) =>
        resolvedPath.startsWith(folder.uri.fsPath + path.sep) || resolvedPath === folder.uri.fsPath
      );
      if (!isInWorkspace) {
        console.warn(`[Mysti] Rejected file outside workspace: ${resolvedPath}`);
        return null;
      }
    }

    // Check if file already exists in context
    if (this._context.find((c) => c.path === resolvedPath && c.type === 'file')) {
      return null;
    }

    try {
      const content = await fs.promises.readFile(resolvedPath, 'utf-8');
      const language = this._getLanguageFromPath(resolvedPath);

      const item: ContextItem = {
        id: this._generateId(),
        type: 'file',
        path: resolvedPath,
        content,
        language
      };

      this._context.push(item);
      return item;
    } catch (error) {
      console.error(`Failed to read file: ${resolvedPath}`, error);
      return null;
    }
  }

  public async addSelectionToContext(
    filePath: string,
    content: string,
    startLine: number,
    endLine: number,
    language?: string
  ): Promise<ContextItem> {
    const item: ContextItem = {
      id: this._generateId(),
      type: 'selection',
      path: filePath,
      content,
      startLine,
      endLine,
      language: language || this._getLanguageFromPath(filePath)
    };

    this._context.push(item);
    return item;
  }

  public async addFolderToContext(folderPath: string): Promise<ContextItem[]> {
    const items: ContextItem[] = [];
    const files = await this._getFilesInFolder(folderPath);

    for (const file of files.slice(0, 20)) { // Limit to 20 files
      const item = await this.addFileToContext(file);
      if (item) {
        items.push(item);
      }
    }

    return items;
  }

  public removeFromContext(id: string) {
    this._context = this._context.filter(c => c.id !== id);
  }

  public clearContext() {
    this._context = [];
  }

  public async refreshContext() {
    // Refresh content for all file items
    for (const item of this._context) {
      if (item.type === 'file') {
        try {
          item.content = await fs.promises.readFile(item.path, 'utf-8');
        } catch (error) {
          // File might have been deleted, remove from context
          this.removeFromContext(item.id);
        }
      }
    }
  }

  public formatContextForPrompt(): string {
    if (this._context.length === 0) {
      return '';
    }

    let formatted = '# Context\n\n';

    for (const item of this._context) {
      if (item.type === 'file') {
        formatted += `## File: ${item.path}\n`;
        formatted += `\`\`\`${item.language || ''}\n${item.content}\n\`\`\`\n\n`;
      } else if (item.type === 'selection') {
        formatted += `## Selection from ${item.path} (lines ${item.startLine}-${item.endLine})\n`;
        formatted += `\`\`\`${item.language || ''}\n${item.content}\n\`\`\`\n\n`;
      }
    }

    return formatted;
  }

  private _generateId(): string {
    return `ctx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private _getLanguageFromPath(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const languageMap: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescriptreact',
      '.js': 'javascript',
      '.jsx': 'javascriptreact',
      '.py': 'python',
      '.rb': 'ruby',
      '.go': 'go',
      '.rs': 'rust',
      '.java': 'java',
      '.c': 'c',
      '.cpp': 'cpp',
      '.h': 'c',
      '.hpp': 'cpp',
      '.cs': 'csharp',
      '.php': 'php',
      '.swift': 'swift',
      '.kt': 'kotlin',
      '.scala': 'scala',
      '.r': 'r',
      '.sql': 'sql',
      '.html': 'html',
      '.css': 'css',
      '.scss': 'scss',
      '.less': 'less',
      '.json': 'json',
      '.yaml': 'yaml',
      '.yml': 'yaml',
      '.xml': 'xml',
      '.md': 'markdown',
      '.sh': 'bash',
      '.bash': 'bash',
      '.zsh': 'bash',
      '.ps1': 'powershell',
      '.dockerfile': 'dockerfile',
      '.vue': 'vue',
      '.svelte': 'svelte'
    };

    return languageMap[ext] || '';
  }

  private async _getFilesInFolder(folderPath: string): Promise<string[]> {
    const files: string[] = [];
    const ignorePatterns = ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__'];

    async function walk(dir: string) {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (!ignorePatterns.includes(entry.name)) {
            await walk(fullPath);
          }
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    }

    try {
      await walk(folderPath);
    } catch (error) {
      console.error(`Failed to read folder: ${folderPath}`, error);
    }

    return files;
  }
}
