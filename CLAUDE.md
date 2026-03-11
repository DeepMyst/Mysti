# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Mysti is a VSCode extension providing a unified AI coding assistant interface supporting 12 AI backends (Claude Code, OpenAI Codex, Google Gemini, Cline, GitHub Copilot, Cursor, OpenClaw, OpenCode, Qwen Code, Ollama, LocalAI, and Manus). It features sidebar/tab chat panels, conversation persistence, multi-agent brainstorm mode (any 2 of 11 agents with 5 collaboration strategies), autonomous mode with safety classification, @-mention agent routing, permission controls, plan selection, context compaction, and a three-tier agent loading system for personas and skills.

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

**Note:** Tests are not yet implemented (`npm run test` exists but has no test files).

## Development

Press `F5` in VSCode to launch Extension Development Host for debugging. Set breakpoints in TypeScript files and filter Debug Console with `[Mysti]` for extension logs.

**CLI requirements**: At least one of these CLIs must be installed for the extension to function:

- `npm install -g @anthropic-ai/claude-code` (Claude Code)
- `npm install -g @google/gemini-cli` (Gemini)
- `npm install -g @github/copilot-cli` (GitHub Copilot)
- Codex CLI (OpenAI - follow their installation guide)
- `npm install -g cline` (Cline)
- `curl https://cursor.com/install -fsS | bash` (Cursor)
- `npm install -g openclaw@latest` (OpenClaw)
- `npm i -g opencode-ai@latest` (OpenCode)
- `npm install -g @qwen-code/qwen-code@latest` (Qwen Code)
- Ollama (install from ollama.com)
- LocalAI (install from localai.io)

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
                └── ManusProvider       (extends BaseCliProvider, API-based)
```

### Key Design Decisions

- **Per-panel isolation**: Each webview panel (sidebar or tab) has independent state, conversation, and child process. Provider instances are singletons but mutable state is per-panel via `_panelSessions: Map<string, PanelSessionState>`. Each provider subclass extends the base session type (e.g., `ClaudeSessionState`, `CodexSessionState`).
- **CLI-based providers**: Spawn CLI processes with `--output-format stream-json`, parse line-delimited JSON events. OpenClaw additionally supports WebSocket streaming via its Gateway daemon.
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

## Key Types (src/types.ts)

- `StreamChunk` - Events from provider CLI (text, thinking, tool_use, tool_result, error, done, session_active, ask_user_question, compaction)
- `WebviewMessage` - Extension ↔ webview communication
- `Message` / `Conversation` - Persistent chat data
- `OperationMode` - "default" | "ask-before-edit" | "edit-automatically" | "quick-plan" | "detailed-plan"
- `AccessLevel` - "read-only" | "ask-permission" | "full-access"
- `ProviderType` / `AgentType` - "claude-code" | "openai-codex" | "google-gemini" | "cline" | "github-copilot" | "cursor" | "openclaw" | "opencode" | "qwen-code" | "ollama" | "localai"
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
- Commands: `mysti.openChat`, `mysti.newConversation`, `mysti.addToContext`, `mysti.clearContext`, `mysti.openInNewTab`, `mysti.toggleAutonomous`, `mysti.debugSetup`, `mysti.debugSetupFailure`
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
4. Register in `src/providers/ProviderRegistry.ts` (add to `_registerBuiltInProviders()`)
5. Add to `ProviderType` union in `src/types.ts`
6. Add agent style entry in `BrainstormManager.ts` `AGENT_STYLES` record
7. Add configuration options in `package.json` (`mysti.*` settings)

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

Create a markdown file in one of the agent source directories (same priority order as personas, under `skills/` instead of `personas/`).

**Syncing agents**: Run `npm run sync-agents` to fetch curated plugins from the `wshobson/agents` GitHub repository into `resources/agents/plugins/`. Caches for 24 hours; use `--force` to bypass.

### Legacy: Static Personas/Skills (Fallback)

For backward compatibility, static definitions exist in `src/providers/base/IProvider.ts` (`PERSONA_PROMPTS`, `DEVELOPER_PERSONAS`, `DEVELOPER_SKILLS`). The dynamic markdown-based system takes precedence when `AgentContextManager` is set on a provider.
