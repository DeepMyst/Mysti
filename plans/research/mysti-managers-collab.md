# Mysti Collaboration/Agent Managers — Bug Review

Scope: `src/managers/` — BrainstormManager, MentionRouter, ChannelBridge, ActiveModeManager,
SlashCommandManager, EngagementManager, TeamPresenceManager, ResponseClassifier,
PlanOptionManager, SuggestionManager, AutocompleteManager, AgentLoader, AgentContextManager,
ProjectContextManager — plus the directly implicated MemoryManager and ProviderManager call paths.
All paths relative to `/Users/bahaabunojaim/Documents/GitHub/Mysti`. All findings were confirmed by
reading the working-tree code (branch `feature/visual-testing`). GitHub issues #42, #44, #46 were
read via `gh issue view` and verified against the code.

---

## 1. ChannelBridge — inbound routing / identity (issues #42 and #44)

### 1.1 [HIGH] Cross-channel identity confusion: contact tracking ignores channel (issue #42 — CONFIRMED)

`src/managers/ChannelBridge.ts:865-873` and `:880-902`

```ts
private _trackContact(nameOrPhone: string, channel: string): void {
  const key = this._normalizeContactId(nameOrPhone);
  this._trackedContacts.set(key, { identifier: key, channel, sentAt: Date.now() });
  ...
}

private _isTrackedConversation(sender: string | undefined, _channelType: string): boolean {
  ...
  for (const [key, contact] of this._trackedContacts) {
    ...
    if (key === senderNorm) { return true; }
    if (senderNorm.includes(key) || key.includes(senderNorm)) { return true; }
  }
  ...
}
```

Three compounding problems:

1. **The channel parameter is deliberately unused** (`_channelType`), and the map key is only the
   normalized contact identifier. Messaging "John" on WhatsApp authorizes inbound routing of
   messages from *any* sender labeled "John" on Telegram, Slack, Discord, etc. The stored
   `contact.channel` field is never consulted at match time. This is exactly the cross-channel
   spoofing path described in issue #42: once authorized, attacker text reaches
   `_handleInboundChannelEvent`, which can answer a pending question
   (`answerPendingQuestion`, line 729), cancel a running request (line 742), or **inject a brand-new
   agent run** (`injectChannelMessage`, line 758 → `ChatViewProvider._handleSendMessage` at
   `src/providers/ChatViewProvider.ts:292`) with the panel's full context and settings.
2. **Bidirectional substring matching** (`senderNorm.includes(key) || key.includes(senderNorm)`)
   means a tracked short name ("Al", "Jo") matches a large population of sender labels, widening the
   spoof surface and causing false-positive routing.
3. **Single-key map**: tracking "John" on Telegram overwrites the entry for "John" on WhatsApp
   (same key), so even the recorded channel metadata is lost.

**Fix**: key `_trackedContacts` by `(channel, identifier)`; pass and enforce the channel in
`_isTrackedConversation`; replace bidirectional substring matching with exact or
token-prefix matching; ideally also bind the OpenClaw conversation/session id rather than the
display label.

### 1.2 [HIGH] Pending ask replies mis-bound across panels/contacts (issue #44 — CONFIRMED)

`src/managers/ChannelBridge.ts:761-791`

```ts
private _tryMatchPendingAsk(channelId, channelType, content, sender?) {
  for (const [_panelId, asks] of this._pendingAsks) {
    const channelAsks = asks.filter(a => !a.reply && (a.channelId === channelId || a.channel === channelType));
    if (channelAsks.length === 0) { continue; }
    if (sender) {
      const senderMatch = channelAsks.find(a => a.to && senderLower.includes(a.to.toLowerCase()));
      if (senderMatch) { ... return senderMatch; }
    }
    // Fall back to oldest channel-only match
    const fallback = channelAsks[0];
    fallback.reply = content;
    ...
    return fallback;     // <-- returns inside the FIRST panel's iteration
  }
}
```

The channel-only fallback executes **inside the first panel** (Map insertion order) that has any
pending ask on the channel. Consequences:

- Panel A asked Alice, panel B asked Bob, both on WhatsApp. Bob replies; his label "Bob Smith"
  doesn't contain "alice", so panel A's sender-aware match fails and the **fallback binds Bob's
  reply to Alice's ask in panel A** — panel B's perfectly matching ask is never examined because the
  loop returns before reaching it.
- The bound reply then auto-triggers the **wrong panel's agent** with attacker/3rd-party-controlled
  text prefixed as `reply to "<question>"` (`_handleInboundChannelEvent`:698-713).
- Sender matching itself is fragile: `ask.to` is whatever the model wrote (`to="Bob"`), while the
  polled `conversation_label` may be an E.164 phone number, so the sender-aware branch routinely
  fails and the misbinding fallback becomes the common path, not the exception.
- `askId` and `panelId` exist on `PendingAsk` (lines 49-59) but are never used for correlation.

**Fix**: do a two-pass match across *all* panels — first pass sender-aware (exact, channel-bound),
second pass channel-only fallback only if exactly one un-replied ask exists for the channel;
otherwise hold the message and route it as a normal inbound message instead of guessing.

### 1.3 [MEDIUM] Name↔phone asymmetry silently drops legitimate replies

`src/managers/ChannelBridge.ts:893-898`. The comment claims `tracked "Sharif" matches sender
"+962792552872" if we also track by phone`, but nothing ever tracks both forms — only the literal
`to=` value is tracked (`executeSend`:359/367, `executeAsk`:405). If the model used a name and the
channel reports a phone label (or vice versa), `_isTrackedConversation` fails in both substring
directions and the reply is **dropped before** ask matching is even attempted. Users will see asks
that never resolve. Fix: when OpenClaw confirms delivery, record both the resolved address and the
display label; or relax the gate for senders that match a pending ask's channel.

### 1.4 [MEDIUM] Poll watermark loses messages written during a poll

`src/managers/ChannelBridge.ts:516-600`. `_lastPollTimestamp` is set to `Date.now()` at the **end**
of `_pollViaSessionFiles` (line 592). Any session entry written during the poll (or with a timestamp
slightly behind wall clock) is `<=` the new watermark and permanently skipped on the next tick via
three separate comparisons (`updatedAt` line 547, `stat.mtimeMs` line 556, message `timestamp` line
619). Additionally `_parseSessionEntry` compares entry timestamps against the *live* field while the
loop is still mutating state. Fix: capture `pollStartedAt` before scanning, advance the watermark to
that value (or to the max observed message timestamp), and rely on `_processedMessageIds` for dedup.

### 1.5 [MEDIUM] Polled events conflate channel id with channel type

`src/managers/ChannelBridge.ts:649-656` returns `channelId: channelType`. With two channels of the
same type (e.g., two WhatsApp accounts), inbound attribution and `_tryMatchPendingAsk`'s
`a.channelId === channelId` comparison degrade to type-level matching, feeding finding 1.2.

### 1.6 [LOW] Ask replies arriving while the agent is running are never surfaced automatically

`src/managers/ChannelBridge.ts:701-713`: on a matched ask, injection happens only when the panel is
idle and has no pending question. Otherwise the reply is stored on the ask and is only injected if
the *user* later sends a message (`getReplyContext`, line 249). No queueing into `_queuedMessages`
happens for this path, so a reply can sit invisible indefinitely.

### 1.7 [LOW] Prompt-snippet cache never refreshes the skills list

`src/managers/ChannelBridge.ts:177-182`: cache signature is built only from connected channel
`id:type`. `_buildSkillsList()` output changes once `ActiveModeManager._fetchSkills()` completes
(async, line 89 of ActiveModeManager), but the cached snippet keeps the static fallback for the rest
of the session. Include a skills-count/hash in the signature.

### 1.8 [LOW] Channel confirmations target the display label

`src/managers/ChannelBridge.ts:731-733` and `:743-745` pass `sender` (often a display name) as the
send target while the inline comment notes WhatsApp requires E.164 — confirmations to named contacts
will fail or go nowhere.

---

## 2. Project memory key collisions (issue #46 — CONFIRMED, in MemoryManager)

### 2.1 [HIGH] Project memory keyed by literal workspace path string

`src/managers/MemoryManager.ts:284-298` (note: the issue is in **MemoryManager**, not
ProjectContextManager — ProjectContextManager only reads `mysti.md`/rules and has no memory keys):

```ts
initProjectMemory(workspacePath: string): void {
  const hash = crypto.createHash('sha256').update(workspacePath).digest('hex').substring(0, 12);
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  this._projectMemoryDir = path.join(homeDir, '.mysti', 'projects', hash, 'memory');
```

Called from `src/extension.ts:94` with `vscode.workspace.workspaceFolders[0].uri.fsPath`.

- **No canonicalization**: the raw lexical path is hashed. Two *different real projects* opened at
  the same lexical path over time (shared dev boxes, `/tmp/project`, recycled containers/home dirs,
  re-mounted volumes) silently share `MEMORY.md`. Since `getProjectMemoryContent()` is injected into
  provider system context, this both leaks the previous project's memory and poisons the new
  session's context (issue #46's attack).
- Conversely, the *same* project reached via a symlink vs. its real path (or with different
  trailing-slash/case on macOS) hashes to different keys and gets amnesia.
- **Multi-root workspaces**: only `workspaceFolders[0]` participates; all other roots share its
  memory namespace.
- The 12-hex-char truncation (48 bits) is fine for accidental collisions but the lexical-path issue
  dominates.

**Fix**: hash `fs.realpathSync.native(workspacePath)` plus a stable per-installation salt (e.g., a
random id stored in `globalState`), and store the original path in a `path.txt` alongside the memory
dir; on `initProjectMemory`, verify the stored path matches the canonical path and re-key if not.

### 2.2 ProjectContextManager (reviewed for the same class of issue)

`src/managers/ProjectContextManager.ts` keeps everything keyed off the in-memory
`_workspaceRoot` and re-reads from disk, so it has no cross-workspace persistence collision.
Minor issues found:

- **[LOW] `_matchGlob` (lines 480-495)**: only `.` is escaped; patterns containing `+ ( ) [ ] { } ?`
  produce wrong regexes or fail silently (caught and treated as non-match). Also `**/*.ts` compiles
  to `.*/[^/]*\.ts`, which fails to match top-level `a.ts` (most glob engines match it).
- **[LOW] `initialize` uses `workspaceFolders[0]` only** — rules/mysti.md from other roots in a
  multi-root workspace are ignored without warning.

---

## 3. ProviderManager cancellation routing (affects brainstorm, mentions, channel cancel)

### 3.1 [HIGH] `cancelRequest(panelId)` cancels via the global-default provider, not the owning provider

`src/managers/ProviderManager.ts:228-243`:

```ts
public cancelRequest(panelId: string): void {
  try {
    const provider = this._getActiveProvider();   // <-- no provider id: resolves to mysti.defaultProvider
    provider.cancelCurrentRequest(panelId);
  } catch {
    const process = this._activePanelProcesses.get(panelId);   // only reached if claude-code missing too
    ...
  }
  this._activePanelProcesses.delete(panelId);
}
```

`_getActiveProvider()` with no argument resolves `mysti.defaultProvider` (lines 58-81). Confirmed
consequences:

- A panel whose per-panel provider override differs from the global default (per-panel overrides
  exist: `ChatViewProvider._handleUpdateSettings`, `src/providers/ChatViewProvider.ts:3554-3561`)
  cannot be cancelled: the default provider has no session for that panelId, the call is a no-op,
  and the `_activePanelProcesses` handle is then **deleted without killing the process**.
- Brainstorm runs two different providers under the same panelId; `cancelPanelRequest`
  (`ChatViewProvider.ts:269-274`) and `BrainstormManager.cancelSession` both funnel into this
  method, so only the default provider's agent dies — the other agent keeps streaming and billing.
- MentionRouter's timeout/retry cancels (`MentionRouter.ts:497`, `:470`) target sub-agent panel ids
  owned by arbitrary providers; a timed-out Gemini sub-agent is "cancelled" on the default Claude
  provider and keeps running until the provider's own 5-minute process timeout.

**Fix**: `cancelRequest` should iterate all registered providers and call
`cancelCurrentRequest(panelId)` on each (they no-op when they own nothing for that panel), and only
then fall back to the tracked ChildProcess. Alternatively record `panelId → providerId` at
`registerProcess` time.

---

## 4. BrainstormManager

### 4.1 [MEDIUM] `cancelSession` cancels panel keys that no provider ever registers

`src/managers/BrainstormManager.ts:1724-1736`:

```ts
this._providerManager.cancelRequest(sessionId);
for (const agent of session.agents) {
  this._providerManager.cancelRequest(`${sessionId}-brainstorm-${agent.id}`);
}
```

Both `_streamAgentResponse` (line 870-878) and `_streamDiscussionResponse` (line 940-948) pass the
plain `sessionId` to `sendMessageToProvider`, so providers key their sessions/processes by
`sessionId` alone. The `-brainstorm-<agent>` suffix is used only by CompactionManager token tracking
(`CompactionManager.ts:49`, `ChatViewProvider.ts:3427`) — the suffixed `cancelRequest` calls match
nothing. Combined with 3.1, cancelling a brainstorm reliably kills at most one of the two agents.

### 4.2 [MEDIUM] `_iterateWithSilenceTimeout` leaks timers and orphans the underlying stream

`src/managers/BrainstormManager.ts:838-853`. Every chunk iteration creates a `setTimeout`
(90s, `BRAINSTORm_SILENCE_TIMEOUT_MS` at `src/constants.ts:80`) that is **never cleared** — a chatty
stream accumulates thousands of live timers (each pinning its closure for 90s). Worse, when the
timeout fires, the generator rejects but the underlying provider stream/CLI process is **not
cancelled** — the catch blocks in `_streamAgentResponse` (917-924) and `_streamDiscussionResponse`
(963-971) yield an error chunk without calling `cancelRequest`, so the orphaned agent process keeps
running until the provider-level timeout. Fix: keep a single resettable timer (`clearTimeout` on
each chunk) and call `providerManager.cancelRequest(sessionId)` (with the provider-aware fix from
3.1) on timeout.

### 4.3 [MEDIUM] Error path of `startBrainstormSession` omits `done` and leaves the session "active"

`src/managers/BrainstormManager.ts:330-336`. The catch yields `agent_error` only; the early
validation paths (lines 247-252, 263-270) yield `{type:'done'}`. On a thrown error `session.phase`
is never set to `'complete'`, so `isSessionActive(panelId)` (line 224-227) returns true for that
panel forever, and any UI logic keyed on a `done` chunk stalls. Add `yield { type: 'done' }` and
`session.phase = 'complete'` in the catch (or a `finally`).

### 4.4 [MEDIUM] Delphi convergence compares refinements against the facilitator summary

`src/managers/BrainstormManager.ts:1564-1571` with the Delphi push pattern at lines 729-736
(facilitator round) and 758-771 (refiner round). `_assessConvergence` runs after the refiner push,
so `prevRound = discussionRounds[len-2]` is the **facilitator** round, whose `contributions` map
contains only the facilitator's summary. Position stability for the facilitator-agent therefore
measures similarity between its refinement and its own *summary text* (not its previous position),
and the other agent contributes no stability sample at all. `avgStability` is semantically wrong for
Delphi and skews `converged`/`stalled` decisions. Fix: in Delphi, compare refinement round `2r`
against refinement round `2r-2` (or against `agentResponses` for round 1).

### 4.5 [LOW] Delphi role-assignment keyed by synthesis agent that may not be in the session

`src/managers/BrainstormManager.ts:704-705` vs `:716-717`. `roleAssignments` is keyed by
`config.synthesisAgent` even when the actual facilitator falls back to `session.agents[0]`. The
synthesis prompt (`_buildSynthesisPrompt`:1458-1475) then renders a role line for an agent not in
the session and no role label for the actual facilitator's contribution.

### 4.6 [LOW] Both backward-compat settings shims are dead code

`src/managers/BrainstormManager.ts:126-137`. `mysti.brainstorm.strategy` has a package.json default
(`"quick"`, `package.json:568-570`), so `config.get<string>('brainstorm.strategy')` is always
truthy and the `discussionMode === 'full' → debate` mapping never fires. Likewise
`maxDiscussionRounds` has a package default, so the nested
`config.get('brainstorm.discussionRounds', 2)` fallback is unreachable. Users upgrading with legacy
settings silently lose them. Use `config.inspect()` to detect explicit user values.

### 4.7 [LOW] `_interleaveGenerators` aborts everything if any iterator rejects

`src/managers/BrainstormManager.ts:1668-1719`. A rejected `iterator.next()` promise never enters
`resultQueue`; `await Promise.race(activePending)` then rethrows, abandoning sibling generators
mid-stream (their processes keep running, see 4.2/3.1). Latent today because the inner generators
catch everything, but a single uncaught throw (e.g., from `sendMessageToProvider`'s synchronous
prelude) takes down the whole session. Wrap the per-iterator promise in `.catch` and convert to an
error result.

Also verified-good: the result-queue interleaver correctly avoids the classic lost-wakeup
`Promise.race` bug; B6 empty-contribution guard and B4 oscillation detection are reasonable.

---

## 5. MentionRouter

### 5.1 [MEDIUM] AI-generated task agents are unvalidated → tasks silently routed to claude-code

`src/managers/MentionRouter.ts:356-358` (`agent: item.agent as AgentType` — no validation against a
known-id list) plus `:411-421`:

```ts
const providerStatus = await this._providerManager.getProviderStatus(agentId);
if (providerStatus && !providerStatus.found) { ...error... }
```

For an unknown/hallucinated id (`"Claude"`, `"gpt"`, etc.) `getProviderStatus` returns null, so the
guard passes, and `sendMessageToProvider(agentId, ...)` hits `ProviderManager._getActiveProvider`'s
silent fallback to claude-code (`ProviderManager.ts:62-68`). The task executes on the wrong agent
while the UI shows the hallucinated agent's name. Fix: validate `item.agent` against the registry
(and `AGENT_DISPLAY_NAMES` reverse-mapping) before accepting the AI task list; fall back to the
first *mentioned* agent otherwise.

### 5.2 [MEDIUM] Informational-question heuristic strips the subject out of the question

`src/managers/MentionRouter.ts:255-263`. "can @gemini generate images?" is routed to the main
provider with `task: stripped`, where `stripMentions` removed `@gemini` — the main agent receives
"can generate images?" with no subject. The rule's intent ("questions ABOUT an agent go to the main
provider") requires substituting the display name, not deleting the mention. Fix: replace mention
tokens with the agent display name instead of stripping when routing informational questions.

### 5.3 [MEDIUM] `cancelSubAgents` misses retry/follow-up/taskgen processes

`src/managers/MentionRouter.ts:213-218` cancels only `${panelId}-subagent-${agentId}`, but dispatch
also creates `...-retryN` (line 475), `...-followup` (line 547), and `${panelId}-taskgen` (line 332)
panel ids. A user cancel during a retry or follow-up leaves those CLI processes running (compounded
by 3.1). Track live sub-agent panel ids in a per-panel set and cancel all of them.

### 5.4 [LOW] Non-greedy JSON extraction truncates task arrays containing `]`

`src/managers/MentionRouter.ts:344`: `rawOutput.match(/\[[\s\S]*?\]/)` stops at the first `]`, which
may be inside a task string ("fix arr[0]") → `JSON.parse` throws → silent downgrade to the
single-task fallback, losing the decomposition. Use a greedy match with bracket balancing, or
`/\[[\s\S]*\]/` with trim-and-retry.

### 5.5 [LOW] Misc

- `AGENT_DISPLAY_NAMES` (lines 35-43) lacks `opencode`, `qwen-code`, `ollama`, `localai` → raw ids
  in prompts/UI for 4 of 11 agents.
- Follow-up stream after an answered question (lines 550-570) has no timeout and ignores a second
  `ask_user_question`.
- Two tasks for the same agent overwrite each other in `priorResponses` (line 441); a mid-list
  `switch` task early-returns and silently drops all subsequent tasks and the `main_tasks` yield
  (lines 133-138).

---

## 6. SlashCommandManager

### 6.1 [MEDIUM] `/clear` clobbers the global current conversation across panels

`src/managers/SlashCommandManager.ts:225-232` calls `this._conversationManager.createNewConversation()`.
`ConversationManager` keeps a single `_currentConversationId` shared by every panel
(`src/managers/ConversationManager.ts:20-22, 50`), so `/clear` in one panel switches the current
conversation underneath all other panels — contradicting the per-panel isolation design used
everywhere else (`clearSession(panelId)` on the same lines is per-panel). Needs a per-panel
conversation pointer or at minimum scoping `/clear`'s conversation reset to the issuing panel.

### 6.2 Verified-good

`_applyProviderSwitch` (lines 953-975) reports "model auto-switched" without setting the model
itself, but `ChatViewProvider._handleUpdateSettings` does perform the auto-switch on provider change
(`ChatViewProvider.ts:3566-3599`), so the message is accurate. `cmd:exit-plan` updating global mode
is consistent with settings being global.

---

## 7. ResponseClassifier / PlanOptionManager / SuggestionManager / AutocompleteManager

### 7.1 [MEDIUM] Always-on warm `claude` process pools; content sent to Claude regardless of chosen provider

- `src/managers/ResponseClassifier.ts:40-88` (pool of 2, spawned in constructor; constructed by
  `PlanOptionManager` which is constructed unconditionally in `ChatViewProvider` at
  `ChatViewProvider.ts:196`).
- `src/managers/SuggestionManager.ts:37-92` (pool of 2, spawned at activation, `extension.ts:74`).

Four idle `claude --print` processes are spawned at startup and respawned after every use, even if
the user's active provider is Gemini/Codex/Ollama and even if they never use suggestions or plan
modes. Beyond the resource cost, every assistant response (`classify`, content truncated to 3000
chars) and last-message content for suggestions/titles is shipped to Claude Haiku regardless of the
user's provider choice — a privacy/consent surprise for non-Claude users. Both managers also resolve
the CLI as bare `'claude'` (`_findClaudeCliPath`, ResponseClassifier.ts:352-384) without the
enriched-env/PATH discovery used by providers (`getEnrichedEnv` in `utils/platform`), so spawns fail
with ENOENT in GUI-launched VSCode where PATH lacks the npm bin dir — features then silently degrade.

**Fix**: lazy-spawn the pool on first use, gate on the classifier feature settings and on Claude CLI
availability, reuse `getCommonSearchPaths`/`getEnrichedEnv`, and consider routing classification
through the user's selected provider.

### 7.2 [LOW] ResponseClassifier concurrency and dead code

`src/managers/ResponseClassifier.ts:219` — concurrent `classify()` calls clobber `_currentProcess`,
so `cancel()` only kills the most recent. `_isSpawning` (line 38) is pointless around a synchronous
loop. `_hasStructuredContent` (117-128) is dead code.

### 7.3 [LOW] AutocompleteManager is dead code

No `new AutocompleteManager` anywhere in `src/` (grep). The file (348 lines, spawns its own warm
process when constructed) is unreferenced — either wire it up or remove it; if wired, note its
`isEnabled()` is hard-coded `true` with no setting gate (`AutocompleteManager.ts:52-54`).

### 7.4 [LOW] `generateTitle` is uncancellable

`src/managers/SuggestionManager.ts:124-178` never assigns `_currentProcess`, so `cancelGeneration()`
cannot stop a title generation in flight.

---

## 8. AgentLoader / AgentContextManager (tier correctness)

### 8.1 [MEDIUM] Duplicate agent ids across sources: inconsistent dedup and type clobbering

`src/managers/AgentLoader.ts:129-170`. For an id present in multiple sources (e.g., a workspace
override of a core persona):

- `_metadataCache.set(id, ...)` dedupes — last source (workspace) wins, which matches the documented
  override intent for Tier 2/3 (`loadInstructions` reads `metadata.filePath` from the cache winner).
- But the **returned `personas`/`skills` arrays push every file**, so callers of `loadAllMetadata()`
  receive duplicates (both the core and workspace entries with the same id). Today the only caller
  (`ChatViewProvider.ts:314`) uses them just for custom-agent detection, but any future UI use shows
  duplicate entries; the arrays and the cache disagree.
- `_agentTypes.set(id, ...)` is keyed globally: a workspace **skill** that reuses a core **persona**
  id silently reclassifies it, making `getPersonas()` drop the persona entirely.

**Fix**: dedupe the returned arrays by id (keep the highest-priority source), and warn on
cross-type id collisions.

### 8.2 [LOW] Section extraction fragility

`src/managers/AgentLoader.ts:447-451` — `sectionName` is interpolated into a RegExp unescaped and
requires exactly `## Name\n` (trailing spaces or `###` headers miss). `_extractInstructions`
fallback (426-442): when the body starts with `# Title\n\n`, the first "paragraph" is just the title
line and `replace(/^#.*\n/, '')` fails (no trailing `\n` after split), so `instructions` becomes the
literal `# Title`.

### 8.3 [LOW] `findMatchingAgents` name match is inverted

`src/managers/AgentLoader.ts:272` — `metadata.name.toLowerCase().includes(queryLower)` almost never
matches a multi-word query (it asks whether the short name *contains* the whole query). The primary
recommendation path (`AgentContextManager.getRecommendations`, line 122, `queryLower.includes(name)`)
does it correctly; align `findMatchingAgents` or delete it if unused.

### 8.4 Verified-good

Three-tier flow is otherwise sound: Tier 1 cached at startup, Tier 2 (`loadInstructions`) cached and
built from Tier 1's file path, Tier 3 (`loadFull`) layered on Tier 2; `reload()` clears all caches.
`AgentContextManager.buildPromptContext` enforces the token budget correctly with a 0 == unlimited
escape hatch (the condensed-persona path not being re-checked against the budget is a nit).

---

## 9. ActiveModeManager / EngagementManager / TeamPresenceManager / PlanOptionManager

### 9.1 [LOW] EngagementManager streaks computed in UTC

`src/managers/EngagementManager.ts:825-857` uses `toISOString()` (UTC) for day boundaries; users at
negative UTC offsets get streak breaks/merges around local evening. Cosmetic: the "Collector" badge
copy says "all 7 providers" (line 227-231) while 11-12 exist.

### 9.2 [LOW] ActiveModeManager `_fetchSkills` uses bare `openclaw`

`src/managers/ActiveModeManager.ts:284-308` execs `'openclaw skills list --json'` from PATH even
when the CLI was detected only at a configured/known absolute path (`_detectCli`, 255-278) — skills
fetch then fails and the ChannelBridge prompt permanently shows the static skill list (see 1.7).

### 9.3 TeamPresenceManager, PlanOptionManager

No functional bugs found. TeamPresenceManager's tool-name substring matching
(`name.includes('read')`) can misclassify exotic tool names but only affects counters.
PlanOptionManager is a thin delegating wrapper; its deprecated `detectPlanOptions` correctly warns.

---

## Improvement opportunities (non-bug)

1. **Central panel-process registry**: `ProviderManager` already has `_activePanelProcesses` but
   providers bypass it in the cancel path. Recording `panelId → {providerId, process}` at spawn time
   would fix 3.1/4.1/5.3 in one place and simplify AgentLifecycleManager.
2. **ChannelBridge marker protocol**: regex markers in streamed text are fragile (split chunks,
   models echoing examples from the injected snippet itself — the snippet at lines 204-239 contains
   literal marker examples that `detectMarkers` would happily execute if the model quotes them).
   Consider requiring a nonce in the marker (`<<<CHANNEL_SEND nonce="...">>>`) injected per-request.
3. **Inbound polling vs events**: ChannelBridge both subscribes to Gateway events and polls session
   JSONL files from disk; the disk-format coupling (`~/.openclaw/agents/main/sessions`, 8KB tail
   reads, metadata regex at line 636) is brittle against OpenClaw format changes. Prefer the
   Gateway `sessions.history` RPC (the `_sessionHistoryAvailable` flag exists but is unused).
4. **BrainstormManager size/duplication**: the five strategies share a copy-pasted
   "stream + accumulate contributions + push round" block 5 times; extracting a
   `_runDiscussionRound(agents, prompts, role, round)` helper would shrink ~300 lines and make the
   Delphi round-numbering scheme (2r-1/2r) explicit.
5. **Heuristic convergence**: word-pattern counting (`\bagree\b` etc.) is easily skewed by the
   required response formats the prompts themselves mandate; a cheap structured approach (ask each
   agent to end with `AGREEMENT: n/10`) would be more robust than lexical matching.
6. **Settings backward-compat**: use `config.inspect()` everywhere a legacy setting must win over a
   package-default (see 4.6) — there are likely other instances of the same dead-fallback pattern.
7. **Classifier consent & lifecycle**: add a `mysti.suggestions.enabled` / `mysti.classifier.enabled`
   gate, lazy spawn, and an idle reaper for warm pools; document that these features call Claude.
8. **MentionRouter prompt injection**: sub-agent outputs are concatenated into the next agent's
   prompt verbatim (`_formatPriorResponses`); a hostile/compromised sub-agent response can steer the
   downstream agent. Consider fencing and labeling as untrusted.
9. **AgentLoader watchers**: agents load once at activation; edits to `.mysti/agents/**` require a
   manual reload. A FileSystemWatcher like ProjectContextManager's would improve DX.

## Notable strengths

- **Per-panel isolation discipline** is consistently applied across managers (context, sessions,
  marker positions, brainstorm sessions, compaction keys) and clearly documented.
- `_interleaveGenerators` uses a result queue that correctly avoids the classic lost-result
  `Promise.race` interleaving bug — a subtle pattern done right.
- BrainstormManager's layered fallbacks (synthesis agent → other agent → raw concatenation,
  B1 silence timeout, B6 empty-contribution guard, B4 oscillation detection) show deliberate
  failure-mode design, even where details need fixing.
- ChannelBridge's tracked-contact gate is the *right idea* (deny-by-default inbound routing); the
  flaws are in key granularity and matching, not the concept. Marker stripping for clean display and
  bounded `_processedMessageIds` show attention to detail.
- MemoryManager's confidence decay + access-weighted pruning is a thoughtful memory policy;
  EngagementManager is cleanly self-contained with versioned-default merging on load.
- AgentLoader's three-tier lazy loading with separate caches per tier is a sound design for keeping
  startup fast and prompt budgets small.

## Cross-reference: GitHub issues

| Issue | Claim | Verdict |
|---|---|---|
| #42 | Cross-channel identity confusion in inbound routing | **Confirmed** — `ChannelBridge.ts:880-902` ignores channel; substring matching widens it (finding 1.1) |
| #44 | Pending ask replies mis-bound across panels | **Confirmed** — `ChannelBridge.ts:783-788` first-panel channel-only fallback preempts sender match in other panels (finding 1.2) |
| #46 | Project memory reused across workspaces with same lexical path | **Confirmed** — `MemoryManager.ts:284-287` hashes the raw path, no canonicalization/identity (finding 2.1); code lives in MemoryManager, not ProjectContextManager |
