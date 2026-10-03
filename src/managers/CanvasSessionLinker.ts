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

/**
 * Registers the in-extension `mysti-canvas` HTTP MCP server into a canvas-linked
 * CLI session (Plan 05 Phase 2.3). For Claude Code — the one CLI with true
 * per-invocation config — it writes a temp `--mcp-config` file pointing at the
 * loopback URL + bearer token, appended to the spawn args, and removed on
 * unlink/panel dispose. No persistent footprint. (Gemini/Qwen/Codex, which only
 * support persistent config, are a follow-up: marker-tagged managed entries.)
 */
export interface McpHttpEndpoint {
  url: string;
  token: string;
}

/** Claude Code `--mcp-config` JSON for an HTTP MCP server. */
export function buildClaudeMcpConfig(serverName: string, endpoint: McpHttpEndpoint): {
  mcpServers: Record<string, { type: 'http'; url: string; headers: Record<string, string> }>;
} {
  return {
    mcpServers: {
      [serverName]: {
        type: 'http',
        url: endpoint.url,
        headers: { Authorization: `Bearer ${endpoint.token}` },
      },
    },
  };
}

export class CanvasSessionLinker {
  private _tmpDir: string;
  private _serverName: string;
  /** panelId → temp config file path. */
  private _configByPanel = new Map<string, string>();

  constructor(opts: { tmpDir?: string; serverName?: string } = {}) {
    this._tmpDir = opts.tmpDir ?? os.tmpdir();
    this._serverName = opts.serverName ?? 'mysti-canvas';
  }

  /**
   * Write the per-session Claude Code MCP config for a canvas-linked panel and
   * return its path. Idempotent per panel (rewrites the same file).
   */
  link(panelId: string, endpoint: McpHttpEndpoint): string {
    const file = path.join(this._tmpDir, `mysti-canvas-${sanitize(panelId)}.json`);
    // 6.3a: the config embeds the per-session MCP bearer token + URL and lives
    // at a predictable path in the SHARED os.tmpdir() — write it owner-only
    // (0o600) so other local users can't read the token. `mode` only applies
    // when the file is created, so chmod too in case a prior link (or another
    // process) left it behind with looser permissions. Best-effort on
    // non-POSIX filesystems (Windows ACLs ignore the mode bits).
    fs.writeFileSync(
      file,
      JSON.stringify(buildClaudeMcpConfig(this._serverName, endpoint), null, 2),
      { encoding: 'utf8', mode: 0o600 },
    );
    try { fs.chmodSync(file, 0o600); } catch { /* best-effort */ }
    this._configByPanel.set(panelId, file);
    return file;
  }

  /** True when the canvas is registered for this panel's session. */
  isLinked(panelId: string): boolean {
    return this._configByPanel.has(panelId);
  }

  /** Per-invocation CLI args to append for a linked panel (Claude Code). */
  cliArgs(panelId: string): string[] {
    const file = this._configByPanel.get(panelId);
    return file ? ['--mcp-config', file] : [];
  }

  /** Remove the temp config (unlink / panel dispose). */
  unlink(panelId: string): void {
    const file = this._configByPanel.get(panelId);
    if (file) {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
      this._configByPanel.delete(panelId);
    }
  }

  unlinkAll(): void {
    for (const panelId of [...this._configByPanel.keys()]) { this.unlink(panelId); }
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}
