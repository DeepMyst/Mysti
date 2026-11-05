# Mysti 2.0.1 · Beta 2

**More reliable conversations. Clearer recovery. A documented path to stable.**

Beta 2 brings the reliability work since Beta 1 into a new extension build. It
improves provider lifecycle handling, context ownership, conversation recovery,
and cancellation, with a refreshed feature gallery and a reusable release guide.

[Feature recordings](../../DEMO_GALLERY.md) ·
[Validation](VALIDATION.md) ·
[Production-readiness checklist](../../PRODUCTION_READINESS.md) ·
[Full changelog](../../../CHANGELOG.md)

## What changed

### Stop and recover

OpenCode's local CLI could exit while its shell tool continued running in a
separate process group. Mysti now captures owned descendants before stopping the
CLI and verifies process identity before signalling them. A bounded native macOS
test confirms shell/child termination, prevention of the delayed write, and a
successful follow-up request. Remote session cleanup also recovers after an
OpenCode server restart while preserving other clients' sessions. Pending remote
cleanup is retried while the provider instance remains alive; it is not persisted
across extension reload.

The broader provider work tightens completion, interruption, timeout, credential
rotation, usage attribution and stale-response handling. Capabilities remain
provider-specific; including an adapter does not certify every CLI release,
model, account or platform.

### Keep the right context with the right conversation

Drafts, attachments, queued messages and second opinions retain their originating
conversation. Context refreshes before dispatch; exact file mentions and bounded
reads prevent ambiguous or oversized inputs from silently becoming something
else. Conversation history, transfer, forks, checkpoints and edit reversion have
additional ownership and recovery checks.

Setup and authentication recover from cancelled, superseded and failed attempts.
Model settings and receipts follow the request that used them. Late callbacks
cannot claim a newer panel or conversation.

### Review before acting

Prompt deep links open the full bounded task for review before placing it in the
composer. They do not send automatically. Shared-conversation import dialogs
default to declining. Read-only tool classification distinguishes built-in tools
from MCP tools with similar names, and rendered content cannot create trusted
message controls.

### Learn the product, and see what remains

The [demo gallery](../../DEMO_GALLERY.md) covers the major workflows in short,
captioned recordings. Sample-data scenes are labelled and kept separate from
native-provider test evidence.

The standalone [production-readiness report](../../PRODUCTION_READINESS.md)
records verified progress, acceptance gaps, priorities, and the checks to repeat
before every update. Copy it into another checkout or planning tool as a release
handoff; its commands and links do not depend on one maintainer's machine.

## Install and update

Download the VSIX from the [Beta 2 release](https://github.com/DeepMyst/Mysti/releases/tag/v2.0.1-beta.2),
then use **Extensions → ⋯ → Install from VSIX** and reload VS Code. Keep a backup
of your workspace and VS Code profile/storage before upgrading or downgrading.

- Package version: **2.0.1**.
- Release tag: **v2.0.1-beta.2**.
- Channel: **pre-release**.
- Requires VS Code **1.86 or newer** and a trusted local workspace.
- Start with one configured provider. Provider subscriptions, API usage and CLI
  credentials remain separate from Mysti.

GitHub release publication and Marketplace/Open VSX publication are separate
operations. The Marketplace badge reports the version actually available there;
do not assume a registry updated merely because a GitHub release exists.

## Beta limits

This build is not a declaration of production readiness. The full acceptance
campaign still includes unrun journeys, broader native platform/account checks,
and deferred long-duration profiles. Some cloud integrations need configured
accounts; experimental authoring, Desk and visual workflows have additional
limits described in their guides. Checkpoints cannot undo external actions.

The OpenCode native test uses the real CLI against a scripted loopback model
server. It proves the exercised transport and process lifecycle, not model
quality or real-account inference. Read [validation](VALIDATION.md) for the
artifact's checks and scope.

For rollback, retain the previous VSIX and your pre-upgrade data backup. Avoid
opening newer storage with an older extension until compatibility is verified;
use a separate profile when testing a downgrade. [Beta 1 remains available](https://github.com/DeepMyst/Mysti/releases/tag/v2.0.0-beta.1).

[Report a reproducible issue](https://github.com/DeepMyst/Mysti/issues/new/choose) ·
[Contribute](../../../CONTRIBUTING.md)
