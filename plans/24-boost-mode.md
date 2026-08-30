# 24 — Boost Mode

**Goal:** one switch (`mysti.boost.enabled`) that makes the agent measurably better, faster and cheaper by coordinating subsystems that already exist — compaction, the delegation pool, model pricing — with the numbers that were measured to work, instead of defaults nobody tunes.

**Status:** **PHASES 0–5 SHIPPED (Phases 3–5 on 2026-08-26)**. Phases 3–5 were built ahead of the "measure a week first" gate at the user's explicit direction; every Phase 3–5 behaviour is therefore Boost-gated and default-off, so the stock path is unchanged until `mysti.boost.enabled` is set. Earlier status: **PHASES 0–2 SHIPPED (2026-08-25)** — 245 test files / 9,248 tests green, `tsc --noEmit` clean, lint guards pass. Written after auditing the tree, not from the design artifact alone. Phases 3–5 remain gated on Phase 1 sensor data.

**Shipped surface:** `src/managers/BoostManager.ts` (overlay + sensor ledger), `src/services/ModelRouter.ts` (tier/effort suggestions), the `CompactionManager` overlay seam (`setBoostOverlay`, consulted from `_loadThreshold`/`_loadSmartEnabled`), `spec.effortLevel` on `CollaboratorSpec` → `CollaboratorPool` child settings, two machine-scoped settings (`mysti.boost.enabled` default **false**, `mysti.boost.profile`), a status-bar chip + `mysti.boostSummary` command, and four test files (33 tests).

**Two adversarial review rounds** (round 1: 3 lenses × verify, 7 confirmed; round 2: 8 recovered claims + a fresh review of round 1's own fixes, 27 agents, 10 confirmed). Round 1's 7, all fixed — fast-lane verb allowlist could downgrade code-writing tasks (dropped `document`/`list`, added a verb-position edit-intent guard); `delegationEffort` could raise a child above its parent; stale `reqTier` dropped a Boost-chosen tier from the persisted delegate card; coordinator round-trips booked as 1 per run (`streams` hoisted out of the try block); unknown/synthesized usage booked as measured zeros (`UsageStats.estimated`, honored on both paths).

Round 2 found 10 more, all fixed — the notable ones being defects in round 1's *own* fixes: the widened
fast-lane guard only recognised edit verbs after a connector word (so `Explain X. Fix Y.` still routed
cheap) and enumerated ~19 verbs (bare `write` slipped through); the 2000-char scan window was shared by
the `^`-anchored lead test and the two scan-anywhere safety gates, so task LENGTH alone could invert a
`strong` into a `fast`; an out-of-union `parentEffort` was read as `'high'` and raised a child above a
parent that `clampEffort` had dropped to its lowest tier; several backends default a missing usage field
to `0`, which booked as a measured-zero context; and the cross-window ledger merge (added in round 2)
initially shared its object with the persisted payload, so later turns mutated the stored value in place.
Round 2 also **refuted** 6 claims — notably that the lifetime estimate flag should be cleared on session
reset (it must not: that would present a tainted lifetime total as measured; the shipped fix instead
scopes the two flags separately).

**Evidence base:** all performance figures come from 34,871 measured Claude Code round-trips (grouped by API `requestId`), not estimates. External write-ups: "The 436k Round-Trip" (diagnosis), "Faster Claude Code" (ordering), "Which Model, Where" (model behaviour). Key numbers used below:

- Context per round-trip is the dominant cost and is set by **session age**, not task: turn 0 ≈ 35k tokens, turn 20 ≈ 670k (19×). Compaction fixes it but fires far too late (default threshold 75%).
- Round-trip latency ≈ `4.6s fixed + 6.1s per 1M context + 2.2s tool`. Only ~28% of a round-trip responds to context — **round-trip count and concurrency are the speed levers; context is the token lever.**
- **Serial delegation measured 0.98× — slower than inline.** Three concurrent lanes measured 1.20×. Concurrency saturates ~1.5× at 3–4 lanes.
- Opus-tier `max` effort costs ~6% over `xhigh`; escalation is nearly free, so route effort *down by default, up eagerly* for review/perimeter work.
- Cold resumes (idle > 1h, large context) re-write the whole prefix at the 2× cache-write rate; measured at ~9% of total spend, 52% of all cache-write tokens.

## What already exists (audited 2026-08-25)

`CompactionManager` (534 L), `SmartCompactor` (777 L), `SavingsLedger` (133 L), `RetrievalCoordinator`, `TelemetryManager` (263 L), `CollaboratorPool` (842 L, gated), `OrchestratorDag` (251 L), `BackgroundJobManager` (352 L), `ModelPricing` (104 L), `runBounded` (already batching read-only coordinator tools at cap 3). `routedModel` exists at `types.ts:222`. **Missing: a router, a per-turn sensor, and a mode that turns the right defaults on together.**

## Prerequisite — SATISFIED

Boost increases delegated execution, so it was gated on the fail-open permission gate. Plan 23 B1 landed (`5b01b01`): `shouldGateToolUse` fails CLOSED on unrecognized `mode`/`accessLevel`, `normalizeAuthoritySettings` coerces at the boundary, and `clampOne` clamps unknown workspace values to the user's floor. Remaining from that review: `READ_ONLY_TOOLS` membership test (ships with Phase 0 here).

## Phases

| # | Ships | Status |
|---|-------|--------|
| 0 | `mysti.boost.*` settings + `BoostManager` overlay (compaction threshold ↓, smart compaction on, profile presets). Overlay, not settings-writes: explicit user values always win. + `READ_ONLY_TOOLS` membership test. | **SHIPPED** |
| 1 | Sensor: per-turn ledger (context, output, round-trips, model) captured from provider `done` usage; status-bar surfacing. | **SHIPPED** — hooked on the CLI `done` path, the coordinator (incl. background jobs), and `orchestrate`. **NOT hooked:** brainstorm per-agent runs, `@agent:role` mention-collaboration, and child delegation tokens (CollaboratorPool has no ledger hook) — so session totals under-count those paths. Estimates are flagged and never presented as measured |
| 2 | `ModelRouter` service: task-class → tier/effort table for **delegated** work only; never overrides an explicit user model choice (custom-model precedence hazard — route by tier/backend, not by mutating `settings.model`). | **SHIPPED** — suggestions feed the existing `tierApplied` machinery, so backend `modelSelection:'none'` checks and `routedModel` precedence hold unchanged; only fires when the coordinator supplied NO tier |
| 3 | Round-trip reducer: widen `runBounded` beyond read-only; merge detector (record-only). | **SHIPPED** — `selectToolBatch` runs the leading READ-ONLY RUN of a mixed native batch instead of dropping it (extracted pure so the decision is testable); merge detector counts redundant repeats + consecutive lone-read turns, record-only |
| 4 | Fan-out scheduler on `CollaboratorPool`+`OrchestratorDag`: decompose → file-disjoint lanes → verify gate → merge. **Refuses single-lane dispatch** (serial delegation measured slower than inline). Cap 3–4 lanes. | **SHIPPED** — `partitionLanes` splits a frontier on declared `files` hints and caps width; single-node plans refuse and fall through to the inline agentic path; one read-only verify lane runs before synthesis when lanes actually ran in parallel |
| 5 | Cold-resume interception + handoff-note flow. | **SHIPPED** — per-panel last-FILL tracking in the ledger; a resume past 1h idle with ≥60k context compacts BEFORE the send and appends a turn-only handoff note |

Phase 0 is most of the value (compaction settings alone ≈ 1.63× on tokens, measured).

**On the "measure first" gate.** Phases 3–5 were originally gated on a week of Phase 1 data, and were
built before that data exists. The mitigation is that each one is inert with Boost off and each is
tuned by a named constant rather than a fitted value, so the sensor can still correct them:
`COLD_RESUME_IDLE_MS`/`COLD_RESUME_MIN_CONTEXT_TOKENS` (Phase 5), `FANOUT_MAX_LANES` (Phase 4), and the
read-only prefix rule (Phase 3, structural — no tuning). The Phase 3 merge detector is still
record-only for exactly this reason: it measures how much round-trip waste exists before anything
acts on it. **The numbers to check against real data first:** the 60k cold-resume floor, the 1h idle
window, and whether `mergeableRoundTrips` is actually non-trivial in practice.

### What Phases 3–5 deliberately do NOT do

- **Phase 3 does not batch mutating calls.** "Widen `runBounded` beyond read-only" is implemented as
  the read-only PREFIX of a mixed batch, not as parallel writes. A mutating call needs its own
  permission card; cards are interactive and ordered, so batching them would mean racing gates —
  which would make Boost raise authority, the one thing it must never do.
- **Phase 4's `files` hints are advisory.** They are model-authored, so they order lanes to avoid a
  lost update; they never grant or deny a write. The pool's gate remains the sole authority. A node
  with no hint is treated as unconstrained, because `files` is optional and treating its absence as
  a conflict would disable fan-out entirely.
- **The verify lane is read-only and cannot fix what it finds.** It reports conflicts into synthesis
  as evidence, never as an instruction.
- **Phase 5 compacts; it does not start a new session.** The "handoff note" is a turn-only line
  appended to the outgoing prompt (never persisted), matching the smart-retrieval convention.

## Design rules

- **Boost never raises authority.** It composes with `settingsClamp`; a workspace can lower what Boost grants, never widen it. Boost must not touch `accessLevel`, `mode`, autonomy, or permission settings at all.
- **Overlay, not persistence.** `BoostManager` computes effective values consumed at read sites; toggling Boost off restores stock behaviour instantly. A user-explicit setting (per `config.inspect`) beats the overlay.
- **Profiles, not toggles:** `economy` (aggressive compaction, cheap tiers), `balanced` (measured defaults), `quality` (effort pinned high, no cheap-tier routing).
- **Sonnet-tier is the floor for delegated code.** No cheap-tier routing into anything security-adjacent; trust-perimeter files are never delegated (Plan 20/23 invariants).
- **Sensor before dial.** Nothing gates or blocks in Phases 0–2; the ledger records, the status bar shows, the human decides.

## Explicitly not building

A composite quality score (no quality signal exists yet); auto-decomposition without confirmation; mid-turn budget blocking (stop the loop, never eat input); a weekly report job (status bar beats reports nobody opens).
