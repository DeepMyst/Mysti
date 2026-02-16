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
import * as os from 'os';

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
export type AgentType = 'persona' | 'skill';

/**
 * Loading tier level
 */
export type LoadingTier = 'metadata' | 'instructions' | 'full';

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

  // Source directories
  private _sourceDirs: { path: string; source: AgentMetadata['source'] }[] = [];

  constructor(context: vscode.ExtensionContext) {
    this._extensionContext = context;
    this._initializeSourceDirs();
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
  public async loadAllMetadata(): Promise<{ personas: AgentMetadata[]; skills: AgentMetadata[] }> {
    const personas: AgentMetadata[] = [];
    const skills: AgentMetadata[] = [];

    for (const sourceDir of this._sourceDirs) {
      // Load personas
      const personasDir = path.join(sourceDir.path, 'personas');
      const personaFiles = await this._getMarkdownFiles(personasDir);

      for (const filePath of personaFiles) {
        try {
          const metadata = await this._loadMetadata(filePath, sourceDir.source);
          if (metadata) {
            this._metadataCache.set(metadata.id, metadata);
            this._agentTypes.set(metadata.id, 'persona');
            personas.push(metadata);
          }
        } catch (error) {
          console.error(`[Mysti] Failed to load persona metadata: ${filePath}`, error);
        }
      }

      // Load skills
      const skillsDir = path.join(sourceDir.path, 'skills');
      const skillFiles = await this._getMarkdownFiles(skillsDir);

      for (const filePath of skillFiles) {
        try {
          const metadata = await this._loadMetadata(filePath, sourceDir.source);
          if (metadata) {
            this._metadataCache.set(metadata.id, metadata);
            this._agentTypes.set(metadata.id, 'skill');
            skills.push(metadata);
          }
        } catch (error) {
          console.error(`[Mysti] Failed to load skill metadata: ${filePath}`, error);
        }
      }
    }

    return { personas, skills };
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
      const content = await fs.promises.readFile(metadata.filePath, 'utf-8');
      const parsed = this._parseMarkdown(content);

      const instructions: AgentInstructions = {
        ...metadata,
        instructions: this._extractInstructions(parsed.body),
        communicationStyle: this._extractSection(parsed.body, 'Communication Style'),
        priorities: this._extractList(parsed.body, 'Priorities'),
        bestPractices: this._extractList(parsed.body, 'Best Practices'),
        antiPatterns: this._extractList(parsed.body, 'Anti-Patterns to Avoid')
      };

      this._instructionsCache.set(agentId, instructions);
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
      const content = await fs.promises.readFile(instructions.filePath, 'utf-8');
      const parsed = this._parseMarkdown(content);

      const full: AgentFull = {
        ...instructions,
        codeExamples: this._extractSection(parsed.body, 'Code Examples'),
        fullContent: parsed.body
      };

      this._fullCache.set(agentId, full);
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

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  /**
   * Get all markdown files in a directory
   */
  private async _getMarkdownFiles(dirPath: string): Promise<string[]> {
    try {
      const exists = await fs.promises.access(dirPath).then(() => true).catch(() => false);
      if (!exists) {
        return [];
      }

      const files = await fs.promises.readdir(dirPath);
      return files
        .filter(f => f.endsWith('.md'))
        .map(f => path.join(dirPath, f));
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
      const parsed = this._parseMarkdown(content);

      if (!parsed.frontmatter.id) {
        console.warn(`[Mysti] Missing 'id' in frontmatter: ${filePath}`);
        return null;
      }

      return {
        id: String(parsed.frontmatter.id),
        name: String(parsed.frontmatter.name || parsed.frontmatter.id),
        description: String(parsed.frontmatter.description || ''),
        icon: parsed.frontmatter.icon ? String(parsed.frontmatter.icon) : undefined,
        category: String(parsed.frontmatter.category || 'general'),
        source,
        filePath,
        activationTriggers: Array.isArray(parsed.frontmatter.activationTriggers)
          ? parsed.frontmatter.activationTriggers.map(t => String(t))
          : undefined
      };
    } catch (error) {
      console.error(`[Mysti] Failed to parse: ${filePath}`, error);
      return null;
    }
  }

  /**
   * Parse markdown with YAML frontmatter
   */
  private _parseMarkdown(content: string): { frontmatter: Record<string, unknown>; body: string } {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

    if (!frontmatterMatch) {
      return { frontmatter: {}, body: content };
    }

    const frontmatterStr = frontmatterMatch[1];
    const body = frontmatterMatch[2];

    // Simple YAML parsing (handles basic key: value and arrays)
    const frontmatter: Record<string, unknown> = {};
    let currentKey: string | null = null;
    let currentArray: string[] | null = null;

    for (const line of frontmatterStr.split('\n')) {
      const trimmed = line.trim();

      // Array item
      if (trimmed.startsWith('- ') && currentKey) {
        if (!currentArray) {
          currentArray = [];
        }
        currentArray.push(trimmed.slice(2).trim());
        frontmatter[currentKey] = currentArray;
      }
      // Key-value pair
      else if (trimmed.includes(':')) {
        // Save previous array if any
        if (currentKey && currentArray) {
          frontmatter[currentKey] = currentArray;
        }

        const colonIndex = trimmed.indexOf(':');
        const key = trimmed.slice(0, colonIndex).trim();
        const value = trimmed.slice(colonIndex + 1).trim();

        currentKey = key;
        currentArray = null;

        if (value) {
          frontmatter[key] = value;
        }
      }
    }

    return { frontmatter, body };
  }

  /**
   * Extract main instructions from markdown body
   * For personas: Key Characteristics section
   * For skills: Instructions section
   */
  private _extractInstructions(body: string): string {
    // Try to extract Key Characteristics (for personas)
    let instructions = this._extractSection(body, 'Key Characteristics');

    // Fallback to Instructions (for skills)
    if (!instructions) {
      instructions = this._extractSection(body, 'Instructions');
    }

    // Fallback to first paragraph
    if (!instructions) {
      const firstParagraph = body.split('\n\n')[0];
      instructions = firstParagraph.replace(/^#.*\n/, '').trim();
    }

    return instructions;
  }

  /**
   * Extract a specific section from markdown body
   */
  private _extractSection(body: string, sectionName: string): string | undefined {
    const regex = new RegExp(`## ${sectionName}\\n([\\s\\S]*?)(?=\\n## |$)`, 'i');
    const match = body.match(regex);
    return match ? match[1].trim() : undefined;
  }

  /**
   * Extract a list from a section
   */
  private _extractList(body: string, sectionName: string): string[] | undefined {
    const section = this._extractSection(body, sectionName);
    if (!section) {return undefined;}

    const items: string[] = [];
    const lines = section.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || /^\d+\.\s/.test(trimmed)) {
        items.push(trimmed.replace(/^[-*]\s|^\d+\.\s/, '').trim());
      }
    }

    return items.length > 0 ? items : undefined;
  }
}
