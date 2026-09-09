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
| Extract coordinator run orchestration | A run owns its abort signal, budget and delegates; it executes without constructing the UI provider; Stop/timeout/consumer-abandonment tests prove cleanup. |
| Extract Canvas host integration | Canvas session ownership, tool dispatch and view lifecycle have narrow ports; all browser and real-editor Canvas tests continue to pass. |
| Split the chat renderer | Feature modules share an explicit message/state contract; existing UI behavior and CSP remain covered by browser tests. |
| Consolidate remaining interaction state | Questions, permissions and continuation timers have explicit panel/run owners; closing one panel cannot settle or cancel another panel's work. |
| Validate native provider contracts | Versioned fixtures and live smoke results cover every advertised capability, especially approval timing and process termination. |
| Strengthen persistence evolution | Migration fixtures cover supported old schemas, partial/corrupt writes and downgrade preservation; backups can actually be restored. |

Keep these criteria current as work lands. Avoid broad rewrites that change
transport behavior, persistence and UI state simultaneously.
