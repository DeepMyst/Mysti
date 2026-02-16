# Mysti Architecture

Technical documentation for contributors and developers.

## Table of Contents

- [Project Structure](#project-structure)
- [Core Components](#core-components)
- [Data Flow](#data-flow)
- [Type System](#type-system)
- [Extension Points](#extension-points)

---

## Project Structure

```
Mysti/
├── src/
│   ├── extension.ts               # Extension entry point
│   ├── types.ts                   # Shared type definitions
│   ├── constants.ts               # Configuration constants
│   ├── managers/                  # Business logic managers
│   │   ├── ContextManager.ts
│   │   ├── ConversationManager.ts
│   │   ├── ProviderManager.ts
│   │   ├── BrainstormManager.ts
│   │   ├── PermissionManager.ts
│   │   ├── ResponseClassifier.ts
│   │   ├── PlanOptionManager.ts
│   │   ├── SuggestionManager.ts
│   │   ├── AutocompleteManager.ts
│   │   ├── AgentLoader.ts            # Three-tier agent loading from markdown
│   │   ├── AgentContextManager.ts     # Agent recommendations & prompt building
│   │   ├── AgentLifecycleManager.ts   # Session lifecycle & idle timeout
│   │   ├── SetupManager.ts           # CLI auto-setup & authentication
│   │   ├── TelemetryManager.ts       # Anonymous usage analytics
│   │   ├── AutonomousManager.ts      # Autonomous mode orchestration
│   │   ├── MemoryManager.ts          # Long-term preference learning
│   │   ├── SafetyClassifier.ts       # Operation safety classification
│   │   ├── CompactionManager.ts      # Context window compaction
│   │   ├── MentionRouter.ts          # @-mention parsing & routing
│   │   └── SlashCommandManager.ts    # Centralized slash command registry
│   ├── providers/                 # AI provider implementations
│   │   ├── ChatViewProvider.ts    # Main UI coordinator
│   │   ├── ProviderRegistry.ts    # Provider registration & discovery
│   │   ├── base/
│   │   │   ├── IProvider.ts       # Interfaces + persona definitions
│   │   │   └── BaseCliProvider.ts # Abstract CLI provider base
│   │   ├── claude/
│   │   │   └── ClaudeCodeProvider.ts
│   │   ├── codex/
│   │   │   └── CodexProvider.ts
│   │   ├── gemini/
│   │   │   └── GeminiProvider.ts
│   │   ├── cline/
│   │   │   └── ClineProvider.ts
│   │   ├── copilot/
│   │   │   └── CopilotProvider.ts
│   │   ├── cursor/
│   │   │   └── CursorProvider.ts
│   │   ├── openclaw/
│   │   │   └── OpenClawProvider.ts
│   │   └── manus/
│   │       └── ManusProvider.ts   # Experimental HTTP API provider
│   ├── mcp/
│   │   └── permissionServer.ts    # MCP permission intermediary
│   ├── utils/
│   │   ├── validation.ts          # Model name validation
│   │   ├── processTree.ts         # Cross-platform child process scanning
│   │   └── platform.ts            # Platform-specific helpers
│   └── webview/
│       └── webviewContent.ts      # HTML/CSS/JS for UI
├── resources/
│   ├── Mysti-Logo.png
│   ├── icon.svg
│   ├── icons/                     # UI icons
│   ├── agents/                    # Agent definitions (markdown)
│   │   ├── core/                  # Bundled agents
│   │   └── plugins/               # Synced community agents
│   ├── marked.min.js
│   ├── prism-bundle.js
│   └── mermaid.min.js
├── package.json
├── tsconfig.json
├── webpack.config.js
└── docs/
    ├── ARCHITECTURE.md
    ├── FEATURES.md
    ├── PROVIDERS.md
    ├── BRAINSTORM.md
    ├── PERSONAS-AND-SKILLS.md
    ├── AUTONOMOUS-MODE.md
    ├── MENTIONS.md
    ├── COMPACTION.md
    └── screenshots/
```

---

## Core Components

### Entry Point: extension.ts

The extension entry point wires everything together:
- Instantiates all managers
- Creates ChatViewProvider with all dependencies
- Registers commands and keybindings
- Sets up view providers and context subscriptions

### Managers

#### ContextManager

Manages code context for AI conversations with per-panel isolation.

**Key Design:**
- `_panelContexts: Map<string, ContextItem[]>` for per-panel context isolation
- Auto-context tracks active editor
- Language detection for 30+ languages

**Key Methods:**
```typescript
addFile(uri: vscode.Uri, panelId?: string): void
addSelection(editor: vscode.TextEditor, panelId?: string): void
clearPanelContext(panelId: string): void
getContextForPrompt(panelId?: string): ContextItem[]
```

#### ConversationManager

Persistent conversation storage using VSCode's globalState.

**Key Methods:**
```typescript
createConversation(settings: Settings): Conversation
addMessage(id: string, message: Message): void
updateAgentConfig(id: string, config: AgentConfiguration): boolean
```

#### ProviderManager

Facade over the ProviderRegistry for provider management.

**Key Methods:**
```typescript
sendMessage(content, context, settings, ...): AsyncGenerator<StreamChunk>
sendMessageToProvider(providerId, ...): AsyncGenerator<StreamChunk>
cancelRequest(panelId?: string): void
```

#### BrainstormManager

Orchestrates multi-agent team collaboration using structured reasoning frameworks.

**Key Design:**
- Per-panel sessions via `_panelSessions: Map<string, BrainstormSession>`
- 5 collaboration strategies: quick, debate, red-team, perspectives, delphi
- Parallel discussion via `_interleaveGenerators()`
- Convergence detection via agreement/disagreement keyword tracking

**Brainstorm Flow:**
```
1. User submits query
2. Individual Phase: Each agent analyzes independently (parallel)
3. Discussion Phase: Strategy-specific role-based discussion
   - Debate: Critic vs Defender
   - Red-Team: Proposer vs Challenger
   - Perspectives: Risk Analyst vs Innovator
   - Delphi: Facilitator vs Refiner
4. Convergence Check: Track agreement, optionally exit early
5. Synthesis Phase: Designated agent creates unified solution
```

**Key Methods:**
```typescript
startBrainstorm(query, context, config, panelId): AsyncGenerator<BrainstormStreamChunk>
cancelBrainstorm(panelId?: string): void
```

#### AutonomousManager

Enables AI to work independently with configurable safety controls.

**Key Design:**
- Integrates SafetyClassifier for operation classification
- Integrates MemoryManager for learned preference queries
- Continuation modes: goal-based and task-queue
- Audit logging of all autonomous decisions

**Key Methods:**
```typescript
activate(config: AutonomousConfig): void
deactivate(): void
handlePermission(request: PermissionRequest): AutonomousDecision
handleQuestion(question: AskUserQuestionData): AutonomousDecision
```

#### SafetyClassifier

Classifies operations into safety levels for autonomous mode.

**Safety Levels:**
- `safe`: Auto-approve (read-only, tests, version checks)
- `caution`: Mode-dependent (file create/edit, unknown commands)
- `blocked`: Always deny (deletion, force push, sudo, chmod 777)

**Safety Modes:** conservative, balanced, aggressive

#### MemoryManager

Long-term memory for learning user preferences.

**Key Design:**
- Dual-layer storage: VSCode globalState (fast) + `~/.mysti/memory/preferences.json` (persistent)
- Confidence decay (0.95/day) ensures recent decisions are weighted more
- Auto-pruning when over capacity (default 500 entries)

**Categories:** permission-preference, question-preference, project-context

#### CompactionManager

Prevents context window overflow via smart conversation compaction.

**Key Design:**
- Per-panel cumulative token tracking (input, output, cache read, cache creation)
- Threshold-based triggering (default 75%)
- Two strategies: native-cli (`/compact`) and client-summarize
- Brainstorm agents tracked independently via `panelId-brainstorm-agentId` keys

#### MentionRouter

Handles `@agent` and `@file` mentions in user messages.

**Key Design:**
- File mentions resolve to transient ContextItems
- Agent mentions generate task lists (heuristic-based, AI fallback)
- Sequential execution with dependency tracking
- Auto-retry failed sub-agent tasks

#### SlashCommandManager

Centralized registry for slash commands.

**Key Design:**
- Organized by sections: Context, Model, Customize, Commands, Settings, Support
- Provider-specific commands: `/compact` (Claude), `/thinking` (Claude), `/profile` (Codex), `/plan-act` (Cline)
- QuickPick dialogs for model, provider, mode selection

#### AgentLifecycleManager

Manages agent session lifecycle.

**Key Design:**
- Per-panel session tracking (active/busy/idle/shutting-down)
- Configurable idle timeout (default 1 hour)
- Cross-platform process tree tracking via `pgrep`/`wmic`
- Child process protection — blocks shutdown if active builds detected

#### PermissionManager

Handles permission requests for file operations.

**Key Methods:**
```typescript
createRequest(type, details): PermissionRequest
resolveRequest(id, decision): void
checkPermission(type, path): boolean
```

#### Other Managers

- **ResponseClassifier**: AI-powered response analysis using Claude Haiku
- **SuggestionManager**: Context-aware quick action suggestions
- **AgentLoader**: Three-tier progressive loading for agent definitions
- **AgentContextManager**: Builds agent context for prompt injection with token budgets
- **SetupManager**: CLI auto-setup and authentication
- **TelemetryManager**: Anonymous usage analytics via Application Insights

### Providers

#### Per-Panel Session Isolation

Provider instances are singletons, but mutable state is per-panel:

```typescript
// Each provider tracks sessions per panel
private _panelSessions: Map<string, PanelSessionState> = new Map();

// Base session state
interface PanelSessionState {
  panelId: string;
  process: ChildProcess | null;
  sessionId: string | null;
  autonomousMode: boolean;
}
```

Each provider subclass extends with its own session type (e.g., `ClaudeSessionState`, `CodexSessionState`).

#### BaseCliProvider

Abstract base class implementing common CLI functionality.

**Key Methods:**
```typescript
// Build prompt with context, persona, skills
protected buildPrompt(content, context, conversation, settings, persona?, agentConfig?): string

// Build CLI arguments — takes session (not boolean)
protected abstract buildCliArgs(settings: Settings, session: PanelSessionState): string[]

// Parse provider-specific output — takes session for per-panel parse state
protected abstract parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null

// Process CLI output stream
protected *processStream(stderrCollector): AsyncGenerator<StreamChunk>
```

#### Provider Implementations

| Provider | Type | Key Differences |
|----------|------|-----------------|
| **ClaudeCodeProvider** | CLI | Thinking mode, native `/compact`, MCP permission server |
| **CodexProvider** | CLI | Profile switching |
| **GeminiProvider** | CLI | Thinking support, Google ecosystem |
| **ClineProvider** | CLI | Plan/Act mode |
| **CopilotProvider** | CLI | 14+ models via GitHub subscription |
| **CursorProvider** | CLI | Auto model selection, cumulative streaming dedup |
| **OpenClawProvider** | CLI + WebSocket | Dual-transport: WebSocket gateway + CLI fallback |
| **ManusProvider** | HTTP API | Async polling workflow (experimental) |

#### MCP Permission Server

Intermediary between Claude Code CLI and VSCode for fine-grained permission control.

**Flow:**
```
Claude CLI --stdin/stdout--> MCP Server --HTTP--> VSCode Extension --postMessage--> Webview UI
```

### ChatViewProvider

Main UI coordinator and webview provider.

**Responsibilities:**
- Webview creation and management
- Per-panel state (conversations, processes)
- Message routing between webview and all managers
- Threads `panelId` to all context/session/cancel calls

**Constructor (dependency injection):**
```typescript
constructor(
  extensionUri, extensionContext,
  contextManager, conversationManager, providerManager,
  suggestionManager, brainstormManager, permissionManager,
  setupManager, telemetryManager, autonomousManager,
  memoryManager, compactionManager
)
```

---

## Data Flow

### Message Flow

```
User Input (Webview)
       ↓
ChatViewProvider.handleMessage()
       ↓
MentionRouter.parse()  ← Check for @-mentions
       ↓
[If @-mentions: Generate task list → Execute sub-agents sequentially]
       ↓
ProviderManager.sendMessage()
       ↓
BaseCliProvider.sendMessage()
       ↓
[Spawn CLI Process]
       ↓
BaseCliProvider.processStream()
       ↓
[Parse JSON chunks per panel session]
       ↓
StreamChunk events → CompactionManager.trackUsage()
       ↓
ChatViewProvider → Webview
       ↓
UI Update
```

### Brainstorm Flow

```
User Query
       ↓
BrainstormManager.startBrainstorm()
       ↓
┌──────────────────────────────────────────────┐
│ Individual Phase (Parallel)                  │
│ ┌──────────┐ ┌──────────┐                   │
│ │ Agent 1  │ │ Agent 2  │                   │
│ │ (stream) │ │ (stream) │                   │
│ └──────────┘ └──────────┘                   │
└──────────────────────────────────────────────┘
       ↓
┌──────────────────────────────────────────────┐
│ Discussion Phase (strategy-dependent)        │
│ Parallel via _interleaveGenerators()         │
│ Roles assigned by strategy:                  │
│   Debate: Critic vs Defender                 │
│   Red-Team: Proposer vs Challenger           │
│   Perspectives: Risk Analyst vs Innovator    │
│   Delphi: Facilitator vs Refiner             │
│                                              │
│ Convergence tracked per round                │
│ Auto-exit if agents converge                 │
└──────────────────────────────────────────────┘
       ↓
┌──────────────────────────────────────────────┐
│ Synthesis Phase                              │
│ ┌──────────────────────────────────────────┐ │
│ │ Synthesis Agent combines all perspectives│ │
│ │ Fallback: other agent → raw concat       │ │
│ └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
       ↓
Unified Solution
```

### @-Mention Flow

```
User: "@claude Write tests, then @gemini review them"
       ↓
MentionRouter.parse()
       ↓
Generate Task List (heuristic or AI)
  Task 1: { agent: claude, type: execute, task: "Write tests" }
  Task 2: { agent: gemini, type: execute, task: "Review tests" }
       ↓
Execute Task 1 → Stream Claude response
       ↓
Build context from Task 1 response
       ↓
Execute Task 2 → Stream Gemini response (with Task 1 context)
       ↓
Return combined results
```

### Autonomous Flow

```
Permission/Question from CLI
       ↓
AutonomousManager.handlePermission() / handleQuestion()
       ↓
SafetyClassifier.classify(operation)
       ↓
[If safe]: Auto-approve → audit log
[If caution]: Check safety mode → approve/deny/ask user
[If blocked]: Auto-deny → audit log
       ↓
MemoryManager.query() → Check learned preferences
       ↓
Decision → audit log → notify ChatViewProvider
```

---

## Type System

### Core Types

```typescript
// Provider types (7 providers + manus experimental)
type ProviderType = 'claude-code' | 'openai-codex' | 'google-gemini' |
                    'cline' | 'github-copilot' | 'cursor' | 'openclaw';
type AgentType = ProviderType;

// Streaming
interface StreamChunk {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'error' | 'done' | 'session_active';
  content?: string;
  toolCall?: ToolCall;
  sessionId?: string;
  usage?: UsageStats;
}

// Brainstorm
type CollaborationStrategy = 'quick' | 'debate' | 'red-team' | 'perspectives' | 'delphi';
type DiscussionRole = 'critic' | 'defender' | 'proposer' | 'challenger' |
                      'risk-analyst' | 'innovator' | 'facilitator' | 'refiner';

// Autonomous
type SafetyLevel = 'safe' | 'caution' | 'blocked';
type AutonomousContinuationMode = 'goal' | 'task-queue';

// @-Mentions
interface MentionTask {
  type: 'execute' | 'switch';
  agent: AgentType;
  task: string;
  order: number;
}

// Compaction
type CompactionStrategy = 'native-cli' | 'client-summarize';
type CompactionStatus = 'idle' | 'evaluating' | 'compacting' | 'complete' | 'error';
```

---

## Extension Points

### Adding a New Provider

1. **Create provider class** extending `BaseCliProvider` in `src/providers/newprovider/`
2. **Implement abstract methods**: `discoverCli()`, `getCliPath()`, `buildCliArgs()`, `parseStreamLine()`, `getAuthConfig()`, `checkAuthentication()`, `getAuthCommand()`, `getInstallCommand()`
3. **Register** in `src/providers/ProviderRegistry.ts` (`_registerBuiltInProviders()`)
4. **Add type** to `ProviderType` union in `src/types.ts`
5. **Add agent style** in `BrainstormManager.ts` `AGENT_STYLES` record
6. **Add settings** in `package.json` (`mysti.*` settings)

### Adding a New Persona/Skill (Markdown)

Create a markdown file with YAML frontmatter in one of the agent directories:

| Location | Scope | Priority |
|----------|-------|----------|
| `.mysti/agents/personas/` (or `skills/`) | Workspace | Highest |
| `~/.mysti/agents/personas/` | User | Medium |
| `resources/agents/core/personas/` | Core | Lowest |

See [Personas & Skills documentation](PERSONAS-AND-SKILLS.md) for the full format.

---

## Build & Development

### Commands

```bash
npm install                # Install dependencies
npm run watch              # Development build with watch
npm run compile            # Production build
npm run lint               # ESLint check
npm run sync-agents        # Sync community agents
npx vsce package           # Package extension
```

### Debugging

1. Open project in VSCode
2. Press `F5` to launch Extension Development Host
3. Set breakpoints in TypeScript files
4. Filter Debug Console with `[Mysti]` prefix
