import type { Frame } from 'playwright';
/** Passive host events only. No application state writes or synthetic requests. */
export function installCodexHelperQualityObserver(): void {
  const win = globalThis as any;
  win.__pb02HelperQualityEvents ||= [];
  win.__pb02HelperQualityListener ||= (event: any): void => {
    const message = event.data;
    if (!message || typeof message !== 'object') { return; }
    const types = ['initialState', 'settingsSync', 'conversationChanged', 'conversationHistory', 'messageAdded', 'responseStarted', 'responseComplete',
      'responseChunk', 'permissionRequest', 'toolUse', 'toolResult', 'error', 'authError', 'requestCancelled', 'modelChanged',
      'titleUpdated', 'suggestionsLoading', 'suggestionsReady', 'suggestionsError', 'clearSuggestions', 'autonomousDecision', 'semiAutonomousPlanTimer', 'semiAutonomousQuestionTimer', 'modeChanged', 'sessionCleared', 'askUserQuestion', 'planOptions', 'fileAttachmentSelected', 'compactionStatus'];
    if (!types.includes(message.type)) { return; }
    let payload = message.payload;
    if (message.type === 'responseChunk' && payload?.type !== 'text') { return; }
    const safeSettings = (settings: any): any => Object.fromEntries(['provider', 'model', 'thinkingLevel', 'effortLevel', 'mode', 'accessLevel', 'contextMode', 'ultracode']
      .filter(key => settings && Object.prototype.hasOwnProperty.call(settings, key)).map(key => [key, settings[key]]));
    if (message.type === 'initialState') {
      payload = { panelId: payload?.panelId, conversationId: payload?.conversation?.id, providerManifest: payload?.providerManifest, settings: safeSettings(payload?.settings) };
    }
    if (message.type === 'settingsSync') { payload = safeSettings(payload); }
    if (message.type === 'fileAttachmentSelected') {
      payload = { attachments: (payload?.attachments || []).map((item: any) => ({ id: item.id, fileName: item.fileName, type: item.type, filePath: item.filePath, size: item.size })) };
    }
    // Sanitize every message-bearing event, including History and partials.
    // Tool input/output strings remain exact for the fixture audit.
    const scrub = (value: any): any => {
      if (Array.isArray(value)) { return value.filter(item => item?.type !== 'thinking').map(scrub); }
      if (value && typeof value === 'object') { return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'thinking').map(([key, item]) => [key, scrub(item)])); }
      return value;
    };
    win.__pb02HelperQualityEvents.push({ type: message.type, at: Date.now(), payload: scrub(payload) });
  };
  const attach = (): void => { win.removeEventListener('message', win.__pb02HelperQualityListener); win.addEventListener('message', win.__pb02HelperQualityListener); };
  const observeTitles = (): void => {
    const recordTitles = (): void => {
      win.__pb02HelperQualityTitleObservations ||= [];
      for (const row of win.document.querySelectorAll('.history-item[data-conversation-id]')) {
        const title = row.querySelector('.history-item-title');
        if (!title || title.getClientRects().length === 0) { continue; }
        const value = { conversationId: row.getAttribute('data-conversation-id'), title: title.textContent?.trim(), at: Date.now(), visible: true };
        const prior = win.__pb02HelperQualityTitleObservations.at(-1);
        if (!prior || prior.conversationId !== value.conversationId || prior.title !== value.title) { win.__pb02HelperQualityTitleObservations.push(value); }
      }
    };
    win.__pb02HelperQualityTitleObserver?.disconnect();
    win.__pb02HelperQualityTitleObserver = new win.MutationObserver(recordTitles);
    win.__pb02HelperQualityTitleObserver.observe(win.document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style'] });
    recordTitles();
  };
  attach(); observeTitles();
  if (!win.__pb02HelperQualityObservedDocumentOpen) {
    const original = win.Document.prototype.open;
    win.Document.prototype.open = function (...args: any[]): any { const result = original.apply(this, args); attach(); observeTitles(); return result; };
    win.__pb02HelperQualityObservedDocumentOpen = true;
  }
}

/** Read actual visible cards only; never mutates application state. */
export async function captureHelperQualityDom(frame: Frame): Promise<any> {
  return frame.evaluate(() => {
        const doc = (globalThis as any).document;
        const visible = (element: any): boolean => element.getClientRects().length > 0;
        return { capturedAt: Date.now(),
          suggestions: Array.from(doc.querySelectorAll('.suggestion-card')).filter(visible).map((card: any) => ({ title: card.querySelector('.suggestion-title')?.textContent?.trim(), tooltip: card.title, color: card.getAttribute('data-color'), icon: card.querySelector('.suggestion-icon')?.textContent?.trim() })),
          plans: Array.from(doc.querySelectorAll('.plan-options-container .plan-option-card')).filter(visible).map((card: any) => ({ optionId: card.getAttribute('data-id'), messageId: card.closest('.plan-options-container').getAttribute('data-message-id'), title: Array.from(card.querySelector('.plan-option-title')?.childNodes || []).filter((node: any) => node.nodeType === 3).map((node: any) => node.textContent).join('').trim(), summary: card.querySelector('.plan-option-summary')?.textContent?.trim() || '', complexity: card.querySelector('.plan-option-complexity')?.textContent?.trim().toLowerCase(), text: card.innerText })),
          questions: Array.from(doc.querySelectorAll('.ask-user-question-container')).filter(visible).map((card: any) => ({ toolCallId: card.getAttribute('data-tool-call-id'), text: card.innerText, questionTexts: Array.from(card.querySelectorAll('.auq-question-text')).map((value: any) => value.textContent?.trim()), optionLabels: Array.from(card.querySelectorAll('.auq-option:not(.auq-option-other) .auq-option-label')).map((value: any) => value.textContent?.trim()) })) };
  });
}
