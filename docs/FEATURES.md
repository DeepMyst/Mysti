# Mysti Features Guide

Feature reference for Mysti 2.0.1 Beta 2. Start with [Getting started](GETTING-STARTED.md), watch the [feature recordings](DEMO_GALLERY.md), and see [release notes](releases/2.0.1-beta.2/RELEASE-NOTES.md) and [production readiness](PRODUCTION_READINESS.md) for scope and remaining validation.

Explicit agent assignments now honor every tagged provider. Independent advisory work can run in parallel; dependent handoffs and writers serialize. The [assignment guide](MENTIONS.md) is the authoritative syntax and behavior reference.

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

### Dictation

Click the microphone beside the message box to dictate a prompt with your editor's voice support. Mysti opens a temporary text editor for native dictation and previews its transcript in chat. Choose **Use dictation in Mysti** in the editor status bar (or **Use text** in chat) to insert it at the original cursor. Review the prompt and send it yourself. **Discard** cancels; Escape in Mysti cancels dictation without stopping a running agent.

Dictation works independently of the selected provider, including Claude, Codex, Mysti, and brainstorm sessions. Existing drafts are preserved; if you edit a draft during dictation, the transcript is appended. A session ends after five minutes and inserts its transcript without sending. Switching conversations or closing the originating chat cancels dictation.

Recent VS Code desktop versions include native voice support on supported platforms. Older editors may require the **VS Code Speech** extension; Mysti offers **Install speech support** when unavailable. Microphone permissions, recognition language, model downloads, and any cloud processing follow your editor's voice settings. Compatible VS Code forks must expose the native editor dictation commands. See [VS Code voice documentation](https://code.visualstudio.com/docs/configure/accessibility/voice) for host and platform requirements. Direct microphone recording inside Mysti's webview is not used.

### Basic Usage

The Mysti chat interface is accessible from the Activity Bar sidebar or as a standalone editor tab.

**Opening the Chat:**
- Click the Mysti icon in the Activity Bar
- Use keyboard shortcut: `Ctrl+Shift+M` (Windows/Linux) or `Cmd+Shift+M` (Mac)
- Run command: `Mysti: Open Mysti Chat`

**Opening in New Tab:**
- Use keyboard shortcut: `Ctrl+Shift+N` (Windows/Linux) or `Cmd+Shift+N` (Mac)
- Click the "Open in New Tab" button in the chat header

### Model and Effort Menus

Click the model pill below the composer to choose a model. Models show their available descriptions; the selected row uses the theme's selection color and a checkmark. The effort slider stays visible below the model list and exposes only the active provider's supported levels. Mysti's coordinator opens its full model catalog from the same menu. Claude also exposes an independent Ultracode switch in the model menu, actions menu and Settings. It requires Claude Code 2.1.284 or newer and a model/account supporting workflows. The `/` button beside the actions menu opens slash commands.

The **⋯** button opens searchable Context, Tools and Model sections. Effort changes in either menu update the same setting. Use arrow keys to move between controls or change effort, Tab to move focus, and Escape to close the menu without interrupting a running response.

If a model reports that it requires a newer CLI, an **Upgrade CLI** button appears beside the failure with the minimum version. Clicking it runs the provider's installer in a visible terminal. Mysti checks the detected CLI version afterward; when it is ready, send your message again. Failed or cancelled installs remain retryable. If an older copy is still selected by your CLI path setting, the card identifies that path instead of reporting success.

### Context Management

Add relevant code context to improve AI responses.

**Adding Context:**
- Right-click a file in Explorer -> "Add to Mysti Context"
- Right-click selected code in Editor -> "Add to Mysti Context"
- Use `@filename` mentions for transient file context

Dropping local file links into the Context panel keeps their contents available across messages in that chat. Invalid links and unreadable files show a warning; valid files in the same drop are still added. If a drop supplies file bytes without disk paths, Mysti explains that it uses them as message attachments instead. A file-link-only drop into the composer shows guidance to use Context or Attach.

Adding a folder considers at most the first 20 files encountered. Reaching this limit shows a notice that more files may remain; use **+ Add** for additional individual files. Files already in Context and unreadable files still count toward the limit. An unreadable subfolder does not prevent readable siblings from being added, and failed files or folders are named in the warning. Folder scans skip symbolic links and the common generated directories `node_modules`, `.git`, `dist`, `build`, `.next`, and `__pycache__`; this is not full `.gitignore` filtering.

Each folder addition also examines at most 200 folders and 10,000 directory entries, including ignored entries. A scan that reaches either work limit reports that more files may remain; add a smaller folder or individual files to include them. Complete listings use filename order within each folder. If a large listing is interrupted by the entry limit, only entries already observed are considered, so the result may be a partial selection. Directory reads use bounded batches and close before descending or after cancellation.

Files added to Context must be UTF-8 text without NUL bytes and no larger than 10 MiB each. Empty files, Unicode and a UTF-8 BOM are preserved. Files that grow past the limit during reading are rejected. Adding or restoring a rejected file shows the reason and keeps other valid files; use message attachments for binary files. Saved file context is validated again on restoration. These file rules do not change selected editor-text snapshots.

Enabled files already in the panel's Context are reread while preparing each new request, including sessions and brainstorms. Missing or rejected files are removed with a warning; other files remain. Disabling a file excludes it from the prompt. Clearing or removing context during a refresh cancels that submission. The submitted list stays fixed during preparation, so adding another file affects the next request. Selected text, earlier messages, second opinions and internally supplied task snapshots keep their captured contents. Files are read once for a request; later collaboration rounds reuse those bytes.

If a submitted message is cancelled or rejected before it reaches conversation history, an **Unsent message** card keeps its text and message attachments in that conversation. **Restore draft** makes them editable again once the composer is free; it never sends automatically or replaces a newer draft. Session briefs are restored as their slash command. **Dismiss** removes the saved submission. These recovery cards are held only for the current view's lifetime, including navigation away and back; closing or reloading the view discards them. Messages already recorded in history remain there instead of becoming recovery cards.

**Auto-Context:**
When enabled (`mysti.autoContext: true`), a direct provider message includes the current selection, or the whole unsaved buffer when nothing is selected. A detached chat remembers the editor used when opening or entering that chat, while it remains visible and open. Switching between chats preserves each chat's editor choice. Changing conversation clears that remembered choice.

The text is captured when you submit and follows that request through Mysti coordination, collaboration, user-started sessions, and explicitly requested background jobs. Explicit context for the same file takes precedence, including a disabled attachment. Automatic snapshots are not saved as attachments or reused by second opinions. Disabling Auto Context is rechecked at the final provider send, after preparation, connection and credential waits, including coordinator retries, collaborator question replies, and later session rounds. Obsolete requests are cancelled before sending. Internally started session tasks use their supplied context without acquiring the current editor.

Selection labels use one-based line numbers. A selection ending at the start of the next line excludes that empty final line from its label; older saved selections without an end column retain their recorded final line.

**Per-Panel Isolation:**
Each chat panel (sidebar or tab) maintains its own independent context. Adding a file to one panel doesn't affect others.

**File Picker Attachments:**
The attachment picker accepts up to 10 MiB (10,485,760 bytes) per file. A file that grows beyond that limit while being read is omitted with a warning; other valid files in the selection remain available. Attachment size reflects the bytes actually captured. Changing conversation, replacing the panel or sending the draft during a pending read discards that old selection. Provider attachment capabilities still apply.
Captured file contents, including empty files, are prepared for CLI providers independently of later changes to or deletion of the source file. Second opinions can reuse an empty attachment when its captured bytes are still available; a missing payload is not inferred from size metadata.

**Pasted and Dropped Attachments:**
The composer accepts up to ten attachments, including files still loading. Pasted and dropped images are limited to 5 MiB each; other files are limited to 10 MiB. Loading files show a removable preview. Sending or queueing that draft waits until its files finish loading or are removed. Switching conversations cancels unfinished reads; delayed results cannot populate another conversation. Read failures show a message and leave other attachments available. Queued turns and second opinions keep their own attachments while a separate draft loads.

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

Mysti offers its coordinator plus 16 registered backends through CLI, ACP, WebSocket and HTTP transports. See [PROVIDERS.md](PROVIDERS.md) for complete setup guides.

| Provider | Best For |
|----------|----------|
| **Claude Code** | Deep reasoning, complex refactoring |
| **Codex** | Quick iterations, OpenAI ecosystem |
| **Gemini** | Fast responses, Google integration |
| **GitHub Copilot** | Multi-model access via GitHub subscription |
| **Cline** | Plan/Act workflow, structured tasks |
| **Cursor** | Auto model selection, multi-model |
| **OpenClaw** | WebSocket streaming, thinking levels |
| **Mysti** | Coordinator, local tools and delegated agents |
| **OpenCode** | Configurable model backends |
| **Qwen Code** | Coding CLI |
| **Hermes** | ACP agent with native approval requests |
| **Kimi Code** | ACP agent with confirmed session model selection; requires explicit Full Access |
| **Continue** | Configurable CLI workflows |
| **Ollama** | Local inference; tool proposals are displayed, not executed |
| **LocalAI** | Self-hosted inference; tool proposals are displayed, not executed |
| **OpenRouter** | HTTP chat with a selected OpenRouter model |

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

Selecting a file from the suggestions inserts its full path in quotes, preserving the selected file through draft edits and queued sends. Typed names such as `@utils.ts` must identify one workspace file; if several files match, choose a suggestion or use a full path. Use quotes for spaces or Unicode, for example `@"src/retry contract.ts"`.

### Agent Mentions

```
@claude Review this code for security issues
@claude Write tests, then @gemini review them
```

Each tagged provider receives its assignment, including the selected provider. Independent advisory work can run concurrently. Use **then** for a dependent handoff; only dependent assignments receive previous results. File writers serialize. See [MENTIONS.md](MENTIONS.md).

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
| `mysti.claudeCodePath` | `"claude"` | Path to Claude CLI |
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

## Proactive inbox

Opt in to local Git monitoring and selected GitHub/Slack topics through DeepMyst. Review evidence, pause watches, and enable quiet-hour-aware VS Code notifications. Cloud monitoring requires the new DeepMyst backend deployment. See [setup, coverage, and current limits](PROACTIVE.md).
