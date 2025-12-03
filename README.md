# Mysti - AI Coding Agent

<p align="center">
  <img src="resources/Mysti-Logo.png" alt="Mysti Logo" width="128" height="128">
</p>

<p align="center">
  <strong>Your AI Coding Dream Team</strong><br>
  <em>Claude Code + Codex collaborate in brainstorm mode, debate solutions, and synthesize the best approach for your code</em>
</p>

<p align="center">
  <a href="#-see-it-in-action">Screenshots</a> •
  <a href="#-key-features">Features</a> •
  <a href="#-requirements">Requirements</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#%EF%B8%8F-configuration">Config</a>
</p>

---

## See It In Action

<p align="center">
  <img src="https://raw.githubusercontent.com/DeepMyst/Mysti/main/docs/screenshots/user-experience.png" alt="Mysti Chat Interface" width="700">
</p>

<p align="center"><em>Beautiful, modern chat interface with syntax highlighting and markdown support</em></p>

---

## Why Mysti?

**Stop relying on a single AI.** Mysti lets you harness the power of multiple AI coding agents working as a team.

| Single AI | Mysti's Team Approach |
|-----------|----------------------|
| One perspective | Multiple AI perspectives |
| One solution | Debated, refined solutions |
| Fixed behavior | 16 personas + 12 skills |
| Take it or leave it | Choose your preferred approach |

---

## Requirements

**Mysti works with your existing AI subscriptions** - no additional costs!

You need at least one of these CLI tools installed:

| CLI Tool | Subscription | Install |
|----------|--------------|---------|
| **Claude Code** (recommended) | Anthropic API or Claude Pro/Max | `npm install -g @anthropic-ai/claude-code` |
| **Codex CLI** | OpenAI API | Follow OpenAI's installation guide |

**Already paying for Claude or ChatGPT?** You're ready to go! Mysti leverages your existing subscriptions through the official CLI tools.

For **Brainstorm Mode** (multi-agent collaboration), install **both** CLIs to get two AI giants working together.

---

## Key Features

### Multiple AI Providers

Switch between Claude Code and Codex with a single click. Use whichever AI best fits your current task.

<p align="center">
  <img src="https://raw.githubusercontent.com/DeepMyst/Mysti/main/docs/screenshots/agent-selection.png" alt="Agent Selection" width="450">
</p>

---

### 16 Developer Personas

Shape how your AI thinks. Select from specialized personas that change the AI's approach to your problems.

<p align="center">
  <img src="https://raw.githubusercontent.com/DeepMyst/Mysti/main/docs/screenshots/persona-skills-panel.png" alt="Personas and Skills Panel" width="550">
</p>

| Persona | Focus |
|---------|-------|
| **Architect** | System design, scalability, clean structure |
| **Debugger** | Root cause analysis, bug fixing |
| **Security-Minded** | Vulnerabilities, threat modeling |
| **Performance Tuner** | Optimization, profiling, latency |
| **Prototyper** | Quick iteration, PoCs |
| **Refactorer** | Code quality, maintainability |
| + 10 more... | Full-Stack, DevOps, Mentor, Designer... |

---

### Quick Persona Selection

Select personas directly from the toolbar without opening panels.

<p align="center">
  <img src="https://raw.githubusercontent.com/DeepMyst/Mysti/main/docs/screenshots/persona-toolbar.png" alt="Toolbar Persona Selection" width="550">
</p>

---

### Smart Auto-Suggestions

Mysti automatically suggests relevant personas and actions based on your message.

<p align="center">
  <img src="https://raw.githubusercontent.com/DeepMyst/Mysti/main/docs/screenshots/auto-suggestions.png" alt="Auto Suggestions" width="550">
</p>

---

### Intelligent Plan Detection

When the AI presents multiple approaches, Mysti detects them and lets you choose.

<p align="center">
  <img src="https://raw.githubusercontent.com/DeepMyst/Mysti/main/docs/screenshots/plan-suggestions.png" alt="Plan Suggestions" width="550">
</p>

---

### Powerful Plan Mode

Execute plans with full control - ask before editing, auto-edit, or plan only.

<p align="center">
  <img src="https://raw.githubusercontent.com/DeepMyst/Mysti/main/docs/screenshots/plan-mode.png" alt="Plan Mode" width="550">
</p>

---

### Conversation History

Never lose your work. All conversations are saved and easily accessible.

<p align="center">
  <img src="https://raw.githubusercontent.com/DeepMyst/Mysti/main/docs/screenshots/conversation-history.png" alt="Conversation History" width="450">
</p>

---

### Extensive Settings

Fine-tune every aspect of Mysti including token budgets, access levels, and brainstorm mode.

<p align="center">
  <img src="https://raw.githubusercontent.com/DeepMyst/Mysti/main/docs/screenshots/settings-panel.png" alt="Settings Panel" width="450">
</p>

---

### Quick Actions on Welcome

Get started fast with one-click actions for common tasks.

<p align="center">
  <img src="https://raw.githubusercontent.com/DeepMyst/Mysti/main/docs/screenshots/quick-actions-welcome.png" alt="Quick Actions" width="550">
</p>

---

## Brainstorm Mode

This is where Mysti shines. Instead of relying on one AI, get a **team of AI agents** working on your problem.

**Requires both Claude Code and Codex CLIs installed.**

### How It Works

```
Your Request
     |
     v
+-----------+-----------+
|Claude Code|   Codex   |
| analyzes  | analyzes  |
+-----+-----+-----+-----+
      |           |
      v           v
+---------------------------+
|   Discussion (Full Mode)  |
| Agents review each other's|
| solutions and debate      |
+-----------+---------------+
            |
            v
+---------------------------+
|        Synthesis          |
| Best ideas combined into  |
| one refined solution      |
+---------------------------+
```

### Two Modes

| Quick Mode | Full Mode |
|------------|-----------|
| Direct synthesis | Agents discuss first |
| Faster results | More thorough |
| Good for simple tasks | Best for complex problems |

---

## Quick Start

### 1. Install CLI Tools

```bash
# Claude Code (recommended)
npm install -g @anthropic-ai/claude-code

# Authenticate with your Anthropic account
claude auth login
```

For Brainstorm Mode, also install Codex CLI.

### 2. Open Mysti

- Click the **Mysti icon** in the Activity Bar, or
- Press `Ctrl+Shift+M` (`Cmd+Shift+M` on Mac)

### 3. Start Coding

Type your request and let the AI team assist you!

---

## 12 Toggleable Skills

Mix and match behavioral modifiers:

- **Concise** - Clear, brief communication
- **Test-Driven** - Tests alongside code
- **Auto-Commit** - Incremental commits
- **First Principles** - Fundamental reasoning
- **Scope Discipline** - Stay focused on the task
- And 7 more...

---

## Permission Controls

Stay in control of what the AI can do:

- **Read-only** - AI can only read, never modify
- **Ask-permission** - Approve each file change
- **Full-access** - Let the AI work autonomously

---

## Configuration

### Essential Settings

```json
{
  "mysti.defaultProvider": "claude-code",
  "mysti.brainstorm.enabled": true,
  "mysti.brainstorm.discussionMode": "full",
  "mysti.accessLevel": "ask-permission"
}
```

### All Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.defaultProvider` | `claude-code` | Primary AI provider |
| `mysti.brainstorm.enabled` | `false` | Enable multi-agent mode |
| `mysti.brainstorm.discussionMode` | `quick` | `quick` or `full` |
| `mysti.accessLevel` | `ask-permission` | File access level |
| `mysti.agents.autoSuggest` | `true` | Auto-suggest personas |

---

## Keyboard Shortcuts

| Action | Windows/Linux | Mac |
|--------|---------------|-----|
| Open Mysti | `Ctrl+Shift+M` | `Cmd+Shift+M` |
| Open in New Tab | `Ctrl+Shift+N` | `Cmd+Shift+N` |

---

## Commands

| Command | Description |
|---------|-------------|
| `Mysti: Open Chat` | Open the chat sidebar |
| `Mysti: New Conversation` | Start fresh |
| `Mysti: Add to Context` | Add file/selection to context |
| `Mysti: Clear Context` | Clear all context |
| `Mysti: Open in New Tab` | Open chat as editor tab |

---

## Telemetry

Mysti collects **anonymous** usage data to improve the extension:

- Feature usage patterns
- Error rates
- Provider preferences

**No code, file paths, or personal data is ever collected.**

Respects VSCode's telemetry setting. Disable via:
Settings > Telemetry: Telemetry Level > off

---

## License

**Business Source License 1.1 (BSL 1.1)**

- **Free** for personal, educational, and non-profit use
- **Commercial use** requires a separate license
- Converts to **MIT License** on December 3, 2030

Contact [baha@deepmyst.com](mailto:baha@deepmyst.com) for commercial licensing.

---

<p align="center">
  <strong>Mysti</strong> - Built by <a href="https://deepmyst.com">DeepMyst Inc</a><br>
  <sub>Made with Claude Code</sub>
</p>
