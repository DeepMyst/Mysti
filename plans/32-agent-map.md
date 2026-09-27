# Plan 32 — Agent map

- **Date:** 2026-09-26
- **Status:** IMPLEMENTED on `feat/agent-map` (uncommitted)
- **Design canvas:** <https://claude.ai/artifact/P6RXMqe6AFpSfQ4C5v5DfM> (Main map, Workflow run, Sidebar list, Inspector states, Entry points)
- **Inputs:** a seven-reader map of every agent event family (orchestrator, coordinator, mentions, brainstorm/jobs, gate, webview infra, prior art). The file:line facts below come from it.

## Goal

One view of every agent working in this chat: the main agent, the coordinator's delegations,
native scouts, the advisor, cross-vendor reviews, orchestration workflows (plan, parallel lanes,
verify, synthesize), @-mention sub-agents, @agent:role collaborators, team sessions, brainstorm
debates, subagents a CLI reports itself, and background jobs. For each one: status (including
"needs you" and "stalled"), backend, model, access, duration, tokens where measured, what it did,
what it produced, and why it failed. Everything else in the chat stays exactly as it is.

## Non-negotiable rules

1. **The map is a view.** It never answers an approval or a question. "Needs you" rows jump to
   the real permission card / question and focus it. The card is the only surface that shows the
   diff, effects and scope, and the global keyboard handler targets it. No bulk approve, ever.
2. **Keyboard isolation.** While open, the map holds a window capture-phase keydown listener that
   stops propagation of every key, so the page handlers (permission Enter/Esc/1/2/3 at chat.js
   `handlePermissionKeyboard`, AUQ keys, mode cycle, dock Escape, composer Escape → cancelRequest)
   never see one, even when a card that arrived later stole focus or focus fell to `<body>`. Escape
   anywhere closes the map; any other key aimed outside the map is swallowed and focus goes back in.
   The one exception: a chord (Ctrl/Cmd/Alt, or an F-key) typed inside the map is left alone, because
   VS Code forwards workbench keybindings from a bubble listener on the same window; the page's own
   chord handler (Cmd+K, Cmd+Shift+R) stands down while the map is open. On the pill only Enter,
   Space and Escape are exempt from the page handlers, so 1/2/3 there still answer a waiting card.
   Host messages that fill the composer do not take focus from the open map. Opening moves focus into
   the map; closing restores it, and a rebuild keeps focus where it was (row, panel or scroller).
3. **Untrusted text.** Titles, tasks, tool summaries, outputs and failure text are model/CLI
   authored. Use `textContent` / DOM APIs only. No `innerHTML` with interpolated data. Ids are
   never interpolated into selectors: find anchors by iterating and comparing `dataset`/attributes,
   or with `CSS.escape`.
4. **Only this panel's ids.** The map posts only `cancelRequest`, `requestJobs`, and `cancelJob` for
   a jobId it learned from this panel's `jobStarted`/`jobsList`. The host checks ownership anyway.
5. **Unknown is not zero.** Missing usage renders as "n/a", never "0 tokens" or "$0". Never compute
   context fill in the webview. Coordinator tokens the receipt marks `tokensPartial` show as "~N (partly
   estimated)".
6. **No per-agent Stop in v1.** Killing one pool child today turns into `empty-response` → pool
   retry → coordinator reroute (CollaboratorPool.ts `_dispatchWithRetry`, ChatViewProvider REROUTE).
   The map offers "Stop turn" (whole foreground turn, `cancelRequest`, labelled as such) and
   "Stop job" (one background job).

## Architecture

- `media/chat/agentMap.js` — new IIFE module, `window.MystiAgentMap = Object.freeze({ create, createModel })`,
  plus `if (typeof module === 'object' && module.exports) module.exports = { create, createModel }`
  (with `/* global module */`) for tests. Loaded before `chat.js`. It never calls
  `acquireVsCodeApi`; everything arrives through ports.
  - `createModel({ now })` — pure state machine, no DOM. `ingest(message)`, `nodes()`, `get(id)`,
    `children(id)`, `counts()`, `resolveNeed(id)`, `reset({ keepJobs })`, `isStalled(node, now)`.
  - `create(ports)` — model + overlay renderer + pill. Returns
    `{ observe(message), open(), close(), toggle(), isOpen(), reset(), permissionResolved(requestId),
    questionAnswered(id), counts(), dispose() }`.
  - Ports: `document`, `postMessage(msg)`, `getAgentDisplay(agentId) → {name, logo?, shortId?}`,
    `listAgents() → [{id, name}]` (selectable backends for "Ask another agent"),
    `prefillComposer(text)`, `now()`, `setInterval`, `clearInterval`, `onOpenChange?(open)`.
- `chat.js` wiring (thin): create the instance next to `MystiSubAgentCards` (guarded if the global is
  missing), call `agentMap.observe(message)` from the existing `observeRun` pre-switch hook in its own
  try/catch, `reset()` on conversation change / new conversation / session cleared, call
  `permissionResolved(id)` where `handlePermissionAction` resolves a card and on
  `permissionDismissed`/`permissionExpired`/`semiAutonomousDecision`, `questionAnswered(id)` where AUQ and
  sub-agent answers/skips are submitted, a palette entry "Agent map", and the pill click.
- Markup in `index.html`: `<button id="agent-map-pill" class="status-seg agent-map-pill hidden" type="button">`
  in `.input-status-line` (hidden at rest so the 3-segment chrome test still holds) and
  `<div id="agent-map" class="agent-map hidden" role="dialog" aria-modal="true" aria-labelledby="agent-map-title"></div>`
  as the overlay shell. The module renders inside it.
- CSS lives in `chat.css` (browser tests inline only chat.css/desk.css), under an `.agent-map`
  prefix, using `--mysti-*` tokens only (light/dark/high-contrast for free). Every hidden rule is
  local (`.agent-map.hidden{display:none}`); there is no global `.hidden`.
- Loader: `webviewContent.ts` `agentMapJsUri` + script tag before chat.js; add the file to
  `scripts/check-provider-literals.js` TARGET_FILES and the guard test list; update harnesses that
  hard-code the script list (`chatComposerBrowser.test.ts` composeHtml, `sessionPicker.test.ts`).

## The model

Node: `{ id, parentId, kind, title, status, backend?, model?, role?, access?, startedAt, endedAt?,
lastEventAt, tools: [{id, name, summary, status}], result?, failure?, error?, dependsOn?: [], phase?,
lane?, usage?, costUsd?, costApprox?, anchor?, needs: [needId], note? }`.

Kinds: `root`, `workflow`, `step` (plan/verify/synthesize), `lane` (orchestration node), `delegate`,
`native` (Mysti scout), `advisor`, `review`, `mention`, `role` (@agent:role member), `session` +
`session-lane`, `debate` + `debater` (+ its `step` synthesis), `reported` (CLI's own subagent),
`job`. Containers (`workflow`, `session`, `debate`, role group `collab`) are not counted as agents.

Status: `waiting` (planned, not started) · `working` · `needs` (derived: has pending needs) ·
`stalled` (derived: working, no event for 90 s, no pending needs) · `done` · `failed` · `interrupted`.
`requestCancelled` turns every foreground `working`/`waiting` node into `interrupted` (jobs untouched).

Ids (webview-local, never sent to the host): root `root`; coordinator cards `card:<toolUse id>`;
workflow `wf:<runId|seq>` with lanes `wf:<run>:n:<nodeId>` and steps `wf:<run>:plan|verify|synth`;
mention `mention:<turn>:<agentId>`; role group `collab:<turn>` + `collab:<turn>:<collaboratorId>`;
session `session:<runId>` + `session:<runId>:<collaboratorId>`; debate `debate:<turn>` +
`debate:<turn>:<agentId>` + `debate:<turn>:synth`; job `job:<jobId>` with coordinator children
`job:<jobId>:card:<id>`. `<turn>` increments on `responseStarted`.

### What each message does

| Message | Effect |
|---|---|
| `responseStarted {provider, model?}` | turn++; root working, backend/model from the payload (not settings). |
| `responseComplete {usage?}` / `error` / `requestCancelled` | root done / failed / interrupted; cancelled interrupts foreground descendants. Root usage from `usage` when it has a signal. |
| `toolUse {id, name, input, meta?}` | `name==='delegate'`: `input.agent` `mysti`→native, `advisor`→advisor, else delegate on that backend; title `input.task`. `name==='review'`: review, backend `input.reviewer`. `name` in task/agent/dispatch_agent (case-insensitive) and id not `mysti-…`: `reported` on the turn's backend. Any other tool: append to the root's activity. `meta` (new, H4) fills kind/access/model. |
| `toolResult {id, status, output, meta?}` | the card node done/failed; `result` = output (clipped); `meta.failure`/`meta.usage`/`meta.costUsd`/`meta.model`/`meta.via` (H4). Fallback when no meta: parse `(failed: <code> — …)`. Non-card ids update root activity. |
| `mystiDelegateTrace {parentId, chunk}` | activity on `card:<parentId>`: tool_use/tool_result rows, `retry` note; `thinking` and `progress` bump `lastEventAt` only. The host sends a content-free `progress` ping (at most one per 5 s) while a child streams text, so a long answer never reads as stalled; the chat draws nothing for it. |
| `mystiStarted {brief}` / `mystiEvent {…, runId}` / `mystiComplete {cancelled}` / `mystiError {message}` | workflow node. `orch_status.phase` decompose/execute/verify/synthesize sets phase and step nodes. `orch_plan` creates lanes (waiting) with `dependsOn`; lane columns come from topological levels of `dependsOn`. `orch_node_start` sets backend. `orch_collab`: `collab_started`→working, tool rows, `collab_retry` note, `collab_error` NOT terminal, `collab_complete`→done/failed + `failure` + `usage`, `collab_skipped`→failed (terminal). `orch_synthesis`→synth step working→done on complete. Verify is done only on `orch_node_done 'verify'`; a verify that never reported settles `interrupted` when synthesize starts. When the run ends, lanes still `waiting` (a refused plan never dispatches) settle `interrupted` ("Not dispatched"), never Done. `mystiError.message` (not `.error`). |
| `subAgentStarted/Chunk/ToolUse/ToolResult/Status/Retry/Complete/Error/AskUserQuestion` | mention node by agentId within the turn. AUQ: `questionData.toolCallId` is the need id, attached only to a live (working) mention card; anything else has no chat card to review and nothing that would clear it. A question need ends with its agent (complete, error, Stop). A card's Retry restarts the same node; one clicked while its turn still runs outlives the turn landing (its card does too) and is stopped by the next send. |
| `collaborationStarted {collaborators, runId}` / `collaborator <CollaboratorChunk & {runId}>` / `collaborationError` / `collaborationComplete` | role group `collab:<runId>` + members keyed by `collaboratorId`, `role`, `label`. The host stamps the run's `runId` on every message, because a new send does not stop an @agent:role run: a late chunk of a superseded or finished run is dropped instead of settling or growing the next one. Same collab_* rules as lanes. |
| `sessionEvent {runId, …}` | `session_started` → session + lanes (`collaboratorId, agentId, label, status`); `lane_update` maps pending/running/done/error/skipped; `lane_text` bumps activity; `session_complete`/`session_error` terminal. `sessionError {runId?, message}`: the host's mid-run failure carries the run id; a refusal before any session started (too few agents, unknown shape) carries none and attaches to no earlier session. |
| `brainstormStarted` / `brainstormAgentChunk/Complete/Error` / discussion / convergence / synthesis / `brainstormComplete/Error` | debate group; debaters created lazily from agentId (brainstormStarted's list can be stale); convergence % on the group; synthesis step. |
| `jobStarted {jobId, title}` / `jobProgress` / `jobToolUse` / `jobToolResult` / `jobComplete` / `jobError` / `jobCancelled` / `jobsList {jobs, source?}` | job nodes (background section). `jobToolUse name==='delegate'` creates a child card under the job. `jobsList` upserts records including `interrupted`. |
| `permissionRequest {id, toolCallId?, ownerKey?, title, description, origin?}` | a need. Attach by: ownerKey==jobId → job; toolCallId == a node's card id → that node; toolCallId starts with `<cardId>-t` → that native node; toolCallId == a tool row id → its node; `origin` (H2): collaboratorId → lane/role/session member in this turn, `parentToolId` → card, agentId → the single working node on that backend; else root. |
| `permissionDismissed {requestIds}` / `permissionExpired` / `semiAutonomousDecision {requestId}` / local answer | resolve the need. |
| `askUserQuestion` (main) | a need on the root, keyed by its toolCallId. It outlives the turn, Stop and errors, exactly as the host's `_pendingAskUserQuestions` does: resolved only on the local answer/skip, `clearPlanOptions` removing the card, or the next `responseStarted` (the host forgets it on a new send). |
| `conversationChanged` / new conversation / `sessionCleared` | reset (jobs kept and re-requested with `requestJobs {source:'agentMap'}`). `sessionCleared {reason:'shutdown'}` (Stop agent session) does not reset: the chat and its agents are still there. |

## Host changes (small, each with tests)

- **H1 Orchestrator identity + verify phase.** Every event yielded by `MystiOrchestratorManager.run`
  carries `runId`. Add `'verify'` to the `orch_status` phase union and use it for the
  "Checking the parallel results for conflicts…" status. Keep the existing webview stepper working
  (verify maps onto its Execute step).
- **H2 Permission origin.** Optional `origin?: { kind: 'collaborator'|'mention'|'native-approval'|'paid';
  agentId?; collaboratorId?; role?; label?; parentToolId? }` on `PermissionRequest`, passed through
  `requestPermissionInline` → `PermissionManager.requestPermission` (trailing optional parameter) and
  posted as-is. Set it in `_requestCollaboratorPermission` (spec fields; plus `parentToolId` = the
  delegate card id when the dispatch came from a coordinator delegation — thread it through the
  delegation request if that is a small change), `_gateSubAgentToolUse` (agentId), the
  NativeApprovalCards request port (providerId) and the PaidSpendGuard ask (label).
- **H3 Job ownership.** `cancelJob` aborts only when the job record's `panelId` equals the host-bound
  `msg.panelId` (mirror `_handlePermissionResponse`) and this window is the one executing the job
  (`BackgroundJobManager.isExecutingHere`): another window's sidebar shares the panel id. `requestJobs` echoes `payload.source` back on
  `jobsList`; chat.js's existing handler skips its system-text listing when `source === 'agentMap'`.
- **H4 Delegation metadata.** `CoordinatorRunOutput.postToolUse/postToolResult` take an optional
  `meta` that is posted as a separate `meta` field (never inside `input`, which is persisted and
  re-folded into prompts). Coordinator delegate/advisor/review/native cards (foreground and job-routed)
  send `meta` on use `{kind, backend, access, model?}` and on result `{failure?, model?, via?, usage?,
  costUsd?, costApprox?}` where the host already knows them.
- **H5 Child usage.** `CollaboratorPool` captures the child's `done` usage per attempt, normalizes it
  with the child provider's convention (`TokenAccounting`), and sets `CollaboratorChunk.usage` on
  `collab_complete` only when `hasUsageSignal`. Orchestration lanes, role collaborators and delegate
  `meta.usage` then carry it.

## UI

- **Pill** in the status line: hidden while nothing is pending and the only nodes are the root and
  containers, so a plain turn keeps the three-segment status line. Otherwise
  `◆ 1 needs you · 12 agents` (needs), `12 agents · 4 working`, or `12 agents`. Click toggles the map.
- **Overlay** (`#agent-map`): header with title, one-line summary, status filter chips
  (All/Needs you/Working/Done/Failed with counts, plus Stopped once something was stopped: a user's
  Stop is never counted as a failure; `aria-pressed`; non-matching nodes dim), close. The close
  button stays in the top-right corner when the chips wrap.
- **Wide (≥ 1000 px):** graph tree — root on the left, children in a column to its right with
  connector lines (CSS on the nested lists), grandchildren further right. A workflow renders as a
  framed block: phase labels (Plan · Run · Verify · Synthesize) over columns — plan step, one
  column per dependency level of lanes, verify, synthesize — with arrows between columns and
  "after <task>" on lanes that depend on others (lanes are always named by task, never by the
  planner's ids). Columns keep a 160 px floor; a wide workflow scrolls the tree pane sideways rather
  than splitting words. Inspector on the right (~380 px).
- **Medium (640–999 px):** the same nested lists as an indented outline with guide lines; inspector on
  the right.
- **Narrow (< 640 px, the sidebar):** outline full width; choosing a node shows the inspector in
  place with a back button.
- Background section under the tree: jobs as rows.
- **Node row/card:** status glyph (shape + colour, never colour alone), title (ellipsis, full title in
  `title`), meta line: backend · access · duration · tokens. Real `<button>`s inside `role="tree"`
  semantics; Up/Down move focus between nodes; Enter/Space select.
- **Inspector:** kind, title, status line (with elapsed time), then as applicable: needs (each
  pending approval/question with "Review" → close map, jump to and focus the card), stall notice
  (`No output for Nm`; actions: Stop turn / Stop job), failure (code chip + message), result (clipped,
  "Show in chat"), facts (backend, model, role, access, spawned by — the main agent of the turn that
  spawned it, not whichever agent runs now — depends on, time, tokens, cost),
  activity (last 20 tool rows), workflow detail for workflows (phase tracker, lane timeline bars
  scaled to the workflow's elapsed time, handoffs from `dependsOn`), actions (Show in chat; Ask
  another agent… → prefill the composer with `@<agent> <task>` for failed/done delegate, lane,
  mention, role and session-lane nodes; Stop turn; Stop job).
- **Stall:** 90 s without an event while working and without pending needs. A 5 s tick runs only
  while the map is open, and rebuilds only while something works.
- **Rebuilds** keep the tree's scroll, the shown node's inspector scroll and focus (without scrolling
  the pane back to the focused row), and wait while the user is selecting text. A resize rebuilds only
  when it changes the layout; CSS reflows the rest.
- **Names:** rows use `getAgentDisplay`, which names the pseudo-agents `Mysti` and `Brainstorm`. The
  root row is titled by the turn's backend (`Mysti`, `Claude Code`) once one is known, with
  "Main agent" as its kind label and as the fallback title.
- Empty state: "Agents appear here while they work in this chat.", said once, with no filter chips and
  no inspector.
- Connector lines use a line colour mixed from the foreground: `--mysti-border` is nearly the panel
  surface in dark themes.

## Out of scope for v1 (named, not silently dropped)

Per-agent stop and per-node retry (needs a pool tombstone + reroute opt-out); open transcript (no
store exists); rebuilding past runs after a window reload (only jobs are re-requested); Claude
`parent_tool_use_id` linkage (inner activity of CLI-reported subagents); per-agent tokens for mention
sub-agents and brainstorm debaters; background-job delegate traces; a dev-server/process list; a
question from a mention that is not working (no chat card, so no need); "Stop job" from a window that
is not executing the job (the host refuses it).
