# DeepMyst 2.0 — Presentation Agent & Canvas System (deep study for Mysti canvas overhaul)

Sources (all in `/Users/bahaabunojaim/Documents/GitHub/DeepMyst-2.0-connections-hub`):

- Frontend presentation agent: `apps/dashboard/src/features/agents/presentation/` (~75 files, ~30k LOC; key files: `PresentationAgentPage.tsx` 2091, `ChatPanel.tsx` 1728, `slideSandboxTemplate.ts` 3127, `InspectorPanel.tsx` 1253, `types.ts` 721)
- Backend: `apps/core-api/src/domains/agents/presentation_*.py` (~21.5k LOC; `presentation_tools.py` alone is 9,989 lines / 63 tools)
- Canvas runtime (block-document agents): `apps/dashboard/src/features/canvas/` + `apps/core-api/src/domains/canvas/`
- Docs: `docs/CANVAS_AGENTS.md`, `docs/build-plans/living_presentations_roadmap.md`, `configurable_canvas_formats_plan.md`, `agent_media_studio.md`, `agent_image_studio.md`, `agent_image_studio_video.md`

There are **two distinct "canvas" systems** in DeepMyst:

1. **The presentation agent** (`features/agents/presentation/` + `presentation_*.py`) — the flagship "extremely capable" deck/design canvas. A server-side LLM agent loop with 63 tools writes per-slide React components rendered in sandboxed iframes; humans co-edit through inline editing, gizmos, inspectors, and a JSX code editor.
2. **Canvas Agents** (`features/canvas/` + `domains/canvas/`) — block-reactive agents attached to an Editor.js document (NDA reviewer style). Tier-gated op dispatcher with annotations/comments/suggested edits, undo stack, locks, audit.

Both matter for Mysti: (1) is the artifact-authoring model, (2) is the agent-edits-a-live-document governance model.

---

## 1. Architecture overview (presentation agent)

```
User chat (ChatPanel, SSE)
   │  POST /agents/{slug}/decks/{deck}/chat  (message + attachments)
   ▼
presentation_chat_service.py  — multi-turn agentic loop against Anthropic gateway
   │  system prompt = build_presentation_system_prompt_blocks()
   │    (static cacheable block w/ cache_control:ephemeral + volatile block w/ date + deck snapshot index)
   │  tools = PRESENTATION_TOOLS (63) + memory tools + note tools + dynamic connector tools + web_search
   ▼
PresentationToolExecutor — every WRITE tool stages a SlideSuggestion row
   │  approval_mode == "auto"  → _auto_apply() immediately mutates deck (repo)
   │  approval_mode == "staged" → suggestion sits in Suggestions tab for Accept/Reject
   ▼
Postgres (SlideDeck, Slide, SlideSuggestion, SlideComment, SlideVisualAsset,
          PresentationVideoAsset, ExportJob, DeckShare, ShareView)
   ▼
React Query frontend — DECK_MODIFYING_TOOLS set triggers deck refetch per finished
tool call → canvas + thumbnails update live mid-turn, not at end of turn
   ▼
JsxSlideRenderer → sandboxed iframe (Babel compiles JSX at runtime, Tailwind CDN,
Recharts, Lucide, UI.* design-system primitives, theme CSS vars, asset: token rewrite)
```

Key separation: **the deck in the database is the single source of truth**, not the chat transcript. Tool calls/results are not replayed across turns; instead each turn's system prompt carries a compact deck index (one line per slide: full UUID, mode, action_title) and the agent is instructed to `read_slide` before editing (`render_deck_snapshot_for_prompt`, presentation_prompt.py:41-111).

---

## 2. Agent-to-canvas protocol (structured output → rendered artifact)

### 2.1 Tool-mediated writes, never freeform

The LLM never writes the document directly. Every mutation goes through a typed tool whose handler validates, stages a `SlideSuggestion` row (`kind`, `proposed_value`, `previous_value`, `element_ref`, `status: pending|applied|rejected|superseded`, `author_run_id`), and in auto mode applies it via `_auto_apply` (presentation_tools.py:9846+). Security hardening is explicit: every element-level tool validates `slide.deck_id == executor.deck.id` (`_require_slide_in_deck`) to block prompt-injection-driven cross-deck writes; `_auto_apply` re-checks as defense in depth.

### 2.2 Tool descriptions carry a READ-ONLY / WRITE contract

Every tool description starts with either `READ-ONLY (… calling this never counts as making a change)` or `WRITE (stages an edit / asset / comment — this IS what makes the change)`. The system prompt enforces: "If the user asked for a change and you only called READ-ONLY tools, you HAVE NOT made the change yet… Never describe edits in past tense unless a WRITE tool actually ran this turn." This kills the classic "agent claims it edited but didn't" failure.

### 2.3 SSE streaming protocol (chat service → ChatPanel)

Typed line-delimited SSE events (presentation_chat_service.py header + chatStreamTypes.ts `applyStreamEvent`):

| Event | Payload | UI effect |
|---|---|---|
| `text_delta` | `content` | token streaming into trailing text block |
| `thinking` | — | thinking indicator |
| `tool_start` | `tool_name`, `args` | tool activity row appears |
| `tool_result` | `tool_name`, `result` | row completes; if name ∈ `DECK_MODIFYING_TOOLS` → **deck refetch now** (live canvas update mid-turn) |
| `tool_error` | error | typed failure card; model decides retry/alternative |
| `heartbeat` | `tool_name`, `elapsed_seconds` | "Working… 24s" on long tool calls (video gen) so nothing looks hung; also keeps proxies from killing idle SSE |
| `ask_user` | `title`, `fields[]` (typed form: text/textarea/select/multiselect/number/email/url/toggle/date/slider/color/file) | inline dynamic form card; turn ends; submission returns as next user message |
| `connector_required` | `label`, `search_query`, `reason` | inline "Connect <service>" button (agent requested an external connector via `request_connector` meta-tool; tools appear on next message) |
| `auto_continue` | `count`, `max` | "…continuing (2/10)…" marker |
| `turn_budget_exceeded` | `cap` | clean budget exit |
| `error` | message (mapped to friendly string) | error on turn |
| `done` | `usage` | finish |

### 2.4 Robustness machinery around the loop

- `CHAT_MAX_TOKENS` = 64K output per LLM call; on `stop_reason=max_tokens` a synthetic "continue" turn is injected, up to `_MAX_AUTO_CONTINUES` = 10; hard per-turn output budget 400K tokens → typed `budget_exceeded` exit.
- Gateway retry with backoff (`_GATEWAY_RETRY_BACKOFFS_SECONDS`), gated on "nothing yielded yet".
- `chat_session_safety.py`: poisoned-session detection, finalize/persist partial assistant text via a fresh DB session, session keep-warm.
- `chatStreamManager.ts`: the SSE fetch is owned by a **module-level singleton outside React**, so navigating away doesn't kill an in-flight generation; remounted panel re-subscribes via `useSyncExternalStore`.
- Media tool calls run as asyncio tasks with per-tool timeout classes (bg-removal vs model-call vs network-fetch) and emit heartbeats while running.
- Per-turn cost accounting: image/video tools are billed by **real recorded cost** summed from asset rows by `author_run_id` (not estimates).

### 2.5 The complete tool catalog (63 tools, `PRESENTATION_TOOLS`)

**Deck/slide CRUD + reading**: `list_slides`, `read_slide`, `insert_slide`, `edit_slide`, `duplicate_slide`, `delete_slide`, `reorder_slides`, `replace_deck` (whole-deck outline staging), `insert_framework_slide` (10 consulting frameworks: exhibit_insight, hero_stat, matrix_2x2, pyramid_principle, waterfall, process_flow, benchmark_bars, option_compare, timeline_horizontal, quote_hero).

**Element-level ops (structured mode)**: `insert_element`, `edit_element`, `delete_element`, `move_element`, `resize_element`, `group_elements`.

**JSX authoring (the preferred path)**: `write_slide_jsx` (create/replace slide as a full `function Slide()` React component), `slide_coordinates_grid` (canvas anchors: center, thirds, golden ratio, safe zones, plus neighbor anchors for `data-ds-id`-tagged elements), `calculate_slide_position` (anchor + size → exact top/left/width/height), `suggest_layout_for_content`, `chart_from_data` (data → theme-token Recharts fragment), `generate_speaker_notes`.

**Validation/QA**: `validate_slide`, `validate_deck`, `render_slide_preview` (renders the slide to PNG via the same Chromium export pipeline **and runs Claude vision on it**, returning issues + answers to up to 5 targeted questions — catches overflow/clipping/contrast/empty charts that JSON checks can't).

**Theme/brand**: `set_theme`, `apply_brand_palette`, `tag_asset_role`.

**Comments/collab**: `add_comment`, `resolve_comment`, `reply_to_comment`, `ask_user` (typed form).

**Image pipeline**: `generate_visual` (gpt-image-1; role hero/background/illustration/icon/diagram/photo/decoration/chart_bg; size/quality/transparent-bg), `generate_visual_from_references` (multi-reference conditioning), `analyze_visual` (Claude vision → safe_zones w/ scores, palette swatches, salient_regions, text-in-image), `edit_visual` (masked region edit), `extract_region` (crop by normalized bbox), `fetch_image_from_url`, `fetch_company_logo`, `search_stock_photo`, `remove_background`, `recolor_image`, `crop_to_subject`, `list_visuals`, `generate_infographic`.

**Video pipeline (fal.ai: veo / kling / wan / seedance-2 / luma-ray-2-i2v / sora-2)**: `generate_video` (t2v + i2v from a reference frame), `generate_animated_infographic` (+ non-blocking `wait_animated_infographic` with `wait=false`/request_id pattern), `validate_video` (frame-sampled vision audit with coarse pass ≤3fps, windowed zoom up to 12fps/28 frames, `auto_zoom`), `regenerate_video_from_frame` (repair tail from last good frame), `splice_video_segment` (regenerate a broken middle locked to both boundary frames), `stitch_video_clips`, `continue_video` (chain clips from previous last frame), `extract_last_frame`, `stitch_sequence`, `validate_sequence` (seam audit), `validate_image_consistency`, `generate_scene_anchor` (validated camera/scene-cut anchor image), `design_clip_prompts` (director/critic that knows per-model prompt grammar, optional `research=true` web lookup), `generate_long_form_video` (resumable one-clip-per-call sequence builder with in-loop auto-fix: audit → splice out bad span → re-stitch → continue), `rehost_video` (durable S3 re-upload of expiring fal-CDN URLs).

**Research/grounding**: `deep_research` (multi-search structured brief with citations, depth quick/standard/thorough), `extract_evidence` (structured claims+quotes from attached docs), plus `web_search` and connector-provided dynamic tools.

### 2.6 Canvas Agents protocol (the block-document system)

A second, simpler protocol for document canvases (docs/CANVAS_AGENTS.md + `features/canvas/`):

- Agents declare a **tier**: `observer` (annotate/comment only), `suggester` (proposes edits, user confirms each), `autonomous` (applies directly, still undoable as one step). The **dispatcher** enforces `TIER_CAPS` and per-kind allowed modes (`auto` vs `suggest`); agents can narrow capabilities but never escalate.
- Ops are a typed union: `edit | insert | delete | annotate | comment | tune`, each with optional `confidence`/`rationale`, wrapped in an `AgentOpEnvelope {agentId, runId, ts, blockVersion}` for optimistic concurrency. Rejection reasons: `tier_forbidden, kind_forbidden, version_mismatch, block_locked, block_missing, rate_limited, killed`.
- Server executor (`POST /canvas/hook-run`) renders Jinja-style hook prompt templates (`{{block.text}} {{neighbors}} {{document_outline}} {{retrieved}} {{memory.*}}`), runs optional pgvector RAG, calls Claude with a single `emit_ops` tool (JSON-schema-constrained), re-validates server-side, enforces `max_ops_per_run` / `allowed_op_kinds` guardrails.
- Triggers: block added/changed/removed/moved/blurred/idle/invoke, with per-block-type min-chars, idle debounce (2500ms default / 800ms aggressive), neighbor window, AbortSignal cancel when the user returns to the block.
- Runtime primitives shipped: `LockManager` (per-block locks + freeze kill-switch), snapshot `UndoStack`, per-agent-per-block `memory`, `canvas_comments` + `canvas_audit` persistence, org-level rate limits, legal-domain forced-suggester policy.

---

## 3. Document / slide data model

### 3.1 Deck

`Deck { id, agent_id, user_id, session_id, name, theme_snapshot, brand_rules_snapshot, layouts_snapshot, timestamps }` + `slides[]`. Theme and brand rules are **snapshotted onto the deck** at creation so agent-config changes don't retroactively restyle existing decks.

### 3.2 Slide — dual-mode

`Slide` (types.ts:104-163) carries BOTH representations; `slide_mode: "structured" | "jsx"` selects the renderer:

- **Structured (legacy, deprecated for new work)**: `elements: SlideElement[]` on a grid canvas (`canvas: {cols, rows}`), each element `{id, type, frame:{col,row,col_span,row_span}, content, style, animation?, z?, rotation_deg?}` with 12 element types (`text, list, image, shape, chart, stat, quote, table, embed, divider, group, html`) — `html` is a Shadow-DOM-scoped sanitized HTML+CSS escape hatch. Alternatively a `framework` payload delegates layout to one of 10 prebuilt consulting frameworks.
- **JSX (preferred)**: `jsx_source` — a complete React component string. Per-slide human-edit deltas live in:
  - `element_overrides: Record<domIndexPath, {translate_x, translate_y, scale, rotate, inner_html, hidden, inner_style}>` — keyed by DOM index path (`"0>2>1"`), applied by the sandbox harness on every layout-settle pass; the persistence fallback when an edit can't be anchored to a source literal.
  - `dropped_assets: DroppedAsset[]` — floating image overlays (drag/paste/upload) positioned in iframe-natural px, `source: "asset:<uuid>" | "url:https://…"`, with x/y/w/h/rotate.
- **Consulting-grade slots** on every slide: `action_title` (the 12-18-word claim), `source`, `footnotes[]`, `page_number`, `notes` (speaker notes), `transitions {in, out}`, `background` (solid/gradient/image/theme_bg), `freedom: strict|guided|freeform` (brand governance per slide).

### 3.3 Theme & brand

`Theme { colors (11 named roles + open-ended), typography {heading/body/mono fonts + scale}, effects {radii, shadows}, spacing, logo {url, safe_zone, show_on}, aspect_ratio, canvas: CanvasSpec }`. `BrandRules { default_freedom, allowed_freedoms, locked_elements, locked_slides, min_text_size, color_palette_locked }`.

### 3.4 CanvasSpec / format catalog — multi-format canvas

`CanvasSpec { format_id, kind: screen|print|book, width, height, physical {w,h,unit}, dpi, bleed, safe_margin, spread, book_style: picture|text }` persisted inside `theme_snapshot` (no migration). Catalog (`formats.ts`): 16:9, 4:3, square, 4:5 portrait, 9:16 story/reel, 1.91:1 landscape, custom (320–8192px), A4 portrait/landscape, US Letter, picture-book 8.5×8.5 and 11×8.5, trade 6×9. Convention: **longer edge normalized to 1920 design px** so 16:9 is byte-identical to legacy and UI.* primitives stay tuned. Print/book formats compute bleed (0.125in) + safe margin (0.25in) in design px; books add **auto-gutter** by KDP page-count thresholds with recto/verso parity (the `PrintGuides` overlay draws asymmetric trim/safe/binding rects). The system prompt's CANVAS SPEC section is regenerated per deck with orientation-specific layout rules (portrait → stack vertically, no 3-col; square → centered focal block) and print/storybook/trade-book personas.

### 3.5 Side-tables

- `SlideComment` — deck/slide/element scoped, severity info/warn/error, threaded, open/resolved, authored by run or user.
- `SlideSuggestion` — the staged-edit unit (see §2.1), with bulk accept/reject (`BulkDecisionResult`).
- `VisualAsset` — full provenance: role, purpose, prompt, status (queued/generating/ready/failed/cropped), model, quality, size, background_mode, `reference_asset_ids`, `parent_asset_id`, `crop_of_id`+`crop_bbox`, `mask_region`, `analysis` (safe zones/palette/salient regions/composition/text-in-image), `tokens_used`, `cost_cents`. Referenced from slides via `asset:<uuid>` tokens; videos via `video-asset:<id>` tokens that survive re-stitching.
- `ExportJob` — format pdf/pptx/pptx_raster/html/html_zip/png, status, artifact, download_url.
- `DeckShare` — public token links with allow_download, expiry, revocation, **email-capture gate** (`EmailGateConfig {slide_index, required, fields: email/name/company}`), and **share analytics**: per-view rows (email, country/region/city, device, referrer, dwell), per-slide impressions/unique viewers/avg dwell, daily series, completion counts.

---

## 4. The editing loop (user edits vs agent edits, conflict handling)

### 4.1 User editing surfaces

1. **Inline text editing inside the sandboxed iframe** (`useJsxInlineEditing` + harness in `slideSandboxTemplate.ts`): click any text node → contentEditable in place. postMessage protocol: `jsx_edit_started` (bounds → parent shows floating `TextFormatToolbar`), `jsx_edit_rect` (toolbar tracks element), `jsx_edit_text` (blur: before/after text AND innerHTML), `jsx_edit_ended`. Plain-text edits do a string replace in `jsx_source`; formatted edits (bold/italic/color/size) round-trip HTML→JSX (`style="…"`→`style={{…}}`, `class`→`className`).
2. **AST-anchored source splicing** (`jsxAstEdit.ts`): parses `jsx_source` with @babel/parser, finds the exact JSXText/attribute node, splices by character offsets (no re-print → byte-stable formatting). Only commits unambiguous matches; otherwise falls back to regex replace, and finally to `element_overrides.inner_html` when text is computed (e.g. `{title}`).
3. **Selection gizmo + transforms**: `SelectionOverlay`/`MultiSelectionOverlay` with 8 resize handles + rotate handle; `useDragInteraction` does pointer-capture drag with **grid-cell snapping** for structured slides; JSX slides get per-element transform overrides (translate/scale/rotate/hide) keyed by DOM path.
4. **InspectorPanel**: type-specific inspectors (Text/Image/Shape/List/Stat/Quote/Divider) when an element is selected; slide-level inspector (action_title, source, page_number, background) when nothing is; `JsxInspector` is a raw JSX code editor (apply-on-blur/Cmd+S = one history entry per session; "Ask AI" drops the slide ref into chat).
5. **Direct-manipulation chrome**: `ThumbnailRail` (reorder, insert blank, duplicate), `InsertMenu`, `LayoutSwitcher`, `FormatMenu` (canvas format switch with re-layout-via-agent toast), `ColorPicker`/`FontPicker`, `ImageReplacePopover` (regenerate/replace/upload), `AssetLibraryPopover`, `RefinePromptPopover` (select element → targeted AI refine), `EditableDeckTitle`.

### 4.2 Undo/redo

`useDeckHistory`: deck-wide snapshot stack — every mutation pushes `(slide_id, before, after)`; undo PATCHes back to `before`. Capped at 50 entries (~200KB). Deck-wide rather than per-slide so "undo the slide I just deleted" works across slides. In-memory v1. Every editing path (element mutations, slide mutations, JSX inline edits, JSX inspector applies) flows through history-aware helpers, so Cmd+Z is uniform.

### 4.3 Write serialization & conflict handling

- `slideMutationQueue.ts`: **per-slide client-side mutation serializer** — at most one PATCH in flight per slide; later edits queue. Fixes drag-commit racing autosave, held arrow keys, and the undo before-snapshot race. Different slides run concurrently. Explicitly documented limitation: no server-side etag/If-Match yet, so a concurrent agent write can still interleave — the agent-vs-user conflict answer today is (a) staged suggestions by default, (b) per-tool deck refetch keeps the UI fresh mid-turn, (c) `superseded` status when a later accepted suggestion (e.g. `replace_deck`) invalidates pending ones — surfaced in a "stale" rail rather than silently dropped.
- `useSaveStatus`: inflight-count-based "Saving… / Saved at HH:MM" indicator.
- Canvas Agents side DOES have optimistic concurrency: ops carry `blockVersion`, dispatcher rejects `version_mismatch`, per-block locks, org kill switch.

### 4.4 Agent edit governance

`approval_defaults` per agent config: `staged` (default — every WRITE tool stages a suggestion the user Accept/Rejects in the Suggestions tab) vs `auto` (applies immediately, audit-logged). Both modes record `previous_value` so accepts are reversible. `SuggestionsPanel` + bulk accept/reject endpoints.

### 4.5 Error recovery: broken slides

`SlideErrorBoundary` catches sandbox compile/render failures → "Fix with AI" one-shot repair endpoint (`SlideRepairResult`): non-streaming Claude call with `build_slide_repair_system_prompt()` (full design-system contract + "change as little as possible, output only the component"), re-validates, returns repaired slide or `repaired:false` → falls back to chat repair. Backend also `_sanitize_jsx_source` / `_slice_to_slide_component` to strip fences/CDATA before storage.

---

## 5. Rendering stack

- **Per-slide sandboxed iframe** (`slideSandboxTemplate.ts`, ~3.1k lines): Babel standalone compiles the JSX string at runtime inside the iframe; React 18 + Tailwind Play CDN + Recharts + Lucide pre-injected as globals; **no network bridge, no DeepMyst.* API** — slides are static. Theme palette injected as `--theme-*` CSS custom properties on `:root`. `asset:<uuid>`/`video-asset:<id>` tokens rewritten to deck asset URLs at mount (with `?_cors=1` cache-bust mode for html2canvas capture paths).
- **Fixed design-pixel canvas** (default 1920×1080, parameterized per format); parent scales the iframe via CSS transform (`ScaledSlide`); a size reporter pins to the canvas floor so under-filled content can't shrink the box.
- **`UI.*` design-system primitives** (pre-injected): `ActionTitle`, `SectionHeader`, `StatCard`, `Callout`, `QuoteCard`, `PullStat`, `SourceFooter`, `ThemedImage`, `Video` (autoplay/loop/muted/playsInline handled), `Chart` (typed chart wrapper whose structural payload lets PPTX export materialize **native editable charts**).
- **Editor mode harness** in the same iframe: `data-element-id` DOM-index tagging, inline-edit listeners, override application on layout-settle, dropped-asset layer.
- `jsxSanitize.ts` + `htmlSanitizer.ts` + server-side regex JSX validator as layered safety; `jsxInlineMarkdown` renders markdown-ish text in JSX.
- **Surfaces** all driven by the same renderer: editor canvas, `ThumbnailRail` (live thumbnails via `slideCanvasCache`), `PresenterView` (fullscreen, swipe, autoplay, safe-area handling), `PublicViewerPage` (token share + email gate + dwell tracking), `EmbedPage`, `RenderDeckPage`/`PrintDeckView` (export capture), `useThumbnailAutoCapture` (hidden-iframe opportunistic deck thumbnail).
- **Exports**: server-side Playwright browser pool → PDF (page size from `theme_page_size_in`, short edge 7.5in, physical override for print), **editable PPTX** via the *walker* (iframe walks its own DOM → typed `PptxSlideWalk` wire format → python-pptx materializes text frames/pictures/native charts; unrecognized subtrees raster-fallback), raster PPTX, per-slide PNG zip at 2×, HTML/HTML-zip; plus pure client-side export (html2canvas + jsPDF) from a hidden iframe. Export jobs are async rows with polling (`useExportJob`).
- **Waiting UX**: `SpinnerRunner` — a themed mini endless-runner game shown during 2-4 min deck builds.

---

## 6. Media generation integration

- **Images**: gpt-image-1 via `generate_visual` with role/purpose/quality/size/transparent-background; multi-reference generation; **vision analysis loop is first-class** — `analyze_visual` returns scored `safe_zones`, `palette`, `salient_regions`, `text_in_image`, and the prompt mandates DESCRIBE → PROMPT → SEE → ASSEMBLE: generate with negative space, analyze, place the title inside the best safe zone, check contrast against extracted palette. Editing primitives: masked `edit_visual`, `extract_region`, `remove_background`, `recolor_image`, `crop_to_subject`, `fetch_company_logo`, `search_stock_photo`, `fetch_image_from_url`. Budget rules in-prompt (≤1 hero + ≤3 illustrations per slide; autonomous on covers/dividers without asking).
- **Video**: full fal.ai pipeline (§2.5) with a **validate → regenerate-from-frame → splice → stitch quality loop** (capped at 3 iterations by prompt), seam validation for multi-clip sequences, scene-cut anchors with identity-consistency validation, per-model prompt-grammar director (`design_clip_prompts`), resumable long-form builder with in-loop auto-fix, durable rehosting of expiring CDN URLs. Animated infographics are a separate structure-preserving motion tool with an async wait pattern.
- **Attachments-as-assets**: chat uploads (images/PDFs) are ingested as deck assets (`ingest_attachments_as_assets`) with inferred palette aggregation, listed to the agent every turn.
- **Costing**: every asset row records `tokens_used`/`cost_cents`; turn billing sums real recorded media cost by `author_run_id`.

---

## 7. What makes the presentation agent "extremely capable" (design synthesis)

1. **JSX-as-universal-slide-representation**: the agent authors arbitrary React/Tailwind/Recharts, so output quality is bounded by the model's design ability, not by a widget schema — while the `UI.*` design system + theme tokens + canvas-fill rules keep it on-brand and consistent. Structured/grid mode is retained only as legacy.
2. **A closed perception-action loop**: the agent can *see its own output* (`render_slide_preview` → Chromium PNG → Claude vision → issues), *see its imagery* (`analyze_visual` safe zones), and *see its video* (frame-sampled `validate_video`) — then repair with targeted tools. Self-QA is mandated by the prompt, not optional.
3. **Deck-as-source-of-truth + compact snapshot index**: cheap multi-turn statefulness without replaying tool history; full UUIDs in the index to avoid wasted error round-trips; prompt-cache split (static cacheable block vs volatile date/snapshot block) keeps long sessions affordable.
4. **Staged-suggestion write model**: every agent write is reviewable, reversible, attributable, and supersession-aware; auto mode is an opt-in with the same audit trail.
5. **Live-during-the-turn canvas**: per-tool-result deck refetch + module-level stream ownership + heartbeats + auto-continue + budgets makes a 5-minute 12-slide build feel alive and survivable.
6. **Grounding tools** (`deep_research`, `extract_evidence`, web_search, connectors) so data slides are cited, plus consulting-grade content rules (action titles as claims, mandatory exhibits + sources, density floors, framework menu).
7. **Whole-lifecycle coverage**: one system goes brief → research → outline → slides → imagery/video → validation → presenter mode → share link with email gate and per-slide engagement analytics → PDF/editable-PPTX/PNG/HTML export.
8. **Format generality**: same engine targets decks, social posts, print sheets, picture books and trade-book interiors via the CanvasSpec + orientation/print/book prompt personas — the roadmap explicitly reframes it as a general "Canvas/Design agent".
9. **Roadmapped data-binding layer** (living presentations): `DataBinding` rows (HTTP/MCP/RAG/SQL/Sheets adapters), `<UI.Chart binding="…">`, frozen/manual/auto refresh policies, viewer-side live data with rate limits, and `narrate_changes` (agent re-writes prose when refreshed numbers move).

---

## 8. Capabilities Mysti's canvas lacks

Stated as a precise checklist of DeepMyst capabilities for the plan author to diff against `/tmp/mysti-planning/research/mysti-canvas-current.md` (that file was deliberately not read; items below describe DeepMyst exactly, so any not present in Mysti's baseline are gaps). Mysti's working-tree canvas (fabric.js webview, CanvasManager, ImageGeneration/StitchService/DesignSpec/CodeGeneration services) was only header-skimmed for orientation.

**Authoring & rendering model**
1. Agent-authored **per-slide/per-artifact React components** (JSX string) compiled at runtime in a sandboxed iframe with a pre-injected design system (`UI.*`), Tailwind, Recharts, Lucide — vs raster/object canvases or HTML strings without a primitives contract.
2. A **dual representation** (typed structured elements + frameworks on a grid, AND freeform JSX) on the same document unit, with a `slide_mode` switch and migration story.
3. **Theme-token contract** enforced end-to-end: named CSS custom properties, banned raw hex, brand rules (freedom levels, locked elements/slides, min text size, palette lock) snapshotted per deck.
4. **Multi-format CanvasSpec catalog** (presentation/social/print/book + custom) with design-px normalization, bleed/safe-margin guides, book gutters with recto/verso parity, and orientation/print/book-specific prompt personas; format switch triggers an agent re-layout pass.
5. **Multi-surface rendering from one source**: editor, live thumbnails, fullscreen presenter (touch, autoplay), public share viewer, embed page, headless export page.

**Agent protocol & loop**
6. **63 typed tools** with an explicit READ-ONLY/WRITE contract in every description, anti-fabrication and tense rules in the prompt.
7. **Staged-suggestion write model**: every agent mutation is a reviewable suggestion row with `proposed_value`/`previous_value`, accept/reject (incl. bulk), supersession status, run attribution — with an opt-in auto-apply mode that reuses the same path.
8. **Mid-turn live canvas updates**: per-tool-result refetch keyed by a deck-modifying-tool set (not end-of-turn refresh).
9. **Typed SSE protocol** incl. `heartbeat` with elapsed seconds for long tools, `ask_user` dynamic forms (12 field types), `connector_required` inline connect buttons, `auto_continue`, and turn budget events.
10. **Auto-continue on max_tokens** (up to 10×), hard per-turn output budget with clean typed exit, gateway retry, poisoned-session recovery, stream ownership that survives UI navigation.
11. **Deck snapshot index in the system prompt** (full IDs, mode, titles) + mandatory `read_slide` before editing + **prompt-cache-split** (static cacheable design system vs volatile date/snapshot).
12. **Server-validated tool inputs** with cross-document write guards (slide-belongs-to-deck checks at stage AND apply time).

**Self-QA / perception**
13. `validate_slide` / `validate_deck` rule engines (overlap, out-of-bounds, safe-zone, readability, missing action title/source, duplicate titles, cover detection, JSX smell checks).
14. **`render_slide_preview`: render-to-PNG + vision critique loop** with targeted questions — the agent sees its own output before declaring done.
15. **Image analysis for composition** (`analyze_visual`): scored safe zones for text placement, palette extraction for contrast, salient regions to avoid.
16. **Video validation loop**: frame-sampled audits, windowed zoom, regenerate-from-frame, middle-splice repair, seam validation across clips, identity-consistency checks, capped repair iterations.
17. One-shot **"Fix with AI" slide repair** path wired to a render error boundary.

**Human co-editing**
18. **In-iframe inline text editing** with a postMessage protocol and floating format toolbar; edits persisted by **AST-anchored byte-stable source splicing** with regex and `element_overrides.inner_html` fallbacks.
19. Per-element **transform overrides on generated JSX** (translate/scale/rotate/hide keyed by DOM path) + **dropped-asset overlay layer** (drag/paste/upload images onto a generated slide).
20. Selection gizmos (multi-select, 8 handles + rotate), grid-snapped drag/resize for structured mode, type-specific inspectors, raw-JSX code inspector with session-granular history, refine-selected-element-via-AI popover.
21. **Deck-wide snapshot undo/redo** spanning every edit path (user direct edits, inspector, inline JSX edits, accepted agent suggestions).
22. **Per-document mutation serialization queue** + save-status indicator; suggestion supersession surfacing; (Canvas Agents side) block-version optimistic concurrency, per-block locks, org kill switch.
23. Threaded **comments** at deck/slide/element scope shared by users and agent (agent can add/resolve/reply).

**Media & grounding**
24. Reference-conditioned image generation, masked edits, region extraction, background removal, recolor, crop-to-subject, stock photo search, company logo fetch — all as agent tools with provenance (parent/crop/mask lineage) and per-asset cost recording.
25. Full **long-form video pipeline**: clip chaining via last-frame continuation, scene-cut anchors, per-model prompt director, resumable sequence builder with in-loop auto-fix, stitching, durable rehosting; async wait pattern for slow generations.
26. `deep_research` and `extract_evidence` grounding tools + attachment-to-asset ingestion with palette inference.
27. Positioning math tools (`slide_coordinates_grid`, `calculate_slide_position`) so the agent never guesses percentages.

**Lifecycle & distribution**
28. Async **export jobs**: PDF (format-aware page sizes), **editable PPTX via DOM-walker → python-pptx with native charts**, raster PPTX, PNG zip, HTML; client-side export fallback; Playwright browser pool.
29. **Public share links** with expiry/revocation/download control, **email-capture gates**, and **share analytics** (per-slide dwell, geo/device, completion, identified viewers).
30. Presenter view, embed page, auto-captured thumbnails, waiting-time mini-game.

**Governance & platform**
31. **Tiered canvas-agent permission model** (observer/suggester/autonomous) with capability narrowing, mode gating per op kind, typed rejection reasons, rate limits, audit table, legal-domain forced-suggester policy, org freeze switch.
32. Natural-language **agent builder** flow for canvas agents (intent classification, AI-drafted hook prompts, dry-run panel) — agents as user-creatable data, not code.
33. Roadmapped **live data bindings** (`DataBinding` + adapters + `<UI.Chart binding>` + freshness badges + `narrate_changes`) — decks as queryable views over MCP/HTTP/SQL/Sheets/doc-RAG sources.
34. Per-turn **real-cost accounting** of media generation and budget caps wired to billing.

Items most load-bearing for a Mysti overhaul plan (highest leverage first): #1/#6/#7 (JSX artifact model + typed WRITE tools + staged suggestions), #14/#13 (vision self-QA loop), #18-21 (human co-editing on generated output with durable overrides + undo), #9-11 (streaming/robustness/prompt-economics), #4 (format generality), #28-29 (export/share).
