# Plan 02 — Unified Chat Experience Across All 12 Agents

- **Title:** Unified Chat Experience Across All 12 Agents
- **Date:** undefined
- **Status:** DRAFT

---

## Goal

Make a Mysti chat with any of the 12 backends look, behave, and degrade identically — differences between agents should be visible only as *absent zones plus explanatory pills*, never as broken controls, missing cards, dead dropdowns, or silent stalls.

Concretely, when this plan is done:

1. **Zero provider-name branching in render logic.** The webview renders from a capability manifest, not from `provider === 'openai-codex'` string checks. Adding provider #13 requires a provider class + registry entry + manifest metadata — zero edits to `webviewContent.ts` or `ChatViewProvider.ts`.
2. **One message anatomy** (header / thinking / body / tool zone / footer) shared by main chat, brainstorm bubbles, sub-agent cards, and restored conversations.
3. **Graceful degradation rules** per missing capability — no dead thinking selectors, no accept-then-strip attachments, no eternal tool spinners, no context bar showing a previous provider's numbers.
4. **Honest session/resume + compaction UX** — users can tell whether their conversation is CLI-resumed, history-replayed, or stateless; compaction looks the same regardless of strategy.
5. **Per-agent config survives switching** (GitHub #33) — Claude→Codex→Claude does not lose "Opus 4.6".
6. **First-class context affordances** (GitHub #28) — open tab/selection auto-context with a quick toggle, finishing the half-built plumbing.
7. **No silent stalls** (GitHub #31) — a streaming status/heartbeat layer so users always see *something* is happening, and the brainstorm 90s abort becomes a warn-then-wait.

## Current State

Grounded in the working tree (branch `feature/visual-testing`). Full evidence: `/tmp/mysti-planning/research/unified-chat-ux.md`, `/tmp/mysti-planning/research/mysti-webview-chat.md`, `/tmp/mysti-planning/research/mysti-providers.md`.

### Capability model exists but never reaches the UI

- `ProviderCapabilities` is declared at `src/providers/base/IProvider.ts:54-65` and populated by all 12 providers, but its entire consumption surface is 6 call sites on the extension side (`ChatViewProvider.ts:2694, 2703, 3729, 6695`; `CompactionManager.ts`; `VisualTestManager.ts:183`). The webview (`src/webview/webviewContent.ts`, 18,669 lines) contains **zero** references to `capabilities` or any `supports*` flag (grep-verified).
- One flag is dead: `supportsVisualTesting` (`IProvider.ts:63`) is never set or read.
- Several flags contradict reality: Copilot `supportsToolUse: true` but its CLI emits plain text so no tool events ever fire; Ollama `supportsImages: true` but attachments are dropped (`OllamaProvider.ts:217-219` → base ignores them at `BaseCliProvider.ts:1255`); Codex/Cline declare `supportsSessions: true` with no actual resume.

### Provider-name branching in the webview (the seams to kill)

Grep counts: **56 provider-ID literal lines in `webviewContent.ts`, 38 in `ChatViewProvider.ts`**. Deduplicated functional seams:

| Seam | Location | Problem |
|---|---|---|
| W1 | `webviewContent.ts:11984` | Thinking-level selector hidden only for `google-gemini`; copilot/cursor/ollama/localai also have `supportsThinking: false` → dead control for 4 providers |
| W2 | `webviewContent.ts:15680` | Main-chat thinking renderer forks on `provider === 'openai-codex'` (separate blocks) vs everyone-else (Claude-style accumulator); Cline/Qwen/OpenCode/OpenClaw forced through the wrong shape |
| W3 | `webviewContent.ts:14774` | Brainstorm thinking renderer uses the *opposite* heuristic (`agentId !== 'claude-code'`) — same provider renders thinking differently in main chat vs brainstorm |
| W4 | `webviewContent.ts:12219-12224, 15257-15263` | `codexSettingsSection` shown iff `providerId === 'openai-codex'`, duplicated twice; no declarative mechanism for other providers' settings |
| W5 | `webviewContent.ts:14478-14483` | `getProviderIconUri()` covers 6 of 11 providers — blank install-modal icons for cline/opencode/ollama/localai/qwen |
| W6 | `webviewContent.ts:9402-9412, 12251-12261, 12270-12280` | Three separate provider display registries in one file |
| W7 | `webviewContent.ts:9417, 12299, 14714, 14932` | Four `'openai-codex'` theme-aware-logo special cases |
| W8 | `webviewContent.ts:10531-10532` | Ad-hoc short-ID aliasing (`'claude-code'→'claude'`) at point of use |
| W9 | `webviewContent.ts:11893, 12322` | Two hard-coded 11-element provider arrays for settings dropdowns |
| W10 | `webviewContent.ts:14703` (+ `ChatViewProvider.ts:514`) | Hard-coded brainstorm default pair |
| C1 | `ChatViewProvider.ts:448-459` vs `:3607-3618` | Two copies of `providerModelKeys`; the write-side copy omits `'qwen-code'` → setting a custom Qwen model is a silent no-op (drift bug, proof name-keying rots) |
| C2 | `ChatViewProvider.ts:640, 869, 3671` | Three hard-coded `allAgentIds` arrays |
| C3 | `ChatViewProvider.ts:926` | `shutdownAgent` lifecycle event always posts `providerId: 'claude-code'` |
| C4 | `ChatViewProvider.ts:2820` | OpenClaw channel-delegate special case, unflagged |
| C5 | `ChatViewProvider.ts:339, 345, 1012, 1828, 6130` | Five `'claude-code'` fallback literals |
| C7 | `SlashCommandManager.ts:81` | Legacy `/compact` always maps to `claude:compact` regardless of provider |

Provider identity (name/color/icon/shortId) is maintained in **at least 6 places**: the three webview registries (W6), `getProviderIconUri` (W5), `BrainstormManager.AGENT_STYLES` (`src/managers/BrainstormManager.ts:35`), `MentionRouter.AGENT_DISPLAY_NAMES` (`src/managers/MentionRouter.ts:35`).

### Message anatomy is inconsistent across providers

From the 12-provider consistency matrix (`mysti-webview-chat.md` §4):

- **Thinking:** 5 providers emit it, rendered through 2 contradictory hard-coded paths (W2/W3); 5 providers don't emit it but still show the level selector; `getThinkingTokens` is only effective for Claude and Cline — the selector is a silent no-op for everyone else.
- **Tool cards:** Ollama/LocalAI emit `tool_use` but never `tool_result` (`OllamaProvider.ts:275-291`) → eternal spinners. Cursor maps rejected tools to `status: 'completed'` (`CursorProvider.ts:469-493`) → failures render green. Qwen drops every tool call after the first per assistant message (`QwenCodeProvider.ts:395-407`, early `return`) and double-emits full-input `tool_use` causing double permission gating (vs Claude's documented avoidance at `ClaudeCodeProvider.ts:567-576`). Copilot produces no tool cards at all (plain-text CLI output). Cursor/OpenClaw parsers emit their own `done` in addition to `sendMessage`'s (`CursorProvider.ts:524-527`, `OpenClawProvider.ts:446-448`).
- **Tool summaries:** `formatToolSummary` (`webviewContent.ts:15776-15821`) is written for Claude's names; Gemini/Qwen names (`run_shell_command`, `write_file`, `replace`) fall to the generic branch → blank/raw-JSON summaries. `ToolCall` (`src/types.ts:87-94`) has no semantic `kind`, so icons are inferred from raw per-CLI names.
- **Thinking misclassification:** Codex rewrites any `**…**` line into a thinking chunk (`CodexProvider.ts:632-646`) — bold answers vanish from the body.
- **Usage footer / context bar:** depends on `done.usage`; OpenClaw and Manus never supply it, and the bar is never reset on provider switch — it silently shows the *previous* provider's numbers; CompactionManager never engages for them.
- **Plan moment:** Claude's `exit_plan_mode` chunk is produced (`ClaudeCodeProvider.ts:488-491`) but consumed nowhere — no case in the `_handleSendMessage` switch (`ChatViewProvider.ts:2792-3179`), no webview handler. The plan-approval moment silently breaks.
- **Restoration parity:** `ConversationManager.addMessageToConversation` (`src/managers/ConversationManager.ts:165-185`) never persists `toolCalls`; restored messages render as one flat block with a non-collapsible thinking dump (`webviewContent.ts:15551-15602`) and show the *currently selected* model as attribution (`:15564`), not the model that produced the message.

### Session/resume honesty

- Fake `session_active` IDs: Copilot fabricates `copilot-<panel>-<ts>` and feeds it to `--resume` (`CopilotProvider.ts:313-316, 386-390` — broken follow-ups); Cursor (`CursorProvider.ts:640-643`), Cline (`ClineProvider.ts:803-806`), OpenClaw gateway (`OpenClawProvider.ts:628-632`) fabricate IDs purely for the green dot. Cursor has `supportsSessions: false` *and* discards history (`CursorProvider.ts:564-588`) — stateless follow-ups while the UI shows a live session. Qwen's `--continue` resumes the globally-latest session (`QwenCodeProvider.ts:188-191`) — cross-panel bleed.
- The session indicator is a bare green dot — no provider/session info, no distinction between "CLI resumes natively", "we replay the last `MAX_CONVERSATION_MESSAGES` (10)", and "stateless".

### Model/agent switcher (#33)

- `_handleUpdateSettings` provider-switch path (`ChatViewProvider.ts:3566-3599`): if the current model isn't in the new provider's hardcoded list it is overwritten with the new provider's default. There is no per-provider memory of the last selection, so Claude→Codex→Claude loses "Opus 4.6". `_getPanelModel` (`ChatViewProvider.ts:351-366`) re-validates on every read and resets to default as well.
- Model dropdowns are hardcoded TS arrays with **three divergent semantics**: pass-raw (Claude/Copilot/Cursor/Qwen), pass-if-member (Codex/Gemini/OpenCode), and ignore (Cline/OpenClaw/Ollama/LocalAI — silent no-op dropdowns, `mysti-providers.md` F18), plus Codex's "default ⇒ omit flag" special case.

### Context affordances (#28)

- The plumbing is half-built and dead-ended: `src/extension.ts:499-531` posts `activeFileChanged` / `selectionChanged` to the webview when `mysti.autoContext` is on, but **no handler for either message exists anywhere** (grep-verified). `ContextManager.getContext()` (`src/managers/ContextManager.ts:41-44`) returns only manually added items; "auto" mode attaches nothing.
- `ContextManager` defaults un-panel'd calls to bucket `'default'` (`ContextManager.ts:42`) while the sidebar panel uses `'sidebar'` — a known bucket mismatch.

### Silent stalls (#31)

- Brainstorm: `BRAINSTORM_SILENCE_TIMEOUT_MS = 90 * 1000` (`src/constants.ts:80`) enforced by `BrainstormManager._iterateWithSilenceTimeout()` (`src/managers/BrainstormManager.ts:838-853`). Any 90s gap between chunks aborts the agent — long thinking phases routinely exceed this (user reports Codex aborted "at the very end" of a full analysis). The `setTimeout` in the `Promise.race` is never cleared → one leaked timer per chunk, and the orphaned stream is never cancelled on abort.
- Main chat: no heartbeat at all. The Stop button disappears after the first chunk (`webviewContent.ts:15654` sets `isLoading = false`), so during a long tool run or thinking phase the user sees a frozen transcript with no status, no elapsed time, and no cancel affordance. `waitForProcess` kills at 5 min (`PROCESS_TIMEOUT_MS`) with a generic error. (Note: `mysti-providers.md` F3's claim that 5 providers never setting `session.autonomousMode` makes autonomous runs die at 5 min was **refuted** by `plans/00-findings-and-github-triage.md` §"Investigated, not a bug" — the 5-min timer only bounds the post-EOF wait for process exit, so autonomous runs do not die at 5 minutes; it is a benign latent inconsistency, cleaned up opportunistically with Plan 00 Batch 2.4's shared `spawnAndStream` harness. The real #31 problems here are the missing heartbeat and the generic timeout error message.)

## Proposed Design

### 1. Capability-driven rendering via a Provider Manifest

Adopt the ACP/Continue.dev model: **render from capabilities, never from provider names**. A provider name selects a logo and accent color from one registry; everything else derives from a capability profile shipped to the webview.

**Extend `ProviderCapabilities`** (`src/providers/base/IProvider.ts:54`):

```ts
export interface ProviderCapabilities {
  // existing flags unchanged ...
  thinkingStyle: 'streamed' | 'complete-blocks' | 'none';   // kills W1/W2/W3
  thinkingLevelEffective: boolean;       // true only where levels map to real CLI behavior (Claude, Cline)
  planMode: 'native' | 'detected' | 'none';
  sessionKind: 'cli-resume' | 'prompt-history' | 'none';    // session honesty
  emitsToolResults: boolean;             // false for Ollama/LocalAI → auto-resolve cards
  emitsUsage: boolean;                   // false for OpenClaw/Manus → footer shows "n/a", bar resets
  modelSelection: 'dropdown' | 'custom-only' | 'none';      // kills silent no-op dropdowns
  supportsChannels?: boolean;            // OpenClaw (C4)
  // delete dead supportsVisualTesting or wire it (Open Question 4)
}
```

**Provider Manifest** — a new module builds, from `ProviderRegistry`, one serializable record per provider:

```ts
interface ProviderManifestEntry {
  id: ProviderType; displayName: string; shortId: string;
  color: string; icon: string; themeAwareLogo?: boolean;
  capabilities: ProviderCapabilities;
  models: ModelInfo[]; defaultModel: string;
  customModelSettingKey: string;                  // single source for C1's duplicated maps
  settingsSections: ProviderSettingsSection[];     // declarative, kills W4
}
```

The manifest is posted to the webview inside `initialState` and on every provider switch/install-state change. `BrainstormManager.AGENT_STYLES` and `MentionRouter.AGENT_DISPLAY_NAMES` become consumers of the same module.

### 2. Normalized message anatomy (one skeleton everywhere)

```
┌ Header ─────────────────────────────────────────────────┐
│ [avatar+color] [name] [model chip — stamped per message] │
│ [role badge in brainstorm] [timestamp]                   │
├ Thinking zone (only if thinkingStyle ≠ 'none') ──────────┤
│ ONE collapsible component; streamed deltas append text,  │
│ complete blocks append paragraphs — same widget.         │
├ Body ────────────────────────────────────────────────────┤
│ Markdown (Marked/Prism/Mermaid) — already uniform        │
├ Tool zone ───────────────────────────────────────────────┤
│ Kind-iconed cards, 4-state status, inline diffs,         │
│ permission cards inline (pipeline already uniform)       │
├ Footer ──────────────────────────────────────────────────┤
│ tokens in/out · context % pie (or "~"/"n/a") · duration  │
│ · session pill (resumed / replayed / stateless)          │
│ · degradation pills when applicable                      │
└──────────────────────────────────────────────────────────┘
```

Used by main chat, brainstorm bubbles, sub-agent cards, **and restored conversations** (which requires persisting `toolCalls`, segments, thinking, and per-message `provider`+`model`).

`ToolCall` gains an ACP-style semantic `kind: 'read'|'edit'|'delete'|'move'|'search'|'execute'|'think'|'fetch'|'other'`, populated at parse time by each provider (each already knows its own tool names; reuse the `_classifyToolAction` taxonomy from `src/utils/permissionClassifier.ts`). The webview renders one icon/card system from `kind` and stops inferring from raw CLI tool names.

### 3. Graceful degradation rules (per missing capability)

OpenRouter rule of thumb: degrade silently where harmless, surface a pill/tooltip where the user could be confused, never hard-fail unless data would be lost.

| Missing capability | Rule |
|---|---|
| `thinkingStyle: 'none'` | Hide thinking selector AND never render a thinking zone. One-time hint if the user had a non-none level set. |
| `thinkingLevelEffective: false` | Selector labeled "advisory" (prompt-injected) or hidden — never a silent no-op. |
| `sessionKind: 'none'` | "Stateless" pill in footer; resume affordances hidden; tooltip explains each message stands alone. |
| `sessionKind: 'prompt-history'` | "History replayed (last 10)" pill; no fake green session dot. |
| `supportsNativeCompact: false` | Client-summarize silently; compaction event card identical either way. |
| `supportsImages / FileAttachments: false` | Disable attach buttons at the composer with tooltip ("Codex doesn't support images — switch to Claude or Ollama"); send-time strip (`ChatViewProvider.ts:2687-2718`) stays as safety net. |
| `emitsToolResults: false` | Auto-resolve tool cards after the next text chunk / on done — no eternal spinners. |
| `emitsUsage: false` | Footer shows "usage n/a"; context bar hidden and **reset on provider switch**; compaction disabled with a pill instead of silently dead. |
| `supportsToolUse: false` (Manus, if revived) | Hide tool zone + permission UI; "responses-only agent" pill. |
| `supportsStreaming: false` (Manus) | Indeterminate progress card with poll status instead of token stream. |
| `planMode: 'detected'` | Plan-option cards from `PlanOptionManager` (already universal); `'native'` adds the exit-plan flow. |
| Model without `contextWindow` | "~" estimate marker on the context pie instead of asserting a 200k-based % (`ProviderManager.ts:165-175`). |
| `modelSelection: 'custom-only' / 'none'` | Dropdown hidden / replaced with "configured via `<cli> config`" note — no dead dropdowns (F18). |

### 4. Session/resume + compaction UX

- Footer session pill driven by `sessionKind` + the real session ID (truncated, with tooltip). Fake fabricated IDs are removed from `session_active` emission (the deep CLI fixes — Copilot `--resume` (B5, `plans/00-findings-and-github-triage.md` Batch 2.4), Qwen `--continue` (B9, Plan 00 Batch 1.3), Cursor statelessness (B8, Plan 00 Batch 2.4) — belong to Plan 00's Batches 1–2; this plan makes the UI honest about whatever the provider actually does).
- `/compact` becomes provider-neutral: `SlashCommandManager.ts:81` routes to `cmd:compact`, which picks native vs client-summarize via `supportsNativeCompact` — same event card either way.
- Context bar resets on provider switch and shows per-provider state.

### 5. Model/agent switcher with per-agent memory (#33)

- New globalState key `mysti.lastModelByProvider: Record<ProviderType, string>` (plus `lastThinkingLevelByProvider`). On model change, record it; on provider switch, restore the remembered model if still valid for that provider, else default. This replaces "reset to default" at `ChatViewProvider.ts:3573-3599`.
- The settings panel renders each provider's `settingsSections` from the manifest, with values loaded per provider — switching agents in the settings UI re-reads that agent's persisted values instead of showing shared/stale state.
- One `customModelSettingKey` per manifest entry replaces both `providerModelKeys` copies (fixes the qwen-code drift, C1).

### 6. Context affordances (#28)

- Finish the dead-ended plumbing: webview handlers for `activeFileChanged` / `selectionChanged` render an **ephemeral "Active context" chip row** above the composer (file name + line range for selections), with a quick toggle pill (bound to `mysti.autoContext`) and a per-chip "pin to context" action that promotes it into `ContextManager`.
- At send time, when `contextMode === 'auto'`, `ChatViewProvider._handleSendMessage` injects the active editor file (or selection, if non-empty) as ephemeral context items — not stored in the manual list, freshly read each send.
- Fix the `'default'` vs `'sidebar'` context-bucket mismatch in `ContextManager`.

### 7. Streaming status / heartbeat (#31)

- **Extension-side heartbeat:** the stream loop in `_handleSendMessage` tracks `lastChunkAt` per panel; a 10s interval posts `streamStatus { phase, silentMs, elapsedMs }` to the webview whenever silence exceeds 10s. `phase` derives from the last chunk type: `waiting-first-token` | `thinking` | `tool-running` (`toolName`) | `generating`.
- **Webview status line:** a slim line under the streaming bubble: "Claude is running `Bash` — 45s" / "Codex is thinking — 1m 20s", with the Stop button visible for the entire stream (fix the `isLoading = false` reset at `webviewContent.ts:15654` — keep a separate `isStreaming` flag for cancel affordance).
- **Brainstorm:** raise `BRAINSTORM_SILENCE_TIMEOUT_MS` to 5 minutes, add `mysti.brainstorm.silenceTimeout` setting, and change semantics from abort to **warn-then-wait**: after the threshold, emit an `agent_status` chunk rendered as "⏳ Codex has been silent for 2m — still waiting (Stop to abort)"; abort only at a hard ceiling (e.g. 3× threshold) or on user action. Clear the race timer on every chunk (today every chunk leaks one) and cancel the orphaned provider stream when aborting.
- **Timeout errors get context:** when `waitForProcess` kills at timeout, the error card states elapsed time, last activity, and suggests autonomous mode / timeout setting — instead of a bare "Process timeout".

## Implementation Phases

> Phases 1→3 are ordered (manifest → de-branding → anatomy). Phases 4–7 are independent of each other once Phase 1 lands; Phase 7 (heartbeat) and Phase 6 (#28) touch almost nothing from Phases 2–3 and can be pulled forward if quick wins are wanted.

### Phase 1 — Capability model + Provider Manifest (extension side)

1. **Modify `src/providers/base/IProvider.ts`:** extend `ProviderCapabilities` with `thinkingStyle`, `thinkingLevelEffective`, `planMode`, `sessionKind`, `emitsToolResults`, `emitsUsage`, `modelSelection`, `supportsChannels?`; delete `supportsVisualTesting` (or wire it — see Open Question 4). Add `ProviderManifestEntry` + `ProviderSettingsSection` types.
2. **Modify all 12 provider files** (`src/providers/*/​*Provider.ts`): set the new capability fields per the verified matrix (claude: `streamed`/`cli-resume`/native plan; codex/cline/qwen/opencode/openclaw: `complete-blocks`; gemini/copilot/cursor/ollama/localai: `none`; sessionKind: claude/gemini/opencode `cli-resume`, codex/cline/copilot `prompt-history`, qwen `cli-resume` (noting the F8 caveat), cursor/ollama/localai `none`; `emitsToolResults: false` for ollama/localai/copilot; `emitsUsage: false` for openclaw; `modelSelection: 'custom-only'` for ollama/localai/opencode, `'none'` for cline/openclaw). Also correct the lying flags: copilot `supportsToolUse: false`, ollama `supportsImages: false` (until provider-layer work wires images — flag/reality alignment is also tracked in `plans/00-findings-and-github-triage.md` Batch 3.5).
3. **Create `src/providers/base/ProviderManifest.ts`:** `buildProviderManifest(registry: ProviderRegistry): ProviderManifestEntry[]` — merges registry config, capabilities, models, `customModelSettingKey`, display metadata (move color/icon/shortId here from the webview registries), `settingsSections` (declare: codex → profile text field; ollama/localai → endpoint fields; openclaw → gateway URL; cursor → API key note).
4. **Modify `src/providers/ChatViewProvider.ts`:** include `providerManifest` in `_sendInitialState` payload and post a `manifestUpdated` message on provider availability/setting changes. Replace the read-side `providerModelKeys` (`:448-459`) with a manifest lookup.
5. **Modify `src/managers/BrainstormManager.ts` (`AGENT_STYLES`, :35) and `src/managers/MentionRouter.ts` (`AGENT_DISPLAY_NAMES`, :35):** derive display names/colors from `ProviderManifest` instead of local literals (keep style *prompts* local — only identity metadata moves).
6. **Modify `src/types.ts`:** add `kind` to `ToolCall` (`:87-94`); add `streamStatus`/`agent_status` chunk types (used in Phase 7); optionally begin the `WebviewMessage` discriminated union for the new messages (`manifestUpdated`, `streamStatus`) so new contracts are typed even if legacy ones stay loose.

**Acceptance:** webview receives a manifest with all 11 registered providers; `npm run compile` + `npm run lint` clean; no UI change yet.

### Phase 2 — Kill provider-name branching (webview + ChatViewProvider de-branding)

1. **Modify `src/webview/webviewContent.ts`:** store the manifest in `state.providerManifest` on `initialState`/`manifestUpdated`; add `getManifestEntry(id)` helper.
2. **W1 — `:11984`:** thinking selector visibility from `capabilities.thinkingStyle !== 'none'`; render as "advisory" (subtle label) when `thinkingLevelEffective === false`.
3. **W5/W6/W7 — `:9402-9412, 12251-12261, 12270-12280, 14478-14483, 9417, 12299, 14714, 14932`:** delete the three display registries, the 6-entry icon map, and the 4 OpenAI-logo special cases; all consumers read manifest entries (`themeAwareLogo` flag covers the OpenAI case).
4. **W8 — `:10531-10532`:** normalize suggestion data to full provider IDs at the source (`SuggestionManager` payloads); delete the alias map.
5. **W9/W10 — `:11893, :12322, :14703`:** iterate `state.providerManifest` for both settings dropdowns and the brainstorm default pair (first two available providers, or a manifest-declared default).
6. **W4 — `:12219-12224, :15257-15263`:** replace `codexSettingsSection` with a generic `renderProviderSettingsSections(entry)` that renders each manifest `settingsSections` item (text/number/select inputs bound to setting keys); Ollama/LocalAI endpoints and OpenClaw gateway move into the same panel.
7. **Modify `src/providers/ChatViewProvider.ts`:**
   - C1: delete the write-side `providerModelKeys` (`:3607-3618`); use `manifest.customModelSettingKey` (fixes the silent qwen-code drop).
   - C2: replace the three `allAgentIds` arrays (`:640, :869, :3671`) with `this._providerManager.getAllProviderIds()` (add that accessor to `src/managers/ProviderManager.ts` if absent).
   - C3: `:926` post the panel's actual provider ID on `shutdownAgent`.
   - C4: `:2820` gate the channel-delegate path on `capabilities.supportsChannels`.
   - C5: extract `DEFAULT_PROVIDER = 'claude-code'` into `src/constants.ts`; replace the 5 literals.
8. **C7 — modify `src/managers/SlashCommandManager.ts:81`:** map legacy `/compact` to a provider-neutral `cmd:compact`; in `ChatViewProvider`, route `cmd:compact` through `CompactionManager` which already branches on `supportsNativeCompact`.
9. **Add a CI guard:** a script (`scripts/check-provider-literals.js`, wired into `npm run lint`) that fails if provider-ID literals appear in `webviewContent.ts` outside an allowlisted manifest/bootstrap block.

**Acceptance:** grep for the 11 provider IDs in `webviewContent.ts` render logic returns ~0 hits; thinking selector hidden for gemini/copilot/cursor/ollama/localai; install modal shows icons for all providers; custom Qwen model persists.

### Phase 3 — Normalized message anatomy + stream conformance

1. **Modify `src/types.ts` + `src/managers/ConversationManager.ts`:** persist render-relevant structure — extend `Message` with `provider`, `model`, `toolCalls`, `thinking`, `segments`; extend `addMessageToConversation` (`ConversationManager.ts:165-185`) to accept them; write them in the `done` handler (`ChatViewProvider.ts:3045-3052`).
2. **Modify each provider's `parseStreamLine`** to stamp `ToolCall.kind` (reuse `classifyToolAction` from `src/utils/permissionClassifier.ts` plus per-provider name maps — coordinate with `plans/00-findings-and-github-triage.md` Batch 1.1's tool-name normalization (B1/B6) so the mapping is written once, in `src/utils/toolNames.ts`, consumed by both the gate and the renderer).
3. **Stream conformance fixes (per-provider):**
   - `src/providers/cursor/CursorProvider.ts:469-493`: map `result.rejected` → `status: 'failed'`; `:524-527`: stop emitting parser-level `done`.
   - `src/providers/openclaw/OpenClawProvider.ts:446-448`: stop emitting parser-level `done`.
   - `src/providers/qwen/QwenCodeProvider.ts:395-413`: drop the `assistant`-event `tool_use` emission (mirror Claude's parser, fixes both the multi-tool drop and double permission gating).
   - `src/providers/codex/CodexProvider.ts:632-646`: remove/narrow the `**…**`-to-thinking heuristic (only treat as thinking when the event is a reasoning item, never plain agent text).
   - `src/providers/ollama/OllamaProvider.ts` + `localai/LocalAIProvider.ts`: either emit synthetic `tool_result` (status `completed`, note "not executed") right after `tool_use`, or rely on `emitsToolResults: false` auto-resolution in the webview — pick one, document it.
4. **Webview unified renderer — modify `src/webview/webviewContent.ts`:**
   - One `renderThinkingZone(style)` collapsible component replacing the W2 fork (`:15680`) and the W3 brainstorm fork (`:14774`): `streamed` appends deltas, `complete-blocks` appends block paragraphs into the same collapsible.
   - One `renderMessageFooter(usage, sessionInfo, degradationPills)` used by live `done` handling and restored messages; auto-resolve running tool cards when `emitsToolResults === false`.
   - Per-message header model chip reads the message's persisted `provider`/`model` (fixes `:15564` showing the currently selected model).
   - Rewrite restored-message rendering (`addMessage`, `:15551-15602`) to replay segments/toolCalls/thinking through the same components used live.
   - `formatToolSummary` (`:15776-15821`) keys off `ToolCall.kind` first, raw name second.
5. **Handle `exit_plan_mode` — modify `src/providers/ChatViewProvider.ts`:** add a case in the `_handleSendMessage` chunk switch (`:2792-3179`) routing it into the existing plan-selection UI (`PlanOptionManager` / `planFilePath` card); add the corresponding webview handler.
6. **Tests:** add NDJSON fixture tests per provider parser (recorded real CLI output) to the **existing vitest setup under `tests/providers/`**, asserting the normalized contract: every `tool_use` eventually resolved, exactly one `done`, `kind` present, no thinking/body cross-contamination. (Test infrastructure already exists — `tests/` has managers/, providers/, integration/, webview/ suites and `npm test` runs vitest on Node 20+; CLAUDE.md's "tests not yet implemented" note is stale, per `github-triage.md` and `plans/00-findings-and-github-triage.md`. Do not re-scaffold or replace it.)

**Acceptance:** the same scripted transcript (text + thinking + 2 tools + usage) renders pixel-comparable across claude/codex/qwen/cursor fixtures; reload of a conversation shows tool cards, collapsible thinking, and correct model attribution.

### Phase 4 — Graceful degradation + composer gating

1. **Modify `src/webview/webviewContent.ts`:**
   - Composer: disable image/file attach buttons from `capabilities` with explanatory tooltips (send-time strip at `ChatViewProvider.ts:2687-2718` remains as safety net).
   - Footer/degradation pills per the design table: "Stateless", "History replayed (last 10)", "usage n/a", "advisory thinking", "~" marker on the context pie when the model lacks `contextWindow`.
   - Context bar: reset stored usage display on `providerChanged`/`manifestUpdated`; hide when `emitsUsage === false`.
   - Agent picker: capability pills (sessions / thinking / images / plan) so users can answer "what can this agent do?" from the UI.
2. **Modify `src/providers/ChatViewProvider.ts`:** post a usage-reset message on provider switch; include `contextWindow`-known flag with usage payloads.
3. **Modify `src/managers/ProviderManager.ts` (`:165-175`):** tag the 200k fallback as `estimated: true` so the UI can render "~".

**Acceptance:** switching to OpenClaw blanks the context bar instead of showing Claude's numbers; Codex composer shows a disabled image button with tooltip; Cursor footer shows "Stateless".

### Phase 5 — Session/resume + compaction UX honesty

1. **Remove fabricated `session_active` IDs:** `src/providers/copilot/CopilotProvider.ts:313-316` (also stop passing the fake ID to `--resume` at `:386-390` — minimal defensive fix here even though full Copilot session work (B5) is in `plans/00-findings-and-github-triage.md` Batch 2.4), `cursor/CursorProvider.ts:640-643`, `cline/ClineProvider.ts:803-806`, `openclaw/OpenClawProvider.ts:628-632`. Providers emit `session_active` only with CLI-issued IDs.
2. **Modify `src/webview/webviewContent.ts`:** replace the bare green dot with the footer session pill driven by `sessionKind` + last real session ID (truncated, tooltip with full ID and an explanation of the resume semantics).
3. **Compaction parity:** ensure the compaction event card renders identically for native and client-summarize (verify `CompactionManager` emits the same `compactionEvent` shape for both); surface "compaction unavailable (no usage data)" pill when `emitsUsage === false`.
4. **Coordinate (do not fix here):** Qwen `--continue` cross-panel bleed (F8 = B9, `plans/00-findings-and-github-triage.md` Batch 1.3), Cursor statelessness (F7 = B8, Plan 00 Batch 2.4), Codex no-resume (F15, alongside Plan 00 Batch 2.4's B11/`spawnAndStream` work); once fixed there, only the `sessionKind` value in Phase 1's matrix changes.

**Acceptance:** no provider shows a session indicator without a real CLI session ID; users can tell from the footer how continuity works for the active agent.

### Phase 6 — Model/agent switcher with per-agent config persistence (#33) 

1. **Modify `src/providers/ChatViewProvider.ts`:**
   - Add `_lastModelByProvider` backed by `globalState` key `mysti.lastModelByProvider` (and `mysti.lastThinkingLevelByProvider`).
   - In `_handleUpdateSettings` model-change path: record `{ [provider]: model }`.
   - In the provider-switch path (`:3567-3599`): before falling back to `defaultModel`, restore `lastModelByProvider[newProvider]` if it's in the new provider's model list.
   - `_getPanelModel` (`:351-366`): when the stored model is invalid for the provider, consult the per-provider memory before resetting to default.
2. **Modify `src/webview/webviewContent.ts`:** settings panel — when the user switches the agent being configured, re-request that agent's settings (`customModel`, sections values, remembered model) from the extension instead of reusing in-memory state; dropdown visibility/contents from `modelSelection` + manifest `models`.
3. **Surface "model ignored" feedback:** when `modelSelection` is `'none'` (Cline/OpenClaw) show "model configured via `<cli>` config" in place of the dropdown; when a provider drops a non-member model (Gemini/Codex pass-if-member semantics) post an info toast naming the model actually used.
4. **Migration:** on first activation with the new code, seed `lastModelByProvider` from the current `mysti.defaultModel` + per-provider custom-model settings.

**Acceptance:** repro from #33 passes — Claude=Opus 4.6 → configure Codex → back to Claude still shows Opus 4.6; per-panel overrides still win over the global memory.

### Phase 7 — Context affordances (#28)

1. **Modify `src/webview/webviewContent.ts`:** add handlers for `activeFileChanged` / `selectionChanged` (currently dead-ended from `extension.ts:499-531`): render an "Active context" chip row above the composer (file name; `path:start-end` for selections), a quick toggle pill bound to auto-context, and a "pin" action per chip that sends `addToContext`.
2. **Modify `src/managers/ContextManager.ts`:** add `getAutoContextItems(panelId): Promise<ContextItem[]>` that reads the active editor file/selection fresh (marked `ephemeral: true`); fix the `'default'` vs `'sidebar'` bucket mismatch (make the default bucket constant equal the sidebar panel ID, or require explicit panelId).
3. **Modify `src/providers/ChatViewProvider.ts` (`_handleSendMessage`):** when `contextMode === 'auto'`, merge `getAutoContextItems(panelId)` into the prompt context (deduped against manually added items); include the auto items in the context summary shown on the user message.
4. **Modify `src/extension.ts` (`:499-531`):** route the events to the *focused* panel(s) rather than broadcast-only `postMessage`, and debounce selection events (250ms) to avoid spam.
5. **Settings:** keep `mysti.autoContext` as the backing setting; the toggle pill and the settings `contextMode` stay in sync (both already read/write `autoContext`, `ChatViewProvider.ts:3539`).

**Acceptance:** with auto-context on, switching editor tabs updates the chip; sending a message includes the open file without manual adds; the toggle pill disables it in one click. Closes #28.

### Phase 8 — Streaming status / heartbeat (#31)

1. **Modify `src/providers/ChatViewProvider.ts`:** in the stream loop of `_handleSendMessage`, track `lastChunkAt` + `lastChunkType`/`toolName` per panel; run a 10s interval (cleared in `finally`) that posts `streamStatus { phase, silentMs, elapsedMs, toolName? }` when silence > 10s.
2. **Modify `src/webview/webviewContent.ts`:**
   - Render the status line under the streaming bubble from `streamStatus`; clear it on any new chunk.
   - Fix the cancel affordance: introduce `state.isStreaming` separate from `isLoading`; keep the Stop button visible until `done`/error/cancel (today killed at first chunk, `:15654`).
3. **Modify `src/constants.ts:80`:** raise `BRAINSTORM_SILENCE_TIMEOUT_MS` to `5 * 60 * 1000`; add `BRAINSTORM_SILENCE_HARD_LIMIT_MULTIPLIER = 3`.
4. **Modify `src/managers/BrainstormManager.ts` (`_iterateWithSilenceTimeout`, `:838-853`):**
   - Clear the race timer on every resolved `next()` (stop the per-chunk timer leak).
   - Warn-then-wait semantics: at the soft threshold yield an `agent_status` chunk (new `BrainstormStreamChunk` type) instead of throwing; throw only at the hard ceiling; on abort, call the provider's `cancelCurrentRequest` for the orphaned stream (today it streams on unobserved).
   - Read `mysti.brainstorm.silenceTimeout` (new setting, add to `package.json` with default 300s, 0 = disabled).
5. **Modify `src/webview/webviewContent.ts` (brainstorm timeline):** render `agent_status` chunks as inline "⏳ still waiting" notices with elapsed time and a per-agent Stop.
6. **Modify `src/providers/base/BaseCliProvider.ts` (`waitForProcess` timeout error, `:1154-1166`):** enrich the timeout error message with elapsed time and a hint about `mysti.*` timeout settings/autonomous mode. (The F3 `session.autonomousMode` inconsistency is **not** a motivating bug — `plans/00-findings-and-github-triage.md` §"Investigated, not a bug" refuted the "autonomous runs die at 5 min" impact; its cleanup stays an opportunistic part of Plan 00 Batch 2.4's `spawnAndStream` harness extraction. This task is purely about making the rare post-EOF timeout error informative.)
7. **Add to `package.json`:** `mysti.brainstorm.silenceTimeout` setting declaration.

**Acceptance:** repro from #31 no longer aborts — a Codex agent silent for 2 minutes shows a waiting notice and completes; main chat shows "running Bash — 45s" during long tools; Stop works mid-stream at any point. Closes #31.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `webviewContent.ts` is an 18.7k-line string-embedded monolith with zero tests — Phase 2/3 edits are high-regression-risk. | Replace seams one at a time behind the manifest (each seam is independently shippable); add the provider-literal CI guard immediately so regressions can't creep back; land Phase 3's renderer with side-by-side fixture screenshots for claude/codex/qwen/cursor. Consider extracting the script to a real `.js` asset first if churn proves painful (Open Question 2). |
| Manifest/webview version skew: a cached webview (retainContextWhenHidden) may receive new messages it doesn't understand or lack the manifest. | Manifest carries a `schemaVersion`; webview falls back to a minimal built-in default entry per provider when an ID is missing; all new messages are additive. |
| Changing `session_active` emission (Phase 5) breaks code that keys off the green dot or session IDs (ChannelBridge `isRunning`, compaction keys). | Grep all `session_active`/`sessionId` consumers before removal; keep emitting `session_active` with `sessionId: undefined` + `sessionKind` so consumers needing a "stream started" signal still get one. |
| Persisting toolCalls/segments/thinking grows `globalState` (already flagged as unbounded by the performance research). | Cap persisted tool output per call (e.g. 4KB) and segments per message; coordinate with `plans/03-performance-optimization.md`'s persistence pruning so the schemas are designed once. |
| Tool-name normalization overlaps with the permission-gate fix in `plans/00-findings-and-github-triage.md` Batch 1.1 — two teams editing the same maps causes conflicts or, worse, divergent classifications. | Single shared module `src/utils/toolNames.ts` (canonical name + kind per provider) consumed by both `permissionClassifier` and the renderer; whichever plan lands first creates it, the other consumes it. |
| Capability values are wrong for some provider edge cases (e.g. a CLI update adds thinking output). | Capabilities are data: keep them in provider files near the parser they describe; fixture tests per provider assert "declared capability ⇔ observed chunk types". |
| Warn-then-wait in brainstorm could let a genuinely hung CLI run forever. | Hard ceiling (3× soft threshold) still aborts; per-agent Stop button; heartbeat makes the hang visible so users act instead of waiting blind. |
| Per-provider model memory (#33) interacts with per-panel `settingsOverrides` and brainstorm's `getProviderDefaultModel` path. | Precedence documented and tested: panel override → per-provider memory → global default → provider default. Brainstorm keeps using provider defaults (unchanged). |
| Codex `**…**` heuristic removal (Phase 3.3) may regress Codex thinking display for CLI versions that emit reasoning as bold text lines. | Gate the change on event type rather than deleting outright; keep a fixture from the current CLI version to verify both shapes. |

## Dependencies

References below use the final plan filenames and Plan 00 batch numbers (note: there is no separate "provider reliability" or "security" plan — those fixes live in `plans/00-findings-and-github-triage.md`'s remediation batches; `plans/01-automatic-model-updates.md` is the model-discovery plan):

- **`plans/00-findings-and-github-triage.md` Batches 1–2 (provider lifecycle & session correctness):** owns the real fixes for Copilot fabricated `--resume` (F4 = B5, Batch 2.4), Qwen `--continue` bleed (F8 = B9, Batch 1.3), Cursor statelessness (F7 = B8, Batch 2.4), Codex no-resume (F15, alongside Batch 2.4's B11 work), and Copilot JSON/tool output (Batch 1.1/2.4). The "autonomous timeout collapse" (F3) is **not** on that list — Plan 00's §"Investigated, not a bug" refuted its user-facing impact; the `autonomousMode` flag inconsistency is opportunistic cleanup inside Batch 2.4's shared `spawnAndStream` harness. **This plan does not block on Plan 00** — Phase 5 makes the UI honest about current behavior; when those fixes land, only the `sessionKind`/`emitsToolResults` values set in Phase 1 get updated. Phase 8's `waitForProcess` message enrichment touches the same function as the Batch 2.4 harness work — sequence whichever lands second as a rebase.
- **`plans/00-findings-and-github-triage.md` Batch 1.1 (fail-closed permission gate + tool-name normalization, B1/B6):** the fail-closed gate fix and this plan's `ToolCall.kind` normalization must share `src/utils/toolNames.ts` (see Risks). The gate fix should land **first or together** — Phase 3 makes more tool names canonical, which incidentally widens gate coverage, but must not be the only thing closing the bypass.
- **`plans/00-findings-and-github-triage.md` Batch 1.2 (wizard `panelId=null` fix, B2):** owned entirely by Plan 00 — **not** by this plan. (`plans/03-performance-optimization.md` Phase 3.3 points at "the chat-UX plan" for this fix; that pointer is wrong — executors should go to Plan 00 Batch 1.2.) This plan's webview/`ChatViewProvider` edits must simply rebase over it if Batch 1.2 lands second.
- **`plans/01-automatic-model-updates.md` (dynamic model discovery):** the manifest's `models[]` is the natural delivery vehicle for runtime-discovered model lists; Phase 1 should define `models` as "whatever the registry returns" so that plan can swap static arrays for `getModels()` without webview changes. Phase 6's `modelSelection` semantics also pre-stage its UX. (Plan 01's Dependencies call this plan the "provider-layer hardening plan" home for F18 dropdown wiring — confirmed: Phase 6.3 here hides/labels the no-op dropdowns; routing `settings.model` into Ollama/LocalAI request bodies is Plan 01 Phase 3.)
- **`plans/03-performance-optimization.md`:** the streaming render throttle (full `marked.parse` per token) and persistence pruning intersect with Phase 3's renderer and message persistence. Phase 3 should adopt that plan's throttled-render helper if it lands first; otherwise design Phase 3's `updateCurrentContentSegment` changes to be throttle-friendly (append-only segment model).
- **No dependency** on `plans/05-canvas-overhaul.md` or `plans/04-connections-and-agent-management.md`.

## Effort Estimate

| Phase | Scope | Estimate |
|---|---|---|
| 1 — Capability model + manifest | types + 12 provider files + manifest module + initialState | **M** |
| 2 — Kill name branching | ~17 seams across webview + ChatViewProvider + CI guard | **L** |
| 3 — Message anatomy + conformance | persistence schema, 5 parser fixes, unified renderer, restore parity, fixture tests in existing vitest suite | **L** |
| 4 — Graceful degradation + composer | pills, composer gating, context-bar reset | **S–M** |
| 5 — Session/compaction honesty | remove fake IDs, session pill, /compact routing | **S–M** |
| 6 — Switcher + per-agent config (#33) | per-provider memory + settings panel reload + migration | **M** |
| 7 — Context affordances (#28) | webview handlers, ephemeral auto-context, toggle pill, bucket fix | **M** |
| 8 — Heartbeat (#31) | streamStatus loop, status line, brainstorm warn-then-wait, Stop fix | **M** |

Suggested delivery order for user impact: **8 and 7 first** (both close promised issues with no Phase 1 dependency), then 1 → 2 → 3 (the structural arc), then 6, 5, 4.

## Open Questions

1. **Manus:** is it being revived (it's the forcing function for non-streaming/non-tool degradation rules) or deleted? If revived, it should enter via the manifest with `supportsStreaming: false` and exercise the progress-card path; if deleted, remove `ManusProvider`, its constants, and the "12 backends" claims in CLAUDE.md/README. (Provider plan decision; affects Phase 1 capability matrix only.)
2. **Webview extraction:** do we split `webviewContent.ts` (move the embedded script to a real `resources/*.js` asset, enabling lint/tests) *before* Phase 2, or live with string-embedded edits one more cycle? Extraction is ~2-3 days of mechanical risk that pays off across Phases 2-4 and the performance plan.
3. **Where does per-provider model memory live** — `globalState` (proposed; machine-local, no Settings-Sync conflicts) or a `mysti.modelByProvider` object setting (sync-able, user-editable, but merge-conflict-prone)? Proposal: globalState now; revisit if users ask for sync.
4. **`supportsVisualTesting`:** wire it (gate the visual-testing slash command/dashboard per provider) or delete the flag? Depends on Visual Testing v2 direction.
5. **Brainstorm hard ceiling default:** is 3× the soft threshold (15 min at the new 5-min default) acceptable for long Delphi rounds, or should brainstorm inherit the autonomous 4h ceiling when autonomous mode is on?
6. **`WebviewMessage` typing scope:** Phase 1 types only the *new* messages. Full discriminated-union migration of all existing message types is valuable but large — separate cleanup task or fold into the webview extraction (Q2)?
7. **Restored-conversation migration:** old persisted messages lack `provider`/`model`/`toolCalls`. Render them with an "(unknown model)" chip, or backfill `provider` from the conversation-level default at migration time?
