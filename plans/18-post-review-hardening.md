# Plan 18 — Post-Review Hardening (v0.4.0 → 0.5.0 release gate)

Date: 2026-07-13 · Provenance: 6-agent parallel staff review of everything since v0.4.0 (Mysti coordinator, delegation/jobs/mentions, CLI providers, brainstorm, canvas/visual-testing, PR #37), ~966k review tokens, every finding carries file:line evidence. Review dashboard artifact: `claude.ai/code/artifact/94489d7f-60eb-4f49-b549-4edd8d36904e`.

**State at review time:** branch `feature/visual-testing`, 82 commits ahead of v0.4.0 (+68.3k/−19.4k, 262 files), plus ~11.1k LOC uncommitted (the whole Plans 14–17 coordinator layer, 70 untracked files). `tsc` clean, **1824/1824 tests green**.

**The through-line:** the new hardened primitives are correct — the gated `CollaboratorPool`, the base-class CLI spawn path, and all 7 Mysti coordinator security invariants verified with evidence. Every HIGH finding lives in code that predates or sidesteps them: legacy `@agent` mentions, brainstorm, Codex's bespoke `sendMessage`. **Fix by routing stragglers through the hardened path, not by patching each in place.**

> **Execution log**
> - **2026-07-13 — Phase −1 DONE.** The ~11k-LOC uncommitted layer committed in 5 chunks (`9e699ed`…`40360f1`); C3 tsc-verified in an isolated worktree; tip 1824/1824 green.
> - **2026-07-13 — Wave 1 DONE (0.1–0.4 + 1.1 + review hardening).** A 23-agent adversarial review of the wave diff (19/20 findings confirmed) forced five upgrades before commit: (1) the sub-agent gate now **suspends children BEFORE awaiting** the permission card (deny previously killed an already-executed command) — shared `_gateSubAgentToolUse` helper used by both the main mention loop and the `retrySubAgent` handler, which had an identical unfixed copy of H1; (2) cancel fan-outs cover `-followup` (and `-retryN-followup`) panels; (3) brainstorm child disposal moved from clean-`done` (a continuity regression) to Stop/error/new-conversation/tab-dispose; (4) Gemini read-only/plan remapped `--sandbox` → `--approval-mode plan` (4.3 pulled forward — forcing read-only brainstorm children made the sandbox spawn-failure user-visible); (5) pool: follow-up children recorded in `_runChildProviders` + a `_closedRuns` tombstone so a child parked at a gate/question when Stop hits can't resurrect the maps or spawn children for a dead run. Suite 1841/1841 + tsc clean.
> - **Accepted residuals (documented, not fixed):** canvas "Always for this workspace" pins the launcher string (`npm run dev`), not the script content — workspace-level trust semantics, same as VS Code workspace trust; tool_use visibility covers the individual-analysis phase only (discussion/synthesis phases have no thinking chunk lane; children are read-only everywhere, so the security property holds); the `_gateSubAgentToolUse` suspend is best-effort on Windows (no SIGSTOP) — parity with the main-path gate, tracked under the Windows epic.
> - **2026-07-13 — Wave 2 DONE (Phase 3 complete + 4.1).** F1 project brain → user turn; F3 directive nonce redacted from every fed-back channel (fence helpers + direct-prompt segments + brain, which now strips BOTH nonces); F2/M2 orchestrator dep-outputs + synthesis fenced, failed deps annotated; F5 pool web-requests defer to user gate policy (with two review-forced corrections: read-only users' web requests always prompt — the bare policy fn gates nothing under the strictest setting — and a failed freeze downgrades a web READ to a best-effort prompt instead of killing the researcher on Windows); F6 read-only users get read-only delegation specs + the coordinator system prompt says so; F7 scanner fence-aware (line-anchored stateful backtick walker — inline ``` in prose must not demote later directives) + F8 flush no longer strands post-directive prose (including via the fenced/malformed branches); M3 legacy sub-agent context nonce-fenced; 4.1 effortLevel in the persistent snapshot, capability-gated (an effort flip must not destroy a live Hermes ACP session); F4 `mysti.viewMystiMemory` command + `MystiMemoryStore.forget`. A 17-agent adversarial review (14/15 confirmed) forced the F5 corrections, the scanner line-anchoring + stranded-tail fixes, the capability gate, and the brain double-nonce strip pre-commit. Suite 1864/1864 + tsc clean.
> - **Wave 2 deferred (documented):** the pool's F5 fast-pass consults the bare `shouldGateToolUse`, not the autonomous-aware `ChatViewProvider._shouldGateToolUse` — in autonomous mode a delegated WebFetch skips the SafetyClassifier that direct chat would apply. Pre-existing parity gap for ALL pool fast-paths, not a Wave 2 regression; fold into the Phase 2.4 override audit (inject a policy callback through dispatch options).
> - **2026-07-13 — Wave 3 DONE (2.1/2.2 + 2.4 trivial tier).** Codex override DELETED (−139 lines, `bdae13a`): no new base hooks needed — `buildCliArgs` appends the stdin `-`, channel context rides `buildPromptAsync` (the native `-c developer_instructions=` injection was also the unquoted shell-mode vector); base `processStream` subsumes `_processCodexStream` + adds the zero-exit-no-content path. **7-provider audit** (agent, evidence-based scorecards) + trivial-tier fixes applied: early spawn `error` listener ×4 (Copilot/OpenClaw/Cline/Cursor — a four-provider copy-paste omission → uncaught host exception on ENOENT), Copilot setup moved inside try (sync Windows EINVAL escaped the generator — provider hard-broken on default npm Windows installs), OpenClaw silent-failure gates dropped (non-zero exit + empty stderr used to end the turn with NO error chunk) + liveness kill-tree, Cursor kill-tree + API key off argv (`ps`-visible), abort-in-finally ×3 (Ollama — GPU keeps generating after abandonment; LocalAI; OpenRouter — billable SSE leak).
> - **Wave 3 deferred (audit findings, tracked):** (i) Copilot/Cursor/OpenClaw pass the prompt as ARGV — they structurally can't adopt the base Windows shell fix; real fix = stdin transport (Cline proves it), `.cmd`→`node.exe` shim resolution, or a base "argv prompt" hook + the ~32K Windows argv ceiling → Windows epic (#14/#27/#30). (ii) Cline's 200K stdin threshold is macOS-calibrated (Windows ~32K) + `.clinerules` clobber-on-crash hazard. (iii) OpenClaw gateway abandonment never sends `agent.stop` — the daemon turn keeps running server-side. (iv) Ollama/LocalAI 120s whole-request timer kills healthy >2-min generations mid-stream (pairs with 4.2's end-to-end deadline work). (v) ManusProvider confirmed unreachable dead code — delete it. (vi) 2.3 legacy mentions → pool: its own pass.
> - **2026-07-22 — Plan 19 layer committed (`0475925`).** The intervening sessions' standalone-agent + Kimi work (~4.7k LOC, phases 0–6, 7 review rounds / 46 findings already fixed) had accumulated uncommitted — committed on the Phase −1 rationale. Its ChatViewProvider/BrainstormManager hunks ride the Wave 4 commit (interleaved files). Live-account F5 smoke for the native loop + MCP path still pending.
> - **2026-07-22 — Wave 4 DONE (`2306830`).** 1.2 tree-kill (win32 taskkill /T always; POSIX group-kill; DevServer detached + tree stop; visual tests stop servers they started, REUSE user servers, liveness-correct isRunning), 1.3 Stop reachability (cancelPanel registries × 4 CVP sites; -retryN/-followup cancel coverage; follow-up deadline; approved-write terminal retry — normalized across -followup and scoped per-dispatch), 4.2 inactivity watchdog on BOTH stream paths (review-redesigned: 30-min bound / 4h autonomous, stderr resets, SIGTERM-first — the 5-min SIGKILL first cut would have killed quiet long tools; the first cut also missed the persistent path entirely), 4.4–4.8 provider nits (Claude effort clamp + ALL parallel tool_results; Codex turn.failed/exit_code/dead fields; Gemini header key + label guard; auth-test env scrub), Phase 5 brainstorm (error-chunk fallback + synthesis silence-timeout + abandoned-child cancel; done-on-error; convergence honest AND stability-required for converged — round-1 agreement-keyword exits rejected in review; delphi stride-2 + stalled; interleaver hardening), Phase 6 canvas (CSP + file: for disk-opened exports; 0600 linker; Host/Origin gate; ALLOWLIST message guard — blocklist was nested-iframe-bypassable; asset confinement; header keys). Built by 4 parallel implementation agents + inline; 22-agent adversarial review, 12/19 confirmed, all fixed pre-commit. ~90 new tests; suite 2116/2116 + tsc clean.
> - **Wave 4 deferred/accepted:** 6.1 render_page_preview wiring is FEATURE work (no production capturePng/vision bridge exists) — tracked for Plan 05; interleaver's synthesized agent_error chunk carries no agentId (type-legal, renders generic); watchdog does not distinguish a quiet tool from a wedge below 30 min (by design).

---

## Phase −1 — Commit the uncommitted layer (do first, same day)

~11.1k LOC of the highest-value work (coordinator, pool, roles, background jobs, Hermes/Continue/OpenRouter, 40+ test files) exists only in the working tree — one `git clean`/disk failure from loss. It is green and type-clean; committing to the branch is not "landing" it, and every fix below can follow as a normal commit.

- [ ] Commit in logical chunks (suggested): (1) utils + parsers (`effort`, `mentionParser`, `mystiDelegateParser`, `settingsClamp`, `vendorFamily`, `agentMarkdown`); (2) services (`CollaboratorPool`, `CoordinatorModelClient`, `OpenRouterClient`, `MystiLocalTools`, `MystiMemoryStore`, `OrchestratorDag`, `SkillDiscoveryService`); (3) managers (`CollaborationManager`, `BackgroundJobManager`, `MystiOrchestratorManager`, `AgentStudio`, `AgentLoader` edits); (4) providers (Hermes, Continue, OpenRouter + manifest/registry/types edits); (5) ChatViewProvider + webview + package.json; (6) personas/skills/roles content + plans; each chunk with its tests.
- [ ] Re-run `npm test` + `npx tsc --noEmit` after each chunk (they interdepend; if a chunk can't stand alone, squash chunks rather than commit red).

## Phase 0 — Security gates (P0; release-blocking)

### 0.1 Brainstorm permission-gate bypass (review S2, HIGH)
CLIs spawn with permissions bypassed (`ClaudeCodeProvider.ts:502-509` contract: "the stream gate intercepts") but `_handleBrainstormMessage` (`ChatViewProvider.ts:4610-4790`) never calls `_shouldGateToolUse` and `_streamAgentResponse` (`BrainstormManager.ts:869-893`) silently drops `tool_use` chunks. Under `ask-permission`, both agents write files/run bash with zero prompts.
- [ ] **Decision: brainstorm children are analysis-only.** Force `accessLevel: 'read-only'` (and plan-style mode where the provider maps it) in the settings clone at `BrainstormManager.ts:860`. This matches the feature's intent (discussion → synthesis) and closes the hole without building a second gate UI.
- [ ] Surface `tool_use` chunks in the discussion timeline as read-activity lines instead of dropping them (visibility, not approval).
- [ ] Test: agent stream yields a `Write` tool_use → assert the settings clone sent to `sendMessageToProvider` was read-only; assert chunk surfaced not dropped.

### 0.2 Brainstorm Stop orphans a process + session cross-contamination (S1 + S4, HIGH)
Both agents register processes under the same plain `panelId` (last-writer-wins, `BaseCliProvider.ts:1158`); `cancelSession`'s composite-key cancels (`BrainstormManager.ts:1710-1722`) hit nothing (`ProviderManager.ts:108-111` falls back to the default provider and no-ops). Separately, a brainstorm agent that equals the panel's chat provider **resumes the user's main CLI session** (default config guarantees this).
- [ ] One fix for both: pass the composite `${sessionId}-brainstorm-${agent.id}` as the `panelId` into `sendMessageToProvider` (`BrainstormManager.ts:856-864`). Sessions, process registration, and `_panelProviders` then key correctly; the existing composite cancels in `cancelSession` become live; brainstorm stops resuming the user's chat session.
- [ ] Evict composite sessions + `clearPanelContext` on session end and panel dispose (wire the currently-dead `BrainstormManager.clearSession`, `:1727-1730`).
- [ ] Reset composite compaction keys (`${panelId}-brainstorm-*`) in the new-conversation and dispose paths (`ChatViewProvider.ts:1441`, `:4423`, `:9483-9530`).
- [ ] Test (integration, real `ProviderManager`, not the string-recording mock — the existing B9 test enshrines the broken contract): start brainstorm with two agents → cancel → assert **both** providers' `cancelCurrentRequest` fired for their composite panels.

### 0.3 Legacy `@agent` deny is a double no-op (delegation H1, HIGH)
`ChatViewProvider.ts:3390-3410`: on deny, `cancelRequest(panelId)` targets the parent (child runs under `${panelId}-subagent-${agentId}`, `MentionRouter.ts:467`) and `break` exits the `switch`, not the for-await — the denied command runs anyway and the stream continues into the main prompt.
- [ ] Minimal fix now: cancel the **sub-agent** panel id on deny, set an abort flag, and exit the mention loop (labeled break/return).
- [ ] Add the `hasInput` guard the main gate path has (`:3854` vs `:3392`) — stops double-prompting per tool (providers L5).
- [ ] Structural fix (this plan, Phase 2.3): retire the legacy path by routing role-less `@agent` mentions through `CollaboratorPool` with access derived from settings — same UX, inherits SIGSTOP-before-gate, deadline, fencing, disposal.
- [ ] Test: sub-agent emits gated tool → deny → assert child panel cancelled AND no further chunks folded into the main prompt.

### 0.4 Canvas: second ungated dev-server start (canvas M1)
`CanvasManager.renderPage` → `devServerManager.start(...)` (`CanvasManager.ts:2606`) auto-executes the workspace `package.json` dev script via `spawn(shell:true)` on `/render`, no confirmation. Not model-arbitrary, but a hostile repo's `"dev"` script runs unprompted.
- [ ] Route through the existing `_confirmModelDevServerCommand` modal (default-DENY, shows exact command), with a per-workspace "remember approval" so `/render` isn't nagged every time.
- [ ] Test: renderPage with no prior approval → no spawn until confirm resolves true.

## Phase 1 — Process lifecycle & leaks (P1)

### 1.1 `disposeRun` leak on collab + orchestrate paths (delegation H2, HIGH)
`CollaboratorPool._runChildProviders` entries are only reclaimed by `disposeRun`, whose sole caller is the coordinator finally (`ChatViewProvider.ts:7327`). Every `@hermes:critic` run leaks a live `hermes acp` process until reload.
- [ ] `pool.disposeRun(runId)` in `CollaborationManager.run`'s finally.
- [ ] Same per-run in `MystiOrchestratorManager.run` (frontier run-ids `runId-f{i}` — either loop them or teach `disposeRun` a prefix match).
- [ ] Test: after a CollaborationManager run with a persistent-process provider, assert `disposePersistentProcessForProvider` fired for the child panel.

### 1.2 Kill trees, not pids (providers M4 + canvas M2)
`killProcessTree` (`processKill.ts:110-177`) signals one pid; on Windows every spawn is `shell:true` so the tracked process is cmd.exe — cancel orphans the real CLI. `DevServerManager.stop` (`:222-227`) has the same bug and headless visual tests deliberately never stop the server (`VisualTestManager.ts:335`).
- [ ] POSIX: spawn detached where safe + `process.kill(-pid)`; Windows: `taskkill /PID <pid> /T /F`. Apply in `processKill.ts` (flag-gated per call site) and `DevServerManager`.
- [ ] Headless visual-test path: stop the dev server it started on completion (it knows whether it started it), or post a "dev server still running — Stop?" notification with a real affordance.

### 1.3 Stop reachability for delegation children (delegation M1)
- [ ] Cancel handler (`ChatViewProvider.ts:1101-1118`): fan out to `-collab-` children (wire the zero-caller `CollaborationManager.cancelRun` + `MystiOrchestratorManager.cancelRun`).
- [ ] `MentionRouter.cancelSubAgents` (`:205-210`): include `-retry1`/`-followup` suffixed panels.
- [ ] Pool: wrap `_relayQuestion` follow-up streams in `_withDeadline` (M4a, `CollaboratorPool.ts:661-678`); make "any write occurred" terminal for `_dispatchWithRetry` (M4b — mirrors the agentic reroute's `!result.wrote` rule, `ChatViewProvider.ts:7172`).

## Phase 2 — Retire the Codex spawn fork (providers H1, HIGH)

`CodexProvider.sendMessage` (`CodexProvider.ts:369-456`) re-implements the spawn loop and misses: Windows auto-shell (fresh install → `spawn EINVAL` every request), kill-in-finally (abandoned generator → unreachable live process), early `error` listener (async spawn failure → uncaught host exception), the shell-mode arg gate/quoting (daemon `channelSystemContext` joined unquoted → injection), and it drops `agentConfig`/`attachments` (personas/skills never reach Codex).
- [ ] 2.1 Add the two missing template hooks to `BaseCliProvider._sendSingleShot` (prompt-format + stdin-mode; arg building already exists) so Codex's real differences fit the base path.
- [ ] 2.2 Delete the override. Codex inherits auto-shell, injection gate, early error capture, finally-kill, attachment + agentConfig lifecycle.
- [ ] 2.3 Route legacy `@agent` mentions through the pool (closes 0.3 structurally; the pool header comment already documents this as the intent).
- [ ] 2.4 Audit the other 7 bespoke overrides (cline/copilot/cursor/localai/ollama/openclaw/openrouter) against a checklist of the five base protections — fix outliers or migrate; record per-provider status in this file.
- [ ] Tests: Windows `.cmd` shell path; abandoned-generator kill; `agentConfig` instructions reach the built prompt; shell-mode quoting of `-c` overrides.

## Phase 3 — Mysti coordinator hardening (before merge to main)

All three are 1-to-few-line closures of injection surfaces in the (now-committed) coordinator; land before the branch merges.

- [ ] 3.1 **Project brain out of the system role** (F1): move `_buildMystiProjectBrain` output from the system prompt (`ChatViewProvider.ts:6844-6846`) into the user turn beside the fenced reference block. Repo files must never ride system-role.
- [ ] 3.2 **Fence the orchestrate DAG channels** (F2/M2): nonce-redact + UNTRUSTED-fence dependency outputs (`MystiOrchestratorManager.ts:229-230`) and synthesis inputs (`:368-378`), same discipline as `_fenceDelegateResult`. While there: stop silently dropping failed deps (`:226-227`) — skip dependents of failed nodes or annotate the failure in their prompt.
- [ ] 3.3 **Redact the directive nonce from all fed-back content** (F3): add `.split(delegateNonce).join('[redacted]')` in `_fenceDelegateResult` (`:7779`), `_fenceLocalToolResult` (`:7905`), and `_buildMystiDirectPrompt` segments; strip the live nonce from the scanner's fail-open raw-tag output (`mystiDelegateParser.ts:142-153`).
- [ ] 3.4 **Memory transparency** (F4): `mysti.viewMystiMemory` command (list + delete individual + clear all); fix the settings-description drift ("recorded by Mysti when a backend fails" — host writer was removed).
- [ ] 3.5 **Pool web-request defers to policy** (F5): replace the hardcoded fast-pass (`CollaboratorPool.ts:539`) with `shouldGateToolUse(options.settings, name)` so a delegated WebFetch is gated exactly like direct chat.
- [ ] 3.6 **read-only users get read-only specs** (F6): `access: (reviewOnly || planMode || settings.accessLevel === 'read-only') ? 'read-only' : 'gated-write'` at `ChatViewProvider.ts:7648` — pool hard-deny becomes the enforcement, not per-CLI flags.
- [ ] 3.7 Scanner polish (F7/F8): don't execute directives inside ``` fences (align with the agent-markdown fence-aware invariant); drain post-directive `_buf` remainder after `flush()`.
- [ ] 3.8 Legacy mention fencing (delegation M3): nonce-fence `formatSubAgentContext` (`MentionRouter.ts:166-186`) like `CollaboratorPool`'s — moot once 2.3 lands, do whichever ships first.

## Phase 4 — Provider correctness (P2)

- [ ] 4.1 **`effortLevel` joins the persistent-respawn snapshot** (M2 — same bug class as the #39 custom-model fix): `BaseCliProvider.ts:676-682`, `_persistentSettingsMatch` `:840-848`. Test: flip effort mid-session → respawn.
- [ ] 4.2 **End-to-end stream deadline** (M1): the 5-min/4-hr timeouts only bound the post-stdout window (`BaseCliProvider.ts:1268-1305`). Add an inactivity watchdog around stdout iteration (yield-resetting timer, like the brainstorm silence timer) so a wedged-but-open CLI can't spin forever.
- [ ] 4.3 **Gemini read-only/plan → `--approval-mode plan`**, not `--sandbox` (M3, verified against gemini 0.28.2 help; `GeminiProvider.ts:309-312`).
- [ ] 4.4 `clampEffort` on the Claude path too (L1 — parity with Codex; bad settings value degrades instead of hard CLI error).
- [ ] 4.5 Claude `parseStreamLine`: yield **all** `tool_result` blocks, not the first (L2, `ClaudeCodeProvider.ts:789-802`).
- [ ] 4.6 Codex stream nits (L3): stringify `turn.failed` error objects; `exit_code === undefined` ≠ failed. Delete dead instance fields (L4, `:69-80`).
- [ ] 4.7 Gemini: `x-goog-api-key` header instead of key-in-query for `discoverModels` (L7); account-label `[object Object]` guard.
- [ ] 4.8 Test hygiene (L6): scrub `GOOGLE_API_KEY`/Vertex env in `codexGeminiAuth.test.ts` beforeEach.
- [ ] 4.9 **F5 smoke gate:** live-verify Gemini `--resume <uuid>` against the CLI contract (M5 — help documents "latest"/index; UUID unconfirmed). If wrong, map session resume accordingly.

## Phase 5 — Brainstorm correctness (P2)

- [ ] 5.1 **Error-chunk-aware synthesis fallback** (S3): `_runSynthesisPhase` treats a streamed `{type:'error'}` (or empty text after done) as failure → existing fallback chain fires. Wrap synthesis in `_iterateWithSilenceTimeout` like every other stream (`BrainstormManager.ts:986`).
- [ ] 5.2 Emit `done` on the error-exit path (S6, `:302-308`) so the webview always gets `brainstormComplete`.
- [ ] 5.3 Convergence honesty (S5): assess convergence on the final round too (the `round < maxDiscussionRounds` gate makes `converged` unreachable at default 2); fix delphi's cross-role stability comparison (compare same-agent refinement rounds only); have delphi honor `stalled` like debate. If not fixed this pass, label the UI meter "heuristic" — don't render defaults as measurements.
- [ ] 5.4 Interleaver hardening: `.catch` on child `next()` promises → convert to `agent_error` chunk (one escaped rejection currently kills the whole interleave); `try/finally` to `return()` children when the consumer breaks.
- [ ] Tests: error-chunk synthesis fallback; interleaver (fairness, one-child-rejects, consumer-break closure); tool_use surfacing (0.1).

## Phase 6 — Canvas polish (P2/P3)

- [ ] 6.1 Wire `render_page_preview` (finding 3 — built, tested, unreachable): pass the `renderPagePreview` hook when constructing `CanvasToolServer` (`ChatViewProvider.ts:6573`), or explicitly mark deferred in Plan 05.
- [ ] 6.2 Consolidate the srcdoc builder (TS `CanvasSandbox.buildPageDocument` ⇄ JS `buildPageSrcdoc` already diverge on CSP); add CSP meta to exported bundle pages.
- [ ] 6.3 Session-linker file: write to `context.storageUri` or chmod `0600` (bearer token currently world-readable in shared tmp, `CanvasSessionLinker.ts:62-63`). Add host/origin validation on `CanvasMcpHttpServer` defensively.
- [ ] 6.4 `canvas.js` message listener: `source`/`origin` guard (`:247`). Guard `ArtifactStore.resolveAssetPath` traversal before it's ever wired (`:324`).
- [ ] 6.5 Gemini image key → header (same as 4.7, `ImageGenerationService.ts:120, :347`).

## Phase 7 — PR #37 (MiniMax)

**Do not merge now** despite MERGEABLE: incomplete even for main (zero webview wiring — provider unselectable), `minimaxBaseUrl` lacks `"scope":"machine"` (workspace `.vscode/settings.json` can redirect the `MINIMAX_API_KEY` + full prompt to any host), and it fails `tsc` 5 ways after this branch lands (missing `PROVIDER_DISPLAY_META`, `PROVIDER_CUSTOM_MODEL_SETTING_KEYS`, `AGENT_BRAINSTORM_ICONS`, `agentKeyMap` entries + 7 now-required capability fields).
- [ ] Post a review comment: thanks + findings + "will conflict with the in-flight 0.5.0 branch; please rebase after it lands" + the 10-step checklist link.
- [ ] After the branch merges: rebase in-house if the contributor is unresponsive. Merge-blocking: manifest/map entries + capability matrix; webview assets/menu/wizard/`LOGO_BY_ICON_PATH`/`PROVIDER_IDS`/`_getProviderDisplayName` + 3 test enumerations; `"scope":"machine"` on `minimaxBaseUrl`. Should-ride: `_getEffectiveModel` precedence, `stream_options.include_usage`, real auth probe (`GET /models`), verify M2.7 ids + context window (1M unverified — poisons compaction math), one SSE-parse test.

## Phase 8 — Structural (post-release, gated)

- [ ] 8.1 Extract `MystiAgenticRunner` from ChatViewProvider (now 10,266 lines; the ~1,200-line coordinator subsystem is testable only by monkey-patching privates — the verify/cross-review/reroute/finalize branches have zero coverage because of this).
- [ ] 8.2 `routedModel`/custom-model precedence as a base template method (`_getEffectiveModel` + overridable `_getCustomModel()`) — kills the 11-way hand-duplication the routedModel test itself calls fragile.
- [ ] 8.3 Known backlog unchanged from the 2026-07-05 review: ChatViewProvider options-object ctor (22 positional args), lint red (193 `no-explicit-any`), DOMPurify (F5-gated).

---

## Execution order

```
Day 0:   Phase −1 (commit the layer)                        ← loss-risk elimination
Wave 1:  Phase 0 (0.1–0.4) + 1.1                            ← release-blocking security + worst leak
Wave 2:  Phase 3 (coordinator hardening) + 4.1              ← before merge to main
Wave 3:  Phase 2 (Codex/base unification, includes 0.3 structural close via 2.3)
Wave 4:  Phases 1.2–1.3, 4.2–4.8, 5, 6                      ← parallelizable, independent
Gate:    4.9 Gemini resume + the standing F5 smoke gates
Release: merge feature/visual-testing → main → v0.5.0
Then:    Phase 7 (PR #37 rebase), Phase 8
```

Rules: every fix ships with the test named in its section (the review showed the existing suites validate the wrong layer in exactly the broken spots — B9 cancel, throw-only synthesis fallback). Suite + `tsc` green before and after every wave. No fix reintroduces a model→shell path without a default-DENY gate (standing invariant from 87960fd).
