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
 * Plan 45: the Manage Plugins template. Its CSP nonce must come from a CSPRNG
 * (18 random bytes, base64) — a Math.random() nonce is predictable — and the
 * same value must reach both the policy and the script tag.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { getPluginsContent } from '../../src/webview/pluginsContent';

const ROOT = path.resolve(__dirname, '../..');
const webview = { cspSource: 'vscode-resource:', asWebviewUri: (u: unknown) => u } as never;

describe('Manage Plugins template (Plan 45)', () => {
  it('fills one cryptographic nonce into the policy and the script tag', () => {
    const html = getPluginsContent(webview, { fsPath: ROOT } as never);
    const policy = /script-src 'nonce-([^']+)'/.exec(html)?.[1];
    const tag = /<script nonce="([^"]+)"/.exec(html)?.[1];
    expect(policy).toMatch(/^[A-Za-z0-9+/]{24}$/);
    expect(tag).toBe(policy);
    expect(html).not.toContain('{{');
  });

  it('never repeats a nonce across loads', () => {
    const a = /nonce-([^']+)/.exec(getPluginsContent(webview, { fsPath: ROOT } as never))?.[1];
    const b = /nonce-([^']+)/.exec(getPluginsContent(webview, { fsPath: ROOT } as never))?.[1];
    expect(a).not.toBe(b);
  });
});
