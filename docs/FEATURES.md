# Mysti Features Guide

Detailed documentation for all Mysti features.

## Table of Contents

- [Chat Interface](#chat-interface)
- [Providers](#providers)
- [Brainstorm Mode](#brainstorm-mode)
- [Autonomous Mode](#autonomous-mode)
- [@-Mention System](#-mention-system)
- [Context Compaction](#context-compaction)
- [Agent Configuration](#agent-configuration)
- [Plan Selection](#plan-selection)
- [Permission System](#permission-system)
- [Agent Lifecycle](#agent-lifecycle)
- [Slash Commands](#slash-commands)
- [Settings Reference](#settings-reference)

---

## Chat Interface

### Basic Usage

The Mysti chat interface is accessible from the Activity Bar sidebar or as a standalone editor tab.

**Opening the Chat:**
- Click the Mysti icon in the Activity Bar
- Use keyboard shortcut: `Ctrl+Shift+M` (Windows/Linux) or `Cmd+Shift+M` (Mac)
- Run command: `Mysti: Open Mysti Chat`

**Opening in New Tab:**
- Use keyboard shortcut: `Ctrl+Shift+N` (Windows/Linux) or `Cmd+Shift+N` (Mac)
- Click the "Open in New Tab" button in the chat header

### Context Management

Add relevant code context to improve AI responses.

**Adding Context:**
- Right-click a file in Explorer -> "Add to Mysti Context"
- Right-click selected code in Editor -> "Add to Mysti Context"
- Use `@filename` mentions for transient file context

**Auto-Context:**
When enabled (`mysti.autoContext: true`), Mysti automatically tracks your active editor and includes relevant context.

**Per-Panel Isolation:**
Each chat panel (sidebar or tab) maintains its own independent context. Adding a file to one panel doesn't affect others.

### Conversation Management

**New Conversation:**
- Click the "New" button in the header
- Run command: `Mysti: New Conversation`

**Conversation History:**
- Access previous conversations from the history panel
- Each conversation persists across VSCode sessions
- Per-conversation settings (mode, model, provider) are preserved

---

## Providers

Mysti supports 7 AI providers through their CLI interfaces. See [PROVIDERS.md](PROVIDERS.md) for complete setup guides.

| Provider | Best For |
|----------|----------|
| **Claude Code** | Deep reasoning, complex refactoring |
| **Codex** | Quick iterations, OpenAI ecosystem |
| **Gemini** | Fast responses, Google integration |
| **GitHub Copilot** | Multi-model access via GitHub subscription |
| **Cline** | Plan/Act workflow, structured tasks |
| **Cursor** | Auto model selection, multi-model |
| **OpenClaw** | WebSocket streaming, thinking levels |
| **Manus** (experimental) | HTTP API-based, async tasks |

**Switching Providers:**
- Use the `/agent` slash command
- Change `mysti.defaultProvider` in settings
- Each conversation remembers its provider

---

## Brainstorm Mode

Brainstorm mode enables two AI agents to collaborate using structured reasoning frameworks. See [BRAINSTORM.md](BRAINSTORM.md) for the full guide.

### Collaboration Strategies

| Strategy | Roles | Best For |
|----------|-------|----------|
| **Quick** | Direct synthesis | Simple tasks |
| **Debate** | Critic vs Defender | Architecture decisions |
| **Red-Team** | Proposer vs Challenger | Security reviews |
| **Perspectives** | Risk Analyst vs Innovator | Greenfield design |
| **Delphi** | Facilitator vs Refiner | Complex consensus |

### Convergence Detection

During discussion rounds, Mysti tracks agent agreement and position stability. When auto-convergence is enabled, discussions exit early once agents reach consensus.

### Configuration

```json
{
  "mysti.brainstorm.enabled": true,
  "mysti.brainstorm.strategy": "debate",
  "mysti.brainstorm.autoConverge": true,
  "mysti.brainstorm.maxDiscussionRounds": 3
}
```

---

## Autonomous Mode

Let the AI work independently with safety controls. See [AUTONOMOUS-MODE.md](AUTONOMOUS-MODE.md) for the full guide.

### Safety Classification

Every operation is classified before auto-approval:

| Level | Action | Examples |
|-------|--------|---------|
| **Safe** | Auto-approve | File reads, test commands, git status |
| **Caution** | Mode-dependent | File creates/edits, unknown bash commands |
| **Blocked** | Always deny | File deletion, force push, sudo |

### Safety Modes

- **Conservative**: Only clearly safe operations auto-approved
- **Balanced** (default): Common development operations auto-approved
- **Aggressive**: Everything auto-approved except hardcoded blocks

### Memory System

Mysti learns from your decisions:
- Permission approvals/denials are remembered
- Question answers are cached for auto-response
- Confidence decays over time (0.95/day)
- Old memories auto-pruned when capacity reached

### Continuation Modes

- **Goal**: Free-form goal with completion detection
- **Task Queue**: Sequential task list with progress tracking

---

## @-Mention System

Route tasks to specific agents and reference files inline. See [MENTIONS.md](MENTIONS.md) for the full guide.

### File Mentions

```
@utils.ts Can you explain these helper functions?
```

Adds the file as transient context (not persisted).

### Agent Mentions

```
@claude Review this code for security issues
@claude Write tests, then @gemini review them
```

Routes tasks to specific agents. Later agents receive earlier agents' responses as context.

### Switching Providers

```
Switch to @cursor
```

---

## Context Compaction

Automatic context management to prevent overflow. See [COMPACTION.md](COMPACTION.md) for the full guide.

- Tracks per-panel token usage
- Triggers at configurable threshold (default 75%)
- Native CLI strategy for Claude Code (`/compact`)
- Client-side summarization for other providers

---

## Agent Configuration

Customize AI behavior with personas and skills. See [PERSONAS-AND-SKILLS.md](PERSONAS-AND-SKILLS.md) for the full guide.

### Developer Personas

16 built-in personas: Architect, Prototyper, Product-Centric, Refactorer, DevOps, Domain Expert, Researcher, Builder, Debugger, Integrator, Mentor, Designer, Full-Stack, Security-Minded, Performance Tuner, Toolsmith.

### Toggleable Skills

12 skills: Concise, Repo Hygiene, Organized, Auto-Commit, First Principles, Auto-Compact, Dependency-Aware, Graceful Degradation, Scope Discipline, Doc Reflexes, Test-Driven, Rollback Ready.

### Three-Tier Loading

Agent definitions load progressively for fast UI:
- **Tier 1**: Metadata (always loaded for lists)
- **Tier 2**: Instructions (loaded on selection)
- **Tier 3**: Full content (loaded on demand)

### Custom Agents

Create custom personas and skills as markdown files in:
- `.mysti/agents/` (workspace, highest priority)
- `~/.mysti/agents/` (user)
- `resources/agents/core/` (bundled, lowest priority)

---

## Plan Selection

When the AI presents multiple implementation options, Mysti detects and displays them for selection.

### How Plan Detection Works

1. AI response contains implementation options
2. ResponseClassifier analyzes the response
3. Detected plans displayed as selectable cards
4. User selects preferred approach and execution mode

### Plan Card Information

Each plan card shows:
- **Title** - Name of the approach
- **Summary** - Brief description
- **Pros** - Advantages
- **Cons** - Trade-offs
- **Complexity** - Low, Medium, or High

### Execution Modes

| Mode | Description |
|------|-------------|
| **Ask Before Edit** | AI explains changes and waits for approval |
| **Edit Automatically** | AI makes changes directly |
| **Plan** | AI creates detailed plan without making changes |

---

## Permission System

Control what actions the AI can perform.

### Access Levels

| Level | Description |
|-------|-------------|
| **Read-only** | AI cannot modify any files |
| **Ask-permission** | AI requests approval for each action |
| **Full-access** | AI can perform all operations |

### Permission Requests

In `ask-permission` mode, the AI shows requests for:
- File creation, editing, deletion
- Bash commands
- Web requests

Each request includes action description, risk level, diff preview, and approve/deny buttons.

### Timeout Behavior

| Behavior | Description |
|----------|-------------|
| `auto-accept` | Automatically approve after timeout |
| `auto-reject` | Automatically deny after timeout |
| `require-action` | No timeout, require explicit action |

---

## Agent Lifecycle

Manages agent session lifecycle for resource efficiency.

### Idle Timeout

Sessions expire after configurable idle time (default 1 hour). Activity is tracked via touch/busy/idle API.

### Process Protection

Before shutdown, Mysti checks for active child processes (e.g., running builds). Shutdown is blocked if protected children are detected.

### Configuration

```json
{
  "mysti.lifecycle.enabled": true,
  "mysti.lifecycle.idleTimeoutMinutes": 60,
  "mysti.lifecycle.processTreeTracking": true,
  "mysti.lifecycle.protectActiveChildren": true
}
```

---

## Slash Commands

Type `/` in the chat to access slash commands organized by section.

### Sections

| Section | Commands |
|---------|----------|
| **Context** | `/context`, `/clear` |
| **Model** | `/model`, `/agent`, `/mode` |
| **Customize** | `/persona`, `/skills` |
| **Commands** | `/compact` (Claude), `/thinking` (Claude), `/profile` (Codex), `/plan-act` (Cline) |
| **Settings** | `/access`, `/thinking-level` |
| **Support** | `/help` |

---

## Settings Reference

### Provider Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.defaultProvider` | `"claude-code"` | Default AI provider |
| `mysti.claudePath` | `"claude"` | Path to Claude CLI |
| `mysti.codexPath` | `"codex"` | Path to Codex CLI |
| `mysti.geminiPath` | `"gemini"` | Path to Gemini CLI |
| `mysti.copilotPath` | `"copilot"` | Path to Copilot CLI |
| `mysti.clinePath` | `"cline"` | Path to Cline CLI |
| `mysti.cursorPath` | `"agent"` | Path to Cursor CLI |
| `mysti.openclawPath` | `"openclaw"` | Path to OpenClaw CLI |

### Operation Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.defaultMode` | `"ask-before-edit"` | Default operation mode |
| `mysti.defaultThinkingLevel` | `"medium"` | Thinking level (none/low/medium/high) |
| `mysti.accessLevel` | `"ask-permission"` | File operation access level |
| `mysti.autoContext` | `true` | Auto-include relevant context |

### Brainstorm Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.brainstorm.enabled` | `false` | Enable brainstorm mode |
| `mysti.brainstorm.agents` | `["claude-code", "openai-codex"]` | Which 2 agents to use |
| `mysti.brainstorm.strategy` | `"quick"` | Collaboration strategy |
| `mysti.brainstorm.autoConverge` | `true` | Auto-exit when agents converge |
| `mysti.brainstorm.maxDiscussionRounds` | `3` | Maximum discussion rounds |

### Autonomous Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.autonomous.safetyMode` | `"balanced"` | Safety mode |
| `mysti.autonomous.maxSessionDuration` | `24` | Max session hours |
| `mysti.autonomous.allowFileCreation` | `true` | Allow file creation |
| `mysti.autonomous.allowFileEdit` | `true` | Allow file editing |
| `mysti.autonomous.allowBashCommands` | `true` | Allow bash commands |
| `mysti.autonomous.blockPatterns` | `[]` | Custom block patterns |

### Compaction Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.compaction.enabled` | `true` | Enable context compaction |
| `mysti.compaction.threshold` | `75` | Compaction threshold (%) |

### Lifecycle Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.lifecycle.enabled` | `true` | Enable lifecycle management |
| `mysti.lifecycle.idleTimeoutMinutes` | `60` | Idle timeout |
| `mysti.lifecycle.processTreeTracking` | `true` | Track child processes |
| `mysti.lifecycle.protectActiveChildren` | `true` | Protect active children |

### Agent Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.agents.autoSuggest` | `true` | Auto-suggest personas |
| `mysti.agents.maxTokenBudget` | `0` | Max tokens (0 = unlimited) |

### Permission Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.permission.timeout` | `30` | Timeout seconds (0 = none) |
| `mysti.permission.timeoutBehavior` | `"auto-reject"` | Timeout behavior |
