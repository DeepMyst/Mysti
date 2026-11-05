# Agent assignments and context mentions

In Mysti 2.0 BETA, **an explicit agent tag is an assignment**, including when that agent is already selected. Mysti does not ask a model to decide whether to honor the tag.

## Independent opinions

```text
@claude @codex What are your opinions on adding a cache to this API?
```

Both providers receive the question independently. Their read-only runs overlap, up to `mysti.collab.maxConcurrent` (default 3). Each has a separate live card. The final response stores both attributed answers without a third model pass rewriting them.

The same behavior applies with Cline, Mysti, or another base provider selected, or with an explicit Mysti prefix and other tagged providers. The base provider is not an extra participant unless tagged. A request without provider tags continues to use the selected agent's normal behavior.

## Assign different work

```text
@claude review the authentication design; @codex assess performance
```

Each agent receives its own segment of the request. Independent advisory segments may run together. Adjacent tags share the following task; repeated identical aliases in a shared assignment are deduplicated.

Potentially mutating work is serialized, even if you ask several agents to do it. Mysti does not assume concurrent writers are safe in the same checkout. Access settings and native approval gates still apply; tagging an agent does not grant it additional authority.

## Order a handoff

```text
@claude Write the parser, then @codex review it
```

Claude completes its assignment before Codex starts. Codex receives the prior response in a fenced reference block. A failed or empty prerequisite prevents its dependent assignment from starting. Use **then**, **afterwards**, **after that**, or **next** immediately before the next tag to express this order.

You can combine sequential and parallel steps in one request:

```text
@claude explain the design, then @codex @gemini review it, then @claude summarize their feedback
```

Claude explains first. Codex and Gemini then review independently in parallel. The final Claude assignment waits for both reviews and receives both results. If either prerequisite fails or returns no answer, the dependent summary is blocked instead of pretending the workflow completed. The transcript shows the current step and the agents waiting in the next step.

Scheduling uses conservative text rules, not a full natural-language dependency solver. Make boundaries explicit. This is an in-session workflow: it is not a saved, resumable workflow editor, and it does not support arbitrary branching or conditional rules. Potential file writers remain serial and permission-gated.

## Roles

```text
@claude:critic @codex:reviewer Assess this proposal
```

Roles come from the agent catalog. Advisory roles restrict tool access to read-only operations; trusted write-capable roles still use permission gates and run serially. Unknown/unverified definitions do not gain authority. Repeated use of one provider in different roles has distinct run/card identities.

Built-in roles include advisor, critic, reviewer, second-opinion, coworker, and collaborator. [Personas, skills and roles](PERSONAS-AND-SKILLS.md).

## Provider tags

| Short tag | Provider |
| --- | --- |
| `@claude` | Claude Code |
| `@codex` | OpenAI Codex |
| `@gemini` | Google Gemini CLI |
| `@copilot` | GitHub Copilot CLI |
| `@cline`, `@cursor` | Cline, Cursor |
| `@openclaw`, `@opencode`, `@qwen` | OpenClaw, OpenCode, Qwen Code |
| `@hermes`, `@continue`, `@kimi` | Hermes, Continue, Kimi Code |
| `@ollama`, `@localai`, `@openrouter` | Ollama, LocalAI, OpenRouter |
| `@mysti` | Mysti coordinator; other explicitly tagged providers still receive their assignments |

The autocomplete menu follows the registered provider catalog. Naming a provider in ordinary prose is not equivalent to tagging it. Each named provider must be installed/configured and authenticated as appropriate.

`Switch to @codex` changes the provider for the current panel. `@codex Explain this function` assigns this message without changing the saved default.

## File and state context

```text
@src/api.ts @claude @codex Review this API
@problems @claude Explain these diagnostics
@git @codex Review the current changes
```

Files are resolved once before the assignment group runs and supplied to all participants. They are transient context for this message. Unreadable files produce a warning. `@problems` and `@git` add bounded, read-only workspace summaries.

File mentions also reach Mysti's inline answers, background jobs, orchestration participants, and brainstorm participants. Their contents are resolved for the request and are not added to the saved message's manual context. Stop or navigation during file resolution prevents that pending request from starting; an already detached background job keeps its own lifecycle.

Referenced file contents and their path metadata are enclosed as untrusted reference data in outgoing prompts. Markdown fences or instruction-like text within a file do not end that reference boundary or grant permission to act. Existing context budgets and Mysti's directive-token redaction still apply. This separates the supplied data from the task; it does not guarantee how a model will interpret the text.

Picking a file from the suggestions inserts its exact full path as a quoted mention. The visible path stays with the draft or queued message; another file with the same name cannot replace it when the workspace list changes. Typed filenames or relative paths must resolve to one workspace file. If the name is ambiguous or a quoted path is no longer listed, sending pauses with an explanation and preserves your draft.

Typed paths, dotted filenames and dotfiles, such as `@src/file.ts`, `@file.ts` and `@.env`, also pause submission when they are unavailable in the current file suggestions. The file may still exist; select it from suggestions or add it through Context. Bare file references shorter than three characters, such as `@.a`, need selection from suggestions or a quoted full path. Unrecognized plain `@words` remain text. To send a file-like token literally, put it in backticks or escape its `@`.

This validation runs before sending or adding a message to the queue, preserving the draft and its attachments on rejection. Rejected submissions do not release a queue held by Stop. Queued references are checked again before dispatch; if the file list changed, the queued item and any current draft remain available. Slash-command arguments follow their command's own handling.

The host also checks that supplied file references match complete mentions in the message. A stale reference or a different absolute path is rejected before any file is read or request starts. Select the file again to repair the reference. A reference rejected at submission leaves an already running response alone. This check verifies the reference's consistency, not workspace containment or shorthand uniqueness.

Before reading typed shorthand, the host checks it again against the current searchable workspace files. This uses the editor's search settings and the same `node_modules` exclusion as the suggestions. If the file list became ambiguous, the search cannot finish, or too many candidates prevent verification, that reference is omitted with an explanation; other valid references and manual Context remain available. Choose a file from the suggestions or use its quoted full path to select it explicitly. This check does not enumerate files excluded by the editor's search configuration or provide an atomic snapshot of concurrent filesystem changes.

File mentions are then checked against the open workspace folders. Only regular files with a resolved target inside one of those folders are read; links within or between open folders are supported. Outside targets and unavailable files produce a warning while other readable references remain available. If the workspace folder list changes during resolution, all file references for that request are discarded with a warning. Explicit file-picker attachments and manually added Context items use their own handling.

Each mentioned file may contain up to 5,000,000 bytes of text. Files containing a NUL byte are treated as binary, regardless of their extension. Binary and oversized files are omitted with an explanation; other valid references and manual Context remain available. The reader also enforces the byte limit if a file grows during reading, and never sends a partial file from a rejected reference. Use a smaller text file or add the relevant text excerpt. This is a per-file limit; it does not impose a total limit on all context in a message. Text is decoded as UTF-8, retaining replacement characters for invalid UTF-8 sequences.

Quoted mentions support spaces and Unicode, such as `@"src/retry contract.ts"`. Quotes and backslashes within a path use JSON escaping, which the picker inserts for you. Agent names inside a quoted filename are part of that filename. Mentions inside code and email addresses are ignored.

Composer attachments are currently not forwarded by collaborator dispatch. Mysti warns rather than silently implying the attachment was delivered. Use Context or a workspace file mention for these runs. Ordinary provider chat retains its provider-specific attachment support.

## Failures, cancellation and limits

- Missing or unauthenticated providers appear as unavailable; another agent never supplies their opinion.
- Available independent participants can finish even if another fails. Failed dependencies block subsequent dependent work.
- Each active card shows elapsed time. After 30 seconds without an assignment event, a provider-specific notice explains that no response or new activity has arrived. Another participant's output does not reset that clock. A quiet provider may still be working; the notice does not cancel or retry it, and a completed sibling answer stays visible.
- Stop cancels the current request, including all active assignments and pending steps; it is not a per-participant stop control.
- Each child uses the shared pool's timeout and safe retry policy. Approved side effects are not blindly retried.
- Stop, panel disposal, and a superseding send cancel the relevant work. Late events must not appear in the new turn.
- Agent count and concurrency are bounded. Too many explicit tags produce a visible error before dispatch instead of silently dropping assignments.
- Model selection is resolved per provider. The selected agent's model must not leak into a different provider's child request.

For a routing bug, include a redacted exact prompt, selected agent, tags, access mode, expected order, actual cards/results, and provider versions. [Contributing](../CONTRIBUTING.md).
