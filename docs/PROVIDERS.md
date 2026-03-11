# AI Providers

Mysti supports 12 AI providers. You only need one to get started — install any two to unlock Brainstorm Mode.

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
| **OpenCode** | CLI | Configurable (Anthropic, OpenAI, Google, Groq) | Multi-backend agent, flexible model selection |
| **Qwen Code** | CLI | Qwen3 Coder, Qwen3 Coder Plus | Alibaba's AI coding agent, deep reasoning |
| **Ollama** | CLI | Local models (Llama, Mistral, CodeLlama, etc.) | Local inference, privacy-first, no subscription |
| **LocalAI** | CLI | Self-hosted models | Full control, on-premise deployment |

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

## OpenCode

Multi-backend coding agent supporting multiple LLM providers through a unified CLI.

### Installation

```bash
npm i -g opencode-ai@latest
```

### Authentication

```bash
opencode auth login
```

Or set provider API keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`.

### Supported Models

OpenCode uses your configured default model. Models depend on your provider setup — run `opencode models` to see available models.

### Unique Features

- **Multi-Backend**: Single CLI supporting Anthropic, OpenAI, Google, Groq, AWS Bedrock, Azure OpenAI, OpenRouter
- **Agent Modes**: `build` agent for full access, `plan` agent for read-only analysis
- **Thinking Support**: Built-in thinking block streaming
- **Session Resume**: Continue previous sessions via `--session <id>` or `--continue`

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.opencodePath` | `opencode` | Path to OpenCode CLI executable |
| `mysti.opencodeModel` | `` | Custom model (provider/model format) |

---

## Qwen Code

Alibaba's AI coding CLI agent with deep reasoning capabilities. Uses the same streaming protocol as Claude Code.

### Installation

```bash
npm install -g @qwen-code/qwen-code@latest
```

### Authentication

```bash
qwen
# Then type /auth in the interactive session
```

Or set API keys: `QWEN_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`.

### Supported Models

- Qwen3 Coder
- Qwen3 Coder Plus

### Unique Features

- **Claude-Compatible Protocol**: Uses the same stream-json NDJSON format as Claude Code
- **Approval Modes**: plan, default, auto-edit, yolo — mapped from Mysti's access levels
- **Auth Error UI**: Guided authentication when not configured
- **Session Resume**: Continue previous sessions with `--continue`

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.qwenCodePath` | `qwen` | Path to Qwen Code CLI executable |
| `mysti.qwenCodeModel` | `` | Custom model |

---

## Ollama

Local LLM inference — run AI models on your own machine with no cloud dependency.

### Installation

Download from [ollama.com](https://ollama.com), then pull a model:

```bash
ollama pull llama3
```

### Authentication

No authentication needed — runs entirely locally.

### Supported Models

Any model available in the Ollama library: Llama 3, Mistral, CodeLlama, Phi, Gemma, and more.

### Unique Features

- **Fully Local**: No internet connection required after model download
- **Privacy**: Your code never leaves your machine
- **No Subscription**: Free to use with any compatible model
- **Fast Inference**: Hardware-accelerated on Apple Silicon, NVIDIA GPUs

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.ollamaPath` | `ollama` | Path to Ollama CLI executable |
| `mysti.ollamaModel` | `` | Custom model |

---

## LocalAI

Self-hosted AI model provider for on-premise deployments.

### Installation

Follow the installation guide at [localai.io](https://localai.io).

### Authentication

No authentication needed — runs entirely locally.

### Supported Models

Supports a wide range of self-hosted models. See LocalAI documentation for compatible models.

### Unique Features

- **Self-Hosted**: Run on your own infrastructure
- **Full Control**: Configure models, resources, and access as needed
- **On-Premise**: Meets compliance requirements for data residency
- **No Subscription**: Free and open source

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.localaiPath` | `localai` | Path to LocalAI CLI executable |
| `mysti.localaiModel` | `` | Custom model |

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

| Feature | Claude | Codex | Gemini | Cline | Copilot | Cursor | OpenClaw | OpenCode | Qwen | Ollama | LocalAI |
|---------|--------|-------|--------|-------|---------|--------|----------|----------|------|--------|---------|
| Streaming | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Thinking Mode | Yes | Yes | Yes | No | No | Yes | Yes | Yes | Yes | No | No |
| Native Compaction | Yes | No | No | No | No | No | No | No | No | No | No |
| Session Resume | Yes | Yes | Yes | No | No | Yes | Yes | Yes | Yes | No | No |
| Tool Use Display | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Brainstorm Support | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Autonomous Mode | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
