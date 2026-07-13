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
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AGENT_FILE_BASENAMES,
  extractAgentInstructions,
  extractAgentList,
  extractAgentSection,
  isSafeAgentId,
  parseAgentMarkdown,
  slugifyAgentId
} from './agentMarkdown';

// ============================================================================
// Agent Types - Three-Tier Loading Structure
// ============================================================================

/**
 * Tier 1: Minimal metadata for UI display (always loaded)
 */
export interface AgentMetadata {
  id: string;
  name: string;
  description: string;
  icon?: string;
  category: string;
  source: 'core' | 'plugin' | 'user' | 'workspace';
  filePath: string;
  activationTriggers?: string[];
  /**
   * Plan 14 (roles only): the access profile a collaborator runs under.
   * Read from the role frontmatter `access:`; defaults to 'read-only' (safe)
   * when a role omits it. Ignored for personas/skills.
   */
  roleAccess?: 'read-only' | 'gated-write';
  /**
   * Plan 14 (roles only): interaction pattern, from frontmatter `pattern:`.
   * Defaults to 'one-shot'.
   */
  rolePattern?: 'one-shot' | 'rounds';
}

/**
 * Tier 2: Instructions for prompt injection (loaded on selection)
 */
export interface AgentInstructions extends AgentMetadata {
  instructions: string;           // Main content for prompt injection
  communicationStyle?: string;
  priorities?: string[];
  bestPractices?: string[];
  antiPatterns?: string[];
}

/**
 * Tier 3: Full content including examples (loaded on demand)
 */
export interface AgentFull extends AgentInstructions {
  codeExamples?: string;          // Code examples section
  fullContent: string;            // Complete markdown content
}

/**
 * Agent type discriminator
 */
export type AgentType = 'persona' | 'skill' | 'role';

/**
 * Loading tier level
 */
export type LoadingTier = 'metadata' | 'instructions' | 'full';

/**
 * Documentation files that live alongside agent definitions but are not
 * agents themselves — never load these from flat directories.
 */
const DOC_FILE_BASENAMES = ['readme.md', 'contributing.md', 'license.md', 'changelog.md', 'code_of_conduct.md'];

// ============================================================================
// AgentLoader - Parses and loads agent definitions from markdown files
// ============================================================================

export class AgentLoader {
  private _extensionContext: vscode.ExtensionContext;

  // Caches for each tier
  private _metadataCache: Map<string, AgentMetadata> = new Map();
  private _instructionsCache: Map<string, AgentInstructions> = new Map();
  private _fullCache: Map<string, AgentFull> = new Map();

  // Type tracking
  private _agentTypes: Map<string, AgentType> = new Map();

  // Bumped on every reload(); in-flight reads from before a reload must
  // not populate the caches with stale content
  private _generation: number = 0;

  // Built-in (core/plugin) ids shadowed by workspace files this load —
  // surfaced to the user as a prompt-injection guard
  private _workspaceShadowedIds: string[] = [];

  // Source directories
  private _sourceDirs: { path: string; source: AgentMetadata['source'] }[] = [];

  constructor(
    context: vscode.ExtensionContext,
    sourceDirsOverride?: { path: string; source: AgentMetadata['source'] }[]
  ) {
    this._extensionContext = context;
    if (sourceDirsOverride) {
      this._sourceDirs = sourceDirsOverride;
    } else {
      this._initializeSourceDirs();
    }
  }

  /**
   * Resolve the base agents directory for a writable scope.
   * Used by the create/import flows to know where to place new files.
   */
  public getScopeBaseDir(scope: 'user' | 'workspace'): string | null {
    if (scope === 'user') {
      return path.join(os.homedir(), '.mysti', 'agents');
    }
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return null;
    }
    return path.join(workspaceFolders[0].uri.fsPath, '.mysti', 'agents');
  }

  /**
   * Initialize source directories in priority order
   */
  private _initializeSourceDirs(): void {
    const extensionPath = this._extensionContext.extensionPath;

    // Core agents (bundled with extension)
    this._sourceDirs.push({
      path: path.join(extensionPath, 'resources', 'agents', 'core'),
      source: 'core'
    });

    // Plugin agents (synced from external sources)
    this._sourceDirs.push({
      path: path.join(extensionPath, 'resources', 'agents', 'plugins'),
      source: 'plugin'
    });

    // User agents (~/.mysti/agents/)
    const userDir = path.join(os.homedir(), '.mysti', 'agents');
    this._sourceDirs.push({
      path: userDir,
      source: 'user'
    });

    // Workspace agents (.mysti/agents/ in workspace root)
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      const workspaceDir = path.join(workspaceFolders[0].uri.fsPath, '.mysti', 'agents');
      this._sourceDirs.push({
        path: workspaceDir,
        source: 'workspace'
      });
    }
  }

  /**
   * Load all agent metadata from all sources (Tier 1)
   * Returns only minimal metadata for fast UI rendering
   */
  public async loadAllMetadata(): Promise<{ personas: AgentMetadata[]; skills: AgentMetadata[]; roles: AgentMetadata[] }> {
    // Dedupe by id: sources are scanned in priority order (core → plugin →
    // user → workspace), so a later source overrides an earlier one. An id
    // can only ever be one type — a workspace skill shadowing a core persona
    // replaces it entirely.
    const personaMap = new Map<string, AgentMetadata>();
    const skillMap = new Map<string, AgentMetadata>();
    const roleMap = new Map<string, AgentMetadata>();
    const shadowed: string[] = [];

    const noteShadowing = (metadata: AgentMetadata): void => {
      if (metadata.source !== 'workspace') {
        return;
      }
      const previous = personaMap.get(metadata.id) || skillMap.get(metadata.id) || roleMap.get(metadata.id);
      if (previous && (previous.source === 'core' || previous.source === 'plugin')) {
        shadowed.push(metadata.id);
      }
    };

    // A single id maps to exactly one kind; loading it under one kind removes it
    // from the other two so a later source can flip a persona into a role, etc.
    const claimId = (id: string, keep: 'persona' | 'skill' | 'role'): void => {
      if (keep !== 'persona') { personaMap.delete(id); }
      if (keep !== 'skill') { skillMap.delete(id); }
      if (keep !== 'role') { roleMap.delete(id); }
    };

    for (const sourceDir of this._sourceDirs) {
      // Load personas
      const personasDir = path.join(sourceDir.path, 'personas');
      const personaFiles = await this._collectAgentFiles(personasDir);

      for (const filePath of personaFiles) {
        try {
          const metadata = await this._loadMetadata(filePath, sourceDir.source);
          if (metadata) {
            noteShadowing(metadata);
            this._metadataCache.set(metadata.id, metadata);
            this._agentTypes.set(metadata.id, 'persona');
            claimId(metadata.id, 'persona');
            personaMap.set(metadata.id, metadata);
          }
        } catch (error) {
          console.error(`[Mysti] Failed to load persona metadata: ${filePath}`, error);
        }
      }

      // Load skills
      const skillsDir = path.join(sourceDir.path, 'skills');
      const skillFiles = await this._collectAgentFiles(skillsDir);

      for (const filePath of skillFiles) {
        try {
          const metadata = await this._loadMetadata(filePath, sourceDir.source);
          if (metadata) {
            noteShadowing(metadata);
            this._metadataCache.set(metadata.id, metadata);
            this._agentTypes.set(metadata.id, 'skill');
            claimId(metadata.id, 'skill');
            skillMap.set(metadata.id, metadata);
          }
        } catch (error) {
          console.error(`[Mysti] Failed to load skill metadata: ${filePath}`, error);
        }
      }

      // Load roles (Plan 14 — collaboration roles: advisor/critic/reviewer/…)
      const rolesDir = path.join(sourceDir.path, 'roles');
      const roleFiles = await this._collectAgentFiles(rolesDir);

      for (const filePath of roleFiles) {
        try {
          const metadata = await this._loadMetadata(filePath, sourceDir.source);
          if (metadata) {
            noteShadowing(metadata);
            this._metadataCache.set(metadata.id, metadata);
            this._agentTypes.set(metadata.id, 'role');
            claimId(metadata.id, 'role');
            roleMap.set(metadata.id, metadata);
          }
        } catch (error) {
          console.error(`[Mysti] Failed to load role metadata: ${filePath}`, error);
        }
      }
    }

    this._workspaceShadowedIds = shadowed;
    return {
      personas: Array.from(personaMap.values()),
      skills: Array.from(skillMap.values()),
      roles: Array.from(roleMap.values()),
    };
  }

  /**
   * Built-in agent ids overridden by workspace files in the last load.
   * A cloned repo replacing a trusted persona is a prompt-injection
   * vector — callers surface this to the user.
   */
  public getWorkspaceShadowedIds(): string[] {
    return [...this._workspaceShadowedIds];
  }

  /** Absolute paths of all agent source directories (for save watchers). */
  public getSourceDirPaths(): string[] {
    return this._sourceDirs.map(d => d.path);
  }

  /**
   * Load agent instructions by ID (Tier 2)
   * Includes main instructions content for prompt injection
   */
  public async loadInstructions(agentId: string): Promise<AgentInstructions | null> {
    // Check cache first
    if (this._instructionsCache.has(agentId)) {
      return this._instructionsCache.get(agentId)!;
    }

    // Need metadata to find file path
    const metadata = this._metadataCache.get(agentId);
    if (!metadata) {
      console.warn(`[Mysti] No metadata found for agent: ${agentId}`);
      return null;
    }

    try {
      const generation = this._generation;
      const content = await fs.promises.readFile(metadata.filePath, 'utf-8');
      const parsed = parseAgentMarkdown(content);

      const instructions: AgentInstructions = {
        ...metadata,
        instructions: extractAgentInstructions(parsed.body),
        communicationStyle: extractAgentSection(parsed.body, 'Communication Style'),
        priorities: extractAgentList(parsed.body, 'Priorities'),
        bestPractices: extractAgentList(parsed.body, 'Best Practices'),
        antiPatterns: extractAgentList(parsed.body, 'Anti-Patterns to Avoid')
      };

      // A reload() completed while we were reading — serve the result
      // but don't poison the fresh caches with pre-reload content
      if (generation === this._generation) {
        this._instructionsCache.set(agentId, instructions);
      }
      return instructions;
    } catch (error) {
      console.error(`[Mysti] Failed to load instructions for: ${agentId}`, error);
      return null;
    }
  }

  /**
   * Load full agent content by ID (Tier 3)
   * Includes all content including code examples
   */
  public async loadFull(agentId: string): Promise<AgentFull | null> {
    // Check cache first
    if (this._fullCache.has(agentId)) {
      return this._fullCache.get(agentId)!;
    }

    // Load instructions first (builds on Tier 2)
    const instructions = await this.loadInstructions(agentId);
    if (!instructions) {
      return null;
    }

    try {
      const generation = this._generation;
      const content = await fs.promises.readFile(instructions.filePath, 'utf-8');
      const parsed = parseAgentMarkdown(content);

      const full: AgentFull = {
        ...instructions,
        codeExamples: extractAgentSection(parsed.body, 'Code Examples'),
        fullContent: parsed.body
      };

      if (generation === this._generation) {
        this._fullCache.set(agentId, full);
      }
      return full;
    } catch (error) {
      console.error(`[Mysti] Failed to load full content for: ${agentId}`, error);
      return null;
    }
  }

  /**
   * Get agent type (persona or skill)
   */
  public getAgentType(agentId: string): AgentType | null {
    return this._agentTypes.get(agentId) || null;
  }

  /**
   * Find agents matching given keywords (for auto-suggestion)
   */
  public findMatchingAgents(query: string): AgentMetadata[] {
    const queryLower = query.toLowerCase();
    const matches: AgentMetadata[] = [];

    for (const metadata of this._metadataCache.values()) {
      // Check activation triggers
      if (metadata.activationTriggers) {
        for (const trigger of metadata.activationTriggers) {
          if (queryLower.includes(trigger.toLowerCase())) {
            matches.push(metadata);
            break;
          }
        }
      }

      // Also check name and description
      if (!matches.includes(metadata)) {
        if (
          metadata.name.toLowerCase().includes(queryLower) ||
          metadata.description.toLowerCase().includes(queryLower)
        ) {
          matches.push(metadata);
        }
      }
    }

    return matches;
  }

  /**
   * Clear all caches and reload
   */
  public async reload(): Promise<void> {
    this._generation++;
    this._metadataCache.clear();
    this._instructionsCache.clear();
    this._fullCache.clear();
    this._agentTypes.clear();
    await this.loadAllMetadata();
  }

  /**
   * Get all cached metadata
   */
  public getAllMetadata(): AgentMetadata[] {
    return Array.from(this._metadataCache.values());
  }

  /**
   * Get personas only
   */
  public getPersonas(): AgentMetadata[] {
    return this.getAllMetadata().filter(m => this._agentTypes.get(m.id) === 'persona');
  }

  /**
   * Get skills only
   */
  public getSkills(): AgentMetadata[] {
    return this.getAllMetadata().filter(m => this._agentTypes.get(m.id) === 'skill');
  }

  /**
   * Get collaboration roles only (Plan 14).
   */
  public getRoles(): AgentMetadata[] {
    return this.getAllMetadata().filter(m => this._agentTypes.get(m.id) === 'role');
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  /**
   * Collect agent definition files in a directory.
   * Two layouts are supported:
   *  - Flat:      `personas/architect.md`, `skills/test-driven.md`
   *  - Directory: `skills/my-skill/SKILL.md` (Anthropic Agent Skills /
   *    gstack convention; also accepts skills.md, persona.md, agent.md,
   *    index.md — case-insensitive)
   */
  private async _collectAgentFiles(dirPath: string): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      const files: string[] = [];

      for (const entry of entries) {
        const lower = entry.name.toLowerCase();
        if (entry.isFile() && lower.endsWith('.md') && !DOC_FILE_BASENAMES.includes(lower)) {
          files.push(path.join(dirPath, entry.name));
        } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const subDir = path.join(dirPath, entry.name);
          try {
            const subEntries = await fs.promises.readdir(subDir, { withFileTypes: true });
            const agentFile = subEntries.find(
              e => e.isFile() && AGENT_FILE_BASENAMES.includes(e.name.toLowerCase())
            );
            if (agentFile) {
              files.push(path.join(subDir, agentFile.name));
            }
          } catch {
            // Unreadable subdirectory — skip
          }
        }
      }

      return files;
    } catch {
      return [];
    }
  }

  /**
   * Load only metadata from a markdown file (Tier 1)
   */
  private async _loadMetadata(filePath: string, source: AgentMetadata['source']): Promise<AgentMetadata | null> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const parsed = parseAgentMarkdown(content);

      // Derive an id when frontmatter lacks one (common in third-party
      // SKILL.md files): prefer the frontmatter name, then the directory
      // name for canonical per-directory files, then the file name.
      const baseName = path.basename(filePath);
      const fallbackName = AGENT_FILE_BASENAMES.includes(baseName.toLowerCase())
        ? path.basename(path.dirname(filePath))
        : baseName;
      const rawId = parsed.frontmatter.id
        ? String(parsed.frontmatter.id)
        : String(parsed.frontmatter.name || '') || fallbackName;
      // Ids flow into DOM attributes and file paths — keep them slugs
      const id = isSafeAgentId(rawId) ? rawId : slugifyAgentId(rawId);

      if (!id) {
        console.warn(`[Mysti] Cannot determine agent id for: ${filePath}`);
        return null;
      }

      // Third-party SKILL.md files (gstack et al.) use `triggers`
      const triggers = Array.isArray(parsed.frontmatter.activationTriggers)
        ? parsed.frontmatter.activationTriggers
        : Array.isArray(parsed.frontmatter.triggers)
          ? parsed.frontmatter.triggers
          : undefined;

      // Role-only frontmatter (Plan 14). Harmless on personas/skills, which
      // simply won't declare these keys.
      const rawAccess = parsed.frontmatter.access ? String(parsed.frontmatter.access) : undefined;
      const roleAccess = rawAccess === 'gated-write' ? 'gated-write' : rawAccess === 'read-only' ? 'read-only' : undefined;
      const rawPattern = parsed.frontmatter.pattern ? String(parsed.frontmatter.pattern) : undefined;
      const rolePattern = rawPattern === 'rounds' ? 'rounds' : rawPattern === 'one-shot' ? 'one-shot' : undefined;

      return {
        id,
        name: String(parsed.frontmatter.name || id),
        description: String(parsed.frontmatter.description || ''),
        icon: parsed.frontmatter.icon ? String(parsed.frontmatter.icon) : undefined,
        category: String(parsed.frontmatter.category || 'general'),
        source,
        filePath,
        activationTriggers: triggers ? triggers.map(t => String(t)) : undefined,
        roleAccess,
        rolePattern
      };
    } catch (error) {
      console.error(`[Mysti] Failed to parse: ${filePath}`, error);
      return null;
    }
  }

}
