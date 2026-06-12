# Mysti: Best-in-Class Unified Multi-Agent Chat Experience

Research report — grounded in the working tree of `/Users/bahaabunojaim/Documents/GitHub/Mysti` (branch `feature/visual-testing`, uncommitted Canvas v2 changes included). Date: 2026-06-12.

---

## 1. Current capability model (extension side)

### 1.1 `ProviderCapabilities` (src/providers/base/IProvider.ts:54-65)

```ts
export interface ProviderCapabilities {
  supportsStreaming: boolean;
  supportsThinking: boolean;
  supportsToolUse: boolean;
  supportsSessions: boolean;
  supportsNativeCompact?: boolean;
  supportsPersistentProcess?: boolean;
  supportsImages?: boolean;
  supportsFileAttachments?: boolean;
  supportsVisualTesting?: boolean;   // DEAD: declared, never set or read by any provider
  supportsAutoInstall: boolean;
}
```

### 1.2 Declared capabilities per provider (verified in each provider file)

| Provider (file:line of decl) | streaming | thinking | toolUse | sessions | nativeCompact | persistentProc | images | fileAttach | autoInstall |
|---|---|---|---|---|---|---|---|---|---|
| claude-code (claude/ClaudeCodeProvider.ts:89) | Y | Y | Y | Y | **Y (only one)** | **Y (only one)** | Y | **Y (only one)** | Y |
| openai-codex (codex/CodexProvider.ts:142) | Y | Y | Y | Y | – | – | N | – | Y |
| google-gemini (gemini/GeminiProvider.ts:86) | Y | N | Y | Y | – | – | N | – | Y |
| cline (cline/ClineProvider.ts:132) | Y | Y | Y | Y | – | – | – | – | Y |
| github-copilot (copilot/CopilotProvider.ts:147) | Y | N | Y | Y | – | – | – | – | Y |
| cursor (cursor/CursorProvider.ts:106) | Y | N | Y | **N** | – | – | – | – | N |
| openclaw (openclaw/OpenClawProvider.ts:78) | Y | Y | Y | Y | – | – | – | – | N |
| opencode (opencode/OpenCodeProvider.ts:64) | Y | Y | Y | Y | – | – | N | – | Y |
| qwen-code (qwen/QwenCodeProvider.ts:72) | Y | Y | Y | Y | – | – | N | – | Y |
| ollama (ollama/OllamaProvider.ts:92) | Y | N | Y | **N** | – | – | **Y** | – | N |
| localai (localai/LocalAIProvider.ts:80) | Y | N | Y | **N** | – | – | N | – | N |
| manus (manus/ManusProvider.ts:79) — **DORMANT** | **N** | N | **N** | Y | – | – | – | – | N |

**Manus is dormant**: `ManusProvider` exists with full capabilities declaration, but `'manus'` is absent from the `ProviderType`/`AgentType` unions (src/types.ts:18,22) and it is never registered in `ProviderRegistry._registerBuiltInProviders()` (src/providers/ProviderRegistry.ts:45-101, which registers exactly 11 providers). It is the only non-streaming, non-tool-use backend — the future stress test for any unified rendering model.

### 1.3 Where capability flags are actually consumed (the whole list)

- `ChatViewProvider.ts:2694` — `supportsImages` → strip image attachments at send time + `attachmentWarning` toast
- `ChatViewProvider.ts:2703` — `supportsFileAttachments` → strip file attachments at send time + warning
- `ChatViewProvider.ts:3729` — `supportsPersistentProcess` → skip persistent-process warm-up
- `ChatViewProvider.ts:6695` — `supportsAutoInstall` → install modal auto-install button
- `CompactionManager.ts` — `supportsNativeCompact` → native `/compact` vs client-summarize strategy
- `VisualTestManager.ts:183` — `supportsImages` → screenshot attached as image vs text-only note

**That is the entire consumption surface.** Crucially, the webview (`src/webview/webviewContent.ts`, 18,669 lines) contains **zero references to `capabilities` or any `supports*` flag** (verified by grep — the only hit is marketing copy "code capabilities" on line 986). Every piece of per-provider UI divergence in the webview is keyed on provider-name string literals instead.

---

## 2. Stream/message contracts (src/types.ts)

- `StreamChunk` (types.ts:278-290): `type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'error' | 'auth_error' | 'done' | 'session_active' | 'ask_user_question' | 'exit_plan_mode' | 'compaction'` plus `toolCall`, `sessionId`, `usage`, `askUserQuestion`, `planFilePath`, `compactionEvent`, `authCommand`, `providerName`. This is already a good normalized vocabulary — the problem is uneven emission (Section 4) and name-keyed rendering (Section 3).
- `ToolCall` (types.ts:87-94): `{ id, name, input, output?, status: 'pending'|'running'|'completed'|'failed', fileChange? }` with `FileChangeInfo` diff lines — close to ACP's tool-call schema but **lacks a semantic `kind`** (read/edit/execute/search/fetch/think) so the UI must infer icons from raw tool names per CLI.
- `WebviewMessage` (types.ts:185-188) is untyped (`type: string; payload?: unknown`) — no compile-time guarantee the webview and extension agree.
- Three parallel chunk vocabularies exist: `StreamChunk`, `BrainstormStreamChunk` (types.ts:367-380), `MentionStreamChunk` (types.ts:421-440). Each re-invents text/thinking/tool/error events, and each has its own webview rendering path (main chat vs brainstorm bubbles vs subagent cards) with different thinking/tool treatments.

The extension→webview pipeline in `ChatViewProvider` (chunk switch at ChatViewProvider.ts:2855-3140: `thinking`, `tool_use` w/ permission gate, `tool_result`, `error`, `auth_error`, `session_active`, `ask_user_question`, `done`) is provider-agnostic. The permission gate (`_shouldGateToolUse`, ChatViewProvider.ts:4257; SIGSTOP suspend at 2877) applies uniformly to all CLI providers. Tool cards, permission cards, plan-option cards and ask-user-question cards in the webview (message dispatch at webviewContent.ts:12691-12731) are likewise provider-agnostic. **The divergence is concentrated in: thinking rendering, settings UI, branding/logos, and provider enumeration lists.**

---

## 3. Provider-name branching in UI logic (the seams)

Raw counts of provider-ID string literals: **56 lines in webviewContent.ts, 38 lines in ChatViewProvider.ts** (grep for the 11 provider IDs + 'manus'). Functional seams, deduplicated:

### 3.1 webviewContent.ts seams

| # | Location | What it does | Why it's a divergence |
|---|---|---|---|
| W1 | :11984 | `thinkingSection.style.display = (provider === 'google-gemini') ? 'none' : 'block'` | Thinking-level selector hidden **only for Gemini**, though copilot/cursor/ollama/localai also declare `supportsThinking: false`. Users of those 4 providers see a dead control. Should be `capabilities.supportsThinking`. |
| W2 | :15680 | Main-chat thinking renderer: `if (provider === 'openai-codex')` → separate blocks per thought; **else** → "Claude" accumulate-into-collapsible path (`claude-thinking` CSS class) | Cline/Qwen/OpenCode/OpenClaw thinking is forced through the Claude-shaped accumulator. Binary provider check standing in for a 3-value capability (`thinkingStyle: streamed-deltas \| complete-blocks \| none`). |
| W3 | :14774 | Brainstorm thinking renderer: `if (agentId !== 'claude-code')` → separate blocks; else accumulate | **Opposite heuristic from W2** for the same problem — main chat special-cases Codex, brainstorm special-cases Claude. Same provider renders thinking differently in main chat vs brainstorm. |
| W4 | :12219-12224 and :15257-15263 | `codexSettingsSection` shown iff `providerId === 'openai-codex'` (duplicated twice) | Provider-specific settings panel is hard-wired; no declarative mechanism for other providers' settings (e.g., Ollama endpoint, OpenClaw gateway live elsewhere). |
| W5 | :14478-14483 | `getProviderIconUri()` map contains only 6 of 11 providers (claude, codex, gemini, copilot, cursor, openclaw) | Install-modal icons are blank for cline, opencode, ollama, localai, qwen-code. Registry drift. |
| W6 | :9402-9412 (`AGENT_DISPLAY`), :12251-12261 (name map), :12270-12280 (logo map) | Three separate provider display registries in the same file | Triplicated metadata; adding a provider requires editing all three + W5. |
| W7 | :9417, :12299, :14714, :14932 | `'openai-codex'` special cases for theme-aware OpenAI logo (`getOpenAILogo()`, `.openai-logo` class) in agent menu, toolbar, brainstorm role cards, discussion bubbles | Branding concern leaking into 4 separate render paths instead of a `themeAware` flag on the registry entry. |
| W8 | :10531-10532 | Suggestion message lookup aliases `'claude-code'→'claude'`, `'openai-codex'→'codex'` | Two ID namespaces (full IDs vs short IDs) reconciled ad hoc at point of use. |
| W9 | :11893, :12322 | Two hard-coded 11-element provider arrays for settings-dropdown iteration | Adding a provider requires editing both; Manus would need a 12th edit. |
| W10 | :14703 | Brainstorm default `['claude-code', 'openai-codex']` hard-coded (also ChatViewProvider.ts:514) | Default-pair duplication. |

### 3.2 ChatViewProvider.ts seams

| # | Location | What it does | Why it's a divergence |
|---|---|---|---|
| C1 | :448-458 vs :3607-3618 | Two copies of `providerModelKeys` (provider→settings-key map). **The second copy omits `'qwen-code'`** | Drift bug: setting a custom model while on Qwen is silently dropped (`settingKey` undefined → no-op). Proof that name-keyed duplication rots. |
| C2 | :640, :869, :3671 | Three hard-coded `allAgentIds` arrays of all 11 providers | Should derive from `ProviderRegistry.getAll()`. |
| C3 | :926 | `shutdownAgent` lifecycle event posts `providerId: 'claude-code'` regardless of the panel's actual provider | UI would mislabel shutdown-blocked events for non-Claude panels. |
| C4 | :2820 | OpenClaw channel-delegate special case | Justified (gateway-only feature) but unflagged — should be a capability (`supportsChannels`). |
| C5 | :339, :345, :1012, :1828, :6130 | `'claude-code'` default-provider fallbacks (5 sites) | Should be one constant. |
| C6 | :6724-6762 | Debug setup flows hard-code claude-code | Acceptable (debug-only). |
| C7 | SlashCommandManager.ts:81 | Legacy `/compact` always maps to `'claude:compact'` | On non-Claude providers the command id targets Claude's native compact rather than the client-summarize path. |

### 3.3 Display-registry duplication across the codebase (single-source-of-truth gap)

The provider identity (name/color/icon/shortId) is independently maintained in **at least 6 places**: webview `AGENT_DISPLAY` (W6 ×3), `getProviderIconUri` (W5), `BrainstormManager.AGENT_STYLES` (src/managers/BrainstormManager.ts:35), `MentionRouter.AGENT_DISPLAY_NAMES` (src/managers/MentionRouter.ts:35), plus per-provider `config.displayName`. The capability matrix is maintained in 1 place (good) but never shipped to the UI (bad).

---

## 4. User-facing feature matrix (what users of each provider actually get)

Verified against parse code, not just declared flags:

| Feature | claude | codex | gemini | cline | copilot | cursor | openclaw | opencode | qwen | ollama | localai |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Thinking display (emits `thinking` chunks) | ✅ streamed deltas | ✅ complete blocks ("reasoning" events) | ❌ | ✅ complete (say:"reasoning", ClineProvider.ts:458-464) | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Thinking rendered correctly in UI | ✅ collapsible | ✅ blocks | n/a (selector hidden) | ⚠️ forced into Claude accumulator (W2) | ⚠️ dead selector shown (W1) | ⚠️ dead selector | ⚠️ Claude path | ⚠️ Claude path | ⚠️ Claude path | ⚠️ dead selector | ⚠️ dead selector |
| Thinking-level setting has effect | ✅ token map (ClaudeCodeProvider.ts:333) | ❌ returns undefined (CodexProvider.ts:473) | ❌ (GeminiProvider.ts:215) | ? | ? | ? | ? | ? | ? | ? | ? |
| Tool cards | ✅ all providers — provider-agnostic `handleToolUse` (webviewContent.ts:15823) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Permission cards (stream gate) | ✅ uniform for all CLI providers (ChatViewProvider.ts:2863-2917, SIGSTOP) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Sessions / resume | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Native compaction | ✅ only | ❌ → client-summarize | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Usage stats emission (feeds context pie + compaction) | ✅ message_delta | ✅ done chunk | ✅ captured | ✅ done | ✅ done | ✅ done | ✅ done | ✅ step-finish | ✅ message_delta | ✅ done | ✅ final chunk |
| Model `contextWindow` declared (else compaction assumes 200k, ProviderManager.ts:165-175) | partial | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ 1 ref | ⚠️ 2 refs | ✅ | ✅ |
| Image attachments | ✅ | stripped+warn | stripped | stripped | stripped | stripped | stripped | stripped | stripped | ✅ | stripped |
| File attachments | ✅ only (others undefined → stripped at send, ChatViewProvider.ts:2703) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Native plan mode (`exit_plan_mode` chunk) | ✅ only (sole emitter, grep-verified) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| AI-detected plan options (`PlanOptionManager`, ChatViewProvider.ts:4421) | ✅ all providers | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Provider slash commands (`getSlashCommands` override) | ✅ | ✅ (profile) | base | ✅ (plan/act toggle) | base | base | base | base | base | base | base |
| @-mention target | ✅ all 11 (MentionRouter) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Brainstorm participant | ✅ all 11 (`AGENT_STYLES` keyed by `AgentType`) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Provider settings panel in UI | – | ✅ hard-coded section (W4) | – | – | – | – | gateway URL setting | – | – | endpoint setting | endpoint setting |

Key reading: **the backbone (tool cards, permission gate, plan detection, mentions, brainstorm, usage capture) is already uniform.** The divergences users actually feel are (a) thinking UX inconsistent across 5 emitting providers and dead controls on 5 non-emitting ones, (b) attachments accepted in the composer then stripped at send, (c) per-provider settings/branding handled by hard-coded special cases, (d) capability info invisible to users (no way to know cursor/ollama/localai are stateless or that only Claude has native plan mode).

---

## 5. How leading tools normalize multi-backend chat UX (external research)

1. **Zed / Agent Client Protocol (ACP)** — the strongest model for Mysti. ACP normalizes any agent backend into one UI contract: tool calls carry a semantic `kind` enum (`read, edit, delete, move, search, execute, think, fetch, other`) so the client picks icons/layout without knowing the agent; a 4-state status lifecycle (`pending, in_progress, completed, failed`); typed content (text/image blocks, **diffs with absolute paths**, **embedded terminals**); `locations` for follow-along file tracking; and a uniform `session/request_permission` with option kinds (`allow_once, allow_always, reject_once, reject_always`). Presentation is fully decoupled from execution. Sources: https://zed.dev/acp, https://agentclientprotocol.com/protocol/tool-calls, https://zed.dev/docs/ai/external-agents.
2. **Continue.dev** — per-model capability flags (`tool_use`, `image_input`) with **autodetection + explicit user override** in `config.yaml`; UI features (Agent mode, image upload) gate on capabilities, never on provider names. Lesson: capabilities should be data (overridable), not code. Source: https://docs.continue.dev/customize/deep-dives/model-capabilities.
3. **Cline Plan/Act** — a single global mode toggle that constrains the agent (plan = read-only exploration; act = write access) regardless of backend model; the agent cannot self-promote to act mode; per-mode model selection. Lesson: operation modes are a *client* invariant enforced uniformly, exactly like Mysti's stream-level permission gate — Mysti's `OperationMode` already mirrors this and should stay backend-independent. Sources: https://docs.cline.bot/core-workflows/plan-and-act, https://cline.bot/blog/plan-smarter-code-faster-clines-plan-act-is-the-paradigm-for-agentic-coding.
4. **OpenRouter** — every model exposes `supported_parameters`; clients filter/feature-gate on it; unsupported parameters are **silently ignored** (graceful degradation) with an opt-in `require_parameters` strict mode. Lesson: degrade by default, fail loudly only on user request. Source: https://openrouter.ai/docs/api/reference/parameters.

---

## 6. Target: the unified experience definition

### 6.1 Principle

**Render from capabilities, never from provider names.** A provider name may select a logo and accent color from one registry; everything else — controls shown, chunk rendering, degradation messaging — derives from a capability profile shipped to the webview.

### 6.2 Capability-driven rendering model

1. **Extend `ProviderCapabilities`** (IProvider.ts:54) with UI-relevant fields:
   - `thinkingStyle: 'streamed' | 'complete-blocks' | 'none'` (kills W1/W2/W3 with one field; claude=streamed; codex/cline/qwen/opencode/openclaw=complete-blocks)
   - `thinkingLevelEffective: boolean` (only Claude maps levels to tokens today)
   - `planMode: 'native' | 'detected' | 'none'`
   - `supportsChannels?: boolean` (OpenClaw), and remove the dead `supportsVisualTesting` or wire it.
2. **Ship a Provider Manifest to the webview** on init and on provider switch: `{ id, displayName, shortId, color, logo, themeAwareLogo, capabilities, models[], settingsSections[] }`, generated from `ProviderRegistry` — replacing W5/W6/W9, BrainstormManager.AGENT_STYLES, MentionRouter.AGENT_DISPLAY_NAMES as render sources (those become consumers of the same manifest module).
3. **Declarative provider settings sections** (`settingsSections: [{ id: 'codexProfile', label, type: 'text', settingKey }]`) replacing the hard-coded `codex-settings-section` (W4) and giving Ollama/LocalAI endpoints and OpenClaw gateway the same treatment.
4. **Add `kind` to `ToolCall`** (ACP-style: read/edit/delete/move/search/execute/think/fetch/other), populated by each provider's `parseStreamLine` (each already knows its own tool names) so the webview renders one icon/card system instead of inferring per-CLI tool names.
5. **Composer gating at input time**: disable image/file attach buttons (with tooltip "Codex doesn't support images — switch to Claude or Ollama") from `capabilities` instead of stripping at send (ChatViewProvider.ts:2687-2718 stays as a safety net).

### 6.3 Consistent message anatomy (same skeleton in main chat, brainstorm bubbles, subagent cards)

```
┌ Header ──────────────────────────────────────────────┐
│ [agent avatar+color] [name] [model chip] [role badge │
│  in brainstorm] [timestamp]                          │
├ Thinking zone (only if thinkingStyle ≠ 'none') ──────┤
│ One collapsible reveal, identical behavior for       │
│ streamed and complete-block styles (blocks appended  │
│ inside the same collapsible).                        │
├ Body ────────────────────────────────────────────────┤
│ Markdown (Marked/Prism/Mermaid) — already uniform    │
├ Tool zone ───────────────────────────────────────────┤
│ Kind-iconed cards, 4-state status, inline diff for   │
│ fileChange, permission card inline (already uniform) │
├ Footer ──────────────────────────────────────────────┤
│ tokens in/out · context % (pie) · duration ·         │
│ session pill ("resumable" / "stateless") ·           │
│ degradation pills when applicable                    │
└──────────────────────────────────────────────────────┘
```

### 6.4 Graceful degradation rules (per missing capability)

| Missing capability | Rule |
|---|---|
| `thinkingStyle: 'none'` | Hide thinking selector (today only Gemini hides, W1) and never render a thinking zone. One-time hint if user had a non-none level set. |
| `supportsSessions: false` | "Stateless" pill in footer; resume affordances hidden; tooltip explains history is replayed client-side (last `MAX_CONVERSATION_MESSAGES` = 10). |
| `supportsNativeCompact: false` | Client-summarize silently (already works); compaction event card identical either way. |
| `supportsImages/FileAttachments: false` | Disable attach affordances at composer; never accept-then-strip. |
| `supportsToolUse: false` (Manus) | Hide tool zone and permission UI; show "responses-only agent" pill. |
| `supportsStreaming: false` (Manus) | Determinate/indeterminate progress card with poll status instead of token stream. |
| `planMode: 'detected'` | Plan-option cards from `PlanOptionManager` (already universal); `'native'` adds the exit-plan flow; quick-plan/detailed-plan modes remain prompt-driven for all. |
| No `contextWindow` on model | Show "~" estimate marker on the context pie instead of asserting a 200k-based percentage (ProviderManager.ts:173-174 default). |
| `thinkingLevelEffective: false` | Show selector as "advisory" (prompt-injected) or hide; never a silent no-op. |

OpenRouter rule of thumb adopted: degrade silently where harmless, surface a pill/tooltip where the user could be confused, never hard-fail unless data would be lost (attachments).

### 6.5 Concrete normalization gap list (actionable, with file refs)

1. **Webview receives no capability data** — add `providerManifest` postMessage; consume in settings panel, composer, message renderer. (webviewContent.ts: all of Section 3.1; ChatViewProvider.ts settings senders ~:540-560, :15200s webview restore path.)
2. **Thinking rendering split-brain** — replace `provider === 'openai-codex'` (webviewContent.ts:15680) and `agentId !== 'claude-code'` (webviewContent.ts:14774) with `thinkingStyle`; unify on one collapsible component.
3. **Thinking selector visibility wrong for 4 providers** — webviewContent.ts:11984 keys on `'google-gemini'` only; should key on `supportsThinking` (copilot/cursor/ollama/localai also false).
4. **`providerModelKeys` drift bug** — ChatViewProvider.ts:3607-3618 missing `'qwen-code'` (present in the :448-458 copy): custom model for Qwen silently dropped. Extract one map (or derive from manifest).
5. **`getProviderIconUri` covers 6/11 providers** — webviewContent.ts:14478-14483; install modal shows blank icons for cline/opencode/ollama/localai/qwen.
6. **Triplicated display registries in webview** — webviewContent.ts:9402, :12251, :12270 (+ BrainstormManager.ts:35, MentionRouter.ts:35) → one manifest.
7. **Hard-coded provider arrays** — webviewContent.ts:11893, :12322; ChatViewProvider.ts:640, :869, :3671 → derive from registry.
8. **Wrong providerId on shutdown event** — ChatViewProvider.ts:926 always posts `'claude-code'`.
9. **Codex-only settings section** — webviewContent.ts:199, :12219, :15257 → declarative settingsSections.
10. **OpenAI theme-logo special cases ×4** — webviewContent.ts:9417, :12299, :14714, :14932 → `themeAware` flag on manifest entry.
11. **Short-ID alias reconciliation at point of use** — webviewContent.ts:10531-10532 → normalize suggestion data to full IDs.
12. **`/compact` legacy mapping is Claude-only** — SlashCommandManager.ts:81 maps to `claude:compact` for every provider → route to a provider-neutral `cmd:compact` that picks strategy by `supportsNativeCompact`.
13. **Dead flag** — `supportsVisualTesting` (IProvider.ts:63) never set/read → set per provider and gate the visual-testing slash command/dashboard, or delete.
14. **`ToolCall` lacks semantic kind** — types.ts:87 → add ACP-style `kind` for uniform icons (the gate already classifies via `_classifyToolAction`, ChatViewProvider.ts:2872 — reuse that taxonomy at parse time).
15. **Attachment accept-then-strip UX** — ChatViewProvider.ts:2687-2718 warns after composition; gate the composer instead.
16. **Untyped `WebviewMessage`** — types.ts:185-188 `{ type: string; payload?: unknown }` → discriminated union to keep extension/webview contracts honest as the manifest lands.
17. **Manus dormancy** — ManusProvider unregistered and absent from `ProviderType`; when revived, it is the forcing function for non-streaming/non-tool degradation rules (Section 6.4).

### 6.6 Definition of "done" for a best-in-class unified experience

- Grep for provider-ID literals in webviewContent.ts UI logic returns only the single manifest definition (or zero if manifest is injected).
- Adding provider #13 requires: provider class + registry entry + manifest metadata — **zero webview edits, zero ChatViewProvider edits**.
- Every message from every provider renders the same anatomy; differences are visible only as absent zones + explanatory pills.
- A user can answer "what can this agent do?" from the UI (capability pills in the agent picker), like OpenRouter's `supported_parameters` surface.

Sources: [Zed ACP](https://zed.dev/acp), [ACP tool calls spec](https://agentclientprotocol.com/protocol/tool-calls), [Zed external agents](https://zed.dev/docs/ai/external-agents), [Continue.dev model capabilities](https://docs.continue.dev/customize/deep-dives/model-capabilities), [Cline Plan & Act](https://docs.cline.bot/core-workflows/plan-and-act), [Cline Plan/Act paradigm post](https://cline.bot/blog/plan-smarter-code-faster-clines-plan-act-is-the-paradigm-for-agentic-coding), [OpenRouter API parameters](https://openrouter.ai/docs/api/reference/parameters).
