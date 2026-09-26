# Plan 32 — Onboarding: first-run wizard, Getting started, hints, /help, walkthrough

- **Date:** 2026-09-26
- **Status:** APPROVED 2026-09-26 ("go ahead and implement") — implementation plan: `plans/32-onboarding-implementation.md`
- **Design:** canvas artifact https://claude.ai/artifact/WezeUNyhz58r434DH7fKVi (private) — Flow, Wizard 1/1b/2/3, Chat · Getting-started card, Walkthrough, /help card, five hint boards, "Hint rules" sticky.
- **Trigger:** "add an onboarding wizard and information to Mysti such that new users can get up and running with Mysti quickly."

Symbols are the stable reference; line numbers drift.

## Goal

A new user reaches a working agent and a first answer quickly, knows what the four modes mean, and meets each Mysti-specific feature (mentions, rewind, Brainstorm, compaction, approvals) with one line of explanation the first time it happens.

## What exists today (verified 2026-09-26)

- `#setup-wizard` (media/chat/index.html) is a single full-screen overlay: DeepMyst fast path (Plan 27 Gate 2) above **11** static `.provider-card`s. OpenCode, Qwen Code, Ollama and LocalAI have no card. Shown by `_sendInitialState` only when `!setupWizardDismissed && !anyReady && !mystiReady`.
- "Use This" posts `selectProvider`; the host answers `wizardComplete`, which HIDES the wizard. Nothing notifies the wizard when DeepMyst sign-in completes.
- `contributes.walkthroughs` has 5 steps: step 2 opens Settings instead of setup; step 3's completion event is `onCommand:mysti.openChat` (same as step 1, so it ticks itself); step 5 is "Star on GitHub".
- `/help` returns plain text that still names modes by setting value (`ask-before-edit`…). `/mode` accepts only raw `OperationMode`s — `/mode auto` is "Invalid mode".
- The composer placeholder is "Ask Mysti…". Brainstorm strategy descriptions read like "Facilitator-mediated iterative convergence".
- `src/utils/trustLadder.ts` (`TRUST_STOPS`, `authorityForTrust`, `TRUST_COPY`) and chat.js `CHAT_MODES`/`applyChatMode`/`deriveChatMode` already own the Plan/Ask/Auto/Full vocabulary.

## Decisions

| # | Decision |
|---|---|
| D1 | A user whose agent is already ready never sees the wizard on first open; they get the **Getting-started card** in the empty chat instead. `Mysti: Get Started` always opens the wizard. |
| D2 | Wizard step 1 lists **found** CLIs first, then the DeepMyst fast path, then three suggested installs (Claude Code, Gemini, Ollama), then "See all 15 agents" (a native `<details>`) grouped by how you pay, with a filter. The DeepMyst block stays above every install card (Plan 27 Gate 2 test). |
| D3 | The existing provider cards and their install/sign-in/retry logic are REUSED — cards are moved between sections, never re-implemented. Four missing cards are added. |
| D4 | Step 1's Continue needs a ready agent (a signed-in CLI or DeepMyst); it does not choose an agent — "Use This" still does. `wizardComplete` no longer hides the wizard; it marks the selection. |
| D5 | Step 2 writes the same `mode` + `accessLevel` pair the mode pill writes (`applyChatMode`). |
| D6 | Hints: one component; each hint is marked seen the moment it is shown; at most one per webview session; "Got it" closes it, "Turn off tips" sets `mysti.tips.enabled=false`. |
| D7 | The Brainstorm first-run hint offers the strategy choice inline and names the two agents with a link to Settings — it does NOT duplicate the brainstorm agent picker (Plan 31 is moving Settings). |
| D8 | `/help` renders a searchable card in the webview from a static list; the host only posts `showHelp`. `/mode` accepts `plan`/`ask`/`auto`/`full` via `authorityForTrust`. |
| D9 | The walkthrough is rewritten to six steps with theme-aware SVG media; "Star on GitHub" is dropped (the welcome screen keeps "Spread the Word"). Steps 4–6 have no completion events, so VS Code checks them off when their button is clicked. |

## Out of scope

Getting-started "all done" state (the card simply stops rendering); Brainstorm agent picker inside the hint; live re-ticking of the Getting-started card while a chat is open (it renders on the empty chat only); hints for backends whose edit tools are not in `FILE_EDIT_TOOLS` (the rewind hint needs an `.edit-report-card`).
