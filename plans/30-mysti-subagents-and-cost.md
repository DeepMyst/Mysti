# Plan 30 — Mysti Subagents, Advisor Routing and Token Cost

- **Date:** 2026-09-25
- **Status:** IMPLEMENTED (Phases 1–4) — live smoke pending
- **Inputs:** three code maps of the `@mysti` coordinator (model selection, delegation, token spend) with file:line refs; live OpenRouter catalog (`/api/v1/models`, `/models/stealth/space-bunny-alpha/endpoints`) on 2026-09-25.
- **Trigger:** User request to make Mysti as a provider more powerful: (1) subagents, (2) less overall token cost, (3) advanced agents for complex problems and cheaper, faster agents for the work, (4) Space Bunny Alpha as the default chat model.

Line numbers below drift: `ChatViewProvider.ts` was being edited by another session while this was mapped. Symbols are the stable reference; line numbers are a starting point.

---

## Goal

The coordinator runs on a free, fast model and stays small. Work that needs reading or doing goes to subagents, which return summaries instead of transcripts. Work that needs judgment goes to an advisor, which runs on the strongest model the user already pays for. No paid API call happens without the user's budget or approval.

Nothing here changes the security model. Every child action rides the existing gated dispatch, children's results re-enter nonce-redacted and UNTRUSTED-fenced, host-side settings stay machine-scoped, and the host can only *narrow* a child's access.

## Decisions (made in chat, 2026-09-25)

| # | Question | Decision |
|---|---|---|
| D1 | What is a subagent? | **Both.** Native Mysti children (the coordinator's own loop on a chosen model, fresh context) *and* upgraded CLI delegation. |
| D2 | Which model drives the loop? | **Cheap driver + advisor.** Space Bunny runs the ReAct loop; an advanced advisor is consulted for plans, hard bugs and risky reviews. |
| D3 | Where does the advisor come from? | **Subscription CLI first.** Claude Code / Codex read-only on the user's existing plan; paid API model only as fallback, under a per-turn dollar cap. |
| D4 | Space Bunny is a stealth model | **Default + one-time notice**, silent fall-through when withdrawn. |
| D5 | Approach | **Extend `delegate`** into the single subagent tool; native children re-enter `_runMystiAgentic` in a child profile. |
| D6 | Paid fallback in the default chain | **Dropped.** The default chain is free-only. |
| D7 | Can the coordinator name exact models? | **Yes**, host-validated against the target's known models and the `EffortLevel` enum; invalid values fall back to the tier. |

Assumptions (stated in chat, not corrected): "the chat itself" means `@mysti`'s own model; Space Bunny is the default on both the DeepMyst gateway and the direct OpenRouter-key paths; the existing free models stay as fallback.

## Current state (what this plan changes)

- **Model:** fixed per run. `MYSTI_DEFAULT_FREE_MODELS` (`src/services/CoordinatorModelClient.ts`) = gpt-oss-120b → nemotron → gemma, then `mysti.mysti.fallbackModel` = `claude-haiku-4-5` (paid) appended by `_gatewayChain`. No per-step switching.
- **Tool capability:** `modelSupportsToolCalls` (`src/services/coordinatorTools.ts`) is a name regex. `stealth/space-bunny-alpha` does not match, so it would silently lose native tools.
- **Free detection:** `normalizeModel` (`OpenRouterClient.ts`) uses `:free` suffix *or* zero pricing; the "Custom…" entry in `mysti.setCoordinatorModel` (`src/extension.ts`) uses the suffix only.
- **Delegation:** `delegate {agent, task, tier}` reaches installed CLI backends only (`_availableMystiBackends` drops pseudo-agents and `openrouter`). One delegation per turn — extra native calls are dropped. Tier → model via keyword regex (`_resolveTierModel`). Result = child's concatenated assistant text clamped to 9k head + 3k tail (`_fenceDelegateResult`). No way to spawn a child of the coordinator itself.
- **Token spend per round-trip:** the whole growing `messages` array is re-sent (`CoordinatorTurnRunner`). 30 canvas tool schemas (~14.9k chars, ~3.7k tokens) ride every run because `_runMystiAgentic` passes a literal `true` for `canvasBound` to `coordinatorToolSchemas`. `mysti.defaultEffortLevel` defaults to `high`, which doubles `_MYSTI_MAX_TURNS` (24 → 48) in the governor. Attached files in the first user message are uncapped; MCP results are uncapped; bash can return 30k stdout + 30k stderr. The current request appears twice (under "The request" and as the last line of "Recent conversation"). A per-run nonce sits ~250 chars into the system prompt, so the prefix differs on every turn.

## Space Bunny Alpha facts (2026-09-25)

`stealth/space-bunny-alpha`: prompt and completion price 0, 1M context, 524k max output, `tools` + `reasoning_effort` supported, `tool_choice` supports `auto` only, no implicit caching, published 2026-09-23. OpenRouter stealth models are temporary and typically log prompts for the undisclosed provider.

---

## §1 Default model — Space Bunny

1. `MYSTI_DEFAULT_FREE_MODELS` becomes `openrouter/stealth/space-bunny-alpha`, then gpt-oss-120b, nemotron, gemma. Update the `mysti.mysti.freeModels` default in `package.json` to match, and add a test asserting the constant equals the `package.json` default (nothing checks this today).
2. `mysti.mysti.fallbackModel` default becomes `""` (free-only, D6). Users who set it explicitly keep their value. When the free chain is exhausted the run ends with "No free model is available right now" and a **Choose model** button that opens `mysti.setCoordinatorModel`.
3. Withdrawal needs no new code: `_isRetryable` already treats 404 / model-not-found as retryable, so the chain falls through.
4. Direct OpenRouter-key path: `auto` resolves to the first `freeModels` entry (prefix stripped) present in the live catalog; only if none is present does it fall back to `getDefaultFreeModel()` discovery.
5. `modelSupportsToolCalls(id)` returns true when the regex matches **or** the cached catalog lists `tools` in `supported_parameters` (already normalised as `supportsTools`). No catalog → regex only. The text-directive protocol keeps running alongside, so a model that advertises tools but uses them badly still works.
6. "Custom…" in `mysti.setCoordinatorModel` decides free vs paid from catalog pricing, not the `:free` suffix.
7. One-time notice on the first `@mysti` run whose resolved model id contains `stealth/`: non-blocking information message — "Space Bunny Alpha is an anonymous preview model; its provider may log prompts." — with **Keep** and **Choose model**. Remembered in `globalState` per model id.

## §2 Subagents via `delegate`

### Schema

```
delegate { agent, task, tier?, model?, effort?, access? }
  agent   installed CLI id | "mysti" | "advisor"
  tier    "fast" | "strong"
  model   exact model id (validated, see below)
  effort  low | medium | high | xhigh | max (validated)
  access  "read-only" | "write"
```

The text-directive form (`<delegate:NONCE …>` in `mystiDelegateParser.ts`) gains the same attributes. Both encodings convert to the same `MystiDirective` and the same gated dispatch.

### Host resolution and validation (trust boundary)

The coordinator's arguments are model output and may be prompt-injected. The host:

- **access:** effective = the *narrower* of the request and the existing rule (plan mode, read-only access level, or review → `read-only`). A child can never be wider than the parent run.
- **model, CLI child:** must be in that backend's known model list (`ModelRegistryService` / provider model list). Otherwise ignored; fall back to `_resolveTierModel`.
- **model, native child:** must be in the OpenRouter catalog. A paid model goes through the §3 spend cap.
- **effort:** must be an `EffortLevel`. Otherwise ignored. Default from tier: `fast` → `medium`, `strong` → `high`.
- Every ignored value is reported back in the result header (`model "x" not available on codex; used <tier model>`) so the coordinator can correct itself.
- Count cap: `maxDelegations` 4 → **6** per run (still doubled by the effort governor, see §4.6).

### Native child (`agent: "mysti"`)

`_runMystiAgentic` gains an optional child profile, parallel to the existing background-job mode (`jobId`):

- **Model:** `model` if valid, else new machine-scoped setting `mysti.mysti.subagentModel` (default `""` = the §1 free chain). `CoordinatorModelClient.stream()` / `complete()` take an optional model override (chain = `[override]`, no fallback append).
- **Context:** fresh. System prompt + task brief + attached files (same caps as today's delegation brief) + project brain (`mysti.md`, rules). No conversation history.
- **Tools:** read / ls / grep / diag always; write / edit / patch / bash only when effective access is `write` **and** `mysti.mysti.localExecution` is on — through the same `MystiLocalExec` chokepoint, gates and approval cards. `delegate` is removed from the child's tool set: depth is 1.
- **Budget:** 12 round-trips, 20 local tool calls. Own nonce. Inherits the parent's cancel.
- **Output:** a nested collapsible trace card (the one CLI children use). Nothing is written to the conversation; the child's result is *returned* to the parent.

### Summary contract

Every child brief (native and CLI) ends with an instruction to finish with:

```
## Result
## Evidence      (file:line references)
## Changes       (files touched, or "none")
## Open questions
```

The host extracts that block and returns only it, clamped to **6k chars**. A child that ignores the format falls back to today's head+tail clamp at the same 6k cap. The full transcript lives only in the trace card. The review block appended after a write (currently unclamped) gets the same 6k cap.

### Parallelism

- Several `delegate` calls in one turn whose effective access is all `read-only` run concurrently via `runBounded`, cap 3. Today's "one directive per turn, extras dropped" rule is lifted for this case.
- Any `write` child runs alone; other write calls in the same turn queue behind it.
- Unchanged and extended to native write children: failure reroute to a different vendor once, post-write diagnostics verify, post-write cross-vendor read-only review.

## §3 Advisor

`delegate { agent: "advisor", task, … }` — always `read-only`.

### Resolution

1. First installed + authenticated backend in new machine-scoped setting `mysti.mysti.advisorAgents` (default `["claude-code", "openai-codex"]`), on its strong-tier model at `high` effort unless a valid `model`/`effort` is given. It explores with its own tools, billed to the user's existing plan.
2. Otherwise a paid API model, new machine-scoped setting `mysti.mysti.advisorModel` (default Opus 5.5 — `anthropic/claude-opus-5.5` on OpenRouter, $4/$20 per MTok; `claude-opus-5-5` on the DeepMyst gateway, matching the picker's `claude-haiku-4-5` / `claude-sonnet-4-6` naming. Phase 4 verifies the gateway serves it; if not, the gateway default is `claude-sonnet-4-6`). **One `complete()` call, no tools**: the coordinator packs the brief and attaches the files it wants judged. Cost is predictable.
3. Otherwise the result is `advisor unavailable: <reason>` and the coordinator continues.

Advisor output uses `## Verdict / ## Plan / ## Risks`, same 6k cap and fencing.

### When it is called

- System-prompt guidance, four triggers: before a change spanning 3+ files; after two failed attempts at the same fix; any change touching auth / permissions / security / secrets; review of a risky diff before declaring done.
- Host nudge via `_appendNudge` when the same diagnostic or test failure recurs twice in a run.
- Cap: **2** advisor calls per run; they also count toward `maxDelegations`.

### Spend control (all paid calls)

Applies to the paid advisor fallback and to any native child whose `model` is a paid OpenRouter model.

- New machine-scoped setting `mysti.mysti.paidBudgetPerTurnUsd`, default `0`.
- Before each paid call: estimate = `ModelPricing` rate × (brief tokens + `max_tokens`).
- If turn estimate so far + this estimate ≤ budget → proceed. Otherwise a forced approval card ("Advisor wants Opus 5.5, ~$0.14"); **timeout = deny** (existing `forceInteractive` behaviour).
- After the call, actual cost (usage or `X-DeepMyst-Cost-USD`) replaces the estimate in the turn total, shown in the turn footer.
- Default `0` means every paid call asks — today's paid-model semantics.
- Fix `ModelPricing`: the `/gpt-6/i` entry charges every GPT-6 at $10/$50. Split: Astra $10/$50, Sol $2/$10, Luna $0.10/$0.50 (live catalog 2026-09-25). The cap's estimates depend on it.

## §4 Token cost

Ordered by expected saving.

1. **Canvas tools on demand.** Unbound runs send only `canvas_open` (`CANVAS_OPEN_TOOL`); the full `CANVAS_TOOL_SCHEMAS` set is sent when `_canvasBoundTo(panelId)`, and recomputed mid-run right after a successful `canvas_open` (one cache miss in that case). Keeps the Plan 22 "open a canvas from a cold chat" behaviour. Saves ~3.6k tokens per round on every non-canvas run.
2. **Elide old tool results within a run.** The last 4 tool results stay verbatim; older ones become a one-line stub (`[read src/x.ts:1-400 — elided; re-read if needed]`). The message and its `tool_call_id` remain so native tool pairing stays valid.
3. **Subagent summaries** (§2).
4. **Caps on what is uncapped.** Attached files in the first user message: 8k per file / 24k total, reusing the delegation-brief helper. MCP results: 12k head+tail. Bash: 30k total, stdout first.
5. **Request once.** Exclude the current message from the "Recent conversation" slice in `_buildMystiDirectPrompt`.
6. **Effort governor.** Budgets stop doubling at `high`; doubling applies to `xhigh` and `max`. The `reasoning_effort` parameter is still passed through as set.
7. **Stable prefix across turns.** Move `delegateNonce` out of the system prompt into the first user message (where the run `nonce` already lives), so system + tools are byte-identical across turns for providers with prefix caching.
8. **Measurement.** `CoordinatorRunOutput` accumulates per-run input, output, cached, round-trips, subagent count and paid USD; shown in the turn footer and logged `[Mysti]`. When a stream is aborted at a directive and the usage frame never arrives, input is estimated as sent chars ÷ 4 and flagged estimated. A prompt-size test builds the default plain-chat system prompt + tool schemas and fails above a fixed budget.

**Deliberately skipped** (add if the §4.8 counters show they matter): shrinking text-directive history (the default chain is all native-tool-capable after §1.5); keeping tools on `finalize()`; Anthropic breakpoint threshold tuning (the default model is free with no caching); a persona-context cap.

## §5 Errors, testing, rollout

### Error handling — a child never throws into the parent

| Situation | Behaviour |
|---|---|
| Native child fails / exhausts budget | Existing `finalize` produces what it has; `## Result` says `failed — <reason>`. |
| CLI child fails | Existing single cross-vendor reroute. |
| Stop | Cancels all children; parallel read-only children use the existing per-tool Stop. |
| No advisor / paid card denied or timed out | `advisor unavailable: <reason>`; coordinator continues. |
| Invalid `model` / `effort` | Ignored, tier default used, reported in the result header. |
| Space Bunny withdrawn | Chain falls through to the next free model. |
| Free chain exhausted | Error message with **Choose model**. |

### Tests (Vitest; suite + `tsc` before and after each phase)

- §1: default chain and `package.json` parity; catalog-backed tool capability; "Custom…" free detection; stealth notice once per id; free-only exhaustion message.
- §2: `delegate` validation (agent, model, effort, access only narrows); read-only children concurrent and write children serial; summary extraction and fallback clamp; native child tool set excludes `delegate`; child budget and cancel.
- §3: advisor resolution order; paid estimate, cap, card, deny-on-timeout; 2-call cap; ModelPricing GPT-6 split.
- §4: canvas tools unbound / bound / mid-run open; elision keeps `tool_call_id` pairing; the new caps; request appears once; effort governor; prompt-size budget; usage estimate on aborted streams.
- Integration: a mocked coordinator stream issues three parallel read-only native delegates; assert the parent's messages contain only their summary blocks.
- Live: one real `@mysti` run on Space Bunny with an OpenRouter key after Phase 4 (the F5 smoke matrix has never been run).

### Rollout — four phases, each its own commit, suite green

1. **Default model** — §1.
2. **Token cuts + measurement** — §4, measurement (§4.8) first so Phases 3 and 4 are measured against it.
3. **Native subagents** — §2.
4. **Advisor + spend cap** — §3.

### Working-tree constraint

The branch carries ~60 uncommitted modified files and another session edits `ChatViewProvider.ts` concurrently. A git worktree off `HEAD` would miss that work, so implementation happens in this tree and each phase stages only its own hunks.

## Out of scope

- Parallel *write* fan-out (Plan 17 P1.1) — needs worktree isolation.
- Model-initiated orchestration (Plan 17 P2.4) and the recursive advisor tree (Plan 11 D3c).
- Nesting deeper than one level.
- Changing CLI-provider models or defaults outside delegation.
