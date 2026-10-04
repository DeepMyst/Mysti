# Proactive continuation and accumulated Mysti release

Date: 2026-10-03. Continues [rollout plan 42](42-proactive-rollout-and-next-steps.md).

## Scope and authorization

The user explicitly requested merging the accumulated Mysti release, including the existing branch history (253 commits ahead of main), onboarding, agent catalog, provider reliability, menus, installers, dictation, and the first Proactive increment. Preserve the development history and merge through a reviewable pull request. DeepMyst PR #1013 was already merged and deployed.

This continuation adds saved cloud scan progress and an explicit task-context view. It does not complete the entire roadmap. No real-account watch is created without a selected repository/channel; the pilot resource question remains pending.

## Implemented continuation

- Migration 183m adds a defaulted checkpoint to existing responsibilities. Worker transactions commit pagination progress with evidence, preserving replay/dedup behavior.
- GitHub scans open/closed PRs in newest creation order, 100 per check. Slack scans fixed seven-day windows, 15 top-level messages per check, using documented timestamp pagination.
- Scans are bounded to 100 pages and 24 hours. Status reports pending pages, resets and coverage gaps. This is not a snapshot: source movement, deletions, busy histories and delays can leave gaps. Slack threads are still excluded.
- Rate limits preserve progress and the previous successful timestamp; Retry-After and GitHub reset headers postpone the next check.
- The inbox's **Before you start** form refreshes accessible evidence for one responsibility. An optional task summary ranks evidence locally, with no persistence or upload. It exposes source versions, timestamps, source author/status when present, stale/paused status and limitations. It does not infer task ownership or inject evidence into chat.
- Results clear on refresh, authorization changes and form edits; late results for previous summaries stay hidden. Untrusted evidence is rendered as text.

## Validation and release evidence

Release PRs: [Mysti #55](https://github.com/DeepMyst/Mysti/pull/55) and [DeepMyst #1014](https://github.com/DeepMyst/DeepMyst-2.0/pull/1014). PR #55 tracks the final Mysti merge status and required platform checks. DeepMyst #1014 is merged and deployed as detailed below.

Local validation:

- Mysti: **13,725 tests passed across 438 files**, including Chromium task-context flows and stale-result rejection. A browser setup convention was corrected; the settings harness now awaits background initialization to prevent a teardown race. An earlier concurrent-build run hit a canvas timeout; the final run completed without failures or unhandled errors.
- Native VS Code 1.140.0: **10 passed**, covering the Proactive panel, dictation bridge and canvas host.
- TypeScript, release build and vendored integrity checks pass. ESLint has no errors and 455 existing warnings.
- DeepMyst: **11 Proactive tests passed** against isolated PostgreSQL 17, including migration upgrade/downgrade, persisted checkpoint/evidence, replay, authorization, concurrency and provider retry delay. Ruff passes.
- Hosted Windows checks exposed CRLF conversion of exact-byte vendor hash inputs. LF checkout attributes preserve those inputs without weakening integrity verification. Further Windows failures exposed short-path/canonical-path differences in local tool output (fixed), POSIX-only filesystem fixtures, mock path separators, JSON-escaped attachment paths and asynchronous child cleanup. Those fixtures now follow platform semantics; POSIX fd-zero closure tests explicitly skip Windows, while its native approval lifecycle tests still run.
- Native editor tests now handle absent dictation support by asserting a setup-required result. The VS Code 1.86 inspector leaves unsupported download configuration untouched; all actual canvas evaluation and rendering still use the real editor. The entire native matrix passed at `dcf44c4`.
- Frame-timing performance assertions run separately from the parallel suite to avoid measuring unrelated runner load. Required packaged VS Code checks now install and inspect the verified VSIX artifact on 1.86.0 and stable.
- Existing backend full-suite/security failures remain separate operational debt; the new Proactive tests are required in CI.

## Next unfinished gates

1. Run the explicitly selected live GitHub/Slack pilot, including browser sign-in, editor-closed delivery, pause/resume/revoke and noise checks. Contract tests do not replace this.
2. Rotate to a dedicated Composio proxy credential; add per-source operational telemetry and remediate existing backend CI/security debt.
3. Add thread coverage and edit/deletion reconciliation, with a durable event strategy for sources that outgrow bounded polling. Consider webhook/event ingestion before claiming complete coverage.
4. Connect the explicit task-context view to an optional chat-start affordance and improve relevance using evaluated, source-backed signals.
5. Continue requirement drift, bounded test/review offload, broader connectors and enrolled mobile/phone delivery in the order from plan 42.

Source contracts: [Slack history pagination](https://docs.slack.dev/reference/methods/conversations.history/), [GitHub pull request listing](https://docs.github.com/en/rest/pulls/pulls), and [GitHub pagination guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).


## Backend continuation deployment

DeepMyst PR #1014 merged at 2026-10-03 07:05 UTC as `d352950df4245f636d30dfb5e03e1c18d6f758eb`. Render API deployment `dep-db0aic0ae00c73edqtlg` and worker deployment `dep-db0aic0ae00c73edquk0` are live.

Production verification jobs `job-db0ajbnavr4c73erlr40` (API) and `job-db0ajbpsrm7s73epd3v0` (worker) succeeded: migration heads `181p`/`183m`, checkpoint column present, both Proactive tables, five routes, proxy configuration and an actual worker tick. Public health returns 200; unauthenticated Proactive access returns 401. Full backend CI reports 6,306 passed / 37 failed / 35 skipped, with exactly the same 37 failing IDs as the preceding deployed release; frontend CI passes. Existing security audit debt remains.

Mysti 0.5.2 is installed locally; an editor reload is required. The real-account pilot remains pending the owner's explicit repository/channel selection. No monitoring grants were inferred or created.
