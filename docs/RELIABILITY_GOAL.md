# Reliability and current-provider completion checklist

Goal: complete the remaining work and make Mysti reliable, with every registered
agent functional and aligned with its current upstream behavior. The goal remains
open. A passing source suite or a deliberately unsupported operation is not proof
that the requested functionality works.

Starting point: candidate `09f9eb2a4984bc7189995a952b47df8e81b8d1a1` passed all
15 required checks and five archive reviews. Its detailed evidence is in
`out-test/release-evidence/REVIEW_ROUND_20260916/REVIEW.json`. These results do not
automatically validate subsequent changes or current provider releases.

Latest verified candidate: `21cb02e` passed all 15 required hosted checks
(overnight 2026-09-22: async media, per-turn Canvas MCP admission, Canvas
export/present/failed-close, compaction cancellation and stale click ownership,
OpenRouter replay/cost/cancellation, and the provider current-release audits).
Local validation passed 15,126 tests with one unchanged unavailable pinned-Claude
skip, typecheck, lint and package shape. Five-archive reviews and hosted editor
archive comparison were not repeated. Evidence is in
`out-test/release-evidence/NIGHT_INTEGRATION_20260922/`.

## Completion requirements

| ID | Requirement | Evidence required | Current state |
| --- | --- | --- | --- |
| G1 | Current behavior for all 15 providers | Dated official release/protocol sources, exact supported versions, implementation review and regression coverage for changed contracts | Core-provider audit corrected eight providers' install/update targets and retired model suggestions; latest native contracts and remaining providers remain open |
| G2 | Actual provider functionality | Installed supported runtime plus authenticated editor turns; streaming, error recovery, Stop during preparation/execution/approval, concurrent panels, history and each advertised capability | Unverified for real accounts; fixtures and installed-runtime proofs have narrower scope |
| G3 | Native operation completeness | Supported read/write/command/network/delegation paths retain authoritative approvals, captured authority, side-effect provenance and cancellation; actual effects observed | Copilot writes, OpenCode shell and restricted Cursor/Continue are unresolved; other transport limits require review |
| G4 | Canvas ownership and behavior (R8) | Authoritative artifact load/switch/save/close owner, tool/view lifecycle ownership, deferred-race tests, browser and packaged editor acceptance | Artifact session, save ordering and tool-session ownership verified on `98fbfa0`; 342 focused Canvas cases and all candidate gates pass. Fenced parser/turn and reentrant job cleanup pass all gates on `d38c8ba`; async media/export/capability ownership and failed-close recovery remain open |
| G5 | Chat timeline and interaction ownership (R9) | Remaining state has explicit ownership; ordering, replay, cancellation and multi-panel behavior preserved in browser/editor tests | Ten Chromium witnesses cover stale intake, final-only loss and duplicate completion; four real-host witnesses show stale ordinary-provider effects after replacement. Host and compaction ownership fixes pass all candidate gates on `ffe7071`, with 62 new regressions. R9b timeline/request identity passes all candidate gates on `09b8503`: local 14,677 tests/one unchanged skip, 107 additions, all 15 hosted checks and five independent archives. R9c visual ownership passes all candidate gates on `4bcd08c`: 14,807 local tests/one unchanged skip, 130 additions, all 15 checks and five archives. Broader interaction ownership and immediate compaction transport cancellation remain open |
| G6 | Minimum runtime and editor compatibility (R10/E3) | Host source checks against minimum Node declarations, exact Node 18.17.1 runtime checks, minimum and stable packaged editor acceptance on supported platforms | R10 passes on `d38c8ba` across all three hosted declaration gates (247 host files), 23 exact Node 18.17.1 runtime checks, 28 runner probes and minimum/stable packaged editor checks; minimum macOS GUI startup remains unresolved |
| G7 | Complete owned-process termination (E7) | Stop/timeout leaves no owned descendants, including escaped sessions or an exited parent; no unrelated processes signaled; actual supported-platform proofs | Bounded failure reporting exists; stronger orphan containment is open |
| G8 | Desk functionality and acceptance (E1) | Implement remaining task authority/execution and exercise pairing, grants, revocation, scope, replay, disconnect/Stop and returned results across two machines | Status/lookup implemented; task execution absent; private relay and second machine explicitly unavailable |
| G9 | Persistence and downgrade acceptance (E5) | Current persistence/migration/recovery proofs plus a controlled real-profile downgrade with matching snapshots and no silent loss | Synthetic old-source probes demonstrate schema/field loss; real-profile acceptance open |
| G10 | Final release candidate validation | Exact final source, full suites with understood skips, performance, audits, build, five archives, installed editors, all 15 required hosted checks and independent reviews | `d38c8ba`: local 14,880 passed/one unchanged skip, 73 added cases with no baseline cases removed; all 15 hosted source/performance/package/editor gates and five independent archive reviews pass. Subsequent media work requires fresh validation |
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
| Gemini | 0.60.0 skips non-root system settings; bridge now enforces via `--admin-policy`, startup refusal (incl. `.agents/skills`) and telemetry off. Install target 0.60.0, 0.58.0 accepted; fake-model runs on both (night 2026-09-22) | Authenticated account operations |
| Cline | 3.0.64 ACP unchanged since 3.0.61; exact-version match widened (3.0.61 accepted); startup refuses a non-empty `~/.agents/plugins` (3.0.62 starts plugins before approval); fake-model 5/5 on both | Installed current contract and authenticated operations; 3.0.62 web search default unverified |
| Copilot | Old write bypass was Mysti's own `COPILOT_ALLOW_ALL=false` (pre-1.0.85 treats any value as allow-all); now unset. Sync shell and per-file edits enabled behind host cards; async/detached denied; 16/16 fake-model scenarios on 1.0.83. Latest 1.0.87 not pinned | Account acceptance; 1.0.87 `--effort`/pin review |
| Cursor | Latest 2026.09.18 reviewed: repo config, project hooks and ACP allowlists prevent Mysti-enforced restriction; restricted tiers remain rejected (documentation only) | Restricted functionality and authenticated acceptance |
| OpenClaw | Pin stays 2026.6.34 (6.35 renames hash-pinned modules; 7.35/9.5 raise Node floor and change SDK/config); two dead gateway calls removed with a method-contract test | Current runtime, authenticated/editor and Windows acceptance |
| OpenCode | Native shell enabled on macOS in ask-permission/full-access (9573f58): a Mysti-owned plugin's `shell.env` hook refuses every spawn not approved `allow_once` for that exact call (upstream still skips permission for no-pattern commands like `> file`); plugin attested before the first prompt, private XDG, account and host homes checked; Stop blocks new spawns and kills running tools at once, then allows OpenCode's own group kill; ACP prompts can never open with `/` or `!`. Adversarial review: no gate bypass. Linux/Windows and read-only/plan stay shell-free | Linux/Windows native runs; real account; `setsid`/double-fork escapes (E7) |
| Qwen Code | 0.24.4: excludes new `tool_call`/`exec`/`record_source`/`omni_*` tools and strips their env; model offered exactly the four admitted tools; install target 0.24.4, 0.23.0 accepted | Authenticated acceptance |
| Hermes | Latest v2026.9.21 source: most tools never request permission and yolo is inherited, so restricted tiers are now rejected before launch; deny/cancel paths verified closed | Runtime unavailable; actual native and account acceptance |
| Continue | cn 1.5.47 Search tool is shell-injectable (pattern and .gitignore lines, runtime-verified with stubbed rg); unrestricted turns now exclude Search and allow Edit/MultiEdit/Write explicitly. Restricted tiers still rejected | Runtime with real ripgrep; restricted functionality and account acceptance |
| Kimi Code | 2.x (`@moonshot-ai/kimi-code` 2.0.2) supported with 1.51 compatibility (1.52 refused: unmaintained stub): model via `session/set_model`, `default` mode pinned before the first prompt (a user's `yolo` config silently skipped approvals), auth presence checks in the version's home, `kimi login`, per-OS installer, npm update checks (ab354bc). Restricted tiers still rejected: 2.0.2 auto-approves in-repo writes, fetch, subagents and skills | Real OAuth login and model turn; `kimi upgrade`; Windows installer path |
| Ollama | Captured request ownership, bounded UTF-8 framing, final events, errors, thinking and proposal-only tools fixed; shared HTTP review passes 104 tests, including 45 loopback cases | Actual configured server/model and editor acceptance |
| LocalAI | Captured request ownership, bounded SSE framing, fragmented tool arguments, usage-only events and reasoning fields fixed; included in the same 104-test HTTP review | Actual configured server/model and editor acceptance |
| OpenRouter | Reasoning replay, served model/cost and prompt-build cancellation fixed (night 2026-09-22) on top of cfe0b0d ownership | Live-model replay acceptance and account/model acceptance |

## Current implementation increments

- OpenRouter ownership/stream completion is verified on candidate `cfe0b0d`. All
  15 required checks, five archives and six hosted editor runs passed independent
  review. Remaining OpenRouter capabilities stay listed above.
- Qwen/Gemini configuration now accepts the supported Qwen protocol map, removes
  inherited execution selectors, and captures the same configuration environment
  used to launch. Windows alias tests exercise real launch preparation under a
  synthetic platform; they do not prove native Windows runtime acceptance.
- Gateway stream review reproduced six incomplete/error cases reaching tool
  dispatch. Strict framing, terminal/tool-batch validation and cancellation fixes
  pass 376 focused tests and independent review; approval enforcement remains in
  the existing execution ports. Combined Qwen/Gateway validation passes 14,459
  source tests, one unavailable pinned-Claude skip, and a private packaged editor
  run (13 passed, one expected native-payload absence skip). The earlier Ubuntu teardown failure is preserved; corrected fixture and fresh
  candidate `98fbfa0` pass all 15 hosted gates and five independent archive reviews.
- Canvas tool-session ownership and independent implementation review pass342
  focused cases. Captured run approval, sticky cancellation and artifact-owner
  identity prevent delayed-open success after Stop, borrowing a replacement view,
  and read-only/plan runs applying edits under permissive global settings. Real
  router cases prove exactly one terminal per job. Combined validation with the
  isolated/awaited fixture-cleanup fix passes 14,508 tests, release packaging and
  private editor acceptance. Candidate `98fbfa0` now passes all 15 hosted gates and
  five independent archive reviews. Fenced parser, media/export
  and failed-close persistence recovery remain separate work.

- R9a host ownership and compaction commit guards pass independent review with
  33 new actual-host cases and 29 new compaction cases. Captured ownership covers
  preparation, intake, terminal cleanup, plans, question timers and manual
  compaction. Summaries require explicit completion and unchanged history; smart
  memory uses a guarded staged commit. Combined local validation passes 14,570 tests (one unavailable Claude skip),
  release packaging and private editor acceptance (13 passed, one expected native
  absence skip). All 15 hosted gates and five independent archive reviews pass on `ffe7071`. R9b timeline/request identity and detached visual continuation remain
  separate; immediate termination of a blocked compaction transport is unproven.

- R9b timeline/request identity passes independent source review and the full
  local suite: 14,677 passed, one unchanged unavailable-Claude skip, 107 added cases
  and no baseline cases removed. Requests retain captured ownership through
  ordinary, session, coordinator and initial mention output. Browser admission
  precedes composer, Runs, tool and queue effects; completion is accepted once.
  Captured attribution and question replies survive valid completion without
  borrowing a successor. Stop preserves executed-tool audit records. Background
  notices and brainstorm Stop remain independent. Two initial full-suite test
  expectation failures are preserved and corrected with stronger behavioral
  checks; production was unchanged. Main/minimum 244-file/editor types and lint
  pass. The release package matches reviewed source; private VS Code 1.137.0
  acceptance passes 13 tests with one expected universal native-payload absence
  skip. All 15 exact hosted checks and five independent archive reviews pass on
  `09b8503`. Hosted main counts are Linux 14,649 passed/26 skips, macOS
  14,654/21 and Windows 14,629/46, plus three performance cases per platform.
  All skip contracts are unchanged; minimum 244-file declarations, exact Node
  18.17.1 runtime 23 checks and 28 runner probes pass.
- R9c visual ownership implementation passes independent source review and the
  full local suite: 14,807 passed, one unchanged unavailable Claude skip,
  130 added cases and no baseline cases removed. Three actual browser/process
  controls pass under OS isolation. Captured parent success/nonce prevents early
  or stale synthetic turns; captured policy, operation and resource ownership
  covers approval, action and screenshot boundaries. Cancellation retains exact
  failed resources for bounded cleanup and reports unconfirmed cleanup honestly.
  The historical three stale-observation, four parent-outcome and eight deeper
  authority witnesses remain preserved. Local package shape and isolated editor acceptance pass (13 passed, one expected
  native absence skip). All 15 hosted checks, five independent archives and six
  hosted editor runs pass on `4bcd08c`. All three platforms pass the actual browser
  and process controls; full and production dependency audits report zero.
- R8a Canvas fenced parser and captured turn/artifact ownership is complete on `d38c8ba`.
  Eight actual-host failures and two valid controls at `4bcd08c` demonstrate
  approval widening, nonce-field confusion, artifact retargeting and shared-parser
  loss/splicing. Independent witness/plan review is complete. Implementation and independent review pass, including actual host authority
  and reentrant job cleanup. Full local validation passes 14,880 tests, one unchanged
  skip and 73 additions with none removed. Local package/editor acceptance passes (13 passed, one expected native absence
  skip). All 15 hosted checks, five independent archive reviews and six editor runs
  pass in `CANVAS_FENCED_FIX_20260922/`. Historical evidence remains in
  `CANVAS_REMAINING_REVIEW_20260922/`.
- Current item R8b/C2 is asynchronous Canvas media ownership and staged asset
  persistence. Nine historical witnesses/controls and the store transaction
  design are reviewed in `CANVAS_MEDIA_REVIEW_20260922/`. Implementation passes local
  typecheck, lint, 15,006 tests (one unchanged skip), package shape and independent
  review in `CANVAS_MEDIA_FIX_20260922/`; all 15 hosted checks pass on `72672ee`.

Current working evidence goes in dated subdirectories of
`out-test/release-evidence/`: `OPENROUTER_FIX_20260920/`,
`QWEN_CONFIG_FIX_20260920/` and
`GOAL_RELIABILITY_20260919/GATEWAY_STREAM_FIX_20260920/`. Combined candidate
validation goes in `GATEWAY_QWEN_FIX_20260920/` (failed hosted candidate) and
`CANVAS_TOOL_FIX_20260920/` (verified `98fbfa0`). Verified R9a evidence uses
`CHAT_HOST_FIX_20260920/`; verified R9b implementation and validation uses
`CHAT_TIMELINE_FIX_20260922/`. Canvas implementation evidence is
in `CANVAS_TOOL_SESSION_20260920/`; next-item browser witnesses are in
`CHAT_TIMELINE_REVIEW_20260920/`; detached visual witnesses are in
`CHAT_VISUAL_REVIEW_20260922/`.
The original reliability review remains in `GOAL_RELIABILITY_20260919/`. Preserve failed candidates
and inconclusive probes. All work uses the isolated reconciled checkout; the
original checkout and normal profiles remain untouched. Provider installations,
account-backed requests and release actions require the corresponding existing
authorization or a concrete final approval when they become necessary.
