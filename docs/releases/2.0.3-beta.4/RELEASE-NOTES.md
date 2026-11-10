# Mysti 2.0.3 · Beta 4

**Your agents, the way their own CLIs run them.**

Beta 4 fixes the issues behind slow, silent or stuck chats in Beta 3, found by
driving the real editor with real settings. If you use Claude Code or Codex in
Mysti, update.

[Full changelog](../../../CHANGELOG.md) ·
[Production-readiness checklist](../../PRODUCTION_READINESS.md)

## What changed

### Agents run natively

- **No more restated modes.** Mysti used to append its Plan, Read Only and
  edit-mode instructions to every message. Claude Code, Codex, Copilot,
  Cursor and Gemini already enforce those modes themselves, so Mysti now only
  adds instructions a CLI cannot enforce. On Claude at maximum effort, the
  extra text made a plain "hi" think about five times longer.
- **Questions are answered in the same turn.** When Claude or Codex asks you
  something, your choice goes straight back to it and it carries on, instead
  of failing the question and starting a new turn. Kimi no longer answers its
  own questions with the first option. Secret Codex questions are never shown
  as plain cards.
- **You can see thinking.** Claude shows "Thinking… ~N tokens" while it
  reasons; Copilot's and Cursor's reasoning is shown.
- **Plans work.** Claude's own plan mode can explore and write its plan in
  Plan and Read Only tiers, so plans reach the approval card. Codex uses its
  own Plan mode.
- **Less repeated context.** A resumed session no longer gets its own last
  exchange replayed as history, and Cursor gets the conversation history it
  was missing.

### Never stuck

- **Move on any time.** If an agent's question is waiting, just send your next
  message (after switching model, agent or mode, too): the question is
  dismissed and your message is sent.
- **Skip means skip.** Skipping a question or plan no longer sends a message
  or triggers a reply.
- **Cards wait for you.** Unanswered permission, question and plan cards now
  wait, like Claude Code, instead of being denied after a minute.

### Current models by default

- Claude defaults to **Sonnet (latest)**: the newest Sonnet your Claude Code
  knows (Sonnet 5.5). Sonnet 5.5 and Haiku 5.5 are in the model menu.
- Codex defaults to **GPT-5.6 Terra**, Codex's own current default.
  ChatGPT accounts currently reject GPT-5.6 Sol, GPT-6 Astra and GPT-5.5;
  if Codex reports that a model is not supported, pick Terra or Luna.
- Qwen defaults to `coder-model`, the only model Qwen OAuth accepts. Cline and
  OpenClaw use the model configured in those CLIs.

## Install

Update from the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti)
(pre-release channel), or download the VSIX from the
[GitHub release](https://github.com/DeepMyst/Mysti/releases/tag/v2.0.3-beta.4)
and run **Extensions: Install from VSIX…**. Conversations and settings carry
over from Beta 3. Settings you changed yourself keep your values; a model you
previously picked stays selected until you pick another.

Mysti remains beta. Known gaps, including providers that run only with full
access and headless plan modes that can be exited, are listed in
[production readiness](../../PRODUCTION_READINESS.md).
