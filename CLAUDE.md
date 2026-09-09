# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Mysti is a VSCode extension providing a unified AI coding assistant interface supporting 15 AI backends (Claude Code, OpenAI Codex, Google Gemini, Cline, GitHub Copilot, Cursor, OpenClaw, OpenCode, Qwen Code, Ollama, LocalAI, Hermes, Continue, OpenRouter, and Kimi Code). It features sidebar/tab chat panels, conversation persistence, multi-agent brainstorm mode (any 2 of 15 agents with 5 collaboration strategies), autonomous mode with safety classification, @-mention agent routing, permission controls, plan selection, context compaction, and a three-tier agent loading system for personas and skills.

## Build Commands

```bash
npm run compile           # Production build: generates the core-agent manifest, then webpack
npm run watch             # Dev build with watch mode (also regenerates the manifest first)
npm run lint              # check-provider-literals + core-manifest --check + eslint (src + media)
npm run typecheck         # TypeScript contract check
npm run test              # Vitest unit and Chromium browser suites
npm run test:vscode       # Extension-host integration tests (tests-vscode/, real VS Code, mocha)
npm run build:core-manifest # Regenerate src/generated/coreAgentManifest.ts from resources/agents/core
npm run sync-agents       # Sync plugins from wshobson/agents repo
npm run sync-agents:force # Force sync (ignores 24h cache)
npm run package           # vsce package (pinned vsce 3.9.2)
npm run check:package -- path/to.vsix # Verify the built archive
```

Two webpack bundles compile the same `tsconfig.json` (via `tsRule(instance)` in
`webpack.config.js`): the extension host bundle `dist/extension.js` (target
`node`, CommonJS2, entry `src/extension.ts`) and the **canvas webview renderer**
`dist/canvasWebview.js` (target `web`, ESM, entry `src/webview/canvas/index.ts`).
The canvas bundle deliberately has no `vscode`/node externals, so it can only
import real bundled code shared from the host (`CanvasSandbox`, `protocol.ts`,
`DocPatch`).

**Tests:** the repo has a Vitest suite (`npm test` → `vitest run`)
plus `npm run typecheck` for type-checking, plus extension-host
integration tests (`npm run test:vscode`). Run the Vitest suite and tsc BEFORE
and AFTER changes — regressions in the coordinator/provider code are caught
here. `vscode` is aliased to `tests/helpers/mockVscode.ts`.

**Mysti agent (coordinator):** alongside the registered backends, Mysti has a first-class *coordinator* agent (`settings.provider === 'mysti'`) that streams its own model (OpenRouter / DeepMyst gateway) and acts through native tools or a per-run nonce-fenced directive protocol parsed by `MystiTagScanner`. The ReAct loop is `ChatViewProvider._runMystiAgentic`; local reads use `MystiLocalTools`, optional local writes/shell use the default-off `mysti.mysti.localExecution` gate and `MystiLocalExec`/`MystiSandbox`; delegations run through the gated `CollaboratorPool`; durable background jobs use `BackgroundJobManager`. Every untrusted result re-entering the model is nonce-redacted and UNTRUSTED-fenced; the `dm_` gateway key is sent only to `*.deepmyst.com`; workspace settings may only lower authority (see `settingsClamp` and machine-scoped `mysti.mysti.*` settings).

Use Node from `.nvmrc` and `npm ci`. Lint and package shape are blocking CI
checks; do not lower rules or add blanket retries to get green. See
`docs/ARCHITECTURE.md` and `docs/MAINTENANCE.md` for the current module map and
release workflow. New chat interaction behavior belongs in `src/chat/` with
explicit panel/run ownership; webview routing uses the host's sender identity.

## Development

Press `F5` in VSCode to launch Extension Development Host for debugging. Set breakpoints in TypeScript files and filter Debug Console with `[Mysti]` for extension logs.

**CLI requirements**: At least one of these CLIs must be installed for the extension to function. The npm-based CLIs install identically on macOS/Linux/Windows; the non-npm ones differ by OS — the in-app setup wizard shows the OS-correct command automatically (each provider's `getInstallMethods()` is platform-tagged and filtered to `process.platform` extension-side; see `src/utils/platform.ts` `filterInstallMethodsForOS`).

npm-based (cross-OS):

- `npm install -g @anthropic-ai/claude-code` (Claude Code)
- `npm install -g @openai/codex` (OpenAI Codex)
- `npm install -g @google/gemini-cli` (Gemini)
- `npm install -g cline` (Cline)
- `npm install -g @github/copilot` (GitHub Copilot)
- `npm install -g openclaw@latest` (OpenClaw — then `openclaw onboard --install-daemon` for the Gateway daemon)
- `npm i -g opencode-ai@latest` (OpenCode)
- `npm install -g @qwen-code/qwen-code@latest` (Qwen Code)
- `npm i -g @continuedev/cli` (Continue — binary `cn`; models/keys configured in `~/.continue/config.yaml`, first interactive run walks through onboarding)

OS-specific (handled per-platform by the wizard):

- **Cursor** — macOS/Linux: `curl https://cursor.com/install -fsS | bash`; Windows (PowerShell): `irm 'https://cursor.com/install?win32=true' | iex` (binary is `cursor-agent`/`agent`; login: `agent login`)
- **Ollama** — Linux: `curl -fsSL https://ollama.com/install.sh | sh`; macOS: `brew install ollama` (or download from ollama.com); Windows: `OllamaSetup.exe` from ollama.com/download
- **LocalAI** — Docker (all OSes): `docker run -p 8080:8080 --name local-ai -ti localai/localai:latest`; macOS/Linux can also use the prebuilt binary; Windows requires Docker Desktop or WSL (there is no `localai.io/install.sh`)
- **Hermes** — macOS/Linux/WSL2: `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`; Windows (PowerShell): `iex (irm https://hermes-agent.nousresearch.com/install.ps1)` (auth: `hermes setup` or `hermes setup --portal`; Mysti drives it over the ACP transport `hermes acp`)

## Architecture

### Core Pattern: Manager + Provider Facades

```
extension.ts (entry — activate() wires everything)
    │
    ├── Managers (business logic, src/managers/)
    │   ├── ContextManager        - File/selection tracking (per-panel contexts)
    │   ├── ConversationManager   - Message persistence via globalState
    │   ├── ProviderManager       - Provider registry facade
    │   ├── PermissionManager     - Access control
    │   ├── BrainstormManager     - Multi-agent orchestration (5 strategies)
    │   ├── ResponseClassifier    - AI-powered response analysis
    │   ├── PlanOptionManager     - Implementation plan extraction
    │   ├── SuggestionManager     - Quick action suggestions
    │   ├── SetupManager          - CLI auto-setup & authentication
    │   ├── AgentLoader           - Three-tier agent loading from markdown
    │   ├── AgentContextManager   - Recommendations & prompt building
    │   ├── AgentStudio           - Create/import/reload personas & skills (uses SkillDiscoveryService)
    │   ├── TelemetryManager      - Anonymous usage analytics
    │   ├── AutocompleteManager   - Autocomplete functionality
    │   ├── AutonomousManager     - Semi/full autonomous mode orchestration
    │   ├── MemoryManager         - Learning memory for autonomous preferences
    │   ├── SafetyClassifier      - Three-level safety evaluation (safe/caution/blocked)
    │   ├── CompactionManager     - Context overflow prevention
    │   ├── MentionRouter         - @-mention routing to specific agents
    │   ├── SlashCommandManager   - Unified slash command menu system
    │   ├── AgentLifecycleManager - Session idle timeout & child process tracking
    │   ├── ActiveModeManager     - OpenClaw daemon WebSocket connection
    │   ├── VisualSessionManager  - Warm dev-server + browser session (`look`/`act`)
    │   ├── ChannelBridge         - Routes messages between daemon channels and panels
    │   └── Later subsystems (all in src/managers/)
    │       ├── Canvas*            - Canvas design sessions (CanvasManager, CanvasSandbox,
    │       │                        CanvasOpParser/Executor, CanvasToolDispatch,
    │       │                        CanvasPromptBuilder, CanvasValidator, CanvasFormats,
    │       │                        CanvasMcpBridge, CanvasSessionLinker, CanvasThemePresets,
    │       │                        CanvasScaffolds, CanvasCapabilityRegistry, DesignSpecManager)
    │       ├── ArtifactStore      - Canvas artifact persistence (schema-versioned op log)
    │       ├── Desk*              - Cross-machine teamwork (DeskPairing, DeskPeerBook,
    │       │                        DeskPairingFlow, DeskAudit, DeskStandup, DeskServingGate,
    │       │                        DeskProposalStore, TeamPresenceManager)
    │       ├── CheckpointManager  - Shadow-repo snapshot before each turn + rewind
    │       ├── SmartCompactor     - Cache-aware compaction (+ SavingsLedger, RetrievalCoordinator)
    │       ├── BoostManager       - One-switch measured-defaults overlay (Plan 24)
    │       ├── MystiOrchestratorManager - DAG decompose/execute/synthesize for @mysti
    │       ├── CollaborationManager    - Collaboration-role routing (advisor/critic/…)
    │       ├── DeepMystAuthManager     - Signed-in DeepMyst account (`dm_` key)
    │       ├── ConnectionsPanelManager - DeepMyst Connections panel + MCP broker wiring
    │       ├── AnnouncementManager     - New-model notifications (with ModelAnnouncementService)
    │       ├── ProjectContextManager   - Project-level context
    │       ├── VisualTestManager       - Visual test dashboard
    │       ├── EngagementManager       - Onboarding/engagement tips
    │       └── CommitSignatureManager  - Team commit attribution (Desk)
    │
    └── ChatViewProvider (UI coordinator, src/providers/ChatViewProvider.ts)
            │
            ├── Webview UI (src/webview/webviewContent.ts — embedded HTML/CSS/JS)
            │
            └── Providers (CLI integrations, src/providers/<name>/)
                ├── ClaudeCodeProvider  (extends BaseCliProvider)
                ├── CodexProvider       (extends BaseCliProvider)
                ├── GeminiProvider      (extends BaseCliProvider)
                ├── ClineProvider       (extends BaseCliProvider)
                ├── CopilotProvider     (extends BaseCliProvider)
                ├── CursorProvider      (extends BaseCliProvider)
                ├── OpenClawProvider    (extends BaseCliProvider + Gateway WebSocket)
                ├── OpenCodeProvider    (extends BaseCliProvider)
                ├── QwenCodeProvider    (extends BaseCliProvider)
                ├── OllamaProvider      (extends BaseCliProvider)
                ├── LocalAIProvider     (extends BaseCliProvider)
                ├── HermesProvider      (extends BaseCliProvider, ACP JSON-RPC via persistent process)
                ├── ContinueProvider    (extends BaseCliProvider, cn headless print mode)
                ├── OpenRouterProvider  (extends BaseCliProvider, OpenAI-compatible SSE API — no CLI)
                └── KimiCodeProvider    (extends BaseCliProvider, ACP transport via `kimi` CLI)
```

`src/providers/manus/ManusProvider.ts` is legacy, unregistered code — it was
removed from `ProviderRegistry` and from the `ProviderType`/`AgentType` unions;
do not revive it. The 15 registered providers are: Claude Code, Codex, Gemini,
Cline, Copilot, Cursor, OpenClaw, OpenCode, Ollama, LocalAI, Qwen Code, Hermes,
Continue, OpenRouter, Kimi Code.

Lifecycle services live in `src/services/` alongside the providers (`CliDiscoveryService`,
`CliUpdateService`, `ModelRegistryService`, `ModelAnnouncementService`, `NativeCommandDiscovery`,
`CollaboratorPool` for gate dispatch, `CoordinatorModelClient`/`OpenRouterClient`/`DeepMystGatewayClient`
for the coordinator's own model, `MystiLocalTools`/`MystiLocalExec`/`MystiSandbox`/
`MystiMemoryStore` for the standalone agent, `McpClient`/`McpConfigManager`/`DeepMystClient`
for brokered tools, `BrowserManager`/`visualTestPolicy`/`PageObservationService` for `look`/`act`,
and the `desk/` cluster for cross-machine channels). Coordinated workloads are UDP-documented in `plans/`
by plan number (referenced in code comments).

### Key Design Decisions

- **Per-panel isolation**: Each webview panel (sidebar or tab) has independent state, conversation, and child process. Provider instances are singletons but mutable state is per-panel via `_panelSessions: Map<string, PanelSessionState>`. Each provider subclass extends the base session type (e.g., `ClaudeSessionState`, `CodexSessionState`).
- **CLI-based providers**: Spawn CLI processes with `--output-format stream-json`, parse line-delimited JSON events. OpenClaw additionally supports WebSocket streaming via its Gateway daemon. Hermes uses the Agent Client Protocol (`hermes acp`, JSON-RPC 2.0 over stdio) through the base persistent-process machinery — the handshake is driven reactively from `parseStreamLine`.
- **AsyncGenerator streaming**: Providers yield `StreamChunk` items for real-time response updates
- **Webview communication**: Extension ↔ webview via `postMessage()` with typed `WebviewMessage`
- **Stream-level permission gate**: All CLI providers bypass interactive permissions (piped stdin can't prompt). `ChatViewProvider._shouldGateToolUse()` intercepts `tool_use` stream events and shows permission cards in the webview when mode/access settings require approval.

### Provider Data Flow

1. User message → `ChatViewProvider._handleMessage()`
2. Context collection → `ContextManager.getContext(panelId)`
3. Provider selection → `ProviderManager._getActiveProvider()` (or `MentionRouter` for @-mentions)
4. CLI spawn → `Provider.sendMessage()` returns `AsyncGenerator<StreamChunk>`
5. Stream parsing → `parseStreamLine(line, session)` yields chunks (text, thinking, tool_use, etc.)
6. UI update → `postMessage()` back to webview

### Brainstorm Mode Data Flow

1. User enables brainstorm (2 of 7 agents selected via settings)
2. `BrainstormManager` dispatches message to both agents in parallel
3. Strategy determines interaction: `quick` (direct synthesis), `debate` (critic vs defender), `red-team` (proposer vs challenger), `perspectives` (risk vs innovator), `delphi` (facilitator-mediated)
4. Discussion runs via `_interleaveGenerators()` with convergence tracking (agreement/position stability)
5. Synthesis agent combines into final response

### Autonomous Mode Data Flow

1. Permission request arrives from CLI provider
2. `SafetyClassifier` evaluates operation → `safe` / `caution` / `blocked`
3. `AutonomousManager` decides based on safety mode (conservative/balanced/aggressive)
4. `MemoryManager` learns from user overrides (confidence decays over time)
5. Audit trail logged for every autonomous decision

## Visual observation (`look` / `act`)

Any agent — the `@mysti` coordinator or a CLI backend — can render the running app in a real
browser and read back what is on screen. It is a **perception primitive, not a second agent**:
`VisualSessionManager.look()` returns a `VisualObservation` (console errors, failed requests,
layout/overflow/contrast probes, accessibility tree, DOM outline, screenshot) to the *calling*
agent, which fixes what it saw with its own already-gated tools.

- Trust boundary: `src/services/visualTestPolicy.ts` — the ONLY place a `VisualTestConfig` is
  built. A model may say WHAT to look at (`path`, `selector`, `mode`) but never WHERE
  (scheme/host/port) and never the dev-server command. There is no `url` or command attribute
  on the tag or in the tool schema, so there is no model-to-shell path to gate.
- Coordinator surface: `<look:NONCE …>` / `<act:NONCE>` directives (`MYSTI_VISUAL_KINDS`,
  `MYSTI_VISUAL_ACT_KINDS`) plus native `look`/`act` tool schemas; both convert to the same
  `MystiDirective` and ride the same gated dispatch. CLI backends get the same nonce'd `<look:>`
  tag via `_visualPromptSnippet`, injected into that turn's system context.
- Gates (all default-safe): `mysti.mysti.visualTools` (machine, **off**), a trusted workspace,
  `mysti.visualTest.allowedOrigins` (loopback only), `mysti.visualTest.allowModelDevServerCommand`
  (**false**), `mysti.visualTest.agentInteractions` (**off**), `mysti.mysti.maxVisualLooks` (6).
  Observations re-enter the model nonce-redacted + UNTRUSTED-fenced.
- Playwright is a webpack external and is un-ignored in `.vscodeignore`; browser BINARIES are not
  shipped (`npx playwright install chromium`). `BrowserManager.probe()` checks both before
  anything spawns.
- `look` survives read-only/plan mode (it is a read); `act` does not.

## Major subsystems

Large feature areas live alongside the core chat flow. Each is its own
manager/service cluster and has a design doc in `plans/`:

- **Canvas** (`plans/05`, `22`) — a design workspace where the model edits a
  document-model page (`src/canvas/`) instead of raw HTML. Sessions persist to
  `.mysti/canvas/<id>/` via a schema-versioned op log (`ArtifactStore`); ops are
  parsed/validated/executed by `CanvasOpParser/Validator/Executor`, prompts are
  assembled by `CanvasPromptBuilder`, and boundary-crossing tools (`generate_visual`,
  `import_design`, …) keep their fail-closed, force-approval treatment. The
  renderer is the second webpack target (`dist/canvasWebview.js`).
- **Desk** (`plans/21`, `26`) — cross-machine teamwork: pair machines via a
  `desk://pair` invite carrying a PUBLIC key + nonce (the invite is not a
  credential; a human must compare the out-of-band safety number and write a
  `PeerGrant` before anything is authorized). Proposals/standups travel over
  host-locally-signed channels (`DeskHttpServer`), every teammate's commit goes
  out with `CommitSignatureManager` attribution, and off-machine requests are
  marked `remoteOrigin` so they can never be auto-approved.
- **DeepMyst Connections** (`plans/04`) — sign in once with a `dm_` key (secret
  storage); DeepMyst holds the third-party credentials and brokers MCP tools
  (Gmail, Slack, Trello, databases, …) at `api.v2.deepmyst.com`. The
  coordinator (`@mysti`) can call connected tools per-call-approval when
  `mysti.mysti.mcpTools` is `on`. "Use in local CLIs" writes the per-user broker
  endpoint into each MCP-capable CLI's config (`McpConfigManager`).
- **Checkpoints** (`mysti.checkpoints.*`) — before each chat turn the workspace
  is snapshotted into a private shadow repo OUTSIDE the project (never touches
  the user's `.git`), so code can be rewound to any prior turn. Also force-adds
  `.mysti/agents` + `.mysti/skills.staged` so agent artifacts survive rewind.
- **Smart Compaction / Boost** (`plans/08`, `24`) — `SmartCompactor` times
  compaction to a cold cache, compacts with a cheap model through the DeepMyst
  gateway, cherry-picks buried history back (`RetrievalCoordinator`), and tracks
  realized savings (`SavingsLedger`). `BoostManager` layers measured-better
  defaults (compaction threshold, smart on, delegation tier/effort routing) over
  a single machine-scoped switch that never touches mode/access/autonomy.
- **Agent catalog & quarantine** (`plans/20`) — the coordinator's `search`/
  `publish`/`skillrun` capabilities over the bundled + user-authored personas,
  skills and roles, all gated on local execution + OS sandbox + trusted
  workspace. `mysti.revokeCapabilities` is the kill switch that quarantines
  every user agent artifact at once.

## Token accounting, compaction and caching

`src/services/TokenAccounting.ts` is the ONLY place that knows what a backend's
usage numbers mean, because the 15 backends speak two incompatible conventions:

- **`anthropic`** (Claude Code) — `input_tokens`, `cache_creation_input_tokens`
  and `cache_read_input_tokens` are DISJOINT; the prompt is the SUM of all three.
- **`openai`** (Codex) — `cached_input_tokens` is a SUBSET of `input_tokens`
  (the `prompt_tokens_details.cached_tokens` convention).
- **`none`** — no cache accounting at all (most backends).
- **`auto`** — the backend fronts other vendors (Cline, OpenRouter, LocalAI), so
  the convention is resolved per-turn from the model id.

Every consumer used to compute fill as `input_tokens + cache_read_input_tokens`,
which is wrong for BOTH, in opposite directions: it dropped Anthropic's
cache-creation bucket (so a cold turn — where the whole prefix is booked as
cache-creation — reported a 400k context as ~2k, and the threshold never
tripped), and it double-counted OpenAI's cached subset (inflating fill up to 2x).
`normalizeUsage` converts to the disjoint shape at the stream boundary so
downstream there is ONE formula: `contextFillTokens` = input + creation + read.
It is idempotent via the `normalized` marker on `UsageStats` — the OpenAI branch
subtracts, and subtracting twice silently shrinks the fill.

Three rules that consumers must not re-derive:

- **UNKNOWN is not zero.** cursor/hermes/kimi/ollama default missing fields to 0
  rather than omitting `usage`; Ollama omits `prompt_eval_count` entirely on a
  fully-cached prompt. An all-zero record means "unmeasured", and thresholding
  on it reads as 0% fill, which silently disables compaction for the session.
  `hasUsageSignal` is the gate; `emitsUsage: false` is the static equivalent
  (now actually CONSUMED — the context pie reads `n/a` instead of holding the
  previous provider's number, and the threshold is skipped).
- **Cost is not fill.** The coordinator's ReAct loop re-sends its prefix every
  round-trip, so summed usage answers "what did this turn cost". Fill is the
  LAST round-trip's prompt. The webview no longer derives fill at all — the
  extension sends `contextTokens` because only it knows the convention.
- **Lifetime totals are not fill.** `getUsage()` is a session spend;
  `getLastFill()` is the current position. Manual `/compact` used the former.

Caching (`src/services/PromptCache.ts`): the coordinator clients declare explicit
`cache_control` breakpoints on the stable prefix (system message + last user
message, above Anthropic's 1024-token minimum) — Anthropic models cache NOTHING
without one, so an N-round-trip run paid full input price N times for an
unchanged prefix. Only Anthropic ids are marked; OpenAI/Google cache prefixes
automatically and can reject the field. Both clients now read
`prompt_tokens_details.cached_tokens` back, so coordinator cache hits are finally
visible to the ledger. `PROMPT_CACHE_TTL_MS` is 1 hour (matching what Claude Code
writes and BoostManager's cold-resume trap), not 5 minutes: too SHORT destroys a
warm cache, too LONG merely defers a compaction the 90% critical-fill override
forces anyway. `SmartCompactor.getWarmth` returns `unknown` — not `cold` — for a
backend that cannot report cache, because `cold` reads as "ideal moment to
compact" and would green-light all 11 of them permanently.

## CLI version detection

`_discoverCliCommon` probes `--version` on the resolved binary and caches it
(`getCachedCliVersion()`, `_getCliMajorVersion()`), which is also what finally
populates `CliDiscoveryResult.version`. NOTHING set that field before — not one
provider — so `CliStatus.version` was always undefined and
`CliUpdateService.getUpdates()` skipped every provider for want of an installed
version to compare against. The update-notification feature was silently inert.

Providers whose invocation changed across CLI major versions branch on this.

`CopilotProvider` is the other one: Copilot CLI 1.0 added `--output-format json`
(JSONL), whose `tool.execution_start` / `tool.execution_complete` events are the
FIRST tool events Mysti has ever received from Copilot. Until then the stream was
plain text, so no `tool_use` chunk existed, the stream-level permission gate
could never fire, and ask-tier had to deny `shell`/`write` outright to stay safe
— which also made those tools unusable. On 1.0+ Copilot is now gated like every
other backend; on 0.0.x it keeps the plain-text path and the fail-closed denial.

`OpenClawProvider` is the third: `openclaw agent` takes its prompt from
`--message`/`--message-file` and **ignores stdin entirely** ("Missing message.
Use openclaw agent --message ..."), and additionally refuses a turn without a
session selector ("Pass --to, --session-key, --session-id, or --agent"). It
overrides the base's `_deliverPrompt` hook to write a 0600 temp file named in
`--message-file`, and maps the panel id onto `--session-key` so each panel keeps
its own OpenClaw session. A provider that overrides `_deliverPrompt` must still
close stdin — `tests/providers/steering.test.ts` enforces that.

`ClineProvider` is the live example: Cline 2.0 renamed **every** flag Mysti used
(`--output-format json` -> `--json`, `--mode plan|act` -> `-p/--plan` with act
as the default, `--yolo` -> `--auto-approve <bool>`) and replaced the event
vocabulary (`type:"say"` -> `type:"agent_event"` with a nested `event`). It also
has no working stdin path at all — a pipe, a file redirect and the old `-`
sentinel are all rejected — so a prompt over `MAX_ARG_LENGTH` gets an explicit
error instead of an opaque spawn failure. Both formats are parsed, because the
payload says which it is; only the ARGS need the version.

## Updating the CLI backends

`mysti.updateClis` ("Mysti: Update CLI Backends", also `/update` in the slash
menu) checks every npm-backed provider, offers a multi-select of the outdated
ones and runs the updates **in the integrated terminal**.

Three rules, each learned the hard way:

- **Never `@latest` blindly.** `CliUpdateService` fetches `engines.node`
  alongside the version and, when the newest release excludes the running Node,
  resolves the newest release that does not (`satisfiesNodeRange`,
  `_findInstallableVersion`). openclaw 2026.9.2 needs Node >=22.22.3; on 22.20.0
  `npm i -g openclaw@latest` aborts in a preinstall hook.
- **One command per package.** A single `npm i -g a b c` aborts entirely when
  one package refuses, installing NOTHING — that is exactly what happened.
- **The terminal, not the extension host.** `npm i -g` needs root wherever npm's
  prefix is root-owned; the extension must never be the thing that escalates.
  The terminal lets sudo prompt and shows the user the command it is prompting for.

`PROVIDER_SELF_UPDATE_COMMANDS` overrides the command for a provider whose npm
package is not the install that runs — Claude Code's native installer writes
`~/.local/bin` (what PATH resolves) while npm writes `/usr/local/bin`. It only
covers providers Mysti can already DETECT as outdated; it changes the command,
not the detection.

## CLI resolution

`_discoverCliCommon` resolves in this order, and `getCliPath()` (the synchronous
getter the SPAWN uses) reads the cache discovery seeds — so "the CLI we found"
and "the CLI we run" are the same statement:

1. an explicitly configured `mysti.<provider>Path`, then provider-declared
   locations (`getPriorityCliPaths`)
2. **whatever the user's PATH resolves** (`resolveCommandOnPath`, using
   `getResolutionEnv()` — NOT `getEnrichedEnv()`, which PREPENDS /usr/local/bin
   for shebang resolution and would invert the user's own PATH order; probing
   with it resolved `claude` to a stale 2.0.71 while the shell ran 2.1.263,
   making this whole step a no-op)
3. the hard-coded guess list (`getCommonSearchPaths`) — still needed when a GUI
   host has a minimal PATH

Step 2 used to come LAST. The guess list is headed by `/usr/local/bin`, so a
stale `npm i -g` copy there beat a current install in `~/.local/bin`: `claude` in
a terminal was 2.1.263 reporting 53 slash commands including `/design`, while
Mysti drove 2.0.71 reporting 8. Upgrading a CLI changed nothing Mysti could see.
Do not reorder these steps without that in mind.

## Provider-native commands

Each backend's own `/command` vocabulary appears in a provider-titled section of
the slash menu ("Claude Code commands"). Three sources feed it, first match wins:

1. `NATIVE_COMMANDS` in `src/providers/base/NativeCommands.ts` — curated built-ins
2. `ICliProvider.getDynamicNativeCommands()` — what the backend itself reports:
   Claude Code's `system`/`init` event (`slash_commands` + `skills`) and the ACP
   backends' `session/update -> available_commands_update`
3. `NativeCommandDiscovery` (`src/services/`) — the user's own files, read from
   the directories in `NATIVE_COMMAND_SOURCES` (`.claude`/`.gemini`/`.qwen`/
   `.continue`/`.openclaw` skills, `.gemini`/`.qwen/commands/*.toml`,
   `~/.codex/prompts`, `.cursor/commands`, `.clinerules/workflows`,
   `.opencode/command`). Cached; reads are sync, refresh is background, and the
   menu is re-posted only when the set changes.

**Prefer what the tool reports over what we hard-code.** Once a provider's
`hasReportedNativeCommands()` is true, that report is AUTHORITATIVE: curated
entries whose `execution` reaches the CLI are filtered down to it, so a command
a CLI release removed stops being offered. `mysti`-mapped entries are exempt —
they never reach the CLI. This is not theoretical: Claude Code 2.1.263 dropped
`/review`, and `/effort` and `/rename` answer *"isn't available in this
environment"* in a print session even though the binary marks them
`supportsNonInteractive` (the reported list also honours isEnabled/isHidden).
Only Claude Code and the ACP backends report on the transport Mysti uses —
Gemini/Qwen/Continue/OpenClaw carry the ACP `availableCommands` schema, but only
under `--experimental-acp`, which Mysti does not drive.

**The rule that matters:** a CLI's *interactive* commands and its *headless*
commands are different sets, and Mysti only ever runs the headless entry point.
Each entry therefore declares `execution`:

- `passthrough` — send `/name` to the CLI. Only where verified: Claude Code
  built-ins carrying `supportsNonInteractive` plus all `prompt`-type commands
  (skills/plugins/`.claude/commands` — this is how `/design` works); Gemini and
  Qwen only where the command yields `submit_prompt`, which is `/init` and their
  custom TOML commands (anything else throws `FatalInputError` and kills the turn).
- `expand` — Mysti reads the user's own template and sends its body. For CLIs
  whose headless mode has no slash parser at all: `codex exec`, `cursor-agent -p`,
  `cline`, `opencode run`.
- `mysti` — run Mysti's cross-provider equivalent (`cmd:clear`, `cmd:compact`,
  `model:switch`). Must name an id `SlashCommandManager.executeCommand` handles;
  `tests/providers/nativeCommands.test.ts` fails otherwise.

A fourth flag, `metadataOnly`, marks an entry that only ever DESCRIBES a
reported command and is never offered on its own — for commands whose
availability varies by release. `/effort` and `/rename` are the worked example:
Claude Code 2.1.154 rejects both ("isn't available in this environment"), 2.1.263
runs them. A reported command flagged `isSkill` keeps the report's own labelling
over any same-named catalog entry, because `design` is both a bundled skill and
a local Claude Design command and they are not the same thing.

Commands that are TUI-only with no Mysti equivalent are deliberately absent — do
not add them back from a CLI's `/help` output, and re-verify against the CLI's
LATEST release rather than whatever is installed locally (every CLI checked had
drifted: Gemini 0.28 -> 0.58, Copilot 0.0.372 -> 1.0.83, Qwen 0.11 -> 0.23).
Claude Code's bundled skills (`/design`) are compiled into the binary as
`SKILL-<hash>.md.zst` and extracted at runtime, so no directory scan can find
them; they arrive only via the init report. `~/.claude/plugins/marketplaces/` is
deliberately NOT scanned — it holds every plugin the marketplace offers, not the
installed ones. Ollama/LocalAI/OpenRouter are HTTP
APIs with no CLI, so `[]` is correct for them.

A name Mysti claims wins over a backend's when TYPED (`/compact` stays
provider-neutral); the menu row is unambiguous either way. Untrusted names — from
an ACP agent or from a filename — are validated by `isValidNativeCommandName` and
dropped, never repaired.

## Key Types (src/types.ts)

- `StreamChunk` - Events from provider CLI (text, thinking, tool_use, tool_result, error, done, session_active, ask_user_question, compaction)
- `WebviewMessage` - Extension ↔ webview communication
- `Message` / `Conversation` - Persistent chat data
- `OperationMode` - "default" | "ask-before-edit" | "edit-automatically" | "quick-plan" | "detailed-plan"
- `AccessLevel` - "read-only" | "ask-permission" | "full-access"
- `ProviderType` / `AgentType` - "claude-code" | "openai-codex" | "google-gemini" | "cline" | "github-copilot" | "cursor" | "openclaw" | "opencode" | "qwen-code" | "ollama" | "localai" | "hermes" | "continue" | "openrouter" | "kimi-code" (15 registered backends; `AgentType` is the same union; `AgentSelection` additionally allows the pseudo-agents `mysti` | `brainstorm`)
- `EffortLevel` - "low" | "medium" | "high" | "xhigh" | "max" (reasoning-effort tier, Claude-parity; distinct from ThinkingLevel)
- `CollaborationStrategy` - "quick" | "debate" | "red-team" | "perspectives" | "delphi"
- `SafetyLevel` - "safe" | "caution" | "blocked"
- `AutonomousSafetyMode` - "conservative" | "balanced" | "aggressive"
- `ThinkingLevel` - "none" | "low" | "medium" | "high"
- `CompactionStrategy` - "native-cli" | "client-summarize"
- `ProviderCapabilities` - Feature flags per provider (supportsStreaming, supportsThinking, supportsToolUse, supportsSessions, supportsNativeCompact, supportsImages, `emitsUsage`, `usageConvention`, etc.)
- `CollaboratorAccess` / `CollaboratorPattern` - "read-only" | "gated-write" | "sealed" / "one-shot" | "rounds" (CollaboratorPool dispatch profile)

## Constants (src/constants.ts)

- `PROCESS_TIMEOUT_MS` — 5 minutes (regular), `AUTONOMOUS_PROCESS_TIMEOUT_MS` — 4 hours (autonomous)
- `PROCESS_KILL_GRACE_PERIOD_MS` — 5s, `PROCESS_FORCE_KILL_TIMEOUT_MS` — 10s
- `AUTH_POLL_INTERVAL_MS` / `AUTH_POLL_MAX_ATTEMPTS` — 2s interval, 60 attempts
- `PERMISSION_DEFAULT_TIMEOUT_S` — 30s, `SEMI_AUTONOMOUS_DEFAULT_TIMEOUT_S` — 60s
- `MAX_CONVERSATION_MESSAGES` — 10
- `SUBAGENT_TIMEOUT_MS` — 1 hour for @-mention sub-agent tasks
- `COMPACTION_DEFAULT_THRESHOLD_PERCENT` — 75%, cooldown 30s, preserve last 4 messages
- `LIFECYCLE_DEFAULT_IDLE_TIMEOUT_MS` — 1 hour, check every 30s
- `OPENCLAW_GATEWAY_TIMEOUT_MS` — 10 minutes
- `MANUS_API_BASE_URL` — `https://api.manus.im`, poll every 3s (legacy/unregistered provider only)

## Conventions

- Private members use leading underscore: `_extensionContext`, `_currentProcess`
- Console logging with `[Mysti]` prefix
- Managers are single-responsibility classes
- New providers extend `BaseCliProvider` and implement `ICliProvider`
- All source files carry the Apache-2.0 license header
- TypeScript strict mode enabled, target ES2022
- Per-panel state accessed via `_panelSessions.get(panelId)` — never stored as instance fields
- `buildCliArgs(settings, session)` and `parseStreamLine(line, session)` take session objects for per-panel state

## VSCode Integration Points

- View: `mysti.chatView` (webview sidebar); secondary panels: `mysti.openCanvas`, `mysti.openConnections` (DeepMyst), `mysti.openVisualTestDashboard`
- Commands: `mysti.openChat`, `mysti.newConversation`, `mysti.addToContext`, `mysti.clearContext`, `mysti.openInNewTab`, `mysti.toggleAutonomous`, `mysti.debugSetup`, `mysti.debugSetupFailure`, `mysti.createPersona`, `mysti.createSkill`, `mysti.createRole`, `mysti.importSkills`, `mysti.reloadAgents`, `mysti.updateClis`, `mysti.setCoordinatorModel`, `mysti.viewMystiMemory`, `mysti.reviewSkillProposals`, `mysti.skillReport`, `mysti.revokeCapabilities` (artifact kill switch), `mysti.deskPair`, `mysti.deskRoster`, `mysti.boostSummary`, `mysti.codeLensAction`, `mysti.canvasDiagnostics`, `mysti.canvasAddScaffold`, `mysti.deepmyst.signIn`/`signOut`
- Keybindings: `Ctrl+Shift+M` / `Cmd+Shift+M` (open chat), `Ctrl+Shift+N` / `Cmd+Shift+N` (new tab), `Ctrl+Shift+A` / `Cmd+Shift+A` (toggle autonomous)
- Settings namespace: `mysti.*` (100+ settings covering provider, mode, access, brainstorm, agents, permissions, autonomous, compaction (+ smart), lifecycle, active mode, checkpoints, boost, mysti coordinator, deepmyst, updates)
- Custom language IDs: `claude-prompt`, `prompt-markdown`, `gpt-prompt`, `gemini-prompt`, `codex-prompt`
- Activation: `onStartupFinished` + `workspaceContains` triggers for config files (`.mysti/`, `.claude/`, `.gemini/`, `.openai/`, `.openclaw/`, `.qwen/`, `claude.md`, `gemini.yaml`, `codex.json`, `agents.yaml`, `opencode.json`)
- DeepMyst sign-in: the `dm_` API key is stored in VS Code secret storage, never in settings; it authenticates both the gateway (`gateway.v2.deepmyst.com`) and the API (`api.v2.deepmyst.com`), and is only ever sent to `*.deepmyst.com` hosts

## Webview UI

The chat webview is one of several embedded-HTML panels (each built by a
`src/webview/*Content.ts` module; the interactive chat reskin lives in static
assets under `media/chat/`):

- `src/webview/webviewContent.ts` / `media/chat/` — the main chat interface (built by `ChatViewProvider`)
- `src/webview/canvasContent.ts` + `src/webview/canvas/` — Canvas design workspace (webpack-bundled renderer, `dist/canvasWebview.js`)
- `src/webview/connectionsContent.ts` — DeepMyst Connections (brokered MCP tools)
- `src/webview/visualTestDashboardContent.ts` — `look`/`act` visual test dashboard

Libraries loaded from `resources/` folder: Marked.js (markdown), Prism.js (syntax highlighting), Mermaid.js (diagrams).

## Extension Points

### Adding a New Provider

1. Create class extending `BaseCliProvider` in `src/providers/newprovider/`
2. Implement abstract methods: `discoverCli()`, `getCliPath()`, `buildCliArgs()`, `parseStreamLine()`, `getAuthConfig()`, `checkAuthentication()`, `getAuthCommand()`, `getInstallCommand()`
3. Implement `_createSession(panelId)` to return provider-specific session state
   - Declare `capabilities.supportsPromptEnhancement` truthfully: `true` only if the provider implements the optional `enhancePrompt()`. The webview enables/disables the "Enhance prompt" button off this flag, and `tests/providers/promptEnhancement.test.ts` fails if the flag and the method ever disagree.
4. Register in `src/providers/ProviderRegistry.ts` (add to `_registerBuiltInProviders()`)
5. Add to `ProviderType` AND `AgentType` unions in `src/types.ts`
5b. Declare `emitsUsage` and `usageConvention` in `capabilities` TRUTHFULLY —
   `usageConvention` is TS-required, and `providerManifest.test.ts` fails if a
   backend declares `emitsUsage: false` alongside any convention but `'none'`.
   See **Token accounting, compaction and caching** above; getting it wrong
   silently breaks the compaction threshold rather than throwing.
6. Add entries to the two TS-enforced maps in `src/providers/base/ProviderManifest.ts` (`PROVIDER_DISPLAY_META`, `PROVIDER_CUSTOM_MODEL_SETTING_KEYS`), the two in `BrainstormManager.ts` (`AGENT_BRAINSTORM_ICONS`, `agentKeyMap`), and the two in `src/providers/base/NativeCommands.ts` (`NATIVE_COMMANDS`, `NATIVE_COMMAND_SOURCES`) — these fail `tsc` if missed. For the last two, `[]` is a valid and often correct answer (see **Provider-native commands** below)
7. Add configuration options in `package.json`: `defaultProvider` enum + enumDescription, `<provider>Path`, `<provider>Model`, `brainstorm.synthesisAgent` + `brainstorm.agents` enums, `agents.<key>Persona` + `agents.<key>CustomPrompt`
8. Webview: logo asset in `resources/icons/`, boot URI in `src/webview/webviewContent.ts`, `LOGO_BY_ICON_PATH` in `media/chat/chat.js`, agent-menu item + wizard provider-card in `media/chat/index.html` (inside the provider-literals allowlist markers)
9. Add the id to `scripts/check-provider-literals.js` `PROVIDER_IDS` (lint guard) and `_getProviderDisplayName` in `SlashCommandManager.ts`
10. Tests: `TestableXProvider` in `tests/helpers/providerFactory.ts`, `createXSession` in `tests/helpers/sessionFactory.ts`, a `tests/providers/<name>/` suite, and the provider-id enumerations in `tests/providers/providerManifest.test.ts`, `tests/integration/chatViewDebranding.test.ts`, `tests/webview/mentionParsing.test.ts`

### Adding a New Persona (Markdown-based)

Create a markdown file in one of the agent source directories (priority order):

1. **Core** (bundled): `resources/agents/core/personas/my-persona.md`
2. **User** (home dir): `~/.mysti/agents/personas/my-persona.md`
3. **Workspace** (project): `.mysti/agents/personas/my-persona.md`

**Three-tier loading system** (managed by AgentLoader):

- **Tier 1 (Metadata)**: Always loaded for UI display — id, name, description, icon, category
- **Tier 2 (Instructions)**: Loaded on selection for prompt injection — instructions, priorities, practices
- **Tier 3 (Full)**: Loaded on demand — complete content including code examples

**Markdown format:**

```markdown
---
id: my-persona
name: My Persona
description: Brief description for UI display
icon: target
category: general
activationTriggers:
  - keyword1
  - keyword2
---

## Key Characteristics

Main instructions for the AI...

## Priorities

1. First priority
2. Second priority

## Best Practices

- Practice one
- Practice two

## Anti-Patterns to Avoid

- Avoid this
- Avoid that
```

### Adding a New Skill (Markdown-based)

Create a markdown file in one of the agent source directories (same priority order as personas, under `skills/` instead of `personas/`). Two layouts are supported:

- **Flat**: `skills/my-skill.md`
- **Directory (SKILL.md convention)**: `skills/my-skill/SKILL.md` — the Anthropic Agent Skills / gstack format. `skills.md`, `persona.md`, `agent.md`, and `index.md` basenames are also accepted (case-insensitive). When frontmatter has no `id`, it is derived from the `name` or directory name (slugified); unsafe ids are slugified. Shared parsing helpers live in `src/managers/agentMarkdown.ts`; later sources override earlier ones by id (workspace > user > plugin > core).

**User-created agents**: `mysti.createPersona` / `mysti.createSkill` (also "+ New" buttons in the webview agent panel) scaffold a template into `~/.mysti/agents/` (user scope) or `.mysti/agents/` (workspace scope) and open it. `mysti.reloadAgents` re-reads all sources; create/import flows reload automatically and broadcast `agentsUpdated` to all panels. Interactive flows: `src/managers/AgentStudio.ts`.

**Skill discovery (gstack etc.)**: `mysti.importSkills` discovers `SKILL.md` files in GitHub repos configured via `mysti.agents.skillSources` (`owner/repo[/path][@branch]`; defaults `garrytan/gstack`, `anthropics/skills`), lets the user multi-select, requires a modal confirmation (imported skills are prompt-injected content — untrusted until reviewed), and installs into `<scope>/skills/<id>/SKILL.md` with a provenance comment. Implementation: `src/services/SkillDiscoveryService.ts` (fetch-injectable, unit-tested).

**Syncing agents**: Run `npm run sync-agents` to fetch curated plugins from the `wshobson/agents` GitHub repository into `resources/agents/plugins/`. Caches for 24 hours; use `--force` to bypass.

**Content conformance**: `tests/resources/agentContentConformance.test.ts` validates every bundled file in `resources/agents/core` (frontmatter completeness, kebab-case ids, required sections). Run it after editing bundled agent content.

### Legacy: Static Personas/Skills (Fallback)

For backward compatibility, static definitions exist in `src/providers/base/IProvider.ts` (`PERSONA_PROMPTS`, `DEVELOPER_PERSONAS`, `DEVELOPER_SKILLS`). The dynamic markdown-based system takes precedence when `AgentContextManager` is set on a provider.
