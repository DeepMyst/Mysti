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
 * SkillStaging (Plan 20 Phase 2) — the inert holding area for agent-authored
 * agent definitions, and the human-only promotion out of it.
 *
 * WHY A STAGING DIRECTORY AT ALL
 * ------------------------------
 * Writing an agent definition is not like writing source. Source is read by a
 * compiler; an agent definition is read by the NEXT SESSION'S MODEL as guidance.
 * A bad source edit fails a test, a bad definition quietly steers every future
 * run — which is how a single prompt injection becomes persistence.
 *
 * So bytes land here first. `.mysti/skills.staged` is deliberately NOT an
 * `AgentLoader` source directory, which makes a staged artifact structurally
 * inert: it is not indexed, not searchable, not readable through `skill_view`,
 * and not injected anywhere. It is a file on disk and nothing more, until a
 * human moves it.
 *
 * WHY PROMOTION IS NOT A TOOL
 * ---------------------------
 * There is deliberately no directive, no tool schema and no model-reachable
 * path that promotes. Promotion is a command the user runs. A permission card
 * would not be enough: 93% of permission prompts are approved and 81% of users
 * reach for always-allow, so a card on the highest-consequence transition in
 * the system is close to no control at all. Making it a separate, deliberate
 * human act is the control.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isSafeAgentId, parseAgentMarkdown, scanAgentContent, findAuthorityFrontmatterKeys, type AgentContentFinding } from '../managers/agentMarkdown';

/** One artifact waiting in the staging area. */
export interface StagedArtifact {
  id: string;
  /** Absolute path of the staged directory. */
  dir: string;
  /** Absolute path of its SKILL.md. */
  entryFile: string;
  name: string;
  description: string;
  /** Files inside the staged directory, workspace-relative POSIX. */
  files: string[];
  /** Content-scan findings. `blocked` means it can never be promoted as-is. */
  findings: AgentContentFinding[];
  blocked: boolean;
  blockedReason?: string;
}

export type PromoteResult =
  | { ok: true; installedTo: string }
  | { ok: false; reason: string };

/** Only these land in a promoted artifact — no executables in Phase 2. */
const PROMOTABLE_EXT = new Set(['.md', '.json', '.txt', '.yml', '.yaml']);
const MAX_FILES = 25;
const MAX_BYTES = 512 * 1024;

export class SkillStaging {
  /**
   * @param stagingRoot absolute path of `<workspace>/.mysti/skills.staged`
   * @param liveRoot    absolute path of `<workspace>/.mysti/agents`
   */
  constructor(private readonly _stagingRoot: string, private readonly _liveRoot: string) {}

  get stagingRoot(): string { return this._stagingRoot; }

  /** Everything currently staged, with its scan verdict already computed. */
  async list(): Promise<StagedArtifact[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this._stagingRoot, { withFileTypes: true });
    } catch {
      return [];
    }

    const out: StagedArtifact[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) { continue; }
      const artifact = await this._read(entry.name).catch(() => null);
      if (artifact) { out.push(artifact); }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  private async _read(id: string): Promise<StagedArtifact | null> {
    if (!isSafeAgentId(id)) { return null; }
    const dir = path.join(this._stagingRoot, id);
    const entryFile = path.join(dir, 'SKILL.md');
    let content: string;
    try {
      content = await fs.promises.readFile(entryFile, 'utf-8');
    } catch {
      return null; // a directory with no SKILL.md is not an artifact
    }

    const scan = scanAgentContent(content);
    const parsed = parseAgentMarkdown(content);
    const authorityKeys = findAuthorityFrontmatterKeys(parsed.frontmatter);
    const files = await this._collect(dir);

    let blockedReason: string | undefined;
    if (scan.rejected) {
      blockedReason = `content scan: ${scan.findings.filter(f => f.severity === 'reject').map(f => f.code).join(', ')}`;
    } else if (authorityKeys.length > 0) {
      blockedReason = `frontmatter tries to grant tool access: ${authorityKeys.join(', ')}`;
    } else if (files.length > MAX_FILES) {
      blockedReason = `too many files (${files.length} > ${MAX_FILES})`;
    } else if (files.some(f => !PROMOTABLE_EXT.has(path.extname(f).toLowerCase()))) {
      // Phase 2 promotes PROSE only. Executable payloads are Phase 3/4, behind
      // the verification ladder — promoting a script here would let one land
      // with no golden-case replay behind it.
      blockedReason = 'contains non-prose files (scripts are not promotable until the verification ladder ships)';
    }

    return {
      id,
      dir,
      entryFile,
      name: String(parsed.frontmatter.name || id),
      description: String(parsed.frontmatter.description || ''),
      files,
      findings: scan.findings,
      blocked: !!blockedReason,
      blockedReason,
    };
  }

  /** Relative file list inside a staged artifact, bounded and symlink-free. */
  private async _collect(dir: string, rel = ''): Promise<string[]> {
    const out: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      // A symlink inside a staged artifact would let promotion copy content
      // from outside the staging tree, so it is simply not a promotable file.
      if (entry.isSymbolicLink()) { out.push(`${childRel} (symlink — not promotable)`); continue; }
      if (entry.isDirectory()) {
        out.push(...await this._collect(dir, childRel));
      } else if (entry.isFile()) {
        out.push(childRel);
      }
      if (out.length > MAX_FILES) { break; }
    }
    return out;
  }

  /**
   * Copy a staged artifact into the LIVE tree. Called only from the user
   * command — there is no model-reachable caller, by design.
   *
   * Re-reads and re-scans at promotion time rather than trusting the listing:
   * the review UI and the promotion are separate moments, and the bytes can
   * change in between (time-of-check/time-of-use).
   */
  async promote(id: string, type: 'skill' | 'persona' | 'role' = 'skill'): Promise<PromoteResult> {
    const artifact = await this._read(id).catch(() => null);
    if (!artifact) { return { ok: false, reason: `Nothing staged under "${id}".` }; }
    if (artifact.blocked) { return { ok: false, reason: `Refused — ${artifact.blockedReason}.` }; }

    const targetDir = path.join(this._liveRoot, `${type}s`, id);
    // Containment: a crafted id must not escape the live tree.
    const liveResolved = path.resolve(this._liveRoot);
    if (!path.resolve(targetDir).startsWith(liveResolved + path.sep)) {
      return { ok: false, reason: `Refused — "${id}" resolves outside the agents directory.` };
    }

    let copied = 0;
    let bytes = 0;
    await fs.promises.mkdir(targetDir, { recursive: true });
    for (const rel of artifact.files) {
      if (rel.includes(' (symlink')) { continue; }
      const from = path.join(artifact.dir, rel);
      const stat = await fs.promises.lstat(from).catch(() => null);
      if (!stat?.isFile()) { continue; }
      bytes += stat.size;
      if (bytes > MAX_BYTES) { return { ok: false, reason: `Refused — artifact exceeds ${MAX_BYTES / 1024}KB.` }; }
      const to = path.join(targetDir, rel);
      await fs.promises.mkdir(path.dirname(to), { recursive: true });
      await fs.promises.copyFile(from, to);
      copied++;
    }
    if (copied === 0) { return { ok: false, reason: 'Refused — nothing promotable in the staged directory.' }; }

    await fs.promises.rm(artifact.dir, { recursive: true, force: true }).catch(() => { /* leave it */ });
    return { ok: true, installedTo: targetDir };
  }

  /** Throw the proposal away. */
  async discard(id: string): Promise<boolean> {
    if (!isSafeAgentId(id)) { return false; }
    const dir = path.join(this._stagingRoot, id);
    if (!path.resolve(dir).startsWith(path.resolve(this._stagingRoot) + path.sep)) { return false; }
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}
