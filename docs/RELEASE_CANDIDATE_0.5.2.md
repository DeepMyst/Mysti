# 0.5.2 review candidate

Unpublished candidate prepared in the isolated reconciliation worktree. The
original checkout and its index are unchanged by this review. No push, merge,
tag, normal-profile installation or Marketplace publication was performed.

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
| 11. CI and editor minimum | Blocking workflows retained. Hosted results, branch protection and the minimum macOS pre-activation SIGTRAP remain open. |
| 12. Desk | Pairing/grants and status/locate scope verified locally. Remote task execution is not wired into production; two-machine acceptance is open. |
| 13. Panel | Product claim corrected to independent answers shown together. No synthesis pass is claimed. |
| 14. Capabilities/docs | Execution types and prompt-history behavior explicitly declared; documentation aligned with reachable provider paths. |
| 15. Persistence | Journal ordering/tail handling and Canvas recovery preservation fixed. Migration, future-schema refusal and failure fixtures pass; real-profile downgrade acceptance is open. |
| 16. Modularity | Run budgets extracted alongside the existing stream/output owners. Broader permission/tool dispatch and Canvas/chat decomposition remain architectural debt. |
| 17. Dependencies/warnings | Source/media lint is clean. Production audit is clear; the development serializer exception and Canvas performance warnings remain bounded, owned follow-ups. |
| 18. Release preparation | Version and notes prepared; final test logs, archive hash and installed-editor result are recorded with the artifact. Publication remains blocked on the external acceptance gates. |

See [provider approval evidence](APPROVAL_ACCEPTANCE_MATRIX.md),
[external acceptance gates](EXTERNAL_RELEASE_ACCEPTANCE.md),
[persistence recovery and downgrade](PERSISTENCE_RECOVERY.md), and
[dependency/build exceptions](MAINTENANCE.md).

## Artifact and rollback discipline

The final evidence directory is `out-test/release-evidence/` (ignored by Git and
excluded from the VSIX). `HANDOFF.md` and `item18-release-manifest.json` identify
the exact source commit, archive SHA-256, checks, prior candidate and remaining
gates. Retain the tested archive; rebuilding creates another artifact that must
be verified separately.

Conversation and Canvas schemas remain version 1. Preserve the complete `.mysti`
workspace data and the relevant editor profile before switching versions. The
prior local candidate is a recovery option, not evidence of an approved
production release. Test a downgrade against copies and never overwrite a
future schema. Do not delete recovery copies merely because the current version
can open the restored design.
