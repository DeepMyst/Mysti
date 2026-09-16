/* Reviewed editor acceptance identities. Changing coverage requires updating this list. */
const canvas = 'Mysti Canvas — real VS Code host';
const chat = 'Mysti Chat — real VS Code host and loopback provider';
const desk = 'Mysti Desk — packaged native runtime in the actual editor';
const optionalNativeTest = [desk, 'starts the exact packaged worker or refuses the minimum runtime before native access'];

const expectedTests = [
  [canvas, 'activates and registers the canvas commands'],
  [canvas, 'opens the canvas panel'],
  [canvas, 'loads an artifact host-side'],
  [canvas, 'the WEBVIEW confirms it rendered — the handshake completes end to end'],
  [canvas, 'a design created in the panel persists to .mysti/canvas'],
  [canvas, 'mounts an interactive artboard under the real host CSP'],
  [canvas, 'reloads the persisted design on a second open'],
  [chat, 'streams a normal response through the chat webview'],
  [chat, 'replays history and Stop closes the active HTTP stream'],
  [chat, 'restores a saved conversation through the history picker'],
  [chat, 'keeps two panels independent when one stream is stopped'],
  [chat, 'recovers from a provider error without leaving the composer locked'],
  [desk, 'registers cross-machine commands while relay access defaults to disabled'],
  optionalNativeTest,
];

module.exports = { expectedTests, optionalNativeTest };
