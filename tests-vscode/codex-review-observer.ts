/** Passive host events only. No application state writes or synthetic requests. */
export function installCodexReviewObserver(): void {
  const win = globalThis as any;
  win.__pb02ReviewEvents ||= [];
  win.__pb02ReviewListener ||= (event: any): void => {
    const message = event.data;
    if (!message || typeof message !== 'object') { return; }
    const types = ['initialState', 'conversationChanged', 'conversationHistory', 'messageAdded', 'responseStarted', 'responseComplete',
      'responseChunk', 'permissionRequest', 'toolUse', 'toolResult', 'error', 'authError', 'requestCancelled', 'modelChanged',
      'modeChanged', 'sessionCleared', 'askUserQuestion', 'planOptions', 'fileAttachmentSelected', 'compactionStatus'];
    if (!types.includes(message.type)) { return; }
    let payload = message.payload;
    if (message.type === 'responseChunk' && payload?.type !== 'text') { return; }
    if (message.type === 'initialState') {
      payload = { panelId: payload?.panelId, conversationId: payload?.conversation?.id, providerManifest: payload?.providerManifest };
    }
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
    win.__pb02ReviewEvents.push({ type: message.type, at: Date.now(), payload: scrub(payload) });
  };
  const attach = (): void => { win.removeEventListener('message', win.__pb02ReviewListener); win.addEventListener('message', win.__pb02ReviewListener); };
  attach();
  if (!win.__pb02ReviewObservedDocumentOpen) {
    const original = win.Document.prototype.open;
    win.Document.prototype.open = function (...args: any[]): any { const result = original.apply(this, args); attach(); return result; };
    win.__pb02ReviewObservedDocumentOpen = true;
  }
}
