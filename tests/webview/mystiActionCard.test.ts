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

  appendChild(child: El): El { this.children.push(child); return child; }
  addEventListener(type: string, fn: (ev?: unknown) => void): void {
    (this.listeners[type] ||= []).push(fn);
  }
  /** Browser-faithful: a disabled button dispatches nothing. */
  click(): void {
    if (this.disabled) { return; }
    for (const fn of this.listeners['click'] || []) { fn(); }
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

interface Rendered {
  card: El;
  posted: Array<{ type: string; payload?: any }>;
}

let chatJs: string;
beforeAll(() => {
  chatJs = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
});

function render(payload: unknown, lastSentContent = 'fix the login bug'): Rendered {
  const src = extractFunction(chatJs, 'renderMystiActionCard');
  // The label/message table lives beside the function; pull it in verbatim.
  const tableStart = chatJs.indexOf('var MYSTI_ACTION_LABELS = {');
  const tableEnd = chatJs.indexOf('};', tableStart) + 2;
  const table = chatJs.slice(tableStart, tableEnd);

  const messagesEl = new El('div');
  const posted: Array<{ type: string; payload?: any }> = [];
  const document = { createElement: (tag: string) => new El(tag) };
  const state = { lastSentContent, activeAgent: 'mysti' };

  const fn = new Function(
    'document', 'messagesEl', 'state', 'postMessageWithPanelId', 'hideLoading', 'scrollToBottom', 'payload',
    `${table}\n${src}\nrenderMystiActionCard(payload);`,
  );
  fn(
    document,
    messagesEl,
    state,
    (msg: { type: string; payload?: any }) => posted.push(msg),
    () => undefined,
    () => undefined,
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

  it('hides the agent list until asked, then lists exactly the agents given', () => {
    const { card } = render({
      reason: 'credits',
      message: 'out of credits',
      actions: ['topUp', 'switchAgent'],
      agents: AGENTS,
      retryable: false,
    });

    const list = card.findAll(el => el.className === 'mysti-action-agents')[0];
    expect(list).toBeDefined();
    expect(list.hidden).toBe(true);

    card.buttons().find(b => b.textContent === 'Switch to another agent')!.click();
    expect(list.hidden).toBe(false);
    expect(list.children.map(c => c.textContent)).toEqual(['Claude Code', 'OpenAI Codex']);
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
