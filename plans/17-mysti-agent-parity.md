# Plan 17 — Mysti Agent Parity: Review & Roadmap

> ## Implementation status (updated 2026-07-12)
>
> **FULL 8-DIMENSION REVIEW + FIX PASS (2026-07-12, 1824 tests green):** a workflow of 8 dimension reviewers (security, loop-correctness, concurrency/lifecycle, provider-routing, coordinator-client, webview, config, tests), each finding 3-lens adversarially verified, surfaced **43 confirmed defects** across the Mysti-agent surface — ALL fixed. Highlights: **HIGH** — a workspace `.vscode/settings.json` could set `mysti.permission.timeoutBehavior:auto-accept`+`timeout:1` to auto-approve delegation writes (now machine-scoped, review[0]); **MED** — cross-review broke user/user alternation (now merged), no reserved finalize turn (full-budget runs returned a placeholder — now a finalize stream), a superseded zombie posted `requestCancelled` into the successor's live UI (now owns()-gated), errors discarded the whole run incl. write-delegation cards (now persists a partial), tab-dispose leaked a frozen gated child (now aborts), a multi-window stall could destroy a live job's result (now an executing-veto in sweep/merge), reasoning-only length-exhaustion returned a placeholder, 5 backends silently dropped tier routing, 5 provider auth false-positives, an idle-watchdog replaced the hard 5-min stream cap, and 6 webview state-lifecycle bugs (job-card destroyed on convo switch → now notifies; sub-agent trace cards duplicated/spinning → now upsert; coordinator reasoning lost on reload → now replays). Security invariants re-verified by direct reading (nonce redaction on every untrusted channel; `dm_` key `*.deepmyst.com`-only; no ungated model→shell). 13 regression tests added (loop integration, routedModel precedence, panel-gone gate, remember parser, merge/executing, clamp floor). **The security REVIEW dimension itself could not complete (a monthly spend limit failed its agents mid-run); it was performed inline instead — no invariant violation found.**
>
> **SELF-REVIEW of the fix batch (2026-07-12) → 4 more fixed:** a 3-agent adversarial re-review of the 43 fixes caught 2 MED regressions I'd introduced + 1 LOW drift + 1 reachable pre-existing XSS. (1) the new finalize turn pushed a 2nd consecutive `user` message (in its exact trigger scenario `messages` always ends user) — would 400 strict-alternation backends and defeat its own rescue; now APPENDS to the last user turn. (2) the new `interrupted` away-notification false-fired for another live window's still-running job after a machine sleep (it self-heals via the executing-veto but the toast already told the user to re-run → double-spend risk); now DEFERRED with a grace re-check that only warns if the record is still interrupted. (3) reroute/stop delegate cards dropped the tier badge on persist; now carried. (4) a reachable attribute-breakout XSS — a prompt-injected coordinator DAG `node.id` in `data-node="…"` — because a weaker duplicate `escapeHtml` (no quote-escaping) shadowed the attribute-safe one for the whole webview scope; deleted the duplicate so the strong definition is sole. 1824 tests still green.
>
> **DONE + reviewed + verified** (BUILD_STAMP `plan17-p2-differentiators+p1.5-hardening`, 1811 tests green):
> - **P0** (all 8 items) — local read tools (read/ls/grep/diag), un-handicapped delegations, live traces, context hygiene, governors, project brain, security-floor pulls, cost receipts. **Two adversarial review passes; 22 + 8 findings all fixed.**
> - **P1.2** verification loop · **P1.3** plan mode (reviewed sound + 3 nits fixed).
> - **P1.4a** coordinator-model command picker (`mysti.setCoordinatorModel`).
> - **P1.5** background-job durability (globalState persist, rehydrate running→interrupted, survive panel dispose, away-notifications, concurrency cap).
> - **P2.1** cross-vendor review · **P2.2** resilience reroute · **P2.3** model-tier routing (`tier="fast|strong"`) · **P2.5** unified cross-backend memory (`<remember:>` + host-writes).
> - **Final P1/P2 adversarial review COMPLETE + fixed** (6 confirmed): tier routing defeated by per-provider custom-model → new `Settings.routedModel` wins in every `_getEffectiveModel`; bg-job write-gate deadlock on tab dispose → `requestPermissionInline` auto-denies when the owning panel is gone + dispose cancels surviving jobs' pending gates; multi-window `globalState` clobber → per-host `hostId`+`heartbeat`, monotonic ownership-aware `_mergeJob` (never resurrects a finalized job, `reported` flag monotonic), host-scoped `runningCount`, `sweep()` GC timer; reroute memory pollution removed; reroute budget +1 over-run guarded; unknown `tier` degrades to default routing instead of voiding the tag. **A focused re-review of these fixes found 3 further regressions in the multi-window store (cross-window cap blocking, repeated away-notification, claimed-job resurrection) — all fixed + tested.**
>
> **DEFERRED (with reasons):**
> - **P1.1 parallel WRITE fan-out** — coupled to the P3 worktree-isolation floor; concurrent write-delegations collide without it ("don't raise autonomy before the floor", §5). A read-only parallel-investigation subset is safe and can land first.
> - **P1.4b native function-calling** — needs a live DeepMyst-gateway tool-calling smoke test (can't run autonomously); the nonce text-tag protocol is the reliable fallback.
> - **P2.4 agent-initiated orchestration** — the `orchestrate:` prefix works; auto-escalation needs the DAG path (`_runMystiOrchestration`) hardened first.
> - **P3** full gate chokepoint + worktree isolation + global process governor + best-of-N — the largest infra (Plan 10 substrate); the security-floor *pulls* (auto-memory fence, workspace-settings clamp) already landed in P0.7.

> **Provenance:** Produced 2026-07-11 by a 10-agent review workflow (6 subsystem maps with file:line evidence, 3 parity benchmarks vs Claude Code / Cursor / Codex / Cline / OpenCode / Gemini CLI + coordinator-differentiator analysis, 1 architect synthesis), on top of the Plan 15/16 implementation as of BUILD_STAMP `plan16-all-provider-auth-detection-fixed`. Numbering note: "Plan 16" (universal effort, CC pass-through, Mysti agentic default, `bg:` jobs, DeepMyst-gateway coordinator) was implemented directly without a plan file; this document is the next step.
>
> **Goal (user):** make the Mysti agent *extremely powerful, capable, and on par with other popular coding agents* — then beyond them, using what only a coordinator of 14 backends can do.
>
> **Benchmark headline:** of the capability checklist derived from Claude Code + competitors, the Mysti agent scores **12 hard "no"s** today — direct file tools, bash, repo search, web search, LSP diagnostics, hooks, workflow scripts, semantic repo understanding, best-of-N, unified memory among them. Almost all are addressable by wiring existing components (see P0).

**Thesis:** The Mysti agent's plumbing is better than its power. It has best-in-class safety architecture (unforgeable nonce control channel, SIGSTOP pre-execution gating, fenced untrusted data in both directions, scoped cancellation) wrapped around a coordinator that is blind, amnesiac, throttled, and delegates to deliberately handicapped versions of the very backends it fronts. Nothing capping its power today requires new infrastructure — the render components, the pool primitives, the context managers, and the persistence layer all already exist and are simply not wired to the Mysti path. The branch at `ChatViewProvider.ts:3100-3147` bypasses almost everything the extension does well.

---

## 1. STATE OF THE AGENT — Honest Scorecard

- **WORKS — Security architecture is genuinely best-in-class.** Per-run nonce delegate protocol that fails open to visible text (`mystiDelegateParser.ts:48-139`), fenced UNTRUSTED blocks both directions with nonce redaction (`_fenceDelegateResult` 7064-7081), SIGSTOP pre-execution gate that fails closed (`CollaboratorPool.ts:474-548`), ownerKey-scoped gate cancellation so fg Stop never kills a bg job's gate. No competitor has a documented equivalent for cross-agent delegation. Treat as an invariant.
- **WORKS — Model resilience.** Free-chain rotation with a correct hard-stop allowlist (401/402/403/content-policy/context-length stop; 429/5xx/transport advance, only before text streams — `CoordinatorModelClient.ts:203-283`), resolved-model attribution persisted per message.
- **WORKS — Delegation reliability contract.** Availability pre-checks with install/auth hints, per-pull deadline racing, 1 transport retry with fresh child, question relay, transport-signal completion (`CollaboratorPool.ts:97-465`). The pool is the load-bearing primitive nearly every roadmap item builds on.
- **WORKS — Checkpoints/rewind cover Mysti turns** (`_captureCheckpoint` at 3074 precedes the mysti branch at 3100) and delegation-card persistence/replay is pixel-identical via `mystiSegments` (6698-6703, chat.js:8307-8345).
- **WEAK — The coordinator is toolless.** Zero read/grep/ls/web/diagnostics; the system prompt says so explicitly (7052). Every fact about the repo costs a full CLI cold-start delegation. This is the single biggest power cap.
- **WEAK — The coordinator is amnesiac.** Context = last 4 messages × 400 chars (7099-7105); prior delegation outputs never folded in; delegate results fed back untruncated so one verbose sub-agent kills the run via the non-retryable context-length stop (`CoordinatorModelClient.ts:279`). None of SmartCompactor/RetrievalCoordinator/ProjectContextManager touches the Mysti path.
- **WEAK — Delegations are handicapped backends.** Context-starved (`_collectContext` stub returns `[]`, `CollaboratorPool.ts:662-667`; `conversation:null`), model-downgraded to the curated default (280), over-gated regardless of the user's access level (474-548 never consults `shouldGateToolUse`), auto-denied on Windows, cold-started every time. A delegated claude-code is a blindfolded, default-model, prompt-per-write, amnesiac version of the tool the user could run directly.
- **WEAK — Black-box UX.** `_runMystiDelegation` drops `collab_tool_use/tool_result/thinking/retry` (7016-7032); the delegate card header is blank (no `formatToolSummary` case); up to 1h of static spinner. Ironically the non-default `orchestrate:` path already renders all of this (chat.js:6704-6898).
- **WEAK — Structurally shallow.** 4 sequential delegations / 8 turns / 4096 tokens per turn, hardcoded (6611-6613, 6750); failed dispatches still charged; a last-turn delegation's result never reaches the answer; scanner aborts on the FIRST directive (6759) so no fan-out; no plan/todo state; plan modes silently ignored (return at 3145).
- **WEAK — Durability is session-deep.** `bg:` jobs are in-memory (`BackgroundJobManager.ts:18-21`), killed on panel dispose (8629-8630 — the opposite of Plan 10 P2.4), job cards die on webview reload, the `requestJobs` channel has no sender (dead wiring), no notifications, no cost accounting anywhere on the path that matters.

---

## 2. THE GAP — The Capability Gaps That Cap Its Power

Ranked by impact on perceived power.

**G1. No hands, no eyes: the toolless coordinator.**
Evidence: `_mystiAgenticSystemPrompt` hardcodes "NO direct access to the file system" (ChatViewProvider.ts:7052); no local tool handling exists in `_runMystiAgentic` (6624-6881); zero uses of `vscode.languages.getDiagnostics` in src/.
Symptom: "What does `parseStreamLine` do?" spawns a full claude-code process, waits seconds-to-minutes, and burns 1 of 4 delegation slots. Claude Code answers in under a second. Users conclude the agent is slow and dumb before it ever delegates real work.

**G2. Amnesia at every timescale.**
Evidence: `_buildMystiDirectPrompt` folds 4 messages × 400 chars (7099-7105); persisted `mystiToolCalls` from the prior turn never re-enter context; delegate results fed back untruncated (6820, 7069-7071); context-length is a deliberate hard stop (`CoordinatorModelClient.ts:279`); no compaction hook (the branch returns at 3146 before all compaction bookkeeping at 3504+).
Symptom: "Now fix what you found" re-delegates discovery from scratch; a verbose delegate (claude-code dumping a diff) errors the entire run mid-task with no recovery.

**G3. Delegation boundary loss: the sub-agent gets a task string and nothing else.**
Evidence: `conversation:null` + empty context (7009-7014; `CollaboratorPool.ts:662-667`); user's model choice discarded for the curated default (280 + `ModelRegistryService.ts:221-224`); every write gated regardless of `accessLevel` with a 30s auto-reject (474-548, `PermissionManager.ts:51-52`); Windows auto-denies all writes (`BaseCliProvider.ts:367-370` + fail-closed at 514-524); unique child panel per delegation means no `--resume` continuity (6805, 644-647); briefs authored by a free model from a 1.6KB window within a 4096-token turn.
Symptom: An Opus user delegates a refactor and gets a default-model sub-agent that re-explores the repo from zero, prompts on every write, dies "denied" if the user walks away — and delegation 2 remembers nothing of delegation 1.

**G4. The default loop cannot execute a real feature workflow.**
Evidence: governors at 6611-6613 (4 delegations, 8 turns) and 6750 (4096 tokens/turn), not settings-backed, not effort-scaled; unconditional `delegations++` even on not-installed failures (6806); turn-cap starvation (a turn-7 delegation's result is appended after the loop exits at 6738); first-directive abort (6759) forces strict sequentiality despite `CollaboratorPool.dispatch` accepting a spec array with `maxConcurrent` up to 8; no plan/todo state of any kind.
Symptom: explore → plan → edit → test → fix exceeds the budget structurally. Claude Code does 20+ tool calls; Mysti gets 4 cold-start specialist calls and no reserved turn to even summarize the last one.

**G5. Black-box delegation UX.**
Evidence: the consumption loop handles only `collab_text/complete/skipped/error` (7016-7033) while the pool already emits `collab_tool_use/tool_result/thinking/retry` (`CollaboratorPool.ts:345,353,621,271`); `formatToolSummary` has no `delegate` case so the card header is blank (chat.js:8670-8674); the permission gate for a delegated edit shows a 500-char raw JSON slice instead of a diff (6986); thinking never persisted (6866-6874 passes `thinking=undefined`).
Symptom: up to an hour staring at "delegate · running" with zero visibility, then approving file edits you literally cannot see. Direct backend use streams everything; this is the #1 "feels less capable" driver.

**G6. No verification loop, no plan gate.**
Evidence: the mysti branch returns at 3145 before OperationMode/PlanOptionManager handling; no post-delegation test-run or diagnostics check exists; ProjectContextManager's discovered build/test commands (and MYSTI.md/.mysti/rules) are injected only into backend sends (~3504-3510), never into the coordinator prompt (7046-7061).
Symptom: the agent hands back unverified diffs and plans blind to the project's conventions — the exact opposite of what 2026 reviews rank as the #1 differentiator ("verification is the bottleneck").

**G7. Brain ceiling: free models, text-tag only, silent truncation, invisible cost.**
Evidence: no `tools` param ever sent (`DeepMystGatewayClient.ts:176-183`); `finish_reason` ignored so max_tokens cuts answers and can sever a half-emitted tag (254-278); 120s TOTAL stream timeout (166, 332-339); `X-DeepMyst-Cost-USD` read only on the non-streaming path (131); chain restarts at models[0] every turn; no UI path to a strong paid coordinator despite the pinning plumbing fully working (`extension.ts:238-241`).
Symptom: protocol reliability rests on gpt-oss-120b:free reproducing an exact nonce tag (the code itself documents failures, `CoordinatorModelClient.ts:54`); answers stop mid-sentence; slow free models get killed mid-stream with the partial text discarded; paid-model users spend credits invisibly.

**G8. Durability cliff.**
Evidence: in-memory job map (`BackgroundJobManager.ts:44`), panel dispose aborts running jobs (8621-8630), `requestJobs` has no sender, no notifications, `bg: orchestrate:` silently degrades to the sequential loop (3105 vs 3122).
Symptom: a 30-minute background refactor dies silently on Reload Window or tab close; a finished job in a hidden panel is invisible forever. "Background" means "as long as this tab stays open."

---

## 3. ROADMAP

Sequencing logic: P0 makes the existing loop feel like a real agent (all wiring, no new infra). P1 buys parity on the loud benchmark items. P2 builds what only a coordinator can do. P3 is the plans/10-12 substrate. Security invariants (nonce discipline, gate chokepoint, no ungated model→shell) are preserved at every step and two floor items are pulled forward deliberately.

### P0 — Wake the agent up (no new infra; all designs reuse shipped components)

**P0.1 Local read-only tools for the coordinator — `<read:>`, `<ls:>`, `<grep:>`, `<diag:>`.** *(M — the highest-leverage change in this plan)*
Extend the nonce grammar in `mystiDelegateParser.ts` with three read-only directives sharing the delegate tag's exact discipline (per-run nonce required, fail-open, partial-marker holdback). Handle them directly in `_runMystiAgentic` — no CLI spawn: `read` via `vscode.workspace.fs` (workspace-scoped, symlink/`..` traversal rejected, size-capped head+tail), `grep` via ripgrep or the workspace search API, `diag` via `vscode.languages.getDiagnostics()` (free ground truth no CLI competitor has). Results come back nonce-fenced UNTRUSTED like delegate results; render as compact tool cards recorded into `mystiSegments`. Local reads do NOT count against the delegation budget (cap them separately, e.g. 20/run). Update `_mystiAgenticSystemPrompt`: "read/grep/ls yourself; delegate only mutations and heavy work."
Files: `mystiDelegateParser.ts`, `ChatViewProvider.ts` (loop + prompt), chat.js (`formatToolSummary` cases).
Security: read-only, workspace-fenced, no shell, results fenced — consistent with the pool's read fast-path precedent (`CollaboratorPool.ts:487` already passes reads free). Explicitly NO write/bash local tools (see §5).

**P0.2 Un-handicap delegations (bundle of five one-liners-to-small-changes).** *(S each, M total)*
(a) Fold enabled ContextItems (paths + content, capped) into `spec.prompt` at 6998 — `_collectContext` is a deliberate stub; the caller was always expected to do this. (b) Honor the user's model: `spec.model = settings.provider===agentId ? settings.model : undefined` at 6994-7000. (c) Honor `accessLevel` in `onGate` (6984-6992): short-circuit approve on `full-access` / route through `shouldGateToolUse(settings, toolName)` — kills the every-write-prompt + 30s-auto-reject death spiral. (d) Override plan modes to `edit-automatically` in the child settings (CollaboratorPool.ts:277-284) so a plan-mode user doesn't get silent plan-only sub-agents. (e) Session continuity: key the child panel on `(cancelKey, agentId)` and skip teardown between delegations so delegation N+1 hits the backend's own `--resume` machinery.
Files: `ChatViewProvider.ts`, `CollaboratorPool.ts`.
Security: (c) narrows gating only to the level the user already granted for direct use — no new authority; (e) keeps children inside the pool's cancel fan-out.

**P0.3 Live delegation trace + legible cards.** *(S — pure wiring)*
Forward `collab_thinking/tool_use/tool_result/retry` in the 7016-7033 loop, nested under the delegate card via the already-shipped `mystiNodeToolUse` components (chat.js:6859-6898). Add a `delegate` case to `formatToolSummary` (`agent + ': ' + task.slice(0,60)`) and stamp the backend logo. Record nested activity into `mystiSegments` so restore parity is preserved. Persist thinking (push into segments + pass as arg 6 of `addMessageToConversation`).
Files: `ChatViewProvider.ts:7016-7033`, chat.js.
Risk: none — data already emitted and dropped.

**P0.4 Context hygiene.** *(S)*
Clamp fenced delegate results head+tail (~12KB) before `messages.push` at 6820 (full text stays on the tool card) — eliminates the context-length run-killer. Widen `_buildMystiDirectPrompt` to ~10 messages × 2000 chars and fold a compact "Previous delegations" digest from the last assistant message's persisted `mystiToolCalls` — restores cross-turn continuity.
Files: `ChatViewProvider.ts:7064-7119`.

**P0.5 Governor + stream fixes.** *(S)*
Settings-backed, effort-scaled caps: `mysti.mysti.maxDelegations` default **4** (→ 8 at high effort) and `mysti.mysti.maxTurns` default **24** (→ 48 at high effort); both machine-scoped (review[0]/[18]) so a workspace cannot raise the per-run spend ceiling. Stop charging budget for not-installed/unknown-agent failures. Reserve a finalize turn so the last delegation's output always reaches the answer (a full-budget run now spends one final no-tools stream — review[2]). Handle `finish_reason==='length'` with an auto-continue turn, incl. reasoning-only exhaustion (review[12]). Sticky chain index per run (also honored by `complete()`, review[31]). Stream timeout is an idle/inter-chunk watchdog, not a hard total cap (review[11]).
Files: `ChatViewProvider.ts`, `DeepMystGatewayClient.ts:254-278`, `CoordinatorModelClient.ts`.

**P0.6 Give the coordinator the project's brain.** *(S — near one-liners with outsized effect)*
Inject MYSTI.md + `.mysti/rules` + the ProjectContextManager workspace scan (build/test commands!) into `_mystiAgenticSystemPrompt` — it is injected into backend sends at ~3504-3510 and simply omitted at 7046. Add a current-diagnostics summary line. Every delegation brief immediately gets smarter.
Security: project files are semi-trusted; fence them like the conversation history already is in `_buildMystiDirectPrompt` (7088-7119). Do NOT put auto-memory raw in the system prefix — see P0.7.

**P0.7 Two security-floor pulls (cheap, unblocks later autonomy).** *(S)*
(a) Fence auto-memory/MEMORY.md content at 3513-3521 with the existing nonce-fence pattern (Plan 10 Part 1 step 5) — closes a live injection vector. (b) Workspace-settings clamp via `inspect()` taking the more-restrictive of user vs workspace for mode/accessLevel/safetyMode (Plan 10 step 4).
Files: `ChatViewProvider.ts`, one shared settings getter + regression test.

**P0.8 Cost visibility.** *(S)*
Read `X-DeepMyst-Cost-USD` in `streamChat` (header available at `DeepMystGatewayClient.ts:191`), yield as a cost event, sum next to `usageTotal`, render `$0.0012` in the footer + a "3 delegations" pill. Prerequisite for P1.4 and every P2 economics story; also the `spent` ledger surgery seed (Plan 09 Phase A step 6).

### P1 — Parity (the loud benchmark items)

**P1.1 Parallel fan-out in the default loop.** *(M)*
Let the DelegateScanner collect ALL complete directives in a turn (it already parses incrementally), dispatch them as one spec array through `CollaboratorPool.dispatch` with `maxConcurrent` from `mysti.collab.maxConcurrent` — pool, gating, per-child panels, and bounded merge all already support it (CollaboratorPool.ts:97-198). One card each, all fenced results in one feedback message.
Risk: concurrent gated-write children colliding on files — v1 rule in the system prompt: parallel directives must declare disjoint scopes, else run parallel children read-only (propose-then-apply). Ship behind a setting until worktree isolation exists (P3).
Files: `mystiDelegateParser.ts`, `_runMystiDelegation`.

> **READY-TO-BUILD — read-only `investigate` subset (safe now, no worktree floor needed).** *(the sanctioned next feature; ~1 focused session + adversarial review)*
>
> Deliberately AVOID touching the streaming scanner / length-continue state machine (it surfaces one directive/turn and is delicate — carry, fail-open, per-kind branches). Instead add ONE new inherently-read-only, inherently-batch directive, exactly like `remember`/`read` were added:
>
> - **Protocol:** `<investigate:NONCE>` whose body is a newline- or `---`-separated list of self-contained read-only sub-tasks (cap width at e.g. 4). Parser: add `kind:'investigate'` to `mystiDelegateParser.ts` (regex + `_parse`, mirror the `remember` shape; each line trimmed, empties dropped, `null` if <1 task). Nonce-fenced, fail-open — same invariant as every other tag.
> - **System prompt:** one paragraph — "to investigate the repo from multiple angles at once (not to edit), emit a single `<investigate:>` block, one sub-question per line; I run them in parallel and return all findings." Keep single `<delegate:>` for anything that writes. No new mode/prefix.
> - **Dispatch:** a NEW `_runMystiInvestigation(tasks, …)` that builds N `CollaboratorSpec`s with `access:'read-only'` (pool hard-denies writes → no file collision → no worktree needed) and does ONE `pool.dispatch(specs, {maxConcurrent})`. Do NOT loop `_runMystiDelegation` N times — see hazard.
> - **⚠️ CONCURRENCY HAZARD (code-verified):** `_runMystiDelegation` sets `_mystiActiveDelegationRuns.set(cancelKey, runId)` — keyed by cancelKey, ONE active run per panel/job. Running it N× concurrently makes the siblings clobber each other's entry, so a Stop tears down only the last. Fix: the investigate path registers ONE runId under cancelKey (a single `pool.dispatch` with all specs already gives one run to cancel), and `_abortMystiDirect` → `cancelRun(runId)` + `cancelRequestsByOwner(cancelKey)` covers the whole batch. Verify no per-spec `_mystiActiveDelegationRuns` writes race.
> - **Budget/UI:** each sub-task counts 1 against `gov.maxDelegations` (bounded); render N concurrent read-only cards (reuse the delegate-trace card shape, `parentId` per spec); feed all results back as ONE user turn, each fenced UNTRUSTED with the writer label. Off-by-default or `advisory` behind a setting until proven.
> - **Explicitly still deferred:** parallel WRITE fan-out — needs the P3 worktree floor (concurrent gated-write children collide); this subset ships zero write concurrency.
> - **Review after build:** the cancellation/teardown path under concurrency is the thing to adversarially verify (Stop mid-batch, one sibling failing, panel dispose mid-batch → all gates unblocked via the review[4] panel-gone guard).

**P1.2 Verification loop.** *(M — the #1 "feels powerful" driver in 2026 reviews)*
After any delegation that reported write tool_use, the host (not the model) appends a directive-shaped suggestion: run the project's test/build command (already discovered by ProjectContextManager) via a delegation, plus a free `<diag:>` regression check (diagnostics before vs after). Failures feed back fenced; the loop iterates within its (now effort-scaled) budget. Setting: `mysti.agent.verify` (off|suggest|auto).
Security: the test command comes from ProjectContextManager/user config, runs inside a gated delegation — never an ungated model→shell path.

**P1.3 Plan-then-act.** *(M)*
Honor quick-plan/detailed-plan: in those modes the coordinator's first turn must produce a plan surfaced as an approvable card (reuse PlanOptionManager UI, chat.js:4473) before any delegation spends backend tokens. Add a `<plan:NONCE>` scratchpad tag: the loop pins the latest plan block as the second message and renders it via the existing TodoWrite sticky-progress components (chat.js:11414-11474). Gives multi-step state with zero new storage.

**P1.4 Brain upgrades.** *(M)*
(a) Coordinator-quality picker in the UI pinning `mysti.mysti.coordinatorModel` to claude-haiku-4-5/claude-sonnet-4-6 — the plumbing (pinning, failover, attribution, friendly 402) already works end-to-end; this is the cheapest path to a dramatically smarter brain, now safe thanks to P0.8 cost display. (b) Hybrid native function-calling: send `tools:[{delegate},{read},…]` when the model advertises support (OpenRouterClient already tracks `supportsTools`; gateway is litellm/OpenAI-compatible — needs one live smoke test), keep the DelegateScanner as the universal fallback. Structured args, no truncation-into-tag risk, multiple calls per turn.
Security: native tool-calls get forgery-resistance from channel separation; the nonce stays mandatory on the text-tag fallback.

**P1.5 Background durability slice.** *(M)*
The 20% of Plan 10 Part 2 users actually hit: persist jobs to `globalState` with completed-unreported delivery on rehydrate; stop killing jobs on panel dispose (let them finish; conversation write at 6866 already survives); wire the dead `requestJobs` channel + `/jobs` command with card re-render; `vscode.window` notification on complete/error; route `bg: orchestrate:` to a job-card-routed `_runMystiOrchestration`; concurrent-jobs cap + entitlement check before start; fix the O(n²) job-card render.
Files: `BackgroundJobManager.ts`, `ChatViewProvider.ts`, chat.js.

### P2 — Differentiation (coordinator-only capabilities)

**P2.1 Cross-vendor review.** *(M)* Post-write hook: auto-dispatch a read-only reviewer spec on a different-vendor backend (vendor-family map is ~20 lines in ProviderManifest); CollaborationManager already resolves reviewer→`read-only` and the pool hard-denies non-read tools. Setting `mysti.agent.crossReview` (off|advisory|blocking); advisory reviews in background while the answer streams; one review round max under the turn governor.

**P2.2 Resilience reroute.** *(S/M)* Deterministic host-side policy in `_runMystiDelegation`: on failure ∈ {not-installed, not-authenticated, timeout, crashed} (never denied/cancelled), reroute once to the next preferred backend, reusing the `collab_retry` card UX. Gate automatic reroute to tasks with no approved write yet (double-apply risk).

**P2.3 Model-tier routing.** *(M)* Optional `model="fast|strong"` attribute on the delegate tag — coarse tiers only, validated against the ModelRegistryService snapshot, mapped tier→concrete model per backend; card displays the resolved model. Keep the orchestrator backend-only (per-call routing thrashes persistent-process respawn — the documented Plan 11 constraint). Escalation ladder (cheap-first, escalate on verifier failure) only after P1.2 provides the verifier and P0.8 the meter.

**P2.4 Agent-initiated orchestration + ready-set DAG.** *(M)* Teach the coordinator one more directive (or a brief-complexity heuristic) to escalate into `MystiOrchestratorManager.run` itself — the parallel DAG stops hiding behind a magic prefix. Replace frontier-barrier scheduling with dispatch-when-deps-settle (~60 lines, pool unchanged); persist orchestrate runs with segments/toolCalls; dismiss orchestrate gates on Stop (call `cancelRequestsByOwner(panelId)` unconditionally in `_abortMystiDirect`).

**P2.5 Unified cross-backend memory.** *(M/L)* `MystiMemoryStore` on workspaceState (capped, LRU, TTL/confidence decay copied from MemoryManager): model writes via a nonce-gated `remember:` tag; host writes operational facts (backend failures → feeds P2.2) with no model involvement; injected everywhere as a nonce-fenced UNTRUSTED block — never system prefix (Plan 12 trust rule).

### P3 — Substrate (the plans/10-12 build-out, in order)

1. **Plan 10 Part 1 completion:** panel-independent `evaluateAndGate()` chokepoint — the hard prerequisite for jobs that outlive their panel and any autonomy-default raise. Weigh the ungated web-request pass-through (`CollaboratorPool.ts:490`) as part of this floor.
2. **Plan 10 Part 2 full JobStore:** durable state machine, orphan detection, host-reload reconciliation, kill switch, job-body redaction, per-job spend field (needs P0.8 ledger).
3. **Global child-process governor + worktree isolation** → unlocks unrestricted parallel writes (P1.1) and **fleets** (decompose → N durable jobs, fleet card, batched gates).
4. **Best-of-N race + debate-as-a-tool** (pool-based, not `_interleaveGenerators` — it's uncapped), judge escalated to the paid tier, explicit opt-in with cost card.
5. **Plan 11 D3b resolveRef / D3c skeleton advisor tree; Plan 12 skills/workflows/scheduling** — only after the above; D3c's economics only pay at ≥~240-function scale.

---

## 4. DIFFERENTIATORS — What Only a Coordinator Can Be

The pitch: *single-backend agents are one model with tools; Mysti is a manager of 14 specialists.* Four capabilities no single-vendor agent can structurally match:

1. **Cross-vendor verification (P2.1 + P1.2).** Every competitor's "self-review" is same-model review with correlated blind spots. Anthropic writes, OpenAI reviews the diff, Google arbitrates — cheap (reviewers are read-only, mid-tier), defensible, and the primitives (role→read-only resolution, hard-deny gate, fencing) are already shipped. This is the flagship.
2. **Vendor-outage immunity (P2.2).** "Your task completes even when Anthropic is down" converts 14-backend breadth from a settings checkbox into a reliability guarantee. Deterministic host-side rerouting means it works even when the free coordinator model wouldn't think of it.
3. **Cost-optimal execution with receipts (P0.8 + P2.3).** Free coordinator + strength-routed specialists + a visible ledger ("this turn cost $0.04; all-frontier would have been $0.61") is exactly the architecture Cline power users hand-build — shipped as a default, monetizing cleanly against the DeepMyst gateway's cost header.
4. **Cross-vendor parallel fan-out and best-of-N (P1.1 + P3.4).** Fan-out across separate vendors' rate limits, and genuinely decorrelated best-of-N (temperature diversity within one vendor vs approach diversity across Anthropic/OpenAI/Google). The "Mysti tried 3 approaches and picked this one, here's why" artifact IS the marketing.

---

## 5. WHAT NOT TO DO

- **Do not rebuild a CLI agent inside the extension.** The coordinator gets read-only local tools (P0.1) and nothing more — no local write tool, no local bash. Mutation and execution stay inside gated delegations where SIGSTOP gating, checkpoints, and the permission card apply. The backends ARE the hands; duplicating them means duplicating their entire safety surface (this codebase already ate one RCE — commit 87960fd — from an ungated model→shell path; never reintroduce one).
- **Do not break the nonce/gate discipline.** Every new model-writable channel (read tags, plan tags, remember tags, race/debate attributes) must reuse the delegate-nonce pattern with fail-open parsing, and every result re-entering the model must be nonce-fenced UNTRUSTED. The fencing consistency is an invariant, not a convention.
- **Do not raise autonomy before the floor.** No fleets, no auto-approve widening, no ungated reroute of write tasks until the `evaluateAndGate()` chokepoint, the workspace-settings clamp (P0.7b), and a global process governor exist. Unbounded autonomy on an in-memory job store is how you lose users' work AND their trust in one reload.
- **Do not lift governors without the hygiene fixes.** Raising delegation caps before result clamping (P0.4) and cost metering (P0.8) just makes runs die bigger and spend invisibly. Sequence: hygiene → meters → caps.
- **Do not bet judgment-critical steps on the free chain.** Best-of-N judging, plan synthesis, and escalation decisions should route to the paid tier (haiku fallback / pinned model); free models handle protocol-following and glue. And don't chase per-call model routing inside the orchestrator — the respawn-thrash constraint in its header comment is there for a reason.
- **Do not build an embeddings index or an OS sandbox.** Cursor's index and Codex's Seatbelt are their moats, not yours. Grep + tree-sitter skeletons (D3c, later) + diagnostics cover repo understanding; for sandboxing, route risky work to the Codex backend and inherit its sandbox.
- **Do not add a 15th mode.** No new prefixes or ceremonies (`orchestrate:` is already one too many — P2.4 makes the agent escalate itself). Power should surface inside the default loop, not behind vocabulary users must learn.

---

**Bottom line:** P0 alone — local read tools, un-handicapped delegations, live traces, context hygiene, project-context injection — turns the Mysti agent from a blind dispatcher into something that *feels* like Claude Code within roughly two weeks of wiring work, because every component it needs already exists on an adjacent path. P1 closes the benchmark gaps reviewers actually score (verification, plan gate, parallelism, durability). P2 is where Mysti stops chasing and starts being the only agent that can say: routed by strength, verified across vendors, immune to outages, and it shows you the receipt.