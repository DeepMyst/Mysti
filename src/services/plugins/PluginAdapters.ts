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
 * Plan 45 — Manage Plugins: one adapter per backend that has a plugin system.
 *
 * Every adapter drives that backend's OWN CLI (execFile, no shell) and never
 * writes another tool's config. An operation is supported iff its method
 * exists, so the panel can never offer something the CLI cannot do.
 *
 * Exit codes are not trusted where the CLI is known to lie: Claude Code exits
 * 0 on a failed install and 1 on an already-disabled disable, so its result is
 * the `--json` line's `outcome`.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ProviderType } from '../../types';
import { getEnrichedEnv } from '../../utils/platform';
import { killProcessTree } from '../../utils/processKill';

export type PluginScope = 'user' | 'project' | 'local';

export interface InstalledPlugin {
  id: string;
  name: string;
  marketplace?: string;
  version?: string;
  /** `bundled` ships with the CLI; `managed` is set by an administrator. Neither can be removed here. */
  scope: PluginScope | 'bundled' | 'managed';
  enabled?: boolean;
  description?: string;
  /** A load error the CLI reports for this plugin. */
  error?: string;
}

export interface CatalogPlugin {
  id: string;
  name: string;
  marketplace?: string;
  description?: string;
  installCount?: number;
  version?: string;
  /** Executable components the catalog itself reports (Hermes); otherwise inspect() decides. */
  codeParts?: CodeParts;
  /** The id it will have once installed, when that differs from `id` (OpenClaw's runtime id). */
  installedAs?: string;
}

export interface PluginListing {
  installed: InstalledPlugin[];
  available?: CatalogPlugin[];
  /** The CLI answered but said something is incomplete. */
  warning?: string;
}

export interface Marketplace { name: string; source: string; builtin?: boolean }

export interface Approval {
  /** Claude Code: the sha256 of a marketplace-declared install command the user approved. */
  acceptCommandSha?: string;
}

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }
/** Runs the backend's CLI. `cwd` is the workspace it runs in, for adapters that read project-scope folders. */
export type Run = ((args: string[], opts?: { timeoutMs?: number }) => Promise<RunResult>) & { cwd?: string };

/** Executable component kinds (`[]` = none), or `'unknown'` when they cannot be seen before install. */
export type CodeParts = string[] | 'unknown';

export interface DeclaredCommand { command: string; sha: string; archiveUrl?: string }

export class PluginCliError extends Error {
  constructor(message: string, readonly acceptCommand?: DeclaredCommand) {
    super(message);
    this.name = 'PluginCliError';
  }
}

export interface PluginAdapter {
  scopes: PluginScope[];
  /** Shown beside what the adapter CAN do, e.g. what its CLI cannot. */
  note?: string;
  /** Appended to the "applies from your next message" banner when the backend needs more. */
  applyHint?: string;
  /** Absent when the CLI cannot list plugins (Cursor manages only marketplaces). */
  list?(run: Run): Promise<PluginListing>;
  /** Catalogs that only answer a query (ClawHub, Hermes). */
  search?(run: Run, query: string): Promise<CatalogPlugin[]>;
  /** Required whenever install exists; absent means "can't see before install". */
  inspect?(run: Run, entry: CatalogPlugin): Promise<CodeParts>;
  install?(run: Run, id: string, scope: PluginScope, approval?: Approval): Promise<void>;
  /** Install from a source the user types (git URL, path, npm package). Contents are never visible first. */
  installSource?(run: Run, source: string, scope: PluginScope, approval?: Approval): Promise<void>;
  sourceHint?: { label: string; placeholder: string };
  uninstall?(run: Run, p: InstalledPlugin): Promise<void>;
  setEnabled?(run: Run, p: InstalledPlugin, on: boolean): Promise<void>;
  update?(run: Run, p: InstalledPlugin, approval?: Approval): Promise<void>;
  details?(run: Run, p: InstalledPlugin): Promise<string>;
  marketplaces?: {
    list(run: Run): Promise<Marketplace[]>;
    add(run: Run, source: string): Promise<void>;
    remove(run: Run, name: string): Promise<void>;
    refresh(run: Run, name: string): Promise<void>;
  };
}

/** A backend whose plugins exist but cannot be driven from its CLI shows only a note. */
export type PluginBackend = PluginAdapter | { note: string } | null;

export const LIST_TIMEOUT_MS = 30_000;
export const MUTATE_TIMEOUT_MS = 300_000;
const MUTATE = { timeoutMs: MUTATE_TIMEOUT_MS };
const TIMED_OUT = 'Timed out. Mysti stopped the CLI; refresh to see whether anything changed.';

/**
 * Run a CLI with an argv array and NO shell. Never rejects: a spawn failure
 * comes back as `code: null` with the reason in stderr.
 */
export function runCli(cliPath: string, args: string[], opts: { timeoutMs?: number; cwd?: string } = {}): Promise<RunResult> {
  // ponytail: npm .cmd/.bat shims on Windows need a shell, and plugin names and
  // sources are untrusted marketplace strings. Refuse rather than quote; add a
  // shim-to-node resolver if Windows users need this.
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath)) {
    return Promise.resolve({ code: null, stdout: '', stderr: `Manage Plugins can't run ${path.basename(cliPath)} on Windows yet. Use the CLI's own plugin command in a terminal.`, timedOut: false });
  }
  const posix = process.platform !== 'win32';
  const cap = 64 * 1024 * 1024;
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    const finish = (code: number | null, extraErr = '') => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') || extraErr, timedOut });
    };
    // spawn, not execFile: execFile drops `detached`. Its own process group on
    // POSIX lets a timeout reach the git/npm processes the CLI started too
    // (Windows kills the tree via taskkill). Still an argv array, no shell.
    const child = spawn(cliPath, args, { cwd: opts.cwd, env: getEnrichedEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: posix });
    // Kill the CLI and everything it started. The group signal reaches children
    // even after the leader has exited (killProcessTree skips a dead leader).
    let killed = false;
    const killAll = () => {
      if (killed) { return; }
      killed = true;
      if (posix && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ } }
      void killProcessTree(child, 1000, { useProcessGroup: posix, initialSignal: 'SIGKILL', label: 'plugin CLI' });
    };
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size <= cap) { into.push(chunk); } else { killAll(); }
    };
    child.stdout?.on('data', collect(out));
    child.stderr?.on('data', collect(err));
    child.on('error', (e) => finish(null, e.message));
    child.on('close', (code) => finish(typeof code === 'number' ? code : null));
    // The CLI has exited, but something it started may still hold the output
    // pipe: give that a moment, then kill it and report the CLI's own result.
    child.on('exit', (code) => {
      setTimeout(() => { if (!settled) { killAll(); finish(typeof code === 'number' ? code : null); } }, 1000).unref?.();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killAll();
    }, opts.timeoutMs ?? LIST_TIMEOUT_MS);
    // No TTY and nothing to say: a CLI that stops to ask a question gets EOF
    // (and its default) instead of hanging until the timeout.
    child.stdin?.on('error', () => { /* already exited */ });
    child.stdin?.end();
  });
}

/** CLI output without TUI chrome (box-drawing frames, spinners), last few lines. */
export function cleanCliText(text: string): string {
  return text
    .split(/\r?\n/)
    // eslint-disable-next-line no-control-regex -- stripping ANSI color escapes is the point
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
    .filter((l) => l && !/^[│┃◇◆●○╭╮╰╯─━┌┐└┘├┤|]/.test(l))
    .slice(-6)
    .join('\n');
}

/** Throw unless the CLI exited 0 (for CLIs whose exit code is truthful). */
function expectExit0(r: RunResult, what: string): void {
  if (r.timedOut) { throw new PluginCliError(TIMED_OUT); }
  if (r.code !== 0) {
    throw new PluginCliError(cleanCliText(r.stderr) || cleanCliText(r.stdout) || `${what} failed${r.code === null ? '' : ` (exit ${r.code})`}`);
  }
}

function parseJson(r: RunResult, what: string): unknown {
  if (r.timedOut) { throw new PluginCliError(TIMED_OUT); }
  try {
    return JSON.parse(r.stdout);
  } catch { /* maybe a banner first */ }
  // Some CLIs print warnings before the JSON (OpenClaw's config box; Gemini's
  // "[ExtensionManager] …", which itself starts with "["), so try each line
  // that could begin it.
  const lines = r.stdout.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    if (!/^\s*[[{]/.test(lines[i])) { continue; }
    try { return JSON.parse(lines.slice(i).join('\n')); } catch { /* next candidate */ }
  }
  const why = cleanCliText(r.stderr);
  throw new PluginCliError(`Couldn't read ${what}${why ? `: ${why}` : '.'}`);
}

function splitId(id: string): { name: string; marketplace?: string } {
  const at = id.lastIndexOf('@');
  return at > 0 ? { name: id.slice(0, at), marketplace: id.slice(at + 1) } : { name: id };
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** Parsed CLI JSON, read field by field. */
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {});
const objs = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object').map(obj) : []);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

// ── Claude Code ─────────────────────────────────────────────────────────────

/**
 * A Claude `--json` mutation result. Success is `outcome: "ok"` (or the plugin
 * already being in the requested state); the exit code is only a tiebreak.
 */
function claudeOutcome(r: RunResult): void {
  if (r.timedOut) { throw new PluginCliError(TIMED_OUT); }
  const line = r.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('{'));
  let parsed: unknown;
  try { parsed = line ? JSON.parse(line) : undefined; } catch { parsed = undefined; }
  if (!parsed || typeof parsed !== 'object') {
    throw new PluginCliError(cleanCliText(r.stderr) || cleanCliText(r.stdout) || `Claude Code returned no result (exit ${r.code})`);
  }
  const j = obj(parsed);
  if (j.alreadyInGoalState === true) { return; }
  // The result writer emits exactly "ok" or "failed" (Claude 2.1.288); anything
  // else is unknown, and unknown is not success.
  if (j.outcome !== 'ok' || r.code !== 0) {
    throw new PluginCliError(str(j.message) ?? str(j.failureCode) ?? 'Claude Code reported a failure.', claudeAcceptCommand(j));
  }
}

/**
 * The marketplace-declared command Claude wants approved, from the failure's
 * `shownCommand` object (`--accept-command`'s help: "reported as
 * shownCommand.sha256"). Offered only when both a 64-hex hash and the command
 * itself are present, so the user always sees what they approve.
 */
function claudeAcceptCommand(j: Obj): DeclaredCommand | undefined {
  const shown = obj(j.shownCommand);
  const sha = str(shown.sha256);
  const command = Array.isArray(shown.command)
    ? shown.command.filter((x): x is string => typeof x === 'string').join(' ')
    : str(shown.command);
  if (!sha || !/^[0-9a-f]{64}$/i.test(sha) || !command) { return undefined; }
  return { command, sha: sha.toLowerCase(), archiveUrl: str(shown.archiveUrl) };
}

/** Manifest keys that declare something which RUNS (vs. prompt content). */
const CLAUDE_CODE_KEYS: Record<string, string> = { hooks: 'Hooks', mcpServers: 'MCP servers', lspServers: 'LSP servers', monitors: 'Monitors' };
/** Top-level entries Claude loads as code by default. */
const CLAUDE_CODE_ENTRIES: Record<string, string> = { 'hooks': 'Hooks', '.mcp.json': 'MCP servers', '.lsp.json': 'LSP servers', 'monitors': 'Monitors' };
/** Top-level entries that are prompt content or inert files. Anything else is "Other content". */
const CLAUDE_INERT_ENTRY = /^(\.claude-plugin|commands|agents|skills|output-styles|assets|docs|images|\.gitignore|\.gitattributes|(README|LICENSE|NOTICE|CHANGELOG|SECURITY)(\..*)?|.*\.(md|txt|png|jpe?g|gif|svg|webp))$/i;
const OTHER_CONTENT = 'Other content';
const CLAUDE_PART_ORDER = ['Hooks', 'MCP servers', 'LSP servers', 'Monitors', OTHER_CONTENT];
/** Every key seen in real marketplace entries and plugin.json files that declares no code. */
const CLAUDE_SAFE_KEYS = new Set([
  '$schema', 'name', 'displayName', 'description', 'version', 'author', 'homepage', 'repository', 'license',
  'keywords', 'category', 'tags', 'source', 'strict', 'commands', 'agents', 'skills', 'outputStyles', 'userConfig',
]);

/** Adds the code parts an object declares; a key we don't know is "Other content". */
function claudeKeys(o: unknown, parts: Set<string>): void {
  for (const k of Object.keys(obj(o))) {
    if (CLAUDE_CODE_KEYS[k]) { parts.add(CLAUDE_CODE_KEYS[k]); } else if (!CLAUDE_SAFE_KEYS.has(k)) { parts.add(OTHER_CONTENT); }
  }
}

function readJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

const claudeScope = (p: { scope: string }) => ['-s', p.scope];

const CLAUDE_ADAPTER: PluginAdapter = {
  scopes: ['user', 'project', 'local'],

  async list(run) {
    const j = obj(parseJson(await run(['plugin', 'list', '--json', '--available'], { timeoutMs: LIST_TIMEOUT_MS }), "Claude Code's plugin list"));
    if (!Array.isArray(j.installed)) { throw new PluginCliError("Couldn't read Claude Code's plugin list."); }
    return {
      installed: objs(j.installed).filter((p) => str(p.id)).map((p): InstalledPlugin => {
        const id = String(p.id);
        const scope = str(p.scope);
        return {
          id,
          ...splitId(id),
          version: str(p.version),
          scope: scope === 'user' || scope === 'project' || scope === 'local' ? scope : 'managed',
          enabled: p.enabled !== false,
          error: p.errorDetails ? str(p.errorDetails) ?? str(obj(p.errorDetails).message) ?? JSON.stringify(p.errorDetails) : undefined,
        };
      }),
      available: objs(j.available).filter((p) => str(p.pluginId) && str(p.name)).map((p): CatalogPlugin => ({
        id: String(p.pluginId),
        name: String(p.name),
        marketplace: str(p.marketplaceName),
        description: str(p.description),
        installCount: num(p.installCount),
      })),
    };
  },

  /**
   * What the plugin RUNS, read from the marketplace copy on disk after
   * refreshing it — the install refreshes too, so this looks at what it will
   * use. Fails closed: a remote source, a bare or escaping path, a missing
   * directory, or ONLY unrecognised content is `'unknown'`; unrecognised
   * content beside known code is listed as "Other content".
   */
  async inspect(run, entry) {
    if (!entry.marketplace || entry.marketplace.startsWith('-')) { return 'unknown'; }
    if ((await run(['plugin', 'marketplace', 'update', entry.marketplace], MUTATE)).code !== 0) { return 'unknown'; }
    const markets = parseJson(await run(['plugin', 'marketplace', 'list', '--json'], { timeoutMs: LIST_TIMEOUT_MS }), "Claude Code's marketplaces");
    const location = str(objs(markets).find((m) => m.name === entry.marketplace)?.installLocation);
    if (!location) { return 'unknown'; }
    const root = path.resolve(location);
    const e = objs(obj(readJson(path.join(root, '.claude-plugin', 'marketplace.json'))).plugins).find((p) => p.name === entry.name);
    // Only an explicit relative path: a bare name may resolve under the
    // marketplace's metadata.pluginRoot instead, so this copy may not be it.
    if (!e || typeof e.source !== 'string' || !e.source.startsWith('./')) { return 'unknown'; }
    const dir = path.resolve(root, e.source);
    if ((dir !== root && !dir.startsWith(root + path.sep)) || !fs.existsSync(dir)) { return 'unknown'; }
    const parts = new Set<string>();
    claudeKeys(e, parts);
    claudeKeys(readJson(path.join(dir, '.claude-plugin', 'plugin.json')), parts);
    for (const name of fs.readdirSync(dir)) {
      if (CLAUDE_CODE_ENTRIES[name]) { parts.add(CLAUDE_CODE_ENTRIES[name]); } else if (!CLAUDE_INERT_ENTRY.test(name)) { parts.add(OTHER_CONTENT); }
    }
    if (parts.size === 1 && parts.has(OTHER_CONTENT)) { return 'unknown'; }
    return CLAUDE_PART_ORDER.filter((p) => parts.has(p));
  },

  async install(run, id, scope, approval) {
    const args = ['plugin', 'install', id, '-s', scope, '--json'];
    if (approval?.acceptCommandSha) { args.push('--accept-command', approval.acceptCommandSha); }
    claudeOutcome(await run(args, MUTATE));
  },
  async uninstall(run, p) { claudeOutcome(await run(['plugin', 'uninstall', p.id, ...claudeScope(p), '--json'], MUTATE)); },
  async setEnabled(run, p, on) { claudeOutcome(await run(['plugin', on ? 'enable' : 'disable', p.id, ...claudeScope(p), '--json'], MUTATE)); },
  async update(run, p, approval) {
    const args = ['plugin', 'update', p.id, ...claudeScope(p), '--json'];
    if (approval?.acceptCommandSha) { args.push('--accept-command', approval.acceptCommandSha); }
    claudeOutcome(await run(args, MUTATE));
  },
  async details(run, p) {
    const r = await run(['plugin', 'details', p.id], { timeoutMs: LIST_TIMEOUT_MS });
    expectExit0(r, 'Details');
    return r.stdout.trim();
  },

  marketplaces: {
    async list(run) {
      const j = parseJson(await run(['plugin', 'marketplace', 'list', '--json'], { timeoutMs: LIST_TIMEOUT_MS }), "Claude Code's marketplaces");
      return objs(j).filter((m) => str(m.name)).map((m): Marketplace => ({ name: String(m.name), source: str(m.repo) ?? str(m.url) ?? str(m.path) ?? str(m.source) ?? '' }));
    },
    async add(run, source) { expectExit0(await run(['plugin', 'marketplace', 'add', source], MUTATE), 'Adding the marketplace'); },
    async remove(run, name) { expectExit0(await run(['plugin', 'marketplace', 'remove', name], MUTATE), 'Removing the marketplace'); },
    async refresh(run, name) { expectExit0(await run(['plugin', 'marketplace', 'update', name], MUTATE), 'Refreshing the marketplace'); },
  },
};

// ── GitHub Copilot ──────────────────────────────────────────────────────────

const COPILOT_ADAPTER: PluginAdapter = {
  scopes: ['user'],

  async list(run) {
    const installed = parseJson(await run(['plugin', 'list', '--json'], { timeoutMs: LIST_TIMEOUT_MS }), "Copilot's plugin list");
    if (!Array.isArray(installed)) { throw new PluginCliError("Couldn't read Copilot's plugin list."); }
    const markets = await COPILOT_ADAPTER.marketplaces!.list(run);
    const available: CatalogPlugin[] = [];
    const failed: string[] = [];
    for (const m of markets) {
      try {
        const entries = parseJson(await run(['plugin', 'marketplace', 'browse', m.name, '--json'], { timeoutMs: LIST_TIMEOUT_MS }), m.name);
        for (const e of objs(entries)) {
          const name = str(e.name);
          if (name) { available.push({ id: `${name}@${m.name}`, name, marketplace: m.name, description: str(e.description) }); }
        }
      } catch {
        failed.push(m.name);
      }
    }
    return {
      installed: objs(installed).filter((p) => str(p.name)).map((p): InstalledPlugin => ({
        // name@marketplace, the same id its catalog entry has (Copilot accepts both forms).
        id: str(p.marketplace) ? `${String(p.name)}@${String(p.marketplace)}` : String(p.name),
        name: String(p.name), marketplace: str(p.marketplace), version: str(p.version), scope: 'user', enabled: p.enabled !== false,
      })),
      available,
      warning: failed.length ? `Couldn't load the ${failed.join(', ')} catalog. Refresh to try again.` : undefined,
    };
  },

  // Copilot keeps no local copy of a marketplace's plugins, so nothing is visible before install.
  async inspect() { return 'unknown'; },

  async install(run, id) { expectExit0(await run(['plugin', 'install', id], MUTATE), 'Install'); },
  async uninstall(run, p) { expectExit0(await run(['plugin', 'uninstall', p.id], MUTATE), 'Uninstall'); },
  async setEnabled(run, p, on) { expectExit0(await run(['plugin', on ? 'enable' : 'disable', p.id], MUTATE), on ? 'Enable' : 'Disable'); },
  async update(run, p) { expectExit0(await run(['plugin', 'update', p.id], MUTATE), 'Update'); },

  marketplaces: {
    async list(run) {
      const j = parseJson(await run(['plugin', 'marketplace', 'list', '--json'], { timeoutMs: LIST_TIMEOUT_MS }), "Copilot's marketplaces");
      return objs(j).filter((m) => str(m.name)).map((m): Marketplace => ({
        name: String(m.name), source: (str(m.source) ?? '').replace(/^GitHub:\s*/, ''), builtin: m.isDefault === true,
      }));
    },
    async add(run, source) { expectExit0(await run(['plugin', 'marketplace', 'add', source], MUTATE), 'Adding the marketplace'); },
    async remove(run, name) { expectExit0(await run(['plugin', 'marketplace', 'remove', name], MUTATE), 'Removing the marketplace'); },
    async refresh(run, name) { expectExit0(await run(['plugin', 'marketplace', 'update', name], MUTATE), 'Refreshing the marketplace'); },
  },
};

// ── OpenClaw ────────────────────────────────────────────────────────────────

const OPENCLAW_ADAPTER: PluginAdapter = {
  scopes: ['user'],
  // A Gateway OpenClaw manages hot-reloads; one the user runs themselves doesn't.
  applyHint: 'If you run its Gateway yourself, restart it with `openclaw gateway restart`.',

  async list(run) {
    const j = obj(parseJson(await run(['plugins', 'list', '--json'], { timeoutMs: LIST_TIMEOUT_MS }), "OpenClaw's plugin list"));
    if (!Array.isArray(j.plugins)) { throw new PluginCliError("Couldn't read OpenClaw's plugin list."); }
    return {
      installed: objs(j.plugins).filter((p) => str(p.id)).map((p): InstalledPlugin => ({
        id: String(p.id), name: str(p.name) ?? String(p.id), version: str(p.version), description: str(p.description),
        scope: p.origin === 'bundled' ? 'bundled' : 'user',
        enabled: p.enabled !== false,
        error: p.status === 'error' || p.status === 'failed' ? `OpenClaw reports this plugin as ${p.status}.` : undefined,
      })),
    };
  },

  // ClawHub only answers a query.
  async search(run, query) {
    const j = parseJson(await run(['plugins', 'search', query, '--json', '--limit', '25'], { timeoutMs: LIST_TIMEOUT_MS }), 'ClawHub results');
    return objs(obj(j).results).map((r) => obj(r.package)).filter((p) => str(p.name)).map((p): CatalogPlugin => ({
      id: `clawhub:${String(p.name)}`, name: str(p.displayName) ?? String(p.name), marketplace: 'ClawHub', description: str(p.summary),
      version: str(p.latestVersion), installCount: num(obj(p.stats).installs), installedAs: str(p.runtimeId),
    }));
  },

  // An OpenClaw plugin is code that runs in its gateway; the registry doesn't list what it does.
  async inspect() { return 'unknown'; },

  async install(run, id) { expectExit0(await run(['plugins', 'install', id], MUTATE), 'Install'); },
  // --force only skips the "are you sure" prompt it shows on a terminal; the user already clicked Uninstall.
  async uninstall(run, p) { expectExit0(await run(['plugins', 'uninstall', p.id, '--force'], MUTATE), 'Uninstall'); },
  async setEnabled(run, p, on) { expectExit0(await run(['plugins', on ? 'enable' : 'disable', p.id], MUTATE), on ? 'Enable' : 'Disable'); },
  async update(run, p) { expectExit0(await run(['plugins', 'update', p.id], MUTATE), 'Update'); },
};

// ── Hermes ──────────────────────────────────────────────────────────────────
// From Hermes's documented `--json` output; not exercised against a live CLI.

const HERMES_CAPABILITIES: [string, string][] = [['provides_hooks', 'Hooks'], ['provides_tools', 'Tools'], ['provides_middleware', 'Middleware']];

const HERMES_ADAPTER: PluginAdapter = {
  scopes: ['user'],

  async list(run) {
    const j = parseJson(await run(['plugins', 'list', '--json'], { timeoutMs: LIST_TIMEOUT_MS }), "Hermes's plugin list");
    if (!Array.isArray(j)) { throw new PluginCliError("Couldn't read Hermes's plugin list."); }
    return {
      installed: objs(j).filter((p) => str(p.name) && p.removed !== true).map((p): InstalledPlugin => ({
        id: String(p.name), name: String(p.name), version: str(p.version), description: str(p.description), scope: 'user', enabled: p.status === 'enabled',
      })),
    };
  },

  async search(run, query) {
    const j = parseJson(await run(['plugins', 'search', query, '--json'], { timeoutMs: LIST_TIMEOUT_MS }), 'Hermes catalog results');
    return objs(obj(j).results).filter((p) => str(p.name)).map((p): CatalogPlugin => {
      const parts = HERMES_CAPABILITIES.filter(([k]) => obj(p.capabilities)[k] === true).map(([, label]) => label);
      // A Hermes plugin is Python that runs inside the agent, whatever it declares.
      return { id: String(p.name), name: String(p.name), marketplace: 'Hermes catalog', description: str(p.description), version: str(p.version), codeParts: parts.length ? parts : ['Python code'] };
    });
  },

  async inspect(_run, entry) { return entry.codeParts ?? 'unknown'; },

  // --enable answers its "Enable now?" question up front.
  async install(run, id) { expectExit0(await run(['plugins', 'install', id, '--enable'], MUTATE), 'Install'); },
  async uninstall(run, p) { expectExit0(await run(['plugins', 'remove', p.id], MUTATE), 'Uninstall'); },
  async setEnabled(run, p, on) { expectExit0(await run(['plugins', on ? 'enable' : 'disable', p.id], MUTATE), on ? 'Enable' : 'Disable'); },
  async update(run, p) { expectExit0(await run(['plugins', 'update', p.id], MUTATE), 'Update'); },
};

// ── Codex ───────────────────────────────────────────────────────────────────
// Codex 0.160.0: plugin list/add/remove + marketplace add/list/upgrade/remove,
// all with --json. No enable/disable/update command exists.

const LIST = { timeoutMs: LIST_TIMEOUT_MS };

const CODEX_ADAPTER: PluginAdapter = {
  scopes: ['user'],
  note: "Turning plugins on and off isn't available from Codex's command line. Use /plugins inside Codex for that.",

  async list(run) {
    const r = await run(['plugin', 'list', '--json', '--available'], LIST);
    const j = obj(parseJson(r, "Codex's plugin list"));
    if (!Array.isArray(j.installed)) { throw new PluginCliError("Couldn't read Codex's plugin list."); }
    const installed = objs(j.installed).filter((p) => str(p.pluginId)).map((p): InstalledPlugin => ({
      id: String(p.pluginId), name: str(p.name) ?? String(p.pluginId), marketplace: str(p.marketplaceName),
      version: str(p.version), scope: 'user', enabled: p.enabled !== false,
    }));
    const ids = new Set(installed.map((p) => p.id));
    const available = objs(j.available).filter((p) => str(p.pluginId) && p.installed !== true && !ids.has(String(p.pluginId))).map((p): CatalogPlugin => ({
      id: String(p.pluginId), name: str(p.name) ?? String(p.pluginId), marketplace: str(p.marketplaceName), version: str(p.version),
    }));
    // A failed remote catalog fetch still exits 0, with empty lists and a stderr warning.
    const down = /failed to list remote marketplace plugins/i.test(r.stderr);
    // Unknown is not zero: an empty list from a failed fetch says nothing.
    if (down && installed.length === 0) {
      throw new PluginCliError("Codex couldn't reach its plugin catalog, so Mysti can't tell what's installed. Refresh to try again.");
    }
    return { installed, available, warning: down ? "Codex couldn't reach its plugin catalog, so these lists may be incomplete. Refresh to try again." : undefined };
  },

  async inspect() { return 'unknown'; },
  async install(run, id) { expectExit0(await run(['plugin', 'add', id, '--json'], MUTATE), 'Install'); },
  async uninstall(run, p) { expectExit0(await run(['plugin', 'remove', p.id, '--json'], MUTATE), 'Uninstall'); },

  marketplaces: {
    async list(run) {
      const r = await run(['plugin', 'marketplace', 'list', '--json'], LIST);
      expectExit0(r, "Reading Codex's marketplaces");
      return objs(obj(parseJson(r, "Codex's marketplaces")).marketplaces).filter((m) => str(m.name)).map((m): Marketplace => {
        const source = str(obj(m.marketplaceSource).source);
        // The curated marketplace Codex ships with has no source of its own.
        return { name: String(m.name), source: source ?? 'built in', builtin: !source };
      });
    },
    async add(run, source) { expectExit0(await run(['plugin', 'marketplace', 'add', source, '--json'], MUTATE), 'Adding the marketplace'); },
    async remove(run, name) { expectExit0(await run(['plugin', 'marketplace', 'remove', name, '--json'], MUTATE), 'Removing the marketplace'); },
    async refresh(run, name) {
      const r = await run(['plugin', 'marketplace', 'upgrade', name, '--json'], MUTATE);
      expectExit0(r, 'Refreshing the marketplace');
      const errors = objs(obj(parseJson(r, 'the refresh result')).errors).map((e) => str(e.message)).filter(Boolean);
      if (errors.length) { throw new PluginCliError(errors.join('\n')); }
    },
  },
};

// ── Gemini ──────────────────────────────────────────────────────────────────
// Gemini 0.62.0: `extensions list -o json` writes to STDERR. There is no
// catalog command. `update` is not offered: it can prompt with no flag to skip
// it, and it exits 0 when it fails.

const GEMINI_ADAPTER: PluginAdapter = {
  scopes: ['user'],
  note: "Gemini's command line has no catalog: find extensions at geminicli.com/extensions and paste the repository URL below. Update extensions with `gemini extensions update` in a terminal.",
  sourceHint: { label: 'Git repository URL or local path', placeholder: 'https://github.com/owner/extension' },

  async list(run) {
    const r = await run(['extensions', 'list', '-o', 'json'], LIST);
    const j = parseJson({ ...r, stdout: r.stderr.trim() ? r.stderr : r.stdout }, "Gemini's extension list");
    if (!Array.isArray(j)) { throw new PluginCliError("Couldn't read Gemini's extension list."); }
    // Only these fields are kept: resolvedSettings can hold secret values.
    return {
      installed: objs(j).filter((e) => str(e.name)).map((e): InstalledPlugin => ({
        id: String(e.name), name: String(e.name), version: str(e.version), scope: 'user', enabled: e.isActive !== false,
        description: str(obj(e.installMetadata).source),
      })),
    };
  },

  // --consent: the native modal Mysti always shows before a source install IS the consent.
  async installSource(run, source) { expectExit0(await run(['extensions', 'install', source, '--consent', '--skip-settings'], MUTATE), 'Install'); },
  async uninstall(run, p) { expectExit0(await run(['extensions', 'uninstall', p.id], MUTATE), 'Uninstall'); },
  async setEnabled(run, p, on) { expectExit0(await run(['extensions', on ? 'enable' : 'disable', '--scope', 'user', p.id], MUTATE), on ? 'Enable' : 'Disable'); },
};

// ── Qwen Code ───────────────────────────────────────────────────────────────
// Qwen 0.24.7 has no JSON output, and its labels are localised, so the parser
// keys on what can't be translated: the extension's folder under
// .qwen/extensions and the ✓/✗ header. Anything else it can't read is an
// error, never an empty list. `update` is not offered (it exits 0 on failure).

/** @internal exported for tests */
export function parseQwenExtensions(text: string): InstalledPlugin[] | undefined {
  const out: InstalledPlugin[] = [];
  // eslint-disable-next-line no-control-regex -- stripping ANSI color escapes is the point
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  for (const block of clean.split(/\r?\n\s*\r?\n/)) {
    // A whole "<label>: <path>" line, so a description that mentions another
    // extension's path can't lend it its id.
    const where = /^\s*[^:\n]+:\s*(\S*[\\/]\.qwen[\\/]extensions[\\/][^\s\\/]+)\s*$/m.exec(block);
    if (!where) { continue; }
    const id = path.basename(where[1]);
    const header = /^\s*([✓✗])\s+(.*)\s+\(([^()]*)\)\s*$/m.exec(block);
    const description = /^\s*Description:\s*(.+)$/m.exec(block)?.[1];
    out.push({
      id, name: header?.[2].trim() || id, version: header?.[3] || undefined, scope: 'user',
      enabled: header ? header[1] === '✓' : undefined, description: description?.trim(),
    });
  }
  if (out.length) { return out; }
  return /^\s*No extensions installed\.?\s*$/.test(clean) ? [] : undefined;
}

function parseQwenSources(text: string): Marketplace[] | undefined {
  if (/^\s*No marketplace sources added yet\.?\s*$/.test(text)) { return []; }
  const out: Marketplace[] = [];
  for (const block of text.split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2 || /^\s/.test(lines[0])) { continue; }
    out.push({ name: lines[0].trim(), source: lines[1].replace(/^\s*[^:]+:\s*/, '').replace(/\s*\([^)]*\)\s*$/, '') });
  }
  return out.length ? out : undefined;
}

const QWEN_ADAPTER: PluginAdapter = {
  scopes: ['user', 'project'],
  note: "Qwen's command line can't list a catalog: browse with /extensions inside Qwen, or install by source below. Update extensions with /extensions inside Qwen.",
  sourceHint: { label: 'Git URL, local path, npm package, or marketplace-url:plugin', placeholder: 'https://github.com/owner/extension' },

  async list(run) {
    const r = await run(['extensions', 'list'], LIST);
    expectExit0(r, "Reading Qwen's extensions");
    const installed = parseQwenExtensions(r.stdout);
    if (!installed) { throw new PluginCliError("Couldn't read Qwen's extension list. If Qwen's language isn't English, its output can't be read here."); }
    return { installed };
  },

  async installSource(run, source, scope) { expectExit0(await run(['extensions', 'install', source, '--scope', scope, '--consent'], MUTATE), 'Install'); },
  async uninstall(run, p) { expectExit0(await run(['extensions', 'uninstall', p.id], MUTATE), 'Uninstall'); },
  async setEnabled(run, p, on) { expectExit0(await run(['extensions', on ? 'enable' : 'disable', '--scope', 'user', p.id], MUTATE), on ? 'Enable' : 'Disable'); },

  marketplaces: {
    async list(run) {
      const r = await run(['extensions', 'sources', 'list'], LIST);
      expectExit0(r, "Reading Qwen's sources");
      const sources = parseQwenSources(r.stdout);
      if (!sources) { throw new PluginCliError("Couldn't read Qwen's marketplace sources."); }
      return sources;
    },
    async add(run, source) { expectExit0(await run(['extensions', 'sources', 'add', source], MUTATE), 'Adding the source'); },
    async remove(run, name) { expectExit0(await run(['extensions', 'sources', 'remove', name], MUTATE), 'Removing the source'); },
    async refresh(run, name) { expectExit0(await run(['extensions', 'sources', 'update', name], MUTATE), 'Refreshing the source'); },
  },
};

// ── Cline ───────────────────────────────────────────────────────────────────
// Cline 3.0.68 can install and uninstall but has no list command, so installed
// plugins are read (read-only) from its plugin folders:
// <root>/_installed/<kind>/…/<slug>-<hash>/package.json.

function clineHome(): string {
  return process.env.CLINE_DIR || path.join(os.homedir(), '.cline');
}

function clineInstalls(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 5) { return; }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      // No folder is "nothing installed"; a folder it can't read is unknown.
      if (depth === 0 && (e as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new PluginCliError(`Couldn't read Cline's plugin folder ${dir}: ${(e as NodeJS.ErrnoException).code ?? errorMessage(e)}`);
      }
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'package.json')) { found.push(dir); return; }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') { walk(path.join(dir, e.name), depth + 1); }
    }
  };
  walk(path.join(root, '_installed'), 0);
  return found.sort();
}

const CLINE_ADAPTER: PluginAdapter = {
  scopes: ['user', 'project'],
  note: "Turning plugins on and off isn't available from Cline's command line. Use Cline's settings screen for that.",
  sourceHint: { label: 'Official plugin name, npm package, git URL, or local path', placeholder: 'plugin-name or https://github.com/owner/plugin' },

  async list(run) {
    const settingsFile = path.join(clineHome(), 'data', 'settings', 'global-settings.json');
    const settings = readJson(settingsFile);
    // A settings file that exists but can't be read leaves on/off unknown.
    const known = settings !== undefined || !fs.existsSync(settingsFile);
    const disabled = obj(settings).disabledPlugins;
    const off = new Set(Array.isArray(disabled) ? disabled.filter((x): x is string => typeof x === 'string') : []);
    const roots: [string, PluginScope][] = [[path.join(clineHome(), 'plugins'), 'user']];
    if (run.cwd) { roots.push([path.join(run.cwd, '.cline', 'plugins'), 'project']); }
    const installed: InstalledPlugin[] = [];
    for (const [root, scope] of roots) {
      for (const dir of clineInstalls(root)) {
        const pkg = obj(readJson(path.join(dir, 'package.json')));
        const name = str(pkg.name) ?? path.basename(dir);
        installed.push({ id: dir, name, version: str(pkg.version), description: str(pkg.description), scope, enabled: known ? !off.has(dir) && !off.has(name) : undefined });
      }
    }
    return { installed };
  },

  async installSource(run, source, scope) {
    const args = ['plugin', 'install', source, '--json'];
    if (scope === 'project') {
      if (!run.cwd) { throw new PluginCliError('Open a folder to install a plugin for this project.'); }
      args.push('--cwd', run.cwd);
    }
    expectExit0(await run(args, MUTATE), 'Install');
  },
  // By install path: unambiguous, and the CLI accepts a path.
  async uninstall(run, p) {
    const args = ['plugin', 'uninstall', p.id, '--json'];
    if (p.scope === 'project' && run.cwd) { args.push('--cwd', run.cwd); }
    expectExit0(await run(args, MUTATE), 'Uninstall');
  },
};

// ── OpenCode ────────────────────────────────────────────────────────────────
// OpenCode 1.18.34: `opencode plugin <module> [-g]` installs; there is no list
// or uninstall for plugins (its top-level `uninstall` removes OpenCode itself,
// so it is never called). `debug config` prints the resolved config.

const OPENCODE_ADAPTER: PluginAdapter = {
  scopes: ['user', 'project'],
  note: "OpenCode's command line can install plugins but not remove them. To remove one, delete it from the plugin list in opencode.json.",
  sourceHint: { label: 'npm package', placeholder: 'opencode-plugin-name' },

  async list(run) {
    const j = obj(parseJson(await run(['debug', 'config'], LIST), "OpenCode's config"));
    const origins = objs(j.plugin_origins);
    const specs = (Array.isArray(j.plugin) ? j.plugin : [])
      .map((p) => (typeof p === 'string' ? p : Array.isArray(p) && typeof p[0] === 'string' ? p[0] : undefined))
      .filter((p): p is string => !!p);
    return {
      installed: specs.map((spec): InstalledPlugin => ({
        id: spec, name: spec, scope: origins.find((o) => o.spec === spec)?.scope === 'local' ? 'project' : 'user',
      })),
    };
  },

  // -g writes the global config; without it, the project's .opencode/opencode.json.
  async installSource(run, source, scope) { expectExit0(await run(['plugin', source, ...(scope === 'user' ? ['-g'] : [])], MUTATE), 'Install'); },
};

// ── Cursor ──────────────────────────────────────────────────────────────────
// Cursor 2026.10.01 manages plugin marketplaces from its CLI; plugins
// themselves are installed only inside Cursor.

const CURSOR_ADAPTER: PluginAdapter = {
  scopes: ['user'],
  note: "Cursor installs plugins only inside Cursor: use /plugins in its agent, or the Cursor app. Marketplaces can be managed here.",
  marketplaces: {
    async list(run) {
      const r = await run(['plugin', 'marketplace', 'list', '--format', 'json'], LIST);
      expectExit0(r, "Reading Cursor's marketplaces");
      return objs(parseJson(r, "Cursor's marketplaces")).filter((m) => str(m.name)).map((m): Marketplace => ({
        name: String(m.name),
        source: `${str(m.gitUrl) ?? ''}${str(m.gitRef) ? `@${String(m.gitRef)}` : ''}`,
        // Team and global marketplaces are managed from the Cursor dashboard.
        builtin: !(m.scope === 'user' || m.scope === 'local'),
      }));
    },
    async add(run, source) { expectExit0(await run(['plugin', 'marketplace', 'add', source], MUTATE), 'Adding the marketplace'); },
    async remove(run, name) { expectExit0(await run(['plugin', 'marketplace', 'remove', name], MUTATE), 'Removing the marketplace'); },
    async refresh(run, name) { expectExit0(await run(['plugin', 'marketplace', 'update', name], MUTATE), 'Refreshing the marketplace'); },
  },
};

// ── The table ───────────────────────────────────────────────────────────────

/**
 * TOTAL over ProviderType, so a new backend without an entry fails tsc. A
 * `{ note }` is a backend whose plugins are managed somewhere Mysti can't drive
 * (yet); `null` means it has no plugin system at all.
 */
export const PLUGIN_ADAPTERS: Record<ProviderType, PluginBackend> = {
  'claude-code': CLAUDE_ADAPTER,
  'github-copilot': COPILOT_ADAPTER,
  'openclaw': OPENCLAW_ADAPTER,
  'hermes': HERMES_ADAPTER,
  'openai-codex': CODEX_ADAPTER,
  'google-gemini': GEMINI_ADAPTER,
  'qwen-code': QWEN_ADAPTER,
  'cline': CLINE_ADAPTER,
  'opencode': OPENCODE_ADAPTER,
  'cursor': CURSOR_ADAPTER,
  'kimi-code': { note: 'Manage Kimi plugins with /plugins inside Kimi.' },
  'continue': null,
  'ollama': null,
  'localai': null,
  'openrouter': null,
  'minimax': null,
};

export function isAdapter(b: PluginBackend): b is PluginAdapter {
  return !!b && 'scopes' in b;
}
