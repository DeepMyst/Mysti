/*
 * Mysti - DeepMyst Connections panel script (Plan 04 Phase 2).
 * SPDX-License-Identifier: Apache-2.0
 *
 * Renders auth status + the user's DeepMyst connections/agents, and relays
 * sign-in/out/manage/refresh actions back to the extension. Display-only;
 * MCP-config wiring into the local CLIs is Phase 3.
 */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();

  function $(id) { return document.getElementById(id); }
  function show(el, on) { if (el) { el.classList.toggle('hidden', !on); } }

  function post(type) { vscode.postMessage({ type: type }); }

  // ── Wire up static buttons ──────────────────────────────────────────────
  function bind(id, type) {
    const el = $(id);
    if (el) { el.addEventListener('click', function () { post(type); }); }
  }
  bind('btn-signin', 'signIn');
  bind('btn-createkey', 'createKey');
  bind('btn-manage', 'manageConnections');
  bind('btn-refresh', 'refresh');
  bind('btn-signout', 'signOut');

  // ── Rendering ───────────────────────────────────────────────────────────
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text != null) { node.textContent = text; }
    return node;
  }

  function renderConnections(list, available) {
    const ul = $('connections-list');
    ul.innerHTML = '';
    show($('connections-unavailable'), !available);
    show($('connections-empty'), available && list.length === 0);
    list.forEach(function (c) {
      const li = el('li', 'list-item');
      const left = el('div');
      left.appendChild(el('div', 'name', c.name || c.id));
      const metaBits = [c.type, c.status].filter(Boolean).join(' · ');
      if (metaBits) { left.appendChild(el('div', 'meta', metaBits)); }
      li.appendChild(left);
      ul.appendChild(li);
    });
  }

  function renderAgents(list, available) {
    const ul = $('agents-list');
    ul.innerHTML = '';
    show($('agents-unavailable'), !available);
    show($('agents-empty'), available && list.length === 0);
    list.forEach(function (a) {
      const li = el('li', 'list-item');
      const left = el('div');
      left.appendChild(el('div', 'name', a.name || a.slug));
      if (a.description) { left.appendChild(el('div', 'meta', a.description)); }
      left.appendChild(el('div', 'endpoint', '/api/v1/mcp/' + a.slug));
      li.appendChild(left);
      ul.appendChild(li);
    });
  }

  function render(state) {
    const pill = $('status-pill');
    if (state.signedIn) {
      pill.textContent = 'Signed in';
      pill.className = 'pill pill-ok';
    } else {
      pill.textContent = 'Signed out';
      pill.className = 'pill pill-off';
    }
    show($('signed-out'), !state.signedIn);
    show($('signed-in'), state.signedIn);

    if (state.signedIn) {
      show($('loading'), !!state.loading);
      renderConnections(state.connections || [], state.connectionsAvailable !== false);
      renderAgents(state.agents || [], state.agentsAvailable !== false);
    }
  }

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (msg && msg.type === 'state') {
      render(msg.payload);
    }
  });

  // Signal readiness so the extension pushes initial state.
  post('uiReady');
})();
