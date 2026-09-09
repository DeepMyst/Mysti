# Native approval contracts

Hermes and Kimi route ACP permission requests through a native request → host permission card → native response bridge. Each request belongs to the issuing process and turn. The provider sends one allow, deny, or cancelled response, and tool notifications are used for display. Other tool-executing adapters still rely on streamed notifications, restrictive native modes, or external configuration. SIGSTOP after a notification does not establish that execution waited for approval.

`supportsNativeApproval` means this native request/response bridge is implemented. It does not infer approval support from JSON output, nor prove that a particular CLI release requests permission for every operation. Release verification must cover the agent's native permission configuration as well as the host bridge.

## Implemented ownership and policy

- Added `src/providers/base/NativeApprovalPolicy.ts`; it uses the shared permission classifier and keeps native plan/read-only restrictions first.
- Hermes/Kimi now deny edit/execute/delete/fetch permission requests in `ask-before-edit + full-access`. Their former unconditional full-access branch approved them before any UI interaction.
- Continue and legacy plain-text Copilot no longer receive unrestricted auto-approval in `edit-automatically + ask-permission`. Continue uses `--readonly`; legacy Copilot denies shell/write because these transports cannot present native requests.
- Modern Copilot's existing stream-pause behavior is unchanged. Correcting its policy predicate does not establish pre-execution approval.
- `shouldGateToolUse` accepts only the mode/access fields it actually uses; classifier behavior is unchanged.
- `IProvider.NativeApprovalHost.handlerForPanel` is resolved before a turn starts; a later handler cannot acquire an old request. `NativeApprovalRequest.id` is a unique host card key, separate from the native JSON-RPC ID and tool-call ID.
- `NativeApprovalRequests` binds callbacks to one process and turn. Stop, process exit/error, disposal, supersession, and handler failure settle pending requests. A late response never targets a replacement process. Duplicate IDs while a request is pending share one decision. Reuse after settlement creates a fresh request and card, including within the same turn.
- `ProviderManager.setNativeApprovalHandler` installs the default host. `setNativeApprovalHandlerForPanel` supplies an explicit child-run destination. Both return identity-safe disposables. `captureNativeApprovalHandler` captures a parent destination without replacing its turn, enabling explicit mention/brainstorm relays.
- Native policy has three outcomes: allow, ask, deny. Host callbacks may further restrict an allowed operation, so collaborator role policy still applies. Native read-only denials cannot be widened by a host approval. Missing handlers deny ask-required operations.
- A single card can select only a native `allow_once` option. Persistent native grants are not silently substituted; the option kind is authoritative when supplied.
- The normal stream inactivity clock is paused while a native approval is pending; permission timeout policy belongs to the host card. Request signals abort on settlement and disposal so card listeners can be removed.
- Tests include a real local ACP fixture process (`tests/fixtures/acpPermissionAgent.cjs`). The fixture writes a marker only after a matching native allow response. It uses no model API or provider account.

## Registered-provider matrix

“Native deny” below describes the configured policy or actual emitted permission-request response, not a verified OS sandbox. CLI approval options and process scheduling are separate mechanisms.

| Provider | Current ask-tier path | Plan/read-only path | Native interactive approval in Mysti? | Source |
| --- | --- | --- | --- | --- |
| Claude Code | `--dangerously-skip-permissions`; stream-json tool notifications trigger SIGSTOP | `--permission-mode plan` | No; no host permission-request handler | `src/providers/claude/ClaudeCodeProvider.ts` |
| Codex | `--sandbox workspace-write`; JSONL item notifications trigger SIGSTOP | `--sandbox read-only` | No; adapter uses `exec`, not app-server request/response | `src/providers/codex/CodexProvider.ts` |
| Gemini | `--yolo`; stream-json tool notifications trigger SIGSTOP | `--approval-mode plan` | No; installed CLI supports ACP, adapter does not use it | `src/providers/gemini/GeminiProvider.ts` |
| Cline | Legacy `--yolo`, modern `--auto-approve true`; stream events trigger SIGSTOP | Legacy `--mode plan`, modern `--plan` | No; installed CLI supports ACP | `src/providers/cline/ClineProvider.ts` |
| Copilot | Modern JSON CLI: `--allow-all-tools` plus stream SIGSTOP. Legacy plain text: native shell/write denial | `--deny-tool shell --deny-tool write` | No; installed modern CLI supports ACP | `src/providers/copilot/CopilotProvider.ts` |
| Cursor | `--force`; stream notifications trigger SIGSTOP | Only omits `--force`; does not select the installed CLI's `--mode plan/ask` | No | `src/providers/cursor/CursorProvider.ts` |
| OpenClaw | Gateway: no mode/access authority field sent, and no local process to stop. CLI fallback: adds `--yolo` | Gateway: prompt instructions only. CLI: adds `--sandbox` | No; gateway approval RPCs are not bridged | `src/providers/openclaw/OpenClawProvider.ts`; `OpenClawGateway.ts` |
| OpenCode | Chooses `--agent build`; local native permissions remain externally configured; notifications are used for stream gate | Chooses configurable `--agent plan` | No request/response bridge; build/plan labels are not immutable permission policies | `src/providers/opencode/OpenCodeProvider.ts` |
| Qwen Code | `--approval-mode auto-edit`, including ask-before-edit; edits are natively auto-approved | `--approval-mode plan` | No; installed CLI supports ACP | `src/providers/qwen/QwenCodeProvider.ts` |
| Hermes | ACP permission request held until the scoped host card resolves; explicit native denials remain blocked | Non-read permission requests denied | Yes, for emitted ACP permission requests | `src/providers/hermes/HermesProvider.ts`; `src/providers/base/AcpApproval.ts` |
| Kimi Code | Same scoped ACP native request/card/response bridge | Non-read permission requests denied | Yes, for emitted ACP permission requests | `src/providers/kimi/KimiCodeProvider.ts`; `src/providers/base/AcpApproval.ts` |
| Continue | `--readonly` in ask/auto-edit-with-ask tiers; `--auto` only in unrestricted tiers after this fix | `--readonly` | No; plain final-text transport | `src/providers/continue/ContinueProvider.ts` |
| Ollama | Receives model tool-call proposals but never executes them | No local execution | Not applicable to execution; `supportsToolUse: true` means proposal reporting here | `src/providers/ollama/OllamaProvider.ts` |
| LocalAI | Receives model tool-call proposals but never executes them | No local execution | Not applicable to execution; `supportsToolUse: true` means proposal reporting here | `src/providers/localai/LocalAIProvider.ts` |
| OpenRouter | Chat-only HTTP transport; `supportsToolUse: false` | No local execution | Not applicable | `src/providers/openrouter/OpenRouterProvider.ts` |

## Codex exec compatibility (2026-09-09)

Installed Codex 0.153.4 rejects `exec --full-auto` before starting a turn. Mysti
now emits `--sandbox workspace-write` for the same settings; the exact adapter
prefix with this replacement passes that CLI's parser in a help-only probe.
The [official non-interactive guide](https://learn.chatgpt.com/docs/non-interactive-mode)
recommends this replacement. The [earlier exec implementation](https://github.com/openai/codex/blob/rust-v0.114.0/codex-rs/exec/src/lib.rs#L218)
expanded the alias to workspace-write and selected `Never` for headless approvals;
interactive CLI alias descriptions are not evidence of exec approval semantics.
Read-only and explicitly unrestricted branches keep their separate sandbox flags.
This compatibility fix does not implement the app-server native approval bridge
or establish authenticated CLI execution; those remain acceptance work below.

## Remaining concrete defects and misleading promises

1. **The advertised approval contract is stronger than the mechanism.** `package.json:563` advertises “confirm every change”; Legacy Chat and collaborator stream-gate comments describe SIGSTOP as pre-execution enforcement. The provider interface now labels it as a best-effort pause. A JSON notification has no acknowledgement dependency. The CLI may run before the extension reads stdout, even if a later SIGSTOP succeeds. Existing tests mock `suspendRequest` and assert cards/flags; they do not prove a write is absent while approval is pending.
2. **Suspension does not stop an already spawned tool child.** `BaseCliProvider.suspendProcess` calls `proc.kill('SIGSTOP')` only on its direct process. An offline process fixture started a command child, emitted a tool-start event, then stopped the parent. Result: `suspended: true`, `toolSideEffectWhileStopped: true`. This demonstrates process semantics independently of a model call. Killing after denial cannot undo the effect.
3. **Zero-argument tools bypass the stream gate.** Direct Chat checks `Object.keys(input).length > 0` before gating (`ChatViewProvider.ts`, direct tool-use gate), as does the legacy subagent path (`_gateLegacySubagentToolUse`). A valid mutating tool with `{}` input never reaches the gate. The existing partial-input workaround needs an explicit event phase or a native permission request, not a nonempty-input test.
4. **OpenClaw authority never reaches the primary gateway.** `_sendViaGateway` sends prompt, thinking, session key and attachments; mode/access are merely prompt material. There is no owned local CLI process, so SIGSTOP cannot enforce gateway execution. Under default/read-only, the shared classifier delegates restrictions to native mode, but none is transmitted.
5. **OpenClaw fallback supplies nonexistent native flags.** Installed OpenClaw 2026.6.34 `dist/register.agent-turn-CfOzQ9g2.js:20` registers neither `--sandbox` nor `--yolo`; Mysti always adds one. Executing that registration with an inert action callback accepts the supported base arguments and rejects both flags with `commander.unknownOption`. No agent or model request ran. A repeated `agent --help` probe now completes, but help also accepts an invalid control flag and therefore cannot establish argument acceptance.
6. **Read-only selection is not uniform.** Cursor only omits `--force` despite installed explicit read-only `--mode plan/ask`. OpenCode chooses a configurable plan agent: official V1 docs describe edits/bash as `ask`, and user configuration can replace its policy. Neither choice establishes the absolute “never modify” setting promise.
7. **Capability vocabulary hides these differences.** `ProviderCapabilities.supportsNativeApproval` now distinguishes the implemented ACP bridge; native read-only strength and proposal-only tool reporting remain separate contract work. `supportsToolUse` covers actual CLI execution and Ollama/LocalAI proposals; callers cannot infer approval enforcement from it.

## Remaining acceptance requirements

The next adapter migrations must provide a native permission request and response path instead of relying on stdout notification timing. Gemini, Cline, Copilot, Qwen, and OpenCode expose ACP in the inspected CLI versions. Claude exposes a host permission protocol; Codex app-server exposes command/file approval requests. OpenClaw needs its gateway's actual approval and policy contract, and valid CLI fallback arguments.

OpenClaw's supported session exec controls (`execSecurity`, `execAsk`, `execHost`,
`elevatedLevel`) cover shell execution, not every built-in or plugin tool. Its
[pre-tool hook](https://docs.openclaw.ai/plugins/hooks) and
[blocking plugin approval contract](https://docs.openclaw.ai/plugins/plugin-permission-requests)
provide the integration point for a policy bound to a Mysti panel, session and
run. The bridge must verify policy registration before starting, route approval
requests into the owning native scope, deny on timeout/cancellation and prevent
late replies from reaching replacements. Local fallback needs the same policy
and an owned configuration/approval broker; dropping unsupported flags alone
would not preserve operation-mode authority. OpenClaw documents the distinction
between [exec approvals and general tool policy](https://docs.openclaw.ai/tools/exec-approvals).

For each adapter, verify its native configuration requests approval for every policy-gated action. ACP permits an agent to omit permission requests, so handling requests alone is not proof that all tools are gated. Pin or probe supported CLI versions and record evidence for writes, commands, deletes, network requests, and zero-argument tools. A configured native read-only mode must withstand repository configuration that otherwise enables writes.

A release acceptance fixture must assert: no side effect while approval is pending; none after denial/cancellation; one after approval; cancellation of the owning card on Stop/close/supersession; no late response into replacement processes; independent concurrent panels; and request-ID reuse across turns. Test actual provider startup/handshake/parser wiring as well as pure policy. Keep notifications separate from authority and make available operation modes reflect the implemented transport contract.

Run the focused suite with:

```sh
npx vitest run tests/providers/nativeApprovalBridge.test.ts tests/providers/base/nativeApprovalRequests.test.ts tests/managers/nativeApprovalRouting.test.ts tests/providers/nativeApprovalPolicy.test.ts
```

## Evidence used

- Installed, read-only `--help`/`--version`: Claude PATH 2.1.263 and preferred extension binary 2.1.266; Codex 0.153.4; Gemini 0.58.0; Cline 3.0.61; Copilot 1.0.83; Cursor 2026.02.13-41ac335; Qwen 0.23.0; OpenCode 1.18.29. Hermes/Kimi/Continue were not installed during this audit; native bridge behavior was verified with local protocol fixtures. No model/API calls made.
- [ACP tool-call permission protocol](https://agentclientprotocol.com/protocol/v1/tool-calls): distinguishes tool progress notifications from permission requests and requires cancelled outcomes on prompt cancellation.
- [Claude SDK approvals](https://code.claude.com/docs/en/agent-sdk/user-input): supported callback receives tool/input and returns allow/deny. Installed help additionally exposes print-mode host permission prompts.
- [Codex app-server](https://developers.openai.com/codex/app-server/): command/file approval requests have distinct IDs and native responses; installed app-server supports stdio.
- [OpenCode permissions](https://opencode.ai/docs/permissions/) and [agents](https://opencode.ai/docs/agents): build/plan policy semantics and configurability.

The [OpenClaw transport repair](OPENCLAW_TRANSPORT.md) adds protocol 4 negotiation,
run isolation, targeted cancellation, native event normalization and owned CLI
prompt delivery. It does not resolve the authority gaps above.
