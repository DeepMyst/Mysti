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
 * Plan 39 — Manage Plugins: one adapter per backend that has a plugin system.
 *
 * Every adapter drives that backend's OWN CLI (execFile, no shell) and never
 * writes another tool's config. An operation is supported iff its method
 * exists, so the panel can never offer something the CLI cannot do.
 *
 * Exit codes are not trusted where the CLI is known to lie: Claude Code exits
 * 0 on a failed install and 1 on an already-disabled disable, so its result is
 * the `--json` line's `outcome`.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { ProviderType } from '../../types';
import { getEnrichedEnv } from '../../utils/platform';

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
export type Run = (args: string[], opts?: { timeoutMs?: number }) => Promise<RunResult>;

/** Executable component kinds (`[]` = none), or `'unknown'` when they cannot be seen before install. */
export type CodeParts = string[] | 'unknown';

export class PluginCliError extends Error {
  constructor(message: string, readonly acceptCommand?: { command: string; sha: string }) {
    super(message);
    this.name = 'PluginCliError';
  }
}

export interface PluginAdapter {
  scopes: PluginScope[];
  list(run: Run): Promise<PluginListing>;
  /** Catalogs that only answer a query (ClawHub, Hermes). */
  search?(run: Run, query: string): Promise<CatalogPlugin[]>;
  inspect(run: Run, entry: CatalogPlugin): Promise<CodeParts>;
  install(run: Run, id: string, scope: PluginScope, approval?: Approval): Promise<void>;
  uninstall?(run: Run, p: InstalledPlugin): Promise<void>;
  setEnabled?(run: Run, p: InstalledPlugin, on: boolean): Promise<void>;
  update?(run: Run, p: InstalledPlugin): Promise<void>;
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
  return new Promise((resolve) => {
    const child = execFile(cliPath, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? LIST_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      env: getEnrichedEnv(),
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number | string; killed?: boolean; signal?: string | null }) | null;
      resolve({
        code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? '') || (e && typeof e.code !== 'number' ? e.message : ''),
        timedOut: !!e && e.killed === true && e.signal === 'SIGKILL',
      });
    });
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
  // Some CLIs print a warning banner before the JSON (OpenClaw's config box).
  const lines = r.stdout.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*[[{]/.test(l));
  if (start > 0) {
    try { return JSON.parse(lines.slice(start).join('\n')); } catch { /* fall through */ }
  }
  const why = cleanCliText(r.stderr);
  throw new PluginCliError(`Couldn't read ${what}${why ? `: ${why}` : '.'}`);
}

function splitId(id: string): { name: string; marketplace?: string } {
  const at = id.lastIndexOf('@');
  return at > 0 ? { name: id.slice(0, at), marketplace: id.slice(at + 1) } : { name: id };
}

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
 * A Claude `--json` mutation result. Failure is `outcome: "failed"` unless the
 * plugin is already in the requested state; the exit code is only a tiebreak.
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
  if (j.outcome === 'failed' || r.code !== 0) {
    throw new PluginCliError(str(j.message) ?? str(j.failureCode) ?? 'Claude Code reported a failure.', claudeAcceptCommand(j));
  }
}

/**
 * The marketplace-declared install command Claude wants approved. Its JSON
 * shape is unverified, so this offers approval only when BOTH a 64-hex hash
 * and the command text are present; otherwise the plain error shows.
 */
function claudeAcceptCommand(j: Record<string, unknown>): { command: string; sha: string } | undefined {
  let sha: string | undefined;
  let command: string | undefined;
  for (const [k, v] of Object.entries(j)) {
    if (typeof v !== 'string') { continue; }
    if (!sha && /sha/i.test(k) && /^[0-9a-f]{64}$/i.test(v)) { sha = v.toLowerCase(); }
    // `command` alone is the subcommand name ("install"), not the declared command.
    if (!command && k !== 'command' && /command/i.test(k)) { command = v; }
  }
  return sha && command ? { command, sha } : undefined;
}

/** Manifest keys that declare something which RUNS (vs. prompt content). */
const CLAUDE_CODE_KEYS: Record<string, string> = { hooks: 'Hooks', mcpServers: 'MCP servers', lspServers: 'LSP servers' };
const CLAUDE_PART_ORDER = ['Hooks', 'MCP servers', 'LSP servers'];
/** Every key seen in real marketplace entries and plugin.json files that declares no code. */
const CLAUDE_SAFE_KEYS = new Set([
  '$schema', 'name', 'displayName', 'description', 'version', 'author', 'homepage', 'repository', 'license',
  'keywords', 'category', 'tags', 'source', 'strict', 'commands', 'agents', 'skills', 'outputStyles', 'userConfig',
]);

/** Adds the code parts an object declares; false when it has a key we don't know. */
function claudeKeys(o: unknown, parts: Set<string>): boolean {
  if (!o || typeof o !== 'object') { return true; }
  for (const k of Object.keys(o)) {
    if (CLAUDE_CODE_KEYS[k]) { parts.add(CLAUDE_CODE_KEYS[k]); } else if (!CLAUDE_SAFE_KEYS.has(k)) { return false; }
  }
  return true;
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
   * What the plugin RUNS, read from the marketplace copy already on disk. Fails
   * closed: a remote source, a missing directory, a path outside the
   * marketplace or an unrecognised manifest key is `'unknown'`.
   */
  async inspect(run, entry) {
    const markets = parseJson(await run(['plugin', 'marketplace', 'list', '--json'], { timeoutMs: LIST_TIMEOUT_MS }), "Claude Code's marketplaces");
    const location = str(objs(markets).find((m) => m.name === entry.marketplace)?.installLocation);
    if (!location) { return 'unknown'; }
    const root = path.resolve(location);
    const e = objs(obj(readJson(path.join(root, '.claude-plugin', 'marketplace.json'))).plugins).find((p) => p.name === entry.name);
    if (!e || typeof e.source !== 'string') { return 'unknown'; }
    const dir = path.resolve(root, e.source);
    if ((dir !== root && !dir.startsWith(root + path.sep)) || !fs.existsSync(dir)) { return 'unknown'; }
    const parts = new Set<string>();
    if (!claudeKeys(e, parts) || !claudeKeys(readJson(path.join(dir, '.claude-plugin', 'plugin.json')), parts)) { return 'unknown'; }
    if (fs.existsSync(path.join(dir, 'hooks', 'hooks.json'))) { parts.add('Hooks'); }
    if (fs.existsSync(path.join(dir, '.mcp.json'))) { parts.add('MCP servers'); }
    if (fs.existsSync(path.join(dir, '.lsp.json'))) { parts.add('LSP servers'); }
    return CLAUDE_PART_ORDER.filter((p) => parts.has(p));
  },

  async install(run, id, scope, approval) {
    const args = ['plugin', 'install', id, '-s', scope, '--json'];
    if (approval?.acceptCommandSha) { args.push('--accept-command', approval.acceptCommandSha); }
    claudeOutcome(await run(args, MUTATE));
  },
  async uninstall(run, p) { claudeOutcome(await run(['plugin', 'uninstall', p.id, ...claudeScope(p), '--json'], MUTATE)); },
  async setEnabled(run, p, on) { claudeOutcome(await run(['plugin', on ? 'enable' : 'disable', p.id, ...claudeScope(p), '--json'], MUTATE)); },
  async update(run, p) { claudeOutcome(await run(['plugin', 'update', p.id, ...claudeScope(p), '--json'], MUTATE)); },
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
        id: String(p.name), name: String(p.name), marketplace: str(p.marketplace), version: str(p.version), scope: 'user', enabled: p.enabled !== false,
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
      version: str(p.latestVersion), installCount: num(obj(p.stats).installs),
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
  'openai-codex': { note: 'Manage Codex plugins with /plugins inside Codex.' },
  'google-gemini': { note: 'Manage Gemini extensions with `gemini extensions` in a terminal.' },
  'qwen-code': { note: 'Manage Qwen extensions with /extensions inside Qwen Code.' },
  'cline': { note: 'Manage Cline plugins in its settings screen, or with `cline plugin` in a terminal.' },
  'opencode': { note: 'Manage OpenCode plugins in the plugin list of opencode.json.' },
  'cursor': { note: 'Manage Cursor plugins with /plugin inside Cursor, or in the Cursor app.' },
  'kimi-code': { note: 'Manage Kimi plugins with /plugins inside Kimi.' },
  'continue': null,
  'ollama': null,
  'localai': null,
  'openrouter': null,
};

export function isAdapter(b: PluginBackend): b is PluginAdapter {
  return !!b && 'list' in b;
}
