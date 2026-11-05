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
import { ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { QuickActionSuggestion, SuggestionColor, Conversation, Message } from '../types';
import { killProcessTree, markOwnedProcessGroup } from '../utils/processKill';
import { PROCESS_KILL_GRACE_PERIOD_MS } from '../constants';
import { spawnTextOnlyClaudeWorker } from '../utils/textOnlyClaudeWorker';

const COLORS: SuggestionColor[] = ['blue', 'green', 'purple', 'orange', 'indigo', 'teal'];
const ICONS = ['💡', '🔧', '📝', '🚀', '✨', '🎯'];
// CLI startup and inference can exceed five seconds even for a short title.
// Titles run asynchronously; retain the same bounded budget as suggestions.
const TITLE_TIMEOUT_MS = 20_000;

/**
 * SuggestionManager - Generates AI-powered quick action suggestions using Claude Haiku 4.5
 * Starts a text-only CLI worker when each prompt is ready
 * No API key needed - uses existing Claude Code authentication
 *
 * Provider-ID contract (Plan 02 Phase 2, W8): any provider-scoped suggestion
 * payload must carry FULL provider ids ('claude-code', 'openai-codex', ...),
 * never short aliases ('claude', 'codex') — the webview matches suggestion
 * providers against `state.settings.provider` with strict equality and has
 * no alias map. QuickActionSuggestion is currently provider-agnostic (no
 * provider field), which satisfies this vacuously; keep it that way or use
 * ProviderType ids when tagging is added.
 */
export class SuggestionManager {
  private _extensionContext: vscode.ExtensionContext;
  private _currentProcess: ChildProcess | null = null;
  private _claudePath: string;
  private _disposed = false;
  private readonly _ownedProcesses = new Set<ChildProcess>();
  private readonly _activeOperations = new Map<ChildProcess, () => void>();

  constructor(context: vscode.ExtensionContext) {
    this._extensionContext = context;
    this._claudePath = this._findClaudeCliPath();

    console.log('[Mysti] SuggestionManager initialized');
  }

  public async generateSuggestions(
    _conversation: Conversation,
    lastMessage: Message
  ): Promise<QuickActionSuggestion[]> {
    if (this._disposed) { return []; }
    this.cancelGeneration();

    // Let errors propagate - caller will handle by showing loading state or clearing
    const suggestions = await this._callClaude(lastMessage.content);
    if (suggestions.length > 0) {
      return suggestions;
    }

    // If AI returned empty, throw to let caller handle it
    throw new Error('No suggestions generated');
  }

  /**
   * Generate a concise title for a conversation based on the first user message
   * Uses Claude Haiku 4.5 for fast, intelligent title generation
   */
  public async generateTitle(userMessage: string): Promise<string> {
    if (this._disposed) { return this._fallbackTitle(userMessage); }
    try {
      const title = await this._generateTitleWithClaude(userMessage);
      return title || this._fallbackTitle(userMessage);
    } catch (error) {
      console.error('[Mysti] Title generation failed:', error);
      return this._fallbackTitle(userMessage);
    }
  }

  private async _generateTitleWithClaude(userMessage: string): Promise<string | null> {
    const prompt = `Generate a short, concise title (3-6 words max) for this chat conversation based on the user's first message. Return ONLY the title, no quotes, no explanation.

User message: "${userMessage.substring(0, 500)}"

Title:`;

    const result = await this._runWorker(prompt, TITLE_TIMEOUT_MS, false);
    return result.code === 0 && result.output.trim() ? this._truncateTitle(result.output.trim()) : null;
  }

  private _fallbackTitle(content: string): string {
    const trimmed = content.trim();
    const title = this._truncateTitle(trimmed);
    return title.length < trimmed.length ? `${title}...` : title;
  }

  private _truncateTitle(content: string): string {
    // Keep the existing length bound without cutting an astral character in half.
    let title = '';
    for (const character of content) {
      if (title.length + character.length > 50) { break; }
      title += character;
    }
    return title;
  }

  private async _callClaude(responseContent: string): Promise<QuickActionSuggestion[]> {
    // Shorter, more focused prompt for faster response
    const prompt = `Given this AI response, suggest 6 follow-up actions as JSON array.

Response: "${responseContent.substring(0, 1000)}"

Rules:
- Extract any numbered options or "Would you like..." choices
- Make suggestions specific to this response
- Each item: {"title": "3-5 words", "description": "8 words", "prompt": "message to send"}

Return ONLY JSON array, no other text.`;

    const result = await this._runWorker(prompt, 20000, true);
    const jsonMatch = result.output.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        const suggestions = parsed.map((item: Record<string, unknown>, i: number) => ({
          id: `suggestion-${Date.now()}-${i}`,
          title: String(item.title || 'Suggestion'),
          description: String(item.description || ''),
          message: String(item.prompt || item.title || ''),
          icon: ICONS[i % ICONS.length],
          color: COLORS[i % COLORS.length]
        })).slice(0, 6);
        if (suggestions.length) { return suggestions; }
      } catch { /* Invalid/partial JSON is a failed optional suggestion. */ }
    }
    throw new Error(result.timedOut ? 'Timeout' : `Failed to parse (code: ${result.code})`);
  }

  private _createProcess(): ChildProcess {
    const proc = spawnTextOnlyClaudeWorker(this._claudePath);
    markOwnedProcessGroup(proc);
    this._ownedProcesses.add(proc);
    // Diagnostics are optional here; consume the pipe so a verbose worker
    // cannot block waiting for its stderr buffer while producing a result.
    proc.stderr?.resume();
    // Keep an error listener even after an operation has settled. Spawn/stdin
    // errors and a late close belong only to this captured worker.
    proc.on('error', () => {});
    proc.stdin?.on('error', () => {
      this._activeOperations.get(proc)?.();
      this._terminateProcess(proc);
    });
    proc.once('exit', () => this._terminateProcess(proc));
    proc.once('close', () => { this._ownedProcesses.delete(proc); });
    return proc;
  }

  private _terminateProcess(proc: ChildProcess): void {
    // These are disposable one-shot helpers; shutdown must not depend on a
    // grace timer surviving extension-host exit.
    void killProcessTree(proc, PROCESS_KILL_GRACE_PERIOD_MS, { initialSignal: 'SIGKILL', label: 'suggestion worker' });
  }

  private _runWorker(prompt: string, timeoutMs: number, suggestion: boolean): Promise<{ output: string; code: number | null; timedOut?: boolean }> {
    if (this._disposed) { return Promise.reject(new Error('Suggestion manager disposed')); }
    // Claude --print has a startup stdin deadline; create the worker only
    // once this operation owns a complete prompt and can write it immediately.
    const proc = this._createProcess();
    if (suggestion) { this._currentProcess = proc; }
    return new Promise((resolve, reject) => {
      let output = '';
      const decoder = new StringDecoder('utf8');
      let settled = false;
      const onData = (data: Buffer) => { output += decoder.write(data); };
      const finish = (code: number | null, error?: Error, timedOut = false) => {
        if (settled) { return; }
        settled = true;
        output += decoder.end();
        clearTimeout(timeout);
        this._activeOperations.delete(proc);
        if (this._currentProcess === proc) { this._currentProcess = null; }
        proc.stdout?.removeListener('data', onData);
        proc.removeListener('close', onClose);
        proc.removeListener('error', onError);
        if (error) { reject(error); } else { resolve({ output, code, timedOut }); }
      };
      const onClose = (code: number | null) => finish(code);
      const onError = (error: Error) => { finish(null, error); this._terminateProcess(proc); };
      this._activeOperations.set(proc, () => finish(null, new Error('Generation cancelled')));
      proc.stdout?.on('data', onData);
      proc.on('close', onClose);
      proc.on('error', onError);
      const timeout = setTimeout(() => { finish(null, undefined, true); this._terminateProcess(proc); }, timeoutMs);
      try { proc.stdin?.write(prompt); proc.stdin?.end(); }
      catch (error) { onError(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  public cancelGeneration(): void {
    const proc = this._currentProcess;
    if (proc) {
      this._activeOperations.get(proc)?.();
      this._terminateProcess(proc);
      if (this._currentProcess === proc) { this._currentProcess = null; }
    }
  }

  public clearSuggestionHistory(): void {
    // No-op - kept for API compatibility
  }

  /**
   * Dispose the manager - kill processes
   */
  public dispose(): void {
    if (this._disposed) { return; }
    this._disposed = true;
    for (const settle of [...this._activeOperations.values()]) { settle(); }
    for (const proc of this._ownedProcesses) { this._terminateProcess(proc); }
    this._currentProcess = null;
  }

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
}
