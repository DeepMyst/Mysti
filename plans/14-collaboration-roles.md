# 14 — Agent Collaboration Roles (any agent(s) as advisor / critic / reviewer / coworker / collaborator)

- **Date:** 2026-07-07
- **Status:** Phases 0–2 (+ Phase 4 gate primitive) IMPLEMENTED 2026-07-08 on `feature/visual-testing`; Phase 3 (model-initiated `mysti-consult`) and the collaborator-card webview UI remain (see status note below)

> **Implementation status (2026-07-08).** Shipped end-to-end and green (tsc clean, provider-literal guard clean, full suite 1605/1605 incl. ~48 new tests):
> - **Phase 0 — `CollaboratorPool`** (`src/services/CollaboratorPool.ts`, +19 tests): bounded concurrency (`mysti.collab.maxConcurrent`, default 3), per-child timeout via a deadline-racing wrapper (`_withDeadline` — strictly better than MentionRouter, which hangs on a provider that ignores cancel), transport retry, cached availability pre-check → `CollaboratorFailure` taxonomy, UUID-scoped child panels, cancel fan-out, question relay, and the read-only/gated-write tool gate (SIGSTOP the child, await gate, resume/cancel the **child's own** panel). *Not yet done:* the MentionRouter/BrainstormManager retrofit onto the pool (deferred — pure dedup, no user-facing gain, avoids destabilizing two tested managers; the pool is the shared primitive ready to absorb them, and Plan 11 D3a consumes it as-is).
> - **Phase 1 — roles** (`AgentLoader`/`AgentContextManager`/`AgentStudio`/`agentMarkdown`): new `roles/` kind in the three-tier loader with `access`/`pattern` frontmatter surfaced (`roleAccess`/`rolePattern`), 6 built-in role files, conformance coverage, `mysti.createRole` + command + package.json.
> - **Phase 2 — invocation** (extension-side): `@agent:role` grammar (`src/utils/mentionParser.ts` + `media/chat/chat.js` + webview mirror test), `CollaborationManager` (role→prompt+access, delimited low-trust reference block, role-labeled synthesis), `/consult`·/review`·/critique`·/panel` commands, and the ChatViewProvider send-flow wiring that partitions role-tagged mentions, runs the collaboration, and folds the block into the main agent's prompt. The main agent's synthesized answer renders today; **the per-collaborator live cards are the remaining F5-gated webview piece** (extension already posts `collaborationStarted`/`collaborator`/`collaborationComplete`/`collaborationError` + `composeCollaboration`).
> - **Phase 4 gate primitive** is present in the pool (gated-write + SIGSTOP + `onGate`); the async-jobs/worktree parts of Phase 4 and all of Phase 3 stay gated on Plan 10.
> - **Security note:** the pool's per-child gate is panel-independent and targets the child's own panel — an improvement over the legacy MentionRouter sub-agent gate (which cancels the parent and does not SIGSTOP). Advisory (read-only) roles hard-deny writes locally regardless. On Windows/no-suspend, gated-write now **fails closed** (denies the write) rather than prompting against an unfrozen child.
> - **Adversarial review + hardening (2026-07-08).** A 5-dimension review (concurrency, gate-security, wiring, loader, data-trust) with per-finding verification confirmed 12 defects; all fixed and regression-tested:
>   - *[high]* `_boundedMerge`/`_withDeadline` now propagate `.return()` to abandoned/timed-out child iterators (fire-and-forget) so a collaborator parked at an await on cancel can't resume into an uncancellable orphan process, and a provider that ignores cancel still runs its cleanup finally.
>   - *[high]* delegation tools (`task`/`agent`/…) no longer take the read fast-path in the gate — they route to hard-deny (read-only) or the gate (gated-write), closing the Task/Agent write-bypass.
>   - *[high]* the low-trust reference block and the synthesis block are fenced with an unguessable per-run nonce (content-stripped of the nonce), so a malicious context file / collaborator output can't forge the closing marker or a second `## The request`.
>   - *[high]* a user/workspace-authored role is clamped to read-only (only core/plugin roles may declare `gated-write`), so a cloned repo can't escalate a collaborator's write access.
>   - *[high]* `collaboratorId` is now positional (`${index}-…`) — the old `-${n}` counter could collide with a role id ending in `-<number>`, cross-wiring outputs and clobbering the shared child panel/session.
>   - *[med/low]* collab-only send path now guards `_cancelledPanels` before spawning the main agent; the brief strips all mention tokens (no dangling `@agent`/raw `@agent:role` re-injected); read-only advisors may do benign web reads (WebFetch/WebSearch) without being killed.

- **Original status:** DRAFT
- **Why this exists:** the user ask is "call any agent or multiple agents as advisors, coworkers, collaborators, critics, reviewers — for all providers, reliably." Today's two multi-agent surfaces can't do it: `BrainstormManager` is settings-bound to exactly 2 agents with 5 hardcoded strategies (`DiscussionRole` is a closed union, `types.ts:30`), and `MentionRouter` is sequential, task-string-only (`MentionTask` has no role, no parallelism, `types.ts:702`). The parallel primitive `_interleaveGenerators` eagerly starts all iterators with no cap (`BrainstormManager.ts`), and the sub-agent dispatch machinery (availability check, timeout, retry, cancel, question relay) is duplicated between the two managers. Meanwhile Plans 10/11 already designed the substrate this needs — this plan ships the **user-facing collaboration surface** on that substrate, sequenced so the ungated majority lands before the security floor.

---

## Goal

Any conversation can pull in **N additional agents in named roles** — ad hoc, no settings ceremony:

- `@google-gemini:critic @openai-codex:reviewer here's my plan …` (mention grammar)
- `/review`, `/critique`, `/consult`, `/panel` (slash commands with an agent multi-picker)
- later, the **main agent itself** requests a consult mid-task (gated)

A **role** = stance prompt + return contract + access profile + interaction pattern. Advisory roles (advisor, critic, reviewer, second-opinion) are read-only children; working roles (coworker, collaborator) write and are gated. Roles are markdown files in the existing three-tier agent system, so users define their own.

## Ownership vs Plans 09–12 (no duplicate work)

1. **The Phase-0 pool here IS the bounded pool Plan 11 constraint 3 requires.** Build once in `src/services/`, shared by MentionRouter, BrainstormManager, this plan's dispatch, Plan 08's retrieval fan-out, and later Plan 11's DAG.
2. **User-initiated dispatch is not delegation.** Typing `@x:critic` or `/review` is an explicit user command — it does **not** wait for the Plan 10 security floor. Anything **model-initiated** (Phase 3) or **writing** (Phase 4) is gated on Plan 10 Part 1 (and Part 2 for async coworkers).
3. Plan 11's hard constraints apply verbatim where relevant: UUID-scoped derived panels (constraint 4), per-child compaction/retrieval/history off (5, 11), transport-signal completion + schema-validated `returnSpec` (6), no `mysti` self-reference (8).
4. This plan does **not** do DAG decomposition, backend auto-routing, or recursive trees — that stays Plan 11.

## Reliability contract (the "reliably" — applies to every phase)

1. **Pre-flight availability** via `CliDiscoveryService` (cached probe: found + authenticated). Unavailable agent → skip-with-notice card + install/auth hint (pattern exists, `MentionRouter.ts:403-413`) — never a hang, never a cryptic stream error.
2. **Structured failure taxonomy** per child: `not-installed | not-authenticated | timeout | crashed | stream-error | empty-response | cancelled` — surfaced on that agent's card; a failed agent never sinks the run.
3. **Completion is a transport signal**: the provider `done` chunk, then `returnSpec` validation with graceful fallback to raw text. Never response-text keyword matching.
4. **Timeouts per role** (advisory ~5 min default, working roles up to `SUBAGENT_TIMEOUT_MS`) + `SUBAGENT_MAX_RETRIES` transport retries — both constants exist; the pool owns them in one place.
5. **Cancel = fan-out** to all derived panelIds via `ProviderManager.cancelRequest` (owning-provider teardown + SIGKILL backstop via `processKill`, Windows kill-tree safe — `ProviderManager.ts:371-389`). One Stop button tears down the whole panel of agents.
6. **Isolation:** derived panelIds are `${panelId}-collab-${runUuid}-${n}` (never bare counters); `evaluateCompaction`/retrieval/history-persistence no-op for `*-collab-*` panels.
7. **Graceful degradation:** K of N agents fail → synthesis proceeds with survivors + an explicit failure note (the `formatSubAgentContext` / brainstorm-fallback pattern, `MentionRouter.ts:166-186`).
8. **Question relay:** a child's `ask_user_question` reuses `SubAgentQuestionCallback` (`MentionRouter.ts:510-583`); in parallel runs, questions are queued to the panel one at a time (never N modal cards at once).
9. **Provider matrix honesty:** every backend already serves one-shot prompt dispatch via `sendMessageToProvider` (`ProviderManager.ts:330`) — including Hermes (ACP persistent process handled in the base machinery). **Manus is excluded** until it's wired or removed (orphaned dead code per the 2026-07-05 review). Ollama/LocalAI map connection-refused to `not-installed`-class errors and respect the probe-failure TTL.
10. **Read-only enforcement for advisory roles** is per-provider: a restricted-permission flag map where the CLI supports it (e.g. Claude `--permission-mode`, Codex sandbox flags, Gemini approval mode); where the CLI can't be restricted, Mysti's stream gate is the enforcement and the Plan 10 Part 1 step 3 trust caveat is shown. Advisory children additionally get a read-only `AccessLevel` in their child `Settings`.

---

## Phase 0 — `CollaboratorPool`: one shared, bounded dispatch primitive (~3–4d, independent)

**Steps**

1. `src/services/CollaboratorPool.ts`: `dispatch(specs: ChildSpec[]) → AsyncGenerator<CollabChunk>` with a real concurrency cap (`mysti.collab.maxConcurrent`, default 3), per-child timeout/retry, availability pre-check, UUID-scoped panels, structured errors, question relay, cancel fan-out, and the completion contract — extracted from `MentionRouter._dispatchWithRetry` (`:444-609`) rather than written fresh.
2. Retrofit `MentionRouter` onto the pool (sequential = cap 1, preserves today's semantics); retrofit `BrainstormManager`'s parallel phases onto it (retires uncapped `_interleaveGenerators` from the dispatch path).
3. **Verify-and-close the gate question:** confirm whether sub-agent `tool_use` on derived panels passes `_shouldGateToolUse` today (gating is panel-bound in `ChatViewProvider`; `MentionRouter` re-yields `subagent_tool_use` for display). If it bypasses, the pool routes every child `tool_use` through the same gate callback the main panel uses — the full panel-independent chokepoint remains Plan 10 Part 1 step 2, but children must not be *less* gated than the main agent in the interim.

**Acceptance:** MentionRouter + brainstorm behavior unchanged (suite stays green); a 5-agent dispatch runs max-3 concurrent; cancel kills all children incl. queued ones; each failure mode maps to its taxonomy entry. +tests for cap, retry, timeout, cancel fan-out, taxonomy mapping, gate routing.

## Phase 1 — Role framework: roles as markdown in the three-tier system (~2–3d)

**Steps**

1. New agent kind `roles/` beside `personas/`/`skills/` in all three sources (`resources/agents/core/roles/`, `~/.mysti/agents/roles/`, `.mysti/agents/roles/`), parsed by the shared `agentMarkdown.ts` helpers, loaded by `AgentLoader` three-tier, workspace-shadowing order preserved. Frontmatter: `id`, `name`, `description`, `icon`, `access: read-only | gated-write`, `pattern: one-shot | rounds`, `timeoutMs?`, plus a `## Return Contract` section (the `returnSpec`: required markdown sections, size cap).
2. Built-in roles: **advisor** (answer a question: options, trade-offs, one recommendation), **critic** (attack the proposal; concrete failure scenarios, no praise), **reviewer** (severity-ranked findings on a diff/files), **second-opinion** (independent solve, then diff vs the main agent's answer), **coworker** (execute a bounded subtask; gated-write), **collaborator** (rounds: propose → cross-critique → converge; gated-write). All advisory roles ship `access: read-only`.
3. Prompt assembly: role stance + user brief + return contract + **delimited low-trust context block** (conversation summary + prior sibling outputs — same posture Plan 10 Part 1 step 5 mandates for self-authored content).
4. Extend `tests/resources/agentContentConformance.test.ts` to validate bundled roles; extend `AgentStudio` create-flow with a role template (`mysti.createRole`).
5. Generalize `DiscussionRole` from the closed union to role ids (keep the old literals as built-in ids for backward compat with brainstorm UI badges).

**Acceptance:** roles load/override across the three tiers like personas; conformance test covers them; a user-authored role file works without code changes.

## Phase 2 — User-facing invocation surfaces (~4–5d; webview bits pair with the F5 pass)

**Steps**

1. **Mention grammar `@agent:role`** — extend `parseMentionsFromContent` (`media/chat/chat.js:844`) and `Mention` with `role?` (`types.ts:684`). Role-tagged mentions bypass the task-list heuristic's sequential default: all role-tagged mentions in one message form a **parallel group** on the pool (they're perspectives on the same brief, not a dependency chain). Un-roled mentions keep today's behavior exactly.
2. **Slash commands** via `SlashCommandManager`: `/consult <question>`, `/review [what]`, `/critique [what]`, `/panel <topic>` — each pre-binds a role; agent selection via a multi-select picker with live availability badges (cached wizard-status, patterns exist in `index.html`'s agent menu). `/review` with no target defaults to the working-tree diff as context.
3. **Per-agent collaborator cards** in the webview: reuse the brainstorm timeline/role-badge components and mention sub-agent cards (streaming text, tool activity, status, failure taxonomy label); respect Plan 06's calm palette (no per-agent rainbow).
4. **Role-aware synthesis:** multi-agent runs end with the **main provider** synthesizing role-labeled blocks (`formatSubAgentContext` generalized with role headers + the failure note); single-agent consults return verbatim. `/panel` synthesis includes an explicit disagreements section.
5. **Persistence:** collaborator outputs stored as role-labeled segments on the message (Plan 02 normalized anatomy) so restore is replay-exact; sub-agent transcripts themselves are not persisted (constraint 6 of the reliability contract).

**Acceptance:** `@x:critic @y:reviewer <brief>` runs both in parallel with live cards and a synthesized, role-labeled result; `/review` on 3 agents with one uninstalled agent degrades gracefully; cancel mid-run kills all; reload restores the cards from persisted segments. +tests for grammar parsing, parallel grouping, synthesis formatting, degradation.

## Phase 3 — Model-initiated consults (gated on Plan 10 Part 1; ~3d)

The main agent asks for help mid-task ("advisor on demand" — the shippable subset of Plan 11 D3c's advisor, no tree).

**Steps**

1. Transport: a fenced ```` ```mysti-consult ```` block `{role, agents?, question, contextPaths?}` emitted by the main agent — detected in the same accumulated-text scan lane as the visual-test and connect markers, stripped from live+persisted text.
2. **Security (non-negotiable):** model-triggered dispatch **is delegation** — classified `delegate` (Plan 10 Part 1 step 1), default-deny approval card showing role, target agents, and the question (the exact posture of the `devServerCommand` RCE fix, commit 87960fd). Advisory read-only roles only; depth 1 (a consulted child cannot consult); consult spend booked to the ledger; per-turn consult budget cap.
3. Result injection: consults run on the pool; answers return to the main agent as an auto-continuation with a delimited low-trust block (the autonomous-continuation machinery, which post-Batch-2 routes through `SafetyClassifier` rather than forcing full-access).

**Acceptance:** the main agent can request `@critic` feedback mid-plan; the user approves once per consult (or pre-approves in autonomous full-access); a child cannot recurse; ledger shows consult spend. +tests for gating, depth guard, marker stripping.

## Phase 4 — Writing coworkers (gated on Plan 10 Parts 1–2; ~1wk)

**Steps**

1. `coworker`/`collaborator` children run with `ask-permission` access through the panel-independent chokepoint; their write/exec `tool_use` surfaces as permission cards attributed to the child agent.
2. **Single-writer default:** one writing child at a time against the workspace; parallel writers require opt-in git-worktree isolation (merge-back as a diff the user applies). No two ungated agents ever write the same tree concurrently.
3. Long coworker tasks become Plan 10 **jobs** (async, report-back card + spend), so a 40-minute subtask doesn't hold the panel.
4. `collaborator` rounds: generalize the brainstorm `debate` loop to N role-tagged agents on the pool (round 1 propose in parallel → round 2 each critiques the others' proposals → synthesis), with the existing convergence tracking.

**Acceptance:** a coworker edits files only through gated cards; two coworkers in parallel require worktrees; an async coworker survives panel reload and reports back; N-agent collaborator rounds converge or hit the round cap. +tests.

---

## Sequencing

```
Phase 0  CollaboratorPool (shared bounded dispatch)      ~3–4d   independent — also pays down MentionRouter/Brainstorm debt; Plan 11 D3a consumes it
Phase 1  Role framework (markdown, three-tier)           ~2–3d   independent
Phase 2  @agent:role + /commands + cards + synthesis     ~4–5d   webview parts pair with the F5 pass
Phase 3  mysti-consult (model-initiated, advisory)       ~3d     GATED on Plan 10 Part 1
Phase 4  writing coworkers + rounds + async jobs         ~1wk    GATED on Plan 10 Parts 1–2
```

Phases 0–2 deliver the bulk of the user value (any agents as critics/reviewers/advisors, reliably, all providers) with **no dependency on the security floor**, because the user is the initiator and advisory children are read-only. Phases 3–4 are where agents gain agency and writes — exactly where Plan 10's floor is required first.

## Out of scope (→ Plans 11/12)

- Task decomposition into DAGs, cross-agent backend routing, recursive advisor-trees (Plan 11).
- Self-improvement, skills-as-tools, workflow engine, scheduling (Plan 12).
