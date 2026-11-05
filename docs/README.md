# Mysti documentation

Find the shortest route from your task to a useful result. These guides describe
the **2.0.1 Beta 2** source line; provider accounts and external services can have
additional requirements. [Verified status and remaining work](PRODUCTION_READINESS.md).

## Start here

| I want to… | Read |
| --- | --- |
| Install Mysti and send my first message | [Getting started](GETTING-STARTED.md) |
| Connect or choose an agent | [Provider setup and compatibility](PROVIDERS.md) |
| Follow a visual, practical example | [Walkthroughs](walkthroughs/README.md) |
| Fix a problem | [Troubleshooting](TROUBLESHOOTING.md) |
| Back up, upgrade or recover my work | [Backup and recovery](BACKUP-AND-RECOVERY.md) |
| Understand data, credentials and telemetry | [Privacy and data controls](PRIVACY.md) |

## Learn by doing

| Outcome | Walkthrough | Preview |
| --- | --- | --- |
| Compare two answers or hand work to a reviewer | [Multi-agent workflows](walkthroughs/multi-agent-workflows.md) | [Watch](DEMO_GALLERY.md#agent-workflow) |
| Create and inspect a visual design | [Canvas](walkthroughs/canvas.md) | [Watch](DEMO_GALLERY.md#canvas-design) |
| Inspect a running local app and its report | [Visual Test](walkthroughs/visual-test.md) | [Watch](DEMO_GALLERY.md#visual-test) |
| Reopen, branch, export or rewind work | [History and checkpoints](walkthroughs/history-and-checkpoints.md) | [Watch](DEMO_GALLERY.md#history-and-rewind) |

Each walkthrough pairs numbered actions with expected results, screenshots or a
diagram, and recovery guidance. The [demo gallery](DEMO_GALLERY.md) contains the
complete tour and 15 focused clips. Sample-data media explains the interface;
native-provider evidence is recorded separately.

## Look up a feature or control

- [Feature guide](FEATURES.md): chat, context, permissions and controls.
- [Agent assignments and mentions](MENTIONS.md): tags, roles and ordering.
- [Brainstorm](BRAINSTORM.md): strategies and synthesis.
- [Personas and skills](PERSONAS-AND-SKILLS.md): reusable guidance.
- [Context compaction](COMPACTION.md) and [autonomous mode](AUTONOMOUS-MODE.md).
- [Proactive](PROACTIVE.md): local and connected watches.
- [Settings reference](SETTINGS.md): every contributed key and declared default.
- [Command reference](COMMANDS.md): command IDs, labels, shortcuts and visibility.
- [Approval contracts](NATIVE_APPROVAL.md): transport-specific permission boundaries.

## Build, support and release

- [Contributing](../CONTRIBUTING.md), [architecture](ARCHITECTURE.md) and [developer notes](DEVELOPER-NOTES.md).
- [Maintenance](MAINTENANCE.md) and the [portable release checklist](PRODUCTION_READINESS.md#checklist-for-every-updated-version).
- [Changelog](../CHANGELOG.md), [Beta 2 release notes](releases/2.0.1-beta.2/RELEASE-NOTES.md) and [release validation](releases/2.0.1-beta.2/VALIDATION.md).
- [Report a vulnerability](../.github/SECURITY.md) or [report a reproducible bug](https://github.com/DeepMyst/Mysti/issues/new/choose).
- [Maintain these guides](DOCS-MAINTENANCE.md) and [publish playable demos](media/README.md).

## For agents and LLM readers

Start with [llms.txt](../llms.txt) for a compact list of raw Markdown links, or
[navigation.json](navigation.json) for topic/audience routing. Repository coding
agents should read [AGENTS.md](../AGENTS.md). Fetch only the relevant guide, then
follow its source references when you need implementation detail.

The [settings JSON](reference/settings.json) and [commands JSON](reference/commands.json)
are generated from the manifest and English localization. They describe declared
interfaces, not account availability or completed acceptance testing. Current
source and readiness evidence take precedence over historical plans and demos.
