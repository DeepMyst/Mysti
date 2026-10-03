# 09 — Cache-Honest Smart Compaction + Router-for-Compaction (Mysti Agent, MVP slice)

- **Date:** 2026-06-20 (revised twice after two adversarial design-review iterations — see "Review history")
- **Status:** DRAFT — **cleared to code** after the residual precision fixes below were folded in (2nd review: `minor-fixes-then-code`, 7/10).
- **Supersedes:** the original "big-bang orchestrator" Plan 09 (1st review: 5/10, two disqualifiers — delegation bypassed the permission gate; cache/economics were false on the CLI path). The orchestrator vision is preserved but **split**:
  - **09 (this file)** — finish Plan 08 honestly + a model router used *only* to pick the compaction model. **No async, no delegation, no pseudo-provider.** The MVP.
  - **[10 — Async substrate + security floor](10-async-substrate-and-security-floor.md)** — hardening prerequisite for any delegation.
  - **[11 — Mysti Orchestrator (coordinator)](11-mysti-orchestrator.md)** — `@mysti`, DAG delegation, backend routing. Gated on 09 + 10.
  - **[12 — Self-improvement, workflows & tools](12-self-improvement-and-workflows.md)** — skills/`skill_view`, background-review/Curator, workflow engine, Hermes. Gated on 11.
- **Inputs:** Plan 08; the verified code scout; the 4 research threads; and two 6-/5-lens adversarial reviews (13 critical + 21 high in round 1; 27 residual, 0 disqualifying in round 2).

---

## Goal

Prove the **economic premise** before building anything on top of it. Finish Plan 08's smart compaction *honestly* — owning that, on the cli-resume path the registered CLI backends use, compaction is a forced cold reseed — and add a `ModelRouter` used **only** to pick the cheapest reliable compaction model (via the gateway). Validate every savings claim against the gateway's real `X-DeepMyst-Cost-USD`. Ship on existing tested code (suite at 1059/1059) with **no new attack surface**.

**Explicit non-goals (moved to 10/11/12):** no `@mysti` provider, no `dispatch_agent` tool, no sub-agents, no async/background jobs, no hooks, no self-improvement, no workflow engine, no cross-provider/user-turn model routing.

---

## Honest framing (review corrections)

- This plan **rewrites parts of** Plan 08: `SmartCompactor.summarize` (whole-file write today, `writeFile :391`), `evaluate` (no prune tier today), and the prompt-assembly injection.
- **"Cache survives compaction" is false on the cli-resume path.** A successful smart summarization calls `clearSessionForProvider` (`ChatViewProvider.ts:3818-3826`, "drop the provider session so the NEXT turn reseeds") — a forced cold reseed (`cache_creation`, zero `cache_read`) for every `--resume` backend. Byte-stable `memory.md` does not save the cache when committing it drops the session.
- **There is no "system tier vs user tier" at the Mysti layer for CLI providers.** `buildPromptAsync` (`BaseCliProvider.ts:1399`) builds **one flat concatenated prompt string**; the CLI owns its own caching. So "byte-stable system prefix" is **not** a CLI-path lever. It applies only to (a) `prompt-history` re-send providers where Mysti sends the whole prompt each turn (ordering affects the *provider's* upstream cache), and (b) a future native gateway path (Plan 11). State this per-`sessionKind`, never as a universal win.
- **`sessionKind` is `cli-resume | prompt-history | none`** (`IProvider.ts:75`) — there is no `gateway-native` value today. The stateless **`none`** class (cursor/manus/localai/ollama and any non-usage-reporting backend) has *no caching at all* and must skip all cache-warmth/economic math.

---

## Design principles

1. **Economics measured, not asserted.** Every savings entry is grounded in the gateway's billed `X-DeepMyst-Cost-USD` (realized) or labelled `estimated:true`. The ledger gains a **`spent`** field so net value (savings − cost-incurred) is always honest. *(This requires real type surgery — see Phase A step 6; it is an acceptance gate, not a passing mention.)*
2. **Cache reality is per-`sessionKind`.** Branch the economic gate on the active provider's `capabilities.sessionKind`:
   - **`none`** → no caching; never apply cache-warmth/`cache_read` credit; compaction decided on raw token pressure only.
   - **`cli-resume`** → every compaction is a guaranteed cold reseed; `N*` includes a mandatory `cache_creation` (write-mult) term and **no** `cache_read` preservation credit; the only win is cheaper *summary* tokens.
   - **`prompt-history`** → Mysti controls the full re-sent prompt, so byte-stable ordering helps the provider's upstream cache; today's warmth-aware `N*` applies.
3. **Router-for-compaction only.** `ModelRouter` picks the compaction model through `DeepMystGatewayClient` (where the per-provider cross-provider model-id guard does **not** apply — we call the gateway directly, not a CLI provider). No routing of user turns (that's Plan 11, with the `routedModel` precedence problem).
4. **Behavior-preserving, fail-CLOSED entitlement.** Smart features stay DeepMyst-gated; when off, today's threshold compaction is byte-for-byte. **The entitlement fail-open is fixed in THIS plan** (it's the first slice to incur gateway cost) — see the cross-cutting fix.
5. **No new attack surface.** Nothing here adds a model-callable tool, a sub-agent, or a background job.

---

## Economic & Performance Model (grounded, calculated)

All rates verified against the Claude API reference (cached 2026-06-04) and `ModelPricing.ts`/`constants.ts`. **The code's price table is correct as written** (Opus 4.8 `$5/$25`, Sonnet 4.6 `$3/$15`, Haiku 4.5 `$1/$5` per MTok; cache read `0.1×`, write `1.25×`@5m / `2×`@1h; min cacheable prefix **4096 tok Opus/Haiku, 2048 tok Sonnet**, 5-min default TTL). DeepMyst gateway Haiku is `$0.25/$1.25` (4× below first-party). Each figure is tagged **[R]** realized (reconcilable against the gateway `X-DeepMyst-Cost-USD` header), **[C]** calculated from those rates, or **[E]** estimate / external-cited.

### Lever 1 — cheap-model summarization (the headline cost win) [C, R-reconcilable]
One compaction summarizing an 80k-token older slice → a **5k**-token summary (respecting the `SMART_MIN_SUMMARY_TOKENS=5000` floor):
- Today (re-summarize on the active model, Opus 4.8): `80k×$5/MTok + 5k×$25/MTok = $0.40 + $0.125 = $0.525`.
- Smart (gateway Haiku `$0.25/$1.25`): `80k×$0.25/MTok + 5k×$1.25/MTok = $0.020 + $0.00625 = $0.0263`.
- **≈ 20× cheaper / ~95% reduction per compaction** (`$0.525 → $0.0263`; the ratio is summary-size-independent — both sides scale). The Opus counterfactual is never billed, so this is **realized only once the SavingsLedger reconciles the smart side against a real `X-DeepMyst-Cost-USD`** — book it then, label it `~` until.

### Lever 2 — delta-patch incremental memory [C/E]
Today's `summarize()` re-summarizes the **whole** growing older slice every pass (≈ O(k·C) over k compactions). Delta-patch summarizes only new turns since `lastCompactedSeq` (≈ O(C)). Over a 5-compaction session this is **~2–2.5× fewer summarization input tokens** (e.g. ~500k → ~210k tokens processed), independently corroborated by Letta sleep-time compute (~2.5× lower cost/query). Compounds with Lever 1.

### Lever 3 — N\* economic gate (don't over-compact a warm cache) [C]
Gateway-native path, prefix `C=120k`, post-compaction prefix `P=20k` (5k summary + 15k preserved tail). Both cases reconcile with `SmartCompactor.evaluate()` (`SmartCompactor.ts:216`, `summarizeCost = read C + write P on the cheap model`):
- Per-turn cost of **not** compacting: re-read `C` at cache-read `0.1×$5 = $0.50/MTok` → `120k×$0.50/MTok = $0.060/turn`.
- Per-turn saving after compaction: `(120k−20k)×$0.50/MTok = $0.050/turn`. The cache-write of `P` on the **main** model (`1.25×$5 = $6.25/MTok`) costs `20k×$6.25/MTok = $0.125` once.
- **Today's shipping formula** (reads the whole `C` on the cheap model, no delta-patch): `summary = 120k×$0.25/MTok + 20k×$1.25/MTok = $0.030 + $0.025 = $0.055`; upfront `= $0.055 + $0.125 = $0.180`; **`N* = $0.180/$0.050 = 3.6 → 4-turn gate`**.
- **With delta-patch (Lever 2, a Phase A deliverable)**: the summary reads only the ~42k delta → `42k×$0.25/MTok + 5k×$1.25/MTok = $0.0105 + $0.00625 = $0.0168`; upfront `= $0.0168 + $0.125 = $0.142`; **`N* = $0.142/$0.050 = 2.84 → 3-turn gate`**.
- So compact only if **≥3–4 turns remain** (delta-patch vs today's formula); under continuous warm traffic (5-min cache refreshes free) the right count is often **zero**, avoiding `~$0.14–0.18` of reseed per unnecessary compaction. *(On cli-resume this lever does not apply — every compaction is a forced cold reseed; see principle 2.)*

### Lever 4 — Tier-0 free prune [C]
Dropping stale tool-result payloads costs **$0** (no model call). Reclaiming ~30k stale tokens removes `~30k×$0.50/MTok = $0.015/turn` of cache-read carry for free, and defers a paid compaction. Always cheaper than a summary; run first.

### Speed / latency [E + C]
- **User-perceived compaction latency ≈ 0**: the compactor runs off the latency path (between turns / on idle), vs today's inline re-summarize that blocks the turn. *[E]*
- **Summarization model ~3–4× faster**: Haiku vs Opus *throughput* (the gateway adds one network round-trip, absorbed off-latency so user-perceived latency stays ≈0). *[E]*
- **Retrieval up to ~4× faster**: cap `= RETRIEVAL_MAX_WORKERS=4`; realized `= min(4, #history chunks)` minus scheduling/network overhead — an upper bound, not a fixed speedup. *[C/E]*
- **Prune: instant** (no model call). *[C]*

### Quality [C + E]
- **No silent-uncacheable trap**: `SMART_MIN_SUMMARY_TOKENS=5000` sits safely above the 4096-tok Opus/Haiku floor (and 2048 Sonnet) — a sub-floor prefix silently sets `cache_creation=0` and loses the whole cache. *[C]*
- **Effective window preserved**: post-compaction cherry-pick retrieval recovers summarized-away detail (top-`5`, `1500`-tok budget) so correctness on prompts referencing dropped detail is retained. *[C]*
- **Contract integrity**: never splitting `tool_use`/`tool_result` prevents broken-context failures across the 13 backends. *[C]*
- **+13–18% task accuracy** reported for off-latency incremental memory (Letta sleep-time compute — *their* benchmark, not our measurement). *[E, external]*

### Net per heavy session (illustrative) [C/E, ranged] — split by sessionKind
A ~50-turn session with ~5 compactions. **Summarization-subsystem spend** (the realized, gateway-reconcilable part):
- Baseline: `5 × $0.525 = $2.63` (full re-summaries on Opus 4.8).
- Smart, **gateway-native path**: `5 × $0.017` (delta-patch) to `5 × $0.055` (today's formula) `= $0.09–$0.28` → **~9–30× cheaper on summarization**, plus N\*-avoided reseeds (`~$0.14–0.18` each) as additional upside, and compaction latency moved off the user's turn.
- Smart, **cli-resume path (the dominant registered backends)**: the summary-token saving applies *where Mysti does the summarization*, but every compaction forces a **cold reseed** (full-prefix `cache_creation`, e.g. `120k×1.25×$5/MTok = $0.75` each) that Mysti cannot avoid and that **dominates** — so do **not** quote the gateway-native multiple here; the honest cli-resume claim is "cheaper summary tokens, same reseed."

The savings ledger must **reproduce the realized deltas against real `X-DeepMyst-Cost-USD`** and label estimates `~` (this is the Phase A acceptance gate, not a marketing line).

---

## Phase A — Smart Compaction v2 (finish Plan 08, honestly)

**DeepMyst-gated.**

**Steps**
1. **Delta-patch incremental memory:** switch `SmartCompactor.summarize` (`:274`) / `_buildMemoryPrompt` (`:397`) to emit/apply `MemoryPatch[]` (types exist, `types.ts:521-528`) against fixed `memory.md` sections, applied deterministically in-process (replaces the whole-file `writeFile :391`). Benefit: cheaper summary tokens on every path; byte-stable `memory.md` *only* helps the `prompt-history` path.
2. **Tier-0 free prune:** implement the `tier:'prune'` branch in `evaluate` (`:186`) — drop/placeholder oldest tool-result payloads (keep last ~3 pairs) with a `clear_at_least` floor so the reclaim beats the rewrite; record the `prune` saving.
3. **`sessionKind`-aware `N*` (plumbing required — not a one-line edit):** add `sessionKind` (+ a `cacheReporting` flag) to `EvaluateParams` (`SmartCompactor.ts:78-89`); have `CompactionManager.evaluateCompaction` (`:363-393`) read the active provider's `capabilities.sessionKind` (via the `ProviderManager` it must now hold) and pass it through. Branch per principle 2. **Replace the hardcoded `remainingTurns = SMART_DEFAULT_REMAINING_TURNS` (`:207`)** with a **new per-panel turns-since-last-compaction counter** maintained in `CompactionManager` (in-memory + `globalState`), fed as an EWMA — *not* "from telemetry" (telemetry is write-only/opt-in with no read API). Until the sample count clears a threshold, keep `SMART_DEFAULT_REMAINING_TURNS` as the documented floor and mark `projectedSavingsUsd` `estimated:true`.
4. **Injection placement is `sessionKind`-specific (correct seam):** `buildPromptAsync` (`BaseCliProvider.ts:1399`) is one flat string. For **`cli-resume`**, inject `memoryBlock` near the user content (it is uncached regardless; the CLI owns caching) and accept it. For **`prompt-history`**, keep the stable instructional content first and the volatile `memoryBlock`/turn last so the provider's upstream cache prefix stays stable. Do **not** claim a Mysti-controlled "system-tier byte-stable prefix" on the CLI path — it doesn't exist there.
5. **Message-contract integrity:** never split `tool_use`/`tool_result`, anchor the tail (last user + last visible assistant), sanitize orphans.
6. **Ledger type surgery (acceptance gate):** add `spent`/`costUsd` to `SavingsEvent` and `SavingsTotals`, a `net` field to `SavingsSnapshot`, and `'model-routing'`/`'prune'`/`'avoided-compaction'`/`'retrieval'` to `SavingsKind` (`types.ts:491`); fix `SavingsLedger.record` (`:51`) which currently discards cost-only events. Replace `length/4` with `estimateTokens`.

**Acceptance:** memory maintained by section-scoped patches; stale tool-results pruned for free; `N*` branches on real `sessionKind` (incl. a `none` no-cache branch) using a measured per-panel `remainingTurns` (or the documented floor + `estimated` flag); the ledger records realized savings **and** `spent`, surfaces `net`, and reconciles against `X-DeepMyst-Cost-USD`; cli-resume compaction is labelled a cold reseed, never credited with preserved cache. +tests per branch; reconcile the suite total with `vitest run` at code time (currently ~1k tests).

**Risk:** native `/compact` (Claude) is a black box — the rule is precise only on the gateway path; treat `unknown` warmth as cold. On cli-resume the win is *cheaper summary tokens*, not preserved cache — do not overclaim.

---

## Phase B — `ModelRouter` (compaction model only)

**Mostly no DeepMyst.**

**Steps**
1. **Capability profiles** `src/services/ModelCapabilities.ts`: per (provider, model) tags + context window + speed tier, **data-driven with a family-pattern regex fallback** (shape of `ModelPricing.ts:42-50`) so unseen discovered/custom models still get a profile.
2. **`ModelRouter.pickCompactionModel(panel) → {model}`** scoped to **gateway models only** (where `DeepMystGatewayClient` calls bypass the per-provider cross-provider guard). Score = reliability-for-summarization then cost; **degrade to quality+speed when `getModelRate` is null** (null-cost = ineligible for cost ranking, not "free"); require `getContextWindow ≥ estTokens` (undefined window ⇒ ineligible, fall back to the configured `cheapModel`).
3. **Wire-in:** feed the chosen model into **both** `EvaluateParams.cheapModel` and `SummarizeParams.cheapModel` so `N*` tracks its real gateway rate.
4. **Ledger:** `model-routing` kind, always `estimated:true`; only booked when the baseline rate is known; never when a quality/respawn signal fires.

**Acceptance:** the compactor's model is router-chosen within window/budget, falls back to `cheapModel` when data is missing, and `N*` reflects the chosen model's rate; routing savings are estimate-labelled and only booked with a known baseline. +tests for scoring, null-cost degrade, window gating, fallback.

**Risk:** do **not** extend this router to user-turn / cross-provider model selection here (Plan 11, where the `routedModel`-vs-`_getEffectiveModel` precedence collision with the issue-#39 respawn logic lives).

---

## Cross-cutting fix carried by this plan (entitlement — fixed here, not deferred)

The entitlement check currently **fails open**: `hasEntitlement()` returns `true` optimistically (`DeepMystAuthManager.ts:144`) and `ensureActiveAccount` maps 404/5xx (`:203`) and any exception (`:206`) to `entitled:true`. Because Plan 09 is the **first slice to spend gateway money**, fix it here:
1. **Flip the defaults to fail-closed-to-free-tier** (`:144/:203/:206`) — a near-one-line default change, no async dependency (this is Plan 10 Part 1 Step 5 pulled forward because it gates *this* plan's spend).
2. **Local cost ceiling:** accumulate **locally-observed `costUsd`** (the gateway returns `x-deepmyst-cost-usd`, `DeepMystGatewayClient.ts:110`) into a per-day cap in the `SavingsLedger`/`CompactionManager`; stop smart compaction for the day when the cap is hit. **Do not** reference `X-DeepMyst-Credits-Remaining` — that header does not exist in the gateway responses.

---

## Sequencing

```
A  Smart Compaction v2 (honest, sessionKind-aware)   gated (gateway)   ~3–4d
B  ModelRouter (compaction model only)               mostly no DeepMyst ~2d
   + entitlement fail-closed flip + local cost ceiling (folded into A)
```
Soak across ≥1 F5 session and validate the ledger `net` against real cost headers **before** starting Plan 10.

---

## Out of scope (explicit — owned by other plans)

- **Cherry-pick retrieval / `RetrievalCoordinator`** stays owned by **Plan 08 Phase 3** (WIP); it is *not* in this MVP. Plan 11 D3b's gate references Plan 08 Phase 3, not "Plan 09 retrieval."
- Async/jobs, hooks, the security floor (un-allowlist `task`/`agent`, panel-independent gate) → **Plan 10**.
- `@mysti`, `dispatch_agent`, DAG delegation, cross-agent/user-turn routing, `routedModel` precedence → **Plan 11**.
- Self-improvement, `skill_view`, workflow engine, Hermes backend → **Plan 11/12**.
- A vector/embedding index; per-panel settings store.

---

## Review history

- **2026-06-20 (round 1):** original big-bang Plan 09 — 6-lens adversarial review, 5/10, revise-then-proceed. Disqualifiers: security-gate bypass + economics-fiction-on-CLI-path. → split into 09/10/11/12 with must-fixes as acceptance gates.
- **2026-06-20 (round 2):** the revised 09–12 set re-verified (regression/coherence/MVP/security/residual). Verdict: `minor-fixes-then-code`, 7/10; both disqualifiers resolved (security removed-from-MVP + deferred-with-fixes to Plan 10; economics corrected in framing). Residual precision fixes folded into this file: entitlement fixed here (not deferred) with a real local-cost ceiling; ledger `spent`/`net` made a typed acceptance gate; `sessionKind` taxonomy corrected to `cli-resume|prompt-history|none` (+ a `none` branch); `remainingTurns` sourced from a new per-panel counter (not telemetry); `buildPromptAsync` corrected to `:1399`/one-flat-string (no CLI system tier); retrieval ownership pinned to Plan 08 Phase 3.
