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
 * D-1 (webview half) — the first-run wizard was an inescapable wall.
 *
 * `media/chat/index.html` ships `script-src 'nonce-{{nonce}}' {{cspSource}}`
 * with no `'unsafe-inline'` and no `'unsafe-hashes'`. Per CSP Level 3
 * (https://www.w3.org/TR/CSP3/), a nonce authorises SCRIPT ELEMENTS; only
 * `'unsafe-hashes'` "will now allow event handlers, style attributes and
 * javascript: navigation targets to match hashes", and `'unsafe-inline'`
 * allows them outright. A nonce does neither. So every `on*=` attribute in
 * this document was dead in the packaged extension — including
 * `.wizard-skip-btn`, the setup wizard's ONLY exit, on a full-screen overlay.
 *
 * These tests assert the five handlers are bound from chat.js and that no new
 * inline handler creeps back in.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
let html: string;
let chatJs: string;
beforeAll(() => {
  html = fs.readFileSync(path.join(ROOT, 'media', 'chat', 'index.html'), 'utf8');
  chatJs = fs.readFileSync(path.join(ROOT, 'media', 'chat', 'chat.js'), 'utf8');
});

describe('D-1: the chat webview carries no CSP-blocked inline handlers', () => {
  it('the CSP that makes inline handlers dead is still in force', () => {
    const csp = /content="([^"]*default-src[^"]*)"/.exec(html);
    expect(csp, 'index.html must still ship a CSP meta tag').toBeTruthy();
    const policy = csp![1];
    // Scoped to script-src on purpose: style-src legitimately carries
    // 'unsafe-inline', and asserting over the whole policy string would
    // conflate the two.
    const scriptSrc = policy.split(';').map(d => d.trim()).find(d => d.startsWith('script-src '));
    expect(scriptSrc, 'index.html must still ship a script-src directive').toBeTruthy();
    expect(scriptSrc).toContain("'nonce-{{nonce}}'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-hashes'");
    // default-src cannot rescue an inline handler either.
    expect(policy).toContain("default-src 'none'");
  });

  it('chat.js emits no inline event-handler attributes either', () => {
    // The guard used to scan index.html ONLY, so the class stayed wide open in
    // the markup chat.js builds as strings — which is where the last offender
    // was: the diagnostics panel's Copy button, on the very panel the wizard's
    // "Run Diagnostics" fix had just made reachable. Both halves are inert
    // under a nonce-only script-src, so the button simply did nothing.
    const offenders: string[] = [];
    const re = /\son[a-z]+\s*=\s*['"][^'"]*['"]/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(chatJs)) !== null) {
      // `onclick=` inside a string literal that chat.js injects as HTML.
      offenders.push(`${chatJs.slice(0, m.index).split('\n').length}: ${m[0].trim()}`);
    }
    expect(offenders, `inline handlers are dead under this CSP:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('index.html has zero inline event-handler attributes', () => {
    const offenders = html
      .split('\n')
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(x => /\son[a-z]+\s*=\s*["']/i.test(x.l));
    expect(offenders.map(o => `${o.n}: ${o.l.trim()}`)).toEqual([]);
  });

  it('index.html still provides the hooks chat.js binds to', () => {
    expect(html).toContain('id="badge-toast"');
    expect(html).toContain('id="setup-retry-btn"');
    expect(html).toContain('id="setup-skip-btn"');
    expect(html).toContain('class="wizard-skip-btn"');
    expect(html).toContain('class="wizard-diagnose-btn"');
  });
});

// ---------------------------------------------------------------------------
// Execute the REAL binding block from chat.js against a minimal fake DOM.
// ---------------------------------------------------------------------------

class El {
  className = '';
  disabled = false;
  textContent = '';
  listeners: Record<string, Array<() => void>> = {};
  readonly classList = {
    add: (c: string) => { this.className = (this.className + ' ' + c).trim(); },
    remove: (c: string) => {
      this.className = this.className.split(/\s+/).filter(x => x && x !== c).join(' ');
    },
    contains: (c: string) => this.className.split(/\s+/).includes(c),
  };
  addEventListener(type: string, fn: () => void): void { (this.listeners[type] ||= []).push(fn); }
  click(): void { for (const fn of this.listeners['click'] || []) { fn(); } }
}

interface Rig {
  posted: Array<{ type: string; payload?: Record<string, unknown> }>;
  els: Record<string, El>;
  diagnosticsRuns: number;
  wizardHidden: number;
  setupOverlayHidden: number;
}

/**
 * Slice the D-1 binding block verbatim out of chat.js and run it. Executing the
 * shipped bytes (rather than asserting on a regex) is the only way this test
 * can prove the buttons actually post what they claim to.
 */
function runBindings(): Rig {
  const start = chatJs.indexOf("var badgeToastEl = document.getElementById('badge-toast');");
  const end = chatJs.indexOf("      settingsBtn.addEventListener('click', function() {");
  expect(start, 'D-1 binding block not found in chat.js').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = chatJs.slice(start, end);

  const els: Record<string, El> = {
    'badge-toast': new El(),
    'setup-retry-btn': new El(),
    'setup-skip-btn': new El(),
    '.wizard-skip-btn': new El(),
    '.wizard-diagnose-btn': new El(),
  };
  els['badge-toast'].className = 'badge-toast show';

  const rig: Rig = { posted: [], els, diagnosticsRuns: 0, wizardHidden: 0, setupOverlayHidden: 0 };
  const documentStub = {
    getElementById: (id: string) => els[id] || null,
    querySelector: (sel: string) => els[sel] || null,
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(
    'document', 'postMessageWithPanelId', 'state', 'requestDiagnostics', 'handleWizardDismissed',
    // Plan 28 Phase 7: the setup-skip handler now also clears the overlay
    // itself, for the same reason the wizard's skip does — the exit has to work
    // even if the extension never answers.
    'hideSetupOverlay',
    block
  )(
    documentStub,
    (msg: { type: string; payload?: Record<string, unknown> }) => { rig.posted.push(msg); },
    { setup: { providerId: 'claude-code' } },
    () => { rig.diagnosticsRuns++; },
    () => { rig.wizardHidden++; },
    () => { rig.setupOverlayHidden++; }
  );
  return rig;
}

describe('D-1: the five rebound handlers do what the dead attributes did', () => {
  it('the wizard skip button — the only exit — dismisses and persists', () => {
    const rig = runBindings();
    rig.els['.wizard-skip-btn'].click();

    expect(rig.posted).toHaveLength(1);
    expect(rig.posted[0].type).toBe('dismissWizard');
    // `false` (what the dead inline handler posted) left the extension free to
    // re-raise the same wall on the next panel load.
    expect(rig.posted[0].payload).toEqual({ dontShowAgain: true });
    // And the overlay clears locally, so the exit works even if the extension
    // never answers.
    expect(rig.wizardHidden).toBe(1);
  });

  it('the diagnostics button runs diagnostics', () => {
    const rig = runBindings();
    rig.els['.wizard-diagnose-btn'].click();
    expect(rig.diagnosticsRuns).toBe(1);
  });

  it('the setup-failure buttons retry with the right provider, and skip', () => {
    const rig = runBindings();
    rig.els['setup-retry-btn'].click();
    rig.els['setup-skip-btn'].click();
    expect(rig.posted).toEqual([
      { type: 'retrySetup', payload: { providerId: 'claude-code' } },
      { type: 'skipSetup' },
    ]);
    // The exit clears the wall itself rather than waiting to be told.
    expect(rig.setupOverlayHidden).toBe(1);
  });

  it('the badge toast dismisses itself on click', () => {
    const rig = runBindings();
    expect(rig.els['badge-toast'].classList.contains('show')).toBe(true);
    rig.els['badge-toast'].click();
    expect(rig.els['badge-toast'].classList.contains('show')).toBe(false);
  });

  it('binds defensively — a missing element must not throw at load', () => {
    const start = chatJs.indexOf("var badgeToastEl = document.getElementById('badge-toast');");
    const end = chatJs.indexOf("      settingsBtn.addEventListener('click', function() {");
    expect(start, 'D-1 binding block not found in chat.js').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = chatJs.slice(start, end);
    const documentStub = { getElementById: () => null, querySelector: () => null };
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function(
        'document', 'postMessageWithPanelId', 'state', 'requestDiagnostics', 'handleWizardDismissed',
        block
      )(documentStub, () => {}, {}, () => {}, () => {});
    }).not.toThrow();
  });
});
