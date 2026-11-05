# Agents and runtime: feature inventory and execution plan

This is a **plan, not an execution report**. It covers the source reachable in the current working tree on 2026-10-09. Existing test references identify available evidence and harnesses; they do not establish that these scenarios, durations, integrations, or quality gates have passed. No paid or live session was started while preparing this file.

Use the fixtures, evidence schema, proposed performance thresholds, provider eligibility matrix, and execution status legend in the [comprehensive plan](../47-comprehensive-feature-test-plan.md). An unavailable or unauthenticated required backend is **blocked**, never a successful collaboration test. Run every reachable case, including disabled-by-default opt-in features, before claiming all-feature coverage. Record exact extension commit, CLI versions, model IDs, configuration, workspace, account route, and experiment seed. Model/provider availability must be established at execution time.

## Profiles and common evidence

- **S:** 45–60 minutes and at least 25 user turns. **W:** 8 hours and at least 250 turns. **E:** 24 hours and at least 750 turns. **P:** 5 days, at least 1,000 turns, 200/day, with real overnight shutdown. A turn is a user submission; internal model rounds and child dispatches are additional recorded counters. Both elapsed duration and iteration minimum must be met. Timers can be accelerated in deterministic regressions, but that does not satisfy a real long-session run.
- **F1:** small Node retry service with a reference implementation, planted defects, deterministic unit/integration assertions, and a diff allowlist. **F2:** realistic full-stack issue workflow, 30–100k LOC. **F3:** monorepo, 10k files/500k LOC. **F4:** adversarial filenames, prompt-injection documents, and recognizable synthetic secrets. **F5:** Canvas app. **F6:** test-service accounts, two workspaces, and two peers. Fixture details come from the main plan.
- Use Claude and Codex as the first genuinely different provider pair; rotate a third available backend through the same assignments. This is a matrix, not permission to accept a substitute provider's results as coverage for a missing provider. For deterministic failure injection, use controlled streams/transport fixtures; for product proof, repeat reachable cases in a real VS Code extension host and retain the actual provider trace.
- Every run captures a timestamped host event log keyed by panel/conversation/run/child/request IDs; redacted prompts and terminal outcomes; screenshots of significant UI states; workspace before/after hashes and test results; provider process and child-process inventory; usage/cost ledger with unknown values preserved; and heap/CPU/handle samples at baseline, each hour, and after cooldown. Never log credentials or real secret contents. All thresholds referenced from the main plan remain proposed acceptance criteria.
- At least once in each feature's long run, Stop during active work, leave a permission/question pending, switch conversation, create a new conversation, and send a successor turn. Inject a late old chunk/error/completion. Foreground work must stop or detach according to its ownership contract, new work must remain unaffected, and old work must not change the new transcript, permission state, canvas, usage, or busy indicator. Background jobs have the explicit exceptions in AR-31. A timing log, process inventory, and persisted conversation comparison are required; a convincing response alone is insufficient.

## Contract discrepancies that must be resolved before a feature can pass

| ID | Advertised contract | Current reachable implementation | Required resolution |
| --- | --- | --- | --- |
| AR-11 | `/panel`: “each answers alone, then one synthesis” in [sessionShapes](../../src/managers/sessionShapes.ts) | [SessionManager](../../src/managers/SessionManager.ts) renders the independent answers; there is no synthesis model phase in the panel path. | Implement and validate synthesis, or explicitly approve and ship corrected product copy/docs. Recording the independent answers is only a characterization result, not a contract pass. |
| AR-14 | `/brainstorm`: “build until they converge” in the same catalog | SessionManager performs the catalog's fixed two rounds, ending earlier only if no successful text remains; it does not assess convergence. This is separate from legacy Brainstorm's convergence logic. | Resolve the promised convergence behavior versus bounded two-round discussion, then validate the agreed contract. |
| AR-04 / AR-10–12 | [`mysti.collab.maxConcurrent`](../../package.json) describes controlling mentions and `/consult`, `/review`, `/critique`, `/panel`. | [SlashCommandManager](../../src/managers/SlashCommandManager.ts) maps typed review/panel/critique aliases to session shapes; SessionManager uses its own fixed limit of 3. The collaboration setting controls CollaborationManager. | Decide whether the setting should control sessions or its description should exclude them. Do not call an ignored advertised setting a pass. |
| AR-22 | Autonomous UI/continuation must have unambiguous ownership when several chats exist. | [AutonomousManager](../../src/managers/AutonomousManager.ts) maintains one active session, while [ChatViewProvider](../../src/providers/ChatViewProvider.ts) has panel-specific autonomy state and continuation gates. | Establish and document the multi-panel ownership contract during execution. The current global-manager/panel-state split is a risk to test, not proof of a defect or permission for another panel to continue the goal. |
| AR-34 | Capability health/report text says a fix plus republish restores repeatedly failing capabilities. | The publish path re-registers bytes, but the inspected path does not reset the separate failure ledger; `skillrun` refuses artifacts no longer offered by that ledger. | Reproduce the four-failures→fix→republish journey and resolve the recovery promise. Do not treat registry replacement alone as recovery. |

Do not count legacy internal command branches, source comments, design plans, mock-only capabilities, or dormant helpers as independently shipped entry points. For example, `/consult` composes role mentions; typed `/review`, `/panel`, `/critique`, `/race`, and `/brainstorm` open session pickers. A comment referring to `/jobs` does not establish a shipped slash command; use the actual background-job/map controls in AR-31.

## Feature cases

## AR-01 — Explicit agent assignments and independent collaboration

**Priority / implemented surface:** P0. `@claude`, `@codex`, and other known agent aliases in the composer dispatch named agents even when Mysti or another backend is selected. Adjacent agents can share a brief; independent advisory assignments can overlap. [ExplicitMentionPlan](../../src/services/ExplicitMentionPlan.ts), [ExplicitMentionRunner](../../src/managers/ExplicitMentionRunner.ts), [MentionRouter](../../src/managers/MentionRouter.ts), and [host routing](../../src/providers/ChatViewProvider.ts) implement this surface. Mentions are bounded and intentionally use conservative parsing.

**Scenario:** In F1, select Mysti and ask `@claude explain why the retry deadline is wrong. @codex propose boundary tests.` Follow with `@claude @codex independently review @src/retry.ts` and then ask each agent to revise its own conclusion after a changed requirement. Repeat with a different selected backend, aliases, sentence-ending punctuation, and an attached file/state reference. Keep a backend-specific marker in controlled responses so hidden rerouting is detectable.

**Long session:** W, 250 turns, at least 100 two-agent and 25 three-agent submissions; rotate selected provider every 25 turns and use at least 30 targeted follow-ups. Add a separate S run at the maximum supported mention count and one above it.

**Faults / boundaries:** Literal mentions in fenced code, email-like text, unknown tags, duplicated assignments, unavailable/auth-expired child, final-text-only stream, one silent child, late failure after switching conversation. Test independent writing assignments for serialized access.

**Pass/fail and evidence:** Exactly the requested assignments run, attributable output remains separate, each target receives its own brief plus allowed shared context, and the selected provider does not silently impersonate another provider. Backend traces, assignment/run IDs, overlap intervals, final transcript, and file hashes must agree. Partial failure must name the failed target without erasing successful peers.

**Existing / new coverage:** [explicitMentions](../../tests/managers/explicitMentions.test.ts), [mentionRouter](../../tests/managers/mentionRouter.test.ts), [stateMentions](../../tests/managers/stateMentions.test.ts), [host persistence](../../tests/integration/chatViewMessagePersistence.test.ts), [live conversations](../../tests-live/conversations.test.ts), [native conversations](../../tests-vscode/conversation.test.ts). Add the W matrix, real provider attribution, and response-quality rubric against F1's planted defects.

## AR-02 — Ordered handoffs and dependency failure propagation

**Priority / implemented surface:** P0. Explicit `then`, `afterwards`, `after that`, or `next` before a subsequent agent tag create ordered phases in [ExplicitMentionPlan](../../src/services/ExplicitMentionPlan.ts) and [ExplicitMentionRunner](../../src/managers/ExplicitMentionRunner.ts). Reusing an agent in a later phase is supported; prior output is fenced as untrusted input. This is not a general natural-language DAG parser.

**Scenario:** `@codex implement bounded retries in @src/retry.ts then @claude review the patch then @codex fix the review findings.` Approve only the intended write scope. Add two parallel independent readers before a final reviewer, then change the requirement in the next turn and prove the old conclusion does not replace the new requirement.

**Long session:** W, 250 turns including 60 three-phase implement/review/revise workflows and 20 workflows with a repeated agent in nonadjacent phases. E extension: 750 turns with a dependency failure in every tenth workflow.

**Faults / boundaries:** Empty successful-looking prerequisite, provider error, denial, Stop between phases, auth loss during handoff, malformed downstream request, and upstream text claiming to authorize deletion or alter agent routing. Include “then” inside code/prose where no later tag exists.

**Pass/fail and evidence:** Downstream tasks start only after all real prerequisites finish successfully and receive their actual output with trust boundaries intact. Failed prerequisites produce named blocked tasks rather than invented reviews. Revision addresses actual reviewer findings and F1 tests pass; unauthorized files remain unchanged. Preserve phase timing, prompt envelopes, hashes, review finding IDs, and blocked-state screenshots.

**Existing / new coverage:** [explicitMentions](../../tests/managers/explicitMentions.test.ts), [collaborationManager](../../tests/managers/collaborationManager.test.ts), [host persistence](../../tests/integration/chatViewMessagePersistence.test.ts). Add real edit/review/revise outcomes, replay under slow consumers, and extended repeated-agent/session-ownership coverage.

## AR-03 — Role-based collaboration, `/consult`, and role authority

**Priority / implemented surface:** P0 for authority, P1 for composition. `@agent:advisor`, `:critic`, `:reviewer`, `:coworker`, plus loaded custom roles, route through [CollaborationManager](../../src/managers/CollaborationManager.ts). [`/consult`](../../src/managers/SlashCommandManager.ts) opens a native picker and composes mentions in the input for the user to submit; it does not immediately dispatch. [`mysti.createRole`](../../src/extension.ts) reaches the agent creation flow. Full role authoring/catalog format coverage belongs to the configuration/catalog domain in the main plan.

**Scenario:** In F2, compose a consultation with Claude and Codex, edit the generated brief, then send. Ask a reviewer for defects, a critic for counterexamples, and a coworker for a scoped change. Use one trusted custom gated-write role and one untrusted workspace role advertising write privileges; inspect role badges and actual tool requests.

**Long session:** W, 250 turns with at least 25 uses of each built-in role, 25 custom-role assignments, and 20 picker cancel/edit/reopen cycles. P extension alternates two workspaces with identically named roles but different trust decisions.

**Faults / boundaries:** Cancel/empty picker, no other backend, missing role, role changed on disk between display and use, role prompt injection, global versus workspace precedence, and writable text instructions inside a read-only role.

**Pass/fail and evidence:** No work starts before submission; role and chosen provider remain attributable. Effective access comes from validated role trust and current user authority, not role prose. Read-only roles make zero writes; approved coworker work remains scoped. Save composed drafts, role-resolution provenance, gate events, actual writes, and post-reload trust state.

**Existing / new coverage:** [collaborationRoleAccess](../../tests/managers/collaborationRoleAccess.test.ts), [agentTrustTier](../../tests/managers/agentTrustTier.test.ts), [agentLoaderTrustAtUse](../../tests/managers/agentLoaderTrustAtUse.test.ts), [roleAutocomplete](../../tests/webview/roleAutocomplete.test.ts), [roleTrustBadge](../../tests/webview/roleTrustBadge.test.ts). Add native picker-to-runtime and persistence workflows.

## AR-04 — Child scheduling, cancellation, questions, authentication, and retry

**Priority / implemented surface:** P0. [CollaboratorPool](../../src/services/CollaboratorPool.ts) governs bounded fan-out, serialized writers, provider readiness, per-child questions/gates, deadlines, cancellation, and at most one eligible retry. [CollaborationManager](../../src/managers/CollaborationManager.ts) applies the configurable concurrency cap; SessionManager has the separate cap noted above. Default task timeout is one hour, readiness is bounded by the smaller readiness/task budget, and question waits have their own timeout.

**Scenario:** Dispatch five read-only F2 reviews with cap 1, 3, then 8; observe actual simultaneous streams. Mix a scoped writer among them. Ask two children distinct questions, answer in reverse order, and cancel one lane while another is waiting for approval. Start an unrelated second-panel run throughout.

**Long session:** E, 750 turns with at least 2,000 child dispatches; rotate cap settings and inject 100 queued cancellations, 50 readiness waits, 50 questions, and 50 terminal auth failures. Verify cleanup after the bounded closed-run history is exceeded. Include one genuine wall-clock timeout boundary in a controlled provider run.

**Faults / boundaries:** Never-resolving readiness or iterator pull, hung abort cleanup, rejected async gate, denial, auth loss after initial text or after question follow-up, empty follow-up, late answer after cancellation, and transient transport failure before versus after approved possible side effects.

**Pass/fail and evidence:** Concurrency respects effective access and the applicable cap; cancelled queued lanes never start; every lane reaches one truthful terminal state; stopped waits settle within proposed main-plan deadlines. Retry must not repeat approved possible side effects. Other runs remain alive, no late answer resurrects work, and all child processes/gates are released. Compare queue/stream timing and actual side-effect counters, not only UI labels.

**Existing / new coverage:** [pool](../../tests/services/collaboratorPool.test.ts), [cancellation](../../tests/services/collaboratorPoolCancellation.test.ts), [provider failures](../../tests/services/collaboratorPoolProviderFailures.test.ts), [native approvals](../../tests/services/collaboratorPoolNativeApproval.test.ts), [child approval routing](../../tests/managers/childNativeApprovalRouting.test.ts). Add E resource metrics and native multi-panel replay; resolve the advertised concurrency-setting discrepancy before contract sign-off.

## AR-05 — Legacy Brainstorm: quick strategy and synthesis fallback

**Priority / implemented surface:** P1. Selecting the Brainstorm agent/mode with strategy `quick` in [BrainstormManager](../../src/managers/BrainstormManager.ts) runs two configured distinct providers independently and then synthesizes. This is different from typed `/brainstorm`. Configured synthesis provider failure can fall back to the other agent and finally an attributable concatenation, which must not be presented as a successful synthesized consensus.

**Scenario:** Use Claude/Codex to compare retry designs for F1: maximum attempts versus total deadline, idempotency, jitter, and cancellation. Give each a persona with a different engineering emphasis. Inspect independent views before synthesis and ask a follow-up that preserves the accepted tradeoff. Repeat with another valid provider pair and alternate synthesis preference.

**Long session:** W, 250 turns, 100 quick runs and 150 design/refinement turns; every tenth run changes provider pair or synthesis preference. P extension checks conversation restoration and next-day continuity without resurrecting obsolete runs.

**Faults / boundaries:** Duplicate/invalid pair, no authenticated agents, one participant fails or is silent, synthesis provider unavailable/empty/hung, cancellation during every phase, and a successful child emitted before a slow failing sibling.

**Pass/fail and evidence:** Exactly two independent initial lanes, no discussion round, and a truthful synthesis/fallback status. Successful source content is retained, dissent is not fabricated as consensus, and the recommendation addresses the fixture's constraints. Preserve phase events, participant text, synthesis prompt provenance, fallback decisions, timings, and rubric scores.

**Existing / new coverage:** [brainstormManager](../../tests/managers/brainstormManager.test.ts), [correctness](../../tests/managers/brainstormCorrectness.test.ts), [provider failures](../../tests/managers/brainstormProviderFailures.test.ts), [isolation](../../tests/managers/brainstormIsolation.test.ts). Add provider-pair quality comparisons and W/P continuity evidence.

## AR-06 — Legacy Brainstorm: debate and convergence

**Priority / implemented surface:** P1. [BrainstormManager](../../src/managers/BrainstormManager.ts) debate runs independent analysis, critique/defense discussion rounds, convergence assessment, then synthesis. `maxDiscussionRounds` and `autoConverge` apply; legacy discussion settings have fallback compatibility behavior.

**Scenario:** In F2, debate whether the same retry primitive should serve HTTP and queue consumers. Supply conflicting latency/duplicate-delivery requirements and known counterexamples. Run with auto-converge on and off and round limits 1, 2, and the supported maximum. Introduce a new constraint mid-conversation and require reassessment rather than recycled agreement.

**Long session:** W, 250 turns with 60 debates spread across round settings; E extension uses 200 debates, at least 30 intentionally stable, 30 oscillating, and 30 unresolved pairs. Count internal rounds separately from user turns.

**Faults / boundaries:** Repeated “we agree” language without stable positions, changes of terminology with unchanged position, contradictory evidence, one participant failing before discussion, Stop between round and synthesis, and a slow peer starving fast output.

**Pass/fail and evidence:** Round roles and cap are correct, incomplete prerequisites do not become invented contributions, and convergence/stall decisions match the implemented measurable evidence. Product quality additionally requires preserving unresolved disagreements and not claiming evidence-backed consensus from rhetorical agreement. Capture each round's positions, convergence history, actual termination reason, and human rubric against seeded requirements.

**Existing / new coverage:** [brainstormManager](../../tests/managers/brainstormManager.test.ts), [correctness](../../tests/managers/brainstormCorrectness.test.ts). Add adversarial convergence datasets, old-setting migration cases, and long-duration round/cost accounting.

## AR-07 — Legacy Brainstorm: red-team challenge and defense

**Priority / implemented surface:** P1. The `red-team` strategy in [BrainstormManager](../../src/managers/BrainstormManager.ts) has propose, challenge, defend, and synthesize phases. This is a design exercise; it does not grant additional execution authority.

**Scenario:** Propose a safe F1 retry/cache design, ask the second agent to break it with deterministic race/timeout/idempotency cases, and require the proposer to defend or revise with evidence. Swap providers' roles and repeat with F2 authorization, migration, and job-retry designs. Evaluate against planted counterexamples rather than persuasiveness.

**Long session:** W, 250 turns including at least 60 complete red-team runs, 20 swapped-role repeats, and 20 follow-up revisions based on earlier attacks. E extension tests 150 complete runs over 24 hours with periodic idle/resume.

**Faults / boundaries:** Empty proposal, challenger outage, “attack” prose that requests unauthorized workspace edits, defender ignores a valid counterexample, phase cancellation, and a challenge containing fake system instructions or spoofed handoff delimiters.

**Pass/fail and evidence:** Every challenge targets the actual proposal; defense sees the actual challenge; final output distinguishes unresolved risk from repaired design. Handoff text never elevates authority. Controlled oracle expects all planted critical counterexamples to remain visible until addressed and no forbidden writes. Archive per-phase prompts, counterexample mapping, terminal statuses, and testable revised design.

**Existing / new coverage:** [brainstormManager](../../tests/managers/brainstormManager.test.ts), [correctness](../../tests/managers/brainstormCorrectness.test.ts), [isolation](../../tests/managers/brainstormIsolation.test.ts). Add a strategy-specific real-provider counterexample rubric and explicit propose/challenge/defend cancellation permutations.

## AR-08 — Legacy Brainstorm: risk/opportunity perspectives

**Priority / implemented surface:** P1. `perspectives` in [BrainstormManager](../../src/managers/BrainstormManager.ts) gives the two agents risk and opportunity lenses, then cross-review and synthesis. Two complementary lenses are implemented; do not advertise a full multi-role “six hats” session.

**Scenario:** In F2, evaluate replacing a polling subsystem with a queue. Supply reliability, delivery speed, operational cost, and rollback requirements. Require the risk agent to enumerate failure modes and the opportunity agent to propose usable incremental benefits, then inspect whether each cross-review addresses the other's actual analysis. Swap backend/lens assignment.

**Long session:** W, 250 turns, 60 perspective runs across five architectural choices; each choice receives revised constraints later in the day and a role-swapped repeat. P extension revisits the same recorded decision on day 5 after implementation evidence changes.

**Faults / boundaries:** Both providers produce identical generic text, one lens is empty/unavailable, one agent asserts unsupported certainty, conflicting cost facts, untrusted handoff instructions, and Stop during cross-review.

**Pass/fail and evidence:** Lens prompts and roles are correctly assigned, cross-review uses the opposing contribution, and synthesis represents concrete risks, benefits, and unresolved assumptions. Missing lenses must be disclosed. Capture prompt/phase traces, named evidence citations to fixture files, rubric scores, and factual contradictions retained or resolved.

**Existing / new coverage:** [brainstormManager](../../tests/managers/brainstormManager.test.ts), [correctness](../../tests/managers/brainstormCorrectness.test.ts). Add lens-swap quality tests, factual grounding checks, and long-run role/context isolation.

## AR-09 — Legacy Brainstorm: Delphi facilitation and refinement

**Priority / implemented surface:** P1. `delphi` in [BrainstormManager](../../src/managers/BrainstormManager.ts) performs independent input, facilitator summary, parallel refinements, convergence/stall assessment, and synthesis. Facilitator/refiner contributions are stored separately. A synthesis preference outside the participating pair falls back to a participant for facilitation; test actual attribution.

**Scenario:** Estimate F2 migration effort/risk using a known task breakdown and two intentionally different estimates. Ask for anonymous facilitator summaries and evidence-based refinement, then introduce a dependency discovered in the repository. Repeat with convergence disabled and multiple round caps. Track each agent's own successive position rather than comparing a refiner to the facilitator.

**Long session:** W, 250 turns with 50 Delphi sessions and at least 150 internal facilitator/refiner pairs; E extension reaches 200 sessions with stable, oscillating, and genuinely changing estimates.

**Faults / boundaries:** Unsupported/absurd convergence scores, malformed score text, facilitator failure, one missing refiner, name leakage in an “anonymous” summary, changed role attribution, and Stop while one refinement is still pending. Check whether declared convergence is based only on facilitator text; characterize this rather than treating it as proof of actual agreement.

**Pass/fail and evidence:** Correct bounded phase order and attribution, no mixing facilitator/refiner histories, truthful convergence/stall reason, and no ungrounded consensus presented as fact. Anonymity promised by prompts is assessed on actual output, not inferred from implementation intent. Preserve summaries, individual positions, convergence history, anonymous-content review, and final uncertainty statement.

**Existing / new coverage:** [brainstormManager](../../tests/managers/brainstormManager.test.ts), [correctness](../../tests/managers/brainstormCorrectness.test.ts). Add facilitator-identity and score-abuse regressions plus live calibration against known task outcomes.

## AR-10 — `/review`: independent diff review and merged findings

**Priority / implemented surface:** P0. The [session catalog](../../src/managers/sessionShapes.ts), [slash dispatch](../../src/managers/SlashCommandManager.ts), [SessionManager](../../src/managers/SessionManager.ts), and host `startSession` path implement a picker for 2–5 providers and read-only review lanes. JSON findings are parsed/merged; corroboration count and strongest severity are preserved. Every lane uses its own backend model defaults rather than inheriting a foreign selected model.

**Scenario:** Give F1 a diff with one critical retry bug, one medium cancellation defect, one harmless formatting change, and duplicate descriptions of the same location. Start `/review`, inspect participants and estimate, then submit. Repeat after fixing one defect and changing another line so stale findings are detectable.

**Long session:** W, 250 turns including 80 review sessions of 2, 3, and 5 providers; F3 extension reviews 50 large diffs during an E profile without feeding the entire monorepo unnecessarily.

**Faults / boundaries:** Below-minimum selection after dedupe, above cap, malformed/partially fenced JSON, conflicting severities, same text at different files/lines, one failed lane, cancelled lane, and unsupported model IDs.

**Pass/fail and evidence:** Participants explicitly chosen, estimate visibly approximate, no review writes, correct location merging and attribution, no duplicate consensus counts from one provider, and single-agent findings framed as leads. Preserve raw outputs, parsed/merged finding table, actual model IDs, file hashes, and mapping to planted defects. Resolve the concurrency-setting discrepancy before overall contract pass.

**Existing / new coverage:** [sessionManager](../../tests/managers/sessionManager.test.ts), [sessionPicker](../../tests/webview/sessionPicker.test.ts), [sessionFlow](../../tests/integration/sessionFlow.test.ts), [plan isolation](../../tests/integration/chatPlanIsolation.test.ts). Add native picker/provider matrix and W precision/recall assessment.

## AR-11 — `/panel`: multiple independent perspectives and promised synthesis

**Priority / implemented surface:** P1, **contract discrepancy open**. `/panel` selects 3–5 providers via [sessionShapes](../../src/managers/sessionShapes.ts) and [SessionManager](../../src/managers/SessionManager.ts). Current output is a rendered set of independent responses. Catalog copy additionally promises one synthesis; do not invent a shipped synthesis step.

**Scenario:** Ask three providers to choose a retry/circuit-breaker API for F2 with explicit performance, adoption, and rollback requirements. Verify independent first responses. Evaluate whether a product-promised synthesis exists and accurately presents agreement/disagreement; currently this observation should expose the discrepancy. After an agreed product/source resolution, run its exact revised contract.

**Long session:** W, 250 turns including 60 panels, at least 20 with five providers and 20 with conflicting conclusions; revisit prior decisions after 100 intervening turns. E extension uses 150 panels with periodic lane outages.

**Faults / boundaries:** One/all providers unavailable, empty successful completion, contradictory citations, duplicate provider selections, invalid participant count, cancelled lane, and embedded authority-changing instructions.

**Pass/fail and evidence:** Characterization requires independent attribution, truthful partial failures, read-only execution, and no leaked selected-provider model. Full feature pass additionally requires the synthesis promise to be implemented and validated or approved corrected copy shipped. Attach catalog screenshot, actual phase trace/output, disagreement table, and issue/resolution reference; do not mark the discrepancy “pass because current output matches code.”

**Existing / new coverage:** [sessionManager](../../tests/managers/sessionManager.test.ts), [sessionPicker](../../tests/webview/sessionPicker.test.ts), [sessionFlow](../../tests/integration/sessionFlow.test.ts). Add explicit advertised-contract assertion and resolved-behavior end-to-end coverage.

## AR-12 — `/critique`: proposer, attackers, and verdict semantics

**Priority / implemented surface:** P1. [SessionManager](../../src/managers/SessionManager.ts) uses one proposer then at least two attackers for 3–5 selected providers, with read-only lanes and nonce-fenced proposal text. A leading `BREAKS` token marks forced revision; other successful text is currently categorized as survived. This parsing must be tested separately from actual correctness.

**Scenario:** Ask for a retry policy, then challenge it with cancellation-before-sleep and double-delivery examples. Put Claude as proposer and Codex plus a third agent as attackers, then rotate proposer. After a forced-revision result, submit a revised proposal and check the same counterexample no longer breaks it.

**Long session:** W, 250 turns with 70 critique sessions and 30 revision/re-critique pairs. E extension injects a malformed verdict in every tenth of 200 sessions.

**Faults / boundaries:** Failed/empty proposal must prevent attacks; one attacker fails; attack says `BREAKS` after whitespace; conflicting verdicts; ordinary prose or malformed verdict without a leading token; adversarial proposal escaping a fence; Stop after proposal.

**Pass/fail and evidence:** Attackers examine the actual proposal, failed prerequisites never dispatch, and failure/unknown text is not product-labeled as reliable safety evidence. Capture parser categorization and independent counterexample result; if malformed outputs are displayed as “survived” despite lacking a verdict, open a product-correctness defect rather than assuming no leading token proves survival. Keep roles, handoff text, verdicts, and fixture tests.

**Existing / new coverage:** [sessionManager](../../tests/managers/sessionManager.test.ts), [sessionFlow](../../tests/integration/sessionFlow.test.ts). Add malformed-verdict UX semantics, real counterexample validity, and long-run proposer rotation.

## AR-13 — `/race`: competing candidate solutions and user selection

**Priority / implemented surface:** P1. `/race` in [sessionShapes](../../src/managers/sessionShapes.ts) and [SessionManager](../../src/managers/SessionManager.ts) launches 2–5 independent read-only attempts and renders candidates. “You keep one” means a human chooses from presented work; this path does not automatically execute a winner or supply an implemented tournament evaluator.

**Scenario:** Request three alternative F1 implementations as suggested patches with complexity and tests. Score each in isolated fixture copies, select one explicitly in the subsequent turn, and ask the normal authorized writer to apply it. Compare a fastest incomplete answer with a slower correct answer; speed alone must not win.

**Long session:** W, 250 turns with 75 races and at least 25 explicit selection/apply/test follow-ups. E extension includes 150 races across small and large tasks with slow-tail providers.

**Faults / boundaries:** Partial/empty candidates, one provider claiming to have already edited files, cancellation of one competitor, all competitors fail, a candidate embedding unauthorized commands, and final-only versus token-streamed answers.

**Pass/fail and evidence:** Every launched lane is accounted for in cost and status, no hidden winner or write occurs, candidates remain attributable and independently comparable, and explicit follow-up applies only the selected approach. Save candidate hashes, isolated test results, selection turn, actual diff, elapsed distributions, and known/unknown cost. Any advertised selection control must be independently verified as reachable; prose alone is not evidence of one.

**Existing / new coverage:** [sessionManager](../../tests/managers/sessionManager.test.ts), [sessionFlow](../../tests/integration/sessionFlow.test.ts), [pool usage](../../tests/services/collaboratorPoolUsage.test.ts). Add candidate-quality scoring and selection-to-implementation native workflow.

## AR-14 — `/brainstorm`: bounded multi-agent refinement session

**Priority / implemented surface:** P1, **contract discrepancy open**. The slash-session shape in [sessionShapes](../../src/managers/sessionShapes.ts) and [SessionManager](../../src/managers/SessionManager.ts) accepts 2–4 providers, all read-only. It runs two waves; later prompts contain successful earlier contributions as untrusted data. It is not the selected Brainstorm agent or its five strategies.

**Scenario:** With three providers, brainstorm API migration paths for F2. Inspect independent first positions and second-round references to actual peers. Use one dataset that already agrees and another that remains irreconcilable after two rounds; compare the catalog's convergence promise with the observed fixed stop. Resolve the contract before qualifying this case.

**Long session:** W, 250 turns with 70 sessions and 30 follow-ups that change a constraint. E extension uses 200 sessions, rotating the failed/slow lane and varying count 2–4.

**Faults / boundaries:** No successful first-wave text, one failed lane, deliberate disagreement, peer output containing routing directives, duplicate round IDs, and cancellation between waves.

**Pass/fail and evidence:** Current characterization requires at most two correctly attributed waves, no later wave when all prerequisite text is absent, no authority from peer text, and one truthful terminal output. Full pass requires an agreed convergence contract and source/copy alignment, with evidence showing the agreed stop condition. Keep catalog copy, wave prompts, round IDs, actual disagreement, final output, and resolution reference.

**Existing / new coverage:** [sessionManager](../../tests/managers/sessionManager.test.ts), [sessionPicker](../../tests/webview/sessionPicker.test.ts), [sessionFlow](../../tests/integration/sessionFlow.test.ts). Add tests that distinguish this path from legacy Brainstorm and assert the resolved convergence promise.

## AR-15 — Mysti inline coordinator, model selection, and fallback

**Priority / implemented surface:** P0. Selected Mysti, `@mysti`, or its supported prefix enters the host's inline coordinator by default. [ChatViewProvider](../../src/providers/ChatViewProvider.ts), [CoordinatorModelClient and its failure classifier](../../src/services/CoordinatorModelClient.ts), and [`mysti.setCoordinatorModel`](../../src/extension.ts) support signed DeepMyst gateway and direct OpenRouter-key routes, free model selection, pinned models, and configured fallback. Explicit named collaborators take precedence over accidental coordinator routing.

**Scenario:** Run F1 diagnosis using auto/free selection, a pinned available model, and each account route in a test account. Select a paid model then cancel the confirmation; confirm settings and next turn remain unchanged. Simulate one unavailable free model, then all unavailable, with paid fallback unset and explicitly configured. Use source-grounded expected classification, not hardcoded provider/model names that may retire.

**Long session:** W, 250 coordinator turns across both routes, 20 model changes, 20 recoverable free-provider outages, and five sign-out/sign-in cycles. P extension reopens the saved workspace after every overnight shutdown.

**Faults / boundaries:** Missing/expired account, invalid key, malformed or unsupported model, rate limit, transport reset, all-free exhaustion, cancelled model picker, and paid fallback approval denial. Separate authentication from model availability to prevent pointless waterfalls.

**Pass/fail and evidence:** Actual route/model matches user choice, each fallback has a traceable eligible reason, no unconfigured paid fallback occurs, account errors are actionable, and partial old streams cannot pollute successor turns. Capture redacted endpoint class, selected/resolved model, fallback sequence, consent event, configuration diff, and result grounded in fixture files.

**Existing / new coverage:** [model client](../../tests/services/coordinatorModelClient.test.ts), [defaults](../../tests/services/coordinatorDefaults.test.ts), [failure classifier](../../tests/services/coordinatorFailureClassifier.test.ts), [cancellation](../../tests/services/coordinatorCancellation.test.ts), [coordinator output](../../tests/chat/coordinatorRunOutput.test.ts). Add both-route native persistence and W availability recovery without paid execution during plan preparation.

## AR-16 — Coordinator tool loop, output continuation, and run budgets

**Priority / implemented surface:** P0. [CoordinatorTurnRunner](../../src/coordinator/CoordinatorTurnRunner.ts), [coordinator tools](../../src/services/coordinatorTools.ts), [prompt budgeting](../../src/coordinator/promptBudget.ts), and [host dispatch](../../src/providers/ChatViewProvider.ts) unify native tool calls and authenticated directive syntax. Read tools and remember/delegate are available by policy; local write/bash, skills, MCP, and visual tools require their separate opt-ins. A bounded number of length continuations and a final no-tools rescue stream exist; configured turn/delegation limits may be effort-scaled.

**Scenario:** In F3, find retry call sites, read relevant files, inspect diagnostics, delegate one focused check, and report an evidence-backed fix plan. Exercise native-tool and textual-directive model paths with the same tool transcript. Force output-length termination while a directive token is split across chunks, then exhaust the tool/run allowance using controlled output.

**Long session:** E, 750 coordinator turns and at least 5,000 read-tool operations, 100 length continuations, and 50 budget exhaustion cases. Repeat at ordinary and high-effort settings while independently counting actual model streams and delegations.

**Faults / boundaries:** Missing/stale nonce, malformed/duplicate tool calls, huge tool output, mid-tag cancellation, endlessly requesting tools, hung iterator return, empty final answer, and late zero-chunk completion after a successor canvas turn. Inject old compaction completion while a new turn is waiting.

**Pass/fail and evidence:** Only authenticated current calls execute, both protocols enforce the same authority, counters match actual streams, configured effort rules do not silently enlarge unrelated budgets, and exhausted runs explicitly report limitations. No unbounded rescue loop, lost actionable result, or stale completion. Preserve tool-call IDs, dispatch audit, truncated-output markers, exact budget values, cancellation timing, and final evidence citations. Direct local-tool functionality is tested in AR-36; executable skills in AR-34; external and visual integrations also have companion-domain cases.

**Existing / new coverage:** [turn runner](../../tests/coordinator/coordinatorTurnRunner.test.ts), [prompt budget](../../tests/coordinator/promptBudget.test.ts), [tool-result elision](../../tests/coordinator/elideToolResults.test.ts), [tools](../../tests/services/coordinatorTools.test.ts), [host persistence](../../tests/integration/chatViewMessagePersistence.test.ts). Add E counts, split-token live replay, and calibrated useful-output checks after budget exhaustion.

## AR-17 — Native Mysti subagents and bounded parallel delegation

**Priority / implemented surface:** P0. [MystiSubagentRunner](../../src/coordinator/MystiSubagentRunner.ts), [summary shaping](../../src/coordinator/subagentSummary.ts), and [host native delegation](../../src/providers/ChatViewProvider.ts) run fresh child contexts on the coordinator's model chain or an explicit subagent model. Native children have depth one: no recursive delegate or remember tool. Narrow read tools are available, writes require an authorized execution port, and the coordinator receives a summary with result/evidence/changes/open questions rather than the entire child transcript. Read-only batches are bounded; paid-model parallel restrictions and spend guards apply.

**Scenario:** In F3 ask Mysti to assign three native readers to retry implementations, cancellation propagation, and tests. Have the parent reconcile conflicting findings and request one approved fix. Compare sequential and parallel batches and inspect child context to ensure each receives only its own task and permitted shared facts. Run one child on a configured alternative model.

**Long session:** E, 750 turns with at least 1,000 native children and 100 three-child batches; include 50 child budget exhaustions and 50 follow-up tasks requiring fresh context.

**Faults / boundaries:** Child attempts recursive delegation, remembers an instruction, exceeds tool/turn limits, returns an enormous report, makes a denied write, requests a paid model in a batch, or hangs while a sibling completes. Cancel parent and individual in-flight work through reachable controls.

**Pass/fail and evidence:** No recursive child tree or hidden memory write, each task's budget/model/authority is enforced, paid-call consent remains effective, summaries preserve real evidence and unresolved failure, and child failure never becomes fabricated success. Capture child prompts, tool schemas actually exposed, concurrency intervals, summaries, counters, and workspace hashes. Quality oracle: parent identifies the planted F3 retry/cancellation relationships using child evidence.

**Existing / new coverage:** [native runner](../../tests/coordinator/mystiSubagentRunner.test.ts), [subagent summary](../../tests/coordinator/subagentSummary.test.ts), [coordinator tools](../../tests/services/coordinatorTools.test.ts), [paid guard](../../tests/coordinator/paidSpendGuard.test.ts). Add native-host parallel ownership, fresh-context assertions over long histories, and E resource accounting.

## AR-18 — CLI delegation, advisor escalation, cross-review, and verification

**Priority / implemented surface:** P0 for routing/authority, P1 for review usefulness. The coordinator's [host delegation paths](../../src/providers/ChatViewProvider.ts), [ModelRouter](../../src/services/ModelRouter.ts), and [advisor policy](../../src/coordinator/advisor.ts) choose installed backends with validated model/tier/effort. `advisor` tries configured read-only CLI advisers, then an optional paid single-call model fallback subject to consent. Configurable cross-vendor review and verification run after actual edits; diagnostics and suggested commands are not proof that a test suite executed.

**Scenario:** Ask Mysti to delegate an F1 fix to Codex, obtain Claude advice, and request a different-vendor review. Turn `crossReview` on and compare off/on runs. Enable verification, plant a type error, and confirm the coordinator responds to diagnostics and explicitly reports whether proposed tests actually ran. Exercise configured adviser order with the first candidate unavailable.

**Long session:** W, 250 turns with 80 editing delegations, 40 adviser requests, 30 cross-reviews, and 30 verification cycles; E extension alternates backend outages during 750 turns. Include at least one two-workspace run to detect shared native session leakage.

**Faults / boundaries:** Foreign selected-model ID, unavailable strongest model, auth failure, backend failing after editing files, adviser attempting writes, both CLI advisers unavailable, paid fallback denied, no different vendor available, misleading “tests pass” text without execution, and diagnostics still failing after the bounded verification cycle.

**Pass/fail and evidence:** Actual model belongs to the actual backend; edited work is not retried onto another backend in a way that duplicates side effects; advice/review stays read-only and attributable; escalation and bounded cycles match source policy. Unavailable review and unexecuted tests remain explicit limitations. Preserve backend/model trace, write detection, adviser order, consent, diagnostic snapshots, actual command exit codes, and final claims-to-evidence table.

**Existing / new coverage:** [modelRouter](../../tests/services/modelRouter.test.ts), [advisor](../../tests/coordinator/advisor.test.ts), [host persistence](../../tests/integration/chatViewMessagePersistence.test.ts), [trust/gates](../../tests/integration/chatViewTrustAndGate.test.ts). Add real cross-vendor post-edit workflows, unavailable-review UX, and verification-claim accuracy.

## AR-19 — Explicit Mysti orchestration DAG and lane scheduling

**Priority / implemented surface:** P0. The deliberate `orchestrate` prefix enters [MystiOrchestratorManager](../../src/managers/MystiOrchestratorManager.ts) through [ChatViewProvider](../../src/providers/ChatViewProvider.ts). [OrchestratorDag](../../src/services/OrchestratorDag.ts) validates tasks/dependencies; the manager schedules eligible frontiers through bounded lanes and synthesizes results. Ordinary Mysti turns remain inline. Boost can affect lane budgets, and single-lane plans can return to inline work instead of pretending to be parallel orchestration.

**Scenario:** In F2 request `orchestrate` a change requiring independent API/test/UI discovery, one implementation after discovery, and verification after implementation. Supply executable fixture acceptance tests. Inspect the proposed dependency graph and actual lane starts, then change one requirement in a follow-up and require a fresh graph.

**Long session:** W, 250 turns with 50 multi-frontier DAGs, 20 single-lane fallbacks, and 20 plans with a blocked dependency. E extension uses 200 DAGs with 1,000 total nodes and alternating Boost profiles.

**Faults / boundaries:** Cyclic graph, unknown dependency, duplicate IDs, empty/malformed decomposition, unavailable lane, dependency failure, cancelled frontier, synthesis outage, wide graph beyond capacity, and task text claiming more authority than the parent granted.

**Pass/fail and evidence:** Invalid graphs fail visibly before execution; only ready nodes start; failed dependencies block descendants without fabricated results; concurrency and write serialization hold; final synthesis reports completed, blocked, and failed tasks accurately. Main acceptance tests and diff scope determine task success, independent of “done” wording. Keep raw/validated graph, node timing, handoff content, selected lanes, terminal states, and final executable evidence.

**Existing / new coverage:** [orchestrator manager](../../tests/managers/mystiOrchestratorManager.test.ts), [DAG](../../tests/services/orchestratorDag.test.ts), [lanes](../../tests/services/orchestratorLanes.test.ts), [agent map signals](../../tests/integration/agentMapHostSignals.test.ts). Add real multi-frontier workday and invalid-model-decomposition native tests.

## AR-20 — Plan modes, plan options, native exit-plan, and approval handoff

**Priority / implemented surface:** P0. Quick/detailed plan modes, detected plan options, and native plan approvals are handled by [PlanOptionManager](../../src/managers/PlanOptionManager.ts), [ResponseClassifier](../../src/managers/ResponseClassifier.ts), [PendingPlanStore](../../src/chat/PendingPlanStore.ts), and [ChatViewProvider](../../src/providers/ChatViewProvider.ts). Plan mode normalizes effective authority to read-only; selecting a current plan may transition to the approved implementation path. Text classification and a provider-native `exit_plan_mode` event are separate input paths.

**Scenario:** Ask for two F2 migration options in quick and detailed planning modes. Select the conservative option, inspect the access transition, then implement and test it. Repeat with Claude's native plan flow and a provider using text detection. Cancel selection, edit requirements, regenerate, and attempt to click the old card.

**Long session:** W, 250 turns with 60 plan→selection→implementation sequences, 30 abandoned plans, and 20 two-panel overlapping plan prompts. P extension retains conversations overnight and verifies stale native requests are not executable after restart.

**Faults / boundaries:** Malformed options, false-positive plan prose, classifier unavailable, unsupported choice, duplicate clicks, user response racing semi-autonomous timer, switch/new/delete/fork during selection, and old native-plan callbacks after a successor run.

**Pass/fail and evidence:** No file change while planning, one current selection commits at most once, chosen plan and approved mode/access reach the correct provider, and stale plans cannot act on another turn or panel. Record effective settings before/after, classifier source/result, pending request IDs, dispatch count, file hashes, and F2 acceptance results. UI showing a plan card is not proof that native execution resumed safely.

**Existing / new coverage:** [pendingPlanStore](../../tests/chat/pendingPlanStore.test.ts), [chatPlanIsolation](../../tests/integration/chatPlanIsolation.test.ts), [chatPermissionLifecycle](../../tests/integration/chatPermissionLifecycle.test.ts), [host persistence](../../tests/integration/chatViewMessagePersistence.test.ts). Add cross-provider native/text parity and P stale-plan replay.

## AR-21 — Effective trust modes and permission lifecycle

**Priority / implemented surface:** P0. [PermissionManager](../../src/managers/PermissionManager.ts), [permission classification](../../src/utils/permissionClassifier.ts), [host gate routing](../../src/providers/ChatViewProvider.ts), and provider-native approval bridges implement read-only/ask/full-access and plan/ask/auto trust surfaces. Native pre-execution approval and legacy process-pause gating have different enforcement capabilities; test each supported provider path. Configuration includes `defaultMode`, `accessLevel`, `permission.timeout`, and `permission.timeoutBehavior`.

**Scenario:** In disposable F1/F4 repositories request a read, file edit, shell command, and representative external action. Deny once, allow once, then use a persistent grant in one panel and test an identical request in another panel and workspace. Repeat for main provider, mention child, Brainstorm child, native Mysti, and a background job. Test read-only and explicit full-access modes without interpreting broad access as approval for forced external/paid-consent gates.

**Long session:** E, 750 turns and at least 1,000 permission events; 100 simultaneous questions/gates across two panels, 100 deny/Stop paths, 50 timeout paths, and 50 grant revocations. P extension verifies precisely which grants persist and which are session-owned.

**Faults / boundaries:** Spoofed source/request IDs, stale replies, double click, request after Stop, failure to pause a legacy process, tool payload changing after display, timeout 0 versus finite values, extension reload with pending gates, and workspace settings attempting to relax machine-scoped authority.

**Pass/fail and evidence:** Zero unauthorized side effects; displayed operation matches execution; decisions affect only the owning request/session scope; expiry and cancellation resolve once; unsupported enforcement fails closed as implemented, with any documented web-request exception separately characterized. Save gate/tool payload hashes, process pause state, actual filesystem/network audit, grant store, and timing. A rendered card or reassuring response does not establish enforcement.

**Existing / new coverage:** [permission gating](../../tests/integration/permissionGating.test.ts), [permission origin](../../tests/integration/permissionOrigin.test.ts), [permission lifecycle](../../tests/integration/chatPermissionLifecycle.test.ts), [grant scoping](../../tests/managers/permissionGrantScoping.test.ts), [scoping](../../tests/managers/permissionScoping.test.ts), [fail-closed helpers](../../tests/utils/permissionGateFailClosed.test.ts), [mention safety](../../tests/managers/mentionNativeApprovalSafety.test.ts). Add actual process/filesystem/network evidence across the eligible provider matrix.

## AR-22 — Autonomous goals, task queues, safety decisions, and continuation

**Priority / implemented surface:** P0. [`mysti.toggleAutonomous`](../../src/extension.ts) and the chat activation flow use [AutonomousManager](../../src/managers/AutonomousManager.ts), [SafetyClassifier](../../src/managers/SafetyClassifier.ts), and [host continuation gates](../../src/providers/ChatViewProvider.ts). Activation is session-only; a goal or explicit task queue drives continuation. Safety mode, allow flags, block patterns, remembered decisions, and maximum session duration affect behavior. The manager's global active session versus panel state needs the ownership contract resolution stated above.

**Scenario:** Give F1 a goal with five externally verifiable acceptance criteria, then a separate explicit queue: reproduce bug, add regression, fix, run tests, summarize. Observe one initial submission followed by internal continuation. Interrupt with a changed requirement, deactivate, and verify no further task begins. Repeat in a second panel while the first remains open; the old panel must not inherit the new goal accidentally.

**Long session:** E, 750 user turns interspersed with at least 200 autonomous continuation turns and 20 task queues; use a short configured maximum for boundary tests and a separate genuine maximum-duration observation. P extension restarts daily and confirms autonomy is not silently reactivated after shutdown.

**Faults / boundaries:** Model says “done” before tests pass, embeds completion markers in quoted logs, repeats a task forever, encounters blocked/caution operations, has an empty queue, hits max duration, loses authentication, or finishes while conversation switching. Inject configured block patterns and disabled file-create/edit/bash flags.

**Pass/fail and evidence:** Continuation has an unambiguous owner, preserves current user corrections, advances queue items exactly once, stops on deactivation/duration/terminal failure, and never converts a blocked decision into approval. Fixture assertions independently determine goal completion; premature self-declared success is a quality failure. Record activation source, queue index/history, continuation reasons, classifier decisions, audit/stat counters, actual side effects, and final tests.

**Existing / new coverage:** [autonomous continuation gate](../../tests/integration/autonomousContinuationGate.test.ts), [safetyClassifier](../../tests/managers/safetyClassifier.test.ts), [memoryManager](../../tests/managers/memoryManager.test.ts). Add direct manager goal/queue lifecycle tests, multi-panel ownership resolution, real max-duration, and P restart coverage; existing gates alone do not prove goal completion.

## AR-23 — Semi-autonomous permission, question, and plan decisions

**Priority / implemented surface:** P0. The host's [semi-autonomous timers and answer routing](../../src/providers/ChatViewProvider.ts) cover eligible permissions, questions, and plan selections, with `mysti.semiAutonomous.timeout` and permission timeout behavior. They are distinct from autonomous goal continuation. Decisions may use classification/memory/model assistance but must preserve the original request's authority and ownership.

**Scenario:** In F2 enable semi-autonomous behavior, allow one safe permission countdown to expire, answer a second manually, let a low-confidence product question require human input, and select a plan just before its timer fires. Repeat with two children asking different questions and a background job awaiting its own decision. Disable the mode while a countdown is active.

**Long session:** W, 250 turns and at least 150 timed decisions: 50 permissions, 50 questions, 50 plans. E extension adds 200 manual/timer races near the configured boundary and periods of machine sleep/resume. Test supported minimum/maximum timeout settings as well as the default.

**Faults / boundaries:** Timer fires after Stop, old question ID reused in another conversation, slow classifier returns after a manual answer, provider unavailable, ambiguous plan, forgotten learned preference, cancelled countdown, and machine clock/suspension skew.

**Pass/fail and evidence:** Exactly one decision acts on the correct current request; manual decisions win when already committed; stale async results cannot continue work; low confidence and forced-consent operations retain their required gate. Show what was decided automatically and why. Capture monotonic timing, request/turn IDs, decision provenance/confidence, effective access before/after, and side-effect counts. Do not accept a timer simply disappearing as evidence of safe resolution.

**Existing / new coverage:** [chatPermissionLifecycle](../../tests/integration/chatPermissionLifecycle.test.ts), [chatPlanIsolation](../../tests/integration/chatPlanIsolation.test.ts), [permission manager](../../tests/integration/permissionManager.test.ts), [memoryManager](../../tests/managers/memoryManager.test.ts). Add native timed question/plan matrix, suspended-machine replay, and decision-race stress coverage.

## AR-24 — Learned preferences, project auto-memory, and project context

**Priority / implemented surface:** P0 for isolation/authority, P1 for usefulness. [MemoryManager](../../src/managers/MemoryManager.ts) stores learned decision preferences and project memory, while host context building consumes project guidance. `/memory` in [SlashCommandManager](../../src/managers/SlashCommandManager.ts) opens project `MEMORY.md`. `autoMemory.enabled`, `projectContext.enabled`, and `autonomous.maxMemoryEntries` govern separate behaviors; opening a file is not the same as editing the autonomous preference store. Memory confidence/decay and project scoping must be measured.

**Scenario:** In F2 teach “use the repository's existing test runner” and a safe recurring question preference, then work across 50 intervening turns. Inspect `/memory`, edit an obsolete project fact, and ask a new provider to use the corrected convention. In another workspace use the opposite convention and ensure no contamination. Disable auto-memory and project-context injection independently.

**Long session:** P, 1,000 turns with 50 legitimate learned preferences, 250 project learnings, and a controlled sequence exceeding the configured preference cap; shutdown each night, alternate workspaces daily, and revisit an old frequently used versus stale low-confidence preference. Exercise the 200-line project-memory boundary.

**Faults / boundaries:** Corrupt/missing/unwritable memory file, old schema, duplicate/conflicting preference, huge or malicious MEMORY.md, prompt-injection “always approve” text, external edit during use, and global-state write failure.

**Pass/fail and evidence:** Project facts stay project-scoped; explicit corrections become observable; caps and decay follow policy; disabled features stop their own writes/injection; untrusted memory cannot authorize actions or override current instructions. Retain redacted memory snapshots, scope keys/paths, prompt injection blocks, confidence changes, actual decisions, and recall checks with known answers. Lost approved memory after restart and cross-project leakage are failures.

**Existing / new coverage:** [memoryManager](../../tests/managers/memoryManager.test.ts), [host trust/gates](../../tests/integration/chatViewTrustAndGate.test.ts), [autonomous continuation](../../tests/integration/autonomousContinuationGate.test.ts). Add five-day persistence, project-file edit workflow, schema/cap/decay combinations, and model behavior checks beyond storage correctness.

## AR-25 — Coordinator cross-backend memory and user pruning

**Priority / implemented surface:** P0 for trust, P1 for retention. [MystiMemoryStore](../../src/services/MystiMemoryStore.ts) and the coordinator's `remember` tool persist per-workspace facts in workspace state and inject a bounded digest into future delegations. Current limits are 40 stored entries, 400 characters per fact, and a default digest of 20. Model-authored facts are untrusted. The `host` source type exists but has no live writer; do not count automatic host-authored operational memory as a shipped feature. [`mysti.viewMystiMemory`](../../src/extension.ts) exposes review and exact-entry deletion.

**Scenario:** Teach Mysti F1's retry invariant, delegate follow-ups alternately to Claude and Codex, and check both receive the same relevant fact. Record a corrected fact, view the list, cancel pruning once, then remove the obsolete entry and confirm later prompts omit it. Disable `mysti.mysti.memory` and verify effective behavior.

**Long session:** P, 1,000 turns with 100 candidate facts, 20 repeated facts with case/whitespace differences, daily pruning, two workspaces, and 100 cross-backend delegations after overnight restarts.

**Faults / boundaries:** Overlong/blank/duplicate facts, cap eviction with frequently used versus stale entries, malformed persisted records, failed state write, injection masquerading as a trusted host fact, and stale UI deletion after a concurrent update.

**Pass/fail and evidence:** Dedupe/caps/eviction are predictable; deletion affects precisely the selected entry; Escape changes nothing; workspace facts never leak; model memory remains fenced and cannot grant permissions. Save before/after entries and digest, actual delegate prompts, provenance tags, restart observations, and reference-question answers. Storage success alone does not prove useful recall.

**Existing / new coverage:** [mystiMemoryStore](../../tests/services/mystiMemoryStore.test.ts), [coordinator tools](../../tests/services/coordinatorTools.test.ts), [host trust/gates](../../tests/integration/chatViewTrustAndGate.test.ts). Add command-to-prompt pruning, multiwindow persistence, and five-day eviction/recall evidence.

## AR-26 — Checkpoints, code rewind, conversation forks, and undo

**Priority / implemented surface:** P0. [CheckpointManager](../../src/managers/CheckpointManager.ts) snapshots the worktree in a private Git repository outside the project. [ChatViewProvider](../../src/providers/ChatViewProvider.ts) connects before-turn capture, rewind, conversation fork, and fork-and-rewind. Rewind takes a safety snapshot for Undo. Retention and file-count caps are configurable; normal excludes omit build/cache/binary junk, while agent-authored `.mysti/agents` and `.mysti/skills.staged` artifacts are deliberately captured. This is scoped workspace recovery, not a whole-machine backup.

**Scenario:** In F1 make user edits, run a three-turn agent change that creates/modifies/deletes files, then rewind to each pre-turn state, Undo, and fork a conversation. Verify history and worktree combinations separately for fork-only and fork-and-rewind. Include untracked source, ignored dependencies, and staged agent artifacts; compare the user's actual `.git` status/index/refs before and after.

**Long session:** P, 1,000 turns and more than 200 checkpoints, with 50 rewinds, 25 undos, and 25 forks. Run a separate F3 profile over the configured file limit and once with an explicitly safe custom limit; measure snapshot lag against the main plan's proposed thresholds.

**Faults / boundaries:** Git missing/hung, full disk, unreadable file, interrupted snapshot, rapid first write racing capture, external user edits before rewind, expired/pruned checkpoint, symlink/adversarial path, and switch/Stop during capture. Use disposable repositories for destructive recovery scenarios.

**Pass/fail and evidence:** Restored eligible files match the intended pre-turn manifest byte-for-byte; ignored content and user Git metadata remain intact; Undo restores the pre-rewind state; expired/skipped snapshots are disclosed; no stale capture associates with another turn. Capture manifests, private snapshot refs, user Git state, retention counts, file-limit decision, confirmation outcome, and conversation lineage. A success toast without exact file comparison fails the oracle.

**Existing / new coverage:** [checkpoint retention](../../tests/managers/checkpointRetention.test.ts), [artifact tracking](../../tests/managers/checkpointArtifactTracking.test.ts), [host persistence](../../tests/integration/chatViewMessagePersistence.test.ts). Add native fork/rewind/undo transactional scenarios and P retention with real crash/reload.

## AR-27 — Manual and automatic compaction with provider-owned history

**Priority / implemented surface:** P0. `/compact` and threshold compaction use [CompactionManager](../../src/managers/CompactionManager.ts) and [host compaction routing](../../src/providers/ChatViewProvider.ts). History ownership/capabilities determine native CLI compaction versus Mysti-owned full-history summarization; recent-history or no-history providers must not be silently reset as if they were full-history HTTP providers. Automatic thresholds must use current context pressure, not accumulated lifetime token spend.

**Scenario:** Create a 30-decision F2 task history with exact sentinel requirements, then cross the configured threshold on a native-compaction provider and a Mysti-full-history provider. Trigger `/compact` manually before and during active work. After compaction ask for old constraints and implement a change relying on them. Exercise an unsupported/recent-history provider for honest behavior.

**Long session:** E, 750 turns, at least 30 native and 30 client-owned compactions, with 20 Stop/switch/successor overlaps and idle/resume. P extension reopens compacted conversations on all five days and checks state/session identity.

**Faults / boundaries:** Missing/zero/unknown usage, large lifetime total with small current context, no native support, failing native compact command, truncated summary, token window/model change, compaction never resolves, and delayed completion from an old conversation.

**Pass/fail and evidence:** Correct history owner controls the operation; native sessions are not silently discarded; thresholds use normalized context facts; compaction occurs at most once per eligible in-flight owner; waiting sends resume or cancel correctly. Sentinel constraints remain recoverable and implemented correctly. Save input window/usage, ownership decision, native command or client summary, transcript/session IDs, recall answers, timings, and resulting tests.

**Existing / new coverage:** [compaction ownership](../../tests/managers/compactionOwnership.test.ts), [token math](../../tests/managers/compactionTokenMath.test.ts), [Boost overlay](../../tests/managers/compactionBoostOverlay.test.ts), [host persistence](../../tests/integration/chatViewMessagePersistence.test.ts). Add real native/client parity, E retention quality, and P restore rather than assuming compaction storage proves continuity.

## AR-28 — Smart compaction, incremental summaries, and history retrieval

**Priority / implemented surface:** P1; opt-in/account-gated. [SmartCompactor](../../src/managers/SmartCompactor.ts), [RetrievalCoordinator](../../src/managers/RetrievalCoordinator.ts), and [HistoryStore](../../src/services/HistoryStore.ts) implement gateway-backed summarization with a quality floor, cache/economic timing, incremental structured sections, and relevant-history retrieval. `compaction.smart.*` settings control enablement, model, summary floor, and retrieval. Disabled or unavailable entitlement must use truthful fallback behavior; it is not proof of smart-path coverage.

**Scenario:** In F2 record evolving Goal/Decisions/Files/Code/Open Threads, compact, then change only one section and inspect the incremental update. After 100 unrelated turns ask about an earlier dismissed approach whose details only exist on disk. Compare retrieval enabled/disabled and a prompt that needs no historical retrieval. Use controlled records with exact old facts and dates.

**Long session:** P, 1,000 turns with 50 smart compactions, 100 retrieval-eligible questions, 100 retrieval-ineligible questions, and real overnight shutdown. E companion run spans cache expiry and retrieval cooldown boundaries without restarts.

**Faults / boundaries:** Account entitlement revoked/expired, gateway timeout, malformed delta patch, full rewrite response, missing sections, corrupt history file, retrieval score below threshold, duplicate concurrent retrieval, huge old content, and injected instructions in retrieved history. Exercise entitlement success/error-cache windows and model/cache cost uncertainty.

**Pass/fail and evidence:** Unchanged sections remain stable when incremental policy requires it; invalid updates do not corrupt the last valid summary; retrieval returns relevant attributable facts within its budget/cooldown and treats them as untrusted data. Quality floor is honored and fallback disclosed. Keep summary diffs, section hashes, raw patch validation, retrieval IDs/scores, entitlement state, economic inputs, actual costs, and exact-answer recall scores. No savings claim passes without measured comparable usage and quality.

**Existing / new coverage:** [smartCompactor](../../tests/managers/smartCompactor.test.ts), [summary memory](../../tests/managers/smartCompactorMemory.test.ts), [retrievalCoordinator](../../tests/managers/retrievalCoordinator.test.ts), [historyStore](../../tests/services/historyStore.test.ts). Add signed-account native integration and P quality/cost comparison; unavailable account leaves those cases blocked.

## AR-29 — Token/cache accounting, cost attribution, and paid-call consent

**Priority / implemented surface:** P0. [TokenAccounting](../../src/services/TokenAccounting.ts), [ModelPricing](../../src/services/ModelPricing.ts), [PromptCache](../../src/services/PromptCache.ts), pool usage folding, and [PaidSpendGuard](../../src/coordinator/PaidSpendGuard.ts) normalize backend usage and track coordinator paid calls. Anthropic-style cache read/write tokens and OpenAI-style cached subsets have different accounting semantics. Per-turn context, cumulative tokens, estimates, actual cost, and unknown values must remain distinct. Budget 0 means every eligible paid call asks; it does not mean paid calls are impossible.

**Scenario:** Replay known usage packets through direct, native-child, CLI-child, session, Brainstorm, and background work, then compare with provider-reported totals from authorized test runs. Configure a small paid budget; request a known-price call below it, one above remaining allowance, and an unknown-price call. Deny/approve and compare reservations with settled actuals. Actual paid execution belongs to a later authorized run, not this plan preparation.

**Long session:** E, 750 turns with 3,000 usage updates, streaming cumulative/delta/final packets, cache-hit and cold calls, 100 cancelled/failed lanes, and 100 controlled paid-budget decisions. P extension validates persisted/lifetime totals and two-window merge without counting the same turn twice.

**Faults / boundaries:** Duplicate final usage, missing/negative/nonfinite values, price absent/stale, unknown model, estimated cost never settled, zero output, cached tokens exceeding stated input, paid batch request, concurrent reservations, and cancellation between approval and dispatch.

**Pass/fail and evidence:** Independent arithmetic matches the ledger for each provider's schema; no double-counting or fabricated zero cost; child/job cost attributes to the actual run; consent happens before an out-of-budget/unknown-price paid call and denial sends no paid request. Actual settlement replaces estimates accurately and missing actuals stay approximate. Archive sanitized packets, independent spreadsheet/script calculation, price/model snapshot, reservation/settlement events, screenshots, and account totals with their reporting lag documented.

**Existing / new coverage:** [tokenAccounting](../../tests/services/tokenAccounting.test.ts), [modelPricing](../../tests/services/modelPricing.test.ts), [promptCache](../../tests/services/promptCache.test.ts), [pool usage](../../tests/services/collaboratorPoolUsage.test.ts), [paid guard](../../tests/coordinator/paidSpendGuard.test.ts), [Boost ledger wiring](../../tests/integration/boostLedgerWiring.test.ts). Add native end-to-end reconciliation and E concurrent-owner ledger audit; static rates alone cannot prove a current external bill.

## AR-30 — Boost profiles, explicit-setting precedence, and savings ledger

**Priority / implemented surface:** P1. [BoostManager](../../src/managers/BoostManager.ts), [CompactionManager](../../src/managers/CompactionManager.ts), [ModelRouter](../../src/services/ModelRouter.ts), and [`mysti.boostSummary`](../../src/extension.ts) implement an opt-in economy/balanced/quality overlay. Profiles affect eligible compaction/model/fan-out defaults, cold-resume behavior, and counters. Explicit settings retain precedence; authority, access, and autonomy are not relaxed by Boost. “Measured-better” or savings language must be proven by the planned comparison rather than inferred from counters.

**Scenario:** Run the same seeded F2 issue sequence with Boost off and each profile, freezing eligible model snapshots for fair comparison. Set a user compaction threshold and workspace override, toggle Boost, and inspect actual effective values. Resume a large-context conversation after more than an hour idle and contrast small/unknown context. Open summary/status UI before/after and in a second window.

**Long session:** Four W arms, each 250 turns/8h; include 20 explicit override changes, ten cold resumes, and at least 30 delegations per arm. P extension checks session versus lifetime counters across daily shutdown and two-window updates.

**Faults / boundaries:** Malformed profile, explicit false/zero setting, missing smart entitlement, unknown usage during idle, repeated cold-resume notification, model-routing failure, ledger write race, and toggling during an active turn.

**Pass/fail and evidence:** Overlay applies only when enabled and only where no explicit setting wins; effective limits match profile policy; no authority change; counters update once and merge across windows. Cold handling fires only on its actual time/context criteria. Compare task correctness, duration, calls, tokens, cost, and user interventions before asserting improvement; a quality regression fails even with fewer tokens. Retain effective-config snapshots, execution traces, summary totals, and paired benchmark results.

**Existing / new coverage:** [boostManager](../../tests/managers/boostManager.test.ts), [compaction overlay](../../tests/managers/compactionBoostOverlay.test.ts), [modelRouter](../../tests/services/modelRouter.test.ts), [ledger wiring](../../tests/integration/boostLedgerWiring.test.ts). Add four-arm workday quality/cost study and P multiwindow persistence.

## AR-31 — Detached background jobs, ownership, persistence, and recovery

**Priority / implemented surface:** P0. Mysti `bg:`/`background:` dispatch in [ChatViewProvider](../../src/providers/ChatViewProvider.ts) uses [BackgroundJobManager](../../src/managers/BackgroundJobManager.ts) for detached job IDs, owner panel/conversation, bounded per-host concurrency, stored results, heartbeat, and recovery status. Jobs can outlive their chat panel; foreground Stop is distinct from explicit Stop job. Persisted metadata does not mean the underlying computation resumes after host shutdown. Stale running records become interrupted, while another live window's fresh work must not be overwritten.

**Scenario:** Start three F2 read-only background investigations, then continue foreground implementation questions. Attempt a fourth job, close the originating chat, reopen the jobs/map surface, and inspect completion. Stop one job explicitly while another awaits its own permission. Launch jobs from two VS Code windows/workspaces and observe each owner's controls. Use the actual job list/map actions; no `/jobs` slash entry was established by the source inventory.

**Long session:** E, 750 foreground turns plus 150 background jobs, at least 30 panel closures and 20 explicit job cancellations. P extension runs 1,000 turns across real shutdowns and over 60 retained job records to exercise retention; use an abrupt disposable-host termination to verify interrupted recovery.

**Faults / boundaries:** Bare prefix, max concurrency, owner panel disposed with a pending gate, stale heartbeat, fresh foreign-window job, machine sleep beyond stale interval, duplicate completion, storage conflict, job failure after partial output, and old cleanup after a replacement run.

**Pass/fail and evidence:** Foreground remains usable; each job's data/permissions/cancellation stay owned; foreground Stop does not kill detached work, while Stop job ends its process tree and gates. Completion notification occurs once, results stay attributable, fresh other-window work is preserved, and interrupted jobs are not shown as successfully resumed. Record job states, owner IDs, heartbeat/storage merges, process inventory, notifications, retained record count, and actual results.

**Existing / new coverage:** [backgroundJobManager](../../tests/managers/backgroundJobManager.test.ts), [host persistence](../../tests/integration/chatViewMessagePersistence.test.ts), [permission lifecycle](../../tests/integration/chatPermissionLifecycle.test.ts), [agent map signals](../../tests/integration/agentMapHostSignals.test.ts). Add native two-window/overnight/crash scenarios and foreground responsiveness measurements.

## AR-32 — Agent lifecycle, idle shutdown, active-child protection, and restart

**Priority / implemented surface:** P0. [AgentLifecycleManager](../../src/managers/AgentLifecycleManager.ts), provider lifecycle implementations, and host lifecycle controls register processes, mark work busy/idle, inspect descendants, protect active children, and shut down idle sessions according to `mysti.lifecycle.*`. Explicit shutdown and Stop are related but different operations. Platform process-tree support and wrapper/native process ownership must be established, especially where a CLI launches another executable.

**Scenario:** Run a persistent Claude/Codex session, leave it idle past a configured boundary, and resume the same conversation. In a second run start a controlled child process and verify active-child protection; repeat with tracking/protection disabled under a disposable fixture. Test explicit shutdown while busy and while idle, then send another turn. Include the Copilot wrapper/native-child path where available.

**Long session:** E, 750 turns with 50 idle/resume cycles and 50 explicit shutdown/restart cycles; include actual default-length idle periods, not only accelerated timers. P extension tracks processes across all five daily shutdowns. Repeat core ownership cases on each supported OS rather than generalizing from one process model.

**Faults / boundaries:** Missing/stale PID, exited/reused PID, orphan descendant, frozen child, inaccessible process tree, polling failure, provider exits between check and kill, old provider cleanup after replacement, system sleep, and a child that ignores graceful termination.

**Pass/fail and evidence:** Lifecycle settings control actual behavior; protected active work is not killed, owned stopped work and descendants do terminate, unrelated/replacement processes remain alive, and UI state explains blocked shutdown. Resumed conversation follows that backend's supported continuity contract without invented retained context. Capture PID/parent/start-time inventory, lifecycle events, protected reason, OS-level liveness, session IDs, and continuation recall. A green terminal card alone does not prove cleanup.

**Existing / new coverage:** [agentLifecycleManager](../../tests/managers/agentLifecycleManager.test.ts), [persistent lifecycle](../../tests/providers/base/persistentLifecycle.test.ts), [single-shot lifecycle](../../tests/providers/base/singleShotLifecycle.test.ts), [processKill](../../tests/utils/processKill.test.ts), [Copilot ownership](../../tests/providers/copilot/processOwnership.test.ts). Add real idle timing, OS matrix, and five-day zero-orphan audit.

## AR-33 — Agent map, workflow activity, needs, and actionable ownership

**Priority / implemented surface:** P1 for visibility, P0 for actions that stop/approve work. [agentMap.js](../../media/chat/agentMap.js), [chat event integration](../../media/chat/chat.js), and [host signals](../../src/providers/ChatViewProvider.ts) render collaborators, coordinator children, sessions, Brainstorm phases, DAGs, background jobs, tools, waiting needs, results, and timing. Map actions include reveal-in-chat, ask another agent, review a need, Stop turn, or Stop job where applicable. Progress pings can indicate liveness without disclosing hidden reasoning; no thought-content output is required.

**Scenario:** Run one example of every workflow above in two conversations. Open map during streaming, filter waiting/working/failed, inspect a child, review its permission, reveal its chat card, ask another agent a follow-up, and stop only the selected work scope. Leave a job detached while switching foreground conversations. Use keyboard navigation and a narrow viewport as well as pointer interaction.

**Long session:** E, 750 turns producing at least 2,000 child/tool events, 100 needs, 100 completed jobs, and repeated open/close/filter cycles. P extension reopens persisted conversations and jobs daily. Include one dense 100-node visible workflow/state replay for UI performance while keeping product model limits intact.

**Faults / boundaries:** Out-of-order/missing/duplicate terminal events, tool ID collision across runs, late event after reset, unknown request owner, deleted chat anchor, failed lazy module load, stalled stream versus legitimate approval wait, unavailable alternate agent, and foreign-window jobs that cannot be stopped here.

**Pass/fail and evidence:** Map state agrees with authoritative host events and actual processes; waiting is not misclassified as failure, failed/completed nodes do not revert to working, and controls target exactly the owned turn/job/request. Conversation reset clears old foreground state while retaining appropriate jobs. Focus, scroll, filters, and keyboard behavior remain usable under updates. Keep event replay, node/need snapshots, screenshots/video, action request IDs, process results, accessibility observations, and heap/render timing versus proposed thresholds.

**Existing / new coverage:** [agentMap](../../tests/webview/agentMap.test.ts), [loader](../../tests/webview/agentMapLoader.test.ts), [host signals](../../tests/integration/agentMapHostSignals.test.ts), [collaboration browser](../../tests/webview/collaborationBrowser.test.ts), [conversation lifecycle browser](../../tests/webview/conversationLifecycleBrowser.test.ts). Add E visual/state reconciliation and native keyboard/action ownership across all workflow types.

## AR-34 — Executable skill publication, registered calls, integrity, and health

**Priority / implemented surface:** P0; opt-in and sandbox-dependent. Host `_runMystiPublish`/`_runMystiSkillRun` in [ChatViewProvider](../../src/providers/ChatViewProvider.ts), [directive parser](../../src/utils/mystiDelegateParser.ts), [CapabilityManifest](../../src/services/CapabilityManifest.ts), [CapabilityRegistry](../../src/services/CapabilityRegistry.ts), [ObservedRuns](../../src/services/ObservedRuns.ts), [CapabilityLedger](../../src/services/CapabilityLedger.ts), and [MystiLocalExec](../../src/services/MystiLocalExec.ts) implement the executable capability path. It requires skills `full`, local execution enabled, workspace trust, and an available OS sandbox. Prose retrieval and ordinary proposal review are distinct companion EW-17 cases.

Publication validates a staged `mysti.tools.json`, checks declared scripts/egress, asks two forced interactive approvals, records host-observed command evidence, promotes the artifact, and pins its folder hash. **No trial execution or determinism smoke test runs during publication**, despite an outdated preceding method comment. Do not present publication as proof of correctness. Code previews are truncated at a source-defined length; review usability must be evaluated. Invocation validates closed-schema JSON arguments, checks current bytes, uses a host-owned args file and interpreter command, requests approval, checkpoints, executes in the sandbox, and records observed success/failure/denial. Current health thresholds quarantine after two consecutive failures and stop offering after four; the recovery contract discrepancy above is open.

**Scenario:** In F1, have Mysti stage a small offline `retry_check` script with known good/bad fixtures, a manifest, and a reference to one genuinely host-observed successful command. Inspect then deny each publication card in separate runs; approve both in the next run. Call the registered tool with valid arguments, invalid extra fields, and malicious shell-looking strings that must remain data. Change script bytes externally and verify refusal until reapproval. Run a failing version repeatedly, inspect the health report, fix/republish, then test actual recovery. Test quarantine-all and reopen behavior through the companion artifact controls.

**Long session:** P, 1,000 turns with 100 publications/republications and 300 calls across 25 artifacts; alternate success, denial, timeout, two-failure quarantine, and four-failure suppression. Shutdown overnight and recheck registry pins and ledger state. Use deterministic clock fixtures for 60-day aging; a five-day run does not establish 60-day aging by elapsed time.

**Faults / boundaries:** Missing/invalid manifest, duplicate tool names across artifacts, missing interpreter/sandbox, symlink/path escape, undeclared network, network disabled, absent observed-command evidence, script modified between the two cards or while invocation approval is pending, large preview hiding changed bytes, stale approval after Stop, args-file tampering/cleanup, and process timeout. Test off/prose/full tiers separately; a disabled parser must not accidentally run an emitted tag.

**Pass/fail and evidence:** No staged script executes or becomes callable without its required publication approvals; publication claims only checks actually performed. Every call binds approved code and schema, denies drift, stays within declared/allowed filesystem/network authority, and leaves no temp/process residue. Denial is neutral in the ledger; actual failed execution increments failure independently of the model's claim. Useful output must match F1's executable oracle. Recovery must match shipped health copy or remain a failed contract case. Capture code/manifest/pin hashes at each gate, staged/live trees, approval IDs, observed-command records, sandbox audit, args-file lifecycle, independent result, and persisted health report.

**Existing / new coverage:** [manifest](../../tests/services/capabilityManifest.test.ts), [registry](../../tests/services/capabilityRegistry.test.ts), [ledger](../../tests/services/capabilityLedger.test.ts), [observed runs](../../tests/services/observedRuns.test.ts), [local execution](../../tests/services/mystiLocalExec.test.ts), [authoring invariants](../../tests/integration/skillAuthoringInvariants.test.ts), [skill directives](../../tests/utils/mystiSkillDirective.test.ts). Add native two-card publication→call→drift→republish journey and actual race/cleanup/health integration; structural tests do not prove the full approval transaction.

## AR-35 — Changes dock, real disk differences, attribution, and revert boundaries

**Priority / implemented surface:** P0 for data preservation, P1 for presentation. Host `requestSessionChanges` in [ChatViewProvider](../../src/providers/ChatViewProvider.ts) compares current eligible worktree files with the first conversation message having a checkpoint via [CheckpointManager.diffSince](../../src/managers/CheckpointManager.ts). [chat.js](../../media/chat/chat.js) derives counts/status from that real diff and joins paths to observed file-edit tool calls for best-effort agent attribution. Unclaimed changes are labeled as likely user changes; file-level attribution cannot prove which hunks belong to whom. Current dock rows open files, and deleted rows are non-openable. Revert is the separate edit-card `revertFileEdit`/Git-command path covered with PC-05; there is no independent dock-specific hunk-safe revert implementation to claim.

**Scenario:** Start F1 with preexisting user edits, let Claude edit file A and Codex create B, manually edit C, then manually change an additional line in A. Open/refresh the dock and compare every path/status/line count against an independent baseline diff. Delete B, add a binary fixture that is eligible under snapshot rules, and test non-ASCII/space-containing paths. Open rows and use only the actual associated edit-card revert control in a disposable copy; inspect whether later user edits to A would be discarded. Compare this operation with AR-26 rewind/Undo, which uses a different baseline and recovery mechanism.

**Long session:** W, 250 turns with 500 changed-file observations, 100 dock refresh/open/close cycles, 50 interleaved user edits, and 30 two-agent/shared-file sequences. P extension spans retained/pruned baseline checkpoints, daily reload, and conversation forks; F3 adds a large-diff rendering/scan profile under the configured file cap.

**Faults / boundaries:** No checkpoint, feature disabled, Git unavailable, pruned or invalid baseline, over-file-cap diff, failed staging, stale async response after conversation switch, absolute versus relative tool paths, tool-reported edit that never reached disk, shell-created changes with no file-edit event, same-path user edits, and deleted rows clicked. Check availability copy distinguishes unknown/unavailable history from “nothing changed” and from checkpoints explicitly off.

**Pass/fail and evidence:** File list/counts reflect actual eligible disk changes, not model prose; the user's own Git index/refs remain untouched by inspection; attribution is qualified and never grants destructive authority. User-only files are not offered for revert. Associated revert must not silently discard new user work or claim checkpoint/hunk semantics it does not implement; any such observed loss is a P0 failure requiring a product fix or explicit correct warning/confirmation contract. Old diff results cannot appear under another conversation. Save independent diff/manifest, tool claim list, UI groups/counts, baseline commit and availability reason, index hashes, actual revert confirmation, and exact before/after contents.

**Existing / new coverage:** [shadow diff](../../tests/managers/shadowDiff.test.ts), [composer/browser changes checks](../../tests/webview/chatComposerBrowser.test.ts), [checkpoint retention](../../tests/managers/checkpointRetention.test.ts). Add host-to-dock native coverage, refresh/switch race, missing-baseline truthfulness, and user-edit preservation tests tied to PC-05. Existing diff parser coverage does not establish attribution or safe revert.

## AR-36 — Direct local reads, edits, multi-file patches, shell, and OS sandbox

**Priority / implemented surface:** P0. [MystiLocalTools](../../src/services/MystiLocalTools.ts) provides bounded workspace `read`/`ls`/`grep` and editor diagnostics, with path containment, secret-name filters, and protected write targets. [MystiLocalExec](../../src/services/MystiLocalExec.ts), [patch envelope parser](../../src/services/mystiPatch.ts), and [MystiSandbox](../../src/services/MystiSandbox.ts) implement opt-in write/edit/add-update-delete-move patch/bash operations. `localExecution=on`, trusted workspace, effective non-plan/non-read-only authority, and AR-21 permission rules are distinct preconditions. `bashNetwork` separately controls egress. macOS uses Seatbelt and Linux uses bubblewrap when available; platforms without an available sandbox permit only the screened genuinely read-only shell subset, not arbitrary test/build scripts. Sandbox reads are broader than workspace reads, with named credential-store exclusions; do not claim complete read isolation or universal secret redaction.

**Scenario:** In F1, use local tools to locate a retry bug, inspect exact lines and diagnostics, edit one unique string, and apply one patch that adds a regression, updates implementation, moves a helper, and deletes obsolete code. Run the fixture's test command in the sandbox, inspect output, then rewind through AR-26. Repeat with duplicate search text requiring explicit replace-all. In F4, attempt a path escape, symlink target, protected agent/config path, synthetic secret file, and denied shell operation, while a separate canary outside the workspace must remain unchanged. Use a local disposable HTTP receiver to prove default egress is blocked and an explicitly enabled/approved network run reaches only the intended test endpoint. Compare disabled execution, plan mode, and no-sandbox behavior.

**Long session:** E, 750 turns, at least 3,000 read/search/diagnostic operations, 200 edits, 100 multi-file patches, and 150 shell runs. F3 adds capped broad searches and large output; F4 supplies 100 containment/secret/protected-path attempts. Include 30 Stop/timeout cases, 30 gate denials, 20 file changes while approval is pending, and 20 interrupted or partially failing filesystem operations. P extension checks no surviving command process or private temp directory after overnight shutdown; run the kernel-enforcement subset independently on macOS and Linux plus a supported no-sandbox environment.

**Faults / boundaries:** Missing workspace, unreadable/binary/oversize file, malformed or ambiguous patch SEARCH, add-existing/move-existing/delete-missing, path with spaces/apostrophe/newline, dangling or swapped symlink, source file changed after validation but before approval, disk full during the write phase, checkpoint unavailable, runaway output, hung command and grandchildren, timeout, denied approval, stale gate after Stop, interpreter/tool missing, shell compound/redirect/remote-effect commands, environment credential leakage, and daemon/launcher escape attempts using disposable fixtures. Test actual command cancellation: current sandbox interfaces expose a timeout but no universal AbortSignal, so Stop correctness needs behavioral proof and cannot be inferred from coordinator cancellation alone.

**Pass/fail and evidence:** Reads/searches show correct line/path facts and explicit truncation within budgets. Rejected patch validation changes zero files; valid patch changes exactly the approved manifest and passes fixture tests. A filesystem failure during apply is allowed to expose a partial change only with truthful failure and usable recovery guidance; do not claim transactional rollback that is not implemented. No denied/out-of-scope write, secret-target direct read, blocked egress, or unrelated process termination is acceptable. Commands obey actual timeout/Stop requirements or produce an explicit defect, outputs have real exit status, and scoped temp/process state cleans up. Save gate payload and file hashes before/after approval, patch parse outcome, checkpoint result, independent test exits, canary/network/environment probes, process trees, truncated output indicators, and OS sandbox profile/availability evidence.

**Existing / new coverage:** [local tools](../../tests/services/mystiLocalTools.test.ts), [local execution](../../tests/services/mystiLocalExec.test.ts), [patches](../../tests/services/mystiPatch.test.ts), [sandbox](../../tests/services/mystiSandbox.test.ts), [coordinator tools](../../tests/services/coordinatorTools.test.ts), [host trust/gates](../../tests/integration/chatViewTrustAndGate.test.ts). Add native full-turn multi-file success/recovery, approval-time mutation races, real kernel/filesystem/network enforcement, and E Stop/descendant/temp cleanup. Mocks and profile-string assertions cannot substitute for the OS matrix.

## Contribution families and coverage handoff

The [package contributions](../../package.json), [extension command registration](../../src/extension.ts), [slash command implementation](../../src/managers/SlashCommandManager.ts), and [webview host message switch](../../src/providers/ChatViewProvider.ts) are the source inventory anchors. This table is a domain handoff, not a replacement for the main plan's machine-readable complete contribution manifest.

| Family / entry point | Cases | Scope notes |
| --- | --- | --- |
| `@agent`, `@agent:role`, `/consult`; `mysti.createRole`; `mysti.collab.maxConcurrent` | AR-01–04 | Role runtime/trust here; complete authoring/catalog distribution in companion domain. Resolve slash-session concurrency-description mismatch. |
| Brainstorm selected agent/mode; `mysti.brainstorm.enabled`, `.strategy`, `.discussionMode`, `.discussionRounds`, `.maxDiscussionRounds`, `.autoConverge`, `.synthesisAgent`, `.agents`; provider-specific persona/custom-prompt settings | AR-05–09 | Every strategy needs its own profile. Verify legacy settings fallbacks and reachable persona wiring. |
| `/review`, `/panel`, `/critique`, `/race`, `/brainstorm`; `startSession`, per-lane Stop | AR-10–14, AR-04 | Session catalog, picker, min/max count, rough estimate, model isolation, read-only runtime; panel/convergence contract discrepancies open. |
| Mysti selection/prefix; `mysti.setCoordinatorModel`; `mysti.mysti.coordinatorModel`, `.freeModels`, `.fallbackModel`; `mysti.openrouter.coordinatorModel` and direct-key route | AR-15 | Complete account/key/model-catalog management also in provider/account domain. No live model availability assumed. |
| `mysti.mysti.maxTurns`, `.maxDelegations`, `.subagentModel`, `.advisorAgents`, `.advisorModel`, `.crossReview`, `.verify` | AR-16–19 | Coordinator, native/CLI children, advice, review, budgets, explicit orchestration. |
| `mysti.mysti.localExecution`, `.bashNetwork`, `.skills`, `.mcpTools`, `.maxMcpCalls`, `.visualTools`, `.maxVisualLooks` | AR-16–18, AR-21, AR-34, AR-36 | Direct local execution/sandbox and executable skills here; catalog, external tools, browser/Canvas capabilities also in companion files. Disabled by default does not remove reachable cases from execution. |
| `mysti.defaultMode`, `mysti.accessLevel`, `mysti.planDetection.enabled`; plan selection/native exit-plan host actions | AR-20–21 | Test effective settings, text/native differences, and stale ownership. Full settings UX belongs to companion UI/config domain. |
| `mysti.permission.timeout`, `.timeoutBehavior`; `mysti.semiAutonomous.timeout`; permission/question/plan responses | AR-21, AR-23 | Timer, gate, request-source, and consent cases cover every owner type. |
| `mysti.toggleAutonomous` and its keybinding; `mysti.autonomous.safetyMode`, `.maxSessionDuration`, `.maxMemoryEntries`, `.blockPatterns`, `.allowFileCreation`, `.allowFileEdit`, `.allowBashCommands`, `.continuationMode` | AR-22–24 | Session-only activation, goal/queue continuation, classification, learned choices, and unresolved multi-panel ownership contract. |
| `/memory`; `mysti.projectContext.enabled`, `mysti.autoMemory.enabled` | AR-24 | Project context and project auto-memory are separate from learned decisions and coordinator memory. |
| `mysti.viewMystiMemory`, `mysti.mysti.memory`, coordinator `remember` tool | AR-25 | Model-written workspace store and prune UI; dormant host writer is not claimed. |
| `mysti.checkpoints.enabled`, `.maxFiles`, `.maxSnapshots`; rewind, fork, fork-and-rewind, Undo | AR-26 | Recovery semantics here; general conversation navigation/export/import in companion UI domain. |
| `/compact`; `mysti.compaction.enabled`, `.threshold` | AR-27 | Provider-owned history is a capability matrix, not one universal compaction implementation. |
| `mysti.compaction.smart.enabled`, `.cheapModel`, `.minSummaryTokens`, `.retrieval.enabled` | AR-28 | Account entitlement/availability blocks real integration coverage if absent. |
| `mysti.mysti.paidBudgetPerTurnUsd`; usage/cache/cost UI and ledgers | AR-29 | Paid advisor/native-child consent, estimates versus actuals; provider billing route details in provider domain. |
| `mysti.boost.enabled`, `.profile`; `mysti.boostSummary` and status item | AR-30 | Setting precedence, profile behavior, cold resume, persistence, and measured quality/cost comparisons. |
| `bg:` / `background:`, request/list/cancel job messages, completion notifications | AR-31 | Detached runtime, concurrency, heartbeat/recovery, two-window state. No independently verified `/jobs` command claim. |
| `mysti.lifecycle.enabled`, `.idleTimeoutMinutes`, `.processTreeTracking`, `.protectActiveChildren`, `.checkIntervalSeconds`; agent shutdown UI | AR-32 | Native process ownership and actual OS behavior must be proven per supported platform. |
| Agent map open/filter/inspect/review/reveal/ask/Stop controls and workflow event families | AR-33 | Content-free progress and owner-bound actions, plus companion UI accessibility checks. |
| Skills `full`, local execution/trust/sandbox opt-ins; `publish`/`skillrun`; capability registry/ledger and observed evidence; `mysti.skillReport`, `mysti.revokeCapabilities` | AR-34, EW-17 | Runtime script path here; prose staging/review and artifact command UX in the companion workspace domain. No publication trial/smoke execution is implemented. |
| `requestSessionChanges`, Changes dock open/refresh/open-file, associated `revertFileEdit` | AR-35, AR-26, PC-05 | Actual disk diff and best-effort attribution here; message edit-card revert and general file actions in PC-05. |
| Coordinator `read`/`ls`/`grep`/`diag`/`write`/`edit`/`patch`/`bash`; localExecution, bashNetwork, sandbox platform availability | AR-36, AR-16, AR-21 | Actual local tool operations, guarded paths, patch validation/partial failure, OS-level enforcement, Stop/timeout/process cleanup. |

## Remaining coverage gaps and execution rules

1. The repository has substantial deterministic manager/service/host/browser tests, but those tests do not establish the proposed W/E/P session lengths, actual provider billing, overnight restore, OS process cleanup, or response usefulness. Preserve that distinction in final reporting.
2. `/panel` synthesis, `/brainstorm` convergence wording, and the collaboration concurrency-setting description require explicit contract resolution. An execution run may characterize them, but cannot certify the advertised feature while leaving the mismatch open. Critique's default “survived” parsing deserves an explicit malformed-output quality check rather than a parser-only pass.
3. Autonomous multi-panel ownership, provider-native plan/approval resumption, checkpoint capture/write ordering, two-window job/ledger persistence, and late stream/compaction completion are mandatory P0 boundaries. Repeat them across real providers after deterministic injection proves the harness.
4. Real collaboration correctness requires assigned-task evidence: reviewers find the planted defects, implementers satisfy fixture tests, advisers disclose uncertainty, and syntheses preserve disagreement. Backend marker/attribution checks are necessary but insufficient for a developer-quality product.
5. Each opt-in/account-dependent feature receives both its disabled/default characterization and its enabled functional/long-session run. Missing entitlements, CLIs, models, OS runners, or test accounts remain explicit blocked cases. Replacing live transport with mocks does not clear the integration block.
6. Proposed thresholds, budgets, and elapsed profiles are acceptance targets, not current product guarantees. Record observed behavior first; failures require a fix/retest or an explicit product contract change, never a quieter oracle.
