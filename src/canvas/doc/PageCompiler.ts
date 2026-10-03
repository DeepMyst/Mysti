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
 * Plan 22 §3.1 — JSX source → {@link DocNode}. A STATIC EVALUATOR, not a bundler.
 *
 * The page a model writes is JSX because that is what models write well; the
 * page the canvas *owns* is a `DocNode` tree because that is what selection,
 * pins, per-element ops, undo and delta rendering need. This file is the only
 * bridge in that direction, and {@link ./DocEmitter} is the only bridge back.
 *
 * The subset is deliberately small and verified against the five shipped
 * scaffolds (`src/managers/CanvasScaffolds.ts`) — nested JSX, literal props,
 * `style={{…}}`, object/array literal props, JSX-valued props (`slots`), local
 * `const x = (<JSX/>)` bindings inlined at their use site, and literal children.
 * There is no `.map`, no ternary, no hook and no runtime logic: those FAIL
 * compilation with a located message so the caller can store the page as
 * `legacy` and badge it honestly, rather than silently producing half a tree.
 */

import { parse } from '@babel/parser';
import type {
  Expression,
  JSXAttribute,
  JSXElement,
  JSXFragment,
  JSXSpreadAttribute,
  Node as BabelNode,
  ObjectExpression,
  Program,
  Statement,
} from '@babel/types';

import {
  cloneNode,
  isMid,
  mintMid,
  type DocNode,
  type JsonValue,
  type Mid,
} from './DocNode';

/* ──────────────────────────────── API ──────────────────────────────── */

export interface CompileOk { ok: true; doc: DocNode }
export interface CompileErr { ok: false; error: string }
export type CompileResult = CompileOk | CompileErr;

export interface CompileOptions {
  /** Injectable RNG so tests can mint deterministic mids. */
  rand?: () => number;
}

/** Thrown internally; never escapes {@link compile}. */
class CompileError extends Error {}

const PARSER_OPTIONS = {
  sourceType: 'module' as const,
  // `typescript` is tolerated so an annotated page still compiles; the subset
  // itself is unchanged — a type annotation simply carries no doc meaning.
  plugins: ['jsx' as const, 'typescript' as const],
};

/**
 * Compile a complete page source into a {@link DocNode} tree.
 *
 * Never throws: anything outside the subset comes back as `{ ok: false }` with
 * a message naming the construct and its line.
 */
export function compile(source: string, opts: CompileOptions = {}): CompileResult {
  try {
    if (!source || !source.trim()) {
      return { ok: false, error: 'empty page source' };
    }
    const ast = parse(source, PARSER_OPTIONS);
    const doc = new PageEvaluator(opts.rand).run(ast.program);
    return { ok: true, doc };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/**
 * Compile the syntactically-complete PREFIX of a half-written page.
 *
 * Phase 5 diffs successive partials to stream a page in as it is authored, so
 * this must never throw and must degrade smoothly: the source is cut back to
 * the last safe tag boundary, the still-open elements and brackets are closed
 * synthetically, and the result is handed to the SAME evaluator — a partial doc
 * is never produced from source Babel did not accept. `{ ok: false }` only when
 * even the prefix carries no usable element.
 */
export function compilePartial(source: string, opts: CompileOptions = {}): CompileResult {
  try {
    const direct = compile(source, opts);
    if (direct.ok) { return direct; }
    if (!source || !source.trim()) { return { ok: false, error: 'empty page source' }; }

    let lastError = direct.error;
    let attempts = 0;
    const deadline = Date.now() + PARTIAL_BUDGET_MS;
    for (const cut of cutCandidates(source)) {
      if (attempts++ >= MAX_PARTIAL_ATTEMPTS || Date.now() > deadline) { break; }
      const repaired = repairPrefix(source.slice(0, cut));
      if (repaired === null) { continue; }
      const r = compile(repaired, opts);
      if (r.ok) { return r; }
      lastError = r.error;
    }
    return { ok: false, error: `no compilable prefix: ${lastError}` };
  } catch (err) {
    // compilePartial is on the streaming path — it may never throw.
    return { ok: false, error: describeError(err) };
  }
}

function describeError(err: unknown): string {
  if (err instanceof CompileError) { return err.message; }
  if (err instanceof Error) { return err.message; }
  return String(err);
}

/* ───────────────────────────── evaluator ───────────────────────────── */

interface ChildItem {
  kind: 'text' | 'node';
  text?: string;
  node?: DocNode;
}

class PageEvaluator {
  private readonly _rand: (() => number) | undefined;
  private readonly _seenMids = new Set<Mid>();
  private readonly _scope = new Map<string, Expression>();
  private readonly _resolving = new Set<string>();
  private _depth = 0;
  private _fallback = 0;

  constructor(rand?: () => number) { this._rand = rand; }

  run(program: Program): DocNode {
    const root = this._findPageExpression(program);
    return this._element(root);
  }

  /* ── page discovery ── */

  private _findPageExpression(program: Program): JSXElement {
    const body = program.body.map(unwrapExport).filter((s): s is Statement => !!s);

    const named = body.find(s => s.type === 'FunctionDeclaration' && s.id?.name === 'Page');
    if (named) { return this._fromFunctionBody((named as Extract<Statement, { type: 'FunctionDeclaration' }>).body.body); }

    // `const Page = () => …` / `const Page = function () {…}`
    for (const stmt of body) {
      if (stmt.type !== 'VariableDeclaration') { continue; }
      for (const d of stmt.declarations) {
        if (d.id.type !== 'Identifier' || d.id.name !== 'Page' || !d.init) { continue; }
        if (d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression') {
          return this._fromFunctionLike(d.init.body);
        }
      }
    }

    // A single unnamed component.
    const fns = body.filter(s => s.type === 'FunctionDeclaration');
    if (fns.length === 1) {
      return this._fromFunctionBody((fns[0] as Extract<Statement, { type: 'FunctionDeclaration' }>).body.body);
    }

    // A bare JSX expression as the whole source.
    for (const stmt of body) {
      if (stmt.type === 'ExpressionStatement' && stmt.expression.type === 'JSXElement') {
        return stmt.expression;
      }
    }

    if (fns.length > 1) {
      throw new CompileError('several components in one page source — expected a single `function Page()`');
    }
    throw new CompileError('no `function Page()` returning JSX was found');
  }

  private _fromFunctionLike(body: BabelNode): JSXElement {
    if (body.type === 'BlockStatement') { return this._fromFunctionBody(body.body); }
    return this._asRootElement(body as Expression);
  }

  private _fromFunctionBody(stmts: Statement[]): JSXElement {
    let ret: Expression | null = null;
    for (const stmt of stmts) {
      switch (stmt.type) {
        case 'VariableDeclaration':
          for (const d of stmt.declarations) {
            if (d.id.type !== 'Identifier') {
              this._fail(d, 'destructuring bindings are outside the JSX subset');
            }
            if (!d.init) { continue; }
            this._scope.set(d.id.name, d.init as Expression);
          }
          break;
        case 'ReturnStatement':
          if (!stmt.argument) { this._fail(stmt, 'empty `return` — a page must return JSX'); }
          ret = stmt.argument;
          break;
        case 'EmptyStatement':
          break;
        default:
          this._fail(stmt, `\`${stmt.type}\` is outside the JSX subset (no runtime logic in a page)`);
      }
    }
    if (!ret) { throw new CompileError('`function Page()` has no `return`'); }
    return this._asRootElement(ret);
  }

  private _asRootElement(expr: Expression): JSXElement {
    const resolved = this._resolve(expr);
    if (resolved.type === 'JSXElement') { return resolved; }
    if (resolved.type === 'JSXFragment') {
      this._fail(resolved, 'a page must have a single root element, not a fragment');
    }
    this._fail(resolved, `a page must return a JSX element, got \`${resolved.type}\``);
  }

  /* ── identifier resolution (local const bindings, inlined at use) ── */

  private _resolve(expr: Expression): Expression {
    if (expr.type !== 'Identifier') { return expr; }
    const bound = this._scope.get(expr.name);
    if (!bound) { return expr; }
    if (this._resolving.has(expr.name)) {
      this._fail(expr, `\`${expr.name}\` refers to itself`);
    }
    this._resolving.add(expr.name);
    try {
      return this._resolve(bound);
    } finally {
      this._resolving.delete(expr.name);
    }
  }

  /* ── mids ── */

  private _mid(hint?: string): Mid {
    if (hint && isMid(hint) && !this._seenMids.has(hint)) {
      this._seenMids.add(hint);
      return hint;
    }
    // A mid from a model is a HINT, never an authority: an unknown shape or a
    // duplicate is discarded and re-minted rather than corrupting identity.
    for (let i = 0; i < 8; i++) {
      const m = mintMid(this._rand);
      if (!this._seenMids.has(m)) { this._seenMids.add(m); return m; }
    }
    // A degenerate RNG (a constant test stub) must not deadlock the compiler:
    // fall back to a counter-seeded stream that still mints a well-formed mid.
    for (let i = 0; i < 10_000; i++) {
      let seed = ++this._fallback;
      const m = mintMid(() => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return seed / 4294967296;
      });
      if (!this._seenMids.has(m)) { this._seenMids.add(m); return m; }
    }
    throw new CompileError('could not mint a unique element id');
  }

  /* ── elements ── */

  private _element(el: JSXElement): DocNode {
    if (this._depth > MAX_DEPTH) {
      throw new CompileError(`page nests deeper than ${MAX_DEPTH} elements`);
    }
    this._depth++;
    try {
      const tag = jsxNameOf(el, (n, m) => this._fail(n, m));
      const { midHint, props, style, slots } = this._attributes(el.openingElement.attributes);
      const node: DocNode = { mid: this._mid(midHint), tag };
      if (props && Object.keys(props).length) { node.props = props; }
      if (style && Object.keys(style).length) { node.style = style; }
      if (slots && Object.keys(slots).length) { node.slots = slots; }

      const items = this._children(el.children);
      applyChildItems(node, items, () => this._mid());
      return node;
    } finally {
      this._depth--;
    }
  }

  private _attributes(attrs: Array<JSXAttribute | JSXSpreadAttribute>): {
    midHint?: string;
    props: Record<string, JsonValue>;
    style: Record<string, string>;
    slots: Record<string, DocNode[]>;
  } {
    const props: Record<string, JsonValue> = {};
    const style: Record<string, string> = {};
    const slots: Record<string, DocNode[]> = {};
    let midHint: string | undefined;

    for (const attr of attrs) {
      if (attr.type === 'JSXSpreadAttribute') {
        this._fail(attr, 'prop spread `{...x}` is outside the JSX subset');
      }
      const name = attrName(attr, (n, m) => this._fail(n, m));

      if (name === 'mid') {
        const v = attr.value;
        if (v && v.type === 'StringLiteral') { midHint = v.value; }
        else if (v && v.type === 'JSXExpressionContainer' && v.expression.type === 'StringLiteral') {
          midHint = v.expression.value;
        }
        // Any other shape is simply discarded — a fresh mid is minted.
        continue;
      }

      if (name === 'style') {
        for (const [k, val] of Object.entries(this._style(attr))) { setCell(style, k, val); }
        continue;
      }

      const value = this._propValue(attr);
      if (value.kind === 'slot') {
        setCell(slots, name, value.nodes);
        delete props[name];
      } else {
        setCell(props, name, value.value);
        delete slots[name];
      }
    }

    return { midHint, props, style, slots };
  }

  private _style(attr: JSXAttribute): Record<string, string> {
    const v = attr.value;
    if (!v || v.type !== 'JSXExpressionContainer') {
      this._fail(attr, 'style must be an object expression: style={{ … }}');
    }
    if (v.expression.type === 'JSXEmptyExpression') {
      this._fail(attr, 'style must be an object expression: style={{ … }}');
    }
    const obj = this._resolve(v.expression);
    if (obj.type !== 'ObjectExpression') {
      this._fail(obj, `style must be an object literal, got \`${obj.type}\``);
    }
    return this._styleObject(obj);
  }

  private _styleObject(obj: ObjectExpression): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of obj.properties) {
      if (p.type !== 'ObjectProperty') {
        this._fail(p, 'spread and methods are outside the style subset');
      }
      let raw: string;
      // A computed key is accepted ONLY as a string literal — `['__proto__']`,
      // the sole form in which that name can be a property rather than a
      // prototype directive. Anything else computed is runtime logic.
      if (p.computed) {
        if (p.key.type !== 'StringLiteral') { this._fail(p, 'computed style keys are outside the JSX subset'); }
        raw = p.key.value;
      }
      else if (p.key.type === 'Identifier') { raw = p.key.name; }
      else if (p.key.type === 'StringLiteral') { raw = p.key.value; }
      else { this._fail(p, `unsupported style key \`${p.key.type}\``); }

      const value = this._resolve(p.value as Expression);
      if (value.type === 'NullLiteral') { continue; }
      const key = normalizeStyleKey(raw);
      const lit = this._literal(value);
      if (typeof lit === 'string') { setCell(out, key, lit); }
      else if (typeof lit === 'number') { setCell(out, key, styleNumber(key, lit)); }
      else { this._fail(value, `style values must be strings or numbers, got \`${value.type}\``); }
    }
    return out;
  }

  private _propValue(attr: JSXAttribute):
    | { kind: 'json'; value: JsonValue }
    | { kind: 'slot'; nodes: DocNode[] } {
    const v = attr.value;
    // Shorthand `<UI.Text muted />`
    if (v === null || v === undefined) { return { kind: 'json', value: true }; }
    if (v.type === 'StringLiteral') { return { kind: 'json', value: v.value }; }
    if (v.type === 'JSXElement' || v.type === 'JSXFragment') {
      return { kind: 'slot', nodes: this._slotNodes(v) };
    }
    if (v.type !== 'JSXExpressionContainer') {
      const other = v as BabelNode;
      this._fail(other, `unsupported prop value \`${other.type}\``);
    }
    if (v.expression.type === 'JSXEmptyExpression') {
      this._fail(v, `prop \`${attrName(attr, (n, m) => this._fail(n, m))}\` has an empty value`);
    }
    const expr = this._resolve(v.expression);

    if (expr.type === 'JSXElement' || expr.type === 'JSXFragment') {
      return { kind: 'slot', nodes: this._slotNodes(expr) };
    }
    if (expr.type === 'ArrayExpression') {
      const elements = expr.elements;
      const resolved = elements.map(e => {
        if (e === null) { this._fail(expr, 'array holes are outside the JSX subset'); }
        if (e.type === 'SpreadElement') { this._fail(e, 'array spread is outside the JSX subset'); }
        return this._resolve(e as Expression);
      });
      const jsxCount = resolved.filter(e => e.type === 'JSXElement' || e.type === 'JSXFragment').length;
      if (jsxCount > 0) {
        if (jsxCount !== resolved.length) {
          this._fail(expr, 'an array prop must be all JSX or all literal data, not a mix');
        }
        const nodes: DocNode[] = [];
        for (const e of resolved) { nodes.push(...this._slotNodes(e as JSXElement | JSXFragment)); }
        return { kind: 'slot', nodes };
      }
    }
    return { kind: 'json', value: this._literal(expr) };
  }

  private _slotNodes(expr: JSXElement | JSXFragment): DocNode[] {
    if (expr.type === 'JSXElement') { return [this._element(expr)]; }
    const out: DocNode[] = [];
    for (const item of this._children(expr.children)) {
      if (item.kind === 'node' && item.node) { out.push(item.node); }
      else if (item.kind === 'text' && item.text) {
        out.push({ mid: this._mid(), tag: 'span', text: item.text });
      }
    }
    return out;
  }

  /** Literal folding. Everything that is not JSON-shaped data fails here. */
  private _literal(expr: Expression): JsonValue {
    const e = this._resolve(expr);
    switch (e.type) {
      case 'StringLiteral': return e.value;
      case 'NumericLiteral': return e.value;
      case 'BooleanLiteral': return e.value;
      case 'NullLiteral': return null;
      case 'Identifier':
        if (e.name === 'undefined') { return null; }
        this._fail(e, `\`${e.name}\` is not defined in this page`);
        break;
      case 'UnaryExpression':
        if ((e.operator === '-' || e.operator === '+') && e.argument.type === 'NumericLiteral') {
          return e.operator === '-' ? -e.argument.value : e.argument.value;
        }
        this._fail(e, `\`${e.operator}\` expressions are outside the JSX subset`);
        break;
      case 'TemplateLiteral':
        if (e.expressions.length === 0 && e.quasis.length === 1) {
          return e.quasis[0].value.cooked ?? e.quasis[0].value.raw;
        }
        this._fail(e, 'template interpolation is outside the JSX subset');
        break;
      case 'ArrayExpression': {
        const out: JsonValue[] = [];
        for (const el of e.elements) {
          if (el === null) { this._fail(e, 'array holes are outside the JSX subset'); }
          if (el.type === 'SpreadElement') { this._fail(el, 'array spread is outside the JSX subset'); }
          out.push(this._literal(el as Expression));
        }
        return out;
      }
      case 'ObjectExpression': {
        const out: Record<string, JsonValue> = {};
        for (const p of e.properties) {
          if (p.type !== 'ObjectProperty') { this._fail(p, 'spread and methods are outside the JSX subset'); }
          // As in style objects: computed is accepted only as a string literal,
          // which is how `__proto__` is written as data rather than a directive.
          if (p.computed && p.key.type !== 'StringLiteral') {
            this._fail(p, 'computed keys are outside the JSX subset');
          }
          const key = p.key.type === 'StringLiteral' ? p.key.value
            : p.key.type === 'Identifier' ? p.key.name
              : p.key.type === 'NumericLiteral' ? String(p.key.value)
                : this._fail(p, `unsupported object key \`${p.key.type}\``);
          setCell(out, key, this._literal(p.value as Expression));
        }
        return out;
      }
      default:
        this._fail(e, `\`${e.type}\` is outside the JSX subset (props must be literal data)`);
    }
    /* istanbul ignore next — every branch above either returns or throws. */
    throw new CompileError('unreachable');
  }

  /* ── children ── */

  private _children(children: JSXElement['children']): ChildItem[] {
    const items: ChildItem[] = [];
    for (const child of children) {
      switch (child.type) {
        case 'JSXText': {
          const text = cleanJsxText(child.value);
          if (text) { items.push({ kind: 'text', text }); }
          break;
        }
        case 'JSXElement':
          items.push({ kind: 'node', node: this._element(child) });
          break;
        case 'JSXFragment':
          for (const n of this._slotNodes(child)) { items.push({ kind: 'node', node: n }); }
          break;
        case 'JSXExpressionContainer': {
          if (child.expression.type === 'JSXEmptyExpression') { break; } // {/* comment */}
          const expr = this._resolve(child.expression);
          if (expr.type === 'JSXElement' || expr.type === 'JSXFragment') {
            for (const n of this._slotNodes(expr)) { items.push({ kind: 'node', node: n }); }
            break;
          }
          if (expr.type === 'ArrayExpression') {
            const parts = expr.elements.map(e => {
              if (e === null) { this._fail(expr, 'array holes are outside the JSX subset'); }
              if (e.type === 'SpreadElement') { this._fail(e, 'array spread is outside the JSX subset'); }
              return this._resolve(e as Expression);
            });
            if (parts.length && parts.every(p => p.type === 'JSXElement' || p.type === 'JSXFragment')) {
              for (const p of parts) {
                for (const n of this._slotNodes(p as JSXElement | JSXFragment)) {
                  items.push({ kind: 'node', node: n });
                }
              }
              break;
            }
            this._fail(expr, 'only arrays of JSX may be used as children');
          }
          const lit = this._literal(expr);
          // `{false}` / `{null}` render nothing in JSX — mirror that.
          if (lit === null || typeof lit === 'boolean') { break; }
          items.push({ kind: 'text', text: String(lit) });
          break;
        }
        case 'JSXSpreadChild':
          this._fail(child, 'spread children are outside the JSX subset');
          break;
        default:
          this._fail(child as BabelNode, `unsupported child \`${(child as BabelNode).type}\``);
      }
    }
    return items;
  }

  private _fail(node: { loc?: BabelNode['loc'] } | BabelNode, message: string): never {
    const line = node && 'loc' in node ? node.loc?.start.line : undefined;
    throw new CompileError(line ? `${message} (line ${line})` : message);
  }
}

const MAX_DEPTH = 200;

/**
 * Fold a child list onto a node.
 *
 * `text` and `children` are mutually exclusive on {@link DocNode}, so mixed
 * content (`<p>Hello <b>world</b></p>`) has its bare text runs wrapped in
 * `span` nodes IN PLACE — order preserved, nothing dropped, and the result
 * round-trips through {@link ./DocEmitter} unchanged.
 */
function applyChildItems(node: DocNode, items: ChildItem[], mint: () => Mid): void {
  if (!items.length) { return; }
  const hasNodes = items.some(i => i.kind === 'node');
  if (!hasNodes) {
    const text = items.map(i => i.text ?? '').join('');
    if (text) { node.text = text; }
    return;
  }
  const children: DocNode[] = [];
  for (const item of items) {
    if (item.kind === 'node' && item.node) { children.push(item.node); }
    else if (item.kind === 'text' && item.text) { children.push({ mid: mint(), tag: 'span', text: item.text }); }
  }
  if (children.length) { node.children = children; }
}

/* ─────────────────────────── names & literals ─────────────────────────── */

/**
 * `record[key] = value` — except for the one key that is not a key.
 *
 * `record['__proto__'] = v` runs `Object.prototype`'s accessor and REPLACES the
 * record's prototype instead of storing anything, so a model writing
 * `data={{ __proto__: { x: 1 } }}` would produce a props object that reports no
 * such key from `Object.keys` and `JSON.stringify` while `for…in` and plain
 * lookups still saw `x` — silent, invisible drift, and a prototype the model
 * chose. `defineProperty` stores it as an ordinary own data property instead:
 * inert, enumerable, JSON-round-tripping, prototype untouched.
 *
 * Dropping the key would have been simpler, but `DocPatch.applyOp` treats a
 * cell named `__proto__` as ordinary data and requires it to survive inversion,
 * so dropping it here would silently erase, on the next `read_page` → rewrite,
 * a cell the op layer had just committed. {@link ./DocEmitter} prints it in the
 * computed form `{ ['__proto__']: … }`, which is likewise a plain property.
 */
function setCell<T>(target: Record<string, T>, key: string, value: T): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
    return;
  }
  target[key] = value;
}

function unwrapExport(stmt: Statement): Statement | null {
  if (stmt.type === 'ExportDefaultDeclaration') {
    const d = stmt.declaration;
    if (d.type === 'FunctionDeclaration') { return d as Statement; }
    if (d.type === 'ArrowFunctionExpression' || d.type === 'FunctionExpression') {
      // `export default () => <JSX/>` — surface it as an expression statement.
      return { type: 'ExpressionStatement', expression: d, loc: stmt.loc } as unknown as Statement;
    }
    return null;
  }
  if (stmt.type === 'ExportNamedDeclaration') { return stmt.declaration ?? null; }
  if (stmt.type === 'ImportDeclaration') { return null; }
  return stmt;
}

function jsxNameOf(el: JSXElement, fail: (n: BabelNode, m: string) => never): string {
  const name = el.openingElement.name;
  if (name.type === 'JSXIdentifier') { return name.name; }
  if (name.type === 'JSXMemberExpression') {
    const parts: string[] = [];
    let cur: typeof name.object | typeof name = name;
    while (cur.type === 'JSXMemberExpression') { parts.unshift(cur.property.name); cur = cur.object; }
    if (cur.type !== 'JSXIdentifier') { fail(el, 'unsupported element name'); }
    parts.unshift(cur.name);
    return parts.join('.');
  }
  return fail(el, 'namespaced element names are outside the JSX subset');
}

function attrName(attr: JSXAttribute, fail: (n: BabelNode, m: string) => never): string {
  const n = attr.name;
  if (n.type === 'JSXIdentifier') { return n.name; }
  if (n.type === 'JSXNamespacedName') { return `${n.namespace.name}:${n.name.name}`; }
  return fail(attr, 'unsupported prop name');
}

/**
 * Babel's JSX text semantics, reimplemented (we parse only — there is no
 * transform to lean on). Indentation-only lines vanish; interior newlines
 * collapse to a single space; a single-line run keeps its exact spacing.
 */
export function cleanJsxText(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  let lastNonEmpty = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/[^ \t]/.test(lines[i])) { lastNonEmpty = i; }
  }
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/\t/g, ' ');
    if (i !== 0) { line = line.replace(/^ +/, ''); }
    if (i !== lines.length - 1) { line = line.replace(/ +$/, ''); }
    if (!line) { continue; }
    if (i !== lastNonEmpty) { line += ' '; }
    out += line;
  }
  return out;
}

/** `alignItems` → `align-items`; `WebkitFilter` → `-webkit-filter`; `--x` kept. */
export function normalizeStyleKey(raw: string): string {
  if (raw.startsWith('--')) { return raw; }
  if (raw.includes('-')) { return raw; }
  const kebab = raw.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
  return kebab.startsWith('-') && !kebab.startsWith('--') ? kebab : kebab;
}

/**
 * CSS properties that take a bare number. Matches React's list so a page
 * authored for React renders identically under the doc interpreter.
 */
export const UNITLESS_STYLE_PROPS: ReadonlySet<string> = new Set([
  'animation-iteration-count', 'aspect-ratio', 'border-image-outset', 'border-image-slice',
  'border-image-width', 'box-flex', 'box-flex-group', 'box-ordinal-group', 'column-count',
  'columns', 'flex', 'flex-grow', 'flex-positive', 'flex-shrink', 'flex-negative', 'flex-order',
  'grid-area', 'grid-row', 'grid-row-end', 'grid-row-span', 'grid-row-start', 'grid-column',
  'grid-column-end', 'grid-column-span', 'grid-column-start', 'font-weight', 'line-clamp',
  'line-height', 'opacity', 'order', 'orphans', 'tab-size', 'widows', 'z-index', 'zoom',
  'fill-opacity', 'flood-opacity', 'stop-opacity', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-miterlimit', 'stroke-opacity', 'stroke-width',
]);

/** React's rule: `0` and unitless properties stay bare, everything else gets `px`. */
export function styleNumber(key: string, n: number): string {
  if (!Number.isFinite(n)) { return '0'; }
  if (n === 0 || UNITLESS_STYLE_PROPS.has(key) || key.startsWith('--')) { return String(n); }
  return `${n}px`;
}

/* ─────────────────────── partial-source repair ─────────────────────── */

const MAX_PARTIAL_ATTEMPTS = 32;
/**
 * Wall-clock ceiling for the repair search. `compilePartial` runs on the
 * streaming path behind a ~150 ms throttle, so a pathological prefix must give
 * up rather than starve the render — a stale partial is fine, a stalled UI is not.
 */
const PARTIAL_BUDGET_MS = 200;

type Frame =
  | { k: 'tag'; name: string }
  | { k: 'el'; name: string }
  | { k: 'br'; ch: '(' | '{' | '[' };

/**
 * Cut points a truncated page may safely be trimmed to, largest first.
 *
 * A `>` is the end of a JSX tag, which is the only place a prefix can be closed
 * synthetically without inventing content. The full length is tried first (the
 * common case is truncation inside element CONTENT, which needs no cut at all).
 */
function cutCandidates(source: string): number[] {
  const out: number[] = [source.length];
  for (let i = source.length - 1; i >= 0 && out.length <= MAX_PARTIAL_ATTEMPTS; i--) {
    if (source[i] === '>') { out.push(i + 1); }
  }
  return out;
}

/**
 * Close every element and bracket a prefix leaves open. `null` when the prefix
 * ends somewhere that cannot be closed honestly — inside a string, a comment or
 * a half-written opening tag.
 */
export function repairPrefix(src: string): string | null {
  const stack = scanOpenFrames(src);
  if (stack === null) { return null; }
  let out = src;
  for (let i = stack.length - 1; i >= 0; i--) {
    const f = stack[i];
    if (f.k === 'tag') { return null; }
    if (f.k === 'el') { out += f.name ? `</${f.name}>` : '</>'; }
    else { out += f.ch === '(' ? ')' : f.ch === '[' ? ']' : '}'; }
  }
  return out;
}

/**
 * A deliberately small JSX-aware scanner. It does NOT build a document — the
 * evaluator above does that, from source Babel accepted. Its only job is to
 * report what is still open, and a wrong guess is harmless: the repaired source
 * simply fails to parse and the caller tries an earlier cut.
 */
function scanOpenFrames(src: string): Frame[] | null {
  const stack: Frame[] = [];
  const top = (): Frame | undefined => stack[stack.length - 1];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const t = top();
    const mode = !t ? 'js' : t.k === 'tag' ? 'tag' : t.k === 'el' ? 'text' : 'js';
    const c = src[i];

    if (mode !== 'text') {
      if (c === '/' && src[i + 1] === '/') {
        const nl = src.indexOf('\n', i);
        if (nl < 0) { return null; }
        i = nl + 1; continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        if (end < 0) { return null; }
        i = end + 2; continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        const end = skipString(src, i);
        if (end < 0) { return null; }
        i = end; continue;
      }
    }

    if (mode === 'tag') {
      if (c === '{') { stack.push({ k: 'br', ch: '{' }); i++; continue; }
      if (c === '/' && src[i + 1] === '>') { stack.pop(); i += 2; continue; }
      if (c === '>') {
        const frame = stack.pop() as Frame & { k: 'tag' };
        stack.push({ k: 'el', name: frame.name });
        i++; continue;
      }
      i++; continue;
    }

    if (mode === 'text') {
      if (c === '{') { stack.push({ k: 'br', ch: '{' }); i++; continue; }
      if (c === '<' && src[i + 1] === '/') {
        const close = /^<\/\s*([A-Za-z_$][\w.$:-]*)?\s*>/.exec(src.slice(i));
        if (!close) { return null; }
        stack.pop();
        i += close[0].length; continue;
      }
      if (c === '<') {
        const opened = openTagAt(src, i);
        if (opened) { stack.push({ k: 'tag', name: opened.name }); i = opened.next; continue; }
        i++; continue;
      }
      i++; continue;
    }

    // js
    if (c === '(' || c === '{' || c === '[') { stack.push({ k: 'br', ch: c }); i++; continue; }
    if (c === ')' || c === '}' || c === ']') {
      if (top()?.k === 'br') { stack.pop(); }
      i++; continue;
    }
    if (c === '<') {
      const opened = openTagAt(src, i);
      if (opened) { stack.push({ k: 'tag', name: opened.name }); i = opened.next; continue; }
      i++; continue;
    }
    i++;
  }

  return stack;
}

function openTagAt(src: string, i: number): { name: string; next: number } | null {
  if (src[i + 1] === '>') { return { name: '', next: i + 2 } as { name: string; next: number }; } // <>
  const m = /^<\s*([A-Za-z_$][\w.$:-]*)/.exec(src.slice(i, i + 96));
  if (!m) { return null; }
  return { name: m[1], next: i + m[0].length };
}

function skipString(src: string, i: number): number {
  const quote = src[i];
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === quote) { return j + 1; }
    if (quote !== '`' && (c === '\n' || c === '\r')) { return -1; }
  }
  return -1;
}

/* ─────────────────────────────── utilities ─────────────────────────────── */

/** A structural copy with every mid replaced — used by tests and reconciliation. */
export function withFreshMids(node: DocNode, rand?: () => number): DocNode {
  const out = cloneNode(node);
  for (const n of walkAll(out)) { n.mid = mintMid(rand); }
  return out;
}

function* walkAll(n: DocNode): Generator<DocNode> {
  yield n;
  for (const c of n.children ?? []) { yield* walkAll(c); }
  for (const list of Object.values(n.slots ?? {})) {
    for (const c of list) { yield* walkAll(c); }
  }
}
