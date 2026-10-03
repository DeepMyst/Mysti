# 08 — Smart Compaction (DeepMyst-gated): A Persistent Compactor Agent with Cache-Aware Economics

- **Date:** 2026-06-14
- **Status:** DRAFT
- **Inputs:** Live map of `CompactionManager` + the `ChatViewProvider` compaction call sites + per-provider usage/cache capture + the DeepMyst auth/broker stack + the cheap-model/parallelism plumbing (file:line refs inline). Plus a 5-agent deep-research pass (DeepMyst gateway API, Anthropic-native primitives, MemGPT/Letta/Generative-Agents/"Don't Break the Cache", a rigorous cost model, and a concrete retrieval/compactor architecture) — sources cited inline.
- **Trigger:** User — "implement an extremely important feature which is smart compaction … enabled only for users with DeepMyst accounts. (1) Auto compact if caching is not enabled or we are already outside the caching window; (2) compact using a much cheaper model that is reliable for compaction; (3) decide on compaction if the expected savings of compaction outperform that of caching (don't over-compact, keep enough context to perform with high quality); (4) maintain full history in a file and automatically load relevant context (cherry-picking) based on the prompt without losing caching benefit, using multiple low-cost agents running in parallel over file sections." Plus: "maintain a compactor agent that is reasonable for the work" and "surface the savings in front of the user all the time so they see the value."

---

## Goal

Replace today's blunt, single-threshold, same-model compaction with a **graduated, cost-aware system** built around a **persistent compactor agent** that maintains structured memory *incrementally* and *off the user-latency path*, decides *when/whether/how-much* to compact on real cache economics, keeps the full transcript on disk for cherry-pick retrieval, and **shows the user the running savings at all times**. The "smart" behavior is a **premium capability gated on a DeepMyst account**; when the gate is off, today's threshold compaction is preserved **byte-for-byte**.

This plan **owns** the smart-compaction *decision*, *summarization*, *memory*, and *retrieval* policy. It **builds on** the existing `CompactionManager` plumbing (per-panel usage, cooldown, strategy dispatch) — not a rewrite.

---

## Design principles

Economics first (per-MTok input base: Opus 4.8 `$5`, Sonnet 4.6 `$3`, Haiku 4.5 `$1`; **DeepMyst gateway `claude-haiku-4-5` is `$0.25/$1.25`**; cache **read ≈ 0.1×** base, **write ≈ 1.25×** @5-min / **2×** @1-hour; **min cacheable prefix 4096 tok** Opus/Haiku, 2048 Sonnet; 5-min TTL refreshes *free* on each read):

1. **A graduated ladder: prune → compact → persist.** Tier 0 = **free** clearing of stale tool-result payloads (no model call — Anthropic's "lightest-touch" context editing). Tier 1 = one cheap summarization pass. Tier 2 = cross-session memory. Always exhaust the cheaper tier first. *(Anthropic context-editing + effective-context-engineering.)*
2. **A persistent, incremental compactor agent — not re-summarize-from-scratch.** Maintain a small **structured memory** (Goal / Decisions / Files / Code / Open-threads) updated via **section-scoped DELTA patches**, run by a cheap model **between turns / on idle**. This is ~linear cost vs. the current ~quadratic full re-summarization, drifts less, and — being byte-stable — keeps the cache warm. *(MemGPT recursive-summary-on-eviction; Letta sleep-time compute: ~2.5× lower cost/query, +13–18% accuracy off the latency path.)*
3. **Compaction is most expensive while the cache is warm; time it cold.** Compacting destroys cheap `cache_read` (0.1×) and forces a fresh `cache_creation` (1.25×). Under continuous traffic the 5-min cache refreshes for *free*, so caching is already nearly free — compact **less**. The ideal moment is a cold/expired window. Urgency (near-overflow) overrides.
4. **Optimize to a quality floor, never max compression.** Dollars push the summary size `S→min`, but two hard limits cap it: **(a)** the **min-cacheable-prefix trap** — if the compacted prefix lands under ~5k tokens it *silently* won't cache (`cache_creation=0`) and you lose everything; **(b)** output is ~50× pricier than reads, so one avoidable 2k-token re-derivation ($0.05 output on Opus) erases ~100k tokens of read savings. Target a **min summary size**, not a max ratio. *(Economic analysis; verified min-prefix table.)*
5. **Cherry-picking and caching are reconciled by a stable system tier + volatile user-turn suffix.** Put incremental memory in the **system tier** (cacheable, byte-stable); put per-prompt retrieved snippets **after the user turn** (messages tier, volatile anyway). Changing the trailing user content invalidates only the messages tier — the system-tier memory keeps yielding `cache_read`. Splicing snippets into system is the anti-pattern. *(Prompt-caching prefix hierarchy; "Don't Break the Cache.")*
6. **The savings are the product — surface them always, honestly.** Each smart action has a measurable saving vs. the counterfactual; show a persistent running total. The DeepMyst gateway returns real `X-DeepMyst-Cost-USD` per call, so the ledger is grounded in actual billed cost, not just our estimate. **Count only realized savings, label estimates** — over-claiming erodes trust.
7. **Behavior-preserving, entitlement-aware gate.** `smart` active iff `isSignedIn() && mysti.compaction.smart.enabled && hasEntitlement()`, where `hasEntitlement()` = on a paid plan **or** within the **free monthly allowance**. When inactive — signed out, toggled off, or free quota exhausted — it falls back to today's threshold compaction **byte-for-byte**, with a quiet upsell only when the cause is an exhausted free tier. Mirrors the Plan 04 gating discipline.

Every phase ships independently and is verifiable in the Extension Development Host. Phases 0–1 deliver value with little/no DeepMyst dependency.

---

## Current-state (grounded)

### A. Blunt binary trigger, no tier-0 prune
`shouldCompact()` ([CompactionManager.ts:106-128](../src/managers/CompactionManager.ts#L106)) fires on the **last response's** fill crossing a flat 75% ([constants.ts:103](../src/constants.ts#L103)), gated by a 30s cooldown + 4-message min. There is **no free pruning tier** — the only options are native `/compact` or full client re-summarize. Stale tool-result payloads (file reads, grep/web output) bloat agentic loops and are kept verbatim.

### B. Full re-summarization on the user's own (expensive) model
`executeClientSummarization()` ([CompactionManager.ts:174-266](../src/managers/CompactionManager.ts#L174)) re-summarizes the **whole** older slice every time through the **active provider/model** with a generic prompt ([:338-357](../src/managers/CompactionManager.ts#L338)), mechanically keeping the last 4 messages ([:198-199](../src/managers/CompactionManager.ts#L198)), estimating tokens at 4 chars each ([:244-245](../src/managers/CompactionManager.ts#L244)). This is the costly O(k·C) pattern; there is no persistent memory and no cheap model.

### C. Cache accounting exists, timing/window awareness does not
`cache_read`/`cache_creation` flow end-to-end for Claude/Cline only; `cache_creation` is summed into totals but used in **no** decision; there is no TTL, no last-turn timestamp, no "is caching on" signal ([recordUsage :81-100](../src/managers/CompactionManager.ts#L81), [updateUsageAfterCompaction :286-293](../src/managers/CompactionManager.ts#L286)). **Mysti never sets `cache_control` itself — the CLIs own caching;** it only observes counts.

### D. The DeepMyst gateway is real, separate, and partly-unwired
There is a **real OpenAI-compatible LLM gateway**, `deepmyst-gateway`, at **`https://gateway.v2.deepmyst.com`** (`apps/gateway/src/main.py:199-201`, `render.yaml:544`) — **distinct from** the MCP/REST host `https://api.v2.deepmyst.com` that today's [DeepMystClient :37-38](../src/services/DeepMystClient.ts#L37) uses. It exposes `POST /v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/responses`, `GET /v1/models` (`apps/gateway/src/router/proxy.py:135,321,486`), authenticated by the **same `dm_` Bearer key** (`auth.py:246-263`). Cheap models in the catalog: **`claude-haiku-4-5` `$0.25/$1.25`**, `gpt-4o-mini` `$0.15/$0.60`, Gemini Flash, Groq Llama (`catalog.py:168-172`). **Caveats (must not depend on):** the proprietary compression engine and `-auto`/`-optimize` model-routing are *present but not wired into the live request path* — the adapter strips the suffixes and LiteLLM cache is `false` (`litellm.py:216,394`, `litellm.yaml: cache: false`); the Anthropic-native `/anthropic/v1/messages` route **requires internal-service headers a `dm_` key lacks** (`anthropic_passthrough.py:207-213`). The gateway **does** emit `X-DeepMyst-Cost-USD`, `X-DeepMyst-Tokens-*`, `X-DeepMyst-Credits-Remaining` headers (`main.py:144-168`).

### E. The account gate, and the cheap-call/parallelism seams
Gate: [DeepMystAuthManager.isSignedIn() :107](../src/managers/DeepMystAuthManager.ts#L107) (syntactic only — a `dm_` string exists); no plan/tier concept. Prompt-assembly seam: [buildPromptAsync :1308-1366](../src/providers/base/BaseCliProvider.ts#L1308) — `systemContext` slot at ~:1340, user `content` at ~:1354; resumed Claude sessions drop re-sent history ([:1044](../src/providers/base/BaseCliProvider.ts#L1044)) and inject system via `--append-system-prompt` ([ClaudeCodeProvider.ts:294-300](../src/providers/claude/ClaudeCodeProvider.ts#L294)). Parallel primitive: [_interleaveGenerators :1648](../src/managers/BrainstormManager.ts#L1648); dedup/relevance: [_calculateTextSimilarity :1615](../src/managers/BrainstormManager.ts#L1615). Env injection for a gateway transport: [getEnrichedEnv :463](../src/utils/platform.ts#L463). Filesystem convention: `.mysti/` ([AgentLoader.ts:107-117](../src/managers/AgentLoader.ts#L107)); globalState is size-capped ([ConversationManager.ts:25-27](../src/managers/ConversationManager.ts#L25)) → history goes to disk, not globalState.

---

## Architecture overview

```
                          .mysti/compaction/<panelId>/
   ┌───────────────┐      ┌──────────────────────────────────────┐
   │  user turn N  │      │ history.jsonl   (append-only, full)   │
   └──────┬────────┘      │ memory.md       (structured, stable)  │
          │               └──────────────────────────────────────┘
          ▼                         ▲ delta patches        ▲ append
   ┌──────────────────────────────────────────────────────────────┐
   │ CompactionManager (decision)                                  │
   │  Tier 0 prune (free) → Tier 1 compactor agent (cheap) →       │
   │  Tier 2 persist;  economic gate N* ; cache-warmth timing      │
   └───────┬───────────────────────────────────────┬──────────────┘
           │ cheap calls (Haiku)                    │ retrieval (rare)
           ▼ direct HTTP                            ▼ parallel map-reduce
   ┌───────────────────────────┐         ┌──────────────────────────┐
   │ DeepMystGatewayClient     │         │ RetrievalCoordinator      │
   │ POST gateway/v1/chat/...  │◄────────┤ N Haiku scorers over      │
   │ dm_ key · cost headers    │         │ history.jsonl chunks      │
   └───────────────────────────┘         └──────────────────────────┘

Prompt layout per turn (cache-preserving):
  [TOOLS] [SYSTEM: persona + memory.md] ← stable, cached prefix
  [...server-side history via --resume...]
  [USER: text  +  "=== Retrieved context ===" snippets] ← volatile suffix
```

---

## Phase 0 — Foundations: pricing, cache model, and the gateway client

**Mostly no DeepMyst; behavior-neutral substrate.**

**Steps**
1. **Pricing table** `src/services/ModelPricing.ts`: `getPricing(providerId, modelId) → {inputPerMTok, outputPerMTok}` for the model families **and the DeepMyst gateway rates** (`claude-haiku-4-5` `$0.25/$1.25`), plus `CACHE_READ_MULT=0.1`, `CACHE_WRITE_MULT_5M=1.25`, `CACHE_WRITE_MULT_1H=2.0`. Unknown → `null` (degrade to non-economic behavior).
2. **Cache constants + warmth** in [constants.ts](../src/constants.ts): `PROMPT_CACHE_TTL_MS`, `CRITICAL_FILL_PERCENT=90`, `MIN_SUMMARY_TOKENS` (≥5000 Opus/Haiku, ≥2500 Sonnet — the anti-uncacheable floor). Add per-panel `lastTurnAt`/`lastCacheRead` in [recordUsage :81-100](../src/managers/CompactionManager.ts#L81); `getCacheWarmth(panelId) → 'warm'|'cold'|'unknown'` (warm iff within TTL AND `lastCacheRead>0`).
3. **DeepMyst gateway client** `src/services/DeepMystGatewayClient.ts` (modeled on [ImageGenerationService._httpsRequest :484](../src/services/ImageGenerationService.ts#L484), **not** the MCP `DeepMystClient`): `chatCompletion({model, messages, max_tokens}) → {text, usage, costUsd}`. `POST {gatewayUrl}/v1/chat/completions`, `Authorization: Bearer ${dm_}`, parse `X-DeepMyst-Cost-USD`/`X-DeepMyst-Tokens-*` response headers. New setting `mysti.deepmyst.gatewayUrl` (default `https://gateway.v2.deepmyst.com`; dev `http://localhost:8090`). Pick a cheap model **explicitly** (`claude-haiku-4-5`); `-auto`/`-optimize` are accepted-but-no-op today, so don't rely on them.
4. **Real token estimate** util replacing 4-chars/token ([:244-245](../src/managers/CompactionManager.ts#L244)), reused by chunking + budgets.

**Acceptance:** `getPricing` correct incl. gateway rate; `getCacheWarmth` flips on TTL; a `DeepMystGatewayClient.chatCompletion` round-trips a Haiku call with the `dm_` key and returns the real `costUsd` from headers. +tests (pricing, warmth, a mocked gateway response with cost headers).

**Risk:** Gateway reachability/billing unknowns are DeepMyst-side (see that section) — Phase 0 only proves the client wiring; later phases gate on it.

---

## Phase 1 — Tier 0 free prune + cache-aware timing (feature ①)

**Mostly no DeepMyst.** Two cheap wins before any paid summary.

**Steps**
1. **Tier-0 prune (no model call):** a client-side analog of `clear_tool_uses_20250919` — drop/placeholder the **oldest tool-result payloads** while keeping the last ~3 tool pairs, gated by a `clear_at_least` floor (only prune if you reclaim enough to beat the cache-rewrite cost). This is *free* and often reclaims the most tokens; run it before considering Tier 1.
2. **2-D timing trigger:** add `evaluateCompaction(...) → {act, tier, reason, deferUntil?}` alongside `shouldCompact()`. `fill ≥ CRITICAL` → act now; `fill ≥ threshold` & cold/unknown → act; `fill ≥ threshold` & warm → **defer** (bounded by `MAX_DEFER_MS`, re-checked each turn / on cold flip); else → don't.
3. **Post-action pre-warm:** after any compaction, fire a `max_tokens:0` prewarm on the new prefix (where the transport allows) so the next real turn is a cheap `cache_read`, not a cold write. Choose 5-min vs 1-hour TTL by observed inter-turn gap (continuous → 5-min free-refresh; gappy-but-active → 1-hour).
4. Surface tier/defer state on the existing `compactionStatus`/`CompactionEvent` channel.

**Acceptance:** stale tool-results are pruned for free before any summary; with a warm cache and sub-critical fill, compaction defers and fires on cold/critical/`MAX_DEFER_MS`; non-cache-reporting providers fall back to today's percentage trigger. +tests per branch.

**Risk:** Tier-0 pruning invalidates the cache at the clear point — only prune in batches past `clear_at_least` so the reclaim beats the re-write; through CLI wrappers Mysti can't control breakpoints, so this is most effective on the direct-API/gateway path.

---

## Phase 2 — Tier 1: the persistent compactor agent + economic decision (features ②③, "compactor agent")

**DeepMyst-gated.** The core of the user's ask: a cheap, reliable, *incremental* compactor that decides on real economics.

**Steps**
1. **Gate wiring:** inject `DeepMystAuthManager` + `DeepMystGatewayClient` into `CompactionManager` ([extension.ts:183](../src/extension.ts#L183)); `isSmartActive() = smartEnabled && deepMystAuth.isSignedIn() && hasEntitlement()`. `hasEntitlement()` reads tier + remaining free-monthly quota from `ensureActiveAccount()` (cached; backed by `/api/v1/me` and/or the gateway's `X-DeepMyst-Credits-Remaining` header) — true if paid or within the free allowance. On exhaustion or sign-out, fall back to standard compaction (never error).
2. **Structured memory** `.mysti/compaction/<panelId>/memory.md` with fixed H2 sections (`Goal`/`Decisions`/`Files`/`Code`/`Open Threads`). **Seed** once (cold start) by bootstrapping from history via the existing summarizer in sectioned form; **rehydrate** from disk on panel reopen (memory.md, not globalState, is source of truth).
3. **Incremental DELTA updates (the compactor agent):** on a compaction trigger, run in sub-session `${panelId}-compactor` **off the user-latency path** (between turns / on idle — Letta sleep-time). Input = `memory.md` + new turns since `lastCompactedSeq`; the cheap model returns a **section-scoped patch** (`{section, op: append|replace|remove, content}`) applied **deterministically in-process** — never let the model rewrite the whole file (keeps bytes stable → cache survives). Validate JSON defensively; on parse failure fall back to the existing flat re-summarize so memory never corrupts.
4. **Cheap transport:** route the compactor call through `DeepMystGatewayClient` (`claude-haiku-4-5`, `$0.25/$1.25`). *(Why not point the Claude CLI at the gateway via `ANTHROPIC_BASE_URL`? The gateway's Anthropic-native route needs internal headers a `dm_` key lacks, and N CLI cold-starts add latency — a direct `/v1/chat/completions` client is cleaner and parallelizes cheaply.)*
5. **Economic gate (feature ③)** after the fill check: compute break-even `N* = (Summarize + P·w) / ((C − P)·r)` (C = current prefix, P = `S + preservedTail`, w = cache-write mult for the panel's TTL, r = 0.1× base, Summarize = the *incremental* Haiku cost). Estimate remaining turns `N` (default ~6, refined from telemetry) and **compact only if `N ≥ N*`** — else let caching ride. Incremental memory roughly halves `N*` (worked: full pays off ~N≥4, incremental ~N≥2; never when the conversation is ending). The gate also **conserves the free-tier quota**: within the allowance the Haiku call is free to the user but burns monthly quota, so `N*` stops us spending quota on compactions that don't pay off.
6. **Quality floor (feature ③ "don't over-compact"):** assert `P ≥ MIN_SUMMARY_TOKENS` before committing (the silent-uncacheable trap); preserve last-N verbatim + never split a `tool_use`/`tool_result` pair + bias the summary to task-critical state (open files/decisions/goal) — re-inject the ~5 most-recently-touched files, Claude-Code-style.
7. **Settings:** `mysti.compaction.smart.enabled` (default **false**, requires DeepMyst), `mysti.compaction.cheapModel` (default `claude-haiku-4-5`), `mysti.compaction.minSummaryTokens`; read via the [_loadThreshold pattern :317-325](../src/managers/CompactionManager.ts#L317); flip live on [onDidChangeAuth :55-57](../src/managers/DeepMystAuthManager.ts#L55).

**Acceptance:** with a DeepMyst account, compaction maintains `memory.md` via incremental Haiku patches at materially lower cost than today's full re-summary, never compacts when `N < N*` or when `P` would fall under the cacheable floor, and reverts to today's behavior when signed out. +tests for the `N*` rule, the floor assertion, patch-apply + fallback, and memory rehydrate.

**Risk:** `N` is the load-bearing estimate — bias toward *not* compacting when uncertain (caching is cheap). Native `/compact` (Claude) is a black box — the economic rule degrades to a heuristic there; the rule is precise on the client/gateway path.

---

## Phase 3 — Tier 2: full-history file + parallel cherry-pick retrieval (feature ④)

**DeepMyst-gated; gateway-backed.** Resolve the caching tension explicitly.

**Steps**
1. **History store** `src/services/HistoryStore.ts`: append `{seq,ts,role,kind,content,tokensEst,msgId}` to `.mysti/compaction/<panelId>/history.jsonl` on every finalized message (hook the `addMessage` path; **not** globalState). `.gitignore` it; flag the privacy note (full transcripts incl. tool output land on disk).
2. **Balanced chunking:** split history (excluding the live window + what's already in `memory.md`) into `N = min(maxWorkers, ceil(total/targetChunkTokens))` contiguous, token-balanced sections on message boundaries.
3. **Parallel map-reduce retrieval** `RetrievalCoordinator`: **map** — each chunk → a Haiku scorer via `DeepMystGatewayClient` returning `[{quote, relevance, msgId}]`; reuse the [_interleaveGenerators :1648](../src/managers/BrainstormManager.ts#L1648) merge **with a concurrency cap** (it currently launches all at once — add a windowed launcher). **reduce** — dedup via [_calculateTextSimilarity :1615](../src/managers/BrainstormManager.ts#L1615) (~0.8), sort by relevance, take top-k under a token budget (~1.5k). Dropped/timed-out workers don't block the reduce.
4. **Cache-preserving injection:** add optional `memoryBlock` + `retrievedSnippets` params to [buildPromptAsync :1308](../src/providers/base/BaseCliProvider.ts#L1308). `memoryBlock` → the `systemContext` slot (~:1340) for non-resumed/other providers, or `--append-system-prompt` ([ClaudeCodeProvider.ts:294](../src/providers/claude/ClaudeCodeProvider.ts#L294)) for resumed Claude — the **stable cached prefix**. `retrievedSnippets` → appended **after** user `content` (~:1354) — the **volatile suffix** in the messages tier, which is new every turn anyway, so the system-tier cache keeps hitting.
5. **Trigger policy (avoid per-turn blowup):** retrieval fires only when **(a)** `mysti.compaction.retrieval.enabled`, **(b)** a compaction has occurred (memory exists) AND archived history exists, **(c)** a **free local Jaccard gate** ([_calculateTextSimilarity](../src/managers/BrainstormManager.ts#L1615)) says the prompt references something outside memory/the live window, **(d)** under a retrieval cooldown + per-session cap. Short/covered prompts pay **zero** extra LLM cost.

**Acceptance:** after compaction, a prompt referencing summarized-away detail pulls the right snippet back and answers correctly; `cache_read` on the system core stays high across turns (volatile suffix is small); retrieval does **not** fire on covered/short turns. +tests for chunking, top-k merge, the local gate, and the injection placement.

**Risk:** (a) for resumed Claude sessions the CLI may still hold server-side history, so retrieval's value is highest *after* `/compact` discards it or for non-resuming providers — make the trigger provider/compaction-state aware. (b) `cache_read` collapse is the regression signal — verify empirically. (c) batched single-call scoring may beat N parallel calls on latency — benchmark.

---

## Phase 4 — Savings ledger + always-on value surfacing (user ask)

**DeepMyst-gated (it's the premium value proof). Cross-cutting — accrues from Phases 1–3; UI ships once Phase 2 produces realized savings.**

**Steps**
1. **Ledger** (`SavingsLedger`, or extend `CompactionManager`): accumulate **realized** events `{kind, tokensSaved, usdSaved, at}`, per-session (memory) + lifetime (globalState). Compute `baselineCost − actualCost`; prefer the gateway's real `X-DeepMyst-Cost-USD` for `actualCost`, the pricing table for the counterfactual baseline.
   - **prune (Tier 0):** reclaimed tokens × current input rate (no model cost).
   - **cheap-model (Tier 1):** same summary at the active model's rate − the Haiku gateway cost.
   - **cache-timing (①):** preserved `cache_read` value from deferring to a cold window (flagged estimate).
   - **economic/avoided compaction (③):** realized over subsequent turns when a compaction pays off, or the avoided re-prime when one is correctly skipped.
   - **retrieval (④):** (full-context − core − suffix) × per-turn price − retrieval fan-out cost.
2. **`compactionSavings` webview message** `{session:{tokens,usd}, lifetime:{tokens,usd}, byKind}`.
3. **UI:** a persistent, calm chip beside the [`#context-usage`] pie (Plan 06 palette — one accent, dim): `◇ saved ~$0.42 · 38k tok`. Click → breakdown popover (by kind; session vs lifetime; **free-tier status** — "N of M smart compactions left this month", from `X-DeepMyst-Credits-Remaining`). Always visible while smart is active; when the free tier runs low/out, the popover shows a quiet upgrade prompt and the chip notes the fallback to standard compaction.
4. **Honesty guardrails:** count only *realized* savings; label estimates (`~`); reconcile every UI number against the telemetry log. (Optional upsell: when signed-in-but-off, a muted "smart compaction could save ~X here" teaser.)

**Acceptance:** after a Haiku summary the session total increments by the correct delta (and matches the gateway cost header); the chip is always visible while active; lifetime persists across reloads. +tests for ledger math per kind.

**Risk:** over-claiming — realized-only + estimate-labels + gateway-grounded actuals are the guardrails.

---

## Sequencing

```
Phase 0  Foundations: pricing(+gateway), cache model, DeepMystGatewayClient   — mostly no DeepMyst   ~1d
Phase 1  Tier-0 free prune + cache-aware timing + pre-warm                     — mostly no DeepMyst   ~1–1.5d
Phase 2  Compactor agent (incremental structured memory) + economic gate      — gated, gateway       ~2.5–3d
Phase 3  History file + parallel cherry-pick retrieval                         — gated, gateway       ~3–4d
Phase 4  Savings ledger + always-on UI                                         — gated                ~1–1.5d
```
Phases 0–1 are the no-/low-dependency wins (free prune + stop destroying a warm cache). Phase 2 is the headline (the compactor agent + the economic decision). Phase 3 is the retrieval layer. Phase 4 makes the value visible and can start as soon as Phase 2 emits realized savings.

## DeepMyst-side dependencies (confirmed 2026-06-14)

The gateway exists and the open questions are resolved:

1. **Public reachability — yes.** `gateway.v2.deepmyst.com` `/v1/chat/completions` is reachable for an external `dm_` Bearer. → Phase 0 gateway client is unblocked.
2. **Compression / `-auto` routing — NOT deployed.** Confirmed no-op. The design banks **only** the explicit cheap model (`claude-haiku-4-5`) + the real `X-DeepMyst-Cost-USD` headers; treat the suffixes as inert. (If it ships later, it's pure upside — revisit the economics then.)
3. **Provider keys — resolve automatically.** A `dm_` key resolves a provider key for the compactor model; the user need not connect their own Anthropic key.
4. **Billing — yes, with a free monthly tier.** Compactor + retrieval calls spend DeepMyst credits; **DeepMyst provides a free monthly allowance**, then paid. Mysti meters smart-compaction usage against that allowance and surfaces remaining quota in the savings UI.
5. **Entitlement — agreed, free-tier-aware.** A `/api/v1/me`-style endpoint returns `{tier, freeRemaining, periodResetAt}`; Mysti gates on it via `ensureActiveAccount()`/`hasEntitlement()` (paid **or** within free allowance), not just the syntactic `isSignedIn()`.

**Net-new DeepMyst-side build:** the free-tier entitlement endpoint (`{tier, freeRemaining, periodResetAt}`) + metering of smart-compaction calls against the monthly free allowance. Everything else is already live.

## Risks & guardrails

- **Mysti can't control CLI caching.** Cache reasoning is observational; breakpoint placement / frozen prefix / mid-conversation system role are only fully actionable on the direct gateway path — best-effort through CLI wrappers. Claude Code has had compaction/cache regressions (issue #29230) — test, don't assume.
- **The silent-uncacheable trap** (P < min cacheable prefix → `cache_creation=0`) — assert `P ≥ MIN_SUMMARY_TOKENS` before every commit.
- **Provider coverage is uneven** — treat `unknown` warmth as cold; non-reporting providers fall back to today's behavior.
- **Recursive-summary drift** — re-ground `memory.md` against the authoritative `history.jsonl` periodically; keep eviction ≠ deletion (everything stays retrievable).
- **Transcript-on-disk privacy** — `history.jsonl` holds full tool output (possibly secrets); `.gitignore`, consider redaction, never persist credentials.
- **Don't regress brainstorm** — per-agent `${panelId}-brainstorm-${agentId}` tracking ([ChatViewProvider.ts:3885-3893](../src/providers/ChatViewProvider.ts#L3885)) must not be silently swept into the new path.
- **Savings honesty** — realized-only, estimate-labeled, reconciled to the telemetry log and gateway cost headers.
- **Tests** — suite is at 1059/1059; land each phase with tests and bump the count.

## Out of scope

- Changing how CLIs cache, or adding `cache_control` to CLI requests (not possible from Mysti).
- A vector/embedding index — Phase 3 uses cheap-model map-reduce + a Jaccard gate over the file; revisit embeddings only if that proves too costly (the gateway does expose `/v1/embeddings` if needed later).
- Depending on DeepMyst's compression/`-auto` routing — **confirmed not deployed**; the design banks only the explicit cheap model + real cost headers (revisit only if it ships).
- Compaction for providers that report no usage (ollama/qwen/opencode/localai/manus) — no usage events, so smart triggering can't apply.
- Building Mysti's own direct `api.anthropic.com` client — the confirmed transport is the DeepMyst gateway; the only non-gateway summarizer route is the existing Claude CLI (`--model haiku`).
