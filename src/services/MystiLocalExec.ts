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
 * MystiLocalExec (Plan 19 Phase 0) — the SINGLE gated chokepoint for the Mysti
 * coordinator's own local mutations (`write` / `edit`; later `patch` / `bash` /
 * `git`). It is the local analogue of CollaboratorPool's gate: the one place
 * authority is checked before the coordinator model's request touches disk.
 *
 * The security stance is "capabilities up, authority unchanged": every op here
 *   1. is refused unless local execution is enabled AND the workspace is trusted,
 *   2. is workspace-scoped + secret-blocked (MystiLocalTools.resolveWriteTarget),
 *   3. passes through the SAME permission gate a CLI backend faces (ctx.gate,
 *      which the coordinator wires to _shouldGateToolUse → requestPermissionInline),
 *   4. is checkpointed BEFORE any byte changes (ctx.checkpoint → rewind),
 * and only then executes. A local tool is never more trusted than a delegated
 * one, and its (untrusted) result is nonce-fenced by the caller before it
 * re-enters the model.
 *
 * This module does the fs work but knows NOTHING about the gate/checkpoint
 * mechanism — those are injected per call (LocalExecContext), keeping it a
 * pure, unit-testable executor.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { MystiLocalTools } from './MystiLocalTools';
import { MystiSandbox, type SandboxRunner } from './MystiSandbox';
import { screenBashCommand, isRemoteEffectCommand } from '../managers/SafetyClassifier';
import { parsePatchEnvelope } from './mystiPatch';

export type LocalExecKind = 'write' | 'edit' | 'bash' | 'patch';

export interface LocalExecResult {
  ok: boolean;
  output: string;
  /** True when the op was refused by the permission gate (vs a validation error). */
  denied?: boolean;
}

/** Info handed to the gate so it can render a meaningful permission card. */
export interface LocalExecGateInfo {
  kind: LocalExecKind;
  // File ops (write/edit):
  absPath?: string;
  relPath?: string;
  /** Whether the target already exists (write = overwrite; edit = required). */
  exists?: boolean;
  linesAdded?: number;
  linesRemoved?: number;
  // Shell (bash):
  command?: string;
  /** Whether this command will run under an OS sandbox (false ⇒ read-only-only host). */
  sandboxed?: boolean;
  /** Matches the read-only/build allowlist. */
  safe?: boolean;
  /** Chained/redirecting command (never auto-approved). */
  compound?: boolean;
  /** Affects a remote system / can't be rewound → modal default-DENY (Phase 3). */
  remoteEffect?: boolean;
  /** Whether the sandbox will have NETWORK access (so the card can't lie). */
  network?: boolean;
  // Multi-file patch:
  files?: string[];
}

/** Per-call capability snapshot + gate/checkpoint closures (dependency-injected). */
export interface LocalExecContext {
  /** `mysti.mysti.localExecution === 'on'` (and not a plan/read-only tier). */
  enabled: boolean;
  /** `vscode.workspace.isTrusted` — no local mutation in an untrusted workspace. */
  workspaceTrusted: boolean;
  /**
   * Route through the SAME permission gate as CLI backends. Resolve `true` when
   * approved (or when the current mode doesn't require gating); `false` = denied.
   */
  gate: (info: LocalExecGateInfo) => Promise<boolean>;
  /** Snapshot the workspace BEFORE mutating, for rewind. Returns whether a
   *  snapshot was actually taken (false ⇒ no automatic undo available). */
  checkpoint: (label: string) => Promise<boolean | void>;
  /** bash: allow network egress inside the sandbox (default false). */
  bashNetwork?: boolean;
  /** bash: per-command timeout in ms. */
  bashTimeoutMs?: number;
}

/** Refuse to write more than this in one op (a runaway/paste guard). */
const MAX_WRITE_BYTES = 2_000_000;
/** NUL byte — a file containing one is treated as binary (not text-editable). */
const NUL = String.fromCharCode(0);

export class MystiLocalExec {
  constructor(
    private readonly _tools: MystiLocalTools,
    private readonly _sandbox: SandboxRunner = new MystiSandbox(),
  ) {}

  /** Whole-file write (create or overwrite), gated + checkpointed. */
  async write(relPath: string, content: string, ctx: LocalExecContext): Promise<LocalExecResult> {
    const blocked = this._guard(ctx);
    if (blocked) { return blocked; }

    const target = await this._tools.resolveWriteTarget(relPath);
    if (!target.ok) { return { ok: false, output: `write: ${target.output}` }; }

    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_WRITE_BYTES) {
      return { ok: false, output: `write: refusing to write ${(bytes / 1e6).toFixed(1)}MB to "${relPath}" (max 2MB).` };
    }

    const exists = fs.existsSync(target.abs);
    let prevLines = 0;
    if (exists) {
      try { prevLines = fs.readFileSync(target.abs, 'utf8').split('\n').length; } catch { /* treat as new */ }
    }
    const newLines = content.split('\n').length;

    const approved = await ctx.gate({
      kind: 'write', absPath: target.abs, relPath: target.relPosix, exists,
      linesAdded: newLines, linesRemoved: exists ? prevLines : 0,
    });
    if (!approved) { return { ok: false, output: `write to "${target.relPosix}" was denied.`, denied: true }; }

    await ctx.checkpoint(`mysti write ${target.relPosix}`);
    try {
      await fs.promises.mkdir(path.dirname(target.abs), { recursive: true });
      await fs.promises.writeFile(target.abs, content, 'utf8');
    } catch (e) {
      return { ok: false, output: `write: failed to write "${relPath}": ${e instanceof Error ? e.message : e}` };
    }
    return { ok: true, output: `Wrote "${target.relPosix}" (${exists ? 'overwrote' : 'created'}, ${newLines} lines).` };
  }

  /** Targeted string-replacement edit of an existing file, gated + checkpointed. */
  async edit(relPath: string, oldString: string, newString: string, replaceAll: boolean, ctx: LocalExecContext): Promise<LocalExecResult> {
    const blocked = this._guard(ctx);
    if (blocked) { return blocked; }

    const target = await this._tools.resolveWriteTarget(relPath);
    if (!target.ok) { return { ok: false, output: `edit: ${target.output}` }; }
    if (!fs.existsSync(target.abs)) {
      return { ok: false, output: `edit: "${relPath}" does not exist — use write to create it.` };
    }

    let current: string;
    try { current = await fs.promises.readFile(target.abs, 'utf8'); } catch (e) {
      return { ok: false, output: `edit: failed to read "${relPath}": ${e instanceof Error ? e.message : e}` };
    }
    if (current.includes(NUL)) { return { ok: false, output: `edit: "${relPath}" looks binary — cannot edit.` }; }

    const occurrences = current.split(oldString).length - 1;
    if (occurrences === 0) {
      return { ok: false, output: `edit: old_string not found in "${relPath}". Read the file first and copy the exact text (including whitespace).` };
    }
    if (occurrences > 1 && !replaceAll) {
      return { ok: false, output: `edit: old_string is not unique in "${relPath}" (${occurrences} matches). Add more surrounding context to make it unique, or set replace="all".` };
    }
    const updated = replaceAll ? current.split(oldString).join(newString) : current.replace(oldString, newString);
    if (updated === current) {
      return { ok: false, output: `edit: no change (old_string and new_string are identical) in "${relPath}".` };
    }

    const before = current.split('\n').length;
    const after = updated.split('\n').length;
    const approved = await ctx.gate({
      kind: 'edit', absPath: target.abs, relPath: target.relPosix, exists: true,
      linesAdded: Math.max(0, after - before), linesRemoved: Math.max(0, before - after),
    });
    if (!approved) { return { ok: false, output: `edit to "${target.relPosix}" was denied.`, denied: true }; }

    await ctx.checkpoint(`mysti edit ${target.relPosix}`);
    try {
      await fs.promises.writeFile(target.abs, updated, 'utf8');
    } catch (e) {
      return { ok: false, output: `edit: failed to write "${relPath}": ${e instanceof Error ? e.message : e}` };
    }
    const n = replaceAll ? occurrences : 1;
    return { ok: true, output: `Edited "${target.relPosix}" (${n} replacement${n === 1 ? '' : 's'}).` };
  }

  /**
   * Apply an atomic multi-file patch (Plan 19 Phase 1): add / update (SEARCH→
   * REPLACE) / delete / move. EVERY touched path is workspace-scoped + secret-
   * checked and EVERY op is validated in memory FIRST — if any path escapes, any
   * secret is targeted, or any op cannot apply, the WHOLE patch is rejected with
   * no writes. Gated ONCE + checkpointed before the batch is written.
   */
  async applyPatch(patchText: string, ctx: LocalExecContext): Promise<LocalExecResult> {
    const blocked = this._guard(ctx);
    if (blocked) { return blocked; }

    const parsed = parsePatchEnvelope(patchText);
    if (!parsed.ok) { return { ok: false, output: parsed.error }; }

    // Resolve + secret-check EVERY path up front; any failure voids the patch.
    const resolvedAbs = new Map<string, string>();     // op path/dest → abs
    const relOf = new Map<string, string>();           // abs → workspace-rel
    const resolve = async (p: string): Promise<string | { error: string }> => {
      if (resolvedAbs.has(p)) { return resolvedAbs.get(p)!; }
      const r = await this._tools.resolveWriteTarget(p);
      if (!r.ok) { return { error: `patch: ${r.output}` }; }
      resolvedAbs.set(p, r.abs); relOf.set(r.abs, r.relPosix);
      return r.abs;
    };
    for (const op of parsed.ops) {
      const a = await resolve(op.path);
      if (typeof a !== 'string') { return { ok: false, output: a.error }; }
      if (op.op === 'move') {
        const d = await resolve(op.dest);
        if (typeof d !== 'string') { return { ok: false, output: d.error }; }
      }
    }

    // Build the final state of every touched file IN MEMORY (validate each op).
    const pending = new Map<string, string | null>();  // abs → new content | null(delete)
    const stateOf = (abs: string): string | null | undefined =>
      pending.has(abs) ? pending.get(abs)! : (fs.existsSync(abs) ? this._safeRead(abs) : undefined);
    let added = 0, updated = 0, deleted = 0, moved = 0;

    for (const op of parsed.ops) {
      const abs = resolvedAbs.get(op.path)!;
      const rel = relOf.get(abs)!;
      if (op.op === 'add') {
        if (typeof stateOf(abs) === 'string') { return { ok: false, output: `patch: Add "${rel}" already exists — use Update to modify it.` }; }
        pending.set(abs, op.content); added++;
      } else if (op.op === 'update') {
        const cur = stateOf(abs);
        if (cur === undefined || cur === null) { return { ok: false, output: `patch: Update "${rel}" does not exist.` }; }
        if (cur.includes(NUL)) { return { ok: false, output: `patch: "${rel}" looks binary — cannot patch.` }; }
        const n = cur.split(op.search).length - 1;
        if (n === 0) { return { ok: false, output: `patch: Update "${rel}" — SEARCH block not found. Copy the exact existing text.` }; }
        if (n > 1) { return { ok: false, output: `patch: Update "${rel}" — SEARCH block is not unique (${n} matches). Add more surrounding context.` }; }
        pending.set(abs, cur.replace(op.search, op.replace)); updated++;
      } else if (op.op === 'delete') {
        if (typeof stateOf(abs) !== 'string') { return { ok: false, output: `patch: Delete "${rel}" does not exist.` }; }
        pending.set(abs, null); deleted++;
      } else { // move
        const destAbs = resolvedAbs.get(op.dest)!;
        const src = stateOf(abs);
        if (typeof src !== 'string') { return { ok: false, output: `patch: Move source "${rel}" does not exist.` }; }
        if (typeof stateOf(destAbs) === 'string') { return { ok: false, output: `patch: Move destination "${relOf.get(destAbs)}" already exists.` }; }
        pending.set(abs, null);
        pending.set(destAbs, src);
        moved++;
      }
    }

    const files = [...pending.keys()].map(a => relOf.get(a) || a);
    const approved = await ctx.gate({ kind: 'patch', relPath: `${files.length} file(s)`, files, linesAdded: added + updated + moved, linesRemoved: deleted });
    if (!approved) { return { ok: false, output: `patch touching ${files.length} file(s) was denied.`, denied: true }; }

    const rewindable = !!(await ctx.checkpoint(`mysti patch: ${files.slice(0, 4).join(', ')}${files.length > 4 ? '…' : ''}`));

    // Apply WRITES (add/update/move-dest) BEFORE REMOVALS (delete/move-source),
    // so a Move never deletes its source before the dest write lands; abort on
    // the first fs error rather than pressing on into an inconsistent state
    // (validation was exhaustive, so this is rare — review #6).
    const entries = [...pending.entries()];
    try {
      for (const [abs, content] of entries) {
        if (content === null) { continue; }
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, content, 'utf8');
      }
      for (const [abs, content] of entries) {
        if (content !== null) { continue; }
        await fs.promises.rm(abs, { recursive: true, force: true });
      }
    } catch (e) {
      const undo = rewindable ? ' Use "rewind" to undo the partial change.' : ' (no checkpoint was taken — undo manually.)';
      return { ok: false, output: `patch: failed part-way through applying — ${e instanceof Error ? e.message : e}.${undo}` };
    }
    const parts = [added && `${added} added`, updated && `${updated} updated`, moved && `${moved} moved`, deleted && `${deleted} deleted`].filter(Boolean);
    return { ok: true, output: `Applied patch: ${parts.join(', ')} (${files.length} file(s)).` };
  }

  private _safeRead(abs: string): string {
    try { return fs.readFileSync(abs, 'utf8'); } catch { return ''; }
  }

  /**
   * Run a shell command, GATED + SANDBOXED (Plan 19 Phase 2). Layered defense:
   *  1. guard (enabled + trusted),
   *  2. SafetyClassifier BLOCK-list → hard-deny (never gates, never runs),
   *  3. if no OS sandbox on this platform, ONLY allowlisted read-only/build
   *     commands may run — anything else is refused (fail-closed),
   *  4. the SAME permission gate as CLI backends (ctx.gate),
   *  5. a pre-run checkpoint (a build/test can mutate files → make it undoable),
   *  6. execution inside the OS sandbox (workspace-write, network-off).
   * The (untrusted) output is nonce-fenced by the caller.
   */
  async bash(command: string, ctx: LocalExecContext): Promise<LocalExecResult> {
    const blocked = this._guard(ctx);
    if (blocked) { return blocked; }

    const cmd = (command || '').trim();
    if (!cmd) { return { ok: false, output: 'bash: empty command.' }; }

    // (2) Hard block-list — irreversible/dangerous commands never even reach the gate.
    const screen = screenBashCommand(cmd);
    if (screen.blockedReason) {
      return { ok: false, output: `bash: refused — ${screen.blockedReason}. This command is blocked for safety; if you truly need it, ask the user to run it themselves or delegate to a backend agent.` };
    }

    const root = this._tools.workspaceRoot();
    if (!root) { return { ok: false, output: 'bash: no workspace folder is open.' }; }

    // (3) No sandbox on this platform ⇒ only GENUINELY READ-ONLY commands run
    // (not build/test runners — those execute repo-defined code, review #8).
    const sandboxed = this._sandbox.available();
    if (!sandboxed && !screen.readOnly) {
      return { ok: false, output: `bash: no OS sandbox is available on this platform, so only genuinely read-only commands (e.g. "git status", "ls", "cat", "--version") can run here — "${cmd}" is refused. Delegate build/test/anything-else to a backend coding agent instead.` };
    }

    // (4) Gate — always consulted. Auto-run (no card) is decided by the caller
    // and requires safe + non-compound + sandboxed (review #1); a remote-effect
    // command gets a modal default-DENY instead (Phase 3).
    const approved = await ctx.gate({ kind: 'bash', command: cmd, sandboxed, safe: screen.safe, compound: screen.compound, remoteEffect: isRemoteEffectCommand(cmd), network: !!ctx.bashNetwork });
    if (!approved) { return { ok: false, output: `bash: "${cmd}" was denied.`, denied: true }; }

    // (5) A command may write files; snapshot first so it can be rewound.
    await ctx.checkpoint(`mysti bash: ${cmd.slice(0, 60)}`);

    // (6) Run inside the sandbox.
    const res = await this._sandbox.run(cmd, { cwd: root, network: !!ctx.bashNetwork, timeoutMs: ctx.bashTimeoutMs });
    return { ok: res.code === 0 && !res.timedOut, output: this._formatBashOutput(cmd, res) };
  }

  private _formatBashOutput(command: string, res: { code: number | null; stdout: string; stderr: string; sandboxed: boolean; timedOut: boolean }): string {
    const head = res.timedOut
      ? `$ ${command}\n[timed out]`
      : `$ ${command}\n[exit ${res.code ?? 'null'}${res.sandboxed ? '' : ', UNSANDBOXED allowlisted host'}]`;
    const out = (res.stdout || '').trimEnd();
    const err = (res.stderr || '').trimEnd();
    const parts = [head];
    if (out) { parts.push(out); }
    if (err) { parts.push(`stderr:\n${err}`); }
    if (!out && !err && !res.timedOut) { parts.push('(no output)'); }
    return parts.join('\n');
  }

  /** Fail closed unless enabled AND the workspace is trusted. */
  private _guard(ctx: LocalExecContext): LocalExecResult | null {
    if (!ctx.enabled) {
      return { ok: false, output: 'Local execution is disabled. Ask the user to enable it (the "mysti.mysti.localExecution" setting) — or delegate this change to a coding agent instead.' };
    }
    if (!ctx.workspaceTrusted) {
      return { ok: false, output: 'Local execution is disabled in an untrusted workspace. Ask the user to trust this workspace, or delegate the change.' };
    }
    return null;
  }
}
