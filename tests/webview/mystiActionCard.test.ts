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
 * Plan 25 — the recoverable-failure action card (webview half).
 *
 * The bug this replaces: a 401 from the coordinator rendered as red text
 * ("Error: DeepMyst rejected the request — try signing in again (run "DeepMyst:
 * Sign In").") with nothing to click. The card must therefore always end in
 * BUTTONS, must offer only agents that are actually installed, and must build
 * itself with textContent rather than innerHTML (the message quotes a raw
 * upstream error string).
 *
 * These execute the REAL function extracted from media/chat/chat.js so they
 * cannot drift from the shipped artifact.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/** Extract a top-level `function name(...) { ... }` declaration by brace matching. */
function extractFunction(source: string, name: string): string {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`function ${name} not found in webview script`);
  }
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') { depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0) { return source.slice(start, i + 1); }
    }
  }
  throw new Error(`Unbalanced braces extracting function ${name}`);
}

// ---------------------------------------------------------------------------
// Minimal fake DOM (the repo ships no jsdom and tsconfig has no lib.dom)
// ---------------------------------------------------------------------------

class El {
  className = '';
  type = '';
  hidden = false;
  disabled = false;
  textContent = '';
  children: El[] = [];
  listeners: Record<string, Array<(ev?: unknown) => void>> = {};
  readonly classList = {
    add: (c: string) => { this.className = (this.className + ' ' + c).trim(); },
    contains: (c: string) => this.className.split(/\s+/).includes(c),
  };

  constructor(readonly tag: string) {}

  /** Present only so a regression that reaches for it fails loudly. */
  set innerHTML(_v: string) { throw new Error('innerHTML written in the action card'); }

  attrs: Record<string, string> = {};
  src = '';
  style: Record<string, string> = {};
  popover: string | null = null;
  popoverTargetElement: El | null = null;
  popoverOpen = false;

  appendChild(child: El): El { this.children.push(child); return child; }
  prepend(child: El): void { this.children.unshift(child); }
  /** Text arguments become text-only children, so allText() still sees them. */
  append(...nodes: Array<El | string>): void {
    for (const n of nodes) {
      if (typeof n === 'string') { const t = new El('#text'); t.textContent = n; this.children.push(t); }
      else { this.children.push(n); }
    }
  }
  setAttribute(name: string, value: string): void { this.attrs[name] = value; }
  addEventListener(type: string, fn: (ev?: unknown) => void): void {
    (this.listeners[type] ||= []).push(fn);
  }
  removeEventListener(): void {}
  getBoundingClientRect() { return { top: 600, bottom: 630, left: 40, right: 240 }; }
  focus(): void { fakeDocument.activeElement = this; }
  private _fire(type: string, ev: unknown): void {
    for (const fn of this.listeners[type] || []) { fn(ev); }
  }
  showPopover(): void {
    if (this.popoverOpen) { return; }
    this._fire('beforetoggle', { newState: 'open' });
    this.popoverOpen = true;
    this._fire('toggle', { newState: 'open' });
  }
  hidePopover(): void {
    if (!this.popoverOpen) { return; }
    this._fire('beforetoggle', { newState: 'closed' });
    this.popoverOpen = false;
    this._fire('toggle', { newState: 'closed' });
  }
  /** Browser-faithful: a disabled button dispatches nothing, and an enabled
   *  popover invoker toggles its target natively (no click listener needed). */
  click(): void {
    if (this.disabled) { return; }
    for (const fn of this.listeners['click'] || []) { fn(); }
    const target = this.popoverTargetElement;
    if (target) { if (target.popoverOpen) { target.hidePopover(); } else { target.showPopover(); } }
  }
  keydown(key: string): void {
    this._fire('keydown', { key, preventDefault: () => undefined });
  }
  *walk(): Generator<El> {
    yield this;
    for (const c of this.children) { yield* c.walk(); }
  }
  querySelectorAll(selector: string): El[] {
    return [...this.walk()].filter(el => el !== this && el.tag === selector);
  }
  findAll(predicate: (el: El) => boolean): El[] {
    return [...this.walk()].filter(predicate);
  }
  buttons(): El[] { return this.findAll(el => el.tag === 'button'); }
  labels(): string[] { return this.buttons().map(b => b.textContent); }
  allText(): string {
    return [...this.walk()].map(el => el.textContent).join(' ');
  }
}

const fakeDocument: { activeElement: El | null; createElement: (tag: string) => El } = {
  activeElement: null,
  createElement: (tag: string) => new El(tag),
};
const fakeWindow = { innerWidth: 400, innerHeight: 700, addEventListener() {}, removeEventListener() {} };

interface Rendered {
  card: El;
  posted: Array<{ type: string; payload?: any }>;
}

let chatJs: string;
beforeAll(() => {
  chatJs = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
});

function render(payload: unknown, lastSentContent = 'fix the login bug'): Rendered {
  const src = extractFunction(chatJs, 'placeMenuNear') + '\n' + extractFunction(chatJs, 'renderMystiActionCard');
  // The label/message table lives beside the function; pull it in verbatim.
  const tableStart = chatJs.indexOf('var MYSTI_ACTION_LABELS = {');
  const tableEnd = chatJs.indexOf('};', tableStart) + 2;
  const table = chatJs.slice(tableStart, tableEnd);

  const messagesEl = new El('div');
  const posted: Array<{ type: string; payload?: any }> = [];
  fakeDocument.activeElement = null;
  const state = { lastSentContent, activeAgent: 'mysti' };

  const fn = new Function(
    'document', 'window', 'messagesEl', 'state', 'postMessageWithPanelId', 'hideLoading', 'scrollToBottom', 'getAgentLogo', 'payload',
    `${table}\n${src}\nrenderMystiActionCard(payload);`,
  );
  fn(
    fakeDocument,
    fakeWindow,
    messagesEl,
    state,
    (msg: { type: string; payload?: any }) => posted.push(msg),
    () => undefined,
    () => undefined,
    (id: string) => (id === 'claude-code' ? 'logo/claude.png' : ''),
    payload,
  );

  expect(messagesEl.children.length).toBe(1);
  return { card: messagesEl.children[0], posted };
}

const AGENTS = [
  { id: 'claude-code', name: 'Claude Code' },
  { id: 'openai-codex', name: 'OpenAI Codex' },
];

describe('renderMystiActionCard (Plan 25)', () => {
  it('renders sign-in and create-account buttons for a signed-out user', () => {
    const { card } = render({
      reason: 'signin',
      message: 'Sign in to DeepMyst to use the Mysti agent.',
      actions: ['signIn', 'signUp', 'switchAgent'],
      agents: AGENTS,
      retryable: false,
    });

    expect(card.labels()).toContain('Sign in to DeepMyst');
    expect(card.labels()).toContain('Create an account');
    expect(card.labels()).toContain('Switch to another agent');
  });

  it('never renders a credential failure as text alone', () => {
    // The whole point: the old path produced a red sentence with no affordance.
    for (const reason of ['signin', 'auth-rejected', 'openrouter-rejected', 'credits']) {
      const { card } = render({
        reason,
        message: 'something went wrong',
        actions:
          reason === 'signin' ? ['signIn', 'signUp', 'switchAgent']
          : reason === 'auth-rejected' ? ['signInAgain', 'signUp', 'switchAgent', 'retry']
          : reason === 'openrouter-rejected' ? ['openRouterSettings', 'switchAgent', 'retry']
          : ['topUp', 'switchAgent', 'retry'],
        agents: AGENTS,
        retryable: reason !== 'signin',
      });
      expect(card.buttons().length).toBeGreaterThan(0);
    }
  });

  it('posts signInDeepMystAgain for a rejected key, so the stale key is dropped first', () => {
    const { card, posted } = render({
      reason: 'auth-rejected',
      message: 'DeepMyst rejected your sign-in',
      actions: ['signInAgain', 'signUp', 'switchAgent', 'retry'],
      agents: AGENTS,
      retryable: true,
    });

    card.buttons().find(b => b.textContent === 'Sign in again')!.click();
    expect(posted).toEqual([{ type: 'signInDeepMystAgain' }]);
  });

  it('sends the user to OpenRouter settings when that key was the one rejected', () => {
    const { card, posted } = render({
      reason: 'openrouter-rejected',
      message: 'Your OpenRouter key was rejected',
      actions: ['openRouterSettings', 'switchAgent'],
      agents: AGENTS,
      retryable: false,
    });

    card.buttons().find(b => b.textContent === 'Open OpenRouter settings')!.click();
    expect(posted).toEqual([{ type: 'openOpenRouterSettings' }]);
  });

  it('keeps the agent menu closed until asked, then lists exactly the agents given', () => {
    const { card } = render({
      reason: 'credits',
      message: 'out of credits',
      actions: ['topUp', 'switchAgent'],
      agents: AGENTS,
      retryable: false,
    });

    const menu = card.findAll(el => el.className === 'mysti-action-agents')[0];
    expect(menu.popover).toBe('auto'); // top layer + native outside-click/Escape dismissal
    expect(menu.popoverOpen).toBe(false);

    const toggle = card.buttons().find(b => b.textContent === 'Switch to another agent')!;
    expect(toggle.popoverTargetElement).toBe(menu);
    expect(toggle.attrs['aria-expanded']).toBe('false');
    toggle.click();
    expect(menu.popoverOpen).toBe(true);
    expect(toggle.attrs['aria-expanded']).toBe('true');

    const items = card.findAll(el => el.className === 'mysti-action-agent');
    expect(items.map(c => c.textContent)).toEqual(['Claude Code', 'OpenAI Codex']);
    // Each row carries the agent's logo when it has one, like the agent menu.
    expect(items[0].children.map(c => c.src)).toEqual(['logo/claude.png']);
    expect(items[1].children).toEqual([]);
  });

  it('opens toward the side with more room — up, when the card sits above the composer', () => {
    // Fake button rect: top 600 / bottom 630 in a 700px window.
    const { card } = render({
      reason: 'signin', message: 'Sign in', actions: ['signIn', 'switchAgent'], agents: AGENTS, retryable: false,
    });
    card.buttons().find(b => b.textContent === 'Switch to another agent')!.click();
    const menu = card.findAll(el => el.className === 'mysti-action-agents')[0];
    expect(menu.style.top).toBe('auto');
    expect(menu.style.bottom).toBe('106px'); // 700 - 600 + 6px gap
    expect(menu.style.left).toBe('40px');
  });

  it('focuses the first agent on open and moves with the arrow keys, wrapping', () => {
    const { card } = render({
      reason: 'signin', message: 'Sign in', actions: ['signIn', 'switchAgent'], agents: AGENTS, retryable: false,
    });
    card.buttons().find(b => b.textContent === 'Switch to another agent')!.click();
    const menu = card.findAll(el => el.className === 'mysti-action-agents')[0];
    const items = card.findAll(el => el.className === 'mysti-action-agent');

    expect(fakeDocument.activeElement).toBe(items[0]);
    menu.keydown('ArrowDown');
    expect(fakeDocument.activeElement).toBe(items[1]);
    menu.keydown('ArrowDown');
    expect(fakeDocument.activeElement).toBe(items[0]);
    menu.keydown('ArrowUp');
    expect(fakeDocument.activeElement).toBe(items[1]);
  });

  it('carries the unsent prompt to the new agent even when retrying Mysti is pointless', () => {
    // Signed out: nothing to retry on Mysti, but "hi" must not be lost on switch.
    const { card, posted } = render({
      reason: 'signin', message: 'Sign in', actions: ['signIn', 'switchAgent'], agents: AGENTS, retryable: false,
    }, 'hi');

    card.buttons().find(b => b.textContent === 'Switch to another agent')!.click();
    expect(card.allText()).toMatch(/Send\s+“hi”\s+to/);
    card.findAll(el => el.className === 'mysti-action-agent')[0].click();

    expect(posted).toEqual([{ type: 'switchAgentAndRetry', payload: { agentId: 'claude-code', retryContent: 'hi' } }]);
    expect(card.labels()).not.toContain('Retry');
  });

  it('never carries this panel\'s last prompt into a background job\'s switch', () => {
    const { card, posted } = render({
      reason: 'credits', message: 'out of credits', actions: ['topUp', 'switchAgent'], agents: AGENTS,
      retryable: false, jobId: 'job-1',
    }, 'unrelated foreground prompt');

    card.buttons().find(b => b.textContent === 'Switch to another agent')!.click();
    expect(card.allText()).not.toMatch(/unrelated/);
    card.findAll(el => el.className === 'mysti-action-agent')[0].click();

    expect(posted).toEqual([{ type: 'switchAgentAndRetry', payload: { agentId: 'claude-code', retryContent: '' } }]);
  });

  it('switches agent AND carries the failed prompt through, so nothing is retyped', () => {
    const { card, posted } = render({
      reason: 'auth-rejected',
      message: 'rejected',
      actions: ['signInAgain', 'switchAgent', 'retry'],
      agents: AGENTS,
      retryable: true,
    }, 'refactor the auth module');

    card.buttons().find(b => b.textContent === 'Switch to another agent')!.click();
    card.findAll(el => el.className === 'mysti-action-agent')[1].click();

    expect(posted).toEqual([{
      type: 'switchAgentAndRetry',
      payload: { agentId: 'openai-codex', retryContent: 'refactor the auth module' },
    }]);
  });

  it('spends the card on use — a hard failure must not be click-loopable', () => {
    const { card, posted } = render({
      reason: 'credits',
      message: 'out of credits',
      actions: ['topUp', 'switchAgent'],
      agents: AGENTS,
      retryable: false,
    });

    card.buttons().find(b => b.textContent === 'Switch to another agent')!.click();
    const agentBtn = card.findAll(el => el.className === 'mysti-action-agent')[0];
    agentBtn.click();
    agentBtn.click(); // a second click must not send a second run

    expect(posted.length).toBe(1);
    expect(card.buttons().every(b => b.disabled)).toBe(true);
  });

  it('offers no switch list when nothing else is installed, and says so', () => {
    const { card } = render({
      reason: 'signin',
      message: 'Sign in to DeepMyst',
      actions: ['signIn', 'switchAgent'],
      agents: [],
      retryable: false,
    });

    expect(card.labels()).not.toContain('Switch to another agent');
    expect(card.allText()).toMatch(/No other agent is installed/i);
  });

  it('does not offer Retry when there is nothing to retry', () => {
    const { card } = render({
      reason: 'auth-rejected',
      message: 'rejected',
      actions: ['signInAgain', 'switchAgent', 'retry'],
      agents: AGENTS,
      retryable: true,
    }, ''); // nothing was sent from this panel

    expect(card.labels()).not.toContain('Retry');
  });

  it('retries on the SAME agent when Retry is used', () => {
    const { card, posted } = render({
      reason: 'credits',
      message: 'out of credits',
      actions: ['topUp', 'retry'],
      agents: AGENTS,
      retryable: true,
    }, 'run the tests');

    card.buttons().find(b => b.textContent === 'Retry')!.click();
    expect(posted).toEqual([{
      type: 'switchAgentAndRetry',
      payload: { agentId: 'mysti', retryContent: 'run the tests' },
    }]);
  });

  it('puts the upstream error text through textContent, never innerHTML', () => {
    // The message embeds a raw provider error string; the El fake throws on
    // innerHTML, so this passing IS the escaping guarantee.
    const nasty = '<img src=x onerror=alert(1)> 401 rejected';
    const { card } = render({
      reason: 'auth-rejected',
      message: nasty,
      actions: ['signInAgain'],
      agents: [],
      retryable: false,
    });
    expect(card.allText()).toContain(nasty);
  });

  it('falls back to a sign-in button when the payload carries no actions', () => {
    const { card, posted } = render({ message: 'Mysti could not run this turn.' });
    card.buttons()[0].click();
    expect(posted).toEqual([{ type: 'signInDeepMyst' }]);
  });
});
