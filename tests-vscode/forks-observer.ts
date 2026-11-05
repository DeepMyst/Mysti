/** Passive observations only; no application state or business-message injection. */
export function installForksObserver(): void {
  const win = globalThis as any;
  win.__pc10Events = [];
  win.document.addEventListener('click', (event: any) => {
    const item = event.target?.closest?.('#rewind-menu .rewind-menu-item');
    if (!item) { return; }
    const menu = item.closest('#rewind-menu');
    win.__pc10Events.push({ type: 'menuClicked', at: Date.now(), payload: {
      action: item.dataset.action, conversationId: menu.dataset.conversationId,
      messageId: menu.dataset.messageId, commit: menu.dataset.commit, disabled: item.disabled,
    } });
  }, true);
  win.addEventListener('message', (event: any) => {
    const message = event.data;
    if (!['conversationChanged', 'conversationHistory', 'messageAdded', 'responseStarted', 'responseChunk', 'responseComplete',
      'requestCancelled', 'titleUpdated', 'checkpointCreated', 'checkpointAvailability', 'rewindComplete', 'permissionRequest',
      'toolUse', 'toolResult', 'error', 'authError', 'sessionCleared'].includes(message?.type)) { return; }
    let payload = message.payload || {};
    if (message.type === 'responseChunk') {
      payload = { type: payload.type, content: payload.type === 'text' ? payload.content : undefined };
    }
    // Full public conversation payloads are kept in this ephemeral observer
    // for exact comparison. The test exports digests, never raw thinking.
    win.__pc10Events.push({ type: message.type, at: Date.now(), payload });
  });
}
