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
import * as crypto from 'crypto';
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
const PROJECT_MEMORY_MAX_LINES = 200;

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
  // Per-project auto-memory (like ~/.claude/projects/<project>/memory/)
  private _projectMemoryDir: string | null = null;
  private _projectMemoryContent: string = '';

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

  // ---- Per-Project Auto-Memory (like ~/.claude/projects/<project>/memory/) ----

  /**
   * Initialize per-project memory for the current workspace.
   * Creates ~/.mysti/projects/<hash>/memory/ directory and loads MEMORY.md.
   */
  initProjectMemory(workspacePath: string): void {
    const hash = crypto.createHash('sha256').update(workspacePath).digest('hex').substring(0, 12);
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    this._projectMemoryDir = path.join(homeDir, '.mysti', 'projects', hash, 'memory');

    try {
      fs.mkdirSync(this._projectMemoryDir, { recursive: true });
    } catch (error) {
      console.warn('[Mysti] Failed to create project memory dir:', error);
      this._projectMemoryDir = null;
      return;
    }

    this._loadProjectMemory();
    console.log(`[Mysti] Project memory initialized at ${this._projectMemoryDir} (${this._projectMemoryContent.length} chars)`);
  }

  /**
   * Get the first 200 lines of MEMORY.md for prompt injection.
   */
  getProjectMemoryContent(): string {
    return this._projectMemoryContent;
  }

  /**
   * Get the path to the project's MEMORY.md file, or null if not initialized.
   */
  getProjectMemoryPath(): string | null {
    if (!this._projectMemoryDir) { return null; }
    return path.join(this._projectMemoryDir, 'MEMORY.md');
  }

  /**
   * Write or update the MEMORY.md file with new content.
   */
  writeProjectMemory(content: string): void {
    if (!this._projectMemoryDir) { return; }

    const memoryPath = path.join(this._projectMemoryDir, 'MEMORY.md');
    try {
      fs.writeFileSync(memoryPath, content, 'utf-8');
      this._loadProjectMemory(); // Reload cached content (respects 200 line limit)
    } catch (error) {
      console.error('[Mysti] Failed to write project memory:', error);
    }
  }

  /**
   * Write or update a topic file in the project memory directory.
   */
  writeTopicFile(topic: string, content: string): void {
    if (!this._projectMemoryDir) { return; }

    const safeName = topic.replace(/[^a-z0-9-]/gi, '-').toLowerCase() + '.md';
    const filePath = path.join(this._projectMemoryDir, safeName);
    try {
      fs.writeFileSync(filePath, content, 'utf-8');
    } catch (error) {
      console.error(`[Mysti] Failed to write topic file ${safeName}:`, error);
    }
  }

  /**
   * Read a topic file from the project memory directory.
   */
  readTopicFile(topic: string): string | null {
    if (!this._projectMemoryDir) { return null; }

    const safeName = topic.replace(/[^a-z0-9-]/gi, '-').toLowerCase() + '.md';
    const filePath = path.join(this._projectMemoryDir, safeName);
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf-8');
      }
    } catch (error) {
      console.warn(`[Mysti] Failed to read topic file ${safeName}:`, error);
    }
    return null;
  }

  /**
   * Record a project learning. Appends to MEMORY.md under the appropriate section.
   * Creates MEMORY.md with default structure if it doesn't exist.
   */
  recordProjectLearning(section: string, insight: string): void {
    if (!this._projectMemoryDir) { return; }

    const memoryPath = path.join(this._projectMemoryDir, 'MEMORY.md');
    let content: string;

    try {
      content = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf-8') : '';
    } catch {
      content = '';
    }

    // If empty, create default structure
    if (!content.trim()) {
      content = '# Mysti Project Memory\n';
    }

    // Find or create the section
    const sectionHeader = `## ${section}`;
    const sectionIndex = content.indexOf(sectionHeader);

    if (sectionIndex >= 0) {
      // Find the end of this section (next ## or end of file)
      const afterHeader = sectionIndex + sectionHeader.length;
      const nextSectionMatch = content.substring(afterHeader).search(/\n## /);
      const insertPoint = nextSectionMatch >= 0
        ? afterHeader + nextSectionMatch
        : content.length;

      // Check if this insight already exists (dedup)
      const sectionContent = content.substring(afterHeader, insertPoint);
      if (sectionContent.includes(insight)) {
        return; // Already recorded
      }

      // Insert before next section
      content = content.substring(0, insertPoint) + `\n- ${insight}` + content.substring(insertPoint);
    } else {
      // Append new section at end
      content += `\n${sectionHeader}\n\n- ${insight}\n`;
    }

    this.writeProjectMemory(content);
  }

  private _loadProjectMemory(): void {
    if (!this._projectMemoryDir) { return; }

    const memoryPath = path.join(this._projectMemoryDir, 'MEMORY.md');
    try {
      if (fs.existsSync(memoryPath)) {
        const full = fs.readFileSync(memoryPath, 'utf-8');
        // Only load first 200 lines (like Claude Code)
        const lines = full.split('\n');
        this._projectMemoryContent = lines.slice(0, PROJECT_MEMORY_MAX_LINES).join('\n');
      } else {
        this._projectMemoryContent = '';
      }
    } catch (error) {
      console.warn('[Mysti] Failed to load project memory:', error);
      this._projectMemoryContent = '';
    }
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
