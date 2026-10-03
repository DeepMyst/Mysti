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
 * Plan 22 §3.4 — the canvas webview's DOM seam.
 *
 * `tsconfig.json` ships `lib: ["ES2022"]` with **no** `lib.dom`, and widening it
 * would change type resolution for the whole extension host. So the canvas
 * bundle declares the *structural* slice of the DOM it actually uses, exactly
 * as `protocol.ts` does for `crypto.getRandomValues`.
 *
 * That constraint turns out to be the feature: because every module takes a
 * {@link CanvasEnv} instead of reaching for the ambient `document`, the board,
 * the preview renderer and the artboard lifecycle are all drivable from a fake
 * DOM in vitest — which matters here, since the repo has no jsdom and the
 * alternative would be an untested 300-line renderer (precisely the state
 * `media/canvas/canvas.js` was in).
 *
 * NOTE the deliberate omission: {@link DomElement} has **no `innerHTML`**. The
 * parent-side preview renderer sets `textContent` and nothing else, and the
 * type system is what enforces it rather than a code-review note.
 */

/** The subset of `CSSStyleDeclaration` the board writes through. */
export interface DomStyle {
  setProperty(name: string, value: string): void;
  removeProperty(name: string): string | void;
}

/** Anything appendable. Text nodes and elements both satisfy it. */
export interface DomNode {
  readonly nodeType?: number;
}

/**
 * An element. `innerHTML` is intentionally absent — see the module docs.
 * `textContent` is the ONLY content channel, and assigning it never parses.
 */
export interface DomElement extends DomNode {
  readonly style: DomStyle;
  textContent: string | null;
  className: string;
  hidden: boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  appendChild(child: DomNode): DomNode;
  removeChild(child: DomNode): DomNode;
  /** Clears children without touching `innerHTML`. */
  replaceChildren(...nodes: DomNode[]): void;
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  remove(): void;
}

/** `<select>` / `<option>` / `<input>` - the only elements with a `value`. */
export interface DomValueElement extends DomElement {
  value: string;
}

/** An `<iframe>` used as a live artboard. */
export interface DomIframe extends DomElement {
  srcdoc: string;
  readonly contentWindow: {
    postMessage(message: unknown, targetOrigin: string, transfer?: unknown[]): void;
  } | null;
}

export interface DomDocument {
  createElement(tag: 'iframe'): DomIframe;
  createElement(tag: 'select' | 'option' | 'input'): DomValueElement;
  createElement(tag: string): DomElement;
  createTextNode(data: string): DomNode;
  getElementById(id: string): DomElement | null;
}

/**
 * Narrow a looked-up element to one carrying a `value`. The single cast for
 * form controls, kept here so no consumer has to reach for `as` inline.
 */
export function asValueElement(el: DomElement): DomValueElement {
  return el as DomValueElement;
}

/* ───────────────────────── observers & channels ───────────────────────── */

export interface IntersectionEntryLike {
  readonly target: DomElement;
  readonly isIntersecting: boolean;
}

export interface IntersectionObserverLike {
  observe(target: DomElement): void;
  unobserve(target: DomElement): void;
  disconnect(): void;
}

export type IntersectionObserverFactory = (
  callback: (entries: readonly IntersectionEntryLike[]) => void,
  options?: { root?: DomElement | null; rootMargin?: string; threshold?: number },
) => IntersectionObserverLike;

/** One end of the artboard's dedicated {@link MessageChannelLike}. */
export interface MessagePortLike {
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface MessageChannelLike {
  readonly port1: MessagePortLike;
  readonly port2: MessagePortLike;
}

export type MessageChannelFactory = () => MessageChannelLike;

/** A `message` event as it arrives on the webview window. */
export interface WindowMessageEvent {
  readonly data: unknown;
  /** `null`/the window itself for host messages; a frame for embedded senders. */
  readonly source?: unknown;
}

/**
 * Everything the canvas webview touches outside its own module graph.
 *
 * Injected rather than imported so a test can supply a fake DOM, a fake
 * `IntersectionObserver` it drives by hand, and a `MessageChannel` whose ports
 * it can inspect.
 */
export interface CanvasEnv {
  doc: DomDocument;
  /** The webview window, for the host message channel. */
  self: {
    addEventListener(type: string, listener: (ev: unknown) => void): void;
  };
  createIntersectionObserver: IntersectionObserverFactory | null;
  createMessageChannel: MessageChannelFactory;
  /** Lazy runtime fetch (React / primitives / harness / Babel-for-legacy). */
  fetchText: (url: string) => Promise<string>;
  now: () => number;
  warn: (message: string, ...rest: unknown[]) => void;
}

/**
 * Adapt the real browser globals to {@link CanvasEnv}. The single cast in the
 * bundle: everything downstream is structurally typed.
 */
export function realEnv(): CanvasEnv {
  const g = globalThis as unknown as {
    document: DomDocument;
    addEventListener(type: string, listener: (ev: unknown) => void): void;
    IntersectionObserver?: new (
      cb: (entries: readonly IntersectionEntryLike[]) => void,
      opts?: { root?: DomElement | null; rootMargin?: string; threshold?: number },
    ) => IntersectionObserverLike;
    MessageChannel: new () => MessageChannelLike;
    fetch: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  };
  const IO = g.IntersectionObserver;
  return {
    doc: g.document,
    self: { addEventListener: (t, l) => g.addEventListener(t, l) },
    createIntersectionObserver: IO ? (cb, opts) => new IO(cb, opts) : null,
    createMessageChannel: () => new g.MessageChannel(),
    fetchText: async (url: string) => {
      const res = await g.fetch(url);
      if (!res.ok) { throw new Error(`[Mysti] canvas runtime fetch failed (${res.status}): ${url}`); }
      return res.text();
    },
    now: () => Date.now(),
    warn: (message, ...rest) => { console.warn(`[Mysti] ${message}`, ...rest); },
  };
}
