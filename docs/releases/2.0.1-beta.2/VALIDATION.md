# Beta 2 validation

Validation date: **2026-11-05**, Asia/Amman. Package **2.0.1**, pre-release.

This report records the scope of the release checks. Whole-feature acceptance is
tracked in [production readiness](../../PRODUCTION_READINESS.md) and the detailed
[feature ledger](../../../plans/48-feature-test-status.md).

## OpenCode Stop regression

The native macOS fixture uses the real OpenCode CLI with an isolated workspace,
isolated configuration and a scripted loopback model endpoint. It makes no paid
inference request. Its positive control completes a delayed file write; its
cancellation case starts a shell and child in a separate process group.

- Both verified descendants exited **48 ms after Stop** in the observed run.
- The delayed write remained absent through the **12.5-second** observation.
- The fixture did not need emergency descendant cleanup.
- A follow-up request resumed the conversation and returned text, completion and
  usage events. All three native invocations and owned connections closed.
- **366 focused tests across 36 files** passed, including detached descendants
  that ignore graceful termination and an unaffected replacement process.

These timings describe one observed run, not a performance guarantee. The test
does not establish Windows/Linux native behavior, real model inference or
endurance. A process snapshot cannot provide a kernel-level guarantee against
arbitrary processes deliberately changing identity or ownership.

## Initial release checks and corrections

The first broad run passed **16,654 tests** but failed two background-job tests
because their prototype-based host fixture omitted the extension's workspace
state. The fixture now supplies that dependency; all six tests in the affected
suite pass with their behavior assertions unchanged.

The same run failed browser-suite collection because the pinned Chromium build
was absent. Chromium was installed and browser coverage is required for the
final broad run. These infrastructure/fixture failures are retained in the local
release logs rather than counted as successful checks.

The fresh audit identified newly reported dependency advisories. Patched runtime
dependencies and regenerated browser assets must be covered by the final build,
sanitization tests, minimum-runtime check and packaged-editor tests. Development
exceptions remain documented in [maintenance](../../MAINTENANCE.md).

## Release qualification

The final local source/browser qualification uses the same explicit phases as CI:

| Check | Result |
| --- | --- |
| Clean locked install | Passed with Node 22.23.3. |
| TypeScript | Passed. |
| Lint | Zero errors; 514 warnings retained as maintenance debt. |
| Unit and integration phase | **16,836 tests / 625 files passed**, no failures or skips. |
| Browser phase, serial | **949 tests / 50 files passed**, no failures or skips. |
| Isolated Canvas performance | **3 tests / 1 file passed**. |
| Total automated behavior checks | **17,788 tests / 676 files passed**. |
| Vendor integrity and rendering | Passed; chat sanitizer and Mermaid are rebuilt and verified together. |
| Runtime npm audit | **Zero advisories**. The full development graph has 16 reported entries, covered by the documented exceptions. |
| Minimum embedded runtime | Passed under **Node 18.17.1**, including Canvas parse/edit/undo and an MCP client/server tool exchange. |
| Packaged editor, macOS arm64 | **11 tests passed** in VS Code **1.145.0**, using an extracted VSIX and a fresh isolated profile. No account-backed provider tests were enabled. |
| Production build and VSIX shape | Passed. Required runtime dependencies and walkthroughs are present; marketing media, test sources and source maps are excluded. |
| Feature-plan traceability | All **130 cases**, 35 commands, 199 settings and 142 chat actions accounted for. This check does not execute feature acceptance. |

The original combined run also exposed contention at browser action/setup and
native-child deadlines, plus new suites that did not follow the repository's
optional-browser skip convention. Those suites now use the existing explicit
skip declarations; release runs still require Chromium and fail if it is absent.
The two transient-permission tests separate page boot from their unchanged
five-second behavior budget and control the browser clock during observation.
Release CI now runs unit/integration, browser and performance phases separately,
with bounded worker counts and no blanket retries or relaxed behavior deadlines.
All final phases passed. The first packaged-editor collection also exposed eager
imports in opt-in campaign tests: 95 campaign/oracle imports now sit inside their
existing environment guards across 34 files. A 102-case collection probe confirms
disabled campaigns perform no private evidence reads or native execution; enabled
campaigns retain their imports and checks. The corrected packaged editor run
passed all 11 tests. Earlier failed runs remain retained in the local logs.

### Artifact identity and hosted checks

The [published GitHub release](https://github.com/DeepMyst/Mysti/releases/tag/v2.0.1-beta.2)
is the canonical record of the exact source commit, successful hosted CI and
editor runs, VSIX SHA-256 and registry publication status. Its `SHA256SUMS.txt`
applies to the attached artifact. Publication uses the downloaded CI artifact
that passed the packaged-editor jobs; it is not rebuilt after qualification.

Required hosted checks include Linux, macOS and Windows source/test gates,
minimum-runtime validation, lint, package shape, editor integration and the
packaged extension in VS Code 1.86/current stable. A local macOS run alone does
not satisfy that matrix. Registry publication is separate from GitHub; no
Marketplace or Open VSX publication is implied by these local checks.

## Recordings

The [feature gallery](../../DEMO_GALLERY.md) identifies fixture responses and
reproduction commands. UI footage is separate from native-provider validation;
it does not establish backend availability, OAuth completion or model quality.
