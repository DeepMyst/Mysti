/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * A minimal fake DOM for the canvas webview tests.
 *
 * The repo ships no jsdom and `tsconfig.json` has no `lib.dom`, which is why
 * `src/webview/canvas/dom.ts` declares the DOM structurally and every module
 * takes it by injection. This is the other half of that bargain: a ~120-line
 * fake that makes the renderer, the board lifecycle and the frame ports
 * assertable headlessly.
 *
 * The important detail is {@link FakeElement.innerHTML}, which THROWS on both
 * read and write. `DomElement` does not declare it, so a direct use is already
 * a compile error; the throw catches a regression that reaches for it through a
 * cast, which is the only way it could ever come back.
 */

export class FakeStyle {
  readonly props = new Map<string, string>();
  setProperty(name: string, value: string): void { this.props.set(name, value); }
  removeProperty(name: string): void { this.props.delete(name); }
  get(name: string): string | undefined { return this.props.get(name); }
}

export interface FakeContentWindow {
  posts: Array<{ message: unknown; targetOrigin: string; transfer?: unknown[] }>;
  postMessage(message: unknown, targetOrigin: string, transfer?: unknown[]): void;
}

export class FakeElement {
  readonly attrs = new Map<string, string>();
  readonly style = new FakeStyle();
  readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  className = '';
  hidden = false;
  value = '';
  srcdoc = '';
  srcdocWrites = 0;
  contentWindow: FakeContentWindow | null = null;
  private _text: string | null = null;

  constructor(readonly tag: string) {
    if (tag === 'iframe') {
      const win: FakeContentWindow = {
        posts: [],
        postMessage(message, targetOrigin, transfer) {
          win.posts.push({ message, targetOrigin, transfer });
        },
      };
      this.contentWindow = win;
    }
  }

  get textContent(): string | null { return this._text; }
  set textContent(value: string | null) { this._text = value; this.children = []; }

  /** Present ONLY so a regression that reaches for it fails loudly. */
  get innerHTML(): string { throw new Error('innerHTML read in the canvas webview'); }
  set innerHTML(_value: string) { throw new Error('innerHTML written in the canvas webview'); }

  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  removeAttribute(name: string): void { this.attrs.delete(name); }

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeElement): FakeElement {
    this.children = this.children.filter(c => c !== child);
    child.parent = null;
    return child;
  }

  replaceChildren(...nodes: FakeElement[]): void {
    for (const c of this.children) { c.parent = null; }
    this.children = [];
    this._text = null;
    for (const n of nodes) { this.appendChild(n); }
  }

  remove(): void { this.parent?.removeChild(this); }

  addEventListener(type: string, listener: (ev: unknown) => void): void {
    const list = this.listeners.get(type);
    if (list) { list.push(listener); } else { this.listeners.set(type, [listener]); }
  }

  /** Fire a listener registered with {@link addEventListener}. */
  fire(type: string, ev: unknown = {}): void {
    for (const l of this.listeners.get(type) ?? []) { l(ev); }
  }

  /** Every element in this subtree, self first. */
  *walk(): Generator<FakeElement> {
    yield this;
    for (const child of this.children) { yield* child.walk(); }
  }

  /** All text in this subtree, concatenated. */
  allText(): string {
    let out = this._text ?? '';
    for (const child of this.children) { out += child.allText(); }
    return out;
  }

  find(predicate: (el: FakeElement) => boolean): FakeElement | null {
    for (const el of this.walk()) { if (predicate(el)) { return el; } }
    return null;
  }

  findAll(predicate: (el: FakeElement) => boolean): FakeElement[] {
    return [...this.walk()].filter(predicate);
  }
}

export class FakeDocument {
  readonly created: FakeElement[] = [];
  readonly byId = new Map<string, FakeElement>();

  createElement(tag: string): FakeElement {
    const el = new FakeElement(tag);
    this.created.push(el);
    return el;
  }

  createTextNode(data: string): FakeElement {
    const el = new FakeElement('#text');
    el.textContent = data;
    return el;
  }

  getElementById(id: string): FakeElement | null { return this.byId.get(id) ?? null; }

  /** Register an element the shell HTML would have provided. */
  seed(id: string, tag = 'div'): FakeElement {
    const el = new FakeElement(tag);
    this.byId.set(id, el);
    return el;
  }

  countTag(tag: string): number { return this.created.filter(e => e.tag === tag).length; }
}

/* ------------------------------ channels ------------------------------ */

export class FakePort {
  readonly posted: unknown[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  started = false;
  closed = false;
  peer: FakePort | null = null;

  postMessage(message: unknown): void {
    if (this.closed) { throw new Error('post on a closed port'); }
    this.posted.push(message);
  }
  start(): void { this.started = true; }
  close(): void { this.closed = true; }
  /** Simulate the frame answering on its end. */
  deliver(data: unknown): void { this.onmessage?.({ data }); }
}

export class FakeChannel {
  readonly port1 = new FakePort();
  readonly port2 = new FakePort();
  constructor() { this.port1.peer = this.port2; this.port2.peer = this.port1; }
}

export class FakeIntersectionObserver {
  readonly observed = new Set<unknown>();
  constructor(readonly callback: (entries: readonly { target: unknown; isIntersecting: boolean }[]) => void) {}
  observe(target: unknown): void { this.observed.add(target); }
  unobserve(target: unknown): void { this.observed.delete(target); }
  disconnect(): void { this.observed.clear(); }
  /** Drive the observer by hand. */
  emit(entries: Array<{ target: unknown; isIntersecting: boolean }>): void { this.callback(entries); }
}
