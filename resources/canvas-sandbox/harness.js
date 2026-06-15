/*
 * Mysti canvas sandbox — harness (Plan 05 M1).
 *
 * Runs LAST inside the page iframe. For `jsx` pages it compiles the embedded
 * `function Page()` source with Babel standalone and mounts it (with an error
 * boundary) into the page root; `html` pages are already in the DOM. Then it
 * tags elements with DOM-index `data-el` paths (for inline edit / overrides),
 * reports the content size to the parent, and reports render errors.
 *
 * Globals expected (loaded earlier as inlined scripts): React, ReactDOM, UI,
 * optionally Recharts, Babel. Communicates only via postMessage to the parent
 * (the iframe has no same-origin access).
 *
 * SPDX-License-Identifier: Apache-2.0
 */
(function () {
  var ROOT_ID = '__mysti_page';
  var JSX_ID = '__mysti_page_jsx';
  var React = window.React;

  function post(type, payload) {
    try { window.parent.postMessage(Object.assign({ source: 'mysti-canvas-page', type: type }, payload || {}), '*'); }
    catch (e) { /* sandboxed parent unreachable */ }
  }

  function reportError(message, stack) {
    post('page_render_error', { message: String(message || 'render error'), stack: stack ? String(stack) : undefined });
  }

  // Tag every element with a DOM index path ("0/2/1") for overrides / inline edit.
  function tagElements(root) {
    function walk(el, path) {
      el.setAttribute('data-el', path);
      var kids = el.children, i = 0;
      for (; i < kids.length; i++) { walk(kids[i], path === '' ? String(i) : path + '/' + i); }
    }
    var children = root.children, i = 0;
    for (; i < children.length; i++) { walk(children[i], String(i)); }
  }

  function reportSize(root) {
    var rect = root.getBoundingClientRect();
    post('page_size', { width: Math.round(rect.width), height: Math.round(root.scrollHeight) });
  }

  function ErrorBoundary() { /* defined below via React.Component */ }

  function buildErrorBoundary() {
    function EB(props) { React.Component.call(this, props); this.state = { error: null }; }
    EB.prototype = Object.create(React.Component.prototype);
    EB.prototype.constructor = EB;
    EB.getDerivedStateFromError = function (error) { return { error: error }; };
    EB.prototype.componentDidCatch = function (error) { reportError(error && error.message, error && error.stack); };
    EB.prototype.render = function () {
      if (this.state.error) {
        return React.createElement('div', { style: { padding: 24, color: 'var(--theme-color-error)', fontFamily: 'var(--theme-font-body)' } },
          React.createElement('strong', null, 'This page failed to render.'),
          React.createElement('pre', { style: { whiteSpace: 'pre-wrap', fontSize: 12, marginTop: 8 } }, String(this.state.error.message || this.state.error)));
      }
      return this.props.children;
    };
    return EB;
  }

  function mount(root, element) {
    if (ReactDOM.createRoot) { ReactDOM.createRoot(root).render(element); }
    else { ReactDOM.render(element, root); }
  }

  function settle(root) {
    // Tag + size after the first paint, and again on resize.
    requestAnimationFrame(function () { tagElements(root); reportSize(root); });
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { reportSize(root); });
      ro.observe(root);
    }
    post('page_ready', {});
  }

  function run() {
    var root = document.getElementById(ROOT_ID);
    if (!root) { reportError('page root missing'); return; }
    var mode = document.documentElement.getAttribute('data-mode');

    if (mode !== 'jsx') { settle(root); return; }

    var srcEl = document.getElementById(JSX_ID);
    var src = srcEl ? srcEl.textContent : '';
    if (!src || !window.Babel) { reportError(window.Babel ? 'empty page source' : 'Babel runtime missing'); return; }

    try {
      var compiled = window.Babel.transform(src, { presets: ['react'] }).code;
      var EB = buildErrorBoundary();
      // Provide React/UI/Recharts/ReactDOM in scope; return the Page component.
      var factory = new Function('React', 'UI', 'Recharts', 'ReactDOM',
        compiled + '\n; return typeof Page !== "undefined" ? Page : null;');
      var Page = factory(React, window.UI, window.Recharts, window.ReactDOM);
      if (typeof Page !== 'function') { reportError('page must define a function Page()'); return; }
      mount(root, React.createElement(EB, null, React.createElement(Page)));
      settle(root);
    } catch (e) {
      reportError(e && e.message, e && e.stack);
    }
  }

  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', run); }
  else { run(); }
})();
