# Maintaining and releasing Mysti

Start with the [production-readiness status and portable release checklist](PRODUCTION_READINESS.md)
for current acceptance gaps, provider limits and the reusable release record.
This guide explains the repository's checks and runtime constraints. Record
actual results against the exact release commit and VSIX; existing workflow
definitions and historical passing runs do not qualify a newer build.

## Reproducible development

Use the Node version in `.nvmrc`, then `npm ci`. `package-lock.json` is committed;
dependency changes must update it in the same change as `package.json`. Do not
use a fresh dependency resolution as a workaround for a failing clean install.

Most unit tests use a VS Code mock and recorded provider data. They need no model
credentials. Browser suites use the installed Playwright version and Chromium:

```sh
npx playwright install chromium
npm run check:docs
npm run typecheck
npm run lint
npm run test:release:unit
npm run test:release:browser
npm run test:release:performance
npm run check:vendor
npm run compile:release
```

The three release phases run sequentially: unit/integration suites use two
workers; named browser suites use one; Canvas frame-performance checks run last
in isolation. This avoids the action/setup starvation observed when browser and
native-process suites competed in the broad run. Assertions and deadlines stay
unchanged; the runner adds no retries. Additional Vitest reporter arguments can
be passed after `--`, for example `--reporter=json --outputFile=release-unit.json`.

Release phases require browser availability, so a missing browser fails rather
than silently removing coverage. Ordinary `npm test` runs may skip browser tests
when Chromium is unavailable; report those skips. On Linux CI, install Chromium
with `--with-deps`. Do not run recording or other browser workloads alongside the
browser/performance phases.

`compile:release` checks the committed core-agent integrity manifest before
building. `compile` and `watch` regenerate it for development. Regenerate and
review the manifest only when intentionally changing bundled core agents; do
not use write mode to make an unexplained integrity failure disappear.

## Documentation maintenance

Run `npm run check:docs` after editing guides, commands, settings or provider references. It checks the documentation index, links and generated reference consistency; it does not establish that a native provider/account journey works. Use the Node version in `.nvmrc`.

Keep [the documentation index](README.md) and the repository's agent entry points aligned with the current source. Add a practical walkthrough when exposing a major workflow: include prerequisites, numbered actions, expected results, a real screenshot/video with text alternatives, limitations and recovery. Reuse the canonical [video manifest](media/github-videos.json) instead of uploading duplicate clips or linking to MP4 file pages.

When changing configuration, run `npm run docs:generate` to regenerate the [settings reference](SETTINGS.md), then review provider setup tables and sample configurations. When changing permissions, update [approval contracts](NATIVE_APPROVAL.md) and distinguish implemented flags/bridges from native acceptance. When changing storage or network behavior, update [backup/recovery](BACKUP-AND-RECOVERY.md) and [privacy](PRIVACY.md). Preserve historical release results as evidence for their recorded artifact.

## Required checks

| Check | What it establishes |
| --- | --- |
| TypeScript | Host and shared source contracts compile. |
| Lint and manifest guards | Source rules, provider literal boundaries and bundled-agent integrity hold. Lint errors block CI. |
| Vitest on Linux, macOS and Windows | Unit, transport fixture, integration-harness and Chromium behavior. No blanket retry policy. |
| Production webpack build | Both actual bundle entry points compile. |
| Vendored asset verification | Committed Mermaid assets match the recorded build configuration, dependency versions and artifact hashes. |
| VSIX package-shape gate | Runtime dependencies and promised walkthrough assets ship; source maps/declarations and unintended large assets do not. |
| Real VS Code integration | The extension-host environment, including webview/CSP behavior, works in the editor rather than only in mocks. |
| Minimum embedded runtime | A production fixture compiles/edits Canvas JSX and exchanges MCP tool messages on Node 18.17.1, independently of newer development Node. The fixture rejects execution on a different Node version. |

Tests must assert behavior rather than elapsed speed on shared CI machines. Use
fake clocks for deadlines, cancellation and delayed callbacks. Preserve exhaustive
parser checks but partition expensive inputs into independent cases. Benchmark
speed separately before making a performance claim.

Warnings remain useful debt signals. Do not suppress lint errors, make a failing
job advisory, or add retries to get a green result. Fix the cause or document an
explicitly bounded follow-up with evidence.

The Linux Playwright test job uses `ubuntu-24.04`: locked Playwright 1.58.2
rejects dependency installation on Ubuntu 26.04, which `ubuntu-latest` selected
on 5 November 2026. The matrix label stays `ubuntu-latest` to preserve the required
check name. Revisit the runner pin with a qualified Playwright upgrade; do not
change assertions or skip browser tests to accommodate a runner-image update.

The split-UTF-16 case in `renderingReliabilityBrowser.test.ts` records stage
timings and its pending operation only when it fails. A Windows PR run hit the
five-second test deadline while the identical independent push case passed;
the original log did not identify the stalled operation. Preserve both results
and inspect these diagnostics before changing the fixture or application.
The additional logging does not resolve or waive the intermittent timing issue.

The shared chat browser fixture supplies the six font custom properties that
[VS Code injects into webviews](https://github.com/microsoft/vscode/blob/1.86.0/src/vs/workbench/contrib/webview/browser/themeing.ts),
using the minimum supported editor's default platform fonts. Earlier fixtures
omitted them and inherited Chromium's Times font. Keep this host setup in
`tests/webview/chatPageHtml.ts`; do not substitute a font warmup, alter user input
or move measured actions into setup to accommodate a timeout. This corrects
fixture fidelity, not the unassigned cause of the earlier Windows timing failures.

Disposable OpenClaw test-data writers use `PRAGMA synchronous=OFF` for
[reproducible database construction](https://www.sqlite.org/pragma.html#pragma_synchronous).
They still create real SQLite files with the existing SQL operations and
connection lifetimes. These fixtures exercise credential selection, redaction
and read-only behavior; they do not simulate power loss. Production database
connections and test assertions retain their existing behavior.

### Live developer conversations

Run `npm run test:live:conversations` explicitly with authenticated Claude Code
and Codex CLIs. This consumes existing provider quota. It exercises the real
mention planner, collaboration pool, ProviderManager, provider prompts and CLI
transports against disposable synthetic repositories. The VS Code API is mocked;
use `npm run test:vscode` separately for editor-host behavior.

The journeys cover independent code reviews, follow-up context, implementation
handed to another agent for review, a revised requirement checked against the
resulting code, conversation isolation while changing agents, Stop during a
native approval with another writer queued, and Quick Brainstorm synthesis.
Three-agent reviews include Gemini, Copilot, Cursor, OpenCode and Qwen when they
are installed and authenticated; unavailable providers are reported as skipped.

Transcripts, attributed events and scenario outcomes are written to the ignored
`out-test/live-conversations.json`. Set `MYSTI_LIVE_REPORT` to preserve another
run separately. `MYSTI_LIVE_CLAUDE`, `MYSTI_LIVE_CODEX`,
`MYSTI_LIVE_CLAUDE_MODEL`, `MYSTI_LIVE_CODEX_MODEL`, and
`MYSTI_LIVE_GEMINI_MODEL` override local CLI/model choices. The fixture disables
Claude hooks and removes its temporary workspace after each scenario.

For native approvals, process restart, cancellation/recovery and attachments,
also run:

```sh
npx vitest run --config vitest.live.config.ts tests-live/providers.test.ts tests-live/menuAttachments.test.ts
```

Report account/model failures and skips separately from passing tests. A green
mocked suite or an installed adapter does not establish live provider support.

### Cline adapter contract

Cline receives Mysti persona, agent and channel instructions as context in each
request, through the shared prompt builder. This is not a native system-prompt
override: Cline keeps its own system/tool/mode guidance and project rules. Mysti
does not write, replace or restore `.clinerules`. Native slash commands retain
the shared builder's command behavior and bypass added request context.

When testing Cline, preserve existing rule bytes and file type during the request
as well as afterwards. Cover manual edits, concurrent panels, cancellation during
context preparation, and late cleanup after a replacement request. Test credential
redaction in both stderr and legacy structured errors using synthetic secrets.

Known Cline 1.x versions keep model selection in the CLI. Modern versions accept
custom model IDs for the configured backend; an unknown version provisionally
uses the same modern contract as the argument builder. Discovery refreshes open
panels when the selected executable or detected version changes. Neither a model
label nor a successful version probe proves backend availability or tool-policy
enforcement; those require separate native evidence.

### Complete feature and long-session acceptance

Use the [comprehensive test plan](../plans/47-comprehensive-feature-test-plan.md)
and [feature checklist](../plans/47-feature-inventory.md) to plan real developer
journeys, workday/endurance runs, and multi-day recovery. Every case identifies
its source, faults, acceptance evidence, existing coverage and new work needed.
Account-dependent or unwired paths are explicitly separated from runnable cases.

Run `node scripts/validation/feature-plan.cjs` to check the plan's identifier
coverage and local links against current commands, settings, provider identities,
chat actions, Canvas operations, session shapes, slash aliases and core assets.
This validates traceability only; it does not run or certify feature behavior.
Record real/soak results separately before claiming all-feature reliability.

## Dependency updates

Dependabot groups routine npm and Actions updates. Review each group against the
actual runtime: development Node, VS Code's embedded Node, the browser bundle and
external CLI processes are not the same engine. A successful build on the
maintainer's machine does not establish the oldest supported editor works.

VS Code 1.86.0 is the minimum needed for the MCP SDK's `URL.canParse` use:
[VS Code's release source](https://raw.githubusercontent.com/microsoft/vscode/1.86.0/.yarnrc)
pins Electron 27.2.3, which embeds
[Node 18.17.1](https://releases.electronjs.org/release/v27.2.3). The prior 1.85
minimum embeds Node 18.15, which lacks that API. Keep the VS Code type declarations
pinned to the declared minimum and exercise that host in CI; neither bundled
syntax nor a newer local editor proves all older runtime APIs exist.

To reproduce the runtime-only gate, build with the development Node:
`node scripts/build-runtime-fixture.js`. Then run
`node out-test/runtime/minimum.cjs` with Node 18.17.1. It bundles its dependencies
with the production webpack configuration and rejects non-builtin externals, so
the old runtime cannot silently load the newer development dependency graph.
This covers the exercised bundled paths; the real-editor integration remains a
separate requirement. In particular, Babel 8 declares newer upstream Node
support even though these bundled parser/compiler behaviors pass on the minimum
editor runtime.

For an update:

1. Read the upstream release/migration notes and inspect the manifest/lock diff.
2. Run `npm ci` from the new lock and the checks above.
3. Run `npm audit --omit=dev` and assess any remaining runtime advisory against
   reachable code. Record justified exceptions with an owner and removal condition.
4. For externalized dependencies, build a VSIX and check the archive itself.
   Verify that the installed extension can resolve the external package.
5. For CLI compatibility, update captured stream fixtures and exercise a live
   supported CLI version. Keep older behavior only where it is intentionally
   supported, with a regression fixture.

Do not publish as part of a dependency bot update. Publishing requires the release
review below.

### Editor test runtime and audit exceptions

The test CLI runs under development Node, but its Mocha runner executes inside
the editor. Mocha 10.8.2 supports the minimum editor's Node 18.17.1; Mocha 11
requires at least 18.18 and Mocha 12 requires a newer major runtime. The
`@vscode/test-cli` override keeps its in-editor Mocha aligned with the direct
dependency. Recheck this override when either package or the minimum editor
changes. Do not raise the production editor minimum solely to update a test tool.

On 5 November 2026, the patched lockfile reports **zero runtime advisories** with
`npm audit --omit=dev`. The full graph reports **16 affected package entries**
(15 moderate, one high), including propagated findings, in these development-only
families. Keep their exclusions verified against the VSIX archive.

| Family | Exposure and bounded exception | Removal condition |
| --- | --- | --- |
| Mocha 10 → serialize-javascript 6.0.2 | The serializer has [crafted-object code execution](https://github.com/advisories/GHSA-5c6j-r48x-rmvq), [CPU exhaustion](https://github.com/advisories/GHSA-qj8w-gfj5-8c6v) and [function-body escaping](https://github.com/advisories/GHSA-m5mm-p8h7-m29v) findings. Its Mocha path is the optional parallel worker pool; editor tests remain serial, with watch disabled. Patched serializer 7.1.3+ requires Node 20, outside the minimum editor's runtime. | Compatible patched serializer/runner, or a separately reviewed runtime migration. Do not force a Node 20 dependency into the Node 18 editor. |
| minimatch 10 through lint, packaging and test tooling | [Globparts amplification](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249). Patterns come from the reviewed repository/tool configuration; do not expose these developer commands as a service accepting untrusted patterns. The patched 11.x line is outside the parents' declared ranges. | Parent packages adopt the patched major, or a separately qualified override covers all affected callers. |
| glob 13 through the test CLI and coverage tools | [Cancellation bypass](https://github.com/isaacs/node-glob/security/advisories/GHSA-3g3m-2fjr-6pw4). Test discovery uses bounded repository paths, not a public glob endpoint. Patched 14.x also moves to minimatch 11. | Upgrade the parent test/coverage tooling or qualify the coupled major changes, retaining editor compatibility. |

The release maintainer owns these exceptions and rechecks them before each
release. They are residual development risks, not suppressed findings or runtime
acceptance. Do not use `npm audit fix --force` to replace reviewed toolchain majors.
The `vite` override requires patched 8.3.6+ within the current major; remove it
when the parent dependency guarantees that floor and the lock remains patched.

ESLint 10 uses `eslint.config.cjs`; typescript-eslint 8 replaces the older parser
and removes the estree-only minimatch override. New recommended rules remain
errors. TypeScript stays on 5.9.x because ts-loader and typescript-eslint consume
the JavaScript compiler API absent from TypeScript 7. Review the compiler and
both consumers together before lifting the Dependabot exclusion.

Source Node declarations target the development Node 22 major. The old 18.17 declarations conflict
with current TypeScript Buffer definitions and omit the fetch globals used here;
a direct downgrade is not sufficient. Vitest 5 also requires Node 22 or newer declarations. They can therefore admit APIs missing in
the minimum editor. Minimum-runtime and real-editor checks remain required; a
separate compatible type-check project is follow-up work.

### Vendored browser assets

An npm update does not patch a JavaScript file copied into `resources/`. Inspect
the shipped asset and its nested libraries as well as the dependency audit.
`NOTICE` records vendored versions and attribution.

Mermaid is built from the locked npm graph with the same patched DOMPurify used
by chat. `build:vendor` also copies the standalone chat sanitizer and records its
hash, so both copies update together. The upstream prebuilt Mermaid bundle has
its own sanitizer; copying it would bypass that pin. After changing a bundled
input, run:

```sh
npm ci
npm run build:vendor
npm run check:vendor
npm test -- tests/webview/mermaidBrowser.test.ts tests/utils/publishCompliance.test.ts
```

Review `resources/mermaid.provenance.json`, the generated asset/license file and
`NOTICE` together. The provenance check detects changes to recorded inputs or
assets; browser tests exercise actual rendering, the chat CSP and malicious HTML
labels. Neither is a substitute for inspecting upstream advisories.

The 2.0.1 Beta 2 update uses [DOMPurify 3.4.17](https://github.com/cure53/DOMPurify/releases/tag/3.4.17)
and [Mermaid 12.2.0](https://github.com/mermaid-js/mermaid/releases/tag/mermaid%4012.2.0),
whose KaTeX range admits the [patched trust handling](https://github.com/KaTeX/KaTeX/security/advisories/GHSA-238p-pmpm-9mq7).
The lock also refreshes compatible body-parser, qs, fast-uri, Zod, ip-address and
Undici releases. Recheck the audit when preparing another version rather than
carrying this dated result forward.

Prism retains the existing language grammars with the patched 1.30.0 core. Keep
its mixed-version provenance explicit when updating it. The other standalone
browser assets must also be checked and updated independently of npm resolution.

## Release checklist

1. Select the exact commit and release channel, set the version and update release notes. Keep feature
   claims tied to reachable behavior and distinguish experimental integrations.
2. Require green CI and real-editor integration for that commit on all supported
   platforms. Repository branch protection must require the relevant status checks;
   workflow YAML alone cannot prevent an administrator from merging a red branch.
3. Run `npm run package:pre-release` for beta releases, or `npm run package` for
   a stable release, then
   `node scripts/check-package-shape.js mysti-<version>.vsix`. Check the built archive,
   not only a listing of the working directory. Verify the channel flag and retain
   its SHA-256 alongside the source commit and validation report.
4. Install that VSIX into a clean VS Code profile. Exercise startup, setup, a normal
   streamed turn, Stop, two simultaneous panels, conversation restoration, Canvas,
   and expected failure paths with credentials absent.
5. Exercise the supported CLI transports with disposable workspaces. Verify the
   timing of write/shell approval, denial, cancellation and process cleanup on each
   platform. Mocked tool events do not prove native approval is synchronous.
6. Attach test results, package identity and any limitations to the release review.
   Publish the reviewed artifact; do not rebuild an unreviewed artifact afterward.
7. Document rollback: the prior VSIX and data-schema compatibility. A downgrade
   must not overwrite data written by a newer schema.

No local automated run establishes authenticated provider compatibility or a
multi-machine Desk workflow by itself. Capture those results explicitly before
claiming production readiness for those capabilities.

## Next architectural increments

The current hardening adds independently testable chat interaction state and
removes concrete cancellation, routing and validation defects. The large chat
host and browser files still contain significant architectural debt. Refactor
them in reviewable feature increments with these acceptance criteria:

| Increment | Completion criteria |
| --- | --- |
| Extract coordinator run orchestration | Model stream orchestration now lives in `CoordinatorTurnRunner` with explicit ports and abandonment tests; permission/tool dispatch and whole-run budgets still need a separate run service. |
| Extract Canvas host integration | Canvas session ownership, tool dispatch and view lifecycle have narrow ports; all browser and real-editor Canvas tests continue to pass. |
| Split the chat renderer | Markdown/diagrams and sub-agent cards are extracted behind explicit ports with browser/CSP coverage. Continue with cohesive message/timeline features while preserving the existing state contract. |
| Consolidate remaining interaction state | Questions, native approval cards, pending plans and queued continuations have explicit owners. Move remaining host-owned interaction lifecycles into independently testable services as they change. |
| Validate native provider contracts | Hermes/Kimi have blocking ACP approval paths with transport and host tests. Remaining adapters need equivalent native enforcement and recorded live smoke results for approval timing and process termination. |
| Strengthen persistence evolution | Migration fixtures cover supported old schemas, partial/corrupt writes and downgrade preservation; backups can actually be restored. |

Keep these criteria current as work lands. Avoid broad rewrites that change
transport behavior, persistence and UI state simultaneously.

### Mysti 2.0 BETA distribution

The beta line uses `npm run package:pre-release`, including the CI artifact tested by the packaged-editor jobs. Keep the numeric package version and lockfile synchronized; the pre-release marker lives in VSIX metadata, not a semver suffix. The README Marketplace badge is an Install link; inspect the actual listing for its published version. Record GitHub, Marketplace and Open VSX publication separately.

Inspect PNG/GIF/video assets and relative links before publication. Assets under `docs/` stay out of the VSIX but must exist at the repository URLs used by its README. Preserve sample-data labels on deterministic captures; record live-provider validation separately. Do not promote a package to stable by merely removing the word BETA: require a reviewed newer version and a deliberate channel change.

Playwright remains pinned to 1.58.2: later releases require Node 20 and terminate
VS Code 1.86's Node 18.17.1 host on import. Because it is an external runtime
dependency, upgrading it requires a deliberate editor-support decision and real
minimum-editor validation, even when newer development Node passes every test.

### Open VSX publication

The manual **Publish reviewed VSIX to Open VSX** workflow accepts the numeric ID
of a successful `CI` push run on `main`. It also requires successful editor
integration for the same commit, downloads that run's `mysti-vsix` artifact,
checks its DeepMyst/mysti identity and pre-release metadata, and publishes the
exact file with pinned `ovsx@1.2.0`. It does not rebuild the extension.

Before dispatch, the publisher must accept the Open VSX publisher agreement,
control the `DeepMyst` namespace, and configure the repository's `OVSX_PAT`
secret. Follow the [registry publishing guide](https://github.com/EclipseFdn/open-vsx.org/wiki/Publishing-Extensions).
Never put the token in workflow inputs or the command line. Missing credentials,
failed source checks, an expired artifact or an already-published version fail
the job; they do not silently skip publication. This workflow publishes only the
beta channel. Review the printed version and SHA256 in the job log, then verify
the listing in Open VSX. Until that succeeds, issue #29 remains pending.
