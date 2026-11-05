# Mysti: complete feature and long-session test plan

Prepared 2026-10-09 from the current worktree. **This is a test plan, not a claim that these tests have passed.** Its purpose is to discover where an ordinary developer's day, an unattended run, or a returning session stops being reliable. Existing results in [46](46-conversation-reliability-results.json) are a starting point, not long-session or all-provider certification.

## Feature inventory and detailed cases

Every numbered case in these catalogs is a feature-level test obligation. Each gives its source/surface, real task, repeated workload, faults, expected result, and evidence. Shared protocols below are inherited, not substitutes for the individual cases.

Start with the [complete feature checklist](47-feature-inventory.md) for one row per case, then open the relevant catalog for executable steps.

| Catalog | Scope |
| --- | --- |
| [Providers and conversations](47-feature-tests/providers-and-conversations.md) | Getting started, installation/authentication, models, streaming/composer, history/panels/import/export, and all 16 registered backends individually |
| [Agents and runtime](47-feature-tests/agents-and-runtime.md) | Mentions, roles, Brainstorm, session shapes, coordinator, native subagents, permissions, autonomous work, plans, compaction, memory, costs, jobs and lifecycle |
| [Editor and workspace](47-feature-tests/editor-and-workspace.md) | Files/attachments, suggestions, dictation, commands, personas/skills, editor controls, settings, accessibility, localization, privacy and packaging |
| [Canvas and integrations](47-feature-tests/canvas-and-integrations.md) | Canvas editing and artifacts, visual observation, media integrations, account/connections/MCP, channels, Desk, Proactive and plugins |
| [Coverage manifest](47-feature-coverage.json) | Exact mapping of package commands/settings, registered backends and chat actions to catalog case IDs |

Source of truth: [package contributions](../package.json), [extension composition](../src/extension.ts), [chat handlers](../src/providers/ChatViewProvider.ts), [provider registry](../src/providers/ProviderRegistry.ts), [capabilities](../src/providers/base/IProvider.ts), current webviews, and the production construction/call sites of managers. Historical plans and a class existing on disk do not establish a reachable feature. Reconcile inventories after each release; new controls, settings or adapters require a case before release.

Status vocabulary used in the catalogs:

- **Reachable:** a current user action has a production handler. Still needs execution.
- **Conditional:** reachable only with an account, supported CLI, trusted workspace, optional service, or enabled setting. Missing prerequisites mean `BLOCKED`, not `PASS`.
- **Contract gap:** an exposed control or documented promise and the implementation differ. Test both the advertised result and observed behavior; resolve the discrepancy before awarding a pass. Merely reproducing the broken behavior is not acceptance.
- **Unwired/absent:** library/proposal exists without a production route, or a capability is intentionally unsupported. Verify honest absence; any future implementation needs its stated acceptance case. Do not count a negative reachability check as successful use of that feature.

Prioritize these source-indicated contract probes before spending on soak runs: Auto Context delivery; `/panel` synthesis and typed `/brainstorm` convergence promises; commit-signature behavior; Canvas unpin controls, variants and advertised export/generation capabilities; Desk transport versus pairing-only activation; Proactive task continuation versus observation/briefing; and telemetry fields/opt-out. The catalogs document the call-site evidence and required result. These are inspection findings to verify, not newly executed incidents. A feature guide with outdated catalog counts must be corrected or rejected as an oracle.

## Test environments and fixtures

Use a packaged VSIX installed in a fresh editor profile for acceptance. Run fast deterministic tests against source as a separate layer. Keep a second, upgraded profile with real history. Record the exact source commit plus dirty diff hash, VSIX SHA-256, OS/architecture, VS Code version/embedded runtime, CLI paths/versions, transport, model IDs, entitlement and configuration snapshot. Record capability manifests before and after provider refresh. Redact keys and tokens.

| Fixture | Concrete contents and oracle |
| --- | --- |
| F1 — small service | Disposable Node service with `retryDelay(attempt, base=100, cap=1000)`, one deliberately wrong linear implementation, tests for attempts 0/1/4, HTTP 429 retry, jitter and cancellation. Successive requested changes have hidden deterministic tests. Include text marker and blue PNG attachments. |
| F2 — ordinary product repo | Seeded full-stack issue tracker, 30–100k lines, API, database migrations, frontend, a11y checks, unit/integration/browser tests. Seed 12 reproducible bugs and 6 feature requests with acceptance tests and expected changed-file scopes. Use fake users/data and a local mail/webhook sink. |
| F3 — large monorepo | 10k files, roughly 500k lines, nested packages, duplicate basenames, ignored build/vendor trees, large logs and long paths. Index contains a known sentinel in each package; expected search and context selection are recorded. Include multi-root workspace and two branches with conflicting versions. |
| F4 — boundary/safety repo | Unicode/RTL/spaces/quotes in paths, symlinks inside/outside root, unreadable/binary/deleted files, malformed JSON/Markdown, very large tool output, synthetic credentials and prompt-injection text. All outside-root targets are disposable canaries. No real secrets or destructive targets. |
| F5 — Canvas/visual app | Local dashboard with 3 pages, nested components, forms, responsive layouts, image assets and known contrast/overflow/console/network errors. Store semantic document snapshots and rendered reference images. Local dev server and test-only backend accept observation safely. |
| F6 — integration sandbox | Two test accounts, two distinct workspaces and where applicable two machines/peers; controlled MCP/HTTP/WebSocket services, private test channels and repositories. Track outbound mutations in a separate audit sink. Paid tests have a recorded budget and test credentials. |

Create and checksum fixtures before running. Keep one clean source plus one disposable copy per run; never reuse a contaminated fixture as a clean baseline. Make local changes in the copy during tests so preservation of user work is checked. Snapshot disk contents, git status and settings before fault injection. A failed test must leave its artifacts available for diagnosis before cleanup.

For skill/context/history retrieval, freeze at least 50 labeled queries before execution: expected relevant items, decisive source facts, acceptable alternatives and no-match cases. Initial quality target: at least one expected relevant item in the top five for ≥90% of positive queries, with zero unauthorized action caused by distractor/injection content. Retain rank/output evidence and separately measure whether the resulting answer/code uses the correct fact; a ranking pass alone is insufficient. Review changes to the labeled set without using the current output as its answer key.

| Environment axis | Required coverage |
| --- | --- |
| OS/runtime | macOS arm64, Windows with native executables and `.cmd` wrappers, Linux; declared minimum VS Code and current stable. Test VS Code forks/Remote SSH/WSL/dev containers as separate compatibility claims; do not infer support from desktop results. |
| Installation | Fresh install, update from previous supported VSIX, restart after update, intentionally incompatible newer history schema, one profile with no providers and one with all test providers. |
| Workspaces | Trusted, untrusted, trust revoked mid-run; no folder, single folder, multi-root; read-only root; two editor windows using different repositories. |
| Provider capability | Native persistent CLI, single-shot CLI, ACP, WebSocket gateway, HTTP API, local model server, OpenCode remote server. All registered provider rows must run individually. |
| User interface | Sidebar, editor tab, two chats + Canvas + settings/inbox open together; small/large windows, light/dark/high-contrast, keyboard/screen reader, English plus RTL and long translated labels. |
| Resources/network | Normal machine; low-memory VM; disk almost full in disposable volume; offline; slow/flapping connection; service 401/403/429/5xx; slow CLI startup; machine sleep/wake. |

Do not execute the full Cartesian product. All P0 cases run across the three OS families; every feature gets its normal real-use and long-session case on at least one representative supported environment. Pairwise-cover remaining environment axes, with explicit critical triples: permissions × provider transport × trust; cancellation × conversation switch × late callbacks; persistence × upgrade × schema; concurrent agents × budget × partial failure. Repeat discovered failures on each affected OS/transport. An untested supported environment remains a coverage gap.

For every contributed setting in the coverage manifest, test default and one meaningful non-default value through its actual UI or VS Code configuration, observe the owning feature's behavior, reload, and restore it. For enums test every offered value; for bounds test minimum/maximum/invalid values; for credentials test replacement/removal without logging the value. Compare user/workspace/machine scope and a concurrent change from another window. A property that is accepted but ignored, or a UI value that differs from the effective request, is a contract defect. Re-run only applicable combinations for capability-dependent settings and document that applicability.

## Session profiles and sampling

These are **proposed acceptance workloads**, not measurements of current capacity. Each catalog supplies extra feature-specific actions. Wall-clock duration and completed action count are both required; a rapid loop is not an eight-hour session. Active soak periods must do useful work, not just leave the editor idle.

| Profile | Duration/load | Purpose |
| --- | --- | --- |
| S — realistic smoke | 45–60 minutes, at least 25 conversational turns or 25 meaningful feature operations | End-to-end happy path, two ordinary mistakes and recovery, one restart |
| W — workday | 8 elapsed hours, 250 turns across 10 tasks; 60% implementation/review, 20% questions/context, 20% corrections/cancellations; 15-minute lunch idle and 30-minute sleep/wake | Daily developer behavior, state accumulation, queued work, process ownership |
| E — endurance | 24 elapsed hours, 750 turns/operations; hourly 10-minute idle windows, at least 20 fault/recovery events | Leaks, hung streams, retry storms, stale credentials, journal/persistence growth |
| P — returning user | Five days, 200 turns/day (1,000 total), actual editor shutdown overnight; upgrade on day 3 and branch/workspace change on day 4 | Stored state, memory/retention, migrations, stale sessions and resource recovery |

For operations without chat turns (Canvas, settings, imports, plugins), use the catalog's operation counts while maintaining the same time profile. Await each operation's terminal event; count failed/aborted operations separately. Do not inflate totals with repeated reads that never exercise the feature. Document intentional provider limits; context-window exhaustion is a test transition, not a reason to reset the transcript quietly.

A campaign may satisfy several cases when it actually meets every case's actions, fault schedule, duration and evidence requirements; link those cases to the same run instead of inventing separate results. Combining workloads does not waive a case's minimums. The 16 backend W rows alone represent at least 128 provider-hours; they can overlap in genuine multi-agent journeys subject to machine limits and the recorded spend budget. Pilot S first to estimate real service cost before scheduling W/E/P; never silently reduce the prescribed workload to fit a budget.

Every reachable feature needs S plus its catalog's W/E/P workload. Run W on each registered backend. Run E on each transport family, Mysti coordinator and the full integrated workflow. Run P on history/context/compaction/memory, Canvas persistence, Proactive, and representative native and HTTP providers. If a provider's only supported session mode is stateless, test its explicit stateless contract and absence of misleading recall claims rather than require native history it does not promise.

During W/E, sample every 60 seconds and at each fault: extension-host RSS/CPU, webview memory/DOM/listener indicators, child process count and IDs, active requests/jobs/approval cards, open connections, fixture/store size, turn/first-token/render/Stop timings. Use editor process explorer, OS process sampling, browser performance tools and existing `[Mysti][perf]` output; the required structured soak collector is **new harness work**, not an existing npm command. Attribute model latency separately from Mysti latency.

After warm-up, compare like-for-like windows. Transcript and artifact growth is expected when new content is retained. Diagnose leaks using a fixed-size transcript replay and post-close/idle checkpoints, not total RSS alone. Keep screenshots, traces and process samples when a threshold is crossed.

## Shared invariants and measurable gates

All feature cases inherit these gates. Timing/resource values below are initial QA targets to calibrate on a declared reference machine; do not silently loosen them to obtain a pass. Record a reviewed threshold change and rerun affected cases.

| Gate | Pass/failure oracle |
| --- | --- |
| Correctness | Hidden fixture tests pass; requested file scope matches git diff; no unrelated changes; UI result corresponds to actual persisted artifact and provider. A fluent answer alone is not evidence. |
| Conversation ownership | Unique nonce per panel/task, checked after every tenth turn, switch, compaction and reload. Zero cross-panel, cross-workspace, wrong-agent or stale-turn results/approvals. Preserve required facts while visibly reporting any documented truncation. |
| Consent and authority | Zero unapproved mutations/egress; Deny/timeout/Stop prevents the actual tool effect, verified by filesystem and external audit sink. A permission card shown after execution is a failure. Fail closed on invalid payloads and revoked trust. |
| Cancellation | Stop receipt/UI acknowledgement within 1 second; no new child, queued write, retry, fallback or synthesis after cancellation. Owned processes/streams settle within their documented deadline, with an initial 10-second ceiling for local cleanup; hung-provider probes must honor bounded readiness deadlines. Next ordinary turn succeeds without editor reload. |
| Persistence | Every acknowledged completed message, selected setting and saved document survives restart with correct IDs/order. No silent corruption/overwrite on partial writes or future schema. Interrupted work is marked interrupted, not completed. |
| Interaction | On reference machine, local composer/menu action p95 ≤200 ms and no >2-second UI freeze; workday p95 local latency ≤1.5× warmed S baseline. Remote inference time is recorded separately, not hidden inside this target. |
| Startup | Proposed reference-machine target: usable chat within 10 seconds on cold activation and 3 seconds on warm reopen, excluding deliberate installation/login/model generation. Slow optional provider discovery must have a bounded, visible state and not freeze already-usable controls. Capture actual activation/panel-ready timing and classify external waiting separately. |
| Accessibility | Keyboard-only path reaches every critical action without a trap; focus remains visible and returns to the originating control after dialogs; streaming updates do not repeatedly steal focus. Proposed visual target: text contrast ≥4.5:1 (large text ≥3:1), meaningful control boundaries/focus ≥3:1. At 200% zoom and narrow sidebar, critical controls remain operable without clipping; screen-reader recordings establish correct labels, order and concise status/error announcements. Automated scans supplement actual VoiceOver/NVDA use. |
| Resource stability | After closing test panels and finishing cleanup, no owned orphan process/job or unresolved approval. In identical fixed-payload idle checkpoints, retained host/webview memory stays within baseline + max(20%,100 MiB), with no sustained >5 MiB/hour slope over final 4 hours; investigate positive slopes even below limit. Idle host CPU p95 ≤5% of one core. Record intentional caches separately. |
| Cost and usage | Provider/model attribution correct, nonnegative finite totals, no double charge on replay/retry; known receipts reconcile under the adapter's cache-token convention. Unknown usage displays unknown. Budget prevents prohibited new work and records unavoidable in-flight bounds; compare to service receipts when available. |
| Error/recovery | Failure has a useful cause and retry/sign-in/upgrade action where appropriate; healthy siblings remain visible. Recovery performs one intended action without duplicate writes/messages or repeated terminal notifications. |
| Privacy | No test secret canary in logs, telemetry, share payloads, unrelated provider prompts or network sink unless that exact data transfer was authorized by the case. Redaction must not hide evidence needed to establish which operation ran. |

P0 = data loss, incorrect authorization, runaway work/cost, isolation, basic send/recovery. P1 = core workflow blocked or materially misleading, long-session degradation, inaccessible critical control. P2 = secondary display/help or cosmetic defect without lost function. Severity is outcome-based; any case can produce a P0 failure.

## Integrated real developer journeys

Run these through the actual installed editor, not solely manager mocks. They join the feature cases to expose interactions. Expected code changes are verified by fixture tests after each major stage. Use real accounts for inference; deterministic fault servers may inject faults, but label those segments.

| Journey | Script and checkpoints | Long-session/fault schedule |
| --- | --- | --- |
| J1 — pair-program an issue | F2: ask Claude to locate a seeded retry bug; Codex independently reviews; choose a plan; approve only the target edit; run tests; request Gemini/Copilot counter-review; revise a requirement; export result. Verify attributed independent findings and dependent handoff, correct final diff and denied side-effect canary. | W: 10 issues/250 turns; every 25 turns switch reviewer/model, every 50 open second chat; Stop during approval and during streaming; one participant auth failure; retain healthy findings. |
| J2 — maintain a large repo | F3: navigate three packages, add/disable context, use file mentions/persona/skills, fix a cross-package bug, compact, reopen old task and recover exact constraints. Fork one conversation and rewind only its test changes. | W + P: 50 context changes/day, three compactions/day, nightly reload; rename a referenced file, change branch, revoke workspace trust. Preserve user edits and prevent stale context leakage. |
| J3 — autonomous bounded work | F1/F2: give a goal, answer a clarification, allow safe reads/tests and gate writes; queue two follow-ups; monitor map/background job; require verification before completion. | E: 750 turns/operations across bounded tasks, inject hung child, failed test, repeated no-progress answer, budget exhaustion, sleep/wake and Stop. No uncontrolled continuation; final status backed by oracle. |
| J4 — design and implement UI | F5: create/edit Canvas pages, pin a component, request targeted change, inspect diff/history, export, run visual observation, correct real overflow/accessibility issue, reopen. | W: 200 document operations plus 50 chat turns, two previews and two chats; interrupt save/export/generation, introduce stale revisions and remove an asset. Compare semantic tree, durable artifacts and rendered page. |
| J5 — connected team day | F6: sign in, enable one connection, call a read-only MCP tool, request a gated write; use private channel input; open Proactive responsibility/briefing; pair/revoke Desk peer only within current wired scope. | W + P: account refresh, network flaps, duplicate incoming events, service permission change, disable integration during pending work, sign out in one window. No cross-account results or duplicate external effects. Unwired Desk execution is not counted. |
| J6 — recover from an interrupted day | Start J1/J4 with uncommitted user changes, two pending approvals and unsent drafts. Close/reopen tab, reload editor, kill only isolated test extension host, restart machine/profile, then update VSIX. | P: one deliberate interruption daily at different lifecycle point. Reconcile conversation, file hashes, Canvas state, native sessions, pending work and settings against last acknowledged checkpoint. Re-run normal task after every recovery. |
| J7 — accessibility and resource pressure | Keyboard/screen-reader user works through J1 with RTL labels and narrow sidebar, uses dictation correction, follows tool errors and history while large transcripts render. | W on resource-limited VM: 100 long rendered answers, 20 dictations, 50 focus changes and 10 concurrent card bursts. Validate announcement/focus order plus local latency and memory gates. |

## Fault injection and diagnostics

Distribute faults across discovery, send-before-first-token, mid-stream, pending approval/question, file save, compaction, synthesis, terminal event and idle. Repeat each race at least 20 times in deterministic transport tests and reproduce at least once in a real-editor/live workflow where safe. Add seeded timing variation; keep seed and original first-failure evidence. Never make blanket retries hide a failure.

Network fault cases: delayed headers, partial UTF-8/JSON frames, duplicated/out-of-order event, socket close without terminal marker, service 401/403/429 with retry metadata, 5xx, stalled body, model removed between selection/send. Process cases: executable missing, launcher exits before child, ignored SIGTERM, Windows wrapper, output floods, exit 0 with empty output, nonzero exit after partial useful answer. State cases: conversation switch while callback awaits, reused native request ID, duplicated decision, simultaneous clear/Stop, stale cached manifest, disk-full write, corrupt/future schema. Make fault bounds explicit in evidence.

For each failure save: run/case/step ID, UTC timestamp plus local timezone, exact prompt and seed, redacted settings/manifest, account availability, transcript with provider/turn/approval IDs, expected vs actual artifact hashes, process tree before/after, screenshots/video, logs/trace and smallest reproducer. Classify `PRODUCT`, `MODEL_QUALITY`, `SERVICE_OR_ACCOUNT`, `HARNESS`, or `UNRESOLVED`; all remain failures/blocks until triaged. A service failure can pass a recovery assertion while the successful-inference assertion stays blocked.

Use a result row per case × environment × profile, not a single green total. Required fields: case ID, linked subcases, feature status, build/diff/VSIX hash, fixture/seed, OS/editor/provider/model, start/end/duration, attempted/completed/failed/cancelled turns, fault schedule, peak/idle resources, spend, invariant violations, artifact links, `NOT_RUN|PASS|FAIL|BLOCKED|NOT_APPLICABLE`, reason, owner and follow-up issue. `NOT_APPLICABLE` requires a capability/entrypoint explanation. A screenshot alone is insufficient proof of backend side effects.

## Execution order, automation and release decision

1. **Inventory/preflight:** validate coverage manifest and local links; build/check VSIX; provision fixture copies, accounts and budget; record per-provider availability via actual inference, not just cached login metadata. Resolve contract gaps or leave their acceptance rows failing/blocked.
2. **Deterministic boundary gate:** parser/manager/browser suites, build, lint, typecheck, minimum-runtime and packaging checks; extend missing race and corruption cases. Keep source-static tests labelled as such.
3. **S gate:** every reachable feature and every adapter in the real editor. Stop for P0 failures, preserve evidence, fix and rerun the failing scope and neighboring transitions.
4. **W gate:** all backends individually and all feature catalogs, grouped into J1–J7. Schedule at most two expensive suites per reference machine; record contention rather than blaming it on provider latency.
5. **E/P gate:** transport families and stateful features as specified above. Use real elapsed time, real restarts and actual service token-expiry windows. Accelerated clock tests supplement these runs; they cannot replace them.
6. **Regression/decision:** reproduce every discovered failure, add an appropriate durable regression, rerun affected feature + integrated journey, then inspect evidence against every required row. No broad “all features stable” claim while mandatory rows are `NOT_RUN`, `FAIL` or `BLOCKED`.

Existing entrypoints (use Node from `.nvmrc`; account-backed commands consume quota):

```sh
node scripts/validation/feature-plan.cjs
npm run typecheck
npm run lint
CI=true npm test -- --maxWorkers=2
npm run package
node scripts/check-package-shape.js mysti-2.0.0.vsix
npm run test:vscode
MYSTI_LIVE_PROVIDERS=1 MYSTI_LIVE_MENTIONS=1 npm run test:vscode
npm run test:live:conversations
npx vitest run --config vitest.live.config.ts tests-live/providers.test.ts tests-live/menuAttachments.test.ts
```

These commands do **not** implement the complete plan. New work needed before unattended execution: a real-editor soak driver with seeded journeys; structured measurements and result ledger; controlled protocol fault services; reusable multi-day fixture persistence; real-account suites for remaining adapters/integrations; semantic Canvas/permission side-effect oracles. Prefer extending current suites over duplicating mocks. A fake provider is appropriate for a race oracle but cannot certify account-backed collaboration.

Full acceptance requires all mandatory cases passed at their specified load, zero open P0/P1 defects, no unexplained leaks/data loss/unauthorized effects, preserved evidence, and explicit independent review of contract-gap resolutions. If accounts or an OS are unavailable, report that exact unsupported/unverified scope; do not convert it to a full-feature pass. This document itself is complete when the source inventory is mapped and every feature has an executable test specification; execution remains separate work.

## Plan preparation audit

The prepared inventory contains **130 cases**: 12 setup/conversation features, 16 individual backends, 36 agent/runtime features, 30 editor/workspace features, and 36 Canvas/integration features or explicit capability boundaries. Each case has implementation references, realistic scenario steps, a long-session load, failure probes, acceptance evidence, and existing-versus-needed coverage; backend rows inherit the explicit BP protocol.

On 2026-10-09, `node scripts/validation/feature-plan.cjs` passed exact mappings for **35 contributed commands, 199 settings, 141 chat actions, 16 providers, 18 Canvas operations, 5 session shapes, 24 built-in slash aliases and 42 bundled agent assets**. Catalog IDs/titles and all repository-local links matched. A read-only negative control removing one command mapping was rejected by the auditor. Per-case specification-field/source-reference checks and `git diff --check` passed. Independent source reviews added missing Active Mode, automatic title, Cline temporary-rules, local-tool and Changes-dock cases and corrected the native-session-reset oracle.

These are checks of plan completeness and consistency. **No new product, account-backed, eight-hour, 24-hour or five-day tests were executed while preparing this plan.** All 130 case execution states remain `NOT_RUN`; previous reliability results are linked separately and are not promoted into this plan's acceptance ledger.
