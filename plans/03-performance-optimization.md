# Performance Optimization Plan — Mysti

- **Title:** Performance Optimization (activation, first-paint, streaming, persistence, hygiene, bundle)
- **Date:** undefined
- **Status:** DRAFT
- **Source research:** `/tmp/mysti-planning/research/mysti-performance.md`, `/tmp/mysti-planning/research/mysti-webview-chat.md`
- **Branch context:** `feature/visual-testing` (uncommitted Canvas v2 changes included in all line refs)

## Goal

Make Mysti feel instant on the paths users hit constantly — extension activation, opening the sidebar, and watching a response stream — and stop the slow-degradation paths (conversation store growth, unbounded DOM, leaked timers) before they become support tickets. Every improvement must be provable: Phase 1 builds the instrumentation first, so each later phase lands with a before/after number against a recorded baseline.

Target budgets (validated/adjusted after Phase 1 baselines):

| Metric | Baseline (expected) | Target |
|---|---|---|
| Activation time (`activate()` wall time) | ~1–6s (serial CLI discovery, worst case with unreachable Ollama/LocalAI endpoints) | < 200ms to interactive; discovery fully backgrounded |
| Sidebar time-to-usable (resolveWebviewView → composer interactive) | hundreds of ms to ~6s (serial wizard probing + 30MB icon decode) | < 300ms with cached discovery |
| Time-to-first-token render (send → first text painted) | unmeasured end-to-end (extension-side `_t0` logs exist) | instrumented; no regression from streaming changes |
| Chunk render cost p95 (webview) | unmeasured; O(n²) full re-parse + whole-document highlight per delta | < 10ms p95 at 10k-char responses; flat w.r.t. conversation length |
| Per-message persistence write | full store re-serialize (potentially tens of MB) | ≈ size of one conversation body; debounced |
| Webview heap growth across 10 long responses | unmeasured | < 20MB drift, returns to baseline after GC |
| VSIX size | 33.8MB (`mysti-0.4.0.vsix`) | < 4MB |
| `dist/extension.js` | 1,857,278 bytes | < 950KB (webview assets extracted) |

## Current State

All findings code-confirmed on the working tree.

### Activation

- `src/extension.ts:81` — `await providerManager.initialize()` runs at the top of `activate()`, **before** the webview provider is registered at `src/extension.ts:171-181`. Commands and the view are unavailable until all providers are probed.
- `src/providers/ProviderRegistry.ts:106-123` — `initializeAll()` loops **serially** over 12 providers; each `initialize()` → `discoverCli()` does sync fs walks of NVM version dirs, `accessSync` over 10–15 candidate paths, a `which` spawn fallback (`src/utils/platform.ts:242-250`), and — for Ollama/LocalAI — an HTTP fetch with a **3s timeout** (`src/providers/ollama/OllamaProvider.ts:122-137,152-163`).
- `package.json:62-82` — `activationEvents` include `workspaceContains:.claude/**`, `.gemini/**`, `.openai/**`, `.openclaw/**`, `.qwen/**`, `.mysti/rules/**`. The `**` globs force VS Code to run workspace file searches at startup, and Mysti activates eagerly in essentially every AI-assisted repo.

### Webview first-paint

- `src/providers/ChatViewProvider.ts:404-420` — `_sendInitialState` awaits `_agentInitPromise` then `this._setupManager.getWizardStatus()` before posting anything; the webview shows the "Preparing your workspace..." overlay the whole time.
- `src/managers/SetupManager.ts:900-925` — `getWizardStatus()` loops **serially** over all providers calling `discoverCli()` + `checkAuthentication()` (a second HTTP fetch for Ollama/LocalAI) with **zero caching**, on **every** `resolveWebviewView` and every new tab (`ChatViewProvider.ts:6064`) — duplicating what `ProviderRegistry.initializeAll()` already did at activation.
- `resources/icons/` — **30.7MB**, 22 decorative PNGs at ~1.4MB each (e.g., `globe.png` 1,495,939 bytes; verified `du -sh` = 30M). Referenced from `src/webview/webviewContent.ts:28-36` (ICON_URIS), `:10557` (welcome cards), `:11048` (persona cards). The welcome screen — the first thing every user sees — decodes ~30MB of multi-megapixel images rendered at ~20–32px.
- `src/webview/webviewContent.ts` — **664,159 bytes / 18,669 lines** of chat UI as a single template string compiled into `dist/extension.js`; plus `canvasContent.ts` (284KB) and `visualTestDashboardContent.ts` (24KB). ~950KB of inert UI markup is parsed by the extension host at activation, and ~650KB of string is re-concatenated on every panel open (`ChatViewProvider.ts:381,4839,5048,6011`).

### Streaming render path

- Claude runs with `--include-partial-messages` (`src/providers/claude/ClaudeCodeProvider.ts:227,277`), so text arrives as token-level deltas, each forwarded as an individual `postMessage` (`src/providers/ChatViewProvider.ts:2793-2798`).
- `src/webview/webviewContent.ts:15631-15643` (`handleResponseChunk`) — per delta: `console.log(JSON.stringify(chunk))`, `stripChannelMarkers` regex over the **full accumulated text**, then `updateCurrentContentSegment`.
- `src/webview/webviewContent.ts:15744-15760` (`updateCurrentContentSegment`) — full `innerHTML` swap of the segment + `messagesEl.scrollTop = messagesEl.scrollHeight` (forced synchronous layout).
- `src/webview/webviewContent.ts:18370-18399` (`formatContent`) — `marked.parse(content)` re-parses the **entire accumulated segment** per delta (O(n²) per response) and schedules `Prism.highlightAll()` — which re-highlights **every code block in the whole document**, so cost grows with conversation length — plus a `renderMermaidDiagrams()` DOM scan.
- **No throttling on this path**, yet the correct pattern already exists 6,000 lines away: the sub-agent path throttles renders at 200ms and uses `Prism.highlightAllUnder(el)` (`src/webview/webviewContent.ts:9772-9791`).
- Extension-side per-delta scans of the full accumulated response: `_detectVisualTestTrigger` (`ChatViewProvider.ts:2826-2852`, regex at `:4983-4991`) runs unconditionally per text delta; ChannelBridge `detectMarkers` (`ChatViewProvider.ts:2800-2824`) runs three global regexes per delta when integration is enabled.
- Scrolling: 17 occurrences of `messagesEl.scrollTop = messagesEl.scrollHeight` (grep-verified); no `isAtBottom`/stick-to-bottom guard anywhere — users are yanked to the bottom on every chunk and cannot scroll up during a stream.
- Long conversations: no virtualization or trimming of `#messages`; history load calls `formatContent` per message, queueing N whole-document `Prism.highlightAll()` + mermaid passes for an N-message conversation (`webviewContent.ts:18379-18384`).

### Persistence

- `src/managers/ConversationManager.ts:613-624` — `_saveConversations()` serializes **all** conversations to `globalState` (`mysti.conversations` key) on every `addMessage`, title update, settings change, and agent-config change. No cap, no pruning (verified by full-file read).
- `src/providers/ChatViewProvider.ts:2382-2388` — each user message persists its context items **including full file contents** (`ContextItem.content` = full file text, `src/managers/ContextManager.ts:64-73`).
- `src/providers/ChatViewProvider.ts:1196-1202` and `:1275-1281` — the history dropdown ships `getAllConversations()` (full message bodies) over `postMessage` just to render a menu.

### Process / memory hygiene

- `src/managers/AgentLifecycleManager.ts:302-312` — `hadChildren` is computed from the **already-updated** `trackedChildPids` set, so `children-detected`/`children-cleared` events are dead code.
- `src/managers/AgentLifecycleManager.ts:317-326` — 30s sweep interval runs even with zero sessions; `src/managers/ChannelBridge.ts:140-145,478-484` — 10s inbound polling started unconditionally in the constructor, ticking forever even when the Gateway is disconnected.
- `src/managers/VisualTestManager.ts:104` — `_activeTests.set(panelId, report)` with no corresponding delete.
- `src/managers/TelemetryManager.ts:70` — unconditional `console.log` per telemetry event when enabled.
- (Cross-plan: `ChildProcess.killed` misread makes every SIGKILL escalation dead code across providers — owned by the provider-layer plan; Phase 7 here only verifies the result via heap/process metrics.)

### Bundle

- `mysti-0.4.0.vsix` = 33,836,555 bytes; ~91% is `resources/icons/`.
- `package.json` declares `marked` and `prismjs` npm deps that are unused in `src/` (vendored copies in `resources/` are what ship); `uuid` is replaceable by `crypto.randomUUID` (already used in ConversationManager); `playwright` is declared a dependency but `.vscodeignore`d so it never ships (handled gracefully at `src/managers/BrowserManager.ts:39-55`).

### Existing strengths to preserve (do not regress)

- Mermaid (2.5MB) lazy-loads only when a diagram appears (`webviewContent.ts:9086-9108`).
- Persistent process pre-spawn hides CLI cold-start (`ChatViewProvider.ts:401,3726-3749`).
- `retainContextWhenHidden: true` (`extension.ts:176-178`); thorough tab-panel dispose cleanup (`ChatViewProvider.ts:6033-6061`).
- Base64 attachment data stripped before persistence (`ChatViewProvider.ts:2377-2381`).
- Ad-hoc `_t0` timing logs already exist in the send path (`ChatViewProvider.ts:2350,2408,2444,2721,2757,2786-2788`) — Phase 1 formalizes them.

## Proposed Design

Five design moves, each provable via Phase 1 instrumentation:

1. **A `PerfTracker` utility + webview perf harness** as permanent, cheap infrastructure (no-op unless `mysti.debug.performanceLogging` is on, except a handful of always-on coarse marks reported through the existing TelemetryManager opt-in). All later phases cite its numbers.
2. **Background everything at startup; cache discovery.** `activate()` registers UI first and fires provider init in parallel without awaiting. A single `CliDiscoveryService` (path + auth + version, TTL, event-invalidated) replaces the three independent probe paths (ProviderRegistry, SetupManager wizard, ChatViewProvider initial state). The sidebar paints from cache and refreshes asynchronously.
3. **Extract the webview into real static assets and split it.** `webviewContent.ts` becomes `media/chat/{index.html,chat.css,chat.js}` loaded at resolve time with the existing nonce; a dedicated webview bundling step (esbuild — binding decision, see Phase 3c) produces a boot-critical main chunk plus on-demand chunks (wizard, brainstorm timeline, settings). This removes ~950KB from the extension bundle, makes the UI lintable/testable, and is the precondition for sane streaming-renderer work.
4. **An O(n) streaming renderer.** Extension-side delta coalescing (30–50ms buffer, flush-before-anything-non-text), webview-side 150ms render throttle (cloning the proven sub-agent pattern), scoped `Prism.highlightAllUnder(segmentEl)`, mermaid only at finalize, incremental markdown via a stable-prefix/unstable-tail split, stick-to-bottom scroll guard, and message windowing past ~60 rendered messages.
5. **Index + per-conversation-file persistence.** `globalState` keeps only a slim index; conversation bodies live as individual JSON files under `globalStorageUri`, written debounced and only when dirty; messages store context **references** (path/range/hash), not file contents; the history dropdown receives index entries only.

## Implementation Phases

### Phase 1 — Measurement & Instrumentation (FIRST; everything else cites these numbers)

**Metrics defined:**

| Metric | Definition | Instrument |
|---|---|---|
| `activation.total` | `activate()` entry → return | mark/measure in `extension.ts` |
| `activation.providerInit` | `providerManager.initialize()` duration (even once backgrounded) | mark in `ProviderRegistry.initializeAll` |
| `panel.timeToUsable` | `resolveWebviewView` → webview posts `uiReady` (composer interactive, first rAF after init render) | extension mark + webview reply |
| `send.ttftRender` | `_handleSendMessage` entry → webview paints first text chunk (rAF after first `innerHTML` set) | extension `_t0` + webview `perfMark` round-trip; report both extension-side TTFT (first chunk received, already logged at `ChatViewProvider.ts:2786-2788`) and end-to-end render |
| `render.chunk.p95` | per-`handleResponseChunk` cost: `performance.now()` before → after synchronous work, plus a rAF-completion sample | webview ring buffer (last 2,000 samples), percentile summary posted at `done` |
| `heap.ext` / `heap.webview` | `process.memoryUsage().heapUsed` (extension host) and `performance.memory.usedJSHeapSize` (webview, Chromium API available there) | sampled at activation/init, after each `done`, and every 60s while a panel is open; log deltas |
| `bundle.sizes` | `dist/extension.js`, VSIX, `resources/` subtotals | build script |

**Tasks:**

1. Create `src/utils/PerfTracker.ts`: `mark(name)`, `measure(name, fromMark)`, `sample(name, ms)` ring buffers, `percentile(name, p)`, `report()`; gated by new setting `mysti.debug.performanceLogging` (default false) — when off, everything is a no-op except `activation.total`, `panel.timeToUsable`, `send.ttftRender` coarse marks. Logs with prefix `[Mysti][perf]`.
2. Modify `package.json`: add `mysti.debug.performanceLogging` boolean setting.
3. Modify `src/extension.ts`: wrap `activate()` with `PerfTracker.mark('activation.start')` / `measure('activation.total')`; sub-measures around `providerManager.initialize()` (line 81) and manager construction.
4. Modify `src/providers/ProviderRegistry.ts`: per-provider `initialize()` duration samples inside `initializeAll()` (lines 106-123) so the slowest CLI probes are identifiable by name.
5. Modify `src/providers/ChatViewProvider.ts`: convert the ad-hoc `_t0` console logs (lines 2350, 2408, 2444, 2721, 2757, 2786-2788) into `PerfTracker` measures; on the **first** text `responseChunk` per response, attach `payload.perfSentAt = Date.now()`; mark `resolveWebviewView` entry and complete `panel.timeToUsable` when the webview's `uiReady` arrives.
6. Modify `src/webview/webviewContent.ts`: add a perf block (no library): time `handleResponseChunk` bodies into a ring buffer; on first painted chunk, post `{type:'perfMark', name:'firstChunkRendered', sentAt: payload.perfSentAt}` after `requestAnimationFrame`; post `uiReady` after initial render rAF; on `done`, post `perfReport` `{chunkCount, p50, p95, max}`; sample `performance.memory.usedJSHeapSize` at init/per-done/60s and include in `perfReport`.
7. Modify `src/managers/TelemetryManager.ts`: accept an aggregate `perf` event (respecting the existing telemetry opt-in) carrying only coarse numbers (activation ms, ttft ms, p95).
8. Create `scripts/perf-sizes.js` + npm script `perf:sizes`: prints `dist/extension.js` bytes, latest `.vsix` bytes, `resources/icons` and `resources/` totals; exits nonzero if over configurable limits (used in Phase 8 as CI guard).
9. Record baselines: run a fixed manual scenario (cold reload → activation; open sidebar; send a prompt producing ≥10k chars with ≥3 code blocks; reload a 100-message conversation) and commit numbers to `plans/perf-baselines.md`.

**Exit criteria:** baseline table committed; every metric above produces a number on demand.

### Phase 2 — Activation time

1. Modify `src/extension.ts` (line 81): replace `await providerManager.initialize()` with fire-and-forget `providerManager.initialize().catch(err => console.error('[Mysti] Provider init failed:', err))`; move webview provider + command registration (currently lines 171+) to run unconditionally before/independently of provider init. Audit everything between lines 81–171 for hard dependencies on initialized providers (SetupManager construction takes the manager reference, not results — fine; status bar provider label at `extension.ts:566-577` reads config, not discovery — fine).
2. Modify `src/providers/ProviderRegistry.ts` (lines 106-123): `initializeAll()` → `await Promise.allSettled([...this._providers.values()].map(p => p.initialize()))`; add a `public readonly whenReady: Promise<void>` resolved when `initializeAll` settles, and an `onProviderReady` event for incremental consumers.
3. Modify `src/managers/ProviderManager.ts`: expose `whenReady` passthrough; any call path that needs discovery results (`SetupManager.getWizardStatus`, wizard handlers) awaits `whenReady` or uses the Phase 3 cache.
4. Modify `src/utils/platform.ts`: memoize `findNodeDir()` / NVM directory walk results at module level (per process lifetime) — currently re-walked per provider.
5. Modify `src/providers/ollama/OllamaProvider.ts` (lines 122-137, 152-163) and the LocalAI analogue: reduce discovery fetch timeout from 3s to 1s, and skip the fetch entirely during background init when the configured endpoint equals the default and a previous attempt failed within the TTL (defer to first actual use / wizard refresh).
6. Modify `package.json` `activationEvents` (lines 62-82): remove all `**` glob entries (`.mysti/rules/**`, `.claude/**`, `.gemini/**`, `.openai/**`, `.openclaw/**`, `.qwen/**`); replace with exact files where the trigger is genuinely needed (e.g., `workspaceContains:.claude/settings.json`) or rely on `onStartupFinished` alone.

**Exit criteria:** `activation.total` < 200ms on the baseline machine; no network I/O or `which` spawns inside the awaited portion of `activate()`; per-provider init durations visible in perf log.

### Phase 3 — Webview first-paint + webview asset architecture

**3a. Cached discovery (kills the "Preparing your workspace" stall):**

1. Create `src/services/CliDiscoveryService.ts`: `getStatus(providerId)` / `getAllStatuses()` returning `{found, path, version, authenticated, checkedAt}` from an in-memory map with TTL (default 5 min); `refresh(providerId?)` forces re-probe (parallel, `Promise.allSettled`); invalidation hooks: `mysti.*` settings change (`vscode.workspace.onDidChangeConfiguration`), wizard install/auth actions, manual refresh button. Seed the cache from `ProviderRegistry.initializeAll()` results so panel opens never re-probe.
2. Modify `src/managers/SetupManager.ts` (lines 900-925): `getWizardStatus()` reads from `CliDiscoveryService` (parallel refresh only on cache miss/expiry); add `getWizardStatusCached()` that returns immediately and emits an update event when a background refresh completes.
3. Modify `src/providers/ChatViewProvider.ts` (`_sendInitialState`, lines 404-420): post `initialState` immediately using cached statuses (probe **only the active provider** synchronously if its cache entry is missing); post a follow-up `providerAvailability` message when the background refresh lands; webview renders the composer immediately and updates provider badges asynchronously. While here, include `panelId` in the `showWizard` payload (the wizard `panelId=null` bug is owned by the chat-UX plan — coordinate, don't double-fix).
4. Modify `src/webview/webviewContent.ts`: handle the late `providerAvailability` message; remove the assumption that provider statuses are final at `initialState`.

**3b. Icon de-bloat (also the bulk of Phase 8's VSIX win):**

5. Downscale `resources/icons/*.png` (22 files, ~1.4MB each) to ≤128px (2x of the ~32–64px render size) via `sips`/`pngquant`, or replace with SVGs; commit optimized assets at the same paths (no code changes needed; verify `webviewContent.ts:28-36,10557,11048` render unchanged). Add `loading="lazy"` to welcome/persona card `<img>` tags.

**3c. Extract the 18.7k-line embedded HTML into static assets (bundling/splitting strategy):**

> **Binding cross-plan decisions** (these resolve Open Questions 1 and 8 below and must be mirrored in Plans 02 and 05 — one owner per decision, no re-litigating at implementation time):
>
> 1. **Canvas webview extraction is owned by Plan 05 Phase 1.6, not this plan.** `canvasContent.ts` is removed from Phase 3c scope (see task 8). Plan 05 performs its extraction as TS modules per its own design, but builds them with the bundler chosen in decision 2 — its current "second webpack entry → `dist/canvasWebview.js`" wording is superseded; output goes to `media/canvas/` via the shared webview build step. (Plan 05's Coordination section already defers bundling conventions to this plan.)
> 2. **Bundler: esbuild, once, for all webviews.** A single `scripts/build-webview.mjs` (esbuild) produces every webview bundle — chat chunks under `media/chat/` (Step 2 below), the visual-test dashboard, and later Plan 05's canvas bundle. webpack remains for the extension-host bundle (`dist/extension.js`) only; no second webpack config is added anywhere.
> 3. **Ordering contract vs Plan 02 (unified chat experience):** Plan 02 Phases 2–3 — the ~17 in-place provider-seam edits to `webviewContent.ts` and its provider-literal CI guard (`scripts/check-provider-literals.js`) — land **before** Phase 3c Step 1 begins here. Rationale: those edits and the guard are keyed to `webviewContent.ts` line references and filename; extracting mid-stream would invalidate every reference and the guard target. After Step 2 lands, this plan retargets the CI guard to the extracted tree (task 9). If Plan 02 Phases 2–3 slip past this plan's 3c window, the explicit fallback is the reverse order — extract first, Plan 02 re-derives its seam references against `src/webview-src/chat/` and the guard is created pointing there — but one order must be chosen at kickoff; interleaving extraction with the seam edits is not allowed. This also answers Plan 02's Open Question 2 (extraction happens after its Phases 2–3, in this plan).

6. **Step 1 (mechanical extraction, no behavior change):** split `src/webview/webviewContent.ts` into `media/chat/index.html` (markup + `{{nonce}}`/`{{cspSource}}`/`{{resourceBase}}` placeholders), `media/chat/chat.css`, `media/chat/chat.js` (the embedded script verbatim). Rewrite `getWebviewContent()` to `fs.readFileSync` the template once (cache in a module-level string), substitute placeholders, and emit `<script nonce="..." src="${asWebviewUri(chat.js)}">`. CSP keeps `script-src 'nonce-...'` — external scripts carry the nonce. Update webpack config so `media/` is copied, not bundled; confirm `dist/extension.js` drops by ~650KB.
7. **Step 2 (real modules + splitting):** convert `media/chat/chat.js` into TypeScript sources under `src/webview-src/chat/` (e.g., `boot.ts`, `messaging.ts`, `renderer/markdown.ts`, `renderer/stream.ts`, `wizard.ts`, `brainstorm.ts`, `settings.ts`) and add a second build step (esbuild — decided, binding decision 2 above: `scripts/build-webview.mjs`, wired into `npm run compile` and `watch`) producing `media/chat/chat.js` plus lazy chunks `media/chat/wizard.js`, `media/chat/brainstorm.js`, `media/chat/settings.js`. Lazy loading inside a nonce-CSP webview: inject `<script nonce src>` tags on demand (the boot chunk knows the nonce via a data attribute) — avoid webpack dynamic `import()` publicPath complexity. The boot-critical chunk contains only: state init, postMessage bridge, message list rendering, streaming renderer, composer.
8. Apply the same extraction (Step 1 only) to `visualTestDashboardContent.ts` (24KB) — `media/vt-dashboard/`. `canvasContent.ts` (284KB) is **removed from this plan's scope** per binding decision 1 above: Plan 05 Phase 1.6 owns the canvas webview extraction and builds it with the shared esbuild step from decision 2.
9. Add ESLint coverage for the new `src/webview-src/` tree (separate tsconfig with `dom` lib); retarget Plan 02's provider-literal CI guard (`scripts/check-provider-literals.js`) from `webviewContent.ts` to `src/webview-src/chat/` as part of this step (per binding decision 3 above).

**Exit criteria:** `panel.timeToUsable` < 300ms warm (cache hit); no serial provider probing on panel open (verify via perf log); `dist/extension.js` < 950KB; welcome screen image transfer < 300KB total.

### Phase 4 — Streaming render path (chunk batching + incremental markdown)

**Extension side:**

1. Modify `src/providers/ChatViewProvider.ts` (`_handleSendMessage` stream loop, around lines 2786-2800): add a per-panel `StreamCoalescer` (small inline class or `src/utils/StreamCoalescer.ts`) buffering consecutive `text` chunk content (and separately `thinking`) for 40ms or 2KB, whichever first, then posting one `responseChunk`. **Flush rules (ordering-critical):** flush before forwarding any non-text chunk type, before the permission gate (`_shouldGateToolUse`), before `done`, on cancel, and in the stream `catch`/`finally`. The first text chunk of a response is posted immediately (don't add 40ms to TTFT) — coalescing starts after.
2. Modify `src/providers/ChatViewProvider.ts` (`_detectVisualTestTrigger` call site lines 2826-2852, regex at 4983-4991): only run the regex when the latest delta contains a backtick, and scan from a tracked `scannedUpTo` offset minus a 64-char overlap window instead of the full `assistantContent`. Apply the same bounded-tail discipline to the ChannelBridge `detectMarkers` call (lines 2800-2824): only invoke when the delta contains a marker sigil; markers have bounded length, so scan only the unscanned tail + overlap.

**Webview side (in the Phase 3 extracted `renderer/stream.ts`; if Phase 3 Step 2 is not yet done, apply to `webviewContent.ts` directly — the changes are identical):**

3. `handleResponseChunk` (currently `webviewContent.ts:15631-15643`): delete the per-delta `console.log(JSON.stringify(chunk))` (15632) and thinking log (15639), or gate behind the Phase 1 perf flag. Accumulate `currentResponse` and schedule a render via a 150ms throttle timer — exact clone of the sub-agent pattern at `webviewContent.ts:9772-9791` — with a guaranteed final flush in `finalizeStreamingMessage` (17216-17241).
4. `formatContent` (18370-18399): remove the embedded `setTimeout(Prism.highlightAll + renderMermaidDiagrams)` entirely; make `formatContent` a pure markdown→HTML function. Callers become responsible for highlighting: `updateCurrentContentSegment` runs `Prism.highlightAllUnder(segmentEl)` after the innerHTML set; mermaid rendering and one final full-segment highlight run **only** in `finalizeStreamingMessage`. Audit all `formatContent` call sites (history render, addMessage at 15551-15602, sub-agent paths) and add the scoped highlight call where needed.
5. Incremental markdown (stable-prefix rendering): in the streaming segment, maintain `stableOffset` — the index of the last `\n\n` that is **outside an open code fence** (track fence state by counting ` ``` ` occurrences up to the candidate). On each throttled render: (a) if `stableOffset` advanced, parse only the newly stabilized slice with `marked.parse` and append the resulting nodes to a `committed` container (highlight only the new nodes via `Prism.highlightAllUnder(newNodes)`); (b) re-parse only the unstable tail (`text.slice(stableOffset)`) into a separate `tail` element. At finalize, discard committed/tail and do one full `marked.parse` of the complete text as ground truth (this also self-heals any boundary mis-render). This turns per-delta cost from O(total) to O(tail).
6. Scroll stickiness: add helpers `isNearBottom()` (`scrollHeight - scrollTop - clientHeight < 80`, read **before** mutation) and `scrollToBottomIfStuck()` (write inside `requestAnimationFrame`, coalesced). Replace all 17 `messagesEl.scrollTop = messagesEl.scrollHeight` occurrences (e.g., 15759, 15735, 9809). User scrolling up during a stream must stick; a "Jump to bottom ↓" pill appears when unstuck with new content.

**Exit criteria (vs Phase 1 baseline):** `render.chunk.p95` < 10ms on the 10k-char scenario and **independent of prior conversation length** (verify by re-running with 100 prior messages); extension→webview message count for the scenario reduced ≥5x; zero `Prism.highlightAll()` (whole-document) calls during streaming; user can scroll up mid-stream.

### Phase 5 — Long-conversation DOM (windowing + history load)

1. History load batching: after Phase 4 task 4, rendering a restored conversation no longer queues N whole-document passes; add one `Prism.highlightAllUnder(messagesEl)` + one `renderMermaidDiagrams()` after the full history render loop completes (locate the conversation-restore render loop that calls `addMessage` per message in `webviewContent.ts` / extracted `renderer/`).
2. Message windowing (explicitly chosen over full virtual scrolling for v1): introduce `MAX_RENDERED_MESSAGES = 60`. On history load, render only the most recent 60; prepend a "Show earlier messages (N)" button that renders the previous 30 on click, preserving scroll position (record `scrollHeight` before prepend, adjust `scrollTop` by the delta after).
3. Live-trim: when a streaming conversation exceeds the window, collapse the oldest rendered message's body (`innerHTML = ''`, keep header + a "collapsed" class; raw markdown stays in `state.messages` for re-expand). Never collapse messages containing a pending permission card or active tool spinner.
4. Bound webview accumulators: cap `subagentRawText` entries and the Phase 1 perf ring buffers; clear per-response accumulators (`currentResponse`, `currentThinking`) at finalize.

**Exit criteria:** 500-message conversation restores in < 1s with bounded DOM node count (measure via perf flag); `heap.webview` flat after window trimming.

### Phase 6 — Persistence write amplification

1. Modify `src/managers/ConversationManager.ts`:
   - Debounce `_saveConversations` (lines 613-624): trailing 500ms, with immediate flush on extension `deactivate` and on conversation switch/delete. Keep the error-surfacing behavior.
   - Split storage: `globalState` keeps only `mysti.conversations.index` = `[{id, title, updatedAt, provider, messageCount}]` + `currentId`; bodies move to `context.globalStorageUri/conversations/<id>.json`, written **only for the dirty conversation** (track a dirty set). Lazy-load bodies on `setCurrentConversation`/restore. Constructor signature gains the `globalStorageUri` (threaded from `extension.ts`).
   - Migration: on first run, if legacy `mysti.conversations` blob exists → write per-conversation files → verify readback → write index → only then delete the legacy key. Schema-version field (`v: 2`) in each file.
   - Retention cap: keep the most recent `mysti.conversations.maxStored` (new setting, default 100); prune LRU on save.
2. Modify `src/providers/ChatViewProvider.ts` (lines 2382-2388): persist context **references** on messages — `{path, lineRange?, sizeBytes, contentHash}` — never `content`. First `grep -n 'context' src/managers/ConversationManager.ts src/webview/webviewContent.ts` for restore-path consumers of `message.context[].content` and switch them to render the chip from path/size only (providers receive full content at send time from `ContextManager`, so nothing functional needs the persisted copy).
3. Modify `src/providers/ChatViewProvider.ts` (history dropdown, lines 1196-1202 and 1275-1281): post index entries only (`{id,title,updatedAt,provider,messageCount}`); update the `conversationHistory` handler in the webview to consume the slim shape; conversation switch then requests the body (`loadConversation` message → extension reads the file → posts messages).
4. Add unit-testable seams: extract pure functions `serializeConversation`/`deserializeConversation` with version handling.

**Exit criteria:** appending one message writes ≈ one conversation body (verify by logging write sizes under the perf flag); history dropdown `postMessage` < 50KB regardless of history size; migration verified against a synthetic 50-conversation legacy blob.

### Phase 7 — Process & memory hygiene

1. Fix `src/managers/AgentLifecycleManager.ts:302-312`: capture `const hadChildren = session.trackedChildPids.size > 0;` **before** reassigning `session.trackedChildPids`, so `children-detected`/`children-cleared` events fire.
2. Modify `src/managers/AgentLifecycleManager.ts:317-326`: start the 30s sweep interval on first `registerSession`, `clearInterval` when the session map empties.
3. Modify `src/managers/ChannelBridge.ts:140-145,478-484`: start inbound polling only when the Gateway connects (or integration is enabled), stop on disconnect/disable.
4. Modify `src/managers/VisualTestManager.ts:104`: delete the `_activeTests` entry when a test run completes/fails and on panel dispose.
5. Modify `src/managers/TelemetryManager.ts:70`: gate the per-event `console.log` behind `mysti.debug.performanceLogging` (or a debug flag).
6. Verify with Phase 1 heap metrics: 10 consecutive long responses on one panel, then 10 panel open/close cycles — `heap.ext` and `heap.webview` return to within 20MB of baseline. If they don't, profile with the perf flag before adding fixes (the `ChildProcess.killed` SIGKILL dead-code fix lives in the provider-layer plan and is the most likely residual cause of leaked processes — confirm it landed).

**Exit criteria:** zero always-on timers with no work to do (inspect via `[Mysti][perf]` interval logs); heap criteria above met; lifecycle children events observed firing in a manual test.

### Phase 8 — Bundle size & dependency hygiene

1. Verify Phase 3b icon result: `resources/icons/` < 300KB; `npm run perf:sizes` reflects it.
2. Modify `package.json` dependencies: remove `marked` and `prismjs` (vendored copies in `resources/` are what ship — `grep -rn "from 'marked'\|require('marked')\|from 'prismjs'" src/` to confirm zero imports first); replace `uuid` usages with `crypto.randomUUID()` (grep `from 'uuid'`) and remove the dep; remove `playwright` from `dependencies` (it's `.vscodeignore`d and `BrowserManager.ts:39-55` already handles absence) — document the optional `npx playwright install` path in README instead.
3. Webpack: confirm webview sources are fully out of the extension bundle after Phase 3 (add a CI assertion via `perf:sizes` limits: `dist/extension.js` < 950KB, VSIX < 4MB).
4. Audit `.vscodeignore`: ensure `src/webview-src/`, `scripts/`, `plans/`, source maps, and any unoptimized asset originals are excluded; ensure `media/` **is** included.
5. Wire `perf:sizes --check` into the package step (`vscode:prepublish`) so size regressions fail the build.

**Exit criteria:** VSIX < 4MB; `dist/extension.js` < 950KB; `npm ls` clean of unused heavyweight deps; size check enforced at package time.

## Risks & Mitigations

| Risk | Phase | Mitigation |
|---|---|---|
| Backgrounding provider init breaks a consumer that silently assumed initialized providers (status bar, wizard, first send) | 2 | `whenReady` promise + audit of `extension.ts:81-171` consumers; first-send path already tolerates discovery (provider `sendMessage` re-resolves CLI path); manual matrix: cold start → immediate send on each of 3 providers |
| Chunk coalescing reorders or delays tool events past the permission gate (the gate is the **sole** enforcement point per the chat-layer research) | 4 | Hard flush-before-non-text rule, flush-before-gate, first-chunk-immediate; add a unit test on `StreamCoalescer` ordering; land after/with the permission-gate fixes from the chat plan |
| Incremental markdown mis-renders constructs spanning the stable boundary (tables, setext headings, nested lists) | 4 | Conservative boundary (`\n\n` outside fences); always re-render last committed block together with the tail if the tail starts with a continuation character (`|`, `=`, `-`, whitespace); authoritative full re-parse at finalize self-heals any drift |
| Webview extraction breaks CSP/nonce or panel restore (`retainContextWhenHidden`) | 3 | Step 1 is byte-identical script content, only relocated; nonce applied to external `<script>`; test sidebar + tab + move-between-containers + VS Code reload; keep the old inline path behind a temporary env flag for one release |
| Storage migration corrupts or loses conversation history | 6 | Write-then-verify-then-delete sequencing; legacy key retained until verified; schema version field; tested against synthetic legacy blobs (empty, 1, 50 conversations, oversized context payloads) |
| Context-reference persistence breaks a restore path that displayed file content | 6 | Grep-audit of `message.context` consumers before the change; chips render from path/size; release note |
| Windowing breaks in-page find / scroll anchoring / pending permission cards | 5 | Explicit "show earlier" batches (no IntersectionObserver recycling in v1); never collapse messages with active cards/spinners; scroll-delta compensation on prepend |
| Icon downscale looks soft on retina | 3 | Export at 2x render size (128px for 64px display); spot-check welcome screen on a retina display |
| Narrowed `activationEvents` stops activation in a repo where a user expected Mysti to auto-appear | 2 | `onStartupFinished` remains, which activates everywhere after startup; the globs only made activation *eager*, not *possible* |
| Lazy wizard/settings chunks fail to load offline-ish edge (file missing from VSIX) | 3 | Chunks are local files in `media/`; add a packaging test that opens each lazy surface once |

## Dependencies

Plan numbering of siblings is TBD at write time; dependencies are stated by topic (digest names in parentheses):

- **Provider-layer plan** (`mysti-providers`): owns the `ChildProcess.killed`/SIGKILL dead-code fix and per-provider lifecycle repairs. Phase 7's "no leaked processes" verification assumes those fixes; this plan does **not** duplicate them. No ordering constraint for Phases 1–6.
- **Chat/security plan** (`mysti-webview-chat`, `mysti-managers-core` — permission gate fail-open, wizard `panelId=null`, persistence of cancelled responses): Phase 4's coalescer touches the same stream-forwarding switch (`ChatViewProvider.ts:2786+`) as the gate fixes — coordinate to land gate fixes first or in the same series; Phase 3's `_sendInitialState` change must not collide with that plan's wizard-panelId fix (one owner — suggest they take it, we rebase). Phase 6's per-conversation file schema should be co-designed with that plan's "persist render-relevant message structure (toolCalls/segments)" item so the v2 schema is defined once.
- **Model-updates plan** (`model-updates`): Phase 3's `CliDiscoveryService` (cache + TTL + settings-invalidation) is the natural home for its runtime model-list discovery; expose the service with that consumer in mind.
- **Canvas plan** (`mysti-canvas-current`): Phase 3 Step 1 extraction of `canvasContent.ts` should be sequenced with any canvas rewrite to avoid churn — if the canvas plan rewrites the file wholesale, skip its extraction here. **RESOLVED (Phase 3c binding decision 1):** `canvasContent.ts` extraction is dropped from this plan; Plan 05 Phase 1.6 owns it, performed as TS modules built by the shared esbuild step (`scripts/build-webview.mjs`) with output under `media/canvas/` — not a second webpack entry to `dist/canvasWebview.js`.
- **Unified chat UX plan** (`unified-chat-ux`): its capability-manifest webview message should ride the same `initialState`/`providerAvailability` split introduced in Phase 3a. **Ordering contract (Phase 3c binding decision 3):** that plan's Phases 2–3 seam edits to `webviewContent.ts` and its provider-literal CI guard land **before** Phase 3c Step 1 here; after Step 2, the guard is retargeted to `src/webview-src/chat/` (Phase 3c task 9). This resolves its Open Question 2 (extraction after its Phases 2–3, owned here).

## Effort Estimate

| Phase | Scope | Estimate |
|---|---|---|
| 1 — Measurement & instrumentation | PerfTracker, webview harness, baselines, size script | **M** |
| 2 — Activation time | un-await init, parallelize registry, activationEvents, memoize platform probes | **S** |
| 3 — First-paint + asset architecture | discovery cache (M) + icons (S) + HTML extraction Step 1 (M) + module split Step 2 (L) | **L** (3a+3b ship first as M; 3c Step 2 can trail) |
| 4 — Streaming render path | coalescer, throttle, scoped highlight, incremental markdown, scroll guard, bounded scans | **M–L** (incremental markdown is the L part; everything else is M and ships first) |
| 5 — Windowing + history load | batch highlight, 60-message window, live-trim | **M** |
| 6 — Persistence | debounce, index+files split, migration, context refs, slim history payload | **M** |
| 7 — Hygiene | 4 small fixes + lazy intervals + heap verification | **S** |
| 8 — Bundle & deps | dep removal, size CI guard, .vscodeignore audit | **S** |

Recommended landing order: 1 → 2 → 3a/3b → 4 (throttle+coalescer first, incremental markdown second) → 3c → 6 → 5 → 7 → 8. Phases 2, 3a/3b, and the first half of 4 deliver the bulk of perceivable improvement and are each contained, low-risk changes. Phase 3c additionally gates on Plan 02 Phases 2–3 having landed (ordering contract, Phase 3c binding decision 3).

## Open Questions

1. **Webview build tool:** esbuild (fast, simple, new dep) vs a second webpack config (consistent tooling, slower)? Recommendation: esbuild; decide before Phase 3c. **RESOLVED — esbuild** (Phase 3c binding decision 2): one `scripts/build-webview.mjs` builds all webview bundles (chat, vt-dashboard, and Plan 05's canvas); webpack remains extension-host-only.
2. **Windowing vs full virtualization:** is 60-rendered-messages windowing acceptable UX, or do power users with 1,000-message conversations need IntersectionObserver-based recycling in v1? (Defaulting to windowing; revisit with Phase 5 metrics.)
3. **Conversation retention default:** is a 100-conversation LRU cap acceptable, or does silent pruning need an export/archive affordance first?
4. **Context content in history:** does any product surface (e.g., "what file did I attach 3 weeks ago?") require persisted file *content* rather than path+hash references? If yes, cap at N KB per item instead of full removal.
5. **Perf telemetry scope:** should coarse perf aggregates (activation ms, ttft, p95) ship through TelemetryManager by default under the existing opt-in, or stay local-only until the budgets stabilize?
6. **Coalescer interval:** 40ms is a guess balancing IPC reduction against perceived typing smoothness — tune against Phase 1's `send.ttftRender` and a subjective smoothness check; is per-provider tuning needed (Claude token deltas vs Manus poll bursts)?
7. **Ollama/LocalAI background probing:** is skipping unreachable-endpoint re-probes within TTL acceptable, or do local-model users expect near-instant detection when they start the daemon? (Possible compromise: probe on panel focus.)
8. **`canvasContent.ts` extraction timing:** does the canvas plan rewrite that file? If so, drop it from Phase 3c scope here. **RESOLVED — dropped** (Phase 3c binding decision 1): Plan 05 Phase 1.6 rewrites and owns the canvas webview extraction (using the shared esbuild step); Phase 3c task 8 retains only `visualTestDashboardContent.ts`.
