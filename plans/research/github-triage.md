# Mysti GitHub Triage — Open PRs & Issues (DeepMyst/Mysti)

Date: 2026-06-12. Repo state reviewed: branch `feature/visual-testing` with uncommitted Canvas v2 changes; `origin/main` at `bce0d2b` (v0.4.0). All 5 open PRs report `mergeable=MERGEABLE, state=CLEAN` against main.

Note: CLAUDE.md says "tests not yet implemented" — stale. `tests/` exists (managers/, providers/, integration/) and `npm test` runs vitest.

---

## Open PRs

### PR #47 — "Fix project memory key isolation" (author: 3em0, 2026-06-01) — **merge-with-changes**

Fixes #46. Files: `src/managers/MemoryManager.ts` (+19/−1), new `tests/managers/memoryManager.test.ts` (+72).

**Change:** `initProjectMemory()` currently keys project memory dirs on `sha256(rawWorkspacePath)[0:12]` (working tree `MemoryManager.ts` line ~285, unchanged since v0.4.0). PR derives the hash from a JSON payload `{schema: 'mysti-project-memory-v2', canonicalWorkspacePath}` where the path is canonicalized via `fs.realpathSync.native()` (fallback `path.resolve()`), and uses the **full** 64-char SHA-256 hex as the directory name.

**Review:**
- Logic is correct and matches the issue's remediation list. Test is sensible (symlink retarget → different memory dirs).
- Conflicts: none with working tree (`MemoryManager.ts` untouched locally; no existing `tests/managers/memoryManager.test.ts`). GitHub reports MERGEABLE.
- **Gap: no migration.** Changing the key scheme silently orphans every existing user's `~/.mysti/projects/<12-char-hash>/memory/MEMORY.md` — all project memory resets on upgrade. The issue itself suggested "invalidating or migrating"; the PR chose silent invalidation without saying so. Recommend adding a one-time migration (if old truncated-hash dir exists and new dir doesn't, move it) or an explicit changelog note.
- Author could not run vitest (their env had Node 18; vitest needs Node 20+) — run `npm test` locally before merge.
- Severity of underlying issue is niche (shared `$HOME`/shared-account environments), so this is hardening, not urgent.

### PR #45 — "Fix ambiguous ChannelBridge pending ask replies" (author: 3em0, 2026-06-01) — **merge-with-changes (rebase onto #43 first)**

Fixes #44. Files: `src/managers/ChannelBridge.ts` (+44/−27), new `tests/managers/channelBridge.test.ts` (+146).

**Change:** Rewrites `_tryMatchPendingAsk()` to return `{matched|ambiguous|none}`. Collects candidate asks across **all** panels, requires **exactly one** candidate (sender-aware first, then channel-only) before binding a reply; ambiguous replies are dropped with a log line instead of being bound to the oldest/first match.

**Review:**
- Addresses the real cross-panel mis-binding shown in #44 (current code at working-tree lines 761–790 falls back to `channelAsks[0]`, first panel wins).
- Test assertions that look contradictory (`toContain('ask-100')` then `toBe('')`) are actually correct: `getReplyContext()` (working tree line 249) consumes/clears replied asks on read.
- **Conflict with PR #43:** both PRs are diffed against the same main blob (`b6f2ec4`) of `ChannelBridge.ts`, both touch `_tryMatchPendingAsk`, and both add `tests/managers/channelBridge.test.ts` with different content. They are mergeable individually but NOT together — the second one in will conflict. Issue #44's cited commit (`f63d9ba`, containing `_matchesInboundChannel`) is PR #43's branch, i.e., the author verified #44 on top of #43 but based PR #45 on main.
- Behavior tradeoff: if a user legitimately has two outstanding asks to the same contact/channel, **all** replies are silently dropped until TTL — only a console log. Acceptable for security but consider surfacing a UI warning, or preferring `ask.to`+panel disambiguation before dropping.
- Author could not run vitest (Node 18). Run tests on merge.
- Recommended order: merge #43, ask author (same person) to rebase #45 on top incorporating `_matchesInboundChannel` into the unique-match logic and merging the two test files; or do the combination in-house.

### PR #43 — "Fix channel-scoped OpenClaw contact tracking" (author: 3em0, 2026-06-01) — **merge (first of the two ChannelBridge PRs)**

Closes #42. Files: `src/managers/ChannelBridge.ts` (+77/−22), new `tests/managers/channelBridge.test.ts` (+170).

**Change:** `TrackedContact` gains `channelId`+`channelType` (replacing `channel`); `_trackContact()` stores under scoped keys `id:<channelId>|<identifier>` and `type:<channelType>|<identifier>`; `_isTrackedConversation()` now requires the inbound event's channel scope to match (concrete channel ID when available, channel-type fallback for session-polling events that lack a concrete ID); `_tryMatchPendingAsk` filter tightened via new `_matchesInboundChannel()` (concrete inbound channel ID must equal the ask's channel ID). Adds `_resolveChannel`/`_resolveChannelType` helpers.

**Review:**
- Fixes a genuine spoofing hole: working-tree `_isTrackedConversation()` (line 880) ignores `_channelType` entirely and fuzzy-matches sender substrings globally — a Telegram "Bob" is trusted because WhatsApp "Bob" was messaged. Verified the vulnerable code is present unchanged in the working tree (lines 865–899).
- Design is sensible; the `type:` fallback keeps session polling working but retains a smaller same-channel-type confusion surface (documented in PR). Acceptable.
- 3 tests cover cross-channel rejection, same-channel acceptance, polling fallback.
- Conflicts: none with working tree or main; conflicts with PR #45 (see above). Author could not run vitest (Node 18) — run before merge.

### PR #38 — "feat(skills): add MiniMax-AI/cli as default skill tap" (author: octo-patch, 2026-04-13) — **close (offer plugin/user-tier path)**

Adds one file: `resources/agents/core/skills/mmx-cli.md` (+45) — a skill instructing agents to use the `mmx` CLI (MiniMax) for text/image/video/speech/music generation.

**Review:**
- The bundled core skill set (`auto-commit`, `concise`, `test-driven`, `scope-discipline`, …) is exclusively generic coding-behavior skills; this would be the first vendor-product promotion in core. That's a curation/product decision, and it effectively endorses installing a third-party CLI + API key.
- Minor format issue: `icon: lab.png` (other skills use icon names, not filenames).
- Strategic overlap: the uncommitted Canvas v2 work (`ImageGenerationService`, `StitchService`, video/SVG generation) is building first-party media generation — bundling a competing vendor skill is awkward.
- Users already have two supported paths: `~/.mysti/agents/skills/` (user tier) or the `wshobson/agents` plugin sync. Recommend closing with a friendly note pointing at those, possibly listing mmx-cli in README/docs instead.

### PR #37 — "feat: add MiniMax provider support" (author: octo-patch, 2026-04-08) — **feature-backlog / merge-with-changes after Canvas v2 lands (maintainer product call)**

Files: new `src/providers/minimax/MiniMaxProvider.ts` (+342), `package.json` (+71/−5, 6 new `mysti.minimax*` settings), `ProviderRegistry.ts`, `types.ts` (ProviderType/AgentType unions), `BrainstormManager.ts` (AGENT_STYLES), test helpers + 13 unit tests.

**Review:**
- Technically clean: OpenAI-compatible SSE provider modeled on `LocalAIProvider`; key from `mysti.minimaxApiKey` or `MINIMAX_API_KEY`; only contacts the configured `minimaxBaseUrl` (default `https://api.minimax.io/v1`); no suspicious network/key handling found in the diff.
- Mergeable vs main today, **but will conflict with the uncommitted `feature/visual-testing` branch**: both modify `package.json` and `src/types.ts` (working-tree `ProviderType` at line 18 currently has 11 entries; PR edits that union). BrainstormManager/ProviderRegistry are not locally modified, so those hunks are safe.
- Product question: 13th backend, second pure-API provider with a vendor key. If wanted, merge AFTER `feature/visual-testing` lands and rebase; also update CLAUDE.md/README provider counts and verify MiniMax model names (`MiniMax-M2.7`) are still current (PR is 2 months old). Otherwise park in backlog with a comment.

---

## Open Issues

### #46 — Project memory reused across workspaces via lexical path (3em0, 2026-06-01) — **valid; resolve by merging PR #47**
Detailed, reproducible report; code citations match the working tree exactly (`MemoryManager.initProjectMemory` truncated raw-path hash; injected into provider context in `ChatViewProvider` `fullSystemContext`). Threat model is niche (shared `$HOME`/symlink alias), so low severity, but the fix is cheap. Close when #47 (plus migration tweak) merges.

### #44 — Pending ask replies mis-bound across panels (3em0, 2026-06-01) — **valid; resolve via PR #45 rebased on #43**
Confirmed against working tree (`_tryMatchPendingAsk` falls back to first/oldest match across all panels; `panelId`/`askId` stored but unused for matching). Real prompt-injection/approval-spoof vector when multiple panels ask the same contact. Close when the combined ChannelBridge fix merges.

### #42 — Cross-channel identity confusion in ChannelBridge (3em0, 2026-06-01) — **valid; resolve by merging PR #43**
Confirmed against working tree (`_trackContact` keys only on normalized sender; `_isTrackedConversation` ignores channel; substring fuzzy match). Highest-quality of the three security reports; enables inbound message spoofing + agent-context injection + `stop`/`cancel` abuse across channels. Close when #43 merges.

### #41 — Partnership inquiry from MyClaw.ai (2026-05-27) — **close**
Business-development outreach, not a code issue. Reply with a contact email (baha@deepmyst.com) and close.

### #40 — OpenCode remote/HTTP mode for Windows+WSL/Docker (wywerne, 2026-05-18) — **feature-backlog**
Valid request: `OpenCodeProvider` is pure CLI-spawn today (no HTTP/`opencode serve` support found in `src/providers/opencode/OpenCodeProvider.ts`). Would need an HTTP/WS transport mode with endpoint setting (`http://localhost:4096`), health check, optional auth token. Medium effort; aligns with official OpenCode Windows/WSL docs and the recurring Windows pain (#14/#27/#30). Backlog with positive comment.

### #39 — "Not able to use custom models" (mguirao, 2026-04-17) — **needs-info (+ small known fix)**
Both screenshots are images (text not retrievable via API). Custom-model plumbing exists and works for Codex (`mysti.codexModel` → `CodexProvider._getEffectiveModel()` line ~1003 prefers custom over dropdown; same pattern in Claude/Gemini/Copilot/Cursor providers). One real bug found while triaging: the **write-side** `providerModelKeys` map in `ChatViewProvider` (~line 3607) omits `'qwen-code'` (read-side map at ~line 448 has it), so qwen custom models can't be saved from the UI. Codex dropdown list is currently fresh (`gpt-5.4-codex` default). Ask the reporter for: provider used, exact setting key, exact chat error text, Mysti version. Fix the qwen map omission regardless.

### #36 — Listed in Awesome Codex CLI (2026-04-01) — **close**
Notification only. Optionally add the badge to README; no code work. Thank and close.

### #34 — OpenClaw Gateway DEVICE_IDENTITY_REQUIRED (Lio-MABA, 2026-03-29) — **valid; fix-ourselves (medium-large)**
Confirmed in working tree `src/providers/openclaw/OpenClawGateway.ts` (~lines 181–200): the `connect` params contain no `device` object and the `connect.challenge` payload/nonce is received but never signed (`challengeHandler` ignores `_payload`); auth is token-only. Any OpenClaw Gateway with device auth enabled (default per reporter) rejects Mysti with 1008 `DEVICE_IDENTITY_REQUIRED`/`NOT_PAIRED`. Fix: generate/persist an ed25519 device keypair (globalState or `~/.mysti`), derive stable `device.id` from the pubkey fingerprint, sign the challenge nonce, include in connect frame — mirroring the openclaw CLI. High impact for the OpenClaw/Active Mode feature set (ChannelBridge etc. all sit behind this connection).

### #33 — Agent config not persisted when switching agents (isCopyman, 2026-03-28) — **valid; fix-ourselves**
Root cause confirmed in `ChatViewProvider.ts` ~lines 3566–3599: the selected model is a single shared value (global `defaultModel` or per-panel `settingsOverrides.model`); on provider switch, if the current model isn't valid for the new provider it is overwritten with the new provider's default. There is no per-provider memory of the last dropdown selection, so Claude→Codex→Claude loses "Opus 4.6". Fix: persist a `providerId → lastSelectedModel` map (globalState or settings) and restore it on switch. Small-medium effort.

### #32 — "support opus 4.6 1m" (isCopyman, 2026-03-28) — **valid small feature; fix-ourselves**
Claude model list in `ClaudeCodeProvider.config.models` (lines 60–86) has `claude-opus-4-6` (200k) but no 1M-context variant. Blocking detail: the 1M variant id uses brackets (`claude-opus-4-6[1m]`), and BOTH `MODEL_NAME_PATTERN` (`src/utils/validation.ts` line 27) and the package.json setting patterns exclude `[`/`]` — users cannot even enter it as a custom model. Brackets are shell-glob chars and Mysti spawns with `shell:true` on Windows, so the safe fix is adding a dropdown entry (with proper arg quoting/escaping verified) rather than blindly widening the validation regex.

### #31 — "Agent silent for 90s — aborting" in brainstorm (collectifweb, 2026-03-24) — **valid; fix-ourselves (promised, not delivered)**
`BRAINSTORM_SILENCE_TIMEOUT_MS = 90 * 1000` (`src/constants.ts` line 80) is still enforced by `BrainstormManager._iterateWithSilenceTimeout()` (line ~838): any 90s gap between stream chunks kills the agent — long thinking phases (Codex finalizing, Claude extended thinking) routinely exceed this. Owner promised on 2026-03-24 to "disable timeout in the next update due this week"; not done as of working tree. Fix options: raise default to 5–10 min, make it a `mysti.brainstorm.silenceTimeout` setting, and/or warn instead of abort once the agent has produced output. Cheap fix, user-facing promise outstanding ~3 months.

### #30 — "errors using the cli" Windows EINVAL/ENOENT (navelya, 2026-03-18) — **duplicate family of #14/#27; fix-ourselves then close as dup**
Windows 11, Gemini slow + Copilot `spawn EINVAL`. Commenter ryzen88 posted a detailed Codex-generated diagnosis (shell:true for spawn, real .exe paths instead of npm shims, node wrapper for Gemini); owner invited a PR that never arrived. Same root-cause cluster as #14/#27 (Windows spawn + PATH/node resolution). Fold into one canonical Windows-spawn epic and close as duplicate.

### #29 — Deploy on Open VSX Registry (matbgn, 2026-03-12) — **feature-backlog (low effort, committed)**
Owner already replied "definitely something we can work on". No `.github/workflows` exist and no ovsx config anywhere. Action: `npx ovsx publish` of the existing .vsix (manual first), then add CI. Unblocks VSCodium/Antigravity users (Antigravity also appears in #30).

### #28 — Add opened tab/selection to context with quick toggle (MuTsunTsai, 2026-03-12) — **valid; fix-ourselves (half-built)**
Plumbing exists but is dead-ended: `extension.ts` (~lines 499–529) posts `activeFileChanged`/`selectionChanged` to the webview when `autoContext` is enabled, but **no handler for either message exists anywhere** (grep of `src/` and `src/webview/` finds zero consumers), and `ContextManager.getContext()` returns only manually added items. The `contextMode` auto/manual toggle exists in settings UI but auto mode doesn't actually attach the active file. Finish the feature: webview handlers + auto-inject active file/selection at send time + a quick toggle pill near the input (parity with the Claude Code extension). Owner promised it 2026-03-12.

### #27 — `'"node"' is not a command` on Windows (MuTsunTsai, 2026-03-12) — **valid; fix-ourselves (root cause identified)**
Root cause found in `src/utils/platform.ts` `findNodeDir()` (lines 304–361): every candidate path is Unix-only (`~/.nvm`, `/usr/local/bin`, `/opt/homebrew/bin`, …) and it tests for a file named `node` (not `node.exe`), so on Windows the enriched PATH never gains node's directory. npm `.cmd` shims (gemini.cmd etc.) invoke `"node"` and fail inside cmd.exe when the extension host PATH lacks node — exactly the reported error, and `useShellForCli` can't help. Fix: add Windows candidates (`%ProgramFiles%\nodejs`, `%APPDATA%\npm`, nvm-windows `%NVM_HOME%`/`%NVM_SYMLINK%`, volta) and check `node.exe`. A "Bogarne: still not fixed" comment (2026-04-08) confirms it persists post-0.4.0. Part of the Windows epic with #14/#30.

### #14 — `Error: spawn EINVAL` (kaiwenshen-vibing, 2025-12-30) — **valid, canonical Windows reliability epic; fix-ourselves**
Longest-running open thread (7 participants). v0.4.0 auto-enabled `shell:true` on Windows (`BaseCliProvider` lines 550/927) which fixed some cases, but multiple users (ToXinE, max86Git) report failures persisting on 0.4.0; sub-reports include Copilot Enterprise model-list mismatch and very slow Gemini. Remaining work: the #27 node-dir fix, `.cmd`/`.exe` shim resolution per CLI, arg quoting under cmd.exe, and better spawn-failure diagnostics (surface the resolved path + PATH in the error card). Keep open as the umbrella; close #30 (and arguably #27) into it once fixed. This is the single biggest user-pain cluster in the tracker.

---

## Cross-cutting recommendations for the plan

1. **Security trio (#42/#44/#46 + PRs #43/#45/#47)**: same reporter, high quality, all confirmed against the working tree. Merge order: #43 → #45 (rebased; merge the two `channelBridge.test.ts` files) → #47 (add memory migration). None touch files modified on `feature/visual-testing`, so they can land on main independently of Canvas v2. Run `npm test` on Node 20+ for all three (author couldn't).
2. **Windows epic (#14 canonical; #27 root-caused; #30 dup)**: fix `findNodeDir()` for Windows + spawn diagnostics. Highest user-impact bug cluster.
3. **Quick wins**: #31 brainstorm timeout (promised in March), #33 per-provider model persistence, qwen-code omission in custom-model save map (found via #39), #32 Opus 4.6 1M entry.
4. **Backlog**: #40 OpenCode HTTP mode, #29 Open VSX publish, #34 OpenClaw device identity (medium-large but gates the whole Active Mode feature), PR #37 MiniMax provider (post-Canvas-v2 rebase if wanted).
5. **Close/no-code**: #36, #41, PR #38 (point to plugin/user skill tiers).
