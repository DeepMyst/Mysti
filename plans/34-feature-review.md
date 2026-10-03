# Mysti feature review and validation plan

Review date: 2026-09-30. Baseline: `0818755`. Extension: 0.5.1.

## Verdict after implementation

**Codex and Claude now pass actual Mysti chat tests, including pre-execution Deny and Allow.** Their adapters use mandatory native permission transports; process and conversation cleanup, custom Codex model routing, and native session continuity have regression coverage. Real adapter tests also passed with permissive Claude settings supplied explicitly on the command line. The real VS Code 1.140.0 suite passed **9/9**, including both provider journeys and Canvas rendering, computed styling, interaction and persistence.

The complete automated suite passed **13,479 tests across 418 files, zero failures/skips**, using four workers to avoid competing browser/compiler workloads. The initial implementation run found an outdated Codex compaction expectation (corrected for native resume) and a Canvas compiler test exceeding its five-second deadline during concurrent editor/build work. Its targeted run and the controlled full run passed without increasing the timeout. Baseline results are preserved in the evidence JSON.

**The whole product is not signed off.** Mysti's coordinator has extensive passing deterministic coverage, including routing, tools, delegation, account recovery, spend controls and cancellation, but no DeepMyst/OpenRouter credential is available to this isolated review profile. Its authenticated production journey remains blocked. OpenClaw now negotiates protocol 4 and authenticates; the local gateway then rejects its configured `anthropic/claude-opus-4-5` model as missing from its provider catalog. This is recorded rather than changing the user's gateway configuration. Other account-dependent integrations and Linux/Windows journeys remain explicitly unverified.

The review identifies all contributed controls and **66 feature groups**. Automated coverage is distinguished from actual editor/account evidence in each row; the inventory includes literal test references as a navigation aid, not automatic sign-off.

## Composer menu follow-up — 2026-10-01

Applied the supplied Claude menu references: searchable action groups, model descriptions with a colored checked selection, and a discrete blue effort slider shared by both menus. Claude, Codex and Mysti expose their supported levels; providers without effort controls hide the slider. The [October 1 follow-up](35-menus-installers-signin-review.md) adds a functional Claude Ultracode switch, shared across the menus and Settings, and restores the visible slash-command button.

Validation: **174/174 targeted Chromium tests** across composer, settings hub and agent menus, including seven new interaction checks covering keyboard model selection, posted effort changes, action filtering, provider switching, dismissal during generation, narrow/theme layouts and long catalogs. JavaScript lint passed with no errors. These checks use controlled host messages; the earlier live-provider findings remain separate. The full-suite count above records the earlier review, not a new full-suite run for this UI follow-up.

## Evidence and scope

CLI compatibility recovery follow-up (2026-10-01): explicit model minimum-version failures now offer an Upgrade CLI action. Claude uses its detected executable's native installer; npm-backed providers install a release at least as new as the required version, with the existing Node compatibility constraint respected. A visible VS Code task reports exit/failure/cancellation, then forced discovery verifies the actual selected binary. Compatible versions are not reinstalled, and idle persistent processes are replaced without clearing native conversation IDs. Validation passed **314 targeted tests**, type-checking, and lint with no errors. No installed CLI was changed during implementation validation; installer execution was exercised with controlled task events and version probes.

- [Machine-readable surface inventory](34-feature-review-inventory.json): all **31 contributed commands**, **188 configuration keys**, **4 contributed keyboard shortcuts**, **6 walkthrough steps**, **142 chat host actions**, and **34 static slash-dispatch cases**, plus contributed menus. Every contributed command has a registration in `extension.ts`. Internal host actions are included for completeness; they are not all independent user features.
- [Automated and live CLI evidence](34-feature-review-evidence.json): relative test-file paths and results; sanitized live event types/results, without tokens, account details or complete provider logs.
- The functional matrix below groups related controls into user journeys. Inventory entries are a completeness backstop, **not** claims of per-control end-to-end coverage. Dynamic native slash commands, discovered models, imported skills and connected tools require testing against the installed account/catalog.
- Sources: `package.json`, `src/extension.ts`, `src/providers/ProviderRegistry.ts`, `ChatViewProvider._handleMessage`, `SlashCommandManager`, `sessionShapes.ts`, `src/canvas/protocol.ts`, `src/chat/settingsHub.ts`, browser assets, existing tests, and the actual installed CLIs. Existing README/provider guides omit newer features, so they were not used as the sole feature inventory.
- Tests use a mocked VS Code API unless explicitly identified as real-editor tests. Browser tests run actual Chromium with controlled host messages. Passing either does not establish provider account entitlement or remote service availability.

Historical baseline sandbox run: 13,100 passed, 68 failed, 286 pending, with loopback `EPERM`, Chromium launch failures and nested sandbox restrictions. Re-running outside those restrictions produced the all-pass result above. These were environment failures, not fixed product defects or ignored tests.

## Findings and corrections

| ID | Priority / state | Evidence and user impact | Required resolution / acceptance |
| --- | --- | --- | --- |
| F01 | P0 corrected for Claude/Codex | Replaced notification/SIGSTOP authority with Claude SDK control requests and Codex app-server requests. Native host absence/denial/cancellation cannot execute a tool; transport failure cannot downgrade. Codex disables external MCP/apps in restricted tiers. | Real CLI adapters and real editor permission cards passed. Process fixtures cover missing owner, pending side effects, ID reuse, Stop, late Allow, session clear and parallel panels. Other legacy providers retain the limitations in [native approval contracts](../docs/NATIVE_APPROVAL.md). |
| F02 | P1 adapter corrected; live model prerequisite blocked | Protocol range 3–4; signed Mysti device identity in SecretStorage; per-run stream filtering/cancellation; no duplicate final text; permanent rejection stops reconnect loops. OpenClaw config now uses a real JSON5 parser so URL strings do not break token loading. Invalid `--sandbox`/`--yolo` options removed. | Gateway authentication succeeds. A model-backed turn fails because the user's configured model is absent from the gateway catalog. Configure a valid model/account, then rerun the opt-in live gateway test. Restricted modes now return a clear error before execution. |
| F03 | Packaging corrected | `.superpowers` and `.remember` development state no longer ships; opt-in live test files are excluded too. | Package shape and archive contents checked on the generated VSIX; see final results. |
| F04 | Real-editor test corrected | Locate Canvas Email by accessible label. Wait for the latest rendered artboard count rather than compare a stale asynchronous report. | Real editor fill/value and persisted reopen assertions pass. |
| F05 | Documentation reconciled | Updated provider roster, removed selectable Manus claims, corrected Claude setting name across translations, Codex/Gemini/OpenClaw authentication examples and Copilot package name. Added Mysti/Hermes/Kimi/Continue/OpenRouter setup and transport limitations. | Registry/manifest/source cross-checks complete. Fresh login/install with every external account is not claimed. |
| F06 | Account prerequisite blocked | No DeepMyst/OpenRouter credential in the isolated profile or supplied environment. | Execute M01–M09 with a disposable signed-in profile. No credentials were extracted from another VS Code profile. |
| F07 | Investigated; no reproduced Canvas style defect | CSP messages originate in VS Code's outer `vscode-webview://…/index.html` frame with a nonce-only style policy. The design iframe renders and its input computes the expected 10px padding and usable width. | Real-editor interaction and computed CSS passed. CSP was not weakened. Broader visual/theme review remains in U66. |
| F08 | Codex routing corrected | Provider-scoped custom dropdown models and the explicit built-in default reach app-server; a model belonging to a different provider is rejected. Profile/mode/access changes respawn the transport. | Registry-to-provider regression passes; actual answering models selected explicitly in live tests. |
| F09 | Session cleanup corrected | Clearing a chat now aborts its request and disposes its persistent process before dropping the native session ID. | Both real adapters and concurrent process fixtures pass; late approval cannot authorize a replacement turn. |
| F10 | Suggestions preference corrected | `showSuggestions=false` previously still called the background suggestion model. The host now checks before requesting and before posting a completed result. | Regression verifies no provider call or loading UI when disabled. |


## Status legend and priorities

**A** = relevant automated scenarios passed; the listed manual/live acceptance remains pending unless explicitly stated. **L** = narrowly described live check passed. **O** = observed defect/contract gap. **R** = inventoried/source-reviewed; no dedicated behavioral coverage established here. A row can be A/O: tests passing does not invalidate a wider real-world defect.

P0: consent, isolation, data loss and unintended spend. P1: core journeys and release failures. P2: secondary integrations, discoverability and polish. Use a temporary workspace with a small text file, a failing test, an image, and an intentionally slow command. Record editor/OS/CLI/model versions and account route. Give each journey an evidence reference and an owner before closing it.

## Provider review

There are **15 registered backends plus the Mysti coordinator**, which has its own execution path. `ManusProvider.ts` is present but not registered; do not advertise it as an available provider.

| Agent/backend | Current evidence | Required live acceptance |
| --- | --- | --- |
| Mysti | A: `tests/coordinator/*`, `tests/services/coordinator*`, `collaboratorPool*`, `mysti*`, `tests/integration/mysti*`; F06 | Signed-in answer, read/tool loop, approved edit, deny, Stop, native child, CLI delegation, free fallback and spend approval. |
| Codex | A: protocol/routing/lifecycle fixtures. L: actual app-server adapter and VS Code chat, two-turn memory and native Deny/Allow; F01/F08 corrected | Full C01–C09 journey in Mysti; selected/custom model and profile must match the actual run. |
| Claude Code | A: native control/lifecycle/parser fixtures. L: actual adapter and VS Code chat, two-turn memory and Deny/Allow; explicit permissive settings adversarial check; F01 corrected | Full C01–C09 including a second persistent turn, resume after restart, compact, Stop and post-Stop recovery. |
| Gemini | A: args/parser/permissions/discovery/conformance | Login, text/tools, model/effort, plan behavior and Stop; prove any approval guarantee separately. |
| Cline | A: modern/legacy CLI compatibility, flags/parser/conformance | Installed CLI variant, auth, plan/act and cancellation. |
| GitHub Copilot | A: args/discovery/parser/permissions | Subscription entitlement, selected model, modern/legacy behavior and denied tools. |
| Cursor | A: args/parser/permissions/conformance | Login, selected model, force/plan semantics and Stop. |
| OpenClaw | A: protocol4 socket, signing, policy, isolation/cancellation and CLI parser fixtures. L: authenticated handshake; model execution blocked by gateway configuration (F02) | Protocol-compatible gateway authentication/stream/reconnect plus independent CLI fallback. |
| OpenCode | A: args/models/parser/permissions/conformance | Configured backend, model IDs and native build/plan permissions. |
| Qwen Code | A: args/models/parser/permissions/conformance | Auth, auto-edit versus ask behavior, tools and Stop. |
| Hermes | A: ACP parser/conformance and real local approval fixture | Installed Hermes ACP handshake plus one real denied/allowed operation. |
| Kimi Code | A: ACP parser and shared native bridge fixtures | Installed Kimi authentication, ACP session and denied/allowed operation. |
| Continue | A: args/parser and native permission-policy fixtures | `cn` config/models, readonly tier, auto tier and completion/error reporting. |
| Ollama | A: model discovery and streaming fixtures | Running local server, installed model, timeout/Stop and honest tool-proposal capability. |
| LocalAI | A: discovery and streaming fixtures | Endpoint/key, actual model, images where supported and timeout/Stop. |
| OpenRouter | A: HTTP client/provider/model-discovery fixtures | Direct key, free and explicit paid model, rate limit, cancellation and attribution. |

### Codex and Claude acceptance sequence

Run separately for each provider, from the Mysti sidebar and an editor tab. A direct terminal reply alone does not close these rows.

| ID | Priority | Steps and pass condition | Review state |
| --- | --- | --- | --- |
| C01 | P1 | Fresh profile → select provider → detect CLI → authenticate → refresh. Missing binary and signed-out states show the right recovery action; successful auth enables Send. | A; installed/login checks L |
| C02 | P1 | Send a unique marker prompt. Partial text renders, response finishes once, spinner clears, history contains the exact final answer. | A/L: actual adapter and editor chat passed |
| C03 | P1 | Set default, alternate, custom and invalid models; set effort and Codex profile. Confirm actual model/argv, truthful errors and restored per-conversation selection after provider switching. | A/L: explicit live model; custom/catalog routing regression passed; alternate account/profile acceptance pending |
| C04 | P1 | Read a fixture, search it, attach an image and reference a selection. Tool/result cards and context match the issuing panel; no duplicate output or inaccessible attachment. | A; live pending |
| C05 | P0 | Request a marker-file edit and shell operation. Hold approval; inspect disk before approval. Deny, allow, timeout, Stop and close-panel variants obey the decision. | A/L: actual file edit Deny/Allow passed; process fixtures cover Stop/clear/late decisions and command approval; live timeout/network variants pending |
| C06 | P0 | Plan and read-only modes request the same edit. No workspace write occurs; leaving plan mode requires the intended user action. | A/L: actual read-only adapters refused writes even with an approving host; plan-exit UI uses fixtures |
| C07 | P1 | Send a follow-up referencing turn 1; reload and reopen. Both providers resume their native sessions with intended context. | A/L: two-turn memory and native resume after process disposal passed; full editor restart acceptance pending |
| C08 | P0 | Cancel a slow turn; immediately send another in the same panel and run a second panel concurrently. No orphan processes, late completion, cross-panel approval or cancelled-run persistence. | A/L: real Stop during approval and recovery passed; concurrent panel/late callback cases use process fixtures |
| C09 | P1 | Force invalid model/auth failure/process exit/network stall. Error is visible, terminal state is emitted once, user can recover without reloading the editor. | A; live pending |

### Mysti coordinator acceptance sequence

| ID | Priority | Steps and pass condition | Review state |
| --- | --- | --- | --- |
| M01 | P1 | No key → sign-in card; valid DeepMyst login → streamed answer; explicit direct OpenRouter key → intended route. A gateway key never goes to another domain. | A; live pending |
| M02 | P1 | Run the default free chain and select an explicit model. Verify answering-model attribution, 404/429 fallback before output, and no mixed response/replayed tools after output starts. | A; live pending |
| M03 | P0 | Exhaust free models and trigger paid advisor/fallback/child. No unapproved paid call; per-turn budget and denial are honored; failed budget decisions terminate visibly. | A; live pending |
| M04 | P1 | List/read/search fixture files through native tools, then an explicitly enabled MCP tool. Display results, preserve untrusted-data boundaries and continue to a useful answer. | A; live pending |
| M05 | P0 | Local execution off/on × trusted/untrusted workspace × read-only/ask/full. Edit and shell must be absent or refused when disallowed; denied writes leave no side effects; sandbox and cancellation work. | A, including real local sandbox fixtures; model journey pending |
| M06 | P0 | Delegate read-only work to a Mysti child and a CLI collaborator; then a writer with approval. Child capabilities cannot exceed parent authority; sibling/parent cancellation and questions route correctly. | A; live pending |
| M07 | P1 | Run cross-review/verification, retry a failed child, view Agent Map and background jobs. Exactly one terminal state per child; no invisible retries or lost results. | A; live pending |
| M08 | P0 | Invoke staged capability publication, deny, approve, run with literal shell-looking arguments, revoke. Approval occurs before execution; quarantine preserves bundled assets. | A; live pending; extend [existing capability smoke checklist](23-smoke-checklist.md) |
| M09 | P1 | Interrupt, compact, reopen, prune memory, and simulate rejected credentials/credits exhaustion. Recovery action fits the failure, remembered context is bounded, usage/cost is attributed once. | A; live pending |

## Complete functional review matrix

Test references below are filenames under `tests/` unless a path is shown. They identify relevant exercised behavior, not exhaustive proof of every sentence in the acceptance column. Every A row still needs the listed live/manual journey before full product sign-off.

### Entry, setup and configuration

| ID | User-facing feature | Automated evidence / state | Manual acceptance |
| --- | --- | --- | --- |
| U01 | Activity-bar chat, command palette, editor tabs, keyboard shortcuts | A: real-editor activation, `identityFromManifest`, `chatComposerBrowser`; shortcuts R | Open from each entry point; correct focus; independent tabs; shortcut conflicts documented. |
| U02 | Get Started walkthrough and packaged illustrations | A: `walkthroughSteps`, package checks | All six steps navigate correctly and images appear in the installed VSIX. |
| U03 | Provider wizard: detect, install methods, auth, skip/retry, diagnostics | A: `onboarding`, `onboardingBrowser`, `setupManagerWizardStatus`, `chatViewWizardRouting`, `wizardZeroInstallPath` | Fresh profile, missing CLI, failed install and existing account all lead to a working first task. |
| U04 | Getting-started card, suggested first task and once-only tips | A: `onboarding*`, `slashCommandModeHelp` | Completion/dismissal persists; tips can be disabled; no repeated interruption. |
| U05 | Agent/model selection and dynamic availability | A: `providerManifest*`, `agentSelectionStability`, `ModelRegistryService`, `modelsUpdatedWebview` | Switch all registered backends; hidden/unsupported controls remain honest; provider outage is recoverable. |
| U06 | Custom models, discovered models, reasoning/thinking/effort | A: `routedModelPrecedence`, `persistentEffortRespawn`, `effort`, provider argument suites | Actual run uses selection; custom model survives reload and provider switch; invalid selection fails visibly. |
| U07 | Model announcements, refresh, CLI update notices/actions | A: `ModelAnnouncementService`, `CliUpdateService`, `CliDiscoveryService`, `modelAutoRefresh` | Dismiss/update/refresh work; unsuccessful update preserves a usable CLI and reports why. |
| U08 | Mysti settings hub, per-chat binding and settings persistence | A: `settingsHub`, `settingsHubTab`, `settingsHubBrowser`, `chatViewSettingKeys`, `settingsScope*` | Every inventoried setting round-trips through its intended scope; closing/rebinding origin chat cannot change another chat's authority. |
| U09 | Connections, agents, badges and about sections in the hub | A: `webviewContentHubView`, `agentMenuLayoutBrowser`, hub suites; badge fulfillment R | Open each section; edit/share actions target correct state and show usable feedback. |
| U10 | Provider install/update/debug command palette actions | A: manifest registrations and setup suites; diagnostic UI R | Exercise each applicable inventory command in a disposable profile, including intentional setup failure. |

### Chat and conversation workflow

| ID | User-facing feature | Automated evidence / state | Manual acceptance |
| --- | --- | --- | --- |
| U11 | Compose/send, multiline text, keyboard operation, queued steering and Stop | A: `chatComposerBrowser`, `steering`, `delayedChannelTurns`, lifecycle suites | Send with keyboard/button; steer a running turn; Stop enables an immediate new turn. |
| U12 | Streaming text/thinking, usage, model attribution and tool/result cards | A: provider conformance, `unifiedMessageRenderer`, `modelAttribution*`, `tokenAccounting` | No duplicated chunks; restored answer matches live rendering; errors do not leave spinners. |
| U13 | Markdown, fenced code, Mermaid, links, copy buttons and sanitization | A: `markdownRenderer`, `markdownSanitization`, `mermaidBrowser`, `inlineHandlerCsp` | Code copies faithfully; diagrams render; links work; untrusted HTML cannot execute. |
| U14 | Context from Explorer/editor selection, file picker and automatic active editor | A: `contextManager*`, `chatViewTrustAndGate` | Correct file/selection and path appear; auto-context obeys setting; unrelated panel remains unchanged. |
| U15 | Drag/drop paths, enable/remove/clear context and file mentions | A: `chatComposerBrowser`, `mentionParsing`, `stateMentions`, context suites | Files added once; removed/disabled files absent from next prompt; missing/large files explain failure. |
| U16 | Images and file attachments | A: `attachmentsAcrossProviders` | Supported providers receive readable files; unsupported provider behavior is explicit; temp files clean up on cancel. |
| U17 | Agent mentions, sequential routing, role autocomplete and consultation | A: `mentionRouter`, `mentionParser`, `roleAutocomplete`, `slashCommandCollaboration` | Intended agents receive scoped context; response order and approvals remain panel-bound. |
| U18 | Quick actions, suggestions, persona recommendations and prompt enhancement | A: `enhanceAffordance`, `promptEnhancement`, `suggestionPreference`; recommendation UX R | Each visible button produces its promised action; enhancement available only for supported providers. |
| U19 | New/clear conversation, switch history, delete and crash-safe persistence | A: `conversationManagerPersistence`, `conversationStoreResilience`, `chatViewMessagePersistence` | Reload restores content/settings; delete affects one conversation; interrupted save cannot wipe history. |
| U20 | Fork, checkpoint, rewind, fork-and-rewind and changed-file navigation | A: `checkpointArtifactTracking`, `checkpointRetention`, `shadowDiff`; full click journey R | Restore chosen content without overwriting unrelated subsequent edits; diff/changed-file targets are correct. |
| U21 | Apply edit, revert edit, open file/line and file decorations | A: `mystiPatch`, `shadowDiff`; editor/decorations R | Apply/revert modifies intended file only; navigation lands on expected line; decorations expire as configured. |
| U22 | Export/import JSON/Markdown, copy message and share/deep-link import | A: `conversationShareableImport`, `deepLinkImportConfirmation`, `slashCommandsAllLive` | Round-trip content; malformed import does not replace data; shared content imports only after intended confirmation. |
| U23 | Slash menu, search, `/help`, `/mode`, provider native commands and Codex profiles | A: `slashCommandsAllLive`, `nativeCommandMenu`, `nativeCommands`, `slashCommandModeHelp`, `claudeReportedCommands` | Every static action and every actually discovered native entry has a visible effect; unsupported commands stay hidden. |
| U24 | Plan detection, plan selection, skip and exit-plan mode | A: `pendingPlanStore`, `chatPlanIsolation`, `trustLadderConformance` | Selected plan executes in originating chat only; dismiss/skip unlocks composer; old cards cannot authorize new runs. |
| U25 | User questions, skip/custom answers and child-agent questions | A: `askUserQuestion`, `subAgentQuestions`, `askUserQuestionResponse` host path | Answers reach the asking run; Stop/close cleans pending questions; stale answers are ignored. |
| U26 | Per-panel isolation, shutdown/restart and idle lifecycle | A: `providerManagerRouting`, `chatJobOwnership`, `agentLifecycleManager`, persistent/single-shot lifecycle | Two chats can run independently; idle teardown does not kill active children; shutdown releases processes. |

### Permissions, autonomy and memory

| ID | User-facing feature | Automated evidence / state | Manual acceptance |
| --- | --- | --- | --- |
| U27 | Read-only / ask / full access; mode switching and trust ladder | A: `settingsClamp`, `trustLadder*`, `nativeApprovalPolicy`; F01 corrected for Claude/Codex | Workspaces can lower but not raise authority; actual tools honor mode and approval. |
| U28 | Approval card detail/diff, allow/deny/custom instruction and timeout | A: `permissionCard*`, `chatPermissionLifecycle`, `permissionGrantScoping`; F01 corrected for Claude/Codex | Full intended operation shown before execution; decisions scoped to one operation/run; no unconsented side effects. |
| U29 | Semi/full autonomous continuation, safety modes and task queues | A: `autonomousContinuationGate`, `safetyClassifier`, `permissionGating` | Toggle/confirm/stop works; prohibited command stays blocked; session duration and continuation bounds hold. |
| U30 | Autonomous audit log, statistics and learned approval/question memory | A: `memoryManager`, gate suites; audit UI R | Recorded decisions are accurate, pruning works and stale learned answers cannot override hard restrictions. |
| U31 | Token/context meter and native/manual/automatic compaction | A: `compactionTokenMath`, `compactionOwnership`, `smartCompactor*`, provider context-window tests | Meter matches actual usage convention; threshold fires; pending turn/other panel unaffected; essential context remains. |
| U32 | Durable Mysti memory, retrieval, view/prune, workspace memory/rules | A: `mystiMemoryStore`, `retrievalCoordinator`, `smartCompactorMemory`, slash wiring | Memory can be inspected/pruned; project rules and recalled evidence apply to the intended workspace. |
| U33 | Boost profiles, caching, savings/cost ledger and session summary | A: `boostManager`, `boostLedgerWiring`, `savingsLedger`, `promptCache`, `modelPricing` | Display actual versus estimated amounts clearly; cached tokens are not counted twice; summary opens and survives reload. |

### Collaboration and agent customization

| ID | User-facing feature | Automated evidence / state | Manual acceptance |
| --- | --- | --- | --- |
| U34 | Brainstorm Quick/Debate/Red-Team/Perspectives/Delphi strategies | A: `brainstormManager`, `brainstormCorrectness`, `brainstormIsolation` | Run each strategy; rounds/convergence/synthesis are coherent; failure of one agent is visible and recoverable. |
| U35 | Review, Panel, Critique, Race and Brainstorm sessions | A: `sessionManager`, `sessionFlow`, `sessionPicker` | Agent-count constraints, estimates, lane progress, cancellation and choosing race results work for each shape. |
| U36 | Agent Map, subagent cards, progress, retry, background jobs and cancellation | A: `agentMap*`, `subAgentCards`, `backgroundJobManager`, `chatJobOwnership` | Parent/child relationships reflect actual activity; terminal and cancelled jobs do not remain active. |
| U37 | Collaborator roles, access, maximum concurrency and native child agents | A: `collaborationRoleAccess`, `collaboratorPool*`, `mystiSubagentRunner`, `orchestratorDag` | Limits enforced; writer serialization/read-only parallelism correct; child never gains parent-excluded tools. |
| U38 | Advisor selection, verification/cross-review and paid budget | A: `advisor`, `paidSpendGuard`, `coordinatorTurnRunner` | Subscription preference and explicit paid fallback work; no hidden spend when budget is denied. |
| U39 | Select/create personas, skills and roles; custom prompts and recommendations | A: `agentLoader*`, `agentMarkdown`, `coordinatorPersona`; creation UI R | Create/reload/select each kind; prompt reflects choice; duplicate/conflicting definitions resolve predictably. |
| U40 | Import skills from GitHub, discover cross-client skills, reload and detail views | A: `skillDiscoveryService`, `crossClientSkills`, `crossVendorInstructions`, `skillIndex` | Valid import is discoverable; unavailable source explains error; untrusted imports do not silently gain execution. |
| U41 | Trust badges, staged agent proposals, review/install and quarantine | A: `agentTrustTier`, `roleTrustBadge`, `skillStaging`, `trustLadderConformance` | Review opens exact artifact; executable promotion uses its required approval; quarantine is reversible and preserves bundled agents. |
| U42 | Capability publication, sandboxed skill execution and catalog report | A: `capability*`, `skillTelemetry`, `observedRuns`, `skillAuthoringInvariants`, `mystiSandbox` | Full script/args shown; evidence precedes promotion; report handles low samples honestly; literal arguments stay literal. |

### Accounts, integrations and teamwork

| ID | User-facing feature | Automated evidence / state | Manual acceptance |
| --- | --- | --- | --- |
| U43 | DeepMyst sign-in, callback, sign-out and auth/credit recovery | A: `deepMystAuthManager`, `DeepMystClient`, `coordinatorFailureClassifier` | Fresh and stale sessions recover; sign-out removes owned integration state; billing/sign-in buttons target the right service. |
| U44 | Connections panel, service-link cards, enable/disable and refresh | A: `DeepMystClient`, `McpConfigManager`; remote UI R | Link a disposable service; connected state updates; disabled service is unavailable to next run. |
| U45 | MCP tools/config injection, schema changes and approval pins | A: `mcp*`, `McpConfigManager`, `canvasMediaService`, `outboundUrlPolicy` | Handshake with actual configured CLI/service; changed tool description requires review; sign-out removes only Mysti-owned entries. |
| U46 | Active Mode, channel connect/disconnect, integration toggles and daemon controls | A: `activeModeManager`, `channelBridge`, `channelReplyFencing`; O: gateway F02 | External reply reaches only its conversation; disconnected/closed chat cannot receive stale work; daemon status truthful. |
| U47 | Desk pairing invitations, verification, roster and revoke | A: `deskPairing*`, `deskPeerBook`, `deskEscaping` | Pair two disposable instances; verify identity; reject wrong invitation; revoke blocks later requests. |
| U48 | Desk delegated work, proposals/artifacts, standup, audit and serving budgets | A: `tests/services/desk/*`, `deskHttpServer`, `deskClient`, `deskServingGate`, `deskStandup` | Cross-machine request honors scope, retention, consent and budget; redact secrets; reject replay; cancel and recover offline peer. |
| U49 | Engagement badges, share text, help/report/version/about | A: action registrations/hub browser; badge earning R | Earn expected badge, copy intended share text, follow support links and show package version accurately. |
| U50 | CodeLens, project context, automatic memory, commit signatures and telemetry preference | A: limited manifest/wiring; end-to-end R | Each opt-in/out changes actual behavior; CodeLens uses correct function; telemetry preference and metadata settings persist. |

### Canvas and visual workflows

| ID | User-facing feature | Automated evidence / state | Manual acceptance |
| --- | --- | --- | --- |
| U51 | Open Canvas, cold start, artifact selection/new/rename and persistent reopen | A: `canvasColdOpenJourney`, `canvasAppBrowser`, `artifactStore`, real-editor tests | Open from command/shortcut/chat; create two artifacts; reopen exact saved pages with no blank/forever-loading state. |
| U52 | Page scaffolds, device formats, variants, themes and design settings | A: `canvasScaffolds`, `canvasFormats`, `canvasVariants`, `canvasThemePresets`, `canvasPreviewThemeBrowser` | Every offered scaffold/format renders; chosen theme/device survives reload; variant switching preserves intended page. |
| U53 | Pan/zoom/fit, board layout, virtualized frames and narrow editor layout | A: `canvasBoard*`, `canvasLayoutBrowser`, `canvasLivePerfBrowser`, `canvasResponsive` | Navigate large board at narrow/wide widths; no lost selection, blank visible page or unusable controls. |
| U54 | Interactive artboards, previews, presentation and sandbox rendering | A: `canvasLiveFrameBrowser`, `canvasFrameCspBrowser`, `canvasPresent`; real-editor selector correction F04 | Interact with labelled input in real editor; presentation opens correct page; frame isolation survives navigation. Investigate F07 styles separately. |
| U55 | Selection, inspector, hierarchy, property changes and inline text editing | A: `canvasSelection`, `canvasInspector`, `canvasTextEdit`, `canvasControls`, `docPatch` | Editing updates intended nodes only; valid properties persist; simultaneous agent edit waits or conflicts visibly. |
| U56 | Agent Canvas generation, chat handoff, steering/comments and job cancellation | A: `coordinatorCanvasLane*`, `canvasPipeline`, `canvasHandoffAssets`, `canvasAgentSyncBrowser`, `canvasLiveness*` | Chat creates intended artifact; sidebar/tab share truthful progress; Stop ends job and ghost artboard state. |
| U57 | Staged suggestions, accept/reject, pins and version conflicts | A: `canvasStagedTransport`, `canvasApplyTimePins`, `canvasToolDispatchPins`, `resolveCanvasApproval` | Deny leaves document unchanged; stale approval cannot overwrite later manual changes; pinned nodes require explicit handling. |
| U58 | Undo/redo, checkpoints, restore and history integrity | A: `canvasHistory*`, `redoV2`, `canvasOpExecutorJournal`, `canvasHistoryUi` | One gesture undoes once; restart preserves history; restore is undoable; corruption reports rather than silently resets. |
| U59 | Asset imports, Figma import, image generation, cropping and media resolution | A: `figmaImport`, `canvasMediaService`, `canvasAssetResolver`, generation-service suites; live services pending | Import local asset/Figma fixture; crop/save/reopen; missing asset clear; actual image provider returns usable image. |
| U60 | Stitch designs and video generation | A: `stitchService`, `CanvasGenerationServices`; authenticated service R | Valid key/model succeeds; unavailable model and cancelled job settle cleanly; no unintended billed retry. |
| U61 | Export HTML/PNG/PDF and secrets management | A: `canvasExportService`, `CanvasSecrets`, `canvasSandboxDoc` | Export opens correctly outside editor; assets/fonts render; credentials and internal control messages absent. |
| U62 | Visual Test dashboard, dev server, screenshot/analyze/fix loop and reports | A: `visualTestManager`, `devServerManager`, `dashboardMessageBoundary`, `vtDashboardContent` | Run against disposable app; visible iterations/report; cancel and stop-server leave no process; browser install failure actionable. |
| U63 | Mysti browser look/interactions and allowed-origin controls | A: `browserInteractionService`, `coordinatorVisualTools`, `visualTestPolicy`, `mystiVisualDirectives` | One allowed screenshot/action succeeds; unauthorized origin rejected; approval and cancellation honored. |

### Distribution and compatibility

| ID | User-facing feature | Automated evidence / state | Manual acceptance |
| --- | --- | --- | --- |
| U64 | Installation, activation, packaged runtime assets and walkthroughs | A: typecheck/build, real-editor activation, package inspector; F03 correction | Install newly built VSIX in clean profile; open chat/Canvas and render Mermaid; no missing runtime resources. |
| U65 | Minimum editor/runtime, macOS/Linux/Windows and shell paths | A: platform/Windows argument fixtures; this review ran macOS/current editor only | Run CI OS matrix, VS Code 1.86.0 and Node 18.17.1 bundled-runtime fixture; paths with spaces/non-ASCII; unavailable sandbox graceful. |
| U66 | Accessibility, themes, keyboard-only use, focus, scaling and rendering performance | A: browser layout/composer/performance fixtures; comprehensive accessibility R | Keyboard-only key journeys, screen-reader labels/focus, dark/light/high contrast, 200% scaling and large conversation/board. |

## Execution record and remaining release gate

1. **Inventory and baseline complete:** manifest, commands, settings, actions and 66 feature groups inventoried; baseline 13,454 tests passed.
2. **Core fixes complete:** native Claude/Codex approvals and session handling, Codex model/profile routing, OpenClaw handshake/signing/isolation/cancellation/config parsing, package exclusions, suggestions setting, setup documentation.
3. **Executed account-backed core tests:** actual provider adapters; permissive Claude settings; real editor two-turn conversations and Deny/Allow cards. Existing native process fixtures additionally cover Stop, clear, missing owner, stale callbacks and concurrent panels.
4. **Executed feature regression sweep:** 13,479 tests / 418 files, browser suites, typecheck, lint, release build, real editor and archive inspection. Each row above records the extent of behavioral evidence. The complete control inventory includes literal test-reference files for targeted follow-up.
5. **Prerequisites still needed:** authenticated Mysti profile; valid OpenClaw gateway model; accounts/CLIs/endpoints for other provider live tests; service credentials for Figma/image/video/connections; a second Desk instance; Linux/Windows and an environment able to launch the minimum editor. Screen-reader and keyboard-only completion of every user journey remain manual acceptance work.

No credential, model entitlement or remote service availability is inferred from a mocked success. This review does not certify every one of the 188 settings individually; inventory entries explicitly retain that limitation. Do not publish a blanket “all features/providers verified” claim until the outstanding acceptance rows are executed.

## Reproduction commands

```sh
npm run typecheck
npm run lint
npm test -- --maxWorkers=4 --reporter=json --outputFile=/tmp/mysti-review-final-tests.json
npm run compile:release
npm run test:vscode
node scripts/build-runtime-fixture.js
npx --yes --package=node@18.17.1 node out-test/runtime/minimum.cjs
npm run package -- --out /tmp/mysti-reviewed.vsix
npm run check:package -- /tmp/mysti-reviewed.vsix
```

The following are **opt-in account-backed tests** and consume existing CLI quota. They use disposable workspaces and bounded marker-file operations. Ordinary `npm test` never runs them.

```sh
npx vitest run --config vitest.live.config.ts tests-live/providers.test.ts
MYSTI_LIVE_PROVIDERS=1 npm run test:vscode
# After extracting the reviewed VSIX, exercise its actual release payload:
MYSTI_TEST_EXTENSION_PATH=<extracted-vsix>/extension MYSTI_LIVE_PROVIDERS=1 npx vscode-test
# Requires a working authenticated gateway and configured model:
npx vitest run --config vitest.live.config.ts tests-live/openclaw.test.ts
```

Protocol references: [Claude permission hooks](https://code.claude.com/docs/en/agent-sdk/permissions), [Codex app-server](https://developers.openai.com/codex/app-server), [OpenClaw protocol](https://docs.openclaw.ai/gateway/protocol), and installed CLI-generated schemas/source. Codex schema reproduction: `codex app-server generate-ts --out /tmp/mysti-codex-protocol`.

## Final checks

Full suite: **13,479/13,479**, 418 files, zero skips. Affected final checks: **70/70**. Typecheck, lint (446 existing warnings, zero errors), release build and archive shape passed. Real editor: **9/9** on VS Code 1.140.0; **9/9 again from the actual extracted VSIX payload in a fresh editor profile**, including both live provider approval journeys. Node **18.17.1** compatibility fixture: **19 checks passed**. VS Code **1.86.0** exited **SIGTRAP before test activation** on this host; its UI validation is blocked, not passed. The reviewed VSIX is `/tmp/mysti-reviewed.vsix` (**691 packaged files**, approximately **7.37 MB**). Source changes remain local and uncommitted; no release was published.
