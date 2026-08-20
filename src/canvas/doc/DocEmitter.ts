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
 * Plan 22 §3.1 — {@link DocNode} → JSX. The exact inverse of {@link ./PageCompiler}.
 *
 * Two things depend on this being an inverse rather than a pretty-printer:
 *
 * 1. **Mid stability, tier 1.** `read_page` / `get_page_jsx` return this output
 *    with `mid="k7f2xq3b4m"` on every element. Models preserve attributes they
 *    do not understand, so a node the model did not mean to touch keeps its
 *    exact identity for free — no matching heuristic involved.
 * 2. **Pins are visible.** With `pins: true` each node carries an inline
 *    `⟂user-set: style.background` comment, so the model can SEE the cells a
 *    human owns instead of discovering them from a rejected receipt.
 *
 * The round-trip `compile(emit(doc)) ≡ doc` is asserted over all five shipped
 * scaffolds and every fixture; it is the contract that keeps the two directions
 * from drifting apart.
 */

import {
  isMid,
  pinnedCells,
  type DocNode,
  type JsonValue,
} from './DocNode';

export interface EmitOptions {
  /** Render `mid="…"` on every element. What `read_page` returns. */
  mids?: boolean;
  /** Annotate human-owned cells inline in a `⟂user-set: …` comment. */
  pins?: boolean;
}

/** Anything longer than this breaks onto multiple lines. */
const MAX_INLINE = 96;
const INDENT = '  ';

/** Marker the prompt refers to when telling the model what it must not overwrite. */
export const PIN_MARKER = '⟂user-set:';

/** A complete, readable `function Page()` component. */
export function emit(doc: DocNode, opts: EmitOptions = {}): string {
  const lines = renderNode(doc, opts).map(l => (l ? `    ${l}` : l));
  return `function Page() {\n  return (\n${lines.join('\n')}\n  );\n}`;
}

/** One subtree, unwrapped — for `get_node` and for slot rendering. */
export function emitElement(node: DocNode, opts: EmitOptions = {}): string {
  return renderNode(node, opts).join('\n');
}

/* ─────────────────────────────── elements ─────────────────────────────── */

function renderNode(node: DocNode, opts: EmitOptions): string[] {
  const tag = safeTag(node.tag);
  const attrs: string[][] = [];

  if (opts.mids && node.mid) {
    // Mids are `[a-z2-7]{10}` so the readable double-quoted form is always safe;
    // a malformed one goes through a string expression rather than breaking JSX.
    attrs.push([isMid(node.mid) ? `mid="${node.mid}"` : `mid={${jsString(node.mid)}}`]);
  }
  if (opts.pins) {
    const cells = pinnedCells(node);
    if (cells.length) { attrs.push([`/* ${PIN_MARKER} ${cells.map(safeComment).join(', ')} */`]); }
  }

  for (const [name, value] of Object.entries(node.props ?? {})) {
    if (!isEmittableAttr(name)) { continue; }
    attrs.push(renderProp(name, value));
  }
  for (const [name, nodes] of Object.entries(node.slots ?? {})) {
    if (!isEmittableAttr(name)) { continue; }
    attrs.push(renderSlot(name, nodes, opts));
  }
  if (node.style && Object.keys(node.style).length) {
    attrs.push(renderStyle(node.style));
  }

  const children = renderChildren(node, opts);
  const inlineAttrs = attrs.every(a => a.length === 1) ? attrs.map(a => a[0]) : null;
  const openInline = inlineAttrs ? `<${tag}${inlineAttrs.map(a => ` ${a}`).join('')}` : null;
  const fitsInline = openInline !== null && openInline.length + 2 <= MAX_INLINE;

  // Self-closing
  if (!children) {
    if (fitsInline && openInline) { return [`${openInline} />`]; }
    return [`<${tag}`, ...indentAll(attrs.flat()), '/>'];
  }

  // One short text child — keep the whole element on one line when it fits.
  if (fitsInline && openInline && children.length === 1 &&
      openInline.length + 1 + children[0].length + tag.length + 3 <= MAX_INLINE) {
    return [`${openInline}>${children[0]}</${tag}>`];
  }

  const head = fitsInline && openInline ? [`${openInline}>`] : [`<${tag}`, ...indentAll(attrs.flat()), '>'];
  return [...head, ...indentAll(children), `</${tag}>`];
}

function renderChildren(node: DocNode, opts: EmitOptions): string[] | null {
  const out: string[] = [];
  if (node.text !== undefined && node.text !== '') { out.push(renderText(node.text)); }
  for (const child of node.children ?? []) { out.push(...renderNode(child, opts)); }
  return out.length ? out : null;
}

/**
 * JSX text is lossy — it trims, collapses interior newlines and decodes HTML
 * entities. Anything that would not survive that verbatim is emitted as a
 * string expression instead, so the compiler reads back the exact same value.
 */
function renderText(text: string): string {
  const safeRaw = text.length > 0 && text.trim() === text && !RAW_TEXT_UNSAFE.test(text);
  return safeRaw ? text : `{${jsString(text)}}`;
}

/**
 * Characters that make raw JSX text lossy or ambiguous: markup, entity starts,
 * and anything a source file should not carry literally — control codes and the
 * U+2028/U+2029 line separators, which terminate a line for some tokenizers.
 */
// eslint-disable-next-line no-control-regex
const RAW_TEXT_UNSAFE = /[<>{}&\\\u0000-\u001f\u007f\u2028\u2029]/;
/** The same rule for a quoted attribute value, which also decodes entities. */
// eslint-disable-next-line no-control-regex
const RAW_ATTR_UNSAFE = /["&\\<>\u0000-\u001f\u007f\u2028\u2029]/;

/* ──────────────────────────────── props ──────────────────────────────── */

function renderProp(name: string, value: JsonValue): string[] {
  if (value === true) { return [name]; }
  if (typeof value === 'string') {
    // A raw JSX string attribute decodes entities, so `&` and `"` go through
    // an expression container to survive the round-trip untouched.
    if (!RAW_ATTR_UNSAFE.test(value)) { return [`${name}="${value}"`]; }
    return [`${name}={${jsString(value)}}`];
  }
  const lit = jsLiteral(value);
  if (lit.length === 1) { return [`${name}={${lit[0]}}`]; }
  return [`${name}={${lit[0]}`, ...lit.slice(1, -1), `${lit[lit.length - 1]}}`];
}

function renderStyle(style: Record<string, string>): string[] {
  const entries = Object.entries(style).map(([k, v]) => `${styleKey(k)}: ${jsString(v)}`);
  const inline = `style={{ ${entries.join(', ')} }}`;
  if (inline.length <= MAX_INLINE) { return [inline]; }
  return ['style={{', ...entries.map(e => `${INDENT}${e},`), '}}'];
}

function renderSlot(name: string, nodes: DocNode[], opts: EmitOptions): string[] {
  if (nodes.length === 0) { return [`${name}={[]}`]; }

  if (nodes.length === 1) {
    const body = renderNode(nodes[0], opts);
    if (body.length === 1 && `${name}={${body[0]}}`.length <= MAX_INLINE) {
      return [`${name}={${body[0]}}`];
    }
    return [`${name}={`, ...indentAll(body), '}'];
  }

  const parts: string[] = [`${name}={[`];
  for (const n of nodes) {
    const body = renderNode(n, opts);
    body[body.length - 1] = `${body[body.length - 1]},`;
    parts.push(...indentAll(body));
  }
  parts.push(']}');
  return parts;
}

/* ─────────────────────────── literal printing ─────────────────────────── */

/** A JSON value as readable JS source. Returns one line, or a block. */
function jsLiteral(value: JsonValue): string[] {
  const inline = jsInline(value);
  if (inline !== null && inline.length <= MAX_INLINE) { return [inline]; }

  if (Array.isArray(value)) {
    const out: string[] = ['['];
    for (const item of value) {
      const sub = jsLiteral(item);
      sub[sub.length - 1] = `${sub[sub.length - 1]},`;
      out.push(...indentAll(sub));
    }
    out.push(']');
    return out;
  }
  if (value !== null && typeof value === 'object') {
    const out: string[] = ['{'];
    for (const [k, v] of Object.entries(value)) {
      const sub = jsLiteral(v);
      sub[0] = `${objectKey(k)}: ${sub[0]}`;
      sub[sub.length - 1] = `${sub[sub.length - 1]},`;
      out.push(...indentAll(sub));
    }
    out.push('}');
    return out;
  }
  return [inline ?? 'null'];
}

/** Single-line form, or `null` when the value must be broken up. */
function jsInline(value: JsonValue): string | null {
  if (value === null) { return 'null'; }
  if (typeof value === 'boolean') { return String(value); }
  if (typeof value === 'number') { return Number.isFinite(value) ? String(value) : 'null'; }
  if (typeof value === 'string') { return jsString(value); }
  if (Array.isArray(value)) {
    const parts = value.map(jsInline);
    if (parts.some(p => p === null)) { return null; }
    const s = `[${parts.join(', ')}]`;
    return s.length <= MAX_INLINE ? s : null;
  }
  const parts = Object.entries(value).map(([k, v]) => {
    const sub = jsInline(v);
    return sub === null ? null : `${objectKey(k)}: ${sub}`;
  });
  if (parts.some(p => p === null)) { return null; }
  if (!parts.length) { return '{}'; }
  const s = `{ ${parts.join(', ')} }`;
  return s.length <= MAX_INLINE ? s : null;
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * A key as it appears inside an object literal.
 *
 * `__proto__` is special-cased into the COMPUTED form `['__proto__']`, which is
 * the only spelling that makes it an ordinary property: both `__proto__: v` and
 * `'__proto__': v` are prototype directives that store nothing. A doc can carry
 * such a key legitimately — `DocPatch.applyOp` treats it as data and inverts it
 * — so it has to survive the trip through source, not be quietly dropped.
 */
function objectKey(k: string): string {
  if (k === '__proto__') { return `[${jsString(k)}]`; }
  return IDENT_RE.test(k) ? k : jsString(k);
}

/** `align-items` → `alignItems`; `--brand` and other odd keys stay quoted. */
function styleKey(k: string): string {
  if (k === '__proto__') { return `[${jsString(k)}]`; }
  if (k.startsWith('--')) { return jsString(k); }
  const camel = k.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
  return IDENT_RE.test(camel) ? camel : jsString(k);
}

/** A JS string literal. Picks the quote that needs the least escaping. */
export function jsString(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    switch (ch) {
      case '\\': out += '\\\\'; break;
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      case '\t': out += '\\t'; break;
      case ' ': out += '\\u2028'; break;
      case ' ': out += '\\u2029'; break;
      default:
        if (ch === quote) { out += `\\${ch}`; }
        else if (ch < ' ') { out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`; }
        else { out += ch; }
    }
  }
  return out + quote;
}

/* ──────────────────────────────── safety ──────────────────────────────── */

const TAG_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const ATTR_RE = /^[A-Za-z_$][\w$-]*(:[A-Za-z_$][\w$-]*)?$/;

/**
 * A doc can reach the emitter from an op payload, so a tag is never trusted to
 * be printable JSX. An unusable one degrades to `div` rather than producing a
 * source string that will not parse.
 */
function safeTag(tag: string): string {
  return TAG_RE.test(tag) ? tag : 'div';
}

function isValidAttrName(name: string): boolean {
  return ATTR_RE.test(name);
}

/**
 * A prop or slot name that can be written as JSX and carries no other meaning.
 * `mid` is identity and `style` has its own attribute, so neither may be
 * smuggled back in through the props bag.
 *
 * **This is the write side's predicate too.** A JSX attribute name is
 * grammatically an identifier: `2col`, `a b` and `foo.bar` have no spelling at
 * all, and there is no computed-key escape hatch either — `PageCompiler` fails
 * `{...spread}` outright (`prop spread \`{...x}\` is outside the JSX subset`),
 * which is the only construct that could carry an arbitrary name. So a prop the
 * emitter cannot print is a prop `read_page` cannot show, and a value the model
 * cannot see is a value it deletes on the next echo. The doc must never hold
 * one, which means `el.setProp` / `el.insert` / `el.replace` have to refuse the
 * name at validation time — against THIS function, not a second copy of it.
 *
 * @see TreeDiffer `_diffCells`, which refuses to read such a prop's absence
 * from a rewrite as an instruction to delete it.
 */
export function isEmittablePropName(name: string): boolean {
  return isEmittableAttr(name);
}

function isEmittableAttr(name: string): boolean {
  return isValidAttrName(name) && name !== 'mid' && name !== 'style';
}

/**
 * Pin cells are model-visible text that lands inside a block comment, so the
 * cell name is reduced to an identifier-safe whitelist — a crafted prop name
 * can neither close the comment early nor smuggle a newline into the source.
 */
function safeComment(cell: string): string {
  const clean = cell.replace(/[^\w.$:-]+/g, '_');
  return clean.length > 120 ? `${clean.slice(0, 120)}_` : clean;
}

function indentAll(lines: string[]): string[] {
  return lines.map(l => (l ? `${INDENT}${l}` : l));
}
