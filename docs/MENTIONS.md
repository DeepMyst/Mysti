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
