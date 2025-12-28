# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Mysti is a VSCode extension providing a unified AI coding assistant interface supporting multiple AI backends (Claude Code CLI, OpenAI Codex CLI, and Google Gemini CLI). It features sidebar/tab chat panels, conversation persistence, multi-agent brainstorm mode (select 2 of 3 agents), permission controls, and plan selection.

## Build Commands

```bash
npm run compile           # Production build (webpack)
npm run watch             # Development build with watch mode
npm run lint              # ESLint check
npm run sync-agents       # Sync plugins from wshobson/agents repo
npm run sync-agents:force # Force sync (ignores 24h cache)
npx vsce package          # Package extension as .vsix
```

Output: `dist/extension.js` from entry point `src/extension.ts`

**Note:** Tests are not yet implemented (`npm run test` exists but has no test files).

## Development

Press `F5` in VSCode to launch Extension Development Host for debugging. Set breakpoints in TypeScript files and filter Debug Console with `[Mysti]` for extension logs.

**CLI requirements**: At least one of these CLIs must be installed for the extension to function:

- `npm install -g @anthropic-ai/claude-code` (Claude Code)
- `npm install -g @google/gemini-cli` (Gemini)
- Codex CLI (OpenAI - follow their installation guide)

## Architecture

### Core Pattern: Manager + Provider Facades

```
extension.ts (entry)
    │
    ├── Managers (business logic)
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
    └── ChatViewProvider (UI coordinator)
            │
            └── Providers (CLI integrations)
                ├── ClaudeCodeProvider (extends BaseCliProvider)
                ├── CodexProvider (extends BaseCliProvider)
                └── GeminiProvider (extends BaseCliProvider)
```

### Key Design Decisions

- **Per-panel isolation**: Each webview panel (sidebar or tab) has independent state, conversation, and child process
- **CLI-based providers**: Spawn `claude`/`codex`/`gemini` CLI with `--output-format stream-json`, parse line-delimited JSON events
- **AsyncGenerator streaming**: Providers yield `StreamChunk` items for real-time response updates
- **Webview communication**: Extension ↔ webview via `postMessage()` with typed `WebviewMessage`

### Provider Data Flow

1. User message → ChatViewProvider._handleMessage()
2. Context collection → ContextManager.getContext()
3. Provider selection → ProviderManager._getActiveProvider()
4. CLI spawn → Provider.sendMessage() returns AsyncGenerator<StreamChunk>
5. Stream parsing → parseStreamLine() yields chunks (text, thinking, tool_use, etc.)
6. UI update → postMessage() back to webview

## Key Types (src/types.ts)

- `StreamChunk` - Events from provider CLI (text, thinking, tool_use, tool_result, error, done)
- `WebviewMessage` - Extension ↔ webview communication
- `Message` / `Conversation` - Persistent chat data
- `OperationMode` - "ask-before-edit" | "edit-automatically" | "plan"
- `AccessLevel` - "read-only" | "ask-permission" | "full-access"

## Constants (src/constants.ts)

System-wide constants for timeouts, limits, and configuration:

- `PROCESS_TIMEOUT_MS` - CLI process timeout (5 minutes)
- `PROCESS_KILL_GRACE_PERIOD_MS` - Grace period before force kill (5 seconds)
- `PROCESS_FORCE_KILL_TIMEOUT_MS` - Final force kill timeout (10 seconds)
- `AUTH_POLL_INTERVAL_MS` / `AUTH_POLL_MAX_ATTEMPTS` - Authentication polling (2s interval, 60 attempts = 2 min)
- `PERMISSION_DEFAULT_TIMEOUT_S` / `PERMISSION_MAX_TIMEOUT_S` - Permission timeouts (30s default, 5 min max)
- `MAX_CONVERSATION_MESSAGES` - Maximum messages in history (10)

## Conventions

- Private members use leading underscore: `_extensionContext`, `_currentProcess`
- Console logging with `[Mysti]` prefix
- Managers are single-responsibility classes
- New providers extend `BaseCliProvider` and implement `ICliProvider`

## VSCode Integration Points

- View: `mysti.chatView` (webview sidebar)
- Commands:
  - `mysti.openChat` - Open sidebar chat
  - `mysti.newConversation` - Start new conversation
  - `mysti.addToContext` - Add file/selection to context
  - `mysti.clearContext` - Clear context
  - `mysti.openInNewTab` - Open chat in editor tab
  - `mysti.debugSetup` / `mysti.debugSetupFailure` - Debug CLI setup flow
- Keybindings:
  - `Ctrl+Shift+M` (Mac: `Cmd+Shift+M`) - Open chat
  - `Ctrl+Shift+N` (Mac: `Cmd+Shift+N`) - Open in new tab
- Settings namespace: `mysti.*` (18+ settings covering provider, mode, access, brainstorm, agents, permissions)

## Webview UI

Two large files handle the UI:

- `src/providers/ChatViewProvider.ts` (~88KB) - Main webview coordinator, handles all message routing between extension and webview
- `src/webview/webviewContent.ts` - Embedded HTML/CSS/JS for the chat interface

Libraries:
- Marked.js for markdown rendering
- Prism.js for syntax highlighting
- Mermaid.js for diagrams
- Resources loaded from `resources/` folder

## Extension Points

### Adding a New Provider

1. Create class extending `BaseCliProvider` in `src/providers/newprovider/`
2. Implement abstract methods: `discoverCli()`, `getCliPath()`, `buildCliArgs()`, `parseStreamLine()`, `getThinkingTokens()`
3. Register in `src/providers/ProviderRegistry.ts`
4. Add to `ProviderType` union in `src/types.ts`
5. Add configuration options in `package.json`

### Adding a New Persona (Markdown-based)

**Current count**: 16 core personas in `resources/agents/core/personas/`

Create a markdown file in one of the agent source directories (priority order):

1. **Core** (bundled): `resources/agents/core/personas/my-persona.md`
2. **User** (home dir): `~/.mysti/agents/personas/my-persona.md`
3. **Workspace** (project): `.mysti/agents/personas/my-persona.md`

**Three-tier loading system** (managed by AgentLoader):

- **Tier 1 (Metadata)**: Always loaded for UI display - id, name, description, icon, category
- **Tier 2 (Instructions)**: Loaded on selection for prompt injection - instructions, priorities, practices
- **Tier 3 (Full)**: Loaded on demand - complete content including code examples

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

**Current count**: 12 core skills in `resources/agents/core/skills/`

Create a markdown file in one of the agent source directories (priority order):

1. **Core** (bundled): `resources/agents/core/skills/my-skill.md`
2. **User** (home dir): `~/.mysti/agents/skills/my-skill.md`
3. **Workspace** (project): `.mysti/agents/skills/my-skill.md`

**Markdown format:**

```markdown
---
id: my-skill
name: My Skill
description: Brief description
icon: ⚡
category: workflow
activationTriggers:
  - trigger1
---

## Instructions

Detailed instructions for the AI when this skill is enabled...
```

**Syncing agents**: Run `npm run sync-agents` to fetch curated plugins from the `wshobson/agents` GitHub repository into `resources/agents/plugins/`. The script caches for 24 hours; use `--force` to bypass.

### Legacy: Static Personas/Skills (Fallback)

For backward compatibility, static definitions still exist:

1. Add ID to `DeveloperPersonaId` in `src/types.ts`
2. Define persona in `DEVELOPER_PERSONAS` record in `src/providers/base/IProvider.ts`
3. Add icon to `resources/icons/`
