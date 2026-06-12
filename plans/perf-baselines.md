# Performance Baselines — Plan 03 Phase 1

Date: 2026-06-12 @ commit `65ce515` (branch `feature/visual-testing`, working tree includes Phase 1 instrumentation)

## Static baselines (measured now)

Captured after a fresh `npm run compile` (webpack 5.103.0, production). Size figures from `npm run perf:sizes` plus direct measurement.

| Metric | Value | Notes |
| --- | --- | --- |
| `dist/extension.js` | 1,872,615 B (1.79 MB) | Fresh production webpack build |
| `mysti-0.4.0.vsix` | 33,836,555 B (32.27 MB) | Newest root `.vsix`; predates this build (re-run `npx vsce package` for a fresh number) |
| `resources/` total | 35,199,557 B (33.57 MB) | Recursive byte total |
| `resources/icons` total | 31,598,490 B (30.13 MB) | ~90% of the resources payload |
| `src/webview/webviewContent.ts` | 18,823 lines / 670,950 B | Single embedded HTML/CSS/JS template module |
| package.json dependencies | 7 prod / 13 dev | |
| Installed packages (`node_modules`) | 410 | Top-level + scoped package directories |

CI guard: `node scripts/perf-sizes.js --max-extension-kb <n> --max-vsix-mb <n>` exits 1 on breach.

## Post Phase 3a/3b — static (measured 2026-06-12)

Captured after Phase 3a (cached CLI discovery) + Phase 3b (icon downscale to 128px, lazy-loading `<img>`) landed in the working tree. Fresh `npm run compile` + `npm run perf:sizes`.

| Metric | Value | Delta vs baseline | Notes |
| --- | --- | --- | --- |
| `dist/extension.js` | 1,881,830 B (1.79 MB) | +9,215 B (+0.5%) | Cumulative working-tree delta since baseline (Phase 2 + 3a discovery cache + concurrent Canvas v2 work) |
| `mysti-0.4.0.vsix` | 3,907,132 B (3.73 MB) | −29,929,423 B (−88.5%) | Repackaged 2026-06-12 post-3b (`npx vsce package`, 307 files) |
| `resources/` total | 3,940,757 B (3.76 MB) | −31,258,800 B (−88.8%) | |
| `resources/icons` total | 339,690 B (0.32 MB) | −31,258,800 B (−98.9%) | 23 PNGs downscaled in place via `sips -Z 128` (was 30.13 MB) |

## Runtime baselines — capture procedure

These cannot be measured statically; fill the table below after one Extension Development Host session.

**Setup**

1. Flip the setting `mysti.debug.performanceLogging` to `true` (Settings UI under Mysti, or `"mysti.debug.performanceLogging": true` in settings.json). Coarse marks (`activation.total`, `panel.timeToUsable`, `send.ttftRender`) log even when this is off; everything else (fine-grained measures, per-chunk render timing, heap sampling, `perfReport`) requires it on.
2. Press `F5` to launch the Extension Development Host.
3. Numbers appear as `[Mysti][perf] <name>: <ms>ms` lines in the **Debug Console** (filter on `[Mysti][perf]`). Webview-side numbers arrive via `perfReport` / `perfMark` messages and are logged extension-side with the same prefix; aggregates also flow to `TelemetryManager.trackPerf` (`perf.aggregate` event) when telemetry is enabled.

**Scenario (Plan 03 Phase 1, task 9)**

1. **Cold reload → activation**: `Developer: Reload Window` in the dev host; record `activation.total` (and `activation.providerInit` / `activation.managerConstruction`) from the Debug Console.
2. **Open sidebar**: open the Mysti chat view; record `panel.timeToUsable` (resolveWebviewView entry → webview `uiReady` rAF).
3. **Send a heavy prompt**: send a prompt that produces a response of **≥10k characters with ≥3 fenced code blocks** (e.g. "Write three complete TypeScript classes with full JSDoc, each in its own code block, totalling at least 10,000 characters"). Record `send.ttftRender` (coarse, e2e), `send.ttftExtension` (extension-side TTFT), and on completion the webview `perfReport` gives `render.chunk` p50/p95/max and `heapUsed`.
4. **Reload a 100-message conversation**: open/switch to a conversation with ~100 messages (or replay until history reaches 100) and reload the panel; record `panel.timeToUsable` again plus `heap.webview` from the next heap `perfReport` (init sample on enable + every 60s).

Heap units are **raw bytes** on both sides (`process.memoryUsage().heapUsed` extension-side, `performance.memory.usedJSHeapSize` webview-side).

### Runtime baseline table (fill after one F5 session)

| Metric | Source | Baseline (ms / bytes) |
| --- | --- | --- |
| `activation.total` | Debug Console, cold reload | |
| `activation.providerInit` | Debug Console (flag on) | |
| `panel.timeToUsable` | Debug Console, sidebar open | |
| `send.ttftRender` (e2e) | Debug Console, heavy prompt | |
| `send.ttftExtension` (ext) | Debug Console (flag on) | |
| `render.chunk.p95` | webview `perfReport` on done | |
| `heap.ext` | `heap.ext` sample post-activation | |
| `heap.webview` | webview heap `perfReport` (init/60s) | |
