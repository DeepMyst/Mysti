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
 * Plan 29 — the agent picker, driven against a REAL DOM.
 *
 * The picker was shipped with static assertions only ("chat.js contains
 * openSessionPicker"), which proves the source mentions a name and nothing about
 * whether a click renders a row. This loads the shipped chat.js into jsdom and
 * clicks it, because the failure being chased — the menu not appearing — is one
 * every static check passes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const CHAT_JS = fs.readFileSync(path.join(ROOT, 'media', 'chat', 'chat.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'media', 'chat', 'index.html'), 'utf8');

const MANIFEST = {
  schemaVersion: 1,
  providers: [
    { id: 'claude-code', displayName: 'Claude', shortId: 'claude', color: '#8B5CF6', icon: 'c.png', capabilities: {}, models: [], defaultModel: '' },
    { id: 'openai-codex', displayName: 'Codex', shortId: 'codex', color: '#10B981', icon: 'x.png', capabilities: {}, models: [], defaultModel: '' },
    { id: 'google-gemini', displayName: 'Gemini', shortId: 'gemini', color: '#4285F4', icon: 'g.png', capabilities: {}, models: [], defaultModel: '' },
  ],
};

const SESSIONS = [
  { id: 'review', commandId: 'session:review', command: '/review', description: 'each reads the same diff', minAgents: 2, maxAgents: 5, rounds: 1, costRate: 0.14 },
  { id: 'panel', commandId: 'session:panel', command: '/panel', description: 'each answers alone', minAgents: 3, maxAgents: 5, rounds: 1, costRate: 0.10 },
];

const MENU_PAYLOAD = {
  sections: [
    { id: 'sessions', label: 'Sessions', order: 0 },
    { id: 'commands', label: 'Commands', order: 4 },
  ],
  commands: [
    { id: 'session:review', label: '/review', description: 'each reads the same diff', section: 'sessions', icon: 'checklist', provider: 'all', action: 'submenu', keywords: ['session'] },
    { id: 'session:panel', label: '/panel', description: 'each answers alone', section: 'sessions', icon: 'organization', provider: 'all', action: 'submenu', keywords: ['session'] },
    { id: 'cmd:clear', label: '/clear', description: 'Clear conversation', section: 'commands', icon: 'trash', provider: 'all', action: 'execute', keywords: ['clear'] },
  ],
  sessions: SESSIONS,
};

interface Harness {
  win: any;
  doc: Document;
  posted: Array<{ type: string; requestId?: string; payload?: any }>;
  /** Deliver a message the extension would post. */
  receive(message: unknown): void;
  openMenu(): void;
  menuRows(): Element[];
  agentRows(): Element[];
  runButton(): HTMLButtonElement | null;
}

const windows: Array<{ close(): void }> = [];
afterEach(() => { for (const win of windows.splice(0)) { win.close(); } });

function boot(): Harness {
  // The real page markup, minus the script tags jsdom would try to fetch.
  const body = INDEX_HTML
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*>/gi, '');

  const dom = new JSDOM(body, { runScripts: 'outside-only', pretendToBeVisual: true });
  const win: any = dom.window;
  windows.push(win);
  const posted: Array<{ type: string; requestId?: string; payload?: any }> = [];

  // Every logo/icon the page reads at load. A Proxy answers any *Uri lookup
  // with a stub, so a new asset added to the boot object never breaks this
  // harness — the picker is what is under test, not the icon plumbing.
  win.__MYSTI_BOOT__ = new Proxy(
    { panelId: 'sidebar', isSidebar: true, manifestSchemaVersion: 1, iconUris: new Proxy({}, { get: () => 'icon.png' }) },
    { get: (target: any, key: string) => (key in target ? target[key] : '') },
  );
  win.acquireVsCodeApi = () => ({
    postMessage: (m: any) => { posted.push(m); },
    getState: () => undefined,
    setState: () => undefined,
  });

  // The page reads these on load; absent ones must not stop the script.
  win.eval(fs.readFileSync(path.join(ROOT, 'media', 'chat', 'markdownRenderer.js'), 'utf8'));
  win.eval(fs.readFileSync(path.join(ROOT, 'media', 'chat', 'subAgentCards.js'), 'utf8'));
  win.eval(fs.readFileSync(path.join(ROOT, 'media', 'chat', 'toolCards.js'), 'utf8'));
  win.eval(fs.readFileSync(path.join(ROOT, 'media', 'chat', 'messageRenderer.js'), 'utf8'));
  win.eval(fs.readFileSync(path.join(ROOT, 'media', 'chat', 'streamingTimeline.js'), 'utf8'));
  win.eval(CHAT_JS);

  const receive = (message: unknown) => {
    win.dispatchEvent(new win.MessageEvent('message', { data: message }));
  };

  // Typing '/' is how the menu opens in production, and it is what arms the
  // document-level "clicked outside" dismiss handler. A harness that skips it
  // cannot see a dismiss bug at all.
  const openMenu = () => {
    const input = win.document.getElementById('message-input') as HTMLTextAreaElement;
    input.value = '/';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
  };

  return {
    win,
    doc: win.document,
    posted,
    receive,
    openMenu,
    menuRows: () => [...win.document.querySelectorAll('#slash-menu-sections .slash-menu-item')],
    agentRows: () => [...win.document.querySelectorAll('#slash-menu-sections .session-agent-row')],
    runButton: () => win.document.querySelector('#slash-menu-sections .session-run-btn'),
  };
}

describe('the session agent picker, in a real DOM', () => {
  let h: Harness;

  beforeEach(() => {
    h = boot();
    // What initialState would establish before any menu opens.
    h.receive({
      type: 'initialState',
      payload: {
        panelId: 'sidebar',
        settings: { provider: 'claude-code', model: 'm', mode: 'default', accessLevel: 'full-access', contextMode: 'auto', thinkingLevel: 'none' },
        context: [],
        conversation: null,
        providers: [],
        providerAvailability: {
          'claude-code': { available: true },
          'openai-codex': { available: true },
          'google-gemini': { available: true },
        },
        providerManifest: MANIFEST,
      },
    });
  });

  it('renders the Sessions section when the menu opens', () => {
    h.openMenu();
    h.receive({ type: 'slashCommandMenu', payload: MENU_PAYLOAD });
    const labels = h.menuRows().map(r => r.querySelector('.slash-menu-item-label')?.textContent);
    expect(labels).toContain('/review');
    expect(labels).toContain('/panel');
  });

  it('clicking a session command opens the agent list — the reported failure', () => {
    h.openMenu();
    h.receive({ type: 'slashCommandMenu', payload: MENU_PAYLOAD });

    const review = h.menuRows().find(r => r.querySelector('.slash-menu-item-label')?.textContent === '/review');
    expect(review, '/review row missing').toBeTruthy();
    (review as HTMLElement).click();

    const rows = h.agentRows();
    expect(rows.length, 'no agent rows rendered after picking a session').toBe(3);
    expect(rows.map(r => r.querySelector('.slash-menu-item-label')?.textContent))
      .toEqual(['Claude', 'Codex', 'Gemini']);
    // The menu must still be open — it became the picker, it did not close.
    expect(h.doc.getElementById('slash-menu')!.classList.contains('hidden')).toBe(false);
  });

  it('pre-ticks the shape minimum, starting with the panel’s own agent', () => {
    h.openMenu();
    h.receive({ type: 'slashCommandMenu', payload: MENU_PAYLOAD });
    (h.menuRows().find(r => r.querySelector('.slash-menu-item-label')?.textContent === '/review') as HTMLElement).click();

    const checked = h.agentRows().filter(r => r.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(2);
    expect(checked[0].querySelector('.slash-menu-item-label')?.textContent).toBe('Claude');
    expect(h.runButton()!.disabled).toBe(false);
  });

  it('ticking a box off drops below the floor and kills Run', () => {
    h.openMenu();
    h.receive({ type: 'slashCommandMenu', payload: MENU_PAYLOAD });
    (h.menuRows().find(r => r.querySelector('.slash-menu-item-label')?.textContent === '/review') as HTMLElement).click();

    const claude = h.agentRows()[0] as HTMLElement;
    claude.click();

    expect(h.agentRows().filter(r => r.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    expect(h.runButton()!.disabled).toBe(true);
    expect(h.runButton()!.textContent).toContain('Pick 2+');
  });

  it('Run posts startSession with the ticked agents', () => {
    h.openMenu();
    h.receive({ type: 'slashCommandMenu', payload: MENU_PAYLOAD });
    (h.menuRows().find(r => r.querySelector('.slash-menu-item-label')?.textContent === '/review') as HTMLElement).click();

    h.posted.length = 0;
    (h.runButton() as HTMLElement).click();

    const start = h.posted.find(m => m.type === 'startSession');
    expect(start, 'Run posted no startSession').toBeTruthy();
    expect(start!.payload.shape).toBe('review');
    expect(start!.payload.agentIds).toHaveLength(2);
  });

  function submitSession(): string {
    h.receive({ type: 'openSessionPicker', payload: { commandId: 'session:review', brief: 'Review this change', sessions: SESSIONS } });
    h.runButton()!.click();
    const request = h.posted.filter(message => message.type === 'startSession').at(-1)!;
    expect(request.requestId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect((h.doc.getElementById('stop-btn') as HTMLElement).style.display).not.toBe('none');
    return request.requestId!;
  }

  it('releases a prepared session on its own preflight refusal without creating an empty answer', () => {
    const requestId = submitSession();
    h.receive({ type: 'responsePending', requestId, payload: { sequence: 1 } });
    h.receive({ type: 'sessionError', requestId, payload: { message: 'Review needs two installed agents.' } });
    h.receive({ type: 'responseComplete', requestId, payload: {} });
    expect((h.doc.getElementById('stop-btn') as HTMLElement).style.display).toBe('none');
    expect(h.doc.querySelectorAll('.message.assistant')).toHaveLength(0);
    expect(h.doc.getElementById('messages')!.textContent).toContain('Review needs two installed agents.');
  });

  it('renders a final-only session answer once with its persisted identity and attribution', () => {
    const requestId = submitSession();
    h.receive({ type: 'responsePending', requestId, payload: { sequence: 1 } });
    h.receive({ type: 'responseStarted', requestId, payload: { provider: 'review', model: 'Claude, Codex' } });
    const completion = { type: 'responseComplete', requestId, payload: { message: {
      id: 'final-session-answer', role: 'assistant', content: 'A complete session answer.', provider: 'review', model: 'Claude, Codex',
    } } };
    h.receive(completion);
    h.receive(completion);
    const answers = h.doc.querySelectorAll('.message.assistant[data-id="final-session-answer"]');
    expect(answers).toHaveLength(1);
    expect(answers[0].textContent).toContain('A complete session answer.');
    expect(answers[0].querySelector('.message-model-info')?.textContent).toContain('Claude, Codex');
    expect(answers[0].classList.contains('streaming')).toBe(false);
    expect((h.doc.getElementById('stop-btn') as HTMLElement).style.display).toBe('none');
  });

  it.each([false, true])('keeps captured attribution when the picker changes before completion (streamed=%s)', streamed => {
    const requestId = submitSession();
    h.receive({ type: 'responsePending', requestId, payload: { sequence: 1 } });
    h.receive({ type: 'responseStarted', requestId, payload: { provider: 'review', model: 'Original session model' } });
    if (streamed) {
      h.receive({ type: 'responseChunk', requestId, payload: { type: 'text', content: 'Partial answer.' } });
    }
    h.receive({ type: 'modelChanged', payload: { model: 'new-picker-model' } });
    h.receive({ type: 'responseComplete', requestId, payload: { message: {
      id: 'captured-session-answer', role: 'assistant', content: 'Final answer with no repeated attribution.',
    } } });
    const answer = h.doc.querySelector('.message.assistant[data-id="captured-session-answer"]')!;
    expect(answer.textContent).toContain('Final answer with no repeated attribution.');
    expect(answer.querySelector('.message-model-info')?.textContent).toContain('Original session model');
    expect(answer.querySelector('.message-model-info')?.textContent).not.toContain('new-picker-model');
  });

  it.each(['error', 'authError'])('finishes Runs on admitted %s while an independent notice leaves it running', type => {
    const requestId = submitSession();
    h.receive({ type: 'responsePending', requestId, payload: { sequence: 1 } });
    h.receive({ type: 'responseStarted', requestId, payload: { provider: 'review', model: 'Claude, Codex' } });
    const working = () => h.doc.querySelector('.runs-tab-count[data-count="working"]')!.textContent;
    expect(working()).toBe('1');
    h.receive({ type: 'error', scope: 'notice', payload: 'An unrelated control failed.' });
    expect(working()).toBe('1');
    const terminal = { type, requestId, payload: type === 'error' ? 'The request failed.' : {
      providerName: 'Review', authCommand: 'test sign-in', error: 'Sign-in required.',
    } };
    h.receive(terminal);
    expect((h.doc.getElementById('stop-btn') as HTMLElement).style.display).toBe('none');
    expect(working()).toBe('0');
    h.receive(terminal);
    expect(working()).toBe('0');
  });

  it('keeps the next prepared session intact when a completed session repeats its events', () => {
    const first = submitSession();
    h.receive({ type: 'responsePending', requestId: first, payload: { sequence: 1 } });
    h.receive({ type: 'responseComplete', requestId: first, payload: {} });
    const second = submitSession();
    expect(second).not.toBe(first);
    h.receive({ type: 'responsePending', requestId: first, payload: { sequence: 1 } });
    h.receive({ type: 'responseStarted', requestId: first, payload: { provider: 'review' } });
    h.receive({ type: 'responseChunk', requestId: first, payload: { type: 'text', content: 'STALE_SESSION' } });
    h.receive({ type: 'responseComplete', requestId: first, payload: {} });
    expect(h.doc.getElementById('messages')!.textContent).not.toContain('STALE_SESSION');
    expect((h.doc.getElementById('stop-btn') as HTMLElement).style.display).not.toBe('none');
    h.receive({ type: 'responsePending', requestId: second, payload: { sequence: 2 } });
    h.receive({ type: 'responseComplete', requestId: second, payload: {} });
    expect((h.doc.getElementById('stop-btn') as HTMLElement).style.display).toBe('none');
  });

  it('does not replace a locally prepared session with an unrelated host acknowledgement', () => {
    const requestId = submitSession();
    h.receive({ type: 'responsePending', requestId: 'unrelated-host-request', payload: { sequence: 99 } });
    h.receive({ type: 'responseComplete', requestId: 'unrelated-host-request', payload: {} });
    expect((h.doc.getElementById('stop-btn') as HTMLElement).style.display).not.toBe('none');
    h.receive({ type: 'responsePending', requestId, payload: { sequence: 1 } });
    h.receive({ type: 'responseComplete', requestId, payload: {} });
    expect((h.doc.getElementById('stop-btn') as HTMLElement).style.display).toBe('none');
  });

  it('correlates Stop before session acknowledgement and refuses the cancelled tail', () => {
    const requestId = submitSession();
    (h.doc.getElementById('stop-btn') as HTMLButtonElement).click();
    const stop = h.posted.filter(message => message.type === 'cancelRequest').at(-1)!;
    expect(stop.requestId).toBe(requestId);
    h.receive({ type: 'requestCancelled', requestId });
    h.receive({ type: 'responsePending', requestId, payload: { sequence: 1 } });
    h.receive({ type: 'responseStarted', requestId, payload: { provider: 'review' } });
    h.receive({ type: 'responseChunk', requestId, payload: { type: 'text', content: 'CANCELLED_SESSION' } });
    expect(h.doc.getElementById('messages')!.textContent).not.toContain('CANCELLED_SESSION');
    expect((h.doc.getElementById('stop-btn') as HTMLElement).style.display).toBe('none');
  });

  it('a panel needs three, so Run is dead at the pre-ticked two', () => {
    h.openMenu();
    h.receive({ type: 'slashCommandMenu', payload: MENU_PAYLOAD });
    (h.menuRows().find(r => r.querySelector('.slash-menu-item-label')?.textContent === '/panel') as HTMLElement).click();

    // Three available agents, floor of three: all three get pre-ticked.
    expect(h.agentRows().filter(r => r.getAttribute('aria-checked') === 'true')).toHaveLength(3);
    expect(h.runButton()!.disabled).toBe(false);
  });

  it('Cancel closes the picker without starting anything', () => {
    h.openMenu();
    h.receive({ type: 'slashCommandMenu', payload: MENU_PAYLOAD });
    (h.menuRows().find(r => r.querySelector('.slash-menu-item-label')?.textContent === '/review') as HTMLElement).click();

    h.posted.length = 0;
    (h.doc.querySelector('.session-cancel-btn') as HTMLElement).click();

    expect(h.doc.getElementById('slash-menu')!.classList.contains('hidden')).toBe(true);
    expect(h.posted.find(m => m.type === 'startSession')).toBeUndefined();
  });

  it('still lists agents when the manifest never arrived — the reported failure', () => {
    // The webview drops a manifest whose schemaVersion it does not recognise,
    // and one may simply not have arrived. Reading it as the ONLY source
    // rendered a picker with a heading, a hint and no agent rows at all.
    const bare = boot();
    bare.receive({
      type: 'initialState',
      payload: {
        panelId: 'sidebar',
        settings: { provider: 'claude-code', model: 'm', mode: 'default', accessLevel: 'full-access', contextMode: 'auto', thinkingLevel: 'none' },
        context: [], conversation: null, providers: [],
        providerAvailability: {
          'claude-code': { available: true },
          'openai-codex': { available: true },
        },
        // A manifest the webview will reject outright.
        providerManifest: { schemaVersion: 999, providers: [] },
      },
    });
    bare.openMenu();
    bare.receive({ type: 'slashCommandMenu', payload: MENU_PAYLOAD });
    (bare.menuRows().find(r => r.querySelector('.slash-menu-item-label')?.textContent === '/review') as HTMLElement).click();

    expect(bare.agentRows().length, 'picker rendered with no agents').toBe(2);
    expect(bare.runButton()!.disabled).toBe(false);
  });

  it('says why when there is genuinely nothing to offer', () => {
    const bare = boot();
    bare.receive({
      type: 'initialState',
      payload: {
        panelId: 'sidebar',
        settings: { provider: 'claude-code', model: 'm', mode: 'default', accessLevel: 'full-access', contextMode: 'auto', thinkingLevel: 'none' },
        context: [], conversation: null, providers: [],
        providerAvailability: {},
        providerManifest: { schemaVersion: 999, providers: [] },
      },
    });
    bare.openMenu();
    bare.receive({ type: 'slashCommandMenu', payload: MENU_PAYLOAD });
    (bare.menuRows().find(r => r.querySelector('.slash-menu-item-label')?.textContent === '/review') as HTMLElement).click();

    expect(bare.agentRows()).toHaveLength(0);
    expect(bare.doc.querySelector('.session-agent-empty')?.textContent)
      .toContain('No agents are available yet');
  });

  it('a TYPED command with args opens the picker too — the second dead end', () => {
    // `/review the auth diff` matches no menu row (the args are part of the
    // query), so it goes through sendMessage and comes back as this message.
    // Before, it reached a switch with no case and did nothing at all.
    h.receive({
      type: 'openSessionPicker',
      payload: { commandId: 'session:review', brief: 'the auth diff', sessions: SESSIONS },
    });

    expect(h.agentRows().length, 'typed command opened no picker').toBe(3);

    h.posted.length = 0;
    (h.runButton() as HTMLElement).click();
    const start = h.posted.find(m => m.type === 'startSession')!;
    expect(start.payload.brief).toBe('the auth diff');
  });

  it('the typed path works before any menu has ever been opened', () => {
    // The catalog rides with the message, so a first-ever `/review` does not
    // depend on a menu render having happened first.
    const fresh = boot();
    fresh.receive({
      type: 'initialState',
      payload: {
        panelId: 'sidebar',
        settings: { provider: 'claude-code', model: 'm', mode: 'default', accessLevel: 'full-access', contextMode: 'auto', thinkingLevel: 'none' },
        context: [], conversation: null, providers: [],
        providerAvailability: { 'claude-code': { available: true }, 'openai-codex': { available: true } },
        providerManifest: MANIFEST,
      },
    });
    fresh.receive({
      type: 'openSessionPicker',
      payload: { commandId: 'session:review', brief: '', sessions: SESSIONS },
    });
    expect(fresh.agentRows().length).toBe(3);
  });

  it('an uninstalled agent is shown with the reason, and cannot be ticked', () => {
    h.receive({
      type: 'providerAvailability',
      payload: {
        providerAvailability: { 'google-gemini': { available: false, installCommand: 'npm i -g x' } },
      },
    });
    h.openMenu();
    h.receive({ type: 'slashCommandMenu', payload: MENU_PAYLOAD });
    (h.menuRows().find(r => r.querySelector('.slash-menu-item-label')?.textContent === '/review') as HTMLElement).click();

    const gemini = h.agentRows().find(r => r.querySelector('.slash-menu-item-label')?.textContent === 'Gemini')!;
    expect(gemini.classList.contains('disabled')).toBe(true);
    (gemini as HTMLElement).click();
    expect(gemini.getAttribute('aria-checked')).toBe('false');
  });

  // -------------------------------------------------------------------------

  describe('the live session card', () => {
    const requestId = 'host-session-card';
    beforeEach(() => {
      h.receive({ type: 'responsePending', requestId, payload: { sequence: 1 } });
      h.receive({ type: 'responseStarted', requestId, payload: { provider: 'review', model: 'Claude, Codex' } });
    });
    function receiveSession(message: { type: 'sessionEvent'; payload: unknown }): void {
      h.receive({ ...message, requestId });
    }

    const started = {
      runId: 'run-1', type: 'session_started', shape: 'review',
      lanes: [
        { collaboratorId: 'c0', agentId: 'claude-code', label: 'Claude', status: 'running', text: '' },
        { collaboratorId: 'c1', agentId: 'openai-codex', label: 'Codex', status: 'pending', text: '' },
      ],
    };

    it('renders one lane row per agent', () => {
      receiveSession({ type: 'sessionEvent', payload: started });
      expect(h.doc.querySelectorAll('#session-card .session-lane')).toHaveLength(2);
      expect(h.doc.querySelector('.session-card-progress')!.textContent).toContain('0 of 2 landed');
    });

    it('a running lane offers Stop, and it reaches the extension', () => {
      receiveSession({ type: 'sessionEvent', payload: started });
      h.posted.length = 0;
      (h.doc.querySelector('.session-lane-stop') as HTMLElement).click();

      const stop = h.posted.find(m => m.type === 'stopSessionLane');
      expect(stop, 'Stop posted nothing').toBeTruthy();
      expect(stop!.payload).toEqual({ runId: 'run-1', collaboratorId: 'c0' });
    });

    it('a lane update replaces that lane in place, not appends', () => {
      receiveSession({ type: 'sessionEvent', payload: started });
      receiveSession({
        type: 'sessionEvent',
        payload: {
          runId: 'run-1', type: 'lane_update',
          lane: { collaboratorId: 'c0', agentId: 'claude-code', label: 'Claude', status: 'done', text: 'x', ms: 2000 },
        },
      });
      expect(h.doc.querySelectorAll('#session-card .session-lane')).toHaveLength(2);
      expect(h.doc.querySelector('.session-card-progress')!.textContent).toContain('1 of 2 landed');
      expect(h.doc.querySelector('.session-lane-done')).toBeTruthy();
    });

    it('a failed lane shows the reason in words, not a taxonomy code', () => {
      receiveSession({ type: 'sessionEvent', payload: started });
      receiveSession({
        type: 'sessionEvent',
        payload: {
          runId: 'run-1', type: 'lane_update',
          lane: { collaboratorId: 'c1', agentId: 'openai-codex', label: 'Codex', status: 'skipped', text: '', error: 'CLI is not signed in' },
        },
      });
      expect(h.doc.querySelector('.session-lane-note-bad')!.textContent).toBe('CLI is not signed in');
    });

    it('the card is removed when the session completes — the message is the result', () => {
      receiveSession({ type: 'sessionEvent', payload: started });
      receiveSession({ type: 'sessionEvent', payload: { runId: 'run-1', type: 'session_complete', markdown: '# done', lanes: [] } });
      expect(h.doc.getElementById('session-card')).toBeNull();
    });

    it('a stray event with no card does not throw', () => {
      expect(() => receiveSession({
        type: 'sessionEvent',
        payload: { runId: 'x', type: 'lane_update', lane: { collaboratorId: 'c9', agentId: 'claude-code', label: 'x', status: 'done', text: '' } },
      })).not.toThrow();
      expect(h.doc.getElementById('session-card')).toBeNull();
    });
  });
});
