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
 * Plan 27 Gate 4 — "every error offers an action", for the CLI backends.
 *
 * The coordinator has had an action card since Plan 25. The other fifteen
 * agents had one actionable failure (authentication — providers yield an
 * `auth_error` chunk and the webview renders "Open Terminal & Authenticate")
 * and one dead end: a MISSING CLI arrived as a plain red sentence.
 *
 * That is the most likely first-run failure there is, since every agent except
 * the coordinator needs an `npm install -g` first.
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

describe('a missing CLI offers an action', () => {
  it('the classifier recognises the shapes a missing binary actually produces', () => {
    // Anchor on the DEFINITION: the first bare occurrence in the file is a
    // call site, since the method is defined further down beside its
    // coordinator twin.
    const idx = provider.indexOf('private _postProviderFailure');
    expect(idx, 'the method definition was not found').toBeGreaterThan(-1);
    const body = provider.slice(idx, idx + 1600);
    for (const shape of ['ENOENT', 'command not found', 'is not recognized']) {
      expect(body, `${shape} is not classified as a missing CLI`).toContain(shape);
    }
  });

  it('it is NARROW — anything else falls back to the plain error', () => {
    const idx = provider.indexOf('private _postProviderFailure');
    const body = provider.slice(idx, idx + 1600);
    expect(body).toContain('if (!missing) { return false; }');
    // Both call sites must honour the false return.
    expect(provider).toContain('if (!this._postProviderFailure(');
  });

  it('both CLI error paths route through it — stream AND spawn', () => {
    const calls = provider.match(/this\._postProviderFailure\(/g) ?? [];
    expect(calls.length, 'expected the stream error case and the catch-all').toBeGreaterThanOrEqual(2);
  });

  it('the card does not offer Retry — retrying a missing binary fails identically', () => {
    const idx = provider.indexOf('private _postProviderFailure');
    expect(provider.slice(idx, idx + 1600)).toContain('retryable: false');
  });

  it('the button opens the EXISTING install modal, not a second install path', () => {
    expect(js).toContain('installCli:');
    const idx = js.indexOf("if (spec.local === 'install')");
    expect(idx, 'the local action branch is missing').toBeGreaterThan(-1);
    expect(js.slice(idx, idx + 220)).toContain('showInstallProviderModal(payload.providerId)');
  });

  it('the button names the agent, so the card reads as one sentence', () => {
    expect(js).toContain('payload.providerName');
    expect(provider).toContain('providerName: name,');
  });
});
