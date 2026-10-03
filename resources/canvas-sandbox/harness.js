/*
 * Mysti canvas sandbox — harness (Plan 22 Phase 2: the DOC INTERPRETER).
 *
 * Runs LAST inside the page iframe (`sandbox="allow-scripts"`, no
 * `allow-same-origin`). It no longer compiles source: it INTERPRETS a `DocNode`
 * tree over the 22 `UI.*` primitives, which is what lets `babel.min.js`
 * (2,983,904 bytes) leave every frame — Babel is now injected only into a
 * `legacy` page's frame by `buildPageDocument`.
 *
 * ## Why this file changed shape
 *
 * The previous harness had NO `message` listener (only `DOMContentLoaded`), so
 * the shell physically could not talk into the page: click-to-select, inline
 * editing and live patching were all structurally impossible, and every change
 * meant rebuilding a 3.14 MB `srcdoc`. This version owns a dedicated
 * `MessageChannel` port handed in by the host on load:
 *
 *   down: mount {doc,themeTokens,format} | patch {ops} | select {mids}
 *         beginTextEdit {mid} | measure
 *   up:   ready | rects {mid->rect} | size {w,h} | hit {mid,rect,modifiers}
 *         textCommit {mid,text} | error {message,stack,mid}
 *
 * `patch` re-renders the EXISTING React root — never a remount — so React
 * reconciliation preserves scroll, focus, hover, input values and CSS
 * animation. That is the entire point of the port.
 *
 * ## Trust
 *
 * Everything here runs on MODEL-AUTHORED content, so:
 *  - the port is bound ONCE, and only from a message whose `ev.source` is the
 *    real parent window (`ev.source === window.parent && window.parent !==
 *    window`). A script inside this frame can only ever produce `ev.source ===
 *    window`, so it can neither hand itself a port nor steal the host's;
 *  - tags are allowlisted, props are JSON-shaped and URL-checked, styles are
 *    filtered, `dangerouslySetInnerHTML` and `on*` handlers are dropped, and no
 *    doc content is ever assigned to `innerHTML`;
 *  - everything posted UP is still untrusted from the host's point of view and
 *    is re-validated parent-side by `parseFrameUpMessage` in CanvasSandbox.ts.
 *
 * Globals expected (inlined earlier in <head>): React, ReactDOM, UI; Babel only
 * for `data-mode="jsx"` legacy pages.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
(function () {
  'use strict';

  var PROTOCOL = 1;
  var ROOT_ID = '__mysti_page';
  var JSX_ID = '__mysti_page_jsx';
  var DOC_ID = '__mysti_page_doc';
  var THEME_STYLE_ID = '__mysti_theme_tokens';
  var FORMAT_STYLE_ID = '__mysti_page_format';
  var HOST_SOURCE = 'mysti-canvas-host';
  var PAGE_SOURCE = 'mysti-canvas-page';

  // Caps: a hostile or runaway doc must not be able to hang the frame or flood
  // the port. Every limit fails CLOSED (truncate / drop) and never throws.
  var MAX_NODES = 20000;
  var MAX_DEPTH = 96;
  var MAX_PROPS = 96;
  var MAX_STYLE_PROPS = 120;
  var MAX_PROP_DEPTH = 8;
  var MAX_PROP_ITEMS = 500;
  var MAX_RECTS = 4000;
  var MAX_TEXT = 20000;
  var MAX_MESSAGE = 2000;
  // A page box outside this range is not a device: refuse it rather than lay
  // the document out at 0px or at a size that hangs layout.
  var MIN_FORMAT_PX = 16;
  var MAX_FORMAT_PX = 20000;

  var MID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  var STYLE_PROP_RE = /^-{0,2}[a-zA-Z][a-zA-Z0-9-]*$/;
  var TOKEN_NAME_RE = /^[a-z0-9-]{1,64}$/;
  var IDENT_RE = /^[A-Za-z_$][\w$]*$/;
  var CTRL_RE = /[\u0000-\u001F]/;
  var CSS_DANGER_RE = /(javascript\s*:|vbscript\s*:|expression\s*\(|@import|behaviou?r\s*:|-moz-binding)/i;
  var URL_OK_RE = /^(https:\/\/|blob:|vscode-webview:|vscode-resource:|#|\.{0,2}\/)/i;
  var DATA_IMG_RE = /^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml)[;,]/i;

  // Structural HTML allowlist. Anything not here renders as a visible
  // "unsupported element" box instead of silently becoming a live tag.
  var HTML_TAGS = {};
  (function (list) { for (var i = 0; i < list.length; i++) { HTML_TAGS[list[i]] = true; } })([
    'div', 'span', 'p', 'section', 'header', 'footer', 'nav', 'main', 'aside', 'article',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'a', 'img', 'button', 'input',
    'label', 'strong', 'em', 'small', 'hr', 'br', 'figure', 'figcaption', 'table', 'thead',
    'tbody', 'tfoot', 'tr', 'td', 'th', 'pre', 'code', 'blockquote'
  ]);
  var VOID_TAGS = { img: true, br: true, hr: true, input: true };
  // Props whose STRING value is fetched or navigated to. Deliberately NOT
  // `data`: that is `UI.Chart`'s series and `UI.TabBar`'s items, and treating a
  // structural prop as a URL silently blanks the chart. `<object data>` is not
  // reachable — `object` is not on the tag allowlist.
  var URL_PROPS = {
    src: true, href: true, poster: true, action: true, formAction: true, srcSet: true,
    background: true, cite: true, longDesc: true, manifest: true, profile: true,
    xlinkHref: true
  };
  var DROP_PROPS = {
    children: true, style: true, key: true, ref: true, dangerouslySetInnerHTML: true,
    innerHTML: true, outerHTML: true, srcDoc: true, srcdoc: true, is: true,
    contentEditable: true, contenteditable: true, suppressHydrationWarning: true
  };

  var state = {
    port: null,
    rootEl: null,
    reactRoot: null,
    errorBoundary: null,
    doc: null,
    selection: [],
    editing: null,
    mode: null,
    reportQueued: false,
    warned: {}
  };

  /* ------------------------------ transport ------------------------------ */

  /** Post up the port when bound; a no-op otherwise (standalone / export). */
  function up(msg) {
    if (!state.port) { return; }
    try { state.port.postMessage(msg); } catch (e) { /* port closed */ }
  }

  /**
   * Legacy window-channel notice, kept only so today's shell (which predates the
   * port) keeps seeing ready/size/error while the webview migrates. Carries no
   * state the port does not also carry.
   */
  function legacyPost(type, payload) {
    try {
      var body = { source: PAGE_SOURCE, type: type };
      if (payload) {
        for (var k in payload) {
          if (Object.prototype.hasOwnProperty.call(payload, k)) { body[k] = payload[k]; }
        }
      }
      window.parent.postMessage(body, '*');
    } catch (e) { /* parent unreachable */ }
  }

  function clampText(value, max) {
    var s = String(value == null ? '' : value);
    return s.length > max ? s.slice(0, max) : s;
  }

  function reportError(message, stack, mid) {
    var msg = { t: 'error', message: clampText(message || 'render error', MAX_MESSAGE) };
    if (stack) { msg.stack = clampText(stack, MAX_MESSAGE * 2); }
    if (mid && MID_RE.test(mid)) { msg.mid = mid; }
    up(msg);
    legacyPost('page_render_error', { message: msg.message, stack: msg.stack });
  }

  function warnOnce(key, message) {
    if (state.warned[key]) { return; }
    state.warned[key] = true;
    reportError(message);
  }

  /* ------------------------------ sanitizers ------------------------------ */

  /**
   * A data object: `{}`-shaped, at most one prototype level deep.
   *
   * NOT `proto === Object.prototype`: a structured-cloned message and a
   * cross-realm payload both carry a DIFFERENT `Object.prototype` object, and a
   * strict identity check would reject every real message. Accepting "prototype
   * is null, or a prototype whose own prototype is null" keeps out everything
   * that matters — arrays, `Date`/`Map`/`Error` instances, DOM nodes and
   * anything with a class in its chain — while working in any realm.
   */
  function isPlainObject(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) { return false; }
    var proto = Object.getPrototypeOf(v);
    if (proto === null) { return true; }
    return Object.getPrototypeOf(proto) === null;
  }

  /**
   * Own-property write that survives a hostile key.
   *
   * Tags, prop names, style properties, slot names and mids are all
   * MODEL-AUTHORED strings, and plain `obj[k] = v` with `k === '__proto__'`
   * invokes the prototype setter instead of creating a property — the value
   * vanishes from `Object.keys`, so the frame and the host silently disagree
   * about the document and the element becomes unselectable. Mirrors `putOwn`
   * in src/canvas/doc/DocNode.ts.
   */
  function putOwn(target, key, value) {
    Object.defineProperty(target, key, { value: value, enumerable: true, writable: true, configurable: true });
  }

  /** URL props: only relative / https / blob / webview refs and data: images. */
  function safeUrl(value) {
    if (typeof value !== 'string') { return undefined; }
    var v = value.trim();
    if (!v) { return undefined; }
    // Control characters are how "java\nscript:" slips past a naive prefix test.
    if (CTRL_RE.test(v)) { return undefined; }
    if (DATA_IMG_RE.test(v)) { return v; }
    if (URL_OK_RE.test(v)) { return v; }
    return undefined;
  }

  /** JSON-shaped values only: string, finite number, boolean, null, array, plain object. */
  function safeValue(value, depth) {
    if (value === null) { return null; }
    var type = typeof value;
    if (type === 'string') { return clampText(value, MAX_TEXT); }
    if (type === 'number') { return isFinite(value) ? value : undefined; }
    if (type === 'boolean') { return value; }
    if (depth >= MAX_PROP_DEPTH) { return undefined; }
    if (Array.isArray(value)) {
      var arr = [];
      for (var i = 0; i < value.length && arr.length < MAX_PROP_ITEMS; i++) {
        var item = safeValue(value[i], depth + 1);
        if (item !== undefined) { arr.push(item); }
      }
      return arr;
    }
    if (isPlainObject(value)) {
      var out = {};
      var n = 0;
      for (var k in value) {
        if (!Object.prototype.hasOwnProperty.call(value, k)) { continue; }
        if (n++ >= MAX_PROP_ITEMS) { break; }
        if (/^on/i.test(k) || Object.prototype.hasOwnProperty.call(DROP_PROPS, k)) { continue; }
        var sv = safeValue(value[k], depth + 1);
        if (sv !== undefined) { putOwn(out, k, sv); }
      }
      return out;
    }
    return undefined; // functions, Dates, Maps, DOM nodes, everything else
  }

  function sanitizeProps(raw) {
    var out = {};
    if (!isPlainObject(raw)) { return out; }
    var count = 0;
    for (var name in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, name)) { continue; }
      if (count >= MAX_PROPS) { break; }
      if (Object.prototype.hasOwnProperty.call(DROP_PROPS, name)) { continue; }
      if (/^on/i.test(name)) { continue; }               // no event handlers, ever
      if (name.indexOf('-') === -1 && !IDENT_RE.test(name)) { continue; }
      var value = safeValue(raw[name], 0);
      if (value === undefined) { continue; }
      // Only a STRING can be a URL; a structural value keeps the JSON path.
      if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(URL_PROPS, name)) {
        value = safeUrl(value);
        if (value === undefined) { continue; }
      }
      putOwn(out, name, value);
      count++;
    }
    return out;
  }

  function cssValueOk(value) {
    if (typeof value === 'number') { return isFinite(value); }
    if (typeof value !== 'string') { return false; }
    if (value.length > 512) { return false; }
    if (/[;{}<>]/.test(value)) { return false; }
    if (CSS_DANGER_RE.test(value)) { return false; }
    var urls = value.match(/url\(([^)]*)\)/gi);
    if (urls) {
      for (var i = 0; i < urls.length; i++) {
        var inner = urls[i]
          .replace(/^url\(\s*/i, '')
          .replace(/\s*\)$/, '')
          .replace(/^['"]|['"]$/g, '');
        if (safeUrl(inner) === undefined) { return false; }
      }
    }
    return true;
  }

  /** `background-color` -> `backgroundColor`; `--x` and `-webkit-x` kept verbatim. */
  function toCamel(prop) {
    if (prop.charAt(0) === '-') { return prop; }
    return prop.replace(/-([a-z0-9])/g, function (_m, c) { return c.toUpperCase(); });
  }

  function sanitizeStyle(raw) {
    var out = {};
    if (!isPlainObject(raw)) { return out; }
    var count = 0;
    for (var prop in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, prop)) { continue; }
      if (count >= MAX_STYLE_PROPS) { break; }
      if (!STYLE_PROP_RE.test(prop)) { continue; }
      var value = raw[prop];
      if (!cssValueOk(value)) { continue; }
      putOwn(out, toCamel(prop), value);
      count++;
    }
    return out;
  }

  /**
   * Normalize an incoming doc into the exact shape the renderer walks. Caps node
   * count and depth; drops anything that is not an object with a `tag`.
   */
  function sanitizeDoc(raw) {
    return sanitizeNode(raw, 0, { n: 0 });
  }

  function sanitizeNode(raw, depth, budget) {
    if (!isPlainObject(raw)) { return null; }
    if (depth > MAX_DEPTH || budget.n >= MAX_NODES) { return null; }
    if (typeof raw.tag !== 'string' || !raw.tag) { return null; }
    budget.n++;
    var node = { tag: raw.tag };
    if (typeof raw.mid === 'string' && MID_RE.test(raw.mid)) { node.mid = raw.mid; }
    if (isPlainObject(raw.props)) { node.props = raw.props; }
    if (isPlainObject(raw.style)) { node.style = raw.style; }
    if (typeof raw.text === 'string') { node.text = clampText(raw.text, MAX_TEXT); }
    if (Array.isArray(raw.children)) {
      var kids = [];
      for (var i = 0; i < raw.children.length; i++) {
        var kid = sanitizeNode(raw.children[i], depth + 1, budget);
        if (kid) { kids.push(kid); }
      }
      if (kids.length) { node.children = kids; }
    }
    if (isPlainObject(raw.slots)) {
      var slots = {};
      var any = false;
      for (var name in raw.slots) {
        if (!Object.prototype.hasOwnProperty.call(raw.slots, name)) { continue; }
        if (!IDENT_RE.test(name)) { continue; }
        var list = raw.slots[name];
        if (!Array.isArray(list)) { continue; }
        var items = [];
        for (var j = 0; j < list.length; j++) {
          var item = sanitizeNode(list[j], depth + 1, budget);
          if (item) { items.push(item); }
        }
        if (items.length) { putOwn(slots, name, items); any = true; }
      }
      if (any) { node.slots = slots; }
    }
    return node;
  }

  /* ----------------------------- theme tokens ----------------------------- */

  /**
   * Live theme swap without rebuilding the frame: rewrite one `<style>` holding
   * the `--theme-*` custom properties. Names and values are filtered so a
   * model-authored theme cannot close the rule and inject arbitrary CSS.
   */
  function applyThemeTokens(tokens) {
    if (!isPlainObject(tokens)) { return; }
    var lines = [];
    for (var name in tokens) {
      if (!Object.prototype.hasOwnProperty.call(tokens, name)) { continue; }
      if (!TOKEN_NAME_RE.test(name)) { continue; }
      var value = tokens[name];
      if (!cssValueOk(value)) { continue; }
      lines.push('--theme-' + name + ': ' + value + ';');
    }
    if (!lines.length) { return; }
    var el = document.getElementById(THEME_STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = THEME_STYLE_ID;
      (document.head || document.documentElement).appendChild(el);
    }
    el.textContent = ':root {\n  ' + lines.join('\n  ') + '\n}';
  }

  /* -------------------------------- format -------------------------------- */

  /**
   * Apply a device/format change WITHOUT rebuilding the frame.
   *
   * The page box exists in exactly one place: `buildBaseCss` bakes
   * `#__mysti_page { width: <format.width>px; min-height: <format.height>px }`
   * into the srcdoc at build time. Until this existed, the `format` the host
   * has always put on `mount` (and in the bootstrap JSON) was dead on arrival —
   * `format` occurred once in this whole file, in the protocol comment. Picking
   * "Mobile" resized the IFRAME ELEMENT around a document still laid out at
   * 1440px, so the human saw the top-left 390px crop of the desktop layout and
   * concluded the responsive design was broken, while the static preview tile
   * under the same artboard (which has no baked width) reflowed correctly —
   * two renderings of one artboard disagreeing on screen simultaneously.
   *
   * Written as its own appended `<style>` rather than by rewriting the base
   * sheet: same specificity, later in the document, so it wins — the same
   * mechanism {@link applyThemeTokens} already uses. Sizes are numbers only and
   * range-checked; the frame validates everything it is handed, whoever sent it.
   */
  function applyFormat(format) {
    if (!isPlainObject(format)) { return; }
    var w = formatPx(format.width);
    var h = formatPx(format.height);
    var decl = [];
    if (w !== null) { decl.push('width: ' + w + 'px;'); }
    if (h !== null) { decl.push('min-height: ' + h + 'px;'); }
    if (!decl.length) { return; }
    var el = document.getElementById(FORMAT_STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = FORMAT_STYLE_ID;
      (document.head || document.documentElement).appendChild(el);
    }
    el.textContent = '#' + ROOT_ID + ' {\n  ' + decl.join('\n  ') + '\n}';
  }

  function formatPx(value) {
    if (typeof value !== 'number' || !isFinite(value)) { return null; }
    var n = Math.round(value);
    if (n < MIN_FORMAT_PX || n > MAX_FORMAT_PX) { return null; }
    return n;
  }

  /** `theme.setToken` paths (`colors.primary`, `radii.md`) -> flat token names. */
  function applyThemeToken(path, value) {
    if (typeof path !== 'string') { return; }
    var flat = path
      .replace(/^colors\./, 'color-')
      .replace(/^radii\./, 'radius-')
      .replace(/^shadows\./, 'shadow-')
      .replace(/\./g, '-')
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase();
    var patch = {};
    putOwn(patch, flat, value);
    applyThemeTokens(patch);
  }

  /* --------------------------- op application ---------------------------- */

  /**
   * The frame's LOCAL projection of an op onto its copy of the doc. The host's
   * `DocPatch` stays the single authority: this exists only so a delta can
   * re-render the existing root instead of forcing a full `mount`. Anything it
   * cannot apply is reported up so the host can resync with a `mount` — it never
   * guesses.
   */
  function applyOps(ops) {
    if (!Array.isArray(ops)) { return false; }
    var missed = 0;
    var changed = false;
    for (var i = 0; i < ops.length; i++) {
      var res = applyOp(ops[i]);
      if (res === 'miss') { missed++; } else if (res === 'ok') { changed = true; }
    }
    if (missed) {
      reportError('patch could not be applied locally (' + missed + ' op(s)); resync needed');
    }
    return changed;
  }

  function applyOp(op) {
    if (!isPlainObject(op) || typeof op.op !== 'string') { return 'skip'; }
    switch (op.op) {
      case 'page.setDoc': {
        var next = sanitizeDoc(op.doc);
        if (!next) { return 'miss'; }
        state.doc = next;
        return 'ok';
      }
      case 'theme.setToken':
        applyThemeToken(op.path, op.value);
        return 'ok';
      case 'el.setText': {
        var tn = findNode(op.mid);
        if (!tn || typeof op.text !== 'string') { return 'miss'; }
        tn.text = clampText(op.text, MAX_TEXT);
        delete tn.children;
        return 'ok';
      }
      case 'el.setStyle': {
        var sn = findNode(op.mid);
        if (!sn || !isPlainObject(op.style)) { return 'miss'; }
        var style = copyRecord(sn.style);
        for (var k in op.style) {
          if (!Object.prototype.hasOwnProperty.call(op.style, k)) { continue; }
          if (op.style[k] === null) { delete style[k]; } else { putOwn(style, k, op.style[k]); }
        }
        sn.style = style;
        return 'ok';
      }
      case 'el.setProp': {
        var pn = findNode(op.mid);
        if (!pn || typeof op.name !== 'string') { return 'miss'; }
        var props = copyRecord(pn.props);
        if (op.value === null) { delete props[op.name]; } else { putOwn(props, op.name, op.value); }
        pn.props = props;
        return 'ok';
      }
      case 'el.insert': {
        var parent = findNode(op.parentMid);
        var node = sanitizeDoc(op.node);
        if (!parent || !node) { return 'miss'; }
        var list = listFor(parent, op.slot);
        var at = indexFor(list, op.before);
        // An anchor the host resolved and this frame cannot means the two docs
        // have already diverged. Appending would hide that; a miss asks for the
        // resync the port already knows how to serve.
        if (at < 0) { return 'miss'; }
        list.splice(at, 0, node);
        return 'ok';
      }
      case 'el.remove': {
        var loc = findLocation(op.mid);
        if (!loc) { return 'miss'; }
        loc.list.splice(loc.index, 1);
        return 'ok';
      }
      case 'el.move': {
        var from = findLocation(op.mid);
        var to = findNode(op.newParentMid);
        if (!from || !to) { return 'miss'; }
        var fromList = from.list;
        var fromIndex = from.index;
        var moved = fromList.splice(fromIndex, 1)[0];
        var dest = listFor(to, op.slot);
        var into;
        if (op.before === op.mid) {
          // "Before myself" — a drag that landed back on its own gap. The host
          // (`DocPatch._move`) reads that as "stay put" and keeps the node at
          // `Math.min(at.index, dest.length)`. This frame had already spliced
          // the node OUT, so `op.mid` was no longer findable in `dest` and the
          // node was APPENDED — silently, as 'ok', so no resync was requested
          // and every later `rects`/`hit` for that subtree was measured off a
          // layout the document does not contain.
          if (dest !== fromList) { fromList.splice(fromIndex, 0, moved); return 'miss'; }
          into = Math.min(fromIndex, dest.length);
        } else {
          into = indexFor(dest, op.before);
          if (into < 0) { fromList.splice(fromIndex, 0, moved); return 'miss'; }
        }
        dest.splice(into, 0, moved);
        return 'ok';
      }
      case 'el.replace': {
        var target = sanitizeDoc(op.node);
        if (!target) { return 'miss'; }
        if (state.doc && state.doc.mid === op.mid) { state.doc = target; return 'ok'; }
        var at = findLocation(op.mid);
        if (!at) { return 'miss'; }
        at.list.splice(at.index, 1, target);
        return 'ok';
      }
      default:
        // page.add / page.remove / theme.set / asset.add ... are board-scope:
        // not this frame's business, and not a miss.
        return 'skip';
    }
  }

  function copyRecord(src) {
    var out = {};
    if (!src) { return out; }
    for (var k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k)) { putOwn(out, k, src[k]); }
    }
    return out;
  }

  function listFor(parent, slot) {
    if (typeof slot === 'string' && slot && IDENT_RE.test(slot)) {
      if (!parent.slots) { parent.slots = {}; }
      if (!Array.isArray(parent.slots[slot])) { putOwn(parent.slots, slot, []); }
      return parent.slots[slot];
    }
    if (!Array.isArray(parent.children)) { parent.children = []; }
    return parent.children;
  }

  /**
   * Where an anchor-relative insertion lands, or `-1` when the anchor is not in
   * this list.
   *
   * It used to fall through to `list.length`, i.e. "append". That turns any
   * anchor mismatch into a silent divergence from the host's document, which is
   * the one outcome the port exists to avoid: the host's `_anchorIndex` THROWS
   * on an unfound anchor, so the frame appending where the host refused is a
   * disagreement neither side reports. Callers answer `-1` with 'miss', which
   * the host already knows how to resolve with a resync.
   */
  function indexFor(list, before) {
    if (before === 'end' || before == null) { return list.length; }
    for (var i = 0; i < list.length; i++) { if (list[i].mid === before) { return i; } }
    return -1;
  }

  function eachNode(node, visit) {
    if (!node) { return true; }
    if (visit(node) === false) { return false; }
    var kids = node.children || [];
    for (var i = 0; i < kids.length; i++) {
      if (eachNode(kids[i], visit) === false) { return false; }
    }
    if (node.slots) {
      for (var s in node.slots) {
        if (!Object.prototype.hasOwnProperty.call(node.slots, s)) { continue; }
        var list = node.slots[s];
        for (var j = 0; j < list.length; j++) {
          if (eachNode(list[j], visit) === false) { return false; }
        }
      }
    }
    return true;
  }

  function findNode(mid) {
    if (typeof mid !== 'string') { return null; }
    var found = null;
    eachNode(state.doc, function (n) {
      if (n.mid === mid) { found = n; return false; }
      return true;
    });
    return found;
  }

  /** The list + index holding `mid`, so remove/move/replace are plain splices. */
  function findLocation(mid) {
    if (typeof mid !== 'string') { return null; }
    var found = null;
    eachNode(state.doc, function (n) {
      var lists = [];
      if (Array.isArray(n.children)) { lists.push(n.children); }
      if (n.slots) {
        for (var s in n.slots) {
          if (Object.prototype.hasOwnProperty.call(n.slots, s)) { lists.push(n.slots[s]); }
        }
      }
      for (var i = 0; i < lists.length; i++) {
        for (var j = 0; j < lists[i].length; j++) {
          if (lists[i][j].mid === mid) { found = { list: lists[i], index: j }; return false; }
        }
      }
      return true;
    });
    return found;
  }

  /* ------------------------------- renderer ------------------------------- */

  function unknownElement(React, tag, mid) {
    warnOnce('tag:' + tag, 'unsupported element: ' + clampText(tag, 120));
    var props = {
      key: mid || tag,
      style: {
        display: 'inline-block', padding: '6px 10px',
        border: '1px dashed var(--theme-color-error, #c00)', borderRadius: 4,
        color: 'var(--theme-color-error, #c00)', fontSize: 12, fontFamily: 'monospace'
      }
    };
    if (mid) { props['data-mid'] = mid; }
    return React.createElement('div', props, 'unsupported element: ' + tag);
  }

  function renderChildren(React, node) {
    if (node.children && node.children.length) {
      var out = [];
      for (var i = 0; i < node.children.length; i++) {
        var el = renderNode(React, node.children[i], 'c' + i);
        if (el !== null) { out.push(el); }
      }
      return out.length ? out : null;
    }
    if (typeof node.text === 'string' && node.text.length) { return node.text; }
    return null;
  }

  function renderSlots(React, node, props) {
    if (!node.slots) { return; }
    for (var name in node.slots) {
      if (!Object.prototype.hasOwnProperty.call(node.slots, name)) { continue; }
      var list = node.slots[name];
      var rendered = [];
      for (var i = 0; i < list.length; i++) {
        var el = renderNode(React, list[i], name + i);
        if (el !== null) { rendered.push(el); }
      }
      // An EMPTY slot must stay absent: the primitives branch on truthiness
      // (`p.sidebar && ...`) and `[]` is truthy, so an empty array would render
      // an empty grid area instead of collapsing it.
      if (!rendered.length) { continue; }
      putOwn(props, name, rendered.length === 1 ? rendered[0] : rendered);
    }
  }

  function renderNode(React, node, keyHint) {
    if (!node) { return null; }
    var mid = typeof node.mid === 'string' && MID_RE.test(node.mid) ? node.mid : null;
    var key = mid || keyHint || node.tag;
    var props = sanitizeProps(node.props);
    props.style = sanitizeStyle(node.style);
    props.key = key;
    renderSlots(React, node, props);

    if (node.tag.indexOf('UI.') === 0) {
      var UI = window.UI || {};
      var Component = UI[node.tag.slice(3)];
      if (typeof Component !== 'function') { return unknownElement(React, node.tag, mid); }
      var kids = renderChildren(React, node);
      var element = kids === null
        ? React.createElement(Component, props)
        : React.createElement(Component, props, kids);
      // The primitives do not spread unknown props onto their DOM node, so a
      // `data-mid` passed to `UI.Card` would simply vanish. A `display:contents`
      // wrapper carries the id with NO box of its own, so flex/grid layout is
      // identical to the unwrapped tree. `measuredEl()` reads geometry off the
      // wrapper's single element child (every primitive renders exactly one
      // root element).
      var wrapProps = { key: key, style: { display: 'contents' }, 'data-mid-wrap': '1' };
      if (mid) { wrapProps['data-mid'] = mid; }
      return React.createElement('div', wrapProps, element);
    }

    if (!Object.prototype.hasOwnProperty.call(HTML_TAGS, node.tag)) {
      return unknownElement(React, node.tag, mid);
    }
    if (mid) { props['data-mid'] = mid; }
    if (Object.prototype.hasOwnProperty.call(VOID_TAGS, node.tag)) {
      return React.createElement(node.tag, props);
    }
    var htmlKids = renderChildren(React, node);
    return htmlKids === null
      ? React.createElement(node.tag, props)
      : React.createElement(node.tag, props, htmlKids);
  }

  function buildErrorBoundary(React) {
    function EB(props) { React.Component.call(this, props); this.state = { error: null }; }
    EB.prototype = Object.create(React.Component.prototype);
    EB.prototype.constructor = EB;
    EB.getDerivedStateFromError = function (error) { return { error: error }; };
    EB.prototype.componentDidCatch = function (error) {
      reportError(error && error.message, error && error.stack);
    };
    EB.prototype.render = function () {
      if (this.state.error) {
        return React.createElement('div', {
          style: { padding: 24, color: 'var(--theme-color-error)', fontFamily: 'var(--theme-font-body)' }
        },
          React.createElement('strong', null, 'This page failed to render.'),
          React.createElement('pre', { style: { whiteSpace: 'pre-wrap', fontSize: 12, marginTop: 8 } },
            String((this.state.error && this.state.error.message) || this.state.error)));
      }
      return this.props.children;
    };
    return EB;
  }

  function createRoot(el) {
    var ReactDOM = window.ReactDOM;
    if (ReactDOM.createRoot) { return ReactDOM.createRoot(el); }
    return { render: function (tree) { ReactDOM.render(tree, el); } };
  }

  /**
   * Render the current doc. Creates the React root at most ONCE for the frame's
   * lifetime; every later call re-renders it, so reconciliation preserves
   * scroll, focus, hover, input values and CSS animation. A `patch` must never
   * remount — that is the whole reason the port exists.
   */
  function render() {
    var React = window.React;
    if (!React || !window.ReactDOM) { reportError('React runtime missing'); return; }
    if (!state.rootEl) { reportError('page root missing'); return; }
    var element = state.doc ? renderNode(React, state.doc, 'root') : null;
    if (!state.errorBoundary) { state.errorBoundary = buildErrorBoundary(React); }
    var tree = React.createElement(state.errorBoundary, null, element);
    if (!state.reactRoot) { state.reactRoot = createRoot(state.rootEl); }
    state.reactRoot.render(tree);
    scheduleReport();
  }

  /* ------------------------------- geometry ------------------------------- */

  /** The element whose box represents a mid (see the `display:contents` note). */
  function measuredEl(el) {
    if (el && el.getAttribute && el.getAttribute('data-mid-wrap') === '1' && el.firstElementChild) {
      return el.firstElementChild;
    }
    return el;
  }

  function domForMid(mid) {
    if (!state.rootEl || typeof mid !== 'string' || !MID_RE.test(mid)) { return null; }
    if (state.rootEl.getAttribute && state.rootEl.getAttribute('data-mid') === mid) { return state.rootEl; }
    return state.rootEl.querySelector('[data-mid="' + mid + '"]');
  }

  function round(n) { return Math.round(n * 100) / 100; }

  function rectOf(el, base) {
    var r = measuredEl(el).getBoundingClientRect();
    return {
      x: round(r.left - base.left),
      y: round(r.top - base.top),
      w: round(r.width),
      h: round(r.height)
    };
  }

  /**
   * Every mid's box, in PAGE coordinates (the parent applies the board
   * transform). Emits x/y/w/h and nothing else — no text, no attributes, no
   * computed styles — so the geometry channel cannot become an exfil channel.
   */
  function collectRects(only) {
    var out = {};
    if (!state.rootEl) { return out; }
    var base = state.rootEl.getBoundingClientRect();
    if (only && only.length) {
      for (var i = 0; i < only.length && i < MAX_RECTS; i++) {
        var one = domForMid(only[i]);
        if (one) { putOwn(out, only[i], rectOf(one, base)); }
      }
      return out;
    }
    var nodes = state.rootEl.querySelectorAll('[data-mid]');
    var limit = Math.min(nodes.length, MAX_RECTS);
    for (var j = 0; j < limit; j++) {
      var el = nodes[j];
      var mid = el.getAttribute('data-mid');
      if (!mid || !MID_RE.test(mid)) { continue; }
      putOwn(out, mid, rectOf(el, base));
    }
    return out;
  }

  function reportSize() {
    if (!state.rootEl) { return; }
    var rect = state.rootEl.getBoundingClientRect();
    var w = Math.round(rect.width);
    var h = Math.round(state.rootEl.scrollHeight || rect.height);
    up({ t: 'size', w: w, h: h });
    legacyPost('page_size', { width: w, height: h });
  }

  function reportRects(only) {
    up({ t: 'rects', rects: collectRects(only) });
  }

  /** Coalesce geometry reporting to one frame — patches can arrive in bursts. */
  function scheduleReport() {
    if (state.reportQueued) { return; }
    state.reportQueued = true;
    var run = function () {
      state.reportQueued = false;
      reportSize();
      reportRects();
    };
    if (window.requestAnimationFrame) { window.requestAnimationFrame(run); }
    else { window.setTimeout(run, 16); }
  }

  /* ----------------------------- interaction ----------------------------- */

  function closestMid(el) {
    var node = el;
    while (node) {
      if (node.hasAttribute && node.hasAttribute('data-mid')) { return node; }
      if (node === state.rootEl) { return null; }
      node = node.parentElement;
    }
    return null;
  }

  function onClick(ev) {
    // While inline-editing, clicks inside the edited node must place the caret.
    if (state.editing && state.editing.el && state.editing.el.contains
      && state.editing.el.contains(ev.target)) { return; }
    // The design is a picture, not an app: no navigation, no submits, no focus
    // stealing. Selection is the only meaning a click has.
    if (ev.preventDefault) { ev.preventDefault(); }
    if (ev.stopPropagation) { ev.stopPropagation(); }
    endTextEdit(true);
    var hit = closestMid(ev.target);
    if (!hit || !state.rootEl) { return; }
    var mid = hit.getAttribute('data-mid');
    if (!mid || !MID_RE.test(mid)) { return; }
    up({
      t: 'hit',
      mid: mid,
      rect: rectOf(hit, state.rootEl.getBoundingClientRect()),
      modifiers: {
        alt: !!ev.altKey, ctrl: !!ev.ctrlKey, meta: !!ev.metaKey, shift: !!ev.shiftKey
      },
      double: (ev.detail || 0) >= 2
    });
  }

  function beginTextEdit(mid) {
    endTextEdit(true);
    var host = domForMid(mid);
    if (!host) { reportError('cannot edit: element not rendered', undefined, mid); return; }
    var el = measuredEl(host);
    if (!el || !el.setAttribute) { reportError('cannot edit: no editable box', undefined, mid); return; }
    el.setAttribute('contenteditable', 'plaintext-only');
    el.setAttribute('spellcheck', 'false');
    state.editing = { mid: mid, el: el, original: el.textContent };
    try { if (el.focus) { el.focus(); } } catch (e) { /* not focusable */ }
    try {
      var sel = window.getSelection && window.getSelection();
      if (sel && document.createRange) {
        var range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch (e) { /* selection unavailable */ }
  }

  /**
   * `commit=false` restores the pre-edit text (Escape). `commit=true` posts
   * `textCommit` AND still restores — the doc is not the frame's to mutate; the
   * host applies `el.setText` and sends the change back down as a patch.
   */
  function endTextEdit(commit) {
    var editing = state.editing;
    if (!editing) { return; }
    state.editing = null;
    var el = editing.el;
    var text = el && typeof el.textContent === 'string' ? el.textContent : '';
    if (el && el.removeAttribute) {
      el.removeAttribute('contenteditable');
      el.removeAttribute('spellcheck');
    }
    if (el && text !== editing.original) { el.textContent = editing.original; }
    if (!commit || text === editing.original) { return; }
    up({ t: 'textCommit', mid: editing.mid, text: clampText(text, MAX_TEXT) });
  }

  function onKeyDown(ev) {
    if (!state.editing) { return; }
    if (ev.key === 'Escape') {
      if (ev.preventDefault) { ev.preventDefault(); }
      endTextEdit(false);
      return;
    }
    if (ev.key === 'Enter' && !ev.shiftKey) {
      if (ev.preventDefault) { ev.preventDefault(); }
      endTextEdit(true);
    }
  }

  function onFocusOut(ev) {
    if (state.editing && ev.target === state.editing.el) { endTextEdit(true); }
  }

  function onPreventDefault(ev) {
    if (ev.preventDefault) { ev.preventDefault(); }
  }

  /* --------------------------------- port --------------------------------- */

  function handleDown(msg) {
    if (!isPlainObject(msg) || typeof msg.t !== 'string') { return; }
    switch (msg.t) {
      case 'mount': {
        // A `mount` with NO `doc` is a theme/device update, not a document
        // replacement: the tree is already current, so the edit in flight is
        // none of its business. Ending it here reverted the characters the
        // human had just typed and posted no `textCommit`, so an agent's
        // `theme.set` silently ate them.
        var replacing = msg.doc !== undefined && msg.doc !== null;
        if (replacing) { endTextEdit(false); }
        if (msg.themeTokens) { applyThemeTokens(msg.themeTokens); }
        // A device change arrives as a re-`mount` down the EXISTING port, so
        // the frame outlives the resize exactly as it outlives an edit.
        if (msg.format) { applyFormat(msg.format); }
        if (!replacing) { return; }
        var doc = sanitizeDoc(msg.doc);
        if (!doc) { reportError('mount rejected: doc is not a DocNode tree'); return; }
        state.doc = doc;
        state.mode = 'doc';
        render();
        return;
      }
      case 'patch': {
        if (!state.doc) { reportError('patch before mount'); return; }
        if (applyOps(msg.ops)) { render(); } else { scheduleReport(); }
        return;
      }
      case 'select': {
        var mids = [];
        if (Array.isArray(msg.mids)) {
          for (var i = 0; i < msg.mids.length && i < MAX_RECTS; i++) {
            if (typeof msg.mids[i] === 'string' && MID_RE.test(msg.mids[i])) { mids.push(msg.mids[i]); }
          }
        }
        state.selection = mids;
        // The PARENT draws selection chrome from these rects; nothing is drawn
        // in-frame, so an overlay cannot be spoofed by page content.
        reportRects(mids);
        return;
      }
      case 'beginTextEdit':
        beginTextEdit(msg.mid);
        return;
      case 'measure':
        reportSize();
        reportRects();
        return;
      default:
        return;
    }
  }

  function bindPort(port) {
    state.port = port;
    port.onmessage = function (ev) {
      try { handleDown(ev && ev.data); }
      catch (e) { reportError(e && e.message, e && e.stack); }
    };
    if (port.start) { port.start(); }
    up({ t: 'ready', protocol: PROTOCOL });
    if (state.rootEl) { scheduleReport(); }
  }

  function onWindowMessage(ev) {
    var data = ev && ev.data;
    if (!isPlainObject(data)) { return; }
    if (data.source !== HOST_SOURCE || data.t !== 'port') { return; }
    if (state.port) { return; }                    // bind ONCE — no rebinding
    // A script inside this frame can only ever produce `ev.source === window`;
    // only the real parent can be `window.parent`. This is what makes the port
    // unstealable by model-authored page content.
    if (window.parent === window || ev.source !== window.parent) { return; }
    var port = ev.ports && ev.ports[0];
    if (!port) { return; }
    bindPort(port);
  }

  /* ------------------------------- bootstrap ------------------------------- */

  function readBootstrapDoc() {
    var el = document.getElementById(DOC_ID);
    if (!el) { return null; }
    try { return JSON.parse(el.textContent || 'null'); }
    catch (e) { reportError('bootstrap doc is not valid JSON'); return null; }
  }

  /** Legacy escape hatch: a page that would not compile into a DocNode tree. */
  function runLegacyJsx() {
    var React = window.React;
    if (!React || !window.ReactDOM) { reportError('React runtime missing'); return; }
    var srcEl = document.getElementById(JSX_ID);
    var src = srcEl ? srcEl.textContent : '';
    if (!src) { reportError('empty page source'); return; }
    if (!window.Babel) { reportError('Babel runtime missing (legacy page)'); return; }
    try {
      var compiled = window.Babel.transform(src, { presets: ['react'] }).code;
      var factory = new Function('React', 'UI', 'Recharts', 'ReactDOM',
        compiled + '\n; return typeof Page !== "undefined" ? Page : null;');
      var Page = factory(React, window.UI, window.Recharts, window.ReactDOM);
      if (typeof Page !== 'function') { reportError('page must define a function Page()'); return; }
      if (!state.errorBoundary) { state.errorBoundary = buildErrorBoundary(React); }
      if (!state.reactRoot) { state.reactRoot = createRoot(state.rootEl); }
      state.reactRoot.render(React.createElement(state.errorBoundary, null, React.createElement(Page)));
      scheduleReport();
    } catch (e) {
      reportError(e && e.message, e && e.stack);
    }
  }

  function observe() {
    if (!window.ResizeObserver || !state.rootEl) { return; }
    try {
      var ro = new window.ResizeObserver(function () { scheduleReport(); });
      ro.observe(state.rootEl);
    } catch (e) { /* observer unavailable */ }
  }

  function run() {
    state.rootEl = document.getElementById(ROOT_ID);
    if (!state.rootEl) { reportError('page root missing'); return; }
    state.mode = document.documentElement ? document.documentElement.getAttribute('data-mode') : null;

    document.addEventListener('click', onClick, true);

  /*
   * Forward wheels to the board.
   *
   * An iframe swallows wheel events — they go to THIS document, and the parent
   * (a different, opaque origin) cannot listen inside it. So with the cursor
   * over any artboard, the board's zoom and pan stopped responding entirely.
   * The page itself has nothing to scroll (it is a fixed-size design surface),
   * so the event belongs to the board in every case.
   *
   * `passive: false` is required to preventDefault; without it Chromium ignores
   * the call and the webview scrolls behind the board.
   */
  document.addEventListener('wheel', function (ev) {
    try {
      ev.preventDefault();
      post({
        t: 'wheel',
        deltaX: ev.deltaX, deltaY: ev.deltaY, deltaMode: ev.deltaMode,
        ctrlKey: !!ev.ctrlKey, metaKey: !!ev.metaKey,
        x: ev.clientX, y: ev.clientY,
      });
    } catch (_) { /* never let input handling break the page */ }
  }, { passive: false, capture: true });
    document.addEventListener('auxclick', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('submit', onPreventDefault, true);
    document.addEventListener('dragstart', onPreventDefault, true);

    if (state.mode === 'doc') {
      var boot = readBootstrapDoc();
      if (boot && boot.themeTokens) { applyThemeTokens(boot.themeTokens); }
      // Redundant with `buildBaseCss` (both come from the same format) and kept
      // deliberately: the two entry points must not be able to disagree about
      // where the page box comes from.
      if (boot && boot.format) { applyFormat(boot.format); }
      // Bootstrap render so export bundles, PNG capture and standalone previews
      // (no host, therefore no port) still show the page.
      var doc = boot ? sanitizeDoc(boot.doc) : null;
      if (doc) { state.doc = doc; render(); }
    } else if (state.mode === 'jsx') {
      runLegacyJsx();
    } else {
      scheduleReport();
    }

    observe();
    legacyPost('page_ready', {});
  }

  window.addEventListener('message', onWindowMessage);
  window.addEventListener('error', function (ev) {
    reportError((ev && ev.message) || 'script error', ev && ev.error && ev.error.stack);
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var reason = ev && ev.reason;
    reportError((reason && reason.message) || 'unhandled rejection', reason && reason.stack);
  });
  // Announce readiness for a port; a host may also simply act on iframe load.
  legacyPost('frame_hello', { protocol: PROTOCOL });

  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', run); }
  else { run(); }
})();
