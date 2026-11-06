# Maintaining the documentation

Keep the task guides accurate, findable and usable without reading the source.
The [documentation index](README.md) is the human entry point; generated files
make the same material easier to discover and check programmatically.

## Where each kind of information belongs

| Information | Canonical location |
| --- | --- |
| Product introduction and install actions | [Root README](../README.md) |
| A task with prerequisites, actions and expected outcomes | [Walkthroughs](walkthroughs/README.md) |
| Diagnosing a failure | [Troubleshooting](TROUBLESHOOTING.md) |
| Storage, backup and safe recovery | [Backup and recovery](BACKUP-AND-RECOVERY.md) |
| Local/remote data and credential controls | [Privacy](PRIVACY.md) |
| Contributed settings and commands | `package.json` plus `package.nls.json`; generated references |
| Current validation and outstanding acceptance | [Production readiness](PRODUCTION_READINESS.md) |
| A past artifact's evidence | Its release directory; preserve its version and scope |
| Agent repository guidance | [AGENTS.md](../AGENTS.md); `CLAUDE.md` points there |
| Discovery metadata | [navigation.json](navigation.json); generates [llms.txt](../llms.txt) |

## Update and check

1. Inspect the implementation and relevant tests before changing a behavior claim.
   Distinguish a visible control, an active host path and verified native behavior.
2. Update the task guide. Include the starting state, exact visible actions,
   expected result, limits and a route back when the task fails.
3. Add or update its entry in `docs/navigation.json`. Keep titles, search topics,
   audience and current/historical status accurate.
4. Run `npm run docs:generate` after manifest, English localization or navigation
   changes. Review the generated diff; never add user credentials or machine state.
5. Run `npm run check:docs`. It checks generated freshness, catalog coverage,
   local links/anchors and documented settings-table identifiers/defaults.
6. Inspect changed pages as rendered Markdown, including narrow layouts, image
   alternatives and diagrams. Follow the relevant walkthrough in the supported
   environment before calling it verified. Source review and sample captures
   must stay labelled as such.

The documentation check runs in CI. It performs no external network requests,
paid-provider calls or link crawling. It does not prove that a provider accepts a
model, that a screenshot is current, or that a how-to works in every environment.
External links and actual native-video playback still need deliberate review.

## Visual walkthroughs

Use real interface screenshots and a short focused video where they clarify the
action. Preserve sample-data labels. Prefer a small Mermaid diagram for order,
branching or data flow; keep the instructions understandable as text as well.
Provide descriptive alt text and captions, and avoid screenshots containing
private workspaces, accounts or credentials. Follow the [media guide](media/README.md)
for native GitHub players and source provenance.

Inspect diagrams on GitHub at narrow widths as well as in a local preview.
GitHub's pan and zoom controls can cover a bottom corner; keep meaningful labels
clear of those controls and confirm that the diagram remains readable.

## Discovery files

[AGENTS.md](https://agents.md/) provides repository working guidance.
[llms.txt](https://llmstxt.org/) is a proposed convention for a compact Markdown
discovery index. Our file links directly to raw Markdown; it does not duplicate
all guides into one large context dump. `docs/navigation.json` is the structured
equivalent and includes topics and intended audiences.

These files help tools that read them; they do not guarantee search ranking,
automatic crawling or support in every agent. They are public documentation,
not authorization to run a command, publish an artifact or access an account.
