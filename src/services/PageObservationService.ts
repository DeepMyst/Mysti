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
 * Turns a live page into a deterministic, text-first OBSERVATION.
 *
 * Why text-first: the coordinator's default model chain is text-only, and most
 * CLI backends see an image only if their provider advertises `supportsImages`.
 * A screenshot alone therefore fails for the majority of callers. Worse, a blank
 * white page — the single most common symptom of a broken UI change — carries no
 * information in a picture at all, while the console holds the exact stack trace.
 *
 * So the digest is the PRIMARY channel and the screenshot is the bonus, ordered
 * most-actionable first: console errors, failed requests, layout probes, the
 * accessibility tree, then a DOM outline.
 *
 * Every probe script here is a FIXED, extension-authored function passed to
 * `page.evaluate` with marshalled arguments. Caller-supplied strings are only
 * ever *arguments* (selectors), never source — that is the generalisation of the
 * scroll-interpolation injection this subsystem used to ship.
 */

import {
  VISUAL_CONSOLE_BUFFER,
  VISUAL_NETWORK_BUFFER,
  VISUAL_DIGEST_MAX_CHARS,
  VISUAL_DOM_OUTLINE_MAX_CHARS,
} from '../constants';
import type { VisualConsoleEntry, VisualNetworkFailure, VisualLayoutProbe, VisualObservation } from '../types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Page = any;

// The `page.evaluate` callback in probeLayout runs in the BROWSER. This project's
// tsconfig targets Node and has no `dom` lib, so the browser globals it touches
// are declared locally; Playwright serialises the function and runs it in the
// page, where they genuinely exist. Nothing here is captured from outer scope —
// a serialised function that closed over module state would fail at runtime.
declare const window: any;
declare const document: any;
type Element = any;

/** Bounded FIFO — page output is unbounded and attacker-influenceable. */
class RingBuffer<T> {
  private _items: T[] = [];
  constructor(private readonly _max: number) {}
  push(item: T): void {
    this._items.push(item);
    if (this._items.length > this._max) { this._items.shift(); }
  }
  get items(): T[] { return this._items; }
  get length(): number { return this._items.length; }
  clear(): void { this._items = []; }
}

/**
 * Attaches to a page once and records console + network activity for the life of
 * the session. Buffers are cleared per look, so each observation describes only
 * what happened since the previous one.
 */
export class PageObservationService {
  private _console = new RingBuffer<VisualConsoleEntry>(VISUAL_CONSOLE_BUFFER);
  private _network = new RingBuffer<VisualNetworkFailure>(VISUAL_NETWORK_BUFFER);
  private _attached = false;

  /** Start recording. Idempotent per service instance (one instance per session). */
  attach(page: Page): void {
    if (this._attached) { return; }
    this._attached = true;

    page.on('console', (msg: any) => {
      try {
        const type = String(msg.type());
        if (type !== 'error' && type !== 'warning' && type !== 'warn') { return; }
        const loc = msg.location?.() || {};
        this._console.push({
          level: type === 'error' ? 'error' : 'warning',
          text: String(msg.text()).slice(0, 500),
          source: loc.url ? `${String(loc.url).slice(0, 200)}:${loc.lineNumber ?? 0}` : undefined,
        });
      } catch { /* a malformed console event must never break a capture */ }
    });

    page.on('pageerror', (err: any) => {
      try {
        this._console.push({
          level: 'error',
          text: String(err?.message || err).slice(0, 500),
          source: String(err?.stack || '').split('\n')[1]?.trim().slice(0, 200) || undefined,
        });
      } catch { /* ignore */ }
    });

    page.on('requestfailed', (req: any) => {
      try {
        this._network.push({
          method: String(req.method()).slice(0, 10),
          url: String(req.url()).slice(0, 300),
          status: 0,
          error: String(req.failure?.()?.errorText || 'request failed').slice(0, 120),
        });
      } catch { /* ignore */ }
    });

    page.on('response', (res: any) => {
      try {
        const status = Number(res.status());
        if (status < 400) { return; }
        this._network.push({
          method: String(res.request().method()).slice(0, 10),
          url: String(res.url()).slice(0, 300),
          status,
        });
      } catch { /* ignore */ }
    });
  }

  /** Drop everything recorded so far — called at the start of each look. */
  reset(): void {
    this._console.clear();
    this._network.clear();
  }

  get consoleEntries(): VisualConsoleEntry[] { return this._console.items; }
  get networkFailures(): VisualNetworkFailure[] { return this._network.items; }

  /**
   * Run the layout/contrast probes over the target subtree.
   *
   * These are what let a text-only model fix CSS: an overflowing element, a
   * zero-size button, a clipped heading and a failing contrast ratio are all
   * invisible in a DOM dump and ambiguous in a screenshot, but each is a precise,
   * actionable fact here.
   */
  async probeLayout(page: Page, selector?: string): Promise<VisualLayoutProbe[]> {
    try {
      const probes = await page.evaluate((rootSelector: string | null) => {
        const MAX = 40;
        const out: Array<Record<string, unknown>> = [];

        const root: Element | null = rootSelector
          ? document.querySelector(rootSelector)
          : document.body;
        if (!root) { return out; }

        // sRGB relative luminance → WCAG contrast ratio.
        const parseColor = (c: string): [number, number, number, number] | null => {
          const m = c.match(/rgba?\(([^)]+)\)/);
          if (!m) { return null; }
          const p = m[1].split(',').map(s => parseFloat(s.trim()));
          if (p.length < 3 || p.some(n => Number.isNaN(n))) { return null; }
          return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
        };
        const lum = (rgb: [number, number, number, number]): number => {
          const f = (v: number) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
          };
          return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
        };
        const effectiveBg = (el: Element): [number, number, number, number] => {
          let node: Element | null = el;
          while (node) {
            const c = parseColor(window.getComputedStyle(node).backgroundColor);
            if (c && c[3] > 0.1) { return c; }
            node = node.parentElement;
          }
          return [255, 255, 255, 1];
        };
        const describe = (el: Element): string => {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const cls = typeof el.className === 'string' && el.className.trim()
            ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
            : '';
          return (tag + id + cls).slice(0, 80);
        };

        const candidates: Element[] = [root, ...Array.from(root.querySelectorAll('*'))].slice(0, 400);

        for (const el of candidates) {
          if (out.length >= MAX) { break; }
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const tag = el.tagName.toLowerCase();
          if (['script', 'style', 'meta', 'link', 'noscript', 'head'].indexOf(tag) >= 0) { continue; }

          const flags: string[] = [];

          // Zero-size: laid out but invisible. Only worth reporting for things
          // that are supposed to be seen (it is normal for wrappers).
          const isInteractive = ['button', 'a', 'input', 'select', 'textarea'].indexOf(tag) >= 0
            || el.getAttribute('role') === 'button';
          if (isInteractive && (rect.width === 0 || rect.height === 0)) {
            flags.push(style.display === 'none' ? 'ZERO-SIZE (display:none)' : 'ZERO-SIZE');
          }

          // Horizontal overflow — the classic responsive break.
          if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && style.overflowX !== 'auto' && style.overflowX !== 'scroll') {
            flags.push(`OVERFLOW-X (scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth})`);
          }
          if (el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 0 && style.overflowY !== 'auto' && style.overflowY !== 'scroll' && style.overflow !== 'auto') {
            const overflowsVisibly = el.scrollHeight - el.clientHeight > 4;
            if (overflowsVisibly && style.overflow === 'hidden') { flags.push('CLIPPED-Y (overflow:hidden cuts content)'); }
          }

          // Text contrast, only for elements that own visible text.
          const ownText = (Array.from(el.childNodes) as any[])
            .filter((n: any) => n.nodeType === 3 && (n.textContent || '').trim())
            .map((n: any) => (n.textContent || '').trim()).join(' ');
          if (ownText && rect.width > 0 && rect.height > 0) {
            const fg = parseColor(style.color);
            if (fg) {
              const bg = effectiveBg(el);
              const l1 = lum(fg), l2 = lum(bg);
              const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
              const size = parseFloat(style.fontSize) || 16;
              const bold = (parseInt(style.fontWeight, 10) || 400) >= 700;
              const large = size >= 24 || (size >= 18.66 && bold);
              const need = large ? 3 : 4.5;
              if (ratio < need) {
                flags.push(`LOW-CONTRAST ${ratio.toFixed(1)}:1 (AA needs ${need}:1) ${style.color} on rgb(${bg[0]},${bg[1]},${bg[2]})`);
              }
            }
          }

          if (flags.length === 0) { continue; }
          out.push({
            selector: describe(el),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            flags,
          });
        }
        return out;
      }, selector ?? null);

      return (probes as VisualLayoutProbe[]) || [];
    } catch {
      // A probe failure must never fail the whole look.
      return [];
    }
  }

  /**
   * Accessibility tree as roles + names. Cheap, and often the fastest way for a
   * model to confirm "the button I added is actually there and reachable".
   */
  async accessibilityOutline(page: Page): Promise<string> {
    try {
      const snap = await page.accessibility.snapshot({ interestingOnly: true });
      if (!snap) { return ''; }
      const lines: string[] = [];
      const walk = (node: any, depth: number) => {
        if (!node || depth > 6 || lines.length >= 60) { return; }
        const role = String(node.role || '').trim();
        const name = String(node.name || '').trim().slice(0, 60);
        if (role && role !== 'generic' && role !== 'none') {
          const extras: string[] = [];
          if (node.checked !== undefined) { extras.push(`checked=${node.checked}`); }
          if (node.disabled) { extras.push('disabled'); }
          if (node.level) { extras.push(`level=${node.level}`); }
          lines.push(`${'  '.repeat(depth)}${role}${name ? ` "${name}"` : ''}${extras.length ? ` ${extras.join(' ')}` : ''}`);
        }
        for (const child of (node.children || [])) { walk(child, depth + 1); }
      };
      walk(snap, 0);
      return lines.join('\n');
    } catch {
      return '';
    }
  }
}

/** Escape a fence delimiter so page content cannot break out of a code block. */
function neutralizeFences(s: string): string {
  return s.replace(/```/g, "'''");
}

/**
 * Render an observation as the text the model actually reads.
 *
 * Ordered most-actionable first, then clamped head+tail so one enormous DOM can
 * never blow the caller's context — the same discipline as `_fenceDelegateResult`.
 */
export function formatObservation(obs: VisualObservation): string {
  const parts: string[] = [];

  const header = [
    `## look #${obs.sequence} — ${obs.url}`,
    `${obs.viewport.width}×${obs.viewport.height} ${obs.browser}${obs.durationMs ? ` — ${(obs.durationMs / 1000).toFixed(1)}s` : ''}${obs.serverReused ? ' — server reused' : ''}`,
  ];
  if (obs.focus) { header.push(`focus: "${neutralizeFences(obs.focus).slice(0, 300)}"`); }
  parts.push(header.join('\n'));

  const errors = obs.console.filter(c => c.level === 'error');
  const warnings = obs.console.filter(c => c.level !== 'error');
  if (obs.console.length > 0) {
    const lines = [`### Console (${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'})`];
    for (const c of [...errors, ...warnings].slice(0, 15)) {
      lines.push(`[${c.level}] ${neutralizeFences(c.text)}`);
      if (c.source) { lines.push(`        at ${c.source}`); }
    }
    parts.push(lines.join('\n'));
  } else {
    parts.push('### Console\nNo errors or warnings.');
  }

  if (obs.network.length > 0) {
    const lines = [`### Failed requests (${obs.network.length})`];
    for (const n of obs.network.slice(0, 12)) {
      lines.push(`${n.method} ${neutralizeFences(n.url)} → ${n.status || n.error || 'failed'}`);
    }
    parts.push(lines.join('\n'));
  }

  if (obs.layout.length > 0) {
    const lines = [`### Layout probes${obs.selector ? ` (target: ${obs.selector})` : ''}`];
    for (const p of obs.layout.slice(0, 25)) {
      lines.push(`${neutralizeFences(p.selector).padEnd(28)} ${p.width}×${p.height} at (${p.x},${p.y})  ${p.flags.join('; ')}`);
    }
    parts.push(lines.join('\n'));
  } else if (obs.selector) {
    parts.push(`### Layout probes (target: ${obs.selector})\nNo overflow, zero-size or contrast problems detected.`);
  }

  if (obs.accessibility) {
    parts.push(`### Accessibility tree (roles + names)\n${neutralizeFences(obs.accessibility)}`);
  }

  if (obs.domOutline) {
    const dom = obs.domOutline.length > VISUAL_DOM_OUTLINE_MAX_CHARS
      ? obs.domOutline.slice(0, VISUAL_DOM_OUTLINE_MAX_CHARS) + '\n… (truncated)'
      : obs.domOutline;
    parts.push(`### DOM outline\n${neutralizeFences(dom)}`);
  }

  if (obs.actionsPerformed && obs.actionsPerformed.length > 0) {
    parts.push(`### Actions performed\n${obs.actionsPerformed.map(a => `- ${a}`).join('\n')}`);
  }
  if (obs.denials && obs.denials.length > 0) {
    parts.push(`### Not done\n${obs.denials.map(d => `- ${d}`).join('\n')}`);
  }
  if (obs.screenshotPath) {
    parts.push(`### Screenshot\nSaved to ${obs.screenshotPath}${obs.screenshotAttached ? ' (attached to this message)' : ' (not attached — this model does not accept images)'}`);
  }

  const full = parts.join('\n\n');
  if (full.length <= VISUAL_DIGEST_MAX_CHARS) { return full; }
  const head = Math.floor(VISUAL_DIGEST_MAX_CHARS * 0.75);
  const tail = VISUAL_DIGEST_MAX_CHARS - head;
  return `${full.slice(0, head)}\n\n… [observation clamped — ${full.length} chars total] …\n\n${full.slice(-tail)}`;
}
