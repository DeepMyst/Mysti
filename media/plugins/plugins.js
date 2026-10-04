/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 45 — Manage Plugins webview. Renders the `state` the host posts and
 * posts the user's clicks back. It decides nothing: the host checks every id,
 * scope and source against what the CLI reported, and asks before anything
 * that runs code is installed. Strings from a CLI or a marketplace are
 * untrusted and only ever reach the DOM through textContent.
 */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const CAP = 100;
  const SCOPE_LABEL = { user: 'For you', project: 'This project', local: 'Just you, this repo' };
  const SCOPE_HINT = { user: 'Every project on this machine', project: 'Shared with this workspace', local: 'Only you, in this workspace' };
  const SCOPE_BADGE = { user: 'User', project: 'Project', local: 'Local', bundled: 'Bundled', managed: 'Managed' };

  let state = null;
  let tab = 'plugins';
  let scopeFor = null;
  let sourceScopesOpen = false;
  let lastSelected = null;
  let searchTimer = null;

  function $(id) { return document.getElementById(id); }
  function post(m) { vscode.postMessage(m); }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text !== undefined && text !== null) { e.textContent = String(text); }
    return e;
  }

  function button(text, cls, attrs) {
    const b = el('button', cls, text);
    b.type = 'button';
    Object.keys(attrs || {}).forEach(function (k) { b.setAttribute(k, attrs[k]); });
    return b;
  }

  function show(node, text) {
    node.hidden = !text;
    if (text) { node.textContent = text; }
  }

  // ── Static controls ──────────────────────────────────────────────────────

  $('backend').addEventListener('change', function (e) { post({ type: 'select', backend: e.target.value }); });
  $('refresh').addEventListener('click', function () { post({ type: 'refresh' }); });
  $('banner-close').addEventListener('click', function () { $('banner').hidden = true; });
  $('search').addEventListener('input', function () {
    if (state && state.can && state.can.search) {
      clearTimeout(searchTimer);
      const query = $('search').value.trim();
      searchTimer = setTimeout(function () { post({ type: 'search', query: query }); }, 300);
    }
    render();
  });
  document.querySelectorAll('[role="tab"]').forEach(function (t) {
    t.addEventListener('click', function () { tab = t.dataset.tab; render(); });
  });
  $('source-install').addEventListener('click', function () {
    const source = $('source-input').value.trim();
    if (!source || !state) { return; }
    const scopes = state.scopes || [];
    if (scopes.length > 1) {
      sourceScopesOpen = !sourceScopesOpen;
      render();
    } else {
      post({ type: 'installSource', source: source, scope: scopes[0] || 'user' });
    }
  });
  $('source-scopes').addEventListener('click', function (e) {
    const b = e.target.closest('button[data-scope]');
    if (!b || b.disabled) { return; }
    sourceScopesOpen = false;
    post({ type: 'installSource', source: $('source-input').value.trim(), scope: b.dataset.scope });
    render();
  });
  $('mkt-add').addEventListener('click', function () {
    const source = $('mkt-source').value.trim();
    if (source) { post({ type: 'addMarketplace', source: source }); }
  });

  $('installed').addEventListener('click', onRowClick);
  $('available').addEventListener('click', onRowClick);
  $('markets').addEventListener('click', function (e) {
    const b = e.target.closest('button[data-action]');
    const li = b && b.closest('li[data-name]');
    if (!li) { return; }
    const type = b.dataset.action === 'remove' ? 'removeMarketplace' : 'refreshMarketplace';
    post({ type: type, name: li.dataset.name });
  });

  function onRowClick(e) {
    const b = e.target.closest('button[data-action], button[data-scope]');
    const li = b && b.closest('li[data-id]');
    if (!li || b.disabled) { return; }
    const id = li.dataset.id;
    if (b.dataset.scope) {
      scopeFor = null;
      post({ type: 'install', id: id, scope: b.dataset.scope });
      render();
      return;
    }
    const action = b.dataset.action;
    if (action === 'install') {
      const scopes = state.scopes || [];
      if (scopes.length > 1) {
        scopeFor = scopeFor === id ? null : id;
        render();
      } else {
        post({ type: 'install', id: id, scope: scopes[0] || 'user' });
      }
    } else if (action === 'cancel-scope') {
      scopeFor = null;
      render();
    } else if (action === 'toggle') {
      post({ type: 'setEnabled', id: id, scope: li.dataset.scope, on: b.getAttribute('aria-checked') !== 'true' });
    } else {
      const menu = b.closest('details');
      if (menu) { menu.open = false; }
      post({ type: action, id: id, scope: li.dataset.scope });
    }
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  /** The focused control, by row and action, so it can be found again after a re-render. */
  function focusKey() {
    const a = document.activeElement;
    const row = a && a.closest ? a.closest('li[data-id], li[data-name]') : null;
    if (!row) { return null; }
    return {
      list: row.parentElement && row.parentElement.id,
      id: row.dataset.id || row.dataset.name,
      sel: a.getAttribute('role') === 'switch' ? '[role="switch"]'
        : a.dataset.action ? '[data-action="' + a.dataset.action + '"]'
          : a.dataset.scope ? '[data-scope="' + a.dataset.scope + '"]'
            : a.tagName === 'SUMMARY' ? 'summary' : null,
    };
  }

  function restoreFocus(key) {
    if (!key || !key.list || !key.sel) { return; }
    const rows = document.querySelectorAll('#' + key.list + ' > li');
    for (let i = 0; i < rows.length; i++) {
      if ((rows[i].dataset.id || rows[i].dataset.name) === key.id) {
        const target = rows[i].querySelector(key.sel);
        if (target) { target.focus(); }
        return;
      }
    }
  }

  function render() {
    const key = focusKey();
    renderNow();
    restoreFocus(key);
  }

  function renderNow() {
    if (!state) { return; }
    const s = state;
    if (s.selected !== lastSelected) {
      lastSelected = s.selected;
      tab = 'plugins';
      scopeFor = null;
      sourceScopesOpen = false;
      $('search').value = '';
      $('source-input').value = '';
    }
    const current = (s.backends || []).find(function (b) { return b.id === s.selected; }) || {};
    renderBackends(s);
    $('status').textContent = current.name
      ? 'Plugins belong to a backend, not to one chat. A change reaches every ' + current.name + ' chat from its next message.'
      : '';
    show($('note'), s.note || '');
    show($('error'), s.error || '');
    show($('warning'), s.listing && s.listing.warning ? s.listing.warning : '');
    $('banner').hidden = !s.banner;
    $('banner-text').textContent = s.banner || '';

    $('main').hidden = current.status !== 'ok';
    if ($('main').hidden) { return; }

    const can = s.can || {};
    if (!can.marketplaces) { tab = 'plugins'; }
    $('tab-marketplaces').hidden = !can.marketplaces;
    ['plugins', 'marketplaces'].forEach(function (name) {
      $('tab-' + name).setAttribute('aria-selected', String(tab === name));
      $('panel-' + name).hidden = tab !== name;
    });
    renderPlugins(s);
    renderMarkets(s);
  }

  function renderBackends(s) {
    const select = $('backend');
    select.replaceChildren();
    (s.backends || []).forEach(function (b) {
      const suffix = b.status === 'none' ? ' — no plugin system'
        : b.status === 'note' ? ' — managed outside Mysti'
          : b.status === 'missing' ? ' — CLI not found'
            : (b.version ? ' ' + b.version : '');
      const option = el('option', null, b.name + suffix);
      option.value = b.id;
      option.disabled = b.status === 'none';
      select.append(option);
    });
    select.value = s.selected;
  }

  function matches(query) {
    return function (p) {
      return !query
        || String(p.name || '').toLowerCase().indexOf(query) >= 0
        || String(p.id || '').toLowerCase().indexOf(query) >= 0
        || String(p.description || '').toLowerCase().indexOf(query) >= 0;
    };
  }

  function renderPlugins(s) {
    const query = $('search').value.trim().toLowerCase();
    const can = s.can || {};
    const listing = s.listing;
    // A CLI that can't list (Cursor) shows only its note: never "Nothing installed".
    const canList = can.list !== false;
    const hasCatalog = !!can.search || !!(listing && listing.available);
    $('search-box').hidden = !canList;
    ['installed-h', 'installed'].forEach(function (id) { $(id).hidden = !canList; });
    if (!canList) { $('installed-empty').hidden = true; }
    renderSourceForm(s);
    if (!canList) {
      ['available-h', 'available-empty', 'available', 'more'].forEach(function (id) { $(id).hidden = true; });
      return;
    }
    ['available-h', 'available'].forEach(function (id) { $(id).hidden = !hasCatalog; });
    const installedAll = listing ? listing.installed : [];
    const installed = installedAll.filter(matches(query));
    $('count-installed').textContent = listing ? String(installedAll.length) : '';
    $('search').placeholder = can.search ? 'Search installed plugins and the catalog' : 'Search plugins';

    fill($('installed'), installed, function (p) { return installedRow(p, s); });
    show($('installed-empty'), !listing
      ? (s.loading ? 'Loading…' : '')
      : installed.length ? '' : (query ? 'No installed plugins match “' + query + '”.' : 'Nothing installed yet.'));

    const installedIds = {};
    installedAll.forEach(function (p) { installedIds[p.id] = true; });
    let available;
    let empty;
    if (can.search) {
      const results = s.search && s.search.query.toLowerCase() === query ? s.search.results : [];
      available = query ? results : [];
      empty = !query ? 'Type to search the catalog.' : (s.search && s.search.query.toLowerCase() === query ? 'Nothing matches “' + query + '”.' : 'Searching…');
      $('available-h').textContent = 'Catalog';
    } else {
      const all = (listing && listing.available) || [];
      available = all.filter(matches(query));
      empty = !listing ? '' : query ? 'Nothing available matches “' + query + '”.' : 'No catalog plugins to show.';
      $('available-h').textContent = 'Available' + (listing ? ' · ' + all.length.toLocaleString('en-US') : '');
    }
    // OpenClaw installs a ClawHub package under its runtime id.
    available = available.filter(function (p) { return !installedIds[p.id] && !(p.installedAs && installedIds[p.installedAs]); });
    fill($('available'), available, function (p) { return availableRow(p, s); });
    show($('available-empty'), available.length || !hasCatalog ? '' : empty);
    const more = installed.length > CAP || available.length > CAP;
    show($('more'), more ? (Math.max(installed.length, available.length) - CAP) + ' more. Search to narrow the list.' : '');
  }

  function fill(list, items, row) {
    list.replaceChildren();
    items.slice(0, CAP).forEach(function (item) { list.append(row(item)); });
  }

  function titleLine(name, metas) {
    const line = el('div', 'row-title');
    line.append(el('span', 'name', name));
    metas.filter(Boolean).forEach(function (m) { line.append(el('span', 'meta', m)); });
    return line;
  }

  function installedRow(p, s) {
    const can = s.can || {};
    const li = el('li', 'row');
    li.dataset.id = p.id;
    li.dataset.scope = p.scope;
    const head = el('div', 'row-head');
    const main = el('div', 'row-main');
    main.append(titleLine(p.name, [p.marketplace, p.version]));
    if (p.description) { main.append(el('div', 'desc', p.description)); }
    if (p.error) { main.append(el('div', 'row-error', p.error)); }
    const side = el('div', 'row-side');
    side.append(el('span', 'badge', SCOPE_BADGE[p.scope] || p.scope));
    const busy = s.busy && s.busy[p.id];
    if (busy) {
      side.append(el('span', 'row-busy', busy));
    } else {
      if (can.toggle && p.scope !== 'managed') {
        const sw = button('', 'switch', {
          role: 'switch', 'aria-checked': String(p.enabled !== false), 'data-action': 'toggle',
          'aria-label': (p.enabled !== false ? 'Turn off ' : 'Turn on ') + p.name,
        });
        sw.append(el('span', 'knob'));
        side.append(sw);
      } else {
        side.append(el('span', 'meta', p.enabled === false ? 'Off' : 'On'));
      }
      const items = [];
      if (can.details) { items.push(['details', 'Details']); }
      if (can.update) { items.push(['update', 'Update']); }
      if (can.uninstall && p.scope !== 'bundled' && p.scope !== 'managed') { items.push(['uninstall', 'Uninstall']); }
      if (items.length) {
        const menu = el('details', 'menu');
        const summary = el('summary', 'icon-btn', '⋯');
        summary.setAttribute('aria-label', 'More actions for ' + p.name);
        menu.append(summary);
        const box = el('div', 'menu-items');
        items.forEach(function (it) { box.append(button(it[1], it[0] === 'uninstall' ? 'menu-item danger' : 'menu-item', { 'data-action': it[0] })); });
        menu.append(box);
        side.append(menu);
      }
    }
    head.append(main, side);
    li.append(head);
    const err = s.rowErrors && s.rowErrors[p.id];
    if (err) { li.append(el('div', 'row-error', err)); }
    if (s.details && s.details.id === p.id) { li.append(el('pre', 'details', s.details.text)); }
    return li;
  }

  function availableRow(p, s) {
    const li = el('li', 'row');
    li.dataset.id = p.id;
    const head = el('div', 'row-head');
    const main = el('div', 'row-main');
    const installs = typeof p.installCount === 'number' ? p.installCount.toLocaleString('en-US') + ' installs' : '';
    main.append(titleLine(p.name, [p.marketplace, p.version, installs]));
    if (p.description) { main.append(el('div', 'desc clamp', p.description)); }
    const side = el('div', 'row-side');
    const busy = s.busy && s.busy[p.id];
    const err = s.rowErrors && s.rowErrors[p.id];
    if (busy) {
      side.append(el('span', 'row-busy', busy));
    } else if ((s.can || {}).install !== false) {
      side.append(button('Install', 'btn', { 'data-action': 'install', 'aria-expanded': String(scopeFor === p.id), 'aria-label': 'Install ' + p.name }));
    }
    head.append(main, side);
    li.append(head);
    if (scopeFor === p.id && !busy) {
      const group = el('div', 'scopes');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', 'Install ' + p.name + ' for');
      const choices = el('div', 'scope-choices');
      scopeButtons(choices, s);
      group.append(choices, button('Cancel', 'btn btn-link', { 'data-action': 'cancel-scope' }));
      li.append(group);
    }
    if (err) { li.append(el('div', 'row-error', err)); }
    return li;
  }

  function scopeButtons(container, s) {
    (s.scopes || []).forEach(function (scope) {
      const locked = scope !== 'user' && !s.trusted;
      const b = button('', 'scope', { 'data-scope': scope });
      b.disabled = locked;
      b.append(el('strong', null, SCOPE_LABEL[scope] || scope), el('span', 'meta', locked ? 'Needs a trusted workspace' : SCOPE_HINT[scope] || ''));
      container.append(b);
    });
  }

  function renderSourceForm(s) {
    const can = s.can || {};
    $('source-form').hidden = !can.installSource;
    if (!can.installSource) { return; }
    const hint = s.sourceHint || { label: 'Source', placeholder: '' };
    $('source-label').textContent = hint.label;
    $('source-input').placeholder = hint.placeholder;
    const box = $('source-scopes');
    box.replaceChildren();
    box.hidden = !sourceScopesOpen;
    if (sourceScopesOpen) {
      const choices = el('div', 'scope-choices');
      scopeButtons(choices, s);
      box.append(choices);
    }
    const firstKey = function (map) { return Object.keys(map || {}).find(function (k) { return k.indexOf('source:') === 0; }); };
    const busyKey = firstKey(s.busy);
    const errKey = firstKey(s.rowErrors);
    show($('source-status'), busyKey ? s.busy[busyKey] : '');
    show($('source-error'), errKey ? s.rowErrors[errKey] : '');
  }

  function renderMarkets(s) {
    const list = s.markets || [];
    $('count-markets').textContent = s.markets ? String(list.length) : '';
    // Unread is not empty: when they couldn't be read, the error says so.
    $('markets-empty').hidden = !s.markets || list.length > 0;
    fill($('markets'), list, function (m) {
      const li = el('li', 'row');
      li.dataset.name = m.name;
      const head = el('div', 'row-head');
      const main = el('div', 'row-main');
      main.append(titleLine(m.name, [m.source]));
      const side = el('div', 'row-side');
      const busy = s.busy && s.busy['mkt:' + m.name];
      if (busy) {
        side.append(el('span', 'row-busy', busy));
      } else {
        side.append(button('Refresh', 'btn', { 'data-action': 'refresh', 'aria-label': 'Refresh ' + m.name }));
        if (m.builtin) {
          side.append(el('span', 'meta', 'Built in'));
        } else {
          side.append(button('Remove', 'btn danger', { 'data-action': 'remove', 'aria-label': 'Remove ' + m.name }));
        }
      }
      head.append(main, side);
      li.append(head);
      const err = s.rowErrors && s.rowErrors['mkt:' + m.name];
      if (err) { li.append(el('div', 'row-error', err)); }
      return li;
    });
  }

  window.addEventListener('message', function (e) {
    const m = e.data;
    if (m && m.type === 'state' && m.state) {
      state = m.state;
      render();
    }
  });

  post({ type: 'ready' });
})();
