# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Mysti is a VSCode extension providing a unified AI coding assistant interface supporting multiple AI backends (Claude Code CLI, OpenAI Codex CLI, Google Gemini CLI, Cline, and GitHub Copilot CLI). It features sidebar/tab chat panels, conversation persistence, multi-agent brainstorm mode (select 2 of 5 agents), permission controls, plan selection, and a three-tier agent loading system for personas and skills.

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

## Architecture

### Core Pattern: Manager + Provider Facades

```
extension.ts (entry — activate() wires everything)
    │
    ├── Managers (business logic, src/managers/)
    │   ├── ContextManager        - File/selection tracking
    │   ├── ConversationManager   - Message persistence via globalState
    │   ├── ProviderManager       - Provider registry facade
    │   ├── PermissionManager     - Access control
    │   ├── BrainstormManager     - Multi-agent orchestration
    │   ├── ResponseClassifier    - AI-powered response analysis
    │   ├── PlanOptionManager     - Implementation plan extraction
    │   ├── SuggestionManager     - Quick action suggestions
    │   ├── SetupManager          - CLI auto-setup & authentication
    │   ├── AgentLoader           - Three-tier agent loading from markdown
    │   ├── AgentContextManager   - Recommendations & prompt building
    │   ├── TelemetryManager      - Anonymous usage analytics
    │   └── AutocompleteManager   - Autocomplete functionality
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
                └── CopilotProvider     (extends BaseCliProvider)
```

### Key Design Decisions

- **Per-panel isolation**: Each webview panel (sidebar or tab) has independent state, conversation, and child process
- **CLI-based providers**: Spawn `claude`/`codex`/`gemini`/`cline`/`copilot` CLI with `--output-format stream-json`, parse line-delimited JSON events
- **AsyncGenerator streaming**: Providers yield `StreamChunk` items for real-time response updates
- **Webview communication**: Extension ↔ webview via `postMessage()` with typed `WebviewMessage`
- **MCP Permission Server** (`src/mcp/permissionServer.ts`): Intermediary between Claude Code CLI and VSCode for permission requests. Flow: `Claude CLI --stdin/stdout--> MCP Server --HTTP--> VSCode Extension --postMessage--> Webview UI`

### Provider Data Flow

1. User message → `ChatViewProvider._handleMessage()`
2. Context collection → `ContextManager.getContext()`
3. Provider selection → `ProviderManager._getActiveProvider()`
4. CLI spawn → `Provider.sendMessage()` returns `AsyncGenerator<StreamChunk>`
5. Stream parsing → `parseStreamLine()` yields chunks (text, thinking, tool_use, etc.)
6. UI update → `postMessage()` back to webview

### Brainstorm Mode Data Flow

1. User enables brainstorm (2 of 5 agents selected via settings)
2. `BrainstormManager` dispatches message to both agents in parallel
3. Quick mode: Direct synthesis from both responses. Full mode: Agents review each other's responses (configurable rounds)
4. Synthesis agent combines into final response

## Key Types (src/types.ts)

- `StreamChunk` - Events from provider CLI (text, thinking, tool_use, tool_result, error, done)
- `WebviewMessage` - Extension ↔ webview communication
- `Message` / `Conversation` - Persistent chat data
- `OperationMode` - "default" | "ask-before-edit" | "edit-automatically" | "quick-plan" | "detailed-plan"
- `AccessLevel` - "read-only" | "ask-permission" | "full-access"
- `ProviderType` / `AgentType` - "claude-code" | "openai-codex" | "google-gemini" | "cline" | "github-copilot"

## Constants (src/constants.ts)

- `PROCESS_TIMEOUT_MS` — 5 minutes
- `PROCESS_KILL_GRACE_PERIOD_MS` — 5 seconds
- `PROCESS_FORCE_KILL_TIMEOUT_MS` — 10 seconds
- `AUTH_POLL_INTERVAL_MS` / `AUTH_POLL_MAX_ATTEMPTS` — 2s interval, 60 attempts (2 min total)
- `PERMISSION_DEFAULT_TIMEOUT_S` / `PERMISSION_MAX_TIMEOUT_S` — 30s default, 5 min max
- `MAX_CONVERSATION_MESSAGES` — 10

## Conventions

- Private members use leading underscore: `_extensionContext`, `_currentProcess`
- Console logging with `[Mysti]` prefix
- Managers are single-responsibility classes
- New providers extend `BaseCliProvider` and implement `ICliProvider`
- All source files carry the BUSL-1.1 license header
- TypeScript strict mode enabled, target ES2022

## VSCode Integration Points

- View: `mysti.chatView` (webview sidebar)
- Commands: `mysti.openChat`, `mysti.newConversation`, `mysti.addToContext`, `mysti.clearContext`, `mysti.openInNewTab`, `mysti.debugSetup`, `mysti.debugSetupFailure`
- Keybindings: `Ctrl+Shift+M` / `Cmd+Shift+M` (open chat), `Ctrl+Shift+N` / `Cmd+Shift+N` (new tab)
- Settings namespace: `mysti.*` (25+ settings covering provider, mode, access, brainstorm, agents, permissions)
- Custom language IDs: `claude-prompt`, `prompt-markdown`, `gpt-prompt`, `gemini-prompt`, `codex-prompt`
- Activation: `onStartupFinished` + `workspaceContains` triggers for config files (`.mysti/`, `.claude/`, `.gemini/`, `.openai/`, `claude.md`, `gemini.yaml`, `codex.json`, `agents.yaml`)

## Webview UI

Two large files handle the UI:

- `src/providers/ChatViewProvider.ts` — Main webview coordinator, handles all message routing between extension and webview
- `src/webview/webviewContent.ts` — Embedded HTML/CSS/JS for the chat interface

Libraries loaded from `resources/` folder: Marked.js (markdown), Prism.js (syntax highlighting), Mermaid.js (diagrams).

## Extension Points

### Adding a New Provider

1. Create class extending `BaseCliProvider` in `src/providers/newprovider/`
2. Implement abstract methods: `discoverCli()`, `getCliPath()`, `buildCliArgs()`, `parseStreamLine()`, `getAuthConfig()`, `checkAuthentication()`, `getAuthCommand()`, `getInstallCommand()`
3. Register in `src/providers/ProviderRegistry.ts` (add to `_registerBuiltInProviders()`)
4. Add to `ProviderType` union in `src/types.ts`
5. Add agent style entry in `BrainstormManager.ts` `AGENT_STYLES` record
6. Add configuration options in `package.json` (`mysti.*` settings)

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
icon: 🎯
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
