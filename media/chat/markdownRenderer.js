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

    let parser = null;
    if (ports.marked) {
      const renderer = new ports.marked.Renderer();
      renderer.code = function(token, language) {
        const code = typeof token === 'object' ? token.text : token;
        const lang = typeof token === 'object' ? token.lang : language;
        if (lang === 'mermaid') {
          return '<div class="mermaid-diagram mermaid-pending">' + escapeHtmlForMarked(code) + '</div>';
        }
        if (lang === 'diff' || lang === 'patch' || isDiffContentMarked(code)) {
          return formatDiffContentMarked(code);
        }
        const langClass = lang ? 'language-' + escapeHtmlForMarked(lang) : '';
        return '<pre><code class="' + langClass + '">' + escapeHtmlForMarked(code) + '</code></pre>';
      };
      // A private parser avoids changing Marked's global configuration.
      parser = new ports.marked.Marked({ gfm: true, breaks: true, renderer });
    }

    function plainText(value) {
      const element = document.createElement('div');
      element.textContent = String(value ?? '');
      return element.innerHTML;
    }

    function renderMarkdown(value) {
      if (disposed || !parser || typeof ports.sanitize !== 'function') {
        if (!disposed) { logger.warn('[Mysti] Markdown libraries unavailable — displaying plain text'); }
        return plainText(value);
      }
      try {
        // Model/tool content can imitate permission controls without executing
        // scripts. Keep those controls out even when the CSP already blocks
        // their network and script behavior; data attributes support code cards.
        return ports.sanitize(parser.parse(String(value ?? '')), {
          ADD_ATTR: ['target', 'class', 'data-lang'],
          FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'iframe', 'object', 'embed', 'base', 'link', 'meta', 'style'],
          FORBID_ATTR: ['formaction', 'action', 'srcdoc', 'ping'],
        });
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
          try {
            const mermaid = await loadMermaid();
            if (!current()) { return; }
            const result = await mermaid.render(nextId('mermaid'), source);
            if (!current()) { return; }
            block.innerHTML = result.svg;
            block.classList.remove('mermaid-pending', 'mermaid-error');
            block.classList.add('mermaid-rendered');
          } catch (error) {
            if (current()) {
              block.classList.add('mermaid-error');
              logger.error('[Mysti] Mermaid render failed', error);
            }
          } finally {
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
      var fileName = '';
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
        var lineNumDisplay = '';

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

      // Chevron SVG
      var chevronSvg = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M4 6l4 4 4-4"/></svg>';

      var html = '<div class="file-edit-card" id="' + diffId + '" data-file-path="' + escapeHtmlForMarked(filePath) + '" data-full-diff="' + fullDiffData + '">' +
        '<div class="file-edit-header">' +
          '<span class="file-edit-icon">📄</span>' +
          '<span class="file-edit-filename">' + escapeHtmlForMarked(fileName) + '</span>' +
          '<span class="file-edit-path">' + escapeHtmlForMarked(dirPath) + '</span>' +
          '<div class="file-edit-stats">' +
            (additions > 0 ? '<span class="file-edit-additions">+' + additions + '</span>' : '') +
            (deletions > 0 ? '<span class="file-edit-deletions">-' + deletions + '</span>' : '') +
          '</div>' +
          '<button class="file-edit-collapse-btn" title="Toggle">' + chevronSvg + '</button>' +
        '</div>' +
        '<div class="file-edit-diff">' +
          '<div class="file-edit-diff-content">' + previewHtml + '</div>' +
          (hasMore ? '<button class="file-edit-show-more">Show more... (' + remainingCount + ' lines)</button>' : '') +
        '</div>' +
        '<div class="file-edit-actions">' +
          '<button class="file-edit-btn file-edit-revert">Revert</button>' +
          '<button class="file-edit-btn file-edit-review">Review</button>' +
        '</div>' +
      '</div>';

      return html;
    }

    return Object.freeze({ renderMarkdown, renderDiagrams, dispose });
  }

  global.MystiMarkdownRenderer = Object.freeze({ create });
})(window);
