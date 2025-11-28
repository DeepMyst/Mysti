# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Mysti is a VSCode extension providing a unified AI coding assistant interface supporting multiple AI backends (Claude Code CLI and OpenAI Codex CLI). It features sidebar/tab chat panels, conversation persistence, multi-agent brainstorm mode, permission controls, and plan selection.

## Build Commands

```bash
npm run compile      # Production build (webpack)
npm run watch        # Development build with watch mode
npm run lint         # ESLint check
npm run test         # Run tests
```

Output: `dist/extension.js` from entry point `src/extension.ts`

## Architecture

### Core Pattern: Manager + Provider Facades

```
extension.ts (entry)
    │
    ├── Managers (business logic)
    │   ├── ContextManager      - File/selection tracking
    │   ├── ConversationManager - Message persistence via globalState
    │   ├── ProviderManager     - Provider registry facade
    │   ├── PermissionManager   - Access control
    │   ├── BrainstormManager   - Multi-agent orchestration
    │   ├── ResponseClassifier  - AI-powered response analysis
    │   ├── PlanOptionManager   - Implementation plan extraction
    │   └── SuggestionManager   - Quick action suggestions
    │
    └── ChatViewProvider (UI coordinator)
            │
            └── Providers (CLI integrations)
                ├── ClaudeCodeProvider (extends BaseCliProvider)
                └── CodexProvider (extends BaseCliProvider)
```

### Key Design Decisions

- **Per-panel isolation**: Each webview panel (sidebar or tab) has independent state, conversation, and child process
- **CLI-based providers**: Spawn `claude`/`codex` CLI with `--output-format stream-json`, parse line-delimited JSON events
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

## Conventions

- Private members use leading underscore: `_extensionContext`, `_currentProcess`
- Console logging with `[Mysti]` prefix
- Managers are single-responsibility classes
- New providers extend `BaseCliProvider` and implement `ICliProvider`

## VSCode Integration Points

- View: `mysti.chatView` (webview sidebar)
- Commands: `mysti.openChat`, `mysti.newConversation`, `mysti.addToContext`, `mysti.clearContext`, `mysti.openInNewTab`
- Settings namespace: `mysti.*` (13 settings covering provider, mode, access, brainstorm)

## Webview UI

`src/webview/webviewContent.ts` contains embedded HTML/CSS/JS (large file). Uses:
- Marked.js for markdown rendering
- Prism.js for syntax highlighting
- Mermaid.js for diagrams
- Resources loaded from `resources/` folder
