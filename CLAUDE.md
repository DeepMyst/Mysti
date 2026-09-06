# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Mysti is a VSCode extension providing a unified AI coding assistant interface supporting 15 AI backends (Claude Code, OpenAI Codex, Google Gemini, Cline, GitHub Copilot, Cursor, OpenClaw, OpenCode, Qwen Code, Ollama, LocalAI, Hermes, Continue, OpenRouter, and Kimi Code). It features sidebar/tab chat panels, conversation persistence, multi-agent brainstorm mode (any 2 of 11 agents with 5 collaboration strategies), autonomous mode with safety classification, @-mention agent routing, permission controls, plan selection, context compaction, and a three-tier agent loading system for personas and skills.

## Build Commands

```bash
npm run compile           # Production build (webpack)
npm run watch             # Development build with watch mode
npm run lint              # ESLint check (src/**/*.ts)
npm run sync-agents       # Sync plugins from wshobson/agents repo
npm run sync-agents:force # Force sync (ignores 24h cache)
npx vsce package          # Package extension as .vsix
```

Output: `dist/extension.js` from entry point `src/extension.ts` (webpack bundles with ts-loader, target: node, CommonJS2).

**Tests:** the repo has a Vitest suite (`npm test` → `vitest run`, ~135 files / 1800+ tests) plus `npx tsc --noEmit` for type-checking. Run BOTH before and after changes — regressions in the coordinator/provider code are caught here. `vscode` is aliased to `tests/helpers/mockVscode.ts`.

**Mysti agent (coordinator):** beyond the 14 CLI backends, Mysti has a first-class *coordinator* agent (`settings.provider === 'mysti'`) that streams its OWN model (OpenRouter free chain / DeepMyst gateway) and acts through a per-run nonce-fenced directive protocol — `<delegate:NONCE agent="…" tier="fast|strong">`, `<read:>`, `<ls:>`, `<grep:>`, `<diag:>`, `<remember:>` — parsed mid-stream by `MystiTagScanner`. The ReAct loop is `ChatViewProvider._runMystiAgentic`; local read-only tools are `MystiLocalTools`; delegations run through the gated `CollaboratorPool`; durable background jobs are `BackgroundJobManager`. Security invariants: the coordinator has NO local write/bash tool; every untrusted result re-entering the model is nonce-redacted + UNTRUSTED-fenced; the `dm_` gateway key is sent only to `*.deepmyst.com`; workspace settings may only LOWER authority (see `settingsClamp` + machine-scoped `mysti.mysti.*` spend/permission settings).

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
    │   └── ChannelBridge         - Routes messages between daemon channels and panels
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
                └── ManusProvider       (extends BaseCliProvider, API-based)
```

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

## Provider-native commands

Each backend's own `/command` vocabulary appears in a provider-titled section of
the slash menu ("Claude Code commands"). Three sources feed it, first match wins:

1. `NATIVE_COMMANDS` in `src/providers/base/NativeCommands.ts` — curated built-ins
2. `ICliProvider.getDynamicNativeCommands()` — ACP backends (Hermes, Kimi) are
   TOLD their commands in `session/update -> available_commands_update`
3. `NativeCommandDiscovery` (`src/services/`) — the user's own files, read from
   the directories in `NATIVE_COMMAND_SOURCES` (`.claude/commands` + skills,
   `.gemini`/`.qwen/commands/*.toml`, `~/.codex/prompts`, `.cursor/commands`,
   `.clinerules/workflows`, `.opencode/command`). Cached; reads are sync, refresh
   is background, and the menu is re-posted only when the set changes.

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

Commands that are TUI-only with no Mysti equivalent are deliberately absent — do
not add them back from a CLI's `/help` output. Ollama/LocalAI/OpenRouter are HTTP
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
- `ProviderType` / `AgentType` - "claude-code" | "openai-codex" | "google-gemini" | "cline" | "github-copilot" | "cursor" | "openclaw" | "opencode" | "qwen-code" | "ollama" | "localai" | "hermes" | "continue"
- `CollaborationStrategy` - "quick" | "debate" | "red-team" | "perspectives" | "delphi"
- `SafetyLevel` - "safe" | "caution" | "blocked"
- `AutonomousSafetyMode` - "conservative" | "balanced" | "aggressive"
- `ThinkingLevel` - "none" | "low" | "medium" | "high"
- `CompactionStrategy` - "native-cli" | "client-summarize"
- `ProviderCapabilities` - Feature flags per provider (supportsStreaming, supportsThinking, supportsToolUse, supportsSessions, supportsNativeCompact, supportsImages, etc.)

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
- `MANUS_API_BASE_URL` — `https://api.manus.im`, poll every 3s

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

- View: `mysti.chatView` (webview sidebar)
- Commands: `mysti.openChat`, `mysti.newConversation`, `mysti.addToContext`, `mysti.clearContext`, `mysti.openInNewTab`, `mysti.toggleAutonomous`, `mysti.debugSetup`, `mysti.debugSetupFailure`, `mysti.createPersona`, `mysti.createSkill`, `mysti.importSkills`, `mysti.reloadAgents`
- Keybindings: `Ctrl+Shift+M` / `Cmd+Shift+M` (open chat), `Ctrl+Shift+N` / `Cmd+Shift+N` (new tab), `Ctrl+Shift+A` / `Cmd+Shift+A` (toggle autonomous)
- Settings namespace: `mysti.*` (50+ settings covering provider, mode, access, brainstorm, agents, permissions, autonomous, compaction, lifecycle, active mode)
- Custom language IDs: `claude-prompt`, `prompt-markdown`, `gpt-prompt`, `gemini-prompt`, `codex-prompt`
- Activation: `onStartupFinished` + `workspaceContains` triggers for config files (`.mysti/`, `.claude/`, `.gemini/`, `.openai/`, `.openclaw/`, `.qwen/`, `claude.md`, `gemini.yaml`, `codex.json`, `agents.yaml`)

## Webview UI

Two large files handle the UI:

- `src/providers/ChatViewProvider.ts` — Main webview coordinator (16-param constructor), handles all message routing between extension and webview
- `src/webview/webviewContent.ts` — Embedded HTML/CSS/JS for the chat interface

Libraries loaded from `resources/` folder: Marked.js (markdown), Prism.js (syntax highlighting), Mermaid.js (diagrams).

## Extension Points

### Adding a New Provider

1. Create class extending `BaseCliProvider` in `src/providers/newprovider/`
2. Implement abstract methods: `discoverCli()`, `getCliPath()`, `buildCliArgs()`, `parseStreamLine()`, `getAuthConfig()`, `checkAuthentication()`, `getAuthCommand()`, `getInstallCommand()`
3. Implement `_createSession(panelId)` to return provider-specific session state
   - Declare `capabilities.supportsPromptEnhancement` truthfully: `true` only if the provider implements the optional `enhancePrompt()`. The webview enables/disables the "Enhance prompt" button off this flag, and `tests/providers/promptEnhancement.test.ts` fails if the flag and the method ever disagree.
4. Register in `src/providers/ProviderRegistry.ts` (add to `_registerBuiltInProviders()`)
5. Add to `ProviderType` AND `AgentType` unions in `src/types.ts`
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
