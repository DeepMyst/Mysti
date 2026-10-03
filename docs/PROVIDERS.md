# AI Providers

Mysti offers its own coordinator plus 15 registered agent backends. You only need one to get started — install any two to unlock Brainstorm Mode.

## Provider Overview

| Provider | Transport | Setup / prerequisites |
| --- | --- | --- |
| Mysti | DeepMyst gateway or direct OpenRouter | Sign in to DeepMyst, or configure your own OpenRouter key |
| Claude Code | Persistent CLI with native approval protocol | `claude`, authenticated account |
| OpenAI Codex | CLI app-server | `codex`, authenticated account |
| Google Gemini | CLI | `gemini`, configured account |
| Cline | CLI | `cline`, configured account/model |
| GitHub Copilot | CLI | `copilot`, entitled GitHub account |
| Cursor | CLI | `agent`, configured account |
| OpenClaw | Gateway or local CLI | Running compatible gateway or `openclaw`, explicit full tool authority |
| OpenCode | CLI | `opencode`, configured backend |
| Qwen Code | CLI | `qwen`, configured account |
| Hermes | ACP over CLI | `hermes`, configured model/backend |
| Kimi Code | ACP over CLI | `kimi`, configured account |
| Continue | CLI | `cn`, configured model/backend |
| Ollama | Local server | Running Ollama and an installed model |
| LocalAI | HTTP endpoint | Running LocalAI and an installed model |
| OpenRouter | HTTP | Your OpenRouter key and an available model |

Model lists and entitlements change. Use Mysti's model dropdown and Refresh Models for the current catalog. Custom entries are stored per provider in `mysti.customModels`; a provider-specific model override takes precedence. Manus source exists but is not registered or selectable in this release.

## Mysti coordinator

Select **Mysti**, then use **Mysti: Sign In to DeepMyst**. A direct key in `mysti.openrouter.apiKey` selects OpenRouter instead. The coordinator's model is controlled by `mysti.mysti.coordinatorModel` on the gateway route and `mysti.openrouter.coordinatorModel` on the direct route. Free-model availability and account credits are checked at runtime; local CLI subscriptions do not authenticate the coordinator. Paid fallback remains subject to the spend guard.

## Permissions and compatibility

Claude Code and Codex use native request/response approvals. A failed native transport reports an error instead of falling back to an unrestricted process. Verified with Claude Code 2.1.278 and Codex 0.153.4; older CLIs must support the same protocol. Update the CLI when initialization fails.

Codex uses native thread resume and sends the selected model explicitly. In restricted modes it starts with a read-only sandbox and obtains approval for mutations. External MCP servers and app tools are disabled in those modes because this adapter cannot enforce their remote side effects per call. They remain available with explicit unrestricted authority. Claude questions and plan choices use Mysti's existing follow-up conversation flow.

OpenClaw accepts gateway protocols 3–4 and signs gateway challenges with a Mysti-owned device key stored in VS Code SecretStorage. A remote gateway may require pairing approval; Mysti does not bypass it. Its gateway/local CLI cannot enforce Mysti's Ask or Read Only policy, so Mysti rejects these combinations before sending a prompt. Use a provider with native approvals, or deliberately select Full Access with a mode that permits unrestricted tools. OpenClaw then uses its own configured policy. The fallback does not pass nonexistent `--sandbox` or `--yolo` options.

Other providers have differing permission guarantees. A visible tool card alone does not prove pre-execution consent. See [native approval contracts](NATIVE_APPROVAL.md) for the transport-specific limits.

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

Use the model dropdown for the current bundled/discovered catalog and any provider-scoped custom IDs. Availability depends on the configured account or endpoint.

### Unique Features

- **Thinking Mode**: Extended reasoning with configurable thinking levels
- **Native Compaction**: Built-in `/compact` command for context management
- **Session Resume**: Continue previous conversations with `--resume`
- **MCP Permission Server**: Fine-grained permission control through VSCode UI

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.claudeCodePath` | `claude` | Path to Claude CLI executable |
| `mysti.claudeModel` | `sonnet` | Default model |
| `mysti.thinkingLevel` | `none` | Thinking level (none, low, medium, high) |

---

## OpenAI Codex

Fast iteration cycles with OpenAI's latest models.

### Installation

Follow [OpenAI's Codex CLI installation guide](https://github.com/openai/codex).

### Authentication

```bash
codex login
```

Or set `OPENAI_API_KEY` environment variable.

### Supported Models

Use the model dropdown for the current bundled/discovered catalog and any provider-scoped custom IDs. Availability depends on the configured account or endpoint.

### Unique Features

- **Profile Switching**: Switch between different OpenAI configurations
- **Fast Iteration**: Optimized for quick code generation cycles

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.codexPath` | `codex` | Path to Codex CLI executable |
| `mysti.codexModel` | empty | Optional model override; otherwise use the selected model |
| `mysti.codexProfile` | empty | Named local Codex profile |

---

## Google Gemini

Google's AI with fast response times and strong Google ecosystem integration.

### Installation

```bash
npm install -g @google/gemini-cli
```

### Authentication

```bash
gemini
```

### Supported Models

Use the model dropdown for the current bundled/discovered catalog and any provider-scoped custom IDs. Availability depends on the configured account or endpoint.

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

Use the model dropdown for the current bundled/discovered catalog and any provider-scoped custom IDs. Availability depends on the configured account or endpoint.

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
npm install -g @github/copilot
```

### Authentication

```bash
copilot
# Then use the /login command
```

### Supported Models

Use the model dropdown for the current bundled/discovered catalog and any provider-scoped custom IDs. Availability depends on the configured account or endpoint.

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

Use the model dropdown for the current bundled/discovered catalog and any provider-scoped custom IDs. Availability depends on the configured account or endpoint.

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
openclaw onboard
```

Configuration stored in `~/.openclaw/openclaw.json`.

### Supported Models

Use the model dropdown for the current bundled/discovered catalog and any provider-scoped custom IDs. Availability depends on the configured account or endpoint.

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

Use the model dropdown for the current bundled/discovered catalog and any provider-scoped custom IDs. Availability depends on the configured account or endpoint.

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

Use the model dropdown for the current bundled/discovered catalog and any provider-scoped custom IDs. Availability depends on the configured account or endpoint.

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

Use the model dropdown for the current bundled/discovered catalog and any provider-scoped custom IDs. Availability depends on the configured account or endpoint.

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

Use the model dropdown for the current bundled/discovered catalog and any provider-scoped custom IDs. Availability depends on the configured account or endpoint.

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

## Hermes, Kimi Code, Continue and OpenRouter

Install/configure the relevant CLI through Mysti's provider setup flow, then refresh detection. Configure a nonstandard executable with `mysti.hermesPath`, `mysti.kimiCodePath`, or `mysti.continuePath`. Each provider has a matching model override: `mysti.hermesModel`, `mysti.kimiCodeModel`, or `mysti.continueModel`.

Hermes and Kimi use ACP permission requests scoped to the current process and turn. Continue uses restrictive native flags where an interactive host approval is unavailable. OpenRouter requires no CLI: configure `mysti.openrouter.apiKey`, select an available model, and optionally set `mysti.openrouterModel`.

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

## Provider capabilities

The settings and slash menus use the registered capability manifest. Claude and Codex stream text, reasoning, tool activity and usage; both support native session continuity. Claude additionally supports native compaction. Hermes and Kimi use ACP sessions and approvals. Ollama and LocalAI display tool-call proposals without executing them; OpenRouter is chat-only. The Mysti coordinator has its own tools, collaboration, memory and spend controls.

For the complete feature inventory and measured validation status, see the [feature review](../plans/34-feature-review.md). Automated parser coverage is distinct from account-backed validation.
