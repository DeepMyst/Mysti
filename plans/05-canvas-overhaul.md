# 05 — Canvas Overhaul: Agent-Driven Artifact Studio (DeepMyst 2.0 Parity)

- **Date:** undefined
- **Status:** DRAFT
- **Inputs:** `/tmp/mysti-planning/research/deepmyst-presentation-canvas.md` (target), `/tmp/mysti-planning/research/mysti-canvas-current.md` (baseline incl. uncommitted Canvas v2)
- **Branch context:** `feature/visual-testing` working tree with uncommitted Canvas v2 (CanvasManager, canvasContent.ts, DesignSpecManager, StitchService, generation services)
- **Revision (2026-06-14):** generation/source tools (Stitch, image, video, code-from-design) and external design tools (Figma, Canva, Claude Design) are no longer hardwired services — they become **optional capability connections registered through the DeepMyst Connections hub** (plan 04), with a local BYO-key fallback. The artifact core (store, op executor, job protocol, `mysti-canvas` editing tools) stays local and always-present. New **Proposed Design §9** + **Phase 6** capture this; the Keep/Replace verdicts, §2/§7, Dependencies, and Open Questions are updated accordingly.

---

## Goal

Rebuild Mysti's canvas from a fabric.js drawing surface with bolt-on generation pipelines into an **agent-driven artifact studio** modeled on DeepMyst 2.0's presentation agent: a persisted structured artifact (deck / document / screen set) is the source of truth; the AI edits it exclusively through a typed READ-ONLY/WRITE tool contract with staged-or-auto application and live mid-turn canvas updates; pages render as sandboxed JSX/HTML with a pre-injected design system and theme tokens; humans co-edit inline with durable overrides and clear conflict rules; the agent can see its own output (render-to-PNG + vision critique) before declaring done; formats are configurable (slides, social, print, living documents); generation and external-source tools (image/video/screen generation, Figma, Canva, …) are **optional capability connections registered through DeepMyst** rather than hardwired services, each emitting provenance-tracked media; and decks export to PNG/PDF/HTML.

Every phase ships something a user can run. Phase 0 makes Canvas v2 trustworthy; Phase 5 ends with exportable, presenter-ready decks.

---

## Current State

Grounded in the working tree (all paths relative to repo root). Full bug inventory: `/tmp/mysti-planning/research/mysti-canvas-current.md` (findings F-1…F-29 referenced below).

### Topology

- One canvas `WebviewPanel` at a time: `ChatViewProvider.openCanvas()` (`src/providers/ChatViewProvider.ts:5024`), single-instance via `_canvasPanelId`; entire wire protocol in `_handleCanvasMessage()` (`ChatViewProvider.ts:5093–5989`, 18 message cases).
- `CanvasManager` (`src/managers/CanvasManager.ts`, 3196 lines) holds all generation pipelines as `AsyncGenerator<CanvasStreamChunk>`: `generateScreen`:898, `editStitchScreen`:997, `generateStitchVariants`:1051, `extractDesignDna`:1119, `generateWebsite`:1212, `promptFrame`:1590, `convertToSvg`:2003, `generateCode`:2095, `editElement`:2329, `integrateComponent`:2488, `generateTheme`:2706, plus the orphaned `generateBatchContent`:1307.
- Webview is a 6,712-line template literal (`src/webview/canvasContent.ts`): fabric.js v6 infinite canvas (pan/zoom/minimap/undo), DOM overlays for live Stitch iframes (`_createStitchIframe`:5331) and component iframes (`_createComponentIframe`:5372), unified prompt bar with slash commands, global tabs (Design/Assets/Code/Themes).
- Services: `ImageGenerationService` (`generate`:189, `analyzeImage`:68), `VideoGenerationService` (Sora `_generateSora`:103, Veo `_generateVeo`:239), `CodeGenerationService` (`generateComponent`:88, `regenerateWithProps`:136, `writeToWorkspace`:183), `StitchService` (singleton, wired in `src/extension.ts:125–127`, never disposed), Playwright `ScreenshotService`/`BrowserManager` (exist for visual testing, unused by canvas generation).
- Protocol types: 40-variant `CanvasStreamChunkType` union (`src/types.ts:1447–1496`); `CanvasSession` (`types.ts:1378–1388`) — note `designSpec?` and `stitchProjectId?` fields **exist on the type but are never populated** by any save path.

### The structural inversion problem (most important)

The structured design model — `DesignSpec` tree, theme library, `_stitchScreenRef`, `_viewData` glue — lives **only in webview memory** (`canvasContent.ts:1496` `_designSpec`; expando props excluded from `customJsonProps` at `canvasContent.ts:2528`). What gets persisted is the fabric render JSON (`CanvasManager.saveSession`:124–148; `canvasSave` handler `ChatViewProvider.ts:5109–5119` writes only `canvasJson`). On reload the design semantics are gone (F-16): Stitch screens degrade to faint rects, `/edit`/`/variants`/`/design-dna` lose their targets, the theme library evaporates. This is exactly backwards for a DeepMyst-style integration, where **the artifact in storage is the single source of truth and the rendered canvas is derived**.

`DesignSpecManager` (`src/managers/DesignSpecManager.ts:29`, new/uncommitted) already provides pure-data DesignSpec CRUD/theme/assets on the extension side — but nothing routes through it for persistence.

### Confirmed defects that gate any overhaul (from F-1…F-29)

- **F-1** snapshot crops use world coords where fabric v6 `toDataURL` expects viewport coords (`canvasContent.ts:3943–3951`) — every AI reference image is wrong once panned/zoomed.
- **F-2** undo/redo passes a v5 callback that v6 treats as a reviver (`canvasContent.ts:2554–2560`) — can permanently kill autosave/history. **F-12** first undo is a no-op.
- **F-3** prompt-bar `/edit` `/variants` `/html` `/design-dna` never send `stitchScreenRef` (`canvasContent.ts:3606–3616` vs `ChatViewProvider.ts:5645–5727`) — advertised commands always error.
- **F-4** job overlays leak permanent spinners — webview action names don't match `CanvasManager.parseUnifiedPrompt` (`CanvasManager.ts:2532`) and six action types map to no `_pending*Job` slot.
- **F-5** OpenAI vision path always 400s (`max_tokens` with `gpt-5-mini`, `ImageGenerationService.ts:138–141`) — kills `/svg`, `/code`, element edits for OpenAI-only users.
- **F-6 (security)** generated/Stitch HTML runs in `allow-scripts allow-same-origin` Blob iframes with unpkg CDN scripts (`canvasContent.ts:5346, 5388, 5992`) — injected code can reach `vscodeApi` and write workspace files via `canvasUpdateProps`.
- **F-7** "Apply props" regenerates components from a hardcoded empty SVG (`canvasContent.ts:4562–4571`, `CodeGenerationService.ts:153–163`).
- **F-9/F-10** Veo sends unsnapped durations and downloads videos without the API key (`VideoGenerationService.ts:248–272, 312–317`).
- **F-11 (security)** all canvas API keys in plaintext sync-able settings (`package.json:1209–1235`) instead of SecretStorage; `StitchService` mutates `process.env` (`StitchService.ts:121`).
- **F-15** the entire batch-generation pipeline (~500 LoC) plus `canvas_component_render_complete`, `canvasImportScreenshot`, `canvas_website_complete` are dead code with no producers.
- **F-21** canvas CLI calls share the `'default'` provider session (no panelId at `CanvasManager.ts:480, 584, 1558, 1954`) — concurrent jobs clobber each other; there is **no cancellation** for any canvas job.
- No job IDs anywhere: webview tracks seven `_pending*Job` singletons; extension repeats the same 12-line for-await/post block ~14× (`ChatViewProvider.ts:5275–5770`).

### Strengths to preserve

- AsyncGenerator pipeline pattern mirroring Mysti's provider streaming (easy to lift into new architecture).
- Smart-prompt construction: annotation extraction as binding directives, hex-color directives, theme matching, 4×4-grid cover-crop composition math (`_buildSmartPrompt`, `_computeCompositionGuide`).
- Content-addressed asset externalization (`externalizeAssets` `CanvasManager.ts:1669`, sha-256 dedupe, `asset://` refs, rehydration).
- Consistent `aCoords`→screen overlay positioning discipline (the pattern Phase 3's page iframes will reuse).
- Playwright already in-repo (`src/services/ScreenshotService.ts`, `BrowserManager.ts`) — the raw material for DeepMyst's render-to-PNG self-QA loop and for exports.

### Gap table: Mysti Canvas v2 vs DeepMyst presentation agent

Disposition legend: **Adopt** (build it), **Adapt** (build a Mysti-shaped equivalent), **Defer** (post-plan roadmap), **Skip** (doesn't fit a VSCode extension), **Keep** (Mysti already has it / keep ours).

| # | DeepMyst capability | Mysti today | Disposition / phase |
|---|---|---|---|
| 1 | Agent-authored per-slide React (JSX) compiled in sandboxed iframe with pre-injected `UI.*` design system, Tailwind, Recharts | Stitch returns opaque HTML screens; generated components are one-off React files in iframes; no primitives contract, no design system | **Adopt** — Phase 3 |
| 2 | Dual representation per slide (structured elements + JSX) with `slide_mode` switch | DesignSpec node tree exists (webview-only) but is a wireframe, not a renderable structured mode | **Adapt** — Phase 1 (`ArtifactPage.mode: 'html' \| 'jsx' \| 'structured'`; Stitch output = `html` mode) |
| 3 | Theme-token contract end-to-end (CSS vars, banned raw hex, brand rules snapshotted per deck) | `DesignTheme` + `_generateThemeCssVars` (`CanvasManager.ts:3172`) exist; theme library webview-only, nothing enforced | **Adopt** — Phases 1 (persist) + 3 (enforce in sandbox/prompt) |
| 4 | Multi-format CanvasSpec catalog (16:9/social/print/book, design-px normalization, bleed/gutters, per-format prompt personas, format switch → agent re-layout) | None — frames are arbitrary rects; `CANVAS_RENDER_DEFAULT_VIEWPORT` only | **Adopt** (minus book gutters) — Phase 4 |
| 5 | Multi-surface render from one source (editor, thumbnails, presenter, share viewer, export page) | Single canvas surface only | **Adapt** — Phase 5 (editor + presenter + export; share viewer skipped) |
| 6 | 63 typed tools with explicit READ-ONLY/WRITE contract + anti-fabrication prompt rules | Zero tools — slash commands parsed from prompt-bar text (`parseUnifiedPrompt`), agent in chat cannot touch the canvas at all | **Adopt (scaled to ~20 tools)** — Phase 2 |
| 7 | Staged-suggestion write model (proposed/previous value, accept/reject/bulk, supersession, run attribution, auto-apply opt-in) | None — generations land directly on canvas, irreversibly except fabric undo | **Adopt** — Phase 2 |
| 8 | Mid-turn live canvas updates keyed by deck-modifying-tool set | Per-chunk overlay updates exist but only for prompt-bar jobs; chat-driven edits impossible | **Adopt** — Phase 2 (`page_updated` events) |
| 9 | Typed SSE protocol: heartbeat w/ elapsed seconds, `ask_user` dynamic forms, `auto_continue`, budget exits | 40 stringly chunk types, no job ids, no heartbeats, no cancellation | **Adapt** — Phase 1 (job envelope) + Phase 2 (heartbeats); `ask_user` forms Defer (reuse chat's existing ask_user) |
| 10 | Auto-continue on max_tokens, turn budgets, retry, poisoned-session recovery, stream survives navigation | CLI providers handle their own continuation; `retainContextWhenHidden` keeps webview alive | **Keep/Defer** — rely on CLI; add per-job timeout + cancel in Phase 1 |
| 11 | Deck snapshot index in system prompt + mandatory read-before-write + prompt-cache split | Nothing — canvas state reaches the AI only as (broken, F-1) screenshots | **Adopt** — Phase 2 (`buildArtifactIndex()`); cache split Skip (CLI-managed) |
| 12 | Server-validated tool inputs w/ cross-document write guards | No validation layer | **Adopt** — Phase 2 (`CanvasOpExecutor` page-belongs-to-artifact checks) |
| 13 | `validate_slide`/`validate_deck` rule engines | None | **Adopt (reduced rule set)** — Phase 4 |
| 14 | `render_slide_preview`: render-to-PNG + Claude-vision critique loop | Playwright + `analyzeImage` both exist but are never composed; vision broken for OpenAI (F-5) | **Adopt** — Phase 4 (highest-leverage gap: parts already in repo) |
| 15 | `analyze_visual` safe zones / palette / salient regions for text placement | `analyzeImage` is freeform text; smart prompt has hex/theme directives but no safe-zone loop | **Adapt** — Phase 4 (structured JSON contract on existing `analyzeImage`) |
| 16 | Video validation loop (frame audits, regenerate-from-frame, splice, seams) | Sora/Veo single-shot gen only (with F-9/F-10 bugs) | **Defer** — out of scope; fix bugs in Phase 0 |
| 17 | One-shot "Fix with AI" repair wired to render error boundary | None; broken component iframes just fail | **Adopt** — Phase 3 |
| 18 | In-iframe inline text editing + AST-anchored byte-stable source splicing + overrides fallback | Element inspector patches styles live into iframe and can flush via `applyElementEdits` (AI round-trip); no inline text edit, no source splicing | **Adapt** — Phase 3 (string-replace + `element_overrides` first; AST splicing as enhancement) |
| 19 | Per-element transform overrides on generated JSX + dropped-asset overlay layer | Fabric-native moves exist but only for fabric objects, not elements inside generated HTML | **Adopt** — Phase 3 |
| 20 | Selection gizmos, inspectors, raw-code inspector, refine-element-via-AI popover | Fabric selection + element inspector + iframe click-to-select bridge exist | **Keep**, extend in Phase 3 (page-level inspector) |
| 21 | Deck-wide snapshot undo spanning user edits and accepted agent suggestions | Fabric-JSON undo stacks (broken: F-2/F-12; bloated: F-27) covering only fabric state | **Adapt** — Phase 2 (op-log undo on artifact; fabric undo stays for freeform layer) |
| 22 | Per-document mutation serialization queue + save status; block-version optimistic concurrency, locks | 500ms debounced whole-canvas autosave; no versioning, no locks | **Adapt** — Phase 2 (page `version` + stale-op rule + edit lock) |
| 23 | Threaded comments at deck/slide/element scope, agent can add/resolve | None | **Defer** |
| 24 | Image tool suite w/ provenance (parent/crop/mask lineage, cost) | `generate` + reference-image edits exist; no provenance, no bg-removal/recolor/crop tools | **Adapt** — Phase 4 (provenance + `generate_visual`); editing primitives (bg-removal/upscale/inpaint) come from the `canvas-media-edit` capability backed by **fal** (§9 / Phase 6) |
| 25 | Long-form video pipeline (chaining, anchors, stitching, rehosting) | Single-clip Sora/Veo | **Defer** |
| 26 | `deep_research` / `extract_evidence` grounding tools | Chat providers have their own web tools | **Skip** — CLI agents bring their own |
| 27 | Positioning math tools (`slide_coordinates_grid`, `calculate_slide_position`) | None (smart-prompt grid math exists for image cropping only) | **Adopt (single tool)** — Phase 3 |
| 28 | Async export jobs: PDF, editable PPTX (DOM walker → python-pptx), PNG zip, HTML | PNG-of-viewport save dialog only (`canvasExport`, `ChatViewProvider.ts:5789`) | **Adapt** — Phase 5 (PNG/PDF/HTML via Playwright; editable PPTX Defer, raster PPTX optional) |
| 29 | Public share links, email gates, per-slide analytics | None | **Skip** — requires a backend Mysti doesn't have; HTML-bundle export instead |
| 30 | Presenter view, embed page, auto-thumbnails, waiting mini-game | None | **Adapt** — Phase 5 (presenter + thumbnails; mini-game skip) |
| 31 | Tiered canvas-agent permission model (observer/suggester/autonomous) w/ typed rejections, audit | Mysti has OperationMode/AccessLevel + permission cards + AutonomousManager for chat, none of it reaches canvas | **Adapt** — Phase 2 maps `staged`↔ask-permission, `auto`↔full-access/autonomous, reusing permission-card UX |
| 32 | NL agent-builder for canvas agents | N/A | **Skip** |
| 33 | Live data bindings (`DataBinding`, `<UI.Chart binding>`, refresh policies) | None | **Defer** — design `UI.Chart` payload in Phase 3 to be binding-ready |
| 34 | Per-turn real-cost accounting for media | None | **Defer** — record per-asset model/size metadata in Phase 4 as the hook |

### Keep / replace verdict on Canvas v2

| Component | Verdict | Rationale |
|---|---|---|
| fabric.js infinite board | **Keep, demoted to spatial shell + freeform layer** | Pan/zoom/minimap/annotations/moodboarding are real value and the overlay-positioning discipline already hosts live iframes. But fabric JSON stops being the source of truth: artifact pages render as iframe overlays anchored to proxy rects; fabric persists only the freeform layer (annotations, uploaded images, ad-hoc frames). Replacing fabric outright (DeepMyst's pure-DOM `ScaledSlide`) is a bigger rewrite for less benefit in v1 — revisit in Open Questions. |
| `DesignSpecManager` | **Keep, grow into `ArtifactStore`** | Already the right shape (pure data ops, extension-side). |
| `ImageGenerationService` / `VideoGenerationService` | **Keep as the _local fallback backend_ of the `canvas-image`/`canvas-video` capabilities** (fix F-5/F-9/F-10/F-25) | The capability is preferentially **DeepMyst-brokered** (§9); these bundled services are the BYO-key fallback for offline / non-DeepMyst users. Still surface as `generate_visual`/`generate_video`, but routed through `CanvasCapabilityRegistry`, not called directly. |
| `CodeGenerationService` | **Keep, narrowed — `canvas-code` capability backend** | Component-from-design stays as the "export to code" path; F-7 fixed; no longer the primary rendering route; gated/optional like the others. |
| `StitchService` | **Keep as the local backend of the optional `canvas-screens` capability** | Stitch screens become `html`-mode pages; Stitch is now one *optional, registered* generator (DeepMyst-brokered when available, else local key), not a hardwired pipeline. |
| 40-chunk `CanvasStreamChunkType` protocol | **Replace** with jobId envelope (Phase 1) | F-4 class of bugs is structural. |
| Batch pipeline, `canvasRenderComponent` stub, `canvasImportScreenshot` | **Delete** (already unreachable, F-15) | |
| `canvasContent.ts` as template literal | **Replace** with webpack-compiled webview modules (Phase 1) | 6.7k untyped lines is where F-8-class typos live; Phases 2–5 add too much webview code to keep inlining. |
| Smart-prompt construction, asset externalization, overlay math | **Keep verbatim**, relocate | |

---

## Proposed Design

### 1. Artifact model (source of truth, persisted)

New types in `src/types.ts`:

```ts
interface CanvasArtifact {
  id: string; version: number;            // monotonically increasing artifact version
  kind: 'deck' | 'document' | 'screens' | 'board';
  name: string;
  format: CanvasFormatSpec;               // see §4
  theme: DesignTheme;                     // snapshotted at creation (DeepMyst pattern)
  pages: ArtifactPage[];
  assets: CanvasAssetRecord[];            // provenance-tracked media
  opLog: CanvasOp[];                      // staged + applied ops (undo/audit source)
  createdAt: number; updatedAt: number;
}
interface ArtifactPage {
  id: string; version: number;            // bumped on every applied mutation
  mode: 'html' | 'jsx' | 'structured';
  htmlSource?: string;                    // Stitch screens, plain HTML pages
  jsxSource?: string;                     // function Page() React component (Phase 3)
  nodes?: DesignNode[];                   // structured mode (existing DesignNode)
  actionTitle?: string; notes?: string; source?: string;
  elementOverrides?: Record<string, ElementOverride>;  // DOM-index-path keyed
  droppedAssets?: DroppedAsset[];
  stitchRef?: StitchScreenRef;            // provenance for Stitch-backed pages
}
interface CanvasOp {
  opId: string; runId: string;            // runId = chat turn / job id
  kind: 'insert_page'|'edit_page'|'delete_page'|'reorder'|'set_theme'|'set_format'|'edit_element'|'add_asset';
  targetPageId?: string; baseVersion?: number;
  proposedValue: unknown; previousValue?: unknown;
  status: 'pending'|'applied'|'rejected'|'superseded'|'stale';
  author: 'agent'|'user'; ts: number;
}
```

Persistence: `.mysti/canvas/<artifactId>/artifact.json` + existing content-addressed `assets/` dir. `CanvasSession.canvasJson` continues to hold **only the freeform fabric layer**; `CanvasSession.designSpec`/`stitchProjectId` (fields already declared at `types.ts:1386–1387`) are superseded by `artifactId` linkage. The webview derives proxy rects + iframe overlays from the artifact on load — reload-safe by construction.

### 2. Agent-to-canvas protocol

Mysti has no server tool loop — providers are external CLIs. Two transports feed one executor:

- **Primary — local MCP tool server** (`mysti-canvas`): a stdio MCP server bundled with the extension, registered into canvas-linked chat sessions per CLI. It exposes only the **artifact-editing / render / export tools** that must run in-process against `.mysti/canvas/` (these can't be brokered remotely): `list_pages`, `read_page`, `insert_page`, `edit_page`, `write_page_jsx`, `delete_page`, `reorder_pages`, `set_theme`, `set_format`, `edit_element`, `page_coordinates` (anchor math), `add_asset` (commit a generated asset into the artifact), `list_assets`, `render_page_preview`, `validate_page`, `repair_page`, `export_artifact` — each description prefixed `READ-ONLY (...)` or `WRITE (stages an edit)` per DeepMyst's contract. **Session-scoped registration is owned by this plan (Phase 2.3)** — plan 04's `IMcpConfigAdapter` only writes persistent global/workspace config files and defines no session/temp-file/CLI-arg lane, so there is nothing there to reuse for per-session scoping. Per-CLI reality: Claude Code is the only CLI with true per-invocation config (`--mcp-config <tempfile>` appended in `buildCliArgs`); Gemini/Qwen (`settings.json`) and Codex (`config.toml`) support only persistent config, so canvas registration there is a marker-tagged persistent entry written on link and removed on unlink/panel dispose (details and cleanup rules in Phase 2.3).
- **Generation / external-source tools are NOT in `mysti-canvas`** — they are **optional capability connections** (`generate_visual`, `generate_video`, screen generation, Figma/Canva import, …) registered through the DeepMyst Connections hub and reached via the single DeepMyst MCP broker already in every CLI's config (plan 04), with a local BYO-key fallback. The agent composes the two: call a connection's generation tool → call `mysti-canvas` `add_asset`/`insert_page`/`write_page_jsx` to commit the result into the artifact, where the executor applies staging/approval/versioning uniformly. Full model in **§9**; capability gating + the extension-host MCP client in **Phase 6**.
- **Fallback — fenced op blocks** for providers without workable MCP support: the system prompt instructs emitting ` ```canvas-op ` fenced JSON; a stream-side parser converts them into the same ops. Lower fidelity (no tool results back), so capabilities degrade: fallback providers get WRITE ops + the artifact index, not READ tools.

Both routes hit **`CanvasOpExecutor`** which: validates (`targetPageId` belongs to artifact — DeepMyst's cross-deck guard), checks `baseVersion`, stages a `CanvasOp`, and per **approval mode** either auto-applies or parks it pending. Approval mode maps onto Mysti's existing semantics: `ask-permission`/default → staged (op card in webview Suggestions rail, reusing the permission-card interaction pattern); `full-access` or autonomous mode → auto-apply with audit (SafetyClassifier not needed — ops only touch `.mysti/canvas/`).

Every applied op emits a **`CanvasJobEvent`** to the webview: `{ jobId, type: 'started'|'progress'|'heartbeat'|'op_staged'|'op_applied'|'page_updated'|'asset_ready'|'error'|'done', ... }` — replacing the 40-chunk union. `page_updated` re-renders just that page's iframe **mid-turn** (DeepMyst's per-tool-result refetch analog). `heartbeat` carries `elapsedSeconds` for long media tools.

**Prompt-side statefulness:** when a chat panel is canvas-linked, `buildArtifactIndex()` injects a compact index into the system prompt (one line per page: full id, mode, actionTitle) + the rule "call `read_page` before editing; never describe an edit in past tense unless a WRITE tool ran this turn."

### 3. Editing + conflict rules (agent-editable AND user-editable)

- Each `ArtifactPage` has `version`. User edits (inline text, overrides, inspector) apply immediately, bump `version`, and append a user-authored op to the log.
- Agent WRITE ops carry `baseVersion` (from their `read_page`). On apply, mismatch → op status `stale`, surfaced in the Suggestions rail with a "re-read & retry" affordance — never silently clobbered (DeepMyst's `version_mismatch` + supersession surfacing).
- While the user is inside an inline-edit session on a page, that page is **locked**: incoming agent ops for it queue as pending until blur (per-block lock analog).
- A later applied whole-artifact op (`replace`-style) marks still-pending ops on affected pages `superseded`.
- **Undo** is op-log based and artifact-wide: undo re-applies `previousValue` of the last applied op regardless of author — "undo the slide the agent just deleted" works. Fabric's snapshot undo remains only for the freeform layer (and gets its F-2/F-12 fixes in Phase 0).
- User inline edits persist like DeepMyst's v1 fallback chain: exact string replace into `htmlSource`/`jsxSource` when unambiguous, else `elementOverrides[domIndexPath].innerHtml`. AST-anchored splicing is a later enhancement (extension host can use `@babel/parser`; the webview cannot).

### 4. Formats (configurable canvas, per DeepMyst's configurable_canvas_formats_plan)

`CanvasFormatSpec { formatId, kind: 'screen'|'print', width, height, dpi?, bleed?, safeMargin? }` with a catalog: `deck-16x9` (default 1920×1080), `deck-4x3`, `square-1x1`, `portrait-4x5`, `story-9x16`, `landscape-1.91x1`, `a4-portrait`, `a4-landscape`, `us-letter`, `custom`. Longer edge normalized to 1920 design px (DeepMyst convention — keeps primitives tuned across formats). Print formats compute bleed/safe-margin in design px and draw guide overlays. Each format contributes a **prompt persona** paragraph (portrait → stack vertically, no 3-column; square → centered focal block; print → margins/no animations). Format switch stages a `set_format` op and offers an agent re-layout pass. `kind:'document'` artifacts (living documents) are a vertical scroll of pages with `a4-portrait`-like geometry and block-level ops — the lightweight Canvas-Agents analog, no Editor.js.

### 5. Rendering stack

- Pages render in **per-page sandboxed iframes** (`sandbox="allow-scripts"` only — no `allow-same-origin`, fixing F-6) anchored to invisible fabric proxy rects via the existing aCoords→screen overlay math. Communication via `postMessage` + `MessageChannel`.
- Sandbox runtime bundled locally in `resources/canvas-sandbox/` (no unpkg): React 18 UMD, Babel standalone (jsx mode only), Recharts UMD, Lucide, a precompiled utility CSS sheet, `ui-primitives.js` exposing `UI.*` (`ActionTitle`, `SectionHeader`, `StatCard`, `Callout`, `QuoteCard`, `PullStat`, `SourceFooter`, `ThemedImage`, `Chart`), `harness.js` (theme CSS vars on `:root`, `asset://` token rewrite, `data-el` DOM-index tagging, inline-edit listeners, override application, size reporter, error boundary → `page_render_error`).
- `html` mode (Stitch output, simple pages) skips Babel entirely — same harness, raw HTML.

### 6. Self-QA loop

`render_page_preview` tool: executor renders the page standalone (temp HTML file → `ScreenshotService` Playwright capture at format dimensions) → `ImageGenerationService.analyzeImage` with a structured critique contract (overflow/clipping/contrast/empty-chart + up to 5 targeted questions) → returns issues JSON to the agent. `validate_page` is the cheap static sibling (rules: text overflow heuristics, missing actionTitle, raw hex when theme locked, asset token resolution). The canvas system prompt mandates preview-before-done for new pages, mirroring DeepMyst.

### 7. Media studio integration

`generate_visual` / `generate_video` resolve their capability through `CanvasCapabilityRegistry` (§9) — DeepMyst-brokered MCP when connected, else the local bundled service, else off — rather than calling a service directly; every result becomes a `CanvasAssetRecord { id, role, prompt, model, size, parentAssetId?, sourcePageId?, ts }` in the artifact (provenance), referenced from pages via existing `asset://` tokens. `analyze_visual` returns structured safe-zones/palette JSON, and the smart-prompt machinery (kept from Canvas v2) gains the DeepMyst DESCRIBE→PROMPT→SEE→ASSEMBLE guidance: generate with negative space, analyze, place text in the best safe zone. Reference-conditioned generation already exists (`/v1/images/edits` path) — exposed as a tool parameter.

### 8. Exports

`CanvasExportService` (Playwright, reusing `BrowserManager`): per-page PNG at 2×, PDF (format-aware page size via `page.pdf`), self-contained HTML bundle (pages + assets + minimal viewer — the no-backend substitute for share links). Raster PPTX via `pptxgenjs` optional. Export runs as a canvas job with progress events.

### 9. Capabilities as registered, optional connections (DeepMyst-brokered)

Generation and external-source tools are **not** compiled-in dependencies. The canvas is a composition of two tiers:

**Tier 1 — Local core (always present, in-process).** `ArtifactStore`, `CanvasOpExecutor`, `CanvasJobRouter`, the local `mysti-canvas` stdio server (artifact-editing/render/QA/export tools of §2), and Playwright render/export. These operate on `.mysti/canvas/` and run in the extension host — never remote, never optional. The canvas hand-authors and edits structured pages with **zero connections**.

**Tier 2 — Capability connections (optional, registered).** Every *generation* or *external-source* capability is identified by a slug and enabled/disabled through the **DeepMyst Connections hub** (plan 04):

| Capability slug | Provides | Preferred source | Local fallback |
|---|---|---|---|
| `canvas-screens` | Stitch-style screen generation → `html` pages | DeepMyst-brokered (if exposed) | `StitchService` + key |
| `canvas-image` | image generation / reference edits | DeepMyst-brokered, **or fal (FLUX/SDXL)** | `ImageGenerationService` (OpenAI) **or fal** + key |
| `canvas-video` | short clips | DeepMyst-brokered, **or fal (Kling/SVD)** | `VideoGenerationService` (Sora/Veo) **or fal** + key |
| `canvas-media-edit` | upscale / background-removal / inpaint / recolor (advances gap #24) | DeepMyst-brokered, **or fal** | **fal** + key |
| `canvas-code` | component-from-design export | local (CLI provider) | n/a |
| `figma` | import frames / push pages | DeepMyst-brokered (Composio/Smithery) | direct Figma MCP token |
| `canva` | on-brand design create / export | DeepMyst-brokered (Composio/Smithery) | direct Canva connector |
| `claude-design` | import/export interop (overlapping surface, not a tool dependency) | n/a | n/a |

**Capabilities are not vendor-bound.** A slug can resolve to any of several candidate backends — e.g. `canvas-image` to a DeepMyst-brokered model, OpenAI gpt-image, or **fal.ai** (600+ models incl. FLUX/Kling/SVD/audio); the registry picks per `source`/setting. **fal is a first-class backend of the media capabilities** (the plan already cites it as DeepMyst's media-layer analog): it ships its own STDIO/HTTP **MCP server** (drop-in `deepmyst`-brokered *or* `local` with a `FAL_KEY`), its **queue API with progress maps directly onto the job router's `heartbeat` events**, and its upscale/bg-removal/inpaint models give `canvas-media-edit` real editing primitives (the part gap #24 left "partial").

- **Preferred source = DeepMyst-brokered MCP.** The user enables the connection in DeepMyst (Composio/Smithery-backed); its tools become reachable through the **single DeepMyst MCP broker plan 04 already registers into every CLI** (`McpConfigManager`) — no per-tool registration in Mysti, no Mysti-held third-party keys (only the `dm_` bearer in SecretStorage). External tools (Figma/Canva and anything else the hub offers) ride this path with **no Mysti code** beyond a registry entry + a bridging prompt convention.
- **Fallback source = local BYO-key service** (the Phase 0 `CanvasSecrets` path) for offline / non-DeepMyst users. Mysti's own generators (Stitch/image/video) are demoted to this fallback backend of their capability, not the primary path.
- **Off** = neither connected nor keyed → the tool/command is hidden, and asking for it emits plan 04's `<<<MYSTI_CONNECT:slug>>>` in-chat connect card.

`CanvasCapabilityRegistry` (new): `slug → { enabled, source: 'deepmyst' | 'local' | 'off', mcpSlug?, localService? }`, computed from DeepMyst connection status + `CanvasSecrets` + `mysti.canvas.capabilities.*`. It drives **UI gating**: a prompt-bar command (`/generate`, `/video`, `/svg`, `/code`, `/design`, `/figma`, `/canva`) and the corresponding tool descriptions appear only when the backing capability is enabled (consistent with the unified-chat-ux manifest approach).

**Two MCP client surfaces.** (a) The **CLI agent** reaches brokered capabilities through the DeepMyst broker already in its config and the local `mysti-canvas` server, orchestrating "generate via a connection → commit via `mysti-canvas` `add_asset`/`insert_page`." (b) The **extension host** holds a small **MCP client** (`McpClient`, Phase 6) so extension-initiated paths (prompt-bar commands, `repair_page`, the `analyze_visual` step of `render_page_preview`) invoke the same brokered capability — falling back to the local bundled service when the capability is in local-key mode.

This split also resolves Open Question 4: artifact-editing tools stay extension-host stdio (`mysti-canvas`) because they need in-process `ArtifactStore`/executor access and only touch local files; credential-bearing generation/source tools are exactly what DeepMyst brokering exists for, so they are connections, not bundled dependencies.

---

## Implementation Phases

### Phase 0 — Stabilize Canvas v2 baseline (ship: current canvas actually works)

Fix the confirmed bugs that would otherwise be inherited or block later phases. All references are to current working-tree lines.

1. **modify `src/webview/canvasContent.ts:3943–3951` (+ full capture at 3884):** F-1 — convert crop bounds world→screen (`left*zoom + vpt[4]`), pass `multiplier: 1/zoom`; for full-scene capture, temporarily reset `viewportTransform` to identity around `toDataURL`, restore after.
2. **modify `src/webview/canvasContent.ts:2554–2560, 2579–2585`:** F-2 — replace callback style with `canvas.loadFromJSON(state).then(() => { restyle; renderAll; isUndoRedoing = false; })`. Same edit fixes the zero-object hang.
3. **modify `src/webview/canvasContent.ts:2530–2565`:** F-12 — fix off-by-one: pop into temp, load new stack top; verify first-undo works after one object add.
4. **modify `src/webview/canvasContent.ts:3606–3616`:** F-3 — `sendUnifiedPrompt` attaches `stitchScreenRef: activeObject?._stitchScreenRef || null`; **modify `src/providers/ChatViewProvider.ts:5645–5727`** to also fall back to `snapshot.selectedRegion.objects[0].metadata` (the `canvasReimagine` pattern at 5151–5157).
5. **modify `src/webview/canvasContent.ts:3586–3598` + `6647–6655`:** F-4 interim — align webview actionType names with `CanvasManager.parseUnifiedPrompt` (`src/managers/CanvasManager.ts:2532`), assign every job a `_pending*` slot, and clear **all** `_genJobs` on `canvas_error`. (Properly replaced by jobIds in Phase 1.)
6. **modify `src/services/ImageGenerationService.ts:138–141`:** F-5 — `max_tokens` → `max_completion_tokens`.
7. **modify `src/webview/canvasContent.ts:4562–4571` + `src/services/CodeGenerationService.ts:136–163`:** F-7 — send real `vd.svgMarkup` and current `codeFiles[0].content`; include current component source in the `regenerateWithProps` prompt.
8. **modify `src/services/VideoGenerationService.ts:248–272`:** F-9 — use the snapped duration for `params.durationSeconds` and the returned metadata. **modify `:312–317, 381–404`:** F-10 — pass `x-goog-api-key` through `_downloadUrl` for `generativelanguage.googleapis.com`; add a redirect-depth cap (F-24).
9. **modify `src/webview/canvasContent.ts:2188–2191` (and cursor readout at 2248):** F-13 — `getViewportPoint` → `getScenePoint`. **modify `:4146–4156, 4235–4245`:** F-18 — `getScaledWidth()/getScaledHeight()`.
10. **delete dead pipelines (F-15):** remove `canvasBatchGenerate` case (`ChatViewProvider.ts:5238`), `generateBatchContent` + `_buildBatchDesignBrief` + `_computeCompositionGuide` callers in `CanvasManager.ts:1307+` (keep `_computeCompositionGuide` itself — reused by smart prompts), `canvas_layout_complete`/batch handlers in `canvasContent.ts:6254–6269`, `canvasRenderComponent` stub (`ChatViewProvider.ts:5927–5963`), `canvasImportScreenshot` (`:5275`), and the corresponding `CanvasStreamChunkType` members in `src/types.ts:1461–1470`.
11. **sandbox hardening (F-6): modify `src/webview/canvasContent.ts:5331–5400, 5992–5994`:** drop `allow-same-origin`; switch Blob URLs to `srcdoc`; replace the `document.write` reload path with iframe recreation; bridge over `postMessage`+`MessageChannel`. Add `resources/canvas-sandbox/` with locally bundled React 18 UMD + Babel standalone (remove unpkg URLs); load via `asWebviewUri` allowance inside srcdoc as inlined script text.
12. **SecretStorage (F-11): create `src/services/CanvasSecrets.ts`** (thin wrapper over `context.secrets` with one-time migration from `mysti.canvas.openaiApiKey`/`geminiApiKey`/`stitchApiKey` settings). **modify** `ImageGenerationService.ts:405–417`, `VideoGenerationService.ts:365–375`, `StitchService.ts:41–45,76,121` (stop mutating `process.env`; pass key explicitly), `ChatViewProvider.ts:5966–5986` (`canvasSaveConfig` → secrets), and mark the three `package.json` key settings deprecated.
13. **small fixes:** F-19 — confirm before overwriting `DESIGN.md` (`CanvasManager.ts:1141–1147`); F-20 — compute real `baseX/baseY` from the source screen bounds (`ChatViewProvider.ts:5679–5683`); F-23 — guard empty `imageBase64` (`CanvasManager.ts:1031, 1098`); F-26 — create a default `_designSpec` before applying a theme (`canvasContent.ts:6605–6621`); F-25 — raise `CANVAS_VIDEO_POLL_MAX_MS` to 600_000 and image HTTP timeout to 180s (`src/constants.ts:134`, `ImageGenerationService.ts:489`); F-29 — dispose `StitchService` in `extension.ts` `deactivate()`.

**Ships:** a Canvas v2 whose advertised commands work, whose AI reference images are correct, and which no longer has the same-origin escape or plaintext keys.

> **Status (2026-06-13):** Phase 0 landed except the **webview side of F-15**. The extension/manager/types side of F-15 is done (`canvasBatchGenerate`/`canvasRenderComponent`/`canvasImportScreenshot` cases, `generateBatchContent`/`_buildBatchDesignBrief` methods, and the dead `CanvasStreamChunkType` members are all removed; `_computeCompositionGuide` kept). The **webview dead-code cluster remains in `src/webview/canvasContent.ts`**: the batch-generate modal (HTML ~1364–1371, CSS ~980–990, handlers ~3308–3367, `canvas_layout_complete` case ~6499–6508, batch chunk handlers ~6772–6802) and the `canvasRenderComponent` fallback emitter (~6202). It is harmless (the emitted messages have no extension-side handler; the modal's only trigger `canvas_layout_complete` is no longer produced) but should be removed during the **canvas F5 validation pass** — the webview JS lives in a template string and is not typechecked, so its removal must be validated in the Extension Development Host alongside the F-6 sandbox/inspector flows.

### Phase 1 — Artifact persistence inversion + typed job protocol + webview build (ship: reload-safe designs, cancellable jobs)

1. **modify `src/types.ts`:** add `CanvasArtifact`, `ArtifactPage`, `CanvasOp`, `CanvasJobEvent`, `CanvasAssetRecord`, `ElementOverride`, `DroppedAsset`, `CanvasFormatSpec` (catalog ids only for now); add `artifactId?: string` to `CanvasSession`; mark `CanvasStreamChunkType` `@deprecated`.
2. **create `src/managers/ArtifactStore.ts`:** composes `DesignSpecManager`; CRUD for `.mysti/canvas/<artifactId>/artifact.json`; atomic write (tmp+rename); asset registry delegating to the externalization logic extracted from `CanvasManager.externalizeAssets` (`CanvasManager.ts:1669`) into a shared helper; op-log append/apply/revert primitives (used fully in Phase 2).
3. **modify `src/managers/CanvasManager.ts`:** `createSession` also creates an artifact and links `session.artifactId`; Stitch pipelines (`generateScreen`:898, `generateWebsite`:1212, `editStitchScreen`:997) write resulting screens into the artifact as `ArtifactPage { mode:'html', htmlSource, stitchRef }` via `ArtifactStore` *in addition to* emitting webview chunks; persist `stitchProjectId` on the artifact (replacing the in-memory `_stitchProjectIds` map at `:82`, fixing restart amnesia).
4. **modify `src/providers/ChatViewProvider.ts:5095–5119`:** `canvasReady` accepts a requested `sessionId` (webview echoes the id `openCanvas` passed into initial HTML state — fixes F-14 race by making `canvasReady` the single load trigger); `canvasLoad` payload includes the artifact; `canvasSave` persists the freeform fabric layer only.
5. **modify webview load path:** on `canvasLoad`, rebuild proxy rects, `_stitchScreenRef`, iframe overlays, and theme library **from the artifact**, not from fabric expandos — closes F-16.
6. **webview extraction: create `src/webview/canvas/` TS modules** (`main.ts`, `board.ts` (fabric setup/overlays), `jobs.ts`, `promptBar.ts`, `tabs.ts`, `messaging.ts`) compiled by a second webpack entry to `dist/canvasWebview.js`; **modify `webpack.config.js`** (add entry + target `web` for this bundle); **shrink `src/webview/canvasContent.ts`** to an HTML shell that loads the bundle via `asWebviewUri` and injects initial state. Port code mechanically; no behavior change in this step beyond what Phases 0–1 already changed.
7. **job protocol: create `src/managers/CanvasJobRouter.ts`** — extension-side: mints/echoes `jobId`, one `pipe(jobId, AsyncGenerator)` helper replacing the ~14 copy-pasted for-await blocks in `ChatViewProvider.ts:5275–5770`; holds an `AbortController` per job. **modify all `CanvasManager` pipeline signatures** to accept `(jobId, signal)` and check `signal.aborted` between awaits. **webview `jobs.ts`:** single `Map<jobId, JobUi>` replacing the seven `_pending*Job` singletons; spinner overlays keyed by jobId (permanently fixes the F-4 class); a Cancel button on every job overlay posting `canvasCancelJob {jobId}`.
8. **fix F-21: modify `src/managers/CanvasManager.ts:480, 584, 1558, 1954`** — pass `panelId: 'canvas-job-' + jobId` into `ProviderManager.sendMessage` so concurrent jobs get isolated provider sessions; cancellation calls `cancelCurrentRequest('canvas-job-' + jobId)`. (Depends on the providers plan's per-panel cancel routing fix — see Dependencies; until it lands, hold a direct reference to the provider instance used.)

**Ships:** designs survive reload (Stitch refs, themes, structure intact), every job is tracked/cancellable, webview code is typed and lintable.

> **Status (2026-06-14):** Phase 1 **extension-side foundation landed and tested** (the structural inversion is in place):
> - **1.1** artifact model types in `src/types.ts` — `CanvasArtifact`, `ArtifactPage`, `CanvasOp`/`CanvasOpKind`/`CanvasOpStatus`, `CanvasJobEvent`, `CanvasAssetRecord`, `ElementOverride`, `DroppedAsset`, `CanvasFormatSpec`; `artifactId` added to `CanvasSession`; `CanvasStreamChunkType` marked `@deprecated`.
> - **1.2** `src/managers/ArtifactStore.ts` — CRUD for `.mysti/canvas/<id>/artifact.json` (atomic tmp+rename), page primitives with page/artifact version bumping, op-log append/find, and a per-artifact content-addressed `assets/` registry with sha-256 dedup + `asset://<id>/assets/<hash>` refs. Root is injectable for hermetic tests. **+15 tests.**
> - **1.3** `CanvasManager` wires an artifact into every `createSession` (in-memory, linked via `session.artifactId`), `recordHtmlPage()` persists Stitch screens into the artifact (`generateScreen`/`editStitchScreen` call it), `ensureArtifact()` rehydrates + seeds the Stitch project-id cache (fixes restart amnesia), and `saveSession` flushes the linked artifact. `getArtifactStore()` shares the store with the executor/linker.
> - **1.7** `src/managers/CanvasJobRouter.ts` — jobId mint/echo, one `AbortController` per job, and a `pipe()` helper that forwards a pipeline's event stream with an exactly-one-terminal-event guarantee (fixes the F-4 leaked-spinner class) and mid-stream cancellation. **+7 tests.**
>
> **Deferred to the canvas F5 pass (webview-coupled / runtime-behavior changes):** 1.4 `canvasReady`/`canvasLoad` payload changes, 1.5 the webview load-from-artifact path (closes F-16 end-to-end), 1.6 the `canvasContent.ts` → typed-modules extraction + second webpack entry, and 1.8's per-job `panelId: 'canvas-job-'+jobId` isolation (belongs with wiring `CanvasJobRouter` into `ChatViewProvider`'s ~14 for-await blocks). The extension-side store/router are ready for that wiring.

### Phase 2 — Agent-to-canvas protocol: tools, staged writes, conflicts (ship: chat agent builds/edits the canvas)

1. **create `src/managers/CanvasOpExecutor.ts`:** validate (target page exists in artifact; `baseVersion` check → `stale`), stage `CanvasOp`, apply/reject/supersede; bump page+artifact versions; emit `op_staged`/`op_applied`/`page_updated` `CanvasJobEvent`s through `CanvasJobRouter`; op-log undo/redo (`undoLastApplied()`); audit line per applied agent op (`[Mysti] canvas-op` log + op log itself).
2. **create `src/services/CanvasToolServer.ts`:** stdio MCP server (use `@modelcontextprotocol/sdk`, run as a child process or in-process stdio bridge) exposing the ~20 tools from Proposed Design §2, each handler delegating to `ArtifactStore`/`CanvasOpExecutor`/generation services; every description prefixed `READ-ONLY (...)`/`WRITE (...)`. Add a small executable entry `src/canvasToolServerMain.ts` bundled to `dist/canvasToolServer.js` (second webpack node entry) so CLIs can spawn it with `--artifact <path>`.
3. **create `src/managers/CanvasSessionLinker.ts`:** when a chat panel is canvas-linked (user ran `/canvas` or clicked "Edit on canvas"), (a) register `mysti-canvas` for the linked session. **Phase 2.3 owns this session-scoped injection mechanism** — plan 04's `IMcpConfigAdapter` defines only persistent global/workspace config writers (`upsert`/`remove`), no session-scoped lane, so it cannot be reused as-is. Per CLI:
   - **Claude Code** (true session scope): write a temp MCP config file (`{tmpdir}/mysti-canvas-<panelId>.json`) and append `--mcp-config <file>` in `buildCliArgs`; delete the temp file on unlink/panel dispose. No persistent footprint.
   - **Gemini/Qwen** (persistent-only — these CLIs have no per-invocation MCP flag; "temp file per session" has no CLI support here): upsert a `mysti-canvas` entry into workspace `.gemini`/`.qwen` `settings.json`, tagged with a `_mystiManaged` marker; remove it on unlink/panel dispose, and sweep stale marked entries on extension activation (crash recovery so canvas tools never leak into unrelated sessions permanently).
   - **Codex** (persistent-only): same managed-entry approach in `~/.codex/config.toml` `[mcp_servers.mysti-canvas]`; spike whether `codex -c mcp_servers.…` per-invocation config overrides work as a true session-scoped alternative (verify task — newer CLIs only).

   Reuse from plan 04 is limited to its low-level write discipline (`configWrite.ts`-style subtree-preserving merge, tmp+rename, backup) for the persistent Gemini/Qwen/Codex files; conversely, plan 04 should later adopt this session lane via a `buildSessionMcpArgs(conn)` adapter extension (see Dependencies). (b) inject the canvas system-prompt block: `buildArtifactIndex()` (one line per page: id, mode, actionTitle) + read-before-write + no-past-tense rules + approval-mode notice.
4. **fallback transport: create `src/managers/CanvasOpParser.ts`:** detects ` ```canvas-op ` fenced JSON in streamed text chunks; **modify `src/providers/ChatViewProvider.ts`** stream loop (the same place markers/visual-test regexes run) to feed text through the parser when the panel is canvas-linked; parsed ops go to `CanvasOpExecutor`; malformed blocks produce a visible `op_error` event rather than silent drop.
5. **approval UI: webview `src/webview/canvas/suggestions.ts`:** Suggestions rail listing pending ops (kind, target page thumbnail, diff summary, Accept/Reject, bulk accept/reject); `canvasOpDecision {opId(s), decision}` message; **modify `ChatViewProvider._handleCanvasMessage`** to route decisions to the executor. Approval mode resolution: panel `AccessLevel`/`OperationMode` + autonomous state → `staged` or `auto` (mapping in `CanvasSessionLinker`).
6. **conflict rules:** implement page lock during inline-edit sessions (webview posts `canvasPageEditState {pageId, editing}`; executor queues ops for locked pages); `stale` ops get a "Re-read & retry" affordance that posts a synthetic instruction back to the linked chat panel.
7. **heartbeats:** `CanvasToolServer` media tools emit `heartbeat {elapsedSeconds}` events every 5s via the job router while awaiting generation.
8. **tests:** add `src/test/canvasOpExecutor.test.ts` covering version-mismatch → stale, supersession, lock queueing, undo of agent op restoring `previousValue`.

**Ships:** "build me a 5-screen onboarding flow" typed in chat produces pages appearing one-by-one on the canvas mid-turn, each reviewable (or auto-applied), with working undo and audit.

> **Status (2026-06-14):** the **executor core + fallback parser landed and tested** ahead of the transport/UI wiring:
> - **2.1** `src/managers/CanvasOpExecutor.ts` — the single executor every transport hits: validates writes (cross-artifact page guard, missing-target/shape checks), enforces `baseVersion` → `stale` (never clobbers, even in auto mode), stages vs auto-applies per approval mode, supersedes still-pending ops on an applied page, queues auto ops behind an inline-edit page lock and flushes on unlock, and does artifact-wide op-log undo restoring `previousValue` across **all** op kinds (agent + user). Emits `op_staged`/`op_applied`/`op_rejected`/`op_error`/`page_updated` via `CanvasJobRouter`. **+15 tests** covering the full conflict matrix.
> - **2.4** `src/managers/CanvasOpParser.ts` — the fenced ` ```canvas-op ` fallback transport: a streaming parser that extracts complete blocks (tolerant of fences split across chunks), ignores surrounding prose with bounded buffering, and surfaces malformed blocks as errors rather than dropping the edit. **+11 tests.**
>
> **Remaining for Phase 2 (transport + UI wiring — pairs with the F5 pass):** 2.2 the `mysti-canvas` stdio MCP tool server (needs `@modelcontextprotocol/sdk` + a `dist/canvasToolServer.js` entry), 2.3 `CanvasSessionLinker` (per-CLI session-scoped registration + the `buildArtifactIndex()` system-prompt block), 2.4 feeding the parser from `ChatViewProvider`'s stream loop, 2.5 the Suggestions-rail approval UI, 2.6's webview `canvasPageEditState` wire, and 2.7 media heartbeats. The executor and parser are ready to be driven by all of these.

### Phase 3 — Sandboxed page renderer, design system, human co-editing (ship: agent-authored slides, inline-editable)

1. **create `resources/canvas-sandbox/`:** `react.production.min.js`, `react-dom`, `babel.min.js`, `recharts.umd.js`, `lucide.umd.js`, `utilities.css` (precompiled Tailwind-subset utility sheet generated at build time — see Open Questions), `ui-primitives.js` (the `UI.*` set: `ActionTitle`, `SectionHeader`, `StatCard`, `Callout`, `QuoteCard`, `PullStat`, `SourceFooter`, `ThemedImage`, `Chart` with a typed structural payload kept export-friendly), `harness.js` (JSX compile, theme CSS vars, `asset://` rewrite via blob URLs minted in the parent, `data-el` index tagging, override application on layout-settle, inline-edit listeners, size reporter, error boundary posting `page_render_error`).
2. **create `src/webview/canvas/pageFrame.ts`:** per-page iframe lifecycle — build `srcdoc` from sandbox runtime + page source + theme; anchor to proxy fabric rect using the existing overlay math (port from `_createStitchIframe`); CSS-transform scale to format design-px; `MessageChannel` bridge; re-render on `page_updated`.
3. **page authoring tools: modify `src/services/CanvasToolServer.ts`:** implement `write_page_jsx` (validate component shape server-side — single `function Page()` export, strip fences, reject imports), `page_coordinates` (anchors: center/thirds/safe-zones for the page's format → exact px); **modify `src/managers/CanvasManager.ts` `parseUnifiedPrompt` (`:2532`)** to add `/slide` and `/deck` prompt-bar commands that route through the same op path (prompt bar becomes another client of the executor).
4. **inline editing:** harness implements `edit_started`/`edit_rect`/`edit_text`/`edit_ended` postMessages; **create `src/webview/canvas/inlineEdit.ts`** — floating format toolbar (bold/italic/size/color → style attrs), persistence chain: unambiguous string replace into `jsxSource`/`htmlSource`, else `elementOverrides[path].innerHtml`; each commit appends a user `CanvasOp` and bumps page version.
5. **element overrides + dropped assets:** drag/resize/rotate selected in-iframe elements via parent-drawn gizmo writing `elementOverrides[path]` transforms; drag/paste an image onto a page → upload to asset store → `droppedAssets` entry rendered by the harness.
6. **error recovery: modify `src/managers/CanvasManager.ts`:** add `repairPage(pageId)` — non-streaming provider call with a minimal-change repair prompt (current source + render error), re-validate, stage as op; webview shows "Fix with AI" on `page_render_error`; expose as `repair_page` tool.
7. **Stitch convergence:** Stitch-generated pages (`mode:'html'`) render through the same pageFrame/harness (replacing the bespoke Stitch iframe path); `generateCodeFromStitch` (`CanvasManager.ts:2214`) remains the "export page to workspace code" action.

**Ships:** the agent authors themed JSX slides with `UI.*` primitives and live Recharts; users click into any text and edit it; broken slides offer one-click AI repair.

### Phase 4 — Formats, self-QA, media studio (ship: multi-format, self-checked, media-rich)

1. **create `src/managers/CanvasFormats.ts`:** the `CanvasFormatSpec` catalog from Proposed Design §4; longer-edge-1920 normalization; bleed/safe-margin computation for print formats; `buildFormatPersona(spec)` prompt text; **webview `src/webview/canvas/printGuides.ts`** draws trim/safe overlays on print-format pages; format picker UI in the prompt bar; format switch stages `set_format` + offers "re-layout with AI" (a synthetic instruction to the linked chat).
2. **self-QA: modify `src/services/CanvasToolServer.ts`:** implement `render_page_preview` — write standalone page HTML to a temp dir, capture with `ScreenshotService`/`BrowserManager` (`src/services/ScreenshotService.ts`, `BrowserManager.ts`) at format dimensions, run `ImageGenerationService.analyzeImage` with a structured critique prompt (issues[] + up to 5 targeted questions), return JSON; cache the PNG as a page thumbnail. Implement `validate_page` (static rules: overflow heuristic from size-reporter data, missing `actionTitle` on deck pages, raw hex when theme present, unresolved `asset://` tokens). **modify `CanvasSessionLinker`** prompt block: mandate preview-before-done for newly written pages.
3. **media provenance: modify `src/managers/ArtifactStore.ts`:** `CanvasAssetRecord` CRUD; **modify `CanvasToolServer`** `generate_visual`/`generate_video` to record `{role, prompt, model, size, parentAssetId, sourcePageId}`; Assets tab (webview `tabs.ts`) lists records with provenance and "regenerate from this".
4. **safe-zone composition: modify `src/services/ImageGenerationService.ts`:** add `analyzeImageStructured()` returning `{safeZones[], palette[], salientRegions[]}` JSON (strict-JSON prompt + parse with fallback); **modify smart-prompt builders in `CanvasManager.ts`** (`_buildSmartPrompt`) to inject DESCRIBE→PROMPT→SEE→ASSEMBLE guidance and pass safe-zone results when placing text over generated imagery; expose as `analyze_visual` tool.
5. **async media pattern:** `generate_video` returns immediately with `{assetId, status:'generating'}` plus a `wait_video {assetId}` tool (DeepMyst's `wait=false` pattern), so the CLI turn isn't held hostage by a 5-minute Veo job; heartbeats continue via job router.
6. **document kind:** enable `kind:'document'` artifacts — vertical page flow, block-targeted `edit_element` ops, `/doc` prompt-bar command. (This is the deliberately-small Canvas-Agents analog.)

**Ships:** same deck re-targeted to 9:16 story or A4 one-pager with agent re-layout; the agent screenshots and critiques its own slides before saying "done"; all media has provenance.

### Phase 5 — Export & presenter (ship: distributable artifacts)

1. **create `src/services/CanvasExportService.ts`:** Playwright-based — `exportPng(artifact, scale=2)` per page; `exportPdf(artifact)` with format-aware page size (`page.pdf`); `exportHtmlBundle(artifact)` → zip of pages + assets + a minimal `viewer.html` (keyboard/swipe navigation) as the no-backend share substitute. Runs as a canvas job (progress/heartbeat events); output to a user-chosen folder via save dialog.
2. **modify `src/providers/ChatViewProvider.ts:5789` (`canvasExport`):** replace viewport-PNG export with an export menu routed to `CanvasExportService`; keep "export visible board as PNG" for the freeform layer.
3. **presenter: create `src/webview/canvas/presenter.ts` + a `mysti.canvasPresent` command (`package.json` contribution + `src/extension.ts` registration):** fullscreen webview panel rendering pages via the same sandbox runtime, arrow/swipe navigation, speaker-notes side channel, ESC to exit.
4. **thumbnails:** reuse Phase 4 preview PNGs as a thumbnail rail (webview `src/webview/canvas/thumbnailRail.ts`) with drag-reorder staging `reorder_pages` ops.
5. **optional raster PPTX:** add `pptxgenjs` dependency behind a setting; one full-bleed PNG per slide + speaker notes. Editable PPTX (DOM walker) explicitly deferred.
6. **expose `export_artifact` tool** so the agent can finish a workflow with "exported deck.pdf to ~/Desktop".

**Ships:** PDF/PNG/HTML-bundle exports, a presenter mode, and a thumbnail rail — the deck lifecycle closes end-to-end inside VSCode.

### Phase 6 — Capability connections: generation + external design tools as optional MCP (ship: nothing hardwired)

Turns every generation/source capability into a registered, optional connection per Proposed Design §9. Can land incrementally alongside Phases 2–4 (it only changes *how* generation is reached, not the artifact contract). Depends on plan 04 having shipped the DeepMyst broker + `McpConfigManager` (it has).

1. **create `src/managers/CanvasCapabilityRegistry.ts`:** `slug → { enabled, source }` computed from `DeepMystAuthManager` connection status (reuse plan 04's connections cache), `CanvasSecrets` (local keys), and `mysti.canvas.capabilities.*` settings. Slugs: `canvas-screens`, `canvas-image`, `canvas-video`, `canvas-media-edit`, `canvas-code`, `figma`, `canva`, `claude-design`. Each slug declares its candidate backends (e.g. `canvas-image` → deepmyst | fal | openai) and resolves one per source/setting. Fires a change event so the prompt bar + tool descriptions re-gate live.
2. **create `src/services/McpClient.ts`:** a thin `@modelcontextprotocol/sdk` *client* for the extension host to call the DeepMyst broker (`${webUrl}/api/v1/mcp` with the `dm_` bearer) for a connection slug + tool. Used only by extension-initiated generation (prompt bar, `repair_page`, the `analyze_visual` step). Agent-initiated generation needs no Mysti code — the broker is already in the CLI config.
3. **route generation through the registry: modify `CanvasManager`/`CanvasToolServer`/prompt-bar handlers:** resolve the capability first — `source==='deepmyst'` → `McpClient` call against the broker; `source==='local'` → the resolved local backend (`StitchService`/`ImageGenerationService`/`VideoGenerationService` with a `CanvasSecrets` key, **or fal** via a direct API client / a locally-spawned fal MCP server with `FAL_KEY` — fal's queue progress feeds the job router's `heartbeat`s); `off` → hide the tool/command and emit a `<<<MYSTI_CONNECT:slug>>>` connect card. Results land via `add_asset`/`insert_page` as before, so provenance + staging are unchanged.
4. **external design tools:** register `figma`/`canva` as brokered connections — registry entry + a one-paragraph bridging convention in the canvas system prompt ("pull from Figma/Canva, then `insert_page`/`write_page_jsx`"); `claude-design` is import/export interop only (import an artifact as a page; no tool dependency).
5. **UI: modify the canvas connections affordance** to list canvas capabilities with status (DeepMyst-connected / local key / off) and a per-capability "Connect via DeepMyst" / "Add local key" action, reusing the `media/connections/` panel patterns from plan 04.
6. **settings + gating:** `mysti.canvas.capabilities.<slug>` (`auto` | `deepmyst` | `local` | `off`); prompt-bar commands and the canvas-link affordance gate on registry state; deprecate the direct-call paths.

**Ships:** Stitch, image/video generation, Figma, and Canva are all optional connections the user turns on through DeepMyst (or a local key) — none hardwired — and the agent composes them with the always-present local artifact tools. A fresh install with no connections still hand-authors and edits decks.

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **Scope: DeepMyst's presentation stack is ~50k LOC with a server.** Blind parity is unachievable in an extension. | Plan death by ambition | The gap table assigns explicit Skip/Defer to backend-dependent items (shares, analytics, video repair pipeline, comments). Tool count capped ~20 vs 63. Each phase independently shippable; stop-points after Phases 2, 3, 4 are all coherent products. |
| **MCP support varies per CLI** (config formats differ; some providers have none). | Protocol works only for some backends | Dual transport from day one: fenced `canvas-op` fallback (Phase 2.4) reuses the existing stream-marker parsing seam. Capability-gate the canvas-link button per provider (consistent with the unified-chat-ux plan's manifest approach). |
| **Generation now depends on a DeepMyst connection (or local key) being enabled** (§9 / Phase 6) — a fresh, signed-out install has no image/video/screen generation. | Feature appears "missing" | The artifact core (author, edit, structure, theme, export) needs **zero** connections, so the canvas is useful out of the box; generation commands are gated + hidden when off and surface a `<<<MYSTI_CONNECT:slug>>>` connect card on request; local BYO-key fallback keeps offline / non-DeepMyst users fully functional. |
| **Webview extraction (Phase 1.6) is a big mechanical churn** colliding with uncommitted Canvas v2 and open PRs. | Merge pain, regressions | Land Phase 0 fixes *inside* the template literal first and commit Canvas v2; do extraction as a single no-behavior-change commit verified by side-by-side smoke test; coordinate with github-triage plan merge order (PRs #37/#43/#45/#47 don't touch canvas files, but package.json/types.ts conflict with #37). |
| **Per-job provider sessions / cancellation depend on broken `ProviderManager.cancelRequest` routing** (resolves global default provider — providers research). | Canvas cancel no-ops for non-default providers | Phase 1.8 holds a direct reference to the provider instance it called and cancels on that instance until the providers plan's routing fix lands. |
| **Sandbox without `allow-same-origin` breaks current bridge features** (style patching, DOM extraction use direct access in places). | Inspector regressions in Phase 0.11 | The bridge already communicates mostly via postMessage; replace the one `document.write` reload with iframe recreation; budget explicit QA on inspector flows. |
| **Offline Tailwind:** DeepMyst uses Tailwind Play CDN; Mysti must work offline and CSP-clean. | Generated JSX referencing arbitrary Tailwind classes won't style | Ship a generated utility CSS covering the class subset the prompt instructs the model to use + theme tokens; prompt bans arbitrary-value classes; `validate_page` flags unknown classes. Revisit with a real JIT step if quality suffers (Open Question 2). |
| **Babel-in-iframe needs `unsafe-eval`-equivalent inside srcdoc.** | CSP conflicts | Page CSP doesn't govern sandboxed iframes without `allow-same-origin`; verify on VSCode stable+insiders early in Phase 3 (spike task); fallback: precompile JSX→JS in the extension host with `@babel/standalone` in Node, ship only compiled JS to the iframe (also removes Babel from the sandbox payload). |
| **Version/lock conflict model is novel surface area.** | Lost edits, user distrust | Op log records `previousValue` for *every* applied op (agent and user), so any clobber is recoverable; Phase 2.8 tests cover the matrix; staged mode is the default. |
| **Performance: N live iframes + fabric on one webview.** | Sluggish boards on big decks | Virtualize: only pages intersecting the viewport get live iframes; off-screen pages show cached preview PNGs (Phase 4 thumbnails); the existing rAF-debounced overlay sync already throttles positioning. |
| **fabric.js remains a dependency with known sharp edges** (v6 API misuse class of bugs). | Recurring breakage | Phase 0 fixes all known instances; demoting fabric to the freeform shell shrinks its blast radius; long-term replacement is Open Question 1, not a blocker. |

---

## Dependencies

Other plans in this series are not yet written to `plans/` (numbering TBD); referenced by topic:

- **Providers stability plan** (research: `mysti-providers.md`): per-panel cancel routing and the `ChildProcess.killed` SIGKILL fix directly affect Phase 1.8 job cancellation. Canvas works around it interim (direct provider reference) but should adopt the fixed path.
- **MCP connections plan** (`plans/04-connections-and-agent-management.md`, research: `deepmyst-mcp-connections.md`): **now load-bearing for Tier 2** (Proposed Design §9 / Phase 6). Generation + external-source capabilities (Stitch/image/video/Figma/Canva) are reached through the DeepMyst MCP broker that plan 04's `McpConfigManager` already writes into every CLI, and enabled via the Connections hub — Phase 6 only adds the `CanvasCapabilityRegistry`, an extension-host `McpClient`, and gating. The local `mysti-canvas` artifact server stays this plan's own (it can't be brokered remotely). Plan 04's `IMcpConfigAdapter` covers **persistent** global/workspace config only (`.mcp.json`, `config.toml`, `settings.json`) — it defines no session-scoped/temp-file/CLI-arg lane, so Phase 2.3 cannot reuse it for per-session registration and instead **owns the session-scoped mechanism** (Claude temp `--mcp-config`; marker-tagged managed persistent entries for Gemini/Qwen/Codex, which only support persistent config). What Phase 2.3 does reuse, if plan 04 ships first, is its shared write-discipline helper (`configWrite.ts`: subtree-preserving merge, tmp+rename, backup) for the persistent Gemini/Qwen `settings.json` and Codex `config.toml` writes; if plan 04 hasn't shipped, Phase 2.3 implements that helper minimally and plan 04 adopts it later. Follow-up for plan 04: extend `IMcpConfigAdapter` with `buildSessionMcpArgs(conn)` (returning per-invocation CLI args where supported, `null` for persistent-only CLIs) so the connections hub gains the same session lane.
- **Security/managers plan** (research: `mysti-managers-core.md`): SecretStorage conventions (Phase 0.12) and the permission-card/approval UX patterns (Phase 2.5) should match its decisions; canvas ops deliberately bypass SafetyClassifier since they only write `.mysti/canvas/`.
- **Unified chat UX plan** (research: `unified-chat-ux.md`): the capability manifest determines which providers show the canvas-link affordance (MCP-capable vs fenced-fallback vs none).
- **GitHub triage plan** (research: `github-triage.md`): commit Canvas v2 and sequence against PR #37 (package.json/types.ts conflicts) before Phase 1 type additions.
- **Performance plan** (research: `mysti-performance.md`): the second webpack entry (Phase 1.6) should follow whatever webview bundling conventions that plan establishes for the chat webview.

No phase blocks on another plan landing; the items above are coordination points, not gates.

---

## Effort Estimate

| Phase | Scope | Estimate |
|---|---|---|
| 0 — Stabilize baseline | ~13 surgical fixes + deletions + sandbox/secrets hardening | **M** |
| 1 — Artifact model, job protocol, webview extraction | New store + protocol + large mechanical port | **L** |
| 2 — Tool server, staged writes, conflicts | MCP server, executor, fallback parser, suggestions UI, tests | **L** |
| 3 — Sandbox renderer, design system, co-editing | Sandbox runtime, pageFrame, inline edit, repair | **L** |
| 4 — Formats, self-QA, media studio | Format catalog, preview/validate tools, provenance, safe zones | **M** |
| 5 — Export & presenter | Playwright exports, presenter webview, thumbnails | **M** |
| 6 — Capability connections | Registry + extension-host MCP client + route generation through DeepMyst connections + gating UI | **M** |

---

## Open Questions

1. **fabric.js end-state:** keep permanently as the freeform/spatial shell, or replace the board with a pure-DOM zoomable surface once pages carry the value? (Phase 3 makes pages independent of fabric; decision can wait for usage data.)
2. **Tailwind strategy in the sandbox:** precompiled utility subset (proposed) vs bundling the Tailwind Play JIT (~400KB, runtime cost, but full class coverage for model-generated JSX). Needs a Phase 3 spike with real model output.
3. **JSX vs HTML as the instructed default for page authoring:** JSX+`UI.*` gives DeepMyst-grade quality but assumes React-literate models and Babel; `html` mode is universally safe. Proposal: instruct JSX for `deck` kind, HTML for `screens`/`document` — validate with the weakest supported CLI models.
4. **Where does the MCP tool server get provider/LLM access for `repair_page`/`analyze_visual`?** **Resolved by the §9 tier split:** `mysti-canvas` (artifact-editing/render/QA) runs as extension-host stdio so it can reach `ProviderManager`/services and the local `ArtifactStore` in-process; generation/source capabilities route through the DeepMyst broker (agent side) or the extension-host `McpClient` (Phase 6).
5. **Multi-canvas:** keep the single-panel `_canvasPanelId` assumption through this plan, or move canvas onto Mysti's per-panel session machinery (one panel per artifact)? Deferred here; the artifact model makes the later migration cheap (`panelId → artifactId` map).
6. **Stitch's long-term role** once `write_page_jsx` exists: Stitch is now the *optional* `canvas-screens` capability (DeepMyst-brokered or local-key, §9) — keep it as a high-quality screen generator feeding `html` pages, or sunset once `write_page_jsx` quality matches? Revisit after Phase 3 comparison; either way it is no longer hardwired.
7. **Editable PPTX:** DeepMyst's DOM-walker→python-pptx approach needs a Python-free equivalent (pptxgenjs can do native text/shapes if the walker emits its primitives). Worth a Phase 5+ spike only if users ask.
8. **Approval-mode default:** `staged` for everything (safest, DeepMyst default) vs auto-apply for additive ops (`insert_page`, `add_asset`) and staged only for destructive ones. Leaning staged-everything in v1 with a `mysti.canvas.approvalMode` setting.
9. **Capture/debug artifacts** (`.mysti/canvas/captures/`, F-22): gate behind `mysti.canvas.debugCaptures` (default off) in Phase 0 or keep always-on until the new protocol stabilizes? Proposal: gate now, since every prompt currently writes PNGs to the workspace.
10. **Brokering boundary for first-party generators** (§9 / Phase 6): DeepMyst connections are Composio/Smithery-backed, which cover Figma/Canva natively but not Mysti's bespoke Stitch / direct-OpenAI / direct-Google pipelines. **fal is the easy middle case** — it ships its own MCP server, so it needs no bespoke DeepMyst endpoint (broker it through the hub if offered, else spawn its MCP locally with a `FAL_KEY`), and a fal-based `canvas-image`/`canvas-video`/`canvas-media-edit` covers most media needs keyless-ish. The genuinely-bespoke cases left to decide with the DeepMyst team are Stitch and the direct OpenAI/Google calls: first-party broker endpoints (`/api/v1/mcp/canvas-image`, fully keyless) vs **local-key only** in the same registry/UI. Until decided, Phase 6 ships: `figma`/`canva` broker-only, `canvas-*` media via fal (local `FAL_KEY` or brokered), and local-key fallback for Stitch/OpenAI/Google.
