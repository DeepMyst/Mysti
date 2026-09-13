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
 * MystiLocalTools (Plan 17 P0.1) — READ-ONLY local tools for the Mysti
 * coordinator: read / ls / grep / diag. Handled in-process (no CLI spawn, no
 * shell) so "look then decide" costs milliseconds instead of a cold-start
 * delegation.
 *
 * Security invariants (plans/17 §5):
 *   - READ-ONLY. There is deliberately no write / bash / exec counterpart —
 *     mutation and execution stay inside gated delegations.
 *   - Workspace-fenced: every path resolves inside the workspace root; `..`
 *     traversal and symlink escapes are rejected via realpath prefix checks.
 *   - Output-capped everywhere (a tool result is fed back into a finite-context
 *     coordinator model).
 *   - Results are treated as UNTRUSTED data by the caller (nonce-fenced before
 *     re-entering the model), same as delegate results.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface LocalToolResult {
  ok: boolean;
  /** Pre-formatted, size-capped text for the tool card + the model feedback. */
  output: string;
}

/** Injectable seams so unit tests can run against a temp dir without vscode. */
export interface MystiLocalToolsDeps {
  getWorkspaceRoot?: () => string | undefined;
  findFiles?: (include: string, exclude: string, maxResults: number) => Promise<string[]>;
  getDiagnostics?: () => Array<{ fsPath: string; diags: Array<{ line: number; severity: number; message: string }> }>;
}

const READ_HEAD_CHARS = 18_000;
const READ_TAIL_CHARS = 6_000;
const LS_MAX_ENTRIES = 200;
const GREP_MAX_FILES = 400;
const GREP_MAX_FILE_BYTES = 1_000_000;
const GREP_MAX_MATCHES = 120;
const GREP_TIME_BUDGET_MS = 3_000;
const GREP_LINE_CLAMP = 240;
const GREP_PROBE_CHARS = 2_000; // clamp the REGEX-TEST input, not just the output (ReDoS)
const DIAG_MAX_ENTRIES = 120;
const GREP_DEFAULT_EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**,**/coverage/**}';

/**
 * Credential/secret files the coordinator must not read or grep — their
 * contents would flow to the free third-party coordinator model. Matched on the
 * workspace-relative POSIX path (review [2]).
 */
const SECRET_FILE_RE = /(^|\/)(\.env(\.[^/]*)?|\.npmrc|\.netrc|\.pgpass|\.htpasswd|\.git-credentials|\.pypirc|\.dockercfg|\.docker\/config\.json|\.mcp\.json|kubeconfig|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|[^/]*\.(pem|key|pfx|p12|keystore|jks|tfvars)|[^/]*\.tfstate(\.backup)?|[^/]*(credential|secret|token)[^/]*\.(json|ya?ml|yml|txt|ini|cfg|conf|env|properties)|service[-_]?account.*\.json|[^/]*-adminsdk-[^/]*\.json)$/i;
/** Directory names whose entire subtree is credential material. */
const SECRET_DIR_RE = /(^|\/)(\.ssh|\.aws|\.gnupg|\.kube|\.docker|secrets|vault)(\/|$)/i;

/**
 * `.env.example` (and friends) are documentation, not credentials — they ship
 * placeholder values on purpose and are the file a developer most often wants
 * the agent to read when wiring up config. Blocking them was a false positive
 * that taught users the filter was noise.
 */
const SECRET_EXEMPT_RE = /(^|\/)\.env\.(example|sample|template|dist)$/i;

function looksLikeSecret(relPosix: string): boolean {
  if (SECRET_EXEMPT_RE.test(relPosix)) { return false; }
  return SECRET_DIR_RE.test(relPosix) || SECRET_FILE_RE.test(relPosix);
}

/** Where agent-authored artifacts are staged before a human promotes them. */
export const SKILL_STAGING_DIR = '.mysti/skills.staged';

/**
 * Paths an AGENT may never write, even when local execution is on.
 *
 * These are the files that tell an agent — this one or a different one, now or
 * next session — how to behave. A write here is not an edit, it is a durable
 * change to the instructions the next run is given, and it converts a one-shot
 * prompt injection into persistence. It also escapes review: nobody reads a
 * `.cursorrules` diff the way they read a source diff, and the published
 * "rules file backdoor" work exists precisely because that assumption fails.
 *
 * Mysti's own live artifact tree is included: authoring goes to the STAGING
 * directory and is promoted by a human, so there is no legitimate direct write.
 * Other assistants' instruction files are included too — Mysti has no business
 * silently rewriting how Claude Code, Cursor, or Copilot behave in this repo.
 *
 * Deliberately NOT a general "config" ban: ordinary project config
 * (package.json, tsconfig, CI) is normal work and stays writable.
 */
const PROTECTED_WRITE_RE = new RegExp([
  // Mysti's own live agent artifacts — staging is the writable path.
  '^\\.mysti/agents(/|$)',
  // Other agents' instruction/config surfaces.
  '^\\.claude(/|$)',
  '^\\.cursor(/|$)',
  '^\\.cursorrules$',
  '^\\.github/copilot-instructions\\.md$',
  '^\\.aider\\.conf\\.yml$',
  '^(CLAUDE|AGENTS|GEMINI|MYSTI)\\.md$',
  '^\\.mysti/mysti\\.md$',
  '^\\.mysti/rules(/|$)',
  // MCP server wiring: editing it redirects where tool calls actually go.
  '^\\.mcp\\.json$',
  // VSCode task/launch/settings files execute commands on open or on save.
  '^\\.vscode/(settings|tasks|launch)\\.json$',
].join('|'), 'i');

/**
 * Is this an instruction-surface path an agent must not write directly?
 * Returns the reason (for the refusal message) or null when the write is fine.
 */
export function protectedWriteReason(relPosix: string): string | null {
  const clean = relPosix.replace(/^\.\//, '');
  // The staging tree lives UNDER .mysti/ but is explicitly writable — that is
  // the whole point of having it.
  if (clean === SKILL_STAGING_DIR || clean.startsWith(`${SKILL_STAGING_DIR}/`)) { return null; }
  if (!PROTECTED_WRITE_RE.test(clean)) { return null; }
  if (/^\.mysti\/agents(\/|$)/i.test(clean)) {
    return `"${relPosix}" is a live agent definition. Write to ${SKILL_STAGING_DIR}/<id>/ instead — the user reviews and promotes it from there.`;
  }
  return `"${relPosix}" configures how an AI assistant behaves. Agents may not edit instruction files directly; ask the user to change it.`;
}

/**
 * Reject a regex likely to catastrophically backtrack; the caller falls back to
 * a LITERAL search so the tool still works (review [1], re-review HIGH).
 *
 * Catastrophic backtracking comes from a QUANTIFIED GROUP — `(…)+`, `(…)*`,
 * `(…){n,}` — where the group has internal ambiguity (`(a+)+`, `(a|a)+`,
 * `(.*)*`, `(a|a|a)+`). Detecting a quantifier applied to a `)` catches all of
 * these. A char-class + quantifier (`[a-z]+`, `\w+`, `[^"]+`) is LINEAR and must
 * NOT be flagged — the previous `\][^\]]*[+*]` rule wrongly literalized those.
 */
function isDangerousRegex(src: string): boolean {
  return /\)\s*(?:[?+*]{0,2}[+*]|\{\s*\d)/.test(src) // quantified group: (…)+ (…)* (…){n,} (…)?+ …
    || /[+*]\s*[+*]/.test(src)                        // adjacent quantifiers: a+*  .*+
    || /\{\s*\d{3,}\s*,?\s*\d*\s*\}/.test(src);       // huge bounded repetition
}

export class MystiLocalTools {
  constructor(private readonly _deps: MystiLocalToolsDeps = {}) {}

  private _root(): string | undefined {
    if (this._deps.getWorkspaceRoot) { return this._deps.getWorkspaceRoot(); }
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /** The workspace root, or undefined when no folder is open (public for MystiLocalExec's bash cwd). */
  workspaceRoot(): string | undefined {
    return this._root();
  }

  /**
   * Resolve a model-supplied path INSIDE the workspace, rejecting absolute
   * escapes, `..` traversal, and symlinks pointing outside. Returns the real
   * absolute path, or null when the path is not safely inside the workspace.
   */
  private async _safeResolve(rel: string): Promise<{ abs: string; root: string; real: string } | null> {
    const root = this._root();
    if (!root) { return null; }
    const cleaned = rel.replace(/^["']|["']$/g, '').trim();
    const abs = path.resolve(root, cleaned === '.' || cleaned === '' ? '.' : cleaned);
    const realRoot = await fs.promises.realpath(root).catch(() => null);
    if (!realRoot) { return null; }
    // The target may not exist (caller reports not-found); realpath its nearest
    // existing ancestor to catch symlink escapes on the path itself.
    let probe = abs;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) { break; }
      probe = parent;
    }
    const realProbe = await fs.promises.realpath(probe).catch(() => null);
    if (!realProbe) { return null; }
    if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) { return null; }
    // `real` = realpath of the TARGET when it exists (so a symlink resolves to
    // its true path) — the secret-file filter must run on this, not the lexical
    // abs, or `notes.txt -> .env` bypasses it (re-review MEDIUM).
    const real = path.resolve(realProbe, path.relative(probe, abs));
    // Keep the target and root in the same spelling. On Windows a temp path
    // may use an 8.3 alias while realpath expands it; mixing the two produces
    // bogus ../ paths in approval cards and secret-file checks.
    let relative = path.relative(root, abs);
    const escapes = (value: string) => value === '..' || value.startsWith('..' + path.sep) || path.isAbsolute(value);
    if (escapes(relative)) { relative = path.relative(realRoot, abs); }
    if (escapes(relative)) { return null; }
    const canonicalAbs = path.resolve(realRoot, relative);
    return { abs: canonicalAbs, root: realRoot, real };
  }

  /** Workspace-relative POSIX path (for secret-file matching, stable across OS). */
  private _relPosix(root: string, abs: string): string {
    return path.relative(root, abs).split(path.sep).join('/');
  }

  /**
   * Resolve + secret-check a WRITE / edit target for the coordinator's gated
   * local-execution layer (Plan 19). Returns the safe absolute path (which may
   * not exist yet — that's fine for a create), or an actionable error.
   *
   * This is PATH-SAFETY ONLY — it applies the exact same workspace-scoping
   * (`_safeResolve`: absolute-escape / `..` / symlink-out rejection) and secret
   * filter (`looksLikeSecret`) as `read()`. Mutation itself never happens here;
   * it stays behind the permission gate + checkpoint in `MystiLocalExec`.
   */
  async resolveWriteTarget(relPath: string): Promise<{ ok: true; abs: string; relPosix: string } | { ok: false; output: string }> {
    const r = await this._safeResolve(relPath);
    if (!r) {
      return { ok: false, output: `"${relPath}" is not inside the workspace (or no workspace is open).` };
    }
    // Refuse to write THROUGH a symlink leaf. `_safeResolve`'s existence probe
    // (`fs.existsSync`) FOLLOWS symlinks, so a DANGLING symlink (target absent)
    // reads as non-existent, slips past the containment check, and `writeFile`
    // would then create the file at the link's out-of-workspace target
    // (e.g. `notes.txt -> ~/.ssh/authorized_keys`). A write/patch target must
    // never itself be a symlink — lstat does NOT follow, so it catches both the
    // dangling and the in-workspace-alias cases (review round-4 HIGH).
    const linkStat = await fs.promises.lstat(r.abs).catch(() => null);
    if (linkStat?.isSymbolicLink()) {
      return { ok: false, output: `"${relPath}" is a symlink — refusing to write through it.` };
    }
    const relAbs = this._relPosix(r.root, r.abs);
    // Check both the lexical path and the symlink-resolved real path so a
    // `notes.txt -> .env` target can't smuggle a secret write past the filter.
    if (looksLikeSecret(relAbs) || looksLikeSecret(this._relPosix(r.root, r.real))) {
      return { ok: false, output: `"${relPath}" looks like a credentials/secret file — writing secret files is blocked.` };
    }
    // Plan 20 Phase 2 (invariant I4): instruction surfaces are not ordinary
    // files. Checked on BOTH the lexical and symlink-resolved paths, same as
    // the secret filter — a `notes.md -> .mysti/agents/personas/x.md` alias
    // would otherwise smuggle the write past this.
    const protectedReason = protectedWriteReason(relAbs) || protectedWriteReason(this._relPosix(r.root, r.real));
    if (protectedReason) {
      return { ok: false, output: protectedReason };
    }
    return { ok: true, abs: r.abs, relPosix: relAbs };
  }

  /** read — file contents with line numbers; optional 1-based inclusive range. */
  async read(relPath: string, startLine?: number, endLine?: number): Promise<LocalToolResult> {
    const r = await this._safeResolve(relPath);
    if (!r) { return { ok: false, output: `read: "${relPath}" is not inside the workspace (or no workspace is open).` }; }
    if (looksLikeSecret(this._relPosix(r.root, r.real)) || looksLikeSecret(this._relPosix(r.root, r.abs))) {
      return { ok: false, output: `read: "${relPath}" looks like a credentials/secret file — blocked. Ask the user to paste only what's needed.` };
    }
    let stat: fs.Stats;
    try { stat = await fs.promises.stat(r.abs); } catch { return { ok: false, output: `read: "${relPath}" not found.` }; }
    if (stat.isDirectory()) { return { ok: false, output: `read: "${relPath}" is a directory — use <ls:> instead.` }; }
    if (stat.size > 5_000_000) { return { ok: false, output: `read: "${relPath}" is ${Math.round(stat.size / 1e6)}MB — too large. Use a lines="A-B" range or <grep:>.` }; }

    let content: string;
    try { content = await fs.promises.readFile(r.abs, 'utf-8'); } catch (e) {
      return { ok: false, output: `read: failed to read "${relPath}": ${e instanceof Error ? e.message : e}` };
    }
    if (content.includes('\u0000')) { return { ok: false, output: `read: "${relPath}" looks binary.` }; }

    const lines = content.split('\n');
    let slice = lines;
    let offset = 0;
    if (startLine !== undefined) {
      const from = Math.max(1, startLine);
      const to = Math.min(lines.length, endLine ?? from + 400);
      slice = lines.slice(from - 1, to);
      offset = from - 1;
    }
    const numbered = slice.map((l, i) => `${offset + i + 1}→${l}`).join('\n');
    const total = `${relPath} (${lines.length} lines)\n`;
    if (numbered.length <= READ_HEAD_CHARS + READ_TAIL_CHARS) {
      return { ok: true, output: total + numbered };
    }
    // Clamp head+tail so a huge file cannot blow the coordinator's context.
    const head = numbered.slice(0, READ_HEAD_CHARS);
    const tail = numbered.slice(-READ_TAIL_CHARS);
    return { ok: true, output: `${total}${head}\n… [clamped — ${numbered.length} chars total; request a lines="A-B" range for the middle] …\n${tail}` };
  }

  /** ls — one directory level: entries with kind and (for files) size. */
  async ls(relPath: string): Promise<LocalToolResult> {
    const r = await this._safeResolve(relPath);
    if (!r) { return { ok: false, output: `ls: "${relPath}" is not inside the workspace (or no workspace is open).` }; }
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(r.abs, { withFileTypes: true }); } catch {
      return { ok: false, output: `ls: "${relPath}" not found or not a directory.` };
    }
    entries.sort((a, b) => (Number(b.isDirectory()) - Number(a.isDirectory())) || a.name.localeCompare(b.name));
    const shown = entries.slice(0, LS_MAX_ENTRIES);
    const rows = await Promise.all(shown.map(async e => {
      if (e.isDirectory()) { return `${e.name}/`; }
      const size = await fs.promises.stat(path.join(r.abs, e.name)).then(s => s.size).catch(() => 0);
      return `${e.name}  (${size >= 10_000 ? `${Math.round(size / 1024)}KB` : `${size}B`})`;
    }));
    const more = entries.length > shown.length ? `\n… ${entries.length - shown.length} more entries` : '';
    return { ok: true, output: `${relPath === '.' ? '(workspace root)' : relPath} — ${entries.length} entries\n${rows.join('\n')}${more}` };
  }

  /** grep — regex search across workspace files (literal fallback on bad regex). */
  async grep(pattern: string, include?: string): Promise<LocalToolResult> {
    const root = this._root();
    if (!root) { return { ok: false, output: 'grep: no workspace is open.' }; }
    const realRoot = await fs.promises.realpath(root).catch(() => root);
    // ReDoS guard (review [1]): a dangerous pattern is searched LITERALLY — the
    // tool still works, it just can't catastrophically backtrack.
    const escapeLiteral = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let re: RegExp;
    if (isDangerousRegex(pattern)) {
      re = new RegExp(escapeLiteral(pattern), 'i');
    } else {
      try { re = new RegExp(pattern, 'i'); } catch { re = new RegExp(escapeLiteral(pattern), 'i'); }
    }
    const files = await this._findFiles(include || '**/*', GREP_DEFAULT_EXCLUDE, GREP_MAX_FILES);
    const started = Date.now();
    const hits: string[] = [];
    let scanned = 0;
    let truncated = false;
    for (const f of files) {
      if (Date.now() - started > GREP_TIME_BUDGET_MS || hits.length >= GREP_MAX_MATCHES) { truncated = true; break; }
      // Symlink fence (review [0]): realpath each candidate (findFiles follows
      // in-workspace symlinks) and skip anything outside the workspace or that
      // looks like a secret — read/ls already enforce this via _safeResolve.
      const real = await fs.promises.realpath(f).catch(() => null);
      if (!real || (real !== realRoot && !real.startsWith(realRoot + path.sep))) { continue; }
      if (looksLikeSecret(this._relPosix(realRoot, real))) { continue; }
      scanned++;
      let content: string;
      try {
        const st = await fs.promises.stat(f);
        if (!st.isFile() || st.size > GREP_MAX_FILE_BYTES) { continue; }
        content = await fs.promises.readFile(f, 'utf-8');
      } catch { continue; }
      if (content.includes('\u0000')) { continue; }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && hits.length < GREP_MAX_MATCHES; i++) {
        // Clamp the TEST input, not just the display slice — a multi-KB line is
        // the fuel a backtracking pattern needs (review [1]).
        const probe = lines[i].length > GREP_PROBE_CHARS ? lines[i].slice(0, GREP_PROBE_CHARS) : lines[i];
        if (re.test(probe)) {
          const rel = path.relative(root, f).split(path.sep).join('/');
          hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, GREP_LINE_CLAMP)}`);
        }
      }
    }
    if (hits.length === 0) {
      return { ok: true, output: `grep: no matches for /${pattern}/ in ${scanned} files${include ? ` (glob ${include})` : ''}.` };
    }
    const note = truncated ? `\n… capped (${GREP_MAX_MATCHES} matches / ${GREP_TIME_BUDGET_MS / 1000}s budget) — narrow with path="glob".` : '';
    return { ok: true, output: `grep /${pattern}/ — ${hits.length} match(es) in ${scanned} files:\n${hits.join('\n')}${note}` };
  }

  /** diag — live VSCode diagnostics: ground truth no CLI backend has. */
  async diag(target: string): Promise<LocalToolResult> {
    const root = this._root();
    const all = this._deps.getDiagnostics
      ? this._deps.getDiagnostics()
      : vscode.languages.getDiagnostics().map(([uri, diags]) => ({
          fsPath: uri.fsPath,
          diags: diags.map(d => ({ line: d.range.start.line, severity: d.severity ?? 0, message: d.message })),
        }));
    const wanted = target && target !== 'all' ? path.resolve(root || '', target) : undefined;
    const rows: Array<{ sev: number; text: string }> = [];
    for (const file of all) {
      if (wanted && path.resolve(file.fsPath) !== wanted) { continue; }
      const rel = root ? path.relative(root, file.fsPath) : file.fsPath;
      if (rel.startsWith('..')) { continue; } // outside-workspace diagnostics are noise
      for (const d of file.diags) {
        const sevName = d.severity === 0 ? 'error' : d.severity === 1 ? 'warning' : 'info';
        rows.push({ sev: d.severity, text: `${rel}:${d.line + 1} [${sevName}] ${d.message.slice(0, 300)}` });
      }
    }
    rows.sort((a, b) => a.sev - b.sev);
    if (rows.length === 0) {
      return { ok: true, output: target && target !== 'all' ? `diag: no diagnostics for ${target}.` : 'diag: no diagnostics — the workspace is clean.' };
    }
    const shown = rows.slice(0, DIAG_MAX_ENTRIES);
    const more = rows.length > shown.length ? `\n… ${rows.length - shown.length} more` : '';
    return { ok: true, output: `${rows.length} diagnostic(s):\n${shown.map(r => r.text).join('\n')}${more}` };
  }

  private async _findFiles(include: string, exclude: string, maxResults: number): Promise<string[]> {
    if (this._deps.findFiles) { return this._deps.findFiles(include, exclude, maxResults); }
    const uris = await vscode.workspace.findFiles(include, exclude, maxResults);
    return uris.map(u => u.fsPath);
  }
}
