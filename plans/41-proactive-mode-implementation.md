# Proactive mode: first implementation and validation

Started: 2026-10-01. Final validation: 2026-10-02 (Asia/Amman). Implements the first monitoring/inbox increment from [design report](39-proactive-mode-design-report.md) and [system design](40-proactive-mode-system-design.md). The complete roadmap is not implemented. No production deployment, live account subscription, external message, or autonomous execution was performed.

## Implemented

Deployment follow-up (2026-10-03): see [rollout and next steps](42-proactive-rollout-and-next-steps.md). Production uses migration **182m**; migration 147 below records the original local prototype only.

| Area | Result |
|---|---|
| Entry points | Sidebar bell, Command Palette, composer actions, action palette; independent of coding provider |
| Local monitoring | Explicit trusted repository selection; read-only Git checks; HEAD changes, incoming commits and working-file overlap; pause/resume/remove |
| Cloud control plane | Migration 147; tenant/user-owned responsibilities; resource-scoped connection binding; versioned pause/resume; delete |
| Cloud monitoring | Fixed GitHub/Slack GET adapters through account-bound Composio proxy; five-minute ARQ reconciliation; bounded coverage with explicit limitations |
| Inbox | Persisted evidence versions, duplicate suppression, mark read/dismiss, trusted source links, retention and revoked-connection filtering |
| Reliability | Atomic insight insert/check advancement; row locks and `SKIP LOCKED`; idempotent duplicate creation; retry without advancing last-success; stale-check UI |
| Notifications | Opt-in generic VS Code summaries; quiet hours; finite per-workspace daily budget; reserve-before-delivery dedup |
| Permissions | Active membership checks, organization/user isolation, embedded/scoped-key rejection, read-only enforcement; no execution or publish rights |
| Deployment | Core API router/model registration, worker cron, migration, Docker Compose and environment example wiring |

## Validation

- Real temporary Git repositories: no implicit fetch, fetched upstream changes, working-tree overlap, preserved HEAD/worktree, renamed filenames including newlines, detached HEAD, absent upstream, empty repository failure, repository-root boundary.
- Client tests: credential destination restrictions, redirect rejection configuration, bounded requests, 401/403/404/500 handling without response-body leakage, 204 handling.
- Manager tests: default off, workspace trust, dropping observations after pause, persisted dedup, notification reservation, clearing evidence on sign-out, rejecting late previous-account results, trusted source URL handling.
- Chromium: actions, forms preserved across refresh, evidence rendered as text, sign-out clearing, narrow viewport. Existing actions/provider matrix included in regression run.
- PostgreSQL 17 on a new isolated temporary cluster: actual migration upgrade/downgrade; durable CRUD; API HTTP responses; schema validation; tenant isolation; retries/dedup; stale revisions; cascade deletion; source and membership revocation; concurrent creation and concurrent worker claims. No existing application database modified.
- Native VS Code 1.136.2: panel open/reveal/disposal and asset/CSP HTML composition. The editor test harness logged blocked webview requests for its synthetic extension context; it is not evidence of a fully rendered native webview. Rendered behavior is covered separately in Chromium.
- Final targeted Mysti run: **18 tests passed** across four files. Earlier combined run with the existing actions/provider matrix: **37 passed**. Git/browser tests now allow 30 seconds for real process startup after a loaded-host run hit the default test/hook deadlines; the final serial run passed in 2.66 seconds.
- Final backend run: **7 tests passed**, including the PostgreSQL migration, HTTP API, and concurrent worker/creation checks. New Python files pass the repository's Ruff rules and format checks.
- TypeScript typecheck and targeted ESLint pass. Full lint also passed with existing repository warnings. Production webpack build passed; the existing Canvas bundle size warnings remain.
- Release package: [`mysti-proactive.vsix`](../mysti-proactive.vsix), 7,751,428 bytes. Archive shape checks passed. Packaged web assets match final source byte-for-byte; compiled command registration, action progress state, and the bounded 45-second mutation timeout were verified. The timeout accommodates an in-progress 25-second read check before a pause lock can be acquired.
- The isolated PostgreSQL server was stopped after validation. No production migration was applied.

The remote adapters use mocked upstream HTTP contracts in tests. Live GitHub/Slack authorization, real Composio proxy credentials, real worker deployment, and production end-to-end monitoring remain rollout checks. Windows/Linux were not run for this increment; local Git uses argument-vector subprocesses with no platform shell script.

## Deliberate limits

This is a bounded polling release, not the full event/observation ledger and webhook architecture. GitHub examines up to 100 open PRs. Slack examines 15 recent top-level messages and excludes replies; busy channels can have gaps. It does not claim complete source coverage. Evidence can outlive a source edit/delete until retention or a newer observation. Source text is displayed, never executed or sent to an LLM.

Deferred: mobile/phone delivery, broader connectors, task-start preflight, semantic overlap/requirements reasoning, source deletion reconciliation, cross-source priority ranking, durable execution jobs, sandboxed offload, approvals for writes, and team-wide policies. No UI control pretends these are available.

See [usage and deployment](../docs/PROACTIVE.md).
