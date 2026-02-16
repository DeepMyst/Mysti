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
import {
  AskUserQuestionData,
  MemoryCategory,
  MemoryEntry,
  MemoryQueryResult,
  PermissionRequest,
  PermissionResponse,
} from '../types';
import {
  AUTONOMOUS_DEFAULT_MAX_MEMORY_ENTRIES,
  AUTONOMOUS_MEMORY_DECAY_FACTOR,
  AUTONOMOUS_MEMORY_SYNC_INTERVAL_MS,
} from '../constants';

const GLOBAL_STATE_KEY = 'mysti.autonomousMemory';
const MEMORY_DIR_NAME = 'memory';

interface MemoryStore {
  entries: MemoryEntry[];
  version: number;
}

export class MemoryManager {
  private _entries: MemoryEntry[] = [];
  private _extensionContext: vscode.ExtensionContext;
  private _maxEntries: number;
  private _syncInterval: NodeJS.Timeout | null = null;
  private _dirty = false;
  private _memoryDirPath: string;

  constructor(context: vscode.ExtensionContext) {
    this._extensionContext = context;
    const config = vscode.workspace.getConfiguration('mysti');
    this._maxEntries = config.get('autonomous.maxMemoryEntries', AUTONOMOUS_DEFAULT_MAX_MEMORY_ENTRIES);

    // ~/.mysti/memory/
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    this._memoryDirPath = path.join(homeDir, '.mysti', MEMORY_DIR_NAME);

    this._load();
    this._startSyncInterval();
  }

  /**
   * Add a new memory entry
   */
  addMemory(params: {
    category: MemoryCategory;
    content: string;
    context: string;
    confidence?: number;
    tags?: string[];
  }): void {
    const entry: MemoryEntry = {
      id: this._generateId(),
      category: params.category,
      content: params.content,
      context: params.context,
      confidence: params.confidence ?? 0.8,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
      tags: params.tags ?? [],
    };

    this._entries.push(entry);
    this._dirty = true;
    this._prune();
    this._saveToGlobalState();
  }

  /**
   * Query memory for entries matching the given context string.
   * Uses keyword/tag matching with relevance scoring.
   */
  query(context: string, limit = 5): MemoryQueryResult[] {
    const contextLower = context.toLowerCase();
    const contextWords = contextLower.split(/\s+/).filter(w => w.length > 2);

    const scored: MemoryQueryResult[] = [];

    for (const entry of this._entries) {
      let score = 0;

      // Tag matching (highest weight)
      for (const tag of entry.tags) {
        if (contextLower.includes(tag.toLowerCase())) {
          score += 3;
        }
      }

      // Content/context keyword matching
      const entryText = `${entry.content} ${entry.context}`.toLowerCase();
      for (const word of contextWords) {
        if (entryText.includes(word)) {
          score += 1;
        }
      }

      // Boost by confidence and recency
      score *= entry.confidence;
      const daysSinceAccess = (Date.now() - entry.lastAccessedAt) / (1000 * 60 * 60 * 24);
      score *= Math.pow(AUTONOMOUS_MEMORY_DECAY_FACTOR, daysSinceAccess);

      if (score > 0) {
        scored.push({ entry, relevanceScore: score });
      }
    }

    // Sort by relevance, return top N
    scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
    const results = scored.slice(0, limit);

    // Update access stats for returned entries
    for (const result of results) {
      result.entry.lastAccessedAt = Date.now();
      result.entry.accessCount++;
    }
    if (results.length > 0) {
      this._dirty = true;
    }

    return results;
  }

  /**
   * Get recent memories regardless of context
   */
  getRecentMemories(limit = 10): MemoryEntry[] {
    return [...this._entries]
      .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
      .slice(0, limit);
  }

  /**
   * Learn from a user's permission decision (passive - works even outside autonomous mode)
   */
  learnFromPermissionDecision(request: PermissionRequest, response: PermissionResponse): void {
    const decision = response.decision === 'approve' || response.decision === 'always-allow'
      ? 'approved' : 'denied';

    const tags = [request.actionType, decision];
    if (request.details.filePath) {
      const ext = path.extname(request.details.filePath);
      if (ext) { tags.push(ext); }
    }
    if (request.details.command) {
      const firstWord = request.details.command.trim().split(/\s+/)[0];
      if (firstWord) { tags.push(firstWord); }
    }

    this.addMemory({
      category: 'permission-preference',
      content: `User ${decision} ${request.actionType}: ${request.title}`,
      context: request.description,
      confidence: response.decision === 'always-allow' ? 1.0 : 0.8,
      tags,
    });
  }

  /**
   * Learn from a user's answer to an AskUserQuestion (passive)
   */
  learnFromQuestionAnswer(
    question: AskUserQuestionData,
    answers: Record<string, string | string[]>
  ): void {
    for (const q of question.questions) {
      const answer = answers[q.header];
      if (!answer) { continue; }

      const formattedAnswer = Array.isArray(answer) ? answer.join(', ') : answer;
      const tags = [q.header.toLowerCase()];

      // Extract option labels as tags
      for (const opt of q.options) {
        tags.push(opt.label.toLowerCase());
      }

      this.addMemory({
        category: 'question-preference',
        content: `Q: "${q.question}" -> A: "${formattedAnswer}"`,
        context: `${q.header}: ${q.options.map(o => o.label).join(', ')}`,
        confidence: 0.8,
        tags,
      });
    }
  }

  /**
   * Record project-level context (tech stack, conventions, etc.)
   */
  recordProjectContext(key: string, value: string): void {
    // Check if we already have this context and update it
    const existing = this._entries.find(
      e => e.category === 'project-context' && e.tags.includes(key)
    );

    if (existing) {
      existing.content = value;
      existing.lastAccessedAt = Date.now();
      existing.confidence = Math.min(1.0, existing.confidence + 0.05);
      this._dirty = true;
      this._saveToGlobalState();
      return;
    }

    this.addMemory({
      category: 'project-context',
      content: value,
      context: key,
      confidence: 0.9,
      tags: [key],
    });
  }

  /**
   * Returns a structured description of Mysti's capabilities.
   * Used to give the autonomous agent self-awareness of what it can do.
   */
  getMystiCapabilities(): string {
    return [
      'Mysti is a VSCode extension providing a unified AI coding assistant interface.',
      'Supported providers: Claude Code CLI, OpenAI Codex CLI, Google Gemini CLI, Cline, GitHub Copilot CLI, Cursor, OpenClaw.',
      'Features: sidebar/tab chat panels, conversation persistence, multi-agent brainstorm mode, permission controls, plan selection, and a three-tier agent loading system.',
      'Operation modes: ask-before-edit, edit-automatically, quick-plan, detailed-plan.',
      'Access levels: read-only, ask-permission, full-access.',
      'Capabilities: file reading/creation/editing, bash command execution, web requests, multi-file edits.',
      'Safety: file deletion and destructive operations are always blocked in autonomous mode.',
    ].join('\n');
  }

  /**
   * Get all memories for a specific category
   */
  getByCategory(category: MemoryCategory): MemoryEntry[] {
    return this._entries.filter(e => e.category === category);
  }

  /**
   * Get total memory count
   */
  getEntryCount(): number {
    return this._entries.length;
  }

  /**
   * Clear all memories (user-initiated)
   */
  clearAll(): void {
    this._entries = [];
    this._dirty = true;
    this._saveToGlobalState();
    this._syncToFiles();
  }

  dispose(): void {
    if (this._syncInterval) {
      clearInterval(this._syncInterval);
      this._syncInterval = null;
    }
    // Final save
    if (this._dirty) {
      this._saveToGlobalState();
      this._syncToFiles();
    }
  }

  // ---- Persistence ----

  private _load(): void {
    // Load from globalState first (fast cache)
    this._loadFromGlobalState();
    // Then merge with file-based long-term memory
    this._loadFromFiles();
  }

  private _loadFromGlobalState(): void {
    try {
      const stored = this._extensionContext.globalState.get<MemoryStore>(GLOBAL_STATE_KEY);
      if (stored?.entries) {
        this._entries = stored.entries;
        console.log(`[Mysti] MemoryManager: Loaded ${this._entries.length} entries from globalState`);
      }
    } catch (error) {
      console.error('[Mysti] MemoryManager: Failed to load from globalState:', error);
    }
  }

  private async _saveToGlobalState(): Promise<void> {
    try {
      const store: MemoryStore = {
        entries: this._entries,
        version: 1,
      };
      await this._extensionContext.globalState.update(GLOBAL_STATE_KEY, store);
      this._dirty = false;
    } catch (error) {
      console.error('[Mysti] MemoryManager: Failed to save to globalState:', error);
    }
  }

  private _loadFromFiles(): void {
    try {
      const prefsPath = path.join(this._memoryDirPath, 'preferences.json');
      if (fs.existsSync(prefsPath)) {
        const data = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
        if (Array.isArray(data.entries)) {
          // Merge file entries that aren't already in memory (by id)
          const existingIds = new Set(this._entries.map(e => e.id));
          let merged = 0;
          for (const entry of data.entries) {
            if (!existingIds.has(entry.id)) {
              this._entries.push(entry);
              merged++;
            }
          }
          if (merged > 0) {
            console.log(`[Mysti] MemoryManager: Merged ${merged} entries from files`);
            this._prune();
          }
        }
      }
    } catch (error) {
      console.log('[Mysti] MemoryManager: No file-based memory found (first run)');
    }
  }

  private _syncToFiles(): void {
    try {
      // Ensure directory exists
      fs.mkdirSync(this._memoryDirPath, { recursive: true });

      const prefsPath = path.join(this._memoryDirPath, 'preferences.json');
      const data = {
        version: 1,
        lastSync: Date.now(),
        entries: this._entries,
      };
      fs.writeFileSync(prefsPath, JSON.stringify(data, null, 2), 'utf-8');
      console.log(`[Mysti] MemoryManager: Synced ${this._entries.length} entries to ${prefsPath}`);
    } catch (error) {
      console.error('[Mysti] MemoryManager: Failed to sync to files:', error);
    }
  }

  private _startSyncInterval(): void {
    this._syncInterval = setInterval(() => {
      if (this._dirty) {
        this._syncToFiles();
        this._dirty = false;
      }
    }, AUTONOMOUS_MEMORY_SYNC_INTERVAL_MS);
  }

  /**
   * Remove oldest/least-accessed entries when over capacity
   */
  private _prune(): void {
    if (this._entries.length <= this._maxEntries) { return; }

    // Apply confidence decay
    const now = Date.now();
    for (const entry of this._entries) {
      const daysSinceCreation = (now - entry.createdAt) / (1000 * 60 * 60 * 24);
      entry.confidence *= Math.pow(AUTONOMOUS_MEMORY_DECAY_FACTOR, daysSinceCreation / 30);
    }

    // Sort by a combined score of confidence, recency, and access count
    this._entries.sort((a, b) => {
      const scoreA = a.confidence * 0.5 + (a.lastAccessedAt / now) * 0.3 + Math.min(a.accessCount / 10, 1) * 0.2;
      const scoreB = b.confidence * 0.5 + (b.lastAccessedAt / now) * 0.3 + Math.min(b.accessCount / 10, 1) * 0.2;
      return scoreB - scoreA;
    });

    // Remove entries below confidence threshold or over max
    this._entries = this._entries
      .filter(e => e.confidence > 0.1)
      .slice(0, this._maxEntries);
  }

  private _generateId(): string {
    return `mem_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }
}
