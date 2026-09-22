/** Foreground response identity, lifetime and transcript owner. SPDX-License-Identifier: Apache-2.0 */
(function(global) {
  'use strict';
  const STREAM = new Set(['responseChunk', 'toolUse', 'toolResult', 'mystiDelegateTrace',
    'subAgentStarted', 'subAgentChunk', 'subAgentComplete', 'subAgentError', 'subAgentToolUse',
    'subAgentToolResult', 'subAgentRetry', 'subAgentAskUserQuestion', 'subAgentStatus',
    'mentionTaskListGenerated', 'mentionTaskStarted', 'mentionTaskComplete', 'mentionFilesResolved',
    'mystiStarted', 'mystiEvent', 'mystiComplete', 'mystiError', 'sessionEvent', 'sessionError']);
  const TERMINAL = new Set(['responseComplete', 'requestCancelled', 'error', 'authError',
    'mystiUnavailable', 'mystiSignInRequired']);
  const ACCESSORY = new Set(['suggestionsLoading', 'suggestionsReady', 'suggestionsError',
    'clearSuggestions', 'planOptions', 'clearPlanOptions', 'askUserQuestion',
    'semiAutonomousPlanTimer', 'semiAutonomousQuestionTimer', 'semiAutonomousDecision',
    'autonomousDecision', 'connectionAlready', 'connectionRequired', 'compactionStatus', 'contextWindowInfo',
    'channelAction', 'autonomousDeactivated']);
  const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);

  function create(ports) {
    const document = ports.document;
    const prefix = 'web-' + (global.crypto && typeof global.crypto.randomUUID === 'function'
      ? global.crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)) + '-';
    let localOrdinal = 0;
    let latestLocalIntent = null;
    let highSequence = 0;
    let tagged = false;
    let disposed = false;
    let owner = null;

    function preserve() {
      if (owner && owner.element) {
        if (owner.phase !== 'terminal' && ports.retireElement) { ports.retireElement(owner.element); }
        owner.element.classList.remove('streaming');
      }
    }
    function replace(id, prepared, sequence) {
      preserve();
      const fallback = ports.fallbackAttribution();
      owner = { id, prepared, sequence, phase: 'pending', element: null, body: null,
        segment: null, segmentIndex: 0, response: '', thinking: '',
        attribution: { provider: fallback.provider, model: fallback.model || '' }, finalized: false };
    }
    function mint() {
      latestLocalIntent = prefix + (++localOrdinal);
      return latestLocalIntent;
    }
    function prepare() {
      if (disposed) { return null; }
      const id = mint();
      tagged = true;
      replace(id, true, null);
      return id;
    }
    // Slash utilities correlate errors/results without claiming the composer.
    // Only an actual host admission turns this reserved command into a run.
    function reserveCommand() { return disposed ? null : mint(); }
    function matches(id) { return !!owner && owner.id === (validId(id) ? id : null); }
    function live() { return !!owner && owner.phase !== 'terminal'; }
    function pending(message) {
      const id = message.requestId;
      const sequence = message.payload && message.payload.sequence;
      if (!validId(id) || !Number.isSafeInteger(sequence) || sequence <= highSequence) { return false; }
      // Local ordinals retire acknowledgements still in flight at reset.
      // Refused unrelated acknowledgements cannot consume this owner's ordinal.
      if (id.indexOf(prefix) === 0 && id !== latestLocalIntent) { return false; }
      if (owner && owner.prepared && owner.sequence === null && owner.id !== id && live()) { return false; }
      if (matches(id)) {
        if (!live() || owner.sequence !== null) { return false; }
        highSequence = sequence;
        tagged = true;
        owner.sequence = sequence;
        return true;
      }
      highSequence = sequence;
      tagged = true;
      replace(id, false, sequence);
      return true;
    }
    function begin(message) {
      const id = message.requestId;
      if (!validId(id)) {
        // Legacy fixtures/standalone callers are isolated from tagged runs.
        // Once correlation is established, untagged events never gain authority.
        if (tagged) { return false; }
        replace(null, false, null);
      } else if (!matches(id) || !live() || owner.phase === 'active') { return false; }
      const fallback = ports.fallbackAttribution();
      const announced = message.payload;
      owner.attribution = announced
        ? { provider: announced.provider, model: announced.model || '' }
        : { provider: fallback.provider, model: fallback.model || '' };
      owner.phase = 'active';
      return true;
    }
    function close() {
      owner.phase = 'terminal';
      preserve();
      return owner.element;
    }
    /** Admission precedes every foreground observer and shell side effect. */
    function admit(message) {
      if (disposed || !message || typeof message.type !== 'string') { return { accepted: false }; }
      const type = message.type;
      const payload = message.payload || {};
      // Native permission decisions and independent channel/session controls
      // carry their own authority; they never close or reopen this timeline.
      if ((type === 'semiAutonomousDecision' && payload.targetType === 'permission' && !validId(message.requestId)) ||
          ((type === 'channelAction' || type === 'autonomousDeactivated') && !validId(message.requestId))) {
        return { accepted: true, foreground: false };
      }
      if (type === 'responsePending') { return { accepted: pending(message), foreground: true }; }
      if (type === 'responseStarted') { return { accepted: begin(message), foreground: true }; }
      if (type === 'jobStarted') {
        // A job has its own lifetime. An old origin cannot detach the new turn,
        // but its job card still needs to appear.
        const detach = matches(message.requestId) && live();
        return { accepted: true, foreground: detach, terminal: detach, element: detach ? close() : null };
      }
      const action = ['mystiActionRequired', 'mystiSignInRequired', 'mystiUnavailable'].includes(type);
      const neutral = message.scope === 'background' || message.scope === 'notice' ||
        (action && (payload.scope === 'background' || payload.scope === 'notice'));
      if (neutral && (action || ACCESSORY.has(type) || type === 'systemNotice' || type === 'error' || type === 'authError')) {
        return { accepted: !validId(message.requestId) || matches(message.requestId), foreground: false };
      }
      if (message.scope === 'accessory' && type === 'toolResult') {
        return { accepted: validId(message.requestId) && matches(message.requestId), foreground: false };
      }
      const terminal = TERMINAL.has(type) || (type === 'mystiActionRequired' && payload.terminal === true) ||
        (type === 'mystiComplete' && payload.cancelled === true);
      const accessory = ACCESSORY.has(type);
      const stream = STREAM.has(type);
      // Tagged miscellaneous foreground effects (messageAdded, notices, gates)
      // also require their captured owner; standalone untagged UI events remain
      // outside this owner and cannot implicitly start or finish it.
      const foreground = terminal || action || stream || validId(message.requestId);
      if (!foreground && !accessory) { return { accepted: true, foreground: false }; }
      if (accessory && !validId(message.requestId) && !tagged) { return { accepted: true, foreground: false }; }
      if (!matches(message.requestId) || (tagged && !validId(message.requestId))) { return { accepted: false }; }
      if (accessory) { return { accepted: true, foreground: false }; }
      if (!live()) { return { accepted: false }; }
      if (type === 'responseChunk' && owner.phase !== 'active') { return { accepted: false }; }
      if (terminal) { return { accepted: true, foreground: true, terminal: true, element: close() }; }
      return { accepted: true, foreground: true };
    }
    function ensure() {
      if (disposed || !live()) { return null; }
      if (owner.element) { return owner.element; }
      const messages = ports.getMessagesElement();
      const loading = messages.querySelector('.loading');
      if (loading) { loading.remove(); }
      const element = document.createElement('div');
      element.className = 'message assistant streaming';
      element.innerHTML = '<div class="message-header"><div class="message-role-container"><span class="message-role assistant">Mysti</span><span class="message-model-info"></span></div></div><div class="message-body"></div>';
      const attribution = owner.attribution || ports.fallbackAttribution();
      element.querySelector('.message-model-info').textContent = ports.formatAttributionLabel(attribution);
      owner.element = element;
      owner.body = element.querySelector('.message-body');
      messages.appendChild(element);
      return element;
    }
    function content(value) {
      if (!ensure()) { return; }
      if (!owner.segment) {
        owner.segment = document.createElement('div');
        owner.segment.className = 'message-content content-segment-' + owner.segmentIndex;
        owner.body.appendChild(owner.segment);
      }
      owner.segment.innerHTML = ports.formatContent(value);
      ports.scroll();
    }
    function append(chunk) {
      if (!live() || owner.phase !== 'active' || !chunk) { return false; }
      if (chunk.type === 'text') {
        owner.response += chunk.content || '';
        content(ports.stripChannelMarkers(owner.response));
      } else if (chunk.type === 'thinking') {
        if (!ensure()) { return false; }
        owner.thinking += chunk.content || '';
        const provider = (owner.attribution || ports.fallbackAttribution()).provider;
        ports.renderThinkingZone(owner.body, ports.getThinkingStyle(provider), chunk.content);
        ports.scroll();
      }
      return true;
    }
    function beforeTool() {
      if (!ensure()) { return null; }
      if (owner.response.trim()) {
        owner.segmentIndex++;
        owner.response = '';
        owner.segment = null;
      }
      return owner.body;
    }
    function thinkingFor(element) {
      return owner && owner.element && owner.element.contains(element) ? owner.thinking : '';
    }
    function synthesis(value) {
      if (!ensure()) { return; }
      owner.element.dataset.mystiSynthesis = 'pending';
      owner.element.querySelector('.message-model-info').textContent = 'Orchestrated';
      content(value || '');
    }
    function completedMessage(message) {
      const msg = message || {};
      const captured = owner && owner.attribution || {};
      return Object.assign({}, msg, {
        provider: typeof msg.provider === 'string' ? msg.provider : captured.provider,
        model: typeof msg.model === 'string' ? msg.model : captured.model || '',
      });
    }
    function finish(message) {
      if (!owner || owner.phase !== 'terminal' || owner.finalized) { return null; }
      owner.finalized = true;
      const msg = completedMessage(message);
      // Sessions may return one final answer without any delta. Empty control
      // completions still release the pending owner without creating a bubble.
      if (!owner.element && (msg.content || (msg.segments && msg.segments.length) ||
          (msg.toolCalls && msg.toolCalls.length) || msg.thinking)) {
        owner.element = ports.appendFinal(Object.assign({ role: 'assistant' }, msg));
      }
      const element = owner.element;
      if (!element) { return null; }
      element.classList.remove('streaming');
      const thinking = element.querySelector('.thinking-block.streaming-thinking');
      if (thinking) { thinking.classList.remove('streaming-thinking'); }
      if (msg.id) { element.dataset.id = msg.id; }
      ports.updateMessageAttributionChip(element, msg);
      const segments = element.querySelectorAll('.message-body .message-content');
      if (msg.content && segments.length === 1) { segments[0].innerHTML = ports.formatContent(msg.content); }
      if (msg.content && segments.length === 0) {
        const finalText = document.createElement('div');
        finalText.className = 'message-content';
        finalText.innerHTML = ports.formatContent(msg.content);
        const body = element.querySelector('.message-body');
        if (body) { body.appendChild(finalText); }
      }
      return element;
    }
    function reset() { preserve(); owner = null; latestLocalIntent = null; }
    function dispose() { reset(); disposed = true; }
    return { prepare, reserveCommand, admit, append, beforeTool, thinkingFor, synthesis, finish, completedMessage,
      currentElement: () => owner && owner.element,
      currentRequestId: () => owner && owner.id,
      capture: () => owner,
      isCurrent: capture => !disposed && capture === owner && live(),
      reset, dispose };
  }
  global.MystiStreamingTimeline = Object.freeze({ create });
})(typeof window !== 'undefined' ? window : globalThis);
