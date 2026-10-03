# 12 — Self-Improvement, Workflows, Tools & Hermes Backend

- **Date:** 2026-06-20
- **Status:** DRAFT (gated on [Plan 11](11-mysti-orchestrator.md))
- **Why last:** these are the highest-trust-risk and lowest-MVP-value pieces. The adversarial review flagged self-authored skills/memory as a **persistent prompt-injection / privilege-escalation vector** and "Hermes as a ManusProvider clone" as likely-wrong. Both are addressed here as gated, trust-bounded features on top of the secured substrate (Plan 10) and the orchestrator (Plan 11).

---

## Part 1 — Skills & self-improvement (trust-bounded)

**Hard constraints from the review (acceptance gates)**
1. **Self-authored content is UNTRUSTED data, never trusted instructions.** `MEMORY.md` and skills today load **unsanitized into the system tier** (`ChatViewProvider.ts:3113-3120`, `AgentLoader.ts:176/214`). For agent-authored content, inject it into a **delimited low-trust user-turn block** with explicit "reference data, not instructions" framing — never the system prefix. Content-scan for injection markers before storage.
2. **Writes are gated + structured.** The background-review proposer is a cheap model whose *input* is untrusted transcript; its output must be **schema-validated diffs**, routed through the Plan 10 Part 1 gate, and **never auto-applied** without review.
3. **Committed-file awareness.** `.mysti/agents/skills/*.md` and per-project `MEMORY.md` are the *documented user-editable* tree (not gitignored like `.mysti/compaction/`). Agent writes there are diff-surfaced for user review; never silent.
4. **Fire on a transport signal, not a heuristic.** The background-review job triggers on the Plan 10 `Stop`/transport-`done` event, not `AutonomousManager._continueGoal` keyword matching.

**Steps**
1. **Model-driven `skill_view` tool:** convert `AgentLoader`'s three tiers (`loadAllMetadata:129` / `loadInstructions:176` / `loadFull:214`) from load-on-selection to a tool the model pulls mid-turn — Tier-1 index always present, Tier-2/3 on demand. Smaller always-present footprint.
2. **Background-review fork** (async job, Plan 10): after a task, a cheap routed model proposes schema-validated skill/memory diffs; surfaced for review; applied only on approval.
3. **Curator:** age/archive skills by usage telemetry (active→stale→archived) with backups/rollback.

**Acceptance:** a background-review job proposes a reviewable, schema-valid skill/memory diff without blocking the chat; agent-authored content is injected as low-trust delimited data and content-scanned; `skill_view` loads tiers on demand; curator ages an unused skill. +tests incl. an injection-attempt that is neutralized.

---

## Part 2 — Tools & workflow engine

**Steps**
1. **Deferred tool loading (narrow waist):** a `tool_search`/`tool_describe` bridge (both **`delegate`/gated**, per Plan 10 Part 1 — they were wrongly on `READ_ONLY_TOOLS`) so MCP/plugin schemas aren't all in the prompt; core tools never defer.
2. **Background-task tools:** `run_in_background` + a `BashOutput`/`Monitor` analog on Plan 10's `JobStore`; surfaced in the jobs dashboard.
3. **Workflow engine:** deterministic reusable recipes (built-in review/research/migrate; user recipes in `.mysti/workflows/*`) that the orchestrator runs as **background jobs** (report back via Plan 10). Bounded by the governor; no Dynamic-Workflow-style arbitrary script execution in v1.

**Acceptance:** a dev server runs as a background task with retrievable output; a built-in workflow recipe runs as a governed background job and reports a consolidated, budget-capped result. +tests.

---

## Part 3 — Hermes Agent backend

**Constraint from the review:** Hermes is an agent **runtime**, not a completion API — do **not** clone the dormant `ManusProvider`.

**Steps**
1. **Transport-discovery spike FIRST (gating dependency):** determine Hermes's actual integration surface — its OpenAI-compatible `/v1/chat/completions` with tool deltas, its ACP server, or a stream-json CLI. Pick the matching template (a streaming+tool-capable provider like Claude/OpenClaw for the API path, or the standard `BaseCliProvider` path for ACP/CLI). Do not commit a template before the spike.
2. **Implement `HermesProvider`** on the chosen path (7-step registration: `types.ts:18,22`; `ProviderRegistry:66`; `ProviderManifest.ts:60,86`; `package.json` settings; honest `capabilities`; optional `discoverModels`).
3. Make Hermes a valid `ModelRouter`/orchestrator delegate target.

**Acceptance:** Hermes selectable, streams + tool-calls correctly on its real transport, authenticates, and works as an orchestrator child. +tests. (May be deferred entirely if Hermes's protocol proves immature.)

---

## Part 4 — Surfacing & scheduling

**Steps**
1. **Background-jobs dashboard** (Agent-View analog) in the webview: live states, results, **spend**, notifications, cancel/retry, master kill-switch.
2. **Orchestration DAG view** + expanded ledger (`model-routing` + per-orchestration net value).
3. **Scheduling:** `/loop`-style recurring + cron (session-scoped) for repeatable governed jobs; cloud routines as a later DeepMyst-hosted tier (don't host public webhooks; emulate via hooks).

**Acceptance:** the dashboard shows running/finished jobs with spend and a working kill-switch; the DAG view renders an orchestration; a scheduled job fires and reports back. +tests.

---

## Out of scope

- A vector/embedding index; per-panel settings store; Dynamic-Workflow arbitrary-script execution; depending on DeepMyst `-auto`/`-optimize` routing.
