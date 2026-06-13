/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for McpConfigManager (Plan 04 Phase 3). Verifies the per-CLI MCP config
 * writer adds/updates/removes only its own `deepmyst-*` entries, preserves the
 * user's other servers + config keys, uses each CLI's expected entry shape, and
 * never corrupts an existing config. `os.homedir()` and the mock workspace are
 * both redirected to a temp dir so nothing touches the real filesystem home.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { McpConfigManager, DEEPMYST_ENTRY_PREFIX } from '../../src/services/McpConfigManager';
import { workspace as mockWorkspace } from '../helpers/mockVscode';

function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const SPEC = {
  id: `${DEEPMYST_ENTRY_PREFIX}support`,
  url: 'https://api.v2.deepmyst.com/api/v1/mcp/support',
  headers: { Authorization: 'Bearer dm_live_abc123' },
};

describe('McpConfigManager', () => {
  let tmp: string;
  let mgr: McpConfigManager;
  let savedFolders: unknown;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-mcp-'));
    // Point the (Claude) workspace adapter at the temp dir.
    savedFolders = (mockWorkspace as { workspaceFolders: unknown }).workspaceFolders;
    (mockWorkspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: { fsPath: tmp }, name: 'tmp', index: 0 },
    ];
    // Redirect homedir-based adapters (Gemini/Qwen/OpenCode) into the temp dir
    // via the constructor override (os.homedir can't be spied under ESM).
    mgr = new McpConfigManager(tmp);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    (mockWorkspace as { workspaceFolders: unknown }).workspaceFolders = savedFolders;
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes the Claude entry with type:http under mcpServers (.mcp.json in workspace)', async () => {
    const results = await mgr.applyAll([SPEC]);
    const claude = results.find((r) => r.providerId === 'claude-code')!;
    expect(claude.ok).toBe(true);
    expect(claude.action).toBe('wrote');

    const cfg = readJson(path.join(tmp, '.mcp.json'));
    expect(cfg.mcpServers[`${DEEPMYST_ENTRY_PREFIX}support`]).toEqual({
      type: 'http',
      url: SPEC.url,
      headers: SPEC.headers,
    });
  });

  it('writes the Gemini entry with httpUrl + headers under mcpServers', async () => {
    await mgr.applyAll([SPEC]);
    const cfg = readJson(path.join(tmp, '.gemini', 'settings.json'));
    expect(cfg.mcpServers[`${DEEPMYST_ENTRY_PREFIX}support`]).toEqual({
      httpUrl: SPEC.url,
      headers: SPEC.headers,
    });
  });

  it('writes the Qwen entry the same way (settings.json)', async () => {
    await mgr.applyAll([SPEC]);
    const cfg = readJson(path.join(tmp, '.qwen', 'settings.json'));
    expect(cfg.mcpServers[`${DEEPMYST_ENTRY_PREFIX}support`].httpUrl).toBe(SPEC.url);
  });

  it('writes OpenCode under `mcp` with type:remote + enabled', async () => {
    await mgr.applyAll([SPEC]);
    const cfg = readJson(path.join(tmp, '.config', 'opencode', 'opencode.json'));
    expect(cfg.mcp[`${DEEPMYST_ENTRY_PREFIX}support`]).toEqual({
      type: 'remote',
      url: SPEC.url,
      enabled: true,
      headers: SPEC.headers,
    });
  });

  it("preserves the user's existing servers and other config keys", async () => {
    const geminiPath = path.join(tmp, '.gemini', 'settings.json');
    fs.mkdirSync(path.dirname(geminiPath), { recursive: true });
    fs.writeFileSync(geminiPath, JSON.stringify({
      theme: 'dark',
      mcpServers: { 'my-server': { command: 'node', args: ['x.js'] } },
    }));

    await mgr.applyAll([SPEC]);

    const cfg = readJson(geminiPath);
    expect(cfg.theme).toBe('dark');
    expect(cfg.mcpServers['my-server']).toEqual({ command: 'node', args: ['x.js'] });
    expect(cfg.mcpServers[`${DEEPMYST_ENTRY_PREFIX}support`]).toBeDefined();
  });

  it('removeAll strips only deepmyst-* entries, leaving user servers', async () => {
    const geminiPath = path.join(tmp, '.gemini', 'settings.json');
    fs.mkdirSync(path.dirname(geminiPath), { recursive: true });
    fs.writeFileSync(geminiPath, JSON.stringify({
      mcpServers: { 'my-server': { command: 'node' } },
    }));

    await mgr.applyAll([SPEC]);
    expect(readJson(geminiPath).mcpServers[`${DEEPMYST_ENTRY_PREFIX}support`]).toBeDefined();

    await mgr.removeAll();
    const cfg = readJson(geminiPath);
    expect(cfg.mcpServers[`${DEEPMYST_ENTRY_PREFIX}support`]).toBeUndefined();
    expect(cfg.mcpServers['my-server']).toEqual({ command: 'node' });
  });

  it('re-applying replaces the prior deepmyst set (disabled agents drop out)', async () => {
    await mgr.applyAll([SPEC]);
    const other = {
      id: `${DEEPMYST_ENTRY_PREFIX}other`,
      url: 'https://api.v2.deepmyst.com/api/v1/mcp/other',
      headers: SPEC.headers,
    };
    await mgr.applyAll([other]);

    const cfg = readJson(path.join(tmp, '.gemini', 'settings.json'));
    expect(cfg.mcpServers[`${DEEPMYST_ENTRY_PREFIX}support`]).toBeUndefined();
    expect(cfg.mcpServers[`${DEEPMYST_ENTRY_PREFIX}other`]).toBeDefined();
  });

  it('does not create a config file when there is nothing to write', async () => {
    await mgr.removeAll();
    expect(fs.existsSync(path.join(tmp, '.gemini', 'settings.json'))).toBe(false);
  });

  it('errors (not corrupts) on an unparseable existing config', async () => {
    const geminiPath = path.join(tmp, '.gemini', 'settings.json');
    fs.mkdirSync(path.dirname(geminiPath), { recursive: true });
    fs.writeFileSync(geminiPath, '{ not valid json');

    const results = await mgr.applyAll([SPEC]);
    const gemini = results.find((r) => r.providerId === 'google-gemini')!;
    expect(gemini.ok).toBe(false);
    expect(gemini.action).toBe('error');
    expect(fs.readFileSync(geminiPath, 'utf8')).toBe('{ not valid json');
  });

  it('supportedProviders lists the JSON-capable backends', () => {
    expect(McpConfigManager.supportedProviders()).toEqual(
      expect.arrayContaining(['claude-code', 'google-gemini', 'qwen-code', 'opencode']),
    );
  });
});
