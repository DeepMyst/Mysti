# 13 — Unified Token Optimization: A Cache-Subordinate, Reversible, Holdout-Governed Layer

- **Date:** 2026-07-05
- **Status:** DRAFT
- **Inputs:** A 4-agent deep-read workflow over (a) Headroom's implementation (`headroomlabs-ai/headroom` — Rust `headroom-core`/`headroom-proxy` + Python runtime), (b) both DeepMyst optimizers — the ORIGINAL wired gateway (`DeepMyst-Gateway/optimizer/` + `router/deepmyst_handler.py`) and the DEAD v2 engine (`connections-hub/apps/compression` + `apps/gateway/src/middleware/compression.py`), (c) our Plan 08 smart compaction + shipped code, and (d) the 2024–2026 SOTA (LLMLingua-2, the "Characterizing Prompt Compression" empirical study, "Don't Break the Cache", Anthropic context-editing, MemGPT/Letta, Chain-of-Draft). Source refs inline.
- **Trigger:** User — "litellm introduced headroom … understand headroom then compare what we are doing and existing token optimization with headroom … run a workflow to understand the implementation of headroom, the implementation of the original token optimization in the original deepmyst gateway, the plan, and then provide how we can come up with something better than both combined."

---

## Goal

Replace the scattered, partial, and (in DeepMyst's case) **broken** token-optimization efforts with **one coherent optimization layer** that (1) is *cache-subordinate* — it never destroys the prompt cache it depends on; (2) is *reversible* — lossy on the wire, lossless end-to-end; (3) is *tool-safe* — never orphans a `tool_use`/`tool_result` pair or corrupts embedded JSON; (4) is *measured* — every action gated on real net savings with a quality holdout, so it can never silently lose money or degrade answers; and (5) spans **all four optimization axes**, which the three existing systems each only partially cover.

It lives primarily at the **DeepMyst gateway** (so every client benefits) with **Mysti's smart compaction (Plan 08/09) as its cross-turn component**.

---

## Design principles (the SOTA hands us these)

1. **Cache-subordination — "compress the cold tail, never the warm prefix."** Prefix caching and compression are *antagonistic on the warm path*: a cached read is **0.1×** (Anthropic) but any prefix byte-change forces a full recompute + a 1.25×–2× rewrite, so rewriting cached tokens **net-loses money** ("Don't Break the Cache", arXiv 2601.06007). Partition every request into a **frozen prefix** (cache-warm, byte-immutable, computed from `cache_control` markers) and a **mutable cold tail**; only ever transform the tail.
2. **Extractive-and-point beats abstractive-and-inline.** Empirically (arXiv 2407.08892) a plain extractive reranker reaches **~10× with accuracy *gains*** while perplexity token-pruning (LLMLingua-style) is *often the worst* method — it shreds grammar/JSON/tool-calls. Select-and-keep-verbatim + a pointer to the dropped original; paraphrase only genuinely-redundant prose.
3. **Reversible by pointing, not by hoping the model self-expands.** Relocate dropped/summarized content to a store, keep a *deterministic* pointer + short summary in-context, retrieve on demand. Lossless end-to-end **and** cache-stable (pointer bytes are deterministic). This is exactly what DeepMyst's optimizer gets wrong (ships opaque `@DUP_hash@` / dictionary abbreviations with no reversible map) and what Headroom's CCR gets right.
4. **Route by content safety.** Never prune code/JSON/tool-calls; only free-form prose. Structured → dense lossless re-encode; code → AST-preserving; prose → extractive selection.
5. **KV-eviction / soft-tokens / CAG are self-hosted-only.** They live in the serving engine and are inaccessible over closed hosted APIs — reserve them for a future self-hosted-model backend tier, never claim them for the closed-API path.
6. **Fail-open, everywhere.** Any transform error → forward the original request unchanged. Never panic on the hot path (Headroom's discipline; DeepMyst's dead middleware is the counter-example).

---

## Current-state (grounded): three systems, three killer gaps

### A. Headroom — within-request compression, done right, but history-blind
Compresses only the **latest user turn's cold live zone** (tool_result/text above the frozen floor) via **byte-range surgery** on `serde_json` RawValue offsets, so untouched bytes stay byte-identical and the cache still hits (`headroom-core/src/transforms/live_zone.rs`, `cache_control.rs:compute_frozen_count`). Reversible via a content-addressed **CCR store** + a `headroom_retrieve(hash)` tool. Tokenizer-gated acceptance, auth-mode gating (only PAYG gets lossy), an output-shaper (Chain-of-Draft-style). **Gap:** it re-sends accumulated history uncompressed (relies on cache) → long sessions still grow; the CCR store is 30-min in-memory by default → retrieval silently degrades to lossy after TTL/restart; retrieval costs an extra round-trip.

### B. DeepMyst optimizer — the anti-pattern (and mostly dead)
- **ORIGINAL** (`DeepMyst-Gateway`, WIRED via the `-optimize` suffix, `DEEPMYST_DISABLE_OPTIMIZATION=false`): dictionary substitution (278+337+602+969 entries) + suffix-array dedup + Groq **Llama-3.1-8b** summarization + relevance drop, rewriting whole messages. A full `decompress` path **exists but is never called** — the model gets compressed text one-way and must self-expand from a 6-example hint (not the 969-entry map) → **lossy**. **Not cache-aware** (0 `cache_control` hits — busts the cache). **Not tool-safe** (regex-subs corrupt embedded JSON; suffix compressor reorders system/user and injects a system message → orphans tool pairs; the repo literally ships `test_orphaned_tool_messages.py`).
- **v2** (`connections-hub/apps/compression`): a cleaner rewrite (O(n) Rabin-Karp dedup, typed, fail-open) that is **triply-dead** — `CompressionMiddleware` is never added to `create_app()`, would self-disable via a `from src.optimizer` package-name collision if it were, and every router hardcodes `prompt_tokens_compressed = prompt_tokens` / `compression_savings_usd = 0.0`. So even wiring it would ship a degraded prompt while reporting zero savings.

### C. Ours (Plan 08) — cross-turn compaction, right axis, real gaps
Persistent incremental memory + cache-aware economic timing (`N*`) + cherry-pick retrieval + realized-savings ledger. **Gaps** (from the code read): no within-request prune (Tier-0 `prune` kind defined, never recorded); **no output-token reduction**; `estimateTokens = chars/4` drives every economic figure; `remainingTurns` is a **constant 6**, not measured; the message slice can **split tool pairs**; the byte-stable **delta-patch memory was never implemented** (each compaction re-emits the whole `memory.md`); and the **Claude reseed forces a cold cache reset** (`clearSessionForProvider`) — fighting the very cache economics the module optimizes for.

**The three occupy three different axes.** None spans all four; each has one fatal defect; and none has quality-holdout governance.

---

## The unified architecture — one layer, six stages, all cache-subordinate

Every request is split into a **frozen prefix** (from `cache_control` markers — Headroom's `compute_frozen_count`) and a **mutable cold tail**. Only the tail is transformed. Stages run in order; each is fail-open and independently flag-gated.

```
request ─► L0 stabilize ─► L1 compress-cold-tail ─► L2 compact-history ─► L3 shape-output ─► provider
                 │                │                        │                   │
                 └───────── L5 measure + holdout ──────────┴─── gate ──────────┘
                                          │
                          L4 unified reversible store  ◄── retrieve(hash) / proactive cherry-pick
```

- **L0 — Cache stabilization** *(the free win; nobody does it at the DeepMyst gateway)*. Deterministically sort `tools[]` + recursively sort JSON-Schema keys (kills hash-randomized SDK ordering that silently busts cache), auto-place **one** `cache_control` breakpoint for naive callers, strip volatile fields (timestamps/UUIDs/request-ids) out of would-be-cached spans, emit a stable `prompt_cache_key`. Banks the **90% Anthropic / 50% OpenAI** prefix discount *before* any compression. Steal Headroom's `cache_stabilization` suite. Zero quality risk. *(headroom-proxy `cache_stabilization/*.rs`.)*
- **L1 — Within-request cold-tail compression** *(Headroom's domain, SOTA-correct)*. Content-routed on the cold live zone only: structured JSON/CSV/logs → dense **lossless** re-encode (`[N]{col:type}` CSV+schema) or extractive row-select; code → tree-sitter AST (keep imports/signatures/types, compress bodies, guarantee re-parse); prose → **extractive** sentence selection (NOT perplexity pruning). Reversible by pointing to L4. **Tokenizer-gated** (accept only if tokens actually drop, marker counted). Byte-range surgery so untouched bytes stay identical. *We lack this entirely.*
- **L2 — Cross-turn compaction** *(our Plan 08/09, SOTA-corrected)*. Triggered by the cache-aware `N*` — but with a **real tokenizer** (not `chars/4`), a **measured** remaining-turns EWMA (not constant 6), **tool-pair-safe** slicing, and **extractive-first** (move oldest tool-results to L4 with deterministic placeholders — Anthropic's `clear_tool_uses_20250919` ordering; abstractively summarize only redundant prose). Memory kept **byte-stable via deterministic delta-patches** so the cached system tier survives compaction. Runs **sleep-time** (async between turns) on the cheap gateway model. **Fold the Claude cold-reseed cost into `N*`** so we only reseed when it clears *including* the forced `cache_creation`.
- **L3 — Output-token reduction** *(nobody in our stack)*. Inject **Chain-of-Draft** / effort directives at the **byte-stable tail** of the system prompt (after the cache breakpoint, so the cached prefix is unchanged), structurally gated to mechanical/reasoning turns. **~80% fewer reasoning tokens, ~few-point accuracy cost** (arXiv 2503.01141; Chain-of-Draft). Output is 5–25× pricier than cached input. *(Headroom's `output_shaper.py`.)*
- **L4 — One unified reversible store + retrieval** *(merge Headroom CCR + our `history.jsonl`/`RetrievalCoordinator`)*. A single **durable** (Sqlite/Redis, not 30-min in-memory) content-addressed store holding both within-request dropped blobs **and** the full transcript, exposing **both** a `retrieve(hash)` tool (reactive) **and** proactive cherry-pick injection into the volatile user suffix (predictive — avoids the round-trip). Secret redaction before storage; actionable miss contract (re-read the file / re-run the command).
- **L5 — Holdout-governed, cache-hit-aware net-savings ledger** *(the trust differentiator)*. Gate every action on **measured** net savings using the gateway's real `X-DeepMyst-Cost-USD` header (our ledger), and run a **10% holdout control group** (Headroom's idea + the SOTA's demand for quality validation). Anything that net-loses money (broke cache) or fails the holdout (degraded quality) **auto-disables itself**. DeepMyst's optimizer has none of this; ours has realized-cost but no quality holdout.

**Two backend tiers.** Closed-API tier (Anthropic/OpenAI via gateway) = L0–L5 above. Self-hosted-model tier (if DeepMyst ever hosts open weights) *adds* SnapKV/H2O KV-eviction + soft-token compression at the serving layer — a router choice, never claimed for the closed path.

---

## Source-contribution map (what we take from each)

| From | We take | Corrected by SOTA |
|---|---|---|
| **Headroom** | byte-range surgery, frozen-prefix, CCR reversibility, tokenizer gate, auth-mode gating, cache-stabilization (L0), output-shaper (L3), content-routed compressors (L1) | add durable store (not 30-min in-memory); prefer extractive over its ML prose model for high ratios |
| **DeepMyst optimizer** | adaptive age×size ratio, content-addressed dedup, two-tier dictionary (lossless layer), embedding acceptance gate | **only with a server-side reversible map (never opaque markers), cache-safe, tool-safe** — i.e. everything it does wrong becomes a requirement |
| **Ours (08/09)** | cross-turn memory + retrieval axis (L2/L4), cache-aware `N*`, min-cacheable floor, realized-savings ledger w/ real cost header, cache-preserving injection topology, gateway + billing + entitlement | real tokenizer, EWMA `N`, delta-patch, tool-pair guard, reseed-cost-in-`N*` |
| **SOTA** | cache-first / compress-cold-only, extractive>perplexity, reversible-by-pointing, Anthropic context-editing ordering, Chain-of-Draft (L3), sleep-time compute, holdout measurement (L5), self-hosted-only KV tier | — |

---

## Phases (ROI order — highest, safest, cheapest first)

## Phase 1 — L0 cache stabilization + L3 Chain-of-Draft (the free wins)

**Gateway-side, near-zero engineering, cache-safe, large savings, independent of everything else.**

**Steps**
1. A pure `stabilize(body)` transform (OpenAI + Anthropic shapes): deterministic `tools[]` + JSON-Schema key sort (skip if any tool already carries `cache_control`), auto-place one ephemeral `cache_control` for naive Anthropic callers who set none, derive a stable `prompt_cache_key`, detect (and optionally strip from would-be-cached spans) volatile timestamp/UUID/id fields.
2. A pure `shape_output(body)` transform: append a **byte-stable** Chain-of-Draft / brevity directive to the *tail* of the system prompt (after the last `cache_control`), and lower an **existing** `effort`/thinking budget only on structurally-classified mechanical continuations — never inject effort where absent, never toggle `thinking.type`.
3. Wire both as a fail-open pre-provider transform behind `DEEPMYST_OPT_STABILIZE` / `DEEPMYST_OPT_OUTPUT_SHAPER` env flags (default off), with a 10% holdout hook stub.

**Acceptance:** on fixtures, tool/schema reordering produces byte-identical prefixes across turns (cache stays warm); the CoD block is idempotent and lands after the breakpoint; both fail open on malformed bodies. +unit tests for OpenAI + Anthropic shapes.

**Risk:** over-eager volatile-field stripping could change semantics — start with *detect + log*, strip only well-known non-semantic fields.

## Phase 2 — L1 within-request compression (adopt Headroom, don't rebuild)

**Status (2026-07-05) — LANDED as a call-out (commit e5db73d on PR #565), default OFF.**

Research finding that reshaped this phase (workflow `headroom-litellm-research`, all facts source-cited): LiteLLM *did* ship a native Headroom integration (BerriAI/litellm **#31407**, merged 2026-06-27) — but it is **not usable for us as documented**: (1) it is a LiteLLM **proxy-server** guardrail, and our gateway calls the bare `litellm.acompletion()` SDK where `pre_call` hooks can't mutate the request → adopting it means adopting the whole proxy server; (2) it requires **v1.92.x, which has no stable release** (only dev/rc pre-releases; latest stable v1.91.0 lacks the code); (3) it **fails CLOSED** (502 on Headroom outage) and (4) delegates all cache-safety to the external service. The `retrieve_headroom`/CCR tool is unmerged.

**What shipped instead** — an explicit async call-out to a Headroom-compatible `/v1/compress` sidecar at the existing **5c/5d** seam (`apps/gateway/src/optimize/compress.py` → `maybe_compress_chat_body`), reusing the L0/L3 flag-gated/fail-open/identity-preserving contract. **Cache-subordinate**: only the LIVE ZONE (messages after the last `cache_control` breakpoint) is ever sent, so the warm prefix stays byte-identical; with no breakpoint, only the current message is offered. **Fail-open** (unlike the native guardrail): any sidecar outage/timeout/malformed reply forwards the request unchanged. Keeps litellm on its current pin. Flags (default off): `DEEPMYST_OPT_COMPRESS`, `HEADROOM_API_BASE`, `HEADROOM_API_KEY`, `HEADROOM_TIMEOUT_S`, `HEADROOM_MIN_CHARS`. Scope: `/v1/chat/completions` only (anthropic passthrough is cache-critical and untouched). 13 unit tests; 30 optimize tests green.

**Before enabling (remaining ops step, not code):** deploy a Headroom `/v1/compress` sidecar (`headroom-ai[proxy]`, pin an exact version) and benchmark against the prompt-cache-hit canary (`cache_read_input_tokens` on multi-turn sessions must not drop). **Risk:** the sidecar's default CCR store is in-memory 30-min → set a durable Sqlite/Redis backend + verify multi-tenant original-store scoping. *(If the gateway ever migrates to the LiteLLM proxy server AND a stable v1.92.0 ships, revisit swapping the call-out for the native guardrail — less code, but fail-closed + a pre-release dep.)*

## Phase 3 — L2 fixes to our compactor (finishes Plan 08/09)

Real tokenizer (replace `chars/4`), measured `remainingTurns` EWMA, deterministic delta-patch memory, tool-pair-safe slicing, reseed-cost folded into `N*`. *(This is largely Plan 09's "cache-honest Smart-Compaction v2".)*

**Status (2026-07-05) — economic-honesty core landed; two items deferred with rationale:**

- ✅ **Measured `remainingTurns` EWMA** — `SmartCompactor` tracks turns-per-compaction-epoch and folds each closed epoch into a global EWMA (`estimateRemainingTurns()`); the `N*` gate uses the measured value once any epoch exists, falling back to the constant only cold-start. *(The single highest-leverage fix — the constant 6 directly gated `economical = N ≥ N*`.)*
- ✅ **Reseed-cost folded into `N*`** — the smart path reseeds a cold session with `[summary, ...preserved]`, so `reprime` now charges `cache_creation` for the summary **and** the preserved tail (`preserveTokens`, estimated in `CompactionManager` from the kept messages). N* is no longer optimistic about the forced cold write.
- ✅ **Turn-pair-safe slicing** — `SmartCompactor._preserveBoundary` snaps the summarize/preserve split to the nearest user turn (bounded window), so a compaction never preserves a dangling assistant reply / tool exchange without the user turn that prompted it. *(Mysti persists whole-turn `Message`s, so this is the meaningful form of "never split a tool pair" for our data model.)*
- ✅ **Deterministic delta-patch memory** — landed (`parseMemorySections`/`applyMemoryPatches`/`serializeMemory`/`tryApplyMemoryPatches`). Non-bootstrap compactions ask the cheap model for section patches `{section, op: append|replace|remove, content}` applied in-process; unchanged sections carry over byte-for-byte, killing re-summarization drift over long sessions. Fully fallback-safe (non-patch response → full rewrite, only if it *looks like* structured memory; `[]` → keep existing verbatim). *Honest framing:* the reseed still cold-resets the CLI cache, so the win is **compaction fidelity + cheaper output**, not cache survival. Hardened against a 12-finding adversarial review (fence-aware parser so a `##`-prefixed line inside a Code fence isn't a heading; duplicate-heading merge; balanced-bracket/string-aware patch extraction; op-case normalize + content-type validation; empty-content never deletes a section; structure-gated fallback so a malformed blob can never overwrite good memory; epoch-counter reset on fallback).
- ⏸️ **Real tokenizer (replace `chars/4`)** — deferred. The load-bearing economic input `C` already uses the provider's **real** `input_tokens + cache_read` usage, not the estimate; `estimateTokens` only feeds secondary paths (chunking, ledger baseline, `preserveTokens`). Replacing it forces exact-value test churn for marginal secondary accuracy, and no accurate local tokenizer exists for Claude (tiktoken under-counts). Revisit only if a secondary path proves materially miscalibrated.
- ⏸️ **Tier-0 free prune** (`tier:'prune'`) — deferred. Mysti persists message `content` as opaque strings, so there's no structured `tool_result` payload to selectively prune; emitting `prune` without a principled prunable-bulk signal would be noise. Needs structured-message support first.

39 SmartCompactor/ModelPricing tests green (incl. 8 review-regression tests + a real-fs bootstrap→patch integration test); `tsc --noEmit` clean.

## Phase 4 — L4 store unification + L5 holdout governance

Merge the CCR store and `history.jsonl` into one durable content-addressed store; make L5 the gate for every stage (auto-disable on net-loss or holdout-fail).

## Sequencing

```
Phase 1  L0 stabilize + L3 Chain-of-Draft   — gateway, free wins, independent   ~1–2d
Phase 2  L1 via Headroom-as-LiteLLM-callback — gateway, flag-gated               ~2–3d + eval
Phase 3  L2 compactor fixes (Plan 09)       — Mysti                              ~3–4d
Phase 4  L4 store unification + L5 holdout   — gateway + Mysti                    ~4–5d
```

## Relationship to other plans (cross-plan ownership)

- **Plan 13 owns** the gateway-side optimization layer (L0/L1/L3/L4/L5) and the unifying architecture.
- **Plan 08/09 own** the Mysti-side cross-turn compactor, which plugs in as **L2** — Plan 09's "cache-honest v2" *is* Phase 3 here. Plan 09's `ModelRouter` (compaction-model pick) and Plan 11's two-tier backend router are the seed of the **self-hosted-model tier**.
- Do not duplicate the savings ledger — L5 extends Plan 08's `SavingsLedger` (adds the holdout + cache-hit-aware net gate).

## Risks & guardrails

- **The cardinal sin is breaking the cache.** Every stage must prove (via L5 + a `byte_fidelity` fixture) that the frozen prefix is byte-identical across turns. A cache miss on a warm prefix dwarfs any textual saving.
- **Never ship opaque markers to the model.** All dropped content is reversible by a server-side map / retrieval tool (the DeepMyst-optimizer failure mode).
- **Tool-pair integrity is non-negotiable** — a split `tool_use`/`tool_result` 400s the provider.
- **Measure quality, not just tokens** — the 10% holdout is what separates this from every current option; without it, silent degradation is invisible.
- **Managed clients** (OAuth/subscription) must pass through byte-unchanged (Headroom's auth-mode gate) to avoid cache-evasion detection.

## Out of scope

- KV-cache eviction / soft-token compression / CAG over closed hosted models (self-hosted tier only).
- Semantic *response* caching beyond a conservative, per-user-scoped, read-only L1/L2 (false-positive correctness + cross-user leak risk; real hit rates 20–45%).
- Resurrecting DeepMyst's in-house optimizer — superseded by L0/L1 done correctly.
