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

/**
 * Logical identifiers for the canvas generation API keys.
 * These map 1:1 to the legacy `mysti.canvas.*ApiKey` settings.
 */
export type CanvasSecretKind = 'openai' | 'gemini' | 'stitch' | 'fal';

/**
 * SecretStorage-backed store for canvas generation API keys (F-11).
 *
 * Replaces the plaintext, sync-able `mysti.canvas.openaiApiKey` /
 * `mysti.canvas.geminiApiKey` / `mysti.canvas.stitchApiKey` settings.
 * Keys are read from `context.secrets`; a one-time migration copies any
 * value that still lives in settings into SecretStorage (and clears the
 * setting) so existing users keep working without re-entering their keys.
 *
 * The generation services no longer read settings or mutate `process.env`
 * for keys — callers resolve the key through this store and pass it in
 * explicitly (see per-service `apiKey` parameters).
 *
 * **Plan 20 §3.6 — only a *user*-scoped value is ever adopted.** The legacy
 * settings were workspace-writable, so a cloned repository could ship a
 * `.vscode/settings.json` that either (a) plants an attacker's API key which
 * Mysti would then bill the user's generations against, or (b) sits there as a
 * plaintext sink. The settings are now declared `"scope": "machine"` in
 * package.json, and {@link CanvasSecrets.migrate} reads **only**
 * `inspect(key).globalValue`: a workspace / workspace-folder value is never
 * adopted into SecretStorage — it is reported to the user and cleared, on every
 * activation, not just the first one.
 */
export class CanvasSecrets {
  /** SecretStorage keys (namespaced so they never collide with other extensions). */
  private static readonly _storageKeys: Record<CanvasSecretKind, string> = {
    openai: 'mysti.canvas.openaiApiKey',
    gemini: 'mysti.canvas.geminiApiKey',
    stitch: 'mysti.canvas.stitchApiKey',
    fal: 'mysti.canvas.falApiKey',
  };

  /** Legacy settings keys (relative to the `mysti` config section). */
  private static readonly _settingKeys: Record<CanvasSecretKind, string> = {
    openai: 'canvas.openaiApiKey',
    gemini: 'canvas.geminiApiKey',
    stitch: 'canvas.stitchApiKey',
    // fal never had a legacy setting; migration finds nothing and skips it.
    fal: 'canvas.falApiKey',
  };

  /** globalState flag recording that the one-time settings→secrets migration ran. */
  private static readonly _migrationFlag = 'mysti.canvas.secretsMigrated';

  private readonly _secrets: vscode.SecretStorage;
  private readonly _memento: vscode.Memento;

  /**
   * @param secrets `context.secrets` from the activated extension context.
   * @param memento `context.globalState` — used to record the one-time
   *                migration so it never re-runs after the user clears a key.
   */
  constructor(secrets: vscode.SecretStorage, memento: vscode.Memento) {
    this._secrets = secrets;
    this._memento = memento;
  }

  /**
   * Read a stored key. Returns '' (never undefined) when nothing is stored,
   * so callers can keep their existing `if (!key)` checks. Note this does NOT
   * fall back to settings — run `migrate()` once on activation first.
   */
  async get(kind: CanvasSecretKind): Promise<string> {
    const value = await this._secrets.get(CanvasSecrets._storageKeys[kind]);
    return value || '';
  }

  /**
   * Store (or, when given an empty value, delete) a key in SecretStorage.
   */
  async set(kind: CanvasSecretKind, value: string): Promise<void> {
    const storageKey = CanvasSecrets._storageKeys[kind];
    if (value && value.trim()) {
      await this._secrets.store(storageKey, value.trim());
    } else {
      await this._secrets.delete(storageKey);
    }
  }

  /** Delete a stored key. */
  async delete(kind: CanvasSecretKind): Promise<void> {
    await this._secrets.delete(CanvasSecrets._storageKeys[kind]);
  }

  /**
   * One-time migration: for each kind, if a plaintext value still lives in the
   * legacy `mysti.canvas.*ApiKey` setting **at user (Global) scope** and nothing
   * is in SecretStorage yet, copy it into SecretStorage and clear the setting.
   * Safe to call on every activation — guarded by a globalState flag and per-key
   * presence checks, so it never clobbers a key the user set via `set()`.
   *
   * Workspace-scoped values are purged first ({@link purgeWorkspaceSecrets}) and
   * are *never* adopted, so a repository cannot inject a key by shipping a
   * `.vscode/settings.json`. That purge runs on every activation, not only the
   * migration run.
   *
   * @returns the list of kinds whose value was migrated this run (for logging).
   */
  async migrate(): Promise<CanvasSecretKind[]> {
    // Not guarded by the migration flag: a workspace value can appear at any
    // time (a repo is cloned, a branch is checked out) long after migration ran.
    await this.purgeWorkspaceSecrets();

    if (this._memento.get<boolean>(CanvasSecrets._migrationFlag)) {
      return [];
    }

    const config = vscode.workspace.getConfiguration('mysti');
    if (typeof config.inspect !== 'function') {
      // Without `inspect` we cannot tell a user value from a workspace value,
      // and `get()` collapses the two — so adopt nothing rather than risk
      // importing a repository-supplied key. Leave the flag unset so a host
      // that does support inspect() can still migrate later.
      console.warn('[Mysti] CanvasSecrets: configuration.inspect unavailable — skipping settings migration.');
      return [];
    }

    const migrated: CanvasSecretKind[] = [];

    for (const kind of Object.keys(CanvasSecrets._settingKeys) as CanvasSecretKind[]) {
      const settingKey = CanvasSecrets._settingKeys[kind];
      const globalValue = readString(config.inspect<string>(settingKey)?.globalValue);
      if (!globalValue) { continue; }

      // Don't overwrite a key the user already moved into SecretStorage.
      const existing = await this.get(kind);
      if (!existing) {
        await this.set(kind, globalValue);
        migrated.push(kind);
      }

      // Clear the plaintext setting either way (it's superseded by secrets).
      try {
        await config.update(settingKey, undefined, vscode.ConfigurationTarget.Global);
      } catch {
        // Setting may not be writable at Global scope in some hosts; ignore.
      }
    }

    await this._memento.update(CanvasSecrets._migrationFlag, true);
    if (migrated.length > 0) {
      console.log(`[Mysti] CanvasSecrets: migrated ${migrated.join(', ')} key(s) from settings to SecretStorage.`);
    }
    return migrated;
  }

  /**
   * Clear any canvas API key that a workspace (or workspace folder) has set,
   * and tell the user. Such a value is untrusted by construction — it comes from
   * the checked-out repository, not from the person using it — so it is dropped,
   * never adopted into SecretStorage.
   *
   * @returns the kinds whose workspace value was found (and cleared).
   */
  async purgeWorkspaceSecrets(): Promise<CanvasSecretKind[]> {
    const config = vscode.workspace.getConfiguration('mysti');
    if (typeof config.inspect !== 'function') { return []; }

    const found: CanvasSecretKind[] = [];
    for (const kind of Object.keys(CanvasSecrets._settingKeys) as CanvasSecretKind[]) {
      const settingKey = CanvasSecrets._settingKeys[kind];
      const info = config.inspect<string>(settingKey);
      const targets: vscode.ConfigurationTarget[] = [];
      if (readString(info?.workspaceValue)) { targets.push(vscode.ConfigurationTarget.Workspace); }
      if (readString(info?.workspaceFolderValue)) { targets.push(vscode.ConfigurationTarget.WorkspaceFolder); }
      if (targets.length === 0) { continue; }

      found.push(kind);
      for (const target of targets) {
        try {
          await config.update(settingKey, undefined, target);
        } catch {
          // Read-only workspace config (e.g. an untrusted window); the value is
          // still never adopted — the warning below is the user-visible result.
        }
      }
    }

    if (found.length > 0) {
      const keys = found.map(k => `mysti.${CanvasSecrets._settingKeys[k]}`).join(', ');
      console.warn(`[Mysti] CanvasSecrets: ignored and cleared workspace-scoped canvas API key(s): ${keys}`);
      void vscode.window.showWarningMessage(
        `Mysti ignored a canvas API key set by this workspace (${keys}). ` +
        'Workspace files must not supply API keys — enter yours from the Canvas config panel.',
      );
    }
    return found;
  }
}

/** A non-empty trimmed string, or '' for anything else (numbers, objects, null). */
function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
