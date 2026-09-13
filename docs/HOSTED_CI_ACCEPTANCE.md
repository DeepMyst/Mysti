# Hosted CI and required checks

## Remote inspection: 2026-09-12

Read-only GitHub API requests at 14:35 UTC established:

- `DeepMyst/Mysti` is public, with default branch `main` at
  `6d709229b5199f6769fb3cf763e5122dcc43c079`. GitHub Actions is enabled.
- The locally tested candidate `4b59960101983a23502abf9af4b688b8610f935f`
  and its `codex/mysti-restricted-provider-modes-2026-09-11` branch are absent
  remotely. The exact-SHA Actions query returned zero runs.
- `main` reports `protected: false`; its branch-protection endpoint returns
  `404 Branch not protected`; the effective-rules endpoint returns `[]`.
  These results came from an account with repository administration access.
- The sole ruleset, `19333223` (Code Quality Copilot review for default branch),
  is disabled. It contains no required CI checks.
- The registered remote workflows are dynamic CodeQL workflows. The latest
  [successful run](https://github.com/DeepMyst/Mysti/actions/runs/34325617993)
  tests the old `main` commit and does not validate this candidate.

Raw responses are retained locally under
`out-test/release-evidence/hosted-ci-20260912/`. No push, workflow dispatch,
merge, publication or repository-rule mutation was performed by this inspection.

## Authorized publication and remediation: 2026-09-13

The user authorized publishing `codex/mysti-hosted-ci-review-2026-09-12` and
activating the prepared rule after all 15 checks pass on the exact candidate.
The branch is published. Rule activation remains conditional on that evidence.

The first hosted run found an invalid job-level `runner.temp` expression; the
value now resolves in the installed-editor step. Windows checkout line endings
also changed integrity hashes, so tracked text now uses LF on every platform.
Playwright is pinned to 1.60.0 and the editor CDP connection uses `noDefaults`
to support the minimum editor's older browser protocol.

The [source editor matrix at 239a24f](https://github.com/DeepMyst/Mysti/actions/runs/34748373724)
passed all four Linux/macOS/Windows stable and Linux minimum-editor jobs. The
[matching CI run](https://github.com/DeepMyst/Mysti/actions/runs/34748373736)
passed all three build gates, lint and the minimum bundled runtime, but failed
unit/browser tests. These partial results do not satisfy the required rule.

The follow-up corrects Windows fixture paths and process cleanup, plus a real
workspace-alias bug in local approval paths. New-file targets also retain their
resolved parent path for secret and instruction-file checks. CI uses two unit
test workers and runs the Canvas timing suite separately so concurrent browsers
do not compete with its frame-time measurements. All performance assertions
remain blocking with their original thresholds. The next push must validate
these changes and produce its own package and installed-editor results.

## Candidate checks

Both workflows run on pushes and pull requests. A push run tests the pushed
commit; a pull-request run normally tests GitHub's synthetic merge commit.
Keep their results and commit identities distinct. Removing integration's former
`main`-only push filter lets all four source editor jobs test the exact candidate
before a merge. The PR runs continue to test its integration with the base branch.
See [GitHub's event semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request).

The prepared [repository ruleset](../.github/mysti-required-ci.ruleset.json)
requires these 15 unique contexts, all from GitHub Actions (app ID `15368`,
verified with `GET /apps/github-actions`):

| Workflow | Required contexts | Count |
| --- | --- | --- |
| CI | `gates (ubuntu-latest)`, `gates (macos-latest)`, `gates (windows-latest)` | 3 |
| CI | `test (ubuntu-latest)`, `test (macos-latest)`, `test (windows-latest)` | 3 |
| CI | `lint`, `bundled runtime (Node 18.17.1)`, `package shape` | 3 |
| CI | `packaged VS Code (1.86.0)`, `packaged VS Code (stable)` | 2 |
| integration | `VS Code host (ubuntu-latest, stable)`, `VS Code host (macos-latest, stable)`, `VS Code host (windows-latest, stable)`, `VS Code host (ubuntu-latest, 1.86.0)` | 4 |

The rule applies only to `refs/heads/main`, requires checks against the latest
base for pull requests, and declares no bypass actors. It adds only a required
status-check rule; separate review, deletion and force-push policies are outside
this proposal. Committing the JSON does not activate a GitHub rule. Its format
follows the [repository ruleset API](https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset).
When job names or matrix entries change, update both this file and the active
required-check configuration so merges do not wait for obsolete check names.

Local validation parsed both workflow files, expanded their matrices and matched
all 15 unique names against the proposed rule. The initial review verified the integration push-filter change. Subsequent
hosted remediation is recorded above; job dependencies, blocking failures and
permissions are preserved. `git diff --check`
passed. The optional actionlint binary could not be downloaded because the
release-asset host failed TLS certificate verification; actionlint and hosted
execution are not claimed as passed.

## Completing this gate

1. After publication is authorized, push the prepared candidate branch. Record
   its full SHA. Wait for both workflows on that exact push and inspect all 15
   job conclusions. Require successful completion; missing, cancelled, skipped
   or neutral jobs do not count as release acceptance. Fix failures and repeat
   on the new SHA. Review the PR merge-commit runs as well if a PR is opened.
2. Record each run URL, attempt, event and tested SHA. Keep the `mysti-vsix`
   artifact from that CI run and its SHA-256 with the two installed-editor
   results. Those jobs download the same archive and do not rebuild it.
   The existing local 0.5.2 archive and its manifest remain evidence for
   `4b59960`; a hosted rebuild is a separate artifact with its own hash.
3. Once all contexts have been observed passing and repository-rule changes
   are authorized, re-read the current rules and check names before applying
   `.github/mysti-required-ci.ruleset.json`. Reconcile any concurrent rule
   changes; do not overwrite or duplicate an existing rule blindly. Creating
   the reviewed rule uses `POST /repos/DeepMyst/Mysti/rulesets` with that file
   as the JSON body. No application command runs from a workflow.
4. Read back the created ruleset and `GET /repos/DeepMyst/Mysti/rules/branches/main`.
   Verify active enforcement, the exact 15 contexts, app IDs, strict status
   policy and empty bypass list. Save those responses before closing this gate.

The minimum macOS editor startup crash and account-backed provider acceptance
remain separate gates in [external acceptance](EXTERNAL_RELEASE_ACCEPTANCE.md).
