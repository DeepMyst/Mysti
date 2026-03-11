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

interface TouchRecord {
  provider: string;
  timestamp: number;
}

/**
 * Adds a sparkle "M" badge to files modified by Mysti in the VS Code Explorer.
 * Makes AI-assisted work visible to teammates during pair programming and screen shares.
 */
export class MystiFileDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private _touchedFiles: Map<string, TouchRecord> = new Map();
  private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  private _durationMs: number;

  constructor() {
    const config = vscode.workspace.getConfiguration('mysti');
    this._durationMs = (config.get<number>('fileDecorations.duration', 24)) * 3600_000;
  }

  /**
   * Mark a file as touched by Mysti. Fires decoration change event.
   */
  markFileTouched(filePath: string, provider: string): void {
    const config = vscode.workspace.getConfiguration('mysti');
    if (!config.get<boolean>('fileDecorations.enabled', true)) {
      return;
    }

    this._touchedFiles.set(filePath, {
      provider,
      timestamp: Date.now(),
    });

    const uri = vscode.Uri.file(filePath);
    this._onDidChangeFileDecorations.fire(uri);
    console.log(`[Mysti] File decoration: marked ${filePath} (${provider})`);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const config = vscode.workspace.getConfiguration('mysti');
    if (!config.get<boolean>('fileDecorations.enabled', true)) {
      return undefined;
    }

    const record = this._touchedFiles.get(uri.fsPath);
    if (!record) {
      return undefined;
    }

    // Check if within duration window
    const elapsed = Date.now() - record.timestamp;
    if (elapsed > this._durationMs) {
      this._touchedFiles.delete(uri.fsPath);
      return undefined;
    }

    const ago = this._formatTimeAgo(elapsed);
    return {
      badge: 'M',
      color: new vscode.ThemeColor('mysti.fileDecorationForeground'),
      tooltip: `Modified with Mysti (${record.provider}) \u2014 ${ago}`,
    };
  }

  /**
   * Get all currently tracked file paths.
   */
  getTrackedFiles(): Map<string, TouchRecord> {
    return this._touchedFiles;
  }

  private _formatTimeAgo(ms: number): string {
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 1) { return 'just now'; }
    if (minutes < 60) { return `${minutes}m ago`; }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) { return `${hours}h ago`; }
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  dispose(): void {
    this._onDidChangeFileDecorations.dispose();
  }
}
