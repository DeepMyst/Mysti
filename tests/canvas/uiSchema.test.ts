/**
 * `src/canvas/UiSchema.ts` — the table Phase 3's properties panel is generated
 * from.
 *
 * The load-bearing tests here do not check the data against itself: they check
 * it against `resources/canvas-sandbox/ui-primitives.js`, the runtime that
 * actually reads the props. A schema that drifts out of the runtime produces
 * controls that silently do nothing — precisely the failure `elementOverrides`
 * already shipped once — so the primitive source is parsed and the two sets are
 * compared in BOTH directions: no primitive missing, no prop invented.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  UI_SCHEMA,
  UI_PRIMITIVE_TAGS,
  UI_PRIMITIVE_NAMES,
  UI_COMMON_STYLES,
  UI_TEXT_STYLES,
  UI_FLEX_STYLES,
  HTML_TAG_STYLES,
  THEME_TOKENS,
  themeTokenValue,
  allThemeTokenValues,
  uiSchemaFor,
  uiPropSpec,
  uiStyleSpec,
  stylesForTag,
  propsForTag,
  isUiTag,
  supportsTextEditing,
  supportsChildren,
} from '../../src/canvas/UiSchema';
import { themeTokenMap } from '../../src/managers/CanvasSandbox';
import { DesignSpecManager } from '../../src/managers/DesignSpecManager';

const PRIMITIVES_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../resources/canvas-sandbox/ui-primitives.js'),
  'utf8',
);

/** The names exported on `window.UI` — the canonical primitive list. */
function runtimePrimitiveNames(): string[] {
  const start = PRIMITIVES_SRC.indexOf('window.UI = {');
  expect(start).toBeGreaterThan(-1);
  const end = PRIMITIVES_SRC.indexOf('};', start);
  const body = PRIMITIVES_SRC.slice(start + 'window.UI = {'.length, end);
  const names: string[] = [];
  for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) { names.push(m[1]); }
  return names;
}

/** The body of `function Name(p) { … }`, by brace matching. */
function primitiveBody(name: string): string {
  const head = `function ${name}(p) {`;
  const at = PRIMITIVES_SRC.indexOf(head);
  if (at === -1) { throw new Error(`primitive ${name} not found in ui-primitives.js`); }
  let depth = 0;
  for (let i = at + head.length - 1; i < PRIMITIVES_SRC.length; i++) {
    const ch = PRIMITIVES_SRC[i];
    if (ch === '{') { depth++; }
    else if (ch === '}') { depth--; if (depth === 0) { return PRIMITIVES_SRC.slice(at, i + 1); } }
  }
  throw new Error(`unbalanced body for ${name}`);
}

/** Every `p.<prop>` the primitive reads, minus the two the schema models elsewhere. */
function runtimeProps(name: string): Set<string> {
  const body = primitiveBody(name);
  const out = new Set<string>();
  for (const m of body.matchAll(/\bp\.([A-Za-z_$][\w$]*)/g)) {
    if (m[1] === 'style' || m[1] === 'children') { continue; }
    out.add(m[1]);
  }
  return out;
}

describe('UiSchema — grounded in the runtime primitives', () => {
  const runtimeNames = runtimePrimitiveNames();

  it('the runtime really does export 22 primitives', () => {
    expect(runtimeNames).toHaveLength(22);
  });

  it('covers EVERY primitive on window.UI — none missing', () => {
    const missing = runtimeNames.filter(n => !Object.prototype.hasOwnProperty.call(UI_SCHEMA, `UI.${n}`));
    expect(missing).toEqual([]);
    expect(UI_PRIMITIVE_NAMES.slice().sort()).toEqual(runtimeNames.slice().sort());
    expect(UI_PRIMITIVE_TAGS).toHaveLength(runtimeNames.length);
  });

  it('invents no primitive the runtime does not export', () => {
    const extra = UI_PRIMITIVE_NAMES.filter(n => !runtimeNames.includes(n));
    expect(extra).toEqual([]);
  });

  it.each(runtimePrimitiveNames())('%s declares exactly the props the primitive reads', name => {
    const declared = new Set(UI_SCHEMA[`UI.${name}`].props.map(p => p.name));
    const actual = runtimeProps(name);
    const missing = [...actual].filter(p => !declared.has(p));
    const invented = [...declared].filter(p => !actual.has(p));
    expect({ name, missing, invented }).toEqual({ name, missing: [], invented: [] });
  });
});

describe('UiSchema — shape invariants', () => {
  const all = Object.values(UI_SCHEMA);

  it('every schema is keyed by its own fully qualified tag', () => {
    for (const [key, schema] of Object.entries(UI_SCHEMA)) {
      expect(schema.tag).toBe(key);
      expect(schema.tag).toBe(`UI.${schema.name}`);
    }
  });

  it('every primitive carries the common style controls', () => {
    for (const schema of all) {
      const props = schema.styles.map(s => s.prop);
      for (const common of UI_COMMON_STYLES) { expect(props).toContain(common.prop); }
    }
  });

  it('style controls are deduplicated per primitive', () => {
    for (const schema of all) {
      const props = schema.styles.map(s => s.prop);
      expect(new Set(props).size).toBe(props.length);
    }
  });

  it('prop names are unique per primitive', () => {
    for (const schema of all) {
      const names = schema.props.map(p => p.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('every enum control offers options, and its default is one of them', () => {
    for (const schema of all) {
      for (const p of schema.props) {
        if (p.control !== 'select') { continue; }
        expect(p.options, `${schema.tag}.${p.name}`).toBeTruthy();
        expect(p.options!.length).toBeGreaterThan(0);
        if (p.default !== undefined) { expect(p.options).toContain(p.default as string); }
      }
      for (const s of schema.styles) {
        if (s.control !== 'select') { continue; }
        expect(s.options, `${schema.tag} style ${s.prop}`).toBeTruthy();
      }
    }
  });

  it('every token control names a real token group', () => {
    const groups = Object.keys(THEME_TOKENS);
    for (const schema of all) {
      for (const spec of [...schema.props, ...schema.styles]) {
        if (spec.control !== 'token') { continue; }
        expect(spec.tokenGroup, JSON.stringify(spec)).toBeTruthy();
        expect(groups).toContain(spec.tokenGroup);
      }
    }
  });

  it('prefers token controls for every themeable style property', () => {
    // The point of the schema: a color/radius/shadow control offers brand
    // tokens, not a free-form field.
    const themeable = ['background', 'border-color', 'border-radius', 'box-shadow', 'color', 'font-family', 'font-weight'];
    for (const schema of all) {
      for (const s of schema.styles) {
        if (!themeable.includes(s.prop)) { continue; }
        expect({ tag: schema.tag, prop: s.prop, control: s.control }).toMatchObject({ control: 'token' });
      }
    }
  });

  it('slots are exactly the props declared with a slot control', () => {
    for (const schema of all) {
      const fromProps = schema.props.filter(p => p.control === 'slot' || p.control === 'slotList').map(p => p.name);
      expect(schema.slots.slice().sort()).toEqual(fromProps.slice().sort());
    }
  });

  it('the primitives with JSX-valued props are exactly the ones with slots', () => {
    const withSlots = Object.values(UI_SCHEMA).filter(s => s.slots.length > 0).map(s => s.name).sort();
    expect(withSlots).toEqual(['AppShell', 'EmptyState', 'ListRow', 'TopBar']);
  });

  it('numeric controls carry a sane range', () => {
    for (const schema of all) {
      for (const spec of [...schema.props, ...schema.styles]) {
        if (spec.control !== 'number') { continue; }
        if (spec.min !== undefined && spec.max !== undefined) { expect(spec.min).toBeLessThan(spec.max); }
      }
    }
  });

  it('every primitive has a non-empty description and a known group', () => {
    const groups = ['layout', 'surface', 'control', 'data', 'typography'];
    for (const schema of all) {
      expect(schema.description.length).toBeGreaterThan(10);
      expect(groups).toContain(schema.group);
      expect(['none', 'elements', 'text']).toContain(schema.content);
    }
  });

  it('is frozen — a consumer cannot mutate the shared table', () => {
    expect(Object.isFrozen(UI_SCHEMA)).toBe(true);
    expect(Object.isFrozen(UI_SCHEMA['UI.Card'])).toBe(true);
    expect(() => {
      (UI_SCHEMA as Record<string, unknown>)['UI.Injected'] = {};
    }).toThrow();
  });
});

describe('UiSchema — theme tokens agree with the sandbox', () => {
  it('every declared token is one the sandbox actually emits', () => {
    const emitted = new Set(Object.keys(themeTokenMap(DesignSpecManager.getDefaultTheme())));
    for (const group of Object.keys(THEME_TOKENS) as (keyof typeof THEME_TOKENS)[]) {
      for (const token of THEME_TOKENS[group]) {
        expect(emitted.has(token), `${group}/${token}`).toBe(true);
      }
    }
  });

  it('token values are var(--theme-…) references, never raw colors', () => {
    expect(themeTokenValue('color-primary')).toBe('var(--theme-color-primary)');
    for (const value of allThemeTokenValues()) {
      expect(value).toMatch(/^var\(--theme-[a-z0-9-]+\)$/);
    }
  });

  it('offers every color the theme guarantees', () => {
    expect(THEME_TOKENS.color).toContain('color-text-secondary'); // camelCase → kebab
    expect(THEME_TOKENS.color).toHaveLength(10);
  });
});

describe('UiSchema — lookups', () => {
  it('accepts both the qualified and the bare tag', () => {
    expect(uiSchemaFor('UI.Card')).toBe(UI_SCHEMA['UI.Card']);
    expect(uiSchemaFor('Card')).toBe(UI_SCHEMA['UI.Card']);
  });

  it('returns undefined — never a stand-in — for unknown or HTML tags', () => {
    expect(uiSchemaFor('div')).toBeUndefined();
    expect(uiSchemaFor('UI.Nope')).toBeUndefined();
    expect(uiSchemaFor('')).toBeUndefined();
    expect(uiSchemaFor(undefined)).toBeUndefined();
    expect(uiSchemaFor(null)).toBeUndefined();
  });

  it('is not fooled by prototype keys', () => {
    expect(uiSchemaFor('constructor')).toBeUndefined();
    expect(uiSchemaFor('UI.__proto__')).toBeUndefined();
    expect(uiSchemaFor('toString')).toBeUndefined();
    expect(isUiTag('constructor')).toBe(false);
    expect(isUiTag('UI.Card')).toBe(true);
    expect(isUiTag('Card')).toBe(false); // isUiTag takes the WIRE tag
  });

  it('uiPropSpec / uiStyleSpec resolve a single control', () => {
    expect(uiPropSpec('UI.Button', 'variant')?.options).toEqual(['primary', 'secondary', 'ghost']);
    expect(uiPropSpec('UI.Button', 'nope')).toBeUndefined();
    expect(uiStyleSpec('UI.Button', 'border-radius')?.tokenGroup).toBe('radius');
    expect(uiStyleSpec('UI.Avatar', 'font-size')).toBeUndefined(); // Avatar has no text styles
  });

  it('stylesForTag falls back to the HTML set so a plain div is still editable', () => {
    expect(stylesForTag('div')).toBe(HTML_TAG_STYLES);
    expect(stylesForTag('UI.Card')).toBe(UI_SCHEMA['UI.Card'].styles);
    const htmlProps = HTML_TAG_STYLES.map(s => s.prop);
    for (const spec of [...UI_COMMON_STYLES, ...UI_FLEX_STYLES, ...UI_TEXT_STYLES]) {
      expect(htmlProps).toContain(spec.prop);
    }
  });

  it('propsForTag is empty for HTML tags', () => {
    expect(propsForTag('div')).toEqual([]);
    expect(propsForTag('UI.Badge').length).toBeGreaterThan(0);
  });

  it('supportsTextEditing marks the leaves inline editing targets', () => {
    expect(supportsTextEditing('UI.Heading')).toBe(true);
    expect(supportsTextEditing('UI.Text')).toBe(true);
    expect(supportsTextEditing('UI.Button')).toBe(true);
    expect(supportsTextEditing('UI.Card')).toBe(false);   // container
    expect(supportsTextEditing('UI.Chart')).toBe(false);  // configured by props
    expect(supportsTextEditing('h1')).toBe(true);
    expect(supportsTextEditing('div')).toBe(false);
    expect(supportsTextEditing(undefined)).toBe(false);
  });

  it('supportsChildren marks the containers', () => {
    expect(supportsChildren('UI.Stack')).toBe(true);
    expect(supportsChildren('UI.Badge')).toBe(false);
    expect(supportsChildren('div')).toBe(true);
    expect(supportsChildren('img')).toBe(false);
    expect(supportsChildren('br')).toBe(false);
  });
});
