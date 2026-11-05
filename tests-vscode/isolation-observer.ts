/** Self-contained so Playwright can install it in the actual webview world. */
export function installIsolationObserver(): void {
  const win = globalThis as any; win.__pc09Events = [];
  win.document.addEventListener('click', (event: any) => {
    if (event.target?.closest?.('#stop-btn')) win.__pc09Events.push({ type: 'stopClicked', payload: {}, at: Date.now() });
  }, true);
  win.addEventListener('message', (event: any) => {
    const message = event.data, p = message?.payload || {}; let payload: any;
    if (message?.type === 'responseChunk') payload = {
      type: p.type,
      content: p.type === 'text' ? p.content : undefined,
      contentLength: p.type === 'thinking' && typeof p.content === 'string' ? p.content.length : undefined,
    };
    else if (message?.type === 'conversationChanged') payload = { id: p.id, messageCount: p.messages?.length };
    else if (message?.type === 'contextUpdated') payload = Array.isArray(p) ? p.map((item: any) => ({ path: item.path, content: item.content })) : [];
    else if (message?.type === 'responseComplete' || message?.type === 'messageAdded') {
      const value = p.message || p; payload = { id: value.id, content: value.content, provider: value.provider, model: value.model };
    } else if (message?.type === 'requestCancelled') payload = p.message ? { id: p.message.id, content: p.message.content, provider: p.message.provider, model: p.message.model } : {};
    else if (message?.type === 'permissionRequest') payload = { id: p.id, toolName: p.details?.toolName };
    else if (['responseStarted', 'error', 'authError', 'toolUse'].includes(message?.type)) payload = {};
    else return;
    win.__pc09Events.push({ type: message.type, payload, at: Date.now() });
  });
}

/** A started request or an empty thinking notification is not model progress. */
export function hasIsolationModelProgress(events: any[], allowThinking: boolean): boolean {
  return events.some(event => event.type === 'responseChunk' && (
    (event.payload?.type === 'text' && typeof event.payload.content === 'string' && event.payload.content.length > 0)
    || (allowThinking && event.payload?.type === 'thinking' && Number.isFinite(event.payload.contentLength) && event.payload.contentLength > 0)
  ));
}
