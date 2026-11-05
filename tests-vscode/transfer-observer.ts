/** Observes real UI/host traffic. Never injects business messages or app state. */
export function installTransferObserver(): void {
  const win = globalThis as any; win.__pc11Events = [];
  win.document.addEventListener('click', (event: any) => {
    const item = event.target?.closest?.('.tools-menu-item, .slash-menu-item, .message-copy-btn, .code-copy-btn');
    if (item) { win.__pc11Events.push({ type: 'actionClicked', at: Date.now(), payload: {
      id: item.id, action: item.dataset.composerAction, commandId: item.dataset.commandId, messageId: item.dataset.messageId,
    } }); }
  }, true);
  win.addEventListener('message', (event: any) => {
    const message = event.data;
    if (!['conversationChanged', 'conversationHistory', 'messageAdded', 'responseStarted', 'responseChunk', 'responseComplete',
      'requestCancelled', 'titleUpdated', 'checkpointCreated', 'permissionRequest', 'toolUse', 'toolResult', 'error', 'authError',
      'fileAttachmentSelected', 'attachmentWarning', 'exportResult', 'sessionCleared', 'conversationImportNotice'].includes(message?.type)) { return; }
    let payload = message.payload || {};
    if (message.type === 'responseChunk') { payload = { type: payload.type, content: payload.type === 'text' ? payload.content : undefined }; }
    win.__pc11Events.push({ type: message.type, at: Date.now(), payload });
  });
}
