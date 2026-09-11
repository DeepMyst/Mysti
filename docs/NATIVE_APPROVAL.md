# Native approval contracts

Hermes and Kimi route ACP permission requests through a native request → host permission card → native response bridge. OpenClaw uses a version-verified owned runtime and a final-execution approval broker for its supported embedded tools; see [the native policy contract](OPENCLAW_NATIVE_POLICY.md). Each request belongs to the issuing process and turn. The provider sends one allow, deny, or cancelled response, and tool notifications are used for display. Claude Code and Codex now use the version-pinned native bridges described in [the CLI approval contract](NATIVE_CLI_APPROVAL.md). Gemini, Cline, Copilot, Qwen and OpenCode now use the version-specific [ACP bridges](ACP_NATIVE_APPROVAL.md). Other tool-executing adapters still rely on streamed notifications, restrictive native modes, or external configuration. SIGSTOP after a notification does not establish that execution waited for approval.

`supportsNativeApproval` means this native request/response bridge is implemented. It does not infer approval support from JSON output, nor prove that a particular CLI release requests permission for every operation. Release verification must cover the agent's native permission configuration as well as the host bridge.

## Implemented ownership and policy

- Added `src/providers/base/NativeApprovalPolicy.ts`; it uses the shared permission classifier and keeps native plan/read-only restrictions first.
- Hermes/Kimi require interactive approval for edit/execute/delete/fetch permission requests in `ask-before-edit + full-access`. A missing owner denies these requests; an explicit host approval permits the one operation. Their former unconditional full-access branch approved them before any UI interaction.
- Cursor and Continue reject restricted turns before CLI discovery or prompt preparation. Their native modes have no verified final-execution boundary in Mysti. Copilot public turns now require the verified ACP transport; legacy plain-text execution has no fallback.
- `shouldGateToolUse` accepts only the mode/access fields it actually uses; classifier behavior is unchanged.
- `IProvider.NativeApprovalHost.handlerForPanel` is resolved before a turn starts; a later handler cannot acquire an old request. `NativeApprovalRequest.id` is a unique host card key, separate from the native JSON-RPC ID and tool-call ID.
- `NativeApprovalRequests` binds callbacks to one process and turn. Stop, process exit/error, disposal, supersession, and handler failure settle pending requests. A late response never targets a replacement process. Duplicate IDs while a request is pending share one decision. The shared scope permits a fresh request after settlement; Claude/Codex add stricter transport-level replay rejection for their native IDs.
- `ProviderManager.setNativeApprovalHandler` installs the default host. `setNativeApprovalHandlerForPanel` supplies an explicit child-run destination. Both return identity-safe disposables. `captureNativeApprovalHandler` captures a parent destination without replacing its turn, enabling explicit mention/brainstorm relays.
- Native policy has three outcomes: allow, ask, deny. Host callbacks may further restrict an allowed operation, so collaborator role policy still applies. Native read-only denials cannot be widened by a host approval. Missing handlers deny ask-required operations.
- Native decision observers report settled outcomes under the captured panel and turn, including policy denials that never open a card. Observers cannot change the response. Mention and collaborator tasks stop after denial and do not replay an approved action that may have side effects after a transport failure; this applies across question follow-ups. An approval already awaiting a parent response cannot permit another action after task denial or cancellation.
- A single card can select only a native `allow_once` option. Persistent native grants are not silently substituted; the option kind is authoritative when supplied.
- The normal stream inactivity clock is paused while a native approval is pending; permission timeout policy belongs to the host card. Request signals abort on settlement and disposal so card listeners can be removed.
- Tests include a real local ACP fixture process (`tests/fixtures/acpPermissionAgent.cjs`). The fixture writes a marker only after a matching native allow response. It uses no model API or provider account.

## Registered-provider matrix

“Native deny” below describes the configured policy or actual emitted permission-request response, not a verified OS sandbox. CLI approval options and process scheduling are separate mechanisms.

| Provider | Current ask-tier path | Plan/read-only path | Native interactive approval in Mysti? | Source |
| --- | --- | --- | --- | --- |
| Claude Code | 2.1.266 host control requests with mandatory wildcard ask policy | Native plan tool subset plus immutable host mutation denial | Yes, for the supported built-ins and explicit Mysti Canvas tools | [CLI approval contract](NATIVE_CLI_APPROVAL.md) |
| Codex | 0.153.4 app-server command/file approvals; inherited authority checked before execution | Native read-only/network-disabled sandbox plus host mutation denial | Yes, for emitted native command/file requests; trusted native reads may run without cards | [CLI approval contract](NATIVE_CLI_APPROVAL.md) |
| Gemini | 0.58.0 ACP, admin policy asks for read/write/replace; other tools denied | Only native read_file permitted plus host mutation denial | Yes, file operations; shell/delegation unavailable | [ACP contract](ACP_NATIVE_APPROVAL.md) |
| Cline | 3.0.61 ACP with auto-approval disabled and isolated local state | Native plan mode plus host mutation denial | Yes, supported final native tool inputs; environment API key required | [ACP contract](ACP_NATIVE_APPROVAL.md) |
| Copilot | 1.0.83 ACP with manual permission policy and isolated BYOK state | Native shell/write denial plus host mutation denial | Restricted read/search only; interactive writable support unresolved | [ACP contract](ACP_NATIVE_APPROVAL.md) |
| Cursor | Rejected before launch | Rejected before launch | No; only fully unrestricted turns remain available | `src/providers/cursor/CursorProvider.ts` |
| OpenClaw | Owned OpenClaw 2026.6.34/Pi runtime; final `read`/`write`/`edit`/foreground `exec` actions request scoped host decisions | Non-read actions denied by immutable host policy | Yes, within the verified four-tool boundary; unsupported harnesses/delegation and CLI fallback denied | [OpenClaw native policy](OPENCLAW_NATIVE_POLICY.md) |
| OpenCode | 1.18.29 ACP with an isolated fixed agent; file/search/fetch requests | Native executable tool map removes mutations plus host denial | Yes, supported file/search/fetch surface; shell/delegation unavailable | [ACP contract](ACP_NATIVE_APPROVAL.md) |
| Qwen Code | 0.23.0 ACP with explicit ask rules for its selected native tools | Mutation tools excluded plus host denial | Yes, read/edit/notebook/foreground shell | [ACP contract](ACP_NATIVE_APPROVAL.md) |
| Hermes | ACP permission request held until the scoped host card resolves; explicit native denials remain blocked | Non-read permission requests denied | Yes, for emitted ACP permission requests | `src/providers/hermes/HermesProvider.ts`; `src/providers/base/AcpApproval.ts` |
| Kimi Code | Same scoped ACP native request/card/response bridge | Non-read permission requests denied | Yes, for emitted ACP permission requests | `src/providers/kimi/KimiCodeProvider.ts`; `src/providers/base/AcpApproval.ts` |
| Continue | Rejected before launch | Rejected before launch | No; only fully unrestricted turns remain available | `src/providers/continue/ContinueProvider.ts` |
| Ollama | Receives model tool-call proposals but never executes them | No local execution | Not applicable to execution; `supportsToolUse: true` means proposal reporting here | `src/providers/ollama/OllamaProvider.ts` |
| LocalAI | Receives model tool-call proposals but never executes them | No local execution | Not applicable to execution; `supportsToolUse: true` means proposal reporting here | `src/providers/localai/LocalAIProvider.ts` |
| OpenRouter | Chat-only HTTP transport; `supportsToolUse: false` | No local execution | Not applicable | `src/providers/openrouter/OpenRouterProvider.ts` |

## Claude/Codex native transport replacement (2026-09-10)

Claude's bypass-permissions and Codex's headless exec execution paths have been
replaced for public agent turns. Claude uses its stdin host control protocol and
Codex uses app-server requests/responses. Both reject unsupported runtime or
policy conditions before model submission, with no legacy execution fallback.
The [CLI approval contract](NATIVE_CLI_APPROVAL.md) records exact versions,
configuration restrictions, native safe-read exceptions, and test evidence.

## Remaining concrete defects and misleading promises

1. **The advertised approval contract is stronger than the mechanism.** `package.json:563` advertises “confirm every change”; Legacy Chat and collaborator stream-gate comments describe SIGSTOP as pre-execution enforcement. The provider interface now labels it as a best-effort pause. A JSON notification has no acknowledgement dependency. The CLI may run before the extension reads stdout, even if a later SIGSTOP succeeds. Existing tests mock `suspendRequest` and assert cards/flags; they do not prove a write is absent while approval is pending.
2. **Suspension does not stop an already spawned tool child.** `BaseCliProvider.suspendProcess` calls `proc.kill('SIGSTOP')` only on its direct process. An offline process fixture started a command child, emitted a tool-start event, then stopped the parent. Result: `suspended: true`, `toolSideEffectWhileStopped: true`. This demonstrates process semantics independently of a model call. Killing after denial cannot undo the effect.
3. **Zero-argument tools bypass the stream gate.** Direct Chat checks `Object.keys(input).length > 0` before gating (`ChatViewProvider.ts`, direct tool-use gate), as does the legacy subagent path (`_gateLegacySubagentToolUse`). A valid mutating tool with `{}` input never reaches the gate. The existing partial-input workaround needs an explicit event phase or a native permission request, not a nonempty-input test.
4. **OpenClaw gateway authority repaired for the supported owned runtime.** Agent sends and prompt enhancement require a captured run lease and final-execution guard. Shared-gateway agent delegation is disabled. Native Codex, ACP, delegated/background execution and arbitrary plugin tools remain unsupported; see [the exact boundary](OPENCLAW_NATIVE_POLICY.md).
5. **OpenClaw invalid fallback removed with its authority replacement.** Installed OpenClaw 2026.6.34 registers neither `--sandbox` nor `--yolo`. Mysti no longer invokes the unsupported agent fallback; failure to start the owned approval runtime reports an error and prevents execution. The original inert parser proof remains useful evidence that dropping flags alone would have been insufficient.
6. **Unsupported restricted transports are blocked.** Cursor and Continue now reject every restricted tier before startup. Continue's native `--readonly` explicitly permits Bash and MCP; it cannot enforce this contract. Cursor's mode flags alone have not established a final-execution boundary. OpenCode/Qwen/Copilot use their bounded ACP policies. See [restricted transport behavior](RESTRICTED_TRANSPORTS.md).
7. **Capability vocabulary hides these differences.** `ProviderCapabilities.supportsNativeApproval` now distinguishes the implemented native bridges; native read-only strength and proposal-only tool reporting remain separate contract work. `supportsToolUse` covers actual CLI execution and Ollama/LocalAI proposals; callers cannot infer approval enforcement from it.

## Remaining acceptance requirements

Gemini, Cline, Copilot, Qwen, and OpenCode now have bounded ACP bridges with version-specific native policies. Their supported tools, credential restrictions, and isolated runtime evidence are recorded in [the ACP contract](ACP_NATIVE_APPROVAL.md). Remaining tool-executing adapters must provide native permission requests or enforce a restricted surface. Claude and Codex now have bounded native bridges; their authenticated and installed-editor acceptance remains outstanding. OpenClaw now has the bounded owned-runtime bridge described above; authenticated provider and wider runtime acceptance remain outstanding.

OpenClaw's session exec controls cover shell execution rather than every tool.
The implemented bridge combines a live host policy with a verified final raw
execution guard because ordinary hooks and tool finalization can mutate the
arguments after the early trusted policy. An early hook or exec-only approval
must not be presented as equivalent coverage. The [native policy contract](OPENCLAW_NATIVE_POLICY.md)
records startup, action identity, supported tools and compatibility limits.

For each adapter, verify its native configuration requests approval for every policy-gated action. ACP permits an agent to omit permission requests, so handling requests alone is not proof that all tools are gated. Pin or probe supported CLI versions and record evidence for writes, commands, deletes, network requests, and zero-argument tools. A configured native read-only mode must withstand repository configuration that otherwise enables writes.

A release acceptance fixture must assert: no side effect while approval is pending; none after denial/cancellation; one after approval; cancellation of the owning card on Stop/close/supersession; no late response into replacement processes; independent concurrent panels; and request-ID reuse across turns. Test actual provider startup/handshake/parser wiring as well as pure policy. Keep notifications separate from authority and make available operation modes reflect the implemented transport contract.

Run the focused suite with:

```sh
npx vitest run tests/providers/nativeApprovalBridge.test.ts tests/providers/base/nativeApprovalRequests.test.ts tests/managers/nativeApprovalRouting.test.ts tests/providers/nativeApprovalPolicy.test.ts
```

## Evidence used

- Installed, read-only `--help`/`--version`: Claude preferred extension binary 2.1.266 (item-4 follow-up found PATH 2.0.71; a separate 2.1.263 binary was also present); Codex 0.153.4; Gemini 0.58.0; Cline 3.0.61; Copilot 1.0.83; Cursor 2026.02.13-41ac335; Qwen 0.23.0; OpenCode 1.18.29. Hermes/Kimi/Continue were not installed during this audit; native bridge behavior was verified with local protocol fixtures. The original audit used no model/API calls. Follow-up native runtime tests use isolated local fake models, with no authenticated provider service.
- [ACP tool-call permission protocol](https://agentclientprotocol.com/protocol/v1/tool-calls): distinguishes tool progress notifications from permission requests and requires cancelled outcomes on prompt cancellation.
- [Claude SDK approvals](https://code.claude.com/docs/en/agent-sdk/user-input): supported callback receives tool/input and returns allow/deny. Installed help additionally exposes print-mode host permission prompts.
- [Codex app-server](https://developers.openai.com/codex/app-server/): command/file approval requests have distinct IDs and native responses; installed app-server supports stdio.
- [OpenCode permissions](https://opencode.ai/docs/permissions/) and [agents](https://opencode.ai/docs/agents): build/plan policy semantics and configurability.

The [OpenClaw transport contract](OPENCLAW_TRANSPORT.md) covers negotiation, run
isolation and targeted cancellation. The [native policy contract](OPENCLAW_NATIVE_POLICY.md)
separately defines the final execution authority and its verified limits.
