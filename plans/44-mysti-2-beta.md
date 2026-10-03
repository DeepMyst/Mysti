# Mysti 2.0 BETA: explicit assignments and release presentation

## User-visible problem

A request for Claude Code and Codex opinions could become a selected-provider answer about both tools. AI task generation could omit a named agent, partitioning folded the selected provider into a later pass, and a single-subagent shortcut could return before that pass. Role collaboration emitted host events without a corresponding chat transcript renderer.

## Implemented behavior

- Explicit tags create deterministic assignments before selected-agent routing. No model chooses which requested provider to omit.
- Independent advisory tasks fan out through the existing bounded pool. Writers serialize; explicit dependent handoffs receive completed prior output, and failed prerequisites block them.
- Live cards show participant identity, output, status, tool activity and failure. Conversation messages store participant metadata so a selected-provider model label cannot misattribute combined results.
- Cancellation, superseding sends, model isolation and per-run role metadata retain their own boundaries. Native permission enforcement remains in the shared pool.

## Release surface

Product release name: **Mysti 2.0 BETA**. Numeric extension version: **2.0.0**, packaged with `--pre-release`.

The README, getting-started and assignment guides, architecture, feature guide, CHANGELOG, contributing guide and versioned release notes describe the new behavior and beta limits. Community translations explicitly link the current canonical reference.

Three GIFs, screenshots, a hero, routing diagram and MP4 tour are reproducible with `npm run demo:record`. Fixture videos are labelled sample data. The native account-backed smoke is separately opt-in through `MYSTI_LIVE_MENTIONS=1`.

## Acceptance evidence

See [candidate validation](../docs/releases/2.0-beta/VALIDATION.md) for final counts and recorded limitations. Tests cover simultaneous start, selected-agent inclusion, distinct tasks and roles, dependencies, partial failures, write serialization, gate reuse, cancellation, live cards, safe rendering and attribution.

## Remaining product work

1. Make an explicit assignment preview editable before dispatch for complicated mixed prose; retain deterministic tags as the default.
2. Add isolated worktrees and merge/reconciliation before enabling parallel file writers.
3. Forward supported composer attachments through collaborator dispatch with per-provider diagnostics.
4. Persist structured assignment timelines beyond the attributed result text, including model and measured usage per participant.
5. Run release-candidate live provider/account checks on Windows and Linux, update community translations, and publish the reviewed Marketplace pre-release after required checks.

Proactive's wider roadmap and live source selection remain in [plan 43](43-proactive-continuation.md). This release does not claim mobile/phone notifications, complete source-event coverage, or autonomous offload.
