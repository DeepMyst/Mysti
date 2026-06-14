# 07 — Context Files Manager + Attachment Drag-and-Drop

- **Date:** 2026-06-14
- **Status:** DRAFT
- **Inputs:** Live map of `ContextManager`, the webview context wiring, and the attachment pipeline (file:line refs inline).
- **Trigger:** User — "We need a place to manage context files (activate / deactivate / remove) like Claude Code. Also support drag-and-drop of attachments into the box."

---

## TL;DR of the current state (important)

Two surprises from the code map shaped this plan:

1. **Drag-and-drop already exists.** Document-level `dragenter/dragover/dragleave/drop` listeners ([chat.js:2117-2154](../media/chat/chat.js#L2117)), a `#drop-overlay` ([index.html:1028](../media/chat/index.html#L1028)), and `handleDroppedFiles()` ([chat.js:~6747](../media/chat/chat.js)) that ingests dropped files as **attachments** (base64, 10-item / 5-10 MB caps). So Part B is **validate + polish**, not build.
2. **The context backend is complete; the UI is missing.** `ContextManager` ([src/managers/ContextManager.ts](../src/managers/ContextManager.ts)) fully supports add (file/selection/folder/symbol), `removeFromContext`, `clearContext`, `refreshContext`, `formatContext`, per-panel (`_panelContexts`). The webview even has `updateContext()` + a `removeFromContext` post ([chat.js:9096-9112](../media/chat/chat.js#L9096)) — but the `#context-items` element it renders into **does not exist in the HTML**, so nothing shows. And `ContextItem` has **no `enabled` flag** — items are only present or removed.

So: build the **context-files UI + an enabled/disabled concept**, and **polish the existing drag-drop** (esp. the attachment-vs-context distinction).

## Key distinction the design must make explicit

| | **Attachment** | **Context file** |
|---|---|---|
| Lifetime | One message (cleared after send) | Persistent across turns until removed |
| Source | 📎 button / paste / drag-drop | "Add context" / `mysti.addToContext` / drag-drop |
| Shape | `Attachment` (base64/path, image/file) | `ContextItem` (file/selection/folder/symbol, path+content) |
| Today | works, with previews | backend works, **no UI** |
| Claude Code analog | pasted image / one-off file | `@file`, added context, CLAUDE.md |

Drag-drop currently always makes **attachments**. The plan routes drops by target: onto the **input** → attachment; onto the **context panel** → context file.

---

## Part A — Context files manager (the main work)

### A1. Data model: add an `enabled` flag
- `ContextItem` ([types.ts:36-44](../src/types.ts#L36)) gains `enabled?: boolean` (default `true`).
- `ContextManager`:
  - new `setItemEnabled(id, enabled, panelId)` + `toggleItem(id, panelId)`.
  - `formatContext()` / `formatContextForPrompt()` ([ContextManager.ts:157](../src/managers/ContextManager.ts#L157), [BaseCliProvider.ts:1438](../src/providers/base/BaseCliProvider.ts#L1438)) **skip `enabled === false`** items — this is what "deactivate" means (kept in the list, excluded from the prompt).
  - `refreshContext()` re-reads only enabled file items.
- Behavior-preserving: existing items default to enabled, so nothing changes until a user toggles.

### A2. Surface the context panel in the chat UI (fix the dangling wiring)
- Add the missing markup: a collapsible **Context** section near the input (above the input row, or a drawer toggled from the status line / `⋯` menu). Contains `#context-items` (the list) + a header with item count + "Add" and "Clear" actions + an empty/drop hint.
- Render each item (extend `updateContext()` [chat.js:9096](../media/chat/chat.js#L9096)):
  - icon by `type` (file/selection/folder/symbol), name + dimmed path (+ line range for selections),
  - an **activate/deactivate toggle** (checkbox or eye icon) → posts `setContextItemEnabled {id, enabled}`,
  - a **remove ✕** → existing `removeFromContext` post.
  - disabled items render dimmed/struck so "in the list but off" is obvious.
- Extension side: handle `setContextItemEnabled` → `ContextManager.setItemEnabled` → re-broadcast `contextUpdated` (the existing message the webview already consumes via `updateContext`).
- Keep it calm per Plan 06: neutral rows, one accent for the active toggle, dim for disabled.

### A3. Entry points to add context
- **Button**: an "Add context" affordance (in the `⋯` tools menu and/or a small context-panel "+"), opening a file picker (reuse `mysti.addToContext` / a new "pick file(s)" path) and/or seeding an `@`-mention.
- **Commands**: `mysti.addToContext` already adds the active file/selection ([extension.ts:441-466](../src/extension.ts#L441)); surface it on the editor context menu / a keybinding. Add `mysti.addFileToContext` (pick from quick-open) if missing.
- **Drag-drop → context** (see Part B): dropping onto the context panel calls a new `addDroppedToContext` path → `ContextManager.addFileToContext` per file → `contextUpdated`.
- **@-mention reuse**: an `@file` mention could optionally offer "keep as context" so a one-off mention can be promoted to persistent context.

### A4. Token cost visibility
- The `#context-usage` pie reflects *total* prompt tokens, not context specifically ([chat.js:9244](../media/chat/chat.js#L9244)). Add a lightweight per-item / section token estimate (chars/4 heuristic, or reuse any existing tokenizer) shown in the context panel header ("Context: 3 files · ~4.2k tokens"), so users see what deactivating saves. Disabled items excluded from the estimate.

### A5. Persistence (decision needed)
- Per-panel context is **in-memory** today (lost on reload). Options:
  - (a) Keep session-only (simplest; matches today).
  - (b) Persist the per-conversation context list (+ enabled flags) in `globalState` keyed by conversationId, restored on load — closer to "a place that stays."
  - **Recommendation:** (b) persist *the list + enabled flags* (not file contents — re-read on use via `refreshContext`), so reopening a conversation restores its context set. Re-reading keeps content fresh and avoids stale snapshots.

**Acceptance (Part A):** a visible Context panel lists added files; each can be toggled active/inactive (inactive stays listed but is excluded from the prompt — verifiable by inspecting the built prompt) and removed; adding via button/command/drag works; the panel shows a token estimate; (if A5b) the set survives reload.

---

## Part B — Attachment drag-and-drop (validate + polish)

### B1. Verify what's already there
- Confirm the existing document-level drag-drop ([chat.js:2117-2154](../media/chat/chat.js#L2117)) still works after the Plan 06 Phase 3 input restructure (it should — listeners are document-level), and that `#drop-overlay` shows on dragenter and `handleDroppedFiles` ingests to `state.attachments` + `renderAttachmentPreviews()`.

### B2. Polish
- **Target-aware drop:** highlight the **input box** on dragover (not only a full-window overlay); drop on the input/preview area → attachment; drop on the **context panel** → context file (Part A3). Update the overlay copy to reflect both ("Drop on the message box to attach · on Context to add a context file").
- **Dedupe ingest:** factor the FileReader→`Attachment` logic shared by paste ([chat.js:2000-2114](../media/chat/chat.js#L2000)) and drop into one helper.
- **Capability + feedback:** images go only to providers whose `ProviderCapabilities.supportsImages` is true — gate or warn (and for non-image providers, fall back to attaching the file path/text). Surface the 10-item / size-cap rejections with a toast instead of silent drops.
- **Path vs base64:** dropped local files currently become base64; for large/code files prefer `filePath` (smaller payload) when the provider can read from disk — mirror the attach-button behavior.

**Acceptance (Part B):** dragging files onto the input attaches them (with the box highlighting as the drop target); dragging onto the Context panel adds them as context files; oversized/over-cap/unsupported drops show a clear message; paste and drop share one code path.

---

## Sequencing & effort
```
A1 data model (enabled)            ~0.5d  — types + ContextManager + formatContext skip
A2 context panel UI                ~1d    — HTML + updateContext render + toggle/remove wiring
A3 add entry points                ~0.5d  — button/command/@-mention
B1+B2 drag-drop validate + polish  ~0.5-1d — target-aware drop + shared ingest + capability gating
A4 token estimate                  ~0.3d
A5 persistence (if chosen)         ~0.5d
```
Pairs with Plan 06 (use the same calm tokens) and Plan 02 (capability-driven rendering for `supportsImages`). Do A1→A2→A3 first (the actual gap), then the drag-drop polish.

## Risks
- **Provider image support varies** — must gate via `supportsImages`, not assume; some CLIs accept only file paths/text.
- **Context token bloat** — large/many context files silently inflate every turn; the token estimate + easy deactivate mitigate (that's the point of the feature).
- **Persistence staleness** — persist the list + enabled flags, NOT cached content; re-read on use so context never goes stale.
- **Attachment vs context confusion** — the target-aware drop + distinct panels + labels are essential; without them users won't know which they're doing.

## Out of scope
Project memory (`mysti.md` / `.mysti/rules`, ProjectContextManager) and auto-memory (MemoryManager) are separate, always-on context sources — not part of this per-conversation context-files manager.
