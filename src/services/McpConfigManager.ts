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
 *
 * MCP config writer (Plan 04 Phase 3 — DeepMyst-brokered MCP).
 *
 * Writes the DeepMyst MCP endpoint(s) into each MCP-capable backend CLI's own
 * config file, so the local CLIs (Claude Code, Gemini, Qwen, OpenCode, …) get
 * the user's DeepMyst-brokered tools — with only the `dm_` key on disk; the
 * third-party credentials stay in DeepMyst.
 *
 * Every entry Mysti writes is keyed `deepmyst-<slug>` so the writer only ever
 * touches its own entries and never clobbers the user's hand-added MCP servers.
 * Writes are idempotent and preserve the rest of each config file.
 *
 * Codex (config.toml — no TOML writer available + uncertain HTTP-MCP shape) and
 * Cline (editor-specific globalStorage path) are deferred to a follow-up; their
 * formats are documented in plans/04.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Prefix marking a Mysti-managed MCP server entry in a CLI config. */
export const DEEPMYST_ENTRY_PREFIX = 'deepmyst-';

/** A DeepMyst MCP server to write into the CLIs. */
export interface McpServerSpec {
  /** Stable id, always `deepmyst-<slug>`. */
  id: string;
  /** The MCP endpoint URL (e.g. https://api.v2.deepmyst.com/api/v1/mcp/<slug>). */
  url: string;
  /** Auth + other headers (carries `Authorization: Bearer dm_...`). */
  headers: Record<string, string>;
}

export interface McpApplyResult {
  providerId: string;
  displayName: string;
  /** Absolute config path, or null when the target isn't applicable (e.g. Claude with no workspace). */
  configPath: string | null;
  ok: boolean;
  /** 'wrote' | 'removed' | 'skipped' | 'error' */
  action: 'wrote' | 'removed' | 'skipped' | 'error';
  error?: string;
}

/**
 * Describes how one CLI stores HTTP MCP servers in its JSON config:
 *  - `rootKey`: the object that holds servers (`mcpServers` or `mcp`)
 *  - `entryFor`: the per-server entry in that CLI's expected shape
 */
interface AdapterContext {
  home: string;
  workspace: string | undefined;
}

interface JsonAdapter {
  id: string;
  displayName: string;
  rootKey: string;
  /** Resolve the config file path, or null when not applicable in this context. */
  resolvePath(ctx: AdapterContext): string | null;
  entryFor(spec: McpServerSpec): Record<string, unknown>;
}

const ADAPTERS: JsonAdapter[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    rootKey: 'mcpServers',
    // Project-scoped .mcp.json in the workspace root (the file Claude Code reads
    // when run in this project). Needs an open workspace.
    resolvePath: (ctx) => (ctx.workspace ? path.join(ctx.workspace, '.mcp.json') : null),
    entryFor: (s) => ({ type: 'http', url: s.url, headers: s.headers }),
  },
  {
    id: 'google-gemini',
    displayName: 'Gemini',
    rootKey: 'mcpServers',
    resolvePath: (ctx) => path.join(ctx.home, '.gemini', 'settings.json'),
    // Gemini CLI uses `httpUrl` for streamable-HTTP MCP servers.
    entryFor: (s) => ({ httpUrl: s.url, headers: s.headers }),
  },
  {
    id: 'qwen-code',
    displayName: 'Qwen Code',
    rootKey: 'mcpServers',
    // Qwen Code is a Gemini CLI fork → same settings.json + httpUrl shape.
    resolvePath: (ctx) => path.join(ctx.home, '.qwen', 'settings.json'),
    entryFor: (s) => ({ httpUrl: s.url, headers: s.headers }),
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    rootKey: 'mcp',
    resolvePath: (ctx) => path.join(ctx.home, '.config', 'opencode', 'opencode.json'),
    // OpenCode uses a `mcp` map with `type: "remote"` for HTTP servers.
    entryFor: (s) => ({ type: 'remote', url: s.url, enabled: true, headers: s.headers }),
  },
];

export class McpConfigManager {
  /** @param _homeDir overridable for tests; defaults to the OS home directory. */
  constructor(private readonly _homeDir: string = os.homedir()) {}

  /** Provider ids this manager can write MCP config for. */
  static supportedProviders(): string[] {
    return ADAPTERS.map((a) => a.id);
  }

  /**
   * Apply the given DeepMyst MCP servers to every supported CLI config: replace
   * all existing `deepmyst-*` entries with `specs` (so disabling an agent
   * removes it), preserving every other server. An empty `specs` clears them.
   */
  async applyAll(specs: McpServerSpec[]): Promise<McpApplyResult[]> {
    const ctx: AdapterContext = { home: this._homeDir, workspace: this._workspaceRoot() };
    return Promise.all(ADAPTERS.map((a) => this._applyOne(a, specs, ctx)));
  }

  /** Remove every Mysti-managed (`deepmyst-*`) entry from all CLI configs. */
  async removeAll(): Promise<McpApplyResult[]> {
    return this.applyAll([]);
  }

  private _workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private async _applyOne(
    adapter: JsonAdapter,
    specs: McpServerSpec[],
    ctx: AdapterContext,
  ): Promise<McpApplyResult> {
    const configPath = adapter.resolvePath(ctx);
    const base: McpApplyResult = {
      providerId: adapter.id,
      displayName: adapter.displayName,
      configPath,
      ok: false,
      action: 'error',
    };

    if (!configPath) {
      // Not applicable (e.g. Claude project scope with no open workspace).
      return { ...base, ok: true, action: 'skipped' };
    }

    try {
      const existing = this._readJson(configPath);
      const root = (existing[adapter.rootKey] && typeof existing[adapter.rootKey] === 'object'
        ? existing[adapter.rootKey]
        : {}) as Record<string, unknown>;

      // Drop our previous entries, keep the user's.
      let changed = false;
      for (const key of Object.keys(root)) {
        if (key.startsWith(DEEPMYST_ENTRY_PREFIX)) {
          delete root[key];
          changed = true;
        }
      }
      // Add the current set.
      for (const spec of specs) {
        root[spec.id] = adapter.entryFor(spec);
        changed = true;
      }

      const hadKey = Object.keys(existing).includes(adapter.rootKey);
      if (Object.keys(root).length > 0 || hadKey) {
        existing[adapter.rootKey] = root;
      }

      // If nothing changed and the file didn't exist, don't create an empty file.
      if (!changed && !fs.existsSync(configPath)) {
        return { ...base, ok: true, action: 'skipped' };
      }

      this._writeJson(configPath, existing);
      return { ...base, ok: true, action: specs.length > 0 ? 'wrote' : 'removed' };
    } catch (err) {
      return { ...base, ok: false, action: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  }

  private _readJson(file: string): Record<string, unknown> {
    try {
      if (!fs.existsSync(file)) {
        return {};
      }
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (!raw) {
        return {};
      }
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch (err) {
      // Don't silently overwrite a config we can't parse — surface it.
      throw new Error(`Existing config at ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private _writeJson(file: string, data: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }
}
