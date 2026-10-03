# 15 — The Mysti Agent (`@mysti`): implementation on the Plan 14 substrate, OpenRouter-free by default

- **Date:** 2026-07-09
- **Status:** DRAFT — implementation plan. Supersedes the sequencing in Plans 10/11 where Plan 14 already delivered the substrate; folds in the new requirement to **default the coordinator to OpenRouter free models**.
- **Grounded by:** a 5-probe code+web investigation (substrate delta, security-floor state, model-routing, OpenRouter integration, live OpenRouter free-tier facts).

---

## What changed since Plans 10/11 were written

Plan 14 shipped `CollaboratorPool` + `CollaborationManager`, which **already satisfy the hard parts of Plan 11's per-node execution layer** (verified, with file:line):

| Plan 11 constraint | Status | Where |
|---|---|---|
| 3 — bounded pool, not `_interleaveGenerators` | ✅ done | `CollaboratorPool.dispatch`/`_boundedMerge` (`:97,:146`), cap = `maxConcurrent` |
| 4 — UUID-scoped child panels | ✅ done | `_childPanelId` `${panelId}-collab-${runId}-${id}` (`:644`) |
| 10 — child tool calls gated pre-execution | ✅ done | `_gateToolUse` (`:474`): read-only hard-deny, gated-write SIGSTOP→`onGate`→resume/cancel on the **child** panel; `dispatch_agent`/`task`/`agent` already off the read fast-path (`:487`) |
| child-recursion containment | ✅ done | delegation regex includes `dispatch_agent` (`:487`) |
| cancel fan-out / no orphans | ✅ done | `cancelRun` + `.return()` propagation (`:120,:183,:451`) |
| 6 — completion by transport signal | ✅ done | stream-end, not keyword (`:377`) |
| failure taxonomy / retry / availability / question relay / untrusted-context fencing | ✅ done | `types.ts:780`, `_dispatchWithRetry`, `_buildReferenceBlock`/`_fenceUntrusted` |

**So the orchestrator does not rebuild execution — it reuses the pool.** What's missing is the brain (a coordinator loop), a DAG over the flat pool, the model-callable delegation surface, the governor, the security floor that makes model-initiated delegation safe, and a model backend (OpenRouter). Confirmed **absent**: no `id='mysti'`, no `ModelRouter`/`ModelCapabilities`, no `JobStore`/`JobRunner`, no OpenRouter code.

---

## Hard constraints carried forward (from the two adversarial reviews)

1. **Pure coordinator, backend-only routing.** `@mysti` decomposes + routes to a **backend** (a `providerId`); it does **not** route a per-call *model* on the CLI path — that collides with `_getEffectiveModel` precedence and the issue-#39 respawn comparator (`BaseCliProvider.ts:804`), which would thrash persistent processes. Model-level routing stays deferred; the OpenRouter default is expressed as its **own backend/client**, not a per-call model override on another provider.
2. **Model-initiated delegation is gated.** User-typed `@agent:role` (Plan 14) is a command; the coordinator *deciding* to spawn a child is delegation and must pass the **security floor** (Phase 0). No exceptions.
3. **Decomposition is structured JSON, not free-model tool-calling.** Free-tier models have unreliable native tool-calling; the coordinator emits a validated JSON DAG (the proven `MentionRouter._generateTaskListWithAI` shape, `:287`), parsed deterministically. `dispatch_agent`-as-a-tool is the *optional* variant for tool-calling-capable backends, on the same gated path.
4. **`mysti` self-reference forbidden** as a backend pick / child default / router target; hard depth cap (4).
5. **Governor is authoritative and persisted:** depth/concurrency/$ caps per `rootId`; the coordinator's own spend (decompose + children) is booked to the ledger so net value stays honest.
6. **OpenRouter free is rate-bounded — design around 20 rpm.** Runtime model discovery, a concurrency semaphore well under 20 rpm, retry-with-backoff. **Free-only by default** (per the locked decision); a paid fallback is **opt-in** via a `mysti.openrouter.fallbackModel` setting (off by default) — when set, fail over to it on sustained 429/402; when unset, degrade gracefully (queue/slow + a visible "rate-limited" notice). Never hardcode free model IDs (they rotate; DeepSeek's free tier already vanished).

---

## Phase 0 — Security floor (Plan 10 Part 1) — the non-negotiable prerequisite

Essentially none of this landed on the authoritative path; the `CollaboratorPool._gateToolUse` delegation block is a Plan-14-scoped band-aid that does **not** cover the main foreground agent's own `dispatch_agent` or async jobs.

**Steps** (each cites the exact site)
1. **Un-allowlist delegation:** remove `'task','agent','toolsearch','tool_search'` from `READ_ONLY_TOOLS` (`toolNames.ts:160`).
2. **Add `'delegate'`** to `PermissionActionType` (`types.ts:886-893`).
3. **Map** `task`/`agent`/`dispatch_agent` → `'delegate'` in `ACTION_TOOLS` (`toolNames.ts:100-138`); keep `KIND_TOOLS`/`toolKind` + the webview permission-card renderer + risk mapping in sync.
4. **`delegate` branch in `shouldGateToolUse`** (`permissionClassifier.ts:75-105`): default-DENY; auto-approve only under explicit full-access/autonomous (like writes). **`delegate` branch in `SafetyClassifier`** so autonomous mode evaluates delegation instead of silently approving.
5. **Panel-independent chokepoint:** extract enforcement out of `ChatViewProvider`'s stream loops (`:1070,:3177,:3621`) into one `evaluateAndGate()` every tool call passes — foreground, async, or viewless derived panel.
6. **Depth guard:** per-`rootId` delegation-depth counter, hard cap 4 (nothing tracks this today).
7. **Entitlement fail-closed for delegation/job spend** (extend the compaction ceiling in `DeepMystAuthManager`).
8. **Clamp gate-governing settings** via `inspect()` (workspace may only narrow) + regression tests for delegation-gating and workspace-widening.
9. **Document the native-inner-tool limitation:** gating outer `dispatch_agent` does not gate a native CLI sub-agent's inner `Write`/`Bash` — orchestrator-mode native children must run with restricted CLI flags / sandbox.

**Acceptance:** delegation is a first-class gated `delegate` action, default-deny, identical in foreground/async/viewless contexts; depth-capped; entitlement-gated; a workspace settings file can't widen it. +tests. **~4–5d. Blocks everything below.**

## Phase 1 — OpenRouter backend + free-model default

**Steps**
1. **`OpenRouterClient`** (`src/services/OpenRouterClient.ts`) — clone the `DeepMystGatewayClient` shape (same `chatCompletion({model,messages,maxTokens,signal})` + a streaming variant): base `https://openrouter.ai/api/v1`, `Authorization: Bearer <key>` from `mysti.openrouter.apiKey` / `OPENROUTER_API_KEY`, `HTTP-Referer`/`X-Title` headers, host-allowlist `openrouter.ai`, fail-open `{failed:true}` on error (so degradation is free). SSE streaming for the coordinator's user-visible synthesis.
2. **Runtime free-model discovery:** `GET /api/v1/models`, filter ids ending `:free` **and** `supported_parameters` including `tools`; cache with TTL. Expose `getDefaultCoordinatorModel()` → the discovered free model, or the meta-router `openrouter/free`. **Never hardcode** (IDs rotate).
3. **Rate-limit resilience:** a concurrency semaphore held **well under 20 rpm**, retry-with-backoff on 429, and **failover to the DeepMyst/Haiku path** on repeated 429/402 (reuse the existing `DeepMystGatewayClient`). Surface a quiet "rate-limited, using fallback" status.
4. **Wire as the coordinator's cheap-task client** (decompose, synthesize, cheap leaves) — a tiny facade dispatching by model id (OpenRouter-free → OpenRouterClient; gateway model → DeepMystGatewayClient) so callers are untouched. `mysti.compaction.smart.cheapModel` may also opt into a free id (`MODEL_NAME_PATTERN` already accepts the slug, `validation.ts:37`).

**Acceptance:** the coordinator's reasoning + cheap tasks run on a runtime-discovered OpenRouter free model with a paid fallback on throttle; no hardcoded IDs; key host-allowlisted. +tests (discovery filter, dispatch-by-id, 429 failover). **~3–4d.** *(A full user-facing OpenRouter chat provider — the 10-step registration, using the dead `ManusProvider` as the API skeleton but streaming SSE — is a separate optional item; see Open decisions.)*

## Phase 2 — The `@mysti` coordinator (D3a: copy-brief DAG, sync)

**Steps**
1. **`MystiOrchestratorManager`** (sibling to `CollaborationManager`, injected with the **existing** `CollaboratorPool` + `AgentContextManager` + `ProviderManager` + `OpenRouterClient`). Register `id='mysti'` (`types.ts` `ProviderType`/`AgentType`, `ProviderRegistry`) whose `sendMessage` delegates to it; enforce the `mysti` self-reference guard.
2. **Decompose → DAG:** modeled on `MentionRouter._generateTaskListWithAI` (`:287`) but running on the OpenRouter free coordinator model and emitting a **graph** (nodes + `dependsOn`), with **cycle + diamond detection** before execution and deterministic dependent-failure.
3. **Execute via the pool:** frontier-by-frontier, `pool.dispatch(specs, {panelId, runId, maxConcurrent, onGate, onQuestion, conversation})`; build specs with `CollaborationManager`'s `_buildPrompt`/`_fenceUntrusted` (untrusted-context fencing reused); thread completed node outputs into dependents' prompts; synthesize via `formatCollaboratorContext` + a final coordinator pass.
4. **`dispatch_agent` (model-callable, `delegate`-gated) — optional variant.** For tool-calling-capable backends, intercept `name==='dispatch_agent'` at the tool_use site (`ChatViewProvider.ts:3613`), run the orchestrator, and return results via the **reseed pattern** (complete the turn at the tool boundary, run the pool, reseed a follow-up turn carrying results as text — the proven `_relayQuestion` mechanism, since CLIs can't take a mid-stream `tool_result`).
5. **Backend router `pickBackend(task)` (backend-only):** default cheap/simple tasks → OpenRouter free; route to a stronger backend only on a high-confidence signal (explicit budget, obvious vision/long-context need). Feeds `spec.agentId`. **No per-task model routing** (deferred; precedence collision).
6. **Governor:** depth cap (4), concurrency cap, per-`rootId` $ budget; refuse to advance a DAG whose `spend ≥ cap`; book decompose + child spend to the ledger `spent` column.

**Acceptance:** `@mysti <request>` decomposes into a validated DAG, routes each node to a sensible backend (cheap→free), runs independent nodes in the capped pool, threads dependencies, respects depth/$/concurrency caps, books its spend, and synthesizes; cancel tears down all children; `mysti` can't recurse into itself. +tests for DAG exec, cycle/diamond detection, governor caps, gating, self-reference guard. **~1–2wk.**

## Phase 3 — Async jobs (Plan 10 Part 2)

The pool is inline/pull-based; `mode:'async'` cannot fire-and-forget a generator (unconsumed = runs nothing). Add the **`JobRunner` pump** (an un-awaited driver that drains `dispatch` in the background and persists chunks/outcome), a durable **`JobStore`** (`pending→running→completed|failed|orphaned`, panel-reload vs host-reload semantics), completion→report-back cards + spend, kill-switch, Windows parity. Long children become background jobs. **~1wk.** *(Gated on Phase 0's panel-independent chokepoint.)*

## Phase 4 — Later (own plans)

D3b by-reference briefs (needs a `rootId`-scoped store + a real `resolveRef`), D3c recursive advisor-tree (the ≥240-function scale lever), the full user-facing OpenRouter chat provider, and Plan 12 (self-improvement, workflow engine, dashboard, scheduling).

---

## Sequencing

**First shippable slice = Phases 0 + 1 + 2** (a working *sync* `@mysti`). Phase 3 (async) and Phase 4 (OpenRouter chat provider, D3b/D3c, Plan 12) follow.

```
── First slice (a usable @mysti) ──────────────
Phase 0  Security floor                     ~4–5d   MUST land first
Phase 1  OpenRouterClient + free default    ~3–4d   parallel-izable with Phase 0
Phase 2  @mysti coordinator (D3a, sync)     ~1–2wk  needs 0 + 1
── Later ──────────────────────────────────────
Phase 3  Async jobs (JobStore/JobRunner)    ~1wk    needs 0
Phase 4  User-facing OpenRouter provider · D3b · D3c · Plan 12
```

## Locked decisions (2026-07-09)

1. **OpenRouter surface — coordinator-internal now, full provider later.** Phase 1 ships the `OpenRouterClient` powering `@mysti`'s reasoning + cheap tasks only. The full user-facing OpenRouter chat backend (10-step provider, using the dead `ManusProvider` as the API skeleton but streaming SSE) is deferred to Phase 4.
2. **Throttle — free-only by default, optional user-set paid fallback.** No automatic paid spend. A new `mysti.openrouter.fallbackModel` setting (off by default) lets the user opt into a paid fallback; unset ⇒ graceful degradation under the 20-rpm cap.
3. **First slice — a working sync `@mysti`** (Phases 0+1+2). Async jobs (Phase 3) explicitly out of the first slice.
