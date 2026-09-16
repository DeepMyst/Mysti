# Remaining external acceptance

Updated 2026-09-16. The [current review checklist](REVIEW_CHECKLIST.md) tracks
implementation fixes and the next code item. The last verified baseline
`b15eefbb` passed all 15 required checks and five archive reviews; every new
candidate still requires its own exact-commit evidence. These checks require the exact candidate commit/archive and
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

The September 16 PATH and package-metadata check still finds no Hermes, Kimi or Continue command. Installed
Claude is 2.0.71, which does not substitute for the pinned 2.1.266 proof. Codex
0.153.4 remains inconclusive: startup attempts to initialize normal-profile
installation metadata before its stdio transport while the isolated probe denies
that access. No account-backed acceptance is inferred from that startup failure.

The 2026-09-14 follow-up closes the isolated Codex startup failure/Stop checks:
four installed-runtime cases confirm invalid-configuration exit reporting,
independent cancellation and cleanup at the unchanged 30-second deadline.
Startup RPCs now retain the actual failure cause; public-provider tests cover
failure/recovery and cancellation without a spurious error. Successful native
initialization/configuration and real account turns remain pending. The PATH and
package-metadata check still finds the same missing or mismatched runtimes.

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

Pairing, identity, grants and revocation are integrated. The production
[local status and workspace lookup commands](DESK_LOCAL_STATUS.md) connect `DeskClient`, the loopback
HTTP transport, identity signing, peer grants and the sealed dispatcher.
Serving requires both machine settings and workspace trust. Each temporary
connection is bound to a pinned recipient, with signed requests and responses,
replay deduplication, limits and lifecycle shutdown. Separate explicit commands
share owner-chosen status or exact workspace coordinates. Lookup snapshots
intersect machine, workspace and peer scopes, exclude private/linked paths, and
refuse changed scopes or files, including cached replies. Only the local sharing
command reads source for indexing; no source text is returned.

Matching native platform builds provide explicit
[cross-machine status and lookup commands](DESK_CROSS_MACHINE.md), with process
isolation, signed transport links and the existing grant/scope checks. The
universal build retains local Desk. Approved relay and two-machine acceptance
remain open; local encrypted protocol and packaged-runtime evidence are recorded
separately. Consultation,
review, assignment, handoff and followup remain absent from the executable
surface. Settings, rail and pairing copy distinguish local status/lookup from these
remaining capabilities. Local HTTP tests use generated identities and in-memory
stores; they do not establish acceptance across editor profiles or machines.

Local signed HTTP and temporary-workspace tests cover the production lookup path.
A two-machine result has not been produced. Before enabling remote task execution,
complete the cross-machine status/lookup acceptance and separately implement task authority, then test
pairing both directions, grant expiry/revocation, scope and secret egress checks,
replay rejection, disconnect/Stop, restart recovery and a real returned result.
Record which machine executes each step. A local loopback fixture is insufficient.
