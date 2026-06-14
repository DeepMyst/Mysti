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
  function postMsg(msg) { vscode.postMessage(msg); }

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

  function statusLabel(status) {
    switch (status) {
      case 'connected': return 'Connected';
      case 'pending': return 'Pending authorization';
      case 'failed': return 'Failed';
      case 'revoked': return 'Revoked';
      default: return status || '';
    }
  }

  function renderConnections(list, available) {
    const ul = $('connections-list');
    ul.innerHTML = '';
    show($('connections-unavailable'), !available);
    show($('connections-empty'), available && list.length === 0);
    list.forEach(function (c) {
      const li = el('li', 'list-item');

      const left = el('div', 'list-item-main');
      if (c.iconUrl) {
        const img = document.createElement('img');
        img.className = 'conn-icon';
        img.src = c.iconUrl;
        img.alt = '';
        left.appendChild(img);
      }
      const text = el('div');
      text.appendChild(el('div', 'name', c.displayName || c.id));
      const metaBits = [c.provider, statusLabel(c.status)].filter(Boolean).join(' · ');
      if (metaBits) { text.appendChild(el('div', 'meta', metaBits)); }
      if (c.status === 'failed' && c.errorMessage) {
        text.appendChild(el('div', 'meta meta-error', c.errorMessage));
      } else if (c.description) {
        text.appendChild(el('div', 'meta', c.description));
      }
      left.appendChild(text);
      li.appendChild(left);

      const actions = el('div', 'list-item-actions');
      // Pending OAuth → let the user finish authorizing in the browser.
      if (c.status === 'pending' && c.setupUrl) {
        const finish = el('button', 'btn btn-primary', 'Finish authorizing');
        finish.addEventListener('click', function () {
          postMsg({ type: 'finishAuth', setupUrl: c.setupUrl });
        });
        actions.appendChild(finish);
      }
      const disc = el('button', 'btn btn-link', 'Disconnect');
      disc.addEventListener('click', function () {
        postMsg({ type: 'disconnectConnection', id: c.id, name: c.displayName || c.id });
      });
      actions.appendChild(disc);
      li.appendChild(actions);

      ul.appendChild(li);
    });
  }

  function renderError(message) {
    const box = $('connections-error');
    if (!box) { return; }
    if (message) {
      box.textContent = 'Couldn’t load your connections (' + message + '). Your DeepMyst sign-in key may not be bound to your user — sign out and sign in again to refresh it.';
      show(box, true);
    } else {
      box.textContent = '';
      show(box, false);
    }
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
      renderError(state.connectionsError);
      renderConnections(state.connections || [], state.connectionsAvailable !== false);
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
