# Maintaining and releasing Mysti

## Reproducible development

Use the Node version in `.nvmrc`, then `npm ci`. `package-lock.json` is committed;
dependency changes must update it in the same change as `package.json`. Do not
use a fresh dependency resolution as a workaround for a failing clean install.

Most unit tests use a VS Code mock and recorded provider data. They need no model
credentials. Browser suites use the installed Playwright version and Chromium:

```sh
npx playwright install chromium
npm run typecheck
npm run lint
npm test
npm run check:vendor
npm run compile:release
```

CI requires browser availability, so a missing browser fails rather than silently
removing coverage. Local test runs may skip browser tests when Chromium is not
available; report those skips. On Linux CI, install Chromium with `--with-deps`.

`compile:release` checks the committed core-agent integrity manifest before
building. `compile` and `watch` regenerate it for development. Regenerate and
review the manifest only when intentionally changing bundled core agents; do
not use write mode to make an unexplained integrity failure disappear.

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
| Installed VSIX on Linux, minimum and stable VS Code | The archive produced by the package gate activates, resolves its shipped Playwright dependency and mounts an interactive Canvas frame. |
| Minimum embedded runtime | A production fixture compiles/edits Canvas JSX and exchanges MCP tool messages on Node 18.17.1, independently of newer development Node. The fixture rejects execution on a different Node version. |

`npm run test:vscode` builds the release bundles and opens a fresh editor profile.
Its loopback Ollama fixture starts before editor activation, avoiding a negative
startup availability probe. Chat checks exercise streaming, Stop after token one,
history restoration, concurrent panels and recovery from HTTP errors. The driver
focuses the native webview before composing so macOS click-to-activate does not
consume the Send click. The suite never needs a model account.
The Canvas test inspects the editor's actual nested webview through a loopback
debugging connection. It uses Zoom In to reach interactive scale before checking
visible content and editing an input inside the sandboxed artboard; a narrow
editor can legitimately fit a page below the live-frame zoom threshold. The
persistence test closes the Canvas tab and waits for disposal before reopening
the saved design. Profiles use fresh OS temporary directories to avoid Unix
socket path limits in deep checkouts; the runner prints their paths, and failure
screenshots remain with the profile for diagnosis.

Set `MYSTI_TEST_VSIX_PATH` to a built archive to run the same suite against its
installed extension. An inert driver starts the editor's test runner while Mysti
loads from the VSIX; the suite checks that Playwright resolves inside the
installed package before activating it. Keep the archive's identity with the
result. This exercises packaged startup and Canvas, not authenticated providers.

CI's `packaged VS Code (1.86.0)` and `packaged VS Code (stable)` jobs download the
same verified archive from `package shape`; neither job packages or rebuilds
the extension. Both fail the workflow on a test failure. Keep both status checks
required in branch protection alongside the existing source integration matrix.
The packaged jobs also upload Canvas screenshots for review.

Tests must assert behavior rather than elapsed speed on shared CI machines. Use
fake clocks for deadlines, cancellation and delayed callbacks. Preserve exhaustive
parser checks but partition expensive inputs into independent cases. Benchmark
speed separately before making a performance claim.

The Vitest suite caps concurrent test files at four because native CLI and
Chromium fixtures also launch child processes. This prevents CPU oversubscription
from consuming native startup deadlines on developer machines. Individual test
deadlines and assertions remain unchanged; the cap is not a retry policy.

Warnings remain useful debt signals. Do not suppress lint errors, make a failing
job advisory, or add retries to get a green result. Fix the cause or document an
explicitly bounded follow-up with evidence.

The OpenClaw adapter has a separate [transport contract](OPENCLAW_TRANSPORT.md)
covering run identity, cancellation, CLI prompt delivery and remaining approval
limitations. Its local transport fixtures do not replace live provider checks.

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

Local limitation recorded on 2026-09-09: the VS Code 1.86.0 arm64 GUI exited with
SIGTRAP on macOS 15.6 before its integration runner started. The failure also
occurred in a standalone launch with extensions disabled and a fresh profile,
including after removing inherited `VSCODE_*` environment variables. Running
the executable as Node reported Node 18.17.1 and Electron 27.2.3; that confirms
runtime identity, not a successful editor integration run. The minimum-host
Linux CI gate remains required. A current-editor pass does not resolve this
local crash or establish minimum-host compatibility.

To reproduce the runtime-only gate, build with the development Node:
`node scripts/build-runtime-fixture.js`. Then run
`node out-test/runtime/minimum.cjs` with Node 18.17.1. It bundles its dependencies
with the production webpack configuration and rejects non-builtin externals, so
the old runtime cannot silently load the newer development dependency graph.
This covers the exercised bundled paths; it does not load the shipped extension
bundle, activate the editor, or test Mysti's MCP stdio/HTTP transports. Real-editor
integration remains a separate requirement. In particular, Babel 8 declares newer upstream Node
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

### Dependency audit evidence and exceptions (2026-09-12)

The reconciled lock installs cleanly with Node 22.20.0 and npm 10.9.3. The
full audit reports three development entries: `@vscode/test-cli`, `mocha` and
`serialize-javascript` (two moderate, one high). `npm audit --omit=dev` reports
zero. Re-run both audits when updating the graph; these counts are dated
evidence, not a permanent claim.

Vitest 4.1.11 fixes the [UI/API access advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp)
and [mock redirect traversal](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9).
The explicit Vite 7.3.6 dependency retains a patched supported peer major.
Webpack remains on major 5; its Terser plugin resolves to 5.6.1, which no longer
depends on the vulnerable serializer. The upstream [5.3.17 release](https://github.com/webpack/minimizer-webpack-plugin/releases/tag/v5.3.17)
removed that dependency from the release-build path. The reconciled lock
preserves MCP's previously reviewed AJV 8.20.0 and ajv-formats 3.0.1. Direct esbuild 0.28.2 declares the dependency already imported
by the browser fixtures instead of relying on Vite's transitive dependency.

The scoped `@typescript-eslint/typescript-estree` override replaces its exact
minimatch 9.0.3 pin with 9.0.9, retaining the major-9 API while fixing
[globstar](https://github.com/isaacs/minimatch/security/advisories/GHSA-7r86-cg39-jmmj)
and [extglob backtracking](https://github.com/isaacs/minimatch/security/advisories/GHSA-23c5-xmqv-rm74).
A real TypeScript parser fixture passed glob-based project discovery and typed
program creation with this resolved version. Dependency maintainers own the
override; remove it when the supported parser dependency resolves a patched
minimatch without it, and repeat typed-project discovery plus the lint checks.

The test CLI runs under development Node, but its Mocha runner executes inside
the editor. Mocha 10.8.2 supports the minimum editor's Node 18.17.1; Mocha 11
requires at least 18.18 and Mocha 12 requires a newer major runtime. The
`@vscode/test-cli` override keeps its in-editor Mocha aligned with the direct
dependency. Its diff 5.2.2 uses the patched backport, removing the previous
diff exception. Recheck this override when either package or the minimum editor
changes. Do not raise the production editor minimum solely to update a test tool.

The current residual audit chain is development-only:
`@vscode/test-cli → mocha → serialize-javascript@6.0.2`. The serializer has
[crafted-object code execution](https://github.com/advisories/GHSA-5c6j-r48x-rmvq)
and [CPU exhaustion](https://github.com/advisories/GHSA-qj8w-gfj5-8c6v) advisories.
Mocha loads it in its optional parallel worker pool. Our editor tests explicitly
run serially, and none of these packages ships in the VSIX. The release maintainer
owns this exception: keep parallel execution disabled and remove the exception
when a compatible patched serializer is available or the runner is replaced.
The registry still has no patched 6.x release; current serializer 7.1.1 requires
Node 20, so overriding it into the minimum editor would
violate its declared runtime support.

The 2026-09-12 source/media lint pass has zero errors and zero warnings, without
relaxing rules. Missing braces and duplicate function-scoped declarations were
corrected; unreachable helpers, unused state and stale parameters were removed.
The release build retains three webpack performance warnings for the 347 KiB
Canvas entry point (recommended threshold: 244 KiB). The release maintainer owns
this performance follow-up: measure editor startup and split a cohesive optional
feature with real-editor/CSP coverage before removing the exception. Do not hide
the warnings or raise the threshold merely to make the log green. VSCE's file
count warning includes the deliberately external Playwright runtime; package
shape and installed-package resolution remain required.

Source Node declarations still target Node 20. The old 18.17 declarations conflict
with current TypeScript Buffer definitions and omit the fetch globals used here;
a direct downgrade is not sufficient. They can therefore admit APIs missing in
the minimum editor. Minimum-runtime and real-editor checks remain required; a
separate compatible type-check project is follow-up work.

### Vendored browser assets

An npm update does not patch a JavaScript file copied into `resources/`. Inspect
the shipped asset and its nested libraries as well as the dependency audit.
`NOTICE` records vendored versions and attribution.

Mermaid is built from the locked npm graph with the same patched DOMPurify used
by chat. The upstream prebuilt Mermaid bundle has its own sanitizer; copying it
would bypass that pin. After changing a bundled input, run:

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

Prism retains the existing language grammars with the patched 1.30.0 core. Keep
its mixed-version provenance explicit when updating it. The other standalone
browser assets must also be checked and updated independently of npm resolution.

## Release checklist

1. Select the exact commit, set the version and update release notes. Keep feature
   claims tied to reachable behavior and distinguish experimental integrations.
2. Require green CI and real-editor integration for that commit on all supported
   platforms. Repository branch protection must require the relevant status checks;
   workflow YAML alone cannot prevent an administrator from merging a red branch.
3. Run `npm run package`, then
   `node scripts/check-package-shape.js mysti-<version>.vsix`. Check the built archive,
   not only a listing of the working directory.
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
| Extract coordinator run orchestration | Model streams live in `CoordinatorTurnRunner`; `CoordinatorRunBudget` now owns immutable settings snapshots, separate tool/delegation counters and batch reservations. Permission and tool dispatch still need a separate run service. |
| Extract Canvas host integration | Canvas session ownership, tool dispatch and view lifecycle have narrow ports; all browser and real-editor Canvas tests continue to pass. |
| Split the chat renderer | Markdown/diagrams and sub-agent cards are extracted behind explicit ports with browser/CSP coverage. Continue with cohesive message/timeline features while preserving the existing state contract. |
| Consolidate remaining interaction state | Questions, native approval cards, pending plans and queued continuations have explicit owners. Move remaining host-owned interaction lifecycles into independently testable services as they change. |
| Validate native provider contracts | Hermes/Kimi have blocking ACP approval paths with transport and host tests. Remaining adapters need equivalent native enforcement and recorded live smoke results for approval timing and process termination. |
| Strengthen persistence evolution | Migration and corruption fixtures, ordered journal mutations, and backup restore failure paths pass. See [recovery and downgrade guidance](PERSISTENCE_RECOVERY.md); real-profile downgrade acceptance remains open. |

Keep these criteria current as work lands. Avoid broad rewrites that change
transport behavior, persistence and UI state simultaneously.
