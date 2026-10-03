# Proactive rollout and next implementation plan

Date: 2026-10-03 (Asia/Amman). Continues [the first release](41-proactive-mode-implementation.md) and the [system design](40-proactive-mode-system-design.md).

## Deployment scope

Deployed the DeepMyst core API, database migration, and background worker needed by the existing Mysti Proactive panel. Existing accounts receive no watches automatically. Installed the validated `mysti-proactive.vsix` locally as Mysti **0.5.1**, replacing 0.4.0 in the user's VS Code extension directory. Reload the editor to activate it. The package remains available locally; it has not been published to the Marketplace.

Release PR: [DeepMyst #1013](https://github.com/DeepMyst/DeepMyst-2.0/pull/1013). It is isolated from the substantially changed local development checkout and based on the live production commit `8c68697547aa15f457aa6bd182994b31d775ecdc`.

The deployable migration is **182m**, based on the production migration graph. The prototype's local migration 147 conflicts with an existing production revision and must not be applied there. Render already runs `alembic upgrade heads` before starting the API.

Pre-deployment evidence:

- Production's read-only database preflight returned Alembic head `181p`.
- The proposed branch's migrations applied successfully in CI.
- All 7 new Proactive tests passed in CI. The broader backend suite reports 37 failures / 6,302 passes / 35 skips; all 37 failing test IDs also fail on the live baseline (which had 6,295 passes). This is not a green full-suite result.
- Existing npm/pip audit and CodeQL checks fail on the live baseline too. Dependency locks are unchanged by this release. Security/CI remediation is an explicit next operational priority, not silently treated as passing.
- Render reports production Postgres point-in-time recovery `AVAILABLE`. A logical export was requested separately; its completion is not yet confirmed.
- A Composio proxy request using the existing server credential was authenticated far enough to reject an intentionally nonexistent connected-account ID (404 / code 606), with no scope denial and no real account accessed. This validates credential compatibility, not a live GitHub/Slack watch.
- `COMPOSIO_PROXY_API_KEY` was configured only on the target API and worker services, reusing that existing compatible credential. Rotate to a separate least-privilege scoped key as the next operations step.

## Verified production result

[PR #1013](https://github.com/DeepMyst/DeepMyst-2.0/pull/1013) was squash-merged on 2026-10-03 at 06:26 UTC. Both Render services are **live** on commit `d0b96be08ce159811727acfb7b8ef26f1a0b9ff2`.

| Component | Deployment / verification | Result |
|---|---|---|
| Core API | `dep-db0a0b8ae00c73edcfm0` | Live |
| Background worker | `dep-db0a0b8ae00c73edcgkg` | Live |
| Public API health | `https://api.v2.deepmyst.com/healthz` | HTTP 200, core-api OK |
| Authentication boundary | Unauthenticated GET `/api/v1/me/proactive` | HTTP 401, missing credentials |
| Database and API readiness | One-off job `job-db0a2t6gekts738qbgb0` | Succeeded: heads `181p`, `182m`; both Proactive tables; five routes; proxy credential configured |
| Worker execution | One-off job `job-db0a2tegekts738qbgig` | Succeeded: cron registered; actual production database tick completed; proxy credential configured |
| Local extension | VS Code extension registry | Mysti 0.5.1 installed; editor reload required |

These checks verify deployment and the database/worker path. They do not establish real-account GitHub/Slack evidence delivery, browser sign-in, or an interactive editor session; those remain the explicit pilot gate below. No user watch was created during deployment. Sanitized machine-readable results are in [rollout evidence](42-proactive-rollout-evidence.json).

## Next, in execution order

| Priority | Increment | Concrete outcome | Completion gate |
|---|---|---|---|
| 1 | Verify an opted-in pilot | One chosen repository and Slack channel produce a relevant, source-linked insight in Mysti while the editor has been closed | Verify real OAuth permissions, background check timestamps, reopen delivery, pause/remove/revoke behavior, and noise with the owner. Permission probing and mocked adapter tests do not replace this |
| 1 | Release operations | Dedicated proxy credential, observable worker/source health, reproducible deployment tests | Rotate from the existing compatible Composio credential to a dedicated scoped key; exercise revocation and rollback; clear the existing platform CI/security debt in a separate reviewed change |
| 2 | Complete source coverage | Durable cursors, bounded catch-up, thread replies, source edit/deletion reconciliation, and provider rate-limit handling | Bursty channels and more than 100 PRs produce either reconciled evidence or a visible coverage gap; replay/restart never silently loses accepted changes |
| 3 | Task-start awareness | Before working, select a responsibility and optionally share an explicit task summary; show ownership/overlap/impact evidence | Related terms are distinguished from actual duplicate work. Stale evidence is labeled; unavailable connectors do not block ordinary chat. No keystroke or full-conversation upload |
| 4 | Better prioritization and requirement drift | Explain why a change matters, identify affected files/tests and deadlines, and compare an approved requirement baseline with proposed changes | Every recommendation cites authorized evidence and a revision; proposals are never treated as approved requirements. A reviewer-labeled pilot measures usefulness and false positives before broader rollout |
| 5 | Bounded offload | Opt-in test and requirement-review recipes on an immutable work snapshot, with results in the inbox | Certified isolation; fixed command/recipe boundaries; time/spend limits; lease fencing; cancellation; verified test counts/artifacts; explicit unavailable state where a platform lacks the required sandbox |
| 6 | Broader work context | Selected email threads, calendars, and documents through capability-aware DeepMyst adapters | Per-resource grants, private-content isolation, connector renewal/revocation, retention, and incremental reconciliation. No blanket monitoring of connected apps |
| 7 | Mobile access and delivery | Responsive authenticated inbox first, then enrolled mobile push with shared read/decision state | Real-device tests for quiet hours, duplicate delivery, stale approvals, logout/revocation, and lock-screen redaction. Device-specific delivery status remains visible |
| 8 | Phone escalation and team responsibilities | Explicitly enrolled SMS/call escalation for selected high-value events; governed shared responsibility ownership | Verified test destinations, cost/frequency caps, opt-out, consent, delivery ambiguity handling, source audience checks, and no execution from an unauthenticated reply |

Start the next coding increment with **source coverage and task-start awareness**, after a real-account pilot establishes that the current connection/worker loop is healthy. This makes the insights more useful before adding autonomous execution or more notification channels.

## Pilot checklist

1. Reload the editor to activate the installed extension, then open **Mysti: Open Proactive Inbox**.
2. Sign in with a personal DeepMyst identity and connect the intended GitHub/Slack accounts.
3. Explicitly enable a watch for a repository/channel and a distinctive issue reference or topic.
4. Observe a real matching change and confirm its source, version, excerpt, last successful check, and coverage statement.
5. Close the editor, make another authorized test change, then reopen it and verify server monitoring continued.
6. Pause the watch and verify no further source checks; resume it, then disconnect its connection and verify evidence becomes inaccessible.
7. Enable VS Code notifications and verify the per-workspace budget and quiet hours. Mobile/phone notifications are not available yet.

## Rollback and operational controls

- Disable monitoring by removing `COMPOSIO_PROXY_API_KEY` from both target services and redeploying. Retained inbox data remains governed by normal access and retention rules.
- Roll API and worker back together to commit `8c68697547aa15f457aa6bd182994b31d775ecdc` if regression recovery is needed (prior API deployment `dep-dav13fpsrm7s73bijsig`, worker `dep-dav13fpsrm7s73bijtgg`). The additive Proactive tables can remain; do not run a broad Alembic downgrade against production.
- Pause/remove individual watches through the inbox. Signing out stops client access but does not revoke an explicitly created server watch.
- Investigate source check failures using status and timestamps; avoid logging credentials or source response bodies.

## Known release constraints

The first release still polls bounded windows and uses term matching. It does not yet provide semantic prioritization, complete event capture, execution jobs, phone/mobile delivery, or all connected-app coverage. The plan above is the path to those capabilities, with evidence required at each step.
