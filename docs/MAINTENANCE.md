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
| Minimum embedded runtime | A production fixture compiles/edits Canvas JSX and exchanges MCP tool messages on Node 18.17.1, independently of newer development Node. The fixture rejects execution on a different Node version. |

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

### Editor test runtime and audit exception

The test CLI runs under development Node, but its Mocha runner executes inside
the editor. Mocha 10.8.2 supports the minimum editor's Node 18.17.1; Mocha 11
requires at least 18.18 and Mocha 12 requires a newer major runtime. The
`@vscode/test-cli` override keeps its in-editor Mocha aligned with the direct
dependency. Recheck this override when either package or the minimum editor
changes. Do not raise the production editor minimum solely to update a test tool.

The current residual audit chain is development-only:
`@vscode/test-cli → mocha → serialize-javascript@6.0.2`. The serializer has
[crafted-object code execution](https://github.com/advisories/GHSA-5c6j-r48x-rmvq)
and [CPU exhaustion](https://github.com/advisories/GHSA-qj8w-gfj5-8c6v) advisories.
Mocha loads it in its optional parallel worker pool. Our editor tests explicitly
run serially, and none of these packages ships in the VSIX. The release maintainer
owns this exception: keep parallel execution disabled and remove the exception
when a compatible patched serializer is available or the runner is replaced.
Serializer 7.0.5 requires Node 20, so overriding it into the minimum editor would
violate its declared runtime support.

The estree-only `minimatch` override updates its pinned vulnerable 9.0.3 to a
patched 9.0.x release without downgrading typescript-eslint. Remove that override
when an upgraded parser resolves a patched version itself.

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
| Extract coordinator run orchestration | Model stream orchestration now lives in `CoordinatorTurnRunner` with explicit ports and abandonment tests; permission/tool dispatch and whole-run budgets still need a separate run service. |
| Extract Canvas host integration | Canvas session ownership, tool dispatch and view lifecycle have narrow ports; all browser and real-editor Canvas tests continue to pass. |
| Split the chat renderer | Markdown/diagrams and sub-agent cards are extracted behind explicit ports with browser/CSP coverage. Continue with cohesive message/timeline features while preserving the existing state contract. |
| Consolidate remaining interaction state | Questions, native approval cards, pending plans and queued continuations have explicit owners. Move remaining host-owned interaction lifecycles into independently testable services as they change. |
| Validate native provider contracts | Hermes/Kimi have blocking ACP approval paths with transport and host tests. Remaining adapters need equivalent native enforcement and recorded live smoke results for approval timing and process termination. |
| Strengthen persistence evolution | Migration fixtures cover supported old schemas, partial/corrupt writes and downgrade preservation; backups can actually be restored. |

Keep these criteria current as work lands. Avoid broad rewrites that change
transport behavior, persistence and UI state simultaneously.
