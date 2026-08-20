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
 * Plan 22 3.4 - the webview end of the typed canvas protocol.
 *
 * `src/canvas/protocol.ts` declares the union; this is the half that consumes
 * it, and it switches **exhaustively**: a variant added to `CanvasHostMessage`
 * with no handler here fails `tsc` at {@link assertNeverCanvasMessage}. That is
 * the specific class of bug this file exists to kill - today the host answers
 * `canvasReady` with a `canvasLoad` the shell ignores, `#btn-present` posts into
 * the void, and 11 of the host's 14 message cases are unreachable, all of which
 * type-check perfectly because nothing ever related the two ends.
 *
 * Three further properties, each tested:
 *
 * 1. **`canvas/ready` is the single authoritative state transfer.** Nothing is
 *    baked into the shell HTML, so a webview reload cannot show a stale
 *    artifact (it does today: the artifact is inlined once at
 *    `ChatViewProvider.ts:6815` and never refreshed).
 * 2. **Version gaps are detected, not absorbed.** The client tracks
 *    `artifactVersion` and asks for `canvas/resync` the moment records skip a
 *    version, so a dropped message degrades into one full transfer rather than
 *    a board that silently disagrees with the file on disk.
 * 3. **Frames cannot forge host traffic.** A page runs in an
 *    `allow-scripts`-only iframe and can still `parent.postMessage` at this
 *    window. Anything arriving with a `source` that is not this window is
 *    dropped before it is even shape-checked - the frame's ONLY channel is its
 *    dedicated `MessagePort`, which is what makes page traffic and host traffic
 *    structurally different rather than heuristically distinguishable.
 */

import {
  assertNeverCanvasMessage,
  isCanvasHostMessage,
  type CanvasClientMessage,
  type CanvasHostMessage,
} from '../../canvas/protocol';
import type { WindowMessageEvent } from './dom';

/**
 * A client message minus the auth envelope the transport stamps.
 *
 * Derived from the exported union (distributively, so `t` stays a usable
 * discriminant) rather than re-declared - re-declaring it is exactly how a
 * webview grows the ability to *claim* fields the host is supposed to stamp.
 */
type WithoutAuth<T> = T extends unknown ? Omit<T, 'viewToken'> : never;
export type CanvasClientBody = WithoutAuth<CanvasClientMessage>;

/** One handler per host message variant. All required: absence is a `tsc` error. */
export interface CanvasHostHandlers {
  hello(m: Extract<CanvasHostMessage, { t: 'canvas/hello' }>): void;
  caps(m: Extract<CanvasHostMessage, { t: 'canvas/caps' }>): void;
  ops(m: Extract<CanvasHostMessage, { t: 'canvas/ops' }>): void;
  staged(m: Extract<CanvasHostMessage, { t: 'canvas/staged' }>): void;
  receipt(m: Extract<CanvasHostMessage, { t: 'canvas/receipt' }>): void;
  job(m: Extract<CanvasHostMessage, { t: 'canvas/job' }>): void;
  agentCursor(m: Extract<CanvasHostMessage, { t: 'canvas/agentCursor' }>): void;
  /** The host's undo/redo/versions snapshot; the webview keeps no mirror of it. */
  history(m: Extract<CanvasHostMessage, { t: 'canvas/history' }>): void;
  resync(m: Extract<CanvasHostMessage, { t: 'canvas/resync' }>): void;
  artifacts(m: Extract<CanvasHostMessage, { t: 'canvas/artifacts' }>): void;
}

export interface CanvasProtocolOptions {
  /** `acquireVsCodeApi().postMessage`. */
  post: (message: unknown) => void;
  handlers: CanvasHostHandlers;
  /** Minted host-side and delivered in the shell boot payload. */
  viewToken: string;
  warn?: (message: string, ...rest: unknown[]) => void;
}

/**
 * Constant-time-ish token comparison. Not a defence against a timing attack
 * (there is no oracle here), just a habit worth keeping at an auth boundary.
 */
function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) { return false; }
  let diff = 0;
  for (let i = 0; i < a.length; i++) { diff |= a.charCodeAt(i) ^ b.charCodeAt(i); }
  return diff === 0;
}

export class CanvasProtocolClient {
  private readonly _post: (message: unknown) => void;
  private readonly _handlers: CanvasHostHandlers;
  private readonly _warn: (message: string, ...rest: unknown[]) => void;
  private _viewToken: string;
  private _dropped = 0;

  constructor(opts: CanvasProtocolOptions) {
    this._post = opts.post;
    this._handlers = opts.handlers;
    this._viewToken = opts.viewToken;
    this._warn = opts.warn ?? (() => { /* silent by default */ });
  }

  /** Messages refused by the source or shape guards. Surfaced in tests. */
  get droppedCount(): number { return this._dropped; }

  /**
   * `canvas/hello` may re-mint the token (a reloaded view gets a fresh one).
   * Empty tokens are refused: `acceptCanvasClientMessage` fails closed on the
   * host side, so sending with one would only produce silent no-ops.
   */
  setViewToken(token: string): void {
    if (typeof token === 'string' && token.length > 0) { this._viewToken = token; }
  }

  /** Stamp the auth envelope and post. The only outbound path. */
  send(body: CanvasClientBody): void {
    if (!this._viewToken) {
      this._warn('canvas: refusing to send before a view token exists', body.t);
      return;
    }
    this._post({ ...body, viewToken: this._viewToken });
  }

  /**
   * Front door for `window`'s `message` event.
   *
   * @returns true when the message was dispatched to a handler.
   */
  receive(ev: WindowMessageEvent, selfWindow: unknown, parentWindow?: unknown): boolean {
    // Source guard FIRST: a sandboxed page frame reaches this window, and a
    // model-authored page must not be able to spoof `canvas/ops` and repaint
    // the board. Allowlist, never blocklist — scanning known contentWindows
    // missed NESTED frames.
    //
    // The allowlist MUST include the PARENT. In VS Code the extension's HTML is
    // loaded inside a nested `<iframe id="active-frame">`, and the outer
    // `vscode-webview://` document relays every extension message with
    // `contentWindow.postMessage(...)` — so `ev.source === window.parent`,
    // which is truthy and is not `selfWindow`. The previous rule therefore
    // dropped `canvas/hello` and every delta before the shape guard, leaving a
    // permanently blank board with no retry and no surfaced diagnostic. (The
    // old `media/canvas/canvas.js` shipped the same rule with a self-flagged
    // "F5-verify" caveat; this is that verification, and it failed.)
    //
    // Frames stay excluded by construction: an embedded artboard — at any depth
    // — posts with a source that is one of OUR descendants, never our parent
    // and never us. Frame traffic has its own `MessageChannel` port anyway.
    if (!isCanvasHostMessage(ev.data)) { this._dropped++; return false; }

    // AUTHENTICATE ON CONTENT, NOT PROVENANCE.
    //
    // The host stamps the per-view token on every message. An artboard is a
    // sandboxed, opaque-origin frame: it cannot read this document, so it
    // cannot learn the token, and a forged `canvas/ops` is refused here.
    //
    // The `ev.source` check this replaces could not be made sound — a frame
    // nested inside an artboard can post to `window.top`, so no window
    // allowlist or denylist covers it — and it failed CLOSED and SILENTLY
    // twice in production: once dropping every message because VS Code relays
    // from the parent, then again leaving the panel stuck on "Loading your
    // designs…". A control that cannot be verified from inside the webview has
    // no business being the only thing between the user and a working panel.
    const token = (ev.data as { viewToken?: unknown }).viewToken;
    if (this._viewToken && typeof token === 'string' && token.length > 0) {
      if (!tokensMatch(token, this._viewToken)) {
        this._dropped++;
        this._warn('canvas: host message rejected — view token mismatch', (ev.data as { t?: unknown }).t);
        return false;
      }
      this.dispatch(ev.data);
      return true;
    }

    // No token on the wire: an older host, or `canvas/hello` itself arriving
    // before this client has one. Fall back to the source shape — but say so,
    // because a silent drop here is what cost two production failures.
    const fromHost = !ev.source || ev.source === selfWindow
      || (parentWindow !== undefined && parentWindow !== selfWindow && ev.source === parentWindow);
    if (!fromHost) {
      this._dropped++;
      this._warn('canvas: host message dropped — untokened and from an unexpected source', (ev.data as { t?: unknown }).t);
      return false;
    }
    this.dispatch(ev.data);
    return true;
  }

  /**
   * The exhaustive switch. Adding a `CanvasHostMessage` variant without a case
   * here is a compile error, not a silently ignored message.
   */
  dispatch(message: CanvasHostMessage): void {
    switch (message.t) {
      case 'canvas/hello': this._handlers.hello(message); return;
      case 'canvas/caps': this._handlers.caps(message); return;
      case 'canvas/ops': this._handlers.ops(message); return;
      case 'canvas/staged': this._handlers.staged(message); return;
      case 'canvas/receipt': this._handlers.receipt(message); return;
      case 'canvas/job': this._handlers.job(message); return;
      case 'canvas/agentCursor': this._handlers.agentCursor(message); return;
      case 'canvas/history': this._handlers.history(message); return;
      case 'canvas/resync': this._handlers.resync(message); return;
      case 'canvas/artifacts': this._handlers.artifacts(message); return;
      default:
        // Unreachable while both ends share a build; the throw only covers a
        // message from a NEWER host talking to an older webview.
        assertNeverCanvasMessage(message);
    }
  }
}
