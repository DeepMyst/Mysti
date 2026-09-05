/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 27 Gate 4 / D-11 — REFUSAL MUST SPEAK.
 *
 * Every gated directive group is simply ABSENT from the coordinator's scanner
 * when its setting is off. That is a good security property — an unrecognised
 * capability cannot be half-executed — and a terrible product one: the tag
 * "degrades to visible text", so the model announces it is writing a file and
 * the user sees raw `<write:NONCE …>` markup, or nothing, and no explanation.
 *
 * The audit's D-11 was "the default agent cannot edit a file AND NOTHING TELLS
 * THE USER", and Appendix C item 6 settled the fix: do NOT flip the default —
 * "silence is the defect, not the default". This is that fix.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
let provider: string;
let js: string;

beforeAll(() => {
  provider = fs.readFileSync(path.join(ROOT, 'src', 'providers', 'ChatViewProvider.ts'), 'utf8');
  js = fs.readFileSync(path.join(ROOT, 'media', 'chat', 'chat.js'), 'utf8');
});

describe('a blocked capability names itself', () => {
  it('the announcer runs on the coordinator turn', () => {
    expect(provider).toContain('this._announceRefusedCapability(panelId, turnText, delegateNonce, scanKinds)');
  });

  it('it fires only when the model ACTUALLY tried — and only for THIS run', () => {
    const idx = provider.indexOf('private _announceRefusedCapability');
    expect(idx).toBeGreaterThan(-1);
    const body = provider.slice(idx, idx + 2600);
    // Nonce-scoped: a user pasting "<write:" into chat cannot trigger it.
    expect(body).toContain('turnText.includes(`<${k}:${nonce}`)');
    expect(body).toContain('if (!tried) { continue; }');
  });

  it('it does not nag: once per panel, and never when nothing was blocked', () => {
    const idx = provider.indexOf('private _announceRefusedCapability');
    const body = provider.slice(idx, idx + 2600);
    expect(body).toContain('this._refusalAnnounced.has(panelId)');
    expect(body).toContain('if (blocked.length === 0) { continue; }');
  });

  it('it changes NOTHING about what is allowed — it only reports', () => {
    const idx = provider.indexOf('private _announceRefusedCapability');
    const body = provider.slice(idx, idx + 2600);
    // No setting writes, no gate mutation, no scanner changes.
    expect(body).not.toMatch(/\.update\(|config\.update|scanKinds\.push/);
  });

  it('it covers the four gated groups a user can turn on', () => {
    const idx = provider.indexOf('private _announceRefusedCapability');
    const body = provider.slice(idx, idx + 2600);
    for (const key of [
      'mysti.mysti.localExecution',
      'mysti.mysti.mcpTools',
      'mysti.mysti.skills',
      'mysti.mysti.visualTools',
    ]) {
      expect(body, `${key} has no refusal message`).toContain(key);
    }
  });

  it('the card says the default is deliberate, not broken', () => {
    const idx = provider.indexOf('private _announceRefusedCapability');
    expect(provider.slice(idx, idx + 2600)).toMatch(/off by default/i);
  });
});

describe('the button opens the exact setting', () => {
  it('the webview action posts the setting key', () => {
    expect(js).toContain('openCapabilitySetting:');
    const idx = js.indexOf("if (spec.local === 'setting')");
    expect(idx).toBeGreaterThan(-1);
    expect(js.slice(idx, idx + 260)).toContain("type: 'openSettingKey'");
  });

  it('the extension opens Settings filtered to that key, and only a mysti one', () => {
    const idx = provider.indexOf("case 'openSettingKey':");
    expect(idx).toBeGreaterThan(-1);
    const body = provider.slice(idx, idx + 500);
    // A webview message is untrusted input: it must not be able to drive
    // executeCommand with an arbitrary string.
    expect(body).toContain("startsWith('mysti.')");
    expect(body).toContain('workbench.action.openSettings');
  });
});
