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
/**
 * Represents a parsed rule file from .mysti/rules/
 */
interface RuleFile {
  paths: string[] | null; // null = global rule (always loaded)
  content: string;
  filePath: string;
}

/**
 * Result of scanning the workspace for project characteristics.
 */
export interface WorkspaceScanResult {
  language: string | null;
  framework: string | null;
  buildCommands: string[];
  testCommands: string[];
  directories: Record<string, boolean>;
  dependencies: string[];
  lintConfig: string | null;
  tsConfig: { strict?: boolean; target?: string } | null;
}

/**
 * ProjectContextManager owns reading mysti.md and .mysti/rules/ for prompt injection.
 * It never auto-modifies mysti.md — that's the user's file.
 * Matches Claude Code's architecture: CLAUDE.md (user-written) + .claude/rules/ (path-specific).
 */
export class ProjectContextManager {
  private _mystiMdContent: string = '';
  private _mystiMdPath: string | null = null;
  private _rules: RuleFile[] = [];
  private _watchers: vscode.FileSystemWatcher[] = [];
  private _workspaceRoot: string | null = null;

  constructor(_context: vscode.ExtensionContext) {
    // Context reserved for future use (e.g., globalState caching)
  }

  /**
   * Initialize: read mysti.md, discover rules, set up file watchers.
   */
  public async initialize(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return;
    }

    this._workspaceRoot = workspaceFolders[0].uri.fsPath;

    await this._loadMystiMd();
    await this._loadRules();
    this._setupWatchers();

    console.log('[Mysti] ProjectContextManager initialized' +
      (this._mystiMdContent ? ` (mysti.md: ${this._mystiMdContent.length} chars)` : ' (no mysti.md found)') +
      ` (${this._rules.length} rule files)`);
  }

  /**
   * Get the current mysti.md content for prompt injection.
   */
  public getMystiMdContent(): string {
    return this._mystiMdContent;
  }

  /**
   * Get the path to the loaded mysti.md file, or null if none found.
   */
  public getMystiMdPath(): string | null {
    return this._mystiMdPath;
  }

  /**
   * Read all global rules (rules without path restrictions).
   * Returns concatenated content or empty string.
   */
  public readRules(): string {
    const globalRules = this._rules
      .filter(r => r.paths === null)
      .map(r => r.content);

    return globalRules.join('\n\n');
  }

  /**
   * Get rules that apply to a specific file path.
   * Returns global rules + any path-specific rules that match.
   */
  public getActiveRulesForPath(filePath: string): string {
    if (!this._workspaceRoot) {
      return this.readRules();
    }

    const relativePath = path.relative(this._workspaceRoot, filePath);
    const activeRules: string[] = [];

    for (const rule of this._rules) {
      if (rule.paths === null) {
        // Global rule — always included
        activeRules.push(rule.content);
      } else {
        // Path-specific rule — check if any pattern matches
        const matches = rule.paths.some(pattern => this._matchGlob(relativePath, pattern));
        if (matches) {
          activeRules.push(rule.content);
        }
      }
    }

    return activeRules.join('\n\n');
  }

  /**
   * Re-read mysti.md and rules from disk (called on file changes).
   */
  public async reload(): Promise<void> {
    await this._loadMystiMd();
    await this._loadRules();
    console.log('[Mysti] ProjectContextManager reloaded');
  }

  /**
   * Scan workspace for project characteristics.
   * Used by /init-team to generate meaningful mysti.md content.
   */
  public async scanWorkspace(): Promise<WorkspaceScanResult> {
    if (!this._workspaceRoot) {
      return {
        language: null, framework: null, buildCommands: [], testCommands: [],
        directories: {}, dependencies: [], lintConfig: null, tsConfig: null,
      };
    }

    const root = this._workspaceRoot;
    const result: WorkspaceScanResult = {
      language: null, framework: null, buildCommands: [], testCommands: [],
      directories: {}, dependencies: [], lintConfig: null, tsConfig: null,
    };

    // Check directories
    const dirNames = ['src', 'lib', 'tests', '__tests__', 'test', 'docs', 'scripts', 'public', 'app'];
    for (const dir of dirNames) {
      result.directories[dir] = fs.existsSync(path.join(root, dir));
    }

    // Check package.json (Node.js/TypeScript)
    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        result.language = 'JavaScript';

        // Detect TypeScript
        const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        if (allDeps['typescript'] || fs.existsSync(path.join(root, 'tsconfig.json'))) {
          result.language = 'TypeScript';
        }

        // Detect framework
        if (allDeps['react']) { result.framework = 'React'; }
        if (allDeps['next']) { result.framework = 'Next.js'; }
        if (allDeps['vue']) { result.framework = 'Vue'; }
        if (allDeps['nuxt']) { result.framework = 'Nuxt'; }
        if (allDeps['@angular/core']) { result.framework = 'Angular'; }
        if (allDeps['svelte']) { result.framework = 'Svelte'; }
        if (allDeps['express']) { result.framework = result.framework ? `${result.framework} + Express` : 'Express'; }
        if (allDeps['fastify']) { result.framework = result.framework ? `${result.framework} + Fastify` : 'Fastify'; }

        // Extract scripts
        if (pkg.scripts) {
          if (pkg.scripts.build) { result.buildCommands.push(`npm run build`); }
          if (pkg.scripts.compile) { result.buildCommands.push(`npm run compile`); }
          if (pkg.scripts.test) { result.testCommands.push(`npm run test`); }
          if (pkg.scripts.lint) { result.buildCommands.push(`npm run lint`); }
        }

        // Key dependencies
        const deps = Object.keys(allDeps).slice(0, 15);
        result.dependencies = deps;
      } catch {
        // Ignore malformed package.json
      }
    }

    // Check Python
    if (!result.language) {
      if (fs.existsSync(path.join(root, 'requirements.txt')) ||
          fs.existsSync(path.join(root, 'pyproject.toml')) ||
          fs.existsSync(path.join(root, 'setup.py'))) {
        result.language = 'Python';
      }
    }

    // Check Rust
    if (!result.language && fs.existsSync(path.join(root, 'Cargo.toml'))) {
      result.language = 'Rust';
      result.buildCommands.push('cargo build');
      result.testCommands.push('cargo test');
    }

    // Check Go
    if (!result.language && fs.existsSync(path.join(root, 'go.mod'))) {
      result.language = 'Go';
      result.buildCommands.push('go build ./...');
      result.testCommands.push('go test ./...');
    }

    // Check Makefile
    if (fs.existsSync(path.join(root, 'Makefile'))) {
      result.buildCommands.push('make');
    }

    // Check tsconfig.json
    const tsconfigPath = path.join(root, 'tsconfig.json');
    if (fs.existsSync(tsconfigPath)) {
      try {
        const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8'));
        result.tsConfig = {
          strict: tsconfig.compilerOptions?.strict,
          target: tsconfig.compilerOptions?.target,
        };
      } catch {
        // Ignore
      }
    }

    // Check ESLint
    const eslintFiles = ['.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', 'eslint.config.js', 'eslint.config.mjs'];
    for (const f of eslintFiles) {
      if (fs.existsSync(path.join(root, f))) {
        result.lintConfig = f;
        break;
      }
    }

    return result;
  }

  /**
   * Generate mysti.md content from a workspace scan result.
   */
  public generateMystiMdContent(projectName: string, scan: WorkspaceScanResult): string {
    const lines: string[] = [
      `# ${projectName} — Mysti Project Config`,
      '',
      'This project uses [Mysti](https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti) for AI-assisted development.',
      '',
    ];

    // Project Overview
    lines.push('## Project Overview', '');
    const overview: string[] = [];
    if (scan.language) { overview.push(scan.language); }
    if (scan.framework) { overview.push(scan.framework); }
    if (overview.length > 0) {
      let overviewLine = overview.join(' + ') + ' project.';
      if (scan.buildCommands.length > 0) {
        overviewLine += ` Build with \`${scan.buildCommands[0]}\`.`;
      }
      if (scan.testCommands.length > 0) {
        overviewLine += ` Test with \`${scan.testCommands[0]}\`.`;
      }
      lines.push(overviewLine);
    } else {
      lines.push('<!-- Describe your project here -->');
    }
    lines.push('');

    // Project Structure
    const presentDirs = Object.entries(scan.directories).filter(([, exists]) => exists);
    if (presentDirs.length > 0) {
      lines.push('## Project Structure', '');
      for (const [dir] of presentDirs) {
        lines.push(`- \`${dir}/\``);
      }
      lines.push('');
    }

    // Build Commands
    if (scan.buildCommands.length > 0 || scan.testCommands.length > 0) {
      lines.push('## Build Commands', '');
      for (const cmd of scan.buildCommands) {
        lines.push(`- \`${cmd}\``);
      }
      for (const cmd of scan.testCommands) {
        lines.push(`- \`${cmd}\``);
      }
      lines.push('');
    }

    // Conventions
    lines.push('## Conventions', '');
    if (scan.tsConfig?.strict) {
      lines.push('- TypeScript strict mode enabled');
    }
    if (scan.lintConfig) {
      lines.push(`- ESLint configured (${scan.lintConfig})`);
    }
    lines.push('<!-- Add your coding conventions here -->', '');

    // Notes
    lines.push('## Notes', '');
    lines.push('<!-- Additional context for Mysti -->', '');

    return lines.join('\n');
  }

  /**
   * Load mysti.md from workspace root.
   * Checks: mysti.md, MYSTI.md, .mysti/mysti.md
   */
  private async _loadMystiMd(): Promise<void> {
    if (!this._workspaceRoot) {
      return;
    }

    const candidates = [
      path.join(this._workspaceRoot, 'mysti.md'),
      path.join(this._workspaceRoot, 'MYSTI.md'),
      path.join(this._workspaceRoot, '.mysti', 'mysti.md'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        try {
          this._mystiMdContent = fs.readFileSync(candidate, 'utf-8');
          this._mystiMdPath = candidate;
          return;
        } catch (error) {
          console.warn(`[Mysti] Failed to read ${candidate}:`, error);
        }
      }
    }

    // No mysti.md found
    this._mystiMdContent = '';
    this._mystiMdPath = null;
  }

  /**
   * Load all rule files from .mysti/rules/
   */
  private async _loadRules(): Promise<void> {
    if (!this._workspaceRoot) {
      return;
    }

    this._rules = [];
    const rulesDir = path.join(this._workspaceRoot, '.mysti', 'rules');

    if (!fs.existsSync(rulesDir)) {
      return;
    }

    let files: string[];
    try {
      files = fs.readdirSync(rulesDir).filter(f => f.endsWith('.md'));
    } catch {
      return;
    }

    for (const file of files) {
      const filePath = path.join(rulesDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const parsed = this._parseFrontmatter(content);

        let paths: string[] | null = null;
        if (Array.isArray(parsed.frontmatter.paths)) {
          paths = parsed.frontmatter.paths.map((p: unknown) => String(p));
        }

        this._rules.push({
          paths,
          content: parsed.body.trim(),
          filePath,
        });
      } catch (error) {
        console.warn(`[Mysti] Failed to read rule file ${filePath}:`, error);
      }
    }
  }

  /**
   * Parse markdown with optional YAML frontmatter.
   * Reuses the same pattern as AgentLoader._parseMarkdown.
   */
  private _parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

    if (!match) {
      return { frontmatter: {}, body: content };
    }

    const frontmatterStr = match[1];
    const body = match[2];

    const frontmatter: Record<string, unknown> = {};
    let currentKey: string | null = null;
    let currentArray: string[] | null = null;

    for (const line of frontmatterStr.split('\n')) {
      const trimmed = line.trim();

      if (trimmed.startsWith('- ') && currentKey) {
        if (!currentArray) {
          currentArray = [];
        }
        currentArray.push(trimmed.slice(2).trim());
        frontmatter[currentKey] = currentArray;
      } else if (trimmed.includes(':')) {
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
   * Set up file watchers for mysti.md and rules changes.
   */
  private _setupWatchers(): void {
    if (!this._workspaceRoot) {
      return;
    }

    // Watch mysti.md at root
    const mystiMdWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this._workspaceRoot, '{mysti.md,MYSTI.md,.mysti/mysti.md}')
    );
    mystiMdWatcher.onDidChange(() => this._loadMystiMd());
    mystiMdWatcher.onDidCreate(() => this._loadMystiMd());
    mystiMdWatcher.onDidDelete(() => this._loadMystiMd());
    this._watchers.push(mystiMdWatcher);

    // Watch rules directory
    const rulesWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this._workspaceRoot, '.mysti/rules/*.md')
    );
    rulesWatcher.onDidChange(() => this._loadRules());
    rulesWatcher.onDidCreate(() => this._loadRules());
    rulesWatcher.onDidDelete(() => this._loadRules());
    this._watchers.push(rulesWatcher);
  }

  /**
   * Simple glob matching for path-specific rules.
   * Supports * (single segment) and ** (any depth) patterns.
   */
  private _matchGlob(filePath: string, pattern: string): boolean {
    // Normalize separators
    const normalized = filePath.replace(/\\/g, '/');
    // Convert glob to regex: ** -> .*, * -> [^/]*, escape dots
    const regexStr = pattern
      .replace(/\\/g, '/')
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '{{GLOBSTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/\{\{GLOBSTAR\}\}/g, '.*');
    try {
      return new RegExp(`^${regexStr}$`).test(normalized);
    } catch {
      return false;
    }
  }

  public dispose(): void {
    for (const watcher of this._watchers) {
      watcher.dispose();
    }
    this._watchers = [];
    console.log('[Mysti] ProjectContextManager disposed');
  }
}
