/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Markdown and diagram rendering, independent of chat state and the host API.
 * Dependencies enter through create(); each instance owns its parser, lazy
 * script, pending renders and disposal. Rendered model content stays untrusted.
 */
(function(global) {
  'use strict';
  let instanceSequence = 0;

  /**
   * document owns the output; marked/sanitize are the supplied local libraries.
   * Mermaid is loaded from mermaidUri and obtained through getMermaid().
   * renderDiagrams resolves when the current batch settles, including failures.
   * The owner calls dispose() before abandoning the document; late work then
   * cannot update it. Calling renderMarkdown after disposal returns plain text.
   */
  function create(ports) {
    const document = ports.document;
    const logger = ports.logger || console;
    const instanceId = ++instanceSequence;
    const pending = new WeakMap();
    let sequence = 0;
    let disposed = false;
    let mermaidPromise = null;
    let loadingScript = null;
    let rejectLoading = null;
    const nextId = kind => kind + '-' + instanceId + '-' + (++sequence);
    const presentationClasses = new Set([
      'mermaid-diagram', 'mermaid-pending', 'file-edit-card', 'file-edit-header',
      'file-edit-icon', 'file-edit-filename', 'file-edit-path', 'file-edit-stats',
      'file-edit-additions', 'file-edit-deletions', 'file-edit-diff',
      'file-edit-diff-content', 'file-edit-line', 'file-edit-line-num',
      'file-edit-line-content', 'file-edit-proposal-more', 'addition', 'deletion', 'context',
    ]);

    let parser = null;
    let userParser = null;
    if (ports.marked) {
      const renderer = new ports.marked.Renderer();
      renderer.code = function(token, language) {
        const code = typeof token === 'object' ? token.text : token;
        const lang = typeof token === 'object' ? token.lang : language;
        if (lang === 'mermaid') {
          return '<div class="mermaid-diagram mermaid-pending">' + escapeHtmlForMarked(code) + '</div>';
        }
        if (lang === 'diff' || lang === 'patch' || (!lang && isDiffContentMarked(code))) {
          return formatDiffContentMarked(code);
        }
        const langClass = lang ? 'language-' + escapeHtmlForMarked(lang) : '';
        return '<pre><code class="' + langClass + '">' + escapeHtmlForMarked(code) + '</code></pre>';
      };
      // A private parser avoids changing Marked's global configuration.
      parser = new ports.marked.Marked({ gfm: true, breaks: true, renderer });
      // User messages can discuss literal tags or placeholders such as
      // <value>. Escape HTML tokens only, preserving code and link parsing.
      const userRenderer = new ports.marked.Renderer();
      userRenderer.code = renderer.code;
      userRenderer.html = function(token) {
        return escapeHtmlForMarked(typeof token === 'object' ? token.text : token);
      };
      userParser = new ports.marked.Marked({ gfm: true, breaks: true, renderer: userRenderer });
    }

    function plainText(value) {
      const element = document.createElement('div');
      element.textContent = String(value ?? '');
      return element.innerHTML;
    }

    function renderMarkdown(value, options) {
      const activeParser = options && options.literalHtml === true ? userParser : parser;
      if (disposed || !activeParser || typeof ports.sanitize !== 'function') {
        if (!disposed) { logger.warn('[Mysti] Markdown libraries unavailable — displaying plain text'); }
        return plainText(value);
      }
      try {
        // Model/tool content can imitate permission controls without executing
        // scripts. Keep those controls out even when the CSP already blocks
        // their network and script behavior; data attributes support code cards.
        const clean = ports.sanitize(activeParser.parse(String(value ?? '')), {
          ADD_ATTR: ['target', 'class', 'data-lang', 'data-file-path', 'data-full-diff'],
          ALLOW_DATA_ATTR: false,
          FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'iframe', 'object', 'embed', 'base', 'link', 'meta', 'style'],
          FORBID_ATTR: ['formaction', 'action', 'srcdoc', 'ping', 'id', 'name', 'style', 'tabindex'],
        });
        // Add our own copy affordance only after untrusted buttons have been
        // removed. Copy reads this code element's text, never model-supplied
        // attributes or an executable command.
        const output = document.createElement('div');
        output.innerHTML = clean;
        // Delegated chat actions also recognize spans/anchors by class or
        // data attribute. Model HTML must not impersonate those actions even
        // when it contains no scripts or buttons. Retain renderer presentation
        // classes and language hooks, never interactive application classes.
        for (const element of output.querySelectorAll('[class]')) {
          const classes = Array.from(element.classList).filter(name => presentationClasses.has(name)
            || (element.tagName === 'CODE' && /^language-[a-zA-Z0-9_+.-]+$/.test(name)));
          if (classes.length) element.setAttribute('class', classes.join(' '));
          else element.removeAttribute('class');
        }
        for (const code of output.querySelectorAll('pre > code')) {
          const pre = code.parentElement;
          const wrapper = document.createElement('div');
          wrapper.className = 'message-code-block';
          const copy = document.createElement('button');
          copy.type = 'button';
          copy.className = 'message-code-copy';
          copy.textContent = 'Copy code';
          copy.setAttribute('aria-label', 'Copy code');
          pre.replaceWith(wrapper);
          wrapper.append(copy, pre);
        }
        return output.innerHTML;
      } catch (error) {
        logger.warn('[Mysti] Markdown rendering failed — displaying plain text', error);
        return plainText(value);
      }
    }

    function loadMermaid() {
      if (disposed) { return Promise.reject(new Error('Markdown renderer is disposed')); }
      if (mermaidPromise) { return mermaidPromise; }
      const attempt = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        loadingScript = script;
        rejectLoading = reject;
        const finish = () => {
          script.onload = null;
          script.onerror = null;
          loadingScript = null;
          rejectLoading = null;
        };
        script.src = ports.mermaidUri;
        script.onload = () => {
          finish();
          try {
            const mermaid = ports.getMermaid();
            if (!mermaid || typeof mermaid.initialize !== 'function' || typeof mermaid.render !== 'function') {
              throw new Error('Mermaid did not initialize');
            }
            mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
            resolve(mermaid);
          } catch (error) { script.remove(); reject(error); }
        };
        script.onerror = () => {
          finish();
          script.remove();
          reject(new Error('Could not load Mermaid'));
        };
        document.head.appendChild(script);
      });
      mermaidPromise = attempt.catch(error => {
        mermaidPromise = null; // A later render may retry a transient load failure.
        throw error;
      });
      return mermaidPromise;
    }

    async function renderDiagrams(scope = document) {
      if (disposed) { return; }
      const tasks = [];
      for (const block of scope.querySelectorAll('.mermaid-pending')) {
        const source = block.textContent;
        const active = pending.get(block);
        if (active && active.source === source) { tasks.push(active.task); continue; }
        const request = { source, task: null };
        pending.set(block, request);
        const current = () => !disposed && block.isConnected && pending.get(block) === request && block.textContent === source;
        request.task = (async () => {
          let renderContainer = null;
          let rendering = false;
          try {
            const mermaid = await loadMermaid();
            if (!current()) { return; }
            // Mermaid leaves diagnostic SVGs in its render container when
            // parsing fails. Own that temporary DOM so failed, superseded and
            // detached renders cannot leak global error graphics.
            renderContainer = document.createElement('div');
            renderContainer.setAttribute('data-mysti-diagram-work', '');
            renderContainer.style.cssText = 'position:fixed;left:-10000px;top:0;pointer-events:none';
            document.body.appendChild(renderContainer);
            rendering = true;
            const result = await mermaid.render(nextId('mermaid'), source, renderContainer);
            if (!current()) { return; }
            block.innerHTML = result.svg;
            block.classList.remove('mermaid-pending', 'mermaid-error');
            block.classList.add('mermaid-rendered');
          } catch (error) {
            if (current()) {
              block.classList.add('mermaid-error');
              // A syntax failure is terminal for this source. A changed code
              // fence creates a fresh pending block; only library-load failures
              // should retry when another message is rendered.
              if (rendering) block.classList.remove('mermaid-pending');
              logger.error('[Mysti] Mermaid render failed', error);
            }
          } finally {
            if (renderContainer) renderContainer.remove();
            if (pending.get(block) === request) { pending.delete(block); }
          }
        })();
        tasks.push(request.task);
      }
      await Promise.all(tasks);
    }

    function dispose() {
      if (disposed) { return; }
      disposed = true;
      if (loadingScript) {
        loadingScript.onload = null;
        loadingScript.onerror = null;
        loadingScript.remove();
        loadingScript = null;
      }
      if (rejectLoading) { rejectLoading(new Error('Markdown renderer is disposed')); rejectLoading = null; }
    }

    function escapeHtmlForMarked(text) {
      if (!text) { return ''; }
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function isDiffContentMarked(content) {
      var lines = content.split('\n');
      var diffMarkers = 0;
      var checkLines = Math.min(lines.length, 20);
      for (var i = 0; i < checkLines; i++) {
        var line = lines[i];
        // Exclude CSS custom properties (--var) from diff detection
        if (line.startsWith('+') || (line.startsWith('-') && !line.startsWith('--')) || line.startsWith('@@')) {
          diffMarkers++;
        }
      }
      return diffMarkers > checkLines * 0.2;
    }

    function formatDiffContentMarked(content) {
      var lines = content.split('\n');
      var additions = 0;
      var deletions = 0;
      var fileName;
      var filePath = '';
      var diffLines = [];
      var lineNum = 1;
      var previewLimit = 10;
      var diffId = nextId('diff');

      // Parse diff and collect data
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];

        // Extract file path from diff headers
        if (line.startsWith('+++ b/')) {
          filePath = line.substring(6);
        } else if (line.startsWith('+++ ') && !filePath) {
          filePath = line.substring(4);
        } else if (line.startsWith('diff --git')) {
          var gitMatch = line.match(/b\/(.+)$/);
          if (gitMatch) { filePath = gitMatch[1]; }
        }

        // Skip header lines for display
        if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
          continue;
        }

        // Parse hunk header for line numbers
        if (line.startsWith('@@')) {
          var hunkMatch = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
          if (hunkMatch) { lineNum = parseInt(hunkMatch[1], 10); }
          continue;
        }

        var lineClass = 'file-edit-line';
        var lineNumDisplay;

        if (line.startsWith('+')) {
          lineClass += ' addition';
          additions++;
          lineNumDisplay = lineNum++;
        } else if (line.startsWith('-')) {
          lineClass += ' deletion';
          deletions++;
          lineNumDisplay = '';
        } else {
          lineClass += ' context';
          lineNumDisplay = lineNum++;
        }

        diffLines.push({
          cls: lineClass,
          num: lineNumDisplay,
          content: line.substring(1) || ' '
        });
      }

      // Extract filename from path
      if (!filePath) { filePath = 'changes'; }
      var pathParts = filePath.split('/');
      fileName = pathParts.pop() || filePath;
      var dirPath = pathParts.length > 0 ? pathParts.join('/') + '/' : '';

      // Build preview (first 10 lines)
      var hasMore = diffLines.length > previewLimit;
      var previewLines = hasMore ? diffLines.slice(0, previewLimit) : diffLines;
      var remainingCount = diffLines.length - previewLimit;

      var previewHtml = '';
      for (var j = 0; j < previewLines.length; j++) {
        var dl = previewLines[j];
        previewHtml += '<div class="' + dl.cls + '">' +
          '<span class="file-edit-line-num">' + (dl.num !== '' ? dl.num : '') + '</span>' +
          '<span class="file-edit-line-content">' + escapeHtmlForMarked(dl.content) + '</span>' +
        '</div>';
      }

      // Encode full diff data for expansion
      var fullDiffData = encodeURIComponent(JSON.stringify(diffLines));

      var remainingHtml = '';
      for (var k = previewLines.length; k < diffLines.length; k++) {
        var remaining = diffLines[k];
        remainingHtml += '<div class="' + remaining.cls + '">' +
          '<span class="file-edit-line-num">' + (remaining.num !== '' ? remaining.num : '') + '</span>' +
          '<span class="file-edit-line-content">' + escapeHtmlForMarked(remaining.content) + '</span></div>';
      }

      var html = '<div class="file-edit-card" id="' + diffId + '" data-file-path="' + escapeHtmlForMarked(filePath) + '" data-full-diff="' + fullDiffData + '">' +
        '<div class="file-edit-header">' +
          '<span class="file-edit-icon">📄</span>' +
          '<span class="file-edit-filename">' + escapeHtmlForMarked(fileName) + '</span>' +
          '<span class="file-edit-path">' + escapeHtmlForMarked(dirPath) + '</span>' +
          '<div class="file-edit-stats">' +
            (additions > 0 ? '<span class="file-edit-additions">+' + additions + '</span>' : '') +
            (deletions > 0 ? '<span class="file-edit-deletions">-' + deletions + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="file-edit-diff">' +
          '<div class="file-edit-diff-content">' + previewHtml + '</div>' +
          (hasMore ? '<details class="file-edit-proposal-more"><summary>Show more (' + remainingCount + ' lines)</summary>' +
            '<div class="file-edit-diff-content">' + remainingHtml + '</div></details>' : '') +
        '</div>' +
      '</div>';

      return html;
    }

    return Object.freeze({ renderMarkdown, renderDiagrams, dispose });
  }

  global.MystiMarkdownRenderer = Object.freeze({ create });
})(window);
