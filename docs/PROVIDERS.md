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
npm install -g @anthropic-ai/claude-code@2.1.266
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
- **Native approvals**: Claude's host control channel waits for the owning Mysti permission decision before executing a supported tool.

The approval bridge supports Claude Code **2.1.266**. Other versions stop before
submission. Mysti supplies its own permission policy and disables native hooks,
custom skills, implicit MCP servers, background tasks, and delegated runtimes.
Explicit Mysti Canvas MCP tools remain available. See the
[native CLI approval contract](NATIVE_CLI_APPROVAL.md) for mode and lifecycle limits.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.claudeCodePath` | `claude` | Path to the supported Claude CLI executable |
| `mysti.claudeModel` | `sonnet` | Default model |
| `mysti.thinkingLevel` | `none` | Thinking level (none, low, medium, high) |

---

## OpenAI Codex

Fast iteration cycles with OpenAI's latest models.

### Installation

Follow [OpenAI's Codex CLI installation guide](https://github.com/openai/codex).
The Mysti bridge currently supports **0.153.4**:

```bash
npm install -g @openai/codex@0.153.4
```

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

- **Native approvals**: Command and patch requests wait for Mysti's captured permission decision over app-server stdio.
- **Fast Iteration**: Optimized for quick code generation cycles

Each turn starts a fresh native thread with prompt history and a read-only,
network-disabled sandbox. Native trusted reads may run without a host card.
Saved execution rules, named profiles, managed policy, MCP servers, and other
unsupported configuration stop startup; Mysti does not modify those files.
Windows support and authenticated/editor acceptance remain pending. See the
[native CLI approval contract](NATIVE_CLI_APPROVAL.md) for the supported boundary.

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
npm install -g @google/gemini-cli@0.58.0
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

The **0.58.0** ACP bridge permits file reads, writes and replacements. Shell and delegation are disabled because this version omits their complete approval inputs. See the [ACP approval contract](ACP_NATIVE_APPROVAL.md) for startup restrictions and acceptance limits.

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
npm install -g cline@3.0.61
```

### Authentication

The ACP bridge requires `CLINE_API_KEY` in the extension environment, with optional `CLINE_PROVIDER`. Saved CLI login profiles are not imported into its private local session.

### Supported Models

- Claude 3.5 Sonnet
- GPT-4o
- Gemini Pro

### Unique Features

- **Plan/Act Mode**: Mysti selects the native session mode before each turn
- **Multi-Model**: Supports models from multiple providers
- **Task-Oriented**: Designed for structured task completion

The **3.0.61** ACP bridge uses private local state and native permission requests. Images, native thinking controls and usage reporting are unavailable in this transport. See the [ACP approval contract](ACP_NATIVE_APPROVAL.md) for startup restrictions and acceptance limits.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.clinePath` | `cline` | Path to Cline CLI executable |
| `mysti.clineModel` | `claude-3-5-sonnet` | Default model |

---

## GitHub Copilot

Use the supported Copilot CLI with an isolated BYOK endpoint. Subscription login support remains pending native policy attestation.

### Installation

```bash
npm install -g @github/copilot@1.0.83
```

### Authentication

The ACP bridge requires an explicit BYOK endpoint through `COPILOT_PROVIDER_BASE_URL`, with its model and API key configured through the native `COPILOT_PROVIDER_*` environment variables. It runs offline from GitHub. GitHub tokens and stored subscription logins are currently unsupported because remotely managed hooks cannot be attested by this bridge.

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
- **Native approvals**: This verified Copilot release is restricted to read/search operations; native reads run without a host card

The **1.0.83** ACP transport permits only read/search operations. It disables file writes, shell, web tools, hooks, plugins, MCP and delegation. Native workspace writes and some shell commands bypass the approval callback, so writable Copilot support remains unresolved. Native safe reads do not reach host approval policy. See the [ACP approval contract](ACP_NATIVE_APPROVAL.md) for startup restrictions and acceptance limits.

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
- **Execution limits**: Available only for `default` or `edit-automatically` with `full-access`. All approval-required and read-only turns are rejected before launch; streamed tool events cannot enforce approval. Prompt enhancement is unavailable. See [restricted transports](RESTRICTED_TRANSPORTS.md).
- **Tool Use Detection**: Detects and displays tool usage (bash, file read/write, grep, etc.)

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.cursorPath` | `agent` | Path to Cursor CLI executable |
| `mysti.cursorModel` | `auto` | Default model |

---

## OpenClaw

Agent turns stream through an owned local runtime with native approvals.
Mysti supports verified OpenClaw **2026.6.34 on POSIX** with the embedded
OpenClaw/Pi harness and stock `read`, `write`, `edit`, and foreground `exec` tools.
Unsupported runtimes or failed approval startup prevent execution. There is no
CLI fallback.

### Installation

```bash
npm install -g openclaw@2026.6.34
```

### Configuration and credentials

Use ordinary JSON in `~/.openclaw/openclaw.json`, or select a file with
`OPENCLAW_CONFIG_PATH`. Set `agents.defaults.model` to an explicit
`provider/model` identifier and configure the matching provider. The owned
runtime accepts inline or process-environment credentials; it does not import
external OAuth/auth-profile stores, executable credentials, or `config.env`.
The Mysti model dropdown and legacy `mysti.openclawModel` setting do not override
this configured model. Authenticated provider acceptance remains pending.

### Unique Features

- **Native approvals**: Final tool arguments are checked before execution; Stop and disconnect revoke the turn's authority.
- **Owned streaming runtime**: Agent turns require an approved local runtime regardless of shared-gateway availability.
- **Shared gateway**: Status and direct channel delivery use the configured gateway. Its agent submission routes are disabled.
- **Session continuity**: A panel retains its logical session within its owned runtime; clearing the session rotates that identity.

Active Mode can start an already installed shared Gateway service using
`openclaw gateway start`. It does not fall back to foreground agent execution
when service startup fails. See [native approval support and limits](OPENCLAW_NATIVE_POLICY.md)
and the [transport contract](OPENCLAW_TRANSPORT.md).

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.openclawPath` | `openclaw` | Path to the verified 2026.6.34 executable |
| `mysti.openclawModel` | empty | Deprecated; configure `agents.defaults.model` in OpenClaw |
| `mysti.openclawUseGateway` | `true` | Connect the provider's shared gateway at initialization; does not select agent transport |
| `mysti.openclawGatewayUrl` | `ws://127.0.0.1:18789` | Shared gateway URL for status and channels |

---

## OpenCode

Multi-backend coding agent supporting multiple LLM providers through a unified CLI.

### Installation

```bash
npm i -g opencode-ai@1.18.29
```

### Authentication

Set the API key for the selected standard provider in the extension environment, such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY`. Saved OpenCode login stores and custom provider configuration are not imported.

### Supported Models

Set `mysti.opencodeModel` to an explicit `provider/model` ID. The bridge supports OpenCode **1.18.29** and checks the selected model in its isolated native session.

### Unique Features

- **Native approvals**: File, search and fetch tools use a fixed native permission policy.
- **Restricted mode**: Mutating tools are removed from the executable tool map.
- **Prompt history**: Each turn starts a fresh native session.

Shell commands, delegation, plugins, MCP, custom tools, formatters and native session resume are unavailable in this bridge.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.opencodePath` | `opencode` | Path to OpenCode CLI executable |
| `mysti.opencodeModel` | `` | Custom model (provider/model format) |

---

## Qwen Code

Alibaba's AI coding CLI agent with an ACP permission bridge for version **0.23.0**.

### Installation

```bash
npm install -g @qwen-code/qwen-code@0.23.0
```

### Authentication

```bash
qwen
# Then type /auth in the interactive session
```

Or configure a supported Qwen/OpenAI-compatible API endpoint, key and model. `ANTHROPIC_API_KEY` alone is not Qwen authentication.

### Supported Models

- Qwen3 Coder
- Qwen3 Coder Plus

### Unique Features

- **Native approvals**: Read, edit, notebook edit and foreground shell use explicit native ask rules.
- **Restricted mode**: Mutation tools are excluded before model submission.
- **Prompt history**: Each turn starts a fresh session with the conversation history.

The bridge disables hooks, extensions, skills, MCP, background execution and delegated tools. See the [ACP approval contract](ACP_NATIVE_APPROVAL.md) for startup restrictions and acceptance limits.

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
