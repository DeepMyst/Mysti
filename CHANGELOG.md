# Changelog

All notable changes to the Mysti extension will be documented in this file.

## [Unreleased]

### Added

- **The agent catalog — `@mysti` can find and read the project's reusable practices (Plan 20)**. Off by default (`mysti.mysti.skills`, machine-scoped: `off` | `prose` | `full`).
  - **Retrieval** (`prose`): the coordinator could previously not see personas/skills/roles at all — it had 42 bundled artifacts available and reached none of them. `<skill:…>` searches the catalog (BM25 with field boosts, stemming, stop-words and a relevance floor) and reads one by id, optionally a bundled `references/` file. The always-present cost is an **O(1) category header** — names are deliberately never listed, because selection accuracy is published as declining past 30–50 always-present entries. Nothing is injected at all below 8 artifacts, or when the setting is off.
  - **Measurement, not faith**: `mysti.skillReport` ("Mysti: Agent Catalog Report") is a go/no-go instrument built to be able to say **no** — below 30 runs it refuses a verdict, below 30% engagement it prints NO-GO, and above that it prints engagement *and* completion delta with the explicit note that engagement alone is not value. It records artifact ids only — never queries, content or paths — and nothing leaves the machine. The published comparison band is 70–80% healthy, ~19% drifting.
  - **Authoring (`full`) is EXPERIMENTAL** and gated behind local execution + a trusted workspace + a real OS sandbox. `@mysti` can stage a capability, and `<publish:…>` runs a verification ladder: content scan and manifest conformance first (nothing executes), then a **forced card showing the full script bytes**, then an evidence check, then a second forced card to register. Both cards auto-DENY on timeout.
  - **The evidence cannot be manufactured.** A manifest may list the commands a capability replaces, but those are looked up in the host's own record of commands it actually ran. The model can *point at* evidence; it cannot create it. Where nothing matches, the card says so rather than quietly passing. **The ladder proves conformance and host-observed corroboration — not correctness**, and says so on the card.
  - **`<skillrun:…>` is a narrowing of `bash`, not a synonym**: the command shape is host-owned, the interpreter comes from a fixed `{bash, python3, node}` map resolved to an absolute path, and arguments are validated against a closed schema then passed **in a file** — so no model-supplied string reaches a shell at all.
  - **Governance**: `Mysti: Review Agent Proposals` is the only path from staged bytes to a live definition (a command, not a permission card). `Mysti: Quarantine All User Agent Artifacts` is a one-action kill switch that **moves** artifacts to a timestamped folder rather than deleting them. Per-capability health tracks `helped` and `hurt` **separately, never averaged** — a 6-help/6-harm capability is unstable, not neutral — with quarantine at 2 consecutive failures (lifted by a success) and nothing ever auto-deleted.

- **Agent content is now trusted by INTEGRITY, not by location (Plan 20 Phase 0)**. Trust used to be decided purely by which directory a file was found in, and the bundled `resources/agents/core` directory is writable by any local process — including a delegated CLI backend, which runs unsandboxed. A build-time SHA-256 manifest of every bundled agent file is compiled **into the extension bundle** (a sibling JSON would be writable by exactly the attacker it defends against) and verified at load. Only verified bundled content reaches the system prompt; everything else — plugin, user, workspace, or a core file that no longer matches — is delimited as reference data with an explicit authority ceiling. Content that hides text from human review (Unicode Tag Block, zero-width, bidi overrides) or forges a coordinator directive fails the load outright, and frontmatter that tries to grant itself tool access is refused rather than ignored. Emoji, ZWJ and Arabic/Indic shaping are deliberately unaffected.

- **Connected MCP tools now carry their real argument schemas.** `listTools()` returns each tool's `inputSchema` and the coordinator was discarding it, so the model had to guess argument names — and each wrong guess costs an approval. Schemas are now passed through (bounded and key-filtered), with the most-used tools carrying full parameters and the rest retrievable via a new read-only `findtool`; attaching all of them would have been a ~12k-token regression rather than a fix. Tool metadata a user approved is also **pinned**: if a server later rewrites a tool's description — the field that lands in the model's unfenceable tool-definition tier — the next approval card shows the change side by side.

### Fixed

- **The permission gate could fail OPEN, and the settings UI itself offered a value that triggered it.** `shouldGateToolUse` decides by matching string literals and ended in a bare `return false`, so any mode/access-level combination it did not explicitly handle was **not gated** — while every CLI provider runs with its native permissions bypassed, and `@mysti`'s own file/shell operations call this with no CLI beneath them. The settings dropdown offered `defaultMode: "plan"`, which is not a mode the code handles; separately, `mysti.accessLevel` is window-scoped, so a cloned repo could supply a value outside the enum (VSCode does not validate declared enums at read time) and the existing clamp passed it through untouched. The gate now fails **closed**, unrecognized values are coerced to "ask" at the boundary, the clamp rejects non-enum workspace values, and a test asserts the declared enums match the TypeScript unions so this class of drift cannot recur silently.

- **Model and tool output is now sanitized before it is rendered.** Markdown from the model, a tool result, or a quoted repo file was written straight into the DOM with no sanitizer present. The webview CSP already blocked script execution and remote images, so the real exposure was **UI spoofing** — markup that looks like Mysti's own permission card, on the surface where you decide what to approve. All rendering now goes through DOMPurify (vendored locally, never a CDN) and **fails closed**, showing plain text if the sanitizer is unavailable. The CSP also gained `form-action` and `base-uri`, neither of which inherits from `default-src`.

- **Standalone execution for the Mysti agent (Plan 19 Phases 0–3 + Phase 4 foundation)** — `@mysti` can now create/edit/patch files AND run commands (tests/builds/linters) by ITSELF, so it works even when no CLI backend is installed to delegate to. Off by default (`mysti.mysti.localExecution`, machine-scoped).
  - New gated directive tags: `<write:…>`, `<edit:…>` (with `replace="all"`), `<bash:…>`, and **`<patch:…>`** — one ATOMIC multi-file change (Add / Update SEARCH-REPLACE / Delete / Move; every path validated + secret-checked in memory first, so any escape voids the whole patch with nothing written). Only recognized when execution is enabled — otherwise they degrade to visible text.
  - **Git & deploy:** git runs through the sandboxed `bash` (read-only git auto-runs; writers show a card; `.git/config` + `.git/hooks` are read-only *inside* the sandbox so nothing can repoint `origin` or plant a hook). **Remote-effect / deploy commands** (push, publish, deploy, ssh, cloud CLIs) get a **modal default-DENY** confirmation — a checkpoint can't undo a push.
  - **Native tool-calling (foundation):** the coordinator's op set now has an OpenAI-style function-tool encoding (`coordinatorTools.ts` — schemas + a conservative capability check + a `tool_call → directive` converter) so capable models can eventually use native tool-calling while unknown models keep the proven text protocol. (The streaming-loop wiring is a follow-up.)
  - **Capabilities up, authority unchanged:** every op funnels through one new chokepoint (`MystiLocalExec`) that reuses the coordinator's existing security substrate verbatim — the **same permission gate** as CLI backends (`_shouldGateToolUse` → `requestPermissionInline`; default-deny in ask modes, panel-gone auto-deny), workspace-scoping + secret-file blocking (`MystiLocalTools.resolveWriteTarget` / `_safeResolve`), a **pre-op checkpoint** (undoable via the existing shadow-git `CheckpointManager`), and UNTRUSTED nonce-fencing of the result. A local op is never more trusted than a delegated one.
  - **Sandboxed `bash`** (`MystiSandbox`): commands run under an OS sandbox — **macOS Seatbelt** / **Linux bwrap** — with **no network** and **writes limited to the workspace** (empirically validated). Destructive commands (`rm`, `sudo`, `git push --force`, `curl|sh`, …) are hard-blocked by the shared `SafetyClassifier` vocabulary; chained/compound commands (`&&`, `|`, `;`) can never be auto-approved. On platforms with no sandbox primitive (Windows / Linux-without-bwrap) only simple allowlisted read-only/build commands run — fail-closed, never arbitrary shell. Network is off by default (`mysti.mysti.bashNetwork`). `bash` auto-runs (no card) only when the mode wouldn't gate AND a capable coordinator model is pinned — otherwise every command is confirmed.
  - **Fail-closed guards:** disabled in untrusted workspaces and in plan / read-only tiers; a tightened per-run budget (`_MYSTI_MAX_LOCAL_EXEC`); machine-scoped so a workspace cannot enable it. (git/deploy + native tool-calling are later phases.)

- **The Mysti Agent (`@mysti`) — a coordinator that plans and delegates (Plan 15, sync MVP)**: type `@mysti <request>` (or `/mysti …`) and Mysti decomposes it into a task DAG, runs the steps across your backends, and synthesizes one answer.
  - **How it works**: the coordinator (running on a **free OpenRouter model** by default) emits a validated JSON DAG (not fragile tool-calling); the steps execute frontier-by-frontier through the shared, bounded, **gated** `CollaboratorPool` (Plan 14), with each step's output threaded into its dependents; a final pass synthesizes the results. Routing is **backend-only** (each step runs on a provider using its own model — no per-call model routing, which would thrash persistent-process respawn). `mysti` can never route to itself, and node/depth caps bound fan-out.
  - **OpenRouter is now a full backend** (the 14th provider): any of 300+ models via the OpenAI-compatible API with real SSE streaming, **free by default** (`openrouter/free`). It's a completion backend (no tool execution), so the coordinator sends file-editing work to agentic CLI backends and text/analysis to OpenRouter free. Key: `mysti.openrouter.apiKey` / `OPENROUTER_API_KEY`; model: `mysti.openrouterModel`.
  - **Free by default, opt-in paid fallback**: the coordinator discovers a live free model at runtime (the roster rotates, so nothing is hardcoded) and is 20-rpm-aware (semaphore + backoff). It only touches a paid model if you set `mysti.openrouter.fallbackModel` — otherwise it degrades gracefully and never spends.
  - **Security floor**: delegation (`task`/`agent`/`dispatch_agent`) is now a first-class **gated `delegate` action** (previously ungated `file-read`) — default-deny, auto-approved only under explicit full-access/autonomous, and never silently approved in autonomous mode.

- **Agent Collaboration Roles (Plan 14)**: call any agent(s) as an advisor, critic, reviewer, second-opinion, coworker, or collaborator — across every provider, in one message
  - **Grammar**: `@agent:role` (e.g. `@google-gemini:critic @openai-codex:reviewer here's my plan`) — role-tagged mentions run as a **parallel group**; plain `@agent` mentions keep today's sequential MentionRouter routing. Slash commands `/consult`, `/review`, `/critique`, `/panel` prebind a role.
  - **Autocomplete**: typing `:` after a known agent (`@gemini:`) opens a role picker filtered as you type, with a read-only/writes badge; Tab/Enter/click completes `@agent:role`. Roles flow to the chat UI via `availableRoles` (initial state + live `agentsUpdated`).
  - **Roles are markdown** in the three-tier agent system (`resources/agents/core/roles/`, `~/.mysti/agents/roles/`, `.mysti/agents/roles/`), authored like personas/skills (`mysti.createRole` / "Reload Agents"). Each role declares an **access profile** (`read-only` advisory vs `gated-write`) and a return contract. Six built-ins ship: advisor, critic, reviewer, second-opinion, coworker, collaborator.
  - **`CollaboratorPool`** — one shared bounded dispatch primitive: a real concurrency cap (`mysti.collab.maxConcurrent`, default 3), per-collaborator timeout + transport retry, a cached availability pre-check (uninstalled/unauthenticated CLI → skip-with-hint, never a hang), a structured failure taxonomy (`not-installed`/`not-authenticated`/`timeout`/`crashed`/`stream-error`/`empty-response`/`cancelled`/`denied`), UUID-scoped derived child panels, and cancel fan-out.
  - **Read-only enforcement**: advisory roles hard-deny any non-file-read tool locally, regardless of provider CLI flags. Gated-write roles SIGSTOP the child before the tool runs, await the permission gate, and resume/cancel the **child's own** panel (fixing the legacy sub-agent gate, which cancelled the parent).
  - **Reliability**: completion is a transport signal (the provider `done` chunk), never keyword matching; a `_withDeadline` wrapper races each pull so a provider that ignores cancel still times out; the main agent synthesizes a role-labeled block that surfaces any failed collaborators rather than dropping them silently. Reference material (conversation history + context files) is wrapped in a delimited low-trust block.
- **Kimi Code Provider**: Moonshot AI's terminal coding agent (`kimi` CLI, `MoonshotAI/kimi-code`) — the 15th provider
  - Transport: Agent Client Protocol (`kimi acp`, JSON-RPC 2.0 over stdio) via the persistent-process path — real streaming, thinking (Kimi K2.7 Code / K3 reason), and tool-call visibility; the initialize → session/new → session/prompt handshake is driven reactively from the stream parser (mirrors the Hermes backend)
  - Permission model **fails closed**: ACP is a blocking protocol answered synchronously (before Mysti's async gate can run), so Kimi auto-allows a tool only when the settings mean "don't ask me" (Full access, or edits in the accept-edits tier) and **denies** in every ask/plan/read-only mode — a prompt-injected agent cannot get a dangerous command auto-approved. Read-only kinds (read/search/think) always run; the access snapshot is kept fresh by forcing a respawn on any access/mode change
  - Cancellation and New Conversation **drop the ACP process** (rather than `session/cancel`) so a stale cancelled-prompt response can never terminate or be misattributed to the next turn
  - Models: `kimi-for-coding` (K2.7 Code), `kimi-for-coding-highspeed`, `k3` (up to 1M context), `kimi-k2.7-code`. A `mysti.kimiCodeModel` override is passed to the CLI via `ANTHROPIC_MODEL` (best-effort — the model is otherwise chosen in-session with `/model`)
  - Auth: `/login` inside the CLI (Kimi Code OAuth or a Moonshot AI Open Platform API key) or `MOONSHOT_API_KEY` / `KIMI_API_KEY`; installed via the official script (`curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`) or Homebrew (`brew install kimi-code`)
  - First-class across the whole surface: provider dropdown, model picker, @-mention (`@kimi`), brainstorm agent + synthesis, `@mysti` cross-vendor delegation (family `moonshot`), setup wizard card, and its own logo
- **Continue Provider**: continuedev's open-source coding agent (`cn` CLI, npm: `@continuedev/cli`)
  - Headless print mode (`cn -p`) with the prompt piped via stdin; `<think>` blocks parsed into thinking chunks (response text is never dropped on mixed thinking/prose lines)
  - Permission policy **fails closed** (mirrors Copilot): `cn` emits plain final text with no tool events, so Mysti's stream gate can't fire — `--auto` (full autonomy) is used only for the autonomous tiers (edit-automatically, or full-access) and every ask-tier setting runs `--readonly` instead of silently writing files / running shell commands
  - Custom model as a hub slug via `mysti.continueModel` (`cn --model owner/package`); the base injects channel/system context into the prompt (no `--rule` flag — a multi-line arg would break Windows spawns and double-inject)
  - Honest capabilities: no tool events or usage stats reach headless stdout (`supportsToolUse: false`, `emitsUsage: false`)
- **Hermes Provider**: NousResearch's hermes-agent (self-improving agent with skills, persistent memory, and 300+ models via Nous Portal, OpenRouter, OpenAI, or custom endpoints)
  - Transport: Agent Client Protocol (`hermes acp`, JSON-RPC 2.0 over stdio) via the persistent-process path — real streaming and tool-call visibility; the handshake is driven reactively from the stream parser
  - Permission model **fails closed**: ACP is a blocking protocol answered synchronously (before Mysti's async gate can run), so Hermes auto-allows a tool only when the settings mean "don't ask me" (Full access, or edits in the accept-edits tier) and **denies** in every ask/plan/read-only mode — a prompt-injected agent cannot get a dangerous command auto-approved. Read-only kinds (read/search) always run. The access-level snapshot is kept fresh by forcing a respawn on any access/mode change.
  - Cancellation and New Conversation **drop the ACP process** (rather than sending `session/cancel`) so a stale cancelled-prompt response can never terminate or be misattributed to the next turn; the next turn re-handshakes cleanly and re-sends history
  - Auth via `hermes setup` / `hermes setup --portal`; install script shown per-OS by the setup wizard
  - Model selection stays in Hermes (`hermes model`) — the provider honestly reports `modelSelection: none`

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
