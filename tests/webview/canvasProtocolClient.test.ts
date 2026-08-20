/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 §3.4 — the webview end of the typed protocol.
 *
 * The exhaustiveness claim is checked two ways, because the compile-time half
 * alone is not evidence at runtime: every tag in `CANVAS_HOST_MESSAGE_TAGS` is
 * dispatched and must reach a handler, so a variant added to the union without
 * a case here fails `tsc` AND fails this suite.
 */
import { describe, it, expect, vi } from 'vitest';
import { CanvasProtocolClient, type CanvasHostHandlers } from '../../src/webview/canvas/protocolClient';
import {
  CANVAS_HOST_MESSAGE_TAGS,
  acceptCanvasClientMessage,
  mintViewToken,
  type CanvasHostMessage,
} from '../../src/canvas/protocol';

function handlers(): { spies: CanvasHostHandlers; calls: string[] } {
  const calls: string[] = [];
  const record = (name: string) => () => { calls.push(name); };
  return {
    calls,
    spies: {
      hello: record('hello'), caps: record('caps'), ops: record('ops'),
      staged: record('staged'), receipt: record('receipt'), job: record('job'),
      agentCursor: record('agentCursor'), history: record('history'),
      resync: record('resync'), artifacts: record('artifacts'),
    },
  };
}

function makeClient(token = 'abcdef0123456789abcdef0123456789') {
  const posted: unknown[] = [];
  const h = handlers();
  const client = new CanvasProtocolClient({
    post: m => posted.push(m),
    handlers: h.spies,
    viewToken: token,
  });
  return { client, posted, calls: h.calls };
}

describe('exhaustive host-message dispatch', () => {
  it('routes every declared host tag to a handler', () => {
    const { client, calls } = makeClient();
    for (const tag of CANVAS_HOST_MESSAGE_TAGS) {
      client.dispatch({ t: tag } as unknown as CanvasHostMessage);
    }
    expect(calls).toHaveLength(CANVAS_HOST_MESSAGE_TAGS.length);
    expect(new Set(calls).size).toBe(CANVAS_HOST_MESSAGE_TAGS.length);
  });

  it('throws for a tag from a NEWER host rather than silently ignoring it', () => {
    const { client } = makeClient();
    expect(() => client.dispatch({ t: 'canvas/fromTheFuture' } as unknown as CanvasHostMessage))
      .toThrow(/unhandled canvas message/);
  });
});

describe('window message intake', () => {
  it('accepts host messages (null / self source)', () => {
    const { client, calls } = makeClient();
    const selfWindow = {};
    expect(client.receive({ data: { t: 'canvas/caps', caps: [] }, source: null }, selfWindow)).toBe(true);
    expect(client.receive({ data: { t: 'canvas/caps', caps: [] }, source: selfWindow }, selfWindow)).toBe(true);
    expect(calls).toEqual(['caps', 'caps']);
  });

  it('DROPS anything from an embedded frame — a page cannot forge canvas/ops', () => {
    const { client, calls } = makeClient();
    const selfWindow = {};
    const hostileFrame = {};
    const forged = { t: 'canvas/ops', records: [], artifactVersion: 999 };
    expect(client.receive({ data: forged, source: hostileFrame }, selfWindow)).toBe(false);
    // ...including a NESTED frame, which a contentWindow blocklist would miss.
    expect(client.receive({ data: forged, source: { nested: true } }, selfWindow)).toBe(false);
    expect(calls).toEqual([]);
    expect(client.droppedCount).toBe(2);
  });

  it('drops unknown / malformed payloads', () => {
    const { client, calls } = makeClient();
    for (const data of [null, undefined, 42, 'canvas/ops', { t: 'canvasArtifactUpdate' }, { t: 123 }]) {
      expect(client.receive({ data, source: null }, {})).toBe(false);
    }
    expect(calls).toEqual([]);
  });
});

describe('outbound auth envelope', () => {
  it('stamps the view token on every client message', () => {
    const token = mintViewToken();
    const { client, posted } = makeClient(token);
    client.send({ t: 'canvas/ready' });
    client.send({ t: 'canvas/export', format: 'png' });
    expect(posted).toHaveLength(2);
    for (const message of posted) {
      expect(acceptCanvasClientMessage(message, token)).not.toBeNull();
      // ...and a DIFFERENT view's token must not accept it.
      expect(acceptCanvasClientMessage(message, mintViewToken())).toBeNull();
    }
  });

  it('adopts a re-minted token from canvas/hello but refuses an empty one', () => {
    const { client, posted } = makeClient('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const fresh = mintViewToken();
    client.setViewToken(fresh);
    client.setViewToken('');
    client.send({ t: 'canvas/ready' });
    expect(acceptCanvasClientMessage(posted[0], fresh)).not.toBeNull();
  });

  it('refuses to send at all when no token exists — silence beats unauthenticated noise', () => {
    const posted: unknown[] = [];
    const warn = vi.fn();
    const client = new CanvasProtocolClient({
      post: m => posted.push(m), handlers: handlers().spies, viewToken: '', warn,
    });
    client.send({ t: 'canvas/ready' });
    expect(posted).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });
});

/* ───────── the VS Code relay shape — the gate that shipped blank ───────── */

describe('host messages relayed by the VS Code webview shell', () => {
  // In VS Code the extension's HTML runs inside a nested `<iframe
  // id="active-frame">`, and the outer `vscode-webview://` document relays
  // extension messages with `contentWindow.postMessage(...)` — so `ev.source`
  // is the PARENT window: truthy, and not self. The original gate dropped
  // exactly that, so `canvas/hello` never landed and the board stayed blank
  // with no retry and no diagnostic. This is the regression guard.
  it('accepts a message whose source is the parent window', () => {
    const selfWin = { name: 'inner' };
    const parentWin = { name: 'outer' };
    const { client, calls } = makeClient();
    const ok = client.receive(
      { data: { t: 'canvas/history', status: { canUndo: true, canRedo: false, versions: [] } }, source: parentWin },
      selfWin,
      parentWin,
    );
    expect(ok).toBe(true);
    expect(calls).toContain('history');
  });

  it('still rejects an embedded artboard frame posting at the window', () => {
    const selfWin = { name: 'inner' };
    const parentWin = { name: 'outer' };
    const frameWin = { name: 'model-authored-artboard' };
    const { client, calls } = makeClient();
    const ok = client.receive(
      { data: { t: 'canvas/ops', records: [], artifactVersion: 99 }, source: frameWin },
      selfWin,
      parentWin,
    );
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(client.droppedCount).toBe(1);
  });

  it('does not treat self as a parent when the view is not nested', () => {
    // Top-level document: `window.parent === window`. The parent branch must
    // not widen the allowlist to anything extra in that case.
    const selfWin = { name: 'top' };
    const other = { name: 'someone-else' };
    const { client } = makeClient();
    expect(client.receive({ data: { t: 'canvas/caps', caps: [] }, source: other }, selfWin, selfWin)).toBe(false);
    expect(client.receive({ data: { t: 'canvas/caps', caps: [] }, source: null }, selfWin, selfWin)).toBe(true);
  });
});

/* ───────── authenticate on content, not provenance ───────── */

describe('host messages are authenticated by view token', () => {
  // The `ev.source` heuristic this replaces failed CLOSED and SILENTLY twice in
  // production — once dropping everything because VS Code relays from the
  // parent, then again leaving the panel stuck on "Loading your designs…". It
  // also cannot be made sound: a frame nested inside a sandboxed artboard can
  // post to `window.top`, so no window allowlist or denylist covers it.
  const TOKEN = 'abcdef0123456789abcdef0123456789';

  it('accepts a tokened message from ANY source, including an artboard-shaped one', () => {
    const { client, calls } = makeClient(TOKEN);
    const someFrame = { name: 'artboard' };
    const ok = client.receive(
      { data: { t: 'canvas/caps', caps: [], viewToken: TOKEN }, source: someFrame },
      { name: 'self' }, { name: 'parent' },
    );
    expect(ok).toBe(true);
    expect(calls).toContain('caps');
  });

  it('rejects a forged message that carries the wrong token', () => {
    const { client, calls } = makeClient(TOKEN);
    const ok = client.receive(
      { data: { t: 'canvas/ops', records: [], artifactVersion: 2, viewToken: 'guessed' }, source: { name: 'page' } },
      { name: 'self' }, { name: 'parent' },
    );
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(client.droppedCount).toBe(1);
  });

  it('still accepts an untokened message from the host window (older host)', () => {
    const { client, calls } = makeClient(TOKEN);
    expect(client.receive({ data: { t: 'canvas/caps', caps: [] }, source: null }, { name: 'self' })).toBe(true);
    expect(calls).toContain('caps');
  });

  it('rejects an untokened message from an unexpected source', () => {
    const { client, calls } = makeClient(TOKEN);
    const ok = client.receive(
      { data: { t: 'canvas/caps', caps: [] }, source: { name: 'page' } },
      { name: 'self' }, { name: 'parent' },
    );
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
