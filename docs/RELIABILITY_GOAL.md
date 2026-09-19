# Reliability and current-provider completion checklist

Goal: complete the remaining work and make Mysti reliable, with every registered
agent functional and aligned with its current upstream behavior. The goal remains
open. A passing source suite or a deliberately unsupported operation is not proof
that the requested functionality works.

Starting point: candidate `09f9eb2a4984bc7189995a952b47df8e81b8d1a1` passed all
15 required checks and five archive reviews. Its detailed evidence is in
`out-test/release-evidence/REVIEW_ROUND_20260916/REVIEW.json`. These results do not
automatically validate subsequent changes or current provider releases.

## Completion requirements

| ID | Requirement | Evidence required | Current state |
| --- | --- | --- | --- |
| G1 | Current behavior for all 15 providers | Dated official release/protocol sources, exact supported versions, implementation review and regression coverage for changed contracts | Core-provider audit corrected eight providers' install/update targets and retired model suggestions; latest native contracts and remaining providers remain open |
| G2 | Actual provider functionality | Installed supported runtime plus authenticated editor turns; streaming, error recovery, Stop during preparation/execution/approval, concurrent panels, history and each advertised capability | Unverified for real accounts; fixtures and installed-runtime proofs have narrower scope |
| G3 | Native operation completeness | Supported read/write/command/network/delegation paths retain authoritative approvals, captured authority, side-effect provenance and cancellation; actual effects observed | Copilot writes, OpenCode shell and restricted Cursor/Continue are unresolved; other transport limits require review |
| G4 | Canvas ownership and behavior (R8) | Authoritative artifact load/switch/save/close owner, tool/view lifecycle ownership, deferred-race tests, browser and packaged editor acceptance | Artifact session and cross-view save/delete/restore ordering implemented and independently reviewed; 253 focused cases pass; tool/view ownership, failed-close recovery and candidate editor acceptance remain open |
| G5 | Chat timeline and interaction ownership (R9) | Remaining state has explicit ownership; ordering, replay, cancellation and multi-panel behavior preserved in browser/editor tests | Open |
| G6 | Minimum runtime and editor compatibility (R10/E3) | Host source checks against minimum Node declarations, exact Node 18.17.1 runtime checks, minimum and stable packaged editor acceptance on supported platforms | Declaration project, Windows path regression and four injected-fault checks pass; exact Node 18.17.1 passes 23 runtime checks and 28 editor-runner probes; candidate CI pending; minimum macOS GUI startup remains unresolved |
| G7 | Complete owned-process termination (E7) | Stop/timeout leaves no owned descendants, including escaped sessions or an exited parent; no unrelated processes signaled; actual supported-platform proofs | Bounded failure reporting exists; stronger orphan containment is open |
| G8 | Desk functionality and acceptance (E1) | Implement remaining task authority/execution and exercise pairing, grants, revocation, scope, replay, disconnect/Stop and returned results across two machines | Status/lookup implemented; task execution absent; private relay and second machine explicitly unavailable |
| G9 | Persistence and downgrade acceptance (E5) | Current persistence/migration/recovery proofs plus a controlled real-profile downgrade with matching snapshots and no silent loss | Synthetic old-source probes demonstrate schema/field loss; real-profile acceptance open |
| G10 | Final release candidate validation | Exact final source, full suites with understood skips, performance, audits, build, five archives, installed editors, all 15 required hosted checks and independent reviews | Current local suite: 14,226 passed, one native-provider skip; main/minimum/editor types, lint, release build and zero-vulnerability audits pass; three performance cases, archive shape/review and private VS Code 1.137.0 pass (13 passed, expected native absence); hosted acceptance pending |
| G11 | Release disposition (E6) | Reviewable final candidate, applicable external gates complete, and authorization for main merge/tag/publication | Candidate-branch publication authorized; final release actions remain outstanding |

## Provider evidence ledger

Each row must eventually record the upstream version/date, installed tested
version, supported account/setup path, native and authenticated evidence, and any
remaining gap. Discovery or a manifest capability alone does not close a row.
Missing runtime/account access remains missing evidence rather than a passing
skip. Capabilities must follow actual upstream contracts; do not remove a feature
merely to make this checklist pass.

| Provider | Current audit work | Acceptance still required |
| --- | --- | --- |
| Claude Code | Latest stable 2.1.278 reviewed; verified bridge remains 2.1.266; install/update targets now agree | Supported installed version and authenticated editor operations |
| Codex | Latest stable 0.155.1 reviewed; verified bridge remains 0.153.4; retired automatic model entry removed; sign-in action corrected to `codex login` | Successful native initialization and authenticated operations |
| Gemini | Latest stable 0.60.0 rejects Mysti's user-owned system settings; verified bridge remains 0.58.0; installer/auth/model guidance corrected | Complete startup policy transport for latest release, current supported account/setup and operations |
| Cline | Pending current release/ACP review | Installed current contract and authenticated operations |
| Copilot | Native writable approval investigation | Actual read/write/command approval and account acceptance |
| Cursor | Pending current CLI and restricted-mode review | Restricted functionality and authenticated acceptance |
| OpenClaw | Owned runtime stays on 2026.6.34; shared updater corrected to respect that verified target. Current upstream gateway/tool-policy review remains open | Current runtime, authenticated/editor and Windows acceptance |
| OpenCode | Actual 1.18.29 Core V2 imports workspace/ancestor plugins even in pure mode; new startup guards pass nine isolated native scenarios. Test-only shell hook exposes a surviving child after Stop and remains disabled | Owned shell execution/termination, stronger startup isolation and authenticated acceptance |
| Qwen Code | Pending current ACP/tool-policy review | Current native and authenticated acceptance |
| Hermes | Pending current ACP/tool-policy review | Runtime unavailable; actual native and account acceptance |
| Continue | Pending current CLI/restricted-mode review | Runtime unavailable; restricted functionality and account acceptance |
| Kimi Code | Pending current ACP/tool-policy review | Runtime unavailable; actual native and account acceptance |
| Ollama | Captured request ownership, bounded UTF-8 framing, final events, errors, thinking and proposal-only tools fixed; shared HTTP review passes 104 tests, including 45 loopback cases | Actual configured server/model and editor acceptance |
| LocalAI | Captured request ownership, bounded SSE framing, fragmented tool arguments, usage-only events and reasoning fields fixed; included in the same 104-test HTTP review | Actual configured server/model and editor acceptance |
| OpenRouter | Review found request ownership/Stop races and lost stream termination metadata; reproductions and fixes are the next item | Actual account/model and editor acceptance |

Current working evidence goes in
`out-test/release-evidence/GOAL_RELIABILITY_20260919/`. Preserve failed candidates
and inconclusive probes. All work uses the isolated reconciled checkout; the
original checkout and normal profiles remain untouched. Provider installations,
account-backed requests and release actions require the corresponding existing
authorization or a concrete final approval when they become necessary.
