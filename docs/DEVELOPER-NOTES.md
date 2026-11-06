# Developer reference notes

Use this page after the [architecture map](ARCHITECTURE.md) when changing a
transport or shared service. These are implementation invariants, not a provider
compatibility guarantee. See [contributing](../CONTRIBUTING.md) for the workflow.

## CLI discovery, updates and commands

Discovery prefers an explicitly configured executable and provider-declared
locations, then the user's PATH, then guessed fallback locations. The synchronous
spawn path reads the discovery cache. Preserve that relationship: finding one
binary and running another defeats version and capability checks.

`getResolutionEnv()` preserves the user's PATH ordering; `getEnrichedEnv()` also
serves subprocess/shebang lookup and has a different purpose. Another extension's
private bundled executable is a fallback, not an override for the user's install.
Keep probe output and lifetime bounded and clean up only owned processes.

Source: [platform utilities](../src/utils/platform.ts),
[base CLI provider](../src/providers/base/BaseCliProvider.ts),
[discovery tests](../tests/utils/cliPathResolution.test.ts).

CLI updates use the selected installation and supported runtime. Preserve
per-package results, cancellation ownership and terminal visibility. A successful
installer exit is not proof that discovery selected the updated binary.

Source: [CLI update service](../src/services/CliUpdateService.ts),
[CLI discovery service](../src/services/CliDiscoveryService.ts).

Provider-native commands can be reported by a transport, declared in the curated
catalog or discovered from user command files. Interactive terminal commands are
not automatically valid in a headless transport. Preserve the distinction between
passthrough, template expansion and a Mysti-owned command. Validate untrusted
names and use the current transport report when it is authoritative.

Source: [native command catalog](../src/providers/base/NativeCommands.ts),
[file discovery](../src/services/NativeCommandDiscovery.ts),
[slash-command manager](../src/managers/SlashCommandManager.ts).

## Usage, context and cache accounting

Use [TokenAccounting](../src/services/TokenAccounting.ts) rather than re-deriving
usage in each consumer. Anthropic-style cache counts are disjoint from ordinary
input; OpenAI-style cached input is a subset. Missing usage is unknown, not a
measurement of zero. Current context occupancy, per-turn spend and lifetime
totals answer different questions.

Use the model that actually ran, including provider/model overrides and reported
context windows. A picker label or catalog maximum is not evidence of the
account's effective model/window. Keep estimated and measured receipts distinct.
See [compaction](COMPACTION.md) for the user-facing behavior.

## Visual observation and artifacts

The [visual policy boundary](../src/services/visualTestPolicy.ts) resolves allowed
origins and dev-server policy. Model-supplied selectors or paths must not become
arbitrary hosts or shell commands. Preserve workspace trust, capability gates,
read versus interaction policy, and untrusted-result fencing.

Canvas uses its typed document and host bridge; old unused classes are not the
active architecture. Read the [Canvas guide](walkthroughs/canvas.md) and
[Visual Test guide](walkthroughs/visual-test.md) before describing visible controls.
A screenshot or returned report does not establish that an automatic repair
loop or every export format exists.

## Persistence and credentials

Histories, Canvas artifacts, checkpoints, provider-owned sessions and secrets
have separate owners. Preserve future-version/corrupt data and successful backup
acknowledgement before replacing live state. An imported conversation does not
transfer executable checkpoint state or credentials.

Use the [backup and recovery guide](BACKUP-AND-RECOVERY.md) and
[privacy guide](PRIVACY.md) for the storage map and user-facing limits.
Do not put credentials in logs, generated reference files, screenshots or examples.
