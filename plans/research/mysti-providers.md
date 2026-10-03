# Mysti Provider Layer Review

Scope: `src/providers/base/` (BaseCliProvider, IProvider), `src/providers/ProviderRegistry.ts`, all 12 provider directories (claude, codex, gemini, cline, copilot, cursor, openclaw incl. OpenClawGateway, opencode, qwen, ollama, localai, manus), plus the parts of `ProviderManager.ts`, `ChatViewProvider.ts`, `utils/platform.ts`, `utils/validation.ts`, and `package.json` that the provider layer depends on. Reviewed against the working tree on branch `feature/visual-testing` (uncommitted Canvas v2 changes included).

All file paths below are relative to `/Users/bahaabunojaim/Documents/GitHub/Mysti`.

---

## 1. Findings

### F1 (HIGH) — `ChildProcess.killed` misused: every SIGKILL escalation is dead code; processes can leak

`subprocess.killed` becomes `true` as soon as `kill()` *successfully sends* a signal — not when the process exits. Every grace-period force-kill in the codebase checks `!processToKill.killed` *after* `kill('SIGTERM')` has already been called on the same object, so the condition is always false and SIGKILL never fires.

- `src/providers/base/BaseCliProvider.ts:1030-1037` (single-shot finally):
  ```ts
  session.process.kill('SIGTERM');
  const processToKill = session.process;
  setTimeout(() => {
    if (processToKill && !processToKill.killed) {   // always false after kill() above
      processToKill.kill('SIGKILL');
    }
  }, PROCESS_KILL_GRACE_PERIOD_MS);
  ```
- Same pattern: `BaseCliProvider.ts:1157-1166` (`waitForProcess` timeout), `BaseCliProvider.ts:671-677` (`disposePersistentProcess`), `cline/ClineProvider.ts:835-844`, `copilot/CopilotProvider.ts:349-357`, `managers/ProviderManager.ts:288-297`.
- Related: `BaseCliProvider.dispose()` (`:202-211`) and several cleanup paths guard with `if (proc && !proc.killed)`, which *skips* killing a process that already received a signal but ignored it.

Impact: any CLI that ignores/blocks SIGTERM (busy native binary, stuck in tool execution, suspended grandchild) survives forever; the "Force killing leaked process" log lines can never print. Fix: track liveness with `proc.exitCode === null && proc.signalCode === null`, or set a flag from the `exit` event, and clear the timer on exit.

### F2 (HIGH) — Persistent-mode fallback can re-send a message (including after user cancel)

`src/providers/base/BaseCliProvider.ts:852-882`:

```ts
let chunkCount = 0;
for await (const chunk of this._sendViaPersistentProcess(...)) { chunkCount++; yield chunk; }
usedPersistent = chunkCount > 0;
...
if (usedPersistent) { ... return; }
// Fall through to single-shot below
yield* this._sendSingleShot(...);
```

Two failure modes, both confirmed in code:
1. **Cancel → resend.** `_cancelSessionRequest` (`:287-295`) interrupts the persistent process and nulls `session.process`; `_readUntilBoundary` then breaks with zero chunks. `usedPersistent` is false, so `sendMessage` falls through and **re-spawns single-shot with the same prompt the user just cancelled**.
2. **Mid-stream exception → duplicate send.** If an exception escapes after some chunks were already yielded (e.g. `prepareAttachments`/`buildPromptAsync` reject, `stdin.write` throws on a destroyed pipe), the `usedPersistent = chunkCount > 0` line is never reached, the catch swallows the error, and the same message is sent again via single-shot — duplicated output and potential double execution of mutating instructions.

Only Claude Code enables `supportsPersistentProcess` today, so this is a Claude-path bug. Fix: set `usedPersistent = true` as soon as the first chunk is yielded; treat "cancelled" as terminal (check a cancellation flag before falling back).

### F3 (HIGH) — Autonomous mode timeout broken for 5 providers (4h becomes 5min)

`waitForProcess` picks the timeout from `session.autonomousMode` (`BaseCliProvider.ts:1154`), which is set **only** in the base `sendMessage` (`:848`). Codex (`codex/CodexProvider.ts:344-428`), Cline (`cline/ClineProvider.ts:685-858`), Copilot (`copilot/CopilotProvider.ts:245-370`), Cursor (`cursor/CursorProvider.ts:564-673`) and OpenClaw CLI fallback (`openclaw/OpenClawProvider.ts:653-729`) all override `sendMessage` and never set `session.autonomousMode`, yet all of them flow through `waitForProcess`. Long autonomous runs on these providers are killed at `PROCESS_TIMEOUT_MS` (5 min) instead of `AUTONOMOUS_PROCESS_TIMEOUT_MS` (4 h), surfacing as "Process timeout" errors mid-task.

### F4 (HIGH) — Copilot: fabricated session ID is passed to `--resume`; every follow-up message is broken

`copilot/CopilotProvider.ts:313-316` invents an ID purely for the UI indicator:

```ts
if (!session.sessionId) {
  session.sessionId = `copilot-${panelId || 'default'}-${Date.now()}`;
}
yield { type: 'session_active' as const, sessionId: session.sessionId };
```

but `buildCliArgs` (`:386-390`) then treats it as a real CLI session:

```ts
if (session.sessionId) {
  args.push('--resume', session.sessionId);   // "copilot-default-1760..." — Copilot CLI never issued this
}
```

From the second message of any Copilot conversation onward, the CLI is asked to resume a session it has never seen. At best the flag is rejected/ignored; either way the resume logic is fiction, while the full conversation history is *also* re-sent in the prompt. Fix: never feed locally-generated IDs into `--resume`; only use IDs parsed from CLI output (the JSON `init` branch at `:479-485` that today never fires).

### F5 (HIGH) — Copilot: permission gate cannot fire, but CLI permissions are bypassed with `--allow-all-tools`

`copilot/CopilotProvider.ts:453-456` pushes `--allow-all-tools` for *every* non-read-only mode/access combination "because the stream gate handles UI prompts". But Copilot CLI emits **plain text** (`:459-575` — the JSON `tool_use` branch is explicitly speculative: "in case Copilot CLI adds JSON support in future"), so `parseStreamLine` never produces `tool_use` chunks and the gate in `ChatViewProvider.ts:2863-2917` never triggers. Net effect: with `accessLevel: ask-permission` or mode `ask-before-edit`, Copilot executes shell commands and file writes with **no approval anywhere** (CLI prompts disabled, webview gate blind). The read-only path (`--deny-tool shell/write`, `:432-437`) is fine. Fix: for the ask-tier combinations use Copilot's approval-tool flags (or deny-by-default plus prompt-level instructions) instead of `--allow-all-tools`.

### F6 (HIGH) — Cline: `.clinerules` workspace file can be permanently clobbered

`cline/ClineProvider.ts:908-949` backs up the user's `.clinerules` into the panel session, overwrites the file with Mysti-generated instructions, and restores it in `finally`. Two confirmed loss scenarios:
1. **Concurrent panels**: panel A writes its instructions; panel B (separate `ClineSessionState`) then "backs up" *A's injected content* as if it were the user's file. Restore order then leaves either A's or B's generated instructions on disk as the new ".clinerules". The per-session backup gives no cross-panel mutual exclusion.
2. **Crash / window close mid-request**: `finally` never runs; user's `.clinerules` is silently replaced.

This is user data in the workspace (often committed to git). Fix: write instructions to a temp rules file Cline also reads (e.g. `.clinerules/` directory entry with a mysti-prefixed name) or guard with a global mutex + restore-on-activation journal.

### F7 (HIGH) — Cursor: multi-turn conversations have no context at all

`cursor/CursorProvider.ts:564-588`: `_conversation` is deliberately discarded (`buildPromptAsync(content, context, null, ...)`, comment: "Cursor manages its own context"), `supportsSessions` is `false`, and no `--resume`/chat-id flag is passed — yet each message spawns a fresh `agent --print` process. There is nothing managing context: the second message in a Cursor chat knows nothing about the first. The fake `session_active` (`:640-643`) makes the UI show a live session, compounding the confusion. Fix: either pass conversation history into the prompt (like Cline/Codex) or use the Cursor CLI's actual resume mechanism and store the real chat ID.

### F8 (HIGH) — Qwen: `--continue` resumes the *globally most recent* session — cross-panel/window session bleed

`qwen/QwenCodeProvider.ts:188-191`:

```ts
if (session.sessionId) {
  args.push('--continue');     // no session ID passed!
}
```

The per-panel `session.sessionId` (carefully extracted at `:383-392`) is only used as a boolean. `--continue` tells the CLI to resume its latest session in that directory, so with two Mysti panels (or a terminal `qwen` session in the same repo) panel B resumes panel A's conversation. This directly violates the per-panel isolation design. Fix: use `--resume <sessionId>` equivalent if the Qwen CLI supports it, else disable resume and re-send history.

### F9 (HIGH) — OpenClaw Gateway: agent events are not scoped to a request — concurrent panels interleave responses

`openclaw/OpenClawGateway.ts:303-314`: `sendAgentMessage` subscribes a handler to the global event names `['agent','chat','stream','message','response']` and maps **every** payload into chunks, with no filtering by `runId`/`sessionKey` (the ack at `_handleMessage:771-777` even logs the runId but discards it). Two concurrent panels using the Gateway — or background ActiveMode traffic — push their deltas into *both* generators, mixing text between chats. Likewise `cancelAgent()` (`:413-421`) sends `agent.stop` with empty params, and `OpenClawProvider.cancelCurrentRequest` (`OpenClawProvider.ts:734-739`) calls it for any panel's cancel — cancelling every panel's run. Fix: capture `runId` from the ack and filter events/cancellations by it.

### F10 (HIGH) — Codex: `agentConfig` and `attachments` silently dropped; deprecated prompt builder used

`codex/CodexProvider.ts:344-352`: the `sendMessage` override only declares 7 parameters — `agentConfig` (personas/skills) and `attachments` are never received. It then calls the deprecated sync `buildPrompt` (`:297-336`) which has no agent-instruction support. Result: the entire three-tier persona/skill system and file attachments are no-ops on Codex with no warning to the user. (Cursor/Copilot/Cline/OpenClaw do accept `agentConfig` and route through `buildPromptAsync`.) Fix: extend the signature and switch to `buildPromptAsync`.

### F11 (MEDIUM) — Five overriding providers never attach an early `error` listener: spawn failure ⇒ unhandled `error` event

Base `_sendSingleShot` attaches an error handler immediately after `spawn` (`BaseCliProvider.ts:941-946`) precisely because spawn errors (ENOENT/EINVAL) are delivered asynchronously. The overrides do not:
- `codex/CodexProvider.ts:385-390` — no `error` listener until `waitForProcess` (which runs only after the stdout for-await ends).
- `cline/ClineProvider.ts:775-780`, `copilot/CopilotProvider.ts:277-281`, `cursor/CursorProvider.ts:619-623`, `openclaw/OpenClawProvider.ts:691-695` — same.

An `error` event on an EventEmitter without listeners throws `ERR_UNHANDLED_ERROR` as an uncaught exception in the extension host; at minimum the provider's own error handling/`auth_error` flow is bypassed and the user sees a hang or generic failure. Fix: replicate the base's early-error-capture pattern in every override (or refactor the overrides onto a shared spawn helper).

### F12 (MEDIUM) — Codex: no process kill in `finally`; abandoned generator orphans the CLI

`codex/CodexProvider.ts:421-427`:

```ts
} finally {
  session.process = null;          // no kill, unlike base/Cline/Copilot
  ...clearProcess(panelId);
}
```

If the consumer stops iterating early (error in ChatViewProvider, panel dispose, generator `.return()`), the codex process keeps running, and because `session.process` is nulled first, a later `cancelCurrentRequest(panelId)` can no longer reach it. Base, Cline, Copilot all kill in `finally`. Cursor and OpenClaw kill but without any SIGKILL escalation (`cursor/CursorProvider.ts:657-663`, `openclaw/OpenClawProvider.ts:717-723`) — see also F1. Fix: kill in `finally` like the base class.

### F13 (MEDIUM) — `_readUntilBoundary` can hang indefinitely after cancel (persistent mode)

`BaseCliProvider.ts:476-489`: the loop's cancellation check `if (session.process !== proc) break;` is only evaluated after `await new Promise(r => { waitResolve = r; })` resolves — and that promise is resolved solely by stdout `data` or process `close`. `_cancelSessionRequest` (`:287-295`) cancels by writing `\x03` to stdin and nulling `session.process`, but a CLI in `--input-format stream-json` mode is reading JSON lines, not a TTY: a raw ETX byte is not guaranteed to produce output or exit. If it doesn't, the generator (and the awaiting ChatViewProvider handler) hangs until the persistent process eventually says something. Fix: have `_cancelSessionRequest` also invoke the `waitResolve`-style wakeup (e.g. expose a per-session cancellation notifier), or send a structured interrupt message.

### F14 (MEDIUM) — `ManusProvider` is unreachable dead code while docs claim 12 backends

`providers/manus/ManusProvider.ts:48`: `// TODO: Manus provider is disabled — fix API key detection and HTTP polling before re-enabling`. It is not registered in `ProviderRegistry._registerBuiltInProviders()` (`ProviderRegistry.ts:45-101` registers exactly 11), `'manus'` is absent from `ProviderType` (`src/types.ts:18`), yet CLAUDE.md and constants (`MANUS_API_BASE_URL`, `MANUS_POLL_INTERVAL_MS`) present it as the 12th backend. Inside the dead code: the poll loop (`:243-288`) has **no max-attempt/overall timeout** — an API that keeps answering `running` (or an unknown status, `:284-287`) polls forever. Fix: either register it behind a feature flag with the poll cap added, or delete it and update docs.

### F15 (MEDIUM) — Codex `supportsSessions: true` but resume is never used

`codex/CodexProvider.ts:146` claims session support and `_parseCodexEvent` stores `thread_id` + emits `session_active` (`:590-595`), but `_buildCodexArgs` (`:441-467`) never emits `exec resume <id>` or any session flag. Every message is a brand-new thread; continuity comes only from the 10-message history re-sent in the prompt, while the UI shows an active session. Same *pattern* (fake/unused session) appears in Cline (`cline-<panel>-<ts>`, `ClineProvider.ts:803-806`), Cursor (`cursor-...`, `CursorProvider.ts:640-643`), OpenClaw gateway (`openclaw-gw-...`, `OpenClawProvider.ts:628-632`). Copilot is the dangerous variant (F4) because its fake ID feeds back into CLI args.

### F16 (MEDIUM) — Qwen emits `tool_use` from `assistant` events — the exact double-gating bug Claude's parser documents and avoids

`claude/ClaudeCodeProvider.ts:567-576` has an explicit comment: emitting `tool_use` from the `assistant` event in addition to `content_block_stop` "would cause double-gating in the permission gate (two SIGSTOP/SIGCONT cycles per tool), leading to 'No response received from CLI' errors", so Claude returns `null`. Qwen uses the same stream protocol but emits a `tool_use` (with full input) from `assistant` events (`qwen/QwenCodeProvider.ts:396-413`) *in addition to* `content_block_start` and `content_block_stop` (`:282-329`). Since the gate skips only empty-input chunks (`ChatViewProvider.ts:2870`), both full-input chunks get gated → double SIGSTOP/permission card per tool on Qwen. Fix: mirror Claude's parser (drop the `assistant` branch tool_use emission).

### F17 (MEDIUM) — Windows: spawn of npm `.cmd` shims fails for providers that don't auto-enable shell

`getCommonSearchPaths` resolves Windows installs to `%APPDATA%\npm\<cli>.cmd` (`utils/platform.ts:137-142`). Node ≥18.20 throws `EINVAL` when spawning `.cmd`/`.bat` without `shell: true`. Base single-shot and persistent spawns auto-enable shell on win32 (`BaseCliProvider.ts:927`, `:550`). But:
- Codex: `shell: useShell` from config only (`codex/CodexProvider.ts:382-390`) — default false.
- Cline: hard-coded `shell: false` (`cline/ClineProvider.ts:779`, justified for argv safety — but then the `.cmd` path can never work).
- Cursor (`:619-623`), OpenClaw (`:691-695`): no shell option at all.
- `ClaudeCodeProvider.enhancePrompt` (`:776-780`): config only.

So Codex/Cline/OpenClaw installed via npm on Windows fail to spawn out of the box. Also note the base validates args for shell metacharacters in shell mode (`BaseCliProvider.ts:931-936`) but Codex does not, while passing `-c developer_instructions=<channel context>` (`CodexProvider.ts:363-366`) — an injection hazard if `useShellForCli` is enabled.

### F18 (MEDIUM) — Model selection is a silent no-op for Cline, OpenClaw, Ollama and LocalAI dropdowns

- Cline: 9-entry `config.models` list + `mysti.clineModel` setting exist, but the provider never reads either; `buildCliArgs` comment admits "Cline CLI has no per-request model flag" (`cline/ClineProvider.ts:315-318`). The dropdown and setting silently do nothing.
- OpenClaw: 3-entry model list; no `--model` flag anywhere in `buildCliArgs`/gateway params; `mysti.openclawModel` never read by the provider (only `ChatViewProvider.ts:451/3611` for UI echo).
- Ollama (`ollama/OllamaProvider.ts:205`) and LocalAI (`localai/LocalAIProvider.ts:210`) read **only** their custom settings (`mysti.ollamaModel` / `mysti.localaiModel`), ignoring `settings.model` — the dropdown (populated from a hardcoded guess-list of local models that may not even be installed) has no effect.

Users picking a model in the UI get no feedback that it was ignored. Fix: hide the dropdown for these providers or wire it up (Ollama/LocalAI can list real models via `/api/tags` / `/v1/models`, which both providers already call in `discoverCli`).

### F19 (MEDIUM) — `ProviderManager.cancelRequest` routes to the *currently active* provider, not the panel's provider

`managers/ProviderManager.ts:228-243`: cancel delegates to `this._getActiveProvider()` — the provider currently selected in settings. If the user switches providers (or a brainstorm pairs two providers) while a request is in flight, the cancel lands on the wrong provider object; the direct-kill fallback only runs if `_getActiveProvider()` *throws*. The per-panel process map (`_activePanelProcesses`) is deleted regardless, dropping the last handle to the still-running process.

### F20 (MEDIUM) — Cursor/OpenClaw parsers emit their own `done` chunk; `sendMessage` then emits a second one

`cursor/CursorProvider.ts:524-527` and `openclaw/OpenClawProvider.ts:446-448` return `{ type: 'done' }` from the parser; the surrounding `sendMessage` then yields the authoritative `done` (with usage) afterwards. Every other provider deliberately suppresses parser-level done ("Don't return done here - let sendMessage handle it", e.g. `CodexProvider.ts:608`, `GeminiProvider.ts:382`). Double `done` risks double-finalization in the webview (message closed, usage row duplicated).

### F21 (MEDIUM) — Ollama `supportsImages: true` but attachments never reach the API

`ollama/OllamaProvider.ts:92-99` advertises image support; `sendMessage` passes `attachments` into `buildPromptAsync` (`:217-219`), but the base implementation ignores `_attachments` (`BaseCliProvider.ts:1255`) and Ollama neither overrides `prepareAttachments` nor adds the Ollama API's `images` field to the request body (`:222-231`). Pasted images are silently dropped. Either set the flag to false or send base64 images via the chat API.

### F22 (MEDIUM) — Copilot/Cursor/OpenClaw pass the full prompt as a single argv element — OS arg-length limits

- Copilot: `args.push('-p', fullPrompt)` (`copilot/CopilotProvider.ts:273`).
- Cursor: `[...baseArgs, "-p", fullPrompt]` (`cursor/CursorProvider.ts:591`).
- OpenClaw CLI: `'--message', fullPrompt` (`openclaw/OpenClawProvider.ts:673`).

With a few large context files the prompt easily exceeds macOS's ~256 KB single-arg limit (E2BIG) and Windows's 32 K command-line limit. Cline solved this with a 200 K threshold + stdin fallback (`cline/ClineProvider.ts:740-747`); the other three have no fallback. Cursor additionally appends `--api-key <key>` to argv (`:616`), exposing the key in `ps` output (also stored in plaintext setting `mysti.cursorApiKey`).

### F23 (MEDIUM) — Codex stream-parse correctness issues

`codex/CodexProvider.ts`:
- `:716` — `isFailed = item.status === 'failed' || (item.exit_code !== null && item.exit_code !== 0)`: when an `item.completed` event lacks `exit_code` (undefined), `(undefined !== null && undefined !== 0)` is true → successful command rendered as **failed**.
- `:575-577` — non-zero exit only reported when *nothing* was yielded; a failure after partial output is silent. stderr is logged but never included in the error chunk, and there is no `isAuthenticationError`/`auth_error` path at all (base has one; Codex auth expiry shows as generic "exited with code N" or nothing).
- `:612` — `turn.failed` puts `event.error` (possibly an object) straight into `content` → "[object Object]".
- `:670-678` — `agent_message` has no started/updated/completed dedup (tools do, `:699-721`); if the CLI emits both `item.updated` and `item.completed` with full text, the text duplicates.
- `:61-72` — instance fields `_activeToolCalls`, `_completedToolCalls`, `_lastUsageStats` are dead leftovers from before the per-panel session refactor (all live state is on `CodexSessionState`); they look like per-panel isolation violations and should be deleted.

### F24 (MEDIUM) — Cline "ask" termination is unreachable while the CLI waits

`cline/ClineProvider.ts:811-815` kills the process "after ask message", but that code runs only after `processStream` returns, and `processStream`'s `for await` over stdout doesn't return while the process is alive holding stdout open. If the Cline CLI blocks awaiting an answer (its `ask` semantics), the request hangs until the 5-minute `waitForProcess` timeout instead of cleanly ending with the `ask_user_question` chunk that was already yielded (`:540-559`). The kill should happen from the parse site (or the consumer) the moment `askReceived` flips.

### F25 (LOW/MEDIUM) — Mid-line stream death renders raw JSON fragments as chat text

`BaseCliProvider.processStream` parses the leftover buffer at stream end (`:1096-1102`). If the process is killed mid-line, the fragment fails `JSON.parse` and Claude/Qwen/Codex/Copilot fall back to `return { type: 'text', content: line }` (`ClaudeCodeProvider.ts:631-636`, `QwenCodeProvider.ts:455-459`, `CodexProvider.ts:641-651`), so users see half a JSON object in the chat. Gemini/OpenCode filter via `_isDiagnosticLine` but still pass JSON-looking fragments. A cheap guard: suppress non-JSON fallback lines that start with `{"` or when the line is the tail buffer after a non-zero exit.

### F26 (LOW) — Attachment temp-file cleanup skipped on early generator exit (persistent path)

`BaseCliProvider._sendViaPersistentProcess` calls `attachmentCleanup()` *after* `yield*` (`:655-660`) instead of in a `try/finally` (the single-shot path does it correctly in `finally`, `:1047-1049`). If the consumer stops early or the stream throws, `.mysti/tmp/mysti-attachment-*` files leak in the user's workspace.

### F27 (LOW) — Gemini auth checks are internally inconsistent

`gemini/GeminiProvider.ts`: `getAuthConfig` treats the existence of `~/.gemini/settings.json` as authenticated (`:127-140`), while `checkAuthentication` requires `settings.auth || settings.security?.auth` keys inside it (`:142-174`) — a user logged in via OAuth (`oauth_creds.json`, which is never checked) with a plain settings file is reported unauthenticated by one method and authenticated by the other. Also `result.stats` usage fallback `input_tokens || total_tokens` (`:377`) inflates input tokens.

### F28 (LOW) — `enhancePrompt` implementations: no timeouts, copy-paste flags

- `claude/ClaudeCodeProvider.ts:761-805`: no timeout — a hung CLI keeps the promise pending forever; doesn't auto-enable shell on win32 (inconsistent with sendMessage).
- `cline/ClineProvider.ts:863-898`: uses `--print --output-format text` — flags copied from Claude; doesn't use `getEnrichedEnv()` so the `#!/usr/bin/env node` shim may not resolve. Fails closed (resolves original prompt) but the feature silently never works.
- `openclaw/OpenClawProvider.ts:768-800`: no timeout.

### F29 (LOW) — Cancel-all and dispose gaps for HTTP providers and the Gateway

- `OllamaProvider.cancelCurrentRequest()` / `LocalAIProvider.cancelCurrentRequest()` abort the `AbortController` only in the `if (panelId)` branch (`ollama/OllamaProvider.ts:331-341`, `localai/LocalAIProvider.ts:357-367`); a no-arg cancel (used by `ProviderManager.cancelCurrentRequest()`, `ProviderManager.ts:282-285`) falls through to the base which only handles `session.process` (null for HTTP) — in-flight HTTP requests survive global cancel.
- `OpenClawGateway.disconnect()` clears `_pendingRequests` without rejecting them (`OpenClawGateway.ts:440`), leaving callers to hang for their 30 s timeout.
- `BaseCliProvider.dispose()` sends SIGTERM to persistent processes with no escalation (`:206-210`) — combined with F1, a stuck CLI survives extension deactivation.

### F30 (LOW) — Cursor parser details

- `tool_call` `completed` with `result.rejected` still maps to `status: 'completed'` (`cursor/CursorProvider.ts:464-491`) — rejected tools render as successful.
- Non-JSON fallback drops any plain-text line starting with `[` and 1-char lines (`:537-544`) — legitimate output starting with a bracket is silently discarded.
- `_getEffectiveModel` (`:773-790`) passes `settings.model` through without checking it belongs to Cursor — mitigated for normal flow by `ChatViewProvider._getPanelModel` validation (`ChatViewProvider.ts:351-366`), but any other caller (e.g. brainstorm settings paths) would pass a Claude model ID to `--model`.

---

## 2. Model determination inventory (per provider)

**Global plumbing:** `Settings.model` is resolved in `ChatViewProvider._getPanelModel` (`ChatViewProvider.ts:351-366`): per-panel override (`panelState.settingsOverrides.model`) → `mysti.defaultModel` (plain string setting, default `claude-sonnet-4-5-20250929`, **no enum** in package.json) → validated against the active provider's hardcoded `config.models` array → falls back to `provider.config.defaultModel` when not a member. The model dropdown in the webview is populated from `provider.config.models` (each a hardcoded TS array in the provider class — **nothing comes from package.json enums or live CLI/API queries**). Every provider additionally has a free-text custom-model setting (`mysti.<provider>Model`, all `type: string, default ''` in package.json) that the provider itself reads and that overrides the dropdown. Custom values pass `validateModelName` (`utils/validation.ts:29-41`, regex `^[a-zA-Z0-9][a-zA-Z0-9._\-:/]*$`, max 128 chars).

| Provider | Hardcoded `config.models` (source of dropdown) | Custom setting | How it reaches the backend | Notes |
|---|---|---|---|---|
| Claude Code | 4 IDs: `claude-opus-4-6`, `claude-sonnet-4-5-20250929` (default), `claude-opus-4-5-20251101`, `claude-haiku-4-5-20251001` (`ClaudeCodeProvider.ts:60-87`) | `mysti.claudeCodeModel` (`:378-390`) | `--model <id>` always when set (`:248-252`); same in persistent args (`:288-291`) | custom > dropdown; dropdown passed raw (no membership check — relies on `_getPanelModel`) |
| Codex | 10 IDs: `gpt-5.4-codex` (default), `gpt-5.3-codex`, `gpt-5.2-codex`, `gpt-5.2`, `gpt-5.2-thinking`, `gpt-5.2-instant`, `gpt-5.1-codex-max`, `gpt-5.1-codex`, `o3`, `o4-mini` (`CodexProvider.ts:74-140`) | `mysti.codexModel`; also `mysti.codexProfile` → `--profile` (`:1027-1039`) | `--model <id>` (`:457-461`); dropdown passed **only if** in `config.models` **and** ≠ defaultModel — default model omits the flag so the CLI's own configured default wins (`:1003-1022`) | uniquely "default = no flag" |
| Gemini | 5 IDs: `gemini-3-pro-preview`, `gemini-3-flash-preview`, `gemini-2.5-pro`, `gemini-2.5-flash` (default), `gemini-2.5-flash-lite` (`GeminiProvider.ts:48-84`) | `mysti.geminiModel` | `-m <id>` (`:192-196`); dropdown passed only if a known Gemini model, else omitted with log (`:256-278`) | |
| Cline | 9 OpenRouter-style IDs, default `deepseek/deepseek-chat` (`ClineProvider.ts:69-130`) | `mysti.clineModel` exists in package.json but **never read by the provider** | **None** — no model flag; comment at `:315-318`: model configured globally via `cline auth/config` | dropdown + setting are dead UI (F18) |
| Copilot | 14 IDs (Claude 4/4.5 family, GPT-5.x family, `gemini-3-pro-preview`), default `claude-sonnet-4.5` (`CopilotProvider.ts:52-145`) | `mysti.copilotModel` | `--model <id>` always when set (`:377-381`); dropdown passed raw (`:399-411`) | |
| Cursor | 7 IDs: `auto` (default), `sonnet-4`, `sonnet-4-thinking`, `gpt-5.4`, `gpt-5`, `o3`, `gemini-2.5-pro` (`CursorProvider.ts:56-104`) | `mysti.cursorModel` | `--model <id>`; falls back to `auto` (`:244-249`, `:773-790`); dropdown passed raw | |
| OpenClaw | 3 IDs: `claude-opus-4-6` (default), `claude-sonnet-4-5`, `gpt-5` (`OpenClawProvider.ts:52-76`) | `mysti.openclawModel` exists in package.json but **never read** | **None** — neither CLI args (`:234-254`) nor Gateway params (`Gateway.ts:326-336`) carry a model | model selection no-op (F18) |
| OpenCode | 1 placeholder: `default` (`OpenCodeProvider.ts:50-62`) | `mysti.opencodeModel` | `-m <provider/model>` (`:189-192`); dropdown only if it contains `/` and ≠ `default` (`:233-251`) — so in practice custom-setting-only | placeholder list intentional |
| Qwen Code | 2 IDs: `qwen3-coder` (default), `qwen3-coder-plus` (`QwenCodeProvider.ts:52-70`) | `mysti.qwenCodeModel` | `--model <id>` always when set (`:193-197`); dropdown passed raw (`:234-246`) | |
| Ollama | 5 suggestion IDs (`llama3.2` default, `codellama`, `deepseek-coder-v2`, `qwen2.5-coder`, `mistral`) (`OllamaProvider.ts:54-90`) | `mysti.ollamaModel` (plus `ollamaEndpoint`, `ollamaTemperature`, `ollamaContextLength`, `ollamaKeepAlive`, `ollamaRequestTimeout`) | HTTP body `model:` = `mysti.ollamaModel \|\| config.defaultModel` (`:205`); **`settings.model` dropdown ignored** | no live `/api/tags` model listing despite calling it for discovery (`:122-137`) |
| LocalAI | 3 placeholder IDs (`gpt-4` default, `ggml-gpt4all-j`, `luna-ai-llama2`) (`LocalAIProvider.ts:54-78`) | `mysti.localaiModel` (plus endpoint/apiKey/temperature/maxTokens/timeout settings) | HTTP body `model:` = `mysti.localaiModel \|\| 'gpt-4'` (`:210`); **dropdown ignored** | no live `/v1/models` listing despite calling it for discovery |
| Manus (disabled) | 3 IDs: `manus-1.6-max`, `manus-1.6` (default), `manus-1.6-lite` (`ManusProvider.ts:53-77`) | `mysti.manusApiKey` env/setting; `mysti.manusModel` referenced in code but **not declared in package.json** | API body `model:` ; dropdown passed if ≠ default (`:358-375`) | provider unregistered (F14) |

Key takeaway for a future "dynamic models" plan: there are **three divergent semantics** for the dropdown today — pass-raw (Claude/Copilot/Cursor/Qwen), pass-if-member (`Codex`, Gemini, OpenCode) and ignore (Cline, OpenClaw, Ollama, LocalAI) — plus one "default ⇒ omit flag" special case (Codex). All lists are compile-time constants; none are sourced from package.json enums or runtime discovery, even where a live endpoint exists (Ollama `/api/tags`, LocalAI `/v1/models`, `copilot /models`, `cursor models`).

---

## 3. Cross-provider inconsistency matrix (summary)

| Concern | Base behavior | Divergent providers |
|---|---|---|
| Conversation history vs session resume | skip history when `sessionId` set (`BaseCliProvider.ts:972`) | Codex/Cline always send history (no real resume); Copilot sends history **and** bogus `--resume` (F4); Cursor sends neither (F7); Qwen `--continue` global (F8) |
| `done` chunk ownership | only `sendMessage` emits done | Cursor & OpenClaw parsers also emit done (F20) |
| autonomousMode timeout | set in base sendMessage | unset in all 5 overriding providers (F3) |
| early spawn `error` listener | yes (`:941-946`) | none of the 5 overriding providers (F11) |
| finally-kill of process | SIGTERM + (broken) SIGKILL | Codex: none (F12); Cursor/OpenClaw: SIGTERM only |
| stderr → error/auth_error | `_cleanStderr` + `isAuthenticationError` | Codex: stderr discarded, no auth detection (F23); Cursor/Cline reuse base processStream (ok); Copilot adds post-hoc auth check |
| shell mode on win32 | auto `shell:true` + arg sanitization | Codex (config only, no sanitization), Cline (`shell:false`), Cursor/OpenClaw (never) (F17) |
| prompt transport | stdin | Copilot/Cursor `-p argv`, OpenClaw `--message argv` (no length fallback), Cline argv with 200K stdin fallback (F22) |
| ask_user tool mapping | n/a | Claude waits for full input; Gemini/Copilot/Cursor/OpenClaw/Codex map by tool-name heuristics; Cline synthesizes Yes/No options |
| `getStoredUsage` keys | per-session, cleared on read | consistent across providers (good) |
| capabilities accuracy | — | Copilot `supportsToolUse` (plain text → never), Ollama `supportsImages` (dropped), Codex/Cline `supportsSessions` (no resume), Cursor `supportsSessions:false` *and* no history (worst of both) |

---

## 4. Improvement opportunities (non-bug)

1. **Extract a shared spawn/stream harness.** Five providers re-implement `sendMessage` with subtly different lifecycles, producing F3/F11/F12/F17. A protected `spawnAndStream(opts)` in the base (handling registration, stderr ref, early error capture, autonomousMode, finally-kill, shell decision) would eliminate the class of drift.
2. **Dynamic model discovery.** Ollama (`/api/tags`), LocalAI (`/v1/models`), Copilot CLI and Cursor CLI all expose model listings; `ProviderConfig.models` could become `getModels(): Promise<ModelInfo[]>` with the static array as fallback. This also fixes the misleading dropdowns (F18) and removes the constantly-staling hardcoded ID lists (e.g., `claude-opus-4-6` vs dated IDs).
3. **Session abstraction honesty.** Introduce `sessionKind: 'cli-resume' | 'prompt-history' | 'none'` on capabilities so ChatViewProvider can decide whether to send history, show a session badge, or warn that follow-ups are stateless — replacing the fake `session_active` IDs in Copilot/Cursor/Cline/OpenClaw.
4. **Per-request Gateway correlation.** OpenClawGateway already receives `runId` in the ack; storing it and filtering events/cancels would make multi-panel + ActiveMode coexistence safe (F9) and enable per-panel cancel.
5. **Secrets handling.** `mysti.cursorApiKey`, `mysti.localaiApiKey`, `mysti.manusApiKey` are plain settings; use `context.secrets` (SecretStorage) and pass keys via env only, never argv.
6. **Central kill utility.** One `killProcessTree(proc, grace)` using `exitCode === null` checks, listener cleanup and timer cancellation, used by base, providers, and ProviderManager (fixes F1 in one place).
7. **Parser fuzz/unit tests.** The repo has zero tests; the stream parsers (especially Cline's multi-line JSON buffering with `_isJsonComplete`, Cursor's cumulative-text dedup, Codex's item state machine) are exactly the kind of code that regresses silently. Recorded NDJSON fixtures per CLI version would catch most of the parse findings above.
8. **`buildPrompt`/`buildPromptAsync` dedup.** The deprecated sync `buildPrompt` (`BaseCliProvider.ts:1311-1362`) duplicates the async version verbatim and is still used by Codex; deleting it forces the agentConfig path (F10).
9. **Surface "model ignored" feedback.** When `_getEffectiveModel` drops a non-member model (Gemini/Codex) or a provider has no model control (Cline/OpenClaw), post an info chunk so the user knows which model actually served the request.
10. **`_getCliCommandName` default footgun.** The default `this.id.split('-')[0]` (`BaseCliProvider.ts:742-744`) would have produced `openai` for codex and `google` for gemini if not overridden — making the override mandatory-but-implicit; consider making it abstract.

---

## 5. Notable strengths

- **Per-panel session architecture is consistently applied.** Every provider implements `_createSession` with provider-specific state; parse state, tool-call accumulation and usage stats live on the session object, not the instance (Codex's leftover instance fields are dead, not used). `clearSession`/`getStoredUsage` are uniformly per-panel.
- **The base single-shot pipeline is genuinely robust**: early spawn-error capture, stderr ring with `_cleanStderr` noise filtering, auth-error pattern detection with provider-specific `authCommand`, prompt-build-after-spawn parallelization, and detailed timing logs.
- **SIGSTOP-based pre-execution permission gate** (suspend before tool runs, SIGKILL-for-suspended on deny in `_cancelSessionRequest:298-305` with a correct comment about why SIGCONT+SIGTERM would be unsafe) is a thoughtful design, and Claude's parser comments (`ClaudeCodeProvider.ts:567-576`, `:364-371`) document hard-won CLI interaction lessons.
- **Cline's `_isJsonComplete` brace-depth scanner** (string/escape aware, `ClineProvider.ts:422-447`) is a solid solution for pretty-printed JSON buffering; its argv-vs-stdin length fallback and `shell: false` security stance are equally deliberate.
- **Cursor's cumulative-text dedup** (`streamedTextLength`, `CursorProvider.ts:362-370`) correctly handles `--stream-partial-output`'s cumulative events, and its tool-name normalization map keeps the webview renderer provider-agnostic.
- **Defense in depth on shell mode**: base refuses to spawn with shell when any arg contains metacharacters (`BaseCliProvider.ts:931-936`), and `validateModelName`/`validateProfileName` whitelist patterns explicitly designed against shell injection.
- **CLI discovery is thorough**: configured path → provider-specific paths (VS Code extension bundles, app bundles) → nvm current+versions → Homebrew/system → npm-global → PATH fallback, with caching and config-change invalidation.
- **OpenClaw's dual transport** (gateway with reconnect/backoff, CLI fallback with NDJSON-then-blob hybrid parsing) degrades gracefully at every step.
