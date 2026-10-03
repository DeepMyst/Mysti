/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 §4 rows 5 and 6 — undo/redo chrome and the version timeline.
 *
 * The audit found "no keybinding, no button, no tool" while the prompt told the
 * model *"work confidently; the user can undo."* These tests pin the three
 * things that make the replacement honest rather than decorative:
 *
 * 1. The chord is platform-exact (Cmd on macOS, Ctrl elsewhere) and yields to a
 *    text field, so inline artboard editing keeps its own undo.
 * 2. The disabled state comes from the HOST's `CanvasHistory` snapshot — the
 *    webview keeps no mirror of a stack it cannot see.
 * 3. Restore is a *message*, not a local mutation: the host replays it as ops.
 */
import { describe, it, expect } from 'vitest';
import {
  HistoryUi,
  defaultVersionLabel,
  detectPlatform,
  formatAge,
  historyButtonState,
  historyMessageFor,
  isEditableTarget,
  kindsSummary,
  matchHistoryShortcut,
  shortcutChord,
  txnSummary,
  type HistoryPlatform,
} from '../../src/webview/canvas/historyUi';
import type { CanvasHistoryStatus, CanvasHistoryTxnView, CanvasVersionView } from '../../src/canvas/CanvasHistory';
import type { CanvasEnv, DomElement } from '../../src/webview/canvas/dom';
import type { CanvasClientBody } from '../../src/webview/canvas/protocolClient';
import { getFormat } from '../../src/managers/CanvasFormats';
import { FakeChannel, FakeDocument, FakeElement } from './canvasFakeDom';

const DESKTOP = getFormat('desktop')!;

function txn(over: Partial<CanvasHistoryTxnView> = {}): CanvasHistoryTxnView {
  return {
    txnId: 't1', author: 'agent', kinds: ['edit_page'], opCount: 1, ts: 0, inEffect: true, ...over,
  };
}

function status(over: Partial<CanvasHistoryStatus> = {}): CanvasHistoryStatus {
  return {
    canUndo: true, canRedo: false, position: 1,
    undo: txn(), redo: undefined, transactions: [txn()], versions: [], ...over,
  };
}

function version(over: Partial<CanvasVersionView> = {}): CanvasVersionView {
  return {
    id: 'v1', label: 'Before rebrand', ts: 0, artifactVersion: 4, pageCount: 2,
    thumbFormat: DESKTOP,
    thumbDoc: { mid: 'aaaaaaaaaa', tag: 'UI.Screen', children: [{ mid: 'bbbbbbbbbb', tag: 'UI.Heading', text: 'Sign in' }] },
    ...over,
  };
}

/* ============================== shortcuts ============================== */

describe('detectPlatform', () => {
  it('reads mac from platform or user agent, and defaults to ctrl elsewhere', () => {
    expect(detectPlatform({ platform: 'MacIntel' })).toBe('mac');
    expect(detectPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' })).toBe('mac');
    expect(detectPlatform({ platform: 'iPhone' })).toBe('mac');
    expect(detectPlatform({ platform: 'Win32' })).toBe('other');
    expect(detectPlatform({ platform: 'Linux x86_64' })).toBe('other');
    expect(detectPlatform(null)).toBe('other');
    expect(detectPlatform({})).toBe('other');
  });
});

describe('matchHistoryShortcut', () => {
  it('maps Cmd+Z / Cmd+Shift+Z on macOS', () => {
    expect(matchHistoryShortcut({ key: 'z', metaKey: true }, 'mac')).toBe('undo');
    expect(matchHistoryShortcut({ key: 'Z', metaKey: true, shiftKey: true }, 'mac')).toBe('redo');
  });

  it('maps Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y on Windows and Linux', () => {
    expect(matchHistoryShortcut({ key: 'z', ctrlKey: true }, 'other')).toBe('undo');
    expect(matchHistoryShortcut({ key: 'z', ctrlKey: true, shiftKey: true }, 'other')).toBe('redo');
    expect(matchHistoryShortcut({ key: 'y', ctrlKey: true }, 'other')).toBe('redo');
  });

  it('refuses the OTHER platform\'s modifier', () => {
    // Ctrl+Z on macOS is the suspend chord, not undo.
    expect(matchHistoryShortcut({ key: 'z', ctrlKey: true }, 'mac')).toBeNull();
    // Meta on Windows/Linux is the OS key; it must not mutate the document.
    expect(matchHistoryShortcut({ key: 'z', metaKey: true }, 'other')).toBeNull();
    // Both held is ambiguous; refuse rather than guess.
    expect(matchHistoryShortcut({ key: 'z', metaKey: true, ctrlKey: true }, 'mac')).toBeNull();
    expect(matchHistoryShortcut({ key: 'z', metaKey: true, ctrlKey: true }, 'other')).toBeNull();
  });

  it('refuses Alt chords and bare Z', () => {
    expect(matchHistoryShortcut({ key: 'z', metaKey: true, altKey: true }, 'mac')).toBeNull();
    expect(matchHistoryShortcut({ key: 'z' }, 'mac')).toBeNull();
    expect(matchHistoryShortcut({ key: 'y', ctrlKey: true, shiftKey: true }, 'other')).toBeNull();
    expect(matchHistoryShortcut({ key: 'a', ctrlKey: true }, 'other')).toBeNull();
  });

  it('falls back to `code` only for a non-Latin layout', () => {
    expect(matchHistoryShortcut({ key: 'я', code: 'KeyZ', metaKey: true }, 'mac')).toBe('undo');
    // A remapped Latin key must NOT fire on the wrong glyph.
    expect(matchHistoryShortcut({ key: 'q', code: 'KeyZ', metaKey: true }, 'mac')).toBeNull();
  });

  it('yields to a text field, a select and an inline contenteditable edit', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input']) {
      expect(matchHistoryShortcut({ key: 'z', metaKey: true, target: { tagName } }, 'mac')).toBeNull();
    }
    expect(matchHistoryShortcut({ key: 'z', metaKey: true, target: { isContentEditable: true } }, 'mac')).toBeNull();
    expect(matchHistoryShortcut({ key: 'z', metaKey: true, target: { contentEditable: 'true' } }, 'mac')).toBeNull();
    // A plain div is not editable — the canvas keeps the chord.
    expect(matchHistoryShortcut({ key: 'z', metaKey: true, target: { tagName: 'DIV' } }, 'mac')).toBe('undo');
  });

  it('isEditableTarget survives junk', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget('input')).toBe(false);
    expect(isEditableTarget({ tagName: 42 })).toBe(false);
    expect(isEditableTarget({ contentEditable: 'false' })).toBe(false);
  });
});

describe('historyMessageFor', () => {
  it('produces exactly the two typed client messages', () => {
    expect(historyMessageFor('undo')).toEqual({ t: 'canvas/undo' });
    expect(historyMessageFor('redo')).toEqual({ t: 'canvas/redo' });
  });

  it('names the chord per platform', () => {
    expect(shortcutChord('undo', 'mac')).toBe('⌘Z');
    expect(shortcutChord('redo', 'mac')).toBe('⇧⌘Z');
    expect(shortcutChord('undo', 'other')).toBe('Ctrl+Z');
    expect(shortcutChord('redo', 'other')).toBe('Ctrl+Shift+Z');
  });
});

/* ================================ labels ================================ */

describe('labels', () => {
  it('summarizes an agent turn and a named human gesture', () => {
    expect(txnSummary(txn({ author: 'agent', kinds: ['edit_page'], opCount: 4 })))
      .toBe('Mysti · edited an artboard · 4 ops');
    expect(txnSummary(txn({ author: 'user', label: 'drag', opCount: 1 }))).toBe('You · drag');
    expect(txnSummary(undefined)).toBe('');
  });

  it('names every op kind and counts the rest', () => {
    expect(kindsSummary([])).toBe('made a change');
    expect(kindsSummary(['reorder'])).toBe('reordered artboards');
    expect(kindsSummary(['edit_page', 'insert_page', 'set_theme'])).toBe('edited an artboard +2 more');
  });

  it('formats ages compactly', () => {
    const now = 10_000_000;
    expect(formatAge(now, now)).toBe('just now');
    expect(formatAge(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatAge(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatAge(now - 50 * 3_600_000, now)).toBe('2d ago');
    // Clock skew must not produce "in -3m".
    expect(formatAge(now + 60_000, now)).toBe('just now');
  });

  it('suggests a version name from the count', () => {
    expect(defaultVersionLabel(0)).toBe('Version 1');
    expect(defaultVersionLabel(7)).toBe('Version 8');
  });
});

describe('historyButtonState', () => {
  it('disables both before the host has said anything', () => {
    const state = historyButtonState(null, 'mac');
    expect(state.undoDisabled).toBe(true);
    expect(state.redoDisabled).toBe(true);
    expect(state.undoTitle).toBe('Nothing to undo (⌘Z)');
  });

  it('names what Cmd+Z would revert', () => {
    const state = historyButtonState(status({ undo: txn({ author: 'agent', kinds: ['edit_page'], opCount: 12 }) }), 'mac');
    expect(state.undoDisabled).toBe(false);
    expect(state.undoTitle).toBe('Undo Mysti · edited an artboard · 12 ops (⌘Z)');
    expect(state.redoDisabled).toBe(true);
  });

  it('enables redo only when the cursor is rewound', () => {
    const state = historyButtonState(status({ canUndo: false, canRedo: true, redo: txn({ author: 'user', label: 'drag' }) }), 'other');
    expect(state.undoDisabled).toBe(true);
    expect(state.redoDisabled).toBe(false);
    expect(state.redoTitle).toBe('Redo You · drag (Ctrl+Shift+Z)');
  });
});

/* ============================== controller ============================== */

interface Harness {
  ui: HistoryUi;
  sent: CanvasClientBody[];
  toolbar: FakeElement;
  timeline: FakeElement;
  keydown: (ev: unknown) => void;
}

function harness(opts: { platform?: HistoryPlatform; requestLabel?: (s: string) => string | null } = {}): Harness {
  const doc = new FakeDocument();
  const toolbar = new FakeElement('div');
  const timeline = new FakeElement('div');
  const listeners: Array<(ev: unknown) => void> = [];
  const env: CanvasEnv = {
    doc: doc as unknown as CanvasEnv['doc'],
    self: { addEventListener: (_t, l) => { listeners.push(l); } },
    createIntersectionObserver: null,
    createMessageChannel: () => new FakeChannel() as unknown as ReturnType<CanvasEnv['createMessageChannel']>,
    fetchText: async () => '',
    now: () => 0,
    warn: () => { /* silent */ },
  };
  const sent: CanvasClientBody[] = [];
  const ui = new HistoryUi({
    env,
    send: body => sent.push(body),
    toolbar: toolbar as unknown as DomElement,
    timeline: timeline as unknown as DomElement,
    platform: opts.platform ?? 'mac',
    requestLabel: opts.requestLabel,
  });
  return { ui, sent, toolbar, timeline, keydown: ev => listeners.forEach(l => l(ev)) };
}

describe('HistoryUi', () => {
  it('builds undo / redo / save-version and starts disabled', () => {
    const h = harness();
    expect(h.toolbar.children.map(c => c.className)).toEqual([
      'history-btn undo', 'history-btn redo', 'history-btn save', 'history-last',
    ]);
    expect(h.toolbar.children[0].attrs.get('disabled')).toBe('true');
    expect(h.toolbar.children[1].attrs.get('aria-disabled')).toBe('true');
  });

  it('mirrors the host snapshot into the button states', () => {
    const h = harness();
    h.ui.setStatus(status({ canUndo: true, canRedo: true, redo: txn() }));
    expect(h.toolbar.children[0].attrs.get('disabled')).toBeUndefined();
    expect(h.toolbar.children[1].attrs.get('disabled')).toBeUndefined();
    h.ui.setStatus(status({ canUndo: false, canRedo: false }));
    expect(h.toolbar.children[0].attrs.get('disabled')).toBe('true');
    expect(h.toolbar.children[1].attrs.get('disabled')).toBe('true');
  });

  it('a disabled button sends nothing', () => {
    const h = harness();
    h.ui.setStatus(status({ canUndo: false, canRedo: false }));
    h.toolbar.children[0].fire('click');
    h.toolbar.children[1].fire('click');
    expect(h.sent).toEqual([]);
  });

  it('an enabled button sends the typed message', () => {
    const h = harness();
    h.ui.setStatus(status({ canUndo: true, canRedo: true, redo: txn() }));
    h.toolbar.children[0].fire('click');
    h.toolbar.children[1].fire('click');
    expect(h.sent).toEqual([{ t: 'canvas/undo' }, { t: 'canvas/redo' }]);
  });

  it('Cmd+Z on the window sends canvas/undo and consumes the event', () => {
    const h = harness({ platform: 'mac' });
    h.ui.setStatus(status({ canUndo: true }));
    let prevented = 0;
    h.keydown({ key: 'z', metaKey: true, preventDefault: () => { prevented++; } });
    expect(h.sent).toEqual([{ t: 'canvas/undo' }]);
    expect(prevented).toBe(1);
  });

  it('sends BEFORE the first status push — a swallowed Cmd+Z reads as broken undo', () => {
    const h = harness({ platform: 'mac' });
    expect(h.ui.status()).toBeNull();
    expect(h.ui.handleKey({ key: 'z', metaKey: true })).toBe('undo');
    expect(h.sent).toEqual([{ t: 'canvas/undo' }]);
  });

  it('consumes the chord but sends nothing when the stack is known-empty', () => {
    const h = harness({ platform: 'mac' });
    h.ui.setStatus(status({ canUndo: false, canRedo: false }));
    let prevented = 0;
    expect(h.ui.handleKey({ key: 'z', metaKey: true, preventDefault: () => { prevented++; } })).toBeNull();
    expect(h.sent).toEqual([]);
    expect(prevented).toBe(1);
  });

  it('ignores the chord while a text field has focus', () => {
    const h = harness({ platform: 'mac' });
    h.ui.setStatus(status({ canUndo: true }));
    h.keydown({ key: 'z', metaKey: true, target: { tagName: 'INPUT' } });
    expect(h.sent).toEqual([]);
  });

  it('uses the platform the host reported', () => {
    const h = harness({ platform: 'other' });
    h.ui.setStatus(status({ canUndo: true }));
    h.keydown({ key: 'z', metaKey: true });          // mac chord on Windows
    expect(h.sent).toEqual([]);
    h.keydown({ key: 'z', ctrlKey: true });
    expect(h.sent).toEqual([{ t: 'canvas/undo' }]);
  });

  it('goes inert after dispose', () => {
    const h = harness();
    h.ui.setStatus(status({ canUndo: true }));
    h.ui.dispose();
    h.keydown({ key: 'z', metaKey: true });
    h.toolbar.children[0].fire('click');
    expect(h.sent).toEqual([]);
  });

  /* ------------------------------ timeline ------------------------------ */

  it('shows an empty-state until a version exists', () => {
    const h = harness();
    expect(h.timeline.allText()).toContain('No saved versions yet');
    h.ui.setStatus(status({ versions: [version()] }));
    expect(h.timeline.allText()).not.toContain('No saved versions yet');
  });

  it('lists versions newest-first with a parent-drawn thumbnail', () => {
    const h = harness();
    h.ui.setStatus(status({
      versions: [version({ id: 'v1', label: 'First' }), version({ id: 'v2', label: 'Second' })],
    }));
    const rows = h.timeline.children;
    expect(rows.map(r => r.attrs.get('data-ref'))).toEqual(['v2', 'v1']);
    // The thumbnail is DRAWN from the checkpoint's doc — no iframe, no
    // rasterization, and (since FakeElement.innerHTML throws) no innerHTML.
    expect(rows[0].allText()).toContain('Sign in');
    expect(rows[0].allText()).toContain('2 artboards');
  });

  it('degrades to a placeholder when a checkpoint carried no thumbnail', () => {
    const h = harness();
    h.ui.setStatus(status({ versions: [version({ thumbDoc: undefined, thumbFormat: undefined, pageCount: 0 })] }));
    const thumb = h.timeline.children[0].children[0];
    expect(thumb.className).toBe('version-thumb empty');
    expect(h.timeline.allText()).toContain('0 artboards');
  });

  it('Restore sends canvas/restore — the host replays it as ops, it is not a local mutation', () => {
    const h = harness();
    const before = version({ id: 'v9', label: 'Before rebrand' });
    h.ui.setStatus(status({ versions: [before] }));
    const restore = h.timeline.children[0].find(el => el.className === 'version-restore')!;
    restore.fire('click');
    expect(h.sent).toEqual([{ t: 'canvas/restore', ref: 'v9' }]);
    // Nothing about the client's own status changed: the host is the authority.
    expect(h.ui.status()?.versions).toEqual([before]);
  });

  it('refuses an empty restore ref', () => {
    const h = harness();
    h.ui.restore('');
    expect(h.sent).toEqual([]);
  });

  /* ----------------------------- checkpoints ----------------------------- */

  it('Save version asks for a name and sends canvas/checkpoint', () => {
    const h = harness({ requestLabel: s => `${s} — pre-rebrand` });
    h.ui.setStatus(status({ versions: [version()] }));
    h.toolbar.children[2].fire('click');
    expect(h.sent).toEqual([{ t: 'canvas/checkpoint', label: 'Version 2 — pre-rebrand' }]);
  });

  it('a cancelled name saves nothing', () => {
    const h = harness({ requestLabel: () => null });
    h.toolbar.children[2].fire('click');
    expect(h.sent).toEqual([]);
  });

  it('falls back to the suggestion for a blank name and clamps a long one', () => {
    const blank = harness({ requestLabel: () => '   ' });
    blank.toolbar.children[2].fire('click');
    expect(blank.sent).toEqual([{ t: 'canvas/checkpoint', label: 'Version 1' }]);

    const long = harness({ requestLabel: () => 'x'.repeat(500) });
    long.toolbar.children[2].fire('click');
    const label = (long.sent[0] as { label: string }).label;
    expect(label).toHaveLength(120);
  });
});
