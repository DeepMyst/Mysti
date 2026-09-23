# AI Providers

Mysti registers 15 backends. Their transports and supported operations differ;
registration does not establish installed or authenticated compatibility. Start
with the [approval matrix](APPROVAL_ACCEPTANCE_MATRIX.md) and the provider's native
contract before choosing a mode. Model examples below are configuration examples,
not a guarantee that an account or installed CLI exposes those models.

Install commands for exact-version native bridges target the verified contract.
Newer upstream releases need approval/startup compatibility review before Mysti
offers them as updates. Current release and acceptance gaps are tracked in
[the reliability checklist](RELIABILITY_GOAL.md).

## Provider overview

| Provider | Agent transport | Execution boundary |
| --- | --- | --- |
| Claude Code | Native host-control CLI | Pinned native file/command approvals |
| Codex | App-server | Native command/file requests and sandbox |
| Gemini | ACP | Bounded file operations |
| Cline | ACP | Supported final native tool inputs |
| Copilot | ACP | Per-call approved sync shell and per-file edits; read/search only in restricted tiers |
| Cursor | CLI | Fully unrestricted turns only |
| OpenClaw | Owned local gateway/runtime | Bounded stock tools with final execution guard |
| OpenCode | ACP | File/search/fetch subset; per-call approved shell on macOS; no delegation |
| Qwen Code | ACP | Read/edit/notebook/foreground shell subset |
| Hermes | Persistent ACP | Restricted tiers rejected; unrestricted turns only |
| Kimi Code | Persistent ACP | Restricted tiers rejected; unrestricted turns only |
| Continue | Plain-text CLI | Fully unrestricted turns only |
| Ollama | HTTP | Reports tool proposals; does not execute them |
| LocalAI | HTTP | Reports tool proposals; does not execute them |
| OpenRouter | HTTP | Chat; no local tool execution |

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
| `mysti.claudeCodeModel` | empty | Custom model override; otherwise use the selected model |
| `mysti.defaultThinkingLevel` | `none` | Thinking level (none, low, medium, high) |

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
codex login
```

Or set `OPENAI_API_KEY` environment variable.

### Supported Models

Use the model picker, which merges the bundled fallback list with native model
discovery. The fallback includes GPT-6 Astra and GPT-5.6 Sol, Terra and Luna;
account availability still governs access. Retired automatic suggestions are
filtered from discovery and saved caches. Explicit custom model IDs remain usable.

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
| `mysti.codexModel` | empty | Custom model override; otherwise use the selected model |

---

## Google Gemini

Google's AI with fast response times and strong Google ecosystem integration.

### Installation

```bash
npm install -g @google/gemini-cli@0.60.0
```

### Authentication

```bash
gemini
```

Use a Gemini Code Assist Standard or Enterprise sign-in, an API key through
`GEMINI_API_KEY` / `GOOGLE_API_KEY`, or Vertex AI. Personal Google AI and free
account access moved to Antigravity CLI on June 18, 2026; it is a separate product
and is not the Gemini bridge. See [Google's service-transition announcement](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/).

### Supported Models

Use the picker or an explicit custom model ID. The bundled default is
`gemini-3.8-flash`; API-key discovery can refresh the available catalogue.

### Unique Features

- **Fast Responses**: Generally the fastest response times
- **Usage reporting**: The native transport reports token usage when available
- **Google Integration**: Works well with Google Cloud and Firebase projects

The **0.60.0** ACP bridge (0.58.0 remains accepted) permits file reads, writes and replacements. Shell and delegation are disabled because these releases omit their complete approval inputs. 0.60.0 ignores a system settings file that is not root-owned, so Mysti enforces its startup policy through the admin policy file and refuses user/workspace customization (including `.agents/skills`) instead. See the [ACP approval contract](ACP_NATIVE_APPROVAL.md) for startup restrictions and acceptance limits.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.geminiPath` | `gemini` | Path to Gemini CLI executable |
| `mysti.geminiModel` | empty | Custom model override; otherwise use the selected model |

---

## Cline

Versatile CLI tool with plan/act workflow support.

### Installation

```bash
npm install -g cline@3.0.64
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

The **3.0.64** ACP bridge (3.0.61 remains accepted) uses private local state and native permission requests. Startup is refused while `~/.agents/plugins` (loaded by 3.0.62+) holds agent plugins. Images, native thinking controls and usage reporting are unavailable in this transport. See the [ACP approval contract](ACP_NATIVE_APPROVAL.md) for startup restrictions and acceptance limits.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.clinePath` | `cline` | Path to Cline CLI executable |
| `mysti.clineModel` | empty | Custom model override; otherwise use the selected model |

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

- **Configured BYOK model**: Uses the explicitly configured provider endpoint/key/model. Subscription login is not supported by this isolated transport.
- **Native approvals**: Sync shell commands and per-file edits wait for a host card; read-only and plan tiers expose read/search only; native reads run without a host card

The **1.0.83** ACP transport holds each sync shell command and each patched file for a host card. It denies async/detached shells, web tools, broader path grants, hooks, plugins, MCP and delegation; read-only and plan tiers keep only read/search tools. The earlier approval bypass came from Mysti setting `COPILOT_ALLOW_ALL=false`, which this release reads as allow-all; the variable is now left unset. Native safe reads do not reach host approval policy. See the [ACP approval contract](ACP_NATIVE_APPROVAL.md) for startup restrictions and acceptance limits.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.copilotPath` | `copilot` | Path to Copilot CLI executable |
| `mysti.copilotModel` | empty | Custom model override; otherwise use the selected model |

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
- **Tool Use Detection**: Displays native tool notifications; they are not permission requests.
- **Conversation history**: Replayed in each prompt, with shared per-turn Stop and replacement ownership.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.cursorPath` | `agent` | Path to Cursor CLI executable |
| `mysti.cursorModel` | empty | Custom model override; otherwise use the selected model or `auto` |

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
- **Shell (macOS)**: In unrestricted tiers each shell command needs its own approval card. Mysti loads a private gate plugin that refuses any command OpenCode did not submit for approval, such as a redirection-only `> file`.
- **Restricted mode**: Mutating tools and shell are removed from the executable tool map.
- **Prompt history**: Each turn starts a fresh native session.

Delegation, user/workspace plugins, MCP, custom tools, formatters and native session resume are unavailable in this bridge. Shell stays unavailable on Linux and Windows until the gate has native acceptance there.

Startup is refused if `.opencode`, `opencode.json`, or `opencode.jsonc` exists in
the workspace or any ancestor, including ancestors reached through symlinks.
Empty files/directories and dangling links also block startup. Use an environment
without these paths and without inherited user/system OpenCode configuration:
this native version can load that configuration despite its isolation flags.
See the [ACP approval contract](ACP_NATIVE_APPROVAL.md) for the exact startup
checks and their limits.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.opencodePath` | `opencode` | Path to OpenCode CLI executable |
| `mysti.opencodeModel` | `` | Custom model (provider/model format) |

---

## Qwen Code

Alibaba's AI coding CLI agent with an ACP permission bridge for version **0.24.4** (0.23.0 remains accepted).

### Installation

```bash
npm install -g @qwen-code/qwen-code@0.24.4
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

HTTP access to an Ollama server, using localhost by default.

### Installation

Download from [ollama.com](https://ollama.com), then pull a model:

```bash
ollama pull llama3
```

### Authentication

The adapter expects an endpoint that does not require authentication. Where the
model runs and what data leaves your machine depend on the configured server.

### Supported Models

Any model available in the Ollama library: Llama 3, Mistral, CodeLlama, Phi, Gemma, and more.

### Unique Features

- **Model discovery**: Lists models exposed by the configured server
- **Streaming**: Text and model-provided thinking, with final token usage
- **Tool proposals**: Displays requested tools without executing them
- **Cancellation**: Stop closes the owned HTTP request; server-side cancellation depends on the server

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.ollamaEndpoint` | `http://localhost:11434` | Ollama HTTP API endpoint |
| `mysti.ollamaModel` | `` | Custom model |

---

## LocalAI

Self-hosted AI model provider for on-premise deployments.

### Installation

Follow the installation guide at [localai.io](https://localai.io).

### Authentication

Set `mysti.localaiApiKey` if the configured server requires a bearer API key.

### Supported Models

Supports a wide range of self-hosted models. See LocalAI documentation for compatible models.

### Unique Features

- **Self-Hosted**: Run on your own infrastructure
- **Full Control**: Configure models, resources, and access as needed
- **Streaming**: Text, model-provided thinking and reported or explicitly estimated usage
- **Tool proposals**: Reassembles streamed arguments without executing tools
- **No Subscription**: Free and open source

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.localaiEndpoint` | `http://localhost:8080` | LocalAI HTTP API endpoint |
| `mysti.localaiApiKey` | empty | Bearer API key when required by the server |
| `mysti.localaiModel` | `` | Custom model |

---

## Hermes and Kimi Code

These persistent ACP adapters implement native request/card/response routing,
reported session continuity, images and usage. Neither CLI is installed in the
review environment. Native policy completeness and authenticated/editor behavior
remain unverified; fixture coverage does not establish universal tool approval.

The 2026-09-22 source review found that neither agent requests permission for
every operation: Hermes v2026.9.21 asks only for denylisted shell commands and
file edits, and Kimi Code 2.0.2 auto-approves in-repository writes, fetches,
subagents and skills. Both honour inherited yolo/auto-approve user settings.
Mysti therefore rejects every restricted tier for them before launch; only
`full-access` with `default` or `edit-automatically` runs.

Kimi Code has two generations behind one `kimi` binary, told apart by
`--version` (`2.0.2` vs `kimi, version 1.51.0`). Kimi Code 2.x (npm
`@moonshot-ai/kimi-code` or the official installer in `~/.kimi-code/bin`) keeps
its data in `~/.kimi-code` (`KIMI_CODE_HOME`); the Python kimi-cli 1.x uses
`~/.kimi` (`KIMI_SHARE_DIR`). Both keep OAuth tokens in `credentials/*.json`,
which Mysti checks for presence only. kimi-cli 1.52.0 is a tombstone that no
longer runs `kimi acp`, so Mysti refuses it before launch and points at the
installer; 1.51 and earlier still work. A selected model is applied with
`session/set_model` after `session/new` (neither generation reads the
`ANTHROPIC_MODEL` env Mysti used to set). Kimi Code 2.x applies a user's
`default_permission_mode = "yolo"|"auto"` to ACP sessions while reporting mode
`default`; Mysti now sends `session/set_mode default` first, which a local
2.0.2 witness showed restores the per-tool permission request. Updates run
`kimi upgrade` on 2.x and the Kimi Code installer on 1.x.

## Continue

The `cn` CLI prints final text and exposes no host approval handshake. Its native
`--readonly` mode permits Bash and MCP operations, so Mysti rejects restricted
turns before launch. Only `full-access` with `default` or `edit-automatically` is
available; those turns exclude the built-in `Search` tool, whose ripgrep command
line is shell-injectable from a model pattern or a `.gitignore` line. It replays conversation history in the prompt and reports no usage.
Continue is not installed in the review environment.

## OpenRouter

The HTTP adapter sends the built conversation prompt to the configured model.
It reports streamed text/reasoning and returned usage, and executes no local tools.
Its history is replayed in each request; it does not resume a server session.

Manus source remains in the repository but is not a registered backend.

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

## Declared display and continuity capabilities

This table describes the implemented adapters. “History” means Mysti replays the
conversation in each request; “native” means a provider-managed session. Thinking
output does not imply that Mysti's thinking-level control is effective. “Usage”
means the transport can report it, not that every response contains measurements.
External acceptance limits in the approval matrix still apply.

| Provider | Continuity | Thinking output | Usage |
| --- | --- | --- | --- |
| Claude Code | native | streamed | yes |
| Cline | history | complete blocks | no |
| OpenAI Codex | history | complete blocks | yes |
| Continue | history | complete blocks | no |
| GitHub Copilot | history | none | no |
| Cursor | history | none | yes |
| Gemini | history | none | yes |
| Hermes | native | none | yes |
| Kimi Code | native | streamed | yes |
| LocalAI | history | streamed | yes |
| Ollama | history | streamed | yes |
| OpenClaw | native | complete blocks | no |
| OpenCode | history | complete blocks | yes |
| OpenRouter | history | streamed | yes |
| Qwen Code | history | complete blocks | yes |

Brainstorm/session participation also requires availability and the requested
restricted execution tier. There is no blanket autonomy or approval guarantee
across providers.
