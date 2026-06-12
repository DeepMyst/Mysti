# Mysti Improvement Plans — Index & Execution Order

Date: 2026-06-12 · Produced by a 63-agent review workflow (5 code reviewers, 6 researchers, adversarial verification of every high/critical finding, 6 plan writers, completeness critic + fix round).

Detailed research reports backing these plans: [plans/research/](research/) (11 reports: providers, core managers, collab managers, webview/chat, canvas, performance, GitHub triage, model discovery, DeepMyst MCP connections, DeepMyst presentation/canvas, unified-chat UX). Plan files referencing `/tmp/mysti-planning/research/` paths resolve to this directory.

> **Execution log** — 2026-06-12: Plan 00 Batch 1 complete. Local fixes in working tree (B1/B2/B6/B9/B15, #31 timer leak, #32 model entry, #39 stopgap) — verified: tsc clean, lint clean, 518/522 tests (4 pre-existing Canvas v2 failures, owned by Plan 05 Phase 0), webpack OK. GitHub: PR #43 merged; #45 landed as #48; #47 landed as #49 (+legacy-dir migration); issues #42/#44/#46/#36/#41 closed; PR #38 closed; #39 needs-info posted.

## The Plans

| # | File | Scope | Headline |
|---|------|-------|----------|
| 00 | [00-findings-and-github-triage.md](00-findings-and-github-triage.md) | Bugs + GitHub | 38 verified bugs (3 critical), triage of all 16 open issues + 5 PRs, 3-batch remediation plan |
| 01 | [01-automatic-model-updates.md](01-automatic-model-updates.md) | Model registry | `ModelRegistryService`: live discovery for 7 backends, curated remote feed, custom models (fixes #39, #32) |
| 02 | [02-unified-chat-experience.md](02-unified-chat-experience.md) | Chat UX | Capability-driven rendering (kills 17 provider-name seams), normalized message anatomy (fixes #28, #31, #33) |
| 03 | [03-performance-optimization.md](03-performance-optimization.md) | Performance | Measurement-first; parallel activation, webview extraction, streaming throttle, persistence rewrite, 33.8MB→<4MB VSIX |
| 04 | [04-connections-and-agent-management.md](04-connections-and-agent-management.md) | MCP + agents | My Connections hub, in-chat connect cards, per-CLI MCP config adapters, skills discovery (DeepMyst 2.0 patterns) |
| 05 | [05-canvas-overhaul.md](05-canvas-overhaul.md) | Canvas | Artifact-centric studio with `mysti-canvas` MCP tool server, 34-capability gap table vs DeepMyst presentation agent |

## Recommended Execution Order

```
Step 1 (immediate, independent):
  • Plan 00 Batch 1 — 3 critical fixes, contained high one-liners,
    merge security PRs #43 → rebased #45 → #47(+migration), close/reply stale issues
  • Plan 03 Phase 1 — instrumentation + baselines (everything later is measured against this)

Step 2 (shared substrate):
  • Plan 03 Phases 2–3 — parallel activation, cached CLI discovery,
    webview extraction to compiled/static assets  ← Plans 02 and 05 build ON this

Step 3 (parallel tracks):
  • Track A: Plan 02 (unified chat) then Plan 01 Phases 3–5 (discovery adapters, dynamic UI)
    — Plan 01 Phase 2 (remove model resets, relax validation) can land with Step 1 quick wins
  • Track B: Plan 04 (connections track Phases 1–3, agents track 4–6 in parallel)
  • Track C: Plan 05 Phase 0 (canvas bug fixes) → Phases 1–5

Step 4: Plan 00 Batches 2–3 remainder (items not absorbed by the dedicated plans).
```

## Cross-Plan Ownership Rules

Resolves overlaps identified by the completeness critic:

1. **Model-selection code** (`ChatViewProvider._getPanelModel`, provider-switch handler, `MODEL_NAME_PATTERN`): **Plan 01 owns** the registry, validation, and reset removal. **Plan 02 owns** the per-provider model-memory UX (#33) and must build on Plan 01's registry API, not reimplement validation.
2. **Webview restructuring**: **Plan 03 Phase 3 owns** the extraction of `webviewContent.ts` into static/compiled assets and the esbuild split. Plan 02's de-branding and Plan 05's canvas webview extraction land *after* (or rebased onto) that structure — neither introduces its own bundling scheme.
3. **Remediation overlap**: where a Plan 00 batch item is also a phase in Plans 01/02/03/05, the dedicated plan owns it; Plan 00 tracks it as a cross-reference, not duplicate work. Plan 00 retains exclusive ownership of: security PR merges, the permission-gate fail-open fix, the setup-wizard panelId fix, ChannelBridge/memory fixes, and the Windows spawn epic (#14/#27/#30).
4. **Shared `toolNames`/permission classification module**: created in Plan 00 Batch 2 (security), consumed by Plan 02 Phase 3 tool cards.
5. **Canvas bugs**: the 13 confirmed Canvas v2 bugs are fixed in Plan 05 Phase 0 (not Plan 00), since that code is uncommitted on `feature/visual-testing`.

## Top Verified Bugs (fix first)

| Severity | Bug | Location |
|----------|-----|----------|
| CRITICAL | Permission gate is name-keyed and **fail-open** — unknown tools auto-allowed while every CLI runs with bypass flags (Gemini, Qwen, Cursor, OpenCode, Copilot effectively ungated) | `src/utils/permissionClassifier.ts:53` |
| CRITICAL | Setup wizard runs with `panelId=null` — every wizard response silently dropped | `src/providers/ChatViewProvider.ts:413` |
| HIGH | Autonomous continuations force full-access settings, bypassing gate + SafetyClassifier | `src/providers/ChatViewProvider.ts:3147` |
| HIGH | `ChildProcess.killed` misused — SIGKILL escalation is dead code, process leaks | `src/providers/base/BaseCliProvider.ts:1032` |
| HIGH | Unsanitized `marked.parse` output — HTML/UI-spoofing injection from model/tool output | `src/webview/webviewContent.ts:18376` |
| HIGH | Streaming re-parses full markdown + re-highlights whole document per token, unthrottled | `src/webview/webviewContent.ts:15631` |

Full list (38 confirmed, 71 needing confirmation): Plan 00.
