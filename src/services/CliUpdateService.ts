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

import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { getProviderNpmPackage } from '../providers/base/ProviderManifest';
import {
  CLI_UPDATE_CHECK_TTL_MS,
  CLI_UPDATE_PROBE_TIMEOUT_MS,
  CLI_UPDATE_STAGGER_MS,
} from '../constants';

/** A backend whose installed CLI is behind the published npm version. */
export interface CliUpdateInfo {
  providerId: string;
  /** npm package name (in-repo literal — never registry- or model-supplied). */
  packageName: string;
  installed: string;
  latest: string;
  /** Epoch ms of the check that produced this entry. */
  checkedAt: number;
}

/** Per-provider result cache entry (persisted, TTL'd). */
interface CachedCheck {
  latest: string;
  checkedAt: number;
}

/** Minimal view of CliDiscoveryService — just the installed-version lookup. */
export interface CliVersionSource {
  getAllStatuses(): Promise<Array<{ providerId: string; found: boolean; version?: string }>>;
  peekStatus(providerId: string): { providerId: string; found: boolean; version?: string } | undefined;
}

/** Minimal view of SetupManager — just npm resolution. */
export interface NpmPathSource {
  getNpmPath(): string | null;
}

export const CLI_UPDATE_CACHE_KEY = 'mysti.cliUpdates.v1';

/**
 * Strict semver-ish matcher. Deliberately anchored for registry output (which
 * must be exactly a version) and unanchored for CLI `--version` output (which
 * is routinely decorated: "1.0.5 (Claude Code)", "v2.3.1", "codex-cli 0.153.1").
 */
const SEMVER_ANCHORED = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,64}))?(?:\+[0-9A-Za-z.-]{1,64})?$/;
const SEMVER_LOOSE = /(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,64}))?/;

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

/**
 * Parse a version out of decorated CLI output. Returns undefined when no
 * `x.y.z` is present at all — an unparseable version is treated as "unknown",
 * never as "outdated", so a CLI with an unusual banner can't nag the user.
 */
export function parseVersion(raw: string | undefined, anchored = false): ParsedVersion | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim().replace(/^v/i, '');
  const m = anchored ? SEMVER_ANCHORED.exec(trimmed) : SEMVER_LOOSE.exec(trimmed);
  if (!m) {
    return undefined;
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4],
  };
}

/**
 * Semver precedence for the numeric triple, with the standard rule that a
 * prerelease sorts BEFORE the same triple's release (1.2.3-beta < 1.2.3).
 *
 * Prerelease identifiers are not compared against each other — two prereleases
 * of the same triple compare equal. That is intentional: the only decision this
 * feeds is "offer an update", and telling someone on `1.2.3-beta.2` to move to
 * `1.2.3-beta.1` would be worse than staying quiet.
 *
 * Returns <0 if a<b, 0 if equal, >0 if a>b.
 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) { return a.major - b.major; }
  if (a.minor !== b.minor) { return a.minor - b.minor; }
  if (a.patch !== b.patch) { return a.patch - b.patch; }
  const aPre = a.prerelease !== undefined;
  const bPre = b.prerelease !== undefined;
  if (aPre === bPre) { return 0; }
  return aPre ? -1 : 1;
}

/**
 * CliUpdateService — answers "is this backend's CLI behind npm?" and nothing
 * else. It NEVER installs: the update command is built by the caller from the
 * in-repo package name and run in a visible terminal on an explicit click.
 *
 * Why this matters for model releases: a new model is frequently gated on a CLI
 * version, not just on the provider's catalogue. gpt-6-astra needs Codex CLI
 * >= 0.153.1, so a user whose picker offers the model but whose CLI predates it
 * gets a confusing failure. Surfacing the stale CLI alongside the new model is
 * the difference between a working suggestion and a dead end.
 */
export class CliUpdateService implements vscode.Disposable {
  private readonly _context: vscode.ExtensionContext;
  private readonly _versions: CliVersionSource;
  private readonly _npm: NpmPathSource;

  /** providerId -> last registry answer (mirrors globalState). */
  private readonly _cache: Map<string, CachedCheck> = new Map();
  private readonly _inFlight: Map<string, Promise<void>> = new Map();

  private readonly _onDidFindUpdates = new vscode.EventEmitter<CliUpdateInfo[]>();
  /** Fires with the set of outdated backends after a check (never empty). */
  public readonly onDidFindUpdates = this._onDidFindUpdates.event;

  constructor(context: vscode.ExtensionContext, versions: CliVersionSource, npm: NpmPathSource) {
    this._context = context;
    this._versions = versions;
    this._npm = npm;
    this._loadCache();
  }

  /**
   * Check every npm-backed provider that is actually installed, staggered so a
   * burst of registry calls doesn't stall activation. Providers with no npm
   * package, or that aren't installed, are skipped without a network call.
   *
   * Fire-and-forget friendly: never throws, and callers do not await it.
   */
  public async checkAll(opts?: { force?: boolean }): Promise<CliUpdateInfo[]> {
    let statuses: Array<{ providerId: string; found: boolean; version?: string }> = [];
    try {
      statuses = await this._versions.getAllStatuses();
    } catch (err) {
      console.warn(`[Mysti] CliUpdate: could not read CLI statuses: ${String(err)}`);
      return [];
    }

    const targets = statuses.filter(s =>
      s.found && !!getProviderNpmPackage(s.providerId) && (opts?.force || this._isStale(s.providerId))
    );

    for (let i = 0; i < targets.length; i++) {
      if (i > 0) {
        await this._delay(CLI_UPDATE_STAGGER_MS);
      }
      await this._refreshLatest(targets[i].providerId).catch(() => undefined);
    }

    const updates = this.getUpdates(statuses);
    if (updates.length > 0) {
      this._onDidFindUpdates.fire(updates);
    }
    return updates;
  }

  /**
   * Synchronous read of the outdated set from cached data only. Safe to call on
   * any paint path — it performs no I/O.
   */
  public getUpdates(
    statuses?: Array<{ providerId: string; found: boolean; version?: string }>
  ): CliUpdateInfo[] {
    const out: CliUpdateInfo[] = [];
    const entries = statuses
      ?? Array.from(this._cache.keys()).map(id => this._versions.peekStatus(id)).filter(
        (s): s is { providerId: string; found: boolean; version?: string } => !!s
      );

    for (const status of entries) {
      const packageName = getProviderNpmPackage(status.providerId);
      const cached = this._cache.get(status.providerId);
      if (!packageName || !cached || !status.found) {
        continue;
      }
      const installed = parseVersion(status.version);
      const latest = parseVersion(cached.latest, true);
      // Unknown on either side => stay quiet. Never guess "outdated".
      if (!installed || !latest) {
        continue;
      }
      if (compareVersions(installed, latest) < 0) {
        out.push({
          providerId: status.providerId,
          packageName,
          installed: `${installed.major}.${installed.minor}.${installed.patch}${installed.prerelease ? '-' + installed.prerelease : ''}`,
          latest: cached.latest,
          checkedAt: cached.checkedAt,
        });
      }
    }
    return out;
  }

  /**
   * The command Mysti would run to update one provider, or undefined when the
   * provider has no npm package. Built ONLY from the in-repo package literal —
   * no registry response and no user/model text reaches this string.
   */
  public getUpdateCommand(providerId: string): string | undefined {
    const packageName = getProviderNpmPackage(providerId);
    return packageName ? `npm install -g ${packageName}@latest` : undefined;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Probe the registry for one provider's latest version, deduped per provider. */
  private async _refreshLatest(providerId: string): Promise<void> {
    const pending = this._inFlight.get(providerId);
    if (pending) {
      return pending;
    }
    const task = this._doRefreshLatest(providerId);
    this._inFlight.set(providerId, task);
    try {
      await task;
    } finally {
      this._inFlight.delete(providerId);
    }
  }

  private async _doRefreshLatest(providerId: string): Promise<void> {
    const packageName = getProviderNpmPackage(providerId);
    if (!packageName) {
      return;
    }

    const npmPath = this._npm.getNpmPath() || 'npm';
    let stdout: string;
    try {
      stdout = await this._execNpmView(npmPath, packageName);
    } catch (err) {
      // Offline, private registry, package renamed — all non-events. Keep the
      // previous answer (if any) and stay silent.
      console.warn(`[Mysti] CliUpdate: npm view failed for ${packageName}: ${String(err)}`);
      return;
    }

    // The registry answer is UNTRUSTED input. It is accepted only if it is
    // exactly a semver, and it is never interpolated into a command.
    const parsed = parseVersion(stdout, true);
    if (!parsed) {
      console.warn(`[Mysti] CliUpdate: unparseable version for ${packageName}: ${JSON.stringify(stdout.slice(0, 40))}`);
      return;
    }

    this._cache.set(providerId, { latest: stdout.trim().replace(/^v/i, ''), checkedAt: Date.now() });
    await this._persistCache();
  }

  /**
   * `npm view <pkg> version` via execFile — argv array, NO shell. Even though
   * the package name is an in-repo literal, running it shell-free removes the
   * question entirely.
   */
  private _execNpmView(npmPath: string, packageName: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        npmPath,
        ['view', packageName, 'version'],
        { timeout: CLI_UPDATE_PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 64 },
        (error, out) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(String(out || '').trim());
        }
      );
      child.on('error', reject);
    });
  }

  private _isStale(providerId: string): boolean {
    const cached = this._cache.get(providerId);
    return !cached || (Date.now() - cached.checkedAt) > CLI_UPDATE_CHECK_TTL_MS;
  }

  private _delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private _loadCache(): void {
    try {
      const raw = this._context.globalState.get<Record<string, CachedCheck>>(CLI_UPDATE_CACHE_KEY);
      if (raw && typeof raw === 'object') {
        for (const [providerId, entry] of Object.entries(raw)) {
          if (entry && typeof entry.latest === 'string' && typeof entry.checkedAt === 'number') {
            this._cache.set(providerId, entry);
          }
        }
      }
    } catch (err) {
      console.warn(`[Mysti] CliUpdate: failed to read cache: ${String(err)}`);
    }
  }

  private async _persistCache(): Promise<void> {
    try {
      const obj: Record<string, CachedCheck> = {};
      this._cache.forEach((v, k) => { obj[k] = v; });
      await this._context.globalState.update(CLI_UPDATE_CACHE_KEY, obj);
    } catch (err) {
      console.warn(`[Mysti] CliUpdate: failed to persist cache: ${String(err)}`);
    }
  }

  public dispose(): void {
    this._onDidFindUpdates.dispose();
  }
}
