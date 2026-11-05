/** Passive public host events and clicked DOM controls; never sends business messages. */
export function installCapabilitiesObserver(): void {
  const win = globalThis as any;
  if (!win.__pc12Events) { win.__pc12Events = []; }
  if (!win.__pc12Listener) {
    win.__pc12Listener = (event: any) => {
      const message = event.data;
      if (message?.type === 'initialState') {
        if (message.payload?.providerManifest) { win.__pc12Events.push({ type: 'manifestObserved', at: Date.now(), source: 'initialState', payload: message.payload.providerManifest }); }
        return;
      }
      if (message?.type === 'manifestUpdated') { win.__pc12Events.push({ type: 'manifestObserved', at: Date.now(), source: 'manifestUpdated', payload: message.payload }); return; }
      if (!['conversationChanged', 'conversationHistory', 'messageAdded', 'responseStarted', 'responseComplete', 'permissionRequest',
        'toolUse', 'toolResult', 'error', 'authError', 'requestCancelled', 'settingsUpdated', 'modelChanged', 'modeChanged', 'providerAvailability', 'sessionCleared'].includes(message?.type)) { return; }
      let payload = message.payload;
      if (message.type === 'settingsUpdated') {
        const settings = payload?.settings || payload || {};
        payload = Object.fromEntries(['provider', 'model', 'mode', 'accessLevel', 'effortLevel'].map(key => [key, settings[key]]));
      }
      win.__pc12Events.push({ type: message.type, at: Date.now(), payload });
    };
  }
  const attach = (): void => {
    win.removeEventListener('message', win.__pc12Listener);
    win.addEventListener('message', win.__pc12Listener);
  };
  attach();
  // VS Code writes the actual webview with document.open, which removes window
  // listeners without clearing globals. Reattach this observer immediately;
  // neither application state nor host message production is altered.
  if (!win.__pc12ObservedDocumentOpen) {
    const original = win.Document.prototype.open;
    win.Document.prototype.open = function (...args: any[]): any {
      const result = original.apply(this, args); attach(); return result;
    };
    win.__pc12ObservedDocumentOpen = true;
  }
}
