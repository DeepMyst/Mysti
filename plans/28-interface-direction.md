# Plan 28 — Interface Direction: A Team's Cockpit

- **Date:** 2026-09-05
- **Status:** DRAFT — no code written
- **Inputs:** Live inventory of `media/chat/{index.html,chat.js,chat.css}`, `src/providers/ChatViewProvider.ts`, `src/utils/permissionClassifier.ts`, `package.json`, `src/managers/SlashCommandManager.ts` (file:line refs inline). Comparative review of Claude Code 2.1.x and Codex CLI as shipped in September 2026.
- **Design canvas:** <https://claude.ai/code/artifact/bd6678ca-821f-45a9-883a-1b443aa57710> — 29 artboards: the redesign, every other surface, six use-case storyboards, and the before/after audit.
- **Trigger:** User request to review Mysti's design against the current state of Claude Code and Codex, and design a more productive and elegant developer experience.

---

## Goal

Mysti is a team of agents wearing the interface of a single chatbot. Fifteen backends, a coordinator that delegates, background jobs, checkpoints, and a permission gate better than most competitors — all of it reaching the developer through one column of messages and a drawer of 183 settings. **The engine is ahead of the cockpit.** This plan closes the gap in six independent moves.

Nothing here changes the security model. The gate stays the single chokepoint, machine policy can still only lower authority, untrusted results keep their fence. Phase 1 in fact *shrinks* the reachable authority space (§6.1).

---

## 0. The verdict in five sentences

The permission card is the strongest thing in the product and needs three additions, not a rewrite. The same policy decision is asked four separate ways across two surfaces that can disagree, which is the shape of seam that produced the B1 fail-open. There is no way to speak to a running turn — the single largest productivity gap against both reference tools. Work in flight renders five different ways and there is no aggregate answer to "what did it do to my repo." Everything else is chrome discipline: ten unlabeled header icons, ten status segments, four keybindings, and four panels that cover the conversation you are trying to read.

---

## Design principles

Six moves. Each is independently shippable; the first four are independent of each other.

1. **One trust control, not four.** A four-stop ladder that says in plain words what it permits, cycled with `⇧⇥`.
2. **The composer never blocks.** `⏎` steers where the backend allows it, `⇥` queues, `esc` stops.
3. **One place for work in flight.** Needs you / Working / Done, with the needs-you count in the header.
4. **"What did it do to my repo" is one key away.** An aggregate Changes dock over the whole session.
5. **A team is a verb.** `@a @b` on one line, or Second opinion on any finished answer.
6. **Nothing covers the conversation.** Docks beside, palette above, transcript always visible.

**What is borrowed, and from where.** Steer-versus-queue and the flat trust ladder come from Codex. The work-in-flight dock with its needs-you filter, the aggregate diff, the honest cost line and the end-of-turn summary come from Claude Code 2.1. Neither has fifteen agents to coordinate — that part is Mysti's own, and it is what the docks are shaped around.

---

# PART I — CURRENT STATE

Every claim below was read out of the shipping source, not recalled.

## 1. The four controls that ask one question

| Control | Where | Writes |
|---|---|---|
| `behavior-popup` (plan/ask/auto-edit/full-access/autonomous) | `media/chat/index.html:627` | mode + access + autonomy |
| `mode-select` (`OperationMode`) | `media/chat/index.html:231` | `mysti.mode` |
| `access-select` (`AccessLevel`) | `media/chat/index.html:241` | `mysti.accessLevel` |
| `autonomy-select` | `media/chat/index.html:250` | `mysti.autonomous.*` |
| plus `timeout-behavior-select` `:259`, `semi-auto-settings` `:269`, `autonomous-settings` `:291` | | |

`OperationMode` has 5 values and `AccessLevel` has 3, so the settings panel can express **15 combinations**, of which the gate (`src/utils/permissionClassifier.ts` `shouldGateToolUse`) gives meaning to four. The rest reach the Plan 23 B1 fail-closed tail, which is correct *because* it was fixed — but a UI that can express eleven meaningless states is a UI that will produce a twelfth.

The popup at `:627` and the selects at `:231`/`:241` are two surfaces writing the same decision. That is the seam.

## 2. Ten segments, ten icons, four keys

- **Status line** (`index.html:698`) carries ten segments: slash, tools, strategy, agent, model, coordinator model, effort, context, savings, behaviour — three unrelated concepts (actions, identity, policy) in one row. Plan 06 §C named this; Phase 3 of that plan reduced it, and it has since grown back.
- **Header** (`index.html:36–120`) is ten unlabeled icon buttons: history, new, new-tab, export on the left; active-mode, agent-config, badges, about, connections, settings on the right. Badges and About sit in permanent chat chrome.
- **Keyboard:** 4 keybindings in `package.json`; the webview binds 6 distinct keys (`Escape`, `Enter`, `Tab`, `ArrowUp`, `ArrowDown`, `/`). Everything else is mouse-only.
- **Welcome** (`index.html:525`) devotes its main column to "Spread the Word" — Star on GitHub, Rate on Marketplace, Share on X — before the product has been useful once.

## 3. Five ways to draw "running", zero ways to see "changed"

Five independent render paths, none of which answers "what is waiting on me?":

| Path | `media/chat/chat.js` |
|---|---|
| Sub-agent cards | `handleSubAgentStarted:1126` |
| Brainstorm stepper | `buildProgressStepper:7130`, `handleBrainstormDiscussionRoundStart:8242` |
| Coordinator nodes | `mystiNodeEl:7222` |
| Background jobs | `jobCardEl:7695` |
| Sticky todos | `updateStickyTodos:12567` |

Edits render as per-file cards (`renderEditReportCard:12637`) scattered down the transcript. There is **no aggregate view** — to learn what changed you scroll, or you leave Mysti and open git. The checkpoint substrate to fix this already exists (`mysti.checkpoints.*`, and the fork / rewind-code / fork-and-rewind menu built in `getRewindMenuEl`); it has never had a surface.

## 4. Panels that cover the thing you are reading

`settings-panel:122`, `about-panel:333`, `badges-panel:413`, `agent-config-panel:424` and `active-mode-strip:459` are all full-width takeovers of the panel. You cannot read an answer and change the model at the same time.

`package.json` declares **183 settings** (53 at the root of the `mysti.*` namespace alone) in one flat scroll, and **29 commands**.

## 5. What is already good — do not touch

- **The approval card.** Question-framed, diff open by default rather than behind a toggle, 1/2/3 keyboard answers, a free-text "tell Mysti what to do instead", honest timer states. It is ahead of most competitors. Phase 7 adds three things to it and changes nothing else.
- **The gate.** `shouldGateToolUse` fails closed on unknown modes, carves out never-gated reads explicitly, and keeps the canvas lane out of blocking modals. Phase 1 must not add a branch to it.
- **Checkpoints and rewind.** Fork, rewind code, fork-and-rewind, per message.
- **The provider manifest.** Capability-driven rendering with the TS-enforced maps; Plan 02's de-branding guard (`scripts/check-provider-literals.js`) keeps it honest.
- **The calm palette.** Plan 06 Phase 2's token layer. Every new surface resolves through it — no raw hex.

---

# PART II — THE PLAN

## 6. Phases

### Phase 1 — Trust: four controls become one

**Why.** Eleven of fifteen expressible authority states are meaningless, and two surfaces write the same decision. This is the highest-value change and the only one that touches security-adjacent code.

**What ships.** A single `TrustStop` — `plan` | `ask` | `auto` | `full` — surfaced as one pill in the status line and cycled with `⇧⇥`. It is a **pure UI collapse**: `OperationMode` and `AccessLevel` remain the stored truth, and each stop maps to exactly one pair the gate already handles.

| Trust | `mode` | `accessLevel` | Gate outcome today |
|---|---|---|---|
| **Plan** | `quick-plan` | `read-only` | not gated here — enforced by the CLI's own permission mode; coordinator refuses local exec |
| **Ask** | `ask-before-edit` | `ask-permission` | gate every change |
| **Auto** | `edit-automatically` | `ask-permission` | edits auto-apply; bash, delete, web-request and `delegate` still gated |
| **Full** | `edit-automatically` | `full-access` | not gated here |

Unattended stops being a fifth mode and becomes a **duration** granted on Auto or Full ("keep going for 30m"), which is what sets `autonomousMode` and routes through the existing `SafetyClassifier` branch in `ChatViewProvider._shouldGateToolUse:6386`. `⌘⇧A` is freed by this and reassigned in Phase 4.

**Files.** `src/types.ts` (`TrustStop` + the map), `src/utils/permissionClassifier.ts` (map + exhaustiveness only — **no new branch in `shouldGateToolUse`**), `ChatViewProvider` settings read/write, `index.html` (delete `mode-select:231`, `access-select:241`, `autonomy-select:250`; replace `behavior-popup:627`), `chat.js`, `package.json` keybinding, `media/chat/chat.css`.

**Guardrail.** A table test asserting that (a) every `TrustStop` maps to a `(mode, accessLevel)` pair in `OPERATION_MODES` × `ACCESS_LEVELS`, (b) the four stops are strictly ordered by permissiveness under `shouldGateToolUse` for every `PermissionActionType`, and (c) no stop can raise authority above the machine-scoped clamp. The B1 fail-closed tail must stay reachable and tested — this phase reduces what can reach it, it does not remove it.

**Done when.** The settings panel has no policy selects, the pill is the only writer, and `tests/utils/settingsScopeParity.test.ts` plus the permission-gate suite are green.

---

### Phase 2 — The composer stops blocking

**Why.** The single largest gap against both reference tools. Today `sendMessage:9004` / `setProcessing:11188` disable the input for the length of a turn: you wait, or you kill it and retype.

**What ships.**
- `⇥` **queues** a follow-up. Queued items render as removable chips above the input and drain in order on `responseComplete`. Works on every backend.
- `⏎` **steers** the running turn where the backend accepts mid-turn input; elsewhere it queues with an honest note, or offers stop-and-resend.
- `esc` stops, unchanged.

**The honest constraint — resolved during implementation (Open Question 3).** No backend can be steered today, and not for want of work: the one-shot path closes stdin immediately, and every persistent backend speaks a structured protocol where a mid-turn write corrupts the next message. So **queueing is the whole of Phase 2's shipped behaviour**, and `Enter` queues exactly as `Tab` does. `supportsSteering` exists on `ProviderCapabilities`, is false everywhere, and `tests/providers/steering.test.ts` fails if a provider declares it — flipping it requires deleting an assertion and reading why it was there. Declaring it without a real mid-turn input path would offer a key that silently eats what the user typed.

**Files.** `chat.js` (input keydown, queue state, chip render), `ChatViewProvider` (queue drain), `src/types.ts` (capability flag), `index.html`, per-provider capability declarations.

**Done when.** A queued message sent during a turn arrives after it without being retyped, on all fifteen backends. **SHIPPED** — pending F5, like every webview change in this plan.

---

### Phase 3 — The Runs dock

**Why.** Five render vocabularies, no answer to "what is waiting on me?".

**What ships.** One dock with three filters — **Needs you** / **Working** / **Done** — fed by the stream events that already exist (`subAgent*`, `job*`, `mysti*`, `brainstorm*`, permission requests). The needs-you count badges the header. `⌘⇧R` opens it and jumps to the first thing waiting.

**Files.** New render module in `chat.js` consuming the five paths above rather than replacing them at the source; a dock shell in `index.html` (shared with Phase 4); a needs-you count broadcast from `ChatViewProvider`.

**Guardrail.** Build the dock as a *view* over existing events first. Do not refactor the five producers in the same phase.

**SHIPPED.** The hook is a single `observeRun(message)` at the top of `handleMessage`, before the switch — so adding a run kind is a case there, never an edit to whatever draws it in the transcript. The diff is **purely additive (0 deletions)** and all five producers are byte-identical; a test asserts it. Covered by ten browser tests. Pending F5, like every webview change in this plan.

---

### Phase 4 — The Changes dock

**Why.** The checkpoint substrate exists and has no surface.

**What ships.** Every edit this session in one list — file, which agent wrote it, ±lines — with per-file **Keep / Revert / Rewind to before this**, a session total, and **Review all** opening VS Code's native multi-diff editor. Files changed on disk that no agent touched are listed **separately**, so a rewind can never eat the developer's own edit. `⌘⇧A`, freed by Phase 1.

**Files.** A `SessionChangesManager` (or an extension of the checkpoint store) that joins checkpoint attribution against working-tree state; `chat.js`; the Phase 3 dock shell.

**Guardrail.** Attribution is the correctness question. A file the developer edited by hand between two agent turns must never be presented as agent-authored, and reverting one file must not touch any other.

**SHIPPED, read-only.** The list and the line counts come from the shadow repo (`CheckpointManager.diffSince`, baselined on the first checkpoint of the conversation — `_captureCheckpoint` snapshots *before* each turn, so that commit is the tree as it stood before any agent touched it). Attribution comes separately, from the file-edit tool calls the webview observes. Anything git reports that no tool call claims is shown as the developer's own and grouped apart. So a file an agent *claimed* but did not touch never appears, and a file changed with nothing behind it is never presented as agent-authored.

**The destructive actions are deliberately NOT wired, and this is the reason.** `ChatViewProvider._handleRevertFileEdit` reverts through VS Code's `git.clean` / `git.checkout` against the **user's real repository**, not the shadow repo. On a file that carries both an agent edit and the developer's own uncommitted work, that discards both — exactly the hazard this phase exists to prevent. Wiring it into a dock that lists *every* changed file would turn a rare hazard into a routine one. The fix is to revert from the shadow repo instead (`git checkout <baseCommit> -- <path>` against `--git-dir`), which restores one file to its pre-session state and cannot reach anything else; that is a prerequisite for Keep / Revert / Rewind-to-before, not part of this phase.

---

### Phase 5 — `⌘K` and the chrome diet

**What ships.**
- A command palette over the transcript (never covering it) carrying the ~20 things that change *during* work: agent, model, effort, trust, persona, skills, commands. The other 163 settings get a deep link into VS Code's own settings editor, where power users already look.
- Header: 10 icons → **Runs, Changes, New, overflow**.
- Status line: 10 segments → **who and what model · trust · context · spend**.
- `settings-panel:122` is deleted. `about-panel:333` and `badges-panel:413` leave chat chrome (a VS Code Walkthrough is the natural home). `welcome-spread:525` is removed outright.
- The empty state becomes: which agents are actually ready, and three openings read from *this* workspace — the branch, the last failing run, the open file.

**Guardrail.** Plan 06's rule holds: moved controls stay reachable via `/`, `@`, the palette, the overflow, and the keyboard. Nothing is removed, only relocated — except the marketing, which is removed.

---

### Phase 6 — A team is a verb

**What ships.** `@claude @codex <question>` dispatches both through the existing `CollaboratorPool` and renders one verdict card: what they agree on, and — given equal room — where they split. A **Second opinion** action on any finished turn sends the same prompt to a different backend. The five collaboration strategies stay, behind `/team`, for when a structured debate is actually wanted.

**Guardrail.** The synthesis must never average two positions into mush. Naming what is unsettled is the product.

---

### Phase 7 — The remaining surfaces

Each is independently shippable and none blocks another.

| Surface | Change |
|---|---|
| **Agents / setup** | The wizard becomes a dock you can leave open, not a modal that blocks the app. Install failures keep their `InstallErrorCategory` and show the fix (a non-writable npm prefix shows the `chown`). |
| **Context** | Every row carries its own token cost and its own switch, built on the `enabled?` flag `ContextItem` already has (`src/types.ts:62`). Repo rules are listed with their cost. |
| **Plan & progress** | The plan and the live checklist are the same list. Approving a plan is what moves trust from Plan to Ask. |
| **Agent asks you** | The timer names *which* option it will pick. A countdown that hides its own default is not consent. |
| **Personas & skills** | Imported skills show `repo @ commit` provenance and state plainly that they are someone else's text entering your prompt. Agent-proposed skills stay inert until a human promotes them (Plan 20 §Phase 2, unchanged). |
| **Context & cost** | A breakdown you can act on instead of a percentage. Compaction announced before it fires, with what it will keep. The cold-resume cost warned *before* you type. |
| **Connections / MCP** | Connector calls always ask, every time — no "don't ask again" for reaching off-machine. Tool-description drift surfaced on the card (Plan 23 Gate 5, unchanged). |
| **Recovery** | Stalls, expired auth, categorised provider errors, bad edits, policy denials. Three rules: say whether anything was written; offer a *different agent*, not only a retry; never let an error end the conversation. |
| **Approval card** | Three additions only — which agent is asking and from what request; effects (writes, network) listed before consent; the blast radius of "don't ask again" stated on the option itself. |
| **Light theme + wide layout** | Full token parity in light and high-contrast. In an editor tab the dock sits beside the transcript; in the sidebar the same dock swaps in at 420px — one layout rule, not a second design. |

---

## 7. Sequencing

```
Phase 1 (trust)        — land first, alone, behind its own test wave
Phase 2 (steer/queue)  — independent of 1; biggest felt win
Phase 3 (Runs dock)    — independent; builds the dock shell
Phase 4 (Changes dock) — after 3 (shares the shell), after 1 (needs ⌘⇧A)
Phase 5 (⌘K + chrome)  — after 1 (settings panel can only die once policy moved)
Phase 6 (team)         — independent; smallest
Phase 7 (the rest)     — any order, each standalone
```

Phases 1–4 can be worked in parallel by different people. Phase 5 is the only one with a hard predecessor other than the dock shell.

## 8. Test and gate implications

- `npm test` (333 test files) and `npx tsc --noEmit` before and after every phase, per `CLAUDE.md`.
- `npm run lint` runs `scripts/check-provider-literals.js` first — Phases 3–5 edit `index.html`/`chat.js` inside the provider-literal allowlist markers, so the guard will bite. Keep the markers intact.
- Phase 1 must extend the permission-gate suite and `tests/utils/settingsScopeParity.test.ts`.
- Phase 2 must extend `tests/providers/promptEnhancement.test.ts`'s pattern to `supportsSteering` — a lying capability flag is a test failure.
- **The F5 smoke matrix has never been run** (`plans/23-smoke-checklist.md`). It is a hard gate on Phases 3–5, all of which are webview-only and unreachable by the Vitest suite.

## 9. Risks and guardrails

- **The gate is the one thing that must not regress.** Phase 1 adds a mapping table and removes UI; it must add no branch to `shouldGateToolUse`. Review the diff of `permissionClassifier.ts` line by line, and keep the B1 fail-closed tail with its comment intact.
- **Attribution in Phase 4.** Misattributing a developer's own edit to an agent, and then offering to revert it, is worse than having no Changes dock at all.
- **Steering honesty in Phase 2.** Better to queue everywhere than to claim steering on a backend that silently drops it.
- **Theme.** Every new surface resolves through the Plan 06 token layer. No raw hex; light and high-contrast checked, not assumed.
- **Scope creep into the canvas.** Plan 22 owns the canvas. This plan does not touch it, and `⌘⇧D` stays with it.
- **Branch hygiene.** `feat/plan-20-agent-catalog` carries uncommitted work and the tree has unpushed history. Start Phase 1 on its own branch off a clean point, and keep each phase separately revertable.

## 10. Out of scope

Provider streaming, message contracts, persistence, the canvas, the coordinator's directive protocol, the delegation substrate, and every security invariant. This plan is presentation, input ergonomics, and where a control lives — not what a control is allowed to do.

## 11. Open questions

1. **Where do Badges and About go?** A VS Code Walkthrough is the obvious home, but nobody has asked whether the badges system should survive at all. Phase 5 assumes it does and only relocates it.
2. **Should `Plan` be one stop or two?** `OperationMode` distinguishes `quick-plan` from `detailed-plan`. The ladder collapses them; the depth becomes a per-request thing (`/plan --detailed`). Confirm before Phase 1 lands.
3. ~~**Which backends can genuinely steer?**~~ **ANSWERED — none, and the reason is structural.** The single-shot path calls `stdin.end()` the moment the prompt is written, so there is no pipe left to write into. The persistent path keeps stdin open, but every persistent backend speaks a *structured* protocol on it — Claude Code's `--input-format stream-json` (NDJSON), Hermes/Kimi's ACP (JSON-RPC over stdio) — where an unsolicited mid-turn write is not an interrupt but one more token in a stream nobody is reading, corrupting the next message. This is the same finding already recorded on `BaseCliProvider._interruptPersistentProcess`, which is why cancelling tears the process down rather than writing a byte. `supportsSteering` is therefore declared false everywhere and pinned by `tests/providers/steering.test.ts`. Making any backend steerable is protocol work, not a flag.
4. **Does the Runs dock replace the five producers eventually, or stay a view?** Phase 3 deliberately defers this. Revisit once the dock has shipped.
