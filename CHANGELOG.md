# Changelog

All notable changes to the Mysti extension will be documented in this file.

## [Unreleased]

### Added

- `Mysti: Restore Canvas Recovery Copy` restores unsaved edits that a failed Canvas close kept in extension storage. It lists only the current workspace's copies. It restores in place only when the design is unchanged and not open; otherwise it creates a new "(recovered)" design. It asks before bringing back a deleted design. Restore is never automatic.

## [0.5.2] - Review candidate, unpublished

### Changed

- Native approval transports replace notification-time permission cards on the supported Claude, Codex, OpenClaw and ACP paths. Bounded installed-version checks use isolated local model fixtures; authenticated compatibility remains a release gate.
- Gemini, Qwen, Cline and OpenCode use isolated ACP sessions with explicit tool restrictions. Copilot is limited to read/search because the reviewed native runtime bypasses approval for some writes and shell operations. OpenCode shell execution is unavailable in this transport.
- Cursor and Continue reject restricted turns before launch until they have an enforceable native approval path. Their fully unrestricted modes remain available. A tool notification requiring approval stops the turn; the operation may already have executed. This supersedes 0.5.1's process-pause description.
- Provider capabilities distinguish native execution, proposed tools and no tools. HTTP providers and Cursor replay prompt history. `/panel` is described as independent answers shown together; it does not add a synthesis pass.
- Desk pairing and grants now support local status commands between paired editor instances on the same computer. Temporary recipient-specific links require signed requests and replies, honor grant expiry/revocation and call limits, and stop working when serving is disabled. Separate workspace lookup commands now prepare a bounded coordinate snapshot within machine, workspace and peer scopes. Scope/file changes invalidate lookup links and cached replies. Remote task execution remains unimplemented.

- Added cross-machine Desk status/lookup commands in matching native platform builds, with device-signed transport links, explicit relay configuration, bounded native child processes and encrypted local regression tests. Universal builds retain local Desk. Approved relay and two-machine acceptance remain open; no public relay is selected by default.

### Fixed

- OpenClaw process-group cleanup waits for actual disappearance, including macOS zombie groups that temporarily return EPERM. Failed cleanup retains owned state for diagnosis.
- ACP cleanup waits for the native process and its inherited pipes to close before removing private state. Unverified shutdown reports an error and retains the state.
- Cursor shares the common Stop/replacement lifecycle, passes prompts as literal arguments without a shell, and keeps API keys out of command arguments.
- Chat keeps Stop visible after the first streamed token. The composer stays in its active-turn state until completion, failure or cancellation, preserving Escape and queued follow-ups during streaming.
- Chat requests initial state after its message listener is ready, preventing a fast host from losing the first state update during sidebar or tab startup.
- History clears serialize with appends. Partial journal tails no longer swallow the next valid record, and existing symlinks are refused. Canvas backup restore preserves the primary before replacement and fails if that recovery copy cannot be made.
- Canvas atomic saves retry transient Windows rename failures within a bounded interval. They preserve the previous file throughout and still report persistent failures.
- Canvas display/layout helpers no longer import migration and the JSX compiler into the browser bundle, reducing it from 355,782 to 183,372 bytes and clearing webpack size warnings without raising thresholds.
- Coordinator budgets have their own per-run owner. Source and browser lint warnings are resolved without relaxing the rules.

Conversation and Canvas schemas remain at version 1. Keep data snapshots and the
prior archive before downgrade; schema compatibility with every older release is
not established. Cross-platform hosted CI, minimum-editor acceptance,
authenticated providers and two-machine Desk checks remain open. This candidate
has not been published or merged into the original working checkout.

## [0.5.1] - 2026-09-05

Pre-release channel (odd minor). First publishable build since 0.4.0; everything under 0.4.0's
"What's New" in the READMEs still describes that release. This entry covers the Plan 27 production-readiness
pass on top of the features listed under *Added* below.

### Security

- **Repository-authored instructions are fenced before they reach a CLI backend.** `mysti.md` and `.mysti/rules/*.md` were joined raw into the system position — two lines after auto-memory was correctly nonce-fenced. Both now pass through the same `UNTRUSTED DATA` fence, so a cloned repository's instructions are reference material, not operator commands.
- **On Windows, the permission card denies instead of prompting over a running tool.** The gate pauses the CLI while you decide; Windows cannot pause it, and the card was shown while the tool executed underneath. When the process cannot be held, the action is denied and the card says so — the same fail-closed rule collaborator children already followed.
- **Bundled agent content is re-verified at the moment it is used, not once at load.** A core persona, skill or role tampered on disk after activation kept its `trusted` flag — and, for roles, its write authority — because the integrity check ran once and was carried forward by value. Trust is now a property of the bytes about to be injected. A workspace skill's `category` could also reach the coordinator's system sentence verbatim; it is now clamped to a short slug.
- **Model- and tool-supplied URLs pass one origin policy.** A URL scraped from an MCP tool's text was fetched with no scheme, host or address check. Outbound fetches now reject non-http(s) schemes, embedded credentials, and private, loopback, link-local and metadata addresses — including after redirects. MCP bearer tokens go only over HTTPS or to loopback.
- **A repository can no longer widen its own authority through settings.** `ollamaEndpoint`, `localaiEndpoint`, `useShellForCli`, `visualTest.devServerCommand`, every `agents.*CustomPrompt` / `*Persona`, the `autonomous.*` policy keys, and (round 3) `visualTest.enabled`, `visualTest.interactions` and `codexProfile` are machine-scoped; a parity test asserts, in both directions, that every authority-bearing setting is either machine-scoped or clamped. Values a repository had set for those three keys in `.vscode/settings.json` are ignored from this release. `visualTest.url` stays workspace-configurable on purpose: `visualTestPolicy` refuses any URL outside the machine-scoped `visualTest.allowedOrigins`, so per-repo dev-server ports remain legitimate and the destination is already machine-controlled. The superseded `mysti.visualTest.interactionsEnabled` (declared, default on, read by nothing) is removed — VS Code will flag it as unknown if it is still in your settings.
- **A v0.4.0 `defaultMode: "plan"` migrates to `quick-plan`, not `default`.** The legacy value meant "never write" and was being coerced to the tier that writes — and on the send path the raw value still went through, so CLI backends fell to their no-permissions flag and the coordinator's local-execution gate opened for exactly the user who had asked it never to. Unknown mode values now coerce to the safe end.
- **A user- or workspace-authored role no longer leads the collaborator prompt.** In `@agent:role` collaboration, a role that is not integrity-verified (anything under `~/.mysti/agents/roles`, `.mysti/agents/roles`, synced plugins, or a bundled file tampered after activation) now runs as the neutral Advisor stance with its body fenced as reference data, matching how personas and skills were already treated. This changes legitimate user-authored roles too, not only tampered ones: they inform the collaborator, they do not instruct it. The webview card still shows the role's name.
- **Shared-conversation deep links are treated as hostile input.** `vscode://…/import?data=…` is unauthenticated; its payload is now capped (message count, content and title length, inflated size — a deflate bomb is refused before inflation), coerced (provider id must be a real backend, including the `mysti.defaultProvider` fallback) and pruned (non-record elements dropped), never thrown out of `activate()` and never persisted raw. Per-panel context keys are swept on activation so a disposed panel's persisted context cannot accumulate.

### Fixed

- **Codex remembered nothing after the first turn.** History was suppressed whenever a session id existed on the assumption the CLI would resume it; Codex records a thread id but has no resume flag. Suppression now follows the provider's declared `sessionKind`. `cli-resume` providers are unaffected.
- **Stop no longer corrupts Claude Code's stdin.** The default interrupt wrote `\x03` into the stream-json pipe, making the next message unparseable.
- **A backend that crashed mid-stream was reported as a complete answer.** Persistent-process exit codes are inspected; a non-zero exit or signal emits an error, never `done`.
- **You can see the diff before approving an edit.** The permission card for Write/Edit renders the same line-level diff the edit report already computed, with every value escaped. Round 3: the card now receives the tool's real name and input (capped by size, up to 64 KB, with an explicit truncation marker) instead of a 500-character JSON slice, so a realistic multi-line Edit renders a diff rather than nothing; the card's headline names the target path; the diff is capped before it is built rather than after.
- **The first-run wizard could not be dismissed.** Its exit button was an inline handler the page's own CSP blocked, and dismissal was never persisted. Every inline handler is rebound and dismissal sticks.
- **`scrollToBottom` was called 21 times and defined nowhere**, throwing on every coordinator, job, brainstorm and permission-card render. `media/**/*.js` is now linted with `no-undef` so this class cannot recur.
- **Opening a canvas on Windows broke every subsequent send** — the shell-argument validator rejected the backslashes in `--mcp-config <path>`.
- **Corrupt conversation storage can no longer prevent activation.** The store is schema-versioned and validated; an unreadable blob is parked under a named key rather than thrown out of `activate()`, and the import path now applies the same size caps as live writes.
- **Canvas `edit_page` / `insert_page` respect pins.** The page-level ops — the only write path 13 of 14 CLI backends are taught — replaced artboards wholesale, destroying hand edits that `write_page` correctly refused on; `insert_page` could also shadow a live pinned artboard by reusing its id.
- **Live model-authored HTML artboards no longer allow `img-src https:`**, closing the canvas's one outbound beacon channel. The chat panel had already made the same decision. Round 3: the canvas SHELL's own policy — which every `srcdoc` artboard inherits — drops its `https:` scheme-sources from `img-src`, `font-src` and `connect-src` and gains `form-action 'none'; base-uri 'none'`, so the canvas is no longer the one Mysti webview that could fetch the internet.
- **Canvas `delete_page` respects pins** and the pin-refusal message names a tool the calling backend can actually reach; `regraftPins` no longer manufactures ownership of cells the human never touched, and applying a legacy patch no longer clobbers the source view.
- **Four settings were read under names `package.json` never declared** (`mysti.mode`, `mysti.defaultAccessLevel`, `mysti.model`, `mysti.autonomous.enabled`), so the configured mode, access level and model were silently ignored on those paths.
- **`mysti.checkpoints.maxSnapshots` is enforced.** It was declared with a default of 200 and read by nothing.
- **The `mysti.mysti.skills` description was false**: it said `full` was unimplemented while `full` gates `publish` / `skillrun`. It now states all of the co-conditions.

### Removed

- **Eight settings that were declared and read by nothing** — `mysti.canvas.autoSave`, `mysti.canvas.defaultVariantCount`, `mysti.canvas.stitchDeviceType`, `mysti.canvas.stitchVariantCount`, `mysti.desk.bind`, `mysti.desk.maxDeskCalls`, `mysti.desk.shareCeiling`, `mysti.activeMode.showActivityFeed`. None had a read site anywhere in the extension, so changing them never did anything; they only appeared in the Settings UI and implied a control that did not exist. The unused settings remain unknown; `mysti.desk.shareCeiling` has since been restored with a production reader for explicit local workspace lookup, defaulting to an empty scope. A test now pins the deletions and catches the next declared-but-unread setting at the moment it is added.

### Packaging & process

- Publishable: `0.5.1` on the pre-release channel; an explicit `capabilities` block (`untrustedWorkspaces: false`, `virtualWorkspaces: false`); recursive `.vscodeignore` globs (2 MB of Playwright `.d.ts` no longer ships); two dead vendored files excluded from the artifact; walkthrough images actually included; `@modelcontextprotocol/sdk` declared instead of resolving through a transitive hoist; `vsce` pinned per invocation with `--dependencies` (the `--no-dependencies` form ships an extension with Playwright missing).
- CI from zero: `.github/workflows/ci.yml` (type-check, tests on Linux/macOS/Windows, lint, package-shape check) plus CODEOWNERS, issue and PR templates, dependabot and `SECURITY.md`. Every CPU-bound test loop carries an explicit budget, so a timeout is a real regression.

### Added

- **The agent catalog — `@mysti` can find and read the project's reusable practices (Plan 20)**. Off by default (`mysti.mysti.skills`, machine-scoped: `off` | `prose` | `full`).
  - **Retrieval** (`prose`): the coordinator could previously not see personas/skills/roles at all — it had 42 bundled artifacts available and reached none of them. `<skill:…>` searches the catalog (BM25 with field boosts, stemming, stop-words and a relevance floor) and reads one by id, optionally a bundled `references/` file. The always-present cost is an **O(1) category header** — names are deliberately never listed, because selection accuracy is published as declining past 30–50 always-present entries. Nothing is injected at all below 8 artifacts, or when the setting is off.
  - **Measurement, not faith**: `mysti.skillReport` ("Mysti: Agent Catalog Report") is a go/no-go instrument built to be able to say **no** — below 30 runs it refuses a verdict, below 30% engagement it prints NO-GO, and above that it prints engagement *and* completion delta with the explicit note that engagement alone is not value. It records artifact ids only — never queries, content or paths — and nothing leaves the machine. The published comparison band is 70–80% healthy, ~19% drifting.
  - **Authoring (`full`) is EXPERIMENTAL** and gated behind local execution + a trusted workspace + a real OS sandbox. `@mysti` can stage a capability, and `<publish:…>` runs a verification ladder: content scan and manifest conformance first (nothing executes), then a **forced card showing the full script bytes**, then an evidence check, then a second forced card to register. Both cards auto-DENY on timeout.
  - **The evidence cannot be manufactured.** A manifest may list the commands a capability replaces, but those are looked up in the host's own record of commands it actually ran. The model can *point at* evidence; it cannot create it. Where nothing matches, the card says so rather than quietly passing. **The ladder proves conformance and host-observed corroboration — not correctness**, and says so on the card.
  - **`<skillrun:…>` is a narrowing of `bash`, not a synonym**: the command shape is host-owned, the interpreter comes from a fixed `{bash, python3, node}` map resolved to an absolute path, and arguments are validated against a closed schema then passed **in a file** — so no model-supplied string reaches a shell at all.
  - **Governance**: `Mysti: Review Agent Proposals` is the only path from staged bytes to a live definition (a command, not a permission card). `Mysti: Quarantine All User Agent Artifacts` is a one-action kill switch that **moves** artifacts to a timestamped folder rather than deleting them. Per-capability health tracks `helped` and `hurt` **separately, never averaged** — a 6-help/6-harm capability is unstable, not neutral — with quarantine at 2 consecutive failures (lifted by a success) and nothing ever auto-deleted.

- **Agent content is now trusted by INTEGRITY, not by location (Plan 20 Phase 0)**. Trust used to be decided purely by which directory a file was found in, and the bundled `resources/agents/core` directory is writable by any local process — including a delegated CLI backend, which runs unsandboxed. A build-time SHA-256 manifest of every bundled agent file is compiled **into the extension bundle** (a sibling JSON would be writable by exactly the attacker it defends against) and verified at load. Only verified bundled content reaches the system prompt; everything else — plugin, user, workspace, or a core file that no longer matches — is delimited as reference data with an explicit authority ceiling. Content that hides text from human review (Unicode Tag Block, zero-width, bidi overrides) or forges a coordinator directive fails the load outright, and frontmatter that tries to grant itself tool access is refused rather than ignored. Emoji, ZWJ and Arabic/Indic shaping are deliberately unaffected.

- **Connected MCP tools now carry their real argument schemas.** `listTools()` returns each tool's `inputSchema` and the coordinator was discarding it, so the model had to guess argument names — and each wrong guess costs an approval. Schemas are now passed through (bounded and key-filtered), with the most-used tools carrying full parameters and the rest retrievable via a new read-only `findtool`; attaching all of them would have been a ~12k-token regression rather than a fix. Tool metadata a user approved is also **pinned**: if a server later rewrites a tool's description — the field that lands in the model's unfenceable tool-definition tier — the next approval card shows the change side by side.

### Fixed

- **The permission gate could fail OPEN, and the settings UI itself offered a value that triggered it.** `shouldGateToolUse` decides by matching string literals and ended in a bare `return false`, so any mode/access-level combination it did not explicitly handle was **not gated** — while every CLI provider runs with its native permissions bypassed, and `@mysti`'s own file/shell operations call this with no CLI beneath them. The settings dropdown offered `defaultMode: "plan"`, which is not a mode the code handles; separately, `mysti.accessLevel` is window-scoped, so a cloned repo could supply a value outside the enum (VSCode does not validate declared enums at read time) and the existing clamp passed it through untouched. The gate now fails **closed**, unrecognized values are coerced to "ask" at the boundary, the clamp rejects non-enum workspace values, and a test asserts the declared enums match the TypeScript unions so this class of drift cannot recur silently.

- **Model and tool output is now sanitized before it is rendered.** Markdown from the model, a tool result, or a quoted repo file was written straight into the DOM with no sanitizer present. The webview CSP already blocked script execution and remote images, so the real exposure was **UI spoofing** — markup that looks like Mysti's own permission card, on the surface where you decide what to approve. All rendering now goes through DOMPurify (vendored locally, never a CDN) and **fails closed**, showing plain text if the sanitizer is unavailable. The CSP also gained `form-action` and `base-uri`, neither of which inherits from `default-src`.

- **Standalone execution for the Mysti agent (Plan 19 Phases 0–3 + Phase 4 foundation)** — `@mysti` can now create/edit/patch files AND run commands (tests/builds/linters) by ITSELF, so it works even when no CLI backend is installed to delegate to. Off by default (`mysti.mysti.localExecution`, machine-scoped).
  - New gated directive tags: `<write:…>`, `<edit:…>` (with `replace="all"`), `<bash:…>`, and **`<patch:…>`** — one ATOMIC multi-file change (Add / Update SEARCH-REPLACE / Delete / Move; every path validated + secret-checked in memory first, so any escape voids the whole patch with nothing written). Only recognized when execution is enabled — otherwise they degrade to visible text.
  - **Git & deploy:** git runs through the sandboxed `bash` (read-only git auto-runs; writers show a card; `.git/config` + `.git/hooks` are read-only *inside* the sandbox so nothing can repoint `origin` or plant a hook). **Remote-effect / deploy commands** (push, publish, deploy, ssh, cloud CLIs) get a **modal default-DENY** confirmation — a checkpoint can't undo a push.
  - **Native tool-calling (foundation):** the coordinator's op set now has an OpenAI-style function-tool encoding (`coordinatorTools.ts` — schemas + a conservative capability check + a `tool_call → directive` converter) so capable models can eventually use native tool-calling while unknown models keep the proven text protocol. (The streaming-loop wiring is a follow-up.)
  - **Capabilities up, authority unchanged:** every op funnels through one new chokepoint (`MystiLocalExec`) that reuses the coordinator's existing security substrate verbatim — the **same permission gate** as CLI backends (`_shouldGateToolUse` → `requestPermissionInline`; default-deny in ask modes, panel-gone auto-deny), workspace-scoping + secret-file blocking (`MystiLocalTools.resolveWriteTarget` / `_safeResolve`), a **pre-op checkpoint** (undoable via the existing shadow-git `CheckpointManager`), and UNTRUSTED nonce-fencing of the result. A local op is never more trusted than a delegated one.
  - **Sandboxed `bash`** (`MystiSandbox`): commands run under an OS sandbox — **macOS Seatbelt** / **Linux bwrap** — with **no network** and **writes limited to the workspace** (empirically validated). Destructive commands (`rm`, `sudo`, `git push --force`, `curl|sh`, …) are hard-blocked by the shared `SafetyClassifier` vocabulary; chained/compound commands (`&&`, `|`, `;`) can never be auto-approved. On platforms with no sandbox primitive (Windows / Linux-without-bwrap) only simple allowlisted read-only/build commands run — fail-closed, never arbitrary shell. Network is off by default (`mysti.mysti.bashNetwork`). `bash` auto-runs (no card) only when the mode wouldn't gate AND a capable coordinator model is pinned — otherwise every command is confirmed.
  - **Fail-closed guards:** disabled in untrusted workspaces and in plan / read-only tiers; a tightened per-run budget (`_MYSTI_MAX_LOCAL_EXEC`); machine-scoped so a workspace cannot enable it. (git/deploy + native tool-calling are later phases.)

- **The Mysti Agent (`@mysti`) — a coordinator that plans and delegates (Plan 15, sync MVP)**: type `@mysti <request>` (or `/mysti …`) and Mysti decomposes it into a task DAG, runs the steps across your backends, and synthesizes one answer.
  - **How it works**: the coordinator (running on a **free OpenRouter model** by default) emits a validated JSON DAG (not fragile tool-calling); the steps execute frontier-by-frontier through the shared, bounded, **gated** `CollaboratorPool` (Plan 14), with each step's output threaded into its dependents; a final pass synthesizes the results. Routing is **backend-only** (each step runs on a provider using its own model — no per-call model routing, which would thrash persistent-process respawn). `mysti` can never route to itself, and node/depth caps bound fan-out.
  - **OpenRouter is now a full backend** (the 14th provider): any of 300+ models via the OpenAI-compatible API with real SSE streaming, **free by default** (`openrouter/free`). It's a completion backend (no tool execution), so the coordinator sends file-editing work to agentic CLI backends and text/analysis to OpenRouter free. Key: `mysti.openrouter.apiKey` / `OPENROUTER_API_KEY`; model: `mysti.openrouterModel`.
  - **Free by default, opt-in paid fallback**: the coordinator discovers a live free model at runtime (the roster rotates, so nothing is hardcoded) and is 20-rpm-aware (semaphore + backoff). It only touches a paid model if you set `mysti.openrouter.fallbackModel` — otherwise it degrades gracefully and never spends.
  - **Security floor**: delegation (`task`/`agent`/`dispatch_agent`) is now a first-class **gated `delegate` action** (previously ungated `file-read`) — default-deny, auto-approved only under explicit full-access/autonomous, and never silently approved in autonomous mode.

- **Agent Collaboration Roles (Plan 14)**: call any agent(s) as an advisor, critic, reviewer, second-opinion, coworker, or collaborator — across every provider, in one message
  - **Grammar**: `@agent:role` (e.g. `@google-gemini:critic @openai-codex:reviewer here's my plan`) — role-tagged mentions run as a **parallel group**; plain `@agent` mentions keep today's sequential MentionRouter routing. Slash commands `/consult`, `/review`, `/critique`, `/panel` prebind a role.
  - **Autocomplete**: typing `:` after a known agent (`@gemini:`) opens a role picker filtered as you type, with a read-only/writes badge; Tab/Enter/click completes `@agent:role`. Roles flow to the chat UI via `availableRoles` (initial state + live `agentsUpdated`).
  - **Roles are markdown** in the three-tier agent system (`resources/agents/core/roles/`, `~/.mysti/agents/roles/`, `.mysti/agents/roles/`), authored like personas/skills (`mysti.createRole` / "Reload Agents"). Each role declares an **access profile** (`read-only` advisory vs `gated-write`) and a return contract. Six built-ins ship: advisor, critic, reviewer, second-opinion, coworker, collaborator.
  - **`CollaboratorPool`** — one shared bounded dispatch primitive: a real concurrency cap (`mysti.collab.maxConcurrent`, default 3), per-collaborator timeout + transport retry, a cached availability pre-check (uninstalled/unauthenticated CLI → skip-with-hint, never a hang), a structured failure taxonomy (`not-installed`/`not-authenticated`/`timeout`/`crashed`/`stream-error`/`empty-response`/`cancelled`/`denied`), UUID-scoped derived child panels, and cancel fan-out.
  - **Read-only enforcement**: advisory roles hard-deny any non-file-read tool locally, regardless of provider CLI flags. Gated-write roles SIGSTOP the child before the tool runs, await the permission gate, and resume/cancel the **child's own** panel (fixing the legacy sub-agent gate, which cancelled the parent).
  - **Reliability**: completion is a transport signal (the provider `done` chunk), never keyword matching; a `_withDeadline` wrapper races each pull so a provider that ignores cancel still times out; the main agent synthesizes a role-labeled block that surfaces any failed collaborators rather than dropping them silently. Reference material (conversation history + context files) is wrapped in a delimited low-trust block.
- **Kimi Code Provider**: Moonshot AI's terminal coding agent (`kimi` CLI, `MoonshotAI/kimi-code`) — the 15th provider
  - Transport: Agent Client Protocol (`kimi acp`, JSON-RPC 2.0 over stdio) via the persistent-process path — real streaming, thinking (Kimi K2.7 Code / K3 reason), and tool-call visibility; the initialize → session/new → session/prompt handshake is driven reactively from the stream parser (mirrors the Hermes backend)
  - Permission model **fails closed**: ACP is a blocking protocol answered synchronously (before Mysti's async gate can run), so Kimi auto-allows a tool only when the settings mean "don't ask me" (Full access, or edits in the accept-edits tier) and **denies** in every ask/plan/read-only mode — a prompt-injected agent cannot get a dangerous command auto-approved. Read-only kinds (read/search/think) always run; the access snapshot is kept fresh by forcing a respawn on any access/mode change
  - Cancellation and New Conversation **drop the ACP process** (rather than `session/cancel`) so a stale cancelled-prompt response can never terminate or be misattributed to the next turn
  - Models: `kimi-for-coding` (K2.7 Code), `kimi-for-coding-highspeed`, `k3` (up to 1M context), `kimi-k2.7-code`. A `mysti.kimiCodeModel` override is passed to the CLI via `ANTHROPIC_MODEL` (best-effort — the model is otherwise chosen in-session with `/model`)
  - Auth: `/login` inside the CLI (Kimi Code OAuth or a Moonshot AI Open Platform API key) or `MOONSHOT_API_KEY` / `KIMI_API_KEY`; installed via the official script (`curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`) or Homebrew (`brew install kimi-code`)
  - First-class across the whole surface: provider dropdown, model picker, @-mention (`@kimi`), brainstorm agent + synthesis, `@mysti` cross-vendor delegation (family `moonshot`), setup wizard card, and its own logo
- **Continue Provider**: continuedev's open-source coding agent (`cn` CLI, npm: `@continuedev/cli`)
  - Headless print mode (`cn -p`) with the prompt piped via stdin; `<think>` blocks parsed into thinking chunks (response text is never dropped on mixed thinking/prose lines)
  - Permission policy **fails closed** (mirrors Copilot): `cn` emits plain final text with no tool events, so Mysti's stream gate can't fire — `--auto` (full autonomy) is used only for the autonomous tiers (edit-automatically, or full-access) and every ask-tier setting runs `--readonly` instead of silently writing files / running shell commands
  - Custom model as a hub slug via `mysti.continueModel` (`cn --model owner/package`); the base injects channel/system context into the prompt (no `--rule` flag — a multi-line arg would break Windows spawns and double-inject)
  - Honest capabilities: no tool events or usage stats reach headless stdout (`supportsToolUse: false`, `emitsUsage: false`)
- **Hermes Provider**: NousResearch's hermes-agent (self-improving agent with skills, persistent memory, and 300+ models via Nous Portal, OpenRouter, OpenAI, or custom endpoints)
  - Transport: Agent Client Protocol (`hermes acp`, JSON-RPC 2.0 over stdio) via the persistent-process path — real streaming and tool-call visibility; the handshake is driven reactively from the stream parser
  - Permission model **fails closed**: ACP is a blocking protocol answered synchronously (before Mysti's async gate can run), so Hermes auto-allows a tool only when the settings mean "don't ask me" (Full access, or edits in the accept-edits tier) and **denies** in every ask/plan/read-only mode — a prompt-injected agent cannot get a dangerous command auto-approved. Read-only kinds (read/search) always run. The access-level snapshot is kept fresh by forcing a respawn on any access/mode change.
  - Cancellation and New Conversation **drop the ACP process** (rather than sending `session/cancel`) so a stale cancelled-prompt response can never terminate or be misattributed to the next turn; the next turn re-handshakes cleanly and re-sends history
  - Auth via `hermes setup` / `hermes setup --portal`; install script shown per-OS by the setup wizard
  - Model selection stays in Hermes (`hermes model`) — the provider honestly reports `modelSelection: none`

### Thanks

- **[3em0](https://github.com/3em0)** — the only external author of a merged security fix in this release: channel-scoped OpenClaw contact tracking in `ChannelBridge`, closing cross-channel sender spoofing (#43, fixes #42); exactly-one matching for `ChannelBridge` pending-ask replies (#45, re-landed by the maintainer as #48); and project-memory key isolation with legacy-directory migration (#47, re-landed as #49). The re-landed commits carry only tool co-author trailers; the fixes are theirs.

## [0.4.0] - March 2026

### Added

- **OpenCode Provider**: Multi-backend coding agent supporting Anthropic, OpenAI, Google, Groq — closes #25
  - CLI: `opencode run --format json --thinking`
  - Uses configured default model (no hardcoded model list)
  - Agents: `build` (full access) and `plan` (read-only)
  - Session resume via `--session <id>`
- **Qwen Code Provider**: Alibaba's AI coding CLI agent
  - Same streaming protocol as Claude Code (stream-json NDJSON)
  - Approval modes: plan, default, auto-edit, yolo
  - Auth error detection with guided authentication UI
  - Models: Qwen3 Coder, Qwen3 Coder Plus
- **Ollama Provider**: Local LLM inference via Ollama CLI — closes #24
- **LocalAI Provider**: Self-hosted AI model provider — closes #24
- **Provider Logos**: Authentic logos with transparent backgrounds for OpenCode, Ollama, LocalAI, Qwen Code
- **Test Infrastructure**: 360 automated tests via vitest with mock provider system
- **Brainstorm Stability** (18 fixes):
  - Silence-based timeout — agents aborted after 90s of no output (B1)
  - Auth pre-check — validates provider authentication before starting (B2)
  - Synthesis fallback feedback — UI shows "retrying with [agent]..." on failure (B3)
  - Oscillation detection — catches flip-flopping discussion positions (B4)
  - Convergence regex broadening — handles varied score phrasings (B5)
  - Duplicate agent validation — prevents selecting same agent twice (B8)
  - Cancel propagation — stops all sub-processes on cancel (B9)
- **@-Mention Stability**:
  - Sub-agent question timeout — auto-skips after 5 minutes (M1)
  - Max mentions per message — caps at 5 mentions (M2)
  - File resolution warnings — user sees when file mentions fail (M7)
  - Retry process cleanup — cancels previous attempt before retry (M8)
  - Full-path file mention matching — `@src/utils.ts` now resolves correctly
- **New Managers**: CommitSignatureManager, EngagementManager, ProjectContextManager, TeamPresenceManager
- **Editor Integration**: MystiCodeLensProvider, MystiFileDecorationProvider
- **Permission Classifier**: Utility for categorizing CLI operations

### Fixed

- Windows `spawn EINVAL` error — auto-enable `shell: true` on Windows + `mysti.useShellForCli` setting — closes #14
- Brainstorm ignores `mysti.codexPath` — now uses shared provider instance with `_getConfiguredCliPath()` — closes #26
- Mention parsing regex too broad — refined to `/@([\w\-./]+)/` (M3)
- File mention matching too greedy — requires 3+ chars and path boundary (M4)
- Invalid agent mentions produce confusing errors — validates against known agents (M5)
- Empty discussion contributions causing false convergence (B6)
- Text similarity filter dropping short meaningful words like "not", "bug" (B7)
- Qwen Code: Removed invalid `--verbose` CLI flag
- Qwen Code: Fixed bare `-p` flag usage (prompt delivered via stdin)
- Qwen Code: Fixed approval mode values (lowercase: plan/auto-edit/yolo)
- OpenCode: Fixed `[object Object]` error display for non-string error objects
- OpenCode: Removed hardcoded model list causing "Model not found" errors
- BaseCliProvider: Hardened error handling for non-Error thrown objects
- New providers now correctly appear in all UI dropdowns, agent menus, and brainstorm selectors
- Fixed agent selection display showing Claude when selecting new providers

### Changed

- Provider count increased to 12 (was 7): added OpenCode, Qwen Code, Ollama, LocalAI, Manus
- Brainstorm discussion more resilient with convergence guards and silence timeout
- @-mention system more robust with limits, timeouts, and validation

### New Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.opencodePath` | `opencode` | Path to OpenCode CLI |
| `mysti.opencodeModel` | `` | Custom OpenCode model |
| `mysti.qwenCodePath` | `qwen` | Path to Qwen Code CLI |
| `mysti.qwenCodeModel` | `` | Custom Qwen model |
| `mysti.ollamaPath` | `ollama` | Path to Ollama CLI |
| `mysti.ollamaModel` | `` | Custom Ollama model |
| `mysti.localaiPath` | `localai` | Path to LocalAI CLI |
| `mysti.localaiModel` | `` | Custom LocalAI model |
| `mysti.useShellForCli` | `false` | Run CLIs with shell (auto-enabled on Windows) |

---

## [0.3.1] - February 2026

---

## [0.3.0] - February 2026

### Added

- **Cursor Provider**: Full integration with Cursor's headless AI agent CLI
  - Supports Auto, Claude Sonnet 4, Claude Sonnet 4 Thinking, GPT-5, OpenAI o3, Gemini 2.5 Pro
  - Auto-approve mode for full-access workflows
  - Cumulative streaming deduplication for accurate output
- **OpenClaw Provider**: Dual-transport provider with WebSocket Gateway and CLI fallback
  - Primary: Real-time WebSocket streaming via `ws://127.0.0.1:18789`
  - Fallback: CLI spawn with NDJSON streaming
  - Supports Claude Opus 4.6, Claude Sonnet 4.5, GPT-5
  - Configurable thinking levels (off, low, medium, high)
- **Manus Provider** (Experimental): HTTP API-based provider for Manus AI
  - Async polling workflow with multi-turn conversation support
  - Models: Manus 1.6 Max, Manus 1.6, Manus 1.6 Lite
- **Autonomous Mode**: AI works independently with configurable safety controls
  - SafetyClassifier with three levels: safe, caution, blocked
  - Three safety modes: conservative, balanced, aggressive
  - MemoryManager learns user preferences over time with confidence decay
  - Continuation modes: goal-based and task-queue
  - Audit logging for all autonomous decisions
  - Hardcoded safety blocks for destructive operations (file deletion, force push, etc.)
- **@-Mention System**: Multi-agent task routing and file context
  - `@agent` mentions route tasks to specific providers with sequential execution
  - `@file` mentions resolve to transient context items
  - Heuristic-based task generation with AI fallback
  - Auto-retry and dependency tracking for sub-agent tasks
- **Context Compaction**: Smart conversation compaction to prevent context overflow
  - Native CLI strategy (`/compact`) for providers that support it
  - Client-side summarization strategy for other providers
  - Per-panel cumulative token tracking with threshold-based triggering
  - Independent brainstorm agent tracking
- **Brainstorm Team Reasoning**: 5 collaboration strategies replacing simple quick/full modes
  - Quick: Direct synthesis from both agents
  - Debate: Critic vs Defender role-based discussion
  - Red-Team: Proposer vs Challenger adversarial review
  - Perspectives: Risk-Analyst vs Innovator complementary viewpoints
  - Delphi: Facilitator vs Refiner iterative convergence
  - Convergence detection with auto-convergence setting
  - Parallel discussion via interleaved generators
- **Agent Lifecycle Management**: Session lifecycle with idle timeout and process protection
  - Configurable idle timeout (default 1 hour)
  - Cross-platform process tree tracking via `pgrep`/`wmic`
  - Graceful shutdown with child process protection
  - Activity tracking via touch/busy/idle API
- **Slash Command System**: Centralized command registry replacing scattered handlers
  - Organized by sections: Context, Model, Customize, Commands, Settings, Support
  - Provider-specific commands (`/compact`, `/thinking`, `/profile`, `/plan-act`)
  - QuickPick dialogs for model, provider, mode, and access level selection
  - Dynamic values showing current configuration state
- **Per-Panel Session Isolation**: Each webview panel has fully independent state
  - Provider sessions tracked via `_panelSessions: Map<string, PanelSessionState>`
  - Context isolation via `_panelContexts` per panel
  - Independent process management and cancellation per panel

### Changed

- Brainstorm mode now supports 5 collaboration strategies (was quick/full)
- Provider count increased to 7 (was 4): added Cursor, OpenClaw, Manus
- Discussion mode runs in parallel via interleaved generators (was sequential)
- Slash commands now managed by centralized SlashCommandManager

### New Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.autonomous.safetyMode` | `balanced` | Safety mode: conservative, balanced, aggressive |
| `mysti.autonomous.maxSessionDuration` | `24` | Max autonomous session duration (hours) |
| `mysti.autonomous.allowFileCreation` | `true` | Allow file creation in autonomous mode |
| `mysti.autonomous.allowFileEdit` | `true` | Allow file editing in autonomous mode |
| `mysti.autonomous.allowBashCommands` | `true` | Allow bash commands in autonomous mode |
| `mysti.autonomous.blockPatterns` | `[]` | Custom block patterns for autonomous safety |
| `mysti.compaction.enabled` | `true` | Enable context compaction |
| `mysti.compaction.threshold` | `75` | Compaction threshold (% of context window) |
| `mysti.lifecycle.enabled` | `true` | Enable agent lifecycle management |
| `mysti.lifecycle.idleTimeoutMinutes` | `60` | Idle timeout before session expiry |
| `mysti.lifecycle.processTreeTracking` | `true` | Track child processes for shutdown protection |
| `mysti.brainstorm.strategy` | `quick` | Collaboration strategy |
| `mysti.brainstorm.autoConverge` | `true` | Auto-exit discussion when agents converge |
| `mysti.brainstorm.maxDiscussionRounds` | `3` | Maximum discussion rounds |
| `mysti.cursorPath` | `agent` | Path to Cursor CLI executable |
| `mysti.cursorModel` | `auto` | Default Cursor model |
| `mysti.openclawPath` | `openclaw` | Path to OpenClaw CLI executable |
| `mysti.openclawModel` | `claude-opus-4-6` | Default OpenClaw model |
| `mysti.openclawUseGateway` | `true` | Use WebSocket Gateway for OpenClaw |

---

## [0.2.0] - December 2025

### Added

- **Three-tier Agent Loading System**: Progressive loading for personas and skills from markdown files
  - Tier 1: Metadata (always loaded for fast UI)
  - Tier 2: Instructions (loaded on selection)
  - Tier 3: Full content with examples (loaded on demand)
- **Toolbar Persona Indicator**: Quick persona switching from the input toolbar
  - Shows active persona name
  - Click to view all personas or context-aware suggestions
- **Inline Suggestions Widget**: Compact persona recommendations above input area
  - Auto-suggests personas based on message content (enabled by default)
  - Toggle auto-suggest on/off inline
  - Dismiss button to hide suggestions
- **Optional Token Budget**: Control agent context size
  - Disabled by default (0 = unlimited)
  - Enable via settings to limit token usage for agent context
- **Google Gemini Provider**: Full Gemini CLI integration as third AI provider
  - Complete streaming support with `--output-format stream-json`
  - Configurable in brainstorm mode alongside Claude and Codex
- **VS Code Auto-Activation**: Extension activates when AI config files detected
  - Workspace triggers: `CLAUDE.md`, `gemini.yaml`, `codex.json`, `agents.yaml`
  - Directory triggers: `.mysti/`, `.claude/`, `.gemini/`, `.openai/`
- **Custom Language Definitions**: Special file type recognition
  - `.claude.md`, `.prompt.md`, `.gpt.md`, `.gemini.md`, `.codex.md`
  - Enables VS Code extension recommendations for prompt files
- **Latest AI Models**: Updated model support across providers
  - Claude: claude-sonnet-4-5-20250929
  - Codex: GPT-5.2, GPT-5.2 Thinking
  - Gemini: Gemini 3 Deep Think
- **Azure Telemetry**: Anonymous usage analytics via Application Insights

### Changed

- Auto-suggest for personas is now **enabled by default**
- Token budget default changed from 2000 to 0 (unlimited)
- Persona selection now shows inline instead of opening full agent config panel
- Welcome message updated to "Your AI coding team"
- Brainstorm agents now configurable (select any 2 of 3 providers)
- README optimized for VS Code Marketplace discovery

### New Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.agents.autoSuggest` | `true` | Auto-suggest personas based on message content |
| `mysti.agents.maxTokenBudget` | `0` | Max tokens for agent context (0 = unlimited) |
| `mysti.brainstorm.agents` | `["claude-code", "openai-codex"]` | Select which 2 agents for brainstorm |
| `mysti.geminiPath` | `gemini` | Path to Gemini CLI executable |

## [0.1.0] - December 2025

### Initial Release

- Initial release
- Multi-provider support (Claude Code CLI, OpenAI Codex CLI)
- Brainstorm mode with multi-agent collaboration
- 16 developer personas
- 12 toggleable skills
- Plan selection and execution
- Permission management system
- Persistent conversation history
- Context-aware suggestions
- Syntax highlighting with Prism.js
- Mermaid diagram support
- Theme-aware UI (light/dark)
