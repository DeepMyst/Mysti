/* global module */
/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Desk rail + pairing ceremony renderer (Plan 26 Phase A/C).
 *
 * ── Everything here is peer-influenceable ──────────────────────────────────
 *
 * An alias is typed locally, but a trust domain, a task title and an error
 * string all originate on another person's machine. The CSP already blocks the
 * code-execution half — `script-src` carries a nonce so injected `onerror`
 * never fires, and `img-src` omits http(s) so injected markup cannot beacon.
 *
 * What CSP does NOT block is UI SPOOFING, and this rail is where a human
 * decides whether a key is genuine. Markup that merely LOOKS like Mysti's own
 * chrome — a second "verified" badge, a fake safety number — is the realistic
 * attack. So every interpolation goes through `escapeHtml`, with no exceptions
 * and no "this field is ours" shortcuts: a field that is ours today is a field
 * someone widens tomorrow.
 *
 * Plan 21 I37: this rail renders NO image, icon or font from peer-supplied
 * data. EchoLeak and CamoLeak both exfiltrated through auto-fetched images,
 * and the second rode a first-party allowlisted proxy — so an endpoint
 * allowlist is not the control. Not fetching is.
 *
 * ── Rendering is pure, wiring is separate ──────────────────────────────────
 *
 * The render functions take state and return an HTML string. They touch no
 * DOM and hold no state, so the escaping can be tested against THIS FILE
 * rather than against a restatement of it in a test — a restatement drifts,
 * and the drift is invisible until it matters.
 */
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Pure helpers
  // -------------------------------------------------------------------------

  /**
   * Escape for HTML text and attribute contexts.
   *
   * Backtick is included on top of the usual five: it is not special in
   * standards-mode HTML, but it terminates an attribute value in older IE
   * quirks parsing, and the cost of covering it is one replace.
   */
  function escapeHtml(value) {
    if (value === null || value === undefined) { return ''; }
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/`/g, '&#96;');
  }

  /**
   * Strip characters that reorder or hide rendered text.
   *
   * `DeskContract` already refuses these at the wire boundary, so anything
   * arriving here has passed that check. This is the second line, and it
   * exists because the rail also renders LOCAL strings (an alias the user
   * typed, an error message we composed) that never crossed the contract.
   *
   * Removed rather than escaped: an escaped bidi override is invisible in the
   * source and still reorders nothing useful — there is no legitimate reason
   * for one in a peer name.
   */
  function stripInvisible(value) {
    if (value === null || value === undefined) { return ''; }
    return String(value).replace(
      /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\u061C\uFEFF]/g,
      '',
    );
  }

  /** Clamp for display. Long strings are a layout attack, not just noise. */
  function clamp(value, max) {
    var s = stripInvisible(value);
    return s.length > max ? s.slice(0, max) + '…' : s;
  }

  /** The one entry point every interpolation must pass through. */
  function safe(value, max) {
    return escapeHtml(clamp(value, typeof max === 'number' ? max : 200));
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /**
   * The rail.
   *
   * Collapsed to a single line when there are no peers: an empty panel eating
   * sidebar space is how a feature earns resentment, but hiding it entirely
   * behind a command means a feature someone deliberately enabled gets
   * forgotten, and a forgotten Desk never gets tested.
   */
  function renderRail(state) {
    if (!state || !state.enabled) { return ''; }
    var peers = Array.isArray(state.peers) ? state.peers : [];

    if (peers.length === 0) {
      return (
        '<div class="desk-empty">' +
          '<span class="desk-empty-text">Desk pairing — no teammates yet. Pair another profile to share local status or scoped workspace coordinates.</span>' +
          '<button type="button" class="desk-btn desk-btn-link" data-desk-action="invite">Invite</button>' +
        '</div>'
      );
    }

    return (
      '<div class="desk-header">' +
        '<span class="desk-title">Paired teammates</span>' +
        '<button type="button" class="desk-btn desk-btn-link" data-desk-action="invite">Invite</button>' +
      '</div>' +
      '<p class="desk-empty-text">Use the Desk local status and workspace lookup commands with paired profiles on this computer. Cross-machine requests are not available yet.</p>' +
      '<ul class="desk-roster">' + peers.map(renderPeerRow).join('') + '</ul>' +
      renderIdentity(state.identity)
    );
  }

  /**
   * One roster row.
   *
   * A revoked peer keeps its row, marked. Removing it makes revocation
   * indistinguishable from a bug, and the one moment a user most wants
   * confirmation is just after revoking someone.
   */
  function renderPeerRow(peer) {
    if (!peer || typeof peer !== 'object') { return ''; }
    var revoked = peer.revoked === true;
    var rotated = typeof peer.rotatedFrom === 'string' && peer.rotatedFrom.length > 0;

    var classes = 'desk-peer' + (revoked ? ' desk-peer-revoked' : '') + (rotated ? ' desk-peer-unverified' : '');
    var verbs = Array.isArray(peer.verbs) ? peer.verbs : [];

    return (
      '<li class="' + classes + '" data-desk-peer="' + safe(peer.peerId, 64) + '">' +
        '<div class="desk-peer-line">' +
          '<span class="desk-peer-alias">' + safe(peer.alias, 32) + '</span>' +
          (rotated
            // I13: a rotated key inherits no pin and no history. It must not be
            // possible to read this row as a continuation of the old identity.
            ? '<span class="desk-peer-badge desk-badge-warn">new key — unverified</span>'
            : '') +
          (revoked ? '<span class="desk-peer-badge desk-badge-revoked">revoked</span>' : '') +
        '</div>' +
        '<div class="desk-peer-meta">' +
          '<span class="desk-peer-domain">' + safe(peer.trustDomain, 64) + '</span>' +
          '<span class="desk-peer-verbs">' +
            verbs.map(function (v) { return safe(v, 16); }).join(', ') +
          '</span>' +
        '</div>' +
        (revoked
          ? ''
          : '<button type="button" class="desk-btn desk-btn-danger" data-desk-action="revoke" ' +
            'data-desk-peer="' + safe(peer.peerId, 64) + '">Revoke</button>') +
      '</li>'
    );
  }

  /** This device's own fingerprint, so a human can read it to someone. */
  function renderIdentity(identity) {
    if (!identity || typeof identity !== 'object') { return ''; }
    return (
      '<div class="desk-identity">' +
        '<span class="desk-identity-label">This machine</span>' +
        '<code class="desk-identity-id">' + safe(identity.peerId, 64) + '</code>' +
      '</div>'
    );
  }

  /**
   * The ceremony.
   *
   * The copy names the FAILURE rather than the action. "Verify identity" is an
   * abstraction nobody models; "someone is intercepting this pairing" is a
   * thing a person can picture, and picturing it is what makes them actually
   * compare the digits.
   */
  function renderChallenge(challenge) {
    if (!challenge || typeof challenge !== 'object') { return ''; }
    var groups = Array.isArray(challenge.groups) ? challenge.groups : [];
    var demanded = Array.isArray(challenge.demanded) ? challenge.demanded : [];

    var grid = groups.map(function (g, i) {
      var n = i + 1;
      var isDemanded = demanded.indexOf(n) !== -1;
      return (
        '<span class="desk-sn-group' + (isDemanded ? ' desk-sn-demanded' : '') + '">' +
          '<span class="desk-sn-index">' + n + '</span>' +
          safe(g, 8) +
        '</span>'
      );
    }).join('');

    var inputs = demanded.map(function (n) {
      return (
        '<label class="desk-answer">' +
          '<span class="desk-answer-label">Group ' + Number(n) + '</span>' +
          '<input type="text" class="desk-answer-input" inputmode="numeric" ' +
            'autocomplete="off" maxlength="12" data-desk-group="' + Number(n) + '" />' +
        '</label>'
      );
    }).join('');

    return (
      '<div class="desk-ceremony">' +
        '<h3 class="desk-ceremony-title">Compare your safety number</h3>' +
        '<p class="desk-ceremony-warn">' +
          'If these numbers differ, <strong>someone is intercepting this pairing</strong>. ' +
          'Stop and tell them.' +
        '</p>' +
        '<div class="desk-sn-grid">' + grid + '</div>' +
        '<p class="desk-ceremony-hint">' +
          'Compare on a <strong>different channel</strong> than the invite arrived on — ' +
          'a call, or in person. If someone can read both, they can sit between both.' +
        '</p>' +
        '<p class="desk-ceremony-ask">Type the highlighted groups to continue:</p>' +
        '<div class="desk-answers">' + inputs + '</div>' +
        (typeof challenge.attemptsLeft === 'number' && challenge.attemptsLeft < 3
          ? '<p class="desk-ceremony-attempts">' +
              Number(challenge.attemptsLeft) + ' attempt(s) left' +
            '</p>'
          : '') +
        '<p class="desk-ceremony-both">' +
          'Pairing is not complete until <em>they</em> have compared it too.' +
        '</p>' +
        '<div class="desk-ceremony-actions">' +
          // Cancel first in the DOM: it is the easy path, and it is what should
          // receive focus and Enter when someone is unsure.
          '<button type="button" class="desk-btn" data-desk-action="pair-cancel">Cancel</button>' +
          '<button type="button" class="desk-btn desk-btn-primary" data-desk-action="pair-verify">Verify</button>' +
        '</div>' +
      '</div>'
    );
  }

  /** The grant step. States the consequence, not the mechanism. */
  function renderGrantStep(peerId, verbs) {
    var known = [
      { id: 'status', on: true, text: 'see whether you are available — costs you nothing' },
      { id: 'locate', on: true, text: 'ask where a symbol lives and get a path and line back — no file contents, costs you nothing' },
    ];
    var granted = Array.isArray(verbs) ? verbs : null;

    return (
      '<div class="desk-grant">' +
        '<h3 class="desk-grant-title">Save pairing permissions</h3>' +
        '<p class="desk-grant-note">Status and scoped locate work through the Desk local commands on this computer. Workspace lookup requires an explicit sharing link and matching scope settings. Cross-machine requests, consultation, and review are not available.</p>' +
        '<div class="desk-grant-rows">' +
          known.map(function (v) {
            var on = granted ? granted.indexOf(v.id) !== -1 : v.on;
            return (
              '<label class="desk-grant-row">' +
                '<input type="checkbox" data-desk-verb="' + safe(v.id, 16) + '"' + (on ? ' checked' : '') + ' />' +
                '<span class="desk-grant-verb">' + safe(v.id, 16) + '</span>' +
                '<span class="desk-grant-text">' + safe(v.text, 200) + '</span>' +
              '</label>'
            );
          }).join('') +
        '</div>' +
        '<label class="desk-field">' +
          '<span class="desk-field-label">Name them (only you see this)</span>' +
          '<input type="text" class="desk-field-input" data-desk-field="alias" ' +
            'autocomplete="off" maxlength="32" placeholder="alice" />' +
        '</label>' +
        '<label class="desk-field">' +
          '<span class="desk-field-label">Same company as you?</span>' +
          '<input type="text" class="desk-field-input" data-desk-field="trustDomain" ' +
            'autocomplete="off" maxlength="32" placeholder="acme.com" />' +
        '</label>' +
        '<p class="desk-grant-note">' +
          'Pairing saves these permissions. It does not send code or start remote work.' +
        '</p>' +
        '<div class="desk-ceremony-actions" data-desk-peer="' + safe(peerId, 64) + '">' +
          '<button type="button" class="desk-btn" data-desk-action="pair-cancel">Cancel</button>' +
          '<button type="button" class="desk-btn desk-btn-primary" data-desk-action="pair-finish">Pair</button>' +
        '</div>' +
      '</div>'
    );
  }

  /** An invite, with its countdown. Not a credential — the copy says so. */
  function renderInvite(invite) {
    if (!invite || typeof invite !== 'object') { return ''; }
    var expired = invite.expiresInMs !== undefined && Number(invite.expiresInMs) <= 0;
    return (
      '<div class="desk-invite' + (expired ? ' desk-invite-expired' : '') + '">' +
        '<p class="desk-invite-label">Send this to your teammate:</p>' +
        '<code class="desk-invite-url">' + safe(invite.url, 400) + '</code>' +
        '<div class="desk-invite-actions">' +
          '<button type="button" class="desk-btn" data-desk-action="invite-copy">Copy</button>' +
          '<span class="desk-invite-expiry">' +
            (expired ? 'Expired — create a new one' : safe(invite.expiresLabel, 32)) +
          '</span>' +
        '</div>' +
        '<p class="desk-invite-note">' +
          'This link is not a password — it carries a public key, nothing secret. ' +
          'What stops an impostor is comparing the safety number, not keeping the link private.' +
        '</p>' +
      '</div>'
    );
  }

  // -------------------------------------------------------------------------
  // Wiring — only when a real document exists
  // -------------------------------------------------------------------------

  var api = {
    escapeHtml: escapeHtml,
    stripInvisible: stripInvisible,
    clamp: clamp,
    renderRail: renderRail,
    renderPeerRow: renderPeerRow,
    renderIdentity: renderIdentity,
    renderChallenge: renderChallenge,
    renderGrantStep: renderGrantStep,
    renderInvite: renderInvite,
  };

  if (typeof module !== 'undefined' && module.exports) {
    // Test context: export the real functions so the shipped file is what is
    // asserted, rather than a copy that drifts.
    module.exports = api;
    return;
  }

  if (typeof window === 'undefined' || typeof document === 'undefined') { return; }
  window.MystiDesk = api;

  var vscodeApi = null;
  function post(message) {
    try {
      if (!vscodeApi && typeof acquireVsCodeApi === 'function') { vscodeApi = acquireVsCodeApi(); }
    } catch (_e) { /* already acquired by chat.js; fall through to the shared one */ }
    if (!vscodeApi && window.__mystiVscodeApi) { vscodeApi = window.__mystiVscodeApi; }
    if (vscodeApi) { vscodeApi.postMessage(message); }
  }

  function mount() {
    var rail = document.getElementById('desk-rail');
    if (!rail) { return; }

    // Delegated, because rows are re-rendered wholesale. CSP forbids inline
    // handlers (script-src carries a nonce), so this is the only option anyway.
    rail.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || !target.getAttribute) { return; }
      var action = target.getAttribute('data-desk-action');
      if (!action) { return; }
      var peerId = target.getAttribute('data-desk-peer') || undefined;

      if (action === 'invite') { post({ type: 'deskCreateInvite' }); return; }
      if (action === 'revoke') { post({ type: 'deskRevoke', peerId: peerId }); return; }
      if (action === 'pair-cancel') { post({ type: 'deskPairCancel' }); return; }
      if (action === 'pair-verify') {
        var answers = [];
        var inputs = rail.querySelectorAll('.desk-answer-input');
        for (var i = 0; i < inputs.length; i++) { answers.push(inputs[i].value); }
        post({ type: 'deskPairVerify', answers: answers });
        return;
      }
      if (action === 'pair-finish') {
        var verbs = [];
        var boxes = rail.querySelectorAll('[data-desk-verb]');
        for (var j = 0; j < boxes.length; j++) {
          if (boxes[j].checked) { verbs.push(boxes[j].getAttribute('data-desk-verb')); }
        }
        var aliasEl = rail.querySelector('[data-desk-field="alias"]');
        var domainEl = rail.querySelector('[data-desk-field="trustDomain"]');
        post({
          type: 'deskPairFinish',
          alias: aliasEl ? aliasEl.value : '',
          trustDomain: domainEl ? domainEl.value : '',
          verbs: verbs,
        });
        return;
      }
    });

    window.addEventListener('message', function (event) {
      var msg = event && event.data;
      if (!msg || typeof msg.type !== 'string') { return; }
      if (msg.type === 'deskRosterUpdated') {
        rail.innerHTML = renderRail(msg.payload);
        rail.classList.toggle('hidden', !(msg.payload && msg.payload.enabled));
      } else if (msg.type === 'deskChallenge') {
        rail.innerHTML = renderChallenge(msg.payload);
      } else if (msg.type === 'deskGrantStep') {
        rail.innerHTML = renderGrantStep(msg.payload && msg.payload.peerId, msg.payload && msg.payload.verbs);
      } else if (msg.type === 'deskInvite') {
        rail.innerHTML = renderInvite(msg.payload);
      }
    });

    post({ type: 'deskRequestRoster' });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
