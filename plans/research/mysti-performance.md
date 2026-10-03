# Mysti Performance Audit

Date: 2026-06-12 · Branch: `feature/visual-testing` (working tree, uncommitted Canvas v2 changes included)
Scope: activation, webview load, streaming hot path, persistence, process management, memory growth, bundle.

Measured baselines:
- `dist/extension.js`: **1,857,278 bytes** (webpack production), source map 4.5MB
- `src/webview/webviewContent.ts`: **664,159 bytes / 18,669 lines** (entire chat UI as a template string, bundled into extension.js); `canvasContent.ts` 284,043 bytes; `visualTestDashboardContent.ts` 23,564 bytes
- `resources/icons/`: **30.7MB** (22 decorative icons at ~1.4MB each); `mysti-0.4.0.vsix`: **33.8MB**
- `resources/`: mermaid.min.js 2.5MB (lazy), prism-bundle 88KB + marked 40KB (eager), fabric 308KB, Mysti-Logo.png 436KB
- 12 providers registered; `ProviderRegistry.initializeAll()` probes each serially at activation

---

## Ranked findings (by expected user-perceivable impact)

### F1. Streaming hot path: full markdown re-parse + whole-document Prism re-highlight on EVERY token delta (HIGH)

**Files:**
- `src/webview/webviewContent.ts:15631-15643` (`handleResponseChunk`)
- `src/webview/webviewContent.ts:15744-15760` (`updateCurrentContentSegment`)
- `src/webview/webviewContent.ts:18370-18399` (`formatContent`)
- `src/providers/claude/ClaudeCodeProvider.ts:227,277` (`--include-partial-messages`) and `:405-409` (`text_delta` → one chunk per token batch)
- `src/providers/ChatViewProvider.ts:2793-2798` (one `postMessage` per delta)

```js
// webviewContent.ts:15631
function handleResponseChunk(chunk) {
  console.log('[Mysti Webview] Received chunk:', JSON.stringify(chunk));   // per delta
  if (chunk.type === 'text') {
    currentResponse += chunk.content;
    var displayContent = stripChannelMarkers(currentResponse);             // regex over FULL text, per delta
    updateCurrentContentSegment(displayContent);                           // full re-render, per delta
  }
  ...
// webviewContent.ts:15758
segmentEl.innerHTML = formatContent(content);                              // full innerHTML swap
messagesEl.scrollTop = messagesEl.scrollHeight;                            // forced layout
// webviewContent.ts:18376-18384
var html = marked.parse(content);                                          // re-parse entire segment
setTimeout(function() {
  if (typeof Prism !== 'undefined') { Prism.highlightAll(); }              // re-highlights EVERY code block in the WHOLE document
  renderMermaidDiagrams();                                                 // re-scans whole DOM
}, 0);
```

**Why it's bad:** Claude Code is run with `--include-partial-messages`, so text arrives as token-level deltas (tens per second). Each delta triggers: extension→webview `postMessage`, `JSON.stringify` + `console.log`, a regex over the full accumulated text, a full `marked.parse` of the accumulated segment (O(n) per delta → O(n²) per response), a full `innerHTML` teardown/rebuild, a queued `Prism.highlightAll()` over the **entire conversation DOM** (so cost grows with conversation length, not just current response), a mermaid DOM scan, and a forced synchronous layout from the scroll write. There is **no throttling** on this path — yet the sub-agent path right next to it already implements the correct pattern (200ms throttle + `Prism.highlightAllUnder(el)`, `webviewContent.ts:9772-9791`).

**Observable impact:** CPU spikes and UI jank during every long response; progressively worse as the conversation accumulates code blocks; fans spin on large outputs.

**Fix:**
1. Throttle main-path renders to 100-200ms exactly like `handleSubAgentChunk` does.
2. Replace `Prism.highlightAll()` with `Prism.highlightAllUnder(segmentEl)`.
3. Run mermaid rendering only in `finalizeStreamingMessage`, not per chunk.
4. Drop/gate the per-chunk `console.log(JSON.stringify(chunk))` (15632) and `console.log` of thinking content (15639).
5. Optionally coalesce text deltas on the extension side (30-50ms buffer before `_postToPanel`) to cut IPC volume ~10x.

### F2. Sidebar open blocks on serial discovery + auth probing of all 11 providers — every panel, no cache (HIGH)

**Files:**
- `src/providers/ChatViewProvider.ts:404-420` (`_sendInitialState` awaits `getWizardStatus()` before sending anything; the webview shows the "Preparing your workspace..." overlay until then)
- `src/managers/SetupManager.ts:890-925` (`getWizardStatus`)
- `src/providers/ollama/OllamaProvider.ts:122-137,152-163` (HTTP fetch with **3s timeout** for both `discoverCli` and `checkAuthentication`; LocalAI is analogous)
- `src/utils/platform.ts:242-250` (`checkCommandExists` spawns `which` per provider as fallback)

```ts
// SetupManager.ts:900-907 — serial loop over ~11 providers
for (const provider of this._providerManager.getAllProviders()) {
  const discovery = await provider.discoverCli();          // fs probes + `which` spawn + HTTP fetch (Ollama/LocalAI)
  if (discovery.found) {
    const authStatus = await provider.checkAuthentication(); // more fs reads / another HTTP fetch
  }
  ...
```

**Why it's bad:** This runs on *every* `resolveWebviewView` and *every* new tab (`ChatViewProvider.ts:6064`), serially, with zero caching — even though `ProviderRegistry.initializeAll()` already ran the exact same `discoverCli()` for every provider at activation. Worst case (Ollama/LocalAI endpoint unreachable but not refusing): up to ~6s of spinner per local provider. Typical case: hundreds of ms of `which` spawns and stat calls before the first paint of usable UI.

**Fix:** Probe in parallel (`Promise.all`); cache discovery/auth results with a TTL (invalidate on settings change or wizard action); for initial state, only probe the *active* provider and load the rest lazily when the wizard/provider picker is actually opened.

### F3. Activation blocks on serial provider initialization (HIGH)

**File:** `src/extension.ts:82` and `src/providers/ProviderRegistry.ts:106-123`, `src/providers/base/BaseCliProvider.ts:192-199`, `src/utils/platform.ts:108-182`

```ts
// extension.ts:82 — top of activate(), before the webview provider is registered (line 171)
await providerManager.initialize();
// ProviderRegistry.ts:113-120 — strictly serial
for (const provider of this._providers.values()) {
  await provider.initialize();   // discoverCli(): fs.existsSync/readdirSync over ~/.nvm versions,
}                                // accessSync over 10-15 candidate paths, `which` spawn, HTTP fetch (Ollama/LocalAI, 3s timeout)
```

**Why it's bad:** Activation (and therefore command/view registration) waits for 11 serial CLI discoveries — sync filesystem walks of NVM version dirs per provider, process spawns, and network fetches. Combined with the very broad `activationEvents` (`package.json:62-82`: `workspaceContains:.claude/**`, `.gemini/**`, `.openai/**`, `.qwen/**` etc.), Mysti activates eagerly in any repo containing those dirs — i.e., most AI-assisted repos — and the `**` glob patterns themselves force VS Code to run workspace file searches during startup.

**Fix:** Register the webview provider and commands *first*, then kick off `providerManager.initialize()` in the background (no `await`, or `Promise.all`). Narrow `workspaceContains` triggers to exact files (e.g., `.claude/settings.json`) or drop them — `onStartupFinished` plus view activation already covers the real use cases.

### F4. 30.7MB of decorative PNGs: 33MB VSIX, ~30MB of image decode in the webview (HIGH)

**Files:** `resources/icons/` (22 files, 1.38-1.50MB each, e.g. `globe.png` 1,495,939 bytes); referenced in `src/webview/webviewContent.ts:28-36` (ICON_URIS), `:10557` (welcome cards), `:11048` (persona cards). Not excluded by `.vscodeignore`; `mysti-0.4.0.vsix` = 33,836,555 bytes.

**Why it's bad:** These are multi-megapixel PNGs rendered at icon size (~20-32px). The welcome screen — the first thing every user sees — makes the webview fetch and decode ~30MB of images, inflating webview memory and time-to-interactive. They are also ~91% of the VSIX download.

**Fix:** Downscale to ≤64px (or convert to SVG). Expected: icons total ~100-300KB, VSIX ~3MB, visibly faster welcome render.

### F5. Conversation persistence: whole store rewritten per message; messages embed full file contents; unbounded growth (MEDIUM-HIGH)

**Files:**
- `src/managers/ConversationManager.ts:613-624` (`_saveConversations` serializes **all** conversations to `globalState` on every `addMessage`, title update, settings change, agent-config change)
- `src/managers/ContextManager.ts:64-73` (`ContextItem.content` = full file text)
- `src/providers/ChatViewProvider.ts:2382-2388` (per-user-message `context` stored into the conversation)
- `src/providers/ChatViewProvider.ts:1196-1202, 1275-1281` (`getAllConversations()` — full messages — posted to the webview just to render the history dropdown)

```ts
// ConversationManager.ts:613
private async _saveConversations(): Promise<void> {
  await this._extensionContext.globalState.update('mysti.conversations', {
    conversations: Array.from(this._conversations.entries()),   // EVERYTHING, every time
    ...
```

**Why it's bad:** Each user message stores its context items *including full file contents*. There is no cap or pruning of conversations anywhere in the manager (verified: full file read). So `mysti.conversations` grows without bound, and every single message append re-serializes the entire store (JSON stringify of potentially tens of MB) on the extension host thread, plus a state-DB write. The history dropdown ships the same full payload over `postMessage`.

**Fix:** Store context references (path + line range + hash) instead of content; cap stored conversations (e.g., 50) and/or move bodies to `globalStorageUri` files loaded lazily; debounce saves; send only `{id,title,updatedAt,provider}` for the history menu.

### F6. Extension-side per-delta scans of the full accumulated response (MEDIUM)

**Files:** `src/providers/ChatViewProvider.ts:2800-2824` (ChannelBridge `detectMarkers` — three global regexes over `assistantContent` per text delta; gated by `isIntegrationEnabled()`), `:2826-2852` + `:4983-4991` (`_detectVisualTestTrigger` — regex over full accumulated content per delta, **not gated by any setting**), and webview `stripChannelMarkers` per delta (`webviewContent.ts:15636,16053-16055`).

```ts
// ChatViewProvider.ts:2828 — runs on every text delta until a trigger fires
const trigger = this._detectVisualTestTrigger(assistantContent);
// :4984
const match = content.match(/```visual-test\s*\n([\s\S]*?)```/);
```

**Why it's bad:** O(response²) regex work on the extension host during streaming, stacked on top of F1. For a 100KB response with ~1k deltas that is ~50MB of text scanned for the visual-test regex alone.

**Fix:** Only scan when the latest delta contains a closing token (`>>>` / triple backtick), or scan a bounded tail window (marker length is bounded); track a "scanned up to" offset.

### F7. Unconditional scroll-to-bottom, no user-scroll guard (MEDIUM)

**File:** `src/webview/webviewContent.ts` — 17 occurrences of `messagesEl.scrollTop = messagesEl.scrollHeight` (e.g., 15759, 15735, 9809); no `isAtBottom`/`userScrolled`/`stickToBottom` logic exists anywhere (grep verified).

**Why it's bad:** Each assignment forces synchronous layout per delta (amplifying F1), and the user is yanked to the bottom on every chunk — scrolling up to read earlier output during a long stream is impossible.

**Fix:** Track stickiness (`scrollHeight - scrollTop - clientHeight < threshold` before mutation), only auto-scroll when stuck, and coalesce scrolls in `requestAnimationFrame`.

### F8. DOM grows unbounded; history load schedules N whole-document highlight passes (MEDIUM)

**Files:** `src/webview/webviewContent.ts` — no virtualization/trimming of `#messages` (grep for trim/virtualize/MAX_MESSAGES: none); `formatContent` (18379-18384) schedules `Prism.highlightAll()` + `renderMermaidDiagrams()` per call, so rendering an N-message conversation queues N full-document passes.

**Fix:** `Prism.highlightAllUnder(messageEl)` per message; a single batch pass after history render; consider collapsing/windowing messages beyond ~100.

### F9. AgentLifecycleManager child-process events can never fire (MEDIUM, correctness)

**File:** `src/managers/AgentLifecycleManager.ts:302-312`

```ts
session.trackedChildPids = new Set([...allChildPids, ...aliveTracked]);  // set updated FIRST
const combinedPids = Array.from(session.trackedChildPids);
const hadChildren = session.trackedChildPids.size > 0;                   // computed from the NEW set
if (combinedPids.length > 0 && !hadChildren) {        // always false
  this._emitEvent('children-detected', ...);
} else if (combinedPids.length === 0 && hadChildren) { // always false
  this._emitEvent('children-cleared', ...);
}
```

**Why it's bad:** `hadChildren` is derived from the already-updated set, so `children-detected`/`children-cleared` lifecycle events are dead code — any UI/telemetry relying on them never updates. (Perf-adjacent note: `_scanChildren` spawns `pgrep` per idle session every 30s, which is acceptable.)

**Fix:** Capture `const hadChildren = session.trackedChildPids.size > 0` *before* reassigning the set.

### F10. ~950KB of webview template strings bundled into extension.js (LOW-MEDIUM)

**Files:** `src/webview/webviewContent.ts` (664KB) + `canvasContent.ts` (284KB) + `visualTestDashboardContent.ts` (24KB) compiled into `dist/extension.js` (1.86MB). The full HTML (~650KB) is rebuilt by string concatenation on each `resolveWebviewView`/tab/canvas open (`ChatViewProvider.ts:381,4839,5048,6011`).

**Why it's bad:** The extension host parses 1.86MB of JS at activation, half of which is inert UI markup; each panel open allocates ~650KB strings (minor). Maintainability cost is the larger issue.

**Fix:** Ship the webview HTML/CSS/JS as static files under `media/` loaded with `fs.readFile` (or `asWebviewUri` script tags) at resolve time; the bundle shrinks ~50% and the UI becomes editable/lintable as real files.

### F11. Always-on background intervals regardless of feature use (LOW)

**Files:**
- `src/managers/AgentLifecycleManager.ts:317-326` — 30s interval runs even with zero sessions (default `lifecycle.enabled: true`); body iterates an empty Map, so cost is tiny but it keeps the extension host timer-active.
- `src/managers/ChannelBridge.ts:140-145,478-484` — inbound polling (10s) started unconditionally in the constructor; ticks are no-ops when the Gateway is disconnected but still fire forever.
- `src/managers/ActiveModeManager.ts:329-335` — 30s status poll when connected (reasonable).

**Fix:** Start intervals on first session/connection, stop when count drops to zero/disconnect.

### F12. Per-delta webview logging and dependency hygiene (LOW)

- `webviewContent.ts:15632,15639`: `console.log(JSON.stringify(chunk))` per delta retains objects in DevTools and burns CPU (covered in F1 fix).
- `TelemetryManager.ts:70`: every telemetry event also `console.log`s unconditionally when enabled.
- `package.json:1449-1457`: `marked` and `prismjs` npm deps are unused in `src/` (vendored copies in `resources/` are what ship) — install-time bloat; `uuid` is replaceable by `crypto.randomUUID` (already used in ConversationManager); `playwright` is declared a dependency but `node_modules/**` is `.vscodeignore`d, so it never ships — handled gracefully at runtime (`BrowserManager.ts:39-55`) but the declaration is misleading.
- `VisualTestManager.ts:104`: `_activeTests.set(panelId, report)` has no corresponding delete — reports accumulate per test run (bounded in practice, unbounded in principle).

---

## Improvement opportunities (non-bug)

1. **Streaming renderer architecture:** parse only *completed* markdown blocks during streaming and append nodes, keeping the unstable tail as plain text — turns O(n²) into O(n) and eliminates innerHTML churn/flicker.
2. **Shared CLI discovery service:** one cached `CliDiscoveryService` (path + auth + version, TTL, event-invalidated) consumed by ProviderRegistry, SetupManager and the wizard, instead of three independent probe paths.
3. **Extension-side delta coalescing:** buffer `text`/`thinking` chunks 30-50ms in `ChatViewProvider` before `_postToPanel` — ~10x fewer IPC messages with no perceptible latency change.
4. **Webview as static assets:** moves 950KB out of the bundle, enables HTML/CSS/JS tooling, syntax checking, and code review of UI changes (today an 18.7k-line template string).
5. **Conversation storage redesign:** per-conversation JSON files under `globalStorageUri`, lazy-loaded; `globalState` keeps only an index. Removes write amplification and the multi-MB history `postMessage`.
6. **Message list virtualization** for conversations beyond ~100 messages.
7. **Status-bar provider label map** (`extension.ts:566-577`) is missing the 5 newer providers (opencode/qwen/ollama/localai/manus) — falls back to raw id; trivial polish.

## Notable strengths

- **Mermaid (2.5MB) is lazy-loaded** only when a diagram appears (`webviewContent.ts:9086-9108`) — exactly the right pattern.
- **Sub-agent streaming is already throttled** at 200ms with `Prism.highlightAllUnder` (`webviewContent.ts:9772-9791`) — the fix for F1 has an in-repo template.
- **Base64 attachment data is stripped before persistence** (`ChatViewProvider.ts:2377-2381`) — deliberate and documented.
- **Persistent process pre-spawn** (`ChatViewProvider.ts:401,3726-3749`) hides CLI cold-start from first-message latency, with health checks in `BaseCliProvider`.
- **`retainContextWhenHidden: true`** (`extension.ts:176-178`) avoids webview rebuilds on sidebar hide/show.
- **Panel dispose cleanup is thorough** (`ChatViewProvider.ts:6033-6061`): processes cancelled, per-panel maps and contexts cleared, persistent processes disposed.
- **Bounded sets where it matters:** `ChannelBridge._processedMessageIds` trimmed at 500→250 (`ChannelBridge.ts:667-670`); `MemoryManager._prune()` with confidence decay; `_panelFilesRead/Written` cleared per response (`ChatViewProvider.ts:2035-2036`).
- **Production webpack build** with source maps excluded from the VSIX; heavy `ws` natives externalized.
- **ChannelBridge marker scanning gated** by `isIntegrationEnabled()` so OpenClaw-off users skip that cost.
- **Deliberate deferrals:** workspace-recommendation prompt delayed 30s (`extension.ts:482-497`); ProjectContextManager/ActiveModeManager initialize fire-and-forget with `.catch`.
