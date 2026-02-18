# Context Compaction

Context compaction prevents your conversation from exceeding the AI's context window by intelligently summarizing older messages while preserving recent context.

## Why Compaction Matters

Every AI model has a limited context window — the maximum amount of text it can process at once. Long conversations can exceed this limit, causing errors or degraded responses. Compaction automatically manages this by:

- Tracking cumulative token usage per chat panel
- Triggering compaction when usage approaches the threshold
- Summarizing older messages while keeping recent ones intact

## How It Works

```
[Message 1] [Message 2] ... [Message N-4] [Message N-3] [Message N-2] [Message N-1] [Message N]
     |           |              |              |              |             |             |
     +--- Older messages -------+              +--- Preserved (last 4) ----+-------------+
     |                                         |
     v                                         v
  Summarized into a compact                 Kept as-is for
  context summary                           full detail
```

### Token Tracking

Mysti tracks cumulative token usage for each panel:
- **Input tokens**: Tokens sent to the model
- **Output tokens**: Tokens received from the model
- **Cache read tokens**: Tokens served from cache
- **Cache creation tokens**: Tokens stored in cache

### Threshold Triggering

When the fill level exceeds the configured threshold (default 75%), compaction is triggered automatically. A cooldown period (30 seconds) prevents rapid repeated compactions.

## Compaction Strategies

### Native CLI (`native-cli`)

For providers that support built-in compaction (currently Claude Code):

- Sends the `/compact` command to the CLI
- The provider handles summarization natively
- Generally produces the best results since the provider understands its own context format

### Client-Side Summarization (`client-summarize`)

For other providers:

- Mysti identifies older messages (beyond the preserved count)
- Summarizes them into a condensed context block
- Replaces the original messages with the summary
- Preserves the last N messages (default 4) in full

## Brainstorm Agent Tracking

In Brainstorm Mode, each agent's token usage is tracked independently using composite keys:
- Main panel: `panelId`
- Brainstorm agents: `panelId-brainstorm-agentId`

This ensures accurate tracking even when multiple agents are active simultaneously.

## Compaction Status

The system reports its status through these states:

| Status | Description |
|--------|-------------|
| `idle` | No compaction needed |
| `evaluating` | Checking if compaction is needed |
| `compacting` | Compaction in progress |
| `complete` | Compaction finished successfully |
| `error` | Compaction failed |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `mysti.compaction.enabled` | `true` | Enable automatic context compaction |
| `mysti.compaction.threshold` | `75` | Trigger compaction at this % of context window |

## Provider Support

| Provider | Strategy | Notes |
|----------|----------|-------|
| Claude Code | `native-cli` | Uses built-in `/compact` command |
| Codex | `client-summarize` | Client-side summarization |
| Gemini | `client-summarize` | Client-side summarization |
| Cline | `client-summarize` | Client-side summarization |
| Copilot | `client-summarize` | Client-side summarization |
| Cursor | `client-summarize` | Client-side summarization |
| OpenClaw | `client-summarize` | Client-side summarization |

## Tips

1. **Leave compaction enabled** — it prevents errors from context overflow
2. **Lower the threshold** (e.g., 60%) for providers with smaller context windows
3. **Raise the threshold** (e.g., 90%) if you want to maximize context before compacting
4. **Watch for compaction events** in the chat — they indicate long conversations
5. **Start a new conversation** if you notice quality degrading after multiple compactions
