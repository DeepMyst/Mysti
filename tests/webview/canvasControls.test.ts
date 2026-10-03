/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 §4 row 3 — the properties panel's decisions, tested where they live.
 *
 * The panel is DOM; its decisions are not. What is asserted here is the part
 * that can actually be wrong:
 *
 * 1. controls are generated from `UiSchema` for every one of the 22 primitives,
 *    and a control never exists for a cell the schema does not declare;
 * 2. a multi-selection shows the INTERSECTION, and a disagreeing value reads as
 *    `mixed` rather than silently flattening to the first node's value;
 * 3. theme tokens come first and a raw value the theme already names is snapped
 *    back to the token;
 * 4. the op a control emits is EXACTLY the op an agent tool emits — asserted by
 *    feeding it to the same `DocPatch.applyOp` the executor uses;
 * 5. a slider drag coalesces into ONE transaction, so Cmd+Z undoes the drag.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_DRAG_THROTTLE_MS,
  TEXT_CONTROL,
  TxnEmitter,
  allControls,
  buildControlModel,
  clampControlText,
  coerceControlInput,
  controlOps,
  countPinnedCells,
  findControl,
  isThemeTokenValue,
  jsonEqual,
  normalizeColorValue,
  pinnedTargetsForControl,
  pinnedTargetsForNodes,
  pinnedTargetsInDoc,
  readControlValue,
  snapToToken,
  tokenOptions,
  type ControlDescriptor,
  type OpSubmission,
} from '../../src/webview/canvas/controls';
import { renderPreview } from '../../src/webview/canvas/preview';
import {
  UI_PRIMITIVE_TAGS,
  UI_SCHEMA,
  propsForTag,
  stylesForTag,
  themeTokenValue,
} from '../../src/canvas/UiSchema';
import { applyOp } from '../../src/canvas/doc/DocPatch';
import type { DocNode } from '../../src/canvas/doc/DocNode';
import type { CanvasOp } from '../../src/canvas/CanvasOps';
import type { DesignTheme } from '../../src/types';
import { getThemePreset } from '../../src/managers/CanvasThemePresets';
import { themeTokenMap } from '../../src/managers/CanvasSandbox';

const THEME: DesignTheme = getThemePreset('clean-saas')!.theme;

function node(over: Partial<DocNode> & { mid: string; tag: string }): DocNode {
  return { ...over };
}

/* ─────────────────────────── control generation ─────────────────────────── */

describe('buildControlModel — generated from UiSchema', () => {
  it('generates controls for every one of the 22 primitives', () => {
    expect(UI_PRIMITIVE_TAGS.length).toBe(22);
    for (const tag of UI_PRIMITIVE_TAGS) {
      const model = buildControlModel([node({ mid: 'aaaaaaaaaa', tag })]);
      const controls = allControls(model);
      expect(controls.length, `${tag} produced no controls`).toBeGreaterThan(0);
      // Every style the schema declares is offered.
      const styleIds = controls.filter(c => c.target.kind === 'style').map(c => c.id);
      for (const spec of stylesForTag(tag)) {
        expect(styleIds, `${tag} is missing ${spec.prop}`).toContain(`style:${spec.prop}`);
      }
      // Every NON-slot prop the schema declares is offered, and nothing else.
      const propIds = controls.filter(c => c.target.kind === 'prop').map(c => c.id);
      for (const spec of propsForTag(tag)) {
        if (spec.slot === true) {
          expect(propIds).not.toContain(`prop:${spec.name}`);
          expect(model.slots).toContain(spec.name);
        } else {
          expect(propIds, `${tag} is missing ${spec.name}`).toContain(`prop:${spec.name}`);
        }
      }
    }
  });

  it('never invents a control the schema does not declare', () => {
    for (const tag of UI_PRIMITIVE_TAGS) {
      const model = buildControlModel([node({ mid: 'aaaaaaaaaa', tag })]);
      const declaredProps = new Set(propsForTag(tag).map(s => s.name));
      const declaredStyles = new Set(stylesForTag(tag).map(s => s.prop));
      for (const control of allControls(model)) {
        if (control.target.kind === 'prop') { expect(declaredProps.has(control.target.name)).toBe(true); }
        if (control.target.kind === 'style') { expect(declaredStyles.has(control.target.prop)).toBe(true); }
      }
    }
  });

  it('offers the text control only where DocNode.text is meaningful', () => {
    const textual = ['UI.Button', 'UI.Badge', 'UI.SidebarItem', 'UI.Heading', 'UI.Text'];
    for (const tag of UI_PRIMITIVE_TAGS) {
      const model = buildControlModel([node({ mid: 'aaaaaaaaaa', tag })]);
      const hasText = !!findControl(model, TEXT_CONTROL.id);
      expect(hasText, tag).toBe(textual.includes(tag) || UI_SCHEMA[tag].content === 'text');
    }
    // Plain HTML text tags get it too, through the same lookup.
    expect(findControl(buildControlModel([node({ mid: 'aaaaaaaaaa', tag: 'h1' })]), 'text')).toBeTruthy();
    expect(findControl(buildControlModel([node({ mid: 'aaaaaaaaaa', tag: 'div' })]), 'text')).toBeNull();
  });

  it('withholds the text control from a container — el.setText would throw', () => {
    const container = node({
      mid: 'aaaaaaaaaa', tag: 'UI.Button',
      children: [node({ mid: 'bbbbbbbbbb', tag: 'UI.Text', text: 'x' })],
    });
    expect(findControl(buildControlModel([container]), 'text')).toBeNull();
  });

  it('falls back to the generic HTML style set for a plain tag', () => {
    const model = buildControlModel([node({ mid: 'aaaaaaaaaa', tag: 'div' })]);
    const ids = allControls(model).map(c => c.id);
    expect(ids).toContain('style:background');
    expect(ids).toContain('style:gap');
    expect(ids).toContain('style:font-size');
    // HTML tags have no schema props — attributes are edited elsewhere.
    expect(allControls(model).some(c => c.target.kind === 'prop')).toBe(false);
  });

  it('returns an empty model for an empty selection', () => {
    const model = buildControlModel([]);
    expect(model.sections).toEqual([]);
    expect(model.tags).toEqual([]);
    expect(model.mixedTags).toBe(false);
  });
});

/* ─────────────────────────── multi-selection ─────────────────────────── */

describe('multi-selection shows the intersection', () => {
  it('keeps a prop both primitives declare identically', () => {
    const model = buildControlModel([
      node({ mid: 'aaaaaaaaaa', tag: 'UI.Button' }),
      node({ mid: 'bbbbbbbbbb', tag: 'UI.Badge' }),
    ]);
    expect(findControl(model, 'prop:label')).toBeTruthy();
    expect(model.mixedTags).toBe(true);
  });

  it('DROPS a prop whose meaning differs between the two tags', () => {
    // Button.size is an enum ('md' | 'lg'); Avatar.size is a number.
    const both = buildControlModel([
      node({ mid: 'aaaaaaaaaa', tag: 'UI.Button' }),
      node({ mid: 'bbbbbbbbbb', tag: 'UI.Avatar' }),
    ]);
    expect(findControl(both, 'prop:size')).toBeNull();
    // Each alone still offers it — the drop is about disagreement, not absence.
    expect(findControl(buildControlModel([node({ mid: 'aaaaaaaaaa', tag: 'UI.Button' })]), 'prop:size')).toBeTruthy();
    expect(findControl(buildControlModel([node({ mid: 'bbbbbbbbbb', tag: 'UI.Avatar' })]), 'prop:size')).toBeTruthy();
  });

  it('drops style controls one of the tags does not declare', () => {
    const model = buildControlModel([
      node({ mid: 'aaaaaaaaaa', tag: 'UI.Button' }),   // has the text styles
      node({ mid: 'bbbbbbbbbb', tag: 'UI.Card' }),     // does not
    ]);
    expect(findControl(model, 'style:background')).toBeTruthy();
    expect(findControl(model, 'style:color')).toBeNull();
  });

  it('withholds the text control unless EVERY node is a text leaf', () => {
    const model = buildControlModel([
      node({ mid: 'aaaaaaaaaa', tag: 'UI.Button' }),
      node({ mid: 'bbbbbbbbbb', tag: 'UI.Card' }),
    ]);
    expect(findControl(model, 'text')).toBeNull();
  });
});

describe('readControlValue', () => {
  const label = findControl(buildControlModel([node({ mid: 'a'.repeat(10), tag: 'UI.Button' })]), 'prop:label')!;
  const background = findControl(buildControlModel([node({ mid: 'a'.repeat(10), tag: 'UI.Button' })]), 'style:background')!;

  it('uniform when every node agrees', () => {
    const value = readControlValue([
      node({ mid: 'aaaaaaaaaa', tag: 'UI.Button', props: { label: 'Go' } }),
      node({ mid: 'bbbbbbbbbb', tag: 'UI.Button', props: { label: 'Go' } }),
    ], label);
    expect(value).toEqual({ state: 'uniform', value: 'Go' });
  });

  it('mixed when they disagree', () => {
    const value = readControlValue([
      node({ mid: 'aaaaaaaaaa', tag: 'UI.Button', props: { label: 'Go' } }),
      node({ mid: 'bbbbbbbbbb', tag: 'UI.Button', props: { label: 'Stop' } }),
    ], label);
    expect(value.state).toBe('mixed');
  });

  it('mixed when one node sets it and the other does not', () => {
    const value = readControlValue([
      node({ mid: 'aaaaaaaaaa', tag: 'UI.Button', props: { label: 'Go' } }),
      node({ mid: 'bbbbbbbbbb', tag: 'UI.Button' }),
    ], label);
    expect(value.state).toBe('mixed');
  });

  it('unset when nobody sets it — the primitive default applies', () => {
    const value = readControlValue([
      node({ mid: 'aaaaaaaaaa', tag: 'UI.Button' }),
      node({ mid: 'bbbbbbbbbb', tag: 'UI.Button' }),
    ], background);
    expect(value.state).toBe('unset');
  });

  it('a prop explicitly set to JSON null is a VALUE, not unset', () => {
    const value = readControlValue([node({ mid: 'aaaaaaaaaa', tag: 'UI.Button', props: { label: null } })], label);
    expect(value).toEqual({ state: 'uniform', value: null });
  });

  it('compares structured props deeply, ignoring key order', () => {
    const chart = findControl(buildControlModel([node({ mid: 'a'.repeat(10), tag: 'UI.Chart' })]), 'prop:data')!;
    const a = node({ mid: 'aaaaaaaaaa', tag: 'UI.Chart', props: { data: [{ label: 'Jan', value: 3 }] } });
    const b = node({ mid: 'bbbbbbbbbb', tag: 'UI.Chart', props: { data: [{ value: 3, label: 'Jan' }] } });
    expect(readControlValue([a, b], chart).state).toBe('uniform');
    expect(jsonEqual([1, 2], [1, 2])).toBe(true);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
  });

  it('reads own properties only — a prototype-named key cannot masquerade', () => {
    const poisoned = node({ mid: 'aaaaaaaaaa', tag: 'UI.Button' });
    // Nothing on Object.prototype may be reported as a set value.
    expect(readControlValue([poisoned], { ...label, target: { kind: 'prop', name: 'constructor' } }).state)
      .toBe('unset');
  });
});

/* ───────────────────────────── theme tokens ───────────────────────────── */

describe('tokens first, raw as the escape hatch', () => {
  it('offers every declared colour token, resolved against the live theme', () => {
    const options = tokenOptions('color', THEME);
    const map = themeTokenMap(THEME);
    expect(options[0].token).toBe('color-primary');
    expect(options[0].value).toBe('var(--theme-color-primary)');
    expect(options[0].resolved).toBe(map['color-primary']);
    expect(options.every(o => o.value === themeTokenValue(o.token))).toBe(true);
  });

  it('appends a brand token the theme added beyond the declared set', () => {
    const custom: DesignTheme = {
      ...THEME,
      colors: { ...THEME.colors, brandTeal: '#0aa' },
    };
    const options = tokenOptions('color', custom);
    const extra = options.find(o => o.token === 'color-brand-teal');
    expect(extra).toBeTruthy();
    expect(extra!.resolved).toBe('#0aa');
    // Declared tokens still come first.
    expect(options.indexOf(extra!)).toBeGreaterThan(options.findIndex(o => o.token === 'color-success'));
  });

  it('works with no theme — offering names without swatches', () => {
    const options = tokenOptions('radius', null);
    expect(options.map(o => o.token)).toEqual(['radius-sm', 'radius-md', 'radius-lg', 'radius-full']);
    expect(options.every(o => o.resolved === undefined)).toBe(true);
  });

  it('snaps a raw value the theme already names back to the token', () => {
    const primary = themeTokenMap(THEME)['color-primary'];
    expect(snapToToken(primary, 'color', THEME)).toBe('var(--theme-color-primary)');
    expect(snapToToken(primary.toUpperCase(), 'color', THEME)).toBe('var(--theme-color-primary)');
    expect(snapToToken('#123456', 'color', THEME)).toBeNull();
  });

  it('normalizes shorthand hex before comparing', () => {
    expect(normalizeColorValue('#ABC')).toBe('#aabbcc');
    expect(normalizeColorValue('  RGB(1, 2,  3) ')).toBe('rgb(1, 2, 3)');
    const shorthand: DesignTheme = { ...THEME, colors: { ...THEME.colors, primary: '#aabbcc' } };
    expect(snapToToken('#abc', 'color', shorthand)).toBe('var(--theme-color-primary)');
  });

  it('recognizes a token value and nothing that merely looks like one', () => {
    expect(isThemeTokenValue('var(--theme-color-primary)')).toBe(true);
    expect(isThemeTokenValue('var(--other-color)')).toBe(false);
    expect(isThemeTokenValue('var(--theme-x); background: url(http://x)')).toBe(false);
    expect(isThemeTokenValue(42)).toBe(false);
  });
});

/* ────────────────────────────── coercion ────────────────────────────── */

describe('coerceControlInput', () => {
  const buttonModel = buildControlModel([node({ mid: 'aaaaaaaaaa', tag: 'UI.Button' })]);
  const variant = findControl(buttonModel, 'prop:variant')!;
  const background = findControl(buttonModel, 'style:background')!;
  const width = findControl(buttonModel, 'style:width')!;
  const opacity = findControl(buttonModel, 'style:opacity')!;
  const label = findControl(buttonModel, 'prop:label')!;
  const stackGap = findControl(buildControlModel([node({ mid: 'a'.repeat(10), tag: 'UI.Stack' })]), 'prop:gap')!;
  const items = findControl(buildControlModel([node({ mid: 'a'.repeat(10), tag: 'UI.TabBar' })]), 'prop:items')!;
  const muted = findControl(buildControlModel([node({ mid: 'a'.repeat(10), tag: 'UI.Text' })]), 'prop:muted')!;

  it('accepts only declared enum members', () => {
    expect(coerceControlInput(variant, 'secondary')).toBe('secondary');
    expect(coerceControlInput(variant, 'chartreuse')).toBeUndefined();
  });

  it('clamps a number to the schema bounds', () => {
    expect(coerceControlInput(stackGap, '20')).toBe(20);
    expect(coerceControlInput(stackGap, '9999')).toBe(160);
    expect(coerceControlInput(stackGap, '-5')).toBe(0);
    expect(coerceControlInput(stackGap, 'NaN')).toBeUndefined();
    expect(coerceControlInput(opacity, '0.5')).toBe(0.5);
  });

  it('composes a bare number with the control unit, and keeps an explicit one', () => {
    expect(coerceControlInput(width, '240', { unit: 'px' })).toBe('240px');
    expect(coerceControlInput(width, '100%', { unit: 'px' })).toBe('100%');
    expect(coerceControlInput(width, 'auto', { unit: 'px' })).toBe('auto');
    expect(coerceControlInput(width, '12 ; color: red', { unit: 'px' })).toBeUndefined();
  });

  it('passes a token through and snaps a raw theme colour to it', () => {
    expect(coerceControlInput(background, 'var(--theme-color-surface)', { theme: THEME }))
      .toBe('var(--theme-color-surface)');
    expect(coerceControlInput(background, themeTokenMap(THEME)['color-primary'], { theme: THEME }))
      .toBe('var(--theme-color-primary)');
  });

  it('allows a genuinely custom colour but refuses a CSS breakout', () => {
    expect(coerceControlInput(background, '#123456', { theme: THEME })).toBe('#123456');
    expect(coerceControlInput(background, 'url(https://evil/x.png)', { theme: THEME })).toBeUndefined();
    expect(coerceControlInput(background, 'red; position: fixed', { theme: THEME })).toBeUndefined();
    expect(coerceControlInput(background, 'u\\rl(https://evil)', { theme: THEME })).toBeUndefined();
  });

  it('empty means CLEAR, never an empty declaration', () => {
    expect(coerceControlInput(background, '')).toBeNull();
    expect(coerceControlInput(width, '   ')).toBeNull();
    expect(coerceControlInput(label, '')).toBeNull();
  });

  it('parses a json control and refuses malformed or prototype-poisoning input', () => {
    expect(coerceControlInput(items, '[{"label":"Home"}]')).toEqual([{ label: 'Home' }]);
    expect(coerceControlInput(items, '[{"label":')).toBeUndefined();
    expect(coerceControlInput(items, '{"__proto__":{"x":1}}')).toBeUndefined();
    expect(coerceControlInput(items, `"${'x'.repeat(30000)}"`)).toBeUndefined();
  });

  it('reads a boolean toggle from either a string or a real boolean', () => {
    expect(coerceControlInput(muted, true)).toBe(true);
    expect(coerceControlInput(muted, 'false')).toBe(false);
    expect(coerceControlInput(muted, 'yes')).toBeUndefined();
  });

  it('strips invisible characters and caps very long text', () => {
    // A bidi override and a zero-width space: invisible in a design, and a
    // spoofing surface anywhere the text is read back.
    const BIDI = String.fromCharCode(0x202E);
    const ZWSP = String.fromCharCode(0x200B);
    const NUL = String.fromCharCode(0);
    expect(coerceControlInput(label, `Sign${BIDI}in${ZWSP}`)).toBe('Signin');
    expect(String(coerceControlInput(label, 'x'.repeat(9000))).length).toBe(5000);
    expect(clampControlText(`a${NUL}b`)).toBe('ab');
  });

  it('refuses to stringify a subtree', () => {
    const slotish: ControlDescriptor = { ...label, control: 'slot' };
    expect(coerceControlInput(slotish, 'anything')).toBeUndefined();
  });
});

/* ─────────────────── op construction (parity with the agent) ─────────────────── */

describe('controlOps — the identical op an agent tool produces', () => {
  const model = buildControlModel([node({ mid: 'aaaaaaaaaa', tag: 'UI.Button' })]);
  const label = findControl(model, 'prop:label')!;
  const background = findControl(model, 'style:background')!;
  const text = findControl(model, 'text')!;

  it('emits el.setProp, byte-for-byte what set_prop emits', () => {
    const ops = controlOps('p1', ['aaaaaaaaaa'], label, 'Get started');
    expect(ops).toEqual([
      { op: 'el.setProp', pageId: 'p1', mid: 'aaaaaaaaaa', name: 'label', value: 'Get started' },
    ]);
  });

  it('emits el.setStyle with the sanitized declaration', () => {
    const ops = controlOps('p1', ['aaaaaaaaaa'], background, 'var(--theme-color-accent)');
    expect(ops).toEqual([
      { op: 'el.setStyle', pageId: 'p1', mid: 'aaaaaaaaaa', style: { background: 'var(--theme-color-accent)' } },
    ]);
  });

  it('emits el.setText', () => {
    expect(controlOps('p1', ['aaaaaaaaaa'], text, 'Hi')).toEqual([
      { op: 'el.setText', pageId: 'p1', mid: 'aaaaaaaaaa', text: 'Hi' },
    ]);
  });

  it('writes one op per selected element', () => {
    const ops = controlOps('p1', ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc'], label, 'Go');
    expect(ops).toHaveLength(3);
    expect(ops.map(o => (o as { mid: string }).mid)).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc']);
  });

  it('null CLEARS: a style delete and a prop delete', () => {
    expect(controlOps('p1', ['aaaaaaaaaa'], background, null)).toEqual([
      { op: 'el.setStyle', pageId: 'p1', mid: 'aaaaaaaaaa', style: { background: null } },
    ]);
    expect(controlOps('p1', ['aaaaaaaaaa'], label, null)).toEqual([
      { op: 'el.setProp', pageId: 'p1', mid: 'aaaaaaaaaa', name: 'label', value: null },
    ]);
  });

  it('a refused value produces NO op — never a half-applied write', () => {
    expect(controlOps('p1', ['aaaaaaaaaa'], background, undefined)).toEqual([]);
    expect(controlOps('p1', ['aaaaaaaaaa'], background, 'url(https://evil)')).toEqual([]);
    expect(controlOps('', ['aaaaaaaaaa'], label, 'x')).toEqual([]);
    expect(controlOps('p1', [], label, 'x')).toEqual([]);
  });

  it('the emitted op is executable by the SAME DocPatch the executor runs', () => {
    const doc: DocNode = {
      mid: 'rrrrrrrrrr', tag: 'UI.Screen',
      children: [{ mid: 'aaaaaaaaaa', tag: 'UI.Button', props: { label: 'Old' } }],
    };
    const [op] = controlOps('p1', ['aaaaaaaaaa'], label, 'New');
    const result = applyOp(doc, op);
    expect(result.doc.children![0].props!.label).toBe('New');
    // And it is invertible — which is what makes the human edit undoable.
    expect(result.inverse).toEqual({
      op: 'el.setProp', pageId: 'p1', mid: 'aaaaaaaaaa', name: 'label', value: 'Old',
    });
  });

  it('every style control in the schema survives the preview renderer', () => {
    // A control that wrote a declaration `preview.ts` drops would be a control
    // that silently does nothing — the exact `elementOverrides` failure mode.
    const htmlModel = buildControlModel([node({ mid: 'aaaaaaaaaa', tag: 'div' })]);
    const style: Record<string, string> = {};
    for (const control of allControls(htmlModel)) {
      if (control.target.kind !== 'style') { continue; }
      const raw = sampleValueFor(control);
      const ops = controlOps('p1', ['aaaaaaaaaa'], control, raw);
      expect(ops.length, `${control.id} refused its own sample ${String(raw)}`).toBe(1);
      const written = (ops[0] as Extract<CanvasOp, { op: 'el.setStyle' }>).style;
      Object.assign(style, written);
    }
    const rendered = renderPreview({ mid: 'aaaaaaaaaa', tag: 'div', style });
    for (const [prop, value] of Object.entries(style)) {
      expect(rendered.root.style[prop], `${prop} was dropped by the preview`).toBe(value);
    }
    expect(rendered.stats.dropped).toBe(0);
  });
});

function sampleValueFor(control: ControlDescriptor): string {
  if (control.tokenGroup) { return tokenOptions(control.tokenGroup, THEME)[0].value; }
  if (control.options) { return control.options[0]; }
  if (control.control === 'number') { return String(control.min ?? 1); }
  if (control.control === 'length') { return '12px'; }
  return 'auto';
}

/* ──────────────────────────────── pins ──────────────────────────────── */

describe('pins — visible, per-cell, and releasable', () => {
  const model = buildControlModel([node({ mid: 'aaaaaaaaaa', tag: 'UI.Button' })]);
  const background = findControl(model, 'style:background')!;
  const label = findControl(model, 'prop:label')!;

  const pinned = node({
    mid: 'aaaaaaaaaa', tag: 'UI.Button',
    style: { background: '#123456' },
    props: { label: 'Mine' },
    pins: { 'style.background': { at: 1, opId: 'op-1' } },
  });

  it('reports the pin on the control that owns the cell, and only that one', () => {
    expect(pinnedTargetsForControl([pinned], background)).toEqual([
      { mid: 'aaaaaaaaaa', cells: ['style.background'] },
    ]);
    expect(pinnedTargetsForControl([pinned], label)).toEqual([]);
  });

  it('collects every pinned cell across a selection', () => {
    const other = node({
      mid: 'bbbbbbbbbb', tag: 'UI.Button',
      pins: { text: { at: 2, opId: 'op-2' }, 'props.label': { at: 3, opId: 'op-3' } },
    });
    const targets = pinnedTargetsForNodes([pinned, other]);
    expect(targets).toHaveLength(2);
    expect(countPinnedCells(targets)).toBe(3);
    expect(targets[1].cells).toEqual(['props.label', 'text']);
  });

  it('"let the agent restyle everything" releases STYLE pins and keeps the copy', () => {
    const doc: DocNode = {
      mid: 'rrrrrrrrrr', tag: 'UI.Screen',
      children: [
        pinned,
        node({
          mid: 'cccccccccc', tag: 'UI.Heading', text: 'Hand-written',
          pins: { text: { at: 4, opId: 'op-4' }, 'style.color': { at: 5, opId: 'op-5' } },
        }),
      ],
    };
    const styles = pinnedTargetsInDoc(doc, 'style');
    expect(styles).toEqual([
      { mid: 'aaaaaaaaaa', cells: ['style.background'] },
      { mid: 'cccccccccc', cells: ['style.color'] },
    ]);
    expect(countPinnedCells(pinnedTargetsInDoc(doc, 'all'))).toBe(3);
  });

  it('walks slots too — a pin inside a slot is still owned by the human', () => {
    const doc: DocNode = {
      mid: 'rrrrrrrrrr', tag: 'UI.ListRow',
      slots: {
        trailing: [node({
          mid: 'dddddddddd', tag: 'UI.Badge',
          pins: { 'style.background': { at: 6, opId: 'op-6' } },
        })],
      },
    };
    expect(pinnedTargetsInDoc(doc, 'style')).toEqual([
      { mid: 'dddddddddd', cells: ['style.background'] },
    ]);
  });
});

/* ──────────────────── transactions: one drag, one undo ──────────────────── */

describe('TxnEmitter — a drag is ONE transaction', () => {
  function harness(throttleMs = DEFAULT_DRAG_THROTTLE_MS) {
    const sent: OpSubmission[] = [];
    let clock = 0;
    let n = 0;
    const emitter = new TxnEmitter({
      emit: s => sent.push(s),
      newTxnId: () => `txn-${n++}`,
      throttleMs,
      now: () => clock,
    });
    return { sent, emitter, tick: (ms: number) => { clock += ms; } };
  }

  const op = (v: string): CanvasOp[] =>
    [{ op: 'el.setStyle', pageId: 'p1', mid: 'aaaaaaaaaa', style: { width: v } }];

  it('keeps 60 drag frames under a single txnId', () => {
    const h = harness();
    h.emitter.begin();
    for (let i = 0; i < 60; i++) { h.tick(16); h.emitter.update(op(`${i}px`)); }
    h.emitter.end(op('60px'));
    expect(h.sent.length).toBeGreaterThan(1);
    expect(new Set(h.sent.map(s => s.txnId)).size).toBe(1);
    expect(h.sent[0].txnId).toBe('txn-0');
  });

  it('throttles the middle of the drag but always commits the final value once', () => {
    const h = harness(80);
    h.emitter.begin();
    for (let i = 0; i < 60; i++) { h.tick(16); h.emitter.update(op(`${i}px`)); }
    h.emitter.end(op('final'));
    expect(h.sent.length).toBeLessThan(30);
    const last = h.sent[h.sent.length - 1];
    expect(last.ops).toEqual(op('final'));
    // ...and exactly once: an end() repeating the last emitted value is a no-op.
    const before = h.sent.length;
    h.emitter.end(op('final'));
    expect(h.sent.length).toBe(before);
  });

  it('a discrete edit outside a gesture gets its own transaction', () => {
    const h = harness();
    h.emitter.commit(op('1px'));
    h.emitter.commit(op('2px'));
    expect(h.sent.map(s => s.txnId)).toEqual(['txn-0', 'txn-1']);
  });

  it('a discrete edit DURING a gesture rides that gesture — undo stays whole', () => {
    const h = harness(0);
    const id = h.emitter.begin();
    h.emitter.update(op('1px'));
    h.emitter.commit(op('2px'));
    h.emitter.end();
    expect(h.sent.every(s => s.txnId === id)).toBe(true);
  });

  it('cancel abandons the pending value', () => {
    const h = harness(1000);
    h.emitter.begin();
    h.emitter.update(op('1px'));      // the first update always emits
    h.emitter.update(op('2px'));      // throttled away
    h.emitter.cancel();
    expect(h.sent.map(s => s.ops[0])).toEqual([op('1px')[0]]);
    expect(h.emitter.active).toBe(false);
  });

  it('beginning a second gesture flushes the first rather than losing it', () => {
    const h = harness(1000);
    h.emitter.begin();
    h.emitter.update(op('1px'));
    h.emitter.update(op('2px'));      // pending, throttled
    h.emitter.begin();                // pointer-down elsewhere
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].ops).toEqual(op('2px'));
    expect(h.sent[1].txnId).toBe('txn-0');
  });

  it('never emits an empty op list', () => {
    const emit = vi.fn();
    const emitter = new TxnEmitter({ emit, throttleMs: 0 });
    emitter.commit([]);
    emitter.begin();
    emitter.update([]);
    emitter.end();
    expect(emit).not.toHaveBeenCalled();
  });
});
