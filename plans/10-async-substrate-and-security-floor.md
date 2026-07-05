# 10 — Async Execution Substrate + Security Floor

- **Date:** 2026-06-20 (hardened after the round-2 verification)
- **Status:** DRAFT (gated on [Plan 09](09-mysti-agent-orchestrator.md) MVP soaking + ledger `net` validated)
- **Why this exists:** round-1 review found async/delegation, as drafted, **bypassed Mysti's sole permission gate** and rested on an `AsyncGenerator` "detach" that cannot make progress. This plan builds the substrate **and** the security floor any later delegation (Plan 11) requires. **Nothing in Plan 11/12 may begin until the security floor (Part 1) lands.**
- **Round-2 hardening folded in:** the "fixed floor" is genuinely fixed (workspace-config can't widen it; native sub-agent inner tools addressed; viewless-panel resolution defined); memory/skills data-trust sanitization pulled forward from Plan 12; orphan/redaction rules corrected.

---

## Part 1 — Security floor (must land first; non-negotiable)

The current gate is deliberately **fail-CLOSED** (`permissionClassifier.ts:63`; the original fail-open bug was a Plan 00 Batch 2 CRITICAL fix, `README:77`). These steps preserve that posture for the orchestration era — and close the holes round-2 found in the floor itself.

**Steps**
1. **Un-allowlist delegation + wire a real `delegate` action type:** `task`/`agent`/`tool_search`/`toolsearch` are in `READ_ONLY_TOOLS` (`toolNames.ts:160`) → classified `file-read` → ungated. Removing them alone makes them fall through to `bash-command` (fail-closed but mislabeled). So **also**: add a `'delegate'` value to `PermissionActionType` (`types.ts:751-758`), map `task`/`agent`/`dispatch_agent` in `ACTION_TOOLS`, and add a `delegate` branch to `shouldGateToolUse` + `SafetyClassifier`. Delegation is gated by default (auto-approved only under explicit full-access/autonomous, like any write).
2. **Panel-independent chokepoint:** move enforcement off the live stream into the execution substrate so **every** tool call — sync, async, or from a sub-agent on a derived panel — passes one `evaluateAndGate()` chokepoint **before execution**, regardless of whether a foreground panel exists. (Today gating lives in `ChatViewProvider._shouldGateToolUse`, panel-bound.)
3. **Native sub-agent inner tools (hard limitation — state it):** un-allowlisting `task`/`agent` gates only the **outer** invocation. When a native provider (e.g. Claude) runs a sub-agent via its own `Task`, the sub-agent's inner `Write`/`Bash`/`rm` calls run **inside the CLI** and never surface to Mysti as separate gated `tool_use` chunks (no `parent_tool_use_id`/sidechain signal Mysti can intercept). **Mysti cannot gate a CLI's internal tools.** Mitigation: orchestrator-mode native children (Plan 11) must be launched with **restricted CLI permission flags** (read-only / pre-approved toolset) or inside a sandbox; document that delegating to a native agent in full-access mode delegates Mysti's trust wholesale.
4. **Clamp gate-governing settings against workspace override:** all gate settings (`mysti.autonomous.safetyMode`, `mysti.mode`, `mysti.accessLevel`, `mysti.allowBashCommands`) are read via `getConfiguration('mysti').get()`, which **merges workspace over user** — a hostile `.vscode/settings.json` can silently *widen* the floor. Read these via `inspect()` and take the **more restrictive** of user vs workspace (workspace may only narrow, never widen). +regression test.
5. **Sanitize self-authored context entering the prompt (data-trust floor — pulled forward from Plan 12):** auto-memory/`MEMORY.md` (`getProjectMemoryContent` → `fullSystemContext` `ChatViewProvider.ts:3113-3120`) and skills load **unsanitized into the system context today**, a live prompt-injection vector that a delegation surface would let escalate. Wrap all self-/agent-authored content in a **delimited low-trust block** with an **injection-marker content-scan** before it enters any prompt. This is a floor concern (the data-trust boundary), decoupled from Plan 12's `skill_view`/Curator features.
6. **Gate is a fixed floor, not a hook outcome:** the hooks layer (Part 3) may **only add denials**; never relax `SafetyClassifier`/`shouldGateToolUse`; workspace-scoped hook config may never widen permissions.
7. **Entitlement fail-closed for all spend:** Plan 09 already flips `hasEntitlement()` fail-closed (`DeepMystAuthManager.ts:150/203/206`) and adds a local `costUsd` ceiling for compaction. Extend the same ceiling/gate to **delegation + background-job** spend here.

**Acceptance:** delegation is gated identically in foreground/async/viewless contexts; compound commands survive classification untruncated (Part 2 step relates); a workspace settings file cannot widen the floor; self-authored memory/skills enter prompts only as scanned low-trust blocks; native-child trust limitation is documented + enforced via restricted flags; no hook/workspace config widens the gate; entitlement failures deny premium spend. +tests incl. regression tests for delegation-gating and workspace-widening.

---

## Part 2 — Async execution substrate (the "doesn't wait, reports back" core)

**Steps**
1. **`JobRunner` pump (fixes the pull-model bug):** an `AsyncGenerator` only advances when something awaits `.next()`. Define an explicit **un-awaited driver** per job (`JobRunner.run(jobId)` owns a real `for await` loop on a microtask, with `.catch`, in an in-memory registry) that pulls chunks and persists them. "Detach the generator" is forbidden — exactly one consumer always.
2. **`JobStore`** `src/services/JobStore.ts`: durable state machine `pending → running → completed | failed | orphaned`, `{jobId, rootId, panelId, kind, targetProvider, sessionId, childPid, status, startedAt, completedAt, resultRef, resultDelivered, error, spend}`; bodies on disk (`.mysti/jobs/`).
3. **Job-body privacy (corrected):** `.gitignore` is **not** redaction — `HistoryStore` stores raw content (`_doAppend:96-116`), so "same posture as history.jsonl" means gitignore-only. Job bodies hold sub-agent results + tool output (possible secrets), so: gitignore **plus** a content-redaction pass (reuse `DeepMystGatewayClient.redactSecrets`-style scrubbing) before write, and a retention cap.
4. **Reload semantics (no "running forever", no lost results):** distinguish **panel-reload** (host lives → the panel-dispose handler `ChatViewProvider.ts:7359-7371` must NOT kill panels with open jobs; the pump survives) from **host-reload** (CLI children orphaned — most backends have no reattachable session → mark `orphaned`). **Edge the round-2 review caught:** a child that *finished and wrote `resultRef` but had not delivered* before host death must be reconciled as **completed-unreported** (deliver the persisted result on rehydrate via the `resultDelivered` flag), never discarded as `orphaned`.
5. **Completion → report-back:** post `{type:'jobCompleted'|'jobFailed', payload}` (new `WebviewMessage` variants) → panel card (summary + spend) + `vscode.window.showInformationMessage`; **coalesce/throttle** events from N concurrent jobs so one panel isn't flooded.
6. **Lifecycle:** each job registers an `AgentLifecycleManager` session + pushes its child pid; `markIdle` becomes **job-protected**.
7. **Kill-switch / blast radius:** a global `mysti.jobs.enabled` master switch + per-root cancel fanning `cancelRequest` to all derived panelIds (mirror `MentionRouter.cancelSubAgents:205`, via the `processKill` util — not `.killed`); a hard cap on concurrent jobs.
8. **Windows parity:** verify job/pid/cancel on Windows (suspend/SIGSTOP already no-ops there).

**Acceptance:** a long task runs as a background job, returns the turn immediately, reports back with a card + notification + spend; cancel + master switch work; panel reload keeps jobs alive; host reload marks unreported-but-finished jobs completed (delivers the result) and truly-lost jobs orphaned (never "running"); job bodies are redacted; events don't flood the webview; Windows cancel works. +tests for the state machine, pump, reload classification (incl. completed-unreported), redaction, cancel fan-out.

---

## Part 3 — Hooks (ADD-only automation)

**Steps**
1. **`HookManager`** events: `PostToolUse`, `Stop`, `JobCompleted`, `Notification`, `SessionStart`. `PreToolUse` may only return a **deny** (composes with, never replaces, the Part-1 floor).
2. Async-mode hooks for fire-and-forget side effects; job completion fires `JobCompleted`/`Notification`.

**Acceptance:** a `PostToolUse` hook can auto-format; a `PreToolUse` deny is honored but "allow" can never widen the floor; `JobCompleted` posts a notification. +tests.

---

## Sequencing

```
Part 1 Security floor   ~3–4d   ← MUST land before any Plan 11 delegation (now incl. workspace-clamp + memory sanitization + delegate wiring)
Part 2 Async substrate  ~3–4d
Part 3 Hooks            ~2d
```

## Out of scope (→ Plan 11/12)

- Any model-callable delegation tool, the orchestrator, cross-agent routing, sub-agent fan-out (Plan 11).
- Self-improvement, `skill_view`, Curator, workflow engine (Plan 12).
- Cloud routines / scheduling (later; emulate locally via hooks first).
