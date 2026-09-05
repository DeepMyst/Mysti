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
 * Plan 27 Gate 2 — "a stranger with no CLI installed reaches a first answer in
 * <= 5 actions without leaving the editor."
 *
 * Before this, the setup wizard offered ONLY provider cards, every one of which
 * requires an `npm install -g` in a terminal. Meanwhile `mysti.defaultAgent`
 * defaults to `mysti`, the coordinator, which runs on the DeepMyst gateway and
 * needs no local CLI and no API key at all. The zero-install route existed and
 * was reachable only by sending a message, having the turn FAIL, and then
 * clicking the sign-in button on the coordinator's failure card.
 *
 * These tests pin the route being offered UP FRONT, and pin the two things that
 * have broken this surface before: an inline handler the page's own CSP blocks
 * (D-1), and a second, divergent sign-in path.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const INDEX = path.join(ROOT, 'media', 'chat', 'index.html');
const CHAT = path.join(ROOT, 'media', 'chat', 'chat.js');
const CSS = path.join(ROOT, 'media', 'chat', 'chat.css');
const PROVIDER = path.join(ROOT, 'src', 'providers', 'ChatViewProvider.ts');

let html: string;
let js: string;
let css: string;

beforeAll(() => {
  html = fs.readFileSync(INDEX, 'utf8');
  js = fs.readFileSync(CHAT, 'utf8');
  css = fs.readFileSync(CSS, 'utf8');
});

describe('the wizard offers a zero-install path', () => {
  it('has a sign-in button', () => {
    expect(html).toContain('id="wizard-signin-btn"');
  });

  it('offers it BEFORE the CLI install cards — order is the entire point', () => {
    const fastPath = html.indexOf('wizard-fastpath');
    const cards = html.indexOf('class="wizard-providers"');
    expect(fastPath, 'the fast-path block is missing').toBeGreaterThan(-1);
    expect(cards, 'the provider cards are missing').toBeGreaterThan(-1);
    expect(
      fastPath,
      'the zero-install path renders BELOW the install cards; a stranger scrolls past 11 '
      + '`npm install -g` cards before finding the one route that needs no terminal',
    ).toBeLessThan(cards);
  });

  it('says what it costs the user: nothing to install, no API key', () => {
    const block = html.slice(html.indexOf('wizard-fastpath'), html.indexOf('class="wizard-providers"'));
    expect(block.toLowerCase()).toMatch(/nothing to install|no local cli/);
    expect(block.toLowerCase()).toContain('no api key');
  });

  it('no longer tells a no-CLI user that a provider is the only way in', () => {
    // The old subtitle was "Set up an AI provider to get started", which is
    // false for the default agent.
    expect(html).not.toContain('Set up an AI provider to get started');
  });
});

describe('the button is wired the way this page requires', () => {
  it('is bound with addEventListener, never an inline handler', () => {
    expect(js).toContain("document.getElementById('wizard-signin-btn')");
    expect(js).toMatch(/wizardSignInBtn\.addEventListener\(\s*'click'/);
  });

  it('the wizard markup carries ZERO inline on*= handlers', () => {
    // script-src is nonce-only, so an inline handler is dead on arrival — this
    // is exactly how the wizard's own exit button was disabled (D-1).
    const wizard = html.slice(html.indexOf('id="setup-wizard"'), html.indexOf('id="wizard-signin-btn"') + 4000);
    expect(wizard.match(/\son[a-z]+=/g) ?? []).toEqual([]);
  });

  it('posts signInDeepMyst — the SAME message the failure card posts', () => {
    expect(js).toContain("vscode.postMessage({ type: 'signInDeepMyst' })");
    // One route, not two: the coordinator's action card uses this message too.
    expect(js).toContain("message: 'signInDeepMyst'");
  });

  it('the extension handles that message', () => {
    const ts = fs.readFileSync(PROVIDER, 'utf8');
    const idx = ts.indexOf("case 'signInDeepMyst':");
    expect(idx, "ChatViewProvider does not handle 'signInDeepMyst'").toBeGreaterThan(-1);
    expect(ts.slice(idx, idx + 200)).toContain('mysti.deepmyst.signIn');
  });
});

describe('the fast path is themed and accessible', () => {
  for (const cls of ['wizard-fastpath', 'wizard-signin-btn', 'wizard-or']) {
    it(`.${cls} is styled — an unstyled primary action reads as broken`, () => {
      expect(css).toContain(`.${cls}`);
    });
  }

  it('uses theme tokens, never hardcoded colours', () => {
    const start = css.indexOf('.wizard-fastpath');
    const block = css.slice(start, css.indexOf('/* Prerequisites Warning */', start));
    expect(block.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? []).toEqual([]);
    expect(block).toContain('var(--vscode-button-background)');
  });

  it('keeps a visible focus ring (Gate E)', () => {
    const start = css.indexOf('.wizard-signin-btn:focus-visible');
    expect(start, 'no :focus-visible rule — several :focus rules in this file start with `outline: none`').toBeGreaterThan(-1);
    expect(css.slice(start, start + 160)).toContain('outline:');
  });
});
