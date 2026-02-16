# AI Providers

Mysti supports 7 AI providers. You only need one to get started — install any two to unlock Brainstorm Mode.

## Provider Overview

| Provider | Type | Models | Best For |
|----------|------|--------|----------|
| **Claude Code** | CLI | Claude Opus 4.6, Sonnet 4.5, Haiku 4.5 | Deep reasoning, complex refactoring, thorough analysis |
| **OpenAI Codex** | CLI | GPT-5.2, GPT-5.2 Thinking, GPT-5 | Quick iterations, familiar OpenAI style |
| **Google Gemini** | CLI | Gemini 3 Deep Think, Gemini 2.5 Pro | Fast responses, Google ecosystem integration |
| **Cline** | CLI | Claude 3.5 Sonnet, GPT-4o, Gemini Pro | Plan/Act mode, multi-model flexibility |
| **GitHub Copilot** | CLI | 14+ models (Claude, GPT, Gemini) | Multi-model access via GitHub subscription |
| **Cursor** | CLI | Auto, Claude Sonnet 4, GPT-5, o3, Gemini 2.5 Pro | Multi-model with auto-selection |
| **OpenClaw** | CLI + WebSocket | Claude Opus 4.6, Sonnet 4.5, GPT-5 | Real-time WebSocket streaming, thinking levels |

## Claude Code

**The recommended provider** for deep reasoning and complex coding tasks.

### Installation

```bash
npm install -g @anthropic-ai/claude-code
```

### Authentication

```bash
claude auth login
```

Opens a browser window to authenticate with your Anthropic account.

### Supported Models

- Claude Opus 4.6
- Claude Sonnet 4.5
- Claude Haiku 4.5

### Unique Features

- **Thinking Mode**: Extended reasoning with configurable thinking levels
- **Native Compaction**: Built-in `/compact` command for context management
- **Session Resume**: Continue previous conversations with `--resume`
- **MCP Permission Server**: Fine-grained permission control through VSCode UI

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.claudePath` | `claude` | Path to Claude CLI executable |
| `mysti.claudeModel` | `sonnet` | Default model |
| `mysti.thinkingLevel` | `none` | Thinking level (none, low, medium, high) |

---

## OpenAI Codex

Fast iteration cycles with OpenAI's latest models.

### Installation

Follow [OpenAI's Codex CLI installation guide](https://github.com/openai/codex).

### Authentication

```bash
codex auth login
```

Or set `OPENAI_API_KEY` environment variable.

### Supported Models

- GPT-5.2
- GPT-5.2 Thinking
- GPT-5

### Unique Features

- **Profile Switching**: Switch between different OpenAI configurations
- **Fast Iteration**: Optimized for quick code generation cycles

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.codexPath` | `codex` | Path to Codex CLI executable |
| `mysti.codexModel` | `gpt-5.2` | Default model |

---

## Google Gemini

Google's AI with fast response times and strong Google ecosystem integration.

### Installation

```bash
npm install -g @google/gemini-cli
```

### Authentication

```bash
gemini auth login
```

### Supported Models

- Gemini 3 Deep Think
- Gemini 2.5 Pro

### Unique Features

- **Fast Responses**: Generally the fastest response times
- **Thinking Support**: Deep thinking mode available
- **Google Integration**: Works well with Google Cloud and Firebase projects

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.geminiPath` | `gemini` | Path to Gemini CLI executable |
| `mysti.geminiModel` | `gemini-3-deep-think` | Default model |

---

## Cline

Versatile CLI tool with plan/act workflow support.

### Installation

```bash
npm install -g cline
```

### Authentication

Depends on the underlying model provider selected within Cline.

### Supported Models

- Claude 3.5 Sonnet
- GPT-4o
- Gemini Pro

### Unique Features

- **Plan/Act Mode**: Separate planning and execution phases via `/plan-act` command
- **Multi-Model**: Supports models from multiple providers
- **Task-Oriented**: Designed for structured task completion

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.clinePath` | `cline` | Path to Cline CLI executable |
| `mysti.clineModel` | `claude-3-5-sonnet` | Default model |

---

## GitHub Copilot

Access 14+ models from Anthropic, OpenAI, and Google through your GitHub subscription.

### Installation

```bash
npm install -g @github/copilot-cli
```

### Authentication

```bash
copilot
# Then use the /login command
```

### Supported Models

**Anthropic:**
- Claude Sonnet 4.5
- Claude Opus 4.5
- Claude Haiku 4.5

**OpenAI:**
- GPT-5.2
- GPT-5.1 Codex Max
- GPT-5.1 Codex
- GPT-5

**Google:**
- Gemini 3 Pro
- Gemini 3 Flash
- Gemini 2.5 Pro

### Unique Features

- **Multi-Model Access**: Use Claude, GPT, and Gemini through a single subscription
- **GitHub Integration**: Leverages your existing GitHub Copilot subscription
- **No Extra Cost**: Included with GitHub Copilot Pro/Pro+/Business plans

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.copilotPath` | `copilot` | Path to Copilot CLI executable |
| `mysti.copilotModel` | `claude-sonnet-4-5` | Default model |

---

## Cursor

Cursor's headless AI agent with smart auto-selection.

### Installation

```bash
curl https://cursor.com/install -fsS | bash
```

### Authentication

```bash
agent login
```

Or set `CURSOR_API_KEY` environment variable.

### Supported Models

- Auto (recommended — intelligently selects the best model)
- Claude Sonnet 4
- Claude Sonnet 4 Thinking
- GPT-5
- OpenAI o3
- Gemini 2.5 Pro

### Unique Features

- **Auto Model Selection**: The "Auto" model intelligently picks the best model for each task
- **Auto-Approve Mode**: When access level is set to full-access, enables `--force` flag for uninterrupted workflows
- **Tool Use Detection**: Detects and displays tool usage (bash, file read/write, grep, etc.)

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.cursorPath` | `agent` | Path to Cursor CLI executable |
| `mysti.cursorModel` | `auto` | Default model |

---

## OpenClaw

Dual-transport provider with real-time WebSocket streaming and CLI fallback.

### Installation

```bash
npm install -g openclaw@latest && openclaw onboard --install-daemon
```

### Authentication

```bash
openclaw login
```

Configuration stored in `~/.openclaw/openclaw.json`.

### Supported Models

- Claude Opus 4.6
- Claude Sonnet 4.5
- GPT-5

### Unique Features

- **WebSocket Gateway**: Primary mode uses real-time WebSocket streaming at `ws://127.0.0.1:18789` for low-latency responses
- **CLI Fallback**: Automatically falls back to CLI mode if the gateway is unavailable
- **Thinking Levels**: Configurable thinking (off, low, medium, high) for deeper reasoning
- **Session Persistence**: Continue conversations across sessions

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.openclawPath` | `openclaw` | Path to OpenClaw CLI executable |
| `mysti.openclawModel` | `claude-opus-4-6` | Default model |
| `mysti.openclawUseGateway` | `true` | Use WebSocket Gateway |
| `mysti.openclawGatewayUrl` | `ws://127.0.0.1:18789` | Gateway URL |

---

## Manus (Experimental)

HTTP API-based provider for Manus AI. Currently under development.

> **Note:** Manus is experimental and may not be fully functional. It uses HTTP polling rather than CLI streaming.

### Authentication

Set your API key via settings (`mysti.manusApiKey`) or `MANUS_API_KEY` environment variable.

### Supported Models

- Manus 1.6 Max
- Manus 1.6
- Manus 1.6 Lite

### How It Differs

Unlike other providers that use CLI tools, Manus communicates via HTTP API with an async polling workflow:
1. POST to create a task
2. GET to poll for completion
3. Results returned when task finishes

---

## Switching Providers

### Via Settings

```json
{
  "mysti.defaultProvider": "claude-code"
}
```

### Via Slash Command

Type `/agent` in the chat to open a provider selection dialog.

### Via Settings Panel

Click the settings gear icon in the Mysti sidebar to access the full settings panel where you can switch providers.

---

## Provider Feature Matrix

| Feature | Claude | Codex | Gemini | Cline | Copilot | Cursor | OpenClaw |
|---------|--------|-------|--------|-------|---------|--------|----------|
| Streaming | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Thinking Mode | Yes | Yes | Yes | No | No | Yes | Yes |
| Native Compaction | Yes | No | No | No | No | No | No |
| Session Resume | Yes | Yes | Yes | No | No | Yes | Yes |
| Tool Use Display | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Brainstorm Support | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Autonomous Mode | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
