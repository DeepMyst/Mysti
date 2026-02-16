# @-Mention System

Mysti's @-mention system lets you reference files and route tasks to specific AI agents directly from the chat input.

## File Mentions

Use `@filename` to add a file as transient context for your current message.

### How It Works

```
@utils.ts Can you explain what the helper functions do?
```

- Mysti resolves the filename to a file in your workspace
- The file content is added as **transient context** (only for this message, not persisted)
- The AI receives the file content alongside your question

### Examples

```
@package.json What version are we on?
@src/auth.ts Is there a security vulnerability in the login flow?
@styles.css @layout.css Can you unify these two stylesheets?
```

You can mention multiple files in a single message.

## Agent Mentions

Use `@agent-name` to route tasks to specific AI providers.

### Available Agents

| Mention | Routes to |
|---------|-----------|
| `@claude` | Claude Code |
| `@codex` | OpenAI Codex |
| `@gemini` | Google Gemini |
| `@cline` | Cline |
| `@copilot` | GitHub Copilot |
| `@cursor` | Cursor |
| `@openclaw` | OpenClaw |

### How It Works

When you mention an agent, Mysti:

1. **Parses** the message for all @-mentions
2. **Generates a task list** — determines what each mentioned agent should do
3. **Executes tasks sequentially** — each agent runs its task in order
4. **Builds context** — prior agent responses are provided as context to later agents
5. **Returns results** — all sub-agent responses are combined into the final response

### Examples

#### Ask a specific agent

```
@gemini What's the fastest way to parse this JSON in Python?
```

Routes the question directly to Gemini, regardless of your default provider.

#### Multi-agent collaboration

```
@claude Write a sorting algorithm, then @codex optimize it for performance
```

1. Claude writes the initial algorithm
2. Codex receives Claude's response as context and optimizes it

#### Switch providers

```
Switch to @cursor
```

Changes your active provider to Cursor.

## Task Generation

Mysti uses a smart task generation system to determine what each agent should do.

### Heuristic Mode (Fast)

For common patterns, Mysti uses heuristics:

- **Switch patterns**: "switch to @agent" → changes the active provider
- **Informational questions**: Direct question → routes to the mentioned agent
- **Directive verbs**: "write", "fix", "refactor" → creates an execution task

### AI Fallback

For complex messages with multiple agents and ambiguous intent, Mysti falls back to AI-powered task generation that analyzes the full message context.

## Execution Details

### Sequential Processing

Sub-agent tasks run in order, not in parallel. This allows:
- Later agents to see earlier agents' responses
- Dependency chains (e.g., "write with @claude, then review with @gemini")
- Consistent, predictable behavior

### Error Handling

- **Auto-retry**: Failed tasks retry once automatically
- **Timeout**: Each sub-agent task has a 2-minute timeout
- **Partial results**: If one agent fails, others continue with available context
- **Error reporting**: Failures are reported in the response without halting the pipeline

### Streaming

During execution, the chat shows real-time progress:
- Which agent is currently working
- Task list with completion status
- Streaming text from the active agent
- Tool use notifications

## Combining Mentions

You can combine file and agent mentions:

```
@src/api.ts @claude Review this API for security issues, then @gemini suggest performance improvements
```

This:
1. Adds `src/api.ts` as context
2. Routes the security review to Claude
3. Passes Claude's review to Gemini for performance suggestions

## Tips

1. **Use file mentions** instead of manually adding context — they're faster and don't persist
2. **Chain agents** for multi-perspective reviews
3. **Switch providers** quickly with "switch to @agent"
4. **Be specific** about what each agent should do for best results
5. **Order matters** — later agents receive earlier agents' responses as context
