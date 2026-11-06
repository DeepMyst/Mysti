# AI Providers

Mysti offers its own coordinator plus 16 registered agent backends. One configured provider is enough for chat; collaboration needs each participant configured and compatible with the requested access mode.

[Documentation index](README.md) · [Troubleshooting](TROUBLESHOOTING.md) · [Privacy and data](PRIVACY.md) · [All settings](SETTINGS.md)

## First successful request

1. Select the provider in the composer. Use its setup card to install a CLI **only if that provider needs one**, then complete its authentication action. HTTP providers need an endpoint or API key instead.
2. Refresh detection. Confirm the selected executable or endpoint, account readiness, and model separately. A detected binary or saved key is not a successful model request.
3. Choose a supported access mode using the [compatibility table](#permissions-and-compatibility). Use a disposable workspace when trying a provider that requires unrestricted tools.
4. Send `Reply with one sentence explaining what you can help me with. Do not use tools.` Expect a completed answer from the selected provider, with no setup or model error. This simple check does not validate tool safety or workspace editing.
5. Add a small non-sensitive file through Context and ask it to explain that file. Move to collaboration after each participant succeeds independently.

Model access, usage charges and quotas belong to the selected service/account. The [readiness report](PRODUCTION_READINESS.md#provider-acceptance-still-needed) distinguishes available adapters from completed native acceptance.

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
| OpenCode | CLI or remote HTTP/SSE | Configured `opencode`, or an authenticated remote server |
| Qwen Code | CLI | `qwen`, configured account |
| Hermes | ACP over CLI | `hermes`, configured model/backend |
| Kimi Code | ACP over CLI | `kimi`, configured account |
| Continue | CLI | `cn`, configured model/backend |
| Ollama | Local server | Running Ollama and an installed model |
| LocalAI | HTTP endpoint | Running LocalAI and an installed model |
| OpenRouter | HTTP | Your OpenRouter key and an available model |
| MiniMax | HTTP | API key stored through provider setup, or `MINIMAX_API_KEY` |

Model lists and entitlements change. Use Mysti's model dropdown and Refresh Models for the current catalog. Custom entries are stored per provider in `mysti.customModels`; a provider-specific model override takes precedence. Manus source exists but is not registered or selectable in this release.

## Mysti coordinator

Select **Mysti**, then use **Mysti: Sign In to DeepMyst**. A direct key in `mysti.openrouter.apiKey` selects OpenRouter instead. The coordinator's model is controlled by `mysti.mysti.coordinatorModel` on the gateway route and `mysti.openrouter.coordinatorModel` on the direct route. Free-model availability and account credits are checked at runtime; local CLI subscriptions do not authenticate the coordinator. Paid fallback remains subject to the spend guard.

## Permissions and compatibility

Claude Code and Codex use native request/response approvals. A failed native transport reports an error instead of falling back to an unrestricted process. Verified with Claude Code 2.1.278 and Codex 0.153.4; older CLIs must support the same protocol. Update the CLI when initialization fails.

Codex uses native thread resume and sends the selected model explicitly. In restricted modes it starts with a read-only sandbox and obtains approval for mutations. External MCP servers and app tools are disabled in those modes because this adapter cannot enforce their remote side effects per call. They remain available with explicit unrestricted authority. Claude questions and plan choices use Mysti's existing follow-up conversation flow.

OpenClaw accepts gateway protocols 3–4 and signs gateway challenges with a Mysti-owned device key stored in VS Code SecretStorage. A remote gateway may require pairing approval; Mysti does not bypass it. Its gateway/local CLI cannot enforce Mysti's Ask or Read Only policy, so Mysti rejects these combinations before sending a prompt. Use a provider with native approvals, or deliberately select Full Access with a mode that permits unrestricted tools. OpenClaw then uses its own configured policy. The fallback does not pass nonexistent `--sandbox` or `--yolo` options.

Choose an access mode the adapter can enforce. The UI and provider preflight reject unsupported combinations rather than silently granting more authority.

| Provider / transport | Ask / approval-based work | Plan / Read Only |
| --- | --- | --- |
| Claude Code, Codex | Native approval requests wait for Mysti's decision | Native restrictions plus host denial of mutations |
| Hermes | Emitted ACP permission requests wait for Mysti | Non-read permission requests are denied; native request coverage still needs acceptance |
| OpenCode remote HTTP/SSE | Native server permission requests wait for Mysti | Server rules and host checks deny non-read tools |
| Gemini, Copilot, Cursor | Unsupported; choose a provider with native approvals | Native plan or deny-tool flags; not an OS sandbox guarantee |
| Cline | Unsupported through this CLI connection | Legacy 1.x has a plan mapping; modern/unknown versions reject this mode |
| Continue | Runs read-only because this transport cannot prompt for tool approval | `--readonly` |
| OpenClaw, Qwen Code, Kimi Code, OpenCode local CLI | Unsupported; execution requires an explicitly unrestricted mode/access combination | Unsupported |
| Ollama, LocalAI | Report tool proposals without executing them | No tools are executed by these adapters |
| OpenRouter, MiniMax | Text completion; no tool execution | No tools are executed by these adapters |

Unrestricted authority means **Edit Automatically + Full Access**, or another explicitly unrestricted combination accepted by the adapter. Selecting Full Access alone does not make an incompatible Ask mode work. A prompt such as “do not edit” is not a permission boundary. See [native approval contracts](NATIVE_APPROVAL.md) for source references, ownership and verification limits.

## Claude Code

Claude Code uses a persistent CLI transport with native approvals and session continuity.

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
- **Native Approvals**: Scoped permission requests wait for a decision in Mysti

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.claudeCodePath` | `"claude"` | Path to Claude CLI executable |
| `mysti.claudeCodeModel` | `""` | Default model |
| `mysti.defaultThinkingLevel` | `"none"` | Thinking level (none, low, medium, high) |

---

## OpenAI Codex

OpenAI Codex through the CLI app-server transport, with native session continuity and approval requests.

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

- **Native sessions**: Resume the conversation's own app-server thread.
- **Scoped approvals**: Command and file requests wait for the owning Mysti decision.
- **Profile selection**: `mysti.codexProfile` requires profile support in the selected CLI/app-server. If initialization reports it unsupported, clear the setting to use the base configuration; Mysti does not silently ignore an explicit profile.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.codexPath` | `"codex"` | Path to Codex CLI executable |
| `mysti.codexModel` | `""` | Optional model override; otherwise use the selected model |
| `mysti.codexProfile` | `""` | Named local Codex profile |

---

## Google Gemini

Gemini CLI with streamed text, tool activity and native session continuity.

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

- **Streamed results**: Text, tool results and available usage are normalized into the chat.
- **Native plan mode**: Plan/Read Only selects the CLI's plan flag. Ask-tier approvals are not supported by this transport.
- **Model selection**: Select a model available to the configured account; the adapter does not expose reasoning-token budgets.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.geminiPath` | `"gemini"` | Path to Gemini CLI executable |
| `mysti.geminiModel` | `""` | Default model |

---

## Cline

Cline CLI with structured task output. Supported controls depend on the detected CLI generation.

### Installation

```bash
npm install -g cline
```

### Authentication

Depends on the underlying model provider selected within Cline.

### Supported Models

Use the model dropdown for the current bundled/discovered catalog and any provider-scoped custom IDs. Availability depends on the configured account or endpoint.

### Unique Features

- **Version-aware controls**: Legacy 1.x has a native Plan mapping. Modern or unknown versions reject Plan/Read Only; Ask-tier tool approval is unsupported.
- **Model configuration**: Legacy model choice stays in the CLI; modern versions accept a custom model for the configured backend.
- **Conversation context**: Mysti replays conversation history rather than claiming a native session resume.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.clinePath` | `"cline"` | Path to Cline CLI executable |
| `mysti.clineModel` | `""` | Default model |

---

## GitHub Copilot

Use GitHub Copilot CLI with a configured GitHub account and an entitled model.

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

- **Account model catalog**: Model availability, quotas and charges depend on the GitHub account and service.
- **Read-only mapping**: Plan/Read Only denies native shell and write tools. Ask-tier approval is not supported.
- **Version-aware output**: Modern CLI output includes tool events; older text-only output has less detail. Token counts are not inferred from billing units.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.copilotPath` | `"copilot"` | Path to Copilot CLI executable |
| `mysti.copilotModel` | `""` | Default model |

---

## Cursor

Cursor's headless CLI adapter with model selection and tool activity.

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

- **Native model choice**: The Auto option delegates model choice to Cursor.
- **Explicit authority**: `--force` is used only for an unrestricted mode/access combination. Ask-tier work is rejected; Plan/Read Only uses `--mode plan`.
- **Tool activity**: Displays parsed CLI tool events. This adapter currently sends no previous conversation history, so repeat necessary context in a follow-up.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.cursorPath` | `"agent"` | Path to Cursor CLI executable |
| `mysti.cursorModel` | `""` | Default model |

---

## OpenClaw

Gateway authentication resolves exported environment references in `gateway.auth.token`, including `$NAME`, `${NAME}` and env SecretRef objects, with named provider allowlists. Mysti refreshes the token when connecting or reconnecting. Unavailable references fall back to `OPENCLAW_GATEWAY_TOKEN`; they are not sent as literal credentials. This resolution does not execute file, command or plugin secret providers, or load config-defined environment variables, includes or dotenv files.

Local authentication readiness recognizes exported keys for configured built-in backends, including OpenAI, Google, OpenRouter and their supported auth aliases. It follows explicit agent model selection, configured model aliases and fallback overrides. An unrelated provider key does not qualify an explicit backend. When selection cannot be resolved offline, core OpenAI and Anthropic credentials remain generic readiness hints. Stored credentials also remain eligibility hints; OpenClaw validates the selected backend and credentials when it runs. Custom runtime plugins, file-based auth evidence and profile-pinned model resolution are not established by these environment checks.

Readiness also recognizes a selected provider's configured API key, exported environment references and known environment markers. Complete local provider configurations can qualify without a key when native OpenClaw supports that configuration. An unavailable explicit key reference does not become a no-auth configuration, and an existing profile id is not counted as a literal key. These checks do not contact the model endpoint or validate the credential; native OpenClaw still resolves and authenticates the request.

Stored-profile readiness follows the selected backend, configured fallbacks, profile declarations and profile order, including the SQLite runtime-state table and agent-local overrides. An explicit `@profile` or provider-entry profile binding cannot silently use an alternative credential when it is missing, expired or incompatible. Native model-version and quantization suffixes containing `@` remain part of the model name. Deliberate cross-provider `@profile` selection follows OpenClaw's rules; provider-entry bindings require a compatible provider or matching configured base URL. Store format follows the selected CLI: releases through 2026.6.1 use JSON; releases from 2026.6.5 use SQLite and ignore retired JSON even when the database is absent. The selected package's declared executable and current version take precedence over cached discovery. Unknown or unqualified transition builds retain compatibility: an existing database is authoritative, otherwise JSON is a readiness hint. These checks never migrate stores, refresh OAuth credentials or execute secret resolvers.

For JSON installations, a valid `auth-profiles.json` envelope is authoritative even when its profile map is empty or contains unusable credentials. `auth.json` is a fallback only when that envelope is missing or malformed. Profile order from `auth-state.json` overrides embedded order for the same provider; invalid or empty order entries are ignored. SQLite installations never combine retired JSON state with their database.

Prompt enhancement uses OpenClaw's text-only inference interfaces and respects `mysti.openclawUseGateway`. It preserves your draft if the selected CLI or gateway does not support those interfaces, returns an error, or times out. Enhancement does not reuse your chat sessions, and its requests stop when Mysti shuts down.

When OpenClaw reports them, Mysti shows the actual backend model, its context window, and usage including cached tokens. Run totals appear in the usage footer; context fill uses the latest model call or OpenClaw's explicit prompt measurement. If that measurement is missing, context fill stays unavailable even when run totals are present. The backend model remains configured in OpenClaw.

For chat requests, gateway and local CLI diagnostics redact exported secrets and API keys, credential headers, and URL credentials from locally readable backend configuration. Locally stored JSON and SQLite profile keys and OAuth tokens are also captured read-only, including expired, retired and inherited profiles, because diagnostic privacy is separate from authentication eligibility. Each request retains its credential snapshot so rotation during a request does not expose the old value. Diagnostic redaction preserves ordinary reply text and does not execute native secret resolvers.

CLI stdout and stderr share the standard inactivity allowance: 30 minutes, or four hours in autonomous mode. A silent open output pipe now ends with a timeout error; completed native JSON and streamed partial text remain visible. Stderr progress extends the allowance without consuming the next stdout reply.

Nonzero CLI exits include the process exit code alongside redacted diagnostics. In OpenClaw 2026.6.34, a gateway restart can resume an interrupted request without another Mysti send. A disconnected or failed Mysti stream therefore does not establish that native execution has stopped.

If the gateway disconnects or reports missing stream events, Mysti preserves the partial reply and reports an incomplete response. A detected event gap cancels the affected run; a connection-wide gap cancels its active runs. Mysti can reconnect for the next request, but does not automatically replay interrupted work.

Stop targets the request's run ID, including during native gateway setup before acknowledgment. Repeated Stop calls share the same cancellation request, keeping other work in the session separate.

Gateway replies can arrive as text deltas or complete text snapshots. Mysti applies revisions to the live reply and saved history, keeps thinking separate, and retains tool activity when text changes. Later snapshots can restore missing text within the current message. If a delta and snapshot disagree about a stable message boundary, Mysti preserves the visible text and reports the reply as incomplete. Provisional replies are reconciled with the final answer. Background features receive finalized text while tool activity continues to stream. Revised or provisional text does not replay text-triggered actions. Gateway commentary and supported progress updates appear as temporary status text, separate from answers, thinking and tool cards. They do not enter saved replies or suppress the final answer. An already-running agent response is reported as incomplete, without retrying or cancelling the existing run. Aborted gateway tasks remain unsuccessful even when the RPC transport reports success.

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
| `mysti.openclawPath` | `"openclaw"` | Path to OpenClaw CLI executable |
| `mysti.openclawModel` | `""` | Default model |
| `mysti.openclawUseGateway` | `true` | Use WebSocket Gateway |
| `mysti.openclawGatewayUrl` | `"ws://127.0.0.1:18789"` | Gateway URL |

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
- **Transport choice**: Local CLI mode requires unrestricted authority and selects `build`; use the remote server transport for native approval and read-only requests
- **Thinking Support**: Built-in thinking block streaming
- **Session Resume**: Local CLI turns use the panel's captured `--session <id>`; remote turns use isolated server sessions with replayed Mysti context

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.opencodePath` | `"opencode"` | Path to OpenCode CLI executable |
| `mysti.opencodeModel` | `""` | Custom model (provider/model format) |

---

## Qwen Code

Qwen Code CLI with streamed text, reasoning and tool activity. The adapter parses Qwen's own event shapes.

### Installation

```bash
npm install -g @qwen-code/qwen-code@latest
```

### Authentication

```bash
qwen
# Then type /auth in the interactive session
```

The adapter recognizes `QWEN_API_KEY`, `DASHSCOPE_API_KEY`, and an `OPENAI_API_KEY` for Qwen's configured OpenAI-compatible route. An unrelated Anthropic credential does not authenticate Qwen.

### Supported Models

Use the model dropdown for the current bundled/discovered catalog and any provider-scoped custom IDs. Availability depends on the configured account or endpoint.

### Unique Features

- **Structured stream**: Parses newline-delimited JSON text, reasoning and tool events
- **Explicit unrestricted mode**: Ask, Plan and Read Only are rejected; allowed CLI turns use `--approval-mode yolo`
- **Auth Error UI**: Guided authentication when not configured
- **Session Resume**: Resume the current panel's captured session using `--resume <id>`; a bare global `--continue` is not used

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.qwenCodePath` | `"qwen"` | Path to Qwen Code CLI executable |
| `mysti.qwenCodeModel` | `""` | Custom model |

---

## Ollama

Connect to an Ollama HTTP server. The default endpoint is on the extension host's localhost; a configured remote endpoint sends prompts to that host.

### Installation

Download from [ollama.com](https://ollama.com), then pull a model:

```bash
ollama pull llama3
```

### Authentication

The default loopback setup does not use an API key. Check the deployment's access controls before exposing or selecting a remote endpoint.

### Supported Models

Use the model dropdown for the current bundled/discovered catalog and any provider-scoped custom IDs. Availability depends on the configured account or endpoint.

### Unique Features

- **Local inference**: A local server and installed model can answer without a cloud model service.
- **Explicit endpoint**: Prompts and selected context go to the configured server.
- **Tool proposals**: Proposed tool calls are displayed; this adapter does not execute them.

Other enabled providers, DeepMyst connections, model downloads and telemetry have separate network behavior. Local-model selection alone does not make the whole extension offline. See [Privacy and data](PRIVACY.md).

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.ollamaEndpoint` | `"http://localhost:11434"` | HTTP endpoint reached by the extension host |
| `mysti.ollamaModel` | `""` | Custom model |

---

## LocalAI

Self-hosted AI model provider for on-premise deployments.

### Installation

Follow the installation guide at [localai.io](https://localai.io).

### Authentication

For an endpoint that requires a key, configure `mysti.localaiApiKey` in **User** settings; the adapter sends it as a bearer credential. This is ordinary VS Code configuration, not SecretStorage, so do not put it in committed workspace settings. A server without authentication can leave it empty. A configured endpoint is not necessarily local; see [Privacy and data](PRIVACY.md).

### Supported Models

Use the model dropdown for the current bundled/discovered catalog and any provider-scoped custom IDs. Availability depends on the configured account or endpoint.

### Unique Features

- **Self-Hosted**: Run on your own infrastructure
- **Full Control**: Configure models, resources, and access as needed
- **Deployment choice**: Data goes to your configured endpoint; residency and compliance depend on your deployment and model configuration
- **No Subscription**: Free and open source

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.localaiEndpoint` | `"http://localhost:8080"` | HTTP endpoint reached by the extension host |
| `mysti.localaiModel` | `""` | Custom model |
| `mysti.localaiApiKey` | `""` | Optional endpoint bearer key; ordinary User configuration |

---

## Hermes

**Setup**

1. Select **Hermes** and use the setup card's installer for your OS. For an existing installation, set `mysti.hermesPath` only when its detected executable is wrong.
2. Use **Authenticate**, which opens `hermes setup`. Configure a model backend and its account/key, or use the offered Nous Portal flow. A saved configuration is only a readiness signal; the backend validates access when used.
3. Refresh detection. Leave `mysti.hermesModel` empty to use the native configured model, or select an available model explicitly.

**Try it:** in a disposable workspace, choose Plan/Read Only and send `Explain when retries make an API more reliable. Do not use tools.` A completed attributed answer establishes text access for that account/model. If startup fails, complete `hermes setup` in the extension host environment and refresh again.

**Limits:** Mysti uses the persistent ACP transport. Emitted permission requests are scoped to the process and turn; non-read requests are denied in read-only modes. Handling those requests does not establish that every native tool always requests permission. Reasoning is controlled by the native model/backend rather than a Mysti token-budget flag.

Source: [Hermes adapter](../src/providers/hermes/HermesProvider.ts).

## Kimi Code

**Setup**

1. Select **Kimi Code**, then use the OS-specific setup installer or configure an existing executable with `mysti.kimiCodePath`.
2. Open `kimi` using **Authenticate** and enter `/login` in its interactive session. Complete the Kimi Code/Moonshot account flow. Mysti's setup action does not run a `kimi login` subcommand.
3. Refresh detection. Leave `mysti.kimiCodeModel` empty for the native account model, or choose an available model. Explicit selections must be accepted by the ACP session before a prompt is sent.

**Try it:** Kimi currently requires **Edit Automatically + Full Access**. Only make that choice deliberately in a disposable workspace; otherwise choose another provider. Send `Explain what a unit test checks. Do not use tools.` Expect a completed Kimi answer rather than an authentication or model-selection error. This prompt does not restrict the authority granted to the process.

**Limits:** Ask, Auto with approval, Plan and Read Only are rejected before dispatch. Native saved permissions can bypass ACP callbacks, so the bridge for emitted requests is not sufficient to enforce these modes. Failed model selection does not fall back silently to another model.

Source: [Kimi adapter](../src/providers/kimi/KimiCodeProvider.ts).

## Continue

**Setup**

1. Select **Continue** and use its installer (`cn` is the executable). Set `mysti.continuePath` only for a nonstandard installation.
2. Open `cn` with **Authenticate** and complete its interactive setup. Configure a model/backend and credentials in the native Continue configuration. The default home is `~/.continue`; `CONTINUE_GLOBAL_DIR` can override it.
3. Refresh detection. Use the configured native model, or set a supported model/assistant identifier with `mysti.continueModel`.

**Try it:** choose Plan/Read Only and send `Explain the difference between a unit test and an integration test. Do not use tools.` Expect a completed answer from Continue. If setup remains incomplete, inspect the native `config.yaml` model configuration without posting its secrets to an issue.

**Limits:** Continue uses a headless final-text transport. Ask-tier requests also run with `--readonly`, so they cannot turn an approval card into a file write. Only explicitly unrestricted authority uses `--auto`. Token usage and reasoning controls depend on the native backend and are not inferred from displayed text.

Source: [Continue adapter](../src/providers/continue/ContinueProvider.ts).

## OpenRouter

**Setup**

1. Select **OpenRouter**. This HTTP adapter needs no CLI installation.
2. Provide `OPENROUTER_API_KEY` to the extension host environment, or set `mysti.openrouter.apiKey` in **User** settings. The setting is ordinary VS Code configuration, not SecretStorage; do not commit a key in workspace settings. See [credential handling](PRIVACY.md).
3. Select a model your account can use. `mysti.openrouterModel` is the provider-specific override; leave it empty to use the selected/default model. A saved key does not establish credit or model entitlement.

**Try it:** send `Give one example of a useful code-review question.` Expect streamed text followed by a completed answer. An authentication, credit or availability error needs to be resolved with the configured account/model.

**Limits:** This provider is chat-only and executes no tools. It is distinct from selecting the **Mysti coordinator**, which can use OpenRouter while applying its own tools and spend controls. Provider costs and free-model availability are evaluated by the service, not guaranteed by selecting a catalog entry.

Source: [OpenRouter adapter](../src/providers/openrouter/OpenRouterProvider.ts).

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

## MiniMax

**Setup**

Select MiniMax and choose **Authenticate / Configure API key**. The host opens a
password field and saves the key in VS Code SecretStorage. No CLI is installed.
A configured key is checked by the API on the first request; a rejected key
returns an authentication card. Keys are never sent to the chat webview.

**Try it:** choose an available MiniMax model and send `Explain one benefit of a small pull request.` Expect a completed MiniMax answer and any usage reported by the API. A configured key is not a successful authentication test until this request succeeds.

**Limits:** The adapter streams text, separate reasoning and reported token usage. It is a
completion backend: it does not execute tools or edit files. The coordinator can
assign it advisory work, while coding agents perform changes. Model selections
and explicit routed models are honored; unsupported effort controls stay hidden.

The bundled MiniMax catalog declares `MiniMax-M2.7` and `MiniMax-M2.7-highspeed`
with 204,800-token context windows. Check the model/account response when using them;
a bundled catalog is not a guarantee of current service availability.
The machine-scoped `mysti.minimaxBaseUrl` accepts only MiniMax's international or
China HTTPS API endpoint; redirects are refused. Stop, panel disposal and replaced
turns cancel their own HTTP request. Transport and setup are fixture-tested;
a paid MiniMax account was not available for an authenticated live smoke test.

Source: [MiniMax adapter](../src/providers/minimax/MiniMaxProvider.ts).
See [all settings](SETTINGS.md) for the current endpoint, model and timeout defaults.

## OpenCode in WSL, Docker or a remote server

Use **Mysti: Configure OpenCode Remote Server** from the Command Palette. Enter
`http://localhost:4096` for a locally forwarded server, or an HTTPS endpoint for
another machine. Enter the project directory **as the server sees it**, such as
`/home/me/project`, and its server password. **Mysti: Test OpenCode Server
Connection** checks health and connected model providers. No OpenCode CLI is
required on the editor's machine in this mode.

Run `opencode auth login` and `opencode serve` on the server. For Docker, publish
the server port to loopback on the host; for WSL use localhost forwarding. The
server must be reachable from the VS Code extension host (which can itself run
inside Remote SSH or a dev container). OpenCode uses HTTP Basic authentication:
set `OPENCODE_SERVER_PASSWORD` on the server; the default username is `opencode`.
Mysti keeps the password in endpoint-specific VS Code SecretStorage. A custom
username is available as `mysti.opencodeRemoteUsername`.

`mysti.opencodeEndpoint` and `mysti.opencodeRemoteDirectory` are machine-scoped.
Clearing the endpoint restores local CLI mode. Remote mode uses HTTP and SSE,
not WebSocket. See the [OpenCode server documentation](https://opencode.ai/docs/server/).

Each turn creates an isolated remote session, checks that the server accepted
its permission rules, and replays Mysti conversation context. Native tool
requests wait for Mysti approval; read-only and plan modes cannot approve writes.
Stop aborts the request and its owned server session, and late approval clicks
cannot resume it. The session is removed after the turn; Mysti keeps its local
conversation. Server models appear in discovery as `provider/model` identifiers.

This beta transport supports text context and streaming answers/reasoning. Local
file/image attachments, server question dialogs and the experimental permission
v2 protocol are not supported; those paths report an explicit error. It does not
import other server sessions or automatically discover network hosts. Verified
against OpenCode 1.18.29 for health and permission acknowledgement, and local HTTP
fixtures for streaming, approval, errors and cancellation. Authenticated model
completion across real WSL/Docker networks remains a release validation task.

The live free-tier probe returned an upstream HTTP 403 restricting external-client
use. A healthy OpenCode server and a discovered model do not guarantee model
entitlement; connect an upstream provider/account permitted for remote clients.

## Reference and maintenance

Settings names and defaults in this guide come from [the extension manifest](../package.json).
Provider transports and capabilities come from the [registered adapters](../src/providers/ProviderRegistry.ts),
not from the availability of a third-party CLI feature. Use [SETTINGS.md](SETTINGS.md)
for the complete current configuration reference and [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
when detection, authentication or a request fails.
