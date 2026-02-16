/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Business Source License 1.1.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: BUSL-1.1
 */

import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AutocompleteType } from '../types';

interface CachedCompletions {
  sentence: string | null;
  paragraph: string | null;
  message: string | null;
}

/**
 * AutocompleteManager - Provides fast autocomplete suggestions using Claude Haiku 4.5
 * Uses pre-spawned CLI processes to eliminate spawn latency (~500ms -> ~50ms)
 * No API key needed - uses existing Claude Code authentication
 */
export class AutocompleteManager {
  private _extensionContext: vscode.ExtensionContext;
  private _warmProcess: ChildProcess | null = null;
  private _claudePath: string;
  private _cachedCompletions: Map<string, CachedCompletions> = new Map();
  private _isSpawning: boolean = false;

  constructor(context: vscode.ExtensionContext) {
    this._extensionContext = context;
    this._claudePath = this._findClaudeCliPath();

    // Pre-spawn a warm process immediately
    this._spawnWarmProcess();

    console.log('[Mysti] Autocomplete initialized with pre-spawn CLI pool');
  }

  /**
   * Check if autocomplete is enabled (always true with CLI approach)
   */
  public isEnabled(): boolean {
    return true;
  }

  /**
   * Pre-spawn a Claude CLI process that's ready and waiting for stdin
   * This eliminates the ~500ms spawn overhead from the critical path
   */
  private _spawnWarmProcess(): void {
    if (this._isSpawning || this._warmProcess) {
      return;
    }

    this._isSpawning = true;

    try {
      this._warmProcess = spawn(this._claudePath, [
        '--print',
        '--output-format', 'text',
        '--model', 'claude-haiku-4-5-20251001'
      ], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Handle process errors - respawn on failure
      this._warmProcess.on('error', (err) => {
        console.error('[Mysti] Warm process error:', err);
        this._warmProcess = null;
        this._isSpawning = false;
        // Don't auto-respawn on error to avoid infinite loop
      });

      // Handle unexpected close
      this._warmProcess.on('close', (code) => {
        if (code !== 0 && code !== null) {
          console.log('[Mysti] Warm process closed with code:', code);
        }
        this._warmProcess = null;
        this._isSpawning = false;
      });

      this._isSpawning = false;
      console.log('[Mysti] Warm process spawned and ready');
    } catch (error) {
      console.error('[Mysti] Failed to spawn warm process:', error);
      this._isSpawning = false;
    }
  }

  /**
   * Get completion suggestion for the given text
   * Uses the pre-spawned warm process for instant response
   */
  public async getCompletion(
    currentText: string,
    completionType: AutocompleteType
  ): Promise<string | null> {
    if (!currentText.trim()) {
      return null;
    }

    // Check cache first
    const cached = this._cachedCompletions.get(currentText);
    if (cached && cached[completionType]) {
      console.log('[Mysti] Autocomplete cache hit for:', completionType);
      return cached[completionType];
    }

    try {
      const suggestion = await this._useWarmProcess(currentText, completionType);

      // Cache the result
      if (suggestion) {
        const existing = this._cachedCompletions.get(currentText) || { sentence: null, paragraph: null, message: null };
        existing[completionType] = suggestion;
        this._cachedCompletions.set(currentText, existing);

        // Limit cache size
        if (this._cachedCompletions.size > 50) {
          const firstKey = this._cachedCompletions.keys().next().value;
          if (firstKey) {
            this._cachedCompletions.delete(firstKey);
          }
        }
      }

      // Immediately respawn for next request
      this._spawnWarmProcess();

      return suggestion;
    } catch (error) {
      console.error('[Mysti] Autocomplete failed:', error);
      // Respawn on failure
      this._spawnWarmProcess();
      return null;
    }
  }

  /**
   * Pre-compute sentence completion for instant response during Tab
   */
  public async precomputeAll(currentText: string): Promise<void> {
    if (!currentText.trim()) {
      return;
    }

    console.log('[Mysti] Pre-computing sentence completion');

    // Only pre-compute sentence level (most common use case)
    // Paragraph/message will be computed on demand if user holds Tab
    const sentence = await this.getCompletion(currentText, 'sentence');

    if (sentence) {
      console.log('[Mysti] Sentence completion cached');
    }
  }

  /**
   * Get cached completion without making CLI call
   */
  public getCached(text: string, type: AutocompleteType): string | null {
    const cached = this._cachedCompletions.get(text);
    return cached ? cached[type] : null;
  }

  /**
   * Use the pre-spawned warm process to get completion
   * Falls back to spawning a new process if warm process isn't available
   */
  private async _useWarmProcess(
    text: string,
    completionType: AutocompleteType
  ): Promise<string | null> {
    // If no warm process available, spawn one and wait briefly
    if (!this._warmProcess) {
      this._spawnWarmProcess();
      // Wait a bit for spawn (still faster than full cold spawn in critical path)
      await new Promise(r => setTimeout(r, 100));
    }

    // Take the warm process (mark as used)
    const proc = this._warmProcess;
    this._warmProcess = null;

    if (!proc) {
      console.error('[Mysti] No process available for autocomplete');
      return null;
    }

    const prompt = this._buildPrompt(text, completionType);

    return new Promise((resolve) => {
      let output = '';
      let stderr = '';

      // Timeout after 5 seconds
      const timeout = setTimeout(() => {
        console.error('[Mysti] Autocomplete timed out');
        proc.kill('SIGTERM');
        resolve(null);
      }, 5000);

      proc.stdout?.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);

        if (code === 0 && output.trim()) {
          const suggestion = output.trim();
          console.log('[Mysti] Autocomplete suggestion:', suggestion.substring(0, 50) + (suggestion.length > 50 ? '...' : ''));
          resolve(suggestion);
        } else {
          if (stderr) {
            console.error('[Mysti] Autocomplete stderr:', stderr.substring(0, 200));
          }
          resolve(null);
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        console.error('[Mysti] Process error:', err);
        resolve(null);
      });

      // Send prompt and close stdin to trigger processing
      proc.stdin?.write(prompt);
      proc.stdin?.end();
    });
  }

  /**
   * Build the prompt for the given completion type
   */
  private _buildPrompt(text: string, completionType: AutocompleteType): string {
    // Use the last portion of text for context (max 500 chars to keep it fast)
    const contextText = text.length > 500 ? text.slice(-500) : text;

    switch (completionType) {
      case 'sentence':
        return `Complete to the end of the current sentence. Only output the completion, nothing else. No quotes, no explanation.

Text: "${contextText}"

Completion:`;

      case 'paragraph':
        return `Complete this thought with a full paragraph. Only output the completion, nothing else. No quotes, no explanation.

Text: "${contextText}"

Completion:`;

      case 'message':
        return `Complete this message naturally and helpfully with a full response. Only output the completion, nothing else. No quotes, no explanation.

Text: "${contextText}"

Completion:`;

      default:
        return `Complete to the end of the current sentence. Only output the completion, nothing else. No quotes, no explanation.

Text: "${contextText}"

Completion:`;
    }
  }

  /**
   * Cancel any pending completion (kills warm process)
   */
  public cancelCompletion(): void {
    if (this._warmProcess) {
      this._warmProcess.kill('SIGTERM');
      this._warmProcess = null;
    }
  }

  /**
   * Clear the completion cache
   */
  public clearCache(): void {
    this._cachedCompletions.clear();
  }

  /**
   * Find the Claude CLI path (same logic as other managers)
   */
  private _findClaudeCliPath(): string {
    const config = vscode.workspace.getConfiguration('mysti');
    const configuredPath = config.get<string>('claudeCodePath', 'claude');

    if (configuredPath !== 'claude') {
      return configuredPath;
    }

    const homeDir = os.homedir();
    const extensionsDir = path.join(homeDir, '.vscode', 'extensions');

    try {
      if (fs.existsSync(extensionsDir)) {
        const entries = fs.readdirSync(extensionsDir);
        const claudeExtensions = entries
          .filter(e => e.startsWith('anthropic.claude-code-'))
          .sort()
          .reverse();

        for (const ext of claudeExtensions) {
          const binaryPath = path.join(extensionsDir, ext, 'resources', 'native-binary', 'claude');
          if (fs.existsSync(binaryPath)) {
            console.log('[Mysti] Found Claude CLI at:', binaryPath);
            return binaryPath;
          }
        }
      }
    } catch (error) {
      console.error('[Mysti] Error searching for Claude CLI:', error);
    }

    return configuredPath;
  }

  /**
   * Dispose the manager - kill warm process and clear cache
   */
  public dispose(): void {
    this.cancelCompletion();
    this.clearCache();
  }
}
