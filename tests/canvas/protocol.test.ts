/**
 * Canvas wire protocol tests (Plan 20 §3.4) — the contract that makes an
 * orphaned handler or a handler-less button a compile error.
 *
 * Two kinds of coverage here:
 *   1. **Exhaustiveness.** `tsc` only checks `src/**`, so the compile-time half
 *      of the guard lives in `protocol.ts` itself (the `Record<Tag, true>` tag
 *      tables reject both a union variant with no tag and a tag with no
 *      variant — verified both ways) and in each `src/` consumer's own switch.
 *      This file closes the loop at runtime: `SAMPLE_*` is keyed by tag and
 *      compared against the exported arrays, and `describe*` dispatches every
 *      sample through a switch whose `default` throws — so a variant that gains
 *      a tag but no handler fails here.
 *   2. **Adversarial.** The view token is the only thing standing between a
 *      sandboxed, model-authored page and a forged human op, so the token path
 *      is tested for prototype-key tags, wrong/short/empty tokens, and an
 *      unminted (empty) expected token.
 */
import { describe, it, expect } from 'vitest';
import { ArtifactStore } from '../../src/managers/ArtifactStore';
import {
  CANVAS_CLIENT_MESSAGE_TAGS,
  CANVAS_HOST_MESSAGE_TAGS,
  acceptCanvasClientMessage,
  assertNeverCanvasMessage,
  isCanvasClientMessage,
  isCanvasClientMessageTag,
  isCanvasHostMessage,
  isCanvasHostMessageTag,
  mintViewToken,
  toWireArtifact,
  viewTokensMatch,
} from '../../src/canvas/protocol';
import type {
  CanvasClientMessage,
  CanvasClientMessageTag,
  CanvasHostMessage,
  CanvasHostMessageTag,
  WireArtifact,
} from '../../src/canvas/protocol';
import type { CanvasArtifact } from '../../src/types';

const TOKEN = 'aaaaaaaabbbbbbbbccccccccdddddddd';

// ============================================================================
// Fixtures — TS-enforced complete over both unions
// ============================================================================

const WIRE_STUB: WireArtifact = {
  id: 'a1', version: 3, kind: 'screens', name: 'Design',
  format: { formatId: 'desktop', kind: 'screen', width: 1440, height: 900 },
  theme: {} as WireArtifact['theme'],
  pages: [], assets: [], updatedAt: 0, approvalMode: 'staged',
};

const SAMPLE_HOST: Record<CanvasHostMessageTag, CanvasHostMessage> = {
  'canvas/hello': { t: 'canvas/hello', artifactId: 'a1', artifact: WIRE_STUB, viewToken: TOKEN, caps: [] },
  'canvas/caps': { t: 'canvas/caps', caps: [] },
  'canvas/ops': { t: 'canvas/ops', records: [], artifactVersion: 3 },
  'canvas/staged': { t: 'canvas/staged', records: [] },
  'canvas/receipt': { t: 'canvas/receipt', receipt: { opId: 'o1', status: 'applied', artifactVersion: 3 } },
  'canvas/job': { t: 'canvas/job', event: { jobId: 'j1', type: 'started' } },
  'canvas/agentCursor': { t: 'canvas/agentCursor', pageId: 'p1', label: 'mysti' },
  'canvas/history': {
    t: 'canvas/history',
    status: { canUndo: true, canRedo: false, position: 2, transactions: [], versions: [] },
  },
  'canvas/resync': { t: 'canvas/resync', artifact: WIRE_STUB, artifactVersion: 3 },
  'canvas/artifacts': { t: 'canvas/artifacts', summaries: [] },
};

const SAMPLE_CLIENT: Record<CanvasClientMessageTag, CanvasClientMessage> = {
  'canvas/ready': { t: 'canvas/ready', viewToken: TOKEN },
  'canvas/submit': { t: 'canvas/submit', txnId: 'tx1', ops: [], baseVersions: {}, viewToken: TOKEN },
  'canvas/selection': { t: 'canvas/selection', pageId: 'p1', mids: [], viewToken: TOKEN },
  'canvas/editing': { t: 'canvas/editing', pageId: 'p1', mids: [], editing: true, viewToken: TOKEN },
  'canvas/decide': { t: 'canvas/decide', opIds: ['o1'], accept: true, viewToken: TOKEN },
  'canvas/undo': { t: 'canvas/undo', viewToken: TOKEN },
  'canvas/redo': { t: 'canvas/redo', viewToken: TOKEN },
  'canvas/checkpoint': { t: 'canvas/checkpoint', label: 'v1', viewToken: TOKEN },
  'canvas/restore': { t: 'canvas/restore', ref: 'sha', viewToken: TOKEN },
  'canvas/comment': { t: 'canvas/comment', pageId: 'p1', text: 'lighter', viewToken: TOKEN },
  'canvas/cancelJob': { t: 'canvas/cancelJob', jobId: 'j1', viewToken: TOKEN },
  'canvas/diag': { t: 'canvas/diag', pages: 2, layoutMode: 'wide', liveFrames: 1, viewToken: TOKEN },
  'canvas/frameError': { t: 'canvas/frameError', pageId: 'p1', message: 'boom', viewToken: TOKEN },
  'canvas/addScaffold': { t: 'canvas/addScaffold', scaffold: 'login', viewToken: TOKEN },
  'canvas/export': { t: 'canvas/export', viewToken: TOKEN },
  'canvas/present': { t: 'canvas/present', viewToken: TOKEN },
  'canvas/newArtifact': { t: 'canvas/newArtifact', viewToken: TOKEN },
  'canvas/openArtifact': { t: 'canvas/openArtifact', artifactId: 'a2', viewToken: TOKEN },
  'canvas/renameArtifact': { t: 'canvas/renameArtifact', artifactId: 'a2', name: 'Nope', viewToken: TOKEN },
};

/** Stand-in for the webview's dispatcher: exhaustive or it does not compile. */
function describeHost(msg: CanvasHostMessage): string {
  switch (msg.t) {
    case 'canvas/hello': return `hello:${msg.artifactId}`;
    case 'canvas/caps': return `caps:${msg.caps.length}`;
    case 'canvas/ops': return `ops:${msg.artifactVersion}`;
    case 'canvas/staged': return `staged:${msg.records.length}`;
    case 'canvas/receipt': return `receipt:${msg.receipt.opId}`;
    case 'canvas/job': return `job:${msg.event.jobId}`;
    case 'canvas/agentCursor': return `cursor:${msg.pageId}`;
    case 'canvas/history': return `history:${msg.status.position}`;
    case 'canvas/resync': return `resync:${msg.artifactVersion}`;
    case 'canvas/artifacts': return `artifacts:${msg.summaries.length}`;
    default: return assertNeverCanvasMessage(msg);
  }
}

/** Stand-in for `_handleCanvasMessage`: exhaustive or it does not compile. */
function describeClient(msg: CanvasClientMessage): string {
  switch (msg.t) {
    case 'canvas/ready': return 'ready';
    case 'canvas/submit': return `submit:${msg.txnId}`;
    case 'canvas/selection': return `selection:${msg.pageId}`;
    case 'canvas/editing': return `editing:${msg.editing}`;
    case 'canvas/decide': return `decide:${msg.accept}`;
    case 'canvas/undo': return 'undo';
    case 'canvas/redo': return 'redo';
    case 'canvas/checkpoint': return `checkpoint:${msg.label}`;
    case 'canvas/restore': return `restore:${msg.ref}`;
    case 'canvas/comment': return `comment:${msg.text}`;
    case 'canvas/cancelJob': return `cancel:${msg.jobId}`;
    case 'canvas/diag': return `diag:${msg.pages}`;
    case 'canvas/frameError': return `frameError:${msg.message}`;
    case 'canvas/addScaffold': return `scaffold:${msg.scaffold}`;
    case 'canvas/export': return 'export';
    case 'canvas/present': return 'present';
    case 'canvas/newArtifact': return 'newArtifact';
    case 'canvas/openArtifact': return `open:${msg.artifactId}`;
    case 'canvas/renameArtifact': return `rename:${msg.name}`;
    default: return assertNeverCanvasMessage(msg);
  }
}

// ============================================================================

describe('canvas protocol — tag tables', () => {
  it('exports exactly the tags the host union declares', () => {
    expect([...CANVAS_HOST_MESSAGE_TAGS].sort()).toEqual(Object.keys(SAMPLE_HOST).sort());
  });

  it('exports exactly the tags the client union declares', () => {
    expect([...CANVAS_CLIENT_MESSAGE_TAGS].sort()).toEqual(Object.keys(SAMPLE_CLIENT).sort());
  });

  it('has no duplicate tags and no overlap between directions', () => {
    const host = new Set(CANVAS_HOST_MESSAGE_TAGS);
    const client = new Set(CANVAS_CLIENT_MESSAGE_TAGS);
    expect(host.size).toBe(CANVAS_HOST_MESSAGE_TAGS.length);
    expect(client.size).toBe(CANVAS_CLIENT_MESSAGE_TAGS.length);
    for (const tag of client) { expect(host.has(tag as never)).toBe(false); }
  });

  it('namespaces every tag under canvas/ so it cannot collide with WebviewMessage', () => {
    for (const tag of [...CANVAS_HOST_MESSAGE_TAGS, ...CANVAS_CLIENT_MESSAGE_TAGS]) {
      expect(tag.startsWith('canvas/')).toBe(true);
    }
  });

  it('does NOT carry the CanvasManager messages Phase 0 deletes', () => {
    // canvasSave/canvasPrompt/canvasReimagine/canvasGenerateDraft/
    // canvasUnifiedPrompt belong to the freeform session layer being removed.
    // A salvaged capability comes back as a tool, never as a transport.
    for (const legacy of ['canvasSave', 'canvasPrompt', 'canvasReimagine', 'canvasGenerateDraft', 'canvasUnifiedPrompt', 'canvasLoad']) {
      expect(isCanvasClientMessageTag(legacy)).toBe(false);
      expect(isCanvasHostMessageTag(legacy)).toBe(false);
    }
  });

  it('gives the previously handler-less Present button a typed home', () => {
    expect(isCanvasClientMessageTag('canvas/present')).toBe(true);
  });
});

describe('canvas protocol — exhaustive dispatch', () => {
  it('handles every host message variant', () => {
    const seen = CANVAS_HOST_MESSAGE_TAGS.map(tag => describeHost(SAMPLE_HOST[tag]));
    expect(seen).toHaveLength(CANVAS_HOST_MESSAGE_TAGS.length);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('handles every client message variant', () => {
    const seen = CANVAS_CLIENT_MESSAGE_TAGS.map(tag => describeClient(SAMPLE_CLIENT[tag]));
    expect(seen).toHaveLength(CANVAS_CLIENT_MESSAGE_TAGS.length);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('assertNeverCanvasMessage throws a [Mysti]-tagged error naming the tag', () => {
    const rogue = { t: 'canvas/fromTheFuture' } as unknown as never;
    expect(() => assertNeverCanvasMessage(rogue)).toThrow(/\[Mysti\].*canvas\/fromTheFuture/);
  });

  it('assertNeverCanvasMessage survives a non-object', () => {
    expect(() => assertNeverCanvasMessage('nope' as unknown as never)).toThrow(/\[Mysti\]/);
  });
});

describe('canvas protocol — guards', () => {
  it('accepts known tags and rejects unknown ones', () => {
    expect(isCanvasHostMessage(SAMPLE_HOST['canvas/hello'])).toBe(true);
    expect(isCanvasClientMessage(SAMPLE_CLIENT['canvas/ready'])).toBe(true);
    expect(isCanvasHostMessage({ t: 'canvasReady' })).toBe(false);
    expect(isCanvasClientMessage({ t: 'canvas/nope', viewToken: TOKEN })).toBe(false);
  });

  it('rejects non-objects and tagless payloads', () => {
    for (const bad of [null, undefined, 'canvas/ready', 42, [], {}, { t: 7 }]) {
      expect(isCanvasHostMessage(bad)).toBe(false);
      expect(isCanvasClientMessage(bad)).toBe(false);
    }
  });

  it('does not treat Object.prototype keys as valid tags', () => {
    // A naive `TAGS[tag]` lookup would let `constructor`/`toString` through.
    for (const proto of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
      expect(isCanvasClientMessageTag(proto)).toBe(false);
      expect(isCanvasHostMessageTag(proto)).toBe(false);
      expect(acceptCanvasClientMessage({ t: proto, viewToken: TOKEN }, TOKEN)).toBeNull();
    }
  });

  it('requires a string viewToken on a client message', () => {
    expect(isCanvasClientMessage({ t: 'canvas/ready' })).toBe(false);
    expect(isCanvasClientMessage({ t: 'canvas/ready', viewToken: 123 })).toBe(false);
  });
});

describe('canvas protocol — view token', () => {
  it('mints 128 bits of hex, distinct per call', () => {
    const a = mintViewToken();
    const b = mintViewToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it('throws rather than falling back to a guessable source', () => {
    const g = globalThis as { crypto?: unknown };
    const saved = g.crypto;
    try {
      delete g.crypto;
      expect(() => mintViewToken()).toThrow(/\[Mysti\].*getRandomValues/);
    } finally {
      if (saved === undefined) { delete g.crypto; } else { g.crypto = saved; }
    }
  });

  it('matches only identical non-empty tokens', () => {
    expect(viewTokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(viewTokensMatch(TOKEN, TOKEN.replace(/d$/, 'e'))).toBe(false);
    expect(viewTokensMatch(TOKEN, TOKEN.slice(0, -1))).toBe(false);
    expect(viewTokensMatch('', '')).toBe(false);
    expect(viewTokensMatch(TOKEN, '')).toBe(false);
    expect(viewTokensMatch(undefined as unknown as string, TOKEN)).toBe(false);
  });
});

describe('canvas protocol — acceptCanvasClientMessage', () => {
  it('narrows a well-formed, authenticated message', () => {
    const accepted = acceptCanvasClientMessage(
      { t: 'canvas/addScaffold', scaffold: 'login', viewToken: TOKEN },
      TOKEN,
    );
    expect(accepted).not.toBeNull();
    expect(describeClient(accepted!)).toBe('scaffold:login');
  });

  it('rejects a forged token — the sandboxed-page attack', () => {
    const forged = { t: 'canvas/submit', txnId: 'tx', ops: [], baseVersions: {}, viewToken: 'f'.repeat(32) };
    expect(acceptCanvasClientMessage(forged, TOKEN)).toBeNull();
  });

  it('rejects a missing or non-string token', () => {
    expect(acceptCanvasClientMessage({ t: 'canvas/undo' }, TOKEN)).toBeNull();
    expect(acceptCanvasClientMessage({ t: 'canvas/undo', viewToken: null }, TOKEN)).toBeNull();
  });

  it('fails CLOSED when the view has no token yet', () => {
    // An unminted view must reject everything, not accept everything.
    expect(acceptCanvasClientMessage({ t: 'canvas/undo', viewToken: '' }, '')).toBeNull();
    expect(acceptCanvasClientMessage({ t: 'canvas/undo', viewToken: TOKEN }, '')).toBeNull();
  });

  it('rejects a message minted for a different canvas view', () => {
    const other = mintViewToken();
    const mine = mintViewToken();
    expect(acceptCanvasClientMessage({ t: 'canvas/export', viewToken: other }, mine)).toBeNull();
    expect(acceptCanvasClientMessage({ t: 'canvas/export', viewToken: mine }, mine)).not.toBeNull();
  });

  it('rejects a host message replayed back at the host', () => {
    expect(acceptCanvasClientMessage({ ...SAMPLE_HOST['canvas/receipt'], viewToken: TOKEN }, TOKEN)).toBeNull();
  });
});

describe('canvas protocol — toWireArtifact', () => {
  function build(): CanvasArtifact {
    const store = new ArtifactStore({ getRoot: () => null }); // pure in-memory, no FS
    const artifact = store.createArtifact({ name: 'Checkout' });
    store.insertPage(artifact, store.makePage({ mode: 'jsx', jsxSource: 'function Page(){}', actionTitle: 'Login' }));
    artifact.opLog.push({
      opId: 'o1', runId: 'r1', kind: 'insert_page', proposedValue: { jsxSource: 'x'.repeat(30_000) },
      status: 'applied', author: 'agent', ts: 1,
    });
    artifact.stitchProjectId = 'stitch-secret';
    return artifact;
  }

  it('carries the fields the board renders', () => {
    const artifact = build();
    const wire = toWireArtifact(artifact, { approvalMode: 'auto' });
    expect(wire.id).toBe(artifact.id);
    expect(wire.version).toBe(artifact.version);
    expect(wire.name).toBe('Checkout');
    expect(wire.kind).toBe(artifact.kind);
    expect(wire.pages).toHaveLength(1);
    expect(wire.pages[0].actionTitle).toBe('Login');
    expect(wire.format).toEqual(artifact.format);
    expect(wire.theme).toBe(artifact.theme);
    expect(wire.assets).toBe(artifact.assets);
    expect(wire.updatedAt).toBe(artifact.updatedAt);
  });

  it('drops the op log and host-only provenance', () => {
    const wire = toWireArtifact(build(), { approvalMode: 'auto' });
    expect(Object.keys(wire).sort()).toEqual([
      'approvalMode', 'assets', 'format', 'id', 'kind', 'name', 'pages', 'theme', 'updatedAt', 'version',
    ]);
    expect(JSON.stringify(wire)).not.toContain('stitch-secret');
    expect(JSON.stringify(wire)).not.toContain('o1');
  });

  it('stamps the resolved approval mode so chrome and prompt cannot disagree', () => {
    const artifact = build();
    expect(toWireArtifact(artifact, { approvalMode: 'staged' }).approvalMode).toBe('staged');
    expect(toWireArtifact(artifact, { approvalMode: 'auto' }).approvalMode).toBe('auto');
  });
});
