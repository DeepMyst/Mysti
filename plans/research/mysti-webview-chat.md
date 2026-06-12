# Mysti Chat UI Layer Review — ChatViewProvider.ts + webviewContent.ts

Scope: message routing (extension ↔ webview), permission card flows (`_shouldGateToolUse`), per-provider StreamChunk rendering consistency, XSS/injection in markdown rendering, sidebar state restoration.
Files: `src/providers/ChatViewProvider.ts` (6,793 lines), `src/webview/webviewContent.ts` (18,669 lines), supporting provider files in `src/providers/*/`, `src/utils/permissionClassifier.ts`.
All findings below were confirmed by reading the working-tree code (branch `feature/visual-testing`, uncommitted Canvas v2 changes included).

---

## 1. Critical findings

### 1.1 Stream-level permission gate is name-keyed with a fail-open default — bypassed for Gemini, Qwen, Cursor, OpenCode, Copilot

**Evidence chain:**

- `src/utils/permissionClassifier.ts:22-55` — `WRITE_TOOLS` is an exact, case-sensitive map; anything not listed classifies as `'file-read'`:
  ```ts
  const WRITE_TOOLS: Record<string, PermissionActionType> = {
    'Edit': 'file-edit', 'edit_file': 'file-edit', 'replace_in_file': 'file-edit', ...
    'Write': 'file-create', 'write_to_file': 'file-create', 'create_file': 'file-create',
    'delete_file': 'file-delete', 'remove_file': 'file-delete',
    'Bash': 'bash-command', 'bash': 'bash-command', 'shell': 'bash-command', ...
  };
  export function classifyToolAction(toolName: string): PermissionActionType {
    return WRITE_TOOLS[toolName] || 'file-read';   // fail-open
  }
  ```
- `src/utils/permissionClassifier.ts:63-68` — `shouldGateToolUse` returns `false` for anything classified `file-read`, so unknown write tools are never gated.
- `src/providers/ChatViewProvider.ts:2871-2873` — the gate additionally skips when `_classifyToolAction(...) === 'file-read'`.
- Every CLI provider deliberately bypasses its own interactive permissions (piped stdin), relying on this gate as **the sole enforcement point**:
  - Gemini: `src/providers/gemini/GeminiProvider.ts:247-250` — `args.push('--yolo')` for all non-read-only modes, comment: "The stream-level tool-use gate in ChatViewProvider handles permission prompts."
  - Copilot: `src/providers/copilot/CopilotProvider.ts:452-455` — `args.push('--allow-all-tools')` for ask-before-edit etc.
  - Cline: `src/providers/cline/ClineProvider.ts:311-312` — `--yolo` ("stream gate handles UI prompts").
  - Qwen: `src/providers/qwen/QwenCodeProvider.ts:229-231` — `--approval-mode auto-edit` (auto-approves edits at CLI level) for ask-before-edit.

**Per-provider tool-name reality (all confirmed in parseStreamLine):**

| Provider | Tool name emitted to gate | Gate result in `ask-before-edit` |
|---|---|---|
| Claude Code | Canonical `Edit`/`Write`/`MultiEdit`/`Bash`/`NotebookEdit` | Gated correctly |
| Codex | Normalized to `Bash`/`Write`/`Edit` (`CodexProvider.ts:705,849`) | Gated correctly |
| Cline | Cline names `write_to_file`/`replace_in_file`/`execute_command` (in map) | Gated correctly |
| Gemini | Raw `data.tool_name` pass-through (`GeminiProvider.ts:308,336,343`) — Gemini CLI's write tools are `write_file`, `replace`, `run_shell_command`, none in `WRITE_TOOLS` | **Bypassed** — file writes & shell run under `--yolo` with zero prompt |
| Qwen | Raw `block.name` pass-through (`QwenCodeProvider.ts:395-407`); qwen-code is a gemini-cli fork with the same tool names | **Bypassed** (and CLI itself auto-approves edits via `auto-edit`) |
| Cursor | Mapped to lowercase `write`/`edit`/`delete` (`CursorProvider.ts:288-299`); map has only capitalized `Write`/`Edit` and `delete_file` | **Bypassed except `bash`** |
| OpenCode | Raw `part.name` (`OpenCodeProvider.ts:302-317`); OpenCode tools are lowercase `edit`/`write`/`patch` | **Bypassed except `bash`** |
| Copilot | CLI emits plain text, not JSON (`CopilotProvider.ts:463-575`, "This is the expected case") → tool_use chunks effectively never produced | **No gate ever fires** while CLI runs `--allow-all-tools` |
| Ollama/LocalAI | Model function names (no execution happens anyway) | N/A |
| Manus | Never emits tool_use | N/A |
| OpenClaw | Gateway events | partial |

**Impact:** In `ask-before-edit` mode (the shipped default, `_sendInitialState` line 438) or `ask-permission` access level, 5 of the 12 providers can edit files and execute shell commands with no permission card while the UI tells the user they'll be asked. This is the single largest correctness/security gap in the chat layer.

**Fix:**
1. Make the gate fail-closed for unknown tools when mode requires approval (or at minimum classify by substring/normalized name: `/write|edit|patch|replace|delete|shell|command|bash|exec/i`).
2. Require each provider to normalize tool names to the canonical set (Codex already does) — add it to the `ICliProvider` contract.
3. For Copilot: until JSON output exists, do not advertise ask-before-edit support; force `--deny-tool write --deny-tool shell` unless mode is edit-automatically + full-access.

### 1.2 Setup wizard runs with `panelId = null` — all wizard responses are dropped

- `src/providers/ChatViewProvider.ts:413-420` — when no provider is ready, `_sendInitialState` posts `showWizard` and **returns early**; the `initialState` message (the only message carrying `panelId`) is never sent.
- `src/webview/webviewContent.ts:9306` — `state.panelId` starts as `null`; the only assignment is inside `initializeState` (`state = Object.assign({}, state, payload)`, line 15208). `handleShowWizard` (line 13688-13698) does not set it, and the `showWizard` payload contains no panelId.
- `src/webview/webviewContent.ts:10217-10220` — every outgoing message gets `msg.panelId = state.panelId` (i.e., `null`).
- `src/providers/ChatViewProvider.ts:1099-1162` — all wizard cases (`checkSetup`, `startProviderSetup`, `selectAuthMethod`, `requestWizardStatus`, ...) pass `msg.panelId` straight through; e.g. `_handleStartProviderSetup` (line 6333-6390) posts every `providerSetupStep` via `_postToPanel(panelId, ...)`.
- `src/providers/ChatViewProvider.ts:6073-6076` — `_postToPanel(null, ...)` → `this._panelStates.get(null)` → `undefined` → message silently discarded.

**Impact:** On a fresh install with no provider CLI present (exactly the audience the wizard exists for), wizard progress updates, auth options, setup status, and detection refresh never reach the webview — the wizard appears frozen.

**Fix:** Include `panelId` in the `showWizard` payload and set `state.panelId` in `handleShowWizard`; defensively default `msg.panelId ?? 'sidebar'` for sidebar-originated messages in `_handleMessage`.

---

## 2. High-severity findings

### 2.1 Cancelled / denied / errored responses are never persisted — visible text vanishes on reload

- `src/providers/ChatViewProvider.ts:2790` — `if (this._cancelledPanels.has(panelId)) {break;}` exits the stream loop *before* the `done` case can run.
- The **only** place the assistant message is saved is inside `case 'done'` (lines 3045-3052, `addMessageToConversation`). There is no save in the cancel path, the permission-deny `return` (line 2914), or the `catch` (lines 3181-3187).
- The webview meanwhile has rendered the partial text (`responseChunk` → `updateCurrentContentSegment`), so the user sees content that silently disappears when the webview reloads or the conversation is switched.

**Fix:** In a `finally` (or before `break`/`return`), persist accumulated `assistantContent`/`thinkingContent` (flagged as interrupted) and post a `responseComplete`/`requestCancelled` so the webview can finalize the bubble.

### 2.2 `_runningPanels` / lifecycle "busy" leak on every non-`done` exit

- `src/providers/ChatViewProvider.ts:2782` — `_runningPanels.add(panelId)`; removed only in `case 'done'` (line 3075) and on tab dispose (line 6044).
- The `cancelRequest` handler (lines 630-648) cancels the provider and posts `requestCancelled` but never deletes from `_runningPanels`, never calls `_lifecycleManager.markIdle(panelId)`, and never clears `_pendingAskUserQuestions`/`_semiAutoQuestionTimeouts`.
- The `catch` block (3181-3187) calls `markIdle` but not `_runningPanels.delete`.
- Consequences: (a) the next `_handleSendMessage` always takes the "cancel previous" path (50 ms stall + global permission dismissal, see 2.3); (b) `ChannelBridge.isRunning` (line 301) reports stale `true`, so inbound channel messages get queued forever instead of injected; (c) lifecycle idle-timeout cleanup never fires for a panel stuck "busy" after an error.

**Fix:** wrap the stream loop in `try/finally { this._runningPanels.delete(panelId); this._lifecycleManager.markIdle(panelId); }` and clear pending question state in `cancelRequest`.

### 2.3 Cross-panel permission interference: new message in panel A force-resolves panel B's pending permission

- `src/providers/ChatViewProvider.ts:2339-2347` — when a panel has a running request, a new message calls `this._permissionManager.cancelAllRequests()`.
- `src/managers/PermissionManager.ts:246-250` — `cancelAllRequests()` iterates **every** pending request, regardless of panel.
- The `permissionDismissed` UI cleanup is posted only to the sending panel (line 2345). Another panel awaiting approval gets its gate promise resolved (denied) → its stream is cancelled with "Operation ... was denied. Request cancelled." while its permission card still looks pending.

**Fix:** key permission requests by panelId and add `cancelRequestsForPanel(panelId)`.

### 2.4 Unsanitized `marked.parse` output + permissive CSP = HTML/UI-spoofing injection from model & tool output

- `src/webview/webviewContent.ts:18370-18399` — `formatContent` returns `marked.parse(content)` directly; assigned via `innerHTML` for every assistant message (`updateCurrentContentSegment` line 15758, `addMessage` line 15597) and sub-agent text (lines 9779, 9842). Marked does **not** sanitize raw HTML.
- CSP (`webviewContent.ts:59`) blocks scripts (`script-src 'nonce-…'`) but allows `style-src 'unsafe-inline'` and `img-src ... data: blob:`. So model/tool output can inject arbitrary `<style>` blocks, `<div>`/`<img>`/`<a>` structures.
- Practical attacks: a poisoned file or web page read by a tool can make the model emit HTML that (a) renders a **fake permission card / fake "Mysti" system message**, (b) uses injected CSS to overlay or relabel real Approve/Deny buttons, (c) hides parts of the transcript.
- Compounding spots where even `escapeHtml` is skipped on model-controlled values:
  - `renderPermissionDetails` — `details.filePath` inserted unescaped: `webviewContent.ts:16218-16222` (inside the *security* card itself).
  - `updateContext` — `item.path` unescaped in `title="..."`: `webviewContent.ts:15304-15306`.

**Fix:** run marked output through DOMPurify (bundle into `resources/`), or set a marked renderer that escapes raw `html` tokens; escape `filePath`/`path` everywhere; consider dropping `'unsafe-inline'` for styles.

### 2.5 Claude `exit_plan_mode` chunk is produced but consumed nowhere

- Produced: `src/providers/claude/ClaudeCodeProvider.ts:488-491` (ExitPlanMode tool intercepted, **not** forwarded as `tool_use`).
- Consumed: `grep -rn exit_plan_mode src/` matches only the producer and the type union (`src/types.ts:279`). The `_handleSendMessage` switch (lines 2792-3179) has no case; webview has no handler.
- Impact: in Claude plan modes, the ExitPlanMode call is swallowed — no plan-approval UI, no tool card, the `planFilePath` is lost. (`type: 'compaction'` in the same union is likewise dead — never produced or consumed.)

**Fix:** handle `exit_plan_mode` in `_handleSendMessage` (route into PlanOptionManager / plan-selection UI) or stop special-casing it in the provider.

### 2.6 Queued channel messages all fire ~simultaneously and cancel each other

- `src/providers/ChatViewProvider.ts:3076-3106` — on `done`, every queued channel message is scheduled with the **same** `setTimeout(..., 500)` inside the loop. With N > 1 queued messages, N concurrent `_handleSendMessage` calls start ~at once; each later call sees `_runningPanels.has(panelId)` (set by the earlier one, eventually) and cancels the previous — earlier queued messages are aborted mid-flight; worse, because `_runningPanels.add` happens late (see 2.7), two streams can genuinely interleave on one panel.

**Fix:** drain sequentially (await each `_handleSendMessage`, or chain with increasing delays / a queue).

### 2.7 `_runningPanels` is set too late — concurrent streams possible during @-mention processing

- `responseStarted` is posted at line 2412 but `_runningPanels.add(panelId)` only happens at line 2782, after mention/sub-agent processing which can run for minutes (`SUBAGENT_TIMEOUT_MS` = 1 h).
- The webview blocks user sends while `state.isLoading` (webviewContent 15488), but `injectChannelMessage` (lines 275-300) and autonomous continuation only consult `isRunning` (`_runningPanels`), so a channel message arriving during mention processing starts a second `_handleSendMessage` on the same panel → interleaved `responseChunk`s rendered into one streaming bubble, double `messageAdded`, double `done` persistence.

**Fix:** add the panel to `_runningPanels` at the top of `_handleSendMessage` (right after the supersede check).

---

## 3. Medium-severity findings

### 3.1 Panel dispose handler clears *all* panels' plan timers and misses question state
`src/providers/ChatViewProvider.ts:6054-6058` — on a tab's dispose, `for (const [planId, timer] of this._semiAutoPlanTimeouts.entries())` clears every entry (keys are synthetic plan IDs, not filtered by panel) → an open plan countdown in another panel silently dies. Meanwhile `_semiAutoQuestionTimeouts`, `_pendingAskUserQuestions`, `_pendingQuestionData`, `_panelFilesRead/Written` are never cleaned for the disposed panel (leak + stale auto-answer timers, see 3.2).

### 3.2 Semi-autonomous question timer fires after cancellation and revives a dead request
- Timer set in `ask_user_question` case (lines 3030-3033). The `cancelRequest` case (630-648) clears neither the timer nor `_pendingAskUserQuestions`.
- `_handleSemiAutonomousQuestionTimeout` (4073-4124) only checks `_pendingAskUserQuestions.has(panelId)` — still true after cancel — so up to `semiAutonomous.timeout` seconds after the user cancelled, the AI auto-answers the stale question and `_handleAskUserQuestionResponse` (2209) launches a brand-new `_handleSendMessage`. The agent "resurrects" after the user explicitly stopped it.

### 3.3 No sidebar dispose handling; `_postToPanel` can throw on disposed webviews
- `resolveWebviewView` (368-402) registers no `onDidDispose`/`onDidChangeVisibility`; only tab panels (6033), canvas (5069), and the VT dashboard (4860) clean up.
- `_postToPanel` (6073-6076) calls `webview.postMessage` without try/catch. VS Code throws on disposed webviews; if the sidebar is disposed mid-stream (view moved/container closed), the throw propagates from inside the stream loop, the `catch` (3183) then *also* throws while posting the error → unhandled rejection, message never persisted, `_runningPanels` leak (see 2.2). Pending permission cards rendered in the destroyed DOM become unanswerable; the extension-side promise only resolves via timeout (or never, with `require-action`).

### 3.4 Permission gate suspend race & Windows gap
`ChatViewProvider.ts:2863-2916` — gating happens when the parsed `tool_use` chunk reaches the extension; the CLI may already be executing the tool (stdout pipe buffering) before `suspendRequest` sends SIGSTOP. On Windows `suspendRequest` returns false (comment line 2876) and the code proceeds to show the card anyway — the tool can complete while the user is still deciding; a later "deny" just kills the process after the fact. Also, gating is skipped entirely for `tool_use` chunks with empty input (line 2870) — fine for Claude's double-emit pattern, but any provider emitting a complete tool call with legitimately empty input `{}` bypasses the gate.

### 3.5 Codex `**…**` heuristic misclassifies bold answers as thinking
`src/providers/codex/CodexProvider.ts:632-646` — any content line that starts and ends with `**` is rewritten into a `thinking` chunk. A legitimate answer like `**Done**` or a bold heading line disappears from the answer body and lands in the thinking block (and is therefore stored in `thinking`, not `content`).

### 3.6 Tool cards: Ollama/LocalAI spinners never resolve; Cursor failures shown as success; multi-tool messages dropped in Qwen
- Ollama emits `tool_use` but never `tool_result` (`OllamaProvider.ts:275-291`) → card stays in `running` spinner forever (`handleToolResult` never fires). Same pattern in LocalAI.
- Cursor `tool_result` is always `status: "completed"` even when the result is `rejected` (`CursorProvider.ts:469-493`) → failed tools render green.
- Qwen's `assistant` message handler returns on the **first** `tool_use` block (`QwenCodeProvider.ts:395-407` — `return` inside `for`), dropping subsequent tool calls in the same message.

### 3.7 Conversation restore loses tool cards, diffs, segments, and per-message model attribution
- `ConversationManager.addMessageToConversation` (165-185) has no `toolCalls` parameter; nothing ever persists tool calls although `Message.toolCalls` exists (`types.ts:69`).
- `addMessage` (webviewContent 15551-15602) renders restored messages as one flat `message-content` + a single flat, *non-collapsible*, plain-escaped thinking block (15592-15595) — no tool cards, no file-edit cards, no todo lists, no interleaved segments. The live and restored views of the same conversation look completely different.
- Line 15564: restored assistant messages display `getModelDisplayName(state.settings.model)` — the *currently selected* model, not the model that produced the message.

### 3.8 `_handleUpdateSettings` custom-model map missing `qwen-code`
`ChatViewProvider.ts:3607-3618` — `providerModelKeys` lacks `'qwen-code': 'qwenCodeModel'` (present in the read-side map at lines 447-459). Setting a custom Qwen model from the UI silently does nothing.

### 3.9 `_vtTriggeredThisResponse` is an instance field, not per-panel
`ChatViewProvider.ts:113` and reset at 2771 — two panels streaming concurrently share the flag; panel B's reset can allow a duplicate visual-test trigger or suppress a legitimate one in panel A.

### 3.10 Sidebar recreation mid-stream renders a truncated bubble
With `retainContextWhenHidden: true` (extension.ts:177) this is rare, but when the sidebar webview *is* recreated (view moved between containers), `_panelStates['sidebar']` is overwritten (385-390) and subsequent `responseChunk`s arrive at a fresh webview whose `currentResponse` is empty — the in-flight reply renders starting mid-sentence. `finalizeStreamingMessage` (17216-17241) recovers only the single-segment case ("For multiple segments, leave them as-is").

---

## 4. Per-provider UX consistency matrix

Legend: ✅ works, ⚠️ partial/divergent, ❌ absent. "Gate" = stream permission gate effective in ask-before-edit (see 1.1).

| Provider | Streamed text | Thinking blocks | Tool cards (use+result) | Errors | Auth-error card | Session indicator | Usage stats / context bar | AskUserQuestion | Images in | Gate | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Claude Code** | ✅ | ✅ collapsible "first-sentence preview" style | ✅ canonical names; file-edit cards, TodoWrite list | ✅ | ⚠️ (via error text) | ✅ | ✅ (`message_delta`) | ✅ native tool | ✅ (`supportsImages`) | ✅ + SIGSTOP | Reference experience. `exit_plan_mode` chunk dropped (2.5) |
| **Codex** | ✅ | ⚠️ hard-coded separate-block style (webview forks on `provider === 'openai-codex'`, line 15680); `**…**` misclassification (3.5) | ✅ normalized Bash/Write/Edit + web_search | ✅ | ⚠️ oauth flow | ✅ | ✅ (incl. cached tokens) | ✅ | ❌ stripped + toast | ✅ | CLI sandbox flags add 2nd safety layer |
| **Gemini** | ✅ | ❌ none emitted; thinking UI section hidden *only* for Gemini (11980-11986) | ⚠️ raw tool names → poor summaries via fallback path | ✅ | ❌ no auth_error chunk | ✅ | ✅ | ⚠️ only if tool named `ask_user*` | ❌ | ❌ **bypassed** | Always `--yolo` outside read-only |
| **Cline** | ⚠️ answer not streamed — interim `say:"text"` shown as *thinking*; final answer pops in at `completion_result` (ClineProvider 467-481) | ✅ (but contains the whole reasoning transcript) | ✅ names in gate map | ✅ rich (api_req_failed etc.) | ⚠️ via error | ✅ | ✅ | ✅ via `ask` | ❌ | ✅ | Always `--yolo` |
| **Copilot** | ⚠️ plain-text lines reformatted to pseudo-markdown (`_formatTerminalOutput`) — tool activity appears as `✓ …` text, not cards | ❌ (supportsThinking false, selector still shown) | ❌ effectively none (JSON path speculative) | ⚠️ | ✅ dedicated auth_error | ⚠️ only from hypothetical JSON | ⚠️ only from hypothetical JSON `result` | ⚠️ hypothetical | ❌ | ❌ **never fires** | Runs `--allow-all-tools` |
| **Cursor** | ✅ | ❌ | ⚠️ lowercase names; failures shown as `completed` (3.6) | ✅ | ❌ | ✅ | ✅ | ⚠️ name-sniffing | ❌ | ⚠️ only `bash` | |
| **OpenClaw** | ✅ (CLI + Gateway WS) | ✅ (claude-style UI) | ⚠️ | ✅ | ✅ (2 paths) | ✅ | ❌ no usage → context bar & compaction dead | ✅ | ❌ | ⚠️ | |
| **OpenCode** | ✅ | ✅ (claude-style UI) | ⚠️ lowercase names | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ | ⚠️ only `bash` | |
| **Qwen** | ✅ | ✅ (claude-style UI) | ⚠️ raw names; multi-tool drop (3.6) | ✅ | ✅ regex-detected | ✅ | ✅ | ❌ | ❌ | ❌ **bypassed** | `auto-edit` auto-approves edits; custom model setting broken (3.8) |
| **Ollama** | ✅ | ❌ | ⚠️ `tool_use` only, eternal spinner (3.6); tools never executed | ✅ | ❌ | ❌ never (no session_active) | ✅ (eval counts) | ❌ | ✅ | N/A | |
| **LocalAI** | ✅ | ❌ | ⚠️ same as Ollama | ✅ | ❌ | ❌ never | ✅ | ❌ | ❌ | N/A | |
| **Manus** | ✅ (poll-based, bursty) | ⚠️ single chunk | ❌ no tool events at all | ✅ | ✅ | ❌ never (despite `supportsSessions: true`) | ❌ none → context bar & compaction dead | ❌ | ❌ | N/A | |

**Cross-cutting divergences:**
- **Thinking UI style is keyed to a provider id, not a capability** (`webviewContent.ts:15680`): only `openai-codex` gets discrete thought blocks; everyone else inherits the Claude accumulate-into-one-collapsible behavior, including providers that emit complete paragraphs per chunk.
- **Thinking-level selector** is hidden only for Gemini (`updateThinkingSectionVisibility`, 11980-11986), yet `supportsThinking:false` also for Copilot/Cursor/Ollama/LocalAI/Manus → dead dropdown for 5 providers. `getThinkingTokens` is only implemented by Claude and Cline (`MAX_THINKING_TOKENS` env); the selector is a no-op for Codex (comment says use config.toml), Gemini, and everyone else.
- **Session indicator** (`sessionActive` → green dot) never appears for Ollama, LocalAI, Manus; appears for the rest. No provider name/session id is shown, so users can't tell *what* is resumed.
- **Context-usage bar + compaction** depend on `done.usage`; OpenClaw and Manus never supply it → for those providers the bar silently shows the previous provider's numbers (never reset on provider switch) and CompactionManager never engages.
- **Tool summaries** (`formatToolSummary`, 15776-15821) are written for Claude's lowercase names; Gemini/Qwen names (`run_shell_command`, `write_file`, `replace`) fall to the generic branch, producing blank or raw-JSON summaries.
- **AskUserQuestion**: native only on Claude; Gemini/Copilot/Cursor/Codex rely on the tool being literally named `ask_user`/`AskUserQuestion`/`ask_user_question`; OpenCode/Qwen/Ollama/LocalAI/Manus have no path → interactive Q&A cards are a Claude-mostly feature.
- **Attachments**: only Claude (`supportsImages && supportsFileAttachments`) and Ollama (`supportsImages`) accept images; others strip with a toast (2694-2718) — reasonable, but the input UI shows the attach affordance identically for all providers.

---

## 5. Other notable bugs (low)

- `showError` with `undefined` payload renders "Error: " (extension forwards `chunk.content` unchecked, 2943-2948).
- `addMessageToConversation` falls back to *current* conversation when the panel's conversation id is stale (`ConversationManager.ts:173-180`) — a message sent from a tab whose conversation was deleted lands in the sidebar's conversation.
- `handleChannelAction` 'inbound' attaches the card to `.message:last-child` which may be a *user* message or permission card (16001-16009).
- `getOrCreateStreamingMessage` resets `state.isLoading=false` on first chunk (15654) so the Stop button disappears while the provider is still generating — stop affordance is only present pre-first-chunk; after that users must send a new message to cancel.
- `_handlePermissionRequest` (3989-4005) still uses a modal `showInformationMessage` — a second, inconsistent permission UX besides the inline cards.
- Webview `marked.parse` re-renders the *entire* accumulated response and schedules `Prism.highlightAll()` (whole-document) on **every** text chunk (18376-18384) — O(n²) work on long answers; noticeable jank with big code blocks.

---

## 6. Improvement opportunities (non-bug)

1. **Capability-driven UI**: drive thinking-selector visibility, thinking render style, attach button, session indicator, and usage bar off `ProviderCapabilities` instead of hard-coded provider ids. Add capabilities like `emitsToolEvents`, `emitsUsage`, `thinkingStyle: 'incremental'|'block'`.
2. **Canonical StreamChunk contract**: define a normalization layer (tool-name mapping table per provider, required `done.usage`, required `tool_result` for every `tool_use`, status vocabulary) and a conformance test per provider — that single contract would fix most of the matrix above.
3. **Persist render-relevant message structure**: store segments/toolCalls/thinking per message so restored conversations look like live ones; render restored thinking with the same collapsible component.
4. **Streaming renderer**: append-only markdown rendering (render only the changed tail, highlight only new code blocks) instead of full re-parse per chunk.
5. **Central panel-scoped state object**: `_pendingAskUserQuestions`, `_pendingQuestionData`, `_semiAutoQuestionTimeouts`, `_pendingPlanSelections`, `_pendingPlanData`, `_semiAutoPlanTimeouts`, `_panelAutonomyLevel`, `_panelFilesRead/Written`, `_lastUserMessage`, `_lastMentionContext` are 10 parallel maps with hand-rolled cleanup in 3 different places; one `PanelRuntimeState` object with a single `disposePanel(panelId)` would eliminate the partial-cleanup class of bugs (3.1/3.2).
6. **Split webviewContent.ts**: 18.7k lines of string-embedded JS with no bundling or tests; even moving the script to a real `.js` asset (kept under `resources/`, loaded with the existing nonce) would enable linting and unit tests for `formatContent`, `formatToolSummary`, etc.
7. **Per-message provider/model stamping**: persist `provider`+`model` on each assistant Message and render that (fixes 3.7 attribution and enables a true multi-agent transcript).
8. **Show degraded-mode banners**: when a provider lacks tool events/usage (Copilot, Manus, OpenClaw), say so in the UI instead of silently missing features.

---

## 7. Notable strengths

- **Single permission pipeline**: AskUserQuestion, detected questions, plan selection, and permission cards all converge on shared handlers with autonomous/semi-autonomous/manual tiers — well-factored decision logic (`requestPermissionInline`, `_handleDetectedQuestions`).
- **SIGSTOP suspension** of the CLI before approval (when it works) is a genuinely strong design for piped CLIs; the suspended "Paused" indicator on cards is a nice touch.
- The classifier extraction to `src/utils/permissionClassifier.ts` as a pure function makes the 1.1 fix easy and testable.
- Webview is generally diligent about `escapeHtml` on dynamic fields (tool names, summaries, suggestions, history titles); the gaps found (filePath/title attrs, marked output) are exceptions, not the rule.
- CSP with per-load nonce and no `unsafe-inline` scripts blocks the worst XSS outcomes despite unsanitized markdown.
- Per-panel session architecture (`_panelSessions`, panelId threading, supersede-on-new-message at 2336-2348) is consistently applied across 12 providers.
- Claude double-emit tool_use handling (empty-input skip with comment, 2865-2870) and Codex name normalization show real attention to stream semantics.
- Mermaid is initialized with `securityLevel: 'strict'` (9100).
- Restoration path re-sends full initial state (settings, conversation, availability, agents, engagement) in one message — simple and mostly race-free thanks to the init-loading overlay.
