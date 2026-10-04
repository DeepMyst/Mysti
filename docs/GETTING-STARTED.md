# Getting started with Mysti 2.0 BETA

## Install and open

Use VS Code 1.86 or newer and a trusted local workspace on Windows, macOS, or Linux. Install `DeepMyst.mysti` from Extensions. For an unpublished beta, use **Extensions: Install from VSIX** with the reviewed package. Reload the window after replacing an installed version.

Open **Mysti: Open Chat** from the command palette or click Mysti in the Activity Bar. Opening a separate editor tab gives a larger workspace for comparisons and visual work.

## Configure one agent

Choose an agent in the composer and follow the setup screen. Installation, CLI discovery, authentication, and model support are separate checks: completing an installer does not imply sign-in is complete.

- **Claude Code / Codex / another CLI:** use the provider's install and authentication actions. If Mysti detects a model compatibility error requiring a newer CLI, use the upgrade action and wait for discovery to refresh.
- **Mysti:** sign in to DeepMyst. The coordinator uses that account; delegating to a local CLI still requires that CLI's setup.
- **Ollama / LocalAI / OpenRouter:** configure the appropriate endpoint or account. These are not all installed through npm.

See [Providers](PROVIDERS.md) for adapter-specific details. Model catalogs and account entitlements can differ from examples in screenshots.

## Assign a task

```text
@claude Explain this function
@claude @codex What are your opinions on this design?
@claude Write the parser, then @codex review it
@claude:critic @codex:reviewer Assess this proposal
```

The selected provider does not absorb explicit assignments. Opinion requests have separate, concurrent read-only runs. A `then` handoff waits for the preceding assignment. Work that may write files runs serially and retains your permission settings.

Add files through Context or `@path/to/file`. Explicit collaborator runs currently do not forward composer attachments; the UI warns you to use Context. Dictation inserts text into your draft and does not send it automatically.

## Read the results

Each live assignment card identifies its agent and status. The final conversation stores attributed answers so reopening it preserves who said what. A missing, unauthenticated, timed-out, or failed participant is reported rather than replaced. Stop cancels active collaborators; a new send supersedes the previous run.

`@agent:role` controls perspective and access. Unknown or unverified roles do not gain write authority. See [Mentions](MENTIONS.md).

## Try connected context

Open **Mysti: Open Proactive Inbox**. Local Git monitoring needs a chosen workspace and the editor running. Cloud GitHub/Slack monitoring needs DeepMyst sign-in, a supported connected account, and a responsibility you explicitly create. Review evidence before acting on it; author metadata is not task ownership. [Setup and limits](PROACTIVE.md).

## If something goes wrong

| Symptom | Check |
| --- | --- |
| An agent is unavailable | Its setup card: installed path, CLI version, and sign-in are distinct checks. |
| A model is rejected | Choose a model your account supports; use an offered CLI upgrade if required. |
| Only one opinion arrives | Inspect the other agent's card and error. Retry after fixing its setup. |
| Work runs serially | Writers and explicit dependencies serialize. Independent read-only work respects `mysti.collab.maxConcurrent`. |
| Dictation has no microphone support | Follow the editor's speech setup prompt and OS microphone permissions. |
| DeepMyst sign-in fails | Retry sign-in, inspect the reported error, and include the HTTP status in a bug report. Never share tokens. |

Report your Mysti version, OS, VS Code version, provider/CLI version, exact prompt with private content removed, and expected versus actual behavior. Attach a redacted screenshot or recording where helpful.
