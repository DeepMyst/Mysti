# Changelog

All notable changes to the Mysti extension will be documented in this file.

## [0.4.0] - March 2026

### Added

- **OpenCode Provider**: Multi-backend coding agent supporting Anthropic, OpenAI, Google, Groq — closes #25
  - CLI: `opencode run --format json --thinking`
  - Uses configured default model (no hardcoded model list)
  - Agents: `build` (full access) and `plan` (read-only)
  - Session resume via `--session <id>`
- **Qwen Code Provider**: Alibaba's AI coding CLI agent
  - Same streaming protocol as Claude Code (stream-json NDJSON)
  - Approval modes: plan, default, auto-edit, yolo
  - Auth error detection with guided authentication UI
  - Models: Qwen3 Coder, Qwen3 Coder Plus
- **Ollama Provider**: Local LLM inference via Ollama CLI — closes #24
- **LocalAI Provider**: Self-hosted AI model provider — closes #24
- **Provider Logos**: Authentic logos with transparent backgrounds for OpenCode, Ollama, LocalAI, Qwen Code
- **Test Infrastructure**: 360 automated tests via vitest with mock provider system
- **Brainstorm Stability** (18 fixes):
  - Silence-based timeout — agents aborted after 90s of no output (B1)
  - Auth pre-check — validates provider authentication before starting (B2)
  - Synthesis fallback feedback — UI shows "retrying with [agent]..." on failure (B3)
  - Oscillation detection — catches flip-flopping discussion positions (B4)
  - Convergence regex broadening — handles varied score phrasings (B5)
  - Duplicate agent validation — prevents selecting same agent twice (B8)
  - Cancel propagation — stops all sub-processes on cancel (B9)
- **@-Mention Stability**:
  - Sub-agent question timeout — auto-skips after 5 minutes (M1)
  - Max mentions per message — caps at 5 mentions (M2)
  - File resolution warnings — user sees when file mentions fail (M7)
  - Retry process cleanup — cancels previous attempt before retry (M8)
  - Full-path file mention matching — `@src/utils.ts` now resolves correctly
- **New Managers**: CommitSignatureManager, EngagementManager, ProjectContextManager, TeamPresenceManager
- **Editor Integration**: MystiCodeLensProvider, MystiFileDecorationProvider
- **Permission Classifier**: Utility for categorizing CLI operations

### Fixed

- Windows `spawn EINVAL` error — auto-enable `shell: true` on Windows + `mysti.useShellForCli` setting — closes #14
- Brainstorm ignores `mysti.codexPath` — now uses shared provider instance with `_getConfiguredCliPath()` — closes #26
- Mention parsing regex too broad — refined to `/@([\w\-./]+)/` (M3)
- File mention matching too greedy — requires 3+ chars and path boundary (M4)
- Invalid agent mentions produce confusing errors — validates against known agents (M5)
- Empty discussion contributions causing false convergence (B6)
- Text similarity filter dropping short meaningful words like "not", "bug" (B7)
- Qwen Code: Removed invalid `--verbose` CLI flag
- Qwen Code: Fixed bare `-p` flag usage (prompt delivered via stdin)
- Qwen Code: Fixed approval mode values (lowercase: plan/auto-edit/yolo)
- OpenCode: Fixed `[object Object]` error display for non-string error objects
- OpenCode: Removed hardcoded model list causing "Model not found" errors
- BaseCliProvider: Hardened error handling for non-Error thrown objects
- New providers now correctly appear in all UI dropdowns, agent menus, and brainstorm selectors
- Fixed agent selection display showing Claude when selecting new providers

### Changed

- Provider count increased to 12 (was 7): added OpenCode, Qwen Code, Ollama, LocalAI, Manus
- Brainstorm discussion more resilient with convergence guards and silence timeout
- @-mention system more robust with limits, timeouts, and validation

### New Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.opencodePath` | `opencode` | Path to OpenCode CLI |
| `mysti.opencodeModel` | `` | Custom OpenCode model |
| `mysti.qwenCodePath` | `qwen` | Path to Qwen Code CLI |
| `mysti.qwenCodeModel` | `` | Custom Qwen model |
| `mysti.ollamaPath` | `ollama` | Path to Ollama CLI |
| `mysti.ollamaModel` | `` | Custom Ollama model |
| `mysti.localaiPath` | `localai` | Path to LocalAI CLI |
| `mysti.localaiModel` | `` | Custom LocalAI model |
| `mysti.useShellForCli` | `false` | Run CLIs with shell (auto-enabled on Windows) |

---

## [0.3.1] - February 2026

---

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
