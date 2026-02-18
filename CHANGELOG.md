# Changelog

All notable changes to the Mysti extension will be documented in this file.

## [0.3.0] - February 2026

### Added

- **Cursor Provider**: Full integration with Cursor's headless AI agent CLI
  - Supports Auto, Claude Sonnet 4, Claude Sonnet 4 Thinking, GPT-5, OpenAI o3, Gemini 2.5 Pro
  - Auto-approve mode for full-access workflows
  - Cumulative streaming deduplication for accurate output
- **OpenClaw Provider**: Dual-transport provider with WebSocket Gateway and CLI fallback
  - Primary: Real-time WebSocket streaming via `ws://127.0.0.1:18789`
  - Fallback: CLI spawn with NDJSON streaming
  - Supports Claude Opus 4.6, Claude Sonnet 4.5, GPT-5
  - Configurable thinking levels (off, low, medium, high)
- **Manus Provider** (Experimental): HTTP API-based provider for Manus AI
  - Async polling workflow with multi-turn conversation support
  - Models: Manus 1.6 Max, Manus 1.6, Manus 1.6 Lite
- **Autonomous Mode**: AI works independently with configurable safety controls
  - SafetyClassifier with three levels: safe, caution, blocked
  - Three safety modes: conservative, balanced, aggressive
  - MemoryManager learns user preferences over time with confidence decay
  - Continuation modes: goal-based and task-queue
  - Audit logging for all autonomous decisions
  - Hardcoded safety blocks for destructive operations (file deletion, force push, etc.)
- **@-Mention System**: Multi-agent task routing and file context
  - `@agent` mentions route tasks to specific providers with sequential execution
  - `@file` mentions resolve to transient context items
  - Heuristic-based task generation with AI fallback
  - Auto-retry and dependency tracking for sub-agent tasks
- **Context Compaction**: Smart conversation compaction to prevent context overflow
  - Native CLI strategy (`/compact`) for providers that support it
  - Client-side summarization strategy for other providers
  - Per-panel cumulative token tracking with threshold-based triggering
  - Independent brainstorm agent tracking
- **Brainstorm Team Reasoning**: 5 collaboration strategies replacing simple quick/full modes
  - Quick: Direct synthesis from both agents
  - Debate: Critic vs Defender role-based discussion
  - Red-Team: Proposer vs Challenger adversarial review
  - Perspectives: Risk-Analyst vs Innovator complementary viewpoints
  - Delphi: Facilitator vs Refiner iterative convergence
  - Convergence detection with auto-convergence setting
  - Parallel discussion via interleaved generators
- **Agent Lifecycle Management**: Session lifecycle with idle timeout and process protection
  - Configurable idle timeout (default 1 hour)
  - Cross-platform process tree tracking via `pgrep`/`wmic`
  - Graceful shutdown with child process protection
  - Activity tracking via touch/busy/idle API
- **Slash Command System**: Centralized command registry replacing scattered handlers
  - Organized by sections: Context, Model, Customize, Commands, Settings, Support
  - Provider-specific commands (`/compact`, `/thinking`, `/profile`, `/plan-act`)
  - QuickPick dialogs for model, provider, mode, and access level selection
  - Dynamic values showing current configuration state
- **Per-Panel Session Isolation**: Each webview panel has fully independent state
  - Provider sessions tracked via `_panelSessions: Map<string, PanelSessionState>`
  - Context isolation via `_panelContexts` per panel
  - Independent process management and cancellation per panel

### Changed

- Brainstorm mode now supports 5 collaboration strategies (was quick/full)
- Provider count increased to 7 (was 4): added Cursor, OpenClaw, Manus
- Discussion mode runs in parallel via interleaved generators (was sequential)
- Slash commands now managed by centralized SlashCommandManager

### New Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.autonomous.safetyMode` | `balanced` | Safety mode: conservative, balanced, aggressive |
| `mysti.autonomous.maxSessionDuration` | `24` | Max autonomous session duration (hours) |
| `mysti.autonomous.allowFileCreation` | `true` | Allow file creation in autonomous mode |
| `mysti.autonomous.allowFileEdit` | `true` | Allow file editing in autonomous mode |
| `mysti.autonomous.allowBashCommands` | `true` | Allow bash commands in autonomous mode |
| `mysti.autonomous.blockPatterns` | `[]` | Custom block patterns for autonomous safety |
| `mysti.compaction.enabled` | `true` | Enable context compaction |
| `mysti.compaction.threshold` | `75` | Compaction threshold (% of context window) |
| `mysti.lifecycle.enabled` | `true` | Enable agent lifecycle management |
| `mysti.lifecycle.idleTimeoutMinutes` | `60` | Idle timeout before session expiry |
| `mysti.lifecycle.processTreeTracking` | `true` | Track child processes for shutdown protection |
| `mysti.brainstorm.strategy` | `quick` | Collaboration strategy |
| `mysti.brainstorm.autoConverge` | `true` | Auto-exit discussion when agents converge |
| `mysti.brainstorm.maxDiscussionRounds` | `3` | Maximum discussion rounds |
| `mysti.cursorPath` | `agent` | Path to Cursor CLI executable |
| `mysti.cursorModel` | `auto` | Default Cursor model |
| `mysti.openclawPath` | `openclaw` | Path to OpenClaw CLI executable |
| `mysti.openclawModel` | `claude-opus-4-6` | Default OpenClaw model |
| `mysti.openclawUseGateway` | `true` | Use WebSocket Gateway for OpenClaw |

---

## [0.2.0] - December 2025

### Added

- **Three-tier Agent Loading System**: Progressive loading for personas and skills from markdown files
  - Tier 1: Metadata (always loaded for fast UI)
  - Tier 2: Instructions (loaded on selection)
  - Tier 3: Full content with examples (loaded on demand)
- **Toolbar Persona Indicator**: Quick persona switching from the input toolbar
  - Shows active persona name
  - Click to view all personas or context-aware suggestions
- **Inline Suggestions Widget**: Compact persona recommendations above input area
  - Auto-suggests personas based on message content (enabled by default)
  - Toggle auto-suggest on/off inline
  - Dismiss button to hide suggestions
- **Optional Token Budget**: Control agent context size
  - Disabled by default (0 = unlimited)
  - Enable via settings to limit token usage for agent context
- **Google Gemini Provider**: Full Gemini CLI integration as third AI provider
  - Complete streaming support with `--output-format stream-json`
  - Configurable in brainstorm mode alongside Claude and Codex
- **VS Code Auto-Activation**: Extension activates when AI config files detected
  - Workspace triggers: `CLAUDE.md`, `gemini.yaml`, `codex.json`, `agents.yaml`
  - Directory triggers: `.mysti/`, `.claude/`, `.gemini/`, `.openai/`
- **Custom Language Definitions**: Special file type recognition
  - `.claude.md`, `.prompt.md`, `.gpt.md`, `.gemini.md`, `.codex.md`
  - Enables VS Code extension recommendations for prompt files
- **Latest AI Models**: Updated model support across providers
  - Claude: claude-sonnet-4-5-20250929
  - Codex: GPT-5.2, GPT-5.2 Thinking
  - Gemini: Gemini 3 Deep Think
- **Azure Telemetry**: Anonymous usage analytics via Application Insights

### Changed

- Auto-suggest for personas is now **enabled by default**
- Token budget default changed from 2000 to 0 (unlimited)
- Persona selection now shows inline instead of opening full agent config panel
- Welcome message updated to "Your AI coding team"
- Brainstorm agents now configurable (select any 2 of 3 providers)
- README optimized for VS Code Marketplace discovery

### New Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.agents.autoSuggest` | `true` | Auto-suggest personas based on message content |
| `mysti.agents.maxTokenBudget` | `0` | Max tokens for agent context (0 = unlimited) |
| `mysti.brainstorm.agents` | `["claude-code", "openai-codex"]` | Select which 2 agents for brainstorm |
| `mysti.geminiPath` | `gemini` | Path to Gemini CLI executable |

## [0.1.0] - December 2025

### Initial Release

- Initial release
- Multi-provider support (Claude Code CLI, OpenAI Codex CLI)
- Brainstorm mode with multi-agent collaboration
- 16 developer personas
- 12 toggleable skills
- Plan selection and execution
- Permission management system
- Persistent conversation history
- Context-aware suggestions
- Syntax highlighting with Prism.js
- Mermaid diagram support
- Theme-aware UI (light/dark)
