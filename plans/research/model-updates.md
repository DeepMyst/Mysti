# Research: Keeping Mysti Provider Model Lists Up To Date

Date: 2026-06-12. Branch: `feature/visual-testing` (uncommitted Canvas v2 changes reviewed as-is).
Repo: `/Users/bahaabunojaim/Documents/GitHub/Mysti`

---

## PART 1 — Current State Inventory

### 1.1 Where model lists live (single source: hardcoded per-provider arrays)

Every provider hardcodes a `models: ModelInfo[]` array inside its `readonly config: ProviderConfig` (type defined at `src/types.ts:190-207`: `ProviderConfig { name, displayName, models: ModelInfo[], defaultModel }`, `ModelInfo { id, name, description?, contextWindow? }`).

| Provider | File (models array start) | Hardcoded model IDs | defaultModel |
|---|---|---|---|
| Claude Code | `src/providers/claude/ClaudeCodeProvider.ts:60` | claude-opus-4-6, claude-sonnet-4-5-20250929, claude-opus-4-5-20251101, claude-haiku-4-5-20251001 (all `contextWindow: 200000`) | claude-sonnet-4-5-20250929 |
| Codex | `src/providers/codex/CodexProvider.ts:77` | gpt-5.4-codex, gpt-5.3-codex, gpt-5.2-codex, gpt-5.2, gpt-5.2-thinking, gpt-5.2-instant, gpt-5.1-codex-max, gpt-5.1-codex, o3, o4-mini | gpt-5.4-codex |
| Gemini | `src/providers/gemini/GeminiProvider.ts:51` | gemini-3-pro-preview, gemini-3-flash-preview, gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite | gemini-2.5-flash |
| Cline | `src/providers/cline/ClineProvider.ts:72` | anthropic/claude-sonnet-4-5-20250929, anthropic/claude-opus-4-6, deepseek/deepseek-chat, deepseek/deepseek-r1, kwaipilot/kat-coder-pro, minimax/minimax-m2.5, qwen/qwen3-coder, mistralai/codestral-2508, arcee-ai/trinity-large-preview | deepseek/deepseek-chat |
| Copilot | `src/providers/copilot/CopilotProvider.ts:55` | claude-sonnet-4.5, claude-opus-4.5, claude-sonnet-4, claude-haiku-4.5, gpt-5.4, gpt-5.2, gpt-5.1-codex-max, gpt-5.1-codex, gpt-5.1-codex-mini, gpt-5.1, gpt-5, gpt-5-mini, gpt-4.1, gemini-3-pro-preview | claude-sonnet-4.5 |
| Cursor | `src/providers/cursor/CursorProvider.ts:59` | auto, sonnet-4, sonnet-4-thinking, gpt-5.4, gpt-5, o3, gemini-2.5-pro | auto |
| OpenClaw | `src/providers/openclaw/OpenClawProvider.ts:55` | claude-opus-4-6, claude-sonnet-4-5, gpt-5 | claude-opus-4-6 |
| OpenCode | `src/providers/opencode/OpenCodeProvider.ts:53` | `default` (single placeholder) | default |
| Qwen Code | `src/providers/qwen/QwenCodeProvider.ts:55` | qwen3-coder, qwen3-coder-plus | qwen3-coder |
| Ollama | `src/providers/ollama/OllamaProvider.ts:57` | llama3.2, codellama, deepseek-coder-v2, qwen2.5-coder, mistral | llama3.2 |
| LocalAI | `src/providers/localai/LocalAIProvider.ts:57` | gpt-4, ggml-gpt4all-j, luna-ai-llama2 | gpt-4 |
| Manus | `src/providers/manus/ManusProvider.ts:56` | manus-1.6-max, manus-1.6, manus-1.6-lite | manus-1.6 |

**Proven staleness examples (June 2026):**
- Claude list is missing claude-opus-4-8 (current Opus), claude-opus-4-7, and claude-sonnet-4-6; opus-4.6+ now have 1M context windows but Mysti hardcodes 200000.
- The locally installed `copilot` CLI enumerates `--model` **choices** in `--help`: `claude-sonnet-4.5, claude-haiku-4.5, claude-opus-4.5, claude-sonnet-4, gpt-5.1-codex-max, gpt-5.1-codex, gpt-5.2, gpt-5.1, gpt-5, gpt-5.1-codex-mini, gpt-5-mini, gpt-4.1, gemini-3-pro-preview`. Mysti's Copilot dropdown offers **gpt-5.4, which the CLI rejects** (not in choices) — picking it produces a hard CLI error. The `mysti.copilotModel` setting description even suggests example `claude-opus-4.6`, also not a valid choice.
- Cursor's hardcoded list (sonnet-4, gpt-5.4, o3...) does not match what `cursor-agent models` reports for an account.

### 1.2 package.json `contributes.configuration` (lines ~280-460)

- `mysti.defaultModel` — plain **string** (no enum), default `"claude-sonnet-4-5-20250929"` (line ~386). VS Code enum dropdowns are NOT used for models anywhere, so there is no static-enum constraint to work around.
- Per-provider **custom model override** string settings, all with `pattern: "^$|^[a-zA-Z0-9][a-zA-Z0-9._\\-:/]*$"`, `maxLength: 128`: `mysti.claudeCodeModel`, `mysti.codexModel` (+ `mysti.codexProfile`), `mysti.geminiModel`, `mysti.clineModel`, `mysti.copilotModel`, `mysti.cursorModel`, `mysti.openclawModel`, `mysti.opencodeModel`, `mysti.qwenCodeModel`.
- `mysti.ollamaModel` / `mysti.localaiModel` — free-text strings (no pattern), defaults empty; plus endpoint settings `mysti.ollamaEndpoint` (http://localhost:11434) and `mysti.localaiEndpoint` (http://localhost:8080).
- No `manusModel` setting (Manus model comes from dropdown/`_getEffectiveModel` only).

### 1.3 src/constants.ts

**No model constants at all.** Only `MANUS_API_BASE_URL = "https://api.manus.im"`, poll interval, timeouts, etc. Model knowledge lives entirely in provider files + scattered string literals.

### 1.4 Provider buildCliArgs / settings handling

- `BaseCliProvider` carries `settings.model` per panel (`src/providers/base/BaseCliProvider.ts:75,588,703,730`).
- Each CLI provider implements `_getEffectiveModel(settings)`: **provider-specific custom setting wins** (validated via `validateModelName`), otherwise the dropdown `settings.model` is used **only if it appears in the hardcoded `config.models` list**:
  - `CodexProvider.ts:1003-1022` — custom `codexModel` → else dropdown only if in `validCodexModels`; else `undefined` (CLI default).
  - `GeminiProvider.ts:254-276` — custom `geminiModel` → else dropdown only if `isKnownGeminiModel`; else logs "Ignoring non-Gemini model" and uses CLI default.
  - `ClaudeCodeProvider.ts:376-389` / `CopilotProvider.ts:397-410` — custom → else `settings.model` passed through; pushed as `--model <id>` (Claude: lines 251, 290; Copilot: line 380).
  - `ClineProvider.ts` — **never passes a model flag**; comment at line ~317: "The model is configured globally via `cline auth` or `cline config`". Mysti's Cline dropdown is effectively cosmetic.
  - `OllamaProvider.ts:205` / `LocalAIProvider.ts:210` — `config.get('ollamaModel'/'localaiModel') || config.defaultModel` sent in the HTTP request body.
  - `ManusProvider.ts:206` — `_getEffectiveModel(settings) || defaultModel`, sent as `model` in `POST /v1/responses` body.
- **Hard validation/reset against the stale list** (this is what makes stale lists actively harmful, not just cosmetic):
  - `ChatViewProvider._getPanelModel()` (`src/providers/ChatViewProvider.ts:351-366`): if the panel/global model is not in `providerConfig.models`, it is **silently reset to `providerConfig.defaultModel`**.
  - Provider-switch handler (`ChatViewProvider.ts:3566-3590`): switching provider re-validates against `newProviderConfig.models` and force-switches to the provider default if absent.
- Custom-model write path: webview sends `updateSettings {customModel}` → `ChatViewProvider.ts:3604-3631` maps provider → setting key via `providerModelKeys` (lines 447-459: note **Manus missing**, and `ollamaModel`/`localaiModel` are reused as the "custom" keys) → `validateModelName()` → global config update.

### 1.5 Model name validation — `src/utils/validation.ts`

```
MODEL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._\-:/]*$/   (max 128 chars)
```
Allowed: letters, digits, `. _ - : /`. **Square brackets are rejected.** Claude Code's 1M-context model strings use a bracket suffix (e.g. `sonnet[1m]`, `claude-opus-4-6[1m]`) — so the custom-model escape hatch **cannot express the exact model requested in issue #32**. The same regex is duplicated in three more places: the `pattern` on every `mysti.*Model` setting in package.json, and inline JS in the webview (`webviewContent.ts:11526`). Any relaxation must touch all four (and consider shell-injection safety, since the comment notes `shell:true` spawning).

### 1.6 Webview model dropdown — `src/webview/webviewContent.ts`

- `<select id="model-select">` at line 192; initial state hardcodes `model: 'claude-sonnet-4-5-20250929'` (line 9313) and `contextUsage.contextWindow: 200000` (line 9330).
- `updateModelsForProvider(providerId)` (lines 12187-12215) rebuilds `<option>`s from `state.providers[].models` and appends a `__custom__` "Custom..." option; if the current model isn't in the list it resets to `provider.defaultModel` and posts `updateSettings`.
- `state.providers` arrives in the `initialState` message: `ChatViewProvider` line 518/528-553 sends `providers: this._providerManager.getProviders()` (ProviderManager.ts:88 returns the hardcoded `ProviderConfig`s). **There is no message type today for refreshing model lists after init** — but the plumbing (postMessage → rebuild dropdown) is exactly where a `modelsUpdated` message would slot in.
- Custom model UI: `modelSelect` change handler (lines 11509-11521), inline validation (11524-11540), and re-selection logic at 15233-15250.

### 1.7 SlashCommandManager — second, divergent hardcoded copy

`src/managers/SlashCommandManager.ts`:
- `/model` command → `_selectModel()` (lines 830+) builds a VS Code QuickPick from `providerConfig.models` (same stale source).
- `_getModelDisplayName()` (lines 792-806) hardcodes a `shortNames` map that has **already drifted from the provider file**: it contains `'claude-opus-4-5-20250918'` while `ClaudeCodeProvider` has `claude-opus-4-5-20251101` — two hand-maintained copies in the same repo disagree on a model ID.

### 1.8 Duplication count

`claude-sonnet-4-5-20250929` is hardcoded in **9 files / 14 occurrences**: package.json, ChatViewProvider.ts, ClaudeCodeProvider.ts, ClineProvider.ts, ConversationManager.ts, ProviderManager.ts, SlashCommandManager.ts, utils/validation.ts (doc comment), webviewContent.ts. Any model-list refactor should centralize the "default model" concept.

### 1.9 contextWindow metadata is load-bearing

`ProviderManager.getModelContextWindow(provider, model)` feeds:
- the compaction trigger (`ChatViewProvider.ts:953, 3111-3121` → `CompactionManager.shouldCompact/recordUsage`), and
- the context-usage meter (`contextWindowInfo` message, line 2776).
Stale `contextWindow` values (e.g. 200K hardcoded for Opus 4.6, which is actually 1M) cause **premature compaction** and wrong usage meters. Any dynamic model system should refresh contextWindow too, not just IDs. (Anthropic's `GET /v1/models/{id}` returns `max_input_tokens`/`max_tokens`; Ollama `/api/show` returns context length; OpenClaw's `models list --json` returns `contextWindow`.)

### 1.10 Motivating GitHub issues (both OPEN)

- **#39 "Not able to use custom models"** — user sets a custom model in settings (screenshot) but chat fails/ignores it; also explicitly asks "Could the model list for open ai also be updated?". Mechanisms in code that can produce this: (a) `_getPanelModel` resets unknown models to provider default; (b) Codex/Gemini `_getEffectiveModel` drops dropdown models not in the hardcoded list; (c) the Copilot phantom `gpt-5.4` entry is rejected by the CLI; (d) the bracket-rejecting regex blocks some valid IDs.
- **#32 "support opus 4.6 1m"** — wants the 1M-context Opus variant. Blocked twice today: `claude-opus-4-6` exists in the list only with `contextWindow: 200000`, and the `[1m]` suffix form can't pass `MODEL_NAME_PATTERN`. (Note: `claude --help` confirms `--model` accepts an alias like `'sonnet'`/`'opus'` or a full name; Claude Code's 1M variants use the bracket-suffix notation.)

---

## PART 2 — Per-Backend Model Discovery Mechanisms

Local CLI availability on this machine: claude, codex, gemini, copilot, cursor-agent, opencode, qwen, cline, openclaw, ollama all installed. All probed via `--help`/list subcommands only.

### Summary table

| Backend | Runtime discovery | Mechanism | Auth needed | Verified |
|---|---|---|---|---|
| Ollama | **YES — first-class** | `GET {endpoint}/api/tags` → `{models:[{name,...}]}`; `/api/show` for context length | none (local) | code already calls it (liveness only) |
| LocalAI | **YES — first-class** | `GET {endpoint}/v1/models` (OpenAI-compatible `{data:[{id}]}`) | optional API key (already a setting) | code already calls it (liveness only) |
| Cursor | **YES — first-class** | `cursor-agent models` (or `--list-models`) — plain text lines, account-scoped; ANSI codes present | logged-in account ("No models available for this account" otherwise) | locally |
| OpenClaw | **YES — first-class** | `openclaw models list --json` → `{count, models:[{key,name,input,contextWindow,local,available,tags:[default,configured,alias:opus,missing]}]}` | local config | locally |
| OpenCode | **YES — first-class** | `opencode models [provider]` → `provider/model` lines (reflects configured providers; backed by the models.dev registry) | local config | locally |
| Copilot | **YES — parseable** | `copilot --help` embeds the exact `--model` choices list `(choices: "claude-sonnet-4.5", ...)` — regex it out | CLI installed | locally |
| Codex | **PARTIAL** | `codex debug models [--bundled]` prints the raw model catalog Codex sees as JSON (documented in CLI reference). No supported public list command (upstream issue openai/codex#8871 closed "not planned"); `/model` TUI picker not scriptable; OpenAI `GET /v1/models` needs an API key (ChatGPT-plan users have none) | CLI installed (catalog is auth-aware) | docs only — local codex binary was SIGKILLed in this env (treat as best-effort + fallback) |
| Claude Code | **PARTIAL** | No models subcommand (verified: commands are agents/auth/mcp/plugin/doctor/...). `--model` accepts evergreen **aliases** (`sonnet`, `opus`, `haiku`) or full names. Anthropic `GET /v1/models` (+ `/v1/models/{id}` with `max_input_tokens` and capability tree) exists but requires an `x-api-key` or OAuth bearer + `anthropic-beta: oauth-2025-04-20` — subscription-auth Claude Code users have no API key Mysti can use politely | API key for the Models API | `--help` locally; Models API via docs |
| Gemini CLI | **NO** (CLI) | Subcommands are only mcp/extensions/skills/hooks; `/model` is an interactive TUI dialog. Generative Language API `ListModels` exists but needs an API key (OAuth/code-assist users excluded) | API key for API route | `--help` locally |
| Qwen Code | **NO** (CLI) | Gemini-CLI fork; no list command. qwen-oauth users get a fixed set (qwen3-coder-plus / qwen3-coder-flash + snapshots). User-configured models live in `~/.qwen/settings.json` (readable as a local heuristic). DashScope OpenAI-compatible `GET .../compatible-mode/v1/models` needs an API key | API key for API route | `--help` locally |
| Cline | **NO** (CLI) | `cline auth` is interactive; `--modelid` exists for BYO quick-setup but there is no list command (`cline config list` needs the Cline Core gRPC instance). The Cline VS Code extension fetches OpenRouter lists dynamically, but that surface isn't exposed via the CLI. Mysti doesn't even pass a model flag to cline today | n/a | `--help` locally |
| Manus | **NO** | API-based (`POST /v1/responses` with `model` field, polled). No documented `/v1/models`. NOTE: official docs now say base URL `api.manus.ai` and **API v1 is deprecated in favor of v2**; Mysti hardcodes `https://api.manus.im` + v1 — flag for separate follow-up | API key | docs |

### Per-backend notes

- **Ollama** (`OllamaProvider.ts:122-137, 152-163`): already fetches `/api/tags` twice (discoverCli + checkAuthentication) with 3s timeout but **discards the model list**. Minimal change: parse `json.models[].name` and surface it. `ollama list` CLI equivalent exists but HTTP is cleaner. Server wasn't running locally during this research; response shape is the well-known `{"models":[{"name":"llama3.2:latest","size":...,"details":{...}}]}`.
- **LocalAI** (`LocalAIProvider.ts:122, 157`): same situation — `/v1/models` already called for liveness; parse `data[].id` for the dropdown. API key header already supported.
- **Cursor**: `cursor-agent models` output is plain lines with ANSI escapes (`Loading models…` then list or "No models available for this account."). Also `--list-models` flag on the main command. Account-gated: a logged-out user gets an empty list → must fall back to curated list, and ideally surface "log in to see models".
- **OpenClaw**: `openclaw models list --json` is the gold standard among these CLIs — includes `contextWindow` and tags (`default`, `configured`, `alias:opus`, `missing`). Upstream is also tracking fully dynamic discovery (openclaw/openclaw#10687). Mysti's OpenClawProvider can shell out once and cache.
- **OpenCode**: `opencode models` prints `provider/model` per line (e.g. `opencode/big-pickle`); reflects the user's configured providers/credentials. The underlying registry is **models.dev** (open-source database; `https://models.dev/api.json`) — that JSON is itself a candidate curated-fallback feed for several backends (ids, context windows, modalities) independent of OpenCode.
- **Copilot**: parse the `(choices: ...)` block following `--model <model>` in `copilot --help` output. Brittle-ish but it is the CLI's own authoritative accept-list; cache + curated fallback. This single change fixes the proven gpt-5.4 phantom.
- **Codex**: `codex debug models` / `codex debug models --bundled` print the model catalog as JSON per the official CLI reference (developers.openai.com/codex/cli/reference). Since it's a `debug` subcommand it may change without notice — wrap in try/catch with curated fallback. (Worth noting: on this machine every codex invocation died with SIGKILL — exit 137 — even unsandboxed, so the implementation must tolerate the command failing entirely.)
- **Claude Code**: best practical strategy is **alias-first curated entries** (`opus`, `sonnet`, `haiku` — evergreen, the CLI resolves them to latest) plus dated full IDs as advanced options, plus the `[1m]` variants once the validation regex permits brackets. Optionally, if `ANTHROPIC_API_KEY` is present in the environment, hit `GET https://api.anthropic.com/v1/models` (headers `x-api-key`, `anthropic-version: 2023-06-01`) for the live list incl. `max_input_tokens` for the contextWindow metadata. Current real IDs (June 2026): claude-opus-4-8, claude-opus-4-7, claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5, claude-fable-5 (+ legacy claude-opus-4-5, claude-sonnet-4-5).
- **Gemini/Qwen/Cline**: curated fallback only, refreshed via Mysti releases (or a remote curated JSON — see Part 3). For Qwen, reading `~/.qwen/settings.json` model entries is a cheap local enhancement. For Cline, consider hiding/disabling the model dropdown since Mysti never sends a model to the CLI anyway (honesty fix for #39-class confusion).
- **Manus**: keep curated (manus-1.6 family). Separately flag the v1-deprecation/base-URL discrepancy.

---

## PART 3 — How other extensions handle dynamic model lists

### Cline (VS Code extension)
- For OpenRouter (and similar aggregator providers) it fetches the live list at runtime via `refreshOpenRouterModels`, caches the result as JSON in extension global storage, and reads the cache when offline; UI shows a searchable dropdown with favorites. "Fetches OpenRouter's latest model list, allowing use of the newest models as soon as they are available."
- Pattern: **runtime fetch → disk cache → bundled/static fallback**, dropdown rendered in its own webview (not VS Code settings enums).

### Roo Code
- Explicit two-tier architecture: 20+ providers with **static model lists hardcoded** for fixed providers and **dynamic lists fetched from provider APIs** for open-ended ones (OpenRouter, Requesty, Glama, Roo Cloud...). PR #8728 ("dynamic model loading") describes the canonical shape: `getModels()`-style fetcher integrated with a shared `modelCache` — **5-minute memory cache + file cache, 10-second fetch timeout, graceful fallback to static definitions when fetch fails**; dynamic results merged with static entries. PR #9410 added a disk-cache fallback to reduce repeated `getModel()` calls.

### Continue.dev
- Config-driven (`config.yaml`), but supports `model: AUTODETECT` for Ollama: it queries the local Ollama instance (`ollama list` ≅ `/api/tags`) and populates the model picker with everything installed. Capabilities are auto-detected per model with manual override.

### VS Code platform constraint (and why Mysti is well-positioned)
- `package.json` `enum`s on settings are frozen at install time — extensions cannot update them at runtime. Extensions that want live model dropdowns therefore render them in **webviews or QuickPicks** fed by runtime data. Mysti already does both (webview `model-select` + `/model` QuickPick) and its model settings are plain strings — so **no settings-schema change is needed**; the work is: fetch per provider → cache → push an update message → `updateModelsForProvider` re-render.

### Mechanism-per-backend recommendation (concrete)

| Backend | Mechanism | Fallback |
|---|---|---|
| Ollama | reuse existing `/api/tags` call, parse names (+ `/api/show` for ctx) | current curated 5 |
| LocalAI | reuse existing `/v1/models` call, parse `data[].id` | current curated 3 |
| Cursor | spawn `cursor-agent models`, strip ANSI, split lines | curated + `auto` |
| OpenClaw | spawn `openclaw models list --json`, map key/name/contextWindow/tags(default) | curated 3 |
| OpenCode | spawn `opencode models`, split `provider/model` lines | `default` placeholder |
| Copilot | spawn `copilot --help`, regex the `--model ... (choices: ...)` block | curated list |
| Codex | spawn `codex debug models` (JSON), try/catch | curated list |
| Claude Code | alias-based curated entries (`opus`/`sonnet`/`haiku`, `[1m]` variants); optional Anthropic `/v1/models` when an API key exists | curated list |
| Gemini | curated only (optional ListModels if API key) | curated list |
| Qwen | curated + optionally read `~/.qwen/settings.json` | curated list |
| Cline | none (CLI ignores model); consider hiding dropdown | curated list |
| Manus | curated only | curated 3 |

### Cross-cutting design notes a plan should include
1. **Stop hard-resetting unknown models.** `_getPanelModel` (ChatViewProvider.ts:359-363), the provider-switch reset (3570-3584), and Codex/Gemini `_getEffectiveModel` list-gating all silently discard models not in the (stale) list — the root of issue #39. Treat the list as *suggestions*, accept any `validateModelName`-passing ID, warn instead of reset.
2. **Fix the validation regex** in all four duplicated locations to admit `[`/`]` (needed for `opus[1m]`-style IDs, issue #32) while keeping shell-metacharacter exclusions; brackets are not shell-dangerous in the spawn contexts used, but verify `shell:true` paths.
3. **Refresh contextWindow with the IDs** — compaction thresholds and the usage meter consume it (`getModelContextWindow`).
4. **Caching shape (mirror Roo Code):** in-memory per session + `globalState` persisted cache with TTL (~24h for CLI-derived lists, ~5min for local servers like Ollama), 5-10s timeout per probe, never block message send on a refresh; refresh triggers: extension activate (lazy), provider switch, dropdown open, explicit "Refresh models" action.
5. **Delivery to UI:** new `WebviewMessage` (e.g. `modelsUpdated { provider, models, defaultModel }`) handled by `updateModelsForProvider`; same data feeds SlashCommandManager `_selectModel` (and delete its divergent `shortNames` map — derive display names from `ModelInfo.name`).
6. **Optional remote curated feed** for the no-discovery backends (Gemini, Qwen, Cline, Manus, Claude fallback): a JSON manifest fetched from the Mysti repo/CDN (or models.dev `api.json` for cross-provider metadata) lets lists update without a marketplace release; bundle a snapshot as the offline fallback.
7. **Centralize defaults:** `claude-sonnet-4-5-20250929` appears in 9 files; introduce a single constant/provider-default lookup so future model bumps are one-line.

### Key file/line index
- `src/types.ts:190-207` — ProviderConfig/ModelInfo
- `src/providers/*/​*Provider.ts` models arrays — lines listed in Part 1.1 table
- `src/providers/ChatViewProvider.ts:351-366` (_getPanelModel reset), `447-465` (providerModelKeys/customModel read), `518-553` (initialState providers payload), `953/2776/3111-3121` (contextWindow uses), `3566-3590` (provider-switch model reset), `3604-3631` (customModel write)
- `src/webview/webviewContent.ts:192` (select), `9313/9330` (hardcoded defaults), `11509-11540` (custom model UI + regex), `12187-12215` (updateModelsForProvider), `15233-15250`
- `src/managers/SlashCommandManager.ts:792-806` (drifted shortNames), `830+` (_selectModel)
- `src/utils/validation.ts:26-41` (MODEL_NAME_PATTERN — rejects brackets)
- `src/managers/ProviderManager.ts:88` (getProviders), getModelContextWindow
- GitHub: Mysti issues #39, #32 (both open); openai/codex#8871 (closed not-planned); RooCodeInc/Roo-Code#8728, #9410; openclaw/openclaw#10687

Sources: [Codex CLI reference](https://developers.openai.com/codex/cli/reference), [openai/codex#8871](https://github.com/openai/codex/issues/8871), [Cline OpenRouter docs](https://docs.cline.bot/provider-config/openrouter), [Roo-Code PR #8728](https://github.com/RooCodeInc/Roo-Code/pull/8728), [Roo-Code PR #9410](https://github.com/RooCodeInc/Roo-Code/pull/9410), [Roo Code OpenRouter docs](https://docs.roocode.com/providers/openrouter), [Continue Ollama autodetect](https://docs.continue.dev/customize/model-providers/top-level/ollama), [Gemini CLI /model](https://geminicli.com/docs/cli/model/), [Qwen Code model providers](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/), [Manus API docs](https://manus.im/docs/integrations/manus-api), [openclaw#10687](https://github.com/openclaw/openclaw/issues/10687).
