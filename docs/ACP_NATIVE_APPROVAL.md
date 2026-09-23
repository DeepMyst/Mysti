# ACP approval contract

Gemini, Cline, Copilot, Qwen and OpenCode public agent turns use ACP v1 native
permission requests. A tool notification is display data. Only a verified native
permission request can reach the captured Mysti host decision. There is no
legacy stream-JSON, plain-text, or auto-approve execution fallback.

## Supported releases and operations

| Provider | Verified release | Native operation boundary |
| --- | --- | --- |
| Gemini | 0.60.0 (0.58.0 accepted) | `read_file`, `write_file`, `replace`. File diffs carry the proposed contents; reads bind a single absolute native location. Shell, delegation and other tools are denied because these releases omit their complete permission inputs. 0.60.0 skips the bundled system settings file (not root-owned); the admin policy is the enforcing transport and `.agents/skills` is refused. |
| Cline | 3.0.64 (3.0.61 accepted) | Supported built-in reads/searches, edits, foreground commands and web tools. The exact native tool name and final `rawInput` are required; a generic `think` kind cannot authorize an agent. |
| Copilot | 1.0.83 | Sync `bash` commands (request must repeat the announced command) and per-file `apply_patch`/`edit`/`create` changes (absolute path + diff), each behind a host card. Async/detached shells, web tools, broader path grants and delegation are denied. Restricted tiers expose read/search only. Native workspace reads bypass host cards. |
| Qwen Code | 0.24.4 (0.23.0 accepted) | `read_file`, `edit`, `notebook_edit`, foreground `run_shell_command`. Final arguments and native normalized edit diffs are captured together. Other core and synthetic tools are excluded, including 0.24's `tool_call` dispatcher, code-mode `exec` and `omni_*` tools. |
| OpenCode | 1.18.29 | File read/search/edit/fetch tools under a fixed `mysti-host` agent. On macOS, unrestricted tiers add shell through a Mysti gate plugin: one card per command, and any command OpenCode did not submit for approval is refused. Task/delegation and arbitrary custom tools are removed from the executable tool map. |

These are bounded native bridges, not OS sandboxes. Approving a command authorizes
that whole command, including its subcommands. Already approved programs and
children they detach are not contained by a pending permission card.

## Turn ownership

`AcpNativeProvider` captures the original settings, host handler, CLI path,
environment, signal and panel before asynchronous preparation. Every turn gets a
fresh process and ACP session. Conversation history is included in the prompt.
A fixed `Mysti user request:` prefix prevents submitted leading slash text from
being routed to native permission-changing commands before the model sees it.
Native session resume and prompt enhancement are unavailable through these
bridges.

CLI discovery reads installation metadata without executing native startup.
Initialization verifies protocol version 1 and the provider's supported identity.
The provider sets its mode/model before model input and rechecks native policy
sources after startup. Settings changes affect later turns. ACP filesystem and
terminal client capabilities are advertised unavailable; Mysti never exposes a
host command runner or filesystem writer through this transport.

`AcpNativeClient` requires a current process/session/prompt owner. It freezes the
final operation inputs before invoking the host. Host card IDs are distinct from
the native RPC and tool IDs. Only `allow_once` can authorize execution;
`allow_always` is never substituted. Denial uses `reject_once` when available,
otherwise cancellation. Missing or incomplete authority, unsupported tool types,
replayed native request IDs and malformed protocol data fail closed.

Read-only and plan settings deny mutating operations before host review. A host
callback may restrict a locally allowed request, but cannot widen a native
restriction. Native tools that bypass permission requests do not reach this
callback; Copilot's safe-read exemption is one such limit.

Stop, exit, disposal, replacement, native mode changes, tool completion and a
change to pending tool inputs revoke the captured card. Late host results cannot
authorize a replacement process. The inactivity clock pauses while a permission
is pending and restarts when it settles. Startup calls have separate deadlines.
A final done chunk is emitted after awaiting the captured child shutdown
attempt and temporary-state cleanup. On POSIX, termination first freezes the
agent (before `session/cancel` is written), then kills every descendant and each
process group a descendant leads, rescanning until none remain; only then is the
agent itself signalled. This covers a tool's detached shell group and its
background jobs. A process that already re-parented itself away (a double-fork
daemon, or `setsid` before the first scan) is outside this cleanup, which is not
OS containment. OpenCode's shell-enabled launch is the one exception to the
freeze-first order: Stop sends `session/cancel` first and waits, at most 5 s,
for the cancelled prompt result, because OpenCode's own cancellation signals
each running shell's whole process group. That reaches a background job whose
foreground shell already exited (no longer a descendant). The freeze and tree
kill then run as usual. Permission requests during the wait are answered
cancelled and nothing the agent reports is shown. Failure to prepare or attest the native launch never falls back
to the old transport.

## Native policy and configuration

ACP allows agents to omit permission requests. The provider startup policy is
therefore part of the approval boundary, independently of the protocol bridge.

- **Gemini:** bundled administrator policy denies all native tools except its
  explicit file subset. A separate restricted policy admits only reads. Native
  hooks, skills, agents, auto-memory, tool discovery and implicit MCP are disabled.
  Startup checks the npm package version, native policy/settings, customization
  directories and executable paths, then checks them again before submission.
- **Qwen:** bundled system settings ask for each enabled tool by name. In this
  release `*` is not a universal ask rule, and bare mode alone does not close
  auto-memory or background-shell exemptions. The bridge explicitly selects its
  core tools and excludes synthetic/delegated tools. Hooks, skills, MCP and
  background authority are disabled. Native settings and executable sources are
  checked before and after startup. Bootstrap argument overrides are stripped, and the
  npm wrapper is pinned to its local payload to prevent selecting a managed update.
- **Cline:** private `CLINE_DIR` and `CLINE_DATA_DIR` plus
  `CLINE_SESSION_BACKEND_MODE=local` isolate native account configuration and the
  shared daemon. Auto-approval must be attested false. Inherited hooks/plugins
  prevent startup, including legacy Documents/Cline paths outside `CLINE_DIR`.
  ACP mode and model are set by RPC because this native entry point ignores the
  corresponding CLI flags.
- **Copilot:** a private `COPILOT_HOME` supplies manual permissions and disabled
  hooks/plugins/IDE auto-connect. The earlier finding that an append-redirection
  command and an in-workspace apply_patch bypassed the ACP callback was caused by
  Mysti itself: it set `COPILOT_ALLOW_ALL=false`, and releases before 1.0.85 treat
  any non-empty value as allow-all while still reporting `allow_all: off`. With the
  variable unset, 1.0.83 (and 1.0.87) send a permission request before every tested
  shell form (redirects, `>>`, `tee`, `sed -i`, `find -delete`, substitutions,
  compound commands) and every patched file, and a reject prevents the effect
  (runtime-verified with a fake local model, 2026-09-22). Unrestricted and ask
  tiers therefore expose `bash`, `apply_patch`, `edit` and `create`; each request
  must match the announced tool, shells must be sync (no `mode: async`/`detach`),
  and a multi-file patch is approved file by file, so a later rejection can leave
  earlier approved files changed. A sync command still running after
  `initial_wait` is killed with the agent's process tree at Stop or turn end.
  Read-only and plan tiers keep the read/search tool map with shell and write
  denied. Native and managed configuration sources that cannot be
  isolated prevent startup. GitHub token login can fetch opaque managed hooks,
  so this bridge requires BYOK and forces GitHub offline mode. Native safe reads
  still bypass host approval.
- **OpenCode:** private XDG state, a fixed primary agent and explicit model isolate
  saved login/configuration. The V1 configuration disables project configuration,
  user/workspace plugins, MCP, skills, formatters, LSP, sharing, snapshots and updates. Actual
  1.18.29 testing exposed a second Core V2 loader that imports project plugins
  even with `--pure`. Mysti therefore rejects `opencode.json`, `opencode.jsonc`
  and `.opencode` in the workspace and all lexical/canonical ancestors, in
  addition to global `.opencode` and managed authority. It checks metadata
  without reading configuration contents, checks again before process launch and
  before the prompt, and rejects workspace symlink retargeting. These checks are
  not OS confinement against concurrent external configuration changes.
  Native background
  dependency checks use private npm configuration, offline mode and disabled
  lifecycle scripts. The internal ACP HTTP server binds loopback with a fresh
  password.

  **Shell gate (macOS, unrestricted tiers).** The shell tool skips its
  permission request whenever its parser yields no command pattern
  (`tool/shell.ts` `ask`: `if (scan.patterns.size === 0) return`), e.g. a
  redirection-only `> file`, which then runs unapproved. A `permission.bash`
  rule cannot help because no request is ever evaluated; 1.18.32 and upstream
  `dev` (2026-09-22) still have the early return. Mysti therefore keeps `bash`
  denied in its configuration and loads one private plugin file (0600, in the
  0700 launch directory, per-launch nonce) as the only configured plugin:
  - its `config` hook, which OpenCode calls only for hooks already registered in
    that instance, is the only thing that changes `bash` to `ask`, so the tool
    exists only where the gate's hooks exist;
  - `tool.execute.before` marks each bash call; `permission.asked` and
    `permission.replied` events (delivered synchronously inside `publish`,
    before the waiting tool resumes) record whether that call's own request was
    answered `once`;
  - `shell.env`, which runs after the permission step and immediately before
    every shell spawn, throws unless the call was approved once. No request,
    rejection, `always`, a pending request, a reused or duplicated call id and a
    missing call id all refuse the spawn.

  Loading a plugin requires dropping `--pure`/`OPENCODE_PURE`. V1 then loads
  plugins from the configured list, the private XDG config directory, and the
  global `.opencode`/managed/account sources that are already rejected before
  launch (project configuration stays disabled). The gate's `config` hook
  writes an attestation of its nonce, instance directory and the instance's
  complete V1 plugin list; Mysti refuses the turn before the prompt unless it
  shows exactly this gate for this workspace. That detects, but cannot undo, a
  plugin source that appeared after the pre-launch checks: its load-time code
  has already run. Read-only and plan tiers, and Linux/Windows, keep `--pure`,
  no plugin and shell removed. (For a later Windows review: with a posix shell
  and an absolute `workdir`, OpenCode runs a fixed `cygpath` helper before the
  request.)

  Approving a command authorizes it whole, including background jobs. A job
  that detaches with `setsid` or a double fork escapes Stop like on every other
  provider. Tested natively on 1.18.29: card before any effect, allow, deny,
  redirection-only refusal without a card, background job, Stop during a
  running shell, a background job and an orphaned background job (no late
  effect), missing gate and extra plugin refusal. 1.18.32 source is identical
  for every file the gate depends on; it is not an accepted runtime.

OpenCode 1.18.29 emits a redundant `fs/write_text_file` UI request after approval
even when the client advertises that capability as false. Mysti returns
MethodNotFound and performs no host write. The already approved native operation
performs its own edit. This specific unsupported request is nonfatal only within
the current prompt/session; other unsupported host operations fail closed.

Qwen's optional `craft/drainMidTurnQueue` request also receives MethodNotFound;
the verified release treats that reply as an unavailable queue and continues
the current prompt without accepting additional host tasks.

All five native launches also use a private Git configuration that disables
global/system configuration and hooks/fsmonitor. Repository and linked-worktree
configuration with executable helpers or includes prevents startup. Inherited
Git environment overrides are removed. The guard runs before spawn and before
model input, without invoking Git or editing user configuration.

These checks do not modify user configuration. They detect ordinary configuration
changes across startup; they are not an OS boundary against adversarial filesystem
races or a replaced executable falsely reporting the expected version.

## Authentication and capability limits

Cline requires `CLINE_API_KEY` in the extension environment, with optional
`CLINE_PROVIDER`. Copilot requires an explicit `COPILOT_PROVIDER_BASE_URL` and its
native BYOK model/key settings; GitHub tokens and stored subscription logins are
unsupported. OpenCode requires an explicit standard `provider/model` ID and the
matching environment API key. These private sessions do not import saved native
credential stores. Gemini and Qwen retain their inspected native model/auth
configuration only when it passes the execution-policy preflight.

Cline ACP does not implement its advertised image capability or forward usage and
thinking controls; Mysti rejects images and reports those limits. Gemini reports
final `_meta.quota.token_count` totals without summing them again with per-model detail. OpenCode reports final prompt
input/output tokens; its context-occupancy updates are not treated as token usage.

All five providers use prompt history instead of persistent native sessions.
Authenticated service calls, installed-editor behavior, broader descendant cleanup
and cross-platform support remain acceptance work. Unsupported platforms or
configuration produce an actionable startup error, with no automatic execution
fallback.

## Evidence and verification

The retained tests cover the strict shared client and each provider's public
`sendMessage` path using local inert process fixtures. They assert absent effects
while review is pending, one effect after allow, no effect after denial or Stop,
version/session rejection, immutable final inputs and cleanup. Separate native
integration tests use the installed pinned CLIs with an isolated local fake model;
these are distinct from authenticated provider acceptance.

Run the shared transport tests with:

```sh
npx vitest run tests/providers/base/acpNativeClient.test.ts tests/providers/base/acpNativeProvider.test.ts
```

Provider-specific native integration tests require their pinned installed runtime
and isolation support. The review handoff records which native cases actually ran,
first failures and unresolved acceptance limits; skipped cases are not acceptance.

Primary protocol references: [ACP initialization](https://agentclientprotocol.com/protocol/v1/initialization),
[session setup](https://agentclientprotocol.com/protocol/v1/session-setup), and
[tool-call permissions](https://agentclientprotocol.com/protocol/v1/tool-calls).
Native behavior is additionally checked against the installed release source;
OpenCode's source reference is tag v1.18.29, commit
`16747470f976aca3d362ad730bcd3fe82ecc2c9a`.
