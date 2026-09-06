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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ProviderType, NativeCommandOrigin } from '../types';
import {
  NATIVE_COMMAND_SOURCES,
  isValidNativeCommandName,
  type NativeCommandExecution,
  type NativeCommandSource,
} from '../providers/base/NativeCommands';

/**
 * Discovery of the commands a user (or their repo) has authored for a backend.
 *
 * A curated catalog can only ever hold what a CLI ships. The commands people
 * actually reach for — `/design`, a repo's `/deploy-staging`, a team's review
 * checklist — live in that CLI's own command directory and change without a
 * Mysti release. This service reads those directories.
 *
 * It follows the CliDiscoveryService contract: reads are SYNCHRONOUS and come
 * from an in-memory cache, so opening the slash menu never blocks on disk;
 * `refresh()` repopulates in the background and the caller re-posts the menu
 * if anything changed.
 *
 * Everything here is read-only and bounded. Command files are prompt templates
 * authored by whoever can already write to the workspace, so they are treated
 * exactly like the rest of the repo — but a runaway directory must not be able
 * to stall the extension host or blow up a webview payload, hence the caps.
 */

/** Per-provider cache lifetime. The menu is opened far more often than commands change. */
export const NATIVE_COMMAND_TTL_MS = 30 * 1000;

/** Directory recursion depth for `nested` sources. Namespaces are one or two deep in practice. */
const MAX_DEPTH = 3;

/** Upper bound on commands surfaced per provider, newest sources winning. */
const MAX_COMMANDS_PER_PROVIDER = 200;

/** Only this much of a command file is read to recover its description. */
const MAX_HEADER_BYTES = 8 * 1024;

/** A command file is a prompt template; anything larger is not one. */
const MAX_TEMPLATE_BYTES = 256 * 1024;

export interface DiscoveredNativeCommand {
  /** Command name as the backend knows it, e.g. `design` or `frontend:audit`. */
  name: string;
  description: string;
  /** Absolute path of the file backing it — the source for `expand`. */
  filePath: string;
  origin: Extract<NativeCommandOrigin, 'user' | 'project'>;
  execution: NativeCommandExecution;
}

interface CacheEntry {
  commands: DiscoveredNativeCommand[];
  checkedAt: number;
}

/**
 * Minimal filesystem surface, injected so the unit tests can run against a
 * fixture tree without touching the real home directory.
 */
export interface NativeCommandFs {
  readdirSync(dir: string): Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  readFileSync(file: string): string;
  statSize(file: string): number;
}

const REAL_FS: NativeCommandFs = {
  readdirSync: (dir) => fs.readdirSync(dir, { withFileTypes: true }),
  readFileSync: (file) => fs.readFileSync(file, 'utf8'),
  statSize: (file) => fs.statSync(file).size,
};

export interface NativeCommandDiscoveryOptions {
  fs?: NativeCommandFs;
  homeDir?: string;
  /** Resolved lazily so a workspace opened after construction is still seen. */
  getWorkspaceRoot?: () => string | undefined;
  ttlMs?: number;
}

export class NativeCommandDiscovery {
  private readonly _fs: NativeCommandFs;
  private readonly _homeDir: string;
  private readonly _getWorkspaceRoot: () => string | undefined;
  private readonly _ttlMs: number;
  private readonly _cache = new Map<string, CacheEntry>();
  private readonly _inFlight = new Map<string, Promise<DiscoveredNativeCommand[]>>();

  constructor(options: NativeCommandDiscoveryOptions = {}) {
    this._fs = options.fs ?? REAL_FS;
    this._homeDir = options.homeDir ?? os.homedir();
    this._getWorkspaceRoot = options.getWorkspaceRoot ?? (() => undefined);
    this._ttlMs = options.ttlMs ?? NATIVE_COMMAND_TTL_MS;
  }

  /**
   * Cached commands for a provider. Never touches disk, never throws — an
   * unseen provider simply has none yet. Pair with `refresh()`.
   */
  public getCached(providerId: string): DiscoveredNativeCommand[] {
    return this._cache.get(providerId)?.commands ?? [];
  }

  /** True when the cache for this provider is missing or past its TTL. */
  public isStale(providerId: string): boolean {
    const entry = this._cache.get(providerId);
    return !entry || Date.now() - entry.checkedAt >= this._ttlMs;
  }

  /**
   * Rescan a provider's command directories.
   *
   * Resolves to the new list and returns `true` from `refreshIfStale` when the
   * set actually changed, so the caller only re-posts a menu that would look
   * different. Concurrent calls for one provider share a single scan.
   */
  public async refresh(providerId: string): Promise<DiscoveredNativeCommand[]> {
    const existing = this._inFlight.get(providerId);
    if (existing) { return existing; }

    const scan = (async () => {
      const commands = this._scan(providerId);
      this._cache.set(providerId, { commands, checkedAt: Date.now() });
      return commands;
    })().finally(() => {
      this._inFlight.delete(providerId);
    });

    this._inFlight.set(providerId, scan);
    return scan;
  }

  /**
   * Refresh only if the cache is stale. Resolves to `true` when the visible
   * command set changed, which is the caller's cue to re-post the menu.
   */
  public async refreshIfStale(providerId: string): Promise<boolean> {
    if (!this.isStale(providerId)) { return false; }
    const before = this.getCached(providerId);
    const after = await this.refresh(providerId);
    return !sameCommands(before, after);
  }

  /** Drop every cached entry — used when settings or the workspace change. */
  public invalidate(providerId?: string): void {
    if (providerId) {
      this._cache.delete(providerId);
    } else {
      this._cache.clear();
    }
  }

  /**
   * Read a command file and produce the prompt to send for an `expand`
   * command. Returns null when the file is gone or is not a prompt template.
   *
   * `$ARGUMENTS` (Claude/Codex/Cursor convention) and `{{args}}` (Cline
   * workflow convention) are substituted; a template with neither gets the
   * arguments appended, which is what every one of these CLIs does.
   */
  public expandTemplate(filePath: string, args: string): string | null {
    let raw: string;
    try {
      if (this._fs.statSize(filePath) > MAX_TEMPLATE_BYTES) { return null; }
      raw = this._fs.readFileSync(filePath);
    } catch {
      return null;
    }

    const body = stripFrontmatter(raw).trim();
    if (!body) { return null; }

    const trimmedArgs = args.trim();
    if (body.includes('$ARGUMENTS') || body.includes('{{args}}')) {
      return body.split('$ARGUMENTS').join(trimmedArgs).split('{{args}}').join(trimmedArgs);
    }
    return trimmedArgs ? `${body}\n\n${trimmedArgs}` : body;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _scan(providerId: string): DiscoveredNativeCommand[] {
    const sources = NATIVE_COMMAND_SOURCES[providerId as ProviderType];
    if (!sources || sources.length === 0) { return []; }

    // Keyed by command name. Sources are visited in declaration order and a
    // later source never displaces an earlier one, so the per-provider order in
    // NATIVE_COMMAND_SOURCES *is* the precedence rule: project before user,
    // matching how every one of these CLIs resolves a name collision.
    const byName = new Map<string, DiscoveredNativeCommand>();

    for (const source of sources) {
      const root = this._resolveRoot(source);
      if (!root) { continue; }
      for (const found of this._scanSource(root, source)) {
        if (byName.size >= MAX_COMMANDS_PER_PROVIDER) { break; }
        if (!byName.has(found.name)) { byName.set(found.name, found); }
      }
    }

    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private _resolveRoot(source: NativeCommandSource): string | undefined {
    if (source.scope === 'user') {
      return path.join(this._homeDir, source.dir);
    }
    const workspaceRoot = this._getWorkspaceRoot();
    return workspaceRoot ? path.join(workspaceRoot, source.dir) : undefined;
  }

  private _scanSource(root: string, source: NativeCommandSource): DiscoveredNativeCommand[] {
    const out: DiscoveredNativeCommand[] = [];

    // A skill directory names its command after the FOLDER, with the metadata
    // inside SKILL.md. This is the layout `/design` and the rest of Claude
    // Code's skills use, and the flat-file walk below would miss it entirely.
    if (source.skillDirs) {
      for (const entry of this._readDir(root)) {
        if (!entry.isDirectory()) { continue; }
        if (!isValidNativeCommandName(entry.name)) { continue; }
        const skillFile = path.join(root, entry.name, 'SKILL.md');
        const description = this._readDescription(skillFile, '.md');
        if (description === null) { continue; }
        out.push({
          name: entry.name,
          description: description || `${entry.name} skill`,
          filePath: skillFile,
          origin: source.scope,
          execution: source.execution,
        });
      }
      return out;
    }

    const walk = (dir: string, prefix: string, depth: number): void => {
      for (const entry of this._readDir(dir)) {
        if (out.length >= MAX_COMMANDS_PER_PROVIDER) { return; }
        if (entry.name.startsWith('.')) { continue; }

        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Only CLIs that namespace by directory recurse; for the others a
          // subdirectory is not part of the command vocabulary at all.
          if (source.nested && depth < MAX_DEPTH && isValidNativeCommandName(entry.name)) {
            walk(full, `${prefix}${entry.name}:`, depth + 1);
          }
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(source.ext)) { continue; }

        const base = entry.name.slice(0, -source.ext.length);
        // A filename is untrusted input: it may legally contain whitespace or a
        // newline, and this name is about to become `/name` in a prompt.
        if (!isValidNativeCommandName(base)) { continue; }
        const description = this._readDescription(full, source.ext);
        if (description === null) { continue; }
        out.push({
          name: `${prefix}${base}`,
          description: description || `${prefix}${base} command`,
          filePath: full,
          origin: source.scope,
          execution: source.execution,
        });
      }
    };

    walk(root, '', 0);
    return out;
  }

  private _readDir(dir: string): Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> {
    try {
      return this._fs.readdirSync(dir);
    } catch {
      // A missing command directory is the normal case, not an error.
      return [];
    }
  }

  /**
   * Description for one command file. Returns `null` when the file cannot be
   * read at all (so the caller skips it) and `''` when it is readable but
   * carries no description (the caller substitutes a placeholder).
   */
  private _readDescription(file: string, ext: '.md' | '.toml'): string | null {
    let head: string;
    try {
      if (this._fs.statSize(file) > MAX_TEMPLATE_BYTES) { return null; }
      head = this._fs.readFileSync(file).slice(0, MAX_HEADER_BYTES);
    } catch {
      return null;
    }
    const raw = ext === '.toml' ? tomlDescription(head) : frontmatterDescription(head);
    return raw ? collapse(raw) : '';
  }
}

// -----------------------------------------------------------------------------
// Parsing helpers (pure — exported for the unit tests)
// -----------------------------------------------------------------------------

/**
 * `description:` out of YAML frontmatter.
 *
 * Deliberately a line scanner over the frontmatter block rather than a YAML
 * parse: these files are prompt templates whose BODY is full of markdown that a
 * lenient parser would happily misread, and the only field needed is a
 * one-liner. Quoted, unquoted and `>`/`|` block forms are all handled.
 */
export function frontmatterDescription(content: string): string | undefined {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) { return undefined; }
  const end = normalized.indexOf('\n---', 3);
  const block = end === -1 ? normalized.slice(4) : normalized.slice(4, end);

  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = /^description:\s*(.*)$/.exec(lines[i]);
    if (!match) { continue; }
    const inline = match[1].trim();
    if (inline && inline !== '>' && inline !== '|' && inline !== '>-' && inline !== '|-') {
      return unquote(inline);
    }
    // Block scalar: take the indented continuation lines.
    const folded: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (!/^\s+\S/.test(lines[j])) { break; }
      folded.push(lines[j].trim());
    }
    return folded.length > 0 ? folded.join(' ') : undefined;
  }
  return undefined;
}

/**
 * `description = "..."` out of a Gemini/Qwen command TOML.
 *
 * The triple-quoted form is checked FIRST and across lines: TOML's `"""` opens
 * a multi-line string, so a line-anchored match would capture the opening
 * delimiter and call it the description.
 */
export function tomlDescription(content: string): string | undefined {
  const normalized = content.replace(/\r\n/g, '\n');
  const triple = /^\s*description\s*=\s*"""([\s\S]*?)"""/m.exec(normalized);
  if (triple) { return triple[1].trim(); }
  const match = /^\s*description\s*=\s*(.+)$/m.exec(normalized);
  return match ? unquote(match[1].trim()) : undefined;
}

/** Remove a leading YAML frontmatter block, leaving the prompt body. */
export function stripFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) { return normalized; }
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) { return normalized; }
  return normalized.slice(end + 4).replace(/^\n/, '');
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** Menu rows are one line; a description that wraps is a description that lies. */
function collapse(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
}

function sameCommands(a: DiscoveredNativeCommand[], b: DiscoveredNativeCommand[]): boolean {
  if (a.length !== b.length) { return false; }
  return a.every((cmd, i) =>
    cmd.name === b[i].name &&
    cmd.description === b[i].description &&
    cmd.filePath === b[i].filePath
  );
}
