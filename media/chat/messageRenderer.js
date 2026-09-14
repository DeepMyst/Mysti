/**
 * Mysti - AI Coding Agent · SPDX-License-Identifier: Apache-2.0
 *
 * Persisted-message replay. The owner supplies its DOM and the same Markdown,
 * thinking, tool-card and footer renderers used by live messages. This module
 * owns no conversation state, provider selection or host messages.
 */
(function(global) {
  'use strict';

  function normalizeMessageThinking(thinking) {
    if (typeof thinking === 'string') {
      return thinking.trim() ? { style: 'complete-blocks', content: thinking } : null;
    }
    if (!thinking || typeof thinking.content !== 'string' || !thinking.content) { return null; }
    return {
      style: thinking.style === 'streamed' ? 'streamed' : 'complete-blocks',
      content: thinking.content,
    };
  }

  function create(ports) {
    const document = ports.document;
    const text = value => typeof value === 'string' ? value : '';
    const element = (tag, className, content) => {
      const node = document.createElement(tag);
      node.className = className;
      if (content !== undefined) { node.textContent = content; }
      return node;
    };

    function buildRestoredMessageBody(msg) {
      const body = element('div', 'message-body');
      const thinking = normalizeMessageThinking(msg.thinking);
      const style = thinking ? thinking.style : 'complete-blocks';
      const calls = Array.isArray(msg.toolCalls) ? msg.toolCalls.filter(call => call && typeof call === 'object') : [];
      const segments = Array.isArray(msg.segments) ? msg.segments : [];
      // Tool identifiers are opaque persisted values, including __proto__ and
      // constructor. A Map cannot accidentally replay Object.prototype members.
      const remaining = new Map();
      for (const call of calls) {
        if (typeof call.id === 'string' && call.id) { remaining.set(call.id, call); }
      }
      const appendCall = id => {
        if (!remaining.has(id)) { return; }
        const call = remaining.get(id);
        remaining.delete(id);
        body.appendChild(ports.buildToolCallElement(call));
      };
      const appendContent = (content, className) => {
        if (!text(content)) { return; }
        const node = element('div', className);
        node.innerHTML = ports.formatContent(content);
        body.appendChild(node);
      };

      if (segments.length) {
        // Coordinator histories store reasoning separately from text/tool
        // segments. Match its live position before the first text in that case.
        const hasThinking = segments.some(segment => segment && segment.type === 'thinking');
        if (thinking && !hasThinking) { ports.renderThinkingZone(body, style, thinking.content); }
        let index = 0;
        for (const segment of segments) {
          if (!segment) { continue; }
          if (segment.type === 'thinking') {
            // All reasoning accumulates in the first thinking zone, as live.
            ports.renderThinkingZone(body, style, text(segment.content));
          } else if (segment.type === 'text' && text(segment.content)) {
            appendContent(segment.content, 'message-content content-segment-' + index++);
          } else if (segment.type === 'tool') { appendCall(segment.toolCallId); }
        }
        // Preserve tools whose segment was absent in an older saved history.
        for (const call of calls) { appendCall(call.id); }
      } else {
        if (thinking) { ports.renderThinkingZone(body, style, thinking.content); }
        appendContent(msg.content, 'message-content');
        for (const call of calls) { body.appendChild(ports.buildToolCallElement(call)); }
      }
      return body;
    }

    function actionButton(className, id, title, icon) {
      const button = element('button', className);
      button.type = 'button';
      button.dataset.messageId = id;
      button.title = title;
      // Only the constant application icon is markup; all persisted values
      // enter through textContent, dataset or DOM properties.
      button.innerHTML = icon;
      return button;
    }

    function appendAttachments(message, attachments) {
      if (!Array.isArray(attachments) || !attachments.length) { return; }
      const container = element('div', 'message-attachments');
      for (const attachment of attachments) {
        if (!attachment || typeof attachment !== 'object') { continue; }
        const name = text(attachment.fileName);
        const mime = text(attachment.mimeType);
        const data = text(attachment.base64Data);
        // Preserve image MIME types (including SVG in an inert img context),
        // but refuse non-image URLs and malformed stored Base64. A label keeps
        // an unavailable attachment visible without trying to load its bytes.
        const validImage = attachment.type === 'image'
          && /^image\/[a-z0-9][a-z0-9.+-]*$/i.test(mime)
          && data.length > 0 && data.length % 4 === 0 && /^[a-z0-9+/]*={0,2}$/i.test(data);
        if (validImage) {
          const image = element('img', 'message-attachment-img');
          image.src = 'data:' + mime + ';base64,' + data;
          image.alt = name;
          image.title = name;
          container.appendChild(image);
        } else {
          container.appendChild(element('span', 'message-attachment-label', (attachment.type === 'image' ? '' : '📄 ') + name));
        }
      }
      if (container.childNodes.length) { message.appendChild(container); }
    }

    function buildMessage(msg) {
      if (!msg || typeof msg !== 'object') { return null; }
      const role = ['assistant', 'user', 'system'].includes(msg.role) ? msg.role : 'system';
      const id = text(msg.id);
      const message = element('div', 'message ' + role);
      message.dataset.id = id;
      const attribution = ports.getMessageAttribution(msg);
      const header = element('div', 'message-header');
      const roleContainer = element('div', 'message-role-container');
      roleContainer.appendChild(element('span', 'message-role ' + role, role === 'assistant' ? 'Mysti' : role));
      header.appendChild(roleContainer);
      if (role === 'assistant') {
        const agent = ports.getAgentDisplayName(attribution.provider);
        const chip = element('span', 'message-model-info', ports.formatAttributionLabel(attribution));
        chip.title = agent ? 'Generated by ' + agent : '';
        roleContainer.appendChild(chip);
        header.appendChild(actionButton('message-copy-btn', id, 'Copy message as Markdown',
          '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/><path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/></svg>'));
      } else if (role === 'user') {
        const button = actionButton('message-rewind-btn', id, 'Rewind / fork from here',
          '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5.5h4v-4"/><path d="M2.9 9.2a5 5 0 1 0 1.3-4.7L2.5 5.5"/></svg>');
        if (msg.checkpoint && text(msg.checkpoint.commit)) { button.dataset.commit = msg.checkpoint.commit; }
        header.appendChild(button);
      }
      message.appendChild(header);
      appendAttachments(message, msg.attachments);
      if (role === 'assistant') {
        message.appendChild(buildRestoredMessageBody(msg));
        ports.renderMessageFooter(message, null, attribution, []);
      } else {
        const content = element('div', 'message-content');
        content.innerHTML = ports.formatContent(text(msg.content));
        message.appendChild(content);
      }
      return message;
    }

    function appendMessage(container, msg) {
      const message = buildMessage(msg);
      if (!message) { return null; }
      const welcome = container.querySelector('.welcome-container');
      if (welcome) { welcome.remove(); }
      container.appendChild(message);
      container.scrollTop = container.scrollHeight;
      return message;
    }

    return { buildMessage, buildRestoredMessageBody, appendMessage };
  }

  global.MystiMessageRenderer = { create, normalizeMessageThinking };
})(typeof window !== 'undefined' ? window : globalThis);
