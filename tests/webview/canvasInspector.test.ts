/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 §4 row 3 — the panel itself, driven through the fake DOM.
 *
 * The headline regression guard is the first test: today's shell contains
 * **zero `<input>` elements** and the op it would have written had zero
 * renderers, so "there are real form controls, and touching one produces a real
 * `CanvasOp`" is the whole point of the row.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CUSTOM_SENTINEL,
  InspectorPanel,
  MIXED_SENTINEL,
  UNSET_SENTINEL,
  type InspectorSelection,
} from '../../src/webview/canvas/inspector';
import type { OpSubmission, UnpinIntent } from '../../src/webview/canvas/controls';
import type { CanvasEnv, DomDocument, DomElement, MessageChannelLike } from '../../src/webview/canvas/dom';
import { FakeChannel, FakeDocument, FakeElement } from './canvasFakeDom';
import type { DocNode } from '../../src/canvas/doc/DocNode';
import type { DesignTheme } from '../../src/types';
import { getThemePreset } from '../../src/managers/CanvasThemePresets';
import { themeTokenMap } from '../../src/managers/CanvasSandbox';

const THEME: DesignTheme = getThemePreset('clean-saas')!.theme;

interface Rig {
  panel: InspectorPanel;
  host: FakeElement;
  submitted: OpSubmission[];
  unpinned: UnpinIntent[];
  textEdits: Array<{ pageId: string; mid: string }>;
  tick(ms: number): void;
}

function rig(opts: { throttleMs?: number } = {}): Rig {
  const doc = new FakeDocument();
  const host = new FakeElement('div');
  const submitted: OpSubmission[] = [];
  const unpinned: UnpinIntent[] = [];
  const textEdits: Array<{ pageId: string; mid: string }> = [];
  let clock = 0;
  let n = 0;
  const env: CanvasEnv = {
    doc: doc as unknown as DomDocument,
    self: { addEventListener: () => { /* unused */ } },
    createIntersectionObserver: null,
    createMessageChannel: () => new FakeChannel() as unknown as MessageChannelLike,
    fetchText: async () => '',
    now: () => clock,
    warn: () => { /* silent */ },
  };
  const panel = new InspectorPanel({
    env,
    host: host as unknown as DomElement,
    throttleMs: opts.throttleMs ?? 0,
    newTxnId: () => `txn-${n++}`,
    callbacks: {
      submit: s => submitted.push(s),
      unpin: i => unpinned.push(i),
      beginTextEdit: (pageId, mid) => textEdits.push({ pageId, mid }),
    },
  });
  return { panel, host, submitted, unpinned, textEdits, tick: ms => { clock += ms; } };
}

function row(host: FakeElement, id: string): FakeElement {
  const found = host.find(el => el.attrs.get('data-control') === id);
  if (!found) { throw new Error(`no control row for ${id}`); }
  return found;
}

function widget(host: FakeElement, id: string, tag: string): FakeElement {
  const found = row(host, id).find(el => el.tag === tag);
  if (!found) { throw new Error(`no <${tag}> in ${id}`); }
  return found;
}

function optionValues(select: FakeElement): string[] {
  return select.children.filter(c => c.tag === 'option').map(o => o.value);
}

function button(host: FakeElement, className: string): FakeElement | null {
  return host.find(el => el.tag === 'button' && el.className === className);
}

const BUTTON_NODE: DocNode = {
  mid: 'aaaaaaaaaa', tag: 'UI.Button',
  props: { label: 'Sign in', variant: 'primary' },
  text: 'Sign in',
};

function selection(over: Partial<InspectorSelection> = {}): InspectorSelection {
  return {
    pageId: 'p1',
    mids: [BUTTON_NODE.mid],
    nodes: [BUTTON_NODE],
    theme: THEME,
    ...over,
  };
}

/* ───────────────────────── the row-3 regression guard ───────────────────────── */

describe('the panel has real controls', () => {
  it('renders actual form elements — not five spans and nine inert swatches', () => {
    const r = rig();
    r.panel.render(selection());
    const inputs = r.host.findAll(el => el.tag === 'input');
    const selects = r.host.findAll(el => el.tag === 'select');
    expect(inputs.length).toBeGreaterThan(5);
    expect(selects.length).toBeGreaterThan(2);
    // Every row is addressable by its control id, and every control the model
    // generated has a row.
    for (const control of r.panel.model.sections.flatMap(s => s.controls)) {
      expect(row(r.host, control.id)).toBeTruthy();
    }
  });

  it('painting the panel writes NOTHING — rendering is not an edit', () => {
    const r = rig();
    r.panel.render(selection());
    r.panel.render(selection());
    expect(r.submitted).toEqual([]);
  });

  it('says so plainly when nothing is selected', () => {
    const r = rig();
    r.panel.render({ pageId: 'p1', mids: [], nodes: [] });
    expect(r.host.allText()).toContain('Select an element');
    expect(r.host.findAll(el => el.tag === 'input')).toHaveLength(0);
  });

  it('degrades honestly on a legacy code page', () => {
    const r = rig();
    r.panel.render(selection({ legacy: true }));
    expect(r.host.allText()).toContain('Code page');
    expect(r.host.findAll(el => el.tag === 'input')).toHaveLength(0);
  });

  it('names slots instead of pretending a subtree is a field', () => {
    const r = rig();
    const listRow: DocNode = { mid: 'bbbbbbbbbb', tag: 'UI.ListRow', props: { title: 'Row' } };
    r.panel.render(selection({ mids: [listRow.mid], nodes: [listRow] }));
    expect(r.host.allText()).toContain('Slots: leading, trailing');
    expect(r.host.find(el => el.attrs.get('data-control') === 'prop:trailing')).toBeNull();
  });
});

/* ──────────────────────── every control has a NAME ──────────────────────── */

describe('every control announces itself (A11Y-5)', () => {
  /** Every control the model generated, across a few different selections. */
  function everyRow(r: Rig, sel: InspectorSelection): Array<{ id: string; label: string; row: FakeElement }> {
    r.panel.render(sel);
    return r.panel.model.sections.flatMap(s => s.controls).map(c => ({
      id: c.id, label: c.label, row: row(r.host, c.id),
    }));
  }

  it('binds the visible label to the widget, with a unique id, on every row', () => {
    // Before: `_row` appended `<label class="ctl-label">` as a SIBLING of the
    // widget (which lives one level deeper, inside `.ctl-body`) with no `for`,
    // and `_input` set no aria-label — so there was neither an implicit nor an
    // explicit association anywhere in the panel. A screen reader announced
    // "edit text, blank" / "slider, 16" / "combo box" / "button, Off" for every
    // property, and clicking a label focused nothing.
    const r = rig();
    const seen = new Set<string>();
    const cases: InspectorSelection[] = [
      selection(),
      selection({ mids: ['cccccccccc'], nodes: [{ mid: 'cccccccccc', tag: 'UI.Text', text: 'Body' }] }),
      selection({ mids: ['dddddddddd'], nodes: [{ mid: 'dddddddddd', tag: 'UI.Card' }] }),
    ];
    let checked = 0;
    for (const sel of cases) {
      for (const { id, row: rowEl } of everyRow(r, sel)) {
        const label = rowEl.find(el => el.className === 'ctl-label');
        expect(label, `no .ctl-label in ${id}`).toBeTruthy();
        const forId = label!.attrs.get('for');
        expect(forId, `<label for> missing on ${id}`).toBeTruthy();
        const target = rowEl.find(el => el.attrs.get('id') === forId);
        expect(target, `<label for="${forId}"> points at nothing in ${id}`).toBeTruthy();
        expect(['input', 'textarea', 'select', 'button'], `${id} labels a <${target!.tag}>`)
          .toContain(target!.tag);
        expect(seen.has(forId!), `duplicate control id ${forId}`).toBe(false);
        seen.add(forId!);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('names a boolean toggle after the property, keeping On/Off as its state', () => {
    const r = rig();
    const textNode: DocNode = { mid: 'cccccccccc', tag: 'UI.Text', text: 'Body' };
    r.panel.render(selection({ mids: [textNode.mid], nodes: [textNode] }));
    const control = r.panel.model.sections.flatMap(s => s.controls).find(c => c.id === 'prop:muted')!;
    const toggle = widget(r.host, 'prop:muted', 'button');
    // "Off" is the state, not the name: three toggles all called "Off" are
    // indistinguishable, which is what a screen reader used to hear.
    expect(toggle.attrs.get('aria-label')).toBe(control.label);
    expect(toggle.textContent).toBe('Off');
    expect(toggle.attrs.get('aria-pressed')).toBe('false');
  });

  it('names the raw escape-hatch field of a colour control', () => {
    const r = rig();
    r.panel.render(selection());
    const token = row(r.host, 'style:color').find(el => el.className.includes('ctl-raw'));
    expect(token, 'no raw field on the colour control').toBeTruthy();
    const control = r.panel.model.sections.flatMap(s => s.controls).find(c => c.id === 'style:color')!;
    expect(token!.attrs.get('aria-label') ?? '').toContain(control.label);
  });
});

/* ─────────────────────────── controls emit ops ─────────────────────────── */

describe('every control emits the agent-identical op', () => {
  it('a select writes el.setProp', () => {
    const r = rig();
    r.panel.render(selection());
    const select = widget(r.host, 'prop:variant', 'select');
    select.value = 'secondary';
    select.fire('change');
    expect(r.submitted).toEqual([{
      txnId: 'txn-0',
      ops: [{ op: 'el.setProp', pageId: 'p1', mid: 'aaaaaaaaaa', name: 'variant', value: 'secondary' }],
    }]);
  });

  it('a text field writes el.setProp', () => {
    const r = rig();
    r.panel.render(selection());
    const input = widget(r.host, 'prop:label', 'input');
    input.value = 'Get started';
    input.fire('change');
    expect(r.submitted[0].ops).toEqual([
      { op: 'el.setProp', pageId: 'p1', mid: 'aaaaaaaaaa', name: 'label', value: 'Get started' },
    ]);
  });

  it('the content field writes el.setText', () => {
    const r = rig();
    r.panel.render(selection());
    const area = widget(r.host, 'text', 'textarea');
    area.value = 'Continue';
    area.fire('change');
    expect(r.submitted[0].ops).toEqual([
      { op: 'el.setText', pageId: 'p1', mid: 'aaaaaaaaaa', text: 'Continue' },
    ]);
  });

  it('a boolean renders a toggle and writes el.setProp', () => {
    const r = rig();
    const textNode: DocNode = { mid: 'cccccccccc', tag: 'UI.Text', text: 'Body' };
    r.panel.render(selection({ mids: [textNode.mid], nodes: [textNode] }));
    const toggle = widget(r.host, 'prop:muted', 'button');
    expect(toggle.attrs.get('aria-pressed')).toBe('false');
    toggle.fire('click');
    expect(r.submitted[0].ops).toEqual([
      { op: 'el.setProp', pageId: 'p1', mid: 'cccccccccc', name: 'muted', value: true },
    ]);
  });

  it('a length field composes the unit and writes el.setStyle', () => {
    const r = rig();
    r.panel.render(selection());
    const input = widget(r.host, 'style:width', 'input');
    input.value = '240';
    input.fire('change');
    expect(r.submitted[0].ops).toEqual([
      { op: 'el.setStyle', pageId: 'p1', mid: 'aaaaaaaaaa', style: { width: '240px' } },
    ]);
  });

  it('the clear button writes the CLEAR form of the op', () => {
    const r = rig();
    r.panel.render(selection());
    const clear = row(r.host, 'prop:label').find(el => el.className === 'ctl-clear');
    expect(clear).toBeTruthy();
    clear!.fire('click');
    expect(r.submitted[0].ops).toEqual([
      { op: 'el.setProp', pageId: 'p1', mid: 'aaaaaaaaaa', name: 'label', value: null },
    ]);
  });

  it('offers no clear button for a value nobody has set', () => {
    const r = rig();
    r.panel.render(selection());
    expect(row(r.host, 'style:background').find(el => el.className === 'ctl-clear')).toBeNull();
    expect(row(r.host, 'style:background').attrs.get('data-state')).toBe('unset');
  });

  it('a rejected value produces no op at all', () => {
    const r = rig();
    r.panel.render(selection());
    const input = widget(r.host, 'style:background', 'input');   // the raw escape hatch
    input.value = 'url(https://evil/x.png)';
    input.fire('change');
    expect(r.submitted).toEqual([]);
  });

  it('writes one op per selected element', () => {
    const r = rig();
    const second: DocNode = { mid: 'bbbbbbbbbb', tag: 'UI.Button', props: { label: 'Sign in' } };
    r.panel.render(selection({ mids: ['aaaaaaaaaa', 'bbbbbbbbbb'], nodes: [BUTTON_NODE, second] }));
    const input = widget(r.host, 'prop:label', 'input');
    input.value = 'Both';
    input.fire('change');
    expect(r.submitted[0].ops).toHaveLength(2);
    expect(r.submitted[0].ops.every(o => o.op === 'el.setProp')).toBe(true);
  });

  it('refuses to write when no artboard owns the selection', () => {
    const r = rig();
    r.panel.render(selection({ pageId: null }));
    expect(r.host.allText()).toContain('Select an element');
    expect(r.submitted).toEqual([]);
  });
});

/* ──────────────────────────── mixed values ──────────────────────────── */

describe('mixed values write only on an explicit change', () => {
  const a: DocNode = { mid: 'aaaaaaaaaa', tag: 'UI.Button', props: { variant: 'primary', label: 'A' } };
  const b: DocNode = { mid: 'bbbbbbbbbb', tag: 'UI.Button', props: { variant: 'ghost', label: 'B' } };

  it('shows Mixed and selects it, without emitting anything', () => {
    const r = rig();
    r.panel.render(selection({ mids: [a.mid, b.mid], nodes: [a, b] }));
    const select = widget(r.host, 'prop:variant', 'select');
    expect(optionValues(select)[0]).toBe(MIXED_SENTINEL);
    expect(select.value).toBe(MIXED_SENTINEL);
    expect(row(r.host, 'prop:variant').attrs.get('data-state')).toBe('mixed');
    expect(r.submitted).toEqual([]);
  });

  it('re-selecting "Mixed" is not an edit', () => {
    const r = rig();
    r.panel.render(selection({ mids: [a.mid, b.mid], nodes: [a, b] }));
    const select = widget(r.host, 'prop:variant', 'select');
    select.value = MIXED_SENTINEL;
    select.fire('change');
    expect(r.submitted).toEqual([]);
  });

  it('choosing a real option writes it to every element', () => {
    const r = rig();
    r.panel.render(selection({ mids: [a.mid, b.mid], nodes: [a, b] }));
    const select = widget(r.host, 'prop:variant', 'select');
    select.value = 'secondary';
    select.fire('change');
    expect(r.submitted[0].ops).toEqual([
      { op: 'el.setProp', pageId: 'p1', mid: 'aaaaaaaaaa', name: 'variant', value: 'secondary' },
      { op: 'el.setProp', pageId: 'p1', mid: 'bbbbbbbbbb', name: 'variant', value: 'secondary' },
    ]);
  });

  it('a mixed text field shows a Mixed placeholder and an empty box', () => {
    const r = rig();
    r.panel.render(selection({ mids: [a.mid, b.mid], nodes: [a, b] }));
    const input = widget(r.host, 'prop:label', 'input');
    expect(input.attrs.get('placeholder')).toBe('Mixed');
    expect(input.value).toBe('');
  });

  it('"Default" clears the cell on every element', () => {
    const r = rig();
    r.panel.render(selection({ mids: [a.mid, b.mid], nodes: [a, b] }));
    const select = widget(r.host, 'prop:variant', 'select');
    select.value = UNSET_SENTINEL;
    select.fire('change');
    expect(r.submitted[0].ops.every(o => o.op === 'el.setProp' && o.value === null)).toBe(true);
  });
});

/* ─────────────────────── tokens first, raw as escape ─────────────────────── */

describe('colour controls offer theme tokens first', () => {
  it('lists every theme token, then Custom, and no raw field until asked', () => {
    const r = rig();
    r.panel.render(selection());
    const select = widget(r.host, 'style:background', 'select');
    const values = optionValues(select);
    expect(values[0]).toBe(UNSET_SENTINEL);
    expect(values[1]).toBe('var(--theme-color-primary)');
    expect(values[values.length - 1]).toBe(CUSTOM_SENTINEL);
    const raw = widget(r.host, 'style:background', 'input');
    expect(raw.hidden).toBe(true);
  });

  it('picking a token writes the var(), never a hex', () => {
    const r = rig();
    r.panel.render(selection());
    const select = widget(r.host, 'style:background', 'select');
    select.value = 'var(--theme-color-surface)';
    select.fire('change');
    expect(r.submitted[0].ops).toEqual([
      { op: 'el.setStyle', pageId: 'p1', mid: 'aaaaaaaaaa', style: { background: 'var(--theme-color-surface)' } },
    ]);
  });

  it('choosing Custom reveals the raw field and writes nothing by itself', () => {
    const r = rig();
    r.panel.render(selection());
    const select = widget(r.host, 'style:background', 'select');
    const raw = widget(r.host, 'style:background', 'input');
    select.value = CUSTOM_SENTINEL;
    select.fire('change');
    expect(raw.hidden).toBe(false);
    expect(r.submitted).toEqual([]);
  });

  it('a raw value the theme already names is SNAPPED back to the token', () => {
    const r = rig();
    r.panel.render(selection());
    const raw = widget(r.host, 'style:background', 'input');
    raw.value = themeTokenMap(THEME)['color-primary'];
    raw.fire('change');
    expect(r.submitted[0].ops).toEqual([
      { op: 'el.setStyle', pageId: 'p1', mid: 'aaaaaaaaaa', style: { background: 'var(--theme-color-primary)' } },
    ]);
  });

  it('a genuinely off-palette colour is allowed through the escape hatch', () => {
    const r = rig();
    r.panel.render(selection());
    const raw = widget(r.host, 'style:background', 'input');
    raw.value = '#123456';
    raw.fire('change');
    expect(r.submitted[0].ops).toEqual([
      { op: 'el.setStyle', pageId: 'p1', mid: 'aaaaaaaaaa', style: { background: '#123456' } },
    ]);
  });

  it('paints the swatch from the theme, through the style sanitizer', () => {
    const r = rig();
    const node: DocNode = { ...BUTTON_NODE, style: { background: 'var(--theme-color-primary)' } };
    r.panel.render(selection({ nodes: [node] }));
    const swatch = row(r.host, 'style:background').find(el => el.className === 'ctl-swatch')!;
    expect(swatch.style.get('background')).toBe(themeTokenMap(THEME)['color-primary']);
  });

  it('refuses to paint a swatch from a hostile theme value', () => {
    const hostile: DesignTheme = {
      ...THEME,
      colors: { ...THEME.colors, primary: 'url(https://evil/beacon.png)' },
    };
    const r = rig();
    const node: DocNode = { ...BUTTON_NODE, style: { background: 'var(--theme-color-primary)' } };
    r.panel.render(selection({ nodes: [node], theme: hostile }));
    const swatch = row(r.host, 'style:background').find(el => el.className === 'ctl-swatch')!;
    expect(swatch.style.get('background')).toBeUndefined();
  });
});

/* ───────────────────────── drag coalescing ───────────────────────── */

describe('a slider drag is one undo step', () => {
  const stack: DocNode = { mid: 'aaaaaaaaaa', tag: 'UI.Stack', props: { gap: 12 } };

  it('renders a range for a bounded number and keeps 40 frames in ONE txn', () => {
    const r = rig({ throttleMs: 0 });
    r.panel.render(selection({ mids: [stack.mid], nodes: [stack] }));
    const slider = widget(r.host, 'prop:gap', 'input');
    expect(slider.attrs.get('type')).toBe('range');
    expect(slider.attrs.get('min')).toBe('0');
    expect(slider.attrs.get('max')).toBe('160');

    for (let i = 0; i < 40; i++) {
      slider.value = String(i);
      slider.fire('input');
      r.tick(16);
    }
    expect(r.panel.gestureActive).toBe(true);
    slider.value = '40';
    slider.fire('change');

    expect(r.submitted.length).toBeGreaterThan(1);
    expect(new Set(r.submitted.map(s => s.txnId)).size).toBe(1);
    expect(r.submitted[r.submitted.length - 1].ops).toEqual([
      { op: 'el.setProp', pageId: 'p1', mid: 'aaaaaaaaaa', name: 'gap', value: 40 },
    ]);
    expect(r.panel.gestureActive).toBe(false);
  });

  it('throttles the middle of the drag', () => {
    const r = rig({ throttleMs: 100 });
    r.panel.render(selection({ mids: [stack.mid], nodes: [stack] }));
    const slider = widget(r.host, 'prop:gap', 'input');
    for (let i = 0; i < 40; i++) { slider.value = String(i); slider.fire('input'); r.tick(16); }
    slider.value = '40';
    slider.fire('change');
    expect(r.submitted.length).toBeLessThan(12);
    expect(new Set(r.submitted.map(s => s.txnId)).size).toBe(1);
  });

  it('two separate drags are two undo steps', () => {
    const r = rig({ throttleMs: 0 });
    r.panel.render(selection({ mids: [stack.mid], nodes: [stack] }));
    const slider = widget(r.host, 'prop:gap', 'input');
    slider.value = '20'; slider.fire('input'); slider.fire('change');
    slider.value = '30'; slider.fire('input'); slider.fire('change');
    expect(new Set(r.submitted.map(s => s.txnId)).size).toBe(2);
  });

  it('a re-render arriving mid-drag is DEFERRED, not applied under the pointer', () => {
    const r = rig({ throttleMs: 0 });
    r.panel.render(selection({ mids: [stack.mid], nodes: [stack] }));
    const slider = widget(r.host, 'prop:gap', 'input');
    slider.value = '25';
    slider.fire('input');

    // The op round-trips as `canvas/ops`, and the app re-renders the panel.
    const updated: DocNode = { mid: 'aaaaaaaaaa', tag: 'UI.Stack', props: { gap: 25 } };
    r.panel.render(selection({ mids: [updated.mid], nodes: [updated] }));
    expect(widget(r.host, 'prop:gap', 'input')).toBe(slider);   // same element: not rebuilt

    slider.value = '25';
    slider.fire('change');
    // Now it lands, and the fresh element reflects the committed value.
    expect(widget(r.host, 'prop:gap', 'input')).not.toBe(slider);
    expect(widget(r.host, 'prop:gap', 'input').value).toBe('25');
  });

  it('an unbounded number renders a plain number field, committed on change', () => {
    const r = rig();
    const heading: DocNode = { mid: 'aaaaaaaaaa', tag: 'UI.Heading', text: 'Hi' };
    r.panel.render(selection({ mids: [heading.mid], nodes: [heading] }));
    const lineHeight = widget(r.host, 'style:line-height', 'input');
    expect(lineHeight.attrs.get('type')).toBe('range');   // bounded by the schema
    const flex = widget(r.host, 'style:flex', 'input');
    expect(flex.attrs.get('type')).toBe('text');
  });
});

/* ──────────────────────────────── pins ──────────────────────────────── */

describe('pins are visible and releasable', () => {
  const pinned: DocNode = {
    mid: 'aaaaaaaaaa', tag: 'UI.Button',
    style: { background: '#123456' },
    props: { label: 'Mine' },
    pins: { 'style.background': { at: 1, opId: 'op-1' } },
  };

  it('marks the pinned row and offers an unpin dot', () => {
    const r = rig();
    r.panel.render(selection({ nodes: [pinned] }));
    const bg = row(r.host, 'style:background');
    expect(bg.attrs.get('data-pinned')).toBe('true');
    const dot = bg.find(el => el.className === 'ctl-pin')!;
    expect(dot.attrs.get('data-cell')).toBe('style.background');
    dot.fire('click');
    expect(r.unpinned).toEqual([{
      pageId: 'p1',
      scope: 'cell',
      targets: [{ mid: 'aaaaaaaaaa', cells: ['style.background'] }],
    }]);
  });

  it('leaves unpinned rows alone', () => {
    const r = rig();
    r.panel.render(selection({ nodes: [pinned] }));
    expect(row(r.host, 'prop:label').attrs.get('data-pinned')).toBeUndefined();
    expect(row(r.host, 'prop:label').find(el => el.className === 'ctl-pin')).toBeNull();
  });

  it('summarizes the selection\'s pins in the header', () => {
    const r = rig();
    r.panel.render(selection({ nodes: [pinned] }));
    const chip = button(r.host, 'insp-unpin-node')!;
    expect(chip.textContent).toContain('1 pinned change');
    chip.fire('click');
    expect(r.unpinned[0].scope).toBe('node');
  });

  it('"let the agent restyle everything" releases style pins across the artboard', () => {
    const doc: DocNode = {
      mid: 'rrrrrrrrrr', tag: 'UI.Screen',
      children: [
        pinned,
        { mid: 'cccccccccc', tag: 'UI.Heading', text: 'Copy', pins: { text: { at: 2, opId: 'op-2' } } },
      ],
    };
    const r = rig();
    r.panel.render(selection({ nodes: [pinned], doc }));
    const bulk = button(r.host, 'insp-restyle')!;
    bulk.fire('click');
    expect(r.unpinned).toEqual([{
      pageId: 'p1',
      scope: 'page-styles',
      // The hand-written copy stays pinned: a rebrand must not rewrite words.
      targets: [{ mid: 'aaaaaaaaaa', cells: ['style.background'] }],
    }]);
  });

  it('hides the bulk release when the artboard has no style pins', () => {
    const doc: DocNode = { mid: 'rrrrrrrrrr', tag: 'UI.Screen', children: [BUTTON_NODE] };
    const r = rig();
    r.panel.render(selection({ doc }));
    expect(button(r.host, 'insp-restyle')).toBeNull();
    expect(button(r.host, 'insp-unpin-node')).toBeNull();
  });
});

/* ─────────────────────────── header + text hand-off ─────────────────────────── */

describe('header and canvas hand-off', () => {
  it('names the tag for a single selection and the count for a mixed one', () => {
    const r = rig();
    r.panel.render(selection());
    expect(r.host.find(el => el.className === 'insp-title')!.textContent).toBe('UI.Button');

    const card: DocNode = { mid: 'bbbbbbbbbb', tag: 'UI.Card' };
    r.panel.render(selection({ mids: ['aaaaaaaaaa', 'bbbbbbbbbb'], nodes: [BUTTON_NODE, card] }));
    expect(r.host.find(el => el.className === 'insp-title')!.textContent).toBe('2 elements');
  });

  it('hands a single text selection to the canvas rather than the panel', () => {
    const r = rig();
    r.panel.render(selection());
    const onCanvas = button(r.host, 'ctl-edit-canvas')!;
    onCanvas.fire('click');
    expect(r.textEdits).toEqual([{ pageId: 'p1', mid: 'aaaaaaaaaa' }]);
  });

  it('dispose empties the panel and abandons any gesture', () => {
    const r = rig({ throttleMs: 1000 });
    r.panel.render(selection());
    r.panel.dispose();
    expect(r.host.children).toHaveLength(0);
    r.panel.render(selection());
    expect(r.host.children).toHaveLength(0);
  });

  it('never touches innerHTML', () => {
    // FakeElement throws on innerHTML in both directions; a full paint over
    // every primitive would trip it if any code path reached for it.
    const r = rig();
    for (const tag of ['UI.Button', 'UI.Chart', 'UI.TabBar', 'UI.AppShell', 'div', 'h1']) {
      expect(() => r.panel.render(selection({
        mids: ['aaaaaaaaaa'],
        nodes: [{ mid: 'aaaaaaaaaa', tag }],
      }))).not.toThrow();
    }
  });
});

describe('json controls', () => {
  const chart: DocNode = { mid: 'aaaaaaaaaa', tag: 'UI.Chart', props: { data: [{ label: 'Jan', value: 3 }] } };

  it('round-trips a structured literal', () => {
    const r = rig();
    r.panel.render(selection({ mids: [chart.mid], nodes: [chart] }));
    const area = widget(r.host, 'prop:data', 'textarea');
    expect(JSON.parse(area.value)).toEqual([{ label: 'Jan', value: 3 }]);
    area.value = '[{"label":"Feb","value":9}]';
    area.fire('change');
    expect(r.submitted[0].ops).toEqual([
      { op: 'el.setProp', pageId: 'p1', mid: 'aaaaaaaaaa', name: 'data', value: [{ label: 'Feb', value: 9 }] },
    ]);
  });

  it('marks malformed json invalid instead of writing garbage', () => {
    const r = rig();
    r.panel.render(selection({ mids: [chart.mid], nodes: [chart] }));
    const area = widget(r.host, 'prop:data', 'textarea');
    area.value = '[{"label":';
    area.fire('change');
    expect(r.submitted).toEqual([]);
    expect(row(r.host, 'prop:data').attrs.get('data-invalid')).toBe('true');
  });
});

describe('warnings are not thrown', () => {
  it('an unpin with no page is dropped rather than crashing', () => {
    const unpin = vi.fn();
    const doc = new FakeDocument();
    const host = new FakeElement('div');
    const panel = new InspectorPanel({
      env: {
        doc: doc as unknown as DomDocument,
        self: { addEventListener: () => { /* unused */ } },
        createIntersectionObserver: null,
        createMessageChannel: () => new FakeChannel() as unknown as MessageChannelLike,
        fetchText: async () => '',
        now: () => 0,
        warn: () => { /* silent */ },
      },
      host: host as unknown as DomElement,
      callbacks: { submit: () => { /* noop */ }, unpin },
    });
    panel.render({ pageId: null, mids: [], nodes: [] });
    expect(unpin).not.toHaveBeenCalled();
  });
});

describe('a value the enum no longer lists', () => {
  it('is surfaced rather than silently reading as unset', () => {
    // An agent (or an older schema) can leave `variant: "brand"` behind. A
    // <select> whose value matches no <option> reads as blank in a real DOM.
    const legacyValue: DocNode = { mid: 'aaaaaaaaaa', tag: 'UI.Button', props: { variant: 'brand' } };
    const r = rig();
    r.panel.render(selection({ nodes: [legacyValue] }));
    const select = widget(r.host, 'prop:variant', 'select');
    expect(optionValues(select)).toContain('brand');
    expect(select.value).toBe('brand');
    // …and it is still replaceable by a declared one.
    select.value = 'ghost';
    select.fire('change');
    expect(r.submitted[0].ops).toEqual([
      { op: 'el.setProp', pageId: 'p1', mid: 'aaaaaaaaaa', name: 'variant', value: 'ghost' },
    ]);
  });

  it('but the panel still refuses to WRITE an undeclared value', () => {
    const r = rig();
    r.panel.render(selection());
    const select = widget(r.host, 'prop:variant', 'select');
    select.value = 'invented';
    select.fire('change');
    expect(r.submitted).toEqual([]);
  });
});
