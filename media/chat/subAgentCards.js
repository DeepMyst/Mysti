/**
 * Mysti - AI Coding Agent. SPDX-License-Identifier: Apache-2.0
 *
 * Mention sub-agent cards. Each instance owns its cards, output buffers, tools,
 * questions and timers. The host still owns execution and question authority.
 * Rendering, transport and clocks enter through create(); no chat state is read.
 */
(function(global) {
  'use strict';
  let instanceSequence = 0;

  function create(ports) {
    const document = ports.document;
    const records = new Map();
    const instanceId = ++instanceSequence;
    const schedule = ports.setTimeout || global.setTimeout.bind(global);
    const cancel = ports.clearTimeout || global.clearTimeout.bind(global);
    let sequence = 0;
    let disposed = false;

    const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const isId = value => typeof value === 'string' && value.length > 0;
    const isCurrent = record => !disposed && records.get(record.agentId) === record && record.card.isConnected;
    const isWorking = record => isCurrent(record) && !record.terminal;
    function find(payload, allowTerminal) {
      if (!isRecord(payload) || !isId(payload.agentId)) { return null; }
      const record = records.get(payload.agentId);
      return record && (allowTerminal ? isCurrent(record) : isWorking(record)) ? record : null;
    }
    function element(tag, className, text) {
      const node = document.createElement(tag);
      node.className = className;
      if (text !== undefined) { node.textContent = text; }
      return node;
    }
    function badge(record, text, className = '') {
      record.status.textContent = text;
      record.status.className = 'subagent-status' + (className ? ' ' + className : '');
    }
    function scroll() {
      const messages = ports.getMessagesElement();
      if (messages) { messages.scrollTop = messages.scrollHeight; }
    }
    function later(record, callback, delay) {
      const generation = record.generation;
      const timer = schedule(() => {
        record.timers.delete(timer);
        if (isCurrent(record) && record.generation === generation) { callback(); }
      }, delay);
      record.timers.add(timer);
      return timer;
    }
    function invalidate(record) {
      record.generation++;
      for (const timer of record.timers) { cancel(timer); }
      record.timers.clear();
      record.renderTimer = null;
      for (const question of record.questions.values()) { question.remove(); }
      record.questions.clear();
      record.content.querySelectorAll('.ask-user-question-container').forEach(question => question.remove());
    }
    function highlight(node) {
      if (ports.highlight) { ports.highlight(node); }
    }
    function render(record, final) {
      if (!record.text || !record.rawText) { return; }
      try {
        record.text.innerHTML = ports.renderMarkdown(record.rawText);
        record.text.className = 'subagent-text-output rendered';
      } catch (_error) {
        record.text.textContent = record.rawText;
      }
      highlight(record.text);
      if (final && ports.renderDiagrams) { ports.renderDiagrams(record.content); }
    }
    function stringify(value) {
      if (typeof value === 'string') { return value; }
      try { return JSON.stringify(value, null, 2) || ''; }
      catch (_error) { return '[Unserializable value]'; }
    }

    function started(payload) {
      if (disposed || !isRecord(payload) || !isId(payload.agentId)) { return; }
      const messages = ports.getMessagesElement();
      if (!messages) { return; }
      const previous = records.get(payload.agentId);
      if (previous) {
        if (isWorking(previous)) { render(previous, true); badge(previous, 'Stopped', 'error'); }
        invalidate(previous);
        previous.rawText = '';
        previous.tools.clear();
      }
      const info = ports.getAgentDisplay(payload.agentId) || {};
      const card = element('div', 'subagent-card');
      // Display short IDs are not unique execution identities. DOM IDs are local
      // opaque tokens; all routing uses the full agent ID in the instance map.
      card.id = 'subagent-' + instanceId + '-' + (++sequence);
      card.dataset.agentId = payload.agentId;
      const header = element('div', 'subagent-header');
      if (typeof info.logo === 'string' && info.logo) {
        const logo = element('img', 'subagent-logo');
        logo.src = info.logo;
        logo.alt = '';
        logo.dataset.agentLogo = payload.agentId;
        header.appendChild(logo);
      } else {
        const initial = typeof info.shortId === 'string' && info.shortId ? info.shortId[0].toUpperCase() : '?';
        const fallback = element('span', '', initial);
        fallback.style.fontSize = '18px';
        header.appendChild(fallback);
      }
      header.appendChild(element('span', 'subagent-name', (info.name || payload.agentId) + ' (sub-agent)'));
      const status = element('span', 'subagent-status streaming', 'Working...');
      header.appendChild(status);
      header.appendChild(element('span', 'subagent-collapse-icon', '▼'));
      const content = element('div', 'subagent-content');
      content.id = card.id + '-content';
      card.append(header, content);
      header.addEventListener('click', () => card.classList.toggle('collapsed'));
      messages.appendChild(card);
      records.set(payload.agentId, {
        agentId: payload.agentId, card, content, status, rawText: '', text: null,
        renderTimer: null, timers: new Set(), tools: new Map(), questions: new Map(),
        generation: 0, terminal: false,
      });
      scroll();
    }

    function chunk(payload) {
      const record = find(payload);
      if (!record || typeof payload.content !== 'string' || !payload.content ||
          !['text', 'thinking'].includes(payload.chunkType)) { return; }
      badge(record, 'Streaming...', 'streaming');
      if (payload.chunkType === 'text') {
        record.rawText += payload.content;
        if (!record.text) {
          record.text = element('div', 'subagent-text-output');
          record.content.appendChild(record.text);
        }
        if (record.renderTimer === null) {
          record.renderTimer = later(record, () => {
            record.renderTimer = null;
            render(record, false);
          }, 200);
        }
      } else {
        let thinking = record.content.querySelector('.subagent-thinking-text');
        if (!thinking) {
          const section = element('div', 'subagent-thinking');
          thinking = element('div', 'subagent-thinking-text', '');
          section.append(element('div', 'subagent-thinking-label', 'Thinking'), thinking);
          record.content.prepend(section);
        }
        thinking.textContent += payload.content;
      }
      scroll();
    }

    function settleTools(record, status) {
      for (const tool of record.tools.values()) {
        if (!tool.classList.contains('running')) { continue; }
        tool.classList.replace('running', status);
        const spinner = tool.querySelector('.subagent-tool-spinner');
        if (spinner) {
          spinner.replaceWith(element('span', 'subagent-tool-icon ' + status, status === 'failed' ? '✕' : '✓'));
        }
      }
    }

    function complete(payload) {
      const record = find(payload);
      if (!record) { return; }
      invalidate(record);
      render(record, true);
      record.terminal = true;
      record.rawText = '';
      // Some backends emit tool_use without a matching tool_result. Completion
      // settles those indicators while preserving every explicit tool outcome.
      settleTools(record, payload.hasError ? 'failed' : 'completed');
      badge(record, payload.hasError ? 'Partial' : 'Done', payload.hasError ? 'error' : 'complete');
      if (record.content.scrollHeight > 400 && !record.content.querySelector('.subagent-expand-btn')) {
        const button = element('button', 'subagent-expand-btn', 'Show full output');
        button.addEventListener('click', () => {
          record.card.classList.toggle('expanded');
          button.textContent = record.card.classList.contains('expanded') ? 'Show less' : 'Show full output';
        });
        record.content.appendChild(button);
      }
    }

    function error(payload) {
      const record = find(payload);
      if (!record) { return; }
      invalidate(record);
      record.terminal = true;
      record.rawText = '';
      record.text = null;
      record.tools.clear();
      badge(record, 'Error', 'error');
      const detail = element('div', 'subagent-error-content');
      detail.appendChild(element('span', 'subagent-error-text', 'Error: ' + (typeof payload.error === 'string' ? payload.error : 'Unknown error')));
      const button = element('button', 'subagent-retry-btn', 'Retry');
      const generation = record.generation;
      button.addEventListener('click', () => {
        if (!isCurrent(record) || record.generation !== generation || button.disabled) { return; }
        button.disabled = true;
        ports.postMessage({ type: 'retrySubAgent', payload: { agentId: record.agentId } });
      });
      detail.appendChild(button);
      record.content.replaceChildren(detail);
    }

    function toolUse(payload) {
      const record = find(payload);
      const tool = isRecord(payload) && payload.toolCall;
      if (!record || !isRecord(tool) || !isId(tool.id) || typeof tool.name !== 'string') { return; }
      badge(record, 'Tool: ' + tool.name, 'streaming');
      const previous = record.tools.get(tool.id);
      if (previous) { previous.remove(); }
      const card = element('div', 'subagent-tool-call running');
      card.dataset.id = tool.id;
      const input = isRecord(tool.input) ? tool.input : {};
      const primary = input.file_path || input.path || input.command || input.pattern;
      const fallback = stringify(Object.values(input)[0]);
      const summary = primary ? stringify(primary) : (fallback.length > 60 ? fallback.slice(0, 60) + '...' : fallback);
      const header = element('div', 'subagent-tool-header');
      const toggle = element('span', 'subagent-tool-toggle', '▸');
      header.append(element('span', 'subagent-tool-spinner'), element('span', 'subagent-tool-name', tool.name),
        element('span', 'subagent-tool-summary', summary), toggle);
      const detail = element('div', 'subagent-tool-detail');
      const inputSection = element('div', 'subagent-tool-detail-section');
      const pre = element('pre', 'subagent-tool-detail-code');
      pre.appendChild(element('code', 'language-json', stringify(tool.input || {})));
      inputSection.append(element('span', 'subagent-tool-detail-label', 'Input'), pre);
      const output = element('div', 'subagent-tool-detail-section subagent-tool-output');
      output.style.display = 'none';
      const outputPre = element('pre', 'subagent-tool-detail-code');
      outputPre.appendChild(element('code', 'subagent-tool-output-code'));
      output.append(element('span', 'subagent-tool-detail-label', 'Output'), outputPre);
      detail.append(inputSection, output);
      card.append(header, detail);
      header.addEventListener('click', () => {
        card.classList.toggle('detail-open');
        toggle.textContent = card.classList.contains('detail-open') ? '▾' : '▸';
        if (card.classList.contains('detail-open')) { highlight(card); }
      });
      record.tools.set(tool.id, card);
      record.content.appendChild(card);
      scroll();
    }

    function toolResult(payload) {
      const record = find(payload);
      const tool = isRecord(payload) && payload.toolCall;
      if (!record || !isRecord(tool) || !isId(tool.id)) { return; }
      // Tool IDs are opaque data, never CSS selectors.
      const card = record.tools.get(tool.id);
      if (!card) { return; }
      const status = tool.status === 'failed' ? 'failed' : 'completed';
      card.classList.remove('running', 'failed', 'completed');
      card.classList.add(status);
      const spinner = card.querySelector('.subagent-tool-spinner, .subagent-tool-icon');
      if (spinner) { spinner.replaceWith(element('span', 'subagent-tool-icon ' + status, status === 'failed' ? '✕' : '✓')); }
      if (tool.output !== undefined && tool.output !== null) {
        const text = stringify(tool.output);
        card.querySelector('.subagent-tool-output-code').textContent = text.length > 2000 ? text.slice(0, 2000) + '\n... (truncated)' : text;
        card.querySelector('.subagent-tool-output').style.display = '';
        if (card.classList.contains('detail-open')) { highlight(card); }
      }
      badge(record, 'Streaming...', 'streaming');
    }

    function retry(payload) {
      const record = find(payload, true);
      if (!record) { return; }
      invalidate(record);
      record.rawText = '';
      record.text = null;
      record.tools.clear();
      record.terminal = false;
      record.content.replaceChildren();
      record.card.classList.remove('expanded');
      badge(record, 'Retrying...', 'retrying');
    }

    function validQuestions(questions) {
      return Array.isArray(questions) && questions.length > 0 && questions.every(question =>
        isRecord(question) && typeof question.question === 'string' &&
        (question.header === undefined || typeof question.header === 'string') &&
        (question.options === undefined || (Array.isArray(question.options) && question.options.every(option =>
          isRecord(option) && typeof option.label === 'string' &&
          (option.description === undefined || typeof option.description === 'string')))));
    }
    function askUserQuestion(payload) {
      const record = find(payload);
      const data = isRecord(payload) && payload.questionData;
      if (!record || !isRecord(data) || !isId(data.toolCallId) || !validQuestions(data.questions)) { return; }
      const toolCallId = data.toolCallId;
      const container = ports.renderQuestion(toolCallId, data.questions);
      if (!container) { return; }
      const previous = record.questions.get(toolCallId);
      if (previous) { previous.remove(); }
      record.questions.set(toolCallId, container);
      // The shared renderer names radios by question index. Each delivery must
      // own its radio groups even while other agents' questions remain visible.
      const prefix = record.card.id + '-question-' + (++sequence) + '-';
      container.querySelectorAll('input[name]').forEach(input => { input.name = prefix + input.name; });
      container._answers = Object.create(null);
      const generation = record.generation;
      const settle = skipped => {
        if (!isWorking(record) || record.generation !== generation || !container.isConnected ||
            record.questions.get(toolCallId) !== container) { return; }
        record.questions.delete(toolCallId);
        ports.postMessage({
          type: skipped ? 'subAgentQuestionSkipped' : 'subAgentQuestionResponse',
          payload: { toolCallId, agentId: record.agentId, ...(skipped ? {} : { answers: container._answers }) },
        });
        if (skipped) { container.remove(); }
        else {
          container.classList.add('submitted');
          container.replaceChildren(element('div', 'auq-submitted', '✓ Answers submitted'));
          later(record, () => container.remove(), 1500);
        }
        badge(record, record.questions.size ? 'Waiting for answer...' : 'Working...', record.questions.size ? '' : 'streaming');
      };
      const submit = container.querySelector('.auq-submit-btn');
      if (submit) { submit.onclick = () => { if (!submit.disabled) { settle(false); } }; }
      const skip = container.querySelector('.auq-skip-btn');
      if (skip) { skip.onclick = () => settle(true); }
      record.content.appendChild(container);
      badge(record, 'Waiting for answer...');
      scroll();
    }

    function status(payload) {
      const record = find(payload);
      if (!record || (payload.status !== undefined && typeof payload.status !== 'string')) { return; }
      badge(record, payload.status || 'Working...', payload.status === 'Working...' ? 'streaming' : '');
    }
    function stop() {
      for (const record of records.values()) {
        if (isWorking(record)) {
          render(record, true);
          badge(record, 'Stopped', 'error');
          settleTools(record, 'failed');
        }
        invalidate(record);
        record.terminal = true;
        record.rawText = '';
      }
      records.clear();
    }
    function reset() {
      for (const record of records.values()) { invalidate(record); }
      records.clear();
    }
    function dispose() {
      reset();
      disposed = true;
    }

    return { started, chunk, complete, error, toolUse, toolResult, retry, askUserQuestion, status, stop, reset, dispose };
  }

  global.MystiSubAgentCards = { create };
})(typeof window !== 'undefined' ? window : globalThis);
