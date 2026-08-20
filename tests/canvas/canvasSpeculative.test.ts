/**
 * SpeculativeStream — Plan 22 Phase 5 Tier 2, "streaming produces OPS, not
 * documents".
 *
 * The properties under test are the ones that make speculative rendering safe
 * to put on a token stream:
 *
 *  - it compiles at most once per throttle window, and never past the source cap;
 *  - a growing page produces INCREMENTAL ops, not a full replace every tick —
 *    which is only true because each partial is reconciled against the previous
 *    one, so ids survive;
 *  - "sealed" tracks top-level structure, so the "writing" treatment lifts when
 *    the layout stops moving rather than when the text stops arriving;
 *  - `settle()` converges on the authoritative tree, and produces NOTHING when
 *    the write path reconciled against the speculative doc (the "nothing
 *    jumps" clause);
 *  - it never throws, whatever arrives.
 */
import { describe, it, expect } from 'vitest';
import {
  SpeculativeStream,
  structurallyStable,
  SPECULATIVE_MAX_SOURCE,
} from '../../src/canvas/CanvasLiveness';
import type { SpeculativePatch } from '../../src/canvas/CanvasLiveness';
import { compile } from '../../src/canvas/doc/PageCompiler';
import { reconcile } from '../../src/canvas/doc/Reconciler';
import { collectMids, walk, type DocNode } from '../../src/canvas/doc/DocNode';
import type { CanvasOp } from '../../src/canvas/CanvasOps';

/** Deterministic mids so a diff is reproducible run to run. */
function seededRand(seed = 7): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

class Clock {
  t = 0;
  now = (): number => this.t;
  advance(ms: number): void { this.t += ms; }
}

const HEAD = 'function Page() {\n  return (\n    <UI.Screen>\n      <UI.Heading text="Sign in" />';
const CARD = '\n      <UI.Card>\n        <UI.Text text="Email" />\n      </UI.Card>';
const SECOND = '\n      <UI.Card>\n        <UI.Text text="Password" />\n      </UI.Card>';
const TAIL = '\n    </UI.Screen>\n  );\n}';

function makeStream(clock: Clock, opts: { throttleMs?: number; onPatch?: (p: SpeculativePatch) => void } = {}) {
  return new SpeculativeStream({
    pageId: 'p1',
    now: clock.now,
    throttleMs: opts.throttleMs ?? 150,
    rand: seededRand(),
    ...(opts.onPatch ? { onPatch: opts.onPatch } : {}),
  });
}

describe('SpeculativeStream — throttling and caps', () => {
  it('compiles at most once per throttle window', () => {
    const clock = new Clock();
    const stream = makeStream(clock);

    // First feed is at t=0 with `_lastAt = -Infinity`, so it compiles.
    expect(stream.feed(HEAD + TAIL)).not.toBeNull();
    expect(stream.compileCount).toBe(1);

    clock.advance(50);
    expect(stream.feed('')).toBeNull();
    clock.advance(50);
    expect(stream.feed('')).toBeNull();
    expect(stream.compileCount).toBe(1);

    clock.advance(60);              // 160ms since the last compile
    stream.feed('');
    expect(stream.compileCount).toBe(2);
  });

  it('stops compiling past the source cap instead of parsing a paste-bomb', () => {
    const clock = new Clock();
    const stream = makeStream(clock);
    stream.feed(HEAD + TAIL);
    const before = stream.compileCount;

    clock.advance(1000);
    expect(stream.feed('x'.repeat(SPECULATIVE_MAX_SOURCE + 1))).toBeNull();

    expect(stream.overflowed).toBe(true);
    expect(stream.compileCount).toBe(before);
    // And it stays off, however long you wait.
    clock.advance(10_000);
    expect(stream.feed('')).toBeNull();
    expect(stream.flush()).toBeNull();
  });

  it('flush() ignores the throttle so the last patch is the whole page', () => {
    const clock = new Clock();
    const stream = makeStream(clock);
    stream.feed(HEAD);                       // first compile
    clock.advance(10);
    expect(stream.feed(CARD)).toBeNull();    // inside the throttle window

    const patch = stream.flush();            // the directive closed

    expect(patch).not.toBeNull();
    expect(patch?.sealed).toBe(true);
    expect(patch!.ops.length).toBeGreaterThan(0);
  });

  it('an unparseable prefix costs one tick, not the run', () => {
    const clock = new Clock();
    const stream = makeStream(clock);
    expect(stream.feed('function Page() { return (<UI.Screen')).toBeNull();
    expect(stream.doc).toBeNull();

    clock.advance(200);
    const patch = stream.feed(TAIL.replace('</UI.Screen>', '></UI.Screen>'));
    expect(patch).not.toBeNull();
  });

  it('never throws, whatever the compiler does', () => {
    const clock = new Clock();
    const stream = new SpeculativeStream({
      pageId: 'p1',
      now: clock.now,
      compile: () => { throw new Error('parser exploded'); },
    });
    expect(() => stream.feed('anything')).not.toThrow();
    expect(stream.feed('anything')).toBeNull();
  });

  it('a throwing patch sink cannot break the stream', () => {
    const clock = new Clock();
    const stream = makeStream(clock, { onPatch: () => { throw new Error('panel gone'); } });
    expect(() => stream.feed(HEAD + TAIL)).not.toThrow();
    expect(stream.doc).not.toBeNull();
  });
});

describe('SpeculativeStream — ops, not documents', () => {
  it('the first patch seeds the artboard, later patches are INCREMENTAL', () => {
    const clock = new Clock();
    const patches: SpeculativePatch[] = [];
    const stream = makeStream(clock, { onPatch: p => patches.push(p) });

    stream.feed(HEAD);                                // syntactically-complete prefix
    expect(patches).toHaveLength(1);
    expect(patches[0].ops).toHaveLength(1);
    expect(patches[0].ops[0].op).toBe('page.setDoc');

    clock.advance(200);
    stream.feed(CARD);                                // one more section arrived

    expect(patches).toHaveLength(2);
    expect(patches[1].ops.map(o => o.op)).not.toContain('page.setDoc');
    // A repaint of the whole artboard would be one op; a delta is element ops.
    expect(patches[1].ops.every(o => o.op.startsWith('el.'))).toBe(true);
  });

  it('a page that grows by one card produces an insert, not a whole-page replace', () => {
    const clock = new Clock();
    const stream = new SpeculativeStream({ pageId: 'p1', now: clock.now, throttleMs: 0, rand: seededRand() });

    stream.feed(HEAD);                                // prefix repair closes the open tags
    const rootMid = (stream.doc as DocNode).mid;
    clock.advance(10);
    const next = stream.feed(CARD);

    expect(next).not.toBeNull();
    const kinds = next!.ops.map(o => o.op);
    expect(kinds).not.toContain('page.setDoc');
    expect(kinds).toContain('el.insert');
    // The insert lands under the artboard root, which is what makes it a
    // top-level structural change and therefore keeps the page unsealed.
    expect(next!.ops.some(o => o.op === 'el.insert' && o.parentMid === rootMid)).toBe(true);
    expect(stream.sealed).toBe(false);
  });

  it('carries mids across partials — the whole reason a diff is small', () => {
    const clock = new Clock();
    const stream = new SpeculativeStream({ pageId: 'p1', now: clock.now, throttleMs: 0, rand: seededRand() });

    stream.feed(HEAD);
    const firstMids = collectMids(stream.doc as DocNode);
    clock.advance(10);
    stream.feed(CARD);
    const secondMids = collectMids(stream.doc as DocNode);

    // Every id from the first partial survives into the second.
    for (const mid of firstMids) { expect(secondMids.has(mid)).toBe(true); }
    expect(secondMids.size).toBeGreaterThan(firstMids.size);
  });

  it('monotonic seq, so the client can drop an out-of-order patch', () => {
    const clock = new Clock();
    const patches: SpeculativePatch[] = [];
    const stream = new SpeculativeStream({
      pageId: 'p1', now: clock.now, throttleMs: 0, rand: seededRand(), onPatch: p => patches.push(p),
    });
    stream.feed(HEAD);
    clock.advance(10);
    stream.feed(CARD);
    clock.advance(10);
    stream.feed(SECOND);

    expect(patches.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < patches.length; i++) {
      expect(patches[i].seq).toBeGreaterThan(patches[i - 1].seq);
      expect(patches[i].pageId).toBe('p1');
    }
  });

  it('every patch is a valid, page-scoped op batch', () => {
    const clock = new Clock();
    const patches: SpeculativePatch[] = [];
    const stream = new SpeculativeStream({
      pageId: 'p1', now: clock.now, throttleMs: 0, rand: seededRand(), onPatch: p => patches.push(p),
    });
    stream.feed(HEAD);
    clock.advance(10);
    stream.feed(CARD);
    clock.advance(10);
    stream.feed(SECOND + TAIL);

    expect(patches.length).toBeGreaterThan(0);
    for (const patch of patches) {
      for (const op of patch.ops) {
        expect(typeof op.op).toBe('string');
        expect((op as { pageId?: string }).pageId).toBe('p1');
      }
    }
  });
});

describe('SpeculativeStream — sealing', () => {
  it('structurallyStable() ignores deep edits and catches root-level ones', () => {
    const deep: CanvasOp[] = [
      { op: 'el.setText', pageId: 'p1', mid: 'aaaaaaaaaa', text: 'hi' },
      { op: 'el.insert', pageId: 'p1', parentMid: 'bbbbbbbbbb', before: 'end', node: { tag: 'div' } },
    ];
    expect(structurallyStable(deep, 'rootrootrr')).toBe(true);

    expect(structurallyStable(
      [{ op: 'el.insert', pageId: 'p1', parentMid: 'rootrootrr', before: 'end', node: { tag: 'div' } }],
      'rootrootrr',
    )).toBe(false);

    expect(structurallyStable(
      [{ op: 'page.setDoc', pageId: 'p1', doc: { mid: 'rootrootrr', tag: 'div' } }],
      'rootrootrr',
    )).toBe(false);

    expect(structurallyStable(
      [{ op: 'el.remove', pageId: 'p1', mid: 'rootrootrr' }],
      'rootrootrr',
    )).toBe(false);
  });

  it('stays unsealed while top-level sections keep arriving', () => {
    const clock = new Clock();
    const stream = new SpeculativeStream({ pageId: 'p1', now: clock.now, throttleMs: 0, rand: seededRand() });
    stream.feed(HEAD);
    clock.advance(10);
    stream.feed(CARD);
    expect(stream.sealed).toBe(false);
  });

  it('seals once the tree stops moving', () => {
    const clock = new Clock();
    const stream = new SpeculativeStream({ pageId: 'p1', now: clock.now, throttleMs: 0, rand: seededRand() });
    stream.feed(HEAD + CARD + TAIL);
    for (let i = 0; i < 3; i++) { clock.advance(10); stream.feed('\n'); }
    expect(stream.sealed).toBe(true);
  });

  it('flush() always seals', () => {
    const clock = new Clock();
    const stream = new SpeculativeStream({ pageId: 'p1', now: clock.now, throttleMs: 0, rand: seededRand() });
    stream.feed(HEAD);
    clock.advance(10);
    stream.feed(CARD);
    expect(stream.sealed).toBe(false);
    stream.flush();
    expect(stream.sealed).toBe(true);
  });
});

describe('SpeculativeStream — settle(): nothing jumps', () => {
  const source = HEAD + CARD + SECOND + TAIL;

  it('produces ZERO ops when the write path reconciled against the speculative doc', () => {
    const clock = new Clock();
    const stream = new SpeculativeStream({ pageId: 'p1', now: clock.now, throttleMs: 0, rand: seededRand() });
    stream.feed(source);
    const speculative = stream.doc as DocNode;

    // What the authoritative write path does when it uses `speculativeDocFor`:
    // compile the final source, then reconcile it against the speculative tree
    // so matched nodes inherit the ids already on screen.
    const authoritative = reconcile(speculative, compileOk(source)).doc;

    const patch = stream.settle(authoritative);

    expect(patch.sealed).toBe(true);
    expect(patch.ops).toEqual([]);
  });

  it('still converges when the write path did NOT use the speculative base', () => {
    const clock = new Clock();
    const stream = new SpeculativeStream({ pageId: 'p1', now: clock.now, throttleMs: 0, rand: seededRand() });
    stream.feed(source);

    // Fresh mids everywhere: the committed tree has no relationship to the ids
    // on screen. Convergence is still guaranteed; it just costs a replace.
    const authoritative = compileOk(source, seededRand(99));
    const patch = stream.settle(authoritative);

    expect(patch.ops.length).toBeGreaterThan(0);
    expect(stream.doc).toBe(authoritative);
    // The frame ends on the AUTHORITATIVE ids, which is the invariant that
    // matters: a later `el.setText` addresses a node the frame actually has.
    const midsAfter = collectMids(stream.doc as DocNode);
    for (const node of walk(authoritative)) { expect(midsAfter.has(node.mid)).toBe(true); }
  });

  it('settles straight to the authoritative doc when nothing ever compiled', () => {
    const clock = new Clock();
    const stream = new SpeculativeStream({ pageId: 'p1', now: clock.now, throttleMs: 0 });
    const authoritative = compileOk(source);

    const patch = stream.settle(authoritative);

    expect(patch.ops).toHaveLength(1);
    expect(patch.ops[0]).toMatchObject({ op: 'page.setDoc', pageId: 'p1' });
    expect(patch.sealed).toBe(true);
  });
});

function compileOk(source: string, rand?: () => number): DocNode {
  const r = compile(source, rand ? { rand } : {});
  if (!r.ok) { throw new Error(`compile failed: ${r.error}`); }
  return r.doc;
}
