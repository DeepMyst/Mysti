# Automatic Model List Updates (Dynamic Model Registry)

**Date:** undefined
**Status:** DRAFT
**Motivating issues:** #39 (custom models broken), #32 (new models missing — Opus 4.6 1M)
**Research inputs:** `/tmp/mysti-planning/research/model-updates.md`, `/tmp/mysti-planning/research/mysti-providers.md`

## Goal

Replace Mysti's hardcoded, perpetually stale per-provider model arrays with a `ModelRegistryService` that merges three sources per provider — live discovery (CLI/HTTP where the backend supports it), a curated fallback list (bundled + remotely refreshable), and user-defined custom models — and feed that registry into every consumer (webview dropdown, `/model` QuickPick, `_getEffectiveModel`, compaction context windows). Users must be able to (a) use any model their CLI accepts even if Mysti has never heard of it (fixes #39), (b) see newly released models without a marketplace release (fixes #32), and (c) never have their model choice silently reset to a default.

Non-goals: changing which CLI flag each provider uses to pass the model (that stays per-provider), fixing the providers whose model selection is a no-op end-to-end (Cline/OpenClaw — see Dependencies), registering Manus.

## Current State (grounded in code, with file:line refs)

### Single source: hardcoded TS arrays, duplicated and drifted

- Every provider hardcodes `models: ModelInfo[]` inside its `readonly config: ProviderConfig` (`src/types.ts:190-207` — `ProviderConfig { name, displayName, models, defaultModel }`, `ModelInfo { id, name, description?, contextWindow? }`). Array locations: `ClaudeCodeProvider.ts:60`, `CodexProvider.ts:77`, `GeminiProvider.ts:51`, `ClineProvider.ts:72`, `CopilotProvider.ts:55`, `CursorProvider.ts:59`, `OpenClawProvider.ts:55`, `OpenCodeProvider.ts:53`, `QwenCodeProvider.ts:55`, `OllamaProvider.ts:57`, `LocalAIProvider.ts:57`, `ManusProvider.ts:56` (unregistered).
- `src/managers/SlashCommandManager.ts:792-806` keeps a second hand-maintained `shortNames` display map that has **already drifted** from the provider file (contains `claude-opus-4-5-20250918`; the provider has `claude-opus-4-5-20251101`). `_selectModel` (`SlashCommandManager.ts:830+`) builds the `/model` QuickPick from the same stale `providerConfig.models`.
- `claude-sonnet-4-5-20250929` is hardcoded in 9 files / 14 occurrences (package.json, `ChatViewProvider.ts:354`, `ProviderManager.ts:158`, ClaudeCodeProvider, ClineProvider, ConversationManager, SlashCommandManager, validation.ts doc comment, `webviewContent.ts:9313`).
- The webview also hardcodes the initial model (`webviewContent.ts:9313`) and a 200000 context window (`webviewContent.ts:9330`).
- Proven staleness (June 2026): the Claude list is missing opus-4-8/4-7/sonnet-4-6; Opus 4.6+ has a 1M window but Mysti hardcodes 200000; the Copilot dropdown offers `gpt-5.4` which the installed `copilot` CLI **rejects** (not in its `--model` choices).

### Stale lists are actively destructive, not just cosmetic (root cause of #39)

- `ChatViewProvider._getPanelModel()` (`src/providers/ChatViewProvider.ts:351-366`): any model not in `providerConfig.models` is **silently reset** to `providerConfig.defaultModel`.
- Provider-switch handler (`ChatViewProvider.ts:3566-3599`): re-validates against the new provider's hardcoded list and force-switches to the default if absent, persisting the reset (`config.update('defaultModel', ...)` at `:3582`).
- `CodexProvider._getEffectiveModel` (`CodexProvider.ts:1003-1022`) and `GeminiProvider._getEffectiveModel` (`GeminiProvider.ts:254-276`) drop dropdown models not in the hardcoded list (Gemini logs "Ignoring non-Gemini model" and uses the CLI default).
- `MODEL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._\-:/]*$/` (`src/utils/validation.ts:26-27`) **rejects square brackets**, so Claude Code's 1M-context form (`claude-opus-4-6[1m]`, `sonnet[1m]`) cannot be entered even as a custom model — the second blocker for #32. The same regex is duplicated as `pattern` on every `mysti.*Model` setting in `package.json` (~lines 280-460) and inline in the webview (`webviewContent.ts:11524-11540`).
- Custom-model write path: webview → `updateSettings {customModel}` → `ChatViewProvider.ts:3602-3636` maps provider → setting key via `providerModelKeys` (also at `:447-459`; Manus missing from both copies) → `validateModelName()` → global config update. But even a saved custom model only takes effect via each provider's `_getEffectiveModel`; the dropdown value (`settings.model`) is still hard-reset per the above.

### No package.json enums (good news)

`mysti.defaultModel` is a plain string setting with no `enum` (`package.json` ~line 386), and all per-provider `mysti.<provider>Model` settings are free-text strings. **There is no frozen settings-schema to migrate away from** — the "static list" lives in the TS arrays surfaced through the webview `initialState` (`ChatViewProvider._sendInitialState`, `ChatViewProvider.ts:404+`, providers payload ~`:518-553` via `ProviderManager.getProviders()` at `ProviderManager.ts:88-90`). The work is to make that payload dynamic and add a refresh channel.

### Webview/QuickPick rendering

- `<select id="model-select">` at `webviewContent.ts:192`; `updateModelsForProvider(providerId)` (`webviewContent.ts:12187-12215`) rebuilds options from `state.providers[].models` plus a `__custom__` "Custom..." entry, and **resets to `provider.defaultModel`** if the current model isn't listed (a third copy of the reset behavior). Custom-model entry UI at `:11509-11540`, re-selection at `:15233-15250`.
- There is **no message type today for refreshing model lists after init** — `updateModelsForProvider` is exactly where a `modelsUpdated` message would slot in.

### contextWindow metadata is load-bearing

`ProviderManager.getModelContextWindow()` (`ProviderManager.ts:165-175`, default 200000) feeds the compaction trigger (`ChatViewProvider.ts:953, 3111-3121` → CompactionManager) and the context-usage meter (`contextWindowInfo`, `ChatViewProvider.ts:2776`). Stale windows (200K hardcoded for a 1M model) cause premature compaction and wrong meters.

### Discovery mechanisms exist for 7-8 of 12 backends (verified in research)

| Backend | Live discovery | Notes |
|---|---|---|
| Ollama | `GET {endpoint}/api/tags` (+ `/api/show` for ctx) | already called for liveness at `OllamaProvider.ts:122-137,152-163` — list discarded |
| LocalAI | `GET {endpoint}/v1/models` | already called at `LocalAIProvider.ts:122,157` — list discarded |
| Cursor | `cursor-agent models` (ANSI-laced text lines; account-gated) | verified locally |
| OpenClaw | `openclaw models list --json` → `{models:[{key,name,contextWindow,tags}]}` | richest source; verified locally |
| OpenCode | `opencode models` → `provider/model` lines | verified locally |
| Copilot | parse `(choices: ...)` block in `copilot --help` | the CLI's own accept-list; fixes the phantom `gpt-5.4` |
| Codex | `codex debug models [--bundled]` (JSON; `debug` subcommand, may break) | best-effort + fallback (binary SIGKILLed in research env) |
| Claude Code | no list subcommand; evergreen aliases (`opus`/`sonnet`/`haiku`) + optional Anthropic `GET /v1/models` if an API key exists | aliases are the robust path |
| Gemini, Qwen, Cline, Manus | none usable without API keys | curated fallback (Qwen: optionally read `~/.qwen/settings.json`) |

### Dropdown semantics are inconsistent (from provider review F18)

Three divergent behaviors: pass-raw (Claude/Copilot/Cursor/Qwen), pass-if-member (Codex/Gemini/OpenCode), and ignore entirely (Cline `ClineProvider.ts:315-318`, OpenClaw, Ollama `OllamaProvider.ts:205`, LocalAI `LocalAIProvider.ts:210` — Ollama/LocalAI read only their custom settings). Users get no feedback when their pick is ignored.

## Proposed Design

### 1. `ModelRegistryService` (new: `src/services/ModelRegistryService.ts`)

Single authority for "what models does provider X have, and what are their context windows". Constructed in `extension.ts` after `ProviderManager`, injected into `ProviderManager`, `ChatViewProvider`, and `SlashCommandManager` callbacks.

```ts
interface ModelEntry extends ModelInfo {          // extends existing ModelInfo (types.ts:202-207)
  source: 'live' | 'curated' | 'custom';
  deprecated?: boolean;                            // curated feed can mark sunset models
}
interface ProviderModelState {
  models: ModelEntry[];
  defaultModel: string;
  fetchedAt: number;                               // 0 = bundled curated only
  discoveryStatus: 'live' | 'cached' | 'fallback' | 'unsupported';
}
class ModelRegistryService {
  getModels(providerId: string): ProviderModelState;        // sync, always answers (merged view)
  getContextWindow(providerId: string, modelId: string): number | undefined;
  getDefaultModel(providerId: string): string;
  refresh(providerId: string, opts?: { force?: boolean }): Promise<void>;  // never throws to caller
  refreshAll(opts?: { force?: boolean }): Promise<void>;     // staggered, fire-and-forget
  addCustomModel(providerId: string, modelId: string): void; // validates, persists, fires event
  removeCustomModel(providerId: string, modelId: string): void;
  readonly onDidUpdateModels: vscode.Event<{ providerId: string }>;
  dispose(): void;
}
```

Merge order for `getModels`: live (if fresh or cached) → else curated (remote-feed snapshot if newer than bundled) ; then **always append** custom models (deduped) and, if the currently-selected model is absent from all sources, append it as a synthetic `custom` entry so the dropdown never shows a value it doesn't contain.

### 2. Per-provider discovery adapters — as an optional provider method

Add to `ICliProvider` (`src/providers/base/IProvider.ts:290+`) an optional method rather than a parallel adapter class hierarchy, so adapters reuse the existing `getCliPath()` discovery, enriched env, and endpoint settings:

```ts
discoverModels?(timeoutMs: number): Promise<ModelInfo[] | null>;  // null = discovery unavailable/failed
```

`BaseCliProvider` provides no default (absence = curated-only). Implementations per the table above (Ollama, LocalAI, Cursor, OpenClaw, OpenCode, Copilot, Codex, Claude-optional). The registry calls `provider.discoverModels?.(MODEL_DISCOVERY_TIMEOUT_MS)` inside `refresh()`, wraps in try/catch, and treats `null`/throw/timeout identically: keep previous cache, fall back to curated.

The static `config.models` arrays **stay in the provider files as the bundled curated fallback** (renamed conceptually, optionally trimmed/corrected — e.g. delete Copilot's phantom `gpt-5.4`, add Claude alias entries `opus`/`sonnet`/`haiku` and `[1m]` variants).

### 3. Caching, TTL, offline behavior (mirrors Roo Code's pattern)

- **Memory cache** in the registry + **persisted cache** in `context.globalState` under one key `mysti.modelRegistry.v1`: `{ [providerId]: { models, fetchedAt } }` (small — IDs and metadata only).
- **TTLs** (new constants in `src/constants.ts`): `MODEL_CACHE_TTL_CLI_MS = 24h` (CLI-derived lists), `MODEL_CACHE_TTL_LOCAL_MS = 5min` (Ollama/LocalAI local servers whose installed set changes often), `MODEL_CURATED_FEED_TTL_MS = 24h`, `MODEL_DISCOVERY_TIMEOUT_MS = 5000`.
- **Stale-while-revalidate**: `getModels()` always answers synchronously from memory/globalState/bundled-curated; if the entry is past TTL it schedules a background `refresh()` and fires `onDidUpdateModels` when done. No code path ever awaits discovery on the message-send path.
- **Offline**: failed probes keep the cached list indefinitely (no expiry-to-empty); with no cache ever, the bundled curated list serves. Failures log with `[Mysti]` prefix only; the sole user-visible error surface is the explicit "Refresh models" action, which reports `discoveryStatus`.

### 4. Stop destroying user choices (the actual #39 fix)

The registry list is **advisory, never authoritative**. Concretely:

**Canonical model-resolution precedence chain (shared contract with Plan 02 — read before editing `_getPanelModel` or the provider-switch handler).** Both this plan (Phase 2) and `02-unified-chat-experience.md` (Phase 6, issue #33) modify the *same two code paths*: `_getPanelModel` (`ChatViewProvider.ts:351-366`) and the provider-switch handler (`:3566-3599`). To prevent whichever plan lands second from silently reverting the first's semantics, the resolution order is defined once, here, and both plans implement slices of it:

1. **Panel override** — per-panel `settingsOverrides` value, always wins.
2. **Per-provider last-model memory** — `mysti.lastModelByProvider[provider]` (globalState). **Owned by Plan 02 Phase 6; NOT implemented in this plan.** On provider switch, the remembered model for the incoming provider is restored before any fallback. Because every model change records into this memory, it also subsumes "hand-typed model survives a provider round-trip" once Plan 02 lands.
3. **Keep validated custom model (never reset)** — any current model that passes `validateModelName` is kept (with a `console.warn` if not in the registry list); auto-switch away from it only when the outgoing model belongs to the old provider's registry list, not the new one's, and is not in `mysti.customModels[newProvider]`. **Owned by this plan, Phase 2.**
4. **Provider default** — `registry.getDefaultModel(provider)`.

Ownership and ordering contract: this plan's Phase 2 implements steps 1, 3, 4 (the never-reset baseline; until Plan 02 lands, the chain degrades gracefully to 1 → 3 → 4). Plan 02 Phase 6 then inserts step 2 **into the Phase-2-modified code** — it must layer the memory lookup on top of (not replace) the keep-validated logic, and must not reintroduce reset-to-default; its "else default" branch is only reached after steps 3–4 here fail. If Plan 02 happens to land first, this plan's Phase 2 must preserve the existing memory lookup when removing the resets. Plan 00's triage row for #33 should name **Plan 02 Phase 6** as the owning plan (this plan does not implement #33).

- `_getPanelModel` (`ChatViewProvider.ts:351-366`): if the model isn't in the registry list but passes `validateModelName`, **keep it** and log a warning; reset only on validation failure.
- Provider-switch (`ChatViewProvider.ts:3566-3599`): only auto-switch when the current model is the *previous* provider's known model (i.e., it appears in the old provider's registry list but not the new one's, and is not a user custom model for the new provider). A model the user typed by hand survives provider round-trips.
- Codex/Gemini `_getEffectiveModel`: pass through any `validateModelName`-passing model with a console warning instead of dropping. (Membership check becomes "warn", not "gate".)
- Webview `updateModelsForProvider` (`webviewContent.ts:12187-12215`): when the current model isn't in the rebuilt list, render it as a selected `(custom)` option instead of resetting to default.
- Relax `MODEL_NAME_PATTERN` to admit `[` and `]` (needed for `opus[1m]`, #32) in all four duplicated locations: `src/utils/validation.ts:27`, every `mysti.*Model` `pattern` in `package.json`, and the inline webview regex (`webviewContent.ts:11524-11540`). Shell-safety must be re-verified because `BaseCliProvider` refuses shell-mode spawn when args contain metacharacters (`BaseCliProvider.ts:931-936`) and `[`/`]` are glob characters in POSIX shells — see Risks.

### 5. Custom models: first-class, per provider

- New setting `mysti.customModels` — `object`, `additionalProperties: { type: array of string }`, keyed by providerId. The registry reads it, validates each entry, and appends them as `source: 'custom'` dropdown entries.
- The existing `mysti.<provider>Model` settings are **kept** (backward compat, still highest precedence in `_getEffectiveModel`), but the webview "Custom..." flow additionally records the value into `mysti.customModels` so it persists in the dropdown instead of living invisibly in a settings field — the discoverability half of #39.
- Add `manus` to `providerModelKeys` maps (`ChatViewProvider.ts:447-459` and `:3607-3618`) guarded for when Manus is registered (currently unregistered dead code — providers plan).

### 6. Dynamic UI delivery

- New `WebviewMessage` type `modelsUpdated { provider, models, defaultModel, discoveryStatus, fetchedAt }`. ChatViewProvider subscribes to `registry.onDidUpdateModels` and posts to **all panels** (each panel filters by its active provider).
- Webview: handler updates `state.providers[i].models` and re-runs `updateModelsForProvider` if it is the active provider, preserving the current selection per §4. Dropdown gains `<optgroup>` separators (Available / Suggested / Custom from `source`), a "Refresh models" action row, and a subtle staleness hint when `discoveryStatus === 'fallback'`.
- Webview posts `requestModels { provider }` on dropdown focus and on provider switch → ChatViewProvider calls `registry.refresh(provider)` (TTL-respecting, `force` only from the explicit Refresh action).
- `SlashCommandManager._selectModel` gets a `getModelsForProvider(providerId)` callback backed by the registry; the drifted `shortNames` map (`SlashCommandManager.ts:792-806`) is deleted and display names derive from `ModelInfo.name`.

### 7. Background refresh policy

- **No always-on timer** (the performance review flagged Mysti's polling-timer accumulation). Refresh triggers, all non-blocking: (1) lazy post-activation `refreshAll()` scheduled ~10s after activate via `setTimeout`, staggered 1s apart per provider, skipping providers whose CLI wasn't discovered; (2) provider switch; (3) dropdown open / `/model` open; (4) explicit "Refresh models"; (5) TTL check on every `getModels()` access (stale-while-revalidate).
- Per-provider in-flight dedup (a `Map<string, Promise>` of pending refreshes) so concurrent triggers don't double-spawn CLIs.

### 8. New models without an extension release

Three independent channels, in priority order:

1. **Live discovery** — 7 backends pick up new models the moment the user's CLI/server knows them (incl. Copilot's authoritative choices list and OpenClaw's contextWindow data).
2. **Remote curated feed** — a schema-versioned JSON manifest (`{ schemaVersion, updatedAt, providers: { [id]: { models: ModelInfo[], defaultModel } } }`) hosted in the Mysti GitHub repo (raw URL), fetched at most once per 24h with a 5s timeout; a snapshot is bundled at `resources/models/curated-models.json` as the offline floor. Every incoming ID is run through `validateModelName` and capped in count/length (the feed is data, never code). This covers Gemini/Qwen/Cline/Manus and the Claude fallback — maintainers update one JSON file in the repo and every install refreshes within a day.
3. **Custom models** — the user escape hatch for day-zero models, now visible in the dropdown.

### 9. Migration of existing settings values

- **No destructive migration needed for model IDs**: because §4 removes the hard resets, existing `mysti.defaultModel` / per-panel values that are "stale" simply keep working as pass-through custom entries.
- One-time, version-gated migration in `extension.ts` (the `mysti.lastVersion` mechanism already exists at `extension.ts:237-260`): copy any non-empty `mysti.<provider>Model` values into `mysti.customModels` (originals untouched), and prime `mysti.modelRegistry.v1` from the bundled curated JSON so first paint is consistent.
- Centralize the fallback default: new `DEFAULT_FALLBACK_MODEL` constant in `src/constants.ts`; replace the 9-file duplication of `claude-sonnet-4-5-20250929` (`ChatViewProvider.ts:354`, `ProviderManager.ts:158`, ConversationManager, webview `:9313`, etc.). Webview hardcoded model/contextWindow defaults (`webviewContent.ts:9313, 9330`) become placeholders overwritten by `initialState`.

## Implementation Phases

### Phase 1 — Registry core, wired but behavior-neutral

Goal: `ModelRegistryService` exists, all consumers read through it, output is byte-identical to today (registry serves the bundled `config.models`).

1. Create `src/services/ModelRegistryService.ts`: class per §1 with merge logic, memory + `globalState` cache (`mysti.modelRegistry.v1`), `onDidUpdateModels` emitter, in-flight dedup map. Initial `refresh()` is a no-op returning curated.
2. Modify `src/types.ts`: add `ModelEntry`/`ProviderModelState` (or extend `ModelInfo` with optional `source`/`deprecated`); add `modelsUpdated`/`requestModels` to the documented `WebviewMessage` payload types if typed there.
3. Modify `src/constants.ts`: add `DEFAULT_FALLBACK_MODEL`, `MODEL_DISCOVERY_TIMEOUT_MS`, `MODEL_CACHE_TTL_CLI_MS`, `MODEL_CACHE_TTL_LOCAL_MS`, `MODEL_CURATED_FEED_TTL_MS`, `MODEL_CUSTOM_MAX_PER_PROVIDER`.
4. Modify `src/extension.ts`: construct `ModelRegistryService(context, providerManager)` after `ProviderManager` (~line 73), pass to `ChatViewProvider` (constructor gains a 17th param — keep the documented param order, append at end) and register for disposal.
5. Modify `src/managers/ProviderManager.ts`: `getModels()` (`:142-145`), `getProviderDefaultModel()` (`:151-159`), `getModelContextWindow()` (`:165-175`) delegate to the registry when set (setter injection to avoid construction-order knots), fall back to `config.models` otherwise.
6. Modify `src/providers/ChatViewProvider.ts`: `_sendInitialState` providers payload (~`:518-553`) sourced from `registry.getModels()` per provider instead of raw `ProviderConfig`; replace `claude-sonnet-4-5-20250929` literal at `:354` with `DEFAULT_FALLBACK_MODEL`.
7. Modify `src/managers/SlashCommandManager.ts`: add `getModelsForProvider` callback to its callbacks interface; `_selectModel` (`:830+`) uses it; delete `_getModelDisplayName`'s `shortNames` map (`:792-806`), derive from `ModelInfo.name`.
8. Verify: `npm run compile` + `npm run lint`; manual smoke in F5 host — dropdown and `/model` identical to before.

### Phase 2 — Stop the resets, relax validation (closes most of #39 and unblocks #32)

Deliberately before discovery so users are unblocked even where discovery is impossible.

1. Modify `src/providers/ChatViewProvider.ts:351-366` (`_getPanelModel`): replace reset-to-default with: registry membership → pass; else `validateModelName` pass → keep + `console.warn`; else default. This implements steps 1/3/4 of the canonical precedence chain (§4). **Shared code path:** Plan 02 Phase 6 (#33) later edits this same function to insert the per-provider memory lookup (step 2) — it builds on this task's modified logic, not the original reset logic.
2. Modify `src/providers/ChatViewProvider.ts:3566-3599` (provider switch): auto-switch only when the outgoing model belongs to the old provider's list and not the new one's and is not in `mysti.customModels[newProvider]`; otherwise keep. **Shared code path:** Plan 02 Phase 6 (#33) later edits this same handler to restore `lastModelByProvider[newProvider]` before falling back to default (step 2 of the §4 chain); the keep/auto-switch semantics here must survive that layering.
3. Modify `src/providers/codex/CodexProvider.ts:1003-1022` and `src/providers/gemini/GeminiProvider.ts:254-276` (`_getEffectiveModel`): membership check downgraded from gate to warning; any validated model passes through (preserve Codex's "default model ⇒ omit flag" special case).
4. Modify `src/utils/validation.ts:26-41`: `MODEL_NAME_PATTERN` → `/^[a-zA-Z0-9][a-zA-Z0-9._\-:/\[\]]*$/`; update doc comment and error message.
5. Modify `package.json`: same pattern change on every `mysti.*Model` setting (claudeCodeModel, codexModel, geminiModel, clineModel, copilotModel, cursorModel, openclawModel, opencodeModel, qwenCodeModel); fix the `mysti.copilotModel` description's invalid `claude-opus-4.6` example.
6. Modify `src/webview/webviewContent.ts:11524-11540`: update the inline validation regex + help text to match.
7. Modify `src/providers/base/BaseCliProvider.ts:931-936` (`_validateArgsForShell` or equivalent): on the shell-mode path, either exclude `[`/`]` from the refusal set **with per-arg quoting** or keep refusing shell mode for bracket args and fall back to non-shell spawn — decide per Risks R1; add an inline comment documenting the glob rationale.
8. Modify `src/providers/claude/ClaudeCodeProvider.ts:60-87`: curated list gains alias entries (`opus`, `sonnet`, `haiku` — "always latest") and `[1m]` variants with `contextWindow: 1000000`; correct stale contextWindows.
9. Modify `src/providers/copilot/CopilotProvider.ts:55+`: remove phantom `gpt-5.4` (and any other IDs absent from the CLI's choices list).
10. Modify `src/providers/ChatViewProvider.ts` (stream path): when a provider will ignore the selected model (Cline/OpenClaw/Ollama/LocalAI per F18, or `_getEffectiveModel` dropped it), surface a one-line informational note in the response header area rather than silence. (Full wiring/hiding of those dropdowns belongs to the provider-layer plan.)
11. Verify: set `claude-opus-4-6[1m]` as custom model → reaches `--model` argv; pick an unknown Codex model → passed through with warning; switch providers and back → hand-typed model survives.

### Phase 3 — Live discovery adapters + caching

1. Modify `src/providers/base/IProvider.ts` (~`:290`): add optional `discoverModels?(timeoutMs: number): Promise<ModelInfo[] | null>` to `ICliProvider`.
2. Modify `src/providers/ollama/OllamaProvider.ts`: implement `discoverModels` reusing the existing `/api/tags` fetch (`:122-137`) — parse `json.models[].name`; optionally `/api/show` per model for context length (cap at 5 lookups per refresh). TTL class: local (5min).
3. Modify `src/providers/localai/LocalAIProvider.ts`: implement via existing `/v1/models` call (`:122,157`) — parse `data[].id`. TTL class: local.
4. Modify `src/providers/cursor/CursorProvider.ts`: implement by spawning `cursor-agent models` (use `getCliPath()` + enriched env), strip ANSI (`/\x1b\[[0-9;]*m/g`), split lines, drop `Loading models…`/empty/`No models available` lines; on the logged-out sentinel return `null` (fallback) and remember `accountGated: true` for UI hinting.
5. Modify `src/providers/openclaw/OpenClawProvider.ts`: implement via `openclaw models list --json`; map `key→id`, `name`, `contextWindow`; mark `tags` containing `default` as the discovered default; skip `missing` entries.
6. Modify `src/providers/opencode/OpenCodeProvider.ts`: implement via `opencode models`; each `provider/model` line becomes an id (these are exactly what `-m` accepts, `OpenCodeProvider.ts:189-192`).
7. Modify `src/providers/copilot/CopilotProvider.ts`: implement by spawning `copilot --help` and regexing the `--model <model>` `(choices: "a", "b", ...)` block; if the regex finds nothing, return `null`.
8. Modify `src/providers/codex/CodexProvider.ts`: implement via `codex debug models` with JSON parse in try/catch; any failure (incl. spawn SIGKILL observed in research) returns `null`.
9. Modify `src/providers/claude/ClaudeCodeProvider.ts`: implement optionally — if `process.env.ANTHROPIC_API_KEY` is present, `GET https://api.anthropic.com/v1/models` (headers `x-api-key`, `anthropic-version: 2023-06-01`), mapping `max_input_tokens`→`contextWindow`; else return `null` (aliases from Phase 2 carry the UX).
10. Optionally modify `src/providers/qwen/QwenCodeProvider.ts`: read model ids out of `~/.qwen/settings.json` if present; merge with curated.
11. Modify `src/services/ModelRegistryService.ts`: `refresh()` now calls `provider.discoverModels?.()` with timeout race, persists results + `fetchedAt` to globalState, fires `onDidUpdateModels`; implement TTL classes and stale-while-revalidate in `getModels()`; implement the post-activation staggered `refreshAll()` (called from `extension.ts` via `setTimeout` after activation completes — must not touch the activation critical path flagged by the performance review).
12. Verify: with Ollama running, dropdown shows installed tags within one refresh; kill the network/server → cached list persists; cold install (cleared globalState) → curated list.

### Phase 4 — Dynamic UI: modelsUpdated, custom-model management, refresh affordances

1. Modify `src/providers/ChatViewProvider.ts`: subscribe to `registry.onDidUpdateModels` → post `modelsUpdated { provider, models, defaultModel, discoveryStatus, fetchedAt }` to all panels; handle inbound `requestModels { provider, force? }` → `registry.refresh()`; route the existing customModel write path (`:3602-3636`) to also call `registry.addCustomModel()`; add `manus` to both `providerModelKeys` maps (`:447-459`, `:3607-3618`) behind a registered-provider check.
2. Modify `src/webview/webviewContent.ts`: add `modelsUpdated` case to the message handler; rework `updateModelsForProvider` (`:12187-12215`) to (a) group options by `source` with `<optgroup>`, (b) keep the current selection as a synthetic `(custom)` option when absent (removing the third reset path), (c) append "Refresh models" and "Custom..." action rows; post `requestModels` on dropdown focus/provider change; replace hardcoded defaults at `:9313`/`:9330` with initialState-driven values; render a small "list may be outdated" hint when `discoveryStatus === 'fallback'`.
3. Modify `package.json`: declare `mysti.customModels` (`type: object`, default `{}`, markdownDescription explaining per-provider arrays); declare a `mysti.models.autoRefresh` boolean (default true) gating the post-activation `refreshAll`.
4. Modify `src/managers/SlashCommandManager.ts`: `_selectModel` QuickPick gains a "$(refresh) Refresh model list" item (calls registry force-refresh and reopens) and shows `source` as QuickPick detail; custom entries get a remove affordance or at minimum render distinctly.
5. Modify `src/services/ModelRegistryService.ts`: `addCustomModel`/`removeCustomModel` write `mysti.customModels` (Global target), enforce `MODEL_CUSTOM_MAX_PER_PROVIDER`, fire events.
6. Verify: enter a custom model via "Custom..." → it appears in the dropdown's Custom group, survives reload, syncs to the `/model` QuickPick; Refresh updates the list in-place without losing the selection.

### Phase 5 — Remote curated feed, migration, cleanup

1. Create `resources/models/curated-models.json`: schema-versioned snapshot covering all 12 providers (source of truth generated from the per-provider curated arrays; include `defaultModel` and `contextWindow`s, current June-2026 Claude IDs incl. opus-4-8/4-7/sonnet-4-6 per research).
2. Modify `src/services/ModelRegistryService.ts`: on refresh (24h TTL), fetch the raw-GitHub manifest URL (constant `MODEL_CURATED_FEED_URL` in `src/constants.ts`); validate `schemaVersion`, run every id through `validateModelName`, cap counts; persist under the same globalState key; curated layer precedence: remote (if newer) → bundled JSON → in-code arrays.
3. Modify `src/extension.ts`: version-gated one-time migration (reuse `mysti.lastVersion` flow at `:237-260`): copy non-empty `mysti.<provider>Model` values into `mysti.customModels`; prime the registry cache from the bundled JSON.
4. Modify remaining `claude-sonnet-4-5-20250929` literals (ConversationManager.ts, ProviderManager.ts:158, validation.ts doc comment, package.json default) to `DEFAULT_FALLBACK_MODEL` or the registry default.
5. Create `scripts/validate-curated-models.js` + npm script `validate-models` (mirror of `sync-agents` pattern): schema-checks the bundled JSON in CI/pre-package so a bad manifest can't ship.
6. Modify `CLAUDE.md`: document ModelRegistryService under Managers/Services, the new constants, the curated-feed update workflow ("edit resources/models/curated-models.json + the hosted copy"), and the new settings.
7. Verify: block network → bundled snapshot serves; bump the hosted manifest → installs pick it up within 24h without a release; fresh-profile upgrade migrates `mysti.codexModel` into `customModels`.

## Risks & Mitigations

- **R1 — Bracket relaxation vs shell safety.** `[`/`]` are POSIX glob characters; `BaseCliProvider` spawns with `shell: true` on win32 (`BaseCliProvider.ts:927`) and refuses shell mode when args contain metacharacters (`:931-936`). An unquoted `claude-opus-4-6[1m]` could glob-expand if a matching filename exists. Mitigation: in shell mode, quote the model argument (or keep brackets in the refusal set and force non-shell spawn for bracketed args — viable everywhere except Windows `.cmd` shims, which is the provider plan's F17 territory); add this exact case to the Phase 2 verification checklist on macOS+Windows.
- **R2 — Fragile discovery surfaces.** `copilot --help` parsing and `codex debug models` are unsupported interfaces that can change format silently. Mitigation: every adapter returns `null` on any parse anomaly (registry falls back to curated, never empty); log raw output at debug level; the curated feed provides a same-day correction channel without a release.
- **R3 — Removing resets re-exposes raw CLI errors.** Users can now select models the CLI rejects (that's the point), so provider error chunks become the feedback path — and some providers have weak error surfacing (Codex discards stderr, provider review F23). Mitigation: Phase 2 task 10's "model ignored/likely invalid" notes; depend on the provider-layer plan for stderr/auth-error hygiene; never reset, only inform.
- **R4 — Discovery spawns worsen startup/perf.** The performance review flagged serial CLI discovery already blocking activation. Mitigation: `refreshAll` runs ≥10s post-activation, staggered, skips undiscovered CLIs, 5s hard timeout each, single-flight dedup; `getModels()` is always synchronous.
- **R5 — Account-gated lists (Cursor) shrink the dropdown.** A logged-out `cursor-agent` reports no models; replacing curated with an empty live list would strand users. Mitigation: empty/sentinel live results are treated as `null` (fallback), plus a "log in to see your models" hint via `discoveryStatus`.
- **R6 — Remote feed is a supply-chain input.** A compromised manifest could inject strings into CLI argv. Mitigation: ids re-validated with `validateModelName` (which exists precisely to be argv-safe), schema-version pinning, count/length caps, data-only consumption; optional future: signature check.
- **R7 — globalState growth.** The managers-core review flags unbounded globalState. Mitigation: single registry key, model metadata only (no descriptions beyond short strings), hard cap entries per provider (e.g. 200).
- **R8 — Webview `state.providers` shape drift.** Multiple webview code paths index `state.providers` (`:11966, :12174, :12438, :12450, :15240`); changing the models shape risks breaking provider switching and brainstorm pickers. Mitigation: keep the wire shape backward compatible (`models: ModelInfo[]` plus additive fields), audit each call site in Phase 4 task 2.
- **R9 — Default-model churn.** OpenClaw discovery reports its own default; auto-adopting it could surprise users. Mitigation: discovered defaults only apply when the user has never chosen a model (no per-panel override and `mysti.defaultModel` untouched/equal to old provider default).

## Dependencies (on other plans 00-05, if any)

- **Provider-layer hardening plan** (the plan derived from `mysti-providers.md`, expected 00 or 02): owns F18 (wiring or hiding the no-op model dropdowns for Cline/OpenClaw/Ollama/LocalAI — Phase 3 here makes Ollama/LocalAI lists real, but *routing* `settings.model` into their request bodies is that plan's change), F17 (Windows `.cmd`/shell spawn — interacts with R1's quoting decision), F14 (Manus registration — gates the `providerModelKeys` manus entries), and the shared `spawnAndStream` helper that `discoverModels` CLI spawns should adopt if it lands first. This plan is **not blocked** by it; only Phase 2 task 7 and Phase 3 spawn details need coordination.
- **Unified chat UX plan** (from `unified-chat-ux.md`, = `02-unified-chat-experience.md`): proposes a Provider Manifest posted to the webview. `modelsUpdated` should ride or align with that manifest message if both land in the same release window; otherwise additive messages coexist safely. **Beyond manifest/models delivery, there is a direct code-path collision:** Plan 02 Phase 6 (#33, `lastModelByProvider` memory) rewrites the same two functions this plan's Phase 2 rewrites — `_getPanelModel` (`ChatViewProvider.ts:351-366`) and the provider-switch handler (`:3566-3599`). The reconciliation is the canonical precedence chain in §4 (panel override → per-provider memory [Plan 02] → keep-validated-custom-model [this plan] → provider default): this plan lands the never-reset baseline, Plan 02 Phase 6 layers the memory lookup on top of the Phase-2-modified code, and neither may reintroduce reset-to-default. Plan 00's #33 triage row should point at Plan 02 Phase 6 as owner.
- **Performance plan** (from `mysti-performance.md`): owns activation-path discovery caching. `refreshAll` scheduling (Phase 3 task 11) must respect whatever activation budget that plan establishes.
- No dependency on the canvas, MCP/connections, or triage plans.

## Effort Estimate (S/M/L per phase)

- Phase 1 — Registry core, behavior-neutral wiring: **M**
- Phase 2 — Remove resets + validation relaxation: **M** (small diffs, but 4-location regex sync + shell-safety verification on two OSes)
- Phase 3 — Seven discovery adapters + caching/TTL: **L**
- Phase 4 — Dynamic UI + custom-model management: **M**
- Phase 5 — Remote curated feed + migration + cleanup: **M**

## Open Questions

1. **R1 resolution**: quote-args-in-shell-mode vs refuse-shell-for-brackets — needs a 30-minute spike on Windows (`.cmd` shim + bracketed `--model`) before Phase 2 task 7 is finalized.
2. Should Cline's model dropdown be hidden outright (the CLI accepts no model flag, `ClineProvider.ts:315-318`) or kept with a persistent "configured via cline CLI" note? Leaning hide, but that is provider-plan territory.
3. Where exactly to host the curated feed: raw GitHub URL in the Mysti repo (simplest, no infra) vs models.dev `api.json` as a secondary cross-provider metadata source (richer contextWindows, but an external dependency and different id namespace). Proposal: Mysti-owned manifest primary; models.dev as a build-time input to *generate* it.
4. Should `getModelContextWindow`'s 200000 fallback (`ProviderManager.ts:165-175`) become model-family-aware (e.g., 1M for `[1m]`-suffixed ids) even when discovery provides nothing? Cheap heuristic, affects compaction thresholds.
5. Do we adopt OpenClaw/Anthropic-discovered `defaultModel`s at all (see R9), or treat discovery as list-only forever?
6. Per-panel vs global refresh semantics: today settings are global; if the per-panel settings follow-up (memory note: "per-panel settings deferred") lands, does the registry need per-workspace endpoint awareness for Ollama/LocalAI (different `mysti.ollamaEndpoint` per workspace is already possible via workspace settings)?
7. Telemetry: is a `model_discovery_{success,fallback}` event worth adding to TelemetryManager to learn which adapters break in the field?
