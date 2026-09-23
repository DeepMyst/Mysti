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
import { getProviderNpmPackage, getProviderSelfUpdateCommand } from '../providers/base/ProviderManifest';
import { getVerifiedNativeCliVersion } from '../providers/base/NativeCliVersions';
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
  /**
   * The update target supported by both this machine and Mysti's native bridge.
   * It can lag `latest` because of the Node engine or a verified protocol pin.
   *
   * The two really do diverge: openclaw 2026.9.2 requires Node >=22.22.3, and
   * on a Node 22.20.0 machine `npm i -g openclaw@latest` fails in a preinstall
   * hook. Offering `@latest` there is offering a command that cannot work.
   */
  installable: string;
  /** True when `installable` is behind `latest` because of the Node engine. */
  blockedByNodeEngine: boolean;
  /** True when a newer upstream release has no verified native contract yet. */
  blockedByNativeBridge?: boolean;
  /** The engine range that excluded `latest`, for explaining the gap. */
  requiredNode?: string;
  /** Epoch ms of the check that produced this entry. */
  checkedAt: number;
}

/** Per-provider result cache entry (persisted, TTL'd). */
interface CachedCheck {
  latest: string;
  checkedAt: number;
  /** Newest installable on THIS Node; absent means "same as latest". */
  installable?: string;
  /** `engines.node` of `latest`, when it excludes the running Node. */
  requiredNode?: string;
  /** Pin whose package metadata was checked; old caches cannot attest a pin. */
  verifiedVersion?: string;
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

/** One `npm view … --json` row: a version and the Node range it declares. */
export interface NpmViewEntry {
  version: string;
  engines?: string;
}

/**
 * Parse `npm view <spec> version engines.node --json`, oldest-first.
 *
 * npm's shape depends on how many things matched and how many fields were
 * asked for, and all of these turn up in practice:
 *   - one match, one field   -> `"1.2.3"`
 *   - one match, two fields  -> `{ "version": "1.2.3", "engines.node": ">=20" }`
 *   - many matches           -> an array of those objects
 * A package with no `engines` simply omits the key.
 *
 * Everything here is UNTRUSTED registry output: rows without a usable version
 * string are dropped, and nothing is interpolated anywhere until it has passed
 * the strict semver check.
 */
export function parseNpmViewEntries(stdout: string): NpmViewEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    // Not JSON: an older npm asked for a single field prints a bare string.
    const bare = stdout.trim().replace(/^v/i, '');
    return bare ? [{ version: bare }] : [];
  }

  const rows = Array.isArray(data) ? data : [data];
  const out: NpmViewEntry[] = [];
  for (const row of rows) {
    if (typeof row === 'string') {
      out.push({ version: row.trim().replace(/^v/i, '') });
      continue;
    }
    if (!row || typeof row !== 'object') { continue; }
    const obj = row as Record<string, unknown>;
    const version = typeof obj['version'] === 'string' ? obj['version'].trim().replace(/^v/i, '') : '';
    if (!version) { continue; }
    const engines = obj['engines.node'];
    out.push({ version, engines: typeof engines === 'string' ? engines : undefined });
  }
  return out;
}

/**
 * Does `nodeVersion` satisfy an `engines.node` range?
 *
 * A deliberately small matcher for what package authors actually write:
 * `||`-separated alternatives, space-separated comparators within one
 * alternative (AND), and `>=`, `>`, `<=`, `<`, `=` against `x`, `x.y` or
 * `x.y.z`. `*` and an empty range mean "anything".
 *
 * UNPARSEABLE RANGES RETURN TRUE. This function only ever DOWNGRADES what
 * Mysti offers, so being unsure has to mean "offer the latest and let npm
 * speak" — the alternative would silently hide a perfectly good update because
 * of a range syntax nobody here anticipated.
 */
export function satisfiesNodeRange(nodeVersion: string, range: string | undefined): boolean {
  if (!range || !range.trim() || range.trim() === '*') { return true; }
  const current = parseVersion(nodeVersion.replace(/^v/i, ''));
  if (!current) { return true; }

  const cmp = (a: ParsedVersion, b: ParsedVersion): number =>
    a.major !== b.major ? a.major - b.major
      : a.minor !== b.minor ? a.minor - b.minor
        : a.patch - b.patch;

  const COMPARATOR = /^(>=|<=|>|<|=)?\s*v?(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?/;

  for (const alternative of range.split('||')) {
    const clauses = alternative.trim().split(/\s+/).filter(Boolean);
    if (clauses.length === 0) { continue; }

    let understood = true;
    let matched = true;
    for (const clause of clauses) {
      const m = COMPARATOR.exec(clause.trim());
      if (!m) { understood = false; break; }
      const op = m[1] || '=';
      const bound: ParsedVersion = {
        major: Number(m[2]),
        minor: m[3] === undefined ? 0 : Number(m[3]),
        patch: m[4] === undefined ? 0 : Number(m[4]),
      };
      const c = cmp(current, bound);
      const ok =
        op === '>=' ? c >= 0 :
          op === '>' ? c > 0 :
            op === '<=' ? c <= 0 :
              op === '<' ? c < 0 :
                c === 0;
      if (!ok) { matched = false; break; }
    }
    // A clause we could not read means we cannot disprove compatibility.
    if (!understood) { return true; }
    if (matched) { return true; }
  }
  return false;
}

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
 * CliUpdateService — finds updates compatible with Mysti's native contract and
 * the local Node engine. It never installs: commands run in a visible terminal
 * only after an explicit update action.
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
      const verified = getVerifiedNativeCliVersion(status.providerId);
      if (verified && (cached.verifiedVersion !== verified || cached.installable !== verified)) {
        continue;
      }
      // Unknown on either side => stay quiet. Never guess "outdated".
      if (!installed || !latest) {
        continue;
      }
      if (compareVersions(installed, latest) < 0) {
        // `installable` is what an update would actually fetch. When the newest
        // release excludes this machine's Node, it is an older one — and when
        // even that is not ahead of what is installed, there is nothing to
        // offer and the provider is skipped rather than nagged about.
        const installable = cached.installable ?? cached.latest;
        const installableParsed = parseVersion(installable, true);
        if (!installableParsed || compareVersions(installed, installableParsed) >= 0) {
          continue;
        }
        out.push({
          providerId: status.providerId,
          packageName,
          installed: `${installed.major}.${installed.minor}.${installed.patch}${installed.prerelease ? '-' + installed.prerelease : ''}`,
          latest: cached.latest,
          installable,
          blockedByNodeEngine: installable !== cached.latest && !!cached.requiredNode,
          ...(verified ? { blockedByNativeBridge: verified !== cached.latest } : {}),
          requiredNode: cached.requiredNode,
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
    const verified = getVerifiedNativeCliVersion(providerId);
    if (verified) {
      const installed = parseVersion(this._versions.peekStatus(providerId)?.version);
      if (installed && compareVersions(installed, parseVersion(verified, true)!) >= 0) { return undefined; }
      const cached = this._cache.get(providerId);
      if (cached && (cached.verifiedVersion !== verified || cached.installable !== verified)) { return undefined; }
      const packageName = getProviderNpmPackage(providerId);
      return getProviderSelfUpdateCommand(providerId)
        ?? (packageName ? `npm install -g ${packageName}@${verified}` : undefined);
    }
    // A provider with its own updater uses it: for Claude Code the npm package
    // and the binary on PATH can be two different installs, so `npm i -g` there
    // updates a copy nothing runs.
    const selfUpdate = getProviderSelfUpdateCommand(providerId, this._versions.peekStatus(providerId)?.version);
    if (selfUpdate) { return selfUpdate; }

    const packageName = getProviderNpmPackage(providerId);
    if (!packageName) { return undefined; }

    // Pin to the newest version this Node can install. `@latest` is wrong the
    // moment the newest release raises its Node floor: npm aborts in a
    // preinstall hook, and — if several packages share one `npm i -g` — takes
    // the whole batch down with it.
    //
    // The version is registry-supplied, so it is re-validated as a strict
    // semver here before it is allowed anywhere near a command string.
    const cached = this._cache.get(providerId);
    const pin = cached?.installable;
    if (pin && parseVersion(pin, true)) {
      return `npm install -g ${packageName}@${pin}`;
    }
    return `npm install -g ${packageName}@latest`;
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
      stdout = await this._execNpmView(npmPath, packageName, ['version', 'engines.node']);
    } catch (err) {
      // Offline, private registry, package renamed — all non-events. Keep the
      // previous answer (if any) and stay silent.
      console.warn(`[Mysti] CliUpdate: npm view failed for ${packageName}: ${String(err)}`);
      return;
    }

    const head = parseNpmViewEntries(stdout).pop();
    // The registry answer is UNTRUSTED input. It is accepted only if it is
    // exactly a semver, and it is never interpolated into a command.
    const parsed = head && parseVersion(head.version, true);
    if (!head || !parsed) {
      console.warn(`[Mysti] CliUpdate: unparseable version for ${packageName}: ${JSON.stringify(stdout.slice(0, 60))}`);
      return;
    }

    const latest = head.version.trim().replace(/^v/i, '');
    const entry: CachedCheck = { latest, checkedAt: Date.now() };

    const verified = getVerifiedNativeCliVersion(providerId);
    if (verified) {
      entry.verifiedVersion = verified;
      entry.installable = '';
      let supported = latest === verified ? head : undefined;
      if (!supported && compareVersions(parseVersion(verified, true)!, parsed) <= 0) {
        try {
          supported = parseNpmViewEntries(await this._execNpmView(
            npmPath, packageName, ['version', 'engines.node'], verified,
          )).find(candidate => candidate.version === verified);
        } catch { /* unavailable metadata cannot authorize an update target */ }
      }
      if (supported && satisfiesNodeRange(process.versions.node, supported.engines)) {
        entry.installable = verified;
      }
      if (!satisfiesNodeRange(process.versions.node, head.engines)) { entry.requiredNode = head.engines; }
      this._cache.set(providerId, entry);
      await this._persistCache();
      return;
    }

    // If the newest release excludes this machine's Node, find the newest one
    // that does not — otherwise Mysti offers an update that cannot be installed.
    if (!satisfiesNodeRange(process.versions.node, head.engines)) {
      entry.requiredNode = head.engines;
      const fallback = await this._findInstallableVersion(npmPath, packageName, latest);
      if (fallback) {
        entry.installable = fallback;
        console.log(
          `[Mysti] CliUpdate: ${packageName}@${latest} needs Node ${head.engines} `
          + `(have ${process.versions.node}); offering ${fallback} instead`
        );
      } else {
        // Nothing installable found: say so by pinning to what is installed,
        // i.e. offer nothing, rather than offering a command that fails.
        entry.installable = '';
      }
    }

    this._cache.set(providerId, entry);
    await this._persistCache();
  }

  /**
   * Newest published version whose `engines.node` accepts the running Node.
   *
   * One extra registry call, made only when the latest release is already known
   * to be incompatible — the common path stays a single `npm view`.
   */
  private async _findInstallableVersion(
    npmPath: string,
    packageName: string,
    latest: string
  ): Promise<string | undefined> {
    let stdout: string;
    try {
      // `<pkg>@<0.0.0` would be empty; bound BELOW the latest instead, which is
      // the range whose newest member we want.
      stdout = await this._execNpmView(npmPath, packageName, ['version', 'engines.node'], `<${latest}`);
    } catch {
      return undefined;
    }
    const entries = parseNpmViewEntries(stdout);
    for (let i = entries.length - 1; i >= 0; i--) {
      const candidate = entries[i];
      if (!parseVersion(candidate.version, true)) { continue; }
      // Prereleases are not something to silently steer a user onto.
      if (candidate.version.includes('-')) { continue; }
      if (satisfiesNodeRange(process.versions.node, candidate.engines)) {
        return candidate.version;
      }
    }
    return undefined;
  }

  /**
   * `npm view <pkg> version` via execFile — argv array, NO shell. Even though
   * the package name is an in-repo literal, running it shell-free removes the
   * question entirely.
   */
  private _execNpmView(
    npmPath: string,
    packageName: string,
    fields: string[] = ['version'],
    range?: string
  ): Promise<string> {
    // `range` is built here from a registry-supplied version that has already
    // passed the strict semver check; the package name is an in-repo literal.
    const spec = range ? `${packageName}@${range}` : packageName;
    return new Promise((resolve, reject) => {
      const child = execFile(
        npmPath,
        ['view', spec, ...fields, '--json'],
        { timeout: CLI_UPDATE_PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 512 },
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
    const verified = getVerifiedNativeCliVersion(providerId);
    return !cached || (!!verified && cached.verifiedVersion !== verified)
      || (Date.now() - cached.checkedAt) > CLI_UPDATE_CHECK_TTL_MS;
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
