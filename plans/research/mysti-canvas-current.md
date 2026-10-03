# Mysti Canvas v2 — Current Implementation Review (working tree, branch `feature/visual-testing`)

Reviewed files (all paths relative to `/Users/bahaabunojaim/Documents/GitHub/Mysti`):

| File | Lines | Role |
|---|---|---|
| `src/managers/CanvasManager.ts` | 3196 | All canvas generation orchestration (Stitch, image, video, SVG, code, themes, batch) |
| `src/webview/canvasContent.ts` | 6712 | Entire canvas webview (HTML/CSS/JS string) — fabric.js v6 canvas + overlays |
| `src/providers/ChatViewProvider.ts` (canvas section ~5017–5989) | — | Webview ↔ extension message router (`_handleCanvasMessage`) |
| `src/managers/DesignSpecManager.ts` | 340 | Pure DesignSpec tree CRUD/theme/assets |
| `src/managers/VisualTestManager.ts` | 565 | Visual test loop (browser → screenshot → AI → fix → verify) |
| `src/webview/visualTestDashboardContent.ts` | 678 | Visual test dashboard webview |
| `src/services/ImageGenerationService.ts` | 496 | GPT-Image / Gemini ("nano-banana") image gen + vision `analyzeImage` |
| `src/services/VideoGenerationService.ts` | 433 | Sora 2 / Veo 3.1 video gen |
| `src/services/CodeGenerationService.ts` | 387 | Vision-API code gen (component + story + props) |
| `src/services/StitchService.ts` | 564 | Google Stitch SDK wrapper (ESM dynamic import) |
| `src/services/ScreenshotService.ts` | 153 | Playwright screenshots + DOM snapshot |
| `src/services/BrowserManager.ts` | 147 | Playwright lifecycle per panel |
| `src/services/BrowserInteractionService.ts` | 100 | click/type/navigate/scroll/hover/select |

---

# 1. ARCHITECTURE DESCRIPTION (baseline for the DeepMyst 2.0 redesign)

## 1.1 Topology

```
extension.ts
  ├─ CanvasManager (singleton, ctor in activate(); StitchService injected via setStitchService)
  ├─ StitchService (singleton, never disposed)
  └─ ChatViewProvider
       ├─ _imageGenService: ImageGenerationService (ctor, line 193)
       ├─ _videoGenService: VideoGenerationService (ctor, line 194)
       ├─ _codeGenService: lazy dynamic import on first /code
       ├─ _canvasBrowserManager / _canvasScreenshotService / _canvasDevServerManager (canvas-only instances)
       ├─ openCanvas() → ONE WebviewPanel 'mysti.canvas' (ViewColumn.Beside, retainContextWhenHidden)
       │    single-instance: `_canvasPanelId` (line 5026); reveal() if already open
       └─ _handleCanvasMessage(msg, panelId) — the entire wire protocol (lines 5093–5989)
```

There is exactly **one canvas panel** at a time; `_canvasChatOrigin` remembers which chat panel opened it (used for settings resolution and `canvasSendToChat`).

## 1.2 Data model

**Persisted** — `CanvasSession` (`.mysti/canvas/<uuid>.json`):
```ts
{ id, name, createdAt, updatedAt, canvasJson: string, assetPaths: string[] }
```
- `canvasJson` is **fabric.js v6 `canvas.toJSON(customJsonProps)`** output. Custom serialized props (canvasContent.ts:2528): `['id','label','description','metadata','videoData','videoMimeType','isVideo','_viewData']`.
- On save, `CanvasManager.externalizeAssets()` (CanvasManager.ts:1669) rewrites top-level `obj.src` data-URIs and `obj.videoData` base64 into **content-addressed files** `.mysti/canvas/assets/<sha256-16>.<ext>` referenced as `asset://...`; `rehydrateAssets()` (1749) inlines them back before sending to the webview.
- Debug captures of every snapshot go to `.mysti/canvas/captures/<ISO-ts>/` (full-canvas.png, selected-region.png, region-metadata.json, prompt.json, enhanced-prompt.txt); a `.gitignore` (`captures/`) is auto-created.

**Webview-only (NOT persisted)** — this is the most important architectural gap:
- `_designSpec` (canvasContent.ts:1496): a `DesignSpec` `{ id, version, name, theme: DesignTheme, rootNodes: DesignNode[], assets[] }` — the structured "source of truth" for generated designs. Built in the webview from `canvas_mockup_complete` chunks, appended on each generation, never serialized into the session.
- `_nodeMap` nodeId → {fabricObj, designNode}; `obj._designNode`, `obj._stitchScreenRef` (projectId/screenId/htmlContent/imageBase64), `obj._contentText`, `obj._typeBadge`, `obj._assetPlaceholders` — all expando props excluded from `customJsonProps`, so a reload loses the design tree, the Stitch edit handles and the wireframe glue (only raw fabric rects/images survive).
- `_viewData` per object (documented at canvasContent.ts:4596–4611) IS persisted: multi-representation store `{ activeView: 'image'|'svg'|'code'|'component', imageDataUrl, svgMarkup, svgFabricJson, codeFiles[], componentName, componentProps, framework, componentRender, componentHtml, liveIframeActive }`.
- Theme library `_themeLibrary` (saved into `_designSpec.themeLibrary` — webview memory only).

**Extension-side per-canvas state**: `CanvasManager._stitchProjectIds: Map<canvasId, stitchProjectId>` (memory only — Stitch projects are recreated after extension restart); static `_projectProfileCache` (AI-generated project profile, invalidated on workspace change).

## 1.3 Rendering approach

- **fabric.js v6** (bundled `resources/fabric.min.js`, 314 KB) on a single `<canvas>` in the webview; infinite canvas via `viewportTransform` pan/zoom (wheel = pan, ctrl/cmd-wheel = zoom, pinch, inertia), zoom 0.1–5, dot-grid painted in `after:render` with a cached pattern tile, minimap (5 fps throttle), zoom-to-fit/presets.
- **Frame labels are not fabric objects** — they are painted directly onto the canvas context in `after:render` (canvasContent.ts:5091) with screen-space math from `aCoords`, plus a click-hit cache (`_frameLabelBounds`).
- **DOM overlay layers** positioned by converting world `aCoords` → screen (`x*zoom + vpt[4]`), synced on a rAF debounce (`_debouncedSyncAllIframes`, 5436):
  - **Stitch screen iframes** (`_createStitchIframe`, 5331): live HTML render of the generated screen in a sandboxed iframe (`allow-scripts allow-same-origin`, Blob URL), CSS-scaled to the frame; fabric rect is made 99% transparent but stays the selection/hit target; screenshot kept as 0.15-opacity fallback.
  - **Component iframes** (`_createComponentIframe`, 5372): generated component code wrapped by `_buildStandaloneHtml` (React 18 UMD + Babel standalone from unpkg CDN, import/export stripped) plus an injected **bridge script** (`_buildStandaloneHtmlWithBridge`, 5266) that does hover-highlight, click-to-select (posts `mysti-element-selected` with selectorPath/computedStyles), live style/text patching (`mysti-apply-style` / `mysti-apply-text`), DOM tree extraction, full reload via `document.write`.
  - Generation-job spinner overlays (`genJobCreate`/`_genJobShowLoader`, 3108), video playback overlay (dblclick on `isVideo` objects), preview-mode HTML overlays (`_togglePreviewMode` renders DesignNodes to HTML), tab placeholder overlay.
- **Global tabs**: Design | Assets | Code | Themes (`_switchGlobalTab`, 4641). Code tab fades fabric objects to opacity 0.05 and shows live iframes; Assets tab is a grid of `_designAssets`; Themes tab is a theme library editor.
- **Undo/redo**: 50-deep stacks of full `canvas.toJSON` snapshots (debounced 150 ms on object:added/removed/modified/path:created).
- **Element inspector**: right panel extends the props panel; per-element editable style rows apply live into the iframe and accumulate `_elementInspectorEdits` which can be flushed to source via `canvasElementEdits` → `CanvasManager.applyElementEdits`.

## 1.4 Component types that exist on the canvas

1. Plain fabric primitives: `rect` "frames" (label/description/metadata expandos), `i-text`/`textbox` annotations (text tool), free-draw `path`, uploaded images.
2. Generated images (`fabric.FabricImage` with id `generated-N`), placed into the source frame after a **content-aware smart crop** (`detectContentBounds` corner-sampled background diff + gravity from `metadata.role/componentType`, canvasContent.ts:4012–4133).
3. Generated videos: poster-frame image object with `videoData`/`videoMimeType`/`isVideo` expandos; playback via DOM `<video>` overlay on dblclick.
4. SVG groups (`fabric.loadSVGFromString` → `groupSVGElements`).
5. DesignNode wireframes: per-node fabric rects with depth-colored borders, optional theme-resolved fill, Textbox content, asset placeholder rects, componentType badge (`_renderDesignTree`, 1581). Node types come from `DesignNodeType` ('page' | 'section' | …).
6. Stitch screens: DesignNode of `type:'page'` with `assets: [image(dataURI screenshot), html(raw HTML)]` and `metadata {engine:'stitch', stitchProjectId, stitchScreenId}` → rendered as rect + live iframe.
7. Components: any object whose `_viewData.codeFiles` exists → live iframe in Code tab.

## 1.5 How agent output reaches the canvas (data flow)

```
webview (prompt bar / action buttons)
  └─ buildSnapshot() (canvasContent.ts:3882)
       { imageBase64: full-viewport PNG, selectedRegion: {imageBase64, bounds(world)},
         _canvasJson: canvas.toJSON(...), elementSelection {selectorPath, componentSource, ...} }
  └─ vscodeApi.postMessage({type:'canvasUnifiedPrompt', payload:{text, canvasId, snapshot, selectedObjectIds, designTheme, designNode?, stitchScreenRef?}})
ChatViewProvider._handleCanvasMessage
  └─ CanvasManager.parseUnifiedPrompt(text) → action
       /design→'page' (Stitch generateScreen)   /edit→'stitch-edit'    /variants→'stitch-variants'
       /website→'website' (multi-page Stitch)   /image→'generate'      /video→'video'
       /svg→'svg'    /code→'code'    /theme→'theme'    /render→'render' /html→'stitch-html'
       /design-dna→'design-dna'   /edit-element /edit-layout   else 'prompt'
  └─ CanvasManager.<pipeline>() — AsyncGenerator<CanvasStreamChunk>
  └─ every chunk → _postToPanel(canvasPanelId, {type:'canvasStreamChunk', payload: chunk})
webview message switch (canvasContent.ts:6046–6697)
  └─ ~40 chunk types update job overlays / progress and finally call
     addImageToCanvas / addVideoToCanvas / addSvgToCanvas / _renderDesignTree / showPropsPanel / _reloadComponentIframe
```

Backend fan-out inside CanvasManager:
- **Stitch SDK** (primary UI engine): `generateScreen`, `editStitchScreen`, `generateStitchVariants`, `generateWebsite` (page list inferred heuristically from prompt keywords, `_inferWebsitePages`), `extractDesignDna` (writes `DESIGN.md` to workspace root), `generateTheme` (Stitch designSystem markdown → regex-parsed `DesignTheme`, LLM fallback).
- **ImageGenerationService**: OpenAI `/v1/images/generations` (+ `/v1/images/edits` multipart when a reference region image exists) or Gemini `generateContent` with `responseModalities:['TEXT','IMAGE']`. Frame size mapped to nearest API size / Gemini aspect ratio.
- **VideoGenerationService**: Sora (`POST /v1/videos` multipart → poll → download) or Veo (`predictLongRunning` → poll operation → download URI).
- **Vision** (`analyzeImage`): Gemini 2.5 Flash preferred, OpenAI `gpt-5-mini` fallback — used for SVG conversion, code gen, element edits, prop regeneration, project profiling.
- **CLI provider** (`ProviderManager.sendMessage`, no panelId → shared `'default'` session): smart-prompt construction (`_buildSmartPrompt`, `_buildReimaginePrompts`, `_buildBatchDesignBrief` with cover-crop / 4×4-grid composition guidance), plain canvas Q&A (`promptFrame`), theme JSON fallback, project profile, and `integrateComponent` (asks the coding agent to wire generated files into the app — this one passes the chat panelId).
- Generated code files are written under `src/components/<Name>/` (`CANVAS_CODE_OUTPUT_DIR`) by `CodeGenerationService.writeToWorkspace` and opened in the editor.

Persistence loop: any canvas mutation → `autoSave()` (500 ms debounce) → `canvasSave` → extension `loadSession` + `debouncedSave` (another 500 ms, `CANVAS_AUTOSAVE_DEBOUNCE_MS`) → externalize → write JSON.

Legacy/secondary messages still handled: `canvasPrompt`, `canvasReimagine` (non-Stitch path → 4 AI-prompted image variants in a 2×2 grid left of the source), `canvasGenerateDraft` (draft overlay), `canvasBatchGenerate` (per-frame batched generation — currently unreachable, see F-15), `canvasExport` (PNG save dialog), `canvasSendToChat`, `canvasSaveConfig` (writes provider + API key to settings), `canvasUpdateProps`, `canvasGenerateAllAssets`, `canvasIntegrateComponent`, `canvasElementEdits`, `canvasRenderComponent` (half-implemented).

---

# 2. FINDINGS (bugs — each confirmed in code)

## F-1 (HIGH) Region/full snapshot crops are wrong whenever the canvas is panned or zoomed
**File:** `src/webview/canvasContent.ts:3943–3951` (also full capture at 3884)
```js
// Use fabric's toDataURL with world-space crop params —
// it handles viewport transform + retina scaling internally
var regionDataUrl = canvas.toDataURL({ format:'png', left: cropLeft, top: cropTop, width: cropW, height: cropH });
```
The crop bounds are computed in **world space** from `aCoords`, but fabric v6's `toCanvasElement` (verified in bundled `resources/fabric.min.js`: `f=[d,0,0,d,(g[4]-(i||0))*t,(g[5]-(r||0))*t]`) subtracts `left/top` directly from the viewport translation and keeps the current zoom — i.e. the crop params are in **screen/viewport space** (`left_screen = left_world*zoom + vpt[4]`). The two coincide only at zoom=1, pan=(0,0). On an infinite canvas users are almost always panned/zoomed, so:
- `selectedRegion.imageBase64` (the reference image fed to `_buildSmartPrompt`, the image-edit API, vision analysis, `/svg`, `/code`) shows the wrong area or empty canvas;
- the "full" capture (`canvas.toDataURL({format:'png'})`) is just the current viewport at current zoom — never the whole scene.
**Fix:** convert to screen space before cropping (`left: cropLeft*zoom + vpt[4], …, width: cropW*zoom`) and pass `multiplier: 1/zoom` to normalize resolution, or temporarily reset `viewportTransform` to identity around the export.

## F-2 (HIGH) Undo/redo passes a v5-style completion callback that fabric v6 treats as a per-object reviver — autosave/history can silently stop
**File:** `src/webview/canvasContent.ts:2554–2560` (and 2579–2585)
```js
canvas.loadFromJSON(JSON.parse(prevState), function() {
  canvas.getObjects().forEach(function(obj) { obj.set(controlStyle); });
  canvas.renderAll();
  isUndoRedoing = false; ...
});
```
Bundled fabric v6 signature (verified in minified source): `loadFromJSON(json, reviver, {signal}) → Promise`. The "callback" runs once **per revived object** (resetting `isUndoRedoing=false` mid-load, so the remaining `object:added` events re-enter `saveHistoryState`/`autoSave` and pollute the undo stack), and **never runs at all when the restored state has zero objects** — leaving `isUndoRedoing === true` forever, after which `object:added`/`object:removed` autosaves and all history snapshots are permanently suppressed (`canvasContent.ts:2531`, `3876–3877`) until the panel is reloaded. The session-load path does it correctly (`canvas.loadFromJSON(json).then(...)`, line 6056), so this is an oversight specific to undo/redo.
**Fix:** `canvas.loadFromJSON(state).then(() => { …; isUndoRedoing = false; })`.

## F-3 (HIGH) Typed `/edit`, `/variants`, `/html`, `/design-dna` always fail — `stitchScreenRef` never sent from the prompt bar
**File:** `src/webview/canvasContent.ts:3606–3616` (sender) vs `src/providers/ChatViewProvider.ts:5645–5651, 5668–5674, 5698–5704, 5721–5727` (consumers)
`sendUnifiedPrompt()` posts `{text, canvasId, snapshot, selectedObjectIds, designTheme}` — no `stitchScreenRef` — while all four extension handlers hard-require `payload.stitchScreenRef` and otherwise emit "Select a Stitch-generated screen to edit/…". Only the "action-reimagine" button path (line 3309) attaches `active._stitchScreenRef`. So the slash commands that the autocomplete menu advertises (lines 3550–3560) are dead from the prompt bar even with a Stitch screen selected.
**Fix:** in `sendUnifiedPrompt`, include `stitchScreenRef: (canvas.getActiveObject() && canvas.getActiveObject()._stitchScreenRef) || null`; or have the extension fall back to `snapshot.selectedRegion.objects[0].metadata.stitchProjectId/ScreenId` like `canvasReimagine` does (ChatViewProvider.ts:5151–5157).

## F-4 (HIGH) Prompt-bar Stitch/render jobs leak permanent "Generating…" overlays
**File:** `src/webview/canvasContent.ts:3586–3598`
```js
if (actionType !== 'prompt') {
  var job = genJobCreate(actionType);
  if (actionType === 'generate') { _pendingGenerateJob = job; }
  ... // 'theme' | 'page' | 'section' | 'component' | 'website' → _pendingLayoutJob
}
```
`genJobCreate` shows a spinner overlay over the selected object for **every** non-prompt action, but jobs of type `'design'`, `'stitch-edit'`, `'stitch-variants'`, `'stitch-html'`, `'design-dna'`, `'render'`, `'edit-element'`, `'edit-layout'` are never assigned to any `_pending*Job` slot ('design' isn't in the list — the webview's actionType names don't match the extension parser, which maps `/design`→'page'). Completion handlers (`canvas_mockup_complete` → `_pendingLayoutJob` only, `canvas_render_complete` → none) and even `canvas_error` cleanup (6647–6655) only complete the tracked slots, so the spinner overlay stays on screen until reload.
**Fix:** unify action-type naming with `CanvasManager.parseUnifiedPrompt`, assign every job to a tracked slot (or key jobs by chunk-correlation id), and clear all `_genJobs` on `canvas_error`.

## F-5 (HIGH) OpenAI vision fallback always 400s: `max_tokens` with `gpt-5-mini`
**File:** `src/services/ImageGenerationService.ts:138–141`
```js
const body = JSON.stringify({ model: 'gpt-5-mini', max_tokens: 16384, messages: [...] });
```
gpt-5-family Chat Completions reject `max_tokens` ("Unsupported parameter… use `max_completion_tokens`"). Every `analyzeImage` call via the OpenAI path fails — meaning users with only an OpenAI key (no Gemini key) cannot use `/svg`, `/code`, element edits, prop regeneration, or vision-based project profiling, despite `isVisionAvailable` reporting true (line 167–171 prefers Gemini, falls back to OpenAI).
**Fix:** use `max_completion_tokens` (or the Responses API).

## F-6 (HIGH, security) Generated/Stitch HTML runs same-origin with the webview (`allow-scripts allow-same-origin` + Blob URLs + CDN scripts)
**File:** `src/webview/canvasContent.ts:5346` and `5388` (`iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin')`), `5351/5390` (Blob URL → inherits the webview's origin), `5992–5994` (React/Babel loaded from unpkg inside the component iframe).
Because Blob URLs inherit the creating document's origin and the sandbox grants both scripts and same-origin, any JS inside the iframe (AI-generated component code, Stitch-returned HTML, or a compromised unpkg bundle) can reach `window.parent.document` and the canvas webview's `vscodeApi`, i.e. post arbitrary extension messages: `canvasUpdateProps` (writes files into the workspace via `CodeGenerationService.writeToWorkspace`), `canvasIntegrateComponent` (drives the coding agent with an attacker-authored prompt + file contents), `canvasSaveConfig` (overwrites API-key settings). This is the textbook "sandbox defeated by allow-same-origin" pattern, with a prompt-injection→workspace-write escalation path.
**Fix:** drop `allow-same-origin` (use `srcdoc` + `postMessage` with explicit `MessageChannel`; the bridge already communicates via postMessage and the only same-origin dependency is the `document.write` reload, which can be replaced by recreating the iframe). Pin/bundle React+Babel locally in `resources/` instead of unpkg.

## F-7 (HIGH) "Apply props" regenerates the component from an empty SVG
**File:** `src/webview/canvasContent.ts:4562–4571`
```js
vscodeApi.postMessage({ type: 'canvasUpdateProps', payload: { ..., svgMarkup: '' } });
```
and `src/services/CodeGenerationService.ts:153–163` — `regenerateWithProps` embeds `opts.svgMarkup` ("Original SVG: ```svg\n\n```") as the **only** source of truth; the current component code is never included. With `svgMarkup` hard-coded to `''`, the model regenerates a component from nothing but the prop list, discarding the actual design. The extension then writes the result over the existing files (ChatViewProvider.ts:5822–5827).
**Fix:** send `vd.svgMarkup`/`vd.codeFiles[0].content` from the webview and include current code in the regeneration prompt.

## F-8 (MEDIUM) Theme tab "Generate" button is dead twice over: `window.prompt()` + undefined `vscode`
**File:** `src/webview/canvasContent.ts:5053–5058`
```js
var desc = prompt('Describe the theme you want to generate:');   // blocked in VS Code webviews → returns undefined
if (!desc) return;
vscode.postMessage({ type: 'canvasAction', ... });                // `vscode` is not defined (API var is `vscodeApi`)
```
`window.prompt` is disabled in VS Code webviews (always falsy → early return); even if it worked, `vscode` is a ReferenceError (everywhere else uses `vscodeApi`, line 1398) and the message type `canvasAction` has no extension handler. The file even contains `showInlineInput` as the "webview-safe replacement for window.prompt()" (3456). Workaround exists (`/theme` in the prompt bar, `action-theme` button), hence medium.
**Fix:** reuse `showInlineInput` + `vscodeApi.postMessage({type:'canvasUnifiedPrompt', payload:{text:'/theme '+desc, …}})`.

## F-9 (MEDIUM) Veo duration: snapped value computed but raw value sent
**File:** `src/services/VideoGenerationService.ts:248–251` vs `269–272`
```js
const duration = [4, 6, 8].reduce(...);          // snapped to Veo-legal values
...
if (options?.durationSeconds) { params.durationSeconds = Math.round(options.durationSeconds); }  // raw!
```
The snapped `duration` is never used for the request; any caller-supplied duration not in {4,6,8} goes to the API verbatim (constants file even documents "Veo accepts 4, 6, or 8 only", `src/constants.ts:135`). Also the returned `durationSeconds` uses the raw value (line 322).
**Fix:** `params.durationSeconds = duration`.

## F-10 (MEDIUM) Veo video download sends no API key
**File:** `src/services/VideoGenerationService.ts:312–317` + `_downloadUrl` (381–404)
Every other Gemini call appends `?key=${apiKey}`, but the final `videoUri` download (`samples[0].video.uri` → `…:download?alt=media`) is fetched with no `x-goog-api-key` header and no key param. The Gemini Files API requires the API key on that download; as written the request should 403, so the Veo path can't deliver a video even after a successful generation. (Code-confirmed: no auth attached; API requirement per Google docs.)
**Fix:** pass the key (`x-goog-api-key` header) through `_downloadUrl` for `generativelanguage.googleapis.com` URLs.

## F-11 (MEDIUM, security) API keys stored in plaintext, sync-able VS Code settings
**Files:** `src/services/ImageGenerationService.ts:405–417`, `VideoGenerationService.ts:365–375`, `StitchService.ts:41–45,76`, `ChatViewProvider.ts:5966–5986` (`canvasSaveConfig` writes `canvas.openaiApiKey`/`canvas.geminiApiKey` to global settings), `package.json:1209–1235` (plain string settings).
OpenAI/Gemini/Stitch keys live in `settings.json` (roams via Settings Sync, readable by any extension, easily committed if a user sets them at workspace scope). `StitchService._getStitch` additionally copies the key into `process.env.STITCH_API_KEY` (line 121) — global env mutation that goes stale if the user changes the key (cached `_stitch`/env wins) and is visible to all child processes.
**Fix:** migrate to `context.secrets` (SecretStorage) with one-time migration from settings; avoid mutating `process.env`.

## F-12 (MEDIUM) First undo is a no-op (history off-by-one)
**File:** `src/webview/canvasContent.ts:2530–2565`
`saveHistoryState()` pushes the **post-change** state (debounced 150 ms after `object:added` etc.), so the top of `undoStack` always equals the current canvas. `undo()` pushes current to redo and pops the top — which is identical to the current state — so the first press does nothing and an extra bogus redo entry is created; every logical undo needs two presses.
**Fix:** standard fix — pop into a temp, and load the new top (or push *previous* state before mutation).

## F-13 (MEDIUM) Text tool places text at viewport coordinates, not scene coordinates
**File:** `src/webview/canvasContent.ts:2188–2191`
```js
var pointer = canvas.getViewportPoint(opt.e);
var text = new fabric.IText('', { left: pointer.x, top: pointer.y, ... });
```
Verified in bundled fabric: `getViewportPoint` = `getPointer(e, true)` (element space), `getScenePoint` = world space. Object `left/top` are world coordinates, so when zoomed/panned the new text appears offset from the click — annotations land in the wrong place (and annotations are design directives for `_buildSmartPrompt`). The cursor status readout (2248) has the same space confusion.
**Fix:** use `canvas.getScenePoint(opt.e)`.

## F-14 (MEDIUM) Webview/extension race on canvas open with explicit `sessionId`
**File:** `src/providers/ChatViewProvider.ts:5077–5085` vs `5095–5106`
`openCanvas(sessionId)` posts `canvasLoad` for the requested session as soon as `loadSession` resolves, while the webview independently sends `canvasReady` (canvasContent.ts:6702) which makes the extension post `canvasLoad` for the **latest** session. Both `loadFromJSON` calls race; whichever arrives last wins, so opening a specific (non-latest) session can show the wrong canvas, and the double-load wastes a full deserialize. `canvasReady` should be the only trigger, parameterized by the requested id.

## F-15 (MEDIUM) Dead/unreachable pipelines kept in the protocol
- `canvas_layout_complete` is handled in the webview (canvasContent.ts:6254–6269 → `addLayoutFrames` + batch modal → `canvasBatchGenerate` → `CanvasManager.generateBatchContent`) but **no extension code ever emits it** (grep: only `types.ts` + webview). The entire batch-generation pipeline (~500 LoC across both sides incl. `_buildBatchDesignBrief`, `_computeCompositionGuide`, `_pendingBatchJobs`) is unreachable since the layout/multipass pipeline was replaced by Stitch.
- `canvas_component_render_complete` (webview 6419–6441) is never emitted; `canvasRenderComponent` (ChatViewProvider.ts:5927–5963) writes a temp HTML file, sends a 50% progress chunk, deletes the file after 30 s — the screenshot capture it stubs was never implemented.
- `canvasImportScreenshot` (ChatViewProvider.ts:5275) has no sender; `canvas_website_complete` has no producer (webview comment acknowledges).
**Fix:** either delete the dead paths or restore a producer; for the redesign, treat the batch pipeline as already-orphaned code.

## F-16 (MEDIUM) Design structure is amnesiac: DesignSpec/Stitch refs/overlay flags don't survive reload
**Files:** `src/webview/canvasContent.ts:2528` (customJsonProps), `1692–1697` (`rect._stitchScreenRef`), `1496` (`_designSpec`), `1502` (`_designNode`), `6049–6062` (canvasLoad does not rebuild any of it).
After closing/reopening the canvas: the DesignSpec tree, theme library, `_stitchScreenRef` (needed for `/edit`, `/variants`, `/design-dna`), live iframes, and helper-object flags (`_isFrameLabel`, `selectable:false`, `evented:false` — not serialized by fabric) are all gone. Stitch screens degrade to a faint rect + a 0.15-opacity screenshot and stray selectable label/placeholder objects. Note `metadata.stitchProjectId/ScreenId` *is* serialized on DesignNode rect? — no: metadata is set on `DesignNode`, not on the fabric rect (only `label/description/nodeType/id` are copied at 1637–1640), so even the metadata fallback used by `canvasReimagine` (ChatViewProvider.ts:5151) fails for reloaded canvases.
**Fix:** persist `designSpec` (+ `stitchScreenRef`, node metadata) inside `CanvasSession`, and rebuild overlays in the `canvasLoad` handler.

## F-17 (MEDIUM) Visual test report stats are structurally wrong: `totalIssuesFixed` can never be > 0
**File:** `src/managers/VisualTestManager.ts:297` with `_parseAiResponse` (412–419)
Issues are always created `status:'open'` and no code path ever marks one `'fixed'`, so `totalIssuesFixed += issues.filter(iss => iss.status === 'fixed').length` is always 0 → `passRate` is always 0 → the `'partial'` verdict (threshold 0.8, line 319) is unreachable; reports always read "0 fixed" regardless of applied fixes. Related dead logic: the iteration timeout (204–206) only logs — it never cancels the provider stream; the hot-reload wait heuristic `aiResponse.includes('tool_use')` (280) tests raw text that rarely contains the literal string.

## F-18 (MEDIUM) Frame-targeted image placement ignores object scaling
**File:** `src/webview/canvasContent.ts:4146–4156` (and video twin at 4235–4245)
```js
if (targetObject && canvas.getObjects().includes(targetObject)) {
  frameW = targetObject.width;  // unscaled!
  frameH = targetObject.height;
```
Fabric resizes rects by changing `scaleX/scaleY`, not `width/height`. After a user resizes a frame with the handles, the generated image is cropped to the original dimensions and placed at the unscaled size, mismatching the visible frame. (`_worldBoundsFromObj`/`genJobGetBounds` get this right; this path bypasses them.)
**Fix:** use `targetObject.getScaledWidth()/getScaledHeight()` or the job's `_worldBoundsFromObj` result.

## F-19 (MEDIUM) `extractDesignDna` silently overwrites workspace `DESIGN.md`
**File:** `src/managers/CanvasManager.ts:1141–1147` — `fs.writeFileSync(path.join(root,'DESIGN.md'), …)` with no existence check or confirmation; a user-authored DESIGN.md is destroyed by running `/design-dna`.

## F-20 (LOW) Stitch variants always placed at canvas origin
**File:** `src/providers/ChatViewProvider.ts:5679–5683` — `generateStitchVariants(..., variantRef.imageBase64 ? 0 : 0, 0)`: the ternary is a leftover that always yields baseX=0/baseY=0, so variant pages stack at (0,0) over whatever is there, instead of beside the source screen.

## F-21 (LOW) Concurrent canvas AI calls share the `'default'` provider session
**Files:** `src/managers/CanvasManager.ts:480, 584, 1558, 1954` (no panelId) + `src/providers/base/BaseCliProvider.ts:164` (`key = panelId || 'default'`). Two simultaneous generation jobs (the webview allows them) both run CLI calls on the same per-panel session record — `session.process` gets overwritten and cancellation/timeout of one can affect the other.

## F-22 (LOW) `_lastCaptureDir` race + unbounded capture growth + sync I/O
**File:** `src/managers/CanvasManager.ts:212–218, 224–305`. One instance field tracks "the most recent capture dir" across all concurrent jobs, so `_saveCapturePrompt` can write prompt.json into another job's folder. Every snapshot writes PNGs with `fs.writeFileSync` on the extension host thread, and `.mysti/canvas/captures/` is never pruned.

## F-23 (LOW) Stitch edit/variants build `data:image/png;base64,` with possibly-empty screenshot
**File:** `src/managers/CanvasManager.ts:1031, 1098` — unlike `generateScreen` (948–961) these don't guard `imageBase64 === ''`, producing a broken image asset (`data:image/png;base64,`) when Stitch returns no screenshot.

## F-24 (LOW) Unbounded redirect recursion in download helpers
**Files:** `src/services/StitchService.ts:539–543`, `VideoGenerationService.ts:386–389, 211–217` — redirects recurse with no depth cap (also note `VideoGenerationService._downloadUrl` mixes module choice: chooses `https`/`http` by protocol but then calls `mod.request(url, …)` — works, but the picked module is decided per call without limit on hops).

## F-25 (LOW) Sora/Veo polling cap of 120 s is optimistic
**File:** `src/constants.ts:134` `CANVAS_VIDEO_POLL_MAX_MS = 120_000`. Sora/Veo generations frequently exceed 2 minutes; users will see spurious "timed out" errors. (Also image generation HTTP timeout is 60 s — `ImageGenerationService.ts:489` — tight for gpt-image at 1536×1024.)

## F-26 (LOW) `/theme` result silently dropped when no design exists
**File:** `src/webview/canvasContent.ts:6605–6621` — `canvas_theme_complete` handler requires `_designSpec`; on a fresh canvas the generated theme is discarded with no feedback.

## F-27 (LOW) Undo stack holds full base64 media ×50
**File:** `src/webview/canvasContent.ts:2528–2536` — `videoData` (entire MP4 base64) and image data-URLs are part of every history snapshot (50-deep) and of every 500 ms autosave postMessage; a couple of videos make history and IPC payloads tens of MB.

## F-28 (LOW) Error text inserted as HTML
**File:** `src/webview/canvasContent.ts:3647, 6643` — `showPromptStatusMessage(chunk.error …)` uses `innerHTML` with unescaped provider/AI-derived strings (the file has `_escapeHtml` but doesn't use it here). Script execution is CSP-blocked, but markup injection/UI spoofing is possible. The visual-test dashboard, by contrast, escapes everything.

## F-29 (LOW) Lifecycle leftovers
- `StitchService.dispose()` exists but is never called (`extension.ts deactivate()`, lines 579–619 — not listed); MCP-ish tool client connection leaks on deactivate.
- `CanvasManager` has no dispose; `_saveTimers`/`_stitchProjectIds` never cleared (timers harmless, but `generateWebsite` (1230) also overwrites the canvas's existing `_stitchProjectIds` entry, orphaning the original project for subsequent `/design` calls).
- `ChatViewProvider.dispose()` (6774) doesn't dispose `_canvasBrowserManager`/`_canvasDevServerManager` directly — only via the canvas panel's `onDidDispose`, which doesn't run on extension deactivate-without-panel-close ordering.

---

# 3. IMPROVEMENT OPPORTUNITIES (non-bug)

1. **Persist the structured model, not the picture.** The DesignSpec tree is the natural source of truth (and the natural seam for a DeepMyst 2.0 presentation-agent integration), yet it lives only in webview memory while the fabric JSON (a render artifact) is what gets persisted. Invert this: persist `DesignSpec` + assets, derive the fabric scene.
2. **Protocol is stringly-typed and sprawling.** ~40 `CanvasStreamChunk` variants and ~20 webview message types are routed through two giant switches with per-action copy-pasted try/for-await/post loops (ChatViewProvider 5275–5770 repeats the same 12-line block ~14×). A single `pipe(stream)` helper and a typed message union with a correlation/job id would collapse hundreds of lines and fix the job-tracking class of bugs (F-4).
3. **Job model:** webview keeps seven parallel `_pending*Job` singletons plus `_pendingBatchJobs`; the extension has no job ids at all. A shared `jobId` minted in the webview and echoed in every chunk would make tracking, cancellation, and concurrent jobs trivial. There is currently **no cancellation** for any canvas generation.
4. **`canvasContent.ts` is a 6.7k-line template literal** — no syntax checking, no linting of the embedded JS, `\\`-escaping hazards, and `vscode`-vs-`vscodeApi` typos (F-8) can't be caught. Move webview code to a real `.js`/`.ts` asset compiled by webpack and loaded via `asWebviewUri` (the project already ships `resources/fabric.min.js` this way).
5. **Snapshot/scene description fidelity:** `_extractObjects` only walks top-level fabric objects (CanvasManager.ts:307–314) and `buildSnapshot` in the webview sends `objects: []`/`sceneDescription: ''` — the extension recomputes from `_canvasJson`, so groups/nested content are invisible to the AI; annotations inside groups never become "design directives".
6. **Settings reads scattered:** `mysti.canvas.stitchModel` is read in five places; image/video provider resolution re-reads config per call. Centralize into a CanvasSettings snapshot per request.
7. **`_inferWebsitePages`** is a keyword heuristic; the smart-prompt LLM pass used elsewhere could plan pages (count, names, per-page briefs) much better and would remove the hardcoded 4-page assumption.
8. **`parseDesignMdToTheme`** regex-scrapes Stitch's markdown; Stitch returns structured designSystem fields that are partially used — prefer structured extraction with the regexes as fallback only.
9. **Vision prompt misuse:** `editElement`/`applyElementEdits`/`regenerateWithProps`/`_analyzeProjectWithVisionAPI` all call `analyzeImage('', prompt)` — i.e. the "image" service is the de-facto generic LLM client. Extract a proper `LlmTextService` so model choice/params (and the F-5 fix) live in one place.
10. **Performance:** every autosave round-trips the entire canvas JSON (with inline media) through postMessage and JSON.parse/stringify twice (webview → extension, then loadSession + saveSession). Send dirty-object deltas, or at least skip `loadSession` (the webview already has the authoritative state). The minimap and `after:render` label pass iterate all objects each frame; fine now, but will not scale to hundreds of nodes.
11. **CSP hygiene:** `script-src` includes `'unsafe-eval'` (canvasContent.ts:45) though nothing in the webview itself eval()s (Babel runs inside iframes, which the page CSP doesn't govern); `connect-src https:` is broader than needed.
12. **Captures as a debugging feature** should be gated behind a setting; right now every prompt writes PNGs to the workspace.
13. **`deriveComponentName`** can produce invalid identifiers for digit-leading labels ("404 page" → `404Page`) and empty string for symbol-only labels — the React/story templates would then emit invalid code.
14. **Single-canvas-panel assumption** (`_canvasPanelId`) is baked into ChatViewProvider; the per-panel session machinery used everywhere else in Mysti is bypassed. Multi-canvas (e.g. one per design) needs the same `panelId`-keyed approach.

# 4. NOTABLE STRENGTHS

- **Clean separation of generation pipelines:** every pipeline is an `AsyncGenerator<CanvasStreamChunk>` in CanvasManager, mirroring Mysti's provider streaming model; the extension side is purely a router. Easy to lift individual pipelines into a new architecture.
- **Smart prompt construction is genuinely sophisticated:** transparency detection, theme matching from a region screenshot, hex-color extraction directives, canvas text annotations treated as binding design requirements (`_extractCanvasAnnotations`), and the 4×4-grid cover-crop composition math (`_computeCompositionGuide`) that anticipates how the API output will be cropped into the frame — this is rare attention to generation fidelity.
- **Content-addressed asset externalization** (sha-256 dedupe, `asset://` refs, rehydration on load, auto-`.gitignore` for captures) keeps session JSON small and avoids duplicate media on disk.
- **Robust Stitch response parsing:** `_extractScreenFromRaw` handles four response shapes with diagnostic logging; ESM-only SDK loaded via `new Function('return import(...)')` to dodge webpack rewriting — pragmatic and documented.
- **Overlay positioning discipline:** all DOM overlays (iframes, spinners, video, labels) consistently derive screen rects from `aCoords` + viewportTransform on a rAF debounce — one correct pattern reused everywhere (the snapshot crop, F-1, is the one place that diverges).
- **Webview UX depth:** pan inertia, pinch zoom, minimap, zoom presets, screen list, shift-click multiselect, content-aware smart crop with gravity, inline input modal replacing `window.prompt`, element inspector with live style patching into the iframe — a credible Figma-lite.
- **Visual test dashboard** correctly HTML-escapes all AI-derived text and has a clean chunked update protocol.
- **Error paths generally yield `canvas_error` chunks** rather than throwing across the postMessage boundary, and HTTP helpers map non-2xx bodies into readable errors with truncation.
