# Providers and conversations

These are planned tests. Inherit fixtures, S/W/E/P profiles, invariants, evidence and status definitions from the [main plan](../47-comprehensive-feature-test-plan.md). P0/P1 are priorities, not measured results. Source links are relative to this file. All backend cases at the end inherit protocol BP; execute each backend independently, not once for the family.

## PC-01 — First-run setup, zero-install path and onboarding

**Surface/source:** Reachable; welcome/wizard/walkthrough/sidebar/new tab. [SetupManager](../../src/managers/SetupManager.ts), [onboarding](../../src/onboarding.ts), [chat onboarding](../../src/chat/onboarding.ts). **Priority:** P0.

**Real case:** In a fresh profile with no CLI, open Mysti from Activity Bar, command and shortcut; take the available coordinator/account route, cancel sign-in, skip setup, then install/configure a backend and send an F1 question. Repeat with one ready provider, multiple providers, stale credentials and untrusted workspace. Verify current setup step and detection correspond to the installed environment.

**Long/fault:** W: 30 open/close cycles, 10 wizard skip/resume cycles and 25 new chats while discovery runs; P: restart daily after each wizard stage. Stall one discovery call, fail installer, close initiating tab, and finish login from another window.

**Pass/evidence:** Usable editor/composer despite one unavailable backend, no duplicate setup workers, no credentials shown in transcript, user can recover without profile deletion. Steps persist appropriately and never mark cached metadata as successful inference. Save wizard transitions, process counts and first real answer. Existing starting coverage: [onboarding browser](../../tests/webview/onboardingBrowser.test.ts), [zero-install](../../tests/webview/wizardZeroInstallPath.test.ts), [wizard status](../../tests/managers/setupManagerWizardStatus.test.ts). New: multi-day actual installer/login journeys.

## PC-02 — Provider discovery, installation, updates and diagnostics

**Surface/source:** Conditional; provider menu, Install/Upgrade CLI, refresh, update commands and debug setup commands. [SetupManager](../../src/managers/SetupManager.ts), [CliDiscoveryService](../../src/services/CliDiscoveryService.ts), [CliUpdateService](../../src/services/CliUpdateService.ts), [CliModelUpgrade](../../src/services/CliModelUpgrade.ts). **Priority:** P0.

**Real case:** Use a clean disposable OS profile for each declared installer method. Discover a PATH install and custom path containing spaces; install missing backend; log in; request a model needing a newer CLI; follow Upgrade; confirm the exact selected binary version changes and real inference succeeds. Use diagnostics and debug success/failure setup paths without altering another panel.

**Long/fault:** W: 50 refreshes across 16 providers, concurrent menus in three panels, five cancelled/failed installs followed by retry. P: update one backend between sessions; leave an older binary earlier on PATH. Inject missing Node/package manager, terminal closed mid-install, permission denial and truncated/version-noise output; Windows `.cmd` paths included.

**Pass/evidence:** No install success inferred solely from command exit; path/version/auth errors remain actionable; unsupported auto-install shows honest instructions; updates do not silently switch provider/model. Capture sanitized terminal output, discovered path/version and successful post-update answer. Existing: [installer matrix](../../tests/providers/installerMatrix.test.ts), [execution](../../tests/managers/installerExecution.test.ts), [auth lifecycle](../../tests/integration/installerAuthLifecycle.test.ts), [upgrade](../../tests/integration/modelCliUpgrade.test.ts). New: real per-OS update soak.

## PC-03 — Backend authentication, expiration and recovery

**Surface/source:** Conditional; provider setup/auth actions and error/retry cards. [ProviderManager](../../src/managers/ProviderManager.ts), [SetupManager](../../src/managers/SetupManager.ts), [provider registry](../../src/providers/ProviderRegistry.ts). DeepMyst connection is also covered in CI catalog. **Priority:** P0.

**Real case:** For each supported auth method, begin signed out, cancel login, complete login and prove it with inference. Revoke a test credential after turn 5; attempt another turn, reauthenticate and continue the original task. Test bad API key, valid key without model entitlement and different signed-in accounts in two isolated profiles.

**Long/fault:** E: expire/revoke during discovery, stream, queued follow-up and idle; 20 auth failures with healthy sibling agents. P: rotate key/session overnight. Include stale local “authenticated” metadata with server rejection.

**Pass/evidence:** One actionable auth failure, no infinite retry, fallback or substitution presented as the requested agent; preserved partial sibling results; replacement credentials used on next request; no secret logging. Record account label, response codes, attributed transcript and request count. Existing: [auth detection](../../tests/providers/providerAuthDetection.test.ts), [Claude auth](../../tests/providers/claude/auth.test.ts), [Codex/Gemini auth](../../tests/providers/codexGeminiAuth.test.ts). New: real expiry/revocation across all adapters.

## PC-04 — Provider/model selection, effort, thinking, profiles and Ultracode

**Surface/source:** Reachable with capability-dependent controls; model/agent menus, actions menu, custom models, refresh/announcements, settings and slash controls. [manifest](../../src/providers/base/ProviderManifest.ts), [model registry](../../src/services/ModelRegistryService.ts), [capabilities](../../src/providers/base/IProvider.ts), [ChatViewProvider](../../src/providers/ChatViewProvider.ts). **Priority:** P1.

**Real case:** On F1 choose every supported effort level, a discovered and custom model, and a provider override. Change settings from both menus; check the outgoing actual request and receipt, not just selected text. Switch to a provider with no effective thinking/effort and verify honest controls. Exercise Codex profile, Cline Plan/Act and Claude Ultracode only on compatible CLI/account/model; verify incompatible choices produce recovery guidance.

**Long/fault:** W: 100 setting changes, 20 catalog refreshes, changes during 30 active/pending turns; P: removed model and old cached catalog after restart. Return malformed/empty discovery, duplicate model IDs across providers, lost catalog request and late response from previous provider.

**Pass/evidence:** Exactly intended model/provider/effort reaches backend; explicit overrides and per-conversation settings retain precedence; unsupported fields are not sent; stale catalog cannot overwrite current selection. Existing: [routed precedence](../../tests/providers/routedModelPrecedence.test.ts), [model refresh](../../tests/integration/modelAutoRefresh.test.ts), [persistent effort](../../tests/providers/persistentEffortRespawn.test.ts), [manifest UI](../../tests/webview/providerManifestWebview.test.ts). New: real per-backend settings sweep and request receipts.

## PC-05 — Streaming answers, rich rendering and message actions

**Surface/source:** Reachable; response/tool/thinking blocks, Markdown/code/diff/Mermaid, copy/open/apply/revert actions. [chat](../../media/chat/chat.js), [renderer](../../media/chat/markdownRenderer.js), [host](../../src/providers/ChatViewProvider.ts). **Priority:** P0.

**Real case:** Ask for code review with prose, table, code, diff, diagram, tool output and final answer. Exercise copy Markdown/code, open source location, apply a suggested edit and revert it; compare actual file bytes to the intended patch and preserve unrelated user edits. Include a final-only answer, thinking-only prefix and no tool-result provider.

**Long/fault:** W: 250 messages with 100 code blocks and 25 diagrams; E fixed-payload rendering/closing loop 500 times. Split Unicode/Markdown tokens, malformed Mermaid, huge output, HTML/script URLs, terminal event before final text, interrupted tool call and detached frame.

**Pass/evidence:** Ordered attributed content rendered once, no missing final answer or permanent spinner, sanitization blocks execution, old async render cannot replace a new chat. Copy preserves source and file actions use correct scope; memory/interaction gates apply. Existing: [renderer](../../tests/webview/markdownRenderer.test.ts), [sanitization](../../tests/webview/markdownSanitization.test.ts), [conversation lifecycle](../../tests/webview/conversationLifecycleBrowser.test.ts). New: real-editor long transcript and file-action round trips.

## PC-06 — Composer, draft preservation, queued follow-ups and second opinions

**Surface/source:** Reachable; composer send/Enter, Stop, queue and second-opinion actions. [chat](../../media/chat/chat.js), [host](../../src/providers/ChatViewProvider.ts). Attachments' content transport is EW coverage. **Priority:** P0.

**Real case:** Draft an F2 task with attachment; switch agents and menus without sending; request a second opinion on the last answer while preserving the draft. During streaming queue three amendments, cancel/reorder where controls support it, and switch conversations. Verify the next actual prompts and attachments belong to their originating chat. Mid-turn unsupported steering must queue, not silently inject/drop text.

**Long/fault:** W: 100 drafts, 50 queue bursts and 30 second opinions; E: interleave Stop, newline/IME composition, duplicate send, tab hide/reveal and final-only answers. P: explicitly test supported draft persistence boundaries without assuming unsent drafts survive every shutdown.

**Pass/evidence:** No accidental double send/lost in-memory draft or unrelated attachment leakage; submitted prompts appear once/in order; queue ownership survives chat navigation; Stop remains available after first token. Record composer snapshots and captured provider prompts. Existing: [browser lifecycle](../../tests/webview/conversationLifecycleBrowser.test.ts), [steering capability](../../tests/providers/steering.test.ts), [native conversation journey](../../tests-vscode/conversation.test.ts). New: keyboard/IME and real queue soak.

## PC-07 — Stop, clear session, shutdown and next-turn recovery

**Surface/source:** Reachable; Stop, clear/session reset and shutdown. [host](../../src/providers/ChatViewProvider.ts), [process cleanup](../../src/utils/processKill.ts), [CLI base](../../src/providers/base/BaseCliProvider.ts). **Priority:** P0.

**Real case:** Start actual analysis, then Stop before first token, mid-stream, during an approval and just before final. Queue a writer behind it. Clear native session without deleting historical messages, send a new nonce, then explicitly shut down an idle agent and send again. Observe actual process tree and filesystem.

**Long/fault:** W: 50 stop/recover cycles/backend; E: 100 races with panels closing/changing and delayed child exit. Disposable process fixture ignores TERM or leaves a native child after launcher exits; test Windows cancellation separately.

**Pass/evidence:** No queued file appears after Stop; approvals settle once; late old cleanup never kills a replacement request; no orphaned owned children; next turn works. Clear-session must discard the old native session/thread identity, but same-chat transcript replay may legitimately reintroduce its nonce; verify the intended history replay rather than demand amnesia. A genuinely new conversation must not recall the old nonce. Existing: [live conversations](../../tests-live/conversations.test.ts), [Copilot process ownership](../../tests/providers/copilot/processOwnership.test.ts), [process kill](../../tests/utils/processKill.test.ts). New: all-adapter real process/stream Stop matrix and 24h leak run.

## PC-08 — Conversation history, persistence, delete and recovery

**Surface/source:** Reachable; new/history/switch/delete, persisted messages/settings. [ConversationManager](../../src/managers/ConversationManager.ts). **Priority:** P0.

**Real case:** Create 20 tasks; verify automatic titles derive from the right first prompt, fallback works when title generation fails, and titles persist. Revisit oldest, verify exact ordered transcript, provider/model/config and context; delete one and verify unrelated chats remain. Delay title generation while switching/deleting its conversation and ensure the late title cannot rename another chat or resurrect the old one. Restart after completed response and after interrupted response. Distinguish intentional truncation of stored tool fields from message loss. Title generation is wired through [SuggestionManager](../../src/managers/SuggestionManager.ts) and the host's first-send path.

**Long/fault:** P: 1,000 turns/100 conversations, five restarts; E: store grows with large nested tool inputs. Inject disk-full/storage rejection, corrupt record, partial write, missing schema stamp and future schema in an isolated profile. Keep original bytes and compare recovery copy.

**Pass/evidence:** Acknowledged messages survive; bounded tool previews are flagged; unreadable/future stores are not silently overwritten; one clear diagnostic with intact recovery data. Deletion targets correct chat, stops its owned work and never resurrects it via late callbacks. Existing: [persistence](../../tests/managers/conversationManagerPersistence.test.ts), [resilience](../../tests/managers/conversationStoreResilience.test.ts), [message lifecycle](../../tests/integration/chatViewMessagePersistence.test.ts). New: real upgrade/disk-failure and multi-day store audit.

## PC-09 — Multi-panel, multi-window and workspace isolation

**Surface/source:** Reachable; sidebar + detached tabs, source-bound messages. [host](../../src/providers/ChatViewProvider.ts), [incoming identity](../../src/chat/incomingMessage.ts). **Priority:** P0.

**Real case:** Open three chats with different agents, task nonces, files, permissions and settings; run two concurrently; answer a question in one and stop another. Open a second editor window on F3 and repeat same native request IDs via controlled fixture. Switch/close an inactive chat while others stream.

**Long/fault:** W: 250 turns, 100 focus switches, 30 tab opens/closes; E: late events after reload and spoofed panel IDs through test harness; P: switch workspace roots and native profiles daily.

**Pass/evidence:** Every response/question/approval/context file stays with owner; stopped panel cannot cancel sibling; no provider-history nonce crosses panel/window; closed webview callbacks cannot mutate active state. Save per-panel ledger and provider request identities. Existing: [routing](../../tests/managers/providerManagerRouting.test.ts), [message isolation](../../tests/integration/chatViewMessagePersistence.test.ts), [native journey](../../tests-vscode/conversation.test.ts). New: installed VSIX multi-window/day-long verification.

## PC-10 — Conversation forks and branch history

**Surface/source:** Reachable; fork, rewind, fork-and-rewind. [ConversationManager](../../src/managers/ConversationManager.ts), [CheckpointManager](../../src/managers/CheckpointManager.ts). AR catalog owns full checkpoint/file semantics. **Priority:** P0.

**Real case:** At message 6 of an F2 task, fork and pursue a different requirement; return to original and compare bytes/metadata/message IDs. Fork a message with structured tool segments and checkpoint, then exercise fork-and-rewind with pre-existing user edits.

**Long/fault:** P: 50 forks, chains depth 10, 20 deletes and reloads; race a completing stream with fork and interrupt checkpoint lookup. Attempt invalid/deleted source/message and unavailable checkpoint.

**Pass/evidence:** Only prefix through selected message cloned, independent subsequent histories, original unchanged, stale stream belongs to old turn; failure does not leave misleading active chat or partially reverted code. Existing: [ConversationManager tests](../../tests/managers/conversationManagerPersistence.test.ts), [host integration](../../tests/integration/chatViewMessagePersistence.test.ts). New: real-editor fork tree plus checkpoint artifact comparison.

## PC-11 — Export, import, share links and clipboard

**Surface/source:** Reachable; JSON/Markdown export, JSON/JSONL/Markdown import, message copy and `vscode://DeepMyst.mysti/import` link. [ConversationManager](../../src/managers/ConversationManager.ts), [host](../../src/providers/ChatViewProvider.ts). **Priority:** P1.

**Real case:** Export a multi-agent conversation with code and attachments to supported formats; import into isolated profile and compare supported semantic fields. Share a short conversation and open it through URI handler; share a long one and verify documented bounds/fallback rather than assuming lossless full-history deep links. Cancel open/save dialogs.

**Long/fault:** W: 100 imports/exports, 25 share opens; P: old export versions, duplicate IDs and external source formats. Inject truncated JSONL, invalid roles/provider, malicious HTML, decompression bomb, >1MiB inflated share data, unwritable destination and clipboard denial in disposable environment.

**Pass/evidence:** Valid round trips retain promised fields and generate safe independent IDs; truncation/format limitations explicit; malformed data rejected safely with original store intact. Imports during active work cannot accept late old writes or leak native context; test this transition explicitly. Share link carries data, not a promised server-hosted share. Existing: [shareable import](../../tests/managers/conversationShareableImport.test.ts), [resilience](../../tests/managers/conversationStoreResilience.test.ts). New: actual URI/dialog/clipboard and import-during-stream cases.

## PC-12 — Capability truthfulness and unsupported backend controls

**Surface/source:** Reachable; per-provider capability-driven interface. [IProvider](../../src/providers/base/IProvider.ts), [manifest](../../src/providers/base/ProviderManifest.ts), [registry](../../src/providers/ProviderRegistry.ts). **Priority:** P1.

**Real case:** Capture actual manifest for all 16 adapters and compare rendered controls and a real operation for streaming, reasoning, native approvals, images/files, sessions/compaction, model selection, usage, prompt enhancement, tools and channels. Check manifest schema mismatch after extension update. Confirm Mysti/Brainstorm selections are distinct from concrete backends and Manus is not registered/selectable.

**Long/fault:** W: 160 provider switches and capability refreshes, including OpenCode CLI↔remote; P: cached webview from older schema; inject unknown provider and partial manifest. Combine unavailable models with unsupported permission modes.

**Pass/evidence:** No clickable no-op presented as supported; no tool receipt masquerades as pre-execution consent; missing usage is unknown; unsupported steering queues honestly; backend failures never fabricate success. Existing: [provider manifest](../../tests/providers/providerManifest.test.ts), [manifest webview](../../tests/webview/providerManifestWebview.test.ts), [enhancement contract](../../tests/providers/promptEnhancement.test.ts), [steering](../../tests/providers/steering.test.ts). New: evidence-backed capability ledger for each installed version.

## BP — mandatory real-backend protocol

Each PB case below is a separate feature test, with P0 priority for send/permissions/isolation and P1 for optional capabilities. Source and test folder are supplied per row. **Setup:** authenticated test account or controlled local endpoint, record CLI/version/model/capabilities; clean F1 then F2. Do not infer login from a cached identity file.

1. Run 25 real turns: explain seeded bug; locate file; propose minimal patch; execute only if capability and authority allow; run fixture oracle; ask revision; ask unrelated question; return to task; switch panel and query nonce. For stateless adapters verify declared no-recall contract rather than silently injecting history in the test.
2. For actual tool-capable transports, demonstrate Deny leaves canary untouched, Allow executes once, Stop prevents queued follow-up, and read-only cannot write. If transport cannot enforce requested restriction, assert preflight rejection before the prompt/tool runs. For chat-only or proposal-only transports, verify that tool-shaped output never executes on the host.
3. Exercise model/effort/attachments/native commands only as declared; include a definitely invalid model. Compare actual backend request/receipt and visible attribution. Send one >context-budget task and check error or compaction/recovery without losing unrelated state.
4. Run **W, 250 real turns/backend** with 25 cancellations, 20 panel/context switches, 10 idle/restart cycles, five changed requirements and fault injection at first-token/mid-stream/terminal boundaries. Run E on each transport representative and P for each continuity kind. Use fixture acceptance tests every 25 turns; check original constraint/nonces every tenth turn where continuity is promised.
5. Inject authentication/quota/network/process failures, preserve useful partial output, restore service and complete next task without reloading editor. No mocked success substitutes for missing inference. Record service-blocked rows separately.

**Pass/evidence for every PB:** all BP gates and provider-specific row pass; attributed transcripts, file oracle/diff, native request IDs or HTTP trace, usage/cost, process cleanup samples and availability errors stored. Existing tests below are starting points only; **W/E/P live provider coverage must be added/executed** for all rows.

| ID / backend | Current surface/source and distinct real-use steps | Long-session failure points and provider-specific oracle | Existing starting coverage |
| --- | --- | --- | --- |
| **PB-01 — Claude Code** | [Persistent CLI](../../src/providers/claude/ClaudeCodeProvider.ts). Implement F2 fix with native permission, question and plan interaction; resume task, native compact, change effort/Ultracode only if available. | BP W + E/P: 30 resume/interrupt cycles, parallel tool results, delayed terminal/background completion, rejected old CLI. Native request answered once; compaction preserves essential constraints; no unrestricted fallback if protocol fails. | [Claude tests](../../tests/providers/claude), [live transport](../../tests-live/providers.test.ts), [editor](../../tests-vscode/providers.test.ts) |
| **PB-02 — OpenAI Codex** | [CLI app-server](../../src/providers/codex/CodexProvider.ts). Same F2 task with native thread resume, named profile and explicit model; approve/deny actual write and test restricted external tool policy. | BP W + E/P: 30 thread resets, model/profile change while previous cleanup finishes, reused native IDs, app-server crash. Correct thread/model; no cross-panel nonce; denied mutation never occurs; external effects obey mode. | [Codex tests](../../tests/providers/codex), [live/editor](../../tests-vscode/providers.test.ts) |
| **PB-03 — Google Gemini** | [CLI](../../src/providers/gemini/GeminiProvider.ts). Review implementation, use supported tools/context and verify current model discovery; pair with Claude/Codex. | BP W; force unsupported-client/account response, noisy discovery and exit after partial stream. A rejected service never counts as success; healthy peer review retained; next valid account/model attempt recovers. | [Gemini tests](../../tests/providers/gemini), [live three-agent case](../../tests-live/conversations.test.ts) |
| **PB-04 — Cline** | [CLI](../../src/providers/cline/ClineProvider.ts). Plan then Act on F1; use current CLI settings/model contract and approval behavior. Start with an existing `.clinerules`, exercise temporary context injection, and compare original bytes after each turn. | BP W + single-shot E: repeated plan/act changes, missing native facilities, malformed events and plan output without execution. Run two Cline panels concurrently; cancel/crash during temporary `.clinerules` use and edit the file manually while a turn runs. Actual mode matches UI; accepted plans perform only authorized edits; no phantom tools or lost original/user-updated rules. Preserve file hashes and restored-state evidence. | [Cline compatibility/stream tests](../../tests/providers/cline) |
| **PB-05 — GitHub Copilot** | [CLI](../../src/providers/copilot/CopilotProvider.ts). Three-agent review; Auto and explicit model; writer under declared policy; no unsupported effort flag on Auto. | BP W + E: 50 stop/recovery cycles with wrapper/native children, pause/resume, wrapper exits first, delayed old cleanup. No running orphan or accidentally killed replacement; explicit model honored and unavailable model explained. | [Copilot tests](../../tests/providers/copilot), [live collaboration](../../tests-live/conversations.test.ts) |
| **PB-06 — Cursor** | [CLI](../../src/providers/cursor/CursorProvider.ts). Ask independent code review, inspect declared continuity and attachment/authority behavior; custom/API-key login as supported. | BP W: cached signed-in metadata while server requires login, repeated process spawn and stateless follow-up. No invented history/compaction support; real auth failure actionable; BP continuity oracle follows manifest. | [Cursor tests](../../tests/providers/cursor), [live attempted collaboration](../../tests-live/conversations.test.ts) |
| **PB-07 — OpenClaw** | [Gateway/local CLI](../../src/providers/openclaw/OpenClawProvider.ts). Pair compatible test gateway; compare gateway and fallback CLI; test explicit Full Access and rejected Ask/Read Only combinations. | BP W both transports, gateway E: 20 reconnects, duplicate events, pairing challenge rotation, remote rejection and gateway→CLI transition. Restricted prompts never dispatched; pairing not bypassed; no duplicate delivered work or fabricated usage. | [OpenClaw tests](../../tests/providers/openclaw), [live gateway](../../tests-live/openclaw.test.ts) |
| **PB-08 — OpenCode** | [CLI and HTTP remote](../../src/providers/opencode/OpenCodeProvider.ts). Configure/test remote server, directory and username/password; perform same task locally and remotely, compare transport-specific manifest/approval behavior. | BP W per transport; 20 endpoint/directory changes, Basic auth expiry, remote path missing, remote HTTP rejected except loopback, dropped stream and server restart. Work executes in intended remote directory; secrets hidden; changing transport refreshes controls and cannot resume wrong session. | [OpenCode remote/setup/stream](../../tests/providers/opencode) |
| **PB-09 — Qwen Code** | [CLI](../../src/providers/qwen/QwenCodeProvider.ts). Implement/review task with supported authority and discovered/custom models; join two other agents with explicit attribution. | BP W: no account, CLI crash, partial tool/result stream, model removal and restart. Gate behavior matches real CLI; no silent substitution, missing terminal state or skipped contribution reported as complete. | [Qwen tests](../../tests/providers/qwen), [conditional live collaboration](../../tests-live/conversations.test.ts) |
| **PB-10 — Hermes** | [ACP](../../src/providers/hermes/HermesProvider.ts). F2 task with native ACP permission, supported file/image context and native command discovery; backend-configured model versus override as supported. | BP W + ACP E/P: cancel while initialize/session/permission awaits, duplicated JSON-RPC IDs, protocol EOF and unexpected fs/terminal requests. One response per native ask; no unsupported single-shot fallback; session/questions isolated. | [Hermes tests](../../tests/providers/hermes), [ACP approval](../../tests/providers/base/acpApproval.test.ts) |
| **PB-11 — Kimi Code** | [ACP](../../src/providers/kimi/KimiCodeProvider.ts). Same real task plus reasoning blocks and images/files, actual approval and resumed follow-up. | BP W + ACP E: 30 interruptions/resumes, partial JSON-RPC, process restart during approval, reasoning-only response then final. No stale callback to replacement, lost final answer or automatic unrestricted fallback. | [Kimi parsing](../../tests/providers/kimi), [ACP approval](../../tests/providers/base/acpApproval.test.ts) |
| **PB-12 — Continue** | [CLI](../../src/providers/continue/ContinueProvider.ts). Select locally configured backend/model; review and authorized edit where supported; validate arguments against current CLI behavior. | BP W: absent backend config, unknown model, output format drift, exit 0 with empty result and repeated start/stop. Configuration failures visible; no success from empty output; actual mode and model match request. | [Continue tests](../../tests/providers/continue) |
| **PB-13 — Ollama** | [Local server](../../src/providers/ollama/OllamaProvider.ts). Offline review using installed local model; choose model/context length/keep-alive/temperature; send tool-shaped proposal. | BP W + HTTP E: unload/reload model, restart server, request timeout, context pressure and absent model. Proposal displayed without host execution; unavailable usage/features honest; endpoint/config changes not masked by cached discovery. | [Ollama tests](../../tests/providers/ollama) |
| **PB-14 — LocalAI** | [HTTP endpoint](../../src/providers/localai/LocalAIProvider.ts). Repeat offline/self-hosted review with optional API key, model, token/timeout/effort settings supported by adapter. | BP W + HTTP E: 401 after rotation, server restart, fragmented SSE and model swap. Tool proposals do not execute; timeout cancellation closes request; correct endpoint/model and protected key; no stale auth/discovery cache. | [LocalAI tests](../../tests/providers/localai) |
| **PB-15 — OpenRouter backend** | [HTTP chat adapter](../../src/providers/openrouter/OpenRouterProvider.ts). Select available model and review F1; compare to separate Mysti coordinator route without confusing them. | BP W + HTTP E/P: 429, insufficient entitlement, model removed, SSE stalls, cache-token convention changes. Chat adapter never executes tool suggestions; actual provider/model/cost shown and service failures terminate visibly. | [OpenRouter tests](../../tests/providers/openrouter), [client](../../tests/services/openRouterClient.test.ts) |
| **PB-16 — MiniMax** | [HTTP adapter](../../src/providers/minimax/MiniMaxProvider.ts). Authenticate through setup/environment, choose allowed base URL, model and generation limits, review F1 with reasoning output. | BP W: malformed endpoint rejected, API key rotates, partial SSE, empty final and request timeout. Only configured allowed endpoint used; no tools executed; reasoning/final separated, unknown usage honest, recovery succeeds. | [MiniMax tests](../../tests/providers/minimax/provider.test.ts) |

No successful-inference assumption is inherited from earlier tests. The previous reliability pass had usable Claude/Codex/Copilot accounts, Gemini service rejection, Cursor login failure and unauthenticated OpenCode/Qwen. Recheck all prerequisites at execution time; none of those historical observations establishes today's availability.
