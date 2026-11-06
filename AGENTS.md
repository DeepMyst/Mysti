# Working on Mysti

Mysti is a VS Code extension with a host bundle, chat webview, Canvas webview,
16 provider adapters and a separate Mysti coordinator. It remains beta.

## Find the right document first

- [Documentation map](docs/README.md): choose a guide by task.
- [Machine-readable map](docs/navigation.json): paths, topics, audience and status.
- [Plain-text discovery index](llms.txt): links to raw Markdown for remote readers.
- [Architecture](docs/ARCHITECTURE.md) and [developer notes](docs/DEVELOPER-NOTES.md): implementation boundaries.
- [Production readiness](docs/PRODUCTION_READINESS.md): actual evidence, outstanding work and release checklist.

Read the smallest relevant guide, then inspect its source references. `package.json`
defines contributed settings and commands; the provider registry and capability
contracts define current adapters. Plans and old release reports describe their
recorded scope, not proof of current behavior. Never infer native-provider
acceptance from a sample-data recording or an installed CLI.

## Development and validation

Use the Node version in `.nvmrc` and `npm ci`. Do not upgrade dependencies as a
workaround for a failed locked install. Start `npm run watch` before pressing F5.

| Change | Relevant checks |
| --- | --- |
| Documentation | `npm run check:docs`; inspect rendered visuals and affected walkthroughs |
| Settings or commands | `npm run docs:generate`, review the generated diff, then `npm run check:docs` |
| Application behavior | Focused regressions, `npm run typecheck`, `npm run lint`, and affected release test phases |
| Release or packaged behavior | Complete [maintenance](docs/MAINTENANCE.md) and [release checklist](docs/PRODUCTION_READINESS.md#checklist-for-every-updated-version) |

Release test phases are `test:release:unit`, `test:release:browser` and
`test:release:performance`, in that order. Browser phases need the locked
Playwright Chromium (`npm exec --no -- playwright install chromium`). Keep them
separate from recording workloads. Preserve failures and skips; do not weaken
assertions, increase deadlines or add retries just to obtain a green run.

## Preserve the important boundaries

- Keep unrelated work intact. Inspect `git status` before edits and stage only the task's files.
- Bind state, permissions, async completions and cleanup to the owning panel/run.
- A streamed tool notification is not a blocking native approval. Follow [approval contracts](docs/NATIVE_APPROVAL.md).
- Workspace settings may lower authority; they must not widen machine/user policy. Preserve default-off capability gates and untrusted-result fencing.
- Read the relevant provider source before changing CLI arguments, process cleanup, credentials or usage attribution.
- Use [CONTRIBUTING.md](CONTRIBUTING.md) for provider integration and [security policy](.github/SECURITY.md) for vulnerability reporting.
- Publish the qualified artifact with its source identity and checksum. GitHub release, Marketplace and Open VSX publication are separate states.

## Keep documentation discoverable

Update the task guide and `docs/navigation.json` when adding a documented surface.
Use meaningful headings, relative repository links, text alternatives for visuals,
and explicit prerequisites, outcomes and limitations. Generated references come
from the manifest; edit their generator or source rather than hand-editing output.
See [documentation maintenance](docs/DOCS-MAINTENANCE.md).
