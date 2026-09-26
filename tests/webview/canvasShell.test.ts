/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 22 — the canvas shell's markup and visual system, as a contract.
 *
 * `media/canvas/index.html` and `media/canvas/canvas.css` are consumed by three
 * things that cannot see each other: `canvasContent.ts` (which templates the
 * HTML), the compiled webview modules (which look elements up by id, because
 * the DOM seam has `getElementById` and nothing else), and the human reading
 * the panel in whichever VS Code theme they run. Every regression this file
 * guards has actually happened in this subsystem:
 *
 *  - an id renamed in the shell while `app.ts` still looked it up → a control
 *    that silently does nothing (`#btn-apply-device` was missing outright);
 *    NOTE that button is now deliberately absent — a format is a property of an
 *    artboard, so `#device-select` writes it directly and there is nothing left
 *    to apply. `assertNoDeadControls` below is what keeps that honest: every id
 *    the shell ships must still be looked up by a module, and vice versa;
 *  - a dark literal as a `--vscode-*` fallback → unreadable under a light or
 *    high-contrast theme, which is what the 23 hard-coded colours did;
 *  - an icon-only button with no accessible name;
 *  - the `:empty` invariant on `#page-stage` broken by a stray newline, which
 *    would silently disable the loading state AND the onboarding hint.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { LAYOUT_BREAKPOINTS, LAYOUT_CEILINGS, LAYOUT_FLOORS } from '../../src/webview/canvas/layout';

const repoRoot = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(repoRoot, 'media', 'canvas', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'media', 'canvas', 'canvas.css'), 'utf8');
/** The stylesheet minus its prose, so the contract block cannot mask a literal. */
const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every id a webview module looks up, plus the ones this shell added. */
const REQUIRED_IDS = [
  'app', 'board', 'board-scroll', 'page-stage', 'board-overlay', 'board-zoom',
  'board-empty', 'board-loading', 'empty-templates', 'onboarding', 'onboarding-dismiss',
  'btn-zoom-in', 'btn-zoom-out', 'btn-zoom-fit', 'zoom-level',
  'pages-rail', 'rail-list', 'scaffold-menu', 'btn-add-page', 'staged-rail',
  'inspector', 'insp-tabs', 'insp-body', 'version-timeline', 'history-toolbar',
  'artifact-name', 'page-chip', 'agent-status', 'agent-activity', 'agent-elapsed',
  'btn-agent-cancel', 'agent-comment', 'board-error',
  'device-select', 'theme-select', 'capability-chips',
  // The dock's two tabs and their panels.
  'tab-inspector', 'tab-activity', 'activity-badge',
  'insp-panel-inspector', 'artboard-props', 'activity-body',
  'btn-present', 'btn-export',
  'rail-hidden', 'rail-shown', 'inspector-hidden', 'inspector-shown',
];

/**
 * The other half of the contract: a control the shell ships that NO module
 * looks up is a button that silently does nothing — the exact defect the
 * missing `#btn-apply-device` produced, in reverse. This is what stops the
 * top bar drifting back into a junk drawer.
 */
describe('the shell ships no control no module drives', () => {
  const modules = fs.readdirSync(path.join(repoRoot, 'src', 'webview', 'canvas'))
    .filter(f => f.endsWith('.ts'))
    .map(f => fs.readFileSync(path.join(repoRoot, 'src', 'webview', 'canvas', f), 'utf8'))
    .join('\n');

  it('every button and select in the shell is reachable from a webview module', () => {
    const ids = [...html.matchAll(/<(?:button|select)\b[^>]*\bid="([^"]+)"/g)].map(m => m[1]);
    expect(ids.length).toBeGreaterThan(5);
    const orphans = ids.filter(id => !modules.includes(`'${id}'`) && !modules.includes(`"${id}"`));
    expect(orphans, `shell controls no module looks up: ${orphans.join(', ')}`).toEqual([]);
  });

  it('no longer ships the Apply button the format control made redundant', () => {
    expect(html).not.toContain('btn-apply-device');
    expect(modules).not.toContain('btn-apply-device');
  });
});

describe('the shell provides every id its modules look up', () => {
  it.each(REQUIRED_IDS)('#%s', id => {
    expect(html).toContain(`id="${id}"`);
  });

  it('keeps the template placeholders the host fills', () => {
    for (const token of ['{{cspMeta}}', '{{cssUri}}', '{{jsUri}}', '{{boot}}']) {
      expect(html).toContain(token);
    }
    expect(html.match(/\{\{nonce\}\}/g)).toHaveLength(2);
  });

  it('ships no inline script beyond the two nonce-guarded tags', () => {
    const scripts = html.match(/<script/g) ?? [];
    expect(scripts).toHaveLength(2);
    expect(html).not.toMatch(/\son[a-z]+\s*=/);   // no inline event handler attributes
    expect(html).not.toContain('innerHTML');
  });
});

describe('the zero-JS state machine the CSS depends on', () => {
  it('keeps #page-stage literally empty so :empty can distinguish three states', () => {
    expect(html).toContain('<div class="page-stage" id="page-stage"></div>');
  });

  it('drives loading, empty and onboarding off that one selector', () => {
    expect(cssRules).toContain('#page-stage:empty');
    expect(cssRules).toContain('#board-empty[hidden]');
    // The empty state starts hidden (the host unhides it); the hint does not,
    // because an empty board must show the empty state, not a hint about it.
    expect(html).toMatch(/id="board-empty" hidden/);
    expect(html).not.toMatch(/id="onboarding" hidden/);
  });

  it('carries four real checkboxes as the pane state machine', () => {
    for (const id of ['rail-hidden', 'rail-shown', 'inspector-hidden', 'inspector-shown']) {
      expect(html).toMatch(new RegExp(`type="checkbox" id="${id}"`));
      expect(cssRules).toContain(`#${id}:checked`);
    }
    // Visually hidden but still focusable — a `display:none` switch would drop
    // the whole layout out of the keyboard's reach.
    expect(cssRules).toContain('.sr-only');
    expect(html).toMatch(/class="pane-switch sr-only"/);
  });
});

describe('responsive: a container-query ladder with a media fallback', () => {
  it('measures the PANEL, not the viewport', () => {
    expect(cssRules).toMatch(/container-type:\s*inline-size/);
    expect(cssRules).toMatch(/container-name:\s*canvas-shell/);
    expect(cssRules).toMatch(/@container canvas-shell \(max-width: 959\.98px\)/);
    expect(cssRules).toMatch(/@container canvas-shell \(max-width: 639\.98px\)/);
    expect(cssRules).toMatch(/@container canvas-shell \(max-width: 479\.98px\)/);
  });

  it('degrades to the same ladder where container queries are unsupported', () => {
    expect(cssRules).toContain('@supports not (container-type: inline-size)');
    expect(cssRules).toMatch(/@media \(max-width: 959\.98px\)/);
    expect(cssRules).toMatch(/@media \(max-width: 639\.98px\)/);
  });

  it('agrees with layout.ts about every number in the ladder', () => {
    // Breakpoints: the CSS uses the exclusive upper bound of each mode.
    expect(cssRules).toContain(`max-width: ${LAYOUT_BREAKPOINTS.wide - 0.02}px`);
    expect(cssRules).toContain(`max-width: ${LAYOUT_BREAKPOINTS.medium - 0.02}px`);
    expect(cssRules).toContain(`max-width: ${LAYOUT_BREAKPOINTS.compact - 0.02}px`);
    // Tracks: clamp(floor, ratio, ceiling).
    expect(cssRules).toContain(`clamp(${LAYOUT_FLOORS.rail}px, 17cqi, ${LAYOUT_CEILINGS.rail}px)`);
    expect(cssRules).toContain(`clamp(${LAYOUT_FLOORS.inspector}px, 22cqi, ${LAYOUT_CEILINGS.inspector}px)`);
    expect(cssRules).toContain(`--board-floor: ${LAYOUT_FLOORS.board}px`);
  });

  it('gives the board a track that can never go to zero or negative', () => {
    expect(cssRules).toMatch(/minmax\(min\(var\(--board-floor\), 100%\), 1fr\)/);
    // …and no fixed three-column grid survives anywhere.
    expect(cssRules).not.toMatch(/grid-template-columns:\s*220px 1fr 280px/);
  });
});

describe('theme correctness in light, dark and high contrast', () => {
  it('has no colour literal other than the documented paper token', () => {
    const hexes = cssRules.match(/#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])/g) ?? [];
    expect(hexes).toEqual(['#ffffff']);
    const paper = /--canvas-paper:\s*#ffffff/.test(cssRules);
    expect(paper).toBe(true);
  });

  it('uses no rgb/rgba/hsl literal at all', () => {
    expect(cssRules).not.toMatch(/\brgba?\(/);
    expect(cssRules).not.toMatch(/\bhsla?\(/);
  });

  it('keeps every --vscode-* fallback theme-neutral', () => {
    const fallbacks = [...cssRules.matchAll(/var\(--vscode-[a-zA-Z-]+,\s*([^)]*(?:\([^)]*\))?[^)]*)\)/g)]
      .map(m => m[1].trim())
      .filter(Boolean);
    expect(fallbacks.length).toBeGreaterThan(20);
    for (const fallback of fallbacks) {
      expect(fallback).not.toMatch(/#[0-9a-fA-F]{3,8}/);
      expect(fallback).not.toMatch(/\brgba?\(/);
    }
  });

  it('answers to the three body classes VS Code stamps', () => {
    expect(cssRules).toContain('body.vscode-light');
    expect(cssRules).toContain('body.vscode-high-contrast');
    expect(cssRules).toContain('body.vscode-high-contrast-light');
    // High contrast is borders, not fills.
    expect(cssRules).toMatch(/--line:\s*var\(--vscode-contrastBorder/);
    expect(cssRules).toMatch(/--shadow-c:\s*transparent/);
  });
});

describe('professional finish', () => {
  it('ships no text-glyph icons or emoji in the shell', () => {
    for (const glyph of ['◆', '＋', '−', '▶', '⤓', '×', '👋']) {
      expect(html).not.toContain(glyph);
    }
    expect(html).toMatch(/class="i i-/);        // masked-SVG icon system
    expect(cssRules).toMatch(/mask-image:\s*var\(--i\)/);
  });

  it('names every icon-only button and label', () => {
    const controls = [...html.matchAll(/<(button|label)\b([^>]*)>([\s\S]*?)<\/\1>/g)];
    expect(controls.length).toBeGreaterThan(8);
    for (const [, , attrs, inner] of controls) {
      const text = inner.replace(/<[^>]*>/g, '').replace(/<!--[\s\S]*?-->/g, '').trim();
      if (text.length > 0) { continue; }
      const named = /aria-label="[^"]+"/.test(attrs)
        || /aria-label="[^"]+"/.test(inner)
        || /\bfor="[^"]+"/.test(attrs)
        || /aria-hidden="true"/.test(attrs);
      expect(named, `unnamed icon-only control: ${attrs}`).toBe(true);
    }
  });

  it('derives its type ramp and spacing from VS Code, not from magic numbers', () => {
    expect(cssRules).toMatch(/--font:\s*var\(--vscode-font-family/);
    expect(cssRules).toMatch(/--fz:\s*var\(--vscode-font-size/);
    for (const step of ['--fz-100', '--fz-200', '--fz-300', '--fz-400', '--fz-500']) {
      expect(cssRules).toContain(`${step}:`);
    }
    for (const step of ['--sp-1', '--sp-2', '--sp-3', '--sp-4']) {
      expect(cssRules).toContain(`${step}:`);
    }
  });

  it('gives keyboard users a real focus ring and honours reduced motion', () => {
    expect(cssRules).toContain(':focus-visible');
    expect(cssRules).toMatch(/outline:\s*var\(--focus-w\) solid var\(--focus\)/);
    expect(cssRules).toContain('@media (prefers-reduced-motion: reduce)');
    expect(cssRules).toMatch(/animation-duration:\s*1ms\s*!important/);
  });

  it('styles every class the webview modules actually emit', () => {
    const emitted = [
      'artboard', 'artboard-label', 'artboard-format', 'artboard-surface', 'artboard-preview', 'artboard-frame',
      'sel-box', 'sel-marquee',
      'thumb', 'thumb-slot', 'thumb-preview', 'thumb-frame', 'thumb-meta', 'thumb-title', 'thumb-badge',
      'thumb-actions', 'thumb-action',
      'ghost-artboard', 'ghost-shimmer', 'ghost-meta', 'ghost-label', 'ghost-elapsed', 'ghost-cancel',
      'agent-cursor', 'agent-cursor-label',
      'frame-error-card', 'fec-title', 'fec-message', 'fec-actions', 'fec-fix', 'fec-dismiss',
      'staged-rail', 'staged-head', 'staged-count', 'staged-row',
      'sr-title', 'sr-previews', 'sr-before', 'sr-after', 'sr-caption', 'sr-preview',
      'sr-error', 'sr-actions', 'sr-accept', 'sr-reject',
      'insp-empty', 'insp-head', 'insp-title', 'insp-sub', 'insp-section', 'insp-section-title',
      'insp-slots', 'insp-restyle', 'insp-unpin-node',
      'ctl', 'ctl-label', 'ctl-body', 'ctl-pin', 'ctl-clear', 'ctl-edit-canvas', 'ctl-note',
      'ctl-toggle', 'ctl-range', 'ctl-readout', 'ctl-token', 'ctl-swatch', 'ctl-input', 'ctl-raw',
      'history-btn', 'version-empty', 'version-row', 'version-thumb', 'version-meta',
      'version-label', 'version-sub', 'version-restore',
      'chip', 'sm-item', 'tpl-btn',
      // Surfaces `liveness.ts` / `inspector.ts` build into the shell's hosts.
      'agent-detail', 'agent-progress', 'agent-progress-fill', 'agent-review',
      'agent-comment', 'ac-head', 'ac-title', 'ac-row', 'ac-target', 'ac-input',
      'ac-send', 'ac-outbox', 'ac-item', 'ac-item-text', 'ac-item-status',
      'staged-empty', 'staged-list', 'staged-toggle', 'sr-head', 'sr-where', 'sr-reveal',
      'insp-ask', 'change-flash', 'history-last', 'btn-label', 'btn-glyph',
    ];
    const unstyled = emitted.filter(cls => !new RegExp(`\\.${cls}(?![\\w-])`).test(cssRules));
    expect(unstyled).toEqual([]);
  });

  it('takes up the icon hand-off the webview modules offer', () => {
    // `historyUi.ts` / `rail.ts` ship `data-icon` + a readable `.btn-label`.
    for (const icon of ['undo', 'redo', 'save', 'add', 'duplicate', 'delete']) {
      expect(cssRules).toContain(`--icon-${icon}:`);
      expect(cssRules).toContain(`[data-icon="${icon}"]::before`);
    }
    // The word may only be hidden where the emitter also sets an aria-label.
    expect(cssRules).toMatch(/\.thumb-action\[data-icon\] \.btn-label/);
  });

  it('honours the layout classes app.ts stamps, and lets them outrank the ladder', () => {
    for (const cls of ['layout-wide', 'layout-medium', 'layout-narrow',
      'rail-collapsed', 'inspector-collapsed']) {
      expect(cssRules).toContain(`.app.${cls}`);
    }
    // The mode classes must come BEFORE the collapse classes: same specificity,
    // and a collapsed pane stays collapsed in every mode.
    expect(cssRules.indexOf('.app.layout-narrow')).toBeLessThan(cssRules.indexOf('.app.rail-collapsed'));
  });

  it('gives the agent status bar a semantic state, not just a dot', () => {
    for (const state of ['working', 'review', 'idle', 'offline']) {
      expect(cssRules).toContain(`.agent-status[data-state="${state}"]`);
    }
    expect(cssRules).toContain('[data-motion="reduced"]');
  });

  it('documents the class contract at the top of the stylesheet', () => {
    const header = css.slice(0, css.indexOf('*/'));
    expect(header).toContain('CLASS CONTRACT');
    for (const marker of ['liveness.ts', 'inspector.ts', 'historyUi.ts', 'rail.ts', 'board.ts']) {
      expect(header).toContain(marker);
    }
  });
});
