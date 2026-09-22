/**
 * Main chat tool cards. SPDX-License-Identifier: Apache-2.0
 *
 * An instance owns live tool input and card identity. Restored cards use the
 * same builder but never enter the live lookup, so reused IDs cannot mutate
 * history. Live frames are accepted only between begin() and end(). The host
 * owns message segments and edit/Todo side effects.
 */
(function(global) {
  'use strict';
  const STATUSES = new Set(['pending', 'running', 'completed', 'failed']);
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = value => typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  const status = (value, fallback) => STATUSES.has(value) ? value : fallback;
  function stringify(value) {
    try { return JSON.stringify(value || {}, null, 2) || ''; }
    catch (_error) { return '[Unserializable input]'; }
  }

  function create(ports) {
    const document = ports.document;
    const records = new Map();
    const cleanPathsInString = value => ports.cleanPathsInString(text(value));
    const makeRelativePath = value => ports.makeRelativePath(text(value));
    let disposed = false;
    let accepting = false;

    function formatToolSummary(toolCall) {
      if (!toolCall) { return ''; }
      var input = toolCall.input;
      if (!input) { return ''; }
      var name = text(toolCall.name).toLowerCase();

      // 1) Kind-first: provider-agnostic summaries from the semantic kind.
      //    Cases without a confident summary fall through to the raw-name
      //    switch below.
      switch (toolCall.kind) {
        case 'execute':
          if (input.description) { return cleanPathsInString(input.description); }
          if (input.command) { return cleanPathsInString(input.command); }
          break;
        case 'read':
        case 'edit':
        case 'delete': {
          var kindPath = input.file_path || input.notebook_path || input.path;
          if (kindPath) { return makeRelativePath(kindPath); }
          break;
        }
        case 'move': {
          var movePath = input.file_path || input.path || input.source || input.old_path;
          var moveDest = input.destination || input.new_path || input.newPath;
          if (movePath && moveDest) { return makeRelativePath(movePath) + ' \u2192 ' + makeRelativePath(moveDest); }
          if (movePath) { return makeRelativePath(movePath); }
          break;
        }
        case 'search': {
          var kindPattern = input.pattern || input.query || '';
          var kindDir = input.path ? makeRelativePath(input.path) : '';
          if (kindPattern && kindDir) { return kindPattern + ' in ' + kindDir; }
          if (kindPattern || kindDir) { return kindPattern || kindDir; }
          break;
        }
        case 'fetch':
          if (input.url) { return input.url; }
          if (input.query) { return input.query; }
          break;
        case 'think':
          if (input.todos && typeof input.todos.length === 'number') {
            return input.todos.length + ' item' + (input.todos.length !== 1 ? 's' : '');
          }
          break;
        default:
          // No kind (legacy persisted call) or 'other' — raw-name fallback.
          break;
      }

      // 2) Raw-name fallback (legacy tool calls without kind, and kinds
      //    whose inputs had no recognizable fields).
      switch (name) {
        case 'delegate': {
          // Mysti coordinator delegation card: "agent: task…" (P0.3 — was blank)
          var dTask = String(input.task || '');
          var dAgent = String(input.agent || '');
          if (dTask.length > 60) { dTask = dTask.substring(0, 60) + '...'; }
          return dAgent && dTask ? dAgent + ': ' + dTask : (dAgent || dTask);
        }
        case 'review': {
          // Cross-vendor review card (P2.1): "reviewer reviews writer"
          var rBy = String(input.reviewer || '');
          var rOf = String(input.of || '');
          return rBy && rOf ? rBy + ' reviews ' + rOf : (rBy || rOf);
        }
        case 'remember': {
          // Cross-backend memory card (P2.5)
          var fact = String(input.fact || '');
          return fact.length > 70 ? fact.substring(0, 70) + '...' : fact;
        }
        case 'diag':
          // Mysti local diagnostics tool
          return String(input.target || 'all');
        case 'ls':
          return makeRelativePath(input.path || '.');
        case 'bash':
          // Show description if available (often contains what the command does)
          // Otherwise show command with paths cleaned up
          if (input.description) {
            return cleanPathsInString(input.description);
          }
          return cleanPathsInString(input.command || '');
        case 'read':
          return makeRelativePath(input.file_path || input.path || '');
        case 'write':
          return makeRelativePath(input.file_path || input.path || '');
        case 'edit':
          return makeRelativePath(input.file_path || input.path || '');
        case 'notebookedit':
          return makeRelativePath(input.notebook_path || input.path || '');
        case 'glob':
          // Show pattern and relative path if specified
          var globPattern = input.pattern || '';
          var globPath = input.path ? makeRelativePath(input.path) : '';
          return globPath ? globPattern + ' in ' + globPath : globPattern;
        case 'grep':
          // Show pattern and relative path if specified
          var grepPattern = input.pattern || '';
          var grepPath = input.path ? makeRelativePath(input.path) : '';
          return grepPath ? grepPattern + ' in ' + grepPath : grepPattern;
        case 'webfetch':
          return input.url || '';
        case 'websearch':
          return input.query || '';
        case 'task':
          return input.description || input.prompt?.substring(0, 50) || '';
        case 'todowrite':
          var todos = input.todos || [];
          return todos.length + ' item' + (todos.length !== 1 ? 's' : '');
        default:
          // Try common field names - apply makeRelativePath to potential file paths
          var filePath = input.file_path || input.path || '';
          if (filePath) { return makeRelativePath(filePath); }
          return cleanPathsInString(input.command || '') || input.query || input.pattern || '';
      }
    }

    function summary(toolCall) {
      try { return text(formatToolSummary(toolCall)); }
      catch (_error) { return ''; }
    }
    function setStatus(record, value) {
      // Status values enter classes and labels through this closed vocabulary.
      for (const name of STATUSES) { record.element.classList.remove(name); }
      record.element.classList.add(value);
      record.status.className = 'tool-call-status ' + value;
      record.status.textContent = value;
    }
    function showOutput(record, output) {
      if (!output) { return; }
      const value = text(output);
      record.outputSection.style.display = 'block';
      record.output.textContent = value.substring(0, 1000) + (value.length > 1000 ? '...' : '');
    }
    function buildRecord(toolCall) {
      const tool = isRecord(toolCall) ? toolCall : {};
      const element = document.createElement('div');
      element.className = 'tool-call';
      element.dataset.id = text(tool.id);
      // Only constant markup enters innerHTML. All tool-controlled values use
      // textContent/dataset, including ID, name, summary, status and output.
      element.innerHTML =
        '<div class="tool-call-header">' +
          '<svg class="tool-call-spinner" viewBox="0 0 16 16" width="12" height="12"><circle cx="8" cy="8" r="6" stroke="var(--vscode-charts-blue)" stroke-width="2" fill="none" stroke-dasharray="28" stroke-dashoffset="8" stroke-linecap="round"/></svg>' +
          '<svg class="tool-call-chevron" viewBox="0 0 16 16" fill="currentColor" width="12" height="12"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>' +
          '<span class="tool-call-name"></span><span class="tool-call-summary"></span>' +
          '<span class="tool-call-status"></span>' +
          '<button class="tool-call-copy" title="Copy to clipboard"><svg class="tool-call-copy-icon" viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M4 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V2zm2-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H6zM2 5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1h1v1a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1v1H2z"/></svg></button>' +
        '</div>' +
        '<div class="tool-call-details"><div class="tool-call-section"><div class="tool-call-label">Input</div><pre class="tool-call-content"></pre></div>' +
          '<div class="tool-call-output-section" style="display:none;"><div class="tool-call-label">Output</div><pre class="tool-call-output-content"></pre></div>' +
        '</div>';
      const record = {
        element, name: text(tool.name), input: isRecord(tool.input) ? tool.input : {}, kind: tool.kind,
        status: element.querySelector('.tool-call-status'),
        inputContent: element.querySelector('.tool-call-content'),
        summary: element.querySelector('.tool-call-summary'),
        outputSection: element.querySelector('.tool-call-output-section'),
        output: element.querySelector('.tool-call-output-content'), terminal: false,
      };
      element.querySelector('.tool-call-name').textContent = record.name;
      record.inputContent.textContent = stringify(record.input);
      record.summary.textContent = element.dataset.summary = summary(tool);
      setStatus(record, status(tool.status, 'running'));
      if (tool.truncated) {
        const note = document.createElement('span');
        note.className = 'tool-call-note';
        note.title = 'Input/output were truncated for storage';
        note.textContent = 'truncated';
        record.status.before(note);
      }
      showOutput(record, tool.output);
      return record;
    }
    function current(record) {
      const messages = ports.getMessagesElement();
      return !!messages && messages.contains(record.element);
    }
    function use(toolCall) {
      if (disposed || !accepting || !isRecord(toolCall) || typeof toolCall.id !== 'string' || !toolCall.id) { return; }
      let record = records.get(toolCall.id);
      if (record && !current(record)) { records.delete(toolCall.id); record = undefined; }
      if (record) {
        // Providers may repeat an empty start frame after complete input. Keep
        // the last meaningful input so a subsequent result can render its diff.
        if (isRecord(toolCall.input) && Object.keys(toolCall.input).length) {
          record.input = toolCall.input;
          record.inputContent.textContent = stringify(toolCall.input);
        }
        if (toolCall.name) { record.name = text(toolCall.name); }
        if (toolCall.kind) { record.kind = toolCall.kind; }
        record.element.querySelector('.tool-call-name').textContent = record.name;
        record.summary.textContent = record.element.dataset.summary = summary({ name: record.name, input: record.input, kind: record.kind });
        return;
      }
      // The host advances the text-segment cursor exactly once per new card.
      const body = ports.getStreamingBody();
      if (!body) { return; }
      record = buildRecord(toolCall);
      records.set(toolCall.id, record);
      body.appendChild(record.element);
      ports.scroll();
    }
    function result(toolCall, acknowledgement) {
      if (disposed || (!accepting && !acknowledgement) || !isRecord(toolCall) || typeof toolCall.id !== 'string') { return; }
      const record = records.get(toolCall.id);
      if (!record || !current(record)) { records.delete(toolCall.id); return; }
      if (acknowledgement && record.name.toLowerCase().replace(/[^a-z]/g, '') !== 'askuserquestion') { return; }
      if (acknowledgement ? record.acknowledged : record.terminal) { return; }
      if (acknowledgement) { record.acknowledged = true; }
      const nextStatus = status(toolCall.status, 'failed');
      setStatus(record, nextStatus);
      showOutput(record, toolCall.output);
      record.terminal = nextStatus === 'completed' || nextStatus === 'failed';
      // Resolve all rendering before handing host side effects back. Repeated
      // terminal events never duplicate an edit report or Todo update.
      ports.onResult({ toolCall, element: record.element, name: record.name || text(toolCall.name), input: record.input });
    }
    function begin() {
      if (disposed) { return; }
      records.clear();
      accepting = true;
    }
    // Close live intake. Retain only this run's exact card references for an
    // explicit, once-only question acknowledgement after completion; reset or
    // the next begin forgets them, and ordinary late frames remain refused.
    function end() { accepting = false; }
    function reset() { end(); records.clear(); }
    function dispose() { if (!disposed) { disposed = true; reset(); } }
    return { build: toolCall => buildRecord(toolCall).element, summary, use,
      result: toolCall => result(toolCall, false), acknowledge: toolCall => result(toolCall, true),
      begin, end, reset, dispose };
  }
  global.MystiToolCards = Object.freeze({ create });
})(typeof window !== 'undefined' ? window : globalThis);
