# Claude and Codex native approval contract

Mysti holds native permission requests until the captured host decision settles.
Claude Code uses its print-mode host control channel; Codex uses app-server
stdio JSON-RPC. Streamed tool notifications update the display and do not grant
execution. Unsupported versions, configuration, or protocol failures stop the
turn without retrying through the former notification-based execution path.

## Shared ownership and policy

The panel, host handler, settings, request signal, and issuing process are
captured before asynchronous startup. Stop, disposal, process exit/error, or a
replacement turn revoke pending cards. Late approvals cannot reach a replacement
process. Exact native tool inputs are frozen before host review; duplicate,
conflicting, cancelled, or settled IDs cannot grant a different operation.

Plan and read-only restrictions deny mutations even if a host handler returns
allow. Other modes use Mysti's shared tool classifier: ask-tier mutations require
the host card, while configured automatic modes may settle without a card. A
captured collaborator handler may further restrict an allowed operation. Missing
handlers deny ask-required actions. Responses grant only the current operation;
session permissions, rule amendments, and broad native grants are unsupported.

The stream inactivity watchdog pauses during a pending approval. The host card
owns permission timeout policy. Once the request settles, ordinary inactivity
handling resumes. Cancellation still wakes a stream waiting on user input.

## Claude Code 2.1.266

The provider verifies the CLI version and packaged policy before sending a turn,
then verifies `system/init.claude_code_version` on the live process. The policy
sets `disableAllHooks: true` and `permissions.ask: ["*"]`. Startup supplies
`--permission-prompt-tool stdio`, `--permission-prompts host`, an empty
`--setting-sources`, strict MCP configuration, and `--permission-mode manual`
(`plan` for restricted modes). The older PATH binary found during this work,
2.0.71, does not support the required manual mode and is rejected.

Each `control_request` of subtype `can_use_tool` carries a request ID, tool-use
ID, tool name, and final input. Mysti returns a matching `control_response` with
either `behavior: allow` and the same frozen `updatedInput`, or `behavior: deny`.
Native `control_cancel_request` retires only its matching card. Both single-shot
and persistent transports keep stdin available for these responses.

Supported built-ins are Bash, Read, Edit, Write, Glob, Grep, NotebookEdit,
WebFetch, WebSearch, and TodoWrite. Restricted startup exposes only Read, Glob,
and Grep. Native EnterPlanMode/ExitPlanMode changes are denied; the user selects
the mode for the next Mysti turn. Explicit Mysti Canvas MCP tools use the same
host protocol. Other MCP servers, custom skills, hooks, native agents, workflow
delegation, background tasks, and sandbox-bypass inputs are disabled or denied.
Prompt enhancement runs with an empty native tool surface because it has no
panel approval owner.

The actual 2.1.266 runtime was exercised with a local fake model in a private
filesystem fixture under macOS sandbox restrictions. Bash and Edit effects
remain absent while host approval is pending and occur once after allow.
Denial, read-only policy, and Stop prevent the effects. Native Read reaches the
host and can be denied by a collaborator policy. Its request omits the optional
`matched_ask_rule` metadata, so that field is diagnostic rather than required.
Background execution is rejected by the restricted native tool schema.

## Codex app-server 0.153.4

The provider negotiates `initialize`/`initialized`, verifies the runtime version,
reads native configuration provenance and requirements, and starts a fresh
ephemeral thread for every turn. Conversation text is replayed as prompt history.
Native state is not resumed across turns. Model, effort, image attachments,
streaming text/reasoning, and token usage remain supported.

Thread and turn parameters require the typed `untrusted` approval policy, the
user approval reviewer, and a read-only sandbox with network access disabled.
The typed policy is supported by 0.153.4 even though the corresponding TOML
spelling is no longer accepted. Startup verifies the native thread's returned
policy before sending model input.

The bridge handles `item/commandExecution/requestApproval` and
`item/fileChange/requestApproval`. Requests must match the current native thread,
turn, and preceding item. Command/cwd values must match the native command item.
If native display redaction makes the item command differ from the approval
command, Mysti denies the request. File approvals bind the exact paths, change kinds, and diffs from the preceding
file item, because the approval frame itself omits those changes. Repeated item
identities fail the turn; completing an item cancels its pending requests. Replies use one-operation
`accept`, `decline`, or `cancel`; persistent grants are never emitted. Additional
permissions, broad filesystem roots, remote/network authority, and terminal stdin
approval requests are denied.

**Native trusted reads can execute without a host card.** Codex's untrusted
policy exempts its native safe-command set inside the read-only sandbox. Mysti
does not promise that collaborator policy can veto those reads. Approving a
command grants that whole command; its internal shell actions are not separate
host requests. Escalated terminal-input approval is enabled and declined; the
bridge does not support interactive command sessions as a separate tool surface.

### Configuration preflight

In 0.153.4, explicit execution allow rules can bypass both the approval policy
and sandbox. The released app-server has no supported flag to ignore inherited
rules. Mysti therefore inspects configuration sources before starting the process
and compares the same sources again after thread startup, before any model turn.
It checks user/system locations, lexical and canonical project ancestors, and
linked-checkout configuration. It rejects `.rules` files, linked or special
configuration files, managed config/requirements, managed macOS preferences,
hooks, MCP servers, profiles, and unsupported authority settings. Configuration
is inspected read-only; credential stores and rejected rule contents are not read by
this preflight.

The supported TOML subset includes ordinary scalar model/provider/auth-store
preferences, project trust entries, history/telemetry preferences, and settings
explicitly overridden by the bridge. Structured or multiline values and unknown
keys require further compatibility work. Startup disables native hooks,
plugins/apps, delegation, browser/computer tools, web search, memories, shell
snapshots, and alternative execution surfaces. It also checks both native
`config/read` provenance and `configRequirements/read`; non-null requirements are
rejected because the public requirements response cannot attest execution rules.

This conservative preflight can reject an otherwise valid standalone Codex
configuration. It reports the unsupported category and leaves the files intact.
Named profiles and Windows execution are unsupported by this bridge. Filesystem
snapshots detect ordinary configuration changes during startup; they are not an
OS security boundary against another process deliberately racing those reads.

## Verification and remaining acceptance

Tests cover the public provider startup path, frozen ownership, native request
framing, allowed/denied/cancelled effects, independent panels, malformed frames,
process failure, replayed or conflicting IDs, missing handlers, read-only
restrictions, and stale responses. Codex uses an inert local app-server process
for native effect assertions and the installed release schema/source for policy
compatibility. Claude additionally has the actual runtime checks described above.
No authenticated model service is used by these tests.

The installed Codex no-model configuration probe did not answer `initialize`
within 30 seconds under the fixture's credential/network isolation, including
an attempt while the machine was awake. That probe is inconclusive: actual
native configuration normalization and authenticated Codex execution are not yet
verified. The protocol fixture and pinned source checks do not replace this
acceptance step.

Authenticated provider accounts, installed-editor behavior, and hosted
cross-platform acceptance remain separate release work. Revoking pending
permission requests does not undo an already approved command. The shared CLI
process cleanup is not an OS sandbox and does not establish containment of an
approved program that detaches descendants or survives a parent crash. The
earlier unexplained OpenClaw macOS cleanup `EPERM` remains a separate open
runtime reliability finding.

Protocol references: [Claude permissions](https://code.claude.com/docs/en/permissions),
[Claude SDK approvals](https://code.claude.com/docs/en/agent-sdk/user-input), and
[Codex app-server](https://learn.chatgpt.com/docs/app-server). The implemented
version boundaries above take precedence over features introduced in later
native releases.
