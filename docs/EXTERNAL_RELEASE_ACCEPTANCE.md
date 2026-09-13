# Remaining external acceptance

Updated 2026-09-13. These checks require the exact candidate commit/archive and
an environment not supplied by the local isolated review. They are release gates,
not results inferred from unit tests or source presence.

## Hosted CI and editor support

The workflows retain blocking Linux/macOS/Windows source gates, lint, browser
tests, the Node 18.17.1 bundled-runtime fixture, package shape, and installed-VSIX
checks on minimum VS Code 1.86.0 and stable Linux. The packaged jobs consume the
same uploaded archive without rebuilding it. No workflow was weakened.

The review branch is now published with user authorization. Require its exact-commit
results: `gates (<OS>)`, `test (<OS>)`, `lint`, `bundled runtime (Node 18.17.1)`,
`package shape`, `packaged VS Code (1.86.0)`, `packaged VS Code (stable)`, and the
`VS Code host (<OS>, <version>)` matrix. Inspect repository rules/branch protection
separately: workflow YAML does not establish that checks are required for merge.
The user also authorized the prepared repository rule once all 15 checks pass;
all 15 passed on `2bbf025`, and live ruleset `23154008` now enforces them on
`main` with strict checks and no bypass actors. Both hosted packaged-editor jobs
passed against the same verified VSIX. See the run links and artifact checksum
in [hosted CI acceptance](HOSTED_CI_ACCEPTANCE.md).

The 2026-09-12 remote inspection found that `main` was unprotected, no active
rules applied to it, and the candidate then had no hosted runs. The sole existing
ruleset was disabled. The integration workflow now also runs on candidate pushes
so the source editor matrix can test the exact branch commit before integration.
The [hosted CI procedure](HOSTED_CI_ACCEPTANCE.md) records the findings, the 15
required check names and the subsequently activated repository ruleset.

The local minimum-editor macOS SIGTRAP predates extension activation and remains
unresolved. A fresh isolated installed-archive attempt on 2026-09-13 reproduced
it on macOS 15.6 with Electron 27.2.3. Its main-thread stack includes CoreGraphics
state restoration and AppKit drawing. The initial standalone probes also reported
child-sandbox initialization errors. Corrected extension-disabled probes retained
the outer OS isolation and used the runner's child-sandbox flags: 1.86.0 still
exited with SIGSEGV by default or SIGTRAP with GPU disabled. Stable 1.136.2 reached
the workbench under the same isolation. These are distinct crash observations,
not a confirmed common cause or workaround. No normal profile was modified.
The original reproduction and runtime-only distinction are recorded
in [maintenance](MAINTENANCE.md). Linux minimum-editor CI now passes, but does not
close this macOS gate.

## Installed provider and chat acceptance

Hermes, Kimi and Continue are absent from the reviewed PATH. The previously pinned
Claude binary is also unavailable at its recorded test location. Account-backed
checks remain pending for every provider; isolated fake-model proofs are in the
[approval matrix](APPROVAL_ACCEPTANCE_MATRIX.md).

The latest PATH check still finds no Hermes, Kimi or Continue command. Installed
Claude is 2.0.71, which does not substitute for the pinned 2.1.266 proof. Codex
0.153.4 remains inconclusive: startup attempts to initialize normal-profile
installation metadata before its stdio transport while the isolated probe denies
that access. No account-backed acceptance is inferred from that startup failure.

In disposable workspaces and fresh editor profiles, verify a streamed turn, Stop
during preparation/execution/approval, two concurrent panels, switching and
restoring conversations, provider setup failure/recovery, and approval decisions
with actual effects observed. Save the editor/provider versions, artifact hash,
requests allowed/denied and final process state. Do not log credentials.

Local source acceptance now passes 12 real-editor cases on VS Code 1.136.2:
five loopback-provider chat cases (streaming, Stop, history, concurrent panels
and HTTP error recovery), plus seven Canvas cases. The editor ran with user-store
reads/writes and off-machine networking blocked. A disappearing Stop button was
fixed from this run. This does not exercise authenticated CLI setup or replace
the exact-archive and minimum-editor/platform gates.

## Desk scope and two-machine acceptance

Pairing, identity, grants and revocation are integrated. The native vocabulary
publishes only `status` and `locate`; consult/review/assign/handoff/followup are
excluded. Desk's HTTP transport and remote dispatcher are not connected to the
production entry points. Cross-machine task execution is therefore unavailable
in this candidate. The dispatcher's pure import boundary is independently tested;
it does not prove deployment or connectivity.

The settings and pairing UI now describe this limitation, and the grant form no
longer offers consultation or review. Pairing saves identity and permissions;
the serving setting does not start a listener in this version. The latest focused
Desk review passed 299 tests, including grant rendering and dispatch/import
boundaries. This correction does not wire remote execution.

The local Desk scope/transport/pairing suite passes 1,284 tests in 17 files.
A two-machine result has not been produced. Before enabling remote task execution,
wire the authenticated transport with explicit lifecycle ownership, then test
pairing both directions, grant expiry/revocation, scope and secret egress checks,
replay rejection, disconnect/Stop, restart recovery and a real returned result.
Record which machine executes each step. A local loopback fixture is insufficient.
