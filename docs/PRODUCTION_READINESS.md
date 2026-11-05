# Mysti: production readiness and release checklist

Updated **6 November 2026** (Asia/Amman). Release line: **2.0.1 Beta 2**.

Mysti has substantial automated regression coverage and several verified native
developer journeys. **It remains a beta.** The evidence does not yet establish
all-provider, all-feature, cross-platform or sustained daily-use reliability.
This document is a portable handoff: it describes what is established, what is
still required, and the checklist to use for every update.

Build-specific results, source identity, VSIX checksum and publication status
belong in the [release validation report](releases/2.0.1-beta.2/VALIDATION.md).
The [release notes](releases/2.0.1-beta.2/RELEASE-NOTES.md) describe the shipped
changes. Neither a new version number nor passing fast tests closes the broader
acceptance work below.

## Evidence snapshot

The [execution ledger](../plans/48-feature-test-status.json), last updated on
5 November 2026 with the executing-tool Stop evidence, contains **130 feature cases**:

| Area | Cases | Partial | In progress | Not run | Fully accepted |
| --- | ---: | ---: | ---: | ---: | ---: |
| Setup and conversations | 12 | 12 | 0 | 0 | 0 |
| Individual provider backends | 16 | 15 | 1 | 0 | 0 |
| Agents and runtime | 36 | 0 | 0 | 36 | 0 |
| Editor and workspace | 30 | 6 | 0 | 24 | 0 |
| Canvas and integrations | 36 | 1 | 0 | 35 | 0 |
| **Total** | **130** | **34** | **1** | **95** | **0** |

These are complete-case acceptance states, not counts of passing tests or a
percentage of working features. A case requires its native journeys, faults,
environment matrix and prescribed elapsed-time profiles before it becomes
`PASS`. `NOT_RUN` means this campaign has not executed the complete case; many
of these areas already have unit or browser tests. Historical failed runs remain
in the ledger even when a later bounded correction passes.

Use the JSON ledger for execution detail; the [feature inventory](../plans/47-feature-inventory.md)
is the original plan snapshot, not current status. Reports from earlier VSIX
builds remain evidence for those builds. Rerun affected checks after source,
dependency, upstream or packaging changes.

## What has been established

| Area | Existing evidence | Boundary |
| --- | --- | --- |
| Setup, discovery and authentication | Fixes for cancellation, stale prompts, installer ownership, discovery and recovery; packaged setup and Restricted Mode journeys; actual Codex update/recovery. | Clean machines, fresh accounts, credential revocation and the full OS/editor matrix remain incomplete. |
| Conversations and isolation | Native Claude/Codex handoffs, two-window isolation, Stop/recovery, restored completed/interrupted history, forks, checkpoints, export/import and clipboard journeys. | Specific macOS builds and bounded tasks; full restart/fault/provider and elapsed-time matrices remain incomplete. |
| Provider compatibility | Regression fixes for protocol parsing, model attribution, permission guidance, terminal errors, secret redaction, cancellation and usage ownership across adapters. | An adapter or successful version probe does not establish account access, inference quality or native permission enforcement. |
| Context and attachments | Bounded file resolution and containment, exact text snapshots, queue/draft recovery, context isolation and dispatch; packaged loopback/synthetic-CLI journeys. | Actual provider/image/clipboard/platform combinations and all reload boundaries remain incomplete. Unsent in-memory drafts are not a promise of durable storage. |
| OpenCode | Installed CLI and server mechanics verified with scripted local model responses: tools, continuity, permission decisions, pending-request Stop, remote faults and recovery. Failed remote-session cleanup is retried while its provider instance survives. | No external model inference was used for these fixtures. Deferred remote cleanup is not persisted across extension reload. See the release report for the executing-tool Stop correction and its exact verification. |
| Packaging and runtime | Repository gates cover manifests, vendor provenance, TypeScript, lint, production builds, VSIX contents, minimum embedded runtime and editor integration. | Gate definitions and old green builds do not establish the status of the release commit. Record fresh results for the exact artifact. |

The executing-tool Stop investigation reproduced a concrete OpenCode failure on
3 November: the CLI exited while its shell and child survived in another process
group. The 5 November correction passed the bounded native macOS test: both owned
descendants exited, the delayed write was prevented, and the next request
recovered. Focused regression tests check unrelated-process isolation. Broader
platform and fault acceptance remains open; see the release validation report.

The live-artboard performance diagnostic currently depends on a design artifact
in the sibling `Mysti-Test-Project` repository and explicitly skips on hosted
runners without it. Replace that dependency with a shareable representative
fixture before treating this diagnostic as a portable release gate. Other
portable browser checks require Chromium and fail when it is unavailable.

### Unreleased changes and unresolved reliability investigations

The published **2.0.1 Beta 2 VSIX** remains the build documented in the
[release validation report](releases/2.0.1-beta.2/VALIDATION.md). The documentation
candidate contains an **unreleased** streaming-scroll correction: text and
Markdown still render immediately, scroll measurements are combined within an
animation frame, terminal events flush pending scrolling after final DOM updates,
and replacement turns or conversations invalidate pending work. This correction
is not in the published VSIX and does not establish the Windows timeout's cause.

On **6 November 2026**, candidate `9f899341` finished with **22 jobs passed,
one failed and two skipped**. [Required PR CI](https://github.com/DeepMyst/Mysti/actions/runs/42103394751)
failed the Windows split-UTF-16 rendering case at its unchanged five-second
deadline; its package jobs were consequently skipped. All
[four source-editor jobs](https://github.com/DeepMyst/Mysti/actions/runs/42103394863)
and all 11 jobs in the
[independent push workflow](https://github.com/DeepMyst/Mysti/actions/runs/42103386679)
passed, including packaged-editor tests. Those passes do not replace the failed
required check: that candidate is **not release-qualified**. Check the
[documentation PR](https://github.com/DeepMyst/Mysti/pull/81) for subsequent
commit-specific results; every proposed release still needs its own complete gates.

The later `3310b03` candidate finished with 17 jobs passed, three failed and four
dependent skips. Linux history recovery, Windows CLI lookup and Windows Unicode
composer input exceeded their original deadlines; all four editor integrations
passed. The next corrections remove redundant JSON traversal from the recovery
fixture while retaining identical disk writes, and let trusted Windows CLI
discovery return its first complete absolute match without waiting for remaining
PATH enumeration. Generic CLI probes still require successful exit, and the
lookup stops only its own helper.

Candidate `2ab34ce` verifies both corrections on hosted runners: the original
Linux history case passes in 856 ms and 1,169 ms, and all 18 new first-match
regressions pass in both Windows jobs. Real Windows lookup returns its first
match in approximately 148–170 ms and observes its own helper close in
158–177 ms. The fixture comparison preserves all 324 physical writes with
identical bytes, including 323 updates totaling 178,861,594 bytes, and all three
recovery reads. Original assertions and deadlines remain unchanged.

That candidate is **still not release-qualified**. Its
[independent push workflow](https://github.com/DeepMyst/Mysti/actions/runs/42121256729)
fails two Unicode composer fills at their original three-second action limit;
dependent package/editor jobs are skipped. The same two cases pass in the
[PR workflow](https://github.com/DeepMyst/Mysti/actions/runs/42121267627) at the
identical commit. All 15 required PR contexts pass, including package shape and
both packaged editors. Across the three workflows, 22 eligible jobs pass, one
fails and two are skipped. Those passes do not erase the failed run. All four
[source-editor integrations](https://github.com/DeepMyst/Mysti/actions/runs/42121267653)
pass after one recorded setup-only retry: the initial Linux stable attempt
failed to connect to VS Code's version-list service before download or tests.
The other three successful jobs were carried forward without rerunning.

The [original-source native-input diagnostic](https://github.com/DeepMyst/Mysti/actions/runs/42120102812)
passes without reproducing the timeout. Its slow fill spends approximately
839 ms in native layout before the application input-event markers, including
792 ms in font fallback. The measured application `scrollHeight` reads total
0.8 ms. This locates the delay in that passing observation; it does not prove
the earlier timeout's cause. The composer uses the normal VS Code host font
stack, and no matching supported upstream fix has been verified.

A [single minimal Windows comparison](https://github.com/DeepMyst/Mysti/actions/runs/42125225464)
then passed all six input-only cases at the original three-second action limit:
the two original Unicode payloads and an ASCII control, each in a plain textarea
and the shipped composer. The first plain Unicode fill took **1,288 ms without
Mysti application code**. This is an end-to-end fill measurement; the minimal
run did not measure native font/layout work or reproduce the timeout. Each case owns a
fresh browser; shared OS font caches and the omitted full CI workload prevent
causal timing comparisons between the cases. Standalone HTML, exact payloads,
versions and results are retained in the workflow artifact.

The next step is to capture a failing native input boundary and use the minimal
probe to verify a browser or application correction before changing dependencies
or timing policy. Keep the original input path, payloads, assertions and failed
records. Do not release these changes until the exact candidate and artifact
complete their required checks; the published Beta 2 VSIX does not include them.

The qualification workflow results above apply to source
`2ab34ce8088675d2c113c9a80d037285327a47b7`; the original-source diagnostic
separately used `3310b03`. A later documentation-only status commit records this
evidence; it does not establish a new qualification result.

The `9f899341` rendering-failure trace completed chunk dispatch in 145 ms, then remained pending
during the completion-event evaluation; it does not establish whether the
application handler had entered. The
[full-context Windows diagnostic](https://github.com/DeepMyst/Mysti/actions/runs/42109781185)
passed its browser phase (961 cases, one platform skip) and captured a complete
native trace without reproducing the rendering timeout. Its unit phase failed a
separate five-second CLI path-resolution test, so the diagnostic correctly
finished as a failure. It is investigation evidence, not release qualification;
the rendering timeout's cause remains unassigned. Earlier failures and
same-commit passes remain linked in the documentation PR. The earlier
[Unicode diagnostic](https://github.com/DeepMyst/Mysti/actions/runs/42091942355)
informed a correction to the fixture's missing VS Code font defaults but did not
reproduce or explain the timeout. Assertions, chunk boundaries and deadlines
remain unchanged; no font warmup or application-test-failure rerun was introduced.

Two other observations remain open: a
[macOS Canvas run](https://github.com/DeepMyst/Mysti/actions/runs/42082967578)
exceeded its pan-performance limit, and a
[macOS editor run](https://github.com/DeepMyst/Mysti/actions/runs/42100707759)
failed chat initialization. The editor fixture now checks readiness with the
intended tab visible within its original 30-second budget; all four editor
variants at `9f899341` passed. The earlier failures' causes remain unassigned,
and overlay disappearance alone does not prove the host handshake completed.
The release maintainer owns these investigations; retain their evidence and
require complete checks for each proposed release artifact.

### Provider acceptance still needed

| Provider | Current evidence or constraint | Required next evidence |
| --- | --- | --- |
| Claude Code | Bounded real tools, approvals, recovery and two-chat work; a longer corrected attempt hit session quota. | Complete missing question/plan, attachments, compaction, queued Stop, restart and required workflow coverage when quota permits. |
| Codex | Real developer tasks and durable history; the accepted native checkpoint is retained separately from a later quota-failed run. Installed CLI profile support is limited. | Remaining profile/context/control/restart cases and exact final workflow acceptance. Preserve unknown historical outcomes rather than converting them into passes. |
| Gemini | Installed attempt failed before inference with service/client eligibility rejection. | A supported service/client combination followed by real answer, tool, Stop and recovery acceptance. |
| Cline | Bounded native Stop, queued-writer suppression and same-chat recovery; local rule preservation and terminal/error fixes. | Remaining timeout/capability/fault cases and complete native acceptance. Current constrained Plan/read-only support is unavailable. |
| Copilot | Packaged Auto read/edit/isolation, multi-provider review, history restoration and bounded Stop tests. | Remaining backend/fault/context cases. Explicit selected-model inference remains unqualified after service rejection; Auto evidence does not establish it. |
| Cursor | Local stream, tool-failure and diagnostic-privacy corrections. | Resolve the installed-client credential-invalidation risk before native use; qualify the selected runtime and owned-workspace trust path. |
| OpenClaw | Controlled gateway/auth/stream tests; current native auth readiness lacks an eligible current credential store. | Current supported sign-in/backend, then real inference. Ledger still lists slow Stop cleanup, truncated-stream false completion and gateway-restart background recovery as open work. |
| OpenCode | Installed CLI/server mechanics with a local scripted backend. | Remaining tool/fault/context/concurrency matrices, real-account inference, cleanup across extension reload, WSL/Docker and cross-platform networks. |
| Qwen, Hermes, Kimi, Continue | Local transport, permission/model or incomplete-response corrections. | Selected native installation, account/model readiness and real workflow/Stop/recovery acceptance for each adapter separately. |
| Ollama | Local regressions and bounded transport/history evidence; native attempts did not satisfy their exact task/cancellation oracle. | Qualify actual context use and cancellation with a suitable model/setup; do not relabel the failed attempts as successful native acceptance. |
| LocalAI, OpenRouter, MiniMax | Local request, cancellation and usage-ownership corrections; LocalAI also supports controlled loopback editor fixtures. | Actual configured service/model functional acceptance, cancellation and remaining provider-specific faults. |

Do not repeat a rejected model/client/account request unchanged. Missing access
is a prerequisite to resolve, not a reason to loosen an assertion or silently
switch to a different provider's result.

## Remaining work toward a stable release

User-facing procedures now live in [visual walkthroughs](walkthroughs/README.md),
[troubleshooting](TROUBLESHOOTING.md), [backup and recovery](BACKUP-AND-RECOVERY.md)
and [privacy](PRIVACY.md). These describe current implementation boundaries;
they do not close the native acceptance cases below. In particular, the current
CodeLens telemetry event includes a function name. Review whether that code
identifier is necessary, minimize or remove it as appropriate, and verify the
telemetry opt-out and disclosure before making a no-code-data collection claim.

The release maintainer owns triage and assigns a named owner to each selected
item. The case IDs below join this handoff to the detailed test plan.

| Priority | Work | Exit condition |
| --- | --- | --- |
| P0 | Complete cancellation and process ownership across supported transports (PC-07, PB-07, PB-08). | Stop blocks delayed tool effects, settles owned resources within the documented deadline, leaves other clients untouched and permits next-turn recovery. Repeat affected OS and wrapper cases. |
| P0 | Verify permissions, trust and account boundaries (PC-03/09/12, AR-20/21, integrations). | Native denial/Stop prevents the actual write or outbound effect; stale approvals cannot act on a successor; no account, panel or workspace leakage. |
| P0 | Finish durable recovery and upgrade acceptance (PC-08/10/11, EW-30). | Exact history/settings/artifacts survive ordinary restart and upgrade; corrupt/partial/future-schema stores preserve recoverable original bytes; downgrade behavior is documented and tested. |
| P0 | Qualify the release artifact on supported systems. | Green required hosted checks plus installed-VSIX smoke on minimum/current VS Code; native Windows, Linux and macOS coverage for platform-sensitive changes. |
| P1 | Complete provider functional coverage (PB-01–16). | Each advertised supported adapter has its own authenticated/native workflow, tools, errors, Stop and recovery evidence, with model/CLI limitations documented. |
| P1 | Execute unrun collaboration/runtime cases (AR-01–36). | Independent reviews, dependent handoffs, partial failure, plans, costs, compaction, checkpoints and background ownership agree with product promises. |
| P1 | Resolve exposed contract gaps before advertising completion. | Reconcile session `/panel` synthesis, typed `/brainstorm` convergence and concurrency-setting promises; implement or remove unsupported controls. Verify Canvas unpin, variants and export/generation claims, commit-signature behavior, skill republish recovery and telemetry boundaries. |
| P1 | Complete Canvas and connected-service acceptance (CI-01–36). | Real document/reload/undo workflows and authorized test-service journeys have semantic state and side-effect evidence. Pairing metadata is not live Desk transport; Proactive observation is not automatic checkout/continuation. |
| P1 | Complete editor experience (EW-07–30). | Keyboard and screen-reader journeys, RTL/long labels, high contrast, narrow layout, settings, privacy opt-out, diagnostics and important failure states work in the installed extension. |
| P1 | Run sustained daily-use profiles after the user resumes them. | Required elapsed duration, meaningful work, restart/sleep/fault schedule and resource/cost measurements all pass. A fast loop or several short runs is not a workday. |
| P2 | Reduce maintenance friction. | Keep provider responsibilities modular, remove obsolete compatibility branches only with evidence, retain a small reusable fixture set, and resolve minimum-runtime type-check and development audit exceptions documented in MAINTENANCE. |

The contract-gap rows originate in the source-grounded plan. Reinspect the
current implementation when taking each case; they are explicit verification
obligations, not a claim that every historical observation remains unchanged.

### Deferred endurance work

The user chose **bounded functional checks; defer endurance** on 15 October
2026. This remains in effect. Deferred work is incomplete, not waived.

| Profile | Required duration and useful work |
| --- | --- |
| S | 45–60 minutes, at least 25 meaningful turns/operations, ordinary mistakes/recovery and a restart. |
| W | Eight elapsed hours, 250 turns across ten tasks, cancellations, idle and sleep/wake. |
| E | 24 elapsed hours, 750 turns/operations, at least 20 fault/recovery events. |
| P | Five actual days, 1,000 turns total, overnight shutdown, upgrade and branch/workspace changes. |

Do not start these campaigns under the current preference. When resumed, agree
on provider spend, supply the missing structured resource collector, and use the
per-case workloads in the [comprehensive plan](../plans/47-comprehensive-feature-test-plan.md).
Measure host/webview memory and CPU, listeners/connections, owned descendants,
latency, usage and cost. Attribute remote model latency separately from Mysti.

## Checklist for every updated version

Copy this section into the next release issue or handoff. Paths are relative to
the repository; the commands use the pinned local tools. Keep the result and
artifact identity together so another maintainer or agent can continue the work.

### 1. Define and freeze the change

- [ ] Record the previous release, target version/channel, exact source commit and any dirty diff. Reconcile upstream changes while preserving local work.
- [ ] Identify changed feature cases, affected transports/platforms and known unresolved defects. Add a reproduction for each material fix.
- [ ] Select beta or stable based on evidence. Stable requires the applicable acceptance gates; an exception must remain visible and must not be called a pass.
- [ ] Update `package.json` and `package-lock.json` together. Review runtime minimums and all bundled/external dependencies.

### 2. Run reproducible source and browser checks

Use the Node version in `.nvmrc`. Run a clean install in the release checkout.
Require Chromium rather than silently accepting browser-test skips.
If the manifest, English localization or `docs/navigation.json` changed, run
`npm run docs:generate` after installation and review the generated diff before
continuing with the checks.

```sh
npm ci
npm exec --no -- playwright install chromium
npm run typecheck
npm run lint
npm run check:vendor
npm run check:docs
node scripts/validation/feature-plan.cjs
npm run test:release:unit
npm run test:release:browser
npm run test:release:performance
npm run compile:release
npm audit --omit=dev
```

- [ ] Record command, exit status, pass/fail/skip counts and retained log. Run the three release phases sequentially; browser/performance checks must not compete with editor/media workloads.
- [ ] The release runner sets `MYSTI_REQUIRE_CHROMIUM=1` and bounds workers (two for unit/integration, one for browser/performance). Linux runners also need Playwright system dependencies (`--with-deps`). No retries or longer assertion deadlines are added.
- [ ] Run focused regressions for changed behavior. Do not replace a failing assertion with retries or a larger timeout merely to obtain green results.
- [ ] Review runtime audit findings and tracked development exceptions. Verify vendored provenance independently of npm audit.
- [ ] Run the minimum-runtime fixture and real-editor integration required by [MAINTENANCE](MAINTENANCE.md). The fixture executes under Node 18.17.1 after building under development Node; do not run the old-runtime assertion under the build Node and call it equivalent.

### 3. Package and exercise the actual extension

For this beta line, substitute the numeric version in the output filename:

```sh
npm run package:pre-release -- --out mysti-2.0.1-beta.2.vsix
npm run check:package -- mysti-2.0.1-beta.2.vsix
```

For a stable release, use `npm run package` and verify the intended channel.

- [ ] Inspect the VSIX itself: publisher/name/version, pre-release flag, required runtime dependencies and walkthrough assets; no credentials, test workspaces or unintended large media.
- [ ] Compute SHA-256 and retain the exact checked artifact. Record build Node, OS/architecture, editor/embedded runtime and CLI versions.
- [ ] Install that VSIX into an isolated fresh profile and a separate upgrade profile. Verify startup, setup, a streamed turn, approval/denial, Stop and next-turn recovery.
- [ ] Exercise two panels, history restart, context/attachments, a multi-agent workflow, checkpoint/rewind and Canvas. Check unchanged user files and actual persisted state.
- [ ] Verify expected failures with missing credentials/offline/unavailable providers. Account-dependent tests need their own prerequisites and spend scope; fixtures do not establish service acceptance.
- [ ] Reproduce the fixed bug using the packaged code and verify resource cleanup. Record unrelated-process controls for cancellation changes.
- [ ] Confirm required hosted CI and editor workflows are green for this exact release commit on the supported matrix. Local macOS success does not stand in for Windows or Linux.

### 4. Prepare documentation and recordings

- [ ] Update README, changelog, feature/provider guides, readiness gaps and release notes to match reachable behavior. Label experimental or unavailable paths.
- [ ] Record focused demonstrations of setup/provider choice, normal chat/context, multi-agent review/handoffs, Brainstorm/session workflows, approvals/Stop, history/forks/rewind, Canvas and supported integrations.
- [ ] Use a clean synthetic project, readable framing, deliberate pacing, captions and consistent visual treatment. Show the action and result; avoid incidental windows, private paths, credentials or unrelated notifications.
- [ ] Label scripted/sample-data recordings and distinguish them from native/account-backed evidence. Never use an illustrative animation as proof of a live backend result.
- [ ] Export a compact poster/GIF where useful. Publish playable GitHub demos using the [native media guide](media/README.md); verify actual playback and seeking on the public README, gallery and release page, as well as every link and narrow-width layout. A repository MP4 link is not an inline player.
- [ ] Keep promotional media out of the installed VSIX; retain capture instructions, scenario descriptions and version/build provenance in the media manifest.

### 5. Publish and verify

- [ ] Review the final diff, release notes, known limitations and evidence together. Confirm no unreviewed code changes followed qualification.
- [ ] Commit and tag the qualified source; push and attach the exact reviewed VSIX and checksum to the appropriate release channel.
- [ ] Publish the tested artifact through the configured registry workflow. The Open VSX workflow consumes a successful main-branch CI artifact and separately checks editor integration; it does not rebuild it.
- [ ] Verify published version/channel, download checksum and install/update behavior. Record GitHub release and registry statuses separately; one does not imply the other.
- [ ] Retain the previous VSIX, history/schema compatibility notes and rollback steps. Verify rollback in a disposable profile before recommending it to users.
- [ ] Link remaining issues with owner, priority, evidence and an observable completion condition. Preserve failed runs and unknown outcomes.

## Reusable release record

```text
Version / channel / date / owner:
Previous version / rollback artifact / data compatibility:
Source commit / dirty diff identity / tag:
VSIX filename / SHA-256 / bytes:
OS + architecture / Node / VS Code + embedded runtime:
Provider CLI + model + transport versions tested:
Changed features and reproduced defects:
Source/browser/runtime/package/editor gates (pass/fail/skip + evidence):
Native/account-backed checks and exact scope:
Unrun platforms/providers, open defects, deferred profiles:
Recordings (scenario / scripted or live / artifact identity):
GitHub release / Marketplace / Open VSX status and links:
Next actions (priority / owner / completion condition):
```

Evidence retained only under ignored `out-test/` directories may not travel with
a clone. Before handoff, preserve a redacted result summary and required logs in
the release/CI artifacts, then include durable links and checksums in the release
record. Do not depend on another person's absolute filesystem paths.
