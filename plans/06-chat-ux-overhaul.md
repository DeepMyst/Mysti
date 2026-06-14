# 06 — Chat UX Overhaul: Calm, Claude-Code-Inspired Chat

- **Date:** 2026-06-14
- **Status:** DRAFT
- **Inputs:** Live inventory of `media/chat/{index.html,chat.js,chat.css}` + `src/providers/ChatViewProvider.ts` (file:line refs inline below)
- **Trigger:** User feedback — "chat is a bit overwhelming, so many colors; the stop button does not show while the user message is processing; the attached options are confusing. Match Claude Code's chat experience."

---

## Goal

Make Mysti's chat feel **calm, legible, and predictable** — closer to Claude Code's restraint — without removing capability. Three concrete complaints drive this:

1. **Too colorful / visually noisy.** Rainbow suggestion/welcome cards (9 variants), per-agent colors, role-tinted discussion bubbles, hardcoded badge metals, a synthesis gradient, orange tool names, and animated tinted status pills all compete for attention.
2. **Stop button missing during processing.** It only appears after the backend's `responseStarted` message — so during the initial "thinking" window (and any pre-first-token latency) there is **no way to stop**, and no clear "working" affordance either.
3. **Confusing "attached options."** The input has ~11 always-visible toolbar controls plus the attach button; it's unclear what's an action, what's a setting, and what "attach" attaches.

Every phase ships independently and is verifiable in the Extension Development Host. Phase 1 (the stop-button bug) is the smallest and highest-impact and should land first.

---

## Design principles (from current Claude Code)

Claude Code's chat is deliberately **near-monochrome with semantic-only color** and **progressive disclosure**:

- **One foreground, one dim, one accent.** Body text = theme foreground; secondary text = dimmed (`descriptionForeground`); a *single* accent for interactive/active state. That's it for "decoration."
- **Color carries meaning, never identity.** Green = success/additions, red = error/removals, yellow = caution — used sparingly on small elements (status, diff, tool result). No per-agent palettes, no rainbow cards, no gradients. Hierarchy comes from **spacing, weight, and dim**, not hue.
- **Interrupt is always available the instant you submit.** The moment a message is sent, the user can stop it (Claude Code: `esc` interrupts immediately, even mid-think). A clear "working…" indicator is shown for the whole processing window, including before the first token.
- **Quiet input chrome.** A clean input box; `/` for commands, `@` for context/agents. Modes/permissions are not a wall of chips — they live one keystroke or one click away, with the current state shown as a single subtle line.
- **Compact, dim tool/thinking blocks.** Collapsed by default, monochrome, expandable on demand.

Target: a chat where, at rest, the eye sees text + one accent — and color only appears to signal something real.

---

## Current-state problems (grounded)

### A. Color / visual noise (`media/chat/chat.css`)
- **9-variant suggestion cards** `data-color` blue/green/purple/orange/indigo/red/teal/pink/amber (`:2028-2036`) and the **same 9 for welcome cards** (`:1494-1502`).
- **Per-agent colors** via `--agent-color` on brainstorm messages (`chat.js:6248`, css `:3785,:3790`).
- **Discussion bubbles**: 8 hardcoded role RGBA sets (critic/defender/challenger/proposer/risk/innovator/facilitator/refiner) (`:3766-3772`).
- **Badge metals** bronze/silver/gold/platinum hardcoded hex (`:996-999,:1035-1038`).
- **Synthesis gradient** `linear-gradient(135deg, rgba(139,92,246,.1)…rgba(16,185,129,.1))` (`:3503`).
- **Tool-call name in orange** (`--vscode-charts-orange`, `:4010-4014`); 4 colored status badges (`:4069-4087`).
- **Status/autonomy pills** with tinted backgrounds + pulse animations (`:40-130`).
- Role badges colored: user = link color, assistant = green (`:1534-1540`).

### B. Stop button (`media/chat/chat.js`)
- `sendMessage()` sets `state.isLoading=true` + disables send, but **does not show stop** (`:6803-6867`).
- Stop is first shown inside `showLoading()`, which is only called on the `responseStarted` message (`:3816-3831`, `showLoading` `:8754-8769`).
- ⇒ **Gap T0→T2** (send → backend `responseStarted`): send disabled, **stop hidden, no spinner**. On slow models the "thinking before first token" is entirely uninterruptible.

### C. Input toolbar / "attached options" (`media/chat/index.html:559-680`)
- Always-visible: `slash-cmd`, `enhance`, `visual-test`, `canvas`, `agent-select`, `context-usage`, `persona`, `persona-clear`, `strategy-indicator`, `behavior-indicator` (`:561-612`) + inline `attach`, `send`, `stop` (`:664-674`).
- Three different concepts are mixed in one bar: **actions** (enhance, visual-test, canvas, slash), **context/identity** (agent, persona, context-usage), **settings** (behavior popup = mode/access/autonomy). Nothing groups or ranks them.
- **Attach** is just an OS file picker (`chat.js:1909`); users conflate it with the surrounding "options."

---

## Phase 1 — Interrupt + "working" affordance (the stop-button bug)

**Highest priority, smallest change.** Make stop available and a "working" state visible the instant a message is sent.

**Steps**
1. In `sendMessage()` (`chat.js:6803-6867`), immediately enter a processing state right after the message is posted: swap send→stop and show the working indicator — do **not** wait for `responseStarted`. Introduce a single `setProcessing(true|false)` helper that owns: `send-btn` hidden, `stop-btn` shown (`flex`), spinner/working line shown, `state.isLoading=true`. Replace the scattered `showLoading()/hideLoading()` toggles (`:8754-8787`) with it.
2. `setProcessing(false)` is called from `responseComplete`, `error`, `requestCancelled`, and a safety timeout — every terminal path. Audit `chat.js:3816-3845` so no path leaves the UI stuck in "working".
3. Ensure **cancel works pre-first-token**: the stop button posts the existing cancel message → `ChatViewProvider` → `provider.cancelCurrentRequest(panelId)`. Verify the child process is spawned (and therefore killable) by the time stop is clickable; if there's a window where no process exists yet, have cancel set a "cancel-requested" flag that aborts the send in-flight. (Check `ChatViewProvider._handleSendMessage` + `cancelCurrentRequest`.)
4. "Working" indicator copy: a minimal dim line ("Working… · Esc to stop" where a key is bound; otherwise just a spinner + "Working…"). Optionally bind `Esc` in the textarea to trigger stop while processing (Claude-Code-like).
5. Keep `responseStarted` only as the trigger to render the assistant message container — not as the gate for interruptibility.

**Acceptance:** sending a message instantly shows the stop button + a working indicator; clicking it (or Esc) during the pre-first-token window cancels the request and restores the input; no terminal path leaves the spinner stuck.

**Risk:** low. Main care: every completion/error/cancel path must call `setProcessing(false)` exactly once.

---

## Phase 2 — Calm palette (de-noise the color)

Collapse the palette to **foreground + dim + one accent + semantic-only color**. Introduce a small token layer at the top of `chat.css` and migrate elements to it.

**Steps**
1. **Define tokens** (`:root` in `chat.css`):
   - `--mysti-fg: var(--vscode-foreground)`
   - `--mysti-dim: var(--vscode-descriptionForeground)`
   - `--mysti-accent: var(--vscode-textLink-foreground)` (the *only* decorative accent)
   - `--mysti-surface: var(--vscode-editor-background)`, `--mysti-border: var(--vscode-panel-border)`
   - Semantic: `--mysti-ok: var(--vscode-charts-green)`, `--mysti-warn: var(--vscode-charts-yellow)`, `--mysti-err: var(--vscode-errorForeground)`
2. **Suggestion + welcome cards** (`:2028-2036`, `:1494-1502`): drop the 9-color `data-color` scheme. One neutral card (surface + border), icon tinted with `--mysti-accent` (or the semantic color only when the card *is* semantic). Differentiate by icon + label, not background hue.
3. **Per-agent colors** (`chat.js:6248`, css `:3785,:3790`): remove colored borders/badges from normal chat. Distinguish agents by **name label + small mono logo**, not a color. (Keep an optional faint accent on the *active* agent only.)
4. **Discussion role bubbles** (`:3766-3772`): replace 8 hued backgrounds with a single neutral bubble + a dim role label (e.g. "Critic", "Defender"). If any signal is kept, use one shared accent for "left side" vs dim for "right side", not 4 hues.
5. **Synthesis gradient** (`:3503`): replace with a flat surface + a single accent left-border.
6. **Tool-call name** (`:4010-4014`): change orange → `--mysti-fg` bold (or dim). Keep status **dot** color semantic (running=accent, ok=green, fail=red) but shrink to a small dot, not a filled badge.
7. **Badge metals** (`:996-999,:1035-1038`): remove from chat; if gamification stays, confine it to a dedicated view, not the message stream.
8. **Status/autonomy pills** (`:40-130`): keep them, but remove tinted backgrounds + pulse; use a small colored dot + dim text. Reserve animation for the single "working" spinner.
9. **Role badges** (`:1534-1540`): make both roles dim/neutral; rely on alignment/avatar/spacing.

**Acceptance:** at rest the chat shows text + at most one accent; color appears only for status/diff/tool-result semantics. No gradients; no per-agent or per-card hue sets. Everything still readable in light + dark themes (all colors via tokens).

**Risk:** medium (broad CSS surface). Mitigate by doing it token-first then element-by-element, screenshotting before/after each group.

---

## Phase 3 — Quiet the input ("attached options")

Group the bar into **left = compose actions**, **right = context/settings**, and push secondary actions behind `/` and a single overflow — so the resting input is clean.

**Steps**
1. **Reduce always-visible controls.** Move `enhance`, `visual-test`, `canvas` (`index.html:567-578`) out of the always-visible bar — they're *actions*, so register them as `/` slash commands (they likely already can be) and/or a single "⋯ More" overflow button. Result: the action row is just `/` (commands) + attach + send/stop.
2. **One settings affordance.** Keep the `behavior-indicator` → popup (mode/access/autonomy) (`:611-643`) but present the current mode as a single subtle chip ("Ask before edit ▾"); fold `persona` and `strategy` into the same popup (or the `/` menu) instead of separate always-on controls. Consider Claude-Code-style `Shift+Tab` to cycle mode.
3. **Agent selector** (`:585`): keep (it's core) but render as quiet text ("@claude-code ▾"), not a filled button; reuse the `@` mention affordance conceptually.
4. **Context usage** (`:592`): keep, but neutral by default — only colorize at warning/danger (it already has those states `:3195-3214`); shrink it.
5. **Clarify attach** (`:664`): tooltip "Attach files (images, code)"; place it adjacent to the input, visually separated from settings. Since the rainbow/option clutter around it is gone, "attach" reads as exactly what it is.
6. **Empty-state guidance.** A one-line hint under the input ("/ for commands · @ to mention an agent · ⌘↩ to send") replaces visual hunting.

**Acceptance:** resting input shows input + attach + send and a compact context/mode line; actions live under `/` or "More"; a new user can tell at a glance what types vs configures vs attaches.

**Risk:** medium — moving controls changes muscle memory. Keep all functionality reachable (slash menu + overflow), and keep keyboard paths.

---

## Phase 4 — Message rendering polish

Make the transcript scan cleanly.

**Steps**
1. **Tool calls** (`:3945-4096`): collapsed by default, single-line dim summary (`name · short args`), small semantic status dot, expand on click. Drop the orange + filled badges (covered in Phase 2).
2. **Thinking** (`:1773-1821`): already dim + collapsible — keep; ensure it's collapsed by default with a one-line preview, expandable.
3. **Role layout** (`:1534-1593`): lean on whitespace + a small avatar/label; remove colored left-borders if they add noise; keep a subtle user/assistant distinction.
4. **Markdown/code** (Prism, `:1761-1766`): keep theme code background; verify Prism token colors come from a theme-aligned set (not a clashing bright scheme). If Prism injects loud colors, switch to a muted/theme-following Prism theme.

**Acceptance:** a long conversation reads as a quiet vertical rhythm of messages; tool calls and thinking are compact and out of the way until expanded.

**Risk:** low–medium.

---

## Phase 5 — (Optional) Brainstorm / discussion de-noise

The brainstorm timeline is the most colorful surface. After Phases 2–4, restyle the discussion view (`:3709-3792`, `chat.js:6050-6129`) to the same calm system: neutral bubbles, dim role labels, one accent for the convergence meter (semantic green/yellow only at thresholds), no per-agent hues.

**Acceptance:** brainstorm matches the rest of the chat's restraint; convergence still legible.

---

## Sequencing

```
Phase 1 (interrupt/stop)         — land first, standalone, ~half day
Phase 2 (palette tokens + de-noise) — token layer first, then element groups
Phase 3 (input simplification)   — after Phase 2 (clutter removal makes attach clear)
Phase 4 (message rendering)      — pairs with Phase 2
Phase 5 (brainstorm)             — last, optional
```

Pairs with **Plan 02 (unified chat)** and **Plan 03 Phase 3 (webview extraction)** — if the webview is being split into compiled assets, do that *first* or rebase these CSS/JS edits onto it to avoid double work. None of these phases change provider behavior or message contracts.

## Risks & guardrails
- **Theme compatibility:** every color must resolve from `--vscode-*`/the token layer so light/high-contrast themes don't break. No raw hex in chat.
- **Don't remove capability:** moved controls stay reachable via `/`, `@`, overflow, and keyboard.
- **Regression surface:** Phase 2 touches a lot of CSS — go token-first, group-by-group, with before/after screenshots; keep changes mechanical.
- **Accessibility:** ensure the "working" indicator and stop button have aria labels; don't rely on color alone for tool status (pair dot with text).

## Out of scope
Conversation history, model/agent routing logic, persistence, and provider streaming are unchanged — this plan is purely the chat **presentation + input ergonomics**.
