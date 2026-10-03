# 11 — The Mysti Orchestrator (coordinator agent + cross-agent routing)

- **Date:** 2026-06-20
- **Status:** DRAFT (gated on [Plan 09](09-mysti-agent-orchestrator.md) + [Plan 10](10-async-substrate-and-security-floor.md), incl. Plan 10 Part 1 security floor)
- **Why this shape:** the adversarial review showed the original "native-vs-CLI dual-mode" + "by-reference firewall briefs" design was fiction against the real code (CLIs take a prompt string; per-panel `HistoryStore` makes cross-panel msgIds undereferenceable; `_interleaveGenerators` has no cap). This plan adopts the review's recommended simplification: **the Mysti agent is a pure coordinator**, every child is an orchestrator-mode CLI/API agent that owns its own window, and the hard parts are split into a shippable D3a and a gated D3b.

---

## Goal

Ship `@mysti`: a first-party coordinator that decomposes a request into a task **DAG**, picks the best **backend** per task, and runs children **sync or async** (via Plan 10) as **gated, isolated sub-agents**, then synthesizes. Cross-agent model routing (the "best model for the task" the user asked for) lives here, honestly scoped. **D3c** generalizes the flat DAG into a **recursive advisor-tree** (project → folder → module → function) for large builds — the scale lever (~2× cheaper at ≥240 functions, flat per-function cost, parallel).

---

## Hard constraints carried from the review (acceptance gates)

1. **Pure coordinator, no dual-mode.** Every child is orchestrator-mode (owns its own context window). Drop "native path owns the full context engine" for v1. Principle "point, don't copy" is **explicitly CLI-path-false**: a CLI child receives a **copied brief** (`task` + path refs it re-reads with its own tools) and returns **copied text**; the plan says so plainly and bounds it with a `returnSpec` size cap.
2. **New dispatch path, not a `MentionRouter` reskin.** `MentionRouter` has `task: string`, no `contextRefs`/`returnSpec`/parallelism. D3a is a genuinely new dispatcher; it may *reuse* `MentionRouter`'s timeout/retry/question-handling patterns but not pretend MentionRouter already supports references.
3. **Bounded concurrency primitive — NOT `_interleaveGenerators`.** Build a real pool with a concurrency cap, per-child timeout, and backpressure (`_interleaveGenerators` eagerly starts all iterators, `:1648`). Also retrofit Plan 08's retrieval fan-out onto it.
4. **Derived panelIds are UUID-scoped:** `${panelId}-orch-${runUuid}-${n}` (never a bare counter) so concurrent/sequential runs never collide in `_panelProviders`/`_panelProcesses`.
5. **Per-child compaction/retrieval disabled:** children are short-lived; `evaluateCompaction` no-ops for `*-orch-*` panels (all compaction/history/usage state is panelId-keyed — `CompactionManager.ts:422`, `SmartCompactor.ts:59`).
6. **Completion is a transport signal,** the provider `done` `StreamChunk` + a **schema-validated `returnSpec`** — never response-text keyword matching (today `AutonomousManager._continueGoal` uses brittle string matching).
7. **Governor persisted in `JobStore`:** depth/concurrency/$ caps per `rootId`; on rehydrate refuse to advance any DAG whose accumulated `spend ≥ cap`. **The orchestration's own cost (decomposition + sub-agent calls) is booked to the ledger `spent` column** — net value must stay honest (meta-economics).
8. **`mysti` self-reference forbidden:** `mysti` may not be a `ModelRouter` pick, a `dispatch_agent` `targetProvider`, or a child `defaultProvider`; a hard recursion/depth guard backs this.
9. **DAG correctness:** cycle + diamond detection before execution; a child failure fails its dependents deterministically (drop-to-null, surface in the result).
10. **Gating:** `dispatch_agent` is a `delegate`-classified tool (Plan 10 Part 1); every child tool call passes the panel-independent chokepoint.
11. **Privacy at N×:** each derived panel writing its own `history.jsonl` multiplies transcript-on-disk (possible secrets). Children default to **no history persistence**; if enabled, same gitignore + redaction posture.

---

## Phase D3a — Path-based copy-brief DAG (ungated beyond the security floor)

Honest "today's capability, done right": copy briefs, path references, the new pool + governor.

**Steps**
1. **`MystiOrchestratorManager`** (sibling to `MentionRouter`), threaded into `ChatViewProvider` (24-arg ctor `:219`) + `extension.ts`. Register `id='mysti'` (`ProviderType`/`AgentType` `types.ts:18,22`, `ProviderRegistry:66`); its `sendMessage` delegates internally.
2. **`dispatch_agent` tool** (model-callable, **`delegate`-gated**): `{task, targetProvider?, contextRefs[] (paths only in D3a), returnSpec, mode:'sync'|'async'}`. `targetProvider` omitted → `ModelRouter.pickBackend` (below). Children spawn on UUID-scoped panels with a copied brief; return only a `returnSpec`-validated summary.
3. **DAG + bounded pool + governor** per the constraints; async nodes go through Plan 10's `JobStore`/`JobRunner`.
4. **Cross-agent `ModelRouter.pickBackend`** (the real router): two-tier policy — a user-overridable `{taskClass → backend}` map first, then a cost/window tie-break **only where pricing exists** (null-cost backends ranked by quality/speed/window; undefined window ⇒ ineligible). Per-subtask routing is **opt-in**: default to the panel backend, route away only on a high-confidence signal (explicit budget, obvious vision/long-context need).
5. **D3a is backend-only routing (model-level routing deferred).** There is **no `routedModel` field on `Settings` today**, and inverting precedence so a per-call model beats the global `mysti.<provider>Model` would touch every provider `_getEffectiveModel` (`BaseCliProvider.ts:751`, `CodexProvider.ts:1019`, `GeminiProvider.ts:299`) **and collides with the issue-#39 respawn logic** (`_persistentSettingsMatch` compares effective model to decide persistent-process respawn — a per-call model would thrash respawns). So D3a routes the **backend** only; each backend uses its own configured/default model. Model-level routing (adding `Settings.routedModel` + reconciling the respawn comparator) is deferred to **D3b** and treated as its own risk item.

**Acceptance:** `@mysti` decomposes a task into a DAG, routes each node to a sensible backend, runs independent nodes in a capped parallel pool (sync or async), respects depth/$/concurrency caps persisted in `JobStore`, books its own spend, and synthesizes; cancel tears down all children; `mysti` can't recurse into itself. +tests for DAG exec, cycle detection, governor caps, gating, UUID isolation.

**Risk:** the `routedModel` precedence change is the riskiest edit (collides with custom-model respawn) — prefer backend-only routing in D3a.

---

## Phase D3b — By-reference briefs (gated on Plan 08 Phase 3 retrieval + a shared store)

The token-efficient version, only viable after the prerequisites exist. **Retrieval is owned by Plan 08 Phase 3** (the WIP `RetrievalCoordinator`), not Plan 09 — D3b cannot start until that retrieval layer is finished and wired.

**Steps**
1. **Build the missing dereference primitive.** There is **no `resolveRef(msgId) → content` lookup in the codebase today**: `RetrievalCoordinator.retrieve` (`:55-75`) does relevance-based extraction returning *model-authored quote text* and treats `msgId` as a label tag (`:121,:167`), not an address. D3b must add a real ref-resolution primitive over an addressable store.
2. **Orchestration-scoped shared store:** today `HistoryStore`/memory are per-exact-panelId, so a parent `msgId` is meaningless to a child panel. Add a `rootId`-scoped store (or resolve refs against the parent panel's store from the child) so `contextRefs` of kind `msgId`/`snippet` actually dereference via the step-1 primitive.
3. **By-reference briefs** for **native/gateway children only** (a CLI child still needs a prompt string). Snippets resolved via the step-1 primitive over Plan 08 Phase 3's `RetrievalCoordinator`, injected into the child's volatile suffix.

**Acceptance:** a native child resolves a parent msgId/snippet ref without a full copy; CLI children continue with bounded copied briefs. +tests.

**Risk:** this is the part the review flagged as "the hard part nobody finished" (even Hermes shipped only summarization) — keep it gated and optional.

---

## Phase D3c — Recursive advisor-orchestrator with hierarchical skeleton context (gated; the scale lever)

Generalizes D3a's flat DAG into a **recursive tree** — project → folder → module → function — where each node carries only its level's *skeleton* (not bodies), cheap models implement leaves in parallel, and an on-demand **cross-model advisor** protects quality. This is the synthesis of the skeleton-map (Aider repo-map), the architect/implementer split, the relevance-gate, and the advisor strategy (Anthropic Advisor tool / MindStudio cost pattern). **Gated behind D3a + D3b.**

**Grounded economics (simulated, verified rates):**

| Functions | Monolithic $ | Hierarchy $ | saving |
|--:|--:|--:|--:|
| 60 | $1.07 | $1.04 | 1.0× |
| 120 | $2.71 | $1.95 | 1.4× |
| 240 | $8.04 | $3.80 | **2.1×** |
| 480 | $16.08 | $7.56 | 2.1× |
| 960 | $31.72 | $15.11 | 2.1× |

The saving **plateaus at ~2×** (compaction already bounds the monolith, so both are linear — the hierarchy just has a much smaller, *flat* per-function constant + parallelism). **Not worth the tree overhead below ~60–120 functions.** New-code-leaning (refactors can't cleanly separate skeleton from body — use the D3a flat DAG for those).

**Contract / steps**
1. **Hierarchical skeleton context (per-node, bounded).** Each node's resident context is a **deterministic tree-sitter skeleton** of its level (project = folder/interface map; folder = module signatures; module = function signatures + types), never bodies. Bodies live in files, read JIT. Skeleton extraction is LLM-free → bounds each node's context regardless of total project size (the flat $/func above).
2. **Per-node progress-file contract (traceability).** Each node maintains `progress.md` (goal / done / pending / open-threads / decisions); children roll up to parents — the tree of progress files **is** the traceability and answers "what's pending" at any level *without a full-tree read* (composes with the relevance-gate; a status query reads only the relevant level). Maintained by Plan 09's delta-patch incremental compactor.
3. **Cheap parallel implementers + heterogeneous on-demand advisor.** Leaf functions implemented by cheap models on small local briefs, in parallel (bounded pool, constraint 3). When stuck, the implementer **escalates to an advisor routed cross-model to the cheapest *sufficient* one** — Sonnet for most design Qs, Opus for the hardest/cross-cutting, Gemini for long-context, Codex for code-pattern. Implemented via Anthropic's **Advisor tool** (`advisor_20260301`) on the native path, or a `consult_advisor` tool that calls `sendMessageToProvider` cross-backend. A consult carries only situation+draft (~2.5k), never the full node context. (Sim: Sonnet-advisor beats Opus-advisor on cost at similar quality for typical consults.)
4. **Escalation-calibration gate (the swing factor).** Hybrid trigger — **rule** (always consult before a cross-cutting/interface decision or final user-facing output) + **confidence threshold** + optional **quality-gate** — tuned from telemetry. The sim shows an optimum ~25% consult rate (under-consult → rework rises; over-consult → advisor cost rises toward Opus). **Fail-safe: when uncertain, consult** — a ~$0.01 consult is cheaper than a ~$0.05 rework.
5. **Depth / budget / consistency guards.** Hard recursion-depth cap (project→folder→module→function = 4); per-root token/$ budget in `JobStore` (constraint 7) enforced across the whole tree. **Consistency: the parent's skeleton is the binding contract for its children** — a child may not change an interface without escalating to the parent (interface churn triggers a re-fan-out cascade; the parent/advisor owns interface changes). A per-node reconcile pass checks children against the skeleton.

**Acceptance:** building a multi-module project, every node carries only its (bounded) skeleton; leaf implementers run in parallel with cross-model advisor consults; per-node progress files roll up and answer status queries without a full-tree read; depth/budget/consistency guards hold; measured cost ≈ **2× under monolithic at ≥240 functions** with the `SavingsLedger` reconciling it against real cost headers. +tests for skeleton extraction, progress roll-up, advisor routing, the calibration gate, and the depth/consistency guards.

**Risk:** calibration (escalation rate is the dominant lever); interface-churn cascades; cross-node consistency; and the **overhead floor** — below ~60–120 functions the tree costs as much as it saves, so the orchestrator must size-gate (use the flat D3a DAG for small/edit tasks).

---

## Sequencing

```
D3a  copy-brief DAG + pool + governor + backend router   needs 09 + 10(+floor)   ~1–2wk
D3b  by-reference briefs + shared store                   needs 09 retrieval      ~1wk (optional)
D3c  recursive advisor-tree (skeleton ctx + progress      needs D3a + D3b         ~2–3wk
     files + cross-model advisor + calibration gate)       (large-build scale lever)
```

## Out of scope (→ Plan 12)

- Self-improvement, `skill_view`, background-review/Curator, workflow engine, Hermes backend, scheduling.
