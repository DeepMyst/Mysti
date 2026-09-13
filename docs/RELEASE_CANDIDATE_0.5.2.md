# 0.5.2 review candidate

Candidate prepared in the isolated reconciliation worktree and published on
`codex/mysti-hosted-ci-review-2026-09-12` for hosted checks. The original checkout
and its index are unchanged by this review. Main merge, tagging, normal-profile
installation and Marketplace publication have not been performed.

## Disposition of the original review items

| Item | Local result and remaining boundary |
| --- | --- |
| 1. Reconciliation | Changes reconciled and committed in the isolated branch. Integration into the original checkout remains a separate action. |
| 2–3. OpenClaw policy and flags | Owned native approval runtime and supported arguments implemented. Broader authenticated/platform acceptance remains open. |
| 4. Claude and Codex | Native bridges implemented with bounded protocol/runtime evidence. The Codex installed startup probe was inconclusive; the pinned Claude test binary is now absent. |
| 5. ACP providers | Gemini/Qwen/Cline/OpenCode/Copilot transports implemented and tested against the reviewed installed versions. Copilot remains read/search only; OpenCode shell is excluded. |
| 6. Restricted transports | Cursor/Continue reject unsupported restricted turns before launch. Native restricted functionality is still unavailable. |
| 7. Notification approval | Notification-time grants removed from direct, legacy mention and collaborator paths. Empty inputs also stop approval-required native tools. A notification cannot establish that an operation has not executed. |
| 8. Approval matrix | Local native/protocol/routing matrix recorded; it is not authenticated end-to-end acceptance for every provider. |
| 9. Installed accounts | Hermes/Kimi/Continue are absent from PATH; account-backed checks remain open. |
| 10. Editor lifecycle | OpenClaw zombie-group cleanup and Cursor lifecycle fixed. Real-editor chat testing found and fixed Stop disappearing after token one. Loopback chat and Canvas acceptance are part of the final archive gate. |
| 11. CI and editor minimum | All 15 required checks passed on `c9a3f35`, including installed archives on minimum/stable Linux editors; the exact-context main ruleset is active. Every later candidate needs fresh exact-commit checks. Minimum macOS 1.86.0 still crashes before activation (SIGSEGV by default, SIGTRAP with GPU disabled). |
| 12. Desk | Pairing/grants, signed status and scoped workspace lookup are connected to production commands and lifecycle. Matching platform builds add explicit iroh commands, signed transport links, a bounded native child process and verified native packaging. The universal build retains local Desk. Scope/file changes invalidate lookup and cached replies. An approved relay and actual two-machine acceptance remain open; local native/runtime tests do not close those gates. |
| 13. Panel | Product claim corrected to independent answers shown together. No synthesis pass is claimed. |
| 14. Capabilities/docs | Execution types and prompt-history behavior explicitly declared; documentation aligned with reachable provider paths. |
| 15. Persistence | Journal ordering/tail handling and Canvas recovery preservation fixed. Migration, future-schema refusal and failure fixtures pass; real-profile downgrade acceptance is open. |
| 16. Modularity | Run budgets and Canvas display/layout owners extracted; Desk local transport and editor lifecycle have separate owners outside the sealed dispatcher. Broader permission/tool dispatch and Canvas/chat decomposition remain architectural debt. |
| 17. Dependencies/warnings | Source/media lint and production audit are clear. Canvas no longer imports migration/compiler code in the browser; its bundle fell from 355,782 to 183,372 bytes and all three webpack size warnings cleared without changing thresholds. The development serializer exception remains. |
| 18. Release preparation | Version and notes prepared; final test logs, archive hash and installed-editor result are recorded with the artifact. Publication remains blocked on the external acceptance gates. |

See [provider approval evidence](APPROVAL_ACCEPTANCE_MATRIX.md),
[external acceptance gates](EXTERNAL_RELEASE_ACCEPTANCE.md),
[persistence recovery and downgrade](PERSISTENCE_RECOVERY.md), and
[dependency/build exceptions](MAINTENANCE.md), and [Desk local status and lookup](DESK_LOCAL_STATUS.md).

## Artifact and rollback discipline

The final evidence directory is `out-test/release-evidence/` (ignored by Git and
excluded from the VSIX). `ACTIVE_REVIEW_PROGRESS.json` points to the current
continuation's handoff; each continuation retains its own exact source commit,
archive SHA-256, checks, prior candidate and remaining gates. The original
`HANDOFF.md` and `item18-release-manifest.json` are historical evidence. Retain
the tested archive; rebuilding creates another artifact that must be verified separately.

Conversation and Canvas schemas remain version 1. Preserve the complete `.mysti`
workspace data and the relevant editor profile before switching versions. The
prior local candidate is a recovery option, not evidence of an approved
production release. Test a downgrade against copies and never overwrite a
future schema. Do not delete recovery copies merely because the current version
can open the restored design.
