/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 27 lane J, finding J-6 — the canvas SHELL's Content-Security-Policy.
 *
 * A `srcdoc` artboard inherits the parent webview's policy, so the shell's
 * `img-src … https:` was the other half of the E-2 beacon: the effective
 * policy in a frame is the INTERSECTION of the two, and both halves allowed
 * `https:`. The shell was also the only Mysti webview with `connect-src https:`
 * and no `form-action` / `base-uri` — the chat panel narrowed all three in
 * Plan 23 B2 (media/chat/index.html).
 *
 * What the shell genuinely needs, established by reading every sink:
 *  - `connect-src ${cspSource}` — `realEnv().fetchText` (dom.ts) is the only
 *    `fetch`, and app.ts calls it on `runtimeUris`/`harnessUri`/`babelUri`,
 *    all `asWebviewUri` outputs. Nothing fetches `https:` or `data:`.
 *  - `img-src ${cspSource} data: blob:` — preview.ts's one `src` sink is an
 *    `asset://` ref resolved to the webview asset origin (boot.ts); the frame's
 *    own policy already names that origin via `imgSources`.
 *  - `font-src ${cspSource} data:` — canvas.css has no `@font-face`/`@import`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { getCanvasContent } from '../../src/webview/canvasContent';
import { mintViewToken } from '../../src/canvas/protocol';

const repoRoot = path.resolve(__dirname, '..', '..');
const CSP_SOURCE = 'vscode-resource://test';

function makeWebview() {
  return {
    cspSource: CSP_SOURCE,
    asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => 'vscode-resource://authority' + uri.fsPath }),
  } as never;
}
const extensionUri = { fsPath: repoRoot, path: repoRoot } as never;

let shellCsp: string;
let directives: Map<string, string>;

beforeAll(() => {
  const html = getCanvasContent(makeWebview(), extensionUri, '1.2.3', undefined, undefined, { viewToken: mintViewToken() });
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
  expect(meta).not.toBeNull();
  shellCsp = meta![1];
  directives = new Map(
    shellCsp.split(';').map(s => s.trim()).filter(Boolean).map(d => {
      const [name, ...rest] = d.split(/\s+/);
      return [name, rest.join(' ')] as const;
    }),
  );
});

describe('canvas shell CSP is no wider than the chat panel where it has no reason to be', () => {
  it('img-src names the webview origin, data: and blob: — no https: scheme-source', () => {
    expect(directives.get('img-src')).toBe(`${CSP_SOURCE} data: blob:`);
  });

  it('connect-src is exactly the webview origin the lazy runtime fetch needs', () => {
    expect(directives.get('connect-src')).toBe(CSP_SOURCE);
  });

  it('font-src carries no https: scheme-source', () => {
    expect(directives.get('font-src')).toBe(`${CSP_SOURCE} data:`);
  });

  it("sets form-action 'none' and base-uri 'none', which do NOT inherit from default-src", () => {
    expect(directives.get('form-action')).toBe("'none'");
    expect(directives.get('base-uri')).toBe("'none'");
  });

  it('carries no bare https: scheme-source in any directive', () => {
    expect(shellCsp).not.toMatch(/(^|\s)https:(\s|;|$)/);
  });

  it('keeps the directives the shell does need', () => {
    expect(directives.get('default-src')).toBe("'none'");
    expect(directives.get('script-src')).toMatch(new RegExp(`^'nonce-[A-Za-z0-9]{32}' ${CSP_SOURCE.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`));
    expect(directives.get('style-src')).toBe(`${CSP_SOURCE} 'unsafe-inline'`);
    // srcdoc artboards.
    expect(directives.get('frame-src')).toBe("'self' blob: data:");
  });
});
