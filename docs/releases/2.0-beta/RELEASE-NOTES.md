# Mysti 2.0 BETA

Package version: **2.0.0** · Channel: **pre-release** · Status: **release candidate prepared in this checkout; Marketplace publication is separate**.

Mysti 2.0 BETA brings agent assignments, a visual workspace, and connected project context into one VS Code extension. This release includes the accumulated 0.5.2 work and corrects how explicit multi-agent requests are dispatched and displayed.

## Agent assignments that honor your request

Previously, an AI-generated mention plan could fold work into the selected provider, and a one-subagent shortcut could omit that selected provider's assigned task. The result could look like Codex speaking about Claude instead of both agents responding.

Now explicit tags create host-owned assignments. A question for `@claude @codex` starts both read-only providers concurrently, within the configured limit. Each result is separately attributed and saved. There is no extra selected-provider synthesis pass that can invent a missing opinion.

Explicit `then` handoffs pass the completed result to the next agent. Potential file writers remain serial. Missing credentials, failures and blocked dependencies stay visible. Native approval and cancellation continue through the shared collaborator pool.

## Visible collaboration

New live assignment cards render provider identity, progress, output, tool activity, retries and failures. Role-based collaboration events that previously had no chat renderer now appear. Cards are scoped by run and participant so repeated agents and late chunks do not overwrite another response.

## Included from the accumulated release

- Consistent model/effort/Ultracode controls where supported, action and slash menus, provider setup/upgrade handling, and dictation through the editor's speech support.
- Canvas, visual testing, agent catalog, personas and skills, conversation history, checkpoints, and context compaction.
- Mysti's DeepMyst-backed coordinator and Proactive inbox: local Git watches, explicitly selected GitHub/Slack responsibilities, bounded scan progress, retry delays, and a source-backed Before you start view.
- Cross-platform build, browser, native editor and verified-VSIX checks introduced with the preceding release.

## Upgrade and beta scope

Install the reviewed 2.0.0 VSIX or select the Marketplace pre-release channel after publication, then reload VS Code. This release introduces no new conversation storage migration or backend migration. Existing agent credentials and provider setup remain separate from installing Mysti.

Known limits:

- The new routing checks use deterministic provider fixtures. They do not certify every authenticated CLI/account combination on every OS.
- Scheduling recognizes explicit tags and a conservative set of dependency/advisory phrases. It is not a general natural-language workflow planner.
- Composer attachments are not forwarded in explicit collaborator runs; use Context or `@file`.
- Proactive cloud coverage remains bounded. Slack threads and full edit/deletion reconciliation are not complete; mobile/phone delivery and autonomous offload remain future work.
- Dictation availability depends on the editor and OS. External actions cannot be undone by workspace checkpoints.
- Existing backend CI/security debt is tracked separately from this extension release; do not interpret extension checks as backend certification.

## Release materials

The README now has a concise value proposition, workflow comparison, current setup paths, a routing visualization, and recorded UI walkthroughs. [Media and reproduction instructions](README.md) identify sample data explicitly. [Validation](VALIDATION.md) records what was tested for this candidate.

## Publishing

VS Code Marketplace versions use numeric `major.minor.patch`; beta status is applied with the pre-release channel, not a `-beta` suffix. This candidate uses **2.0.0 + `--pre-release`**. A later stable release must have a greater version (for example 2.0.1); do not attempt to reuse 2.0.0 as a stable artifact. Microsoft's odd-minor prerelease convention is a recommendation; the channel flag is the actual release metadata. [Official publishing guidance](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#prerelease-extensions).

Require passing checks for the exact reviewed commit before publishing. Package with `npm run package:pre-release -- --out mysti-2.0.0-beta.vsix`; inspect it with `npm run check:package -- mysti-2.0.0-beta.vsix`. Publish the reviewed VSIX and verify its Marketplace page, links, pre-release label and installation. See [maintenance](../../MAINTENANCE.md).
