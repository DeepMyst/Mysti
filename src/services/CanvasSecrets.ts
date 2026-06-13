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
export type CanvasSecretKind = 'openai' | 'gemini' | 'stitch';

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
 */
export class CanvasSecrets {
  /** SecretStorage keys (namespaced so they never collide with other extensions). */
  private static readonly _storageKeys: Record<CanvasSecretKind, string> = {
    openai: 'mysti.canvas.openaiApiKey',
    gemini: 'mysti.canvas.geminiApiKey',
    stitch: 'mysti.canvas.stitchApiKey',
  };

  /** Legacy settings keys (relative to the `mysti` config section). */
  private static readonly _settingKeys: Record<CanvasSecretKind, string> = {
    openai: 'canvas.openaiApiKey',
    gemini: 'canvas.geminiApiKey',
    stitch: 'canvas.stitchApiKey',
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
   * legacy `mysti.canvas.*ApiKey` setting and nothing is in SecretStorage yet,
   * copy it into SecretStorage and clear the setting (Global scope). Safe to
   * call on every activation — guarded by a globalState flag and per-key
   * presence checks, so it never clobbers a key the user set via `set()`.
   *
   * @returns the list of kinds whose value was migrated this run (for logging).
   */
  async migrate(): Promise<CanvasSecretKind[]> {
    if (this._memento.get<boolean>(CanvasSecrets._migrationFlag)) {
      return [];
    }

    const config = vscode.workspace.getConfiguration('mysti');
    const migrated: CanvasSecretKind[] = [];

    for (const kind of Object.keys(CanvasSecrets._settingKeys) as CanvasSecretKind[]) {
      const settingKey = CanvasSecrets._settingKeys[kind];
      const settingValue = (config.get<string>(settingKey, '') || '').trim();
      if (!settingValue) { continue; }

      // Don't overwrite a key the user already moved into SecretStorage.
      const existing = await this.get(kind);
      if (!existing) {
        await this.set(kind, settingValue);
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
}
