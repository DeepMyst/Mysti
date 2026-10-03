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
 * CapabilityRegistry (Plan 20 Phase 3) — what has actually been published, and
 * whether it is still the thing that was approved.
 *
 * Registration is the one act a checkpoint does not undo. A bad `bash` is one
 * bad turn; a registered capability is every turn until somebody notices a
 * markdown file. So the registry stores a folder HASH taken at approval time
 * and re-checks it before every call: approval binds BYTES, not a filename.
 * If the folder changed, the capability is refused and must be re-approved —
 * that is the time-of-check/time-of-use gap closed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { CapabilityEntry } from './CapabilityManifest';

export interface RegisteredCapability {
  /** Artifact id (the folder name under the live agents tree). */
  id: string;
  /** Absolute path of the artifact folder. */
  dir: string;
  entries: CapabilityEntry[];
  /** Folder hash at the moment the user approved it. */
  merkle: string;
  approvedAt: number;
  /** What the verification produced, shown on later cards. */
  verifiedBy: string;
}

/** Minimal Memento shape (vscode.Memento) so tests can pass a plain object. */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | void;
}

const KEY = 'mysti.capabilityRegistry.v1';

/**
 * Hash every file in an artifact folder, sorted, content normalized to LF.
 *
 * Cheap enough to run before each call, and it covers the routes a write gate
 * cannot see: a delegated CLI backend writing outside the sandbox, a `git pull`,
 * another extension, or the user's own editor.
 */
export async function folderMerkle(dir: string): Promise<string> {
  const files: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { await walk(childRel); }
      else if (entry.isFile()) { files.push(childRel); }
    }
  };
  await walk('');

  const hash = createHash('sha256');
  for (const rel of files.sort()) {
    hash.update(rel);
    hash.update('\0');
    try {
      const body = await fs.promises.readFile(path.join(dir, rel), 'utf-8');
      hash.update(body.replace(/\r\n/g, '\n'));
    } catch {
      hash.update('<unreadable>');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

export class CapabilityRegistry {
  constructor(private readonly _state: MementoLike, private readonly _nowMs: () => number = () => Date.now()) {}

  private _load(): RegisteredCapability[] {
    const raw = this._state.get<RegisteredCapability[]>(KEY);
    return Array.isArray(raw) ? raw.filter(r => r && typeof r.id === 'string' && Array.isArray(r.entries)) : [];
  }

  private _save(all: RegisteredCapability[]): void {
    void this._state.update(KEY, all);
  }

  list(): RegisteredCapability[] {
    return this._load();
  }

  /** All callable entries across every registered artifact. */
  allEntries(): Array<{ artifact: RegisteredCapability; entry: CapabilityEntry }> {
    return this._load().flatMap(artifact => artifact.entries.map(entry => ({ artifact, entry })));
  }

  /** Find one entry by its `namespace_verb` tool name. */
  findEntry(toolName: string): { artifact: RegisteredCapability; entry: CapabilityEntry } | undefined {
    return this.allEntries().find(e => e.entry.name === toolName);
  }

  register(cap: Omit<RegisteredCapability, 'approvedAt'>): void {
    const all = this._load().filter(c => c.id !== cap.id);
    all.push({ ...cap, approvedAt: this._nowMs() });
    this._save(all);
  }

  unregister(id: string): boolean {
    const all = this._load();
    const next = all.filter(c => c.id !== id);
    if (next.length === all.length) { return false; }
    this._save(next);
    return true;
  }

  clear(): void { this._save([]); }

  /**
   * Confirm the artifact on disk is still the one that was approved.
   *
   * Returns the reason it is NOT usable, or null when it is fine. A mismatch is
   * deliberately not self-healing: re-hashing whatever is there now would make
   * the pin decorative, since the attacker's write would simply be re-pinned.
   */
  async verify(id: string): Promise<string | null> {
    const cap = this._load().find(c => c.id === id);
    if (!cap) { return `"${id}" is not a registered capability.`; }
    if (!fs.existsSync(cap.dir)) { return `"${id}" is registered but its folder is missing.`; }
    const current = await folderMerkle(cap.dir);
    if (current !== cap.merkle) {
      return `"${id}" has changed on disk since you approved it. It is refused until you review and publish it again.`;
    }
    return null;
  }
}
