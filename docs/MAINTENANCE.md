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

`npm run test:vscode` builds the release bundles and opens a fresh editor profile.
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

Warnings remain useful debt signals. Do not suppress lint errors, make a failing
job advisory, or add retries to get a green result. Fix the cause or document an
explicitly bounded follow-up with evidence.

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

As a narrower check on that runtime, a production-webpack-config bundle of the
PageCompiler ran under Node 18.17.1: all five shipped scaffolds and five partial
scaffolds compiled, and an unsupported `process.env` expression was rejected.
This covers the exercised bundled parser subset despite its upstream package's
newer Node engine declaration; it does not replace full minimum-host validation.

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

### Dependency audit evidence and exceptions (2026-09-09)

The reviewed lock installs cleanly with Node 22.20.0 and npm 10.9.3. The full
audit decreased from 24 entries, including one critical, to four development
entries: `@vscode/test-cli`, `mocha`, `diff` and `serialize-javascript` (two low,
one moderate, one high). `npm audit --omit=dev` reports zero. Re-run both audits
when updating the graph; these counts are dated evidence, not a permanent claim.

Vitest 4.1.11 fixes the [UI/API access advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp)
and [mock redirect traversal](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9).
The explicit Vite 7.3.6 dependency retains a patched supported peer major.
Webpack remains on major 5; its Terser plugin resolves to 5.6.1, which no longer
depends on the vulnerable serializer. The upstream [5.3.17 release](https://github.com/webpack/minimizer-webpack-plugin/releases/tag/v5.3.17)
removed that dependency from the release-build path. The update also changes
MCP's resolved AJV from 8.18.0 to 8.20.0 and hoists its existing ajv-formats 3.0.1;
runtime direct versions are unchanged, but the resolved runtime graph changes.

The scoped `@typescript-eslint/typescript-estree` override replaces its exact
minimatch 9.0.3 pin with 9.0.9, retaining the major-9 API while fixing
[globstar](https://github.com/isaacs/minimatch/security/advisories/GHSA-7r86-cg39-jmmj)
and [extglob backtracking](https://github.com/isaacs/minimatch/security/advisories/GHSA-23c5-xmqv-rm74).
A real TypeScript parser fixture passed glob-based project discovery and typed
program creation with this resolved version. Dependency maintainers own the
override; remove it when the supported parser dependency resolves a patched
minimatch without it, and repeat typed-project discovery plus the lint checks.

The editor-test toolchain maintainers own these remaining exceptions:

- Mocha 11.8.0 retains serialize-javascript 6.0.2, affected by
  [RegExp/Date output injection](https://github.com/yahoo/serialize-javascript/security/advisories/GHSA-5c6j-r48x-rmvq)
  and [array-like CPU exhaustion](https://github.com/yahoo/serialize-javascript/security/advisories/GHSA-qj8w-gfj5-8c6v).
  Mocha uses it for parallel-worker options in
  `lib/nodejs/buffered-worker-pool.js`; `.vscode-test.mjs` does not enable parallel
  execution. The affected path is therefore not exercised by the current test
  configuration. Reassess before enabling parallel tests. Remove the exception
  when supported Mocha and test-cli versions adopt serializer 7.0.5 or later,
  with the real editor suite passing.
- Mocha's diff 7.0.0 has a [patch-parser denial of service](https://github.com/kpdecker/jsdiff/security/advisories/GHSA-73rr-hh4g-fpgx).
  The advisory affects `parsePatch` and `applyPatch(string)`; Mocha's reporter
  uses `createPatch` and display-diff methods. The affected parser is not used
  by this reporter. Remove the exception when supported Mocha/test-cli versions
  adopt a fixed diff release (for example 8.0.3 or later), with reporter and
  editor tests passing. Reassess before introducing patch parsing.

Neither remaining package is a production dependency. Mocha and test-cli audit
entries inherit these findings; they do not represent additional vulnerable
implementations. Do not force a major transitive override or downgrade test-cli
merely to remove audit entries; validate the affected toolchain first.

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
| Extract coordinator run orchestration | Model stream orchestration now lives in `CoordinatorTurnRunner` with explicit ports and abandonment tests; permission/tool dispatch and whole-run budgets still need a separate run service. |
| Extract Canvas host integration | Canvas session ownership, tool dispatch and view lifecycle have narrow ports; all browser and real-editor Canvas tests continue to pass. |
| Split the chat renderer | Markdown/diagrams and sub-agent cards are extracted behind explicit ports with browser/CSP coverage. Continue with cohesive message/timeline features while preserving the existing state contract. |
| Consolidate remaining interaction state | Questions, native approval cards, pending plans and queued continuations have explicit owners. Move remaining host-owned interaction lifecycles into independently testable services as they change. |
| Validate native provider contracts | Hermes/Kimi have blocking ACP approval paths with transport and host tests. Remaining adapters need equivalent native enforcement and recorded live smoke results for approval timing and process termination. |
| Strengthen persistence evolution | Migration fixtures cover supported old schemas, partial/corrupt writes and downgrade preservation; backups can actually be restored. |

Keep these criteria current as work lands. Avoid broad rewrites that change
transport behavior, persistence and UI state simultaneously.
