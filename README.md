# Mysti - AI Coding Agent

<p align="center">
  <img src="resources/Mysti-Logo.png" alt="Mysti Logo" width="128" height="128">
</p>

<p align="center">
  <strong>Your AI Coding Dream Team</strong><br>
  <em>Claude Code + Codex working together to solve your coding challenges</em>
</p>

<p align="center">
  <a href="#-key-features">Features</a> •
  <a href="#-brainstorm-mode">Brainstorm</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-personas--skills">Personas</a> •
  <a href="#%EF%B8%8F-configuration">Config</a>
</p>

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

## ✨ Key Features

### 🧠 Brainstorm Mode - AI Collaboration
The standout feature. Enable brainstorm mode and watch **Claude Code** and **Codex** work together:

1. **Both AIs analyze** your request independently
2. **They debate** different approaches (in full mode)
3. **One synthesizes** the best solution from both perspectives

> *"Two AI giants, one goal - the best code for you."*

### 🎭 16 Developer Personas
Shape how your AI thinks:

| Persona | Focus |
|---------|-------|
| **Architect** | System design, scalability, clean structure |
| **Debugger** | Root cause analysis, bug fixing |
| **Security-Minded** | Vulnerabilities, threat modeling |
| **Performance Tuner** | Optimization, profiling, latency |
| **Prototyper** | Quick iteration, PoCs |
| **Refactorer** | Code quality, maintainability |
| + 10 more... | Full-Stack, DevOps, Mentor, Designer... |

### ⚡ 12 Toggleable Skills
Mix and match behavioral modifiers:

- **Concise** - Clear, brief communication
- **Test-Driven** - Tests alongside code
- **Auto-Commit** - Incremental commits
- **First Principles** - Fundamental reasoning
- **Scope Discipline** - Stay focused on the task
- And 7 more...

### 🎯 Smart Plan Selection
When the AI presents multiple approaches:
- Mysti **detects the options** automatically
- You **choose your preferred** implementation
- Select **execution mode** (ask-before-edit, auto-edit, plan-only)

### 🔐 Permission Controls
Stay in control:
- **Read-only** - AI can only read, never modify
- **Ask-permission** - Approve each file change
- **Full-access** - Let the AI work autonomously

---

## 🚀 Quick Start

### 1. Install a CLI Provider

```bash
# Claude Code (recommended)
npm install -g @anthropic-ai/claude-code

# Or OpenAI Codex
# Follow OpenAI's installation instructions
```

### 2. Open Mysti
- Click the **Mysti icon** in the Activity Bar, or
- Press `Ctrl+Shift+M` (`Cmd+Shift+M` on Mac)

### 3. Start Coding
Type your request and let the AI team assist you!

### 4. Try Brainstorm Mode
Enable it in settings to unlock multi-agent collaboration.

---

## 🧠 Brainstorm Mode

This is where Mysti shines. Instead of relying on one AI, get a **team of AI agents** working on your problem.

### How It Works

```
Your Request
     ↓
┌─────────────┬─────────────┐
│ Claude Code │   Codex     │
│  analyzes   │  analyzes   │
└──────┬──────┴──────┬──────┘
       │             │
       ▼             ▼
┌─────────────────────────────┐
│    Discussion (Full Mode)    │
│  Agents review each other's  │
│  solutions and debate        │
└──────────────┬──────────────┘
               ↓
┌─────────────────────────────┐
│        Synthesis            │
│  Best ideas combined into   │
│  one refined solution       │
└─────────────────────────────┘
```

### Two Modes

| Quick Mode | Full Mode |
|------------|-----------|
| Direct synthesis | Agents discuss first |
| Faster results | More thorough |
| Good for simple tasks | Best for complex problems |

### Enable Brainstorm
Settings → `mysti.brainstorm.enabled: true`

---

## 🎭 Personas & Skills

### Using Personas
1. Click the **persona indicator** in the toolbar
2. Select from 16 specialized personas
3. The AI adopts that mindset for your conversation

### Auto-Suggest
Mysti can **automatically suggest** relevant personas based on your message:
- Type "review this code" → Suggests **Refactorer**
- Type "design a system" → Suggests **Architect**
- Type "fix this bug" → Suggests **Debugger**

### Combining with Skills
Personas define *who* the AI is. Skills define *how* it works.

**Example combo:**
- Persona: **Architect**
- Skills: **Concise** + **First Principles**
- Result: An architect who explains design decisions clearly and from fundamentals

---

## ⚙️ Configuration

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

## ⌨️ Keyboard Shortcuts

| Action | Windows/Linux | Mac |
|--------|---------------|-----|
| Open Mysti | `Ctrl+Shift+M` | `Cmd+Shift+M` |
| Open in New Tab | `Ctrl+Shift+N` | `Cmd+Shift+N` |

---

## 📋 Commands

| Command | Description |
|---------|-------------|
| `Mysti: Open Chat` | Open the chat sidebar |
| `Mysti: New Conversation` | Start fresh |
| `Mysti: Add to Context` | Add file/selection to context |
| `Mysti: Clear Context` | Clear all context |
| `Mysti: Open in New Tab` | Open chat as editor tab |

---

## 📊 Telemetry

Mysti collects **anonymous** usage data to improve the extension:
- Feature usage patterns
- Error rates
- Provider preferences

**No code, file paths, or personal data is ever collected.**

Respects VSCode's telemetry setting. Disable via:
`Settings → Telemetry: Telemetry Level → off`

---

## 📄 License

**Business Source License 1.1 (BSL 1.1)**

- **Free** for personal, educational, and non-profit use
- **Commercial use** requires a separate license
- Converts to **MIT License** on December 3, 2030

Contact baha@deepmyst.com for commercial licensing.

---

## 🤝 Contributing

Contributions welcome! See our [Architecture Guide](docs/ARCHITECTURE.md) for technical details.

1. Fork the repository
2. Create a feature branch
3. Submit a Pull Request

---

<p align="center">
  <strong>Mysti</strong> - Built by <a href="https://deepmyst.com">DeepMyst Inc</a><br>
  <sub>Made with Claude Code</sub>
</p>

<p align="center">
  <a href="https://github.com/DeepMyst/Mysti">GitHub</a> •
  <a href="https://deepmyst.com">Website</a> •
  <a href="https://www.linkedin.com/company/deepmyst/">LinkedIn</a>
</p>
