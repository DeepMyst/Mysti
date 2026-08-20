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
 * Plan 22 3.4 - the shell boot contract, declared ONCE.
 *
 * `canvasContent.ts` (extension host) writes this object into the shell HTML
 * and `index.ts` (webview bundle) reads it. Both import this type, so a field
 * added on one side without the other is a `tsc` failure rather than an
 * `undefined` at runtime.
 *
 * Note what is deliberately NOT here: **the artifact**. Today the whole design
 * is inlined into the HTML once at `ChatViewProvider.ts:6815` and never
 * refreshed, so a webview reload renders whatever the design looked like when
 * the panel first opened. State arrives over `canvas/hello` instead, in
 * response to `canvas/ready` - one authoritative transfer, always current.
 *
 * Also not here: **`babel.min.js`**, 2,983,904 bytes of it. Only URIs ride in
 * the shell; the runtime is fetched lazily, so the static previews paint
 * immediately and a doc-model page never loads a JSX compiler at all.
 */

import type { CanvasFormatSpec, DesignTheme } from '../../types';

export const CANVAS_BOOT_GLOBAL = '__MYSTI_CANVAS_BOOT__';

export interface CanvasDeviceOption {
  formatId: string;
  width: number;
  height: number;
  kind: CanvasFormatSpec['kind'];
  label: string;
}

export interface CanvasThemeOption {
  id: string;
  name: string;
  dark: boolean;
  theme: DesignTheme;
}

export interface CanvasScaffoldOption {
  id: string;
  name: string;
  description?: string;
}

export interface CanvasBoot {
  /**
   * Per-view auth envelope, minted host-side. Required for the FIRST client
   * message (`canvas/ready`), which is why it cannot wait for `canvas/hello`.
   */
  viewToken: string;
  /** The shell's CSP nonce. A `srcdoc` artboard inherits the parent policy, so
   *  its scripts must carry this or they are refused and the frame is blank. */
  frameNonce?: string;
  /** React, ReactDOM and `ui-primitives.js`, as webview URIs. Fetched lazily. */
  runtimeUris: string[];
  /** The frame harness, as a webview URI. */
  harnessUri: string;
  /** Fetched ONLY when a `legacy` artboard needs a JSX compiler. */
  babelUri: string;
  /** Prefix for resolving `asset://<name>` to a loadable webview URI. */
  assetBaseUri?: string;
  /** Inner CSP for frame documents - the one policy, passed through. */
  innerCsp: string;
  devices: CanvasDeviceOption[];
  themes: CanvasThemeOption[];
  scaffolds: CanvasScaffoldOption[];
  activeThemeId?: string;
}

/** Read the boot object the shell inlined, or `null` in a bare page. */
export function readBoot(scope: unknown): CanvasBoot | null {
  if (!scope || typeof scope !== 'object') { return null; }
  const value = (scope as Record<string, unknown>)[CANVAS_BOOT_GLOBAL];
  if (!value || typeof value !== 'object') { return null; }
  const boot = value as Partial<CanvasBoot>;
  if (typeof boot.viewToken !== 'string' || boot.viewToken.length === 0) { return null; }
  return {
    viewToken: boot.viewToken,
    frameNonce: typeof boot.frameNonce === 'string' && boot.frameNonce ? boot.frameNonce : undefined,
    runtimeUris: Array.isArray(boot.runtimeUris) ? boot.runtimeUris.filter(u => typeof u === 'string') : [],
    harnessUri: typeof boot.harnessUri === 'string' ? boot.harnessUri : '',
    babelUri: typeof boot.babelUri === 'string' ? boot.babelUri : '',
    assetBaseUri: typeof boot.assetBaseUri === 'string' ? boot.assetBaseUri : undefined,
    innerCsp: typeof boot.innerCsp === 'string' ? boot.innerCsp : '',
    devices: Array.isArray(boot.devices) ? boot.devices : [],
    themes: Array.isArray(boot.themes) ? boot.themes : [],
    scaffolds: Array.isArray(boot.scaffolds) ? boot.scaffolds : [],
    activeThemeId: typeof boot.activeThemeId === 'string' ? boot.activeThemeId : undefined,
  };
}

/** One path segment of an `asset://` ref: no separators, no dot-segments. */
const ASSET_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/**
 * The middle segment of a canonical ref. Mirrors `ASSETS_DIR` in
 * `ArtifactStore.ts`; it is restated rather than imported because that module
 * is host-only (`fs`, `path`, `crypto`) and this one is bundled into the
 * webview.
 */
const ASSET_DIR_SEGMENT = 'assets';

/**
 * Resolve an `asset://…` ref against the webview asset base.
 *
 * The grammar is the one `ArtifactStore` mints and `resolveAssetPath` re-states:
 * **`asset://<artifactId>/assets/<sha>.<ext>`** — three segments. This resolver
 * previously accepted only a flat, slash-free name, so it returned `null` for
 * every real ref (CANVAS-SEC-3): the static preview dropped the `<img src>` and
 * the live frame received the unresolved `asset://…` string, which the harness's
 * `safeUrl` refuses because `asset:` is not a permitted scheme. Every generated
 * or imported image was invisible in every renderer, silently.
 *
 * Only the FILE segment is appended: `CanvasBoot.assetBaseUri` is already
 * `<artifactDir>/assets` (see `ChatViewProvider._canvasAssetBaseUri`), so the
 * artifact and `assets` segments are validated and then dropped. A ref naming a
 * different artifact therefore resolves inside the OPEN artifact's assets dir,
 * where it simply does not exist — it can never point outside it.
 *
 * The flat `asset://<name>` form is still accepted for refs authored before the
 * per-artifact store, and is subject to the identical segment check.
 *
 * Returns `null` for anything else — refs are model-authored, and
 * `asset://../../.mysti/secrets` must not become a readable webview URI.
 * `preview.ts` re-checks the resulting scheme, so this is the first of two
 * independent gates rather than the only one.
 */
export function makeAssetResolver(base: string | undefined): (ref: string) => string | null {
  if (!base) { return () => null; }
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return (ref: string): string | null => {
    if (typeof ref !== 'string' || !ref.startsWith('asset://')) { return null; }
    const rest = ref.slice('asset://'.length);
    if (rest.includes('..')) { return null; }
    const parts = rest.split('/');
    let file: string;
    if (parts.length === 3) {
      if (!ASSET_SEGMENT_RE.test(parts[0]) || parts[1] !== ASSET_DIR_SEGMENT) { return null; }
      file = parts[2];
    } else if (parts.length === 1) {
      file = parts[0];
    } else {
      return null;
    }
    if (!ASSET_SEGMENT_RE.test(file)) { return null; }
    return prefix + file;
  };
}

/** One label of a CSP `host-source`: `host-char = ALPHA / DIGIT / "-"`. */
const CSP_HOST_LABEL_RE = /^[A-Za-z0-9-]+$/;

/**
 * The CSP source expression for the webview's asset origin, derived from
 * {@link CanvasBoot.assetBaseUri}.
 *
 * A `doc`-mode frame ships a hardened `img-src data: blob:` (§3.6), so without
 * this an `asset://` resolved to a webview URI is blocked by the frame's own
 * policy. Returns `null` when there is no base or it is not an absolute URL —
 * `URL` is not in `lib: ["ES2022"]`, so this parses the origin by hand rather
 * than reaching for a global the bundle cannot type.
 *
 * The result must be a **legal CSP source expression**, which is not the same
 * thing as a legal URL origin. On VS Code desktop `asWebviewUri` returns
 * `https://file+.vscode-resource.vscode-cdn.net/…`, and `+` is not a
 * `host-char`: returning that origin verbatim made Chromium discard the source
 * ("contains an invalid source: … It will be ignored"), so every live artboard
 * kept `img-src data: blob:` and every generated, imported or dropped-in image
 * vanished the instant the artboard went live — while its static preview tile,
 * which allows `https:`, still showed it, so it read as a flicker rather than a
 * policy block. An illegal leading label is therefore replaced by `*`, which is
 * exactly the shape VS Code's own `webview.cspSource` uses, and which stays
 * narrower than that value (it names the resource authority, not the whole
 * `vscode-cdn.net` CDN). Never widened past two remaining labels, so no input
 * can produce `*.net` or a bare `*`.
 */
export function assetCspSource(base: string | undefined): string | null {
  if (typeof base !== 'string') { return null; }
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/\s]+)/i.exec(base);
  if (!match) { return null; }
  const host = cspHostSource(match[2]);
  return host ? `${match[1]}://${host}` : null;
}

/** An authority (`host[:port]`) as a CSP `host-source`, or `null`. */
function cspHostSource(authority: string): string | null {
  const parts = /^([^:]+)(:[0-9]{1,5})?$/.exec(authority);
  if (!parts) { return null; }
  const port = parts[2] ?? '';
  const labels = parts[1].split('.');
  if (labels.every(l => CSP_HOST_LABEL_RE.test(l))) { return parts[1] + port; }
  const rest = labels.slice(1);
  if (rest.length >= 2 && rest.every(l => CSP_HOST_LABEL_RE.test(l))) { return `*.${rest.join('.')}${port}`; }
  return null;
}
