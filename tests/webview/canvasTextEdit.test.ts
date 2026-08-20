/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 §4 row 4 — inline text editing, which did not exist at all.
 *
 * The frame owns the caret; the parent owns whether a commit becomes an op. So
 * what is tested here is the parent's half, and specifically the adversarial
 * half: the harness renders MODEL-AUTHORED content, so a `textCommit` is a
 * claim, not a fact.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  InlineTextEditor,
  TEXT_EDIT_MAX_LENGTH,
  isTextLeaf,
  sanitizeCommittedText,
} from '../../src/webview/canvas/textEdit';
import type { OpSubmission } from '../../src/webview/canvas/controls';
import type { FrameDownMessage } from '../../src/managers/CanvasSandbox';
import type { DocNode } from '../../src/canvas/doc/DocNode';

const HEADING: DocNode = { mid: 'aaaaaaaaaa', tag: 'UI.Heading', text: 'Welcome' };
const BUTTON: DocNode = { mid: 'bbbbbbbbbb', tag: 'UI.Button', text: 'Sign in' };
const CARD: DocNode = { mid: 'cccccccccc', tag: 'UI.Card' };
const CONTAINER: DocNode = {
  mid: 'dddddddddd', tag: 'UI.Button',
  children: [{ mid: 'eeeeeeeeee', tag: 'UI.Text', text: 'x' }],
};

function harness() {
  const sent: Array<{ pageId: string; message: FrameDownMessage }> = [];
  const submitted: OpSubmission[] = [];
  const editing: Array<{ pageId: string; mids: string[]; editing: boolean }> = [];
  let n = 0;
  const editor = new InlineTextEditor({
    sendToFrame: (pageId, message) => sent.push({ pageId, message }),
    submit: s => submitted.push(s),
    onEditingChange: (pageId, mids, on) => editing.push({ pageId, mids: [...mids], editing: on }),
    newTxnId: () => `txn-${n++}`,
    now: () => 1000,
  });
  return { editor, sent, submitted, editing };
}

describe('opening an inline edit', () => {
  it('a double-click on a text leaf sends beginTextEdit down the port', () => {
    const h = harness();
    expect(h.editor.handleHit('p1', HEADING.mid, HEADING, true)).toBe(true);
    expect(h.sent).toEqual([{ pageId: 'p1', message: { t: 'beginTextEdit', mid: HEADING.mid } }]);
    expect(h.editor.active).toEqual({ pageId: 'p1', mid: HEADING.mid, startedAt: 1000 });
  });

  it('a single click does not — that is selection', () => {
    const h = harness();
    expect(h.editor.handleHit('p1', HEADING.mid, HEADING, false)).toBe(false);
    expect(h.sent).toEqual([]);
    expect(h.editor.active).toBeNull();
  });

  it('announces canvas/editing so the executor parks agent ops in that subtree', () => {
    const h = harness();
    h.editor.begin('p1', HEADING.mid, HEADING);
    expect(h.editing).toEqual([{ pageId: 'p1', mids: [HEADING.mid], editing: true }]);
  });

  it('refuses a primitive that does not render text', () => {
    const h = harness();
    expect(h.editor.begin('p1', CARD.mid, CARD)).toBe(false);
    expect(h.sent).toEqual([]);
  });

  it('refuses a container — el.setText on one throws in DocPatch', () => {
    const h = harness();
    expect(h.editor.begin('p1', CONTAINER.mid, CONTAINER)).toBe(false);
  });

  it('refuses a mid the store cannot resolve, or one that does not match', () => {
    const h = harness();
    expect(h.editor.begin('p1', 'zzzzzzzzzz', null)).toBe(false);
    expect(h.editor.begin('p1', 'zzzzzzzzzz', HEADING)).toBe(false);
    expect(h.editor.begin('', HEADING.mid, HEADING)).toBe(false);
  });

  it('re-opening the SAME node is idempotent', () => {
    const h = harness();
    h.editor.begin('p1', HEADING.mid, HEADING);
    h.editor.begin('p1', HEADING.mid, HEADING);
    expect(h.sent).toHaveLength(1);
  });
});

describe('committing', () => {
  it('emits el.setText — the same op set_text produces', () => {
    const h = harness();
    h.editor.begin('p1', HEADING.mid, HEADING);
    const outcome = h.editor.commit('p1', HEADING.mid, 'Get started', HEADING);
    expect(outcome).toEqual({
      ok: true,
      text: 'Get started',
      ops: [{ op: 'el.setText', pageId: 'p1', mid: HEADING.mid, text: 'Get started' }],
    });
    expect(h.submitted).toEqual([{
      txnId: 'txn-0',
      ops: [{ op: 'el.setText', pageId: 'p1', mid: HEADING.mid, text: 'Get started' }],
    }]);
    expect(h.editor.active).toBeNull();
    expect(h.editing.at(-1)).toEqual({ pageId: 'p1', mids: [HEADING.mid], editing: false });
  });

  it('an unchanged commit writes nothing — no journal entry, no pin', () => {
    const h = harness();
    h.editor.begin('p1', HEADING.mid, HEADING);
    const outcome = h.editor.commit('p1', HEADING.mid, 'Welcome', HEADING);
    expect(outcome).toEqual({ ok: false, reason: 'unchanged' });
    expect(h.submitted).toEqual([]);
    expect(h.editor.active).toBeNull();
  });

  it('one commit is one transaction; two edits are two', () => {
    const h = harness();
    h.editor.begin('p1', HEADING.mid, HEADING);
    h.editor.commit('p1', HEADING.mid, 'One', HEADING);
    h.editor.begin('p1', BUTTON.mid, BUTTON);
    h.editor.commit('p1', BUTTON.mid, 'Two', BUTTON);
    expect(h.submitted.map(s => s.txnId)).toEqual(['txn-0', 'txn-1']);
  });
});

describe('the frame is not trusted', () => {
  it('refuses a commit for a node the user never opened', () => {
    const h = harness();
    h.editor.begin('p1', HEADING.mid, HEADING);
    // A prompt-injected page claiming a DIFFERENT element committed.
    const outcome = h.editor.commit('p1', BUTTON.mid, 'Owned', BUTTON);
    expect(outcome).toEqual({ ok: false, reason: 'foreign-edit' });
    expect(h.submitted).toEqual([]);
    // ...and the real edit still works afterwards.
    expect(h.editor.commit('p1', HEADING.mid, 'Real', HEADING).ok).toBe(true);
  });

  it('refuses a commit for the right mid on the WRONG artboard', () => {
    const h = harness();
    h.editor.begin('p1', HEADING.mid, HEADING);
    expect(h.editor.commit('p2', HEADING.mid, 'Elsewhere', HEADING))
      .toEqual({ ok: false, reason: 'foreign-edit' });
  });

  it('refuses a commit when nothing is open at all', () => {
    const h = harness();
    expect(h.editor.commit('p1', HEADING.mid, 'Unsolicited', HEADING))
      .toEqual({ ok: false, reason: 'no-active-edit' });
    expect(h.submitted).toEqual([]);
  });

  it('refuses a non-string body', () => {
    const h = harness();
    h.editor.begin('p1', HEADING.mid, HEADING);
    expect(h.editor.commit('p1', HEADING.mid, { toString: () => 'x' }, HEADING))
      .toEqual({ ok: false, reason: 'not-a-string' });
    expect(h.submitted).toEqual([]);
  });

  it('refuses when the node vanished mid-edit (an agent removed it)', () => {
    const h = harness();
    h.editor.begin('p1', HEADING.mid, HEADING);
    expect(h.editor.commit('p1', HEADING.mid, 'Ghost', null))
      .toEqual({ ok: false, reason: 'unknown-node' });
    expect(h.editor.active).toBeNull();
  });

  it('refuses when the node stopped being a text leaf mid-edit', () => {
    const h = harness();
    h.editor.begin('p1', HEADING.mid, HEADING);
    const grown: DocNode = { ...HEADING, text: undefined, children: [{ mid: 'ffffffffff', tag: 'UI.Text' }] };
    expect(h.editor.commit('p1', HEADING.mid, 'Nope', grown))
      .toEqual({ ok: false, reason: 'not-text' });
  });

  it('a commit after Escape/cancel is refused', () => {
    const h = harness();
    h.editor.begin('p1', HEADING.mid, HEADING);
    h.editor.cancel();
    expect(h.editor.commit('p1', HEADING.mid, 'Late', HEADING))
      .toEqual({ ok: false, reason: 'no-active-edit' });
    expect(h.submitted).toEqual([]);
  });
});

describe('superseded edits still land', () => {
  it('the harness closes edit A while opening B; A\'s commit is still accepted', () => {
    // The real sequence: beginTextEdit(B) makes the harness call endTextEdit(true)
    // on A, so A's `textCommit` arrives AFTER `active` has moved to B. Refusing it
    // on provenance grounds would silently discard real typing.
    const h = harness();
    h.editor.begin('p1', HEADING.mid, HEADING);
    h.editor.begin('p1', BUTTON.mid, BUTTON);
    const outcome = h.editor.commit('p1', HEADING.mid, 'Typed in A', HEADING);
    expect(outcome.ok).toBe(true);
    expect(h.editor.active).toEqual({ pageId: 'p1', mid: BUTTON.mid, startedAt: 1000 });
    // B still commits on its own.
    expect(h.editor.commit('p1', BUTTON.mid, 'Typed in B', BUTTON).ok).toBe(true);
  });

  it('the tail is bounded — an ancient edit cannot be replayed', () => {
    const h = harness();
    const mids = ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc', 'dddddddddd', 'eeeeeeeeee', 'ffffffffff'];
    const nodes = mids.map(mid => ({ mid, tag: 'UI.Heading', text: mid } as DocNode));
    for (const n of nodes) { h.editor.begin('p1', n.mid, n); }
    // Six opens, a 4-deep tail: the first is no longer claimable.
    expect(h.editor.commit('p1', mids[0], 'stale', nodes[0]))
      .toEqual({ ok: false, reason: 'foreign-edit' });
    expect(h.editor.commit('p1', mids[4], 'fresh', nodes[4]).ok).toBe(true);
  });

  it('a commit consumes its claim — a replay of the same commit is refused', () => {
    const h = harness();
    h.editor.begin('p1', HEADING.mid, HEADING);
    h.editor.begin('p1', BUTTON.mid, BUTTON);
    expect(h.editor.commit('p1', HEADING.mid, 'once', HEADING).ok).toBe(true);
    expect(h.editor.commit('p1', HEADING.mid, 'twice', HEADING))
      .toEqual({ ok: false, reason: 'foreign-edit' });
  });
});

describe('sanitizeCommittedText', () => {
  it('normalizes CRLF that contenteditable produces', () => {
    expect(sanitizeCommittedText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('strips invisible characters that would be a spoofing surface', () => {
    const BIDI = String.fromCharCode(0x202E);
    const ZWSP = String.fromCharCode(0x200B);
    const NUL = String.fromCharCode(0);
    expect(sanitizeCommittedText(`Pay${BIDI}now${ZWSP}${NUL}`)).toBe('Paynow');
  });

  it('keeps ordinary whitespace and newlines', () => {
    expect(sanitizeCommittedText('one two\n  three\t.')).toBe('one two\n  three\t.');
  });

  it('caps length', () => {
    expect(sanitizeCommittedText('x'.repeat(TEXT_EDIT_MAX_LENGTH + 500))!.length)
      .toBe(TEXT_EDIT_MAX_LENGTH);
    expect(sanitizeCommittedText('abcdef', 3)).toBe('abc');
  });

  it('does not interpret markup — the value is stored verbatim', () => {
    // Nothing downstream parses it: `preview.ts` sets `textContent`, and the
    // harness writes a text node. So escaping would corrupt legitimate copy.
    const raw = '<img src=x onerror=alert(1)> & "quoted"';
    expect(sanitizeCommittedText(raw)).toBe(raw);
  });

  it('returns null for anything that is not a string', () => {
    expect(sanitizeCommittedText(undefined)).toBeNull();
    expect(sanitizeCommittedText(42)).toBeNull();
    expect(sanitizeCommittedText({})).toBeNull();
  });

  it('an empty commit is a legitimate value, not a refusal', () => {
    expect(sanitizeCommittedText('')).toBe('');
  });
});

describe('isTextLeaf', () => {
  it('accepts text primitives and textual HTML tags', () => {
    expect(isTextLeaf(HEADING)).toBe(true);
    expect(isTextLeaf({ mid: 'aaaaaaaaaa', tag: 'h2', text: 'x' })).toBe(true);
    expect(isTextLeaf({ mid: 'aaaaaaaaaa', tag: 'span' })).toBe(true);
  });

  it('rejects containers, layout primitives and junk', () => {
    expect(isTextLeaf(CARD)).toBe(false);
    expect(isTextLeaf(CONTAINER)).toBe(false);
    expect(isTextLeaf({ mid: 'aaaaaaaaaa', tag: 'div' })).toBe(false);
    expect(isTextLeaf(null)).toBe(false);
    expect(isTextLeaf({ mid: 'aaaaaaaaaa' } as unknown as DocNode)).toBe(false);
  });
});

describe('committing an empty string', () => {
  it('clears the text rather than refusing', () => {
    const h = harness();
    h.editor.begin('p1', HEADING.mid, HEADING);
    const outcome = h.editor.commit('p1', HEADING.mid, '', HEADING);
    expect(outcome.ok).toBe(true);
    expect(h.submitted[0].ops).toEqual([{ op: 'el.setText', pageId: 'p1', mid: HEADING.mid, text: '' }]);
  });

  it('but an empty commit on already-empty text is still a no-op', () => {
    const h = harness();
    const empty: DocNode = { mid: 'aaaaaaaaaa', tag: 'UI.Heading' };
    h.editor.begin('p1', empty.mid, empty);
    expect(h.editor.commit('p1', empty.mid, '', empty)).toEqual({ ok: false, reason: 'unchanged' });
  });
});

describe('warnings', () => {
  it('reports a dropped foreign commit rather than failing silently', () => {
    const warn = vi.fn();
    const editor = new InlineTextEditor({
      sendToFrame: () => { /* noop */ },
      submit: () => { /* noop */ },
      warn,
    });
    editor.begin('p1', HEADING.mid, HEADING);
    editor.commit('p1', BUTTON.mid, 'x', BUTTON);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('never opened'), 'p1', BUTTON.mid,
    );
  });
});
