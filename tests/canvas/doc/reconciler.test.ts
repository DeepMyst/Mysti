/**
 * Reconciler tests (Plan 22 §3.1 "Mid stability — three tiers").
 *
 * The property under test is not "the diff is pretty" — it is that IDENTITY is
 * decided safely, because selection, pins, comments and element undo are all
 * anchored to mids. So the suite is weighted toward the failure paths:
 *
 *  - a mid from a model is a HINT: forged, unknown, tag-incompatible and
 *    duplicated claims must be DISCARDED, never retargeted onto a live node;
 *  - **a pin may never ride a weak match** (Plan 22 §7 risk 2) — the single
 *    non-negotiable rule, because a mis-inherited pin is invisible to the human
 *    it lies to;
 *  - every mid in the output is unique, whatever the input does;
 *  - a genuine restructure LOSES ids and says so, rather than guessing.
 */
import { describe, it, expect } from 'vitest';
import {
  reconcile, dice, similarity, PIN_CARRYING_TIERS, SIMILARITY_THRESHOLD,
  type ReconcileResult,
} from '../../../src/canvas/doc/Reconciler';
import { isMid, walk, type DocNode, type DocNodeInput, type Mid } from '../../../src/canvas/doc/DocNode';

/* ------------------------------- helpers ------------------------------- */

/** A readable, valid 10-char base32 mid. */
function mid(name: string): Mid {
  const m = (name + 'aaaaaaaaaa').slice(0, 10);
  if (!isMid(m)) { throw new Error(`bad test mid: ${name}`); }
  return m;
}

function pinned(...cells: string[]): DocNode['pins'] {
  const out: NonNullable<DocNode['pins']> = {};
  for (const c of cells) { out[c] = { at: 1700000000000, opId: `op-${c}` }; }
  return out;
}

/** Every mid in a tree, in walk order. */
function mids(root: DocNode): Mid[] {
  return [...walk(root)].map(n => n.mid);
}

function find(root: DocNode, pred: (n: DocNode) => boolean): DocNode | undefined {
  for (const n of walk(root)) { if (pred(n)) { return n; } }
  return undefined;
}

/** Invariants that must hold for EVERY reconcile, whatever the input. */
function assertInvariants(r: ReconcileResult): void {
  const seen = new Set<Mid>();
  for (const n of walk(r.doc)) {
    expect(isMid(n.mid), `mid ${n.mid} is not a well-formed mid`).toBe(true);
    expect(seen.has(n.mid), `duplicate mid ${n.mid} in output`).toBe(false);
    seen.add(n.mid);
    expect(r.tiers[n.mid], `no tier recorded for ${n.mid}`).toBeDefined();
  }
  expect(Object.keys(r.tiers).length).toBe(seen.size);
  // `carried` counts exactly the nodes that did not mint.
  const minted = [...seen].filter(m => r.tiers[m] === 'minted').length;
  expect(r.carried).toBe(seen.size - minted);
  // Every minted node is reachable from `newMids`.
  expect(new Set(Object.values(r.newMids)).size).toBe(Object.keys(r.newMids).length);
}

/* --------------------------------- dice -------------------------------- */

describe('dice', () => {
  it('is 1 for identical strings and 0 for disjoint ones', () => {
    expect(dice('Sign in', 'Sign in')).toBe(1);
    expect(dice('abcdef', 'wxyzuv')).toBe(0);
  });

  it('treats two empty strings as identical (two containers are alike)', () => {
    expect(dice('', '')).toBe(1);
  });

  it('is 0 when only one side has text', () => {
    expect(dice('Sign in', '')).toBe(0);
    expect(dice('', 'Sign in')).toBe(0);
  });

  it('handles single characters without dividing by zero', () => {
    expect(dice('a', 'a')).toBe(1);
    expect(dice('a', 'b')).toBe(0);
    expect(Number.isNaN(dice('a', 'bc'))).toBe(false);
  });

  it('ignores case and collapses whitespace', () => {
    expect(dice('Sign In', '  sign   in ')).toBe(1);
  });

  it('scores partial overlap between 0 and 1', () => {
    const s = dice('Sign in', 'Sign up');
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });

  it('is symmetric', () => {
    expect(dice('Dashboard', 'Dashboards')).toBeCloseTo(dice('Dashboards', 'Dashboard'), 12);
  });
});

/* ------------------------------ similarity ----------------------------- */

describe('similarity', () => {
  it('cannot clear the threshold across a tag boundary', () => {
    // 0.3 (identical text) + 0.2 (identical props) = 0.5 — deliberately under 0.55.
    const s = similarity(
      { tag: 'section', text: 'Hello', props: { a: 1 } },
      { tag: 'h1', text: 'Hello', props: { a: 1 } },
    );
    expect(s).toBeCloseTo(0.5, 10);
    expect(s).toBeLessThan(SIMILARITY_THRESHOLD);
  });

  it('scores a same-tag identical node at 1', () => {
    expect(similarity({ tag: 'p', text: 'x' }, { tag: 'p', text: 'x' })).toBeCloseTo(1, 10);
  });

  it('clears the threshold for a same-tag node whose text changed entirely', () => {
    expect(similarity({ tag: 'p', text: 'Alpha' }, { tag: 'p', text: 'Zulu' })).toBeGreaterThan(SIMILARITY_THRESHOLD);
  });

  it('falls to exactly 0.5 when tag matches but nothing else does', () => {
    const s = similarity({ tag: 'p', text: 'Alpha', props: { a: 1 } }, { tag: 'p', text: 'Zulu', props: { b: 2 } });
    expect(s).toBeCloseTo(0.5, 10);
    expect(s).toBeLessThan(SIMILARITY_THRESHOLD);
  });

  it('compares prop values structurally, not by reference', () => {
    const a = similarity({ tag: 'p', props: { items: [{ label: 'Home' }] } }, { tag: 'p', props: { items: [{ label: 'Home' }] } });
    expect(a).toBeCloseTo(1, 10);
  });
});

/* ------------------------------ tier 1 echo ---------------------------- */

describe('reconcile — tier 1 (echoed)', () => {
  const prev: DocNode = {
    mid: mid('root'), tag: 'div', by: 'user',
    children: [
      { mid: mid('title'), tag: 'h1', text: 'Welcome' },
      { mid: mid('body'), tag: 'div', children: [{ mid: mid('cta'), tag: 'UI.Button', props: { label: 'Go' } }] },
    ],
  };

  it('keeps every echoed id through a content rewrite', () => {
    const next: DocNodeInput = {
      mid: mid('root'), tag: 'div',
      children: [
        { mid: mid('title'), tag: 'h1', text: 'Welcome back' },
        { mid: mid('body'), tag: 'div', children: [{ mid: mid('cta'), tag: 'UI.Button', props: { label: 'Continue' } }] },
      ],
    };
    const r = reconcile(prev, next);
    assertInvariants(r);
    expect(mids(r.doc)).toEqual([mid('root'), mid('title'), mid('body'), mid('cta')]);
    expect(r.carried).toBe(4);
    expect(r.newMids).toEqual({});
    expect(r.lost).toEqual([]);
    expect(r.droppedPins).toEqual([]);
    expect(r.tiers[mid('title')]).toBe('echoed');
    expect(r.tiers[mid('root')]).toBe('echoed');
    expect(find(r.doc, n => n.mid === mid('title'))?.text).toBe('Welcome back');
  });

  it('is an identity when the doc is fed back to itself', () => {
    const r = reconcile(prev, prev);
    assertInvariants(r);
    expect(mids(r.doc)).toEqual(mids(prev));
    expect(r.carried).toBe(mids(prev).length);
    expect(r.newMids).toEqual({});
    expect(r.lost).toEqual([]);
  });

  it('moves identity with a node that changed parent', () => {
    const next: DocNodeInput = {
      mid: mid('root'), tag: 'div',
      children: [
        { mid: mid('body'), tag: 'div', children: [{ mid: mid('title'), tag: 'h1', text: 'Welcome' }] },
        { mid: mid('cta'), tag: 'UI.Button', props: { label: 'Go' } },
      ],
    };
    const r = reconcile(prev, next);
    assertInvariants(r);
    expect(new Set(mids(r.doc))).toEqual(new Set([mid('root'), mid('body'), mid('title'), mid('cta')]));
    expect(r.lost).toEqual([]);
    expect(r.tiers[mid('cta')]).toBe('echoed');
  });
});

/* --------------------- tier 1 adversarial: hint, not authority --------- */

describe('reconcile — a claimed mid is a hint, never an authority', () => {
  const prev: DocNode = {
    mid: mid('root'), tag: 'div',
    children: [
      { mid: mid('head'), tag: 'h1', text: 'Title', pins: pinned('style.color', 'text') },
      { mid: mid('note'), tag: 'p', text: 'Body copy' },
    ],
  };

  it('discards an unknown mid and mints instead, keyed by the rejected claim', () => {
    const forged = mid('zzzz');
    const next: DocNodeInput = {
      mid: mid('root'), tag: 'div',
      children: [
        { mid: mid('head'), tag: 'h1', text: 'Title' },
        { mid: forged, tag: 'p', text: 'Body copy' },
      ],
    };
    const r = reconcile(prev, next);
    assertInvariants(r);
    // The forged id never appears in the tree.
    expect(mids(r.doc)).not.toContain(forged);
    // The `p` still reconciles onto its real previous node by identical text.
    expect(mids(r.doc)).toContain(mid('note'));
    expect(r.tiers[mid('note')]).toBe('exact');
    expect(r.newMids).toEqual({});
  });

  it('records a rejected claim under that claim so the writer can remap', () => {
    const forged = mid('zzzz');
    const next: DocNodeInput = {
      mid: mid('root'), tag: 'div',
      children: [{ mid: forged, tag: 'UI.Badge', props: { label: 'New' } }],
    };
    const r = reconcile(prev, next);
    assertInvariants(r);
    expect(Object.keys(r.newMids)).toEqual([forged]);
    const fresh = r.newMids[forged];
    expect(isMid(fresh)).toBe(true);
    expect(fresh).not.toBe(forged);
    expect(r.tiers[fresh]).toBe('minted');
  });

  it('refuses a structurally incompatible claim and never moves that node\'s pins', () => {
    const next: DocNodeInput = {
      mid: mid('root'), tag: 'div',
      // Claims the pinned <h1>'s id while being an <img>.
      children: [{ mid: mid('head'), tag: 'img', props: { src: 'asset://x' } }],
    };
    const r = reconcile(prev, next);
    assertInvariants(r);
    const img = r.doc.children?.[0];
    expect(img?.tag).toBe('img');
    expect(img?.mid).not.toBe(mid('head'));
    expect(img?.pins).toBeUndefined();
    expect(r.lost).toContain(mid('head'));
    expect(r.droppedPins).toContainEqual({
      prevMid: mid('head'), nowMid: null, reason: 'removed', cells: ['style.color', 'text'],
    });
  });

  it('ignores malformed mid strings entirely', () => {
    for (const bogus of ['', '../../etc/passwd', 'ABCDEFGHIJ', '0000000000', 'short', 'waytoolongforamid']) {
      const next: DocNodeInput = {
        mid: mid('root'), tag: 'div',
        children: [{ mid: bogus, tag: 'UI.Badge', props: { label: 'x' } }],
      };
      const r = reconcile(prev, next);
      assertInvariants(r);
      const kid = r.doc.children?.[0];
      expect(kid?.mid).not.toBe(bogus);
      expect(isMid(kid?.mid ?? '')).toBe(true);
      // A malformed claim is not a usable handle, so the receipt keys by path.
      expect(Object.keys(r.newMids)).toEqual(['#/0']);
    }
  });

  it('honours only the first of two nodes claiming the same id', () => {
    const next: DocNodeInput = {
      mid: mid('root'), tag: 'div',
      children: [
        { mid: mid('note'), tag: 'p', text: 'First' },
        { mid: mid('note'), tag: 'p', text: 'Second' },
      ],
    };
    const r = reconcile(prev, next);
    assertInvariants(r);
    const kids = r.doc.children ?? [];
    expect(kids[0].mid).toBe(mid('note'));
    expect(kids[1].mid).not.toBe(mid('note'));
    // The duplicate is keyed by path, not by the claim — the claim IS honoured
    // for the first node, so `note -> fresh` would be an outright lie.
    expect(Object.keys(r.newMids)).toEqual(['#/1']);
  });

  it('refuses a root that claims an inner node\'s id', () => {
    const next: DocNodeInput = {
      // The root claims the <h1>'s pinned id.
      mid: mid('head'), tag: 'div',
      children: [{ mid: mid('note'), tag: 'p', text: 'Body copy' }],
    };
    const r = reconcile(prev, next);
    assertInvariants(r);
    // The artboard root keeps being the artboard root.
    expect(r.doc.mid).toBe(mid('root'));
    expect(r.doc.pins).toBeUndefined();
    expect(r.tiers[mid('root')]).toBe('exact');
    // and the <h1> is genuinely gone, reported, pins dropped.
    expect(r.lost).toContain(mid('head'));
    expect(r.droppedPins.some(d => d.prevMid === mid('head') && d.reason === 'removed')).toBe(true);
  });

  it('keeps output mids unique when the same node object appears twice', () => {
    const shared: DocNodeInput = { tag: 'p', text: 'Body copy' };
    const r = reconcile(prev, { mid: mid('root'), tag: 'div', children: [shared, shared] });
    assertInvariants(r);
    const kids = r.doc.children ?? [];
    expect(kids).toHaveLength(2);
    expect(kids[0].mid).not.toBe(kids[1].mid);
  });

  it('survives a previous tree that carries duplicate mids', () => {
    const dup = mid('dup');
    const broken: DocNode = {
      mid: mid('root'), tag: 'div',
      children: [
        { mid: dup, tag: 'p', text: 'One' },
        { mid: dup, tag: 'p', text: 'Two' },
      ],
    };
    const r = reconcile(broken, {
      mid: mid('root'), tag: 'div',
      children: [{ mid: dup, tag: 'p', text: 'One' }, { mid: dup, tag: 'p', text: 'Two' }],
    });
    assertInvariants(r);
  });
});

/* --------------------------- tier 2 reconciled ------------------------- */

describe('reconcile — tier 2 (keyed / exact)', () => {
  it('keeps ids across reordered keyed siblings', () => {
    const prev: DocNode = {
      mid: mid('root'), tag: 'div',
      children: [
        { mid: mid('ka'), tag: 'UI.Card', props: { key: 'a', title: 'A' } },
        { mid: mid('kb'), tag: 'UI.Card', props: { key: 'b', title: 'B' } },
        { mid: mid('kc'), tag: 'UI.Card', props: { key: 'c', title: 'C' } },
      ],
    };
    const next: DocNodeInput = {
      tag: 'div',
      children: [
        { tag: 'UI.Card', props: { key: 'c', title: 'C' } },
        { tag: 'UI.Card', props: { key: 'a', title: 'A' } },
        { tag: 'UI.Card', props: { key: 'b', title: 'B' } },
      ],
    };
    const r = reconcile(prev, next);
    assertInvariants(r);
    expect((r.doc.children ?? []).map(n => n.mid)).toEqual([mid('kc'), mid('ka'), mid('kb')]);
    expect(r.newMids).toEqual({});
    expect(r.lost).toEqual([]);
    expect(r.tiers[mid('kc')]).toBe('exact');
  });

  it('keeps ids across reordered siblings identified by identical text', () => {
    const prev: DocNode = {
      mid: mid('root'), tag: 'div',
      children: [
        { mid: mid('pa'), tag: 'p', text: 'Alpha' },
        { mid: mid('pb'), tag: 'p', text: 'Beta' },
        { mid: mid('pc'), tag: 'p', text: 'Gamma' },
      ],
    };
    const r = reconcile(prev, {
      tag: 'div',
      children: [{ tag: 'p', text: 'Gamma' }, { tag: 'p', text: 'Alpha' }, { tag: 'p', text: 'Beta' }],
    });
    assertInvariants(r);
    expect((r.doc.children ?? []).map(n => n.mid)).toEqual([mid('pc'), mid('pa'), mid('pb')]);
  });

  it('does not treat a keyed node and a same-tag text node as the same node', () => {
    const prev: DocNode = {
      mid: mid('root'), tag: 'div',
      children: [{ mid: mid('keyed'), tag: 'p', props: { key: 'alpha' }, pins: pinned('style.color') }],
    };
    const r = reconcile(prev, { tag: 'div', children: [{ tag: 'p', text: 'alpha' }] });
    assertInvariants(r);
    expect(r.doc.children?.[0].mid).not.toBe(mid('keyed'));
    expect(r.doc.children?.[0].pins).toBeUndefined();
    expect(r.droppedPins).toContainEqual({
      prevMid: mid('keyed'), nowMid: null, reason: 'removed', cells: ['style.color'],
    });
  });

  it('does not let an inserted wrapper steal its children\'s ids', () => {
    const prev: DocNode = {
      mid: mid('root'), tag: 'div',
      children: [
        { mid: mid('h'), tag: 'h1', text: 'Hello', pins: pinned('text') },
        { mid: mid('p'), tag: 'p', text: 'World' },
      ],
    };
    const next: DocNodeInput = {
      tag: 'div',
      children: [{
        tag: 'section',
        children: [{ tag: 'h1', text: 'Hello' }, { tag: 'p', text: 'World' }],
      }],
    };
    const r = reconcile(prev, next);
    assertInvariants(r);
    const section = r.doc.children?.[0];
    expect(section?.tag).toBe('section');
    expect(section?.mid).not.toBe(mid('h'));
    expect(section?.mid).not.toBe(mid('p'));
    expect(r.tiers[section?.mid ?? '']).toBe('minted');
    expect((section?.children ?? []).map(n => n.mid)).toEqual([mid('h'), mid('p')]);
    // An exact match, so the human's pin travels with its element.
    expect(section?.children?.[0].pins).toEqual(pinned('text'));
    expect(r.lost).toEqual([]);
    expect(r.droppedPins).toEqual([]);
  });

  it('keeps children\'s ids when a wrapper is removed', () => {
    const prev: DocNode = {
      mid: mid('root'), tag: 'div',
      children: [{
        mid: mid('wrap'), tag: 'section',
        children: [{ mid: mid('h'), tag: 'h1', text: 'Hello' }, { mid: mid('p'), tag: 'p', text: 'World' }],
      }],
    };
    const r = reconcile(prev, {
      tag: 'div',
      children: [{ tag: 'h1', text: 'Hello' }, { tag: 'p', text: 'World' }],
    });
    assertInvariants(r);
    expect((r.doc.children ?? []).map(n => n.mid)).toEqual([mid('h'), mid('p')]);
    expect(r.lost).toEqual([mid('wrap')]);
  });

  it('mints only the genuinely new node when one is inserted mid-list', () => {
    const prev: DocNode = {
      mid: mid('root'), tag: 'div',
      children: [
        { mid: mid('one'), tag: 'p', text: 'One' },
        { mid: mid('two'), tag: 'p', text: 'Two' },
        { mid: mid('three'), tag: 'p', text: 'Three' },
      ],
    };
    const r = reconcile(prev, {
      tag: 'div',
      children: [
        { tag: 'p', text: 'One' }, { tag: 'p', text: 'Inserted' },
        { tag: 'p', text: 'Two' }, { tag: 'p', text: 'Three' },
      ],
    });
    assertInvariants(r);
    const kids = r.doc.children ?? [];
    expect(kids[0].mid).toBe(mid('one'));
    expect(kids[2].mid).toBe(mid('two'));
    expect(kids[3].mid).toBe(mid('three'));
    expect(r.tiers[kids[1].mid]).toBe('minted');
    expect(Object.keys(r.newMids)).toEqual(['#/1']);
  });

  it('reconciles slot contents by slot name', () => {
    const prev: DocNode = {
      mid: mid('root'), tag: 'div',
      children: [{
        mid: mid('row'), tag: 'UI.Row',
        slots: {
          trailing: [{ mid: mid('badge'), tag: 'UI.Badge', props: { label: 'New' }, pins: pinned('props.label') }],
        },
      }],
    };
    const r = reconcile(prev, {
      tag: 'div',
      children: [{
        tag: 'UI.Row',
        slots: { trailing: [{ tag: 'UI.Badge', props: { label: 'New' } }] },
      }],
    });
    assertInvariants(r);
    const badge = find(r.doc, n => n.tag === 'UI.Badge');
    expect(badge?.mid).toBe(mid('badge'));
    expect(r.lost).toEqual([]);
    // A node identified by neither `props.key` nor text is NOT an exact match,
    // however identical its content: three `<UI.Badge label="New"/>` siblings
    // are indistinguishable, and pairing the wrong one would move a pin
    // invisibly. So the id carries and the pin is dropped-and-reported.
    expect(r.tiers[mid('badge')]).toBe('similar');
    expect(badge?.pins).toBeUndefined();
    expect(r.droppedPins).toEqual([{
      prevMid: mid('badge'), nowMid: mid('badge'), reason: 'weak-match', cells: ['props.label'],
    }]);
  });

  it('carries a slot node\'s pins once it is keyed', () => {
    const prev: DocNode = {
      mid: mid('root'), tag: 'div',
      children: [{
        mid: mid('row'), tag: 'UI.Row',
        slots: {
          trailing: [{
            mid: mid('badge'), tag: 'UI.Badge',
            props: { key: 'status', label: 'New' }, pins: pinned('props.label'),
          }],
        },
      }],
    };
    const r = reconcile(prev, {
      tag: 'div',
      children: [{
        tag: 'UI.Row',
        slots: { trailing: [{ tag: 'UI.Badge', props: { key: 'status', label: 'Updated' } }] },
      }],
    });
    assertInvariants(r);
    const badge = find(r.doc, n => n.tag === 'UI.Badge');
    expect(r.tiers[mid('badge')]).toBe('exact');
    expect(badge?.pins).toEqual(pinned('props.label'));
    expect(r.droppedPins).toEqual([]);
  });

  it('does not carry ids between differently named slots', () => {
    const prev: DocNode = {
      mid: mid('root'), tag: 'UI.Row',
      slots: { leading: [{ mid: mid('av'), tag: 'UI.Avatar', props: { src: 'a' }, pins: pinned('props.src') }] },
    };
    const r = reconcile(prev, {
      tag: 'UI.Row',
      slots: { trailing: [{ tag: 'UI.Avatar', props: { src: 'a' } }] },
    });
    assertInvariants(r);
    expect(find(r.doc, n => n.tag === 'UI.Avatar')?.mid).not.toBe(mid('av'));
    expect(r.lost).toEqual([mid('av')]);
    expect(r.droppedPins).toContainEqual({
      prevMid: mid('av'), nowMid: null, reason: 'removed', cells: ['props.src'],
    });
  });

  it('keys minted slot nodes by their slot path', () => {
    const prev: DocNode = { mid: mid('root'), tag: 'UI.Row' };
    const r = reconcile(prev, {
      tag: 'UI.Row',
      slots: { trailing: [{ tag: 'UI.Badge', props: { label: 'x' } }] },
    });
    assertInvariants(r);
    expect(Object.keys(r.newMids)).toEqual(['#/@trailing/0']);
  });
});

/* --------------- the non-negotiable rule: pins and weak matches -------- */

describe('reconcile — pins never ride a weak match (Plan 22 §7 risk 2)', () => {
  const prev: DocNode = {
    mid: mid('root'), tag: 'div',
    children: [{
      mid: mid('copy'), tag: 'p', text: 'Alpha', by: 'user',
      pins: pinned('style.color', 'text'),
    }],
  };

  it('inherits the id but drops the pins on a similarity match, and reports it', () => {
    // Same tag, entirely different text: 0.5 + 0 + 0.2 = 0.7 — matched, but weakly.
    const r = reconcile(prev, { tag: 'div', children: [{ tag: 'p', text: 'Zulu' }] });
    assertInvariants(r);
    const kid = r.doc.children?.[0];
    expect(kid?.mid).toBe(mid('copy'));
    expect(r.tiers[mid('copy')]).toBe('similar');
    expect(PIN_CARRYING_TIERS.has('similar')).toBe(false);
    expect(kid?.pins).toBeUndefined();
    expect(r.droppedPins).toEqual([{
      prevMid: mid('copy'), nowMid: mid('copy'), reason: 'weak-match', cells: ['style.color', 'text'],
    }]);
  });

  it('does not carry `by` across a weak match either', () => {
    const r = reconcile(prev, { tag: 'div', children: [{ tag: 'p', text: 'Zulu' }] });
    expect(r.doc.children?.[0].by).toBeUndefined();
  });

  it('carries pins and `by` on a tier-1 echo', () => {
    const r = reconcile(prev, {
      mid: mid('root'), tag: 'div',
      children: [{ mid: mid('copy'), tag: 'p', text: 'Totally rewritten' }],
    });
    assertInvariants(r);
    expect(r.tiers[mid('copy')]).toBe('echoed');
    expect(r.doc.children?.[0].pins).toEqual(pinned('style.color', 'text'));
    expect(r.doc.children?.[0].by).toBe('user');
    expect(r.droppedPins).toEqual([]);
  });

  it('carries pins on a tier-2 exact match', () => {
    const keyedPrev: DocNode = {
      mid: mid('root'), tag: 'div',
      children: [{ mid: mid('copy'), tag: 'p', props: { key: 'c' }, pins: pinned('style.color') }],
    };
    const r = reconcile(keyedPrev, { tag: 'div', children: [{ tag: 'p', props: { key: 'c', extra: 1 } }] });
    assertInvariants(r);
    expect(r.tiers[mid('copy')]).toBe('exact');
    expect(r.doc.children?.[0].pins).toEqual(pinned('style.color'));
    expect(r.droppedPins).toEqual([]);
  });

  it('never lets a pin ride any tier outside PIN_CARRYING_TIERS, across a fuzzed corpus', () => {
    // Property sweep: whatever the rewrite, a node holding pins in the output
    // must have been matched at a pin-carrying tier.
    const texts = ['Alpha', 'Alphabet', 'Zulu', '', 'Alpha '];
    const tags = ['p', 'h1', 'UI.Text'];
    for (const t of texts) {
      for (const g of tags) {
        for (const key of [undefined, 'c', 'other']) {
          const props = key === undefined ? undefined : { key };
          const r = reconcile(prev, { tag: 'div', children: [{ tag: g, text: t, props }] });
          assertInvariants(r);
          for (const n of walk(r.doc)) {
            if (n.pins && Object.keys(n.pins).length > 0) {
              expect(PIN_CARRYING_TIERS.has(r.tiers[n.mid])).toBe(true);
            }
          }
          // Pins either travel or are reported; they are never silently gone.
          const survived = find(r.doc, n => !!n.pins)?.pins;
          if (!survived) {
            expect(r.droppedPins.some(d => d.prevMid === mid('copy'))).toBe(true);
          }
        }
      }
    }
  });
});

/* ------------------------- restructure is honest ----------------------- */

describe('reconcile — a genuine restructure loses ids and says so', () => {
  it('mints a replacement of a different tag and reports the loss', () => {
    const prev: DocNode = {
      mid: mid('root'), tag: 'div',
      children: [{
        mid: mid('btn'), tag: 'UI.Button', props: { label: 'Buy' },
        pins: pinned('style.background'),
        children: [{ mid: mid('inner'), tag: 'span', text: 'Buy' }],
      }],
    };
    const r = reconcile(prev, {
      tag: 'div',
      children: [{ tag: 'UI.Chart', props: { data: [{ label: 'Jan', value: 22 }] } }],
    });
    assertInvariants(r);
    expect(mids(r.doc)).not.toContain(mid('btn'));
    expect(r.lost).toEqual(expect.arrayContaining([mid('btn'), mid('inner')]));
    expect(r.droppedPins).toEqual([{
      prevMid: mid('btn'), nowMid: null, reason: 'removed', cells: ['style.background'],
    }]);
    expect(r.carried).toBe(1); // the root only
  });

  it('mints the root when its tag changes but still reconciles the body', () => {
    const prev: DocNode = {
      mid: mid('root'), tag: 'div', pins: pinned('style.background'),
      children: [{ mid: mid('h'), tag: 'h1', text: 'Hello' }],
    };
    const r = reconcile(prev, { tag: 'section', children: [{ tag: 'h1', text: 'Hello' }] });
    assertInvariants(r);
    expect(r.doc.mid).not.toBe(mid('root'));
    expect(r.tiers[r.doc.mid]).toBe('minted');
    expect(r.doc.pins).toBeUndefined();
    expect(r.doc.children?.[0].mid).toBe(mid('h'));
    expect(r.droppedPins).toContainEqual({
      prevMid: mid('root'), nowMid: null, reason: 'removed', cells: ['style.background'],
    });
    expect(Object.keys(r.newMids)).toEqual(['#']);
  });

  it('reports every previous node as lost when the page is emptied', () => {
    const prev: DocNode = {
      mid: mid('root'), tag: 'div',
      children: [{ mid: mid('a'), tag: 'p', text: 'A' }, { mid: mid('b'), tag: 'p', text: 'B' }],
    };
    const r = reconcile(prev, { tag: 'div' });
    assertInvariants(r);
    expect(r.doc.children).toBeUndefined();
    expect(r.lost).toEqual([mid('a'), mid('b')]);
    expect(r.carried).toBe(1);
  });

  it('mints an entire fresh page when nothing corresponds', () => {
    const prev: DocNode = { mid: mid('root'), tag: 'div', children: [{ mid: mid('a'), tag: 'p', text: 'A' }] };
    const r = reconcile(prev, {
      tag: 'main',
      children: [{ tag: 'UI.Card', props: { title: 'X' } }, { tag: 'UI.Chart', props: { data: [] } }],
    });
    assertInvariants(r);
    expect(r.carried).toBe(0);
    expect(r.lost).toEqual([mid('root'), mid('a')]);
    expect(Object.keys(r.newMids).sort()).toEqual(['#', '#/0', '#/1']);
  });
});

/* ------------------------------- options ------------------------------- */

describe('reconcile — options', () => {
  const prev: DocNode = {
    mid: mid('root'), tag: 'div',
    children: [{ mid: mid('copy'), tag: 'p', text: 'Alpha' }],
  };

  it('an unreachable threshold forces everything but exact matches to mint', () => {
    const r = reconcile(prev, { tag: 'div', children: [{ tag: 'p', text: 'Zulu' }] }, { threshold: 2 });
    assertInvariants(r);
    expect(r.doc.children?.[0].mid).not.toBe(mid('copy'));
    expect(r.lost).toEqual([mid('copy')]);
  });

  it('a zero window still allows an in-place similarity match', () => {
    const r = reconcile(prev, { tag: 'div', children: [{ tag: 'p', text: 'Zulu' }] }, { window: 0 });
    assertInvariants(r);
    expect(r.doc.children?.[0].mid).toBe(mid('copy'));
  });

  it('truncates rather than overflowing on an absurdly deep tree', () => {
    let deep: DocNodeInput = { tag: 'span', text: 'leaf' };
    for (let i = 0; i < 400; i++) { deep = { tag: 'div', children: [deep] }; }
    const r = reconcile(prev, deep);
    assertInvariants(r);
    expect(r.truncated).toBeGreaterThan(0);
    // The tree stops at the cap instead of blowing the host stack.
    expect([...walk(r.doc)].length).toBeLessThanOrEqual(257);
  });

  it('still mints unique ids when the injected rand is degenerate', () => {
    const r = reconcile(prev, {
      tag: 'div',
      children: [{ tag: 'br' }, { tag: 'br' }, { tag: 'br' }, { tag: 'br' }, { tag: 'br' }],
    }, { rand: () => 0 });
    assertInvariants(r);
    const kidMids = (r.doc.children ?? []).map(n => n.mid);
    expect(new Set(kidMids).size).toBe(5);
    for (const m of kidMids) { expect(isMid(m)).toBe(true); }
  });

  it('is deterministic for a given rand', () => {
    const seeded = () => {
      let s = 12345;
      return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
    };
    const next: DocNodeInput = { tag: 'div', children: [{ tag: 'UI.Card', props: { title: 'X' } }] };
    const a = reconcile(prev, next, { rand: seeded() });
    const b = reconcile(prev, next, { rand: seeded() });
    expect(JSON.stringify(a.doc)).toBe(JSON.stringify(b.doc));
  });
});

/* -------------------------------- scale -------------------------------- */

describe('reconcile — large trees', () => {
  function flatPage(count: number, label: (i: number) => string): DocNode {
    return {
      mid: mid('root'), tag: 'div',
      children: Array.from({ length: count }, (_, i) => ({
        mid: mid(`n${indexToMidChunk(i)}`), tag: 'p', text: label(i),
      })),
    };
  }

  /** Index into base32-safe characters so generated mids stay well-formed. */
  function indexToMidChunk(i: number): string {
    const alpha = 'abcdefghijklmnopqrstuvwxyz';
    return `${alpha[Math.floor(i / 26 / 26) % 26]}${alpha[Math.floor(i / 26) % 26]}${alpha[i % 26]}`;
  }

  it('carries nearly every id through a 400-node rewrite with one insertion', () => {
    const prev = flatPage(400, i => `Item ${i}`);
    const kids: DocNodeInput[] = Array.from({ length: 400 }, (_, i) => ({ tag: 'p', text: `Item ${i}` }));
    kids.splice(200, 0, { tag: 'p', text: 'Brand new row' });
    const started = Date.now();
    const r = reconcile(prev, { tag: 'div', children: kids });
    const elapsed = Date.now() - started;
    assertInvariants(r);
    expect(r.carried).toBe(401); // 400 rows + the root
    expect(Object.keys(r.newMids)).toEqual(['#/200']);
    expect(r.lost).toEqual([]);
    expect(elapsed).toBeLessThan(5000);
  });

  it('matches indistinguishable containers positionally without crossing the window', () => {
    const prev: DocNode = {
      mid: mid('root'), tag: 'div',
      children: Array.from({ length: 200 }, (_, i) => ({ mid: mid(`c${indexToMidChunk(i)}`), tag: 'div' })),
    };
    const started = Date.now();
    const r = reconcile(prev, {
      tag: 'div',
      children: Array.from({ length: 200 }, () => ({ tag: 'div' })),
    });
    const elapsed = Date.now() - started;
    assertInvariants(r);
    // Indistinguishable nodes carry by position: all 200 keep their ids, in order.
    expect((r.doc.children ?? []).map(n => n.mid)).toEqual((prev.children ?? []).map(n => n.mid));
    expect(r.lost).toEqual([]);
    expect(elapsed).toBeLessThan(5000);
  });

  it('handles a deep-but-wide tree without duplicating a single id', () => {
    const build = (depth: number, breadth: number, tag: string): DocNodeInput =>
      depth === 0
        ? { tag: 'span', text: `leaf-${breadth}` }
        : { tag, children: Array.from({ length: breadth }, () => build(depth - 1, breadth, tag)) };
    const prevInput = build(4, 4, 'div');
    const seeded = reconcile({ mid: mid('root'), tag: 'nothing' }, prevInput);
    assertInvariants(seeded);
    const again = reconcile(seeded.doc, build(4, 4, 'div'));
    assertInvariants(again);
    // A byte-identical rewrite must not lose anything.
    expect(again.lost).toEqual([]);
    expect(again.carried).toBe([...walk(seeded.doc)].length);
  });
});
